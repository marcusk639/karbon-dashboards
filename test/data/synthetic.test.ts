import { expect, test } from "vitest";
import { loadCatalog, loadGenericWords, loadLabels } from "../../src/config.js";
import { createSyntheticSource } from "../../src/data/synthetic.js";
import { runMenuRequest, type GuardDeps } from "../../src/guard/run.js";
import { buildQuery, validateRequest } from "../../src/query/build.js";
import { OPEN_WORK_REQUESTS } from "../../src/requests/open-work.js";

const catalog = loadCatalog();
const labels = loadLabels();
const generic = loadGenericWords();
const built = (req: Parameters<typeof validateRequest>[0]) => {
  const r = validateRequest(req, catalog);
  return { r, q: buildQuery(r, catalog, labels) };
};

test.each(Object.entries(OPEN_WORK_REQUESTS))("%s: columns equal BuiltQuery.columns", async (_n, req) => {
  const { r, q } = built(req);
  const out = await createSyntheticSource().data.run(q, r);
  expect(out.columns).toEqual(q.columns);
  expect(out.rows.every((row) => row.length === q.columns.length)).toBe(true);
});

test("no dimensions gives exactly one row", async () => {
  const { r, q } = built(OPEN_WORK_REQUESTS.totals);
  expect((await createSyntheticSource().data.run(q, r)).rows).toHaveLength(1);
});

test("by_stage has 3 to 9 rows", async () => {
  const { r, q } = built(OPEN_WORK_REQUESTS.by_stage);
  const n = (await createSyntheticSource().data.run(q, r)).rows.length;
  expect(n).toBeGreaterThanOrEqual(3);
  expect(n).toBeLessThanOrEqual(9);
});

test("same seed gives the same output; a different seed differs", async () => {
  const { r, q } = built(OPEN_WORK_REQUESTS.by_stage);
  const a = await createSyntheticSource(7).data.run(q, r);
  const b = await createSyntheticSource(7).data.run(q, r);
  const c = await createSyntheticSource(8).data.run(q, r);
  expect(a).toEqual(b);
  expect(a).not.toEqual(c);
});

test("work_type dimension uses made-up work types", async () => {
  const { r, q } = built({ measures: ["jobs"], dimensions: ["work_type"] });
  const out = await createSyntheticSource().data.run(q, r);
  expect(out.rows.map((x) => x[0])).toEqual(["Individual Return", "Bookkeeping"]);
});

test("measures: counts are integers, budget_hrs has one decimal", async () => {
  const { r, q } = built(OPEN_WORK_REQUESTS.totals);
  const row = (await createSyntheticSource().data.run(q, r)).rows[0]!;
  q.columns.forEach((c, i) => {
    const v = row[i] as number;
    if (c === "budget_hrs") expect(Math.round(v * 10)).toBeCloseTo(v * 10, 6);
    else expect(Number.isInteger(v)).toBe(true);
  });
});

test.each(Object.entries(OPEN_WORK_REQUESTS))("guard passes synthetic %s", async (_n, req) => {
  const { data, names } = createSyntheticSource();
  const deps: GuardDeps = {
    catalog, labels, generic, data, names,
    now: () => new Date("2026-10-16T15:00:00Z"),
    log: { log: () => {} },
  };
  const res = await runMenuRequest(req, deps);
  expect(res.status).toBe("ok");
});
