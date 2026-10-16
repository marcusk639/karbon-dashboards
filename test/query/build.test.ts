import { expect, test } from "vitest";
import { loadCatalog, loadLabels, type LabelOutcome } from "../../src/config.js";
import { buildQuery, RequestError, validateRequest } from "../../src/query/build.js";

const cat = loadCatalog();
const labels = loadLabels();
const emptyLabels = { primary_status: {}, stage: {}, work_type: {} };
const A = (outcome: LabelOutcome["outcome"], alias?: string): LabelOutcome => ({
  outcome,
  ...(alias ? { alias } : {}),
  date: "2026-10-16",
  reviewer: "Test Reviewer",
});

const OPEN_WORK = {
  measures: ["jobs", "past_due", "median_days_in_stage", "median_age_days", "stuck_over_30d", "budget_hrs"],
  dimensions: ["primary_status", "stage"],
  orderBy: [
    { field: "stuck_over_30d", dir: "desc" },
    { field: "jobs", dir: "desc" },
  ],
};
test("open work by stage carries every query D expression verbatim", () => {
  const q = buildQuery(validateRequest(OPEN_WORK, cat), cat, labels);
  for (const m of OPEN_WORK.measures) expect(q.sql).toContain(cat.measures[m].expr);
  expect(q.sql).toContain(cat.cohorts.active_work.where);
  expect(q.sql).toContain("FROM KPI_DATABASE.SECURE_VIEWS.WORK_ITEM_DETAILS");
  expect(q.sql).toContain('ORDER BY "stuck_over_30d" DESC, "jobs" DESC');
  expect(q.columns).toEqual(["primary_status", "stage", ...OPEN_WORK.measures]);
});
test("unknown measure or a client column is refused before any SQL", () => {
  expect(() => validateRequest({ measures: ["CLIENT"] }, cat)).toThrow(RequestError);
  expect(() =>
    validateRequest({ measures: ["jobs"], dimensions: ["WORK_TITLE"] }, cat),
  ).toThrow(/dimensions\[0\]/);
});
test("labels: approve, alias, other and unreviewed (incl. NULL) map in SQL", () => {
  const l = {
    ...labels,
    work_type: {
      "Tax Return": A("approve"),
      "Smithfield Trust": A("alias", "Trust: other"),
      Misc: A("other"),
    },
  };
  const q = buildQuery({ measures: ["jobs"], dimensions: ["work_type"] }, cat, l);
  expect(q.binds).toEqual(
    expect.arrayContaining(["Tax Return", "Smithfield Trust", "Trust: other", "Misc", "Other"]),
  );
  expect(q.sql).toMatch(/ELSE 'Other \(unreviewed\)' END/);
  expect(q.sql).toContain("COUNT(*) OVER (PARTITION BY");
  expect([...q.exemptStrings]).toEqual(
    expect.arrayContaining(["Tax Return", "Trust: other", "Other", "Other (unreviewed)"]),
  );
  expect([...q.exemptStrings]).not.toContain("Smithfield Trust");
});
test("no dimensions -> single aggregate row, no GROUP BY", () => {
  expect(buildQuery({ measures: ["jobs"] }, cat, labels).sql).not.toMatch(/GROUP BY/);
});
test("empty labels file -> literal unreviewed label", () => {
  expect(
    buildQuery({ measures: ["jobs"], dimensions: ["stage"] }, cat, emptyLabels).sql,
  ).toContain(`'Other (unreviewed)' AS "stage"`);
});
test("binds match placeholders in order, including the repeated minGroup window and date filter", () => {
  const l = { ...emptyLabels, work_type: { "Tax Return": A("approve"), Misc: A("other") } };
  const q = buildQuery(
    { measures: ["jobs"], dimensions: ["work_type"], filters: { due_between: { from: "2026-01-01", to: "2026-02-01" } } },
    cat,
    l,
  );
  expect((q.sql.match(/\?/g) ?? []).length).toBe(q.binds.length);
  expect(q.binds).toEqual([
    "Tax Return", "Tax Return", "Misc", "Other",
    "Tax Return", "Tax Return", "Misc", "Other",
    "2026-01-01", "2026-02-01",
  ]);
  expect(q.sql).toContain("AND DUE_DATETIME >= ? AND DUE_DATETIME < ?");
});
test("request validation pins limits and positions only", () => {
  expect(() => validateRequest({ measures: [] }, cat)).toThrow(RequestError);
  expect(() => validateRequest({ measures: ["jobs", "x; DROP"] }, cat)).toThrow(/measures\[1\] not in menu/);
  try {
    validateRequest({ measures: ["jobs", "x; DROP"] }, cat);
  } catch (e) {
    expect((e as RequestError).message).not.toContain("DROP");
    expect((e as RequestError).code).toBe("disallowed_request");
  }
  expect(() =>
    validateRequest({ measures: ["jobs"], dimensions: ["stage", "stage", "work_type", "primary_status"] }, cat),
  ).toThrow(RequestError);
  expect(() => validateRequest({ measures: ["constructor"] }, cat)).toThrow(/measures\[0\]/);
  expect(() =>
    validateRequest({ measures: ["jobs"], orderBy: [{ field: "stage", dir: "asc" }] }, cat),
  ).toThrow(/orderBy\[0\]/);
  expect(() =>
    validateRequest({ measures: ["jobs"], filters: { due_between: { from: "2026-02-01", to: "2026-01-01" } } }, cat),
  ).toThrow(RequestError);
  expect(() =>
    validateRequest({ measures: ["jobs"], filters: { due_between: { from: "2026-13-01", to: "2026-14-01" } } }, cat),
  ).toThrow(RequestError);
  expect(() => validateRequest({ measures: ["jobs"], sql: "select 1" }, cat)).toThrow(RequestError);
});
test("buildQuery re-validates: unvalidated input throws and yields no SQL", () => {
  expect(() =>
    buildQuery(
      { measures: ["jobs"], orderBy: [{ field: 'jobs" DESC; --', dir: "asc" }] },
      cat,
      labels,
    ),
  ).toThrow(RequestError);
  expect(() => buildQuery({ measures: ["constructor"] }, cat, labels)).toThrow(RequestError);
  expect(() =>
    buildQuery({ measures: ["jobs"], dimensions: ["WORK_TITLE"] }, cat, labels),
  ).toThrow(RequestError);
});
test("cohort is parenthesised before the date filter", () => {
  const q = buildQuery(
    { measures: ["jobs"], filters: { due_between: { from: "2026-01-01", to: "2026-02-01" } } },
    cat,
    labels,
  );
  expect(q.sql).toContain(`(${cat.cohorts.active_work.where}) AND DUE_DATETIME >= ?`);
});
