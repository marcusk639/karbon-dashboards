# Karbon Dashboards Go-Live Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Take the built service from "tests pass on the Mac" to "the firm partner gets a checked open-work-by-stage PDF in OneDrive every Monday at 08:00 Central", meeting every acceptance item in spec §8.

**Architecture:** Two small code changes close the gaps that block the spec's acceptance criteria on Railway. The first is a heartbeat lease on runs, so a redeploy during the scheduled minute runs once (§8.4). The second is a drain on SIGTERM. State lives in a private Postgres service in the same Railway project, so Railway is the only new vendor for gate G2. TLS to it is fully verified (`DATABASE_CA_CERT`, done 2026-10-17). The service is deployed in synthetic mode first, so §8.3, §8.4, §8.7 and §8.8 are proven without the Karbon password. It switches to live only after gates G2 and G5 and the same-day reconciliation (§8.1). The courier route is verified before relying on it (§4.8). Then come the first Monday by hand and the switch-on. This plan replaces Tasks 12–13 of `docs/plans/2026-10-16-guarded-karbon-dashboards.md`.

**Tech Stack:** Node 22, TypeScript (ESM), vitest, `pg` + PGlite, Railway (app service with config as code, plus a private `postgres-ssl:17` service), Claude Code + Microsoft 365 connector (courier).

**Spec:** `docs/specs/2026-10-16-guarded-karbon-dashboards-design.md` (§ references point there). Operational reference: `docs/deploy.md`, `docs/courier-prompt.md`.

## Global Constraints

