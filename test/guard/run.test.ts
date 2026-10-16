import { expect, test, vi } from "vitest";
import { loadCatalog, loadLabels, loadGenericWords } from "../../src/config.js";
import { buildQuery, validateRequest } from "../../src/query/build.js";
import { FixtureNameChecker } from "../../src/guard/names.js";
import { runMenuRequest, type GuardDeps } from "../../src/guard/run.js";
import type { ResultTable } from "../../src/data/types.js";

const catalog = loadCatalog();
const labels = loadLabels();
const generic = loadGenericWords();
const builtColumns = buildQuery(validateRequest({ measures: ["jobs"], dimensions: ["stage"] }, catalog), catalog, labels).columns;

function deps(o: { columns?: string[]; rows?: ResultTable["rows"]; err?: unknown }) {
  const events: unknown[] = [];
  const run = vi.fn(async () => {
    if (o.err) throw o.err;
    return { columns: o.columns ?? builtColumns, rows: o.rows ?? [] };
  });
  const d: GuardDeps = {
    catalog,
    labels,
    generic,
    data: { run },
    names: new FixtureNameChecker(["Avery Lee"], generic),
    now: () => new Date("2026-10-16T15:00:00Z"),
    log: { log: (e) => events.push(e) },
  };
  return Object.assign(d, { events, run });
}
const REQ = { measures: ["jobs"], dimensions: ["stage"] };

test("client name in a non-exempt cell rejects; Claude gets no value", async () => {
  const r = await runMenuRequest(REQ, deps({ rows: [["Avery Lee review", 3]] }));
  expect(r).toEqual({ status: "rejected", code: "client_name", detail: 'column "stage"' });
  expect(JSON.stringify(r)).not.toContain("Avery");
});

test("exempt label passes even if it shares a word with a client", async () => {
  const r = await runMenuRequest(REQ, deps({ rows: [["Other (unreviewed)", 4]] }));
  expect(r.status).toBe("ok");
  if (r.status === "ok") {
    expect(r.queriedAt).toBe("2026-10-16T15:00:00.000Z");
    expect(r.sql).toContain("SELECT");
  }
});

test("disallowed request never reaches the data source", async () => {
  const d = deps({ rows: [] });
  expect((await runMenuRequest({ measures: ["CLIENT"] }, d)).status).toBe("rejected");
  expect(d.run).not.toHaveBeenCalled();
  const r = await runMenuRequest({ measures: ["CLIENT"] }, d);
  expect(r).toMatchObject({ code: "disallowed_request" });
});

test("extra column from the source is rejected", async () => {
  expect(
    await runMenuRequest({ measures: ["jobs"] }, deps({ columns: ["jobs", "CLIENT"], rows: [[1, "x"]] })),
  ).toMatchObject({ code: "unexpected_column" });
});

test("pattern in a cell rejects without the value", async () => {
  const r = await runMenuRequest(REQ, deps({ rows: [["a.b@x.com", 1]] }));
  expect(r).toEqual({ status: "rejected", code: "pattern_match", detail: 'column "stage"' });
});

test("warehouse errors map to categories, never the message", async () => {
  const login = await runMenuRequest(REQ, deps({ err: Object.assign(new Error("secret SELECT x"), { code: "warehouse_login" }) }));
  expect(login).toMatchObject({ code: "warehouse_login" });
  const other = await runMenuRequest(REQ, deps({ err: new Error("bind 'Avery'") }));
  expect(other).toMatchObject({ code: "warehouse_error" });
  expect(JSON.stringify([login, other])).not.toMatch(/secret|Avery/);
});

test("one log event per call, without values", async () => {
  const d = deps({ rows: [["Avery Lee review", 3]] });
  await runMenuRequest(REQ, d);
  expect(d.events).toHaveLength(1);
  expect(d.events[0]).toMatchObject({ kind: "question", verdict: "rejected", code: "client_name" });
  expect(JSON.stringify(d.events)).not.toContain("Avery");
});

const REQ2 = { measures: ["jobs"], dimensions: ["stage"] };
test("over-wide row is rejected, extra cell never returned", async () => {
  const r = await runMenuRequest(REQ2, deps({ rows: [["ok", 1, "Avery Lee"]] }));
  expect(r).toMatchObject({ status: "rejected", code: "unexpected_column" });
  expect(JSON.stringify(r)).not.toContain("Avery");
});
test("short or non-finite name-checker counts fail closed", async () => {
  for (const counts of [[], [Number.NaN], ["0" as unknown as number], [undefined as unknown as number]]) {
    const d = deps({ rows: [["Review", 1]] });
    d.names = { countMatches: async () => counts };
    expect(await runMenuRequest(REQ2, d)).toMatchObject({ code: "warehouse_error", detail: "name check failed" });
  }
});
test("name-checker throw is warehouse_error", async () => {
  const d = deps({ rows: [["Review", 1]] });
  d.names = { countMatches: async () => { throw new Error("Avery"); } };
  const r = await runMenuRequest(REQ2, d);
  expect(r).toMatchObject({ code: "warehouse_error" });
  expect(JSON.stringify(r)).not.toContain("Avery");
});
test("non-primitive cells are rejected", async () => {
  for (const cell of [{ a: 1 }, new Date(), Number.NaN]) {
    const r = await runMenuRequest(REQ2, deps({ rows: [["Review", cell as never]] }));
    expect(r).toMatchObject({ code: "unexpected_column", detail: "unexpected cell type" });
  }
});
test("columns must match in order and position", async () => {
  expect(await runMenuRequest(REQ2, deps({ columns: ["jobs", "jobs"], rows: [] }))).toMatchObject({ code: "unexpected_column" });
  expect(await runMenuRequest(REQ2, deps({ columns: ["jobs", "stage"], rows: [] }))).toMatchObject({ code: "unexpected_column" });
});
test("null cell passes", async () => {
  expect((await runMenuRequest(REQ2, deps({ rows: [[null, 1]] }))).status).toBe("ok");
});
