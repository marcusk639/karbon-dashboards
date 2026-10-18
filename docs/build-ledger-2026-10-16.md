# Build ledger — 2026-10-16 (rulings and deferred findings)

Copied from the subagent-driven build's scratch ledger before deleting it. Deferred items are candidates for follow-up work.


Spec: docs/specs/2026-10-16-guarded-karbon-dashboards-design.md (approved). Repo: ~/dev/karbon-dashboards, branch feat/initial-build from main (566eb94).

## Pre-flight scan

| Pair / task       | Produces vs consumes                                                                     | Finding                                                                       |
| ----------------- | ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| T1→T2             | Catalog, Labels, parseLabels                                                             | consistent                                                                    |
| T2→T3             | BuiltQuery{sql,binds,columns,exemptStrings}, DataSource.run(q,req), RequestError         | consistent                                                                    |
| T3→T4             | NAME_CHECK_SQL binds; error.code 'warehouse_login'                                       | consistent                                                                    |
| T4→T5,T9,T13      | OPEN_WORK_REQUESTS exported from src/cli/reconcile.ts                                    | CONFLICT: importing a CLI entry module from tests/core runs it. See R2        |
| T6→T8             | Snapshot, Layout used in Schedule                                                        | consistent (T6 before T8)                                                     |
| T8→T9             | claimRun→runId, PendingFile                                                              | PendingFile shape never defined. See R3                                       |
| T9↔T10            | executeScheduledRun(periodKey) vs runScheduleNow ("manual-<ISO>" key, file date = today) | CONFLICT: one periodKey drives both claim key and filenames/snapshots. See R4 |
| T10 boundary test | tools.ts may import only CoreApi                                                         | tools need MenuRequest/Cadence types. See R5                                  |
| T1 self           | Step 1 creates branch                                                                    | branch already exists. See R1                                                 |
| T2 self           | tests vs rules                                                                           | consistent (binds hold 'Other'; empty labels literal)                         |
| T3 self           | fixture name tests vs SQL rules                                                          | consistent (hand-checked: [1,0,0])                                            |
| T4 self           | Steps 4,6,7 need live Karbon creds + the owner                                              | implementers have no secrets. See R6                                          |
| T6 self           | 95/239 → 40%; 13:02Z → 08:02 CT                                                          | consistent                                                                    |
| T8 self           | DST: 13:30Z on 2026-11-02 = 07:30 CST → 2026-10-26                                       | consistent                                                                    |
| T10 self          | Step 5 needs Claude Code + Keychain token                                                | See R6                                                                        |
| T12, T13          | Railway deploy with creds; courier under firm Claude account; the firm partner gate G2              | external side effects + credentials. See R7                                   |

## Rulings

- R1 Ruling: Task 1 skips `git switch -c feat/initial-build` (branch already created by controller) — avoids a failing step — cost if wrong: none.
- R2 Ruling: `OPEN_WORK_REQUESTS` lives in `src/requests/open-work.ts`; `src/cli/reconcile.ts` imports it — a CLI module must not be imported by tests/core (side effects on import) — cost if wrong: one extra file.
- R3 Ruling: `type PendingFile = { fileId: number; runId: number; folder: string; filename: string; contentType: string; bytes: number; content: Buffer; createdAt: string }` (Task 8) — needed by T9 tests and T10 base64 mapping — cost if wrong: small rename.
- R4 Ruling: `executeScheduledRun(schedule, runId, periodKey, deps, fileDate = periodKey)`; filenames and `Snapshot.periodKey` use `fileDate` (a yyyy-MM-dd local date), the claim uses `periodKey`; `previousSnapshot(scheduleId, beforeDate)` compares fileDates. `runScheduleNow` claims `manual-<ISO>` and passes today's local date (schedule tz) as fileDate — keeps filenames/snapshots date-ordered — cost if wrong: manual and scheduled runs on the same day share a filename; the courier's fail-if-exists then marks the second delivered without uploading (acceptable for POC).
- R5 Ruling: `src/core/api.ts` re-exports every type the MCP layer needs (MenuRequest, Cadence, GuardResult, …); the boundary test allows imports only from `../core/api.js`, `zod`, and `@modelcontextprotocol/sdk` — keeps the boundary test meaningful — cost if wrong: none.
- R6 Ruling: implementers never hold Karbon credentials. Task 4 Steps 4, 6, 7 and Task 10 Step 5's Claude Code connection are deferred to the owner (logged as "pending manual"); implementers verify with unit tests, `npm run build`, and (Task 10) a synthetic-mode server started with a throwaway `MCP_BEARER_TOKEN` and probed with curl/MCP initialize — credentials stay with the owner — cost if wrong: live SQL defects (esp. NAME_CHECK_SQL) surface later, at the owner's first live run.
- R7 Ruling: execution stops after Task 11 + final review. Tasks 12–13 need the owner (Railway firm account + secrets after gate G2; courier under the firm Claude account; Snowsight label review) — they are external, credentialed side effects — cost if wrong: none; they're handed over as a checklist.

