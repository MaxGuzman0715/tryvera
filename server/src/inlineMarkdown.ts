/** Shared `**bold**` handling for HTML (Chromium) and PDFKit paths. */

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * One line of body text: `**emphasis**` → `<strong>` (balanced pairs only).
 * Unbalanced `**` falls back to escaped plain text with asterisks stripped.
 */
export function htmlLineWithInlineBold(markdownLine: string): string {
  const parts = markdownLine.split(/\*\*/);
  if (parts.length % 2 === 0) {
    return escapeHtml(markdownLine.replace(/\*\*/g, ""));
  }
  return parts
    .map((t, i) => {
      if (t === "") return "";
      const esc = escapeHtml(t);
      return i % 2 === 1 ? `<strong>${esc}</strong>` : esc;
    })
    .join("");
}

export type BoldSegment = { text: string; bold: boolean };

/** Segments for PDFKit (Helvetica vs Helvetica-Bold). Unbalanced ** → single plain segment. */
export function splitBoldSegments(line: string): BoldSegment[] {
  const parts = line.split(/\*\*/);
  if (parts.length % 2 === 0) {
    return [{ text: line.replace(/\*\*/g, ""), bold: false }];
  }
  const out: BoldSegment[] = [];
  for (let i = 0; i < parts.length; i++) {
    if (parts[i] === "") continue;
    out.push({ text: parts[i], bold: i % 2 === 1 });
  }
  return out.length ? out : [{ text: line.replace(/\*\*/g, ""), bold: false }];
}
