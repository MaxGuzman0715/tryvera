// Content script (Slice 2: Generate from the page).
//
// Renders a small floating panel on allowed job pages. The panel lets a
// signed-in user generate tailored docs (résumé / cover letter) straight from
// the page: it auto-scrapes the visible text as the JD, asks the background
// worker to run enpply's pipeline, then polls progress. The run appears in
// enpply Logs just like a dashboard run.
//
// LinkedIn (and any blocked host) is hard-disabled: enpplify never operates
// there. Fill + résumé attach arrive in Slice 3.

(function () {
  const host = location.hostname.replace(/^www\./, "");
  const isLinkedIn = host === "linkedin.com" || host.endsWith(".linkedin.com");
  const BLOCKED_HOSTS = [""];
  const isBlocked = BLOCKED_HOSTS.some((h) => host === h || host.endsWith("." + h));
  if (isBlocked) {
    console.log("[enpplify] disabled on", host, "(blocked host)");
    return;
  }

  // The script now runs in EVERY frame (manifest all_frames) so it can reach
  // forms embedded in a cross-origin iframe (e.g. pindrop.com → Greenhouse
  // job-boards iframe, jobs.gem.com → apply frame). But we only want ONE panel
  // per tab. Rule: the TOP frame always mounts (so Generate-only pages still
  // get a panel); a CHILD frame mounts only when it actually contains an
  // application form. When the top frame later detects a form-bearing child
  // frame, it minimizes itself to the circle so the in-form panel is primary.
  const isTopFrame = window.top === window.self;

  /** Does THIS frame contain something form-like worth a panel? */
  function frameHasForm() {
    if (document.querySelector('input[type="file"]')) return true;
    const fields = document.querySelectorAll("input, textarea, select").length;
    const txt = (document.body?.innerText || "").toLowerCase();
    if (fields >= 3 && /apply|application|resume|résumé|cover letter|first name|email/.test(txt)) return true;
    return fields >= 6;
  }

  // A child frame with no form is just chrome (nav, ads, analytics) — never
  // mount there. But ATS embeds (Greenhouse `grnhse_app` etc.) often start as an
  // empty about:blank/srcdoc frame and inject the form seconds later, so keep
  // re-checking for a while before giving up.
  if (!isTopFrame && !frameHasForm()) {
    let settled = false;
    const t = setInterval(() => {
      if (settled) return;
      if (frameHasForm()) { settled = true; clearInterval(t); boot(); }
    }, 800);
    setTimeout(() => { if (!settled) clearInterval(t); }, 30000);
    return;
  }
  boot();

  function boot() {
  if (window.__enpplifyPanelMounted) return;
  window.__enpplifyPanelMounted = true;

  // --- messaging -------------------------------------------------------------

  /** Promise wrapper over chrome.runtime.sendMessage. */
  function send(type, payload) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ type, payload }, (res) => {
        if (chrome.runtime.lastError) {
          resolve({ ok: false, error: chrome.runtime.lastError.message });
        } else {
          resolve(res || { ok: false, error: "No response from extension." });
        }
      });
    });
  }

  // --- JD scraping -----------------------------------------------------------

  const JD_CAP = 60000;
  function scrapeJobDescription() {
    const text = (document.body?.innerText || "").replace(/\n{3,}/g, "\n\n").trim();
    return text.length > JD_CAP ? text.slice(0, JD_CAP) : text;
  }

  // --- form harvesting + filling ---------------------------------------------
  //
  // We mint an ephemeral `ref` per field and keep a ref -> element map locally.
  // Only descriptors (text + ref) go to the server; selectors never leave here.

  let refSeq = 0;
  /** @type {Map<string, Element>} */
  const refToEl = new Map();

  function visible(el) {
    if (!el || el.disabled) return false;
    if (el.type === "hidden") return false;
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden" || cs.opacity === "0") return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  // react-select (used by Greenhouse/Lever/Ashby) and similar libs are readonly
  // text inputs acting as comboboxes. We must NOT skip those, but we should skip
  // genuinely read-only display fields. Treat a readonly input as fillable only
  // if it looks like a combobox.
  function isReadonlyDisplayOnly(el) {
    return el.readOnly && !isCombobox(el) && el.tagName === "INPUT";
  }

  /** Trim a label string: collapse whitespace, drop a trailing required "*". */
  function cleanLabel(s) {
    return String(s || "").replace(/\s+/g, " ").replace(/\s*\*+\s*$/, "").trim();
  }

  /**
   * Find a label-like text node near the input when there's no <label for>,
   * wrapping <label>, or ARIA. Many modern ATS (Gem, custom React forms) render
   * the field label as a SIBLING element (a <span>/<div>) just before the input
   * wrapper, with NO association attributes. Climb a few ancestors; at each, the
   * first short text-bearing child that does NOT contain the input is the label.
   */
  function siblingLabel(el) {
    let node = el;
    for (let depth = 0; depth < 5 && node && node !== document.body; depth++) {
      const container = node.parentElement;
      if (!container) break;
      for (const child of container.children) {
        if (child === node || child.contains(el)) continue; // skip the input's own branch
        // Don't treat another control's wrapper as a label.
        if (child.querySelector?.("input, textarea, select")) continue;
        const t = cleanLabel(child.innerText || child.textContent || "");
        if (t && t.length <= 120) return t;
      }
      node = container;
    }
    return "";
  }

  // A "label" that is actually just a machine field name (Lever's
  // cards[uuid][field0], surveysResponses[uuid][responses][field1], a bare
  // hash, etc.) is WORSE than no label — it gets sent to the LLM as the
  // question. Reject these so we fall through to real question text.
  function isJunkLabel(s) {
    const t = String(s || "").trim();
    if (!t) return true;
    if (/\[[^\]]*\]/.test(t)) return true;            // foo[bar][field0]
    if (/^[a-f0-9]{8}-[a-f0-9]{4}-/i.test(t)) return true; // a uuid
    if (/^[\w.-]+$/.test(t) && !/\s/.test(t) && t.length > 20) return true; // long token, no spaces
    return false;
  }

  /**
   * The real QUESTION text for a field group on ATS that render the prompt in a
   * separate element from the control (Lever: `.application-label .text`,
   * Greenhouse/Ashby: a label/legend above an options list). Walk up to the
   * question container and read its heading-ish text, excluding the answer
   * options/controls themselves.
   */
  function groupQuestion(el) {
    const container = el.closest(
      ".application-question, [class*='application-question'], fieldset, [role='group'], li",
    );
    if (!container) return "";
    // Prefer an explicit label/question element if present.
    const labelEl = container.querySelector(
      ".application-label .text, .application-label, legend, [class*='label']",
    );
    let t = cleanLabel(labelEl?.innerText || labelEl?.textContent || "");
    if (t && !isJunkLabel(t)) return t;
    // Fall back to the container text minus the option labels and any control values.
    const clone = container.cloneNode(true);
    try {
      clone.querySelectorAll(
        "input, textarea, select, .application-answer-alternative, [data-qa='multiple-choice'], [data-qa='checkboxes'], ul",
      ).forEach((n) => n.remove());
    } catch { /* ignore */ }
    t = cleanLabel(clone.innerText || clone.textContent || "");
    return t && !isJunkLabel(t) ? t : "";
  }

  /**
   * Checkboxes that form one "select all that apply" question. Group by shared
   * `name` when present (most reliable); else by the nearest question container
   * (fieldset / [role=group] / application-question). Returns the group's
   * checkboxes — a single element means a standalone checkbox, which the caller
   * leaves alone (we never auto-tick a lone consent/agree box).
   */
  function checkboxGroup(el) {
    const name = el.getAttribute("name") || "";
    if (name) {
      const byName = Array.from(
        document.querySelectorAll(`input[type="checkbox"][name="${CSS.escape(name)}"]`),
      );
      if (byName.length >= 2) return byName;
    }
    const container = el.closest(
      "fieldset, [role='group'], [class*='application-question'], [class*='checkbox-group']",
    );
    if (container) {
      const inBox = Array.from(container.querySelectorAll('input[type="checkbox"]'));
      if (inBox.length >= 2) return inBox;
    }
    return [el];
  }

  /** Best-effort visible label text for a control. */
  function labelFor(el) {
    if (el.id) {
      const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (l?.innerText && !isJunkLabel(l.innerText)) return cleanLabel(l.innerText);
    }
    const wrap = el.closest("label");
    if (wrap?.innerText && !isJunkLabel(wrap.innerText)) return cleanLabel(wrap.innerText);
    if (el.getAttribute("aria-labelledby")) {
      const ids = el.getAttribute("aria-labelledby").split(/\s+/);
      const txt = ids.map((i) => document.getElementById(i)?.innerText || "").join(" ").trim();
      if (txt && !isJunkLabel(txt)) return cleanLabel(txt);
    }
    const aria = el.getAttribute("aria-label");
    if (aria && aria.trim() && !isJunkLabel(aria)) return cleanLabel(aria);
    // The question may live in a separate element (Lever cards, grouped radios).
    const grp = groupQuestion(el);
    if (grp) return grp;
    // No association attrs (Gem etc.) → look for a sibling/group label.
    const sib = siblingLabel(el);
    if (sib && !isJunkLabel(sib)) return sib;
    return "";
  }

  /** Short snippet of text immediately preceding the control (e.g. a question). */
  function surroundingText(el) {
    const container = el.closest("div,section,fieldset,li,p") || el.parentElement;
    if (!container) return "";
    let t = container.innerText || "";
    // Strip the values of form controls in the container so the extracted
    // "question" is STABLE whether or not fields are filled. Without this, a
    // filled textarea's answer becomes part of the surrounding text → the field's
    // question key changes after Q&A fills the page, and stored answers no longer
    // match on re-open (the per-field path never fills the page, so it was fine).
    try {
      for (const c of container.querySelectorAll("input, textarea, select")) {
        const vals = [];
        if (typeof c.value === "string" && c.value.trim().length >= 3) vals.push(c.value.trim());
        if (c.tagName === "SELECT" && c.selectedIndex >= 0) {
          const ot = c.options[c.selectedIndex] && c.options[c.selectedIndex].text;
          if (ot && ot.trim().length >= 3) vals.push(ot.trim());
        }
        for (const v of vals) t = t.split(v).join(" ");
      }
    } catch {
      /* best-effort — fall back to raw text */
    }
    t = t.trim().replace(/\s+/g, " ");
    return t.length > 300 ? t.slice(0, 300) : t;
  }

  const MAX_FIELDS = 400;
  // Cap a field's option list before sending — long native <select>s (country,
  // state on Taleo/Workday) can exceed the server's per-field options bound and
  // would otherwise get the whole fill request rejected.
  const MAX_OPTIONS = 1000;

  // Per-string server bounds (fill-map fieldSchema). ONE over-long string makes
  // Zod reject the ENTIRE request, so nothing fills. We clamp every string we
  // send to its server max. The usual offender is `label`: an input wrapped in a
  // big <label> (or pointing aria-labelledby at a section) drags in a whole
  // consent/legal blurb — far longer than any real field name — so truncating
  // keeps the request valid without losing a genuine question.
  const MAX_STR = { label: 2000, name: 500, id: 500, placeholder: 1000, ariaLabel: 1000, autocomplete: 100 };
  const MAX_OPTION = 500; // fieldSchema.options[].max(500)
  const clamp = (s, n) => (typeof s === "string" && s.length > n ? s.slice(0, n) : s);

  /** Harvest fillable fields into descriptors; populates refToEl. */
  function harvestFields() {
    refSeq = 0;
    refToEl.clear();
    const descriptors = [];
    const seenRadioGroups = new Set();
    const seenCheckboxes = new Set();
    const controls = document.querySelectorAll("input, textarea, select");

    for (const el of controls) {
      if (descriptors.length >= MAX_FIELDS) break;
      const tag = el.tagName.toLowerCase();
      const type = (el.getAttribute("type") || (tag === "input" ? "text" : tag)).toLowerCase();
      if (["hidden", "submit", "button", "reset", "image"].includes(type)) continue;

      // File inputs are handled separately (résumé attach), skip in fill-map.
      if (type === "file") continue;

      // Passwords are NEVER sent to the server / LLM — they're filled locally by
      // the autofill (fillPasswords). Skip them here so they can't leak in a
      // descriptor or get offered as an AI field. Also skip reveal-toggled
      // password fields (type flips to "text" but autocomplete still says so).
      if (type === "password") continue;
      if ((el.getAttribute("autocomplete") || "").toLowerCase().includes("password")) continue;

      // Radio groups: one descriptor per group (by name), with options.
      if (type === "radio") {
        const name = el.name || "";
        const key = name || el.id;
        if (!name || seenRadioGroups.has(name)) continue;
        seenRadioGroups.add(name);
        const group = Array.from(document.querySelectorAll(`input[type="radio"][name="${CSS.escape(name)}"]`));
        if (!group.some(visible)) continue;
        // Keep each radio paired with the EXACT option text we send to the
        // server, so the returned value maps back to the right radio with no
        // re-derivation/guessing.
        const opts = group.map((r) => ({ el: r, text: clamp(labelFor(r) || r.value, MAX_OPTION) }));
        const options = opts.map((o) => o.text).filter(Boolean);
        const ref = `f${refSeq++}`;
        refToEl.set(ref, { kind: "radio", name, opts });
        // The question text comes from the GROUP label (Lever .application-label
        // .text, a legend, etc.), NOT each option's own <label> — so the server
        // and LLM see the real question, not the input name or an option value.
        const qLabel = groupQuestion(el);
        descriptors.push({
          ref, type: "radio", name, options,
          label: qLabel, surroundingText: qLabel || surroundingText(el),
        });
        continue;
      }

      // Checkbox GROUPS ("select all that apply"): one multi-select descriptor
      // per group, with each box's label as an option. A standalone checkbox
      // (group of one) is skipped — never auto-tick a lone consent/agree box.
      if (type === "checkbox") {
        if (seenCheckboxes.has(el)) continue;
        const group = checkboxGroup(el);
        group.forEach((c) => seenCheckboxes.add(c));
        if (group.length < 2 || !group.some(visible)) continue;
        const opts = group.map((c) => ({ el: c, text: clamp(labelFor(c) || c.value, MAX_OPTION) }));
        const options = opts.map((o) => o.text).filter(Boolean);
        if (options.length < 2) continue;
        const ref = `f${refSeq++}`;
        refToEl.set(ref, { kind: "checkboxes", opts });
        const qLabel = groupQuestion(el);
        descriptors.push({
          ref, type: "checkboxes", options,
          label: qLabel, surroundingText: qLabel || surroundingText(el),
        });
        continue;
      }

      // Decide combobox-ness first: a custom dropdown's real <input> may be
      // visually hidden, so judge its visibility by the styled control wrapper
      // (which IS visible), and don't drop it as a read-only display field.
      const combobox = tag === "input" && (isCombobox(el) || inSelectWidget(el));
      if (!visible(combobox ? comboboxControl(el) : el)) continue;
      if (!combobox && isReadonlyDisplayOnly(el)) continue; // genuine read-only display field

      const ref = `f${refSeq++}`;
      refToEl.set(ref, { kind: combobox ? "combobox" : tag, el });
      const rawName = el.getAttribute("name") || "";
      const d = {
        ref,
        type: tag === "select" ? "select" : (tag === "textarea" ? "textarea" : type),
        label: clamp(labelFor(el), MAX_STR.label),
        // Don't send machine field names (Lever cards[uuid][fieldN]) — the server
        // uses `name` as a question fallback, and that junk would mislead the LLM.
        name: clamp(isJunkLabel(rawName) ? "" : rawName, MAX_STR.name),
        id: clamp(isJunkLabel(el.id || "") ? "" : (el.id || ""), MAX_STR.id),
        placeholder: clamp(el.getAttribute("placeholder") || "", MAX_STR.placeholder),
        ariaLabel: clamp(el.getAttribute("aria-label") || "", MAX_STR.ariaLabel),
        autocomplete: clamp(el.getAttribute("autocomplete") || "", MAX_STR.autocomplete),
      };
      if (!d.label) d.surroundingText = surroundingText(el);
      if (tag === "select") {
        d.options = Array.from(el.options).map((o) => clamp(o.text.trim(), MAX_OPTION)).filter(Boolean).slice(0, MAX_OPTIONS);
      } else if (combobox) {
        d.type = "select";
        // Try to read pre-rendered options (some libs keep them in the DOM).
        const opts = comboboxOptions(el);
        if (opts.length) d.options = opts;
      }
      descriptors.push(d);
    }
    return descriptors;
  }

  /**
   * Set a value and fire the events frameworks (React/Vue/Angular) listen for.
   * Robust against controlled inputs that ignore a bare value assignment:
   *  - write via the element's OWN prototype setter (React patches the instance
   *    setter to detect "unmanaged" writes; the prototype setter bypasses that
   *    so React picks the change up),
   *  - focus first and blur after (many forms validate/commit on blur),
   *  - dispatch a real InputEvent + a keyup so keystroke-listeners react too.
   * Returns true if the value actually stuck on the element.
   */
  function setNativeValue(el, value) {
    try { el.focus?.(); } catch { /* ignore */ }
    const proto = el.tagName === "TEXTAREA"
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    if (setter) setter.call(el, value);
    else el.value = value;
    try {
      el.dispatchEvent(new InputEvent("input", { bubbles: true, data: value, inputType: "insertText" }));
    } catch {
      el.dispatchEvent(new Event("input", { bubbles: true }));
    }
    el.dispatchEvent(new Event("change", { bubbles: true }));
    el.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true }));
    try { el.blur?.(); } catch { /* ignore */ }
    el.dispatchEvent(new Event("blur", { bubbles: true }));
    el.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    return el.value === value;
  }

  function selectByText(selectEl, value) {
    const want = value.trim().toLowerCase();
    let match = Array.from(selectEl.options).find((o) => o.text.trim().toLowerCase() === want);
    if (!match) match = Array.from(selectEl.options).find((o) => o.text.trim().toLowerCase().includes(want));
    if (!match) return false;
    selectEl.value = match.value;
    selectEl.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }

  function radioNorm(s) {
    return String(s || "").toLowerCase().replace(/\s+/g, " ").trim();
  }

  /** Check a radio robustly: input click → label click → manual + events. */
  function selectRadio(el) {
    if (!el) return false;
    if (el.checked) return true;
    el.focus?.();
    el.click();
    if (el.checked) return true;
    // Custom-styled radios often only respond to a click on their <label>.
    const lbl = el.id ? document.querySelector(`label[for="${CSS.escape(el.id)}"]`) : el.closest("label");
    if (lbl) { lbl.click(); if (el.checked) return true; }
    // Last resort for controlled components that ignored the click.
    el.checked = true;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    return el.checked;
  }

  /**
   * Select the radio whose option text matches `value`. `opts` is the exact
   * [{el,text}] we sent the server, so we match the returned value against the
   * same strings: exact → prefix → shortest substring (so "Yes" beats "Yes, with
   * sponsorship" when the answer is just "Yes").
   */
  function chooseRadio(opts, value) {
    const want = radioNorm(value);
    if (!want || !Array.isArray(opts)) return false;
    const scored = opts.map((o) => ({ el: o.el, t: radioNorm(o.text) })).filter((o) => o.t);
    const byLen = (a, b) => a.t.length - b.t.length;
    const target =
      (scored.find((o) => o.t === want) || {}).el ||
      (scored.filter((o) => o.t.startsWith(want) || want.startsWith(o.t)).sort(byLen)[0] || {}).el ||
      (scored.filter((o) => o.t.includes(want) || want.includes(o.t)).sort(byLen)[0] || {}).el ||
      null;
    return selectRadio(target);
  }

  /** Tick or untick a checkbox robustly (input click → label click → manual). */
  function toggleCheckbox(el, want) {
    if (!el) return false;
    if (!!el.checked === !!want) return true;
    el.focus?.();
    el.click();
    if (!!el.checked === !!want) return true;
    const lbl = el.id ? document.querySelector(`label[for="${CSS.escape(el.id)}"]`) : el.closest("label");
    if (lbl) { lbl.click(); if (!!el.checked === !!want) return true; }
    el.checked = !!want;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    return !!el.checked === !!want;
  }

  /**
   * Check every box in a "select all that apply" group whose option text
   * matches a part of `value`. The server returns the chosen options joined by
   * " | " (each already an exact option), so we split on that and match each.
   * Exact/prefix match only — never loose substring, so "Product analytics"
   * doesn't also tick "Marketing analytics".
   */
  function checkBoxes(opts, value) {
    const wants = String(value || "").split(/\s*(?:\||;|\r?\n)\s*/).map(radioNorm).filter(Boolean);
    if (!wants.length || !Array.isArray(opts)) return false;
    let any = false;
    for (const o of opts) {
      const t = radioNorm(o.text);
      if (!t) continue;
      const hit = wants.some((w) => t === w || t.startsWith(w) || w.startsWith(t));
      if (hit && toggleCheckbox(o.el, true)) any = true;
    }
    return any;
  }

  // Treat an input as a typeahead/combobox if it advertises async options. These
  // need real keystrokes to trigger their debounced search, then a click on the
  // surfaced option — setting .value alone does nothing.
  function isCombobox(el) {
    if (el.tagName !== "INPUT") return false;
    const role = (el.getAttribute("role") || "").toLowerCase();
    return (
      role === "combobox" ||
      el.hasAttribute("aria-autocomplete") ||
      el.hasAttribute("aria-controls") ||
      el.getAttribute("aria-expanded") !== null
    );
  }

  // react-select (and look-alikes) wrap a styled control DIV around a frequently
  // hidden text input. For non-searchable selects (EEO / demographic questions:
  // Gender, Hispanic/Latino, Race, Veteran status) the input is a 0×0 / opacity:0
  // "DummyInput" with NO aria-combobox attributes, so isCombobox() misses it and
  // visible() drops it. Detect the widget by its control wrapper instead.
  //
  // Guard against false positives: Bootstrap's plain inputs carry `form-control`
  // (also ends in "-control"), so `closest('[class*="-control"]')` would match
  // the input itself. We only treat it as a widget when an ANCESTOR control
  // wrapper also holds a dropdown indicator / placeholder child — a structure
  // plain inputs don't have.
  function inSelectWidget(el) {
    if (el.tagName !== "INPUT") return false;
    const ctrl = el.closest('[class*="-control"], [class*="__control"]');
    if (!ctrl || ctrl === el) return false;
    return !!ctrl.querySelector(
      '[class*="ndicator"], [class*="placeholder"], [class*="Placeholder"], [class*="dropdown"], [class*="Dropdown"], [class*="arrow"], [class*="caret"]',
    );
  }

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  function fireKey(el, key) {
    for (const type of ["keydown", "keypress", "input", "keyup"]) {
      if (type === "input") {
        el.dispatchEvent(new InputEvent("input", { bubbles: true, data: key }));
      } else {
        el.dispatchEvent(new KeyboardEvent(type, { bubbles: true, key }));
      }
    }
  }

  /** All currently-rendered option elements anywhere (menus often portal to body). */
  function visibleOptionEls() {
    return Array.from(
      document.querySelectorAll(
        '[role="option"], li[role="option"], [class*="-option"], [class*="__option"], [class*="MenuItem"], [class*="menu-item"]',
      ),
    ).filter((o) => {
      const cs = getComputedStyle(o);
      if (cs.display === "none" || cs.visibility === "hidden") return false;
      const r = o.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    });
  }

  /** Pre-read option labels for a combobox (best-effort; many libs render lazily). */
  function comboboxOptions(el) {
    const controls = el.getAttribute("aria-controls");
    let list = controls ? document.getElementById(controls) : null;
    let opts = list ? Array.from(list.querySelectorAll('[role="option"], li, [class*="option"]')) : [];
    return opts.map((o) => clamp(o.textContent.trim(), MAX_OPTION)).filter(Boolean).slice(0, 60);
  }

  function bestOptionMatch(opts, value) {
    const want = value.trim().toLowerCase();
    if (!want) return null;
    const norm = (o) => o.textContent.trim().toLowerCase();
    return (
      // exact, then option-begins-with-value, then option-contains-the-WHOLE-value
      opts.find((o) => norm(o) === want) ||
      opts.find((o) => norm(o).startsWith(want)) ||
      opts.find((o) => norm(o).includes(want)) ||
      // value begins with the option as whole leading words (e.g. "United States
      // of America" ⊃ "United States"). Require length ≥ 4 so a stray 2–3 char
      // option ("JA") can't match because it's a substring of a name ("James").
      opts.find((o) => {
        const t = norm(o);
        return t.length >= 4 && want.startsWith(t + " ");
      }) ||
      null
    );
  }

  function realClick(el) {
    // react-select opens on mousedown, not click; fire the full sequence.
    for (const type of ["pointerdown", "mousedown", "mouseup", "click"]) {
      try {
        el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
      } catch {
        el.click?.();
      }
    }
  }

  /** The clickable control for a combobox input (react-select's `.control` div). */
  function comboboxControl(el) {
    return (
      el.closest('[class*="-control"]') ||
      el.closest('[class*="__control"]') ||
      el.closest('[role="combobox"]') ||
      el.parentElement ||
      el
    );
  }

  /**
   * Fill a custom dropdown / typeahead (react-select, downshift, MUI, etc.):
   * open the menu, type to filter if the input is searchable, then click the
   * best-matching option. Falls back to keyboard ArrowDown+Enter.
   */
  async function fillCombobox(el, value) {
    const control = comboboxControl(el);
    realClick(control);
    el.focus?.();
    await sleep(120);

    // If the input accepts text, type the value so async/filtered menus populate.
    const canType = !el.readOnly && el.tagName === "INPUT";
    if (canType) {
      setNativeValue(el, value);
      fireKey(el, value.slice(-1) || "a");
    }
    await sleep(600);

    let opts = visibleOptionEls();
    let match = bestOptionMatch(opts, value);

    // Menu may not have opened on the first click; try once more.
    if (!match) {
      realClick(control);
      await sleep(400);
      opts = visibleOptionEls();
      match = bestOptionMatch(opts, value);
    }

    if (match) {
      match.scrollIntoView?.({ block: "nearest" });
      realClick(match);
      await sleep(80);
      return true;
    }

    // Keyboard fallback: ArrowDown to highlight, Enter to commit.
    el.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "ArrowDown", code: "ArrowDown" }));
    await sleep(150);
    el.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter", code: "Enter" }));
    await sleep(80);
    return false; // couldn't confirm a real selection
  }

  /** Apply a ref->value list; returns count of fields actually filled. */
  async function applyValues(values) {
    let filled = 0;
    for (const { ref, value } of values) {
      const entry = refToEl.get(ref);
      if (!entry || !value) continue;
      try {
        const combo = entry.kind === "combobox" || (entry.kind !== "select" && entry.kind !== "radio" && entry.kind !== "checkboxes" && isCombobox(entry.el));
        // Bring the field into view first — some controlled inputs ignore writes
        // while off-screen, and it lets the user see what's being filled.
        if (entry.el && entry.el.scrollIntoView) {
          try { entry.el.scrollIntoView({ block: "center", behavior: "instant" }); } catch { /* ignore */ }
        }
        if (entry.kind === "select") {
          if (selectByText(entry.el, value)) filled++;
        } else if (combo) {
          // Honor the combobox_fill flag; if off, set the raw text as a fallback.
          if (flagOn("combobox_fill")) {
            if (await fillCombobox(entry.el, value)) filled++;
          } else {
            setNativeValue(entry.el, value);
            filled++;
          }
        } else if (entry.kind === "radio") {
          if (chooseRadio(entry.opts, value)) filled++;
        } else if (entry.kind === "checkboxes") {
          if (checkBoxes(entry.opts, value)) filled++;
        } else {
          setNativeValue(entry.el, value);
          filled++;
        }
      } catch {
        /* skip a field that won't take the value */
      }
    }
    return filled;
  }

  // --- résumé attach (DataTransfer trick) ------------------------------------

  function dataUrlToBytes(dataUrl) {
    const [meta, b64] = dataUrl.split(",");
    const mime = meta.match(/data:([^;]+)/)?.[1] ?? "application/octet-stream";
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return { bytes, mime };
  }

  function dataUrlToFile(dataUrl, filename, type) {
    const { bytes, mime } = dataUrlToBytes(dataUrl);
    return new File([bytes], filename, { type: type || mime });
  }

  // Chrome blocks top-level navigation to data: URLs, so a data-URL PDF opened
  // via window.open lands on a blank/null page. Convert to a blob: URL, which
  // IS navigable, and open that instead.
  function openDataUrlInTab(dataUrl, type) {
    const { bytes, mime } = dataUrlToBytes(dataUrl);
    const blob = new Blob([bytes], { type: type || mime || "application/pdf" });
    const url = URL.createObjectURL(blob);
    const win = window.open(url, "_blank");
    // Revoke after the tab has had time to load; revoking immediately can abort
    // the navigation in some Chrome versions.
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    return !!win;
  }

  /**
   * Find a résumé-ish file input. ATS dropzones almost always keep the real
   * <input type=file> hidden (0×0, display:none, opacity:0) behind a styled
   * button, so we must NOT filter by visibility here. We accept any enabled
   * file input, scoring résumé/PDF signals — including the dropzone wrapper's
   * text, not just the input's own attributes.
   */
  /** All enabled file inputs in the main document + same-origin iframes. */
  function collectFileInputs() {
    let inputs = Array.from(document.querySelectorAll('input[type="file"]'));
    for (const frame of document.querySelectorAll("iframe")) {
      try {
        const doc = frame.contentDocument;
        if (doc) inputs.push(...doc.querySelectorAll('input[type="file"]'));
      } catch {
        /* cross-origin frame — not accessible, skip */
      }
    }
    return inputs.filter((el) => !el.disabled);
  }

  /** Searchable text describing a file input (label + attrs + dropzone text). */
  function fileInputHaystack(el) {
    const accept = (el.getAttribute("accept") || "").toLowerCase();
    const zone = el.closest("div,section,fieldset,li,form") || el.parentElement;
    const zoneText = (zone?.innerText || "").toLowerCase();
    return { accept, text: [labelFor(el), el.name, el.id, accept, zoneText].filter(Boolean).join(" ").toLowerCase() };
  }

  /**
   * Find the best file input for a document kind ("resume" | "cover").
   * @param exclude a Set of inputs already claimed by another document.
   * @param allowSoleFallback when true, fall back to the single unclaimed input
   *   even if it didn't score (résumé forms rarely label the input; CV must not
   *   grab an unlabeled input or it would land on the résumé field).
   */
  function findFileInput(kind, exclude, allowSoleFallback) {
    const inputs = collectFileInputs().filter((el) => !exclude || !exclude.has(el));
    if (inputs.length === 0) return null;
    const scored = inputs.map((el) => {
      const { accept, text } = fileInputHaystack(el);
      let score = 0;
      const isResumeWord = /resume|résumé|curriculum vitae|(^|\W)cv(\W|$)/.test(text);
      const isCoverWord = /cover\s*letter/.test(text);
      if (kind === "cover") {
        if (isCoverWord) score += 3;
        if (isResumeWord) score -= 2;
      } else {
        if (isResumeWord) score += 3;
        if (isCoverWord) score -= 2;
      }
      if (/\.pdf|application\/pdf|\.docx?/.test(accept)) score += 1;
      return { el, score };
    });
    scored.sort((a, b) => b.score - a.score);
    if (scored[0].score > 0) return scored[0].el;
    if (allowSoleFallback) {
      const best = scored.find((s) => s.score > 0);
      return best ? best.el : scored[0].el;
    }
    return null;
  }

  function findResumeFileInput() {
    return findFileInput("resume", null, true);
  }

  /**
   * Attach a File to a file input via the DataTransfer trick. Returns true if
   * the file stuck on the input.
   *
   * IMPORTANT: we fire ONLY input + change here — NOT synthetic drop events.
   * Greenhouse (and most React ATS uploaders) handle `change`, immediately
   * begin an async S3 upload of input.files[0], and a second synthetic `drop`
   * carrying the same DataTransfer re-enters their handler and corrupts the
   * in-flight upload ("Your file didn't upload. Try again."). Pure drag-and-drop
   * zones with no <input type=file> are handled separately by dropFileOnZone().
   */
  function attachFileToInput(input, file) {
    const dt = new DataTransfer();
    dt.items.add(file);
    try {
      input.files = dt.files;
    } catch {
      // Some frameworks define a non-writable files getter; redefine on this
      // element instance so the value sticks.
      Object.defineProperty(input, "files", { value: dt.files, configurable: true });
    }
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    return !!(input.files && input.files.length > 0);
  }

  /** Fallback for a pure drag-and-drop zone that has no usable file input. */
  function dropFileOnZone(zone, file) {
    const dt = new DataTransfer();
    dt.items.add(file);
    try {
      const opts = { bubbles: true, cancelable: true };
      zone.dispatchEvent(new DragEvent("dragenter", { ...opts, dataTransfer: dt }));
      zone.dispatchEvent(new DragEvent("dragover", { ...opts, dataTransfer: dt }));
      zone.dispatchEvent(new DragEvent("drop", { ...opts, dataTransfer: dt }));
      return true;
    } catch {
      return false;
    }
  }

  // --- UI (shadow DOM, isolated from page styles) ----------------------------

  const mount = document.createElement("div");
  mount.id = "enpplify-root";
  mount.style.cssText = "all:initial; position:fixed; z-index:2147483647; right:16px; bottom:16px;";
  const shadow = mount.attachShadow({ mode: "open" });
  shadow.innerHTML = `
    <style>
      :host { all: initial; }
      * { box-sizing: border-box; font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }

      /* ---- Tryvify palette ----
         #E8590C primary · #C94A05 primary-hover · #FFF4ED soft fill
         #FFD9BF soft border · #1B1F24 ink · #6B7280 muted · #E5E7EB border

         Icon strategy: child <svg><use> wherever the markup is ours to keep, and
         CSS mask pseudo-elements on any element whose textContent JS rewrites
         (#go, #moreBtn, .fldbtn) — a pseudo-element survives textContent
         assignment, a child node would be destroyed by it. */
      :host {
        --ic-doc: url('data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="black" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M13 2v7h7M8.5 13h7M8.5 17h5"/></svg>');
        --ic-bolt: url('data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="black" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M13.5 2 4 13.5h6.5L10 22l9.5-11.5H13z"/></svg>');
        --ic-copy: url('data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="black" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="8.5" y="8.5" width="12" height="12" rx="2.2"/><path d="M15.5 5.5v-1a2 2 0 0 0-2-2h-8a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h1"/></svg>');
        --ic-chevd: url('data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="black" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>');
        --ic-chevr: url('data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="black" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 6 6 6-6 6"/></svg>');
        --ic-upload: url('data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="black" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 15.5V3.8M8.2 7.6 12 3.8l3.8 3.8"/><path d="M4.5 15v3.5a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V15"/></svg>');
        --ic-dl: url('data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="black" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3.8v11.7M8.2 11.7 12 15.5l3.8-3.8M4.5 15v3.5a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V15"/></svg>');
        --ic-key: url('data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="black" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="7.5" cy="15.5" r="4"/><path d="m10.4 12.6 8.1-8.1M16.5 6.5l2.5 2.5M14 9l2.5 2.5"/></svg>');
        --ic-refresh2: url('data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="black" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M20.5 11a8.5 8.5 0 0 0-14.6-5L3.5 8.3"/><path d="M3.5 4v4.3h4.3M3.5 13a8.5 8.5 0 0 0 14.6 5l2.4-2.3"/><path d="M20.5 20v-4.3h-4.3"/></svg>');
      }

      .wrap { display: block; }

      .panel {
        width: 316px; background: #fff; color: #1b1f24;
        border: 1px solid #e5e7eb; border-radius: 14px;
        box-shadow: 0 1px 2px rgba(16,24,40,.04), 0 10px 30px -8px rgba(16,24,40,.18);
        overflow: hidden; font-size: 12.5px; line-height: 1.45;
        display: flex; flex-direction: column; max-height: 92vh;
      }

      /* ---- header ---- */
      .hd {
        display: flex; align-items: center; gap: 9px; flex: 0 0 auto;
        padding: 11px 12px; cursor: grab; user-select: none;
        background: #fff; border-bottom: 1px solid #f1f2f4;
      }
      .hd.dragging { cursor: grabbing; }

      /* drag grip — a dot grid drawn in CSS, no glyph */
      .draghint {
        flex: 0 0 auto; width: 9px; height: 13px; cursor: grab; font-size: 0; padding: 0;
        background-image: radial-gradient(#cbd0d6 1.1px, transparent 1.2px);
        background-size: 4px 4px; background-position: 0 1px;
      }

      .brand { display: flex; align-items: center; gap: 7px; min-width: 0; flex: 1 1 auto; }
      .logo { display: none; }
      .brand .ttl { font-size: 14px; font-weight: 680; letter-spacing: -.012em; flex: 0 0 auto; }

      .hd .tools { display: flex; align-items: center; gap: 2px; flex: 0 0 auto; }
      .iconbtn {
        border: none; background: transparent; color: #9ca3af; padding: 0; font-size: 0;
        width: 26px; height: 26px; border-radius: 7px; cursor: pointer;
        display: flex; align-items: center; justify-content: center;
        transition: background .12s, color .12s;
      }
      .iconbtn svg { width: 15px; height: 15px; }
      .iconbtn:hover:not(:disabled) { background: #f3f4f6; color: #1b1f24; }
      .iconbtn:disabled { opacity: .5; cursor: default; }
      .iconbtn.spin svg { animation: enpplify-spin .8s linear infinite; }

      /* ---- body ---- */
      .bd {
        padding: 0; display: flex; flex-direction: column;
        flex: 1 1 auto; min-height: 0; overflow-y: auto; background: #f9fafb;
      }
      .bd.hidden { display: none; }
      .hidden { display: none !important; }
      .bd::-webkit-scrollbar { width: 8px; }
      .bd::-webkit-scrollbar-thumb { background: #e0e3e7; border-radius: 4px; }

      #auth { padding: 18px 14px; }
      #app { display: flex; flex-direction: column; }

      /* ---- job context band, flush under the header ---- */
      .jobhd {
        padding: 9px 13px; background: #fff; border-bottom: 1px solid #f1f2f4;
        display: flex; flex-direction: column; gap: 1px; flex: 0 0 auto;
      }
      .jobhd.hidden { display: none; }
      .jobco {
        font-size: 11px; color: #6b7280; line-height: 1.3;
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      }
      .jobrole {
        font-size: 12.5px; font-weight: 640; color: #1b1f24; line-height: 1.3;
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      }
      .jobrole:empty { display: none; }

      /* ---- status line ---- */
      .statusline {
        display: flex; align-items: center; gap: 7px; flex: 0 0 auto;
        padding: 10px 12px 0;
      }
      .statusline:not(:has(.status:not(:empty))):not(:has(.spinner:not(.hidden))) { display: none; }
      #statusline { margin-bottom: 0; }
      .spinner {
        width: 12px; height: 12px; flex: 0 0 auto;
        border: 1.8px solid #ffd9bf; border-top-color: #e8590c; border-radius: 50%;
        animation: enpplify-spin .8s linear infinite;
      }
      @keyframes enpplify-spin { to { transform: rotate(360deg); } }
      .status { margin: 0; font-size: 11.5px; color: #6b7280; line-height: 1.4; }
      .status.err { color: #b91c1c; }
      .status.ok { color: #15803d; }

      .hint { color: #9ca3af; font-size: 11px; margin: 0; text-align: center; line-height: 1.5; }

      /* ---- sections ---- */
      .sec { display: flex; flex-direction: column; padding: 11px 12px; gap: 10px; }
      .sec + .sec { padding-top: 0; }
      .seclabel { display: none; }
      .sep { display: none; }

      /* ---- buttons (base) ---- */
      .btnrow { display: flex; gap: 7px; }
      /* a row holding only hidden children collapses instead of leaving a gap */
      .btnrow:not(:has(> :not(.hidden))) { display: none; }

      button.btn {
        flex: 1; min-width: 0; display: inline-flex; align-items: center; justify-content: center;
        gap: 6px; padding: 8px 10px; border-radius: 8px; border: 1px solid #e5e7eb;
        background: #fff; color: #374151; font-family: inherit;
        font-size: 11.8px; font-weight: 580; cursor: pointer; transition: all .12s;
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      }
      button.btn:hover:not(:disabled):not(.disabled) { background: #f9fafb; border-color: #d1d5db; }
      button.btn:disabled { opacity: .45; cursor: default; }
      button.btn.disabled { opacity: .45; pointer-events: none; }

      /* ---- hero: the two primary actions ---- */
      .hero {
        background: #fff; border: 1px solid #e5e7eb; border-radius: 11px;
        padding: 11px; display: flex; flex-direction: column; gap: 7px;
      }
      .hero .btnrow { flex-direction: column; }

      button.primary {
        background: #e8590c; border-color: #e8590c; color: #fff;
        box-shadow: 0 1px 2px rgba(232,89,12,.28);
        font-size: 13px; font-weight: 650; padding: 11px 12px; letter-spacing: -.005em;
      }
      button.primary:hover:not(:disabled):not(.disabled) { background: #c94a05; border-color: #c94a05; }
      button.primary::before {
        content: ""; width: 16px; height: 16px; flex: 0 0 auto; background: currentColor;
        -webkit-mask: var(--ic-doc) center/contain no-repeat; mask: var(--ic-doc) center/contain no-repeat;
      }

      button.fillall {
        background: #fff; border-color: #ffd9bf; color: #c2410c;
        box-shadow: none; font-size: 13px; font-weight: 650; padding: 11px 12px;
      }
      button.fillall:hover:not(:disabled):not(.disabled) { background: #fff4ed; border-color: #ffd9bf; }
      button.fillall::before {
        -webkit-mask: var(--ic-bolt) center/contain no-repeat; mask: var(--ic-bolt) center/contain no-repeat;
      }

      button.ghost { background: #fff; color: #374151; border-color: #e5e7eb; font-weight: 560; }
      button.ghost:hover:not(:disabled):not(.disabled) { background: #f9fafb; border-color: #d1d5db; }

      /* leading glyphs for the secondary actions in the Documents drawer */
      #dl::before {
        content: ""; width: 13px; height: 13px; flex: 0 0 auto; background: #6b7280;
        -webkit-mask: var(--ic-dl) center/contain no-repeat; mask: var(--ic-dl) center/contain no-repeat;
      }
      #regen::before {
        content: ""; width: 13px; height: 13px; flex: 0 0 auto; background: #6b7280;
        -webkit-mask: var(--ic-refresh2) center/contain no-repeat; mask: var(--ic-refresh2) center/contain no-repeat;
      }
      #pw::before {
        content: ""; width: 13px; height: 13px; flex: 0 0 auto; background: #6b7280;
        -webkit-mask: var(--ic-key) center/contain no-repeat; mask: var(--ic-key) center/contain no-repeat;
      }

      /* ---- unified row group ---- */
      .grp { border: 1px solid #e5e7eb; border-radius: 11px; background: #fff; overflow: hidden; }
      .grp > * + * { border-top: 1px solid #f1f2f4; }

      /* every control inside the group renders as a full-width row lockup */
      .grp button.btn {
        display: flex; align-items: center; justify-content: flex-start; text-align: left;
        gap: 10px; width: 100%; padding: 10px 11px;
        border: none; border-radius: 0; background: #fff; color: #1b1f24;
        font-size: 12.5px; font-weight: 580; white-space: normal; overflow: visible;
      }
      .grp button.btn:hover:not(:disabled):not(.disabled) { background: #fafbfc; border: none; }
      .grp button.btn::before { content: none; }

      .ri {
        width: 30px; height: 30px; border-radius: 8px; flex: 0 0 auto;
        display: inline-flex; align-items: center; justify-content: center;
        background: #fff4ed; color: #e8590c;
      }
      .ri svg { width: 15px; height: 15px; }
      .ri.neutral { background: #f3f4f6; color: #6b7280; }

      .rt { min-width: 0; flex: 1 1 auto; display: flex; flex-direction: column; gap: 1px; }
      .rt b {
        display: block; font-size: 12.8px; font-weight: 640; color: #1b1f24;
        letter-spacing: -.003em; line-height: 1.3;
      }
      /* The description wraps rather than truncating: if the row ever gets narrow
         (long profile name, zoomed page), an ellipsised subtitle can collapse to
         nothing, which reads as a missing description. Wrapping degrades to two
         short lines instead of disappearing. */
      .rt span {
        display: block; font-size: 11px; color: #6b7280; line-height: 1.35;
        font-weight: 400; white-space: normal; overflow-wrap: anywhere;
      }

      .rowchev {
        width: 15px; height: 15px; flex: 0 0 auto; background: #c3c8cf;
        -webkit-mask: var(--ic-chevr) center/contain no-repeat; mask: var(--ic-chevr) center/contain no-repeat;
      }

      /* split row: the lockup is the main button, the caret sits beside it */
      .rowsplit { display: flex; align-items: stretch; background: #fff; }
      .rowsplit:hover { background: #fafbfc; }
      .grp .rowsplit button.btn { background: transparent; }
      .split { display: contents; }
      .grp .splitmain { flex: 1 1 auto; min-width: 0; }
      .grp .splitcaret {
        flex: 0 0 auto; width: 38px; padding: 0; justify-content: center;
        font-size: 0; color: #c3c8cf; background: transparent;
      }
      .grp .splitcaret::after {
        content: ""; width: 15px; height: 15px; background: currentColor;
        -webkit-mask: var(--ic-chevr) center/contain no-repeat; mask: var(--ic-chevr) center/contain no-repeat;
        transition: transform .16s ease;
      }
      .grp .splitcaret:hover:not(:disabled) { color: #6b7280; background: transparent; }
      .splitcaret.open { color: #e8590c; }
      .splitcaret.open::after { transform: rotate(90deg); }

      /* ---- native disclosure for Documents (no JS) ---- */
      details.disc { display: block; }
      details.disc > summary {
        list-style: none; cursor: pointer;
        display: flex; align-items: center; gap: 10px; padding: 10px 11px; background: #fff;
      }
      details.disc > summary::-webkit-details-marker { display: none; }
      details.disc > summary::marker { content: ""; }
      details.disc > summary:hover { background: #fafbfc; }
      .discchev {
        width: 15px; height: 15px; flex: 0 0 auto; background: #c3c8cf;
        -webkit-mask: var(--ic-chevd) center/contain no-repeat; mask: var(--ic-chevd) center/contain no-repeat;
        transition: transform .16s ease;
      }
      details.disc[open] > summary .discchev { transform: rotate(180deg); }

      /* ---- drawer ---- */
      .drawer {
        padding: 0 11px 11px; display: flex; flex-direction: column; gap: 8px;
        background: #fcfcfd; border-top: 1px solid #f1f2f4;
      }

      /* ---- chips + checkbox rows ---- */
      .toggles { display: flex; gap: 7px; }
      label.chip {
        flex: 1; display: flex; align-items: center; gap: 7px; cursor: pointer;
        padding: 7px 9px; border: 1px solid #e5e7eb; border-radius: 8px;
        background: #fff; font-size: 11.8px; color: #4b5563; transition: all .12s;
      }
      label.chip:hover { border-color: #d1d5db; }
      label.chip:has(input:checked) {
        border-color: #ffd9bf; background: #fff4ed; color: #9a3412; font-weight: 600;
      }
      label.chip input { width: 14px; height: 14px; accent-color: #e8590c; cursor: pointer; flex: 0 0 auto; }
      label.row { display: flex; align-items: center; gap: 8px; cursor: pointer; font-size: 11.5px; color: #6b7280; }
      label.row input { width: 14px; height: 14px; accent-color: #e8590c; cursor: pointer; flex: 0 0 auto; }
      .row.disabled, .chip.disabled { opacity: .4; pointer-events: none; }

      /* ---- Copy path — keeps .cpicon + .cptext (JS rewrites .cptext only) ---- */
      button.cppath { gap: 6px; }
      .cpicon {
        width: 13px; height: 13px; flex: 0 0 auto; background: #6b7280;
        -webkit-mask: var(--ic-copy) center/contain no-repeat; mask: var(--ic-copy) center/contain no-repeat;
      }
      .cptext { min-width: 0; overflow: hidden; text-overflow: ellipsis; }

      /* ---- More toggle — JS writes its textContent and aria-expanded ---- */
      #moreBtn { justify-content: center; }
      #moreBtn::after {
        content: ""; width: 13px; height: 13px; flex: 0 0 auto; background: currentColor;
        -webkit-mask: var(--ic-chevd) center/contain no-repeat; mask: var(--ic-chevd) center/contain no-repeat;
        opacity: .6; transition: transform .16s ease;
      }
      #moreBtn[aria-expanded="true"]::after { transform: rotate(180deg); }
      .more { display: flex; flex-direction: column; gap: 8px; }

      /* ---- drill-in sub-view ----
         While a list is open the panel becomes that list: the hero, the row group
         and the "more" region hide, and a back bar appears. Pure CSS on top of the
         existing hidden/open classes — the open/close JS is untouched. */
      .fldnav {
        display: none; align-items: center; gap: 8px;
        padding: 9px 12px; background: #fff; border-bottom: 1px solid #f1f2f4;
        margin: 0 -12px;
      }
      .sec:has(#fldMenu:not(.hidden)) .fldnav { display: flex; }
      .fldnav .navttl { font-size: 13px; font-weight: 660; }
      .fldnav .navttl { display: none; }
      .sec:has(#flCaret.open) .fldnav .navttl.t-easy { display: block; }
      .sec:has(#aiCaret.open) .fldnav .navttl.t-qa { display: block; }
      .backbtn {
        width: 26px; height: 26px; flex: 0 0 auto; padding: 0; font-size: 0;
        border: 1px solid #e5e7eb; background: #fff; border-radius: 7px; color: #4b5563;
        display: inline-flex; align-items: center; justify-content: center; cursor: pointer;
      }
      .backbtn svg { width: 14px; height: 14px; }
      .backbtn:hover { background: #f9fafb; border-color: #d1d5db; }

      #app:has(#fldMenu:not(.hidden)) > .jobhd,
      #app:has(#fldMenu:not(.hidden)) > .statusline,
      #app:has(#fldMenu:not(.hidden)) > .sec.first { display: none; }
      .sec:has(#fldMenu:not(.hidden)) > .grp,
      .sec:has(#fldMenu:not(.hidden)) > #moreBtn,
      .sec:has(#fldMenu:not(.hidden)) > #moreWrap { display: none; }
      .sec:has(#fldMenu:not(.hidden)) { padding-top: 0; }

      /* ---- the list ---- */
      .fldmenu {
        display: flex; flex-direction: column; gap: 7px;
        border: none; border-radius: 0; padding: 0; background: transparent;
        max-height: 60vh; overflow-y: auto;
      }
      .fldmenu::-webkit-scrollbar { width: 8px; }
      .fldmenu::-webkit-scrollbar-thumb { background: #e0e3e7; border-radius: 4px; }

      .fldloading, .fldempty {
        font-size: 12px; color: #6b7280; padding: 20px 14px; text-align: center; line-height: 1.5;
      }
      .fldempty::before {
        content: ""; display: block; width: 30px; height: 30px; margin: 0 auto 10px;
        background: #e8590c;
        -webkit-mask: var(--ic-bolt) center/contain no-repeat; mask: var(--ic-bolt) center/contain no-repeat;
      }
      .fldloading::before {
        content: ""; display: block; width: 22px; height: 22px; margin: 0 auto 10px;
        border: 2px solid #ffd9bf; border-top-color: #e8590c; border-radius: 50%;
        animation: enpplify-spin .8s linear infinite;
      }

      /* password / instant rows */
      button.flditem {
        display: flex; flex-direction: column; gap: 5px; align-items: stretch; text-align: left;
        border: 1px solid #e5e7eb; border-radius: 9px; background: #fff; padding: 9px;
        cursor: pointer; transition: all .12s; width: 100%; font-family: inherit;
      }
      button.flditem:hover:not(:disabled) { border-color: #d1d5db; background: #fafbfc; }
      button.flditem:disabled { opacity: .6; cursor: default; }
      button.flditem.done { border-color: #bbf7d0; background: #f0fdf4; }

      .fldtop { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
      .fldlabel {
        font-size: 11.8px; font-weight: 620; color: #1b1f24; min-width: 0;
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      }
      .fldval {
        font-size: 11.5px; color: #4b5563; background: #f9fafb; border: 1px solid #f1f2f4;
        border-radius: 6px; padding: 5px 7px; line-height: 1.45;
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      }
      .fldval.muted { font-style: normal; color: #9ca3af; }

      .fldtag {
        flex: 0 0 auto; font-size: 9px; font-weight: 700; text-transform: uppercase;
        letter-spacing: .05em; padding: 3px 7px; border-radius: 999px;
      }
      .fldtag.heu { background: #f3f4f6; color: #6b7280; }
      .fldtag.ai { background: #fff4ed; color: #c2410c; }
      .fldtag.saved { background: #f0fdf4; color: #15803d; }
      .fldtag.reuse { background: #eff6ff; color: #1d4ed8; }

      /* editable answer rows */
      .answerrow {
        display: flex; flex-direction: column; gap: 6px;
        border: 1px solid #e5e7eb; border-radius: 9px; background: #fff; padding: 9px;
      }
      .answerrow.done { border-color: #bbf7d0; background: #f0fdf4; }
      .answerrow .fldtop { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
      .answerrow.addrow { background: #fcfcfd; border-style: dashed; border-color: #e5e7eb; }

      .fldinput, .fldqinput {
        width: 100%; font-family: inherit; font-size: 11.8px; line-height: 1.45; color: #1b1f24;
        border: 1px solid #e5e7eb; border-radius: 7px; padding: 7px 8px; background: #fff;
      }
      .fldinput { resize: vertical; min-height: 34px; }
      .fldinput::placeholder, .fldqinput::placeholder { color: #9ca3af; }
      .fldinput:focus, .fldqinput:focus {
        outline: none; border-color: #e8590c; box-shadow: 0 0 0 3px rgba(232,89,12,.12);
      }

      .fldacts { display: flex; gap: 5px; flex-wrap: wrap; }
      .fldbtn {
        flex: 1; min-width: 52px; padding: 5px 8px; border-radius: 6px;
        border: 1px solid #e5e7eb; background: #fff; color: #6b7280; font-family: inherit;
        font-size: 10.5px; font-weight: 570; cursor: pointer; white-space: nowrap; transition: all .12s;
      }
      .fldbtn:hover:not(:disabled) { background: #f9fafb; color: #374151; border-color: #d1d5db; }
      .fldbtn:disabled { opacity: .55; cursor: default; }
      .fldbtn.fill { background: #e8590c; color: #fff; border-color: #e8590c; }
      .fldbtn.fill:hover:not(:disabled) { background: #c94a05; border-color: #c94a05; color: #fff; }
      .fldbtn.gen { background: #fff9f5; color: #c2410c; border-color: #ffd9bf; }
      .fldbtn.gen:hover:not(:disabled) { background: #fff4ed; color: #c2410c; border-color: #ffd9bf; }
      .fldbtn.save { color: #374151; font-weight: 620; }
      .fldbtn.copy { color: #6b7280; }
      .fldbtn.del { color: #b91c1c; }
      .fldbtn.del:hover:not(:disabled) { background: #fef2f2; color: #b91c1c; border-color: #fecaca; }
      /* "→ Profile" promotes an answer to the reusable store — blue, matching the
         .fldtag.reuse badge, and given its own line since the label is long. */
      .fldbtn.toprofile {
        flex: 1 0 100%; background: #f8fbff; color: #1d4ed8; border-color: #dbeafe;
      }
      .fldbtn.toprofile:hover:not(:disabled) { background: #eff6ff; color: #1d4ed8; border-color: #bfdbfe; }

      .linkbtn {
        align-self: flex-start; border: none; background: none; padding: 0; font-family: inherit;
        color: #c2410c; cursor: pointer; font-size: 11.5px; font-weight: 600;
      }
      .linkbtn:hover { text-decoration: underline; }

      /* ---- drop zone ---- */
      .drop {
        border: 1.5px dashed #ffd9bf; border-radius: 9px; padding: 14px 10px;
        text-align: center; font-size: 11.3px; color: #b45309; background: #fffaf6;
        cursor: default; transition: all .12s;
      }
      .drop::before {
        content: ""; display: block; width: 18px; height: 18px; margin: 0 auto 6px;
        background: #e8590c;
        -webkit-mask: var(--ic-upload) center/contain no-repeat; mask: var(--ic-upload) center/contain no-repeat;
      }
      .drop.over { border-color: #e8590c; background: #fff4ed; color: #9a3412; }

      /* ---- memory card ---- */
      .mem {
        background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 9px; padding: 10px;
        display: flex; flex-direction: column; gap: 5px;
      }
      .memhd {
        display: flex; align-items: center; gap: 6px; margin-bottom: 3px;
        font-size: 9.5px; text-transform: uppercase; letter-spacing: .1em; font-weight: 700; color: #9ca3af;
      }
      .memjob {
        font-size: 11px; font-weight: 620; color: #374151; margin-bottom: 3px;
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      }
      .memjob.empty { font-weight: 400; color: #9ca3af; }
      .memrow { display: flex; justify-content: space-between; align-items: center; gap: 10px; font-size: 11px; }
      .memrow > span:first-child { color: #6b7280; flex: 0 0 auto; }
      .memval {
        color: #1b1f24; font-weight: 600; text-align: right; min-width: 0;
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      }
      .memval.yes { color: #15803d; }
      .memval.no { color: #9ca3af; font-weight: 400; }
      .memval.mono {
        font-weight: 400; font-family: ui-monospace, Menlo, Consolas, monospace;
        font-size: 10px; color: #6b7280;
      }
      .membtns { display: flex; gap: 12px; margin-top: 5px; }

      /* ---- persistent footer ---- */
      .foot {
        flex: 0 0 auto; border-top: 1px solid #f1f2f4; background: #fcfcfd;
        padding: 8px 10px; display: flex; align-items: center; gap: 7px;
      }
      .fmark {
        width: 22px; height: 22px; border-radius: 7px; background: #e8590c; color: #fff;
        display: inline-flex; align-items: center; justify-content: center; flex: 0 0 auto;
        box-shadow: 0 1px 2px rgba(232,89,12,.32);
      }
      .fmark svg { width: 13px; height: 13px; }
      .fname { font-size: 11.5px; font-weight: 650; flex: 0 0 auto; }
      .ver {
        font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 9.5px;
        color: #9ca3af; flex: 0 0 auto;
      }
      .ver:empty { display: none; }
      .fdot {
        width: 6px; height: 6px; border-radius: 50%; flex: 0 0 auto;
        background: #15803d; box-shadow: 0 0 0 2.5px rgba(21,128,61,.14);
      }
      /* signed out: the profile chip is hidden, so the dot reports it */
      .foot:has(.hdprof.hidden) .fdot { background: #9ca3af; box-shadow: 0 0 0 2.5px rgba(156,163,175,.16); }

      .hdprof {
        margin-left: auto; display: inline-flex; align-items: center; gap: 6px; min-width: 0;
        padding: 3px 8px 3px 3px; border-radius: 999px;
        background: #fff; border: 1px solid #e5e7eb; flex: 0 1 auto;
      }
      .hdprof.hidden { display: none; }
      .av {
        display: inline-flex; align-items: center; justify-content: center; flex: 0 0 auto;
        width: 18px; height: 18px; border-radius: 50%;
        background: #fff4ed; color: #c94a05; font-weight: 700; font-size: 9px; text-transform: uppercase;
      }
      .hdprof strong {
        font-size: 11px; font-weight: 600; color: #374151;
        max-width: 92px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      }
      .minbtn {
        border: none; background: none; color: #9ca3af; padding: 0; font-size: 0;
        width: 24px; height: 24px; cursor: pointer; border-radius: 6px; flex: 0 0 auto;
        display: inline-flex; align-items: center; justify-content: center;
      }
      .foot:has(.hdprof.hidden) .minbtn { margin-left: auto; }
      .minbtn::after {
        content: ""; width: 14px; height: 14px; background: currentColor;
        -webkit-mask: var(--ic-chevd) center/contain no-repeat; mask: var(--ic-chevd) center/contain no-repeat;
      }
      .minbtn:hover { background: #f3f4f6; color: #6b7280; }

      /* ---- minimized circle (FAB) ---- */
      .wrap.minimized .panel { display: none; }
      .wrap:not(.minimized) .fab { display: none; }
      .fab {
        width: 50px; height: 50px; border-radius: 50%; border: none; cursor: grab; padding: 0;
        background: #e8590c; color: #fff; position: relative;
        display: flex; align-items: center; justify-content: center;
        box-shadow: 0 3px 10px rgba(232,89,12,.4), 0 1px 3px rgba(16,24,40,.2);
        transition: transform .12s, background .12s;
      }
      .fab:hover { background: #c94a05; transform: translateY(-1px); }
      .fab.dragging { cursor: grabbing; }
      .fabtxt { display: inline-flex; align-items: center; justify-content: center; font-size: 0; }
      .fabtxt svg { width: 23px; height: 23px; }
      .fabdot {
        position: absolute; top: 2px; right: 2px; width: 12px; height: 12px;
        border-radius: 50%; background: #22c55e; border: 2px solid #fff;
      }
      .fabdot.hidden { display: none; }

      button:focus-visible, input:focus-visible, textarea:focus-visible, summary:focus-visible {
        outline: 2px solid #e8590c; outline-offset: 2px;
      }

      @media (prefers-reduced-motion: reduce) {
        .spinner, .iconbtn.spin svg, .fldloading::before { animation: none; }
        * { transition: none !important; }
      }
    </style>

    <svg width="0" height="0" style="position:absolute" aria-hidden="true"><defs>
      <g id="ic-mark" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7.5h16M8.5 13.2 11 15.7l5-5.4"/><path d="M4 7.5v9a3 3 0 0 0 3 3h10a3 3 0 0 0 3-3v-9"/></g>
      <g id="ic-doc" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M13 2v7h7M8.5 13h7M8.5 17h5"/></g>
      <g id="ic-clip" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M20 11.5 12.3 19.2a5 5 0 0 1-7.1-7.1l8-8a3.4 3.4 0 0 1 4.8 4.8l-7.9 8a1.7 1.7 0 0 1-2.4-2.4l7-7"/></g>
      <g id="ic-bolt" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M13.5 2 4 13.5h6.5L10 22l9.5-11.5H13z"/></g>
      <g id="ic-spark" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3.2 13.9 9 19.7 10.9 13.9 12.8 12 18.6 10.1 12.8 4.3 10.9 10.1 9z"/><path d="M18.6 3v3.4M20.3 4.7h-3.4M5.6 16v2.6M6.9 17.3H4.3"/></g>
      <g id="ic-refresh" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M20.5 11a8.5 8.5 0 0 0-14.6-5L3.5 8.3"/><path d="M3.5 4v4.3h4.3M3.5 13a8.5 8.5 0 0 0 14.6 5l2.4-2.3"/><path d="M20.5 20v-4.3h-4.3"/></g>
      <g id="ic-minus" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/></g>
      <g id="ic-chevl" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 6-6 6 6 6"/></g>
    </defs></svg>

    <div class="wrap minimized" id="wrap">
      <button class="fab" id="fab" type="button" title="Open Tryvify"><span class="fabtxt"><svg viewBox="0 0 24 24"><use href="#ic-mark"/></svg></span><span class="fabdot hidden" id="fabdot"></span></button>
      <div class="panel" id="panel">
      <div class="hd" id="hd">
        <span class="draghint" title="Drag to move"></span>
        <span class="brand">
          <span class="logo"></span>
          <span class="ttl">Tryvify</span>
        </span>
        <span class="tools">
          <button class="iconbtn" id="refresh" type="button" title="Reload data from the server"><svg viewBox="0 0 24 24"><use href="#ic-refresh"/></svg></button>
          <button class="iconbtn" id="minTop" type="button" title="Minimize to circle"><svg viewBox="0 0 24 24"><use href="#ic-minus"/></svg></button>
        </span>
      </div>
      <div class="bd" id="bd">
        <div id="auth" class="hidden">
          <p class="hint" style="text-align:left">Sign in from the Tryvify toolbar popup, then reopen this panel.</p>
        </div>
        <div id="app" class="hidden">
          <div class="jobhd hidden" id="jobHd">
            <div class="jobco" id="jobCo"></div>
            <div class="jobrole" id="jobRole"></div>
          </div>
          <div class="statusline" id="statusline">
            <span class="spinner hidden" id="sp"></span>
            <p class="status" id="st"></p>
          </div>

          <div class="sec first">
            <p class="seclabel"><span class="n">1</span> Generate documents</p>
            <div class="hero">
              <div class="btnrow">
                <button class="btn primary" id="go">Generate documents</button>
              </div>
              <div class="btnrow">
                <button class="btn primary fillall" id="fillAll" type="button" title="Fill this page: AI-answer questions, attach an already-generated résumé/CV, Easy Fill the basics, and fill passwords. Does not generate — use Generate for that.">Fill application</button>
              </div>
            </div>
          </div>

          <div class="sep"></div>

          <div class="sec">
            <p class="seclabel"><span class="n">2</span> Fill this page</p>

            <div class="fldnav">
              <button class="backbtn" id="fldBack" type="button" title="Back"><svg viewBox="0 0 24 24"><use href="#ic-chevl"/></svg></button>
              <span class="navttl t-easy">Easy Fill</span>
              <span class="navttl t-qa">Q&amp;A</span>
            </div>

            <div class="grp">
              <details class="disc" open>
                <summary>
                  <span class="ri"><svg viewBox="0 0 24 24"><use href="#ic-doc"/></svg></span>
                  <span class="rt"><b>Documents</b><span>What to generate</span></span>
                  <span class="discchev"></span>
                </summary>
                <div class="drawer">
                  <div class="toggles">
                    <label class="chip" id="grRow"><input type="checkbox" id="gr" /> Résumé</label>
                    <label class="chip"><input type="checkbox" id="gc" /> Cover letter</label>
                  </div>
                  <label class="row" id="baseRow"><input type="checkbox" id="base" /> Use my base résumé instead</label>
                  <div class="btnrow">
                    <button class="btn ghost cppath" id="cp" type="button">
                      <span class="cpicon" aria-hidden="true"></span>
                      <span class="cptext">Copy path</span>
                    </button>
                    <button class="btn ghost" id="dl" type="button" title="Download the generated files to this computer">Download</button>
                  </div>
                  <div class="btnrow">
                    <button class="btn ghost hidden" id="regen" type="button" title="Discard the existing documents and generate them again">Force regenerate</button>
                  </div>
                </div>
              </details>

              <button class="btn" id="rs" type="button">
                <span class="ri"><svg viewBox="0 0 24 24"><use href="#ic-clip"/></svg></span>
                <span class="rt"><b>Attach résumé &amp; CV</b><span>Upload the documents to this page</span></span>
                <span class="rowchev"></span>
              </button>

              <div class="rowsplit">
                <div class="split">
                  <button class="btn fill alt splitmain" id="fl">
                    <span class="ri"><svg viewBox="0 0 24 24"><use href="#ic-bolt"/></svg></span>
                    <span class="rt"><b>Easy Fill</b><span>Instant basics — no AI</span></span>
                  </button>
                  <button class="btn fill alt splitcaret" id="flCaret" type="button" title="Easy Fill list — profile answers (add / edit)"></button>
                </div>
              </div>

              <div class="rowsplit">
                <div class="split">
                  <button class="btn fill alt splitmain" id="ai">
                    <span class="ri"><svg viewBox="0 0 24 24"><use href="#ic-spark"/></svg></span>
                    <span class="rt"><b>Q&amp;A</b><span>AI answers for this form</span></span>
                  </button>
                  <button class="btn fill alt splitcaret" id="aiCaret" type="button" title="Q&amp;A list — page questions + saved answers (add / generate)"></button>
                </div>
              </div>
            </div>

            <div class="fldmenu hidden" id="fldMenu"></div>
            <button class="btn ghost" id="moreBtn" type="button" aria-expanded="false" title="Show more">More</button>

            <!-- Everything below is foldable to keep the panel short. -->
            <div class="more hidden" id="moreWrap">
              <button class="btn ghost hidden" id="pw">Fill sign-up password</button>
              <div class="drop hidden" id="drop">Drop a résumé file here to upload it to this page</div>
              <p class="hint">Review every field, then submit manually.</p>

              <div class="mem" id="mem">
                <div class="memhd">Run memory</div>
                <div class="memjob" id="memJob">—</div>
                <div class="memrow"><span>Run</span><span class="memval" id="memRun">none yet</span></div>
                <div class="memrow"><span>Résumé</span><span class="memval" id="memR">—</span></div>
                <div class="memrow"><span>Cover letter</span><span class="memval" id="memC">—</span></div>
                <div class="memrow"><span>Answers</span><span class="memval" id="memA">—</span></div>
                <div class="membtns">
                  <button class="linkbtn hidden" id="vr">View résumé</button>
                  <button class="linkbtn hidden" id="vc">View CV</button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
      <div class="foot">
        <span class="fmark"><svg viewBox="0 0 24 24"><use href="#ic-mark"/></svg></span>
        <span class="fname">Tryvify</span>
        <span class="ver" id="ver" title="Extension version"></span>
        <span class="fdot" aria-hidden="true"></span>
        <span class="hdprof" id="hdprof" title="Active profile"><span class="av" id="avatar">—</span><strong id="prof">—</strong></span>
        <button class="minbtn" id="min" type="button" title="Minimize to circle"></button>
      </div>
      </div>
    </div>
  `;
  document.documentElement.appendChild(mount);

  // Keep the panel alive on SPA pages (Greenhouse, Lever, Ashby, Workday…).
  // These frameworks re-render the document after hydration, which can detach
  // our node moments after it mounts ("shows then disappears"). A Mutation
  // observer re-appends it whenever it leaves the DOM. Throttled via rAF so a
  // burst of mutations doesn't thrash. Because state (status, listeners, shadow
  // DOM) lives on the same `mount` element, re-appending restores everything.
  function ensureMounted() {
    if (!mount.isConnected && document.documentElement) {
      document.documentElement.appendChild(mount);
    }
  }
  let reattachScheduled = false;
  const keepAlive = new MutationObserver(() => {
    if (reattachScheduled) return;
    reattachScheduled = true;
    requestAnimationFrame(() => {
      reattachScheduled = false;
      ensureMounted();
    });
  });
  keepAlive.observe(document.documentElement, { childList: true, subtree: true });

  const $ = (id) => shadow.getElementById(id);
  const bd = $("bd"), wrap = $("wrap"), fab = $("fab"), minBtn = $("min"), minTopBtn = $("minTop"), fabdot = $("fabdot"), refreshBtn = $("refresh");
  const authView = $("auth"), appView = $("app");
  const goBtn = $("go"), stEl = $("st"), spEl = $("sp"), cpBtn = $("cp"), flBtn = $("fl"), rsBtn = $("rs"), pwBtn = $("pw"), aiBtn = $("ai"), dropEl = $("drop"), regenBtn = $("regen");
  const flCaret = $("flCaret"), aiCaret = $("aiCaret"), fldMenu = $("fldMenu"), fillAllBtn = $("fillAll");
  const dlBtn = $("dl"), moreBtn = $("moreBtn"), moreWrap = $("moreWrap"), hdProf = $("hdprof");
  const jobHd = $("jobHd"), jobCo = $("jobCo"), jobRole = $("jobRole");

  // Surface the extension version in the header, read from the manifest so it
  // stays the single source of truth (bump manifest.json on every change).
  try { $("ver").textContent = "v" + chrome.runtime.getManifest().version; } catch { /* manifest unavailable */ }

  // --- hover tooltip for truncated list labels -------------------------------
  // Q&A / Easy-Fill rows ellipsis-truncate long labels (.fldlabel) and value
  // previews (.fldval). Reveal the full text in a small tooltip after a short
  // hover. The tip is a direct child of the shadow root (no transformed
  // ancestor) so position:fixed resolves to the viewport and it escapes the
  // panel's overflow clipping. Shown ONLY when the text is actually truncated.
  const tip = document.createElement("div");
  tip.setAttribute("role", "tooltip");
  tip.style.cssText =
    "position:fixed; z-index:2147483647; max-width:280px; padding:6px 8px;" +
    "background:#16262b; color:#fff; font:500 11.5px/1.4 system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;" +
    "border-radius:7px; box-shadow:0 4px 14px rgba(15,40,46,.28); pointer-events:none;" +
    "opacity:0; transition:opacity .12s ease; white-space:normal; overflow-wrap:anywhere; display:none;";
  shadow.appendChild(tip);

  let tipTimer = null;
  function hideTip() {
    clearTimeout(tipTimer);
    tip.style.opacity = "0";
    tip.style.display = "none";
  }
  function showTip(el) {
    const text = (el.textContent || "").trim();
    if (!text) return;
    tip.textContent = text;
    tip.style.display = "block";
    const r = el.getBoundingClientRect();
    const tr = tip.getBoundingClientRect();
    // Prefer above the label; flip below when there isn't room.
    let top = r.top - tr.height - 6;
    if (top < 4) top = r.bottom + 6;
    let left = Math.min(r.left, window.innerWidth - tr.width - 6);
    if (left < 4) left = 4;
    tip.style.left = left + "px";
    tip.style.top = top + "px";
    tip.style.opacity = "1";
  }

  const TIP_SEL = ".fldlabel, .fldval";
  shadow.addEventListener("mouseover", (e) => {
    const el = e.target.closest?.(TIP_SEL);
    if (!el || el.scrollWidth <= el.clientWidth + 1) return; // not truncated → nothing hidden
    clearTimeout(tipTimer);
    tipTimer = setTimeout(() => showTip(el), 200);
  });
  shadow.addEventListener("mouseout", (e) => {
    if (e.target.closest?.(TIP_SEL)) hideTip();
  });
  // The tip is viewport-anchored, so any scroll/click makes its position stale.
  bd.addEventListener("scroll", hideTip, true); // capture: also catches inner .fldmenu scroll
  shadow.addEventListener("mousedown", hideTip, true);

  dlBtn.disabled = true; // enabled once a run exists for this page
  hdProf.classList.add("hidden"); // shown once signed in (profile known)
  const grEl = $("gr"), gcEl = $("gc"), baseEl = $("base"), grRow = $("grRow");
  const memRun = $("memRun"), memR = $("memR"), memC = $("memC"), memA = $("memA"), memJob = $("memJob");
  const vrBtn = $("vr"), vcBtn = $("vc");

  // Copy text to the clipboard from the page context. The async Clipboard API
  // can be blocked on non-secure origins / without focus, so fall back to a
  // hidden textarea + execCommand (same approach as enpply's CopyButton).
  async function copyToClipboard(text) {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch {
      /* fall through to the textarea fallback */
    }
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.cssText = "position:fixed;top:-1000px;opacity:0;";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
      return true;
    } catch {
      return false;
    }
  }

  // The path the Copy button writes, set when a run completes. The button is
  // always visible; until a path is known it tells the user to generate first.
  let copyPath = "";
  function showCopyPath(path) {
    copyPath = path || "";
    cpBtn.title = copyPath || "Generate first to get an output path";
  }

  cpBtn.addEventListener("click", async () => {
    if (!copyPath) {
      setStatus("Generate first — then the output path is available to copy.");
      return;
    }
    const ok = await copyToClipboard(copyPath);
    // Update only the text span so the clipboard icon stays put.
    const label = cpBtn.querySelector(".cptext") || cpBtn;
    const prev = label.textContent;
    label.textContent = ok ? "Copied!" : "Copy failed";
    setTimeout(() => { label.textContent = prev; }, 1200);
  });

  // Download the generated files (résumé + CV + result.json) to THIS computer.
  // Unlike "Copy path" (which is the server's folder — useless on a remote
  // backend), this actually transfers the files to the user's Downloads folder.
  async function downloadFiles() {
    if (!activeAppId) {
      setStatus("Generate first — then the files are available to download.", "err");
      return;
    }
    dlBtn.disabled = true;
    setStatus("Downloading files…", "", true);
    const res = await send("enpplify:download", { appId: activeAppId });
    dlBtn.disabled = false;
    if (!res.ok) {
      setStatus(res.error || "Download failed.", "err");
      return;
    }
    const n = (res.saved || []).length;
    setStatus(`Downloaded ${n} file${n === 1 ? "" : "s"} to Downloads${res.dir ? "/" + res.dir : ""}.`, "ok");
  }
  dlBtn.addEventListener("click", () => void downloadFiles());

  // Foldable "more" region — keeps the panel short; expands to reveal the
  // password button, drop zone, hint, and the memory card.
  let moreOpen = false;
  function setMoreOpen(open) {
    moreOpen = open;
    moreWrap.classList.toggle("hidden", !open);
    // Text only — the chevron is a CSS pseudo-element keyed off aria-expanded,
    // so it survives this textContent assignment.
    moreBtn.textContent = open ? "Less" : "More";
    moreBtn.setAttribute("aria-expanded", open ? "true" : "false");
  }
  moreBtn.addEventListener("click", () => setMoreOpen(!moreOpen));

  // The active run id for this page, set once a run completes. Fill/attach need
  // it to fetch the answers map and the résumé PDF. The buttons stay visible at
  // all times; if there's no run yet they prompt the user to Generate first.
  let activeAppId = "";
  // Last memory summary from the server (run id + which docs exist). attachDocs
  // uses hasCoverLetter to decide whether to also attach the CV.
  let lastMemory = null;
  function enableFillActions(appId) {
    activeAppId = appId || "";
    // Light up the minimized-circle status dot when a run exists for this page.
    fabdot.classList.toggle("hidden", !activeAppId);
    // Download needs generated files; disable until a run exists.
    dlBtn.disabled = !activeAppId;
    // Force-regenerate only makes sense once a run exists for this page.
    regenBtn.classList.toggle("hidden", !activeAppId);
  }

  // --- memory panel ----------------------------------------------------------
  // Shows what Enpplify currently holds for this job: which run, and whether a
  // résumé / cover letter / answers were generated. "View" opens the PDF.

  function setMemVal(el, ok, yesText, noText) {
    el.textContent = ok ? yesText : noText;
    el.className = "memval " + (ok ? "yes" : "no");
  }

  function updateMemory(memory) {
    lastMemory = memory || null;
    if (!memory) {
      jobHd.classList.add("hidden");
      jobCo.textContent = "";
      jobRole.textContent = "";
      memJob.textContent = "—";
      memJob.className = "memjob empty";
      memRun.textContent = "none yet";
      memRun.className = "memval no";
      setMemVal(memR, false, "", "—");
      setMemVal(memC, false, "", "—");
      memA.textContent = "—";
      memA.className = "memval no";
      vrBtn.classList.add("hidden");
      vcBtn.classList.add("hidden");
      return;
    }
    const company = memory.companyName || "";
    const roleName = memory.roleName || "";
    if (company || roleName) {
      jobCo.textContent = company || roleName;
      jobRole.textContent = company ? roleName : "";
      jobHd.classList.remove("hidden");
    } else {
      jobHd.classList.add("hidden");
      jobCo.textContent = "";
      jobRole.textContent = "";
    }
    const job = [company, roleName].filter(Boolean).join(" — ");
    memJob.textContent = job || "—";
    memJob.className = job ? "memjob" : "memjob empty";
    memRun.textContent = memory.runUuid || memory.appId || "—";
    memRun.className = "memval mono";
    setMemVal(memR, memory.hasResume, "✓ generated", "not generated");
    setMemVal(memC, memory.hasCoverLetter, "✓ generated", "not generated");
    memA.textContent = memory.answersCount > 0 ? `${memory.answersCount} saved` : "none";
    memA.className = "memval " + (memory.answersCount > 0 ? "yes" : "no");
    vrBtn.classList.toggle("hidden", !memory.hasResume);
    vcBtn.classList.toggle("hidden", !memory.hasCoverLetter);
  }

  async function viewArtifact(key, label) {
    if (!activeAppId) { setStatus("Generate first.", "err"); return; }
    setStatus(`Opening ${label}…`, "", true);
    const res = await send("enpplify:artifact", { appId: activeAppId, key });
    if (!res.ok || !res.dataUrl) {
      setStatus(res.error || `Could not load ${label}.`, "err");
      return;
    }
    try {
      const opened = openDataUrlInTab(res.dataUrl, res.contentType);
      setStatus(opened ? "" : `Popup blocked — allow popups for this site to view the ${label}.`, opened ? "" : "err");
    } catch (e) {
      setStatus(`Could not open ${label}: ${e?.message || e}`, "err");
    }
  }

  vrBtn.addEventListener("click", () => viewArtifact("resume_pdf", "résumé"));
  vcBtn.addEventListener("click", () => viewArtifact("cover_letter_pdf", "CV"));

  // --- enpplify settings + password autofill ---------------------------------
  // Feature flags + the autofill password come from the server (per user). The
  // password feature is OFF unless the flag is on AND a password is configured.

  let enpplifySettings = { flags: {}, autofill_password: "" };
  // The profile this panel is acting as (from getState). Base résumés are
  // per profile, so "Use base resume" availability/attach is keyed on this.
  let currentProfileId = "";
  // True once the user has hand-toggled "Use base resume" on the current page,
  // so a settings refresh won't clobber their choice with the profile default.
  // Reset whenever the acting profile changes.
  let baseManuallySet = false;
  // Apply the saved "generate by default" prefs exactly once (the first time
  // settings load), so later settings refreshes never clobber the user's
  // per-page toggles of Résumé / Cover letter.
  let genDefaultsApplied = false;
  function flagOn(key) {
    return !!enpplifySettings.flags?.[key];
  }

  async function loadSettings() {
    const res = await send("enpplify:settings", {});
    if (res.ok && res.settings) enpplifySettings = res.settings;
    // Seed the Résumé / Cover letter checkboxes from the user's defaults (both
    // OFF unless turned on in Enpplify settings). One-shot — see above.
    if (!genDefaultsApplied) {
      genDefaultsApplied = true;
      grEl.checked = flagOn("gen_resume_default");
      // LinkedIn flows are résumé-only by convention — keep cover letter off.
      gcEl.checked = isLinkedIn ? false : flagOn("gen_cover_letter_default");
    }
    // Until the user hand-toggles it, the base checkbox follows the active
    // profile's saved default. After a manual change, only correct an
    // impossible state (on, but no base résumé for this profile).
    if (!baseManuallySet) baseEl.checked = baseResumeDefaultOn();
    else if (baseEl.checked && !baseResumeAvailable()) baseEl.checked = false;
    refreshPasswordButton();
    refreshDropZone();
    // applyBaseMode() runs last so "Use base resume" wins: it disables the
    // Résumé checkbox whenever base mode is on, regardless of the default above.
    applyBaseMode();
  }

  // Refresh settings before a fill so a just-set autofill password is honored —
  // but NEVER block the fill on it. If the worker is asleep or the backend is
  // slow/unreachable, proceed after a short cap with whatever we already have
  // (loadSettings keeps running in the background and updates for next time).
  function refreshSettingsBestEffort() {
    return Promise.race([loadSettings().catch(() => {}), sleep(2000)]);
  }

  // --- "Use base resume" -----------------------------------------------------
  // When on, the per-job résumé isn't generated/attached; the user's uploaded
  // base résumé (Enpplify settings tab) is attached instead.

  function baseResumeAvailable() {
    const names = enpplifySettings.base_resume_names || {};
    return !!(currentProfileId && names[currentProfileId]);
  }

  /** The active profile's saved "Use base resume by default" preference. */
  function baseResumeDefaultOn() {
    if (!baseResumeAvailable()) return false;
    const defs = enpplifySettings.base_resume_default || {};
    return defs[currentProfileId] === true;
  }

  /** Reflect the base checkbox into the UI (blur Résumé toggle + Generate). */
  function applyBaseMode() {
    const on = baseEl.checked;
    grRow.classList.toggle("disabled", on);
    grEl.disabled = on;
    // Generate is pointless when résumé is base AND cover letter is unchecked.
    const nothingToGenerate = on && !gcEl.checked;
    goBtn.classList.toggle("disabled", nothingToGenerate);
    goBtn.title = nothingToGenerate
      ? "Nothing to generate — base résumé is used and cover letter is off"
      : "";
  }

  baseEl.addEventListener("change", () => {
    if (baseEl.checked && !baseResumeAvailable()) {
      baseEl.checked = false;
      setStatus("No base résumé uploaded — add one in Tryvera → Tryvify settings.", "err");
      return;
    }
    // A hand-toggle is a per-page override of the profile default.
    baseManuallySet = true;
    applyBaseMode();
    setStatus(baseEl.checked ? "Using your base résumé for this application." : "", baseEl.checked ? "ok" : "");
  });

  gcEl.addEventListener("change", applyBaseMode);

  /** Show the drop zone only when enabled and the page has a résumé input. */
  function refreshDropZone() {
    const eligible = flagOn("drop_to_upload") && !!findResumeFileInput();
    setDropVisible(eligible);
  }

  /**
   * EVERY password field on the page — all of these get the user's one autofill
   * password (password, "password again", confirm, verify… all the same value).
   * Includes genuine password inputs plus text inputs that are really passwords
   * (a show/hide toggle flips type to "text" but keeps autocomplete "*password").
   * No sign-up/confirm/current heuristics: if it's a password box, we fill it.
   */
  function passwordFields() {
    // Scan the main document AND any same-origin iframes — embedded ATS / auth
    // forms often render the password fields inside an iframe, which a top-frame
    // query alone would miss.
    const docs = [document];
    for (const frame of document.querySelectorAll("iframe")) {
      try {
        if (frame.contentDocument) docs.push(frame.contentDocument);
      } catch {
        /* cross-origin frame — not accessible, skip */
      }
    }
    const out = [];
    for (const doc of docs) {
      for (const el of doc.querySelectorAll('input[type="password"], input[type="text"]')) {
        if (!visible(el)) continue;
        const type = (el.getAttribute("type") || "").toLowerCase();
        if (type === "password") { out.push(el); continue; }
        // A reveal-toggled password field is type="text" but still says so via autocomplete.
        if ((el.getAttribute("autocomplete") || "").toLowerCase().includes("password")) out.push(el);
      }
    }
    return out;
  }

  // Password autofill is usable as soon as the user has configured an autofill
  // password in Enpplify settings. Having set a password IS the opt-in, so we no
  // longer also require the separate (default-off) password_autofill flag — that
  // double gate silently swallowed sign-up password fills.
  function passwordAutofillEnabled() {
    return !!enpplifySettings.autofill_password;
  }

  function refreshPasswordButton() {
    const eligible = passwordAutofillEnabled() && passwordFields().length > 0;
    pwBtn.classList.toggle("hidden", !eligible);
    // The password button lives in the foldable "more" region; open it so the
    // user can see this page actually offers sign-up password autofill.
    if (eligible && !moreOpen) setMoreOpen(true);
  }

  // Sign-up forms and résumé dropzones frequently mount after hydration or a
  // step change, so a one-shot check at load misses them. Re-evaluate the
  // password + drop-zone affordances whenever the page's password/file input
  // count changes. Debounced and signature-gated so SPA mutation bursts (and
  // our own panel re-renders) don't thrash.
  let formScanTimer = null;
  let lastFormSig = "";
  function formSignature() {
    const pw = document.querySelectorAll('input[type="password"]').length;
    const file = document.querySelectorAll('input[type="file"]').length;
    return `${pw}:${file}`;
  }
  function startFormWatcher() {
    lastFormSig = formSignature();
    const obs = new MutationObserver(() => {
      if (formScanTimer) return;
      formScanTimer = setTimeout(() => {
        formScanTimer = null;
        const sig = formSignature();
        if (sig === lastFormSig) return;
        lastFormSig = sig;
        refreshPasswordButton();
        refreshDropZone();
      }, 500);
    });
    try {
      obs.observe(document.documentElement, { childList: true, subtree: true });
    } catch {
      /* observation unavailable — the load-time checks still run */
    }
  }

  /** Fill EVERY password field on the page with the configured autofill password. */
  function fillPasswords() {
    const pw = enpplifySettings.autofill_password;
    if (!pw) return { ok: false, reason: "no-password" };
    const fields = passwordFields();
    if (fields.length === 0) return { ok: false, reason: "no-fields" };
    let n = 0;
    for (const el of fields) {
      try {
        el.focus?.();
        setNativeValue(el, pw);
        // Many forms validate ("Please enter your password") on blur; fire it so
        // the error clears and the value is committed to the framework's state.
        el.dispatchEvent(new Event("blur", { bubbles: true }));
        el.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
        n++;
      } catch {
        /* skip */
      }
    }
    return { ok: n > 0, count: n };
  }

  pwBtn.addEventListener("click", () => {
    const r = fillPasswords();
    if (r.ok) setStatus(`Filled ${r.count} password field(s). Review, then submit manually.`, "ok");
    else if (r.reason === "no-password") setStatus("No autofill password set — add one on the Tryvify settings page.", "err");
    else setStatus("No password fields detected on this page.", "err");
  });

  // --- drop-a-file-to-upload -------------------------------------------------
  // A user-initiated drop hands us a real File object (the one browser-allowed
  // path to a local file), which we attach to the page's résumé input via the
  // same DataTransfer trick. No server, no AI.

  function setDropVisible(show) {
    dropEl.classList.toggle("hidden", !show);
  }

  ["dragenter", "dragover"].forEach((t) =>
    dropEl.addEventListener(t, (e) => {
      e.preventDefault();
      e.stopPropagation();
      dropEl.classList.add("over");
    }),
  );
  ["dragleave", "dragend"].forEach((t) =>
    dropEl.addEventListener(t, () => dropEl.classList.remove("over")),
  );

  dropEl.addEventListener("drop", (e) => {
    e.preventDefault();
    e.stopPropagation();
    dropEl.classList.remove("over");
    const file = e.dataTransfer?.files?.[0];
    if (!file) {
      setStatus("No file in the drop.", "err");
      return;
    }
    const input = findResumeFileInput();
    if (!input) {
      setStatus("No résumé upload field found on this page to drop into.", "err");
      return;
    }
    const stuck = attachFileToInput(input, file);
    setStatus(
      stuck
        ? `Uploaded "${file.name}" to the résumé field. Review, then submit manually.`
        : `Couldn't attach "${file.name}" — the page rejected it.`,
      stuck ? "ok" : "err",
    );
  });

  // --- Fill this page --------------------------------------------------------

  /** Fetch a generated artifact and attach it to a file input. */
  async function attachDocToInput(input, key, fallbackName) {
    const res = await send("enpplify:artifact", { appId: activeAppId, key });
    if (!res.ok || !res.dataUrl) return { ok: false, reason: res.error || "fetch-failed" };
    try {
      const file = dataUrlToFile(res.dataUrl, res.filename || fallbackName, res.contentType);
      const stuck = attachFileToInput(input, file);
      return stuck ? { ok: true } : { ok: false, reason: "input-rejected-file" };
    } catch (e) {
      return { ok: false, reason: e?.message || "attach-failed" };
    }
  }

  /** Attach the user's uploaded base résumé (no run needed). */
  async function attachBaseResumeToInput(input) {
    const res = await send("enpplify:baseResume", { profileId: currentProfileId });
    if (!res.ok || !res.dataUrl) return { ok: false, reason: res.error || "no-base-resume" };
    try {
      const file = dataUrlToFile(res.dataUrl, res.filename || "base_resume.pdf", res.contentType);
      const stuck = attachFileToInput(input, file);
      return stuck ? { ok: true } : { ok: false, reason: "input-rejected-file" };
    } catch (e) {
      return { ok: false, reason: e?.message || "attach-failed" };
    }
  }

  /**
   * Attach the résumé, and the CV/cover letter too when it was generated and a
   * distinct cover-letter upload field exists on the page. Returns
   * { resume, cover } where each is null (not attempted) or { ok, reason }.
   */
  async function attachDocs() {
    const out = { resume: null, cover: null };
    const taken = new Set();

    const resumeInput = findResumeFileInput();
    if (!resumeInput) {
      out.resume = { ok: false, reason: "no-input" };
    } else {
      taken.add(resumeInput);
      // "Use base resume" → attach the uploaded base PDF instead of the
      // per-job generated résumé.
      out.resume = baseEl.checked
        ? await attachBaseResumeToInput(resumeInput)
        : await attachDocToInput(resumeInput, "resume_pdf", "resume.pdf");
    }

    // Only attach the CV if the flag is on, it exists for this run, AND there's
    // a separate cover-letter input (never reuse the résumé input for the CV).
    if (flagOn("attach_cover_letter") && lastMemory?.hasCoverLetter) {
      const coverInput = findFileInput("cover", taken, false);
      if (coverInput) {
        out.cover = await attachDocToInput(coverInput, "cover_letter_pdf", "cover_letter.pdf");
      }
    }
    return out;
  }

  /** Human-readable summary of an attachDocs() result. */
  function describeAttach(res) {
    const parts = [];
    if (res.resume?.ok) parts.push("résumé attached");
    else if (res.resume && res.resume.reason !== "no-input") parts.push("résumé attach failed");
    if (res.cover?.ok) parts.push("CV attached");
    else if (res.cover && res.cover.reason !== "no-input") parts.push("CV attach failed");
    return parts;
  }

  /**
   * Fill the page. mode "heuristic" = instant, no LLM (name/email/phone/links/
   * location from the profile). mode "both" = heuristic AND AI over the rest.
   * Both buttons run this; only the mode (and thus speed/cost) differs.
   */
  /**
   * Fill the page from the server fill-map. Options:
   *  - mode:      server fill-map mode ("heuristic" | "ai" | "both").
   *  - sources:   value sources to APPLY to the page, a subset of
   *               "heuristic"|"app"|"profile"|"ai"; null = apply all. Lets a
   *               button fill only its own slice (Easy Fill = basics/reusable;
   *               Q&A = answered questions) even though the server may return
   *               more.
   *  - attach:    attach résumé/CV afterwards.
   *  - passwords: fill sign-up password fields locally.
   *  - btn/otherBtn: buttons to disable while running.
   */
  async function doFill(opts) {
    const { mode = "both", sources = null, attach = false, passwords = false, btn, otherBtn } = opts;
    // A full fill re-harvests fields; close the per-field menu so its now-stale
    // refs can't be clicked.
    closeFieldMenu();
    if (btn) btn.disabled = true;
    if (otherBtn) otherBtn.disabled = true;
    setStatus("Reading the form…", "", true);
    // Pick up a freshly-set autofill password (etc.) without an extension reload.
    await refreshSettingsBestEffort();

    const reenable = () => {
      if (btn) btn.disabled = false;
      if (otherBtn) otherBtn.disabled = false;
    };

    const pwFields = passwords ? passwordFields() : [];
    const fields = harvestFields();
    if (fields.length === 0 && pwFields.length === 0) {
      reenable();
      setStatus("No fillable fields found on this page.", "err");
      return;
    }

    const parts = [];
    if (fields.length > 0) {
      // With a run: heuristic + saved + (for "ai"/"both") AI. Without a run:
      // instant profile-only pass (the server skips AI without job context).
      const usingAi = activeAppId && mode !== "heuristic";
      setStatus(usingAi ? `Asking AI for ${fields.length} fields…` : `Matching ${fields.length} fields…`, "", true);
      const res = activeAppId
        ? await send("enpplify:fillMap", { appId: activeAppId, fields, mode })
        : await send("enpplify:fillMapProfile", { profileId: currentProfileId, fields, mode: "heuristic" });
      if (!res.ok) {
        reenable();
        setStatus(res.error || "Fill failed.", "err");
        return;
      }
      setStatus("Filling fields…", "", true);
      let values = res.values || [];
      if (sources) values = values.filter((v) => sources.includes(v.source));
      const filled = await applyValues(values);
      parts.push(`Filled ${filled} field(s)`);
    }

    // Attach docs when a run exists (generated résumé/CV) OR when "Use base
    // resume" is on — the base PDF needs no run. attachDocs() picks base-vs-
    // generated by the checkbox.
    if (attach && (activeAppId || baseEl.checked)) {
      const attached = await attachDocs();
      parts.push(...describeAttach(attached));
    }

    // Every password field gets the user's one autofill password — locally, no
    // AI, no server round-trip, no run required.
    if (passwords && pwFields.length > 0) {
      if (passwordAutofillEnabled()) {
        const pr = fillPasswords();
        if (pr.ok) parts.push(`${pr.count} password field(s)`);
      } else {
        parts.push("set an autofill password in Tryvify settings to fill the password fields");
      }
    }

    reenable();
    const note = !activeAppId ? " Press Q&A to answer job-specific questions." : "";
    setStatus((parts.length ? parts.join(" · ") : "Nothing to fill") + "." + note + " Review, then submit manually.", "ok");
  }

  // Easy Fill: instant profile basics + reusable answers — no AI, no docs.
  // Password fields are the one exception to exact-match Easy Fill: every
  // password box gets the user's configured autofill password (filled locally,
  // never sent to the server). "Just fill in easy fills (+ the password)."
  flBtn.addEventListener("click", () =>
    void doFill({ mode: "heuristic", sources: ["heuristic", "app", "profile"], passwords: true, btn: flBtn, otherBtn: aiBtn }),
  );
  // Q&A: make sure a slot exists, then AI-answer the application questions (the
  // server stores them on the slot) and fill them. Basics are Easy Fill's job,
  // so we apply only the answered-question sources — plus the autofill password,
  // so a one-press Q&A on a sign-up form also fills the password fields.
  aiBtn.addEventListener("click", async () => {
    // Ensure a slot (also refreshes the stored application-form page text).
    const ok = await ensureQaSlot();
    if (!ok) return;
    // Mode "ai" sends EVERY harvested field to the LLM — including ones the
    // heuristic would treat as Easy Fill (name/email/…) — and stores the
    // answers on the run. Easy Fill / Fill all still apply the instant basics.
    await doFill({ mode: "ai", sources: ["ai"], passwords: true, btn: aiBtn, otherBtn: flBtn });
  });

  // --- per-field fill dropdowns ---------------------------------------------
  // Each Fill button has its own caret. The "instant" caret lists the fields the
  // heuristic pass can fill (free, values shown). The "AI" caret lists ONLY the
  // leftover fields heuristic can't fill — WITHOUT calling the LLM. The AI call
  // happens per field, only when the user clicks that individual field. Both
  // menus are built from a single free heuristic pass (values + leftover refs).

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]),
    );
  }

  function fieldLabel(d) {
    if (!d) return "(field)";
    const t = d.label || d.ariaLabel || d.placeholder || d.name || d.surroundingText || d.ref || "";
    return t.trim().replace(/\s+/g, " ").slice(0, 60) || d.ref;
  }

  let openMenuMode = null; // "heuristic" | "ai" | null

  function closeFieldMenu() {
    fldMenu.classList.add("hidden");
    flCaret.classList.remove("open");
    aiCaret.classList.remove("open");
    openMenuMode = null;
  }

  // Easy Fill and Q&A render as full sub-views (the CSS hides the rest of the
  // body while #fldMenu is open), so the back arrow is the way out. It reuses
  // closeFieldMenu — same state transition the carets already perform.
  $("fldBack").addEventListener("click", closeFieldMenu);

  /**
   * Canonical question text for a field — MUST mirror the server's questionOf()
   * so an answer saved here matches back to the same field on a later visit.
   */
  function fieldQuestion(d) {
    if (!d) return "";
    // Mirror server questionOf(), but never fall back to a machine field name.
    const name = isJunkLabel(d.name) ? "" : d.name;
    return (d.label || d.ariaLabel || d.surroundingText || d.placeholder || name || "").trim();
  }

  /** Grow a textarea to fit its content (capped) so the value is fully visible. */
  function autosize(ta) {
    ta.style.height = "auto";
    ta.style.height = Math.min(Math.max(ta.scrollHeight, 34), 240) + "px";
  }

  /** Wire a row's Copy button to copy the textarea's current value. */
  function wireCopyBtn(row, ta) {
    const btn = row.querySelector(".fldbtn.copy");
    if (!btn) return;
    btn.addEventListener("click", async () => {
      const val = ta.value.trim();
      if (!val) { setStatus("Nothing to copy yet.", "err"); return; }
      const ok = await copyToClipboard(val);
      const prev = btn.textContent;
      btn.textContent = ok ? "Copied ✓" : "Copy failed";
      setTimeout(() => { btn.textContent = prev; }, 1200);
    });
  }

  function setRowTag(row, source) {
    const t = row.querySelector(".fldtag");
    if (!t) return;
    t.outerHTML =
      source === "ai" ? `<span class="fldtag ai">AI</span>`
      : source === "app" ? `<span class="fldtag saved">saved</span>`
      : source === "profile" ? `<span class="fldtag reuse">reusable</span>`
      : `<span class="fldtag heu">instant</span>`;
  }

  /**
   * An editable answer row. The value is shown in an auto-sizing textarea. The
   * user decides where an edited/new answer is saved:
   *  - Save to app    → this application's answers (result.json), instant here.
   *  - Save to profile → the profile's reusable answers, instant on every app.
   * AI rows also get Generate (LLM for this one field). Fill applies the current
   * text to the page. `source` (instant|saved|reusable|AI) is just the origin tag.
   */
  // Two concepts now: EASY FILL (profile store) and Q&A (app store). Each list is
  // built from page fields + the relevant store; rows are editable textareas.

  function normalizeQ(s) {
    return String(s || "").toLowerCase().replace(/\s+/g, " ").trim();
  }
  let synthSeq = 0;

  /**
   * Easy Fill row — PROFILE store only. `ref` set ⇒ it's on the page (fillable).
   * Save writes a profile reusable answer; Delete removes it (profile rows only).
   */
  function easyRow({ d, ref, question, value, source }) {
    const row = document.createElement("div");
    row.className = "answerrow";
    const fillable = !!ref;
    const tag = source === "profile"
      ? `<span class="fldtag reuse">reusable</span>`
      : `<span class="fldtag heu">instant</span>`;
    row.innerHTML =
      `<div class="fldtop"><span class="fldlabel">${escapeHtml(question || "(field)")}</span>${tag}</div>` +
      `<textarea class="fldinput" rows="2" placeholder="Answer"></textarea>` +
      `<div class="fldacts">` +
        (fillable ? `<button type="button" class="fldbtn fill">Fill</button>` : "") +
        `<button type="button" class="fldbtn copy">Copy</button>` +
        `<button type="button" class="fldbtn save">Save</button>` +
        (source === "profile" ? `<button type="button" class="fldbtn del">Delete</button>` : "") +
      `</div>`;
    const ta = row.querySelector(".fldinput");
    ta.value = value || ""; autosize(ta);
    ta.addEventListener("input", () => autosize(ta));
    wireCopyBtn(row, ta);
    const fillBtn = row.querySelector(".fldbtn.fill");
    const saveBtn = row.querySelector(".fldbtn.save");
    const delBtn = row.querySelector(".fldbtn.del");

    if (fillBtn) fillBtn.addEventListener("click", async () => {
      const val = ta.value.trim();
      if (!val) { setStatus("Enter an answer first.", "err"); return; }
      fillBtn.disabled = true;
      const filled = await applyValues([{ ref, value: val }]);
      fillBtn.disabled = false;
      row.classList.toggle("done", filled > 0);
      setStatus(filled > 0 ? `Filled "${question}".` : `Couldn't fill "${question}".`, filled > 0 ? "ok" : "err");
    });

    saveBtn.addEventListener("click", async () => {
      const val = ta.value.trim();
      if (!val) { setStatus("Enter an answer before saving.", "err"); return; }
      if (!currentProfileId) { setStatus("No profile selected.", "err"); return; }
      saveBtn.disabled = true;
      const res = await send("enpplify:saveProfileAnswer", { profileId: currentProfileId, question, answer: val });
      saveBtn.disabled = false;
      if (res.ok) { saveBtn.textContent = "Saved ✓"; setRowTag(row, "profile"); setStatus(`Saved "${question}" to Easy Fill (profile).`, "ok"); }
      else setStatus(res.error || "Could not save.", "err");
    });

    if (delBtn) delBtn.addEventListener("click", async () => {
      delBtn.disabled = true;
      const res = await send("enpplify:saveProfileAnswer", { profileId: currentProfileId, question, answer: "" });
      delBtn.disabled = false;
      if (res.ok) { row.remove(); setStatus(`Removed "${question}" from Easy Fill.`, "ok"); }
      else setStatus(res.error || "Could not delete.", "err");
    });
    return row;
  }

  /** Current page text as job context for run-free Q&A (JD often isn't on the apply page). */
  function qaPageContext() {
    const pageText = (typeof scrapeJobDescription === "function" ? scrapeJobDescription() : "") || "";
    return { job_description: pageText, apply_form: pageText };
  }

  /**
   * AI-answer Q&A fields with as much context as we have. With a run, use the
   * application's stored context; without one, send the current page's text +
   * profile so answers still generate (no "Generate first" gate).
   */
  async function qaAiGenerate(fields) {
    if (activeAppId) return send("enpplify:fillMap", { appId: activeAppId, fields, mode: "ai" });
    if (!currentProfileId) {
      return { ok: false, error: "No profile selected. Open the Tryvify popup and pick a profile." };
    }
    return send("enpplify:fillMapProfile", { profileId: currentProfileId, fields, mode: "ai", context: qaPageContext() });
  }

  /**
   * Q&A row — APP store only. `ref` set ⇒ it's a page question (fillable).
   * Generate asks the LLM (server saves it to this app); Save/Delete edit the
   * app's answers. `kind`: "app" | "dashboard" (follow-up) | "new" (unanswered).
   */
  function qaRow({ d, ref, question, answer, kind }) {
    const row = document.createElement("div");
    row.className = "answerrow";
    const fillable = !!ref;
    const tag = kind === "dashboard" ? `<span class="fldtag reuse">dashboard</span>`
      : answer ? `<span class="fldtag saved">answered</span>`
      : `<span class="fldtag heu">unanswered</span>`;
    row.innerHTML =
      `<div class="fldtop"><span class="fldlabel">${escapeHtml(question || "(question)")}</span>${tag}</div>` +
      `<textarea class="fldinput" rows="2" placeholder="No answer yet — Generate or type one"></textarea>` +
      `<div class="fldacts">` +
        `<button type="button" class="fldbtn gen">Generate</button>` +
        (fillable ? `<button type="button" class="fldbtn fill">Fill</button>` : "") +
        `<button type="button" class="fldbtn copy">Copy</button>` +
        `<button type="button" class="fldbtn save">Save</button>` +
        `<button type="button" class="fldbtn toprofile" title="Also save this question + answer to the profile (Easy Fill) — reused on every application">→ Profile</button>` +
        `<button type="button" class="fldbtn del">Delete</button>` +
      `</div>`;
    const ta = row.querySelector(".fldinput");
    ta.value = answer || ""; autosize(ta);
    wireCopyBtn(row, ta);
    ta.addEventListener("input", () => autosize(ta));
    const genBtn = row.querySelector(".fldbtn.gen");
    const fillBtn = row.querySelector(".fldbtn.fill");
    const saveBtn = row.querySelector(".fldbtn.save");
    const toProfileBtn = row.querySelector(".fldbtn.toprofile");
    const delBtn = row.querySelector(".fldbtn.del");

    genBtn.addEventListener("click", async () => {
      genBtn.disabled = true; genBtn.textContent = "Generating…";
      const field = d || { ref: "qa_" + (synthSeq++), label: question, type: "textarea" };
      const res = await qaAiGenerate([field]);
      genBtn.disabled = false; genBtn.textContent = "Regenerate";
      if (!res.ok) { setStatus(res.error || "AI fill failed.", "err"); return; }
      const v = (res.values || [])[0];
      if (!v || !v.value) { setStatus(`AI had no answer for "${question}".`, "err"); return; }
      ta.value = v.value; autosize(ta); setRowTag(row, "app");
      setStatus(`Generated "${question}".${fillable ? " Review, then Fill." : ""}`, "ok");
    });

    if (fillBtn) fillBtn.addEventListener("click", async () => {
      const val = ta.value.trim();
      if (!val) { setStatus("Generate or type an answer first.", "err"); return; }
      fillBtn.disabled = true;
      const filled = await applyValues([{ ref, value: val }]);
      fillBtn.disabled = false;
      row.classList.toggle("done", filled > 0);
      setStatus(filled > 0 ? `Filled "${question}".` : `Couldn't fill "${question}".`, filled > 0 ? "ok" : "err");
    });

    saveBtn.addEventListener("click", async () => {
      const val = ta.value.trim();
      if (!val) { setStatus("Enter an answer before saving.", "err"); return; }
      saveBtn.disabled = true;
      // Saving needs an application to store into — create the lightweight slot now if there's no run.
      if (!activeAppId) { const ok = await ensureQaSlot(); if (!ok) { saveBtn.disabled = false; return; } }
      const res = await send("enpplify:saveAppAnswer", { appId: activeAppId, question, answer: val });
      saveBtn.disabled = false;
      if (res.ok) { saveBtn.textContent = "Saved ✓"; setRowTag(row, "app"); setStatus(`Saved "${question}" to this application's Q&A.`, "ok"); }
      else setStatus(res.error || "Could not save.", "err");
    });

    // Promote a Q&A question+answer to the PROFILE (Easy Fill), so it's reused
    // with no AI on every application for this profile.
    toProfileBtn.addEventListener("click", async () => {
      const val = ta.value.trim();
      if (!val) { setStatus("Generate or type an answer before saving to the profile.", "err"); return; }
      if (!currentProfileId) { setStatus("No profile selected.", "err"); return; }
      toProfileBtn.disabled = true;
      const res = await send("enpplify:saveProfileAnswer", { profileId: currentProfileId, question, answer: val });
      toProfileBtn.disabled = false;
      if (res.ok) { toProfileBtn.textContent = "→ Profile ✓"; setStatus(`Saved "${question}" to the profile (Easy Fill).`, "ok"); }
      else setStatus(res.error || "Could not save to profile.", "err");
    });

    delBtn.addEventListener("click", async () => {
      if (!activeAppId) { row.remove(); return; }
      delBtn.disabled = true;
      const res = await send("enpplify:saveAppAnswer", { appId: activeAppId, question, answer: "" });
      delBtn.disabled = false;
      if (res.ok) { row.remove(); setStatus(`Removed "${question}" from Q&A.`, "ok"); }
      else setStatus(res.error || "Could not delete.", "err");
    });
    return row;
  }

  /** The "＋ Add" row at the bottom of the Easy Fill list (writes to profile). */
  function addRowEasy() {
    const row = document.createElement("div");
    row.className = "answerrow addrow";
    row.innerHTML =
      `<input class="fldqinput" placeholder="New question / field label" />` +
      `<textarea class="fldinput" rows="2" placeholder="Answer"></textarea>` +
      `<div class="fldacts"><button type="button" class="fldbtn save">＋ Add to profile</button></div>`;
    const qi = row.querySelector(".fldqinput");
    const ta = row.querySelector(".fldinput");
    autosize(ta); ta.addEventListener("input", () => autosize(ta));
    row.querySelector(".fldbtn.save").addEventListener("click", async () => {
      const q = qi.value.trim(); const a = ta.value.trim();
      if (!q || !a) { setStatus("Enter a question and an answer.", "err"); return; }
      if (!currentProfileId) { setStatus("No profile selected.", "err"); return; }
      const res = await send("enpplify:saveProfileAnswer", { profileId: currentProfileId, question: q, answer: a });
      if (res.ok) { setStatus(`Added "${q}" to Easy Fill.`, "ok"); void renderEasyFill(); }
      else setStatus(res.error || "Could not add.", "err");
    });
    return row;
  }

  /** The "＋ Add" row at the bottom of the Q&A list (Generate + write to app). */
  function addRowQA() {
    const row = document.createElement("div");
    row.className = "answerrow addrow";
    row.innerHTML =
      `<input class="fldqinput" placeholder="New question" />` +
      `<textarea class="fldinput" rows="2" placeholder="Answer — Generate or type"></textarea>` +
      `<div class="fldacts"><button type="button" class="fldbtn gen">Generate</button><button type="button" class="fldbtn save">＋ Add to Q&amp;A</button></div>`;
    const qi = row.querySelector(".fldqinput");
    const ta = row.querySelector(".fldinput");
    autosize(ta); ta.addEventListener("input", () => autosize(ta));
    row.querySelector(".fldbtn.gen").addEventListener("click", async () => {
      const q = qi.value.trim();
      if (!q) { setStatus("Enter a question first.", "err"); return; }
      const btn = row.querySelector(".fldbtn.gen"); btn.disabled = true; btn.textContent = "Generating…";
      const res = await qaAiGenerate([{ ref: "qa_" + (synthSeq++), label: q, type: "textarea" }]);
      btn.disabled = false; btn.textContent = "Generate";
      if (!res.ok) { setStatus(res.error || "AI fill failed.", "err"); return; }
      const v = (res.values || [])[0];
      if (!v || !v.value) { setStatus(`AI had no answer for "${q}".`, "err"); return; }
      ta.value = v.value; autosize(ta); setStatus("Generated. Review, then Add.", "ok");
    });
    row.querySelector(".fldbtn.save").addEventListener("click", async () => {
      const q = qi.value.trim(); const a = ta.value.trim();
      if (!q || !a) { setStatus("Enter a question and an answer.", "err"); return; }
      if (!activeAppId) { const ok = await ensureQaSlot(); if (!ok) return; }
      const res = await send("enpplify:saveAppAnswer", { appId: activeAppId, question: q, answer: a });
      if (res.ok) { setStatus(`Added "${q}" to Q&A.`, "ok"); void renderQA(); }
      else setStatus(res.error || "Could not add.", "err");
    });
    return row;
  }

  /** A short label for a password field. */
  function passwordLabel(el) {
    const t = labelFor(el) || el.getAttribute("aria-label") || el.name || el.getAttribute("placeholder") || "Password";
    return t.trim().replace(/\s+/g, " ").slice(0, 60) || "Password";
  }

  /**
   * Row for a password field in the "instant" menu. Passwords are excluded from
   * the server harvest (filled locally), so they get their own rows: clicking
   * fills just that field with the autofill password. No run needed.
   */
  function passwordItem(el) {
    const label = passwordLabel(el);
    const ready = passwordAutofillEnabled();
    const item = document.createElement("button");
    item.type = "button";
    item.className = "flditem";
    item.innerHTML =
      `<span class="fldtop"><span class="fldlabel">${escapeHtml(label)}</span>` +
      `<span class="fldtag heu">password</span></span>` +
      `<span class="fldval${ready ? "" : " muted"}">${ready ? "••••••••" : "Set an autofill password in Tryvify settings"}</span>`;
    if (!ready) { item.disabled = true; return item; }
    item.addEventListener("click", () => {
      try {
        el.focus?.();
        setNativeValue(el, enpplifySettings.autofill_password);
        el.dispatchEvent(new Event("blur", { bubbles: true }));
        el.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
        item.classList.add("done");
        setStatus(`Filled "${label}".`, "ok");
      } catch {
        setStatus(`Couldn't fill "${label}".`, "err");
      }
    });
    return item;
  }

  // --- Easy Fill list (profile store) ---------------------------------------

  async function openEasyFill() {
    if (openMenuMode === "easy" && !fldMenu.classList.contains("hidden")) { closeFieldMenu(); return; }
    closeFieldMenu();
    openMenuMode = "easy";
    flCaret.classList.add("open");
    fldMenu.classList.remove("hidden");
    await renderEasyFill();
  }

  async function renderEasyFill() {
    fldMenu.innerHTML = `<div class="fldloading">Reading the form…</div>`;
    // Pick up a freshly-set autofill password so password rows aren't disabled.
    await refreshSettingsBestEffort();
    if (openMenuMode !== "easy") return;
    const pwFields = passwordFields();

    // Only fields that actually appear on THIS page's form (profile basics +
    // profile-reusable answers that match a field) — not the whole profile list.
    // Easy Fill is profile-only, so it works before a run via the profile-scoped
    // endpoint; with a run we use the per-app endpoint (same heuristic result).
    let matches = [];
    let descByRef = new Map();
    const fields = harvestFields();
    if (fields.length > 0) {
      const res = activeAppId
        ? await send("enpplify:fillMap", { appId: activeAppId, fields, mode: "heuristic" })
        : await send("enpplify:fillMapProfile", { profileId: currentProfileId, fields, mode: "heuristic" });
      if (openMenuMode !== "easy") return;
      if (res.ok) {
        matches = (res.values || []).filter((v) => v && v.ref && v.value);
        descByRef = new Map(fields.map((f) => [f.ref, f]));
      }
    }

    fldMenu.innerHTML = "";
    for (const v of matches) {
      const d = descByRef.get(v.ref);
      const q = fieldQuestion(d);
      fldMenu.appendChild(easyRow({ d, ref: v.ref, question: q, value: v.value, source: v.source === "profile" ? "profile" : "heuristic" }));
    }
    for (const el of pwFields) fldMenu.appendChild(passwordItem(el));
    if (!fldMenu.querySelector(".answerrow:not(.addrow)") && !pwFields.length) {
      const note = document.createElement("div");
      note.className = "fldempty";
      note.textContent = "No Easy-Fill matches on this page. Add a reusable answer below.";
      fldMenu.appendChild(note);
    }
    fldMenu.appendChild(addRowEasy()); // Add row sits at the BOTTOM of the list
  }

  // --- Q&A list (app store) -------------------------------------------------

  /**
   * Ensure a generation slot exists so Q&A/Fill can store + answer questions.
   * Q&A no longer requires generating a résumé first: when there's no run yet,
   * create a lightweight Q&A-only slot (company/role + answers via the cheap
   * model). Pressing Generate later fills the résumé into this same slot.
   */
  async function ensureQaSlot() {
    // The full application-page text — stored on the run as its "application
    // form" (separate from the JD) and refreshed every time Q&A runs here.
    const pageText = scrapeJobDescription();
    if (activeAppId) {
      // Keep the stored application-form text current for this run. Awaited (not
      // fire-and-forget) so it reliably lands before Q&A proceeds; non-fatal.
      if (pageText) {
        const r = await send("enpplify:setApplyForm", { appId: activeAppId, applyForm: pageText });
        if (r && r.ok === false) console.warn("[enpplify] setApplyForm failed:", r.error);
      }
      return true;
    }
    if (!pageText) { setStatus("No readable text found on this page for Q&A.", "err"); return false; }
    setStatus("Reading the job for Q&A…", "", true);
    const res = await send("enpplify:qaCreate", { jobLink: location.href, jobDescription: pageText, applyForm: pageText });
    if (!res.ok) { setStatus(res.error || "Couldn't start Q&A for this page.", "err"); return false; }
    enableFillActions(res.appId);
    markGenerated();
    const who = [res.companyName, res.roleName].filter(Boolean).join(" — ");
    setStatus(`Q&A ready${who ? `: ${who}` : ""}.`, "ok");
    return true;
  }

  async function openQA() {
    if (openMenuMode === "qa" && !fldMenu.classList.contains("hidden")) { closeFieldMenu(); return; }
    closeFieldMenu();
    openMenuMode = "qa";
    aiCaret.classList.add("open");
    fldMenu.classList.remove("hidden");
    fldMenu.innerHTML = `<div class="fldloading">Reading the form…</div>`;
    // No run is required to view/generate Q&A: we answer from the current page
    // text + profile. If a run already exists, keep its stored apply-form text
    // current (non-fatal, fire-and-forget). The lightweight app slot is created
    // lazily on Save (see qaRow/addRowQA), not just to open the panel.
    if (activeAppId) {
      const pt = scrapeJobDescription();
      if (pt) void send("enpplify:setApplyForm", { appId: activeAppId, applyForm: pt });
    }
    await renderQA();
  }

  async function renderQA() {
    fldMenu.innerHTML = `<div class="fldloading">Reading the form…</div>`;
    const fields = harvestFields();
    let unmatched = [];
    let descByRef = new Map();
    if (fields.length > 0) {
      // Find which page fields are open questions (heuristic, no LLM). With a run
      // use the app-scoped pass; without one use the profile-scoped pass.
      const res = activeAppId
        ? await send("enpplify:fillMap", { appId: activeAppId, fields, mode: "heuristic" })
        : await send("enpplify:fillMapProfile", { profileId: currentProfileId, fields, mode: "heuristic" });
      if (openMenuMode !== "qa") return;
      if (res.ok) {
        unmatched = res.unmatchedRefs || [];
        descByRef = new Map(fields.map((f) => [f.ref, f]));
      }
    }
    // Stored app answers only exist once a run/slot does.
    let answers = [];
    let followups = [];
    if (activeAppId) {
      const qa = await send("enpplify:appQA", { appId: activeAppId });
      if (openMenuMode !== "qa") return;
      answers = qa.ok && Array.isArray(qa.answers) ? qa.answers : [];
      followups = qa.ok && Array.isArray(qa.followups) ? qa.followups : [];
    }
    const appMap = new Map();
    for (const a of answers) if (a && a.question) appMap.set(normalizeQ(a.question), a.answer || "");

    fldMenu.innerHTML = "";
    const shown = new Set();
    // 1) Open questions extracted from the page (fillable).
    for (const ref of unmatched) {
      const d = descByRef.get(ref);
      if (!d) continue;
      const q = fieldQuestion(d);
      const nq = normalizeQ(q);
      shown.add(nq);
      const ans = appMap.get(nq) ?? "";
      fldMenu.appendChild(qaRow({ d, ref, question: q, answer: ans, kind: ans ? "app" : "new" }));
    }
    // 2) Stored app answers not currently on the page.
    for (const a of answers) {
      const nq = normalizeQ(a.question);
      if (!a.question || shown.has(nq)) continue;
      shown.add(nq);
      fldMenu.appendChild(qaRow({ d: null, ref: null, question: a.question, answer: a.answer || "", kind: "app" }));
    }
    // 3) Dashboard follow-ups (tagged; fill only if a page field matches above).
    for (const f of followups) {
      const nq = normalizeQ(f.question);
      if (!f.question || shown.has(nq)) continue;
      shown.add(nq);
      fldMenu.appendChild(qaRow({ d: null, ref: null, question: f.question, answer: f.answer || "", kind: "dashboard" }));
    }
    if (!fldMenu.querySelector(".answerrow:not(.addrow)")) {
      const note = document.createElement("div");
      note.className = "fldempty";
      note.textContent = "No open questions on this page or stored Q&A. Add one above.";
      fldMenu.appendChild(note);
    }
    fldMenu.insertBefore(addRowQA(), fldMenu.firstChild); // Add row sits at the TOP of the list
  }

  flCaret.addEventListener("click", () => void openEasyFill());
  aiCaret.addEventListener("click", () => void openQA());

  rsBtn.addEventListener("click", async () => {
    // Base-resume attach needs no run; generated attach does.
    if (!activeAppId && !baseEl.checked) {
      setStatus("Generate first — the résumé PDF comes from the generated run.", "err");
      return;
    }
    rsBtn.disabled = true;
    setStatus("Attaching documents…", "", true);
    const attached = await attachDocs();
    rsBtn.disabled = false;
    const done = describeAttach(attached);
    if (done.length) {
      setStatus(done.join(" · ") + ". Review, then submit manually.", "ok");
    } else if (attached.resume?.reason === "no-input") {
      setStatus("No résumé/CV upload field found on this page.", "err");
    } else {
      setStatus(`Attach failed: ${attached.resume?.reason || "unknown"}`, "err");
    }
    // Finally, download the generated files to this computer — same as the
    // ⬇ Download button. Only when a generated run exists (base-résumé attach
    // has no run/artifacts to download).
    if (activeAppId) await downloadFiles();
  });

  // --- minimize + drag -------------------------------------------------------
  // The panel shrinks to a draggable circle (FAB). Both the header and the FAB
  // act as drag handles; a small movement threshold separates a drag (reposition)
  // from a click (header click does nothing; FAB click expands). Position
  // persists across pages/reloads in chrome.storage.

  const hd = $("hd");
  const POS_KEY = "panelPos";

  function setMinimized(min) {
    wrap.classList.toggle("minimized", !!min);
  }

  function persistPos() {
    const rect = mount.getBoundingClientRect();
    try {
      chrome.storage.local.set({ [POS_KEY]: { left: rect.left, top: rect.top } });
    } catch {
      /* ignore */
    }
  }

  // Minimize and expand are mirror images around the BOTTOM-RIGHT corner, so the
  // transition is reversible and nothing jumps: the circle's bottom-right sits
  // exactly where the panel's bottom-right was, and expanding restores it.

  /** Collapse the panel to the circle, keeping the bottom-right corner fixed. */
  function minimizeToCorner() {
    const before = mount.getBoundingClientRect(); // panel rect
    const right = before.right, bottom = before.bottom;
    setMinimized(true);
    const c = mount.getBoundingClientRect(); // circle rect (now)
    applyPosition(right - c.width, bottom - c.height);
    persistPos();
  }

  /** Expand from the circle, keeping the bottom-right corner fixed (grows up+left). */
  function expandFromCircle() {
    const c = mount.getBoundingClientRect(); // circle rect (before expand)
    const right = c.right, bottom = c.bottom;
    setMinimized(false);
    const p = mount.getBoundingClientRect(); // panel rect (now visible)
    applyPosition(right - p.width, bottom - p.height);
    persistPos();
  }

  function onMinimizeClick(e) {
    e.stopPropagation();
    minimizeToCorner();
  }
  minBtn.addEventListener("click", onMinimizeClick);
  minTopBtn.addEventListener("click", onMinimizeClick);
  // Don't let a mousedown on the header's buttons start a drag.
  minTopBtn.addEventListener("mousedown", (e) => e.stopPropagation());
  refreshBtn.addEventListener("mousedown", (e) => e.stopPropagation());

  // Reload everything from the server: state (profile/session), settings,
  // memory/status, and re-render whichever list is open so it pulls fresh data.
  async function doRefresh() {
    if (refreshBtn.disabled) return;
    refreshBtn.disabled = true;
    refreshBtn.classList.add("spin");
    try {
      const res = await send("enpplify:getState", { jobLink: location.href });
      if (!res.signedIn) {
        authView.classList.remove("hidden");
        appView.classList.add("hidden");
        hdProf.classList.add("hidden");
        setStatus("Sign in from the Tryvify popup, then reopen.", "err");
        return;
      }
      authView.classList.add("hidden");
      appView.classList.remove("hidden");
      hdProf.classList.remove("hidden");
      currentProfileId = res.profileId || "";
      const profName = res.profileName || res.profileId || "—";
      $("prof").textContent = profName;
      $("avatar").textContent = profName && profName !== "—" ? profName.trim()[0] : "?";
      await loadSettings();

      // Re-render the open list first (uses fldMenu, not the status line), then
      // let poll() set the final status with run/company info.
      if (!fldMenu.classList.contains("hidden")) {
        if (openMenuMode === "easy") await renderEasyFill();
        else if (openMenuMode === "qa") await renderQA();
      }

      if (res.session?.appId) {
        markGenerated();
        enableFillActions(res.session.appId);
        await poll(res.session.appId);
      } else {
        enableFillActions("");
        updateMemory(null);
        setStatus("Refreshed.", "ok");
      }
    } catch (e) {
      setStatus(`Refresh failed: ${e?.message || e}`, "err");
    } finally {
      refreshBtn.disabled = false;
      refreshBtn.classList.remove("spin");
    }
  }
  refreshBtn.addEventListener("click", (e) => { e.stopPropagation(); void doRefresh(); });

  function clampToViewport(left, top) {
    const rect = mount.getBoundingClientRect();
    const w = rect.width || 268;
    const h = rect.height || 60;
    const maxLeft = Math.max(0, window.innerWidth - w);
    const maxTop = Math.max(0, window.innerHeight - h);
    return {
      left: Math.min(Math.max(0, left), maxLeft),
      top: Math.min(Math.max(0, top), maxTop),
    };
  }

  function applyPosition(left, top) {
    const p = clampToViewport(left, top);
    mount.style.left = `${p.left}px`;
    mount.style.top = `${p.top}px`;
    mount.style.right = "auto";
    mount.style.bottom = "auto";
  }

  // Re-apply the active (left/top-anchored) position, clamped to the CURRENT
  // layout. The expanded panel is far wider than the minimized circle, so a
  // saved position that kept the *circle* on-screen would push the *panel* off
  // the right edge once expanded. Call after any size change (e.g. the initial
  // expand in init) to pull it fully back into view. No-op when still anchored
  // to the default bottom-right corner (no saved position).
  function reclampPosition() {
    if (mount.style.left && mount.style.left !== "auto") {
      applyPosition(parseFloat(mount.style.left) || 0, parseFloat(mount.style.top) || 0);
    }
  }

  // Restore a saved position (if any).
  try {
    chrome.storage.local.get(POS_KEY, (items) => {
      const p = items && items[POS_KEY];
      if (p && typeof p.left === "number" && typeof p.top === "number") {
        applyPosition(p.left, p.top);
      }
    });
  } catch {
    /* storage unavailable — keep default bottom-right anchor */
  }

  /** Make `handle` drag the whole panel; fire onClick() for a click (no drag). */
  function makeDraggable(handle, onClick) {
    let dragging = false, moved = false, sx = 0, sy = 0, bl = 0, bt = 0;
    handle.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      dragging = true; moved = false; sx = e.clientX; sy = e.clientY;
      const rect = mount.getBoundingClientRect();
      bl = rect.left; bt = rect.top;
      handle.classList.add("dragging");
      e.preventDefault();
    });
    window.addEventListener("mousemove", (e) => {
      if (!dragging) return;
      const dx = e.clientX - sx, dy = e.clientY - sy;
      if (!moved && Math.abs(dx) + Math.abs(dy) > 4) moved = true;
      if (moved) applyPosition(bl + dx, bt + dy);
    });
    window.addEventListener("mouseup", () => {
      if (!dragging) return;
      dragging = false;
      handle.classList.remove("dragging");
      if (moved) {
        const rect = mount.getBoundingClientRect();
        try {
          chrome.storage.local.set({ [POS_KEY]: { left: rect.left, top: rect.top } });
        } catch {
          /* ignore persistence failure */
        }
      } else if (onClick) {
        onClick();
      }
    });
  }

  makeDraggable(hd, null);              // header: drag only
  makeDraggable(fab, expandFromCircle); // circle: drag, or click to open (top-right)

  // Keep the panel on-screen if the window is resized.
  window.addEventListener("resize", () => {
    if (mount.style.left && mount.style.left !== "auto") {
      applyPosition(parseFloat(mount.style.left), parseFloat(mount.style.top));
    }
  });

  /**
   * Heuristic "is this a job / application page?" — mirrors how autofillers like
   * Simplify decide whether to engage. Used only to choose the INITIAL state
   * (expanded vs minimized circle); the user can always open the circle.
   */
  function looksLikeJobPage() {
    const url = location.href.toLowerCase();
    const h = host.toLowerCase();
    const ATS = [
      "greenhouse.io", "lever.co", "ashbyhq.com", "myworkdayjobs.com", "workday",
      "icims.com", "smartrecruiters.com", "taleo.net", "jobvite.com", "bamboohr.com",
      "breezy.hr", "workable.com", "applytojob.com", "recruitee.com", "successfactors",
      "avature.net", "jobs.", "careers.", "boards.", "job-boards.",
    ];
    if (ATS.some((s) => h.includes(s) || url.includes(s))) return true;
    if (/(apply|application|\/jobs?\/|career|posting|gh_jid|requisition|req[-_]?id|opening)/.test(url)) return true;
    // DOM signals
    const text = (document.body?.innerText || "").toLowerCase();
    const hasFile = !!document.querySelector('input[type="file"]');
    const fields = document.querySelectorAll("input, textarea, select").length;
    let score = 0;
    if (hasFile) score += 1;
    if (/\bapply\b|application form|submit your application/.test(text)) score += 1;
    if (/resume|résumé|cover letter|job description|qualifications|responsibilities|equal opportunity/.test(text)) score += 1;
    if (fields >= 4) score += 1;
    return score >= 2;
  }

  // Set the status line. Pass busy=true for in-progress actions to show the
  // spinner; any terminal status (ok/err/plain) hides it, so it can't get stuck.
  function setStatus(msg, kind = "", busy = false) {
    stEl.textContent = msg || "";
    stEl.className = `status${kind ? " " + kind : ""}`;
    spEl.classList.toggle("hidden", !busy);
  }

  // --- state + polling -------------------------------------------------------

  let pollTimer = null;
  const STEP_LABEL = {
    queued: "Queued…",
    extracting_keywords: "Reading the job…",
    generating_resume: "Writing résumé…",
    generating_cover_letter: "Writing cover letter…",
    generating_answers: "Answering questions…",
    completed: "Done",
    failed: "Failed",
    cancelled: "Cancelled",
  };

  function stopPolling() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  }

  function setBusy(busy) {
    goBtn.disabled = busy;
  }

  function markGenerated() {
    // A run exists. Keep the primary button as "Generate" (clicking it loads the
    // existing run without overwriting); the explicit "Regenerate (force)" button
    // — shown via enableFillActions — is what actually re-runs.
    goBtn.textContent = "Generate documents";
  }

  // Set when this run pre-existed (you already applied) rather than being freshly
  // generated now — drives the "you already applied" notice. A fresh generation
  // resets it; loading a pre-existing run sets it.
  let alreadyAppliedNotice = false;

  /**
   * Apply a terminal status payload to the panel. Returns true if the run
   * completed (documents ready), false if it failed/cancelled. Shared by the
   * interval poller and the awaitable waitForRun().
   */
  function applyRunResult(res, polledAppId) {
    stopPolling();
    setBusy(false);
    // The server may have switched us to a pre-existing run (duplicate
    // recovery); use the id it reports back, not the one we polled with.
    const effectiveId = res.appId || polledAppId;
    if (res.status === "completed") {
      const who = [res.companyName, res.roleName].filter(Boolean).join(" — ");
      // "Already applied" when the server recovered a duplicate (usedExisting)
      // or when we loaded a pre-existing run instead of regenerating.
      const already = res.usedExisting || alreadyAppliedNotice;
      if (already) {
        setStatus(
          `You already applied${who ? ` to ${who}` : ""} with this profile — loaded existing documents. Ready to fill.`,
          "ok",
        );
      } else {
        setStatus(`Done${who ? ": " + who : ""}. Ready to fill.`, "ok");
      }
      markGenerated();
      showCopyPath(res.copyPath);
      enableFillActions(effectiveId);
      updateMemory(res.memory);
      return true;
    }
    setStatus(res.generationError || `Run ${res.status}.`, "err");
    markGenerated();
    return false;
  }

  // How many consecutive "not found" polls before we give up. A freshly-created
  // run appears in the list almost immediately; if it never shows (e.g. it was
  // rejected+deleted server-side), don't spin forever — surface an error.
  const NOT_FOUND_LIMIT = 8; // ~20s at 2.5s cadence
  let notFoundCount = 0;

  async function poll(appId) {
    const res = await send("enpplify:status", { appId, jobLink: location.href });
    if (!res.ok) { setStatus(res.error || "Status check failed.", "err"); return; }
    if (!res.found) {
      notFoundCount += 1;
      if (notFoundCount >= NOT_FOUND_LIMIT) {
        stopPolling();
        setBusy(false);
        markGenerated();
        setStatus("That run didn't stick (it may have been rejected). Try Force regenerate.", "err");
        return;
      }
      setStatus("Run not found yet…", "", true);
      return;
    }
    notFoundCount = 0;
    if (res.status === "generating") {
      setStatus(STEP_LABEL[res.statusStep] || "Generating…", "", true);
      return;
    }
    applyRunResult(res, appId);
  }

  function startPolling(appId) {
    stopPolling();
    notFoundCount = 0;
    poll(appId);
    pollTimer = setInterval(() => poll(appId), 2500);
  }

  /**
   * Poll a run to a terminal state, awaitably (no interval timer). Resolves
   * true if it completed, false otherwise. Used by the one-click "Fill all".
   */
  async function waitForRun(appId) {
    stopPolling(); // don't let the interval poller race this loop
    for (;;) {
      const res = await send("enpplify:status", { appId, jobLink: location.href });
      if (!res.ok) { setStatus(res.error || "Status check failed.", "err"); return false; }
      if (!res.found) { setStatus("Run not found yet…", "", true); await sleep(2500); continue; }
      if (res.status === "generating") {
        setStatus(STEP_LABEL[res.statusStep] || "Generating…", "", true);
        await sleep(2500);
        continue;
      }
      return applyRunResult(res, appId);
    }
  }

  /** Start a generation for this page. Returns { appId, alreadyApplied } or null. */
  async function startGeneration() {
    // "Use base resume" attaches the uploaded base PDF — never generate a per-job
    // résumé in that mode. If the cover letter is also off there is nothing to
    // generate; don't kick off an empty run (the base PDF attaches via Fill).
    const genResume = $("gr").checked && !baseEl.checked;
    const genCoverLetter = $("gc").checked;
    if (!genResume && !genCoverLetter) {
      setStatus(
        baseEl.checked
          ? "Nothing to generate — base résumé is used. Press Fill to attach it."
          : "Nothing to generate — enable Résumé or Cover letter first.",
        "err",
      );
      return null;
    }
    const jobDescription = scrapeJobDescription();
    if (!jobDescription) { setStatus("No readable text found on this page.", "err"); return null; }
    setBusy(true);
    setStatus("Starting…", "", true);
    const res = await send("enpplify:generate", {
      jobLink: location.href,
      jobDescription,
      applyForm: null,
      genResume,
      genCoverLetter,
    });
    if (!res.ok) {
      setBusy(false);
      setStatus(res.error || "Generation failed to start.", "err");
      return null;
    }
    // The server (or local session) found this job already done → no overwrite.
    alreadyAppliedNotice = !!res.alreadyApplied;
    setStatus(res.alreadyApplied ? "Loading your existing application…" : "Generating…", "", true);
    return { appId: res.appId, alreadyApplied: !!res.alreadyApplied };
  }

  goBtn.addEventListener("click", async () => {
    const r = await startGeneration();
    if (r?.appId) startPolling(r.appId);
  });

  // Force a regeneration of the EXISTING run (rerun, reusing its output folder),
  // overwriting the current documents. Only shown once a run exists.
  async function forceRegenerate() {
    if (!activeAppId) { setStatus("Nothing to regenerate yet — Generate first.", "err"); return; }
    const jobDescription = scrapeJobDescription();
    if (!jobDescription) { setStatus("No readable text found on this page.", "err"); return; }
    const genResume = $("gr").checked && !baseEl.checked;
    const genCoverLetter = $("gc").checked;
    if (!genResume && !genCoverLetter) {
      setStatus("Nothing to regenerate — enable Résumé or Cover letter first.", "err");
      return;
    }
    regenBtn.disabled = true;
    setBusy(true);
    alreadyAppliedNotice = false;
    setStatus("Regenerating…", "", true);
    const res = await send("enpplify:regenerate", {
      jobLink: location.href,
      jobDescription,
      applyForm: null,
      genResume,
      genCoverLetter,
    });
    regenBtn.disabled = false;
    if (!res.ok) {
      setBusy(false);
      setStatus(res.error || "Regeneration failed to start.", "err");
      return;
    }
    startPolling(res.appId);
  }
  regenBtn.addEventListener("click", () => void forceRegenerate());

  /**
   * One-click FILL (never generates):
   *  1. ensure a lightweight Q&A slot exists so the AI answer pass has job
   *     context (does NOT generate a résumé/cover letter — those are the
   *     Generate button's job);
   *  2. attach an ALREADY-generated résumé/CV (or the base PDF if checked);
   *  3. Q&A — AI-answer + store + fill the application questions;
   *  4. Easy Fill last, so profile basics/reusable answers take precedence;
   *  5. fill sign-up passwords.
   * The Generate button is what produces résumé/cover-letter PDFs.
   */
  async function doFillAll() {
    fillAllBtn.disabled = true;
    try {
      // No generation here — just make sure there's a slot to answer/store
      // against (also refreshes the stored application-form text). If a full run
      // was already generated, we reuse it as-is.
      const ok = await ensureQaSlot();
      if (!ok) return;
      // Q&A pass: AI answers EVERY field (mode "ai") + attach already-generated
      // docs + passwords. The answers are stored on the run.
      await doFill({ mode: "ai", sources: ["ai"], attach: true, passwords: true, btn: fillAllBtn });
      // Easy Fill applied LAST so profile basics/reusable answers win on any
      // basic field the AI also answered (name/email/phone/links/city).
      await doFill({ mode: "heuristic", sources: ["heuristic", "app", "profile"], btn: fillAllBtn });
      // Finally, download the generated files to this computer — same as the
      // ⬇ Download button. Only when a generated run exists (base-résumé-only
      // fills have no run/artifacts to download).
      if (activeAppId) await downloadFiles();
    } finally {
      fillAllBtn.disabled = false;
    }
  }

  fillAllBtn.addEventListener("click", () => void doFillAll());

  // Re-sync the panel after the profile is changed elsewhere (the toolbar
  // popup). Runs are per-profile, so we reset run-bound UI and re-apply the new
  // profile's session for this page. Base-résumé availability is per profile too.
  async function refreshForProfile() {
    const res = await send("enpplify:getState", { jobLink: location.href });
    if (!res.signedIn) {
      authView.classList.remove("hidden");
      appView.classList.add("hidden");
      hdProf.classList.add("hidden");
      return;
    }
    authView.classList.add("hidden");
    appView.classList.remove("hidden");
    currentProfileId = res.profileId || "";
    const profName = res.profileName || res.profileId || "—";
    $("prof").textContent = profName;
    $("avatar").textContent = (profName && profName !== "—") ? profName.trim()[0] : "?";
    hdProf.classList.remove("hidden");

    // Reset run-bound UI — the old run belonged to the previous profile.
    stopPolling();
    setBusy(false);
    goBtn.textContent = "Generate documents";
    enableFillActions("");
    updateMemory(null);
    showCopyPath("");

    // "Use base résumé" is keyed on the profile: forget the old page's manual
    // override and start from the new profile's saved default (off if it has no
    // base résumé uploaded).
    baseManuallySet = false;
    baseEl.checked = baseResumeDefaultOn();
    applyBaseMode();
    refreshDropZone();

    if (res.session?.appId) {
      markGenerated();
      enableFillActions(res.session.appId);
      if (res.session.status === "generating") {
        setBusy(true);
        setStatus("Generating…", "", true);
        startPolling(res.session.appId);
      } else if (res.session.status === "completed") {
        setStatus(`Switched to ${profName}. Previously generated — Regenerate to refresh.`, "ok");
        poll(res.session.appId);
      } else {
        setStatus(`Switched to ${profName}.`, "ok");
      }
    } else {
      setStatus(`Switched to ${profName}.`, "ok");
    }
  }

  // The popup writes the picked profile to chrome.storage; mirror it live here
  // so the floating panel follows the popup without a page reload.
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local" || !changes.selectedProfile) return;
      const next = changes.selectedProfile.newValue || "";
      if (next !== currentProfileId) void refreshForProfile();
    });
  } catch {
    /* storage events unavailable — panel updates on next page load */
  }

  // --- init ------------------------------------------------------------------

  /**
   * In the TOP frame, detect a child iframe that likely hosts the application
   * form (cross-origin ATS embed, e.g. Greenhouse/Gem). When present, the
   * in-form child frame shows the primary panel, so the top frame defers by
   * starting minimized as a circle (the user can still open it for Generate).
   */
  function hasFormBearingChildFrame() {
    if (!isTopFrame) return false;
    const ATS_FRAME = /greenhouse|grnh\.se|lever\.co|ashby|gem\.com|myworkdayjobs|icims|smartrecruiters|jobvite|workable|breezy|bamboohr/i;
    for (const f of document.querySelectorAll("iframe")) {
      const src = f.getAttribute("src") || "";
      if (!src) continue;
      // Cross-origin form iframe we can't reach from here but our child-frame
      // script can — or any ATS-looking embed.
      if (ATS_FRAME.test(src)) return true;
      try {
        // Same-origin child with a form is handled by its own frame too.
        if (f.contentDocument?.querySelector('input,textarea,select')) return true;
      } catch {
        // Cross-origin: unreadable. Size heuristic — a big embed is likely the form.
        const r = f.getBoundingClientRect();
        if (r.width >= 320 && r.height >= 320) return true;
      }
    }
    return false;
  }

  async function init() {
    const res = await send("enpplify:getState", { jobLink: location.href });
    const hasRun = !!res.session?.appId;
    const deferToChild = hasFormBearingChildFrame();
    // Start expanded on job/application pages or when a run already exists for
    // this tab; otherwise start as a minimized circle the user can open. If the
    // form lives in a child frame, that frame is primary — start minimized here.
    setMinimized(deferToChild || !(hasRun || looksLikeJobPage()));
    // Starting expanded with a restored circle-position must not leave the wider
    // panel hanging off the right edge — re-clamp to the now-expanded width.
    reclampPosition();
    if (hasRun) fabdot.classList.remove("hidden");

    if (!res.ok && res.error) { setStatus(res.error, "err"); }
    if (!res.signedIn) {
      authView.classList.remove("hidden");
      appView.classList.add("hidden");
      hdProf.classList.add("hidden");
      return;
    }
    authView.classList.add("hidden");
    appView.classList.remove("hidden");
    currentProfileId = res.profileId || "";
    const profName = res.profileName || res.profileId || "—";
    $("prof").textContent = profName;
    $("avatar").textContent = (profName && profName !== "—") ? profName.trim()[0] : "?";
    hdProf.classList.remove("hidden");
    // On LinkedIn, default to résumé-only — most LinkedIn flows take only a
    // résumé, so the cover letter starts unchecked (you can re-tick it).
    if (isLinkedIn) { gcEl.checked = false; applyBaseMode(); }
    // Load feature flags + autofill password, then surface the password button
    // if this looks like an account-creation page. Retry once for late SPA
    // forms, and keep watching as the DOM mounts password/résumé fields.
    void loadSettings();
    setTimeout(() => { refreshPasswordButton(); refreshDropZone(); }, 1500);
    startFormWatcher();
    if (res.session?.appId) {
      markGenerated();
      enableFillActions(res.session.appId);
      if (res.session.status === "generating") {
        setBusy(true);
        setStatus("Generating…", "", true);
        startPolling(res.session.appId);
      } else if (res.session.status === "completed") {
        // You already applied to this job with this profile — flag it so the
        // poll's terminal message reads "you already applied …" with company/role.
        alreadyAppliedNotice = true;
        setStatus("You already applied with this profile — loading…", "ok", true);
        // Pull the stored run's path so Copy works on a fresh page load too.
        poll(res.session.appId);
      }
    }
    console.log("[enpplify] active on", host, isTopFrame ? "(top frame)" : "(child frame)");
  }

  init();
  } // end boot()
})();
