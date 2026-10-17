# Karbon Dashboards Go-Live Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Take the built service from "tests pass on the Mac" to "Chris gets a checked open-work-by-stage PDF in OneDrive every Monday at 08:00 Central", meeting every acceptance item in spec §8.

**Architecture:** The service runs as **two Railway services** built from this one repo (spec §4.7, ruling below):

- **`karbon-api`** (the Node.js core API server): catalog, SQL generation, the Snowflake connection, every check, the scheduler, the renderer, run state and pending files. It is the only service holding warehouse credentials or `DATABASE_URL`. It has **no public domain** and is reachable only at `karbon-api.railway.internal` on the private network.
- **`karbon-mcp`** (the MCP layer): the only public door. It authenticates Claude with the bearer token, applies the rate limit, and turns each tool call into one call to `karbon-api` over the private network. It has no warehouse access, no database and no logic of its own.

Two small code changes close the gaps that block the spec's acceptance criteria on Railway: a heartbeat lease on runs, so a redeploy during the scheduled minute runs once (§8.4), and a drain on SIGTERM. A third change splits the process in two (Task 3). State lives in a private Postgres service in the same Railway project, so Railway is the only new vendor for gate G2. TLS to it is fully verified (`DATABASE_CA_CERT`, done 2026-10-17). Both services are deployed in synthetic mode first, so §8.3, §8.4, §8.7 and §8.8 are proven without the Karbon password. The API switches to live only after gates G2 and G5 and the same-day reconciliation (§8.1). The courier route is verified before relying on it (§4.8). Then come the first Monday by hand and the switch-on. This plan replaces Tasks 12–13 of `docs/plans/2026-10-16-guarded-karbon-dashboards.md`.

**Ruling (2026-10-17): two services, not one.** Spec §4.7 leaves "one service or two" to the builder, and Marcus asked for the split. It is cheap to do now and gives the protection the spec describes: a fault or compromise in the public MCP layer cannot reach Snowflake, because that service never holds the credentials. If it is wrong, the cost is one extra Railway service and one internal hop. The local all-in-one entry (`src/server.ts`) is kept for running on the Mac, and a contract test (Task 3) keeps the two paths identical.

**Tech Stack:** Node 22, TypeScript (ESM), vitest, `pg` + PGlite, Railway (two app services managed by Infrastructure as Code in `.railway/railway.ts`, plus a private `postgres-ssl:17` service), Claude Code + Microsoft 365 connector (courier).

**Spec:** `docs/specs/2026-10-16-guarded-karbon-dashboards-design.md` (§ references point there). Operational reference: `docs/deploy.md`, `docs/courier-prompt.md`.

## Global Constraints

- Repo `~/dev/karbon-dashboards`; work on branch `feat/go-live` from `main` (`5b7b59c`). Stage files by name. Push nothing without Marcus's say-so.
- **Before every commit:** `git diff --cached` contains no client names, no `eyJ….eyJ…` JWT, no PEM `BEGIN` line, no `password=`, no `postgresql://` URL. Tests use made-up names only.
- Secrets live only in Railway variables (production) and the macOS Keychain via `scripts/dev-env.sh` (Mac). Never in a file, log, commit, test, image or `.mcp.json`. Never print a Railway variable's value into a session; list names only. **Which service holds which secret:**

  | Variable                                                                | `karbon-api`      | `karbon-mcp`                                                                           |
  | ----------------------------------------------------------------------- | ----------------- | -------------------------------------------------------------------------------------- |
  | `KARBON_SF_USER`, `KARBON_SF_PASSWORD`                                  | yes (Task 7 only) | **never**                                                                              |
  | `DATABASE_URL`, `DATABASE_CA_CERT`, `POSTGRES_PASSWORD` (via reference) | yes               | **never**                                                                              |
  | `ALERT_WEBHOOK_URL`, `HEARTBEAT_URL`                                    | yes               | no                                                                                     |
  | `INTERNAL_API_TOKEN`                                                    | yes               | yes (same value)                                                                       |
  | `MCP_BEARER_TOKEN`                                                      | no                | yes                                                                                    |
  | `CORE_API_URL`                                                          | no                | yes, a reference: `http://${{karbon-api.RAILWAY_PRIVATE_DOMAIN}}:${{karbon-api.PORT}}` |

  `karbon-mcp` refuses to start if any "never" variable is set (Task 3), so the separation is enforced, not just intended.

