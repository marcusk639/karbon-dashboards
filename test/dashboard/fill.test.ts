import { expect, test } from "vitest";
import { checkFilled, fillLayout } from "../../src/dashboard/fill.js";
import { EMPTY_RESULTS, LAYOUT, PREV_2026_10_12, RESULTS, cat, names } from "./fixtures.js";

const AT = new Date("2026-10-19T13:02:00Z");

test("fill: share, change and as-of copy", () => {
  const f = fillLayout(LAYOUT, RESULTS, PREV_2026_10_12, AT, cat);
  expect(f.asOf).toBe("Queried from Karbon's warehouse 2026-10-19 08:02 CT");
  expect(f.tiles[1]).toEqual({ label: "Past due", value: "95 (40%)", change: "+3 since 2026-10-12" });
  expect(f.tiles[0]).toEqual({ label: "Open jobs", value: "238", change: "-2 since 2026-10-12" });
  expect(f.tiles[2]).toEqual({ label: "Budget hours", value: "1,234.6", change: null });
});
test("fill: no change, and previous lacking the request gives null", () => {
  const prev = { periodKey: "2026-10-12", totals: { totals: { columns: ["jobs"], rows: [[238]] } } };
  const f = fillLayout(LAYOUT, RESULTS, prev, AT, cat);
  expect(f.tiles[0]!.change).toBe("No change since 2026-10-12");
  expect(f.tiles[1]!.change).toBeNull();
});
test("fill: zero rows still fills", () => {
  const f = fillLayout(LAYOUT, EMPTY_RESULTS, null, new Date(), cat);
  expect(f.tables[0]!.rows).toEqual([]);
  expect(f.tiles[0]!.value).toBe("0");
  expect(f.tiles[2]!.value).toBe("0.0");
  expect(f.tiles[0]!.change).toBe("No earlier run to compare");
  expect(f.charts[0]!.bars).toEqual([]);
  expect(f.tiles[1]!.value).toBe("0");
});
test("fill: share guards divide by zero", () => {
  const r = { ...RESULTS, totals: { columns: ["jobs", "past_due", "budget_hrs"], rows: [[0, 0, 0]] } };
  expect(fillLayout(LAYOUT, r, null, AT, cat).tiles[1]!.value).toBe("0");
});
test("fill: tables sort, format, dash nulls; charts carry bars", () => {
  const f = fillLayout(LAYOUT, RESULTS, null, AT, cat);
  expect(f.tables[0]).toEqual({
    title: "By work type",
    header: ["Work type", "Jobs"],
    rows: [["Bookkeeping", "3,000"], ["Tax", "1,200"], ["Other (unreviewed)", "—"]],
  });
  expect(f.charts[0]!.bars).toEqual([
    { label: "In Progress", value: 200 },
    { label: "Other (unreviewed)", value: 38 },
  ]);
});
test("fill: footnotes", () => {
  const f = fillLayout(LAYOUT, RESULTS, PREV_2026_10_12, AT, cat);
  expect(f.footnotes).toEqual([
    cat.measures.jobs!.meaning,
    cat.measures.past_due!.meaning,
    cat.measures.budget_hrs!.meaning,
    '38 jobs had a label not yet reviewed and are shown as "Other (unreviewed)".',
    "Compared with the run of 2026-10-12.",
  ]);
  const g = fillLayout(LAYOUT, EMPTY_RESULTS, null, AT, cat);
  expect(g.footnotes.some((x) => x.includes("not yet reviewed"))).toBe(false);
  expect(g.footnotes.some((x) => x.startsWith("Compared"))).toBe(false);
});

const filled = () => fillLayout(LAYOUT, RESULTS, PREV_2026_10_12, AT, cat);
test("checkFilled passes a normal dashboard", async () =>
  expect(await checkFilled(filled(), new Set(["Other (unreviewed)"]), { names })).toEqual({ ok: true }));
test("checkFilled catches a pattern in any string, naming the location", async () => {
  const f = filled();
  f.tables[0]!.rows[0]![0] = "a@b.co";
  expect(await checkFilled(f, new Set(), { names })).toEqual({
    ok: false,
    code: "pattern_match",
    detail: "tables[0].rows[0][0]",
  });
});
test("checkFilled catches a client name in a non-exempt cell but not in footnotes/exempt", async () => {
  const f = filled();
  f.tables[0]!.rows[1]![0] = "Avery Lee";
  const r = await checkFilled(f, new Set(), { names });
  expect(r).toEqual({ ok: false, code: "client_name", detail: "tables[0].rows[1][0]" });
  expect(await checkFilled(f, new Set(["Avery Lee"]), { names })).toEqual({ ok: true });
  const g = filled();
  g.footnotes.push("Avery Lee");
  expect(await checkFilled(g, new Set(), { names })).toEqual({ ok: true });
});

test("checkFilled fails closed when the checker returns NaN", async () => {
  const nan = { countMatches: async (t: string[]) => t.map(() => NaN) };
  const r = await checkFilled(filled(), new Set(), { names: nan }).catch((e) => e);
  expect(r).not.toEqual({ ok: true });
});

// I4: synthetic output must never pass for live.
test("fill in synthetic mode stamps the banner and the as-of line", () => {
  const f = fillLayout(LAYOUT, RESULTS, null, new Date("2026-10-19T13:02:00Z"), cat, { synthetic: true });
  expect(f.banner).toBe("SYNTHETIC DATA — not from Karbon");
  expect(f.asOf).toBe("SYNTHETIC DATA — not from Karbon (generated 2026-10-19 08:02 CT)");
  expect(f.asOf).not.toContain("Queried from Karbon's warehouse");
});
test("fill in live mode has no banner", () => {
  const f = fillLayout(LAYOUT, RESULTS, null, new Date("2026-10-19T13:02:00Z"), cat);
  expect(f.banner).toBeUndefined();
});

// m7: a measure that came back null shows "—", never a fabricated 0; no rows at all still shows "0".
test("fill: a null measure in a returned row shows a dash, with no change and no share", () => {
  const r = { ...RESULTS, totals: { columns: ["jobs", "past_due", "budget_hrs"], rows: [[238, null, null]] } };
  const f = fillLayout(LAYOUT, r, PREV_2026_10_12, AT, cat);
  expect(f.tiles[1]).toMatchObject({ value: "—", change: null });
  expect(f.tiles[2]!.value).toBe("—");
  expect(f.tiles[0]!.value).toBe("238");
});

// m8: the unreviewed footnote is singular for one job.
test("fill: unreviewed footnote is singular for one job", () => {
  const r = {
    ...RESULTS,
    by_status: { columns: ["primary_status", "jobs", "past_due"], rows: [["In Progress", 200, 80], ["Other (unreviewed)", 1, 0]] },
    by_type: { columns: ["work_type", "jobs"], rows: [["Tax", 1200]] },
  };
  const f = fillLayout(LAYOUT, r, null, AT, cat);
  expect(f.footnotes).toContain('1 job had a label not yet reviewed and is shown as "Other (unreviewed)".');
});
