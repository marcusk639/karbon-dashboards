# Guarded Karbon Dashboards Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Node.js service on Railway that answers client-free questions about TWK's Karbon
work through a guarded MCP layer, and every Monday at 8:00 Central produces a checked
open-work-by-stage PDF that a scheduled Claude courier uploads to OneDrive.

**Architecture:** A core module (TypeScript, one process) owns the catalog, SQL generation,
the Snowflake connection, every check, the scheduler, the PDF renderer and a SQLite state
store. A thin MCP layer depends only on the core's `CoreApi` interface and is the only
public entry point (Streamable HTTP plus a bearer secret). Totals are computed in Snowflake.
Labels are relabelled in Snowflake, and the client-name check runs in Snowflake, so no
client row or client name ever leaves the warehouse.

**Tech Stack:** Node 22, TypeScript (ESM), vitest, `@modelcontextprotocol/sdk`,
`snowflake-sdk`, `zod`, `luxon`, `better-sqlite3`, `pdfkit`, `express`. Railway (one
service, one volume).

**Spec:** `docs/specs/2026-10-16-guarded-karbon-dashboards-design.md`
(approved 2026-10-16). Section references (§) below point there.

## Global Constraints

- This is a standalone repo, `~/dev/karbon-dashboards` (moved out of cpa-consulting on 2026-10-16). Run all commands from its root. Paths to cpa-consulting reference material are given as `~/dev/cpa-consulting/…`.
- Work on branch `feat/initial-build`, created from `main` (which holds only the spec and
  plan). Stage files by name. Nothing is pushed to any remote without Marcus's say-so.
- **Before every commit:** `git diff --cached` must contain no client names, no `eyJ…​.eyJ…`
  two-segment JWT, no PEM `BEGIN` line and no `password=`. Tests use **made-up** names only.
  Never copy anything from `~/dev/cpa-consulting/twk/exports/` into this project.
- Snowflake connection: account `rva82772.east-us-2.azure`, warehouse `READ_WH`, role
  `PUBLIC`, database `KPI_DATABASE`, schema `SECURE_VIEWS`, username and password auth only
  (PATs fail with `390432`).
- Secrets come only from environment variables: `KARBON_SF_USER`, `KARBON_SF_PASSWORD`,
  `MCP_BEARER_TOKEN`, `ALERT_WEBHOOK_URL`. On the Mac they come from the Keychain via
  `scripts/dev-env.sh`; on Railway from Railway variables. Never in a file, log or image.
- Other config env: `DATA_MODE` (`live` | `synthetic`, default `synthetic`), ~~`STATE_DB_PATH`
  (default `./state/karbon-dashboards.sqlite`; `/data/state.sqlite` on Railway)~~ **Superseded 2026-10-16: Neon via `DATABASE_URL`, see docs/deploy.md.** `PORT`
  (default `8787`).
- Claude never supplies SQL. No code path selects individual rows. Every query has the
  `active_work` cohort.
- Measure, dimension and cohort expressions are **verbatim** from query D (§4.1); never
  reformat them.
- Fixed copy: data-as-of line `Queried from Karbon's warehouse <YYYY-MM-DD HH:mm> CT`;
  unreviewed label `Other (unreviewed)`; small-group label `Other`; notice body first line
  `No dashboard this week. The run was <outcome>. Marcus has been notified.`
- Monday schedule: weekday 1, `08:00`, `America/Chicago`. Undelivered alert after 30
  minutes. Min group size 3 (work_type). Upload limit 1,048,576 bytes per file.
- Logs carry only whitelisted fields (Task 3); never cell values, client names or secrets.
- Railway runs **exactly one replica** (exactly-once scheduling depends on it).

## Review Focus

1. **A label column comes back NULL** (blank `WORK_TYPE`): it must map to `Other (unreviewed)`, never `null` or a crash. Test in Task 2.
2. **The cohort or filter yields zero rows:** the run still produces a PDF with zeros and an empty table, not a failure notice. Test in Task 6.
3. **The week daylight saving ends** (Mon 2026-11-02): the run fires at 08:00 Central = 14:00Z, not 13:00Z. Test in Task 8.
4. **Snowflake refuses login or hangs** (MFA switched on, network): the run ends within the timeout as a `NOT PRODUCED` notice plus an alert, never a hang or a silent gap. Test in Task 9.
5. **A stage table too long for one page:** the PDF continues onto a second page and stays under 1,048,576 bytes. Test in Task 7.

---

## File Structure

```
~/dev/karbon-dashboards/
  package.json  tsconfig.json  vitest.config.ts  .gitignore  .railwayignore  railway.json
  config/catalog.json          menu: cohort, measures, dimensions, filters (tracked)
  config/labels.json           reviewed label outcomes, approved strings only (tracked)
  config/generic-words.json    words the name check ignores, Marcus-approved (tracked)
  scripts/dev-env.sh           loads Keychain secrets into env on the Mac
  src/config.ts                zod schemas + loaders for the three config files
  src/query/build.ts           MenuRequest validation and SQL generation
  src/data/types.ts            DataSource, ResultTable, BuiltQuery
  src/data/snowflake.ts        live DataSource + SnowflakeNameChecker
  src/data/synthetic.ts        synthetic DataSource
  src/guard/patterns.ts        email/phone/SSN/EIN/opaque-id/URL detection
  src/guard/names.ts           NameChecker interface, name-check SQL, FixtureNameChecker
  src/guard/run.ts             runMenuRequest: the guarded path for every question
  src/log.ts                   whitelisted structured logger
  src/dashboard/layout.ts      Layout schema + checkLayout
  src/dashboard/fill.ts        fillLayout + checkFilled
  src/dashboard/render.ts      renderPdf (pdfkit)
  src/store/db.ts              SQLite store
  src/schedule/due.ts          due-occurrence maths (luxon)
  src/schedule/run.ts          executeScheduledRun
  src/schedule/ticker.ts       minute tick, catch-up, undelivered alerts
  src/alert.ts                 Alerter (webhook + console)
  src/core/api.ts              CoreApi interface + createCore
  src/mcp/tools.ts             MCP tools over CoreApi (no other imports from src/)
  src/http.ts                  express app: bearer auth, rate limit, MCP transport
  src/server.ts                entry point
  src/cli/reconcile.ts         live reconciliation printout (no Claude)
  test/…                       mirrors src/
  docs/label-review.md  docs/courier-prompt.md  docs/deploy.md  docs/courier-verification.md
```

---

### Task 1: Scaffold and config loading

**Files:**

- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`, `config/catalog.json`, `config/labels.json`, `config/generic-words.json`, `src/config.ts`
- Test: `test/config.test.ts`

**Interfaces:**

- Produces:
  - `type Format = 'int' | 'pct' | 'hours'`
  - `type Catalog = { source: string; cohorts: Record<string, { where: string; meaning: string }>; measures: Record<string, { expr: string; meaning: string; format: Format }>; dimensions: Record<string, { expr: string; labels: 'primary_status' | 'stage' | 'work_type'; minGroup: number | null; meaning: string }>; filters: { due_between: { column: 'DUE_DATETIME' } } }`
  - `type LabelOutcome = { outcome: 'approve' | 'alias' | 'other'; alias?: string; date: string; reviewer: string }`
  - `type Labels = Record<'primary_status' | 'stage' | 'work_type', Record<string, LabelOutcome>>`
  - `loadCatalog(path?: string): Catalog`, `loadLabels(path?: string): Labels`, `loadGenericWords(path?: string): string[]` (lower-cased), all throwing on schema failure.

- [ ] **Step 1: Create branch and scaffold**

```bash
git switch -c feat/initial-build
npm init -y && npm pkg set type=module
npm i @modelcontextprotocol/sdk snowflake-sdk zod luxon better-sqlite3 pdfkit express
npm i -D typescript vitest @types/node @types/luxon @types/better-sqlite3 @types/pdfkit @types/express tsx
# superseded 2026-10-16: better-sqlite3 and @types/better-sqlite3 above were replaced by pg, @types/pg and @electric-sql/pglite (Neon via DATABASE_URL, see docs/deploy.md)
npm pkg set scripts.build="tsc -p ." scripts.test="vitest run" scripts.start="node dist/server.js" scripts.reconcile="tsx src/cli/reconcile.ts"
```

`tsconfig.json`: `target ES2022`, `module NodeNext`, `strict true`, `outDir dist`, `rootDir src`. `vitest.config.ts`: exclude `test/live/**` unless `LIVE=1`. `.gitignore`: `node_modules/`, `dist/`, `state/`, `.env*`, `*.sqlite`.

- [ ] **Step 2: Write `config/catalog.json`** with exactly these expressions (§4.1):

| key                                  | expr                                                                                          |
| ------------------------------------ | --------------------------------------------------------------------------------------------- |
| `source`                             | `KPI_DATABASE.SECURE_VIEWS.WORK_ITEM_DETAILS`                                                 |
| cohort `active_work`                 | `COMPLETED_DATETIME IS NULL AND PRIMARY_STATUS <> 'Planned'`                                  |
| measure `jobs` (int)                 | `COUNT(*)`                                                                                    |
| measure `past_due` (int)             | `COUNT_IF(IS_WORK_ITEM_OVERDUE)`                                                              |
| measure `stuck_over_30d` (int)       | `COUNT_IF(DATEDIFF('day', CURRENT_STATUS_ENTRY_DATE, CURRENT_DATE()) > 30)`                   |
| measure `median_days_in_stage` (int) | `ROUND(MEDIAN(DATEDIFF('day', CURRENT_STATUS_ENTRY_DATE, CURRENT_DATE())), 0)`                |
| measure `median_age_days` (int)      | `ROUND(MEDIAN(DATEDIFF('day', CREATED_DATETIME, CURRENT_DATE())), 0)`                         |
| measure `budget_hrs` (hours)         | `ROUND(SUM(COALESCE(BUDGETED_MINUTES,0))/60.0, 1)`                                            |
| measure `budgeted_jobs` (int)        | `COUNT_IF(BUDGETED_MINUTES > 0)`                                                              |
| dimension `primary_status`           | `PRIMARY_STATUS`, labels `primary_status`, minGroup null                                      |
| dimension `stage`                    | `COALESCE(NULLIF(SECONDARY_STATUS,''), '(no stage recorded)')`, labels `stage`, minGroup null |
| dimension `work_type`                | `WORK_TYPE`, labels `work_type`, minGroup 3                                                   |

Each entry gets a one-sentence `meaning` in plain English (e.g. `stuck_over_30d`: "Active jobs that have been in their current stage for more than 30 days."). `past_due`'s meaning says it uses Karbon's own overdue flag.

`config/labels.json`: `{"primary_status":{},"stage":{},"work_type":{}}`. `config/generic-words.json`: an array seeded with dashboard vocabulary and common words: every word appearing in the catalog meanings and the fixed copy above, plus `open, work, stage, status, jobs, active, past, due, stuck, budget, budgeted, hours, median, days, age, other, unreviewed, recorded, review, tax, payroll, the, and, for, with, by, of, in, to, week, since, change`.

- [ ] **Step 3: Write the failing test** `test/config.test.ts`:

```ts
test("catalog expressions are verbatim from query D", () => {
  const c = loadCatalog();
  expect(c.measures.stuck_over_30d.expr).toBe(
    "COUNT_IF(DATEDIFF('day', CURRENT_STATUS_ENTRY_DATE, CURRENT_DATE()) > 30)",
  );
  expect(c.dimensions.stage.expr).toBe(
    "COALESCE(NULLIF(SECONDARY_STATUS,''), '(no stage recorded)')",
  );
  expect(c.cohorts.active_work.where).toBe(
    "COMPLETED_DATETIME IS NULL AND PRIMARY_STATUS <> 'Planned'",
  );
  expect(c.dimensions.work_type.minGroup).toBe(3);
});
test("labels file rejects an alias outcome without an alias string", () => {
  expect(() =>
    parseLabels({
      primary_status: {},
      stage: {
        X: { outcome: "alias", date: "2026-10-16", reviewer: "Marcus Klein" },
      },
      work_type: {},
    }),
  ).toThrow();
});
test("generic words are lower-cased", () => {
  expect(loadGenericWords().every((w) => w === w.toLowerCase())).toBe(true);
});
```

(`parseLabels(raw: unknown): Labels` is exported alongside `loadLabels`.)

- [ ] **Step 4: Run** `npm test -- test/config.test.ts`. Expected: FAIL, module not found.
- [ ] **Step 5: Implement `src/config.ts`** with zod schemas; `alias` is required when `outcome === 'alias'`.
- [ ] **Step 6: Run** `npm test -- test/config.test.ts`. Expected: PASS.
- [ ] **Step 7: Commit** `feat(karbon-dashboards): scaffold and catalog config`.

---

### Task 2: Query builder

**Files:**

- Create: `src/data/types.ts`, `src/query/build.ts`
- Test: `test/query/build.test.ts`

**Interfaces:**

- Consumes: `Catalog`, `Labels` (Task 1).
- Produces:
  - `type MenuRequest = { measures: string[]; dimensions?: string[]; filters?: { due_between?: { from: string; to: string } }; orderBy?: { field: string; dir: 'asc' | 'desc' }[] }`
  - `type BuiltQuery = { sql: string; binds: (string | number)[]; columns: string[]; exemptStrings: Set<string> }` in `src/data/types.ts`
  - `type ResultTable = { columns: string[]; rows: (string | number | null)[][] }`
  - `interface DataSource { run(q: BuiltQuery, req: MenuRequest): Promise<ResultTable> }`
  - `class RequestError extends Error { code: 'disallowed_request' }`
  - `validateRequest(req: unknown, catalog: Catalog): MenuRequest` (throws `RequestError`)
  - `buildQuery(req: MenuRequest, catalog: Catalog, labels: Labels): BuiltQuery`

**Rules the builder pins:**

- At least 1 measure, at most 3 dimensions, all names in the catalog, `orderBy` fields within the request, `from`/`to` ISO dates with `from < to`. Anything else is a `RequestError` naming only the offending key's _position_ (e.g. `measures[2] not in menu`), never echoing free text.
- Label dimension expression: `CASE WHEN <expr> = ? THEN ? … ELSE 'Other (unreviewed)' END`, with one `WHEN` per labels-file entry. `approve` outputs the value, `alias` outputs the alias, `other` outputs `'Other'`. Values go in as binds. If there are no entries, the expression is the literal `'Other (unreviewed)'`.
- For `minGroup` dimensions, wrap the mapped expression as `CASE WHEN COUNT(*) OVER (PARTITION BY <mapped>) < 3 THEN 'Other' ELSE <mapped> END`.
- Shape: `SELECT <dims as "name">, <measure expr> AS "name" FROM (SELECT t.*, <dim exprs> AS "name" FROM KPI_DATABASE.SECURE_VIEWS.WORK_ITEM_DETAILS t WHERE <cohort> [AND DUE_DATETIME >= ? AND DUE_DATETIME < ?]) [GROUP BY <dims>] [ORDER BY …]`. With no dimensions there is no `GROUP BY`, and the result is one aggregate row.
- `exemptStrings` = every output string of the label mappings used, plus `Other` and `Other (unreviewed)`.

- [ ] **Step 1: Write the failing tests:**

```ts
const OPEN_WORK = {
  measures: [
    "jobs",
    "past_due",
    "median_days_in_stage",
    "median_age_days",
    "stuck_over_30d",
    "budget_hrs",
  ],
  dimensions: ["primary_status", "stage"],
  orderBy: [
    { field: "stuck_over_30d", dir: "desc" },
    { field: "jobs", dir: "desc" },
  ],
};
test("open work by stage carries every query D expression verbatim", () => {
  const q = buildQuery(validateRequest(OPEN_WORK, cat), cat, labels);
  for (const m of OPEN_WORK.measures)
    expect(q.sql).toContain(cat.measures[m].expr);
  expect(q.sql).toContain(cat.cohorts.active_work.where);
  expect(q.sql).toContain("FROM KPI_DATABASE.SECURE_VIEWS.WORK_ITEM_DETAILS");
  expect(q.sql).toContain('ORDER BY "stuck_over_30d" DESC, "jobs" DESC');
  expect(q.columns).toEqual(["primary_status", "stage", ...OPEN_WORK.measures]);
});
test("unknown measure or a client column is refused before any SQL", () => {
  expect(() => validateRequest({ measures: ["CLIENT"] }, cat)).toThrow(
    RequestError,
  );
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
  const q = buildQuery(
    { measures: ["jobs"], dimensions: ["work_type"] },
    cat,
    l,
  );
  expect(q.binds).toEqual(
    expect.arrayContaining([
      "Tax Return",
      "Smithfield Trust",
      "Trust: other",
      "Misc",
      "Other",
    ]),
  );
  expect(q.sql).toMatch(/ELSE 'Other \(unreviewed\)' END/); // NULL falls to ELSE
  expect(q.sql).toContain("COUNT(*) OVER (PARTITION BY");
  expect([...q.exemptStrings]).toEqual(
    expect.arrayContaining([
      "Tax Return",
      "Trust: other",
      "Other",
      "Other (unreviewed)",
    ]),
  );
  expect([...q.exemptStrings]).not.toContain("Smithfield Trust");
});
test("no dimensions -> single aggregate row, no GROUP BY", () => {
  expect(buildQuery({ measures: ["jobs"] }, cat, labels).sql).not.toMatch(
    /GROUP BY/,
  );
});
test("empty labels file -> literal unreviewed label", () => {
  expect(
    buildQuery({ measures: ["jobs"], dimensions: ["stage"] }, cat, emptyLabels)
      .sql,
  ).toContain(`'Other (unreviewed)' AS "stage"`);
});
```

(`A(outcome, alias?)` is a local helper that builds a `LabelOutcome` dated `2026-10-16`. "Smithfield Trust" is a made-up name.)

- [ ] **Step 2: Run** `npm test -- test/query`. Expected: FAIL.
- [ ] **Step 3: Implement** `validateRequest` and `buildQuery` per the rules above.
- [ ] **Step 4: Run** `npm test -- test/query`. Expected: PASS.
- [ ] **Step 5: Write `docs/label-review.md`**: Marcus runs these in **Snowsight** (never through Claude), decides an outcome for each value, and records it in `config/labels.json` with date and reviewer. A value that names or implies a client gets `alias` or `other`, never `approve`.

```sql
SELECT DISTINCT PRIMARY_STATUS FROM WORK_ITEM_DETAILS WHERE COMPLETED_DATETIME IS NULL AND PRIMARY_STATUS <> 'Planned';
SELECT DISTINCT COALESCE(NULLIF(SECONDARY_STATUS,''), '(no stage recorded)') FROM WORK_ITEM_DETAILS WHERE COMPLETED_DATETIME IS NULL AND PRIMARY_STATUS <> 'Planned';
SELECT DISTINCT WORK_TYPE FROM WORK_ITEM_DETAILS WHERE COMPLETED_DATETIME IS NULL AND PRIMARY_STATUS <> 'Planned';
```

- [ ] **Step 6: Commit** `feat(karbon-dashboards): menu request validation and SQL builder`.

---

### Task 3: Checks, logger and the guarded path

**Files:**

- Create: `src/guard/patterns.ts`, `src/guard/names.ts`, `src/guard/run.ts`, `src/log.ts`
- Test: `test/guard/patterns.test.ts`, `test/guard/run.test.ts`, `test/log.test.ts`

**Interfaces:**

- Consumes: `buildQuery`, `validateRequest`, `RequestError`, `DataSource`, `ResultTable` (Task 2).
- Produces:
  - `findPatterns(text: string, opts?: { urls?: boolean }): ('email'|'phone'|'ssn'|'ein'|'opaque_id'|'url')[]`
  - `interface NameChecker { countMatches(texts: string[]): Promise<number[]> }`
  - `class FixtureNameChecker implements NameChecker` (constructor `(names: string[], generic: string[])`), with matching rules identical to the SQL below.
  - `NAME_CHECK_SQL: string` (binds: `[JSON.stringify(texts), JSON.stringify(generic)]`)
  - `type RejectCode = 'disallowed_request'|'unexpected_column'|'pattern_match'|'client_name'|'warehouse_error'|'warehouse_login'`
  - `type GuardResult = { status: 'ok'; table: ResultTable; sql: string; queriedAt: string } | { status: 'rejected'; code: RejectCode; detail: string }`
  - `type GuardDeps = { catalog: Catalog; labels: Labels; generic: string[]; data: DataSource; names: NameChecker; now: () => Date; log: Logger }`
  - `runMenuRequest(raw: unknown, deps: GuardDeps): Promise<GuardResult>`
  - `type LogEvent = { kind: 'question'|'run'|'layout'|'courier'|'auth'; verdict: 'ok'|'rejected'|'failed'; requestHash?: string; sqlHash?: string; rowCount?: number; code?: RejectCode; scheduleId?: number }`; `createLogger(sink?: (line: string) => void): Logger` with `log(e: LogEvent): void`.

**Pinned values:**

- Patterns (string cells only): email `/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i`, phone `/(?:\+?1[-. ]?)?\(?\d{3}\)?[-. ]\d{3}[-. ]\d{4}/`, SSN `/\b\d{3}-\d{2}-\d{4}\b/`, EIN `/\b\d{2}-\d{7}\b/`, opaque id `/\b(?=[A-Za-z0-9]*\d)(?=[A-Za-z0-9]*[A-Za-z])[A-Za-z0-9]{10,}\b/`, URL (layouts only) `/(https?:\/\/|www\.)/i`.
- Name matching: lower-case; split on `[^a-z0-9]+`; words of **2+ characters** count. An input counts one hit per input word equal to a client-name word not in the generic list, plus one per full client name (4+ chars) contained in the input.
- `detail` strings never contain data: e.g. `column "stage"`, `measures[2] not in menu`.

`NAME_CHECK_SQL` (written as given; the live check is in Task 4):

```sql
WITH inputs AS (
  SELECT f.index AS idx, LOWER(f.value::string) AS txt FROM TABLE(FLATTEN(INPUT => PARSE_JSON(?))) f),
generic AS (SELECT LOWER(g.value::string) AS word FROM TABLE(FLATTEN(INPUT => PARSE_JSON(?))) g),
names AS (
  SELECT LOWER(n) AS full_name FROM (
    SELECT CLIENT AS n FROM KPI_DATABASE.SECURE_VIEWS.DIMN_CLIENT UNION ALL
    SELECT FIRST_NAME FROM KPI_DATABASE.SECURE_VIEWS.DIMN_CLIENT UNION ALL
    SELECT MIDDLE_NAME FROM KPI_DATABASE.SECURE_VIEWS.DIMN_CLIENT UNION ALL
    SELECT LAST_NAME FROM KPI_DATABASE.SECURE_VIEWS.DIMN_CLIENT UNION ALL
    SELECT PREFERRED_NAME FROM KPI_DATABASE.SECURE_VIEWS.DIMN_CLIENT UNION ALL
    SELECT LEGAL_NAME FROM KPI_DATABASE.SECURE_VIEWS.DIMN_CLIENT_ACCOUNTING_DETAIL UNION ALL
    SELECT TRADING_NAME FROM KPI_DATABASE.SECURE_VIEWS.DIMN_CLIENT_ACCOUNTING_DETAIL UNION ALL
    SELECT BUSINESS_NAME FROM KPI_DATABASE.SECURE_VIEWS.DIMN_CLIENT_ACCOUNTING_DETAIL UNION ALL
    SELECT CONTACT FROM KPI_DATABASE.SECURE_VIEWS.CONTACT_MEMBER_RELATIONSHIP UNION ALL
    SELECT RELATED_CONTACT FROM KPI_DATABASE.SECURE_VIEWS.CONTACT_MEMBER_RELATIONSHIP UNION ALL
    SELECT ORGANIZATION FROM KPI_DATABASE.SECURE_VIEWS.DIMN_ORGANIZATION_MEMBER)
  WHERE n IS NOT NULL AND TRIM(n) <> ''),
name_words AS (
  SELECT DISTINCT w.value::string AS word FROM names,
    LATERAL SPLIT_TO_TABLE(REGEXP_REPLACE(full_name, '[^a-z0-9]+', ' '), ' ') w
  WHERE LENGTH(w.value) >= 2),
input_words AS (
  SELECT i.idx, w.value::string AS word FROM inputs i,
    LATERAL SPLIT_TO_TABLE(REGEXP_REPLACE(i.txt, '[^a-z0-9]+', ' '), ' ') w
  WHERE LENGTH(w.value) >= 2),
word_hits AS (
  SELECT iw.idx, COUNT(*) AS c FROM input_words iw
  JOIN name_words nw ON iw.word = nw.word
  LEFT JOIN generic g ON g.word = iw.word
  WHERE g.word IS NULL GROUP BY iw.idx),
phrase_hits AS (
  SELECT i.idx, COUNT(*) AS c FROM inputs i
  JOIN names nm ON LENGTH(nm.full_name) >= 4 AND CONTAINS(i.txt, nm.full_name)
  GROUP BY i.idx)
SELECT i.idx, COALESCE(w.c, 0) + COALESCE(p.c, 0) AS hits
FROM inputs i LEFT JOIN word_hits w ON w.idx = i.idx LEFT JOIN phrase_hits p ON p.idx = i.idx
ORDER BY i.idx
```

**Order inside `runMenuRequest`:** validate (refuse → `disallowed_request`, no SQL run) → build → `data.run` (login error → `warehouse_login`, other error/timeout → `warehouse_error`) → every result column is in `BuiltQuery.columns` (else `unexpected_column`) → `findPatterns` on every string cell (`pattern_match`) → `names.countMatches` on string cells **not** in `exemptStrings` (any > 0 → `client_name`) → `ok`. Log one `LogEvent` per call.

- [ ] **Step 1: Write the failing tests:**

```ts
// patterns
test.each([
  ["a.b@x.com", "email"],
  ["(337) 555-0142", "phone"],
  ["123-45-6789", "ssn"],
  ["72-1234567", "ein"],
  ["mcC3q74sXb9Q", "opaque_id"],
])("%s -> %s", (t, k) => expect(findPatterns(t)).toContain(k));
test("ordinary labels pass", () => {
  for (const t of [
    "Ready To Start",
    "(no stage recorded)",
    "Other (unreviewed)",
    "2026-10-19",
  ])
    expect(findPatterns(t)).toEqual([]);
});
// names (made-up names only)
test("short surname caught, generic word ignored", async () => {
  const n = new FixtureNameChecker(
    ["Ng Family Trust", "Lee, Avery"],
    ["family", "trust"],
  );
  expect(
    await n.countMatches(["Waiting on Ng", "Family trust review", "Payroll"]),
  ).toEqual([1, 0, 0]);
});
// guard
test("client name in a non-exempt cell rejects; Claude gets no value", async () => {
  const r = await runMenuRequest(
    { measures: ["jobs"], dimensions: ["stage"] },
    deps({ rows: [["Avery Lee review", 3]] }),
  );
  expect(r).toEqual({
    status: "rejected",
    code: "client_name",
    detail: 'column "stage"',
  });
  expect(JSON.stringify(r)).not.toContain("Avery");
});
test("exempt label passes even if it shares a word with a client", async () => {
  const r = await runMenuRequest(
    { measures: ["jobs"], dimensions: ["stage"] },
    deps({ rows: [["Other (unreviewed)", 4]] }),
  );
  expect(r.status).toBe("ok");
});
test("disallowed request never reaches the data source", async () => {
  const d = deps({ rows: [] });
  expect((await runMenuRequest({ measures: ["CLIENT"] }, d)).status).toBe(
    "rejected",
  );
  expect(d.data.run).not.toHaveBeenCalled();
});
test("extra column from the source is rejected", async () => {
  expect(
    await runMenuRequest(
      { measures: ["jobs"] },
      deps({ columns: ["jobs", "CLIENT"], rows: [[1, "x"]] }),
    ),
  ).toMatchObject({ code: "unexpected_column" });
});
// log
test("logger refuses unknown fields and never prints values", () => {
  const lines: string[] = [];
  const l = createLogger((s) => lines.push(s));
  l.log({
    kind: "question",
    verdict: "rejected",
    code: "client_name",
    ...({ value: "Avery Lee" } as any),
  });
  expect(lines.join()).not.toContain("Avery");
});
```

(`deps({columns?, rows})` builds `GuardDeps` with a `vi.fn()` DataSource returning `{ columns: columns ?? builtColumns, rows }` and a `FixtureNameChecker(['Avery Lee'], generic)`.)

- [ ] **Step 2: Run** `npm test -- test/guard test/log.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `patterns.ts`, `names.ts` (`FixtureNameChecker` mirrors the SQL rules), `run.ts`, and `log.ts`. The logger copies only the whitelisted `LogEvent` keys and writes one JSON line.
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(karbon-dashboards): guarded request path with pattern and name checks`.

---

### Task 4: Live Snowflake source, dev secrets and reconciliation

**Files:**

- Create: `src/data/snowflake.ts`, `scripts/dev-env.sh`, `src/cli/reconcile.ts`
- Test: `test/live/snowflake.live.test.ts` (runs only with `LIVE=1`)

**Interfaces:**

- Consumes: `DataSource`, `NameChecker`, `NAME_CHECK_SQL`, `runMenuRequest`.
- Produces: `createSnowflakeSource(env: NodeJS.ProcessEnv, timeoutMs = 120_000): { data: DataSource; names: NameChecker; close(): Promise<void> }`. Login failures throw an error with `code = 'warehouse_login'`. A timeout throws `warehouse_error`.
- Produces: `OPEN_WORK_REQUESTS: Record<'totals'|'by_status'|'by_stage', MenuRequest>` exported from `src/cli/reconcile.ts`, reused by Task 9:
  - `totals`: measures `jobs, past_due, stuck_over_30d, median_days_in_stage, median_age_days, budget_hrs, budgeted_jobs`, no dimensions;
  - `by_status`: measures `jobs`, dimensions `primary_status`;
  - `by_stage`: the `OPEN_WORK` request from Task 2.

- [ ] **Step 1: Write `scripts/dev-env.sh`.** It exports `KARBON_SF_USER`, `KARBON_SF_PASSWORD` and `MCP_BEARER_TOKEN` from `security find-generic-password -s karbon-dashboards -a <name> -w` (accounts `snowflake-user`, `snowflake-password`, `mcp-bearer`), then `exec "$@"`. It never echoes a value. Document one-time setup in its header: `security add-generic-password -s karbon-dashboards -a snowflake-password -w` (prompts).
- [ ] **Step 2: Write the live test** (`LIVE=1` only): `createSnowflakeSource(process.env)`; `names.countMatches(['Ready To Start','zzqx'])` resolves to two numbers, and the second is `0`. Running `OPEN_WORK_REQUESTS.totals` through `runMenuRequest` returns `ok` with one row.
- [ ] **Step 3: Implement `src/data/snowflake.ts`** with `snowflake-sdk` and the Global Constraints connection. Each `run` is raced against `timeoutMs`. Columns come back with their quoted lower-case aliases.
- [ ] **Step 4: Run** `LIVE=1 scripts/dev-env.sh npx vitest run test/live`. Expected: PASS. **If `NAME_CHECK_SQL` errors in Snowflake, fix the SQL here and keep `FixtureNameChecker` matching it.**
- [ ] **Step 5: Implement `src/cli/reconcile.ts`.** It runs the three requests through `runMenuRequest` (live) and prints each result as a plain table. If any is rejected, it prints the code and exits 1.
- [ ] **Step 6: Reconcile (manual; Marcus).** First complete the `primary_status` and `stage` reviews from `docs/label-review.md` (gate G5, §9). Within one hour, run `scripts/dev-env.sh npm run reconcile` and Snowsight query D, copied from `~/dev/cpa-consulting/karbon-kb/power-bi-demo-build-guide-2026-10-15.md` §2.2 and never retyped. Expected: `by_stage` equals query D row for row. `budget_hrs` compared unrounded may differ by up to 0.1 h per row. Record the date and result in `docs/deploy.md` under "Reconciliation log".
- [ ] **Step 7: Two one-time facts (manual, recorded in `docs/deploy.md`).**
  - **Session time zone.** Run `SHOW PARAMETERS LIKE 'TIMEZONE'` in Snowsight and record it (§4.1). If it isn't `America/Chicago`, note that `CURRENT_DATE()` rolls over at a different hour; nothing changes in code.
  - **Warehouse refresh timing (§4.5).** Run `OPEN_WORK_REQUESTS.totals` through the reconciliation runner at about 07:30, 08:00 and 09:00 Central on one Monday. If the figures change after 08:00, record it. Then add the line `Data reflects Karbon's warehouse as of its last refresh, which happens after 8:00 CT on Mondays.` to the layout's notes (Task 13, Step 2).
- [ ] **Step 8: Commit** `feat(karbon-dashboards): live Snowflake source and reconciliation runner`.

---

### Task 5: Synthetic data source

**Files:**

- Create: `src/data/synthetic.ts`
- Test: `test/data/synthetic.test.ts`

**Interfaces:**

- Consumes: `DataSource`, `BuiltQuery`, `MenuRequest`.
- Produces: `createSyntheticSource(seed = 1): { data: DataSource; names: NameChecker }`. Rows are derived from `req` and `BuiltQuery.columns` using made-up labels (`Ready To Start`, `In Progress`, `Waiting`; stages `Preparing`, `Review`, `(no stage recorded)`; work types `Individual Return`, `Bookkeeping`). Integers come out deterministic for a given seed. `names` is a `FixtureNameChecker` over three made-up client names.

- [ ] **Step 1: Write the failing test:** for each `OPEN_WORK_REQUESTS` entry, the synthetic source returns exactly `BuiltQuery.columns`; `by_stage` has 3 to 9 rows; the same seed gives the same output.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(karbon-dashboards): synthetic data source`.

---

### Task 6: Layout schema, check and fill

**Files:**

- Create: `src/dashboard/layout.ts`, `src/dashboard/fill.ts`
- Test: `test/dashboard/layout.test.ts`, `test/dashboard/fill.test.ts`

**Interfaces:**

- Consumes: `GuardResult`/`ResultTable`, `NameChecker`, `findPatterns`, `Catalog`.
- Produces:
  - `type Layout = { title: string; subtitle?: string; tiles: { label: string; request: string; measure: string; shareOf?: string; showChange: boolean }[]; charts: { title: string; request: string; dimension: string; measure: string }[]; tables: { title: string; request: string; columns: { field: string; label: string }[]; sortBy?: { field: string; dir: 'asc'|'desc' } }[]; notes: string[] }`. Every text field is 1 to 200 characters.
  - `checkLayout(raw: unknown, requests: Record<string, MenuRequest>, deps: { names: NameChecker }): Promise<{ ok: true; layout: Layout } | { ok: false; code: 'invalid_layout'|'pattern_match'|'client_name'; detail: string }>`. Field refs must exist in the named request. All Claude-authored text goes through `findPatterns(…, { urls: true })` and `names`.
  - `type Snapshot = { periodKey: string; totals: Record<string, ResultTable> }`
  - `type FilledDashboard = { title: string; subtitle?: string; asOf: string; tiles: { label: string; value: string; change: string | null }[]; charts: { title: string; bars: { label: string; value: number }[] }[]; tables: { title: string; header: string[]; rows: string[][] }[]; notes: string[]; footnotes: string[] }`
  - `fillLayout(layout: Layout, results: Record<string, ResultTable>, previous: Snapshot | null, queriedAt: Date, catalog: Catalog): FilledDashboard`
  - `checkFilled(f: FilledDashboard, exempt: Set<string>, deps: { names: NameChecker }): Promise<{ ok: true } | { ok: false; code: 'pattern_match'|'client_name'; detail: string }>`

**Pinned copy and formatting:**

- `asOf` = `Queried from Karbon's warehouse ${yyyy-MM-dd HH:mm in America/Chicago} CT`.
- Tile value: `int` → thousands separator; `hours` → one decimal; with `shareOf`, `95 (40%)` (share rounded to a whole percent).
- `change`: `+3 since 2026-10-12`, `-2 since …`, `No change since …`. With no previous snapshot, `No earlier run to compare`. If the previous snapshot lacks the field, `null`.
- `footnotes` (system copy, exempt from the name check): each used measure's catalog `meaning`; `N jobs had a label not yet reviewed and are shown as "Other (unreviewed)".` whenever that label appears; `Compared with the run of <periodKey>.`
- `checkFilled` applies patterns to **every** string, and runs the name check on strings that are neither in `exempt` nor footnotes nor `asOf`.

- [ ] **Step 1: Write the failing tests:**

```ts
test("layout with a URL is refused", async () =>
  expect(await checkLayout(withNote("see https://x.y"), REQS, d)).toMatchObject(
    { ok: false, code: "pattern_match" },
  ));
test("layout naming a made-up client is refused", async () =>
  expect(
    await checkLayout(withNote("Avery Lee is late"), REQS, d),
  ).toMatchObject({ ok: false, code: "client_name" }));
test("layout ref to a measure not in its request is invalid", async () =>
  expect(
    await checkLayout(tileOn("by_status", "budget_hrs"), REQS, d),
  ).toMatchObject({ code: "invalid_layout" }));
test("fill: share, change and as-of copy", () => {
  const f = fillLayout(
    LAYOUT,
    RESULTS,
    PREV_2026_10_12,
    new Date("2026-10-19T13:02:00Z"),
    cat,
  );
  expect(f.asOf).toBe("Queried from Karbon's warehouse 2026-10-19 08:02 CT");
  expect(f.tiles[1]).toEqual({
    label: "Past due",
    value: "95 (40%)",
    change: "+3 since 2026-10-12",
  });
});
test("fill: zero rows still fills", () => {
  const f = fillLayout(LAYOUT, EMPTY_RESULTS, null, new Date(), cat);
  expect(f.tables[0].rows).toEqual([]);
  expect(f.tiles[0].value).toBe("0");
  expect(f.tiles[0].change).toBe("No earlier run to compare");
});
```

- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement** with zod for the schema and luxon for the time.
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(karbon-dashboards): dashboard layout check and fill`.

---

### Task 7: PDF renderer

**Files:**

- Create: `src/dashboard/render.ts`
- Test: `test/dashboard/render.test.ts`

**Interfaces:**

- Consumes: `FilledDashboard`.
- Produces: `renderPdf(f: FilledDashboard): Promise<Buffer>`. pdfkit, US Letter landscape, built-in Helvetica (no font files, no images, no links). Page order follows §4.5: title, `asOf` and subtitle; tiles in a row; bar charts; tables; then notes and footnotes. Tables continue onto new pages with the header repeated.

- [ ] **Step 1: Write the failing tests:** the output starts with `%PDF`; a 60-row table produces more than 1 page (count `/Type /Page` objects) and stays under `1_048_576` bytes; the output has no `/URI` entries.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(karbon-dashboards): PDF renderer`.

---

### Task 8: State store and schedule timing

**Files:**

- Create: `src/store/db.ts`, `src/schedule/due.ts`
- Test: `test/store/db.test.ts`, `test/schedule/due.test.ts`

**Interfaces:**

- Produces (`due.ts`):
  - `type Cadence = { weekday: 1|2|3|4|5|6|7; time: string /* HH:mm */; timezone: string }`
  - `latestOccurrence(c: Cadence, now: Date): { at: Date; periodKey: string } | null` returns the most recent occurrence at or before `now`. `periodKey` is the occurrence's local date `yyyy-MM-dd`.
- Produces (`db.ts`): `openStore(path: string): Store`, where `Store` has:
  - `createSchedule(s: NewSchedule): number`, `updateSchedule(id, patch)`, `setPaused(id, paused)`, `deleteSchedule(id)`, `listSchedules(): Schedule[]`, `getSchedule(id)`
  - `claimRun(scheduleId: number, periodKey: string, now: Date): number | null` inserts a `running` run, or re-claims an `interrupted` one; returns `null` if it's already running or finished.
  - `finishRun(runId, status: 'produced'|'rejected'|'failed', code?: RejectCode)`, `recoverInterrupted(now: Date, olderThanMin = 15): number`
  - `addFile(runId, f: { folder: string; filename: string; content: Buffer; contentType: string }): number`, `pendingFiles(): PendingFile[]`, `markDelivered(fileId, now)`, `undeliveredOlderThan(min: number, now: Date): PendingFile[]`, `markAlerted(fileId, now)`
  - `saveSnapshot(runId, s: Snapshot)`, `previousSnapshot(scheduleId, beforePeriodKey): Snapshot | null`
  - `getTargets(): Record<string, { driveId: string; itemId: string }>`, `setTarget(key, t)`
  - `listRuns(limit: number): RunSummary[]`
  - `type Schedule = { id: number; name: string; slug: string; cadence: Cadence; requests: Record<string, MenuRequest>; layout: Layout; paused: boolean; createdAt: string }`
- Tables: `schedules`, `runs` (`UNIQUE(schedule_id, period_key)`), `files` (`content BLOB`, `bytes`, `delivered_at`, `alerted_at`), `snapshots`, `targets`. Created on open.

- [ ] **Step 1: Write the failing tests:**

```ts
const MON8 = {
  weekday: 1,
  time: "08:00",
  timezone: "America/Chicago",
} as const;
test("Monday 08:00 CDT is 13:00Z", () =>
  expect(latestOccurrence(MON8, new Date("2026-10-19T13:00:00Z"))).toEqual({
    at: new Date("2026-10-19T13:00:00Z"),
    periodKey: "2026-10-19",
  }));