- Existing infrastructure (Marcus's personal Railway account, his decision 2026-10-16):
  - Railway project `karbon-dashboards` `c6ebe4d5-7717-411e-a32f-c9560af74610`, environment `production` `c9d6f25c-d525-4843-9724-88f5ac4f240a`. The environment was created after 2026-10-16, so its private DNS resolves to both IPv4 and IPv6 (Railway docs, "How Private Networking Works").
  - App service `02371543-1c9a-4d03-8cc1-e45876f06194`, currently named `karbon-dashboards` (no source yet). `DATABASE_URL` (reference variables, no `sslmode`) and `DATABASE_CA_CERT` are set. **It becomes `karbon-api`** (renamed in Task 5), so those variables stay where the database is used.
  - `karbon-mcp`: new service, created in Task 5.
  - Postgres service `postgres` `1c6c90b7-caf1-4662-b7c9-0fe6d13c1122`, image `ghcr.io/railwayapp-templates/postgres-ssl:17`, volume `postgres-data`, private network only (no TCP proxy). Details are in `docs/deploy.md` "State store (Railway Postgres)".
  - Neon project `small-butterfly-91907366` is no longer used. Delete it only when Marcus says so.
- **Railway configuration is Infrastructure as Code (`.railway/railway.ts`), not `railway.json`.** Railway deprecated Config as Code: "New services cannot opt into Config as Code", and existing files stop being read on 2026-12-01 (docs, "Infrastructure as Code"). Both app services are new. **`railway config apply` deletes any resource the file omits**, so the file must declare `postgres` and its volume, and every apply is preceded by a `railway config plan` that shows zero deletes.
- **Gate G2 still binds the Karbon password.** The spec puts the warehouse password on a _firm-owned_ Railway account approved by Chris. `KARBON_SF_USER`/`KARBON_SF_PASSWORD` are not set on Railway, and `DATA_MODE=live` is not set, until Chris has approved holding them where they will live (Task 7, Step 1).
- Each app service runs **exactly one replica** (`replicas: 1`). The scheduler only ever runs in `karbon-api`.
- **No deploy of `karbon-api` between 07:45 and 08:30 Central on Mondays** until Tasks 1–2 are deployed. After that the rule is retired (Task 5 updates `docs/deploy.md`). `karbon-mcp` holds no run state and can be deployed at any time; a tool call in flight during its restart fails cleanly and is retried by the caller.
- Fixed values: Monday schedule weekday `1`, `08:00`, `America/Chicago`. Undelivered alert after 30 minutes. Upload limit 1,048,576 bytes. Courier at 08:05 and 09:00 Central.
- New constants (decided here):
  - Lease touch every `30_000` ms; a run is stale after `120` s without a touch; SIGTERM drain cap `60_000` ms; Railway draining `90` s on `karbon-api`.
  - Internal API: path prefix `/v1/`, request body limit `512kb`, response size limit `4mb` (a preview PDF is at most 1,048,576 bytes before base64).
  - MCP-to-API client timeout `120_000` ms per call, except `runScheduleNow` at `600_000` ms. On timeout or transport error the tool returns `{ ok: false, code: "core_unavailable" }`.
  - `INTERNAL_API_TOKEN` at least 32 characters, Keychain item `karbon-dashboards` / `internal-api`.

## Review Focus

1. **Redeploy of `karbon-api` while the old process is mid-run at 08:00:** the new process must not re-run it, and the run must end exactly once. Test in Task 1 ("a live lease blocks a second process").
2. **Old `karbon-api` process killed mid-run (Railway SIGKILL after drain):** the new process re-runs it once, about 2 minutes later, not never. Test in Task 1 ("a lapsed lease is recovered once").
3. **`karbon-api` is down, slow or mid-redeploy when Claude calls a tool:** the tool returns `core_unavailable` with no URL, stack or token in the text; a scheduled run already started on the API is unaffected and finishes. Test in Task 3 ("API down returns core_unavailable", "a timeout returns core_unavailable").
4. **`karbon-mcp` started with warehouse credentials or a database URL in its environment** (a copy-paste of variables between services): it must refuse to start and name the variable, never its value. Test in Task 3 ("mcp server refuses warehouse and database variables").
5. **Something else on the private network calls the API:** no token, a wrong token, or a method name outside the `CoreApi` list each get a bare `401` or `404`, and nothing is executed. Test in Task 3 ("internal API rejects missing and wrong tokens", "unknown method is 404").

---
### Task 1: Run lease (exactly-once across overlapping deploys)

**Files:**

- Create: `src/schedule/lease.ts`
- Modify: `src/store/db.ts` (schema, `Store` type, `claimRun`, `recoverInterrupted`, new `touchRun`)
- Modify: `src/schedule/ticker.ts` (first-tick sweep, wrap `execute`)
- Modify: `src/core/api.ts:290-299` (`runScheduleNow` wraps execution)
- Test: `test/schedule/lease.test.ts` (new), `test/store/db.test.ts`, `test/schedule/ticker.test.ts`

**Interfaces:**

- Produces:
  - `Store.touchRun(runId: number, now: Date): Promise<void>` sets `heartbeat_at` on a `running` row only.
  - `Store.recoverInterrupted(now: Date, staleSec?: number): Promise<number>`. The default `staleSec` is `120`. It marks `running` rows interrupted whose `COALESCE(heartbeat_at, started_at) < now - staleSec`. **The parameter changes from minutes to seconds**, and there is one production caller (the ticker).
  - `claimRun` (insert and re-claim) also sets `heartbeat_at = now`.
  - `withLease<T>(store: Store, runId: number, fn: () => Promise<T>, opts?: { everyMs?: number; now?: () => Date }): Promise<T>` in `src/schedule/lease.ts`. It touches every `everyMs` (default `30_000`) until `fn` settles, then clears the timer. Touch errors are swallowed.
  - Exported constants `LEASE_TOUCH_MS = 30_000` and `LEASE_STALE_SEC = 120` from `lease.ts`.

- [ ] **Step 1: Write the failing tests**

`test/store/db.test.ts`: replace the body of "recoverInterrupted leaves young runs; finished runs are never re-claimed" so that "young" means touched recently:

```ts
const run = await s.claimRun(id, "2026-10-19", T)!;
expect(await s.recoverInterrupted(new Date(T.getTime() + 90_000))).toBe(0); // 90 s < 120 s
await s.touchRun(run, new Date(T.getTime() + 100_000));
expect(await s.recoverInterrupted(new Date(T.getTime() + 200_000))).toBe(0); // touched 100 s ago
expect(await s.recoverInterrupted(new Date(T.getTime() + 221_000))).toBe(1); // 121 s since touch
```

Add "touchRun never revives a finished run": finish the run as `produced`, call `touchRun`, then `recoverInterrupted(T + 1 h)` → `0`. `listRuns(1)[0].status` → `produced`.

`test/schedule/lease.test.ts` (fake timers via `vi.useFakeTimers()`):

- "withLease touches every 30 s until fn settles": `fn` resolves after `vi.advanceTimersByTimeAsync(95_000)`; the `touchRun` spy is called 3 times. After the promise settles, advancing another 60 s adds no calls.
- "a failing touch does not abort the run": `touchRun` rejects; `fn` resolves `"produced"`; `withLease` resolves `"produced"`.
- "withLease rethrows fn's error and still stops touching".

`test/schedule/ticker.test.ts`:

- Rewrite "restart within the scheduled minute runs once, not zero times". Process A claims at 13:00:00 and dies (no touches). Process B ticks at 13:02:30 → `runSpy` called once with period `2026-10-19`.
- New "a live lease blocks a second process". A claims at 13:00:00 and `touchRun` at 13:01:45. B ticks at 13:02:00 → `runSpy` not called, and the run is still `running`. A then calls `finishRun(produced)`. B ticks at 13:05:00 → `runSpy` still not called.
- New "a lapsed lease is recovered once". A claims at 13:00, touches at 13:00:30, dies. B ticks at 13:02:00 (no run), then at 13:02:31 (one run), then at 13:03:00 (still one run in total).
- New "a long run that keeps touching is never swept". Set up a first tick at 12:00. Claim a manual period `manual-2026-10-19T13:00:00.000Z`. `touchRun` at 13:19:40. Tick at 13:20 → no notice is added (`pendingFiles()` is empty) and the status stays `running`.
- Rewrite "a later tick leaves a young running run alone" to add `touchRun(id, 13:19:40)` before the 13:20 tick.
- New "a store outage at 08:00 is retried on the next tick": `listSchedules` works but `claimRun` rejects once (`mockRejectedValueOnce`) at 13:00:30 → one `run_failed` alert. The next tick at 13:01:30 claims the period → `runSpy` called once with `2026-10-19`.

- [ ] **Step 2: Run them and confirm they fail**

Run: `npx vitest run test/store/db.test.ts test/schedule/lease.test.ts test/schedule/ticker.test.ts`
Expected: FAIL. Errors are `touchRun is not a function` and a missing `../../src/schedule/lease.js`, and "a live lease blocks a second process" fails because the age-0 first-tick sweep re-runs it.

- [ ] **Step 3: Implement**
  - `db.ts`: append `ALTER TABLE runs ADD COLUMN IF NOT EXISTS heartbeat_at timestamptz` to `SCHEMA` and bump `SCHEMA_VERSION` to `2`. Add `touchRun` (`UPDATE runs SET heartbeat_at = $2 WHERE id = $1 AND status = 'running'`). Set `heartbeat_at` in both `claimRun` statements. Change `recoverInterrupted` to the seconds signature above.
  - `lease.ts`: `withLease` per the interface.
  - `ticker.ts`: drop the `first ? 0 : 15` logic and its comment. Every tick calls `store.recoverInterrupted(now)` with the default. Wrap `execute(s, runId, periodKey, runDeps)` in `withLease(store, runId, () => …, { now: () => new Date() })`. The touch must use the wall clock, not the tick's frozen `now`.
  - `api.ts` `runScheduleNow`: wrap `executeScheduledRun(...)` in `withLease(store, runId, …, { now: deps.now })`.

- [ ] **Step 4: Run the whole suite**

Run: `npm test && npm run build`
Expected: every test passes (231 + the new ones), and `tsc` exits 0.

- [ ] **Step 5: Commit**

```bash
git add src/schedule/lease.ts src/store/db.ts src/schedule/ticker.ts src/core/api.ts test/schedule/lease.test.ts test/store/db.test.ts test/schedule/ticker.test.ts
git commit -m "fix(schedule): heartbeat lease so an overlapping deploy runs a period once"
```

---

### Task 2: Drain an in-flight tick on SIGTERM

**Files:**

- Modify: `src/schedule/ticker.ts` (`stop`)
- Modify: `src/core/api.ts:336,381-397` (`Core.startTicker` type, `close`)
- Modify: `src/server.ts` (`shutdown`)
- Test: `test/schedule/ticker.test.ts`

**Interfaces:**

- Consumes: `startTicker` from Task 1.
- Produces:
  - `startTicker(...).stop(): Promise<void>` clears the interval and resolves when any in-flight `tickOnce` has finished. Existing un-awaited `t.stop()` calls in tests stay valid.
  - `Core.startTicker(): { active: boolean; stop(): Promise<void> }`.
  - `Core.close()` awaits every ticker's `stop()` before closing the store.

- [ ] **Step 1: Write the failing test** "stop waits for the in-flight run". `runSpy` awaits a deferred promise. Start `tickOnce()` without awaiting it, then call `const stopped = t.stop()`. Assert `stopped` has not resolved after a microtask flush. Resolve the deferred. `await stopped`, then assert the run's status is `produced`.

- [ ] **Step 2: Run it and confirm it fails.** Run `npx vitest run test/schedule/ticker.test.ts -t "stop waits"`. Expected: FAIL, because `stop` returns `undefined`.

- [ ] **Step 3: Implement.** The ticker keeps the current tick's promise and `stop` returns it (or a resolved promise). In `server.ts` `shutdown`, run `await Promise.race([ticker.stop(), sleep(60_000)])` before `http.close()` and `core.close()`. Keep `process.exit(0)` last.

- [ ] **Step 4: Run** `npm test && npm run build`. Expected: all tests pass and `tsc` exits 0.

- [ ] **Step 5: Commit**

```bash
git add src/schedule/ticker.ts src/core/api.ts src/server.ts test/schedule/ticker.test.ts
git commit -m "fix(server): wait up to 60 s for an in-flight run on SIGTERM"
```

---

### Task 3: Split the core API and the MCP layer into two processes

**Files:**

- Create: `src/api/http.ts` (internal API app), `src/api/client.ts` (HTTP client implementing `CoreApi`), `src/api-server.ts` (entry for `karbon-api`), `src/mcp-server.ts` (entry for `karbon-mcp`)
- Modify: `src/core/api.ts:61,196` (`listMenu` becomes async), `src/mcp/tools.ts:56` (`await api.listMenu()`), `src/server.ts` (header comment: local all-in-one only, not deployed), `package.json` (scripts)
- Test: `test/api/http.test.ts`, `test/api/client.test.ts`, `test/api/contract.test.ts`, `test/mcp-server.test.ts` (all new); `test/core/api.test.ts:45-46`, `test/mcp/tools.test.ts:131`, `test/http.test.ts:18` (async `listMenu`)

**Interfaces:**

- Consumes: `CoreApi` and `createCore(env)` from `src/core/api.ts`; `createApp(api, env, opts)` from `src/http.ts` (unchanged: it already takes any `CoreApi`); `Core.startTicker().stop(): Promise<void>` from Task 2.
- Produces:
  - `CoreApi.listMenu(): Promise<Menu>`. **Signature change**: every method on `CoreApi` is now async, so an HTTP client can implement the whole interface.
  - `CORE_METHODS: readonly (keyof CoreApi)[]` in `src/api/http.ts`, listing all 14 methods. It is the allowlist for the wire.
  - `createApiApp(api: CoreApi, env: { INTERNAL_API_TOKEN?: string }, opts?: { log?: (e: LogEvent) => void }): express.Express`. Routes:
    - `GET /health` returns `ok`, with no auth (Railway's health check).
    - `POST /v1/:method` with body `{ "args": unknown[] }` (positional, in the `CoreApi` signature's order) returns `200 { "result": <value> }`. A domain failure (`{ ok: false, code, detail }`) is a normal `result`.
    - Missing or wrong `Authorization: Bearer <INTERNAL_API_TOKEN>` returns `401` with an empty body. A method not in `CORE_METHODS` returns `404` with an empty body. Anything else returns `500 { "error": "internal" }`, with no message and no stack.
    - Token compare is constant-time, using the same digest-then-`timingSafeEqual` as `src/http.ts`. `createApiApp` throws if the token is shorter than 32 characters.
  - `createHttpCoreApi(opts: { baseUrl: string; token: string; fetch?: typeof fetch; timeoutMs?: number; longTimeoutMs?: number }): CoreApi`. Each method POSTs to `${baseUrl}/v1/<name>`. Defaults: `timeoutMs` `120_000`; `longTimeoutMs` `600_000`, used by `runScheduleNow`. Timeout, network error, non-200, or an unparseable body all resolve to `{ ok: false, code: "core_unavailable", detail: "core API unavailable" }`. For the methods that return a list (`listSchedules`, `listRuns`, `listPendingFiles`) and for `listMenu`/`getDeliveryTargets`, it **throws** instead, so the existing tool guard turns it into `internal`. The client never puts `baseUrl` or the token in a returned value or an error message.
  - `src/api-server.ts`: checks `INTERNAL_API_TOKEN` length before opening the store, then runs `createCore(process.env)`, `createApiApp(core.api, env)`, `listen(port, "::")` (dual stack) and `core.startTicker()`. `PORT` default `8080`. SIGTERM uses the Task 2 drain: `await Promise.race([ticker.stop(), sleep(60_000)])`, then `http.close()`, `core.close()`, `process.exit(0)`.
  - `src/mcp-server.ts`:
    - At startup it fails fast, exiting 1, if any of `KARBON_SF_USER`, `KARBON_SF_PASSWORD`, `DATABASE_URL`, `DATABASE_CA_CERT`, `POSTGRES_PASSWORD` is set (naming the variable only). It also exits if `MCP_BEARER_TOKEN` or `INTERNAL_API_TOKEN` is under 32 characters, or `CORE_API_URL` is not an `http://` or `https://` URL.
    - It then runs `createApp(createHttpCoreApi({ baseUrl: CORE_API_URL, token: INTERNAL_API_TOKEN }), env)` and `listen(PORT ?? 8787)`. SIGTERM closes the HTTP server and exits. It never imports `src/core/api.ts` or `src/data/snowflake.ts`.
  - `package.json` scripts: `"start:api": "node dist/api-server.js"`, `"start:mcp": "node dist/mcp-server.js"`. `"start"` stays `node dist/server.js` (local all-in-one).

- [ ] **Step 1: Write the failing tests**

`test/api/http.test.ts` (supertest against `createApiApp` with a `vi.fn()` `CoreApi`, as in `test/http.test.ts`):

- "internal API rejects missing and wrong tokens": no header returns `401` with an empty body; `Bearer wrong` returns `401`; the spy was not called.
- "unknown method is 404": `POST /v1/close` and `POST /v1/__proto__` with a valid token return `404`, and nothing is called.
- "a call passes positional args and returns the result": `POST /v1/pauseSchedule` `{ args: [7, true] }` calls `pauseSchedule(7, true)` and returns `{ result: { ok: true } }`.
- "a domain failure is a 200 result": `ask` resolves `{ ok: false, code: "guard", detail: "rejected" }`; the response is `200` with that `result`.
- "a thrown error is a bare 500": `listRuns` rejects with `new Error("SELECT secret FROM x")`; the response is `500 { error: "internal" }` and the body does not contain `SELECT`.
- "health needs no token": `GET /health` returns `200 ok`.
- "short token refuses to build": `createApiApp(api, { INTERNAL_API_TOKEN: "x".repeat(31) })` throws `/INTERNAL_API_TOKEN/`.

`test/api/client.test.ts` (inject a fake `fetch`):

- "sends bearer and args": `pauseSchedule(3, false)` produces one request to `http://core.test/v1/pauseSchedule`, with header `authorization: Bearer <token>` and body `{"args":[3,false]}`.
- "API down returns core_unavailable": the fake `fetch` rejects with `TypeError("fetch failed")`. `ask({})` resolves `{ ok: false, code: "core_unavailable" }`, and `JSON.stringify` of the result contains neither `core.test` nor the token.
- "a timeout returns core_unavailable": with `vi.useFakeTimers()`, the fake `fetch` never resolves, `timeoutMs: 1_000`; after advancing 1_001 ms, `previewDashboard` resolves `core_unavailable`.
- "runScheduleNow uses the long timeout": with `timeoutMs: 1_000, longTimeoutMs: 5_000` it is still pending at 1_001 ms and resolves `core_unavailable` at 5_001 ms.
- "a list call that fails throws": `listSchedules` with a `500` response rejects, and the error message contains neither `core.test` nor the token.

`test/api/contract.test.ts`:

- "the HTTP path matches the in-process path". Build the real synthetic core (`createCore({ DATA_MODE: "synthetic", ALLOW_SYNTHETIC_SCHEDULES: "1", INTERNAL_API_TOKEN: … })`, PGlite store). Serve `createApiApp(core.api, …)` on an ephemeral port. Point `createHttpCoreApi` at it. For `listMenu`, `ask(OPEN_WORK_REQUESTS.totals)`, `createSchedule(…)`, `listSchedules`, `previewDashboard(…)` (compare `bytes` and `filled`, not the PDF bytes), `listRuns(5)`, `listPendingFiles`, `getDeliveryTargets`, the client's result deep-equals the in-process `core.api` result. Close everything in `afterAll`.
- "registerTools over the HTTP client": run the `get_menu`/`list_menu` and `ask_question` tool handlers from `test/mcp/tools.test.ts`'s helper against the HTTP client. Each returns the same `structuredContent` as against `core.api`.

`test/mcp-server.test.ts` (spawn `npx tsx src/mcp-server.ts` with `env` built explicitly, not inherited; 10 s timeout):

- "mcp server refuses warehouse and database variables": for each of the five names, the process exits `1`, stderr names the variable, and stderr does not contain the value (`"s3cr3t-value"`).
- "mcp server starts with only its own variables": with `MCP_BEARER_TOKEN`, `INTERNAL_API_TOKEN`, `CORE_API_URL=http://127.0.0.1:9`, `PORT=8798`, `GET /health` returns `ok` within 5 s. Kill the process afterwards.

- [ ] **Step 2: Run them and confirm they fail**

Run: `npx vitest run test/api test/mcp-server.test.ts`
Expected: FAIL, because `src/api/http.js`, `src/api/client.js` and `src/mcp-server.ts` do not exist.

- [ ] **Step 3: Implement** per the Interfaces block.
  - `listMenu` becomes `async` in `api.ts`; update the three test files and `tools.ts:56` to `await`. Arguments travel as JSON, so they are only plain data. Every argument is already validated by zod inside `CoreApi` (it receives `unknown` from the MCP tools today), so the API adds no second schema.
  - Route lookup uses `CORE_METHODS.includes(name)` on the raw path segment, then calls `api[name](...args)`, with `args` defaulting to `[]` when it is not an array. Never index `api` with an unchecked string.
  - `express.json({ limit: "512kb" })` only after auth.

- [ ] **Step 4: Run the whole suite**

Run: `npm test && npm run build && ls dist/api-server.js dist/mcp-server.js dist/server.js`
Expected: every test passes, `tsc` exits 0, and all three entries exist.

- [ ] **Step 5: Local two-process check**

```bash
export INTERNAL_API_TOKEN=$(openssl rand -base64 48) MCP_BEARER_TOKEN=$(openssl rand -base64 48)
PORT=8080 DATA_MODE=synthetic node dist/api-server.js & sleep 2
PORT=8787 CORE_API_URL=http://localhost:8080 node dist/mcp-server.js & sleep 2
curl -s localhost:8787/health; curl -s -o /dev/null -w '%{http_code}\n' -X POST localhost:8787/mcp
curl -s -o /dev/null -w '%{http_code}\n' -X POST localhost:8080/v1/listMenu
kill %1 %2; unset INTERNAL_API_TOKEN MCP_BEARER_TOKEN
```

Expected: `ok`, `401` (MCP without bearer), `401` (API without internal token).

- [ ] **Step 6: Docs.** In `docs/deploy.md`:
  - Replace the single-service variable table with the per-service table from Global Constraints.
  - Add "Local run" with both commands from Step 5, plus the all-in-one `npm start` for quick use from Claude Code on the Mac.
  - Add one line to `docs/build-ledger-2026-10-16.md`: "Ruling 2026-10-17: two services (karbon-api private, karbon-mcp public); spec §4.7 builder's call."

- [ ] **Step 7: Commit**

```bash
git add src/api/http.ts src/api/client.ts src/api-server.ts src/mcp-server.ts src/core/api.ts src/mcp/tools.ts src/server.ts package.json test/api test/mcp-server.test.ts test/core/api.test.ts test/mcp/tools.test.ts test/http.test.ts docs/deploy.md docs/build-ledger-2026-10-16.md
git commit -m "feat: split core API (private) and MCP layer (public) into two processes"
```

---

### Task 4: Database backups and a restore check

No code. The Postgres volume is ours to back up (`docs/deploy.md`, "State store", item 6).

- [ ] **Step 1:** Turn on Railway volume backups for `postgres-data` (dashboard → `postgres` → Backups, daily, keep at least 7). If the plan tier has none, add a Railway cron service running `pg_dump` over the private network into a Railway bucket, declare it in `.railway/railway.ts` (Task 5), and record which one was chosen in `docs/deploy.md`.
- [ ] **Step 2: Restore check.** After Task 6 has written rows, restore the latest backup into a scratch environment (`railway environment new restore-check --duplicate production`, then restore there). Expected: `list_schedules` through that environment's `karbon-mcp` shows the same schedules. Delete `restore-check` afterwards.
- [ ] **Step 3:** Record the backup schedule and the restore result in `docs/deploy.md`. Commit `docs(deploy): Postgres backups and restore check`.

---

### Task 5: Railway Infrastructure as Code for both services, and deploy notes

**Files:**

- Create: `.railway/railway.ts` (and the `.railway/README.md` the CLI generates), `.railwayignore`
- Modify: `package.json` (`"engines": { "node": "22.x" }`; devDependency `railway`)
- Modify: `docs/deploy.md`

- [ ] **Step 1: Confirm the current DSL.** Use the `use-railway` skill or `mcp__plugin_railway_railway__fetch-docs` on `infrastructure-as-code/reference` and `infrastructure-as-code`. Expected: `service(name, { build, start, healthcheck, healthcheckTimeout, replicas, env, domains })`, `postgres(name)`, `volume(name, …)`, `preserve()` and `<svc>.env.RAILWAY_PRIVATE_DOMAIN` exist under those names. If the spelling has changed, use what the doc says. **Check whether the DSL has a draining or teardown field.** As of 2026-10-17 the reference documents none.

- [ ] **Step 2: Import before authoring.** Run `npm i -D railway` and `railway link` (project and environment above). Then run `railway config pull`. Expected: `.railway/railway.ts` now declares `postgres` and its volume exactly as they exist, with secrets as `preserve()`. Run `railway config plan`. Expected: `Your Railway configuration is already up to date.` Do not continue until this shows no changes.

- [ ] **Step 3: Rename and add services in the file.**
  - Rename the imported app service to `karbon-api`:
    - `build: "npm ci && npm run build"`, `start: "npm run start:api"`, `healthcheck: "/health"`, `replicas: 1`.
    - No `domains`.
    - `env`: `DATABASE_URL` and `DATABASE_CA_CERT` as imported, plus `INTERNAL_API_TOKEN: preserve()`, `ALERT_WEBHOOK_URL: preserve()`, `HEARTBEAT_URL: preserve()`, `DATA_MODE: "synthetic"`, `ALLOW_SYNTHETIC_SCHEDULES: "1"`.
  - Add `karbon-mcp`:
    - Same `build`, `start: "npm run start:mcp"`, `healthcheck: "/health"`, `replicas: 1`.
    - `env`: `MCP_BEARER_TOKEN: preserve()`, `INTERNAL_API_TOKEN: preserve()`, ``CORE_API_URL: `http://${api.env.RAILWAY_PRIVATE_DOMAIN}:${api.env.PORT}` `` (or the DSL's documented way to compose a reference, per Step 1), `TRUST_PROXY_HOPS: "1"`.
  - Run `railway config plan`. Expected: `1 to add` (`karbon-mcp`) and changes to the app service only (its name, commands and variables). **Zero deletes.** If the plan shows any delete, stop and fix the file.
  - If the rename shows as delete-and-create, keep the name `karbon-dashboards` for the API service instead, so its variables and ID survive. Then use that name in every `CORE_API_URL` reference and in the rest of this plan.

- [ ] **Step 4: Settings the DSL does not cover.** For `karbon-api`, set draining to `90` seconds in the service settings (dashboard → Settings → Deploy, or `mcp__plugin_railway_railway__update-service` if it exposes the field). Expected: `mcp__plugin_railway_railway__get-service-config` on `karbon-api` shows draining `90`. Record in `docs/deploy.md` that this setting lives outside `.railway/railway.ts`.

- [ ] **Step 5:** Write `.railwayignore`: `node_modules`, `dist`, `state`, `test`, `.env*`, `*.sqlite`, `.claude`, `.serena`, `.superpowers`, `snowflake.log`. Keep `config/` deployed, because `src/config.ts` reads `../config/*.json` relative to `dist/`. Keep `.railway/` in git but out of the upload (add `.railway` to `.railwayignore`), since Railway does not read it during deploys.

- [ ] **Step 6: Verify the bundle locally.** Repeat Task 3, Step 5 from a clean `rm -rf dist && npm ci && npm run build`. Expected: the same three results.

- [ ] **Step 7: Update `docs/deploy.md`.**
  - Add a "Deploy timing" note: overlapping `karbon-api` deploys are safe from this change on (lease plus drain), so the Monday 07:45–08:30 rule is retired. `karbon-mcp` deploys are always safe.
  - Add "Infrastructure as Code": `railway config plan` before every `apply`, never apply a plan with a delete, and draining is set outside the file (Step 4).
  - Add "Rotate":
    - the bearer: new Keychain value, then set on `karbon-mcp`.
    - `INTERNAL_API_TOKEN`: new Keychain value, set on **both** services with `skipDeploys`, then redeploy `karbon-api` first and `karbon-mcp` straight after.
    - the Postgres password: `ALTER ROLE karbon PASSWORD …` over `railway ssh`, then set `POSTGRES_PASSWORD` through the CLI; `DATABASE_URL` follows by reference.
    - the Karbon password: a `karbon-api` variable only.

- [ ] **Step 8: Apply and commit.** Run `railway config apply` (interactive; read the plan again). Expected: `karbon-mcp` exists, and `mcp__plugin_railway_railway__list-services` shows `karbon-api`, `karbon-mcp` and `postgres`.

```bash
git add .railway/railway.ts .railway/README.md .railwayignore package.json package-lock.json docs/deploy.md
git commit -m "chore(deploy): Railway IaC for karbon-api (private) and karbon-mcp (public)"
```

---

### Task 6: Synthetic deploy on Railway and the acceptance checks that need no Karbon data

Run from the repo root on `feat/go-live` after Tasks 1–5. Secrets are set with the pipe-to-CLI method below, so no value enters the session. Non-secret variables come from `.railway/railway.ts`.

- [ ] **Step 1: Set secrets.**
  - `INTERNAL_API_TOKEN`: `security add-generic-password -U -s karbon-dashboards -a internal-api -w "$(openssl rand -base64 48)"`, then set it on **both** `karbon-api` and `karbon-mcp` from `security find-generic-password -s karbon-dashboards -a internal-api -w`, piped through `railway variables --service <name> --set`.
  - `MCP_BEARER_TOKEN`: the same way, under Keychain account `mcp-bearer`, on `karbon-mcp` only.
  - `ALERT_WEBHOOK_URL` on `karbon-api`: the channel Marcus chooses. **Ask him.**
  - `HEARTBEAT_URL` on `karbon-api`: a Healthchecks-style check, period 1 week, due Mondays 08:30 America/Chicago. **Ask Marcus to create it.**

  Expected: `list-variables` on `karbon-api` shows `DATABASE_URL`, `DATABASE_CA_CERT`, `INTERNAL_API_TOKEN`, `ALERT_WEBHOOK_URL`, `HEARTBEAT_URL`, `DATA_MODE`, `ALLOW_SYNTHETIC_SCHEDULES` and no `MCP_BEARER_TOKEN`. On `karbon-mcp` it shows `MCP_BEARER_TOKEN`, `INTERNAL_API_TOKEN`, `CORE_API_URL`, `TRUST_PROXY_HOPS` and **no** `KARBON_SF_*`, `DATABASE_*` or `POSTGRES_*`. Check names only.

- [ ] **Step 2: Deploy, API first.**
  1. `railway up --service karbon-api --detach`. Expected: `SUCCESS`. The logs show `listening` on port `8080` with no `state: in-memory` and no `state store unavailable` line (it opened the private Postgres over verified TLS).
  2. `railway up --service karbon-mcp --detach`. Expected: `SUCCESS`, and `listening`.
  3. Run `mcp__plugin_railway_railway__generate-domain` for **`karbon-mcp` only**.
  4. Run `list-domains` for `karbon-api`. Expected: no public domain.

- [ ] **Step 3: Endpoint checks (§8.7).**
  - `curl -s -o /dev/null -w '%{http_code}' -X POST https://<mcp-domain>/mcp` → `401`.
  - `curl -s https://<mcp-domain>/health` → `ok`.
  - **The API is not public:** `karbon-api` has no domain (Step 2), and `curl -s -m 5 http://karbon-api.railway.internal:8080/health` from the Mac fails to resolve.
  - **The private hop works:** `railway ssh --service karbon-mcp`, then `curl -s -o /dev/null -w '%{http_code}' -X POST "$CORE_API_URL/v1/listMenu"`. Expected: `401` (reachable, but rejected without the internal token). Exit.
  - Set the `.mcp.json` URL to `https://<mcp-domain>/mcp` (header placeholder `${MCP_BEARER_TOKEN}` only). Run `scripts/dev-env.sh claude`, then `get_menu`, which should succeed, so the whole chain Claude → MCP → API works. Run the leak check in `docs/deploy.md` "Connect Claude Code", step 4. Expected: `clean:` for both files (§8.8).
  - `TRUST_PROXY_HOPS` on `karbon-mcp`: send 3 unauthenticated requests and read the `rejected` log lines. If the logged or keyed client address is a Railway-internal address rather than the Mac's public IP, set `TRUST_PROXY_HOPS` to the hop count Railway's docs give. This settles the deferred Task 10 item.

- [ ] **Step 4: Redeploy during the scheduled minute (§8.4).** Through Claude Code, create a synthetic schedule `deploy-overlap-test` whose cadence is today's weekday at a time 6 minutes ahead (America/Chicago). One minute before that time, run `railway up --service karbon-api --detach` again. Expected afterwards: `list_runs` shows exactly one run for that period with status `produced`; `list_pending_files` shows one `SYNTHETIC-…pdf` and one `SYNTHETIC-…totals.json`; the logs show no second claim.

- [ ] **Step 5: MCP restart does not touch runs.** Start `run_schedule_now` on `deploy-overlap-test` from Claude Code, and within 10 s run `railway up --service karbon-mcp --detach`. Expected: the Claude call returns `core_unavailable` or a connection error. `list_runs`, after the MCP is back, shows the run finished once (`produced`), not twice and not `interrupted`.

- [ ] **Step 6: Undelivered alert and courier idempotence (§8.4).** Leave the files undelivered for 31 minutes. Expected: one `undelivered` alert per file reaches `ALERT_WEBHOOK_URL`, and no repeat on later ticks. Then run `docs/courier-prompt.md` by hand in Claude Code (Marcus's Microsoft 365 connector), twice. Expected: the first run reports `2 uploaded` (or more if Step 5 added files); the second reports `0 uploaded, 0 already present, 0 failed` and creates nothing new in OneDrive. Delete `deploy-overlap-test` (this cascades to its runs and files) and the uploaded `SYNTHETIC-` files.

- [ ] **Step 7: Logs (§8.3).** Force one rejection: `preview_dashboard` with a layout containing a made-up client name from the synthetic set. Read the logs of **both** services. Expected: reason codes only, with no layout text and no values in `karbon-api`'s logs, and nothing but auth and request lines in `karbon-mcp`'s.

- [ ] **Step 8: Record the results** in `docs/deploy.md` (a new "Railway acceptance log" table: date, check, result). Commit `docs(deploy): synthetic Railway acceptance log`.

---

### Task 7: Gates and live readiness (Marcus, with Chris for G2)

Each step is a person's action. The agent prepares the commands and waits.

- [ ] **Step 1: G2 (Chris).** Put the decision to Chris: the Karbon warehouse password and the state database (operational totals) on Marcus's own Railway account, instead of firm-owned accounts as the spec requires. Tell him the password sits only in the private `karbon-api` service, which has no public address. Record his answer in `docs/deploy.md`. **If he refuses:** either move everything to firm-owned accounts (create them, `railway config apply` the same `.railway/railway.ts` there, rerun Task 6, Steps 1–3), or fall back to the Cloud PC (spec §9). Stop this plan until one of those is chosen.
- [ ] **Step 2: G5 labels.** In Snowsight (never through Claude), Marcus runs the three statements in `docs/label-review.md` and records an outcome for every value in `config/labels.json`, with date and reviewer. Any value that names or implies a client gets `alias` or `other`. He also reviews `config/generic-words.json`. Verify with `npm test` (config tests pass) and the pre-commit diff scan. Commit `chore(config): reviewed labels (G5)`.
- [ ] **Step 3: Session time zone.** `SHOW PARAMETERS LIKE 'TIMEZONE'` in Snowsight; record it in `docs/deploy.md` "Session time zone".
- [ ] **Step 4: Live reconciliation (§8.1)** per `docs/deploy.md` "Reconciliation log", steps 2–3. Within one hour, run `scripts/dev-env.sh npm run reconcile` and Snowsight query D (copied, never retyped). Expected: the rows match as that section defines. Fill in the log row.
- [ ] **Step 5: Live name-check positive test**, per `docs/deploy.md` "Reconciliation log", step 5. Expected: `LIVE=1 scripts/dev-env.sh npx vitest run test/live` shows both "scores > 0" tests passing, not skipped. A failure blocks every step below.
- [ ] **Step 6: Switch `karbon-api` to live.**
  1. Set `KARBON_SF_USER` and `KARBON_SF_PASSWORD` on **`karbon-api` only**, from the Keychain, using the pipe-to-CLI method from Task 6, Step 1.
  2. In `.railway/railway.ts`, set `DATA_MODE: "live"` and remove `ALLOW_SYNTHETIC_SCHEDULES` (add both `KARBON_SF_*` as `preserve()`).
  3. Run `railway config plan`. Expected: changes to `karbon-api` variables only, with zero deletes of resources.
  4. Apply, then deploy `karbon-api`, avoiding Monday 07:45–08:30 Central.

  Expected: the logs show `listening` with `dataMode: "live"`, and no "scheduling off" line. `ask_question` with `OPEN_WORK_REQUESTS.totals` through `karbon-mcp` returns `ok`, with totals in line with Step 4. `list-variables` on `karbon-mcp` still shows no `KARBON_SF_*`.

- [ ] **Step 7: Commit** `.railway/railway.ts` and `docs(deploy): G2 decision, time zone, reconciliation`.

---

### Task 8: Verify the courier route (§4.8, "verify before relying on it")

- [ ] **Step 1:** Under the **firm** Claude account (G3), check whether a scheduled task (a Claude Code cloud routine, or a claude.ai scheduled task) can use both the Microsoft 365 connector and a custom connector to `https://<mcp-domain>/mcp` with the bearer header.
- [ ] **Step 2:** Record it in a new `docs/courier-verification.md`: the feature used, how the custom connector authenticates, and whether the bearer header works (yes/no, with the date). **If the connector requires OAuth, stop and raise it with Marcus.** OAuth on the MCP layer is a separate plan. It would live in `karbon-mcp` only, with no change to `karbon-api`. Monday delivery stays manual (Task 9, Step 3) until it ships.
- [ ] **Step 3: Commit** `docs: courier route verification`.

---

### Task 9: The real schedule and the first Monday by hand

- [ ] **Step 1: Create the schedule** through Claude Code: name `Open work by stage`, slug `open-work-by-stage`, cadence weekday `1` `08:00` `America/Chicago`, requests `OPEN_WORK_REQUESTS`. Layout per §4.5: tiles for active jobs, past due (with share), stuck over 30 days and budgeted hours, each with change; a bar chart of jobs by primary status; the stage table sorted by stuck over 30 days. Run `preview_dashboard` first. Expected: the preview passes every check; `list_schedules` shows one schedule.
- [ ] **Step 2: Warehouse refresh timing.** On the first live Monday, run `scripts/dev-env.sh npm run reconcile` (`totals`) at about 07:30, 08:00 and 09:00 Central. Fill in the table in `docs/deploy.md`. If the figures change after 08:00, add the fixed notes line from that section to the layout with `update_schedule`.
- [ ] **Step 3: First Monday delivery by hand.** After 08:00 Central, Marcus runs `docs/courier-prompt.md` in Claude Code. Expected: one PDF and one `totals.json` in `Claude Dashboards/open-work-by-stage/`, neither with a `SYNTHETIC-` prefix. The heartbeat check shows a ping. The same morning, Marcus compares the PDF with Snowsight query D (§8.1).
- [ ] **Step 4: Week-over-week (§8.5)** on the second Monday. Expected: the tiles show a change, and the dashboard names the date it compared with.
- [ ] **Step 5: Commit** `docs(deploy): first Monday record`.

---

### Task 10: Switch on

- [ ] **Step 1: G6.** Once he is satisfied with the first real PDF, Marcus shares `Claude Dashboards` with Chris.
- [ ] **Step 2:** Create two scheduled courier tasks under the firm Claude account, at **Mondays 08:05** and **Mondays 09:00** `America/Chicago`, each with the text of `docs/courier-prompt.md` (route per Task 8). Expected on the next Monday: the 08:05 run reports the files uploaded; the 09:00 run reports `0 uploaded, 0 already present, 0 failed`; no `undelivered` alert arrives.
- [ ] **Step 3: POL-01 record (G3 follow-up, §9).** In `~/dev/cpa-consulting`, use its `changelog-capture` skill to add the POL-01 line describing this pipeline (two Railway services; warehouse credentials only in the private one) and its changelog entry.
- [ ] **Step 4: Commit** (this repo) `docs: go-live record`. Ask Marcus before merging `feat/go-live` to `main` or pushing.

---

## Out of scope (parked, unchanged)

The ledger's deferred items: M5–M8, the C1 second-login nit, the retry of deterministic SQL errors, the 500-run sweep limit, and courier detection of one missing schedule among several. None of them blocks a single Monday schedule. OAuth for claude.ai connectors is phase 2 (§4.11), unless Task 8 makes it necessary; when it comes, it is a `karbon-mcp` change only. Moving the services to a firm-owned Railway account is a `railway config apply` of the same `.railway/railway.ts` plus secrets, not a rebuild.