## Progress
Task 1: minor (deferred): package.json npm-init leftovers (main/directories/license)
Task 1: minor (deferred): Labels types hand-written + `as Labels` cast in parseLabels
Task 1: minor (deferred): no loadLabels() smoke test / no negative parseCatalog test
Task 1: minor (deferred): generic-words includes marcus/karbon/ct from fixed copy — final review to confirm acceptable
Task 1: complete (commits 566eb94..62443b7, review clean)
Task 2: Ruling: min group size stays per work_type label (plan/spec §4.3 item 5), not per dimension tuple — a small cross-tab cell only reveals that one of ≥3 reviewed-label jobs sits in a stage; labels are reviewed and "Other" names no one; medians of one job describe a job, not a client — cost if wrong: a cross-tab cell could describe a single job's age/budget; revisit if a person/template dimension is added (spec already requires minGroup for those).
Task 2: minor (deferred): NULL label only asserted via ELSE regex, not end to end
Task 2: minor (deferred): long unwrapped lines in build.ts
Task 2: fix round 1/5 (2 addressed, 0 open; commits df4fb93..c8952fa)
Task 2: complete (commits 62443b7..c8952fa, review clean)
Task 3: Ruling: minors 3 (non-string/non-number cells) and 4 (exact positional column match) are folded into fix round 1 alongside Importants 1-2 — same fail-closed class on the privacy core, a few lines each — cost if wrong: slightly larger fix diff.
Task 3: minor (deferred): non-RequestError throws from validate/build propagate without a log event
Task 3: minor (deferred): FixtureNameChecker uses JS trim() vs Snowflake TRIM (spaces only)
Task 3: minor (deferred): logger validates keys, not value shapes
Task 3: ⚠️ guard does not bound data.run — timeout must live in Task 4's Snowflake source (carry to Task 4 dispatch)
Task 3: fix round 1/5 (4 addressed, 0 open; commits 365addf..509bea8)
Task 3: minor (deferred): sparse-array holes skip type check (no value carried)
Task 3: minor (deferred): numeric cells not pattern-checked (design assumption: numbers non-identifying)
Task 3: complete (commits c8952fa..509bea8, review clean)
Task 4: minor (deferred): connect-time network errors labelled warehouse_login (alerts may say login for outages)
Task 4: minor (deferred): shared connection reset on any failure affects concurrent calls (single-caller POC)
Task 4: minor (deferred): tests miss connect hang, close() after failed login, unexpected IDX/HITS column
Task 4: fix round 1/5 (1 addressed, 0 open; commits 6280e01..9b9daf1)
Task 4: complete (commits 509bea8..9b9daf1, review clean) — PENDING MANUAL (the owner): Steps 4 (LIVE test incl. NAME_CHECK_SQL), 6 (label review + reconcile vs query D), 7 (session TZ, refresh timing); see docs/deploy.md
Task 5: minor (deferred): synthetic measures independent — can show impossible figures (stuck > jobs); fix before any demo to the firm
Task 5: minor (deferred): orderBy not applied to synthetic rows; unknown dimension falls back to "Other"
Task 5: complete (commits 9b9daf1..1760ae9, review clean)
Task 6: minor (deferred): unreviewed footnote may say "0 jobs" when jobs null; max-across-pairs may undercount; "1 jobs" not pluralised (brief copy)
Task 6: minor (deferred): previous snapshot with zero rows → null change vs current missing → 0 (inconsistent)
Task 6: minor (deferred): layout arrays unbounded; whitespace-only text passes; fillLayout assumes checkLayout ran
Task 6: minor (deferred): test gaps (hours/pct change, NUMERIC/CHANGE skip can't hide a name, pattern in title/column label)
Task 6: minor (deferred): non-Latin-script names not name-checked (consistent with SQL tokeniser)
Task 6: complete (commits 1760ae9..54c4fe5, review clean)
Task 7: minor (deferred): sync throw escapes as exception (callers must await in try)
Task 7: minor (deferred): long chart/tile labels can overlap (fixed row height); heading can be orphaned; >=12 table columns break widths; U+2212 not in WinAnsi
Task 7: complete (commits 54c4fe5..5004d93, review clean)
Task 8: minor (deferred): updateSchedule explicit-undefined patch → cryptic NOT NULL error; no cadence re-validation; relies on `this`
Task 8: minor (deferred): createdAt compared as ISO strings (all writers must use toISOString)
Task 8: minor (deferred): delete cascade drops undelivered files — Task 10 delete_schedule description must say so
Task 8: fix round 1/5 (1 addressed, 0 open; commits 7e0b58e..bda6d68)
Task 8: complete (commits 5004d93..bda6d68, review clean)
Task 9: Ruling: minors M1 (unhandled rejection from setInterval) and M2 (non-atomic produce path can yield PDF + NOT PRODUCED together) folded into fix round 1 with C1/I1 — both feed the same "partner sees nothing or contradictory output" failure — cost if wrong: larger fix diff.
Task 9: minor (deferred): tick clock frozen for all runs in a tick (queriedAt/created_at show tick start)
Task 9: minor (deferred): two undelivered alerts per produced run (pdf + totals.json)
Task 9: minor (deferred): log-only alert fallback lacks scheduleId/kind distinction; "the owner has been notified" true only if ALERT_WEBHOOK_URL set — deploy checklist
Task 9: minor (deferred): oversize-PDF branch untested, logged twice
Task 9: minor (deferred): invalid cadence skipped silently each tick (validate on save in Task 10)
Task 9: minor (deferred): webhook response body not consumed
Task 9: fix round 1/5 (4 addressed, 0 open; commits 7041e55..4a506d2)
Task 9: minor (deferred): ticker catch (execute throws) finishes failed + alerts but writes no NOT PRODUCED notice — final review to weigh against "no silent failure" anti-goal
Task 9: minor (deferred): first-tick interrupted scan limited to listRuns(500)
Task 9: complete (commits bda6d68..4a506d2, review clean)
Task 10: Ruling: spec §4.9 "query run time" means the queriedAt timestamp (§4.11 calls it the "data as of" timestamp), not a duration — cost if wrong: add a duration field later.
Task 10: Ruling: minors 2 (cap rate-limit map), 3 (check token before createCore), 4 (wrap tool calls so raw error messages never reach the client) folded into fix round 1 with the SQL finding — internet-facing hardening, small — cost if wrong: larger fix diff.
Task 10: minor (deferred): 429 logged as kind 'auth'; cadenceFailure uses new Date() not deps.now(); hasOk name inverted; no unauth OPTIONS test
Task 10: minor (deferred): Railway proxy hop count unverified — confirm at Task 12 (TRUST_PROXY_HOPS)
Task 10: fix round 1/5 (4 addressed, 0 open; commits 4a199ad..aca4064)
Task 10: minor (deferred): reg() catch swallows errors with no server-side log; MIN_TOKEN_LENGTH duplicated in server.ts/http.ts; no test for server.ts pre-check
Task 10: complete (commits 4a506d2..aca4064, review clean) — PENDING MANUAL (the owner): connect Claude Code to the local/Railway MCP endpoint (Step 5 Claude part)
Task 11: Ruling: the courier uploads every file (pdf, json, txt) with contentBase64 straight from list_pending_files plus expectedBytes, instead of decoding .json/.txt to text — asking a model to hand-decode base64 invites corruption; the M365 upload tool accepts base64 for any type — cost if wrong: none observed (tool docs allow base64 for binary; text files as base64 are still valid bytes).
Task 11: Ruling: minors 3 (no per-file retry of a failed folder), 5 (size check before upload), 6 (tool-error handling), 8 (conflict = name-conflict/409 only) folded into fix round 1 with the two Importants, plus a one-line service guard rejecting slug "root" — an unattended prompt should be literal and closed — cost if wrong: slightly longer prompt.
Task 11: minor (deferred): stale cached folder target not auto-healed (alert is the signal); root search scope wording
Task 11: fix round 1/5 (6 addressed, 0 open; commits 0c32b7a..efebcc3)
Task 11: complete (commits aca4064..efebcc3, review clean)
Tasks 12-13: NOT EXECUTED per R7 (the owner: G2 Railway firm account + secrets; courier verification; first Monday)
Final review (566eb94..efebcc3): Needs fixes first — C1 stale Snowflake session; I1 substring name match; I2 NaN counts in layout/fill; I3 slug/request/schedule names unchecked; I4 synthetic indistinguishable; I5 token into MCP config (docs); I6 no dead-man alert; I7 live name-check positive case. Full list: final-fix-findings.md
Final: Ruling: M5 (SIGTERM mid-run), M6 (script text in layout), M7 (accents), M8 (rate table full) deferred — none leaks data or loses a Monday report silently — cost if wrong: a spurious alert, or a courier 429 under a flood.
Final fix wave: complete (commits efebcc3..3c45c7a, re-review: all findings addressed; 231/231 tests)
Final: parked — C1 timed-out first attempt may reset a newer connection and do an unbudgeted second login — Ruling: harmless for read-only queries; tighten later — cost if wrong: an extra Snowflake login on a hung query.
Final: parked — every non-login error retried once (incl. deterministic SQL errors) — Ruling: one extra round trip, acceptable — cost if wrong: doubled latency on a broken query.
Final: parked — deploy.md heartbeat note wrong when ALLOW_SYNTHETIC_SCHEDULES=1; leak-check grep shows token in ps; courier doesn't flag one schedule missing among several — Ruling: doc/ops polish, single schedule today — cost if wrong: misread heartbeat in a test setup.

## State store moved to Neon Postgres (2026-10-16)

- The owner's decision: SQLite on a Railway volume replaced by Neon Postgres via `DATABASE_URL`. Store is async; exactly-once claim is atomic SQL; PGlite in-memory for tests and synthetic mode.
- Review fixes applied: transaction client error listener + destroy-on-error release; `sslmode=verify-full`; per-tick recovery of stranded runs (15 min); SQLSTATE-only error logging; plan doc's volume/`STATE_DB_PATH` lines marked superseded.
- Known limitation (parked): a Railway deploy whose old and new processes overlap during the Monday 08:00 run can mark the old process's in-flight run interrupted and run it again (the first-tick sweep uses age 0). Operational rule until fixed: **do not deploy between 07:45 and 08:30 Central on Mondays.** Same risk for a manual `run_schedule_now` started just before a first tick.
- Parked: a manual run lasting more than 15 minutes could be marked interrupted by the per-tick sweep (duplicate notice); interrupted-run sweep reads only the newest 500 runs; the real `pg` pool path is covered only by the `LIVE_DB=1` smoke test, which the owner runs once Neon exists.
- Ruling 2026-10-17: two services (karbon-api private, karbon-mcp public); spec §4.7 builder's call.

## Rulings during go-live execution (2026-10-17)

Copied in order from the go-live progress log; each keeps its cost if wrong.

- Pre-flight: Ruling: R1 the "no postgresql:// URL" commit scan targets real connection strings; the reference-variable template in deploy.md and fake test URLs stay — they carry no secret and pre-date the rule in tests — cost if wrong: a reviewer flags a doc line.
- Pre-flight: Ruling: R2 run Task 3 Step 1 (enable backups) right after Task 4, and Step 2 (restore check) after Task 5 Step 4 — the restore needs rows — cost if wrong: none.
- Pre-flight: Ruling: R3 keep POSTGRES_USER=karbon (the app's role, matching the plan text); deploy.md's rotate note must ALTER both roles (karbon and postgres) and the stray postgres superuser is recorded as known state, pending the owner's choice on the user fix — cost if wrong: a rotation that misses one role leaves an old password valid.
- Pre-flight: Ruling: R4 Tasks 6-9 and the owner-input parts of Task 5 are human actions; the controller executes Tasks 1, 2, 4, Task 3 Step 1 and the agent-runnable parts of Task 5, then stops with the exact asks — cost if wrong: none (they cannot be done by an agent).
- Task 3: Ruling: DAILY retention is fixed at 6 days by Railway, so "keep at least 7" is met by adding WEEKLY (27 days) — cost if wrong: a restore older than 6 days falls back to the last weekly backup.
- Task 4: Ruling: no railway.json — Railway's docs (2026-10-17) say Config as Code is deprecated, new services cannot opt in, hard cutoff 2026-12-01; IaC (.railway/railway.ts) takes ownership of every resource in the environment (an undeclared owned resource is deleted on apply), too much blast radius next to the postgres volume. Instead the controller applies the same settings with update-service (build `npm ci && npm run build`, start `npm start`, healthcheck `/health`, restart ON_FAILURE, 1 replica, drainingSeconds 90, builder RAILPACK) and deploy.md records them as the source of truth; the subagent does .railwayignore, engines, deploy.md only — cost if wrong: settings live only in Railway, so a dashboard edit drifts silently from deploy.md.
- Pre-flight: Ruling: R5 declare `PORT: "8080"` in karbon-api's env in .railway/railway.ts so the CORE_API_URL reference resolves and matches api-server's default — cost if wrong: none (same value as the code default).
- Pre-flight: Ruling: R6 DATABASE_CA_CERT is written as preserve() in .railway/railway.ts, never as its PEM value, so no BEGIN line reaches git — cost if wrong: the CA is not reviewable in the file (it is public; deploy.md documents how to copy and fingerprint it).
- Pre-flight: Ruling: R7 Task 3 — `ask` returns GuardResult ({status:…}), not Failure ({ok:false,…}), so the plan's "ask({}) resolves { ok:false, code:'core_unavailable' }" cannot type-check. The HTTP client's ask resolves { status:"rejected", code:"core_unavailable", detail:"core API unavailable" } instead, and "core_unavailable" is added to RejectCode (src/log.ts); the client test asserts code core_unavailable with status rejected. Every other Failure-returning method keeps { ok:false, code:"core_unavailable", detail:"core API unavailable" } — cost if wrong: ask_question reports an outage as a rejection (Claude still sees the core_unavailable code; no data involved).
- Task 2: Ruling: plan-mandated pair (shutdown races stop vs 60 s; Core.close awaits stop) defeats the spec's bounded drain — fix: export DRAIN_CAP_MS = 60_000 (one definition), Core.close() races its ticker stops against it with an unref'd timer, server.ts uses the constant; add a fake-timer test where stop never resolves and close() still resolves at the cap — cost if wrong: a hung run is abandoned at 60 s (lease recovery re-runs it on the new process, by Task 1).
- Pre-flight: Ruling: R8 Task 5 — rename the app service to karbon-api through the Railway API (serviceUpdate name) BEFORE `railway config pull`, so the IaC file imports the final name and the rename can never plan as delete-and-create; the plan's fallback (keep karbon-dashboards) is then unnecessary — cost if wrong: none (same service ID; references use the service name, and no reference to karbon-dashboards exists yet).
- Task 3: Ruling: enforce the response cap, but at 16 MiB (RESPONSE_LIMIT_BYTES = 16 * 1024 * 1024), not 4mb — listPendingFiles returns every pending PDF base64 (~1.4 MB each), so 4mb would stall courier delivery once 3 weeks are undelivered, exactly when the backlog must clear (spec §4.8 delivery outranks the plan's constant); 16 MiB covers ~10 pending weeks. Over the cap → Unavailable (core_unavailable / throw for list methods) — cost if wrong: karbon-mcp may buffer up to 16 MiB per call.
- Task 3: Ruling: minor #1 (unmatched routes return Express's HTML 404 echoing the path) is pulled into the fix round — Review Focus #5 requires a bare 401/404 for anything on the private network — cost if wrong: none.
- Task 5: Ruling: ⚠️ preserve() on not-yet-set variables and managed-variables semantics — controller re-runs `railway config plan` right before apply, then checks list-variables names; Task 6 Step 1 sets every secret through the CLI immediately after apply — cost if wrong: an empty placeholder variable that Task 6 overwrites.
- Final: Ruling: T6(b) manual runs get filenames `<date>-<slug>-manual-<HHmm>`; scheduled names unchanged (spec §4.8) — cost if wrong: manual file names differ from the spec pattern (manual runs are not in the spec).
- Final: Ruling: start commands become `node dist/api-server.js` / `node dist/mcp-server.js` so npm is out of the signal path; shutdown/drained log lines added — cost if wrong: none (npm scripts kept for local use).
- Final: Ruling: finishRun only finishes a row still `running` — cost if wrong: a late finisher's result is dropped in favour of the recovery path (which already produced a notice or a re-run).
- Final: parked — M5 (ALTER TABLE ACCESS EXCLUSIVE on every start) — Ruling: old-process transactions are milliseconds; revisit with lock_timeout — cost if wrong: a new process could stall its health check behind a stuck transaction.

## Later corrections and decisions (2026-10-17)

Entries above are kept as written; these supersede them.

- **Superseded:** "do not deploy between 07:45 and 08:30 Central on Mondays" and "per-tick recovery of stranded runs (15 min)" (Neon section). The heartbeat lease (30 s touch, 120 s stale) and the drain retire both; see docs/deploy.md "Deploy timing".
- **Superseded:** "Task 4: Ruling: no railway.json … update-service" (later renumbered Task 5). The updated plan moved Railway config to Infrastructure as Code (`.railway/railway.ts`), which now owns build, start, healthcheck, replicas and draining.
- **Superseded:** R3 "keep POSTGRES_USER=karbon". Since 2026-10-17 the app connects as `postgres` (`POSTGRES_USER=postgres`); `karbon` remains as the bootstrap superuser with the same password, and both were rotated together (Keychain `karbon-dashboards/postgres-password`).
- **Superseded:** "Final: Ruling: finishRun only finishes a row still `running` — a late finisher's result is dropped". That fence did not cover a re-claimed row (same id), and the late finisher's files still landed. Replaced by a claim generation (PR #4 review fix, `f1d10ab`): schema v3 `runs.attempt`; `claimRun` returns `{ runId, attempt }`; `finishRun`/`touchRun` match `id`, `attempt` and `status = 'running'`; a process whose claim was taken over rolls back its whole commit (files, snapshot, finish), sends no alert and logs `claim_lost`. Cost if wrong: a superseded run's work is discarded (the new owner produces the period).
- PR #4 multi-agent review fixes (2026-10-17): an undelivered-file alert is marked alerted only when the webhook returns 2xx, or when no webhook is configured (the log line is then the alert) — cost if wrong: one log line per file per minute while a webhook is down; `listen` failure logs `listen failed` with a code and exits 1, and the ticker starts only once listening — cost if wrong: none; `Core.close()` also waits for in-flight `run_schedule_now` calls within the one 60 s cap — cost if wrong: none.
- Parked from the PR #4 review: a lease touch racing a successful commit can log a spurious `claim_lost`; a hanging (not refusing) webhook delays each tick by up to 10 s per pending file; `core_unavailable` merges timeout, token mismatch, 5xx and the 16 MiB cap into one code; `CORE_METHODS` and the log-code list are not type-tied to their unions.
- **Finding, revisits gate G1:** the Microsoft 365 connector holds read-only delegated permissions in the firm tenant, so the courier cannot create folders or upload (first manual run: `0 uploaded, 0 already present, 4 failed`). It needs `Files.ReadWrite.All` (and `Mail.ReadWrite` for email drafts), delegated, ideally consented for the owner only; request drafted to the IT provider (IT admin). Decision: no app registration for now (it would put a Microsoft credential on Railway and needs new code); revisit only if the courier proves unreliable.
- Decision (superseded 2026-10-17, see next line): alerts reach the owner's Outlook through a Power Automate HTTP-trigger flow (Premium connector; fallback a webhook-to-email service). The heartbeat uses a Healthchecks-style check that emails on a missed Monday ping.

- Ruling (2026-10-17): the GitHub test upload of produced PDFs (`GITHUB_UPLOAD_TOKEN`, to the owner's private repo `claude-dashboards`) is synthetic only; `createCore` refuses it with `DATA_MODE=live`. Cost if wrong: none while synthetic; a live PDF would need the firm partner's approval before this rule is lifted.
- Decision (2026-10-17): alerts go by email over Gmail SMTP with an app password (`EMAIL_ALERT_RECIPIENT`, `ALERT_SMTP_USER`, `ALERT_SMTP_PASSWORD`); no Premium Power Automate licence is available, and the webhook stays an optional second channel. Cost if wrong: alerts depend on one Gmail account; an app-password revocation silences email alerts, which the heartbeat monitor still covers.