test("one minute early -> previous week", () =>
  expect(
    latestOccurrence(MON8, new Date("2026-10-19T12:59:00Z"))!.periodKey,
  ).toBe("2026-10-12"));
test("after DST ends, 08:00 CST is 14:00Z", () => {
  expect(
    latestOccurrence(MON8, new Date("2026-11-02T13:30:00Z"))!.periodKey,
  ).toBe("2026-10-26");
  expect(latestOccurrence(MON8, new Date("2026-11-02T14:00:00Z"))).toEqual({
    at: new Date("2026-11-02T14:00:00Z"),
    periodKey: "2026-11-02",
  });
});
test("claimRun is exactly-once; interrupted runs can be re-claimed", () => {
  const s = openStore(":memory:");
  const id = s.createSchedule(SCHED);
  expect(s.claimRun(id, "2026-10-19", T)).not.toBeNull();
  expect(s.claimRun(id, "2026-10-19", T)).toBeNull();
  expect(s.recoverInterrupted(new Date(T.getTime() + 16 * 60_000))).toBe(1);
  expect(s.claimRun(id, "2026-10-19", T)).not.toBeNull();
});
test("pending, delivered and alerting", () => {
  // addFile -> pendingFiles has it; markDelivered -> gone; undeliveredOlderThan(30) only after 30 min; markAlerted excludes it next time
});
```

(Write the last test's assertions in full; the comment lists them.)

- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement** with luxon (`DateTime.fromJSDate(now).setZone(tz)`, walking back to the weekday) and ~~better-sqlite3~~ (superseded 2026-10-16: Neon via `DATABASE_URL`, see docs/deploy.md).
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(karbon-dashboards): state store and schedule timing`.

