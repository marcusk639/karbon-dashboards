# Deploy notes

## Environment

Two Railway services run from this repo (ruling 2026-10-17): **`karbon-api`** (`node dist/api-server.js`; `npm run start:api` locally) holds the core (warehouse, state store and scheduler) and is reachable only on Railway's private network behind `INTERNAL_API_TOKEN`. **`karbon-mcp`** (`node dist/mcp-server.js`; `npm run start:mcp` locally) is the public MCP endpoint; it calls `karbon-api` over HTTP and holds no warehouse or database credentials.

| Variable                                                                | `karbon-api`      | `karbon-mcp`                                                                           | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ----------------------------------------------------------------------- | ----------------- | -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `KARBON_SF_USER`, `KARBON_SF_PASSWORD`                                  | yes (Task 7 only) | **never**                                                                              | Keychain via `scripts/dev-env.sh` on the Mac; Railway variables in production.                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `DATABASE_URL`, `DATABASE_CA_CERT`, `POSTGRES_PASSWORD` (via reference) | yes               | **never**                                                                              | `DATABASE_URL`: private Postgres on Railway, built from reference variables with **no `sslmode`** (TLS comes from `DATABASE_CA_CERT`), see "State store (Railway Postgres)". **Live: required.** In synthetic mode, unset means in-memory state (lost on restart; the log says `state: in-memory (synthetic)`). Never log it or commit it. `DATABASE_CA_CERT`: PEM root CA of the Postgres service (a public certificate, not a secret); startup refuses it together with an `sslmode`/`ssl` in `DATABASE_URL`. |
| `ALERT_WEBHOOK_URL`, `HEARTBEAT_URL`                                    | yes               | no                                                                                     | `ALERT_WEBHOOK_URL` is **live: required** (alerts for rejected/failed runs and undelivered files; an undelivered-file alert the webhook does not accept with a 2xx is retried on the next minute's tick). `HEARTBEAT_URL` is recommended (live), see "Heartbeat monitor".                                                                                                                                                                                                                                                                                                                                              |
| `INTERNAL_API_TOKEN`                                                    | yes               | yes (same value)                                                                       | At least 32 characters. Keychain item `karbon-dashboards` / `internal-api`.                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `MCP_BEARER_TOKEN`                                                      | no                | yes                                                                                    | At least 32 characters. Never in a file (see "Connect Claude Code").                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `CORE_API_URL`                                                          | no                | yes, a reference: `http://${{karbon-api.RAILWAY_PRIVATE_DOMAIN}}:${{karbon-api.PORT}}` | Must be an `http://` or `https://` URL.                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `DATA_MODE`                                                             | yes               | no                                                                                     | `live` or `synthetic` (default). Only `live` reads Karbon.                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `ALLOW_SYNTHETIC_SCHEDULES`                                             | testing only      | no                                                                                     | `1` starts the scheduler in synthetic mode.                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `PORT`                                                                  | `8080`            | default `8787`                                                                         | `karbon-api` listens on `::` (dual stack: this environment's private DNS resolves to IPv4 and IPv6).                                                                                                                                                                                                                                                                                                                                                                                                            |

`karbon-mcp` **refuses to start** (exit 1, naming the variable only) if any "never" variable is set, so a copy-paste of variables between services cannot put credentials on the public service. It also refuses a token under 32 characters or a `CORE_API_URL` that is not an `http://`/`https://` URL. If `karbon-api` is down, slow (over 120 s per call; 600 s for `run_schedule_now`) or mid-redeploy, a tool returns `core_unavailable` with no URL, stack or token; the list tools return `internal`. `core_unavailable` after a long call (`run_schedule_now`, `create_schedule`) may still have completed: check `list_runs` / `list_schedules` before retrying.

The internal API caps each response at 16 MiB (`RESPONSE_LIMIT_BYTES` in `src/api/client.ts`). A controller ruling raised the plan's 4 MB because `listPendingFiles` carries every pending PDF. A larger response fails the call: the list tools (`list_pending_files`, `list_runs`, `list_schedules`) return `internal` (they throw), the others `core_unavailable`. There is no pagination, so a pending backlog over the cap (roughly ten weeks of PDFs) stops the courier until it shrinks. Remedy: deliver or delete old pending files by id, oldest first (`mark_file_delivered` with the id, or `DELETE FROM files WHERE id = …` over `railway ssh -s postgres`).

A startup error names the missing variable only, never a value. A database connection failure reports only `state store unavailable`; the connection string is never printed.

**Synthetic mode never passes for live.** In synthetic mode the scheduler does not run (unless `ALLOW_SYNTHETIC_SCHEDULES=1`), every PDF carries "SYNTHETIC DATA — not from Karbon" above its title and as its as-of line, and every file name starts with `SYNTHETIC-`. A file without that prefix came from Karbon.

## Local run

Two processes, as deployed (tokens generated inline, never printed):

```bash
npm run build
export INTERNAL_API_TOKEN=$(openssl rand -base64 48) MCP_BEARER_TOKEN=$(openssl rand -base64 48)
PORT=8080 DATA_MODE=synthetic node dist/api-server.js & sleep 2
PORT=8787 CORE_API_URL=http://localhost:8080 node dist/mcp-server.js & sleep 2
curl -s localhost:8787/health; curl -s -o /dev/null -w '%{http_code}\n' -X POST localhost:8787/mcp
curl -s -o /dev/null -w '%{http_code}\n' -X POST localhost:8080/v1/listMenu
kill %1 %2; unset INTERNAL_API_TOKEN MCP_BEARER_TOKEN
```

Expected: `ok`, `401` (MCP without bearer), `401` (API without internal token).

For quick use from Claude Code on the Mac, `npm start` (`dist/server.js`) runs the core and the MCP layer in one process on port `8787`; it needs only `MCP_BEARER_TOKEN` (plus the live variables for `DATA_MODE=live`). It is not deployed.

## State store (Railway Postgres)

The service keeps its state (schedules, layouts, run history, weekly totals snapshots, delivery targets and pending PDFs) in a private Postgres service in the same Railway project. It replaced Neon on 2026-10-17 (the owner), so no vendor beyond Railway holds this data. `numReplicas` stays `1` (the scheduler and the Monday run assume one process).

1. Service `postgres`, image `ghcr.io/railwayapp-templates/postgres-ssl:17`, volume `postgres-data` at `/var/lib/postgresql/data`, `PGDATA=/var/lib/postgresql/data/pgdata`, `POSTGRES_USER=postgres` (the role the app connects as, since 2026-10-17), `POSTGRES_DB=karbon`. `POSTGRES_PASSWORD` comes from `openssl rand -hex 32`, kept in the Keychain as `karbon-dashboards` / `postgres-password` and set through the CLI; it is never printed. The cluster was initialised as `karbon`, which stays as the bootstrap superuser (it cannot be dropped) with the same password. **No TCP proxy**: the database is reachable only on Railway's private network.
2. The app's `DATABASE_URL` is `postgresql://${{postgres.POSTGRES_USER}}:${{postgres.POSTGRES_PASSWORD}}@${{postgres.RAILWAY_PRIVATE_DOMAIN}}:5432/${{postgres.POSTGRES_DB}}` (reference variables, so the password never leaves Railway).
3. The image generates a self-signed root CA and a server certificate whose SAN includes `postgres.railway.internal`. Its root CA is the app's `DATABASE_CA_CERT`. Copy it with `railway ssh -s postgres -- cat /var/lib/postgresql/data/certs/root.crt` and compare SHA-256 fingerprints after setting it. Checked 2026-10-17: TLSv1.3 with `sslmode=verify-full` over the private hostname.
4. **Certificate expiry:** the certificates run 820 days (until 2029-01-14). Within 30 days of expiry the image regenerates them, **including the root CA**. After that, copy the new `root.crt` into `DATABASE_CA_CERT`, or the service fails with `state store unavailable` (and the Monday run alerts).
5. The service creates its tables on first start (`CREATE TABLE IF NOT EXISTS`, with a `schema_version` row), so there is no migration step.
6. **Backups are ours.** Turn on Railway volume backups for `postgres-data`, or add a scheduled `pg_dump`. The data is small: totals, layouts and pending PDFs.
7. Tests use in-memory PGlite and never connect to a database. `test/store/neon.live.test.ts` (`LIVE_DB=1`) runs against any throwaway Postgres reachable from where it runs.

**What the database holds:** schedules, layouts, weekly totals and pending PDFs (totals only). No client data, by the same design that keeps it out of the layouts and snapshots.

## Deploy timing

Overlapping `karbon-api` deploys are safe from this change on (scheduler lease plus a drain: on SIGTERM the old process waits up to 60 s for an in-flight run (Railway allows 90 s); a longer run is re-run once by the next process about 2 minutes later), so the old Monday 07:45-08:30 no-deploy rule is retired. Each re-claim starts a new attempt of the run, so the superseded process can neither keep the lease alive nor finish the run: its files and snapshot roll back and it logs `claim_lost` instead of alerting. `karbon-mcp` deploys are always safe: it holds no state.

## Infrastructure as Code

`.railway/railway.ts` declares `karbon-api`, `karbon-mcp`, `postgres` and its volume, with variables managed. It holds no secret: every secret is `preserve()` (keep the value Railway already has), and `CORE_API_URL` is composed from `karbon-api`'s private domain and `PORT`.

1. Run `railway config plan` before every `railway config apply`, and read it.
2. Never apply a plan that contains a delete, or any change to `postgres` or its volume.
3. Variables not in the file are removed on apply (managed mode), so add a new variable to the file first.
4. Draining (`deploy.drainingSeconds: 90` on `karbon-api`) is in the file. If a future CLI drops the field, set it in the dashboard (Settings, Deploy) and check it with `get-service-config`.
5. `.railway/` stays in git but is excluded from the upload (`.railwayignore`), since Railway does not read it during a deploy. The `config/` directory is uploaded because `src/config.ts` reads `../config/*.json` relative to `dist/`.

## Rotate

Never print a value. Generate with `openssl rand -hex 32`, store it in the Keychain, then set it through the CLI from the Keychain.

- **Bearer (`MCP_BEARER_TOKEN`):** new Keychain value (`karbon-dashboards` / `mcp-bearer`), then set on `karbon-mcp` only.
- **`INTERNAL_API_TOKEN`:** new Keychain value (`karbon-dashboards` / `internal-api`), set on **both** services with `skipDeploys`, then redeploy `karbon-api` first and `karbon-mcp` straight after. Calls fail with `core_unavailable` between the two.
- **Postgres password:** the server has two superuser roles with the same password, `postgres` (used by the app) and `karbon` (bootstrap). Put the new value in the Keychain (`security add-generic-password -U -s karbon-dashboards -a postgres-password -w "$(openssl rand -hex 32)"`), pipe it over stdin into `railway ssh -s postgres` and `ALTER ROLE postgres PASSWORD …; ALTER ROLE karbon PASSWORD …;` with a psql variable (never on a command line), then set `POSTGRES_PASSWORD` on `postgres` through the CLI from the Keychain with `--skip-deploys`. `DATABASE_URL` follows by reference; redeploy `karbon-api`. Last rotated 2026-10-17.
- **Karbon password:** a `karbon-api` variable only (`KARBON_SF_PASSWORD`).

## Connect Claude Code

The MCP bearer token must **never be pasted into, or expanded into, any config file** (spec §4.7, acceptance 8). Do **not** use `claude mcp add ... --header "Authorization: Bearer $MCP_BEARER_TOKEN"`: the shell expands `$MCP_BEARER_TOKEN` before Claude Code sees it, so the literal token is written into `~/.claude.json`.

Instead, keep only a placeholder in the config and let Claude Code expand it from the environment at load time:

```json
{
  "mcpServers": {
    "karbon-dashboards": {
      "type": "http",
      "url": "http://localhost:8787/mcp",
      "headers": { "Authorization": "Bearer ${MCP_BEARER_TOKEN}" }
    }
  }
}
```

1. Put that in the project's `.mcp.json` (it holds a placeholder, not a secret). Use the Railway URL in place of `localhost` for the deployed service: the public `karbon-mcp` domain, `https://<karbon-mcp domain>/mcp`.
2. Launch Claude Code through the Keychain wrapper so the variable exists only in that process: `scripts/dev-env.sh claude`.
3. Alternative: a `headersHelper` command in the server entry that reads the Keychain (`security find-generic-password -s karbon-dashboards -a mcp-bearer -w`) and prints the header as JSON, so the token is never in the environment of the whole session either. Check the current Claude Code MCP documentation for the exact `headersHelper` output format before relying on it.
4. Verify nothing leaked (prints only yes/no, never the token):
   `scripts/dev-env.sh bash -c 'for f in ~/.claude.json .mcp.json; do if grep -qF -- "$MCP_BEARER_TOKEN" "$f" 2>/dev/null; then echo "LEAK in $f"; else echo "clean: $f"; fi; done'`
   Any `LEAK` line: remove the entry, rotate the token (new Keychain value and Railway variable), and reconnect as above.

## Heartbeat monitor

Nothing inside the service can report that the service itself was down at 08:00. Set `HEARTBEAT_URL` to a dead-man's-switch check (for example a Healthchecks-style ping URL). After every scheduler tick that executed a run, whatever its outcome, the service sends a bare `GET` to it (no body, 10 s timeout, never fails the run).

Configure the monitor to expect one ping a week, due **Mondays by 08:30 America/Chicago**, and to alert the owner when it is missing. A missing ping means the service did not run the Monday schedule at all (down, crashed, paused, or synthetic mode); a ping plus a `run_failed` alert means it ran and failed.

## Reconciliation log

Status: **pending manual (the owner)**. Implementers hold no Karbon credentials (ruling R6).

Steps (go-live plan Task 7, Steps 4–5):

1. Complete the `primary_status` and `stage` reviews in `docs/label-review.md` (gate G5, spec section 9).
2. Within one hour of each other, run:
   - `scripts/dev-env.sh npm run reconcile` (prints `totals`, `by_status`, `by_stage`; exits 1 and prints the code if any is rejected)
   - Snowsight query D, copied from `~/dev/cpa-consulting/karbon-kb/power-bi-demo-build-guide-2026-10-15.md` section 2.2. Copy it; never retype it.
3. Expected: `by_stage` equals query D row for row **only when every stage label was approved as-is** in the review. An `alias` outcome renames a row, and an `other` outcome (or any label not yet reviewed) merges rows into `Other` / `Other (unreviewed)`, which query D does not do. If any label was aliased or merged, compare only the **unmerged** rows (those whose label was approved as-is) row for row, and check that the merged rows' `jobs` sum to the merged bucket. `budget_hrs` compared unrounded may differ by up to 0.1 h per row.
4. If `LIVE=1 scripts/dev-env.sh npx vitest run test/live` fails because `NAME_CHECK_SQL` errors in Snowflake, fix the SQL in `src/guard/names.ts` and keep `FixtureNameChecker` matching it.
5. Live name-check positive test (the only proof the live check catches a real name). Store one real client word, and optionally one short (2-3 letter) client surname, in the Keychain. Each command prompts for the value; nothing is echoed, and the value is never written to a file, a commit, a test or a log:
   - `security add-generic-password -s karbon-dashboards -a known-client-word -w`
   - `security add-generic-password -s karbon-dashboards -a known-short-surname -w` (optional)

   `scripts/dev-env.sh` exports them as `KNOWN_CLIENT_WORD` / `KNOWN_SHORT_SURNAME` when present. Then `LIVE=1 scripts/dev-env.sh npx vitest run test/live` must show both "scores > 0" tests passing, not skipped. A skipped test means the variable is not set; a failure means the live check misses that name and nothing may be scheduled until it is fixed. Test output shows counts only, never the word.

| Date    | Run by  | Result  |
| ------- | ------- | ------- |
| pending | pending | pending |

## One-time facts

### Session time zone

Status: **pending**. Run `SHOW PARAMETERS LIKE 'TIMEZONE'` in Snowsight and record it (spec section 4.1).
If it is not `America/Chicago`, note that `CURRENT_DATE()` rolls over at a different hour; nothing changes in code.

- Recorded value: pending
- Date: pending

### Warehouse refresh timing

Status: **pending**. On one Monday, run `scripts/dev-env.sh npm run reconcile` (the `totals` block) at about 07:30, 08:00 and 09:00 Central (spec section 4.5). If the figures change after 08:00, record it here.
Then add this line to the layout's notes (go-live plan Task 9, Step 2):

> Data reflects Karbon's warehouse as of its last refresh, which happens after 8:00 CT on Mondays.

| Time (CT) | jobs    | past_due | stuck_over_30d | Changed? |
| --------- | ------- | -------- | -------------- | -------- |
| ~07:30    | pending | pending  | pending        | pending  |
| ~08:00    | pending | pending  | pending        | pending  |
| ~09:00    | pending | pending  | pending        | pending  |
