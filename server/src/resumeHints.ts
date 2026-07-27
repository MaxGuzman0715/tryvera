/** Set `ENPPLY_RESUME_TEMPLATE_HINTS=1` to show gray “Template · …” lines under ## / ### (layout debugging). Default: off so PDFs stay clean. */
export function resumeTemplateHintsEnabled(): boolean {
  return process.env.ENPPLY_RESUME_TEMPLATE_HINTS === "1";
}