---

### Task 9: Scheduled runs, ticker and alerts

**Files:**

- Create: `src/schedule/run.ts`, `src/schedule/ticker.ts`, `src/alert.ts`
- Test: `test/schedule/run.test.ts`, `test/schedule/ticker.test.ts`

**Interfaces:**

- Consumes: `runMenuRequest`, `fillLayout`, `checkFilled`, `renderPdf`, `Store`, `latestOccurrence`, `GuardDeps`.
- Produces:
  - `interface Alerter { alert(kind: 'run_rejected'|'run_failed'|'undelivered', detail: string): Promise<void> }`; `createAlerter(env): Alerter` POSTs `{ "text": "<kind>: <detail>" }` to `ALERT_WEBHOOK_URL` if set, otherwise uses the logger. `detail` never contains data values.
  - `executeScheduledRun(schedule: Schedule, runId: number, periodKey: string, deps: GuardDeps & { store: Store; alerter: Alerter }): Promise<'produced'|'rejected'|'failed'>`
  - `startTicker(deps, opts?: { intervalMs?: number; now?: () => Date }): { tickOnce(): Promise<void>; stop(): void }`. Each tick does three things: claim and run the latest due occurrence of every unpaused schedule whose `createdAt` is at or before that occurrence; alert once for files undelivered after 30 minutes; and, on the first tick, `recoverInterrupted`.

