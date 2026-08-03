import PDFDocument from "pdfkit";
import { splitBoldSegments } from "./inlineMarkdown.js";
import { resumeTemplateHintsEnabled } from "./resumeHints.js";

type PdfDoc = InstanceType<typeof PDFDocument>;

function stripMdFence(s: string): string {
  let t = s.trim();
  if (t.startsWith("```")) {
    t = t.replace(/^```[a-z]*\n?/i, "").replace(/\n?```\s*$/i, "");
  }
  return t.trim();
}

function resetBodyStyle(doc: PdfDoc, pageWidth: number) {
  void pageWidth;
  doc.fillColor("#000000").font("Helvetica").fontSize(10);
}

function emitTemplateHint(doc: PdfDoc, pageWidth: number, label: string) {
  doc.fillColor("#718096").font("Helvetica-Oblique").fontSize(7.5);
  doc.text(`Template · ${label}`, { width: pageWidth });
  resetBodyStyle(doc, pageWidth);
  doc.moveDown(0.12);
}

function writePdfLineWithBold(
  doc: PdfDoc,
  pageWidth: number,
  line: string,
  opts: { indent?: number; fillColor?: string; fontSize?: number }
): void {
  const indent = opts.indent ?? 0;
  const fontSize = opts.fontSize ?? 10;
  const fillColor = opts.fillColor ?? "#000000";
  doc.fillColor(fillColor);
  const segs = splitBoldSegments(line);
  if (segs.length === 1 && !segs[0].bold) {
    doc.font("Helvetica").fontSize(fontSize).text(segs[0].text, { width: pageWidth, indent });
    resetBodyStyle(doc, pageWidth);
    return;
  }
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    doc
      .font(seg.bold ? "Helvetica-Bold" : "Helvetica")
      .fontSize(fontSize)
      .text(seg.text, {
        width: pageWidth,
        indent: i === 0 ? indent : 0,
        continued: i < segs.length - 1,
      });
  }
  resetBodyStyle(doc, pageWidth);
}

type HeaderPhase = "none" | "need_title_or_contact" | "need_contact_after_headline";
type FenceKind = "grid-3" | "grid-2" | "lang-bars";

function fenceLinesToCells(rawLines: string[]): string[][] {
  const cells: string[][] = [];
  let cur: string[] = [];
  for (const raw of rawLines) {
    if (!raw.trim()) {
      if (cur.length) {
        cells.push(cur);
        cur = [];
      }
      continue;
    }
    cur.push(raw.trimEnd());
  }
  if (cur.length) cells.push(cur);
  return cells;
}

function emitFencePdf(
  doc: PdfDoc,
  pageWidth: number,
  kind: FenceKind,
  rawLines: string[]
): void {
  doc.moveDown(0.15);
  if (kind === "lang-bars") {
    for (const raw of rawLines) {
      if (!raw.trim()) continue;
      writePdfLineWithBold(doc, pageWidth, raw.trim(), { indent: 0, fontSize: 9.5 });
      doc.moveDown(0.08);
    }
    doc.moveDown(0.1);
    return;
  }
  const cells = fenceLinesToCells(rawLines);
  for (let i = 0; i < cells.length; i++) {
    doc.font("Helvetica-Bold").fontSize(8).fillColor("#666666").text(`— ${kind === "grid-3" ? "Column" : "Block"} ${i + 1} —`, {
      width: pageWidth,
    });
    resetBodyStyle(doc, pageWidth);
    doc.moveDown(0.06);
    for (const ln of cells[i]!) {
      const t = ln.trim();
      if (!t) continue;
      if (t.startsWith("- ") || t.startsWith("* ")) {
        writePdfLineWithBold(doc, pageWidth, `• ${t.slice(2).trim()}`, { indent: 14, fontSize: 10 });
      } else {
        writePdfLineWithBold(doc, pageWidth, t, { indent: 0, fontSize: 10 });
      }
      doc.moveDown(0.06);
    }
    doc.moveDown(0.12);
  }
  resetBodyStyle(doc, pageWidth);
}

/**
 * Minimal markdown → PDF: # ## ### bullets and paragraphs.
 * Matches HTML template: optional headline after `# Name`, then contact; optional `|` heuristic;
 * optional `### left | right` role rows; optional `:::grid-3` / `:::grid-2` / `:::lang-bars` fences.
 */
