import PDFDocument from "pdfkit";
import type { FilledDashboard } from "./fill.js";

const M = 40; // page margin, points
const W = 792 - 2 * M; // content width, US Letter landscape
const BOTTOM = 612 - M;
const INK = "#1a1a1a";
const GREY = "#666666";
const RULE = "#d9d9d9";
const BAR = "#5b7a99";
const REGULAR = "Helvetica";
const BOLD = "Helvetica-Bold";

const NUMERIC = /^[-+−]?[\d,]*\.?\d+%?(\s*\(\d+%\))?$|^—$/;

/**
 * Render an already-checked dashboard to a PDF (US Letter landscape, built-in Helvetica,
 * no images, no links). Tables continue onto new pages with the header repeated; a chart
 * with more bars than fit continues on the next page under "(continued)".
 */
export function renderPdf(f: FilledDashboard): Promise<Buffer> {
  const doc = new PDFDocument({
    size: "LETTER",
    layout: "landscape",
    margin: M,
    compress: true,
    info: { Title: f.title },
  });
  const chunks: Buffer[] = [];
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });

  const text = (s: string, x: number, y: number, size: number, font: string, color: string, width: number, align: "left" | "right" = "left") =>
    doc.font(font).fontSize(size).fillColor(color).text(s, x, y, { width, align });
  const height = (s: string, size: number, font: string, width: number) =>
    doc.font(font).fontSize(size).heightOfString(s, { width });
  /** Start a new page unless `h` more points fit. Returns true when a page was added. */
  const ensure = (h: number): boolean => {
    if (doc.y + h <= BOTTOM) return false;
    doc.addPage();
    doc.y = M;
    return true;
  };
  const gap = (h: number) => {
    doc.y += h;
  };
  const heading = (s: string) => {
    ensure(40);
    text(s, M, doc.y, 13, BOLD, INK, W);
    gap(6);
  };

  // Title block
  text(f.title, M, M, 22, BOLD, INK, W);
  if (f.subtitle) text(f.subtitle, M, doc.y + 2, 12, REGULAR, INK, W);
  text(f.asOf, M, doc.y + 2, 10, REGULAR, GREY, W);
  gap(14);

  // Tiles: one row of boxed cards
  if (f.tiles.length > 0) {
    const g = 10;
    const w = (W - g * (f.tiles.length - 1)) / f.tiles.length;
    const h = 78;
    ensure(h);
    const y = doc.y;
    f.tiles.forEach((t, i) => {
      const x = M + i * (w + g);
      doc.lineWidth(0.75).strokeColor(RULE).roundedRect(x, y, w, h, 4).stroke();
      text(t.value, x + 10, y + 10, 24, BOLD, INK, w - 20);
      text(t.label, x + 10, y + 42, 10, REGULAR, INK, w - 20);
      if (t.change !== null) text(t.change, x + 10, y + 58, 9, REGULAR, GREY, w - 20);
    });
    doc.y = y + h;
    gap(18);
  }

  // Bar charts: rectangles, one neutral colour, value labels at the bar ends
  for (const c of f.charts) {
    const rowH = 20;
    const labelW = 170;
    const valW = 60;
    const plotW = W - labelW - valW - 10;
    const max = Math.max(1, ...c.bars.map((b) => b.value));
    heading(c.title);
    for (const b of c.bars) {
      if (ensure(rowH)) heading(`${c.title} (continued)`);
      const y = doc.y;
      text(b.label, M, y + 3, 10, REGULAR, INK, labelW - 8);
      const bw = Math.max(b.value > 0 ? 1 : 0, (Math.max(0, b.value) / max) * plotW);
      doc.fillColor(BAR).rect(M + labelW, y + 2, bw, rowH - 8).fill();
      text(new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 }).format(b.value), M + labelW + bw + 6, y + 3, 10, BOLD, INK, valW);
      doc.y = y + rowH;
    }
    gap(14);
  }

  // Tables: bold header repeated on each page, light row rules, numeric columns right-aligned
  for (const t of f.tables) {
    const n = t.header.length;
    if (n === 0) continue;
    const first = n === 1 ? W : Math.min(W * 0.4, W - (n - 1) * 70);
    const rest = n === 1 ? 0 : (W - first) / (n - 1);
    const colW = (i: number) => (i === 0 ? first : rest);
    const colX = (i: number) => M + (i === 0 ? 0 : first + (i - 1) * rest);
    const right = t.header.map((_, i) => i > 0 && t.rows.length > 0 && t.rows.every((r) => NUMERIC.test((r[i] ?? "").trim())));
    const pad = 4;
    const drawRow = (cells: string[], font: string, size: number) => {
      const h = Math.max(...t.header.map((_, i) => height(cells[i] ?? "", size, font, colW(i) - 2 * pad))) + 2 * pad;
      const y = doc.y;
      cells.forEach((cell, i) =>
        text(cell, colX(i) + pad, y + pad, size, font, INK, colW(i) - 2 * pad, right[i] ? "right" : "left"),
      );
      doc.lineWidth(0.5).strokeColor(RULE).moveTo(M, y + h).lineTo(M + W, y + h).stroke();
      doc.y = y + h;
    };
    const header = () => drawRow(t.header, BOLD, 10);
    const rowH = (r: string[]) =>
      Math.max(...t.header.map((_, i) => height(r[i] ?? "", 10, REGULAR, colW(i) - 2 * pad))) + 2 * pad;

    heading(t.title);
    ensure(60);
    header();
    for (const r of t.rows) {
      if (ensure(rowH(r))) {
        heading(`${t.title} (continued)`);
        header();
      }
      drawRow(r, REGULAR, 10);
    }
    gap(16);
  }

  // Notes and footnotes: small grey text
  for (const s of [...f.notes, ...f.footnotes]) {
    ensure(height(s, 9, REGULAR, W) + 4);
    text(s, M, doc.y, 9, REGULAR, GREY, W);
    gap(4);
  }

  doc.end();
  return done;
}