**Run steps (§4.4):**

1. Run every named request.
2. If any is rejected, write a notice.
3. Otherwise: `previousSnapshot`, then `fillLayout`, then `checkFilled` with the union of `exemptStrings`. A failed check writes a notice.
4. `renderPdf`. If the PDF is 1,048,576 bytes or more, write a notice with code `warehouse_error`/detail `pdf too large`.
5. `addFile` for the PDF (`application/pdf`) and `<periodKey>-<slug>.totals.json` (`application/json`), then `saveSnapshot`.

Notice file: `<periodKey>-<slug> — NOT PRODUCED.txt`, `text/plain`, body:

```
No dashboard this week. The run was <rejected (possible client data) | rejected (<code>) | could not complete (<code>)>. Marcus has been notified.
Scheduled: <periodKey> <time> <timezone>
```

`rejected (possible client data)` is used for `client_name` and `pattern_match`. An exception from any step means `failed`. Every outcome other than `produced` calls `alerter.alert`. `folder` is the schedule `slug`.

- [ ] **Step 1: Write the failing tests:**

```ts
test("happy path stores PDF, totals and snapshot", async () => {
  expect(await executeScheduledRun(SCHED, runId, "2026-10-19", deps)).toBe(
    "produced",
  );
  expect(store.pendingFiles().map((f) => f.filename)).toEqual([
    "2026-10-19-open-work-by-stage.pdf",
    "2026-10-19-open-work-by-stage.totals.json",
  ]);
});
test("client name in a result -> notice only, alert, no PDF", async () => {
  expect(
    await executeScheduledRun(
      SCHED,
      runId,
      "2026-10-19",
      depsWithRow(["Avery Lee", 2]),
    ),
  ).toBe("rejected");
  const [f] = store.pendingFiles();
  expect(f.filename).toBe("2026-10-19-open-work-by-stage — NOT PRODUCED.txt");
  expect(f.content.toString()).toMatch(
    /^No dashboard this week\. The run was rejected \(possible client data\)\. Marcus has been notified\./,
  );
  expect(f.content.toString()).not.toContain("Avery");
  expect(alerter.alert).toHaveBeenCalledWith(
    "run_rejected",
    expect.not.stringContaining("Avery"),
  );
});
test("warehouse login failure -> failed notice within timeout", async () => {
  expect(
    await executeScheduledRun(SCHED, runId, "2026-10-19", depsLoginFails),
  ).toBe("failed");
  expect(store.pendingFiles()[0].content.toString()).toContain(
    "could not complete (warehouse_login)",
  );
});
test("ticker runs once per period across two ticks and a restart", async () => {
  const t = startTicker(deps, { now: () => new Date("2026-10-19T13:05:00Z") });
  await t.tickOnce();
  await t.tickOnce();
  t.stop();
  await startTicker(deps, {
    now: () => new Date("2026-10-19T13:06:00Z"),
  }).tickOnce();
  expect(runSpy).toHaveBeenCalledTimes(1);
});
test("undelivered after 30 min alerts exactly once", async () => {
  /* addFile at 13:00Z, tick at 13:29Z -> 0 alerts, 13:31Z -> 1, 13:40Z -> still 1 */
});
```

