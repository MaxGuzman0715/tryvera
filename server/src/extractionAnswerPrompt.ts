/**
 * Renderer for the versioned `extraction` prompt.
 *
 * The extraction prompt lives in the prompt store (`extraction/<variant>.txt`) so it
 * is editable + versionable in the Config UI like every other prompt. The four runtime
 * modes (no-answers / explicit / fit-only / explicit+fit) are expressed inside that single
 * template via conditional sections, rendered here against two booleans:
 *
 *   {{#flag}} … {{/flag}}   keep the body only when `flag` is true (else drop the block)
 *
 * Available flags:
 *   answers       — any answers wanted (explicit || fit)
 *   explicitOnly  — explicit answers only
 *   explicitFit   — explicit answers AND the "good fit" answer
 *   fitOnly       — the "good fit" answer only
 *   excludeNonAi  — list of non-AI form fields to skip (whenever explicit answers are wanted)
 */

type TemplateFlags = Record<string, boolean>;

/** Consumes the newline right after the open tag and right before the close tag so removed blocks leave no stray blank lines. */
const BLOCK_RE = /[ \t]*\{\{#(\w+)\}\}[ \t]*\r?\n?([\s\S]*?)\r?\n?[ \t]*\{\{\/\1\}\}[ \t]*/;

function renderTemplate(template: string, flags: TemplateFlags): string {
  let out = template;
  // Iterate so nested blocks resolve once their parent is kept.
  for (let guard = 0; guard < 50 && BLOCK_RE.test(out); guard++) {
    out = out.replace(new RegExp(BLOCK_RE, "g"), (_m, name: string, body: string) =>
      flags[name] ? body : ""
    );
  }
  return out.replace(/\n{3,}/g, "\n\n").trim();
}

/** Render the active extraction template for the requested answer mode. */
export function getExtractionAnswerPrompt(
  template: string,
  wantExplicitAnswers: boolean,
  wantFitAnswer: boolean
): string {
  const flags: TemplateFlags = {
    answers: wantExplicitAnswers || wantFitAnswer,
    explicitOnly: wantExplicitAnswers && !wantFitAnswer,
    explicitFit: wantExplicitAnswers && wantFitAnswer,
    fitOnly: wantFitAnswer && !wantExplicitAnswers,
    excludeNonAi: wantExplicitAnswers,
  };
  return renderTemplate(template, flags);
}
