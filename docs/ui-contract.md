# UI contract — selectors and identifiers the redesign must not break

This file is the guardrail for the Tryvera / Tryvify UI redesign. Everything
listed here is **load-bearing**: JavaScript looks it up, the server depends on
it, or a stored user preference is keyed on it. The redesign rewrites
stylesheets and markup freely — but every identifier below must survive
verbatim.

Regenerate the inventories with the commands at the bottom after any UI stage
and diff against these lists. A missing entry is a broken feature, not a style
regression.

---

## 1. Names that look like branding but are not

Renaming any of these breaks runtime behaviour. They stay as-is.

| Identifier | Location | Consequence of renaming |
| --- | --- | --- |
| `enpply_sid` | `server/src/auth/cookies.ts:3` | Session cookie name. Every signed-in user is logged out; the extension loses its session. |
| `enpply.autoDownloadDir` | `extension/lib/storage.js:68` | localStorage key shared between the web app and the extension. "Copy path" silently reverts to the server path. |
| `tealbridge.online`, `app.tealbridge.online` | `client/src/domains.ts:20-25`, `extension/manifest.json:11` | Live deployment hostnames. Drives the marketing/app routing split, CORS, and extension `host_permissions`. |
| `/api/enpplify/*` | server routes, `client/src/enpply/api.ts` | HTTP API contract shared with the shipped extension. |
| `/enpplify` | React route, `client/src/App.tsx:43` | Bookmarked route + `KNOWN_ROUTE_PATTERNS` membership; a mismatch renders NotFound. |
| `enpplify-root` | `extension/content.js:833` | Mount element id. Panel fails to mount / de-duplicate. |
| `client/src/enpply/` | directory path | Not UI. Renaming is pure churn across every import. |

**Renameable (visible text only):** `manifest.json` `name` / `description` /
`action.default_title`, `popup.html` `<title>` and brand text, the panel header
title and FAB glyph, the dashboard nav brand (`App.tsx:69`, currently
`TealBridge`), the theme label `"Enpply - Standard"` in
`client/src/enpply/themes.ts:8`, and the copy string at
`extension/content.js:2258` ("…in Enpplify settings").

---

## 2. Extension panel — `extension/content.js`

The panel lives in a shadow root (`content.js:835`). Its stylesheet and markup
are a single template literal spanning **lines 836–1238**: `<style>` at 837–1140,
markup at 1141–1237. That block is the redesign surface. Everything below line
1240 is logic and stays untouched.

Element lookups go through `const $ = (id) => shadow.getElementById(id)`
(`content.js:1263`), so **IDs are the primary contract**.

### 2.1 IDs — all 49 must remain, on an element of the same kind

```
ai          aiCaret     app         auth        avatar      base        baseRow
bd          cp          dl          drop        fab         fabdot      fillAll
fl          flCaret     fldMenu     gc          go          gr          grRow
hd          hdprof      jobCo       jobHd       jobRole     mem         memA
memC        memJob      memR        memRun      min         minTop      moreBtn
moreWrap    panel       prof        pw          refresh     regen       rs
sp          st          statusline  vc          ver         vr          wrap
```

45 of these are read by `$()`. The remaining four — `baseRow`, `mem`, `panel`,
`statusline` — are styling/structure anchors and must also stay, since layout
rules and the drag handler target them.

Type constraints that JS assumes:
- `gr`, `gc`, `base`, `autoEnabled`-style toggles are `<input type="checkbox">` —
  code reads `.checked`.
- `go`, `fillAll`, `fl`, `ai`, `rs`, `pw`, `dl`, `cp`, `regen`, `refresh`,
  `min`, `minTop`, `moreBtn`, `fab`, `flCaret`, `aiCaret` are clickable buttons —
  code attaches `click` listeners and sets `.disabled`.
- `st`, `prof`, `ver`, `memRun`, `memR`, `memC`, `memA`, `memJob`, `jobCo`,
  `jobRole` receive `.textContent`.
- `fldMenu` has its `.innerHTML` replaced wholesale (lines 2287, 2365, 2378).

### 2.2 Classes toggled by JS — behavioural, must keep their effect

| Class | Required effect |
| --- | --- |
| `hidden` | must hide the element (`display: none !important`) |
| `disabled` | must visually mute and block pointer events |
| `minimized` | collapses the panel to the FAB circle |
| `dragging` | applied to `hd` while the header is dragged |
| `open` | expanded state for the `more` region / field menus |
| `spin` | rotation animation on the refresh icon button |
| `done` | success state on a completed action |
| `over` | drag-over highlight on the résumé drop zone |

### 2.3 Classes queried by `querySelector` — must exist in emitted markup

```
answerrow   cptext   fldbtn   fldinput   fldqinput   fldtag
```

### 2.4 Classes emitted by JS-built markup — the redesign must style these

These come from template literals inside `easyRow` (`content.js:2018`), `qaRow`
(`2097`), `passwordItem` (`2249`), `renderEasyFill` (`2286`) and `renderQA`
(`2377`). The functions are logic and will not be edited, so the new stylesheet
has to cover every class they produce or those lists render unstyled.