- Repo `~/dev/karbon-dashboards`; work on branch `feat/go-live` from `main` (`5b7b59c`). Stage files by name. Push nothing without the owner's say-so.
- **Before every commit:** `git diff --cached` contains no client names, no `eyJ….eyJ…` JWT, no PEM `BEGIN` line, no `password=`, no `postgresql://` URL. Tests use made-up names only.
- Secrets live only in Railway variables (production) and the macOS Keychain via `scripts/dev-env.sh` (Mac): `KARBON_SF_USER`, `KARBON_SF_PASSWORD`, `MCP_BEARER_TOKEN`, `ALERT_WEBHOOK_URL`, `HEARTBEAT_URL`, `POSTGRES_PASSWORD`. Never in a file, log, commit, test, image or `.mcp.json`. Never print a Railway variable's value into a session; list names only.
- Existing infrastructure (the owner's personal Railway account, his decision 2026-10-16):
  - Railway project `karbon-dashboards` `c6ebe4d5-7717-411e-a32f-c9560af74610`, environment `production` `c9d6f25c-d525-4843-9724-88f5ac4f240a`.
  - App service `karbon-dashboards` `02371543-1c9a-4d03-8cc1-e45876f06194` (no source yet). `DATABASE_URL` (reference variables, no `sslmode`) and `DATABASE_CA_CERT` are set.
  - Postgres service `postgres` `1c6c90b7-caf1-4662-b7c9-0fe6d13c1122`, image `ghcr.io/railwayapp-templates/postgres-ssl:17`, volume `postgres-data`, private network only (no TCP proxy). Details are in `docs/deploy.md` "State store (Railway Postgres)".
  - Neon project `small-butterfly-91907366` is no longer used. Delete it only when the owner says so.
- **Gate G2 still binds the Karbon password.** The spec puts the warehouse password on a _firm-owned_ Railway account approved by the firm partner. `KARBON_SF_USER`/`KARBON_SF_PASSWORD` are not set on Railway, and `DATA_MODE=live` is not set, until the firm partner has approved holding them where they will live (Task 6, Step 1).
- Railway runs **exactly one replica** (`numReplicas: 1`).
- **No deploy between 07:45 and 08:30 Central on Mondays** until Tasks 1–2 are deployed. After that the rule is retired (Task 4 updates `docs/deploy.md`).
- Fixed values: Monday schedule weekday `1`, `08:00`, `America/Chicago`. Undelivered alert after 30 minutes. Upload limit 1,048,576 bytes. Courier at 08:05 and 09:00 Central.
- New constants (decided here): lease touch every `30_000` ms; a run is stale after `120` s without a touch; SIGTERM drain cap `60_000` ms; Railway `drainingSeconds` `90`.

## Review Focus

1. **Redeploy while the old process is mid-run at 08:00:** the new process must not re-run it, and the run must end exactly once. Test in Task 1 ("a live lease blocks a second process").
2. **Old process killed mid-run (Railway SIGKILL after drain):** the new process re-runs it once, about 2 minutes later, not never. Test in Task 1 ("a lapsed lease is recovered once").
3. **A manual `run_schedule_now` that runs longer than 15 minutes:** it must not be marked interrupted while it is still alive (the old parked duplicate-notice bug). Test in Task 1 ("a long run that keeps touching is never swept").
4. **The database blips during a run, so `touchRun` throws:** the run carries on and finishes. A heartbeat failure never aborts a run. Test in Task 1 ("a failing touch does not abort the run").
5. **Postgres restarts across 08:00** (a redeploy of `postgres`, or a crash): the claim fails and alerts, then the first tick after it is back claims and runs the period once, so the miss is never silent. Test in Task 1 ("a store outage at 08:00 is retried on the next tick").

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

### Task 3: Database backups and a restore check

No code. The Postgres volume is ours to back up (`docs/deploy.md`, "State store", item 6).

- [ ] **Step 1:** Turn on Railway volume backups for `postgres-data` (dashboard → `postgres` → Backups, daily, keep at least 7). If the plan tier has none, add a Railway cron service running `pg_dump` over the private network into a Railway bucket, and record which one was chosen in `docs/deploy.md`.
- [ ] **Step 2: Restore check.** After Task 5 has written rows, restore the latest backup into a scratch environment (`railway environment new restore-check --duplicate production`, then restore there). Expected: `list_schedules` against the restored database shows the same schedules. Delete `restore-check` afterwards.
- [ ] **Step 3:** Record the backup schedule and the restore result in `docs/deploy.md`. Commit `docs(deploy): Postgres backups and restore check`.

---

### Task 4: Railway config as code and deploy notes

**Files:**

- Create: `railway.json`, `.railwayignore`
- Modify: `package.json` (`"engines": { "node": "22.x" }`)
- Modify: `docs/deploy.md`

- [ ] **Step 1: Confirm the current Railway config keys.** Use the `use-railway` skill, or `mcp__plugin_railway_railway__search-docs` with "config as code drainingSeconds numReplicas healthcheckPath". Expected: the doc names the keys used in Step 2, or their current spelling. Use whatever the doc says.

- [ ] **Step 2: Write `railway.json`:**
  - `build`: builder `RAILPACK` (or Railway's current default per Step 1); `buildCommand` `npm ci && npm run build`.
  - `deploy`: `startCommand` `npm start`; `healthcheckPath` `/health`; `restartPolicyType` `ON_FAILURE`; `numReplicas` `1`; `drainingSeconds` `90`.

  Write `.railwayignore`: `node_modules`, `dist`, `state`, `test`, `.env*`, `*.sqlite`, `.claude`, `.serena`, `.superpowers`, `snowflake.log`. Keep `config/` deployed, because `src/config.ts` reads `../config/*.json` relative to `dist/`.

- [ ] **Step 3: Verify the bundle locally.** Run `rm -rf dist && npm ci && npm run build && MCP_BEARER_TOKEN=$(openssl rand -base64 48) PORT=8799 node dist/server.js & sleep 3; curl -s localhost:8799/health; kill %1`. Expected: `ok`, and a `state: in-memory (synthetic)` log line.

- [ ] **Step 4: Update `docs/deploy.md`.**
  - Add a "Deploy timing" note: overlapping deploys are safe from this change on (lease plus drain), and the Monday 07:45–08:30 rule is retired.
  - Add "Rotate": the bearer (new Keychain value, then `set-variables`), the Postgres password (`ALTER ROLE karbon PASSWORD …` over `railway ssh`, then `POSTGRES_PASSWORD` set through the CLI; `DATABASE_URL` follows by reference), and the Karbon password (Railway variable only).

- [ ] **Step 5: Commit**

```bash
git add railway.json .railwayignore package.json package-lock.json docs/deploy.md
git commit -m "chore(deploy): Railway config as code, one replica, 90 s drain"
```

---

### Task 5: Synthetic deploy on Railway and the acceptance checks that need no Karbon data

Run from the repo root on `feat/go-live` after Tasks 1–4. Variables are set with `mcp__plugin_railway_railway__set-variables` (service `02371543-…`, environment `c9d6f25c-…`) and `skipDeploys: true`, then deployed once.

- [ ] **Step 1: Set variables.**
  - `MCP_BEARER_TOKEN`: generate with `openssl rand -base64 48` into the Keychain as `karbon-dashboards/mcp-bearer` (`security add-generic-password -U -s karbon-dashboards -a mcp-bearer -w "$(openssl rand -base64 48)"`), then set the Railway variable from `security find-generic-password … -w` piped through the `railway variables --set` CLI, so the value never enters the session.
  - `ALERT_WEBHOOK_URL`: the channel the owner chooses. **Ask him.**
  - `HEARTBEAT_URL`: a Healthchecks-style check, period 1 week, due Mondays 08:30 America/Chicago. **Ask the owner to create it.**
  - `DATA_MODE=synthetic`, `ALLOW_SYNTHETIC_SCHEDULES=1`.

  Expected: `list-variables` shows those names plus `DATABASE_URL`. Check names only.

- [ ] **Step 2: Deploy and get a domain.** Run `railway link` (project and service above), then `railway up --detach`, then `mcp__plugin_railway_railway__generate-domain`. Expected: the deployment is `SUCCESS`, and the logs show `listening` with no `state: in-memory` and no `state store unavailable` line (it opened the private Postgres over verified TLS).

- [ ] **Step 3: Endpoint checks (§8.7).**
  - `curl -s -o /dev/null -w '%{http_code}' -X POST https://<domain>/mcp` → `401`.
  - `curl -s https://<domain>/health` → `ok`.
  - Set the `.mcp.json` URL to `https://<domain>/mcp` (header placeholder `${MCP_BEARER_TOKEN}` only). Run `scripts/dev-env.sh claude`, then `get_menu`, which should succeed. Run the leak check in `docs/deploy.md` "Connect Claude Code", step 4. Expected: `clean:` for both files (§8.8).
  - `TRUST_PROXY_HOPS`: send 3 unauthenticated requests and read the `rejected` log lines. If the logged or keyed client address is a Railway-internal address rather than the Mac's public IP, set `TRUST_PROXY_HOPS` to the hop count Railway's docs give. This settles the deferred Task 10 item.

- [ ] **Step 4: Redeploy during the scheduled minute (§8.4).** Through Claude Code, create a synthetic schedule `deploy-overlap-test` whose cadence is today's weekday at a time 6 minutes ahead (America/Chicago). One minute before that time, run `railway up --detach` again. Expected afterwards: `list_runs` shows exactly one run for that period with status `produced`; `list_pending_files` shows one `SYNTHETIC-…pdf` and one `SYNTHETIC-…totals.json`; the logs show no second claim.

- [ ] **Step 5: Undelivered alert and courier idempotence (§8.4).** Leave those files undelivered for 31 minutes. Expected: one `undelivered` alert per file reaches `ALERT_WEBHOOK_URL`, and no repeat on later ticks. Then run `docs/courier-prompt.md` by hand in Claude Code (the owner's Microsoft 365 connector), twice. Expected: the first run reports `2 uploaded`; the second reports `0 uploaded, 0 already present, 0 failed` and creates nothing new in OneDrive. Delete `deploy-overlap-test` (this cascades to its runs and files) and the uploaded `SYNTHETIC-` files.

- [ ] **Step 6: Logs (§8.3).** Force one rejection: `preview_dashboard` with a layout containing a made-up client name from the synthetic set. Read the Railway logs. Expected: reason codes only, no layout text, no values.

- [ ] **Step 7: Record the results** in `docs/deploy.md` (a new "Railway acceptance log" table: date, check, result). Commit `docs(deploy): synthetic Railway acceptance log`.

---

### Task 6: Gates and live readiness (the owner, with the firm partner for G2)

Each step is a person's action. The agent prepares the commands and waits.

- [ ] **Step 1: G2 (the firm partner).** Put the decision to the firm partner: the Karbon warehouse password and the state database (operational totals) on the owner's own Railway account, instead of firm-owned accounts as the spec requires. Record his answer in `docs/deploy.md`. **If he refuses:** either move both to firm-owned accounts (create them, rerun Task 5, Steps 1–2 there), or fall back to the Cloud PC (spec §9). Stop this plan until one of those is chosen.
- [ ] **Step 2: G5 labels.** In Snowsight (never through Claude), the owner runs the three statements in `docs/label-review.md` and records an outcome for every value in `config/labels.json`, with date and reviewer. Any value that names or implies a client gets `alias` or `other`. He also reviews `config/generic-words.json`. Verify with `npm test` (config tests pass) and the pre-commit diff scan. Commit `chore(config): reviewed labels (G5)`.
- [ ] **Step 3: Session time zone.** `SHOW PARAMETERS LIKE 'TIMEZONE'` in Snowsight; record it in `docs/deploy.md` "Session time zone".
- [ ] **Step 4: Live reconciliation (§8.1)** per `docs/deploy.md` "Reconciliation log", steps 2–3. Within one hour, run `scripts/dev-env.sh npm run reconcile` and Snowsight query D (copied, never retyped). Expected: the rows match as that section defines. Fill in the log row.
- [ ] **Step 5: Live name-check positive test**, per `docs/deploy.md` "Reconciliation log", step 5. Expected: `LIVE=1 scripts/dev-env.sh npx vitest run test/live` shows both "scores > 0" tests passing, not skipped. A failure blocks every step below.
- [ ] **Step 6: Switch the service to live.** Set `KARBON_SF_USER` and `KARBON_SF_PASSWORD` from the Keychain using the same pipe-to-CLI method as Task 5, Step 1. Then set `DATA_MODE=live` and remove `ALLOW_SYNTHETIC_SCHEDULES`. Deploy, avoiding Monday 07:45–08:30 Central. Expected: the logs show `listening` with `dataMode: "live"`, with no "scheduling off" line, and `ask_question` with `OPEN_WORK_REQUESTS.totals` returns `ok` with totals in line with Step 4.
- [ ] **Step 7: Commit** `docs(deploy): G2 decision, time zone, reconciliation`.

---

### Task 7: Verify the courier route (§4.8, "verify before relying on it")

- [ ] **Step 1:** Under the **firm** Claude account (G3), check whether a scheduled task (a Claude Code cloud routine, or a claude.ai scheduled task) can use both the Microsoft 365 connector and a custom connector to `https://<domain>/mcp` with the bearer header.
- [ ] **Step 2:** Record it in a new `docs/courier-verification.md`: the feature used, how the custom connector authenticates, and whether the bearer header works (yes/no, with the date). **If the connector requires OAuth, stop and raise it with the owner.** OAuth on the MCP layer is a separate plan, and Monday delivery stays manual (Task 8, Step 3) until it ships.
- [ ] **Step 3: Commit** `docs: courier route verification`.

---

### Task 8: The real schedule and the first Monday by hand

- [ ] **Step 1: Create the schedule** through Claude Code: name `Open work by stage`, slug `open-work-by-stage`, cadence weekday `1` `08:00` `America/Chicago`, requests `OPEN_WORK_REQUESTS`. Layout per §4.5: tiles for active jobs, past due (with share), stuck over 30 days and budgeted hours, each with change; a bar chart of jobs by primary status; the stage table sorted by stuck over 30 days. Run `preview_dashboard` first. Expected: the preview passes every check; `list_schedules` shows one schedule.
- [ ] **Step 2: Warehouse refresh timing.** On the first live Monday, run `scripts/dev-env.sh npm run reconcile` (`totals`) at about 07:30, 08:00 and 09:00 Central. Fill in the table in `docs/deploy.md`. If the figures change after 08:00, add the fixed notes line from that section to the layout with `update_schedule`.
- [ ] **Step 3: First Monday delivery by hand.** After 08:00 Central, the owner runs `docs/courier-prompt.md` in Claude Code. Expected: one PDF and one `totals.json` in `Claude Dashboards/open-work-by-stage/`, neither with a `SYNTHETIC-` prefix. The heartbeat check shows a ping. The same morning, the owner compares the PDF with Snowsight query D (§8.1).
- [ ] **Step 4: Week-over-week (§8.5)** on the second Monday. Expected: the tiles show a change, and the dashboard names the date it compared with.
- [ ] **Step 5: Commit** `docs(deploy): first Monday record`.

---

### Task 9: Switch on

- [ ] **Step 1: G6.** Once he is satisfied with the first real PDF, the owner shares `Claude Dashboards` with the firm partner.
- [ ] **Step 2:** Create two scheduled courier tasks under the firm Claude account, at **Mondays 08:05** and **Mondays 09:00** `America/Chicago`, each with the text of `docs/courier-prompt.md` (route per Task 7). Expected on the next Monday: the 08:05 run reports the files uploaded; the 09:00 run reports `0 uploaded, 0 already present, 0 failed`; no `undelivered` alert arrives.
- [ ] **Step 3: POL-01 record (G3 follow-up, §9).** In `~/dev/cpa-consulting`, use its `changelog-capture` skill to add the POL-01 line describing this pipeline and its changelog entry.
- [ ] **Step 4: Commit** (this repo) `docs: go-live record`. Ask the owner before merging `feat/go-live` to `main` or pushing.

---

## Out of scope (parked, unchanged)

The ledger's deferred items: M5–M8, the C1 second-login nit, the retry of deterministic SQL errors, the 500-run sweep limit, and courier detection of one missing schedule among several. None of them blocks a single Monday schedule. OAuth for claude.ai connectors is phase 2 (§4.11), unless Task 7 makes it necessary.