(Write the last test in full. `depsLoginFails` uses a DataSource whose `run` rejects with `code = 'warehouse_login'`.)

- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(karbon-dashboards): scheduled runs, ticker and alerts`.

---

### Task 10: Core API, MCP layer and HTTP server

**Files:**

- Create: `src/core/api.ts`, `src/mcp/tools.ts`, `src/http.ts`, `src/server.ts`
- Test: `test/core/api.test.ts`, `test/mcp/tools.test.ts`, `test/http.test.ts`, `test/mcp/boundary.test.ts`

**Interfaces:**

- Consumes: everything above.
- Produces: `interface CoreApi` with:
  - `listMenu(): { cohorts; measures; dimensions; filters }` (names and meanings only)
  - `ask(raw: unknown): Promise<GuardResult>`
  - `previewDashboard(requests: Record<string, MenuRequest>, layout: unknown): Promise<{ ok: true; pdfBase64: string; bytes: number; filled: FilledDashboard } | { ok: false; code: string; detail: string }>`
  - `createSchedule(input: { name: string; slug: string; cadence: Cadence; requests: Record<string, MenuRequest>; layout: unknown }): Promise<{ ok: true; id: number } | { ok: false; code: string; detail: string }>` (validates requests, then `checkLayout`; `slug` matches `^[a-z0-9-]{3,60}$`)
  - `listSchedules()`, `updateSchedule(id, patch)` (re-validates), `pauseSchedule(id, paused)`, `deleteSchedule(id)`, `runScheduleNow(id)` (period key `manual-<ISO time>`, file date uses today's local date)
  - `listRuns(limit)`, `listPendingFiles(): { fileId; folder; filename; contentType; bytes; contentBase64 }[]`, `markFileDelivered(fileId)`, `getDeliveryTargets()`, `setDeliveryTarget(key, driveId, itemId)`
- `createCore(env): { api: CoreApi; ticker: … }` chooses Snowflake or synthetic by `DATA_MODE`.
- `registerTools(server: McpServer, api: CoreApi): void` registers these tools, each a direct call: `list_menu`, `ask_question`, `preview_dashboard`, `create_schedule`, `list_schedules`, `update_schedule`, `pause_schedule`, `delete_schedule`, `run_schedule_now`, `list_runs`, `list_pending_files`, `mark_file_delivered`, `get_delivery_targets`, `set_delivery_target`. Each tool description states what it returns and that SQL can't be supplied.
- `createApp(api: CoreApi, env): express.Express`. `POST /mcp` uses Streamable HTTP in stateless mode. Every request needs `Authorization: Bearer <MCP_BEARER_TOKEN>`; anything else gets 401 before any work, logged as `kind:'auth'`. Rate limit 60 requests per minute per IP, returning 429 above that. `GET /health` returns `ok` without auth and reveals nothing else.
- `src/server.ts` does `createCore(process.env)`, then `createApp`, `listen(PORT)`, then starts the ticker.

- [ ] **Step 1: Write the failing tests:**

```ts
test("no token -> 401 and the core is never called", async () => {
  const r = await request(app).post("/mcp").send(INIT);
  expect(r.status).toBe(401);
  expect(api.ask).not.toHaveBeenCalled();
});
test("wrong token -> 401", async () =>
  expect(
    (
      await request(app)
        .post("/mcp")
        .set("Authorization", "Bearer nope")
        .send(INIT)
    ).status,
  ).toBe(401));