```
addrow    ai        answerrow  copy      del       empty     fill
fldacts   fldbtn    fldempty   fldinput  flditem   fldlabel  fldloading
fldqinput fldtag    fldtop     fldval    gen       heu       memjob
memval    mono      muted      no        reuse     save      saved
toprofile
```

Note `fldval` is conditionally combined with `muted` at `content.js:2258`.

---

## 3. Extension popup — `extension/popup.html` / `popup.css` / `popup.js`

### 3.1 IDs — all 13 must remain, same element types

```
apiBase     appView     authView    autoDir     autoEnabled   email
password    profile     profileHint signIn      signOut       status
userEmail
```

- `apiBase`, `email`, `password`, `autoDir` are `<input>` — code reads `.value`.
- `autoEnabled` is `<input type="checkbox">` — code reads `.checked`.
- `profile` is a `<select>`; code populates `<option>` children and reads `.value`.
- `signIn`, `signOut` are buttons with click listeners.
- `authView`, `appView` are the two view containers toggled by `hidden`.

### 3.2 Classes

`popup.js:26` sets `statusEl.className = "status" [+ " error" | " ok"]`, so the
`status`, `status.error` and `status.ok` rules must all survive. `popup.js:30-32`
toggles `hidden` on `authView`, `appView` and `signOut`.

---

## 4. Dashboard — `client/src/`

Styling is token-driven: `client/src/styles.css:1-37` defines the palette as CSS
custom properties, with a dark default under `:root` and a light override under
`html[data-app-theme="light"]`. The theme is applied by
`applyAppUiTheme()` (`client/src/enpply/uiTheme.ts`), which sets
`document.documentElement.dataset.appTheme`.

**Constraint:** the `data-app-theme` attribute name, the `"light"` / `"dark"`
values, and the `user.preferences.ui_theme` field are logic. The redesign
retokens the *values* and flips which theme is the default — it does not change
the mechanism, remove the toggle, or alter the preferences API.

Route patterns in `KNOWN_ROUTE_PATTERNS` (`client/src/App.tsx:32-45`) must keep
matching the `<Route path>` values; a nav-label rename must not drift the paths.

---

## 5. Regenerating these inventories

Run from the repo root in PowerShell. Compare output against the lists above.

```powershell
# Panel IDs in the shadow markup
$m = Get-Content extension\content.js | Select-Object -Skip 1140 -First 97
($m | Select-String -Pattern 'id="([\w-]+)"' -AllMatches).Matches |
  ForEach-Object { $_.Groups[1].Value } | Sort-Object -Unique

# IDs the panel JS looks up
(Select-String -Path extension\content.js -Pattern '\$\("([\w-]+)"\)' -AllMatches).Matches |
  ForEach-Object { $_.Groups[1].Value } | Sort-Object -Unique

# Classes the panel JS toggles or queries
(Select-String -Path extension\content.js -Pattern 'classList\.(add|remove|toggle|contains)\("([^"]+)"' -AllMatches).Matches |
  ForEach-Object { $_.Groups[2].Value } | Sort-Object -Unique
(Select-String -Path extension\content.js -Pattern 'querySelector(All)?\("\.([\w-]+)' -AllMatches).Matches |
  ForEach-Object { $_.Groups[2].Value } | Sort-Object -Unique

# Popup element lookups
(Select-String -Path extension\popup.js -Pattern 'getElementById\("([\w-]+)"\)|\$\("([\w-]+)"\)' -AllMatches).Matches |
  ForEach-Object { if ($_.Groups[1].Value) { $_.Groups[1].Value } else { $_.Groups[2].Value } } | Sort-Object -Unique
```

---

## 6. Design tokens

Approved palette for both surfaces. The extension panel hardcodes these in its
shadow stylesheet (no CSS variables cross the shadow boundary from the page);
the dashboard maps them onto the existing custom properties in `styles.css`.

| Token | Value | Use |
| --- | --- | --- |
| Primary | `#E8590C` | primary buttons, active nav, focus rings, icon accents |
| Primary hover | `#C94A05` | hover / pressed |
| Soft background | `#FFF4ED` | secondary button fill, selected chips, badge backgrounds |
| Soft border | `#FFD9BF` | borders on soft-filled elements |
| Ink | `#1B1F24` | primary text |
| Muted | `#6B7280` | secondary text, section labels |
| Border | `#E5E7EB` | card and divider borders |
| Surface | `#FFFFFF` | cards, panel background |
| Canvas | `#F9FAFB` | page background behind cards |
| Success | `#15803D` | success badges and status |
| Danger | `#B91C1C` | errors, destructive actions |

Icons are inline SVG only — no PNG, no emoji, no icon-font or CDN dependency.
The panel carries a small inline `<symbol>` sprite inside its shadow root; the
dashboard uses a React icon module. Both ship as source, keeping the extension
lightweight.