export function markdownToPdfBuffer(markdown: string): Promise<Buffer> {
  const text = stripMdFence(markdown);
  const lines = text.split(/\r?\n/);
  const hints = resumeTemplateHintsEnabled();

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "LETTER", margins: { top: 50, bottom: 50, left: 56, right: 56 } });
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const pageWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    let headerPhase: HeaderPhase = "none";
    let roleSplitActive = false;
    let fence: { kind: FenceKind; lines: string[] } | null = null;

    const closeRoleIndent = (): number => (roleSplitActive ? 18 : 12);
    const paraIndent = (): number => (roleSplitActive ? 14 : 0);

    const closeRoleSplit = () => {
      if (roleSplitActive) {
        doc.moveDown(0.15);
        roleSplitActive = false;
      }
    };

    const flushFence = () => {
      if (!fence) return;
      const f = fence;
      fence = null;
      emitFencePdf(doc, pageWidth, f.kind, f.lines);
    };

    for (const raw of lines) {
      const line = raw.trimEnd();
      const trimmed = line.trim();

      if (fence) {
        if (trimmed === ":::") {
          flushFence();
          continue;
        }
        fence.lines.push(raw);
        continue;
      }

      const fenceStart =
        trimmed === ":::grid-3" ? "grid-3" : trimmed === ":::grid-2" ? "grid-2" : trimmed === ":::lang-bars" ? "lang-bars" : null;
      if (fenceStart) {
        closeRoleSplit();
        headerPhase = "none";
        fence = { kind: fenceStart, lines: [] };
        continue;
      }

      if (!line.trim()) {
        doc.moveDown(0.3);
        continue;
      }
      if (line.startsWith("# ")) {
        closeRoleSplit();
        headerPhase = "none";
        doc.moveDown(0.45);
        doc.font("Helvetica-Bold").fillColor("#000000").fontSize(20).text(line.slice(2).trim(), { width: pageWidth });
        doc.moveDown(0.12);
        headerPhase = "need_title_or_contact";
        resetBodyStyle(doc, pageWidth);
        continue;
      }
      if (line.startsWith("## ")) {
        closeRoleSplit();
        headerPhase = "none";
        const title = line.slice(3).trim();
        doc.moveDown(0.4);
        doc.font("Helvetica-Bold").fontSize(11).fillColor("#1e3a5f");
        doc.text(title.toUpperCase(), { width: pageWidth, characterSpacing: 0.6 });
        doc.moveDown(0.08);
        resetBodyStyle(doc, pageWidth);
        if (hints) emitTemplateHint(doc, pageWidth, `Section: ${title}`);
        continue;
      }
      if (line.startsWith("### ")) {
        headerPhase = "none";
        const rest = line.slice(4).trim();
        const pipe = rest.indexOf(" | ");
        if (pipe !== -1) {
          const left = rest.slice(0, pipe).trim();
          const right = rest.slice(pipe + 3).trim();
          if (left && right) {
            closeRoleSplit();
            doc.moveDown(0.2);
            doc.font("Helvetica-Bold").fontSize(9).fillColor("#333333").text(left.toUpperCase(), { width: pageWidth });
            doc.moveDown(0.06);
            doc.font("Helvetica-Bold").fontSize(10.5).fillColor("#000000").text(right.toUpperCase(), { width: pageWidth });
            doc.moveDown(0.12);
            resetBodyStyle(doc, pageWidth);
            if (hints) emitTemplateHint(doc, pageWidth, `Role block: ${left} | ${right}`);
            roleSplitActive = true;
            continue;
          }
        }
        closeRoleSplit();
        doc.moveDown(0.22);
        doc.font("Helvetica-Bold").fontSize(10.5).fillColor("#000000").text(rest, { width: pageWidth });
        doc.moveDown(0.1);
        resetBodyStyle(doc, pageWidth);
        if (hints) emitTemplateHint(doc, pageWidth, `Role block: ${rest}`);
        continue;
      }
      if (headerPhase === "need_title_or_contact") {
        if (line.startsWith("- ") || line.startsWith("* ")) {
          headerPhase = "none";
          const bullet = line.slice(2).trim();
          writePdfLineWithBold(doc, pageWidth, `• ${bullet}`, { indent: closeRoleIndent() });
          continue;
        }
        if (line.includes("|")) {
          writePdfLineWithBold(doc, pageWidth, line.trim(), { indent: 0, fillColor: "#4a5568", fontSize: 9.25 });
          headerPhase = "none";
          doc.moveDown(0.2);
          continue;
        }
        doc.font("Helvetica-Bold").fillColor("#1e3a5f").fontSize(10.5);
        doc.text(line.trim().toUpperCase(), { width: pageWidth, characterSpacing: 0.6 });
        doc.moveDown(0.08);
        resetBodyStyle(doc, pageWidth);
        headerPhase = "need_contact_after_headline";
        continue;
      }
      if (headerPhase === "need_contact_after_headline") {
        if (line.startsWith("- ") || line.startsWith("* ")) {
          headerPhase = "none";
          const bullet = line.slice(2).trim();
          writePdfLineWithBold(doc, pageWidth, `• ${bullet}`, { indent: closeRoleIndent() });
          continue;
        }
        writePdfLineWithBold(doc, pageWidth, line.trim(), { indent: 0, fillColor: "#4a5568", fontSize: 9.25 });
        headerPhase = "none";
        doc.moveDown(0.2);
        continue;
      }
      if (line.startsWith("- ") || line.startsWith("* ")) {
        const bullet = line.slice(2).trim();
        doc.fillColor("#000000");
        writePdfLineWithBold(doc, pageWidth, `• ${bullet}`, { indent: closeRoleIndent() });
        continue;
      }
      doc.fillColor("#000000");
      writePdfLineWithBold(doc, pageWidth, line.trim(), { indent: paraIndent() });
    }

    closeRoleSplit();
    if (fence) flushFence();

    doc.end();
  });
}
