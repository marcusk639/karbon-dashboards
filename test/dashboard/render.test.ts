import { describe, expect, it } from "vitest";
import type { FilledDashboard } from "../../src/dashboard/fill.js";
import { renderPdf } from "../../src/dashboard/render.js";

const base = (over: Partial<FilledDashboard> = {}): FilledDashboard => ({
  title: "Open work",
  subtitle: "Weekly",
  asOf: "Queried from Karbon's warehouse 2026-11-02 08:00 CT",
  tiles: [
    { label: "Open jobs", value: "120", change: "+4 vs last week" },
    { label: "Past due", value: "12 (10%)", change: null },
  ],
  charts: [{ title: "Jobs by status", bars: [{ label: "Planned", value: 40 }, { label: "In progress", value: 80 }] }],
  tables: [{ title: "By work type", header: ["Work type", "Jobs"], rows: [["Tax", "10"]] }],
  notes: ["A note."],
  footnotes: ["A footnote."],
  ...over,
});

// pdfkit writes each page as its own indirect object (no object streams), so only
// content streams are compressed; the "/Type /Page" dictionaries stay readable.
const countPages = (b: Buffer) => (b.toString("latin1").match(/\/Type \/Page(?![s\w])/g) ?? []).length;

describe("renderPdf", () => {
  it("starts with %PDF", async () => {
    const pdf = await renderPdf(base());
    expect(pdf.subarray(0, 4).toString("latin1")).toBe("%PDF");
    expect(countPages(pdf)).toBe(1);
  });

  it("continues a 60-row table onto more pages and stays under the upload limit", async () => {
    const rows = Array.from({ length: 60 }, (_, i) => [`Type ${i}`, String(i)]);
    const pdf = await renderPdf(base({ tables: [{ title: "Long", header: ["Work type", "Jobs"], rows }] }));
    expect(countPages(pdf)).toBeGreaterThan(1);
    expect(pdf.length).toBeLessThan(1_048_576);
  });

  it("contains no link annotations", async () => {
    const pdf = await renderPdf(base({ notes: ["see https://example.com/x"] }));
    expect(pdf.toString("latin1")).not.toContain("/URI");
  });

  it("handles empty sections and zero values", async () => {
    const pdf = await renderPdf(base({ tiles: [], charts: [{ title: "Empty", bars: [] }], tables: [{ title: "T", header: ["A"], rows: [] }], notes: [], footnotes: [] }));
    expect(pdf.subarray(0, 4).toString("latin1")).toBe("%PDF");
  });

  it("stamps SYNTHETIC into the document title when a banner is set", async () => {
    const pdf = await renderPdf(base({ banner: "SYNTHETIC DATA — not from Karbon" }));
    expect(pdf.toString("latin1")).toContain("(SYNTHETIC DATA - Open work)");
    const live = await renderPdf(base());
    expect(live.toString("latin1")).not.toContain("SYNTHETIC");
  });
});