test("61st request in a minute -> 429", async () => {
  /* 61 authorised calls */
});
test("ask_question passes through rejection with no data", async () => {
  api.ask.mockResolvedValue({
    status: "rejected",
    code: "client_name",
    detail: 'column "stage"',
  });
  expect(
    await callTool("ask_question", { request: { measures: ["jobs"] } }),
  ).toMatchObject({ structuredContent: { status: "rejected" } });
});
test("create_schedule refuses a layout with a URL", async () => {
  /* real createCore in synthetic mode */
});
test("MCP layer imports nothing but the CoreApi type", () => {
  const src = readFileSync("src/mcp/tools.ts", "utf8");
  expect(src).not.toMatch(
    /from '\.\.\/(data|guard|query|store|schedule|dashboard)\//,
  );
});
```

Add `supertest` as a dev dependency. Write the rate-limit and `create_schedule` tests in full.

- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test`. Expected: all PASS.
- [ ] **Step 5: Local end to end (synthetic).** Run `DATA_MODE=synthetic scripts/dev-env.sh npm run build && scripts/dev-env.sh npm start`, then connect Claude Code: `claude mcp add --transport http karbon-dashboards http://localhost:8787/mcp --header "Authorization: Bearer $MCP_BEARER_TOKEN"` (expanded in the shell, never pasted into a file). In Claude Code, list the menu, ask `OPEN_WORK_REQUESTS.by_stage`, preview a layout, and `run_schedule_now` on a test schedule. Expected: a PDF is pending in `list_pending_files`.
- [ ] **Step 6: Commit** `feat(karbon-dashboards): core API, MCP tools and authenticated HTTP server`.

