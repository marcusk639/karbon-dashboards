import { expect, test } from "vitest";
import { checkLayout } from "../../src/dashboard/layout.js";
import { LAYOUT, REQS, cat, d, names } from "./fixtures.js";

const withNote = (n: string) => ({ ...LAYOUT, notes: [n] });
const tileOn = (request: string, measure: string) => ({
  ...LAYOUT,
  tiles: [{ label: "X", request, measure, showChange: false }],
});

test("a valid layout passes", async () => {
  const r = await checkLayout(LAYOUT, REQS, d);
  expect(r).toMatchObject({ ok: true });
});
test("layout with a URL is refused", async () =>
  expect(await checkLayout(withNote("see https://x.y"), REQS, d)).toMatchObject({
    ok: false,
    code: "pattern_match",
  }));
test("layout naming a made-up client is refused, detail names the field only", async () => {
  const r = await checkLayout(withNote("Avery Lee is late"), REQS, d);
  expect(r).toMatchObject({ ok: false, code: "client_name", detail: "notes[0]" });
  expect(JSON.stringify(r)).not.toContain("Avery");
});
test("layout ref to a measure not in its request is invalid", async () =>
  expect(await checkLayout(tileOn("by_status", "budget_hrs"), REQS, d)).toMatchObject({
    code: "invalid_layout",
  }));
test("unknown request is invalid", async () =>
  expect(await checkLayout(tileOn("nope", "jobs"), REQS, d)).toMatchObject({ code: "invalid_layout" }));
test("shareOf, chart dimension and column/sort fields must be in the request", async () => {
  const bad = [
    { ...LAYOUT, tiles: [{ label: "X", request: "totals", measure: "jobs", shareOf: "nope", showChange: false }] },
    { ...LAYOUT, charts: [{ title: "C", request: "by_type", dimension: "stage", measure: "jobs" }] },
    { ...LAYOUT, tables: [{ title: "T", request: "by_type", columns: [{ field: "past_due", label: "P" }] }] },
    {
      ...LAYOUT,
      tables: [{ title: "T", request: "by_type", columns: [{ field: "jobs", label: "J" }], sortBy: { field: "stage", dir: "asc" } }],
    },
  ];
  for (const b of bad) expect(await checkLayout(b, REQS, d)).toMatchObject({ code: "invalid_layout" });
});
test("a referenced request that fails the menu is invalid", async () => {
  const reqs = { ...REQS, totals: { measures: ["not_a_measure"] } };
  expect(await checkLayout(LAYOUT, reqs, d)).toMatchObject({ code: "invalid_layout" });
});
test("empty or over-long text and extra keys are invalid", async () => {
  expect(await checkLayout({ ...LAYOUT, title: "" }, REQS, d)).toMatchObject({ code: "invalid_layout" });
  expect(await checkLayout(withNote("x".repeat(201)), REQS, d)).toMatchObject({ code: "invalid_layout" });
  expect(await checkLayout({ ...LAYOUT, sql: "select 1" }, REQS, d)).toMatchObject({ code: "invalid_layout" });
  expect(await checkLayout("nope", REQS, d)).toMatchObject({ code: "invalid_layout" });
});
test("a client name in a tile label or column label is caught with its path", async () => {
  const t = { ...LAYOUT, tiles: [{ label: "Jordan Quill", request: "totals", measure: "jobs", showChange: false }] };
  expect(await checkLayout(t, REQS, d)).toMatchObject({ code: "client_name", detail: "tiles[0].label" });
  const c = {
    ...LAYOUT,
    tables: [{ title: "T", request: "by_type", columns: [{ field: "jobs", label: "Avery" }] }],
  };
  expect(await checkLayout(c, REQS, d)).toMatchObject({ code: "client_name", detail: "tables[0].columns[0].label" });
});
void cat; void names;

test("a checker returning NaN fails closed (never passes the layout)", async () => {
  const nan = { countMatches: async (t: string[]) => t.map(() => NaN) };
  const r = await checkLayout(LAYOUT, REQS, { ...d, names: nan }).catch((e) => e);
  expect(r).not.toMatchObject({ ok: true });
});
test("a checker returning a negative count fails closed", async () => {
  const neg = { countMatches: async (t: string[]) => t.map(() => -1) };
  const r = await checkLayout(LAYOUT, REQS, { ...d, names: neg }).catch((e) => e);
  expect(r).not.toMatchObject({ ok: true });
});