---

### Task 11: Courier instructions

**Files:**

- Create: `docs/courier-prompt.md`
- Test: manual (Task 13)

- [ ] **Step 1: Write `docs/courier-prompt.md`**, the exact instructions for the scheduled Claude task (§4.8):
  1. Call `list_pending_files`. If there are none, stop.
  2. For each file, take the target from `get_delivery_targets` under `root`. On first use, find `Claude Dashboards` with the Microsoft 365 folder search, then `set_delivery_target('root', driveId, itemId)`.
  3. Find or create the subfolder named `folder` with the Microsoft 365 `create_folder` tool (`conflictBehavior: 'fail'`; on "already exists", look it up instead), and cache it with `set_delivery_target(folder, …)`.
  4. Upload with `sharepoint_upload_file`: `filename` as given; `contentBase64` for the PDF, `content` for `.json`/`.txt` (decoded from base64); `expectedBytes` set to `bytes`; `conflictBehavior: 'fail'`.
  5. On success, or on a "name already exists" error, call `mark_file_delivered(fileId)`.
  6. Never open, summarize, rename, edit or re-encode a file. Never upload anywhere but `Claude Dashboards/<folder>/`. Report only counts: uploaded, already present, failed.
- [ ] **Step 2: Commit** `docs(karbon-dashboards): courier instructions`.

---

### Task 12: Railway deployment (after gate G2)

**Files:**

- Create: `railway.json`, `.railwayignore`, `docs/deploy.md`

**Precondition:** Chris has approved a **firm-owned** Railway account holding the Karbon password (G2). Stop here if not.

- [ ] **Step 1: Write `railway.json`:** Nixpacks builder; build `npm ci && npm run build`; start `npm start`; restart policy `ON_FAILURE`; `numReplicas: 1`. `.railwayignore`: `node_modules`, `state`, `dist`, `test`, `.env*`, `*.sqlite`.
- [ ] **Step 2: Provision** in the firm account: one service, ~~one volume mounted at `/data`~~ **Superseded 2026-10-16: Neon via `DATABASE_URL`, see docs/deploy.md.** Set variables `KARBON_SF_USER`, `KARBON_SF_PASSWORD`, `MCP_BEARER_TOKEN` (newly generated with `openssl rand -base64 48`, also stored in the Keychain as `mcp-bearer`), `ALERT_WEBHOOK_URL` (an alert channel Marcus chooses), ~~`STATE_DB_PATH=/data/state.sqlite`~~ **Superseded 2026-10-16: Neon via `DATABASE_URL`, see docs/deploy.md.** `DATA_MODE=live`. Use the `use-railway` skill for the CLI steps.
- [ ] **Step 3: Deploy from the repo root:** `railway up`. This repo holds only this project, so nothing else from cpa-consulting can reach Railway.
- [ ] **Step 4: Verify:**
  - `curl -s -o /dev/null -w '%{http_code}' -X POST https://<service>/mcp` → `401`;
  - `GET /health` → `ok`;
  - from Claude Code (re-add the MCP server with the Railway URL), `ask_question` with `OPEN_WORK_REQUESTS.totals` → `ok`;
  - read `railway logs` after a deliberately rejected request: it shows reason codes and no values.
- [ ] **Step 5: Write `docs/deploy.md`** with the steps above, the variable names (never values), how to rotate the password and token, and the reconciliation log.
- [ ] **Step 6: Commit** `chore(karbon-dashboards): Railway deployment`.

---

### Task 13: Courier verification, first Monday and switch-on

**Files:**

- Create: `docs/courier-verification.md`

- [ ] **Step 1: Verify the courier route (§4.8, "verify before relying on it").** Under the **firm** Claude account, check whether a scheduled task (a Claude Code cloud routine or a claude.ai scheduled task) can use both the Microsoft 365 connector and a custom connector to the Railway service. Record in `docs/courier-verification.md`: the feature used, how the custom connector authenticates, and whether the bearer header works. **If the custom connector requires OAuth, stop and raise it with Marcus.** That needs an OAuth addition to Task 10, which is a separate plan.
- [ ] **Step 2: Create the real schedule** through Claude Code: name `Open work by stage`, slug `open-work-by-stage`, cadence weekday 1 `08:00` `America/Chicago`, requests `OPEN_WORK_REQUESTS`, layout per §4.5 (tiles: active jobs, past due with share, stuck over 30 days, budgeted hours, all with change; a bar chart of jobs by primary status; the stage table sorted by stuck over 30 days). Check it with `preview_dashboard` first.
- [ ] **Step 3: First Monday by hand.** After the 08:00 run, Marcus runs `docs/courier-prompt.md` in Claude Code himself and checks the PDF in `Claude Dashboards/open-work-by-stage/` against Snowsight query D the same morning.
- [ ] **Step 4: Share and switch on.** Marcus shares `Claude Dashboards` with Chris (G6), then creates the scheduled courier task for **Mondays 08:05 America/Chicago** with `docs/courier-prompt.md` as its prompt.
- [ ] **Step 5: Policy record.** In the cpa-consulting repo, use its `changelog-capture` skill to add the POL-01 line describing this pipeline (G3 follow-up, §9) and its changelog entry.
- [ ] **Step 6: Commit** `docs(karbon-dashboards): courier verification and go-live record`.
