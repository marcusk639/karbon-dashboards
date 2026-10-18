# Deploy notes

## Status (2026-10-17)

**Running on Railway in synthetic mode** (made-up data; nothing reads Karbon yet). Project `karbon-dashboards` (`c6ebe4d5-7717-411e-a32f-c9560af74610`), environment `production`, in the owner's personal Railway account pending gate G2.

| Service | ID | Reachable at | Deployed code |
| --- | --- | --- | --- |
| `karbon-mcp` | `095c2ed3-a595-498b-93f8-f3a705ebcc76` | `https://karbon-mcp-production-cf6b.up.railway.app/mcp` (public) | `1eaea11` |
| `karbon-api` | `02371543-1c9a-4d03-8cc1-e45876f06194` | `karbon-api.railway.internal:8080` (private only) | `b62f98e` (with the GitHub test upload) |
| `postgres` | `1c6c90b7-caf1-4662-b7c9-0fe6d13c1122` | `postgres.railway.internal:5432` (private only) | `postgres-ssl:17` |

Both app services were redeployed on 2026-10-17 at `1eaea11` (PR #4 head, including the review fixes: alert retry, listen-failure exit, run claim generation, manual-run drain). The database is at schema v3 (`schema_version` holds 2 and 3; `runs.attempt` present), and the old `karbon-api` logged `shutdown` then `drained`. To redeploy: `railway up --service karbon-api --detach`, then the same for `karbon-mcp`.

**Secrets** (values never printed; Keychain service `karbon-dashboards`):

| Variable | Service | State | Keychain account |
| --- | --- | --- | --- |
| `INTERNAL_API_TOKEN` | both | set | `internal-api` |
| `MCP_BEARER_TOKEN` | `karbon-mcp` | set | `mcp-bearer` |
| `POSTGRES_PASSWORD` (+ `POSTGRES_USER=postgres`) | `postgres`, by reference into `karbon-api`'s `DATABASE_URL` | set, rotated 2026-10-17 | `postgres-password` |
| `DATABASE_CA_CERT` | `karbon-api` | set (public cert) | none |
| `EMAIL_ALERT_RECIPIENT`, `ALERT_SMTP_USER`, `ALERT_SMTP_PASSWORD` | `karbon-api` | **not set**: needs a Gmail app password (see "Alerts by email"); declared `preserve()` in `.railway/railway.ts` | `alert-recipient`, `alert-smtp-user`, `alert-smtp-password` |
| `ALERT_WEBHOOK_URL` | `karbon-api` | optional second alert channel; **not set** | `alert-webhook` |
| `HEARTBEAT_URL` | `karbon-api` | **not set**: needs a Healthchecks-style check | `heartbeat-url` |
| `KARBON_SF_ACCOUNT` | `karbon-api` | live only; a non-secret account locator kept out of git; declared `preserve()` in `.railway/railway.ts`; not yet set | `snowflake-account` |
| `KARBON_SF_USER`, `KARBON_SF_PASSWORD` | `karbon-api` | set by the owner 2026-10-17; unused while `DATA_MODE=synthetic`; declared `preserve()` in `.railway/railway.ts`. G2 approval still to be recorded | `snowflake-user`, `snowflake-password` |
| `GITHUB_UPLOAD_TOKEN` | `karbon-api` | set 2026-10-17 (fine-grained, `<github-owner>/claude-dashboards` only, Contents read/write); test aid, refused in live mode | `github-upload` |

**Go-live checklist** (go-live plan Tasks 4 and 6–10):

1. An alert channel (email or webhook) and a heartbeat check; then the controller sets the variables. *Pending.*
2. Claude Code connected to the public MCP URL, and the `.mcp.json` leak check. *Pending.*
3. Courier run ×2. **Blocked:** the Microsoft 365 connector has read-only permissions in the firm tenant (see "Courier and the Microsoft 365 connector"); request sent to the IT provider. *Pending.*
4. Backup restore check after the first daily backup. *Pending (the owner; a restore can overwrite the volume).*
5. G2: The firm partner approves the Karbon password and the state database in the owner's own Railway account. *Pending.*
6. G5: label review (`docs/label-review.md`, `config/labels.json`, `config/generic-words.json`). *Pending.*
7. Same-day reconciliation, live name-check positive test, session time zone (see "Reconciliation log"). *Pending.*
8. Switch to live (see "Going live"). *Pending.*
9. Courier route under the firm Claude account; first Monday by hand; warehouse refresh timing. *Pending.*
10. G6 share with the firm partner; scheduled courier at 08:05 and 09:00 Central; POL-01 line. *Pending.*

## Environment

Two Railway services run from this repo (ruling 2026-10-17): **`karbon-api`** (`node dist/api-server.js`; `npm run start:api` locally) holds the core (warehouse, state store and scheduler) and is reachable only on Railway's private network behind `INTERNAL_API_TOKEN`. **`karbon-mcp`** (`node dist/mcp-server.js`; `npm run start:mcp` locally) is the public MCP endpoint; it calls `karbon-api` over HTTP and holds no warehouse or database credentials.

| Variable                                                                | `karbon-api`      | `karbon-mcp`                                                                           | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ----------------------------------------------------------------------- | ----------------- | -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `KARBON_SF_ACCOUNT`                                                     | yes (Task 7 only) | **never**                                                                              | Non-secret account locator, kept out of git. Keychain `snowflake-account` via `scripts/dev-env.sh`; a Railway variable in production. |
| `KARBON_SF_USER`, `KARBON_SF_PASSWORD`                                  | yes (Task 7 only) | **never**                                                                              | Keychain via `scripts/dev-env.sh` on the Mac; Railway variables in production.                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `DATABASE_URL`, `DATABASE_CA_CERT`, `POSTGRES_PASSWORD` (via reference) | yes               | **never**                                                                              | `DATABASE_URL`: private Postgres on Railway, built from reference variables with **no `sslmode`** (TLS comes from `DATABASE_CA_CERT`), see "State store (Railway Postgres)". **Live: required.** In synthetic mode, unset means in-memory state (lost on restart; the log says `state: in-memory (synthetic)`). Never log it or commit it. `DATABASE_CA_CERT`: PEM root CA of the Postgres service (a public certificate, not a secret); startup refuses it together with any `ssl*` parameter in `DATABASE_URL` (`sslmode`, `ssl`, `sslrootcert`, `sslcert`, `sslkey`, `sslnegotiation`), because `pg` would let the URL replace the CA. |
| `EMAIL_ALERT_RECIPIENT`, `ALERT_SMTP_USER`, `ALERT_SMTP_PASSWORD`, `ALERT_SMTP_HOST`, `ALERT_SMTP_PORT` | yes | no (`karbon-mcp` refuses `ALERT_SMTP_PASSWORD`) | The email alert channel, see "Alerts by email". The first three go together: setting only some stops `karbon-api` at start, naming the missing ones. `ALERT_SMTP_HOST` defaults to `smtp.gmail.com`, `ALERT_SMTP_PORT` to `465` (implicit TLS; `587` uses STARTTLS). |
| `ALERT_WEBHOOK_URL`, `HEARTBEAT_URL`                                    | yes               | no                                                                                     | Live needs **at least one alert channel**: `ALERT_WEBHOOK_URL` or the three email variables (alerts for rejected/failed runs and undelivered files; with both set, an alert goes to both, and an undelivered-file alert is retried on the next minute's tick unless every channel accepted it). `HEARTBEAT_URL` is recommended (live), see "Heartbeat monitor".                                                                                                                                                                                                                                                                                                                                              |
| `INTERNAL_API_TOKEN`                                                    | yes               | yes (same value)                                                                       | At least 32 characters. Keychain item `karbon-dashboards` / `internal-api`.                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `MCP_BEARER_TOKEN`                                                      | no                | yes                                                                                    | At least 32 characters. Never in a file (see "Connect Claude Code").                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `CORE_API_URL`                                                          | no                | yes, a reference: `http://${{karbon-api.RAILWAY_PRIVATE_DOMAIN}}:${{karbon-api.PORT}}` | Must be an `http://` or `https://` URL.                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `DATA_MODE`                                                             | yes               | no                                                                                     | `live` or `synthetic` (default). Only `live` reads Karbon.                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `ALLOW_SYNTHETIC_SCHEDULES`                                             | testing only      | no                                                                                     | `1` starts the scheduler in synthetic mode.                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `PORT`                                                                  | `8080`            | default `8787`                                                                         | `karbon-api` listens on `::` (dual stack: this environment's private DNS resolves to IPv4 and IPv6).                                                                                                                                                                                                                                                                                                                                                                                                            |

`karbon-mcp` **refuses to start** (exit 1, naming the variable only) if any "never" variable is set, so a copy-paste of variables between services cannot put credentials on the public service. It also refuses a token under 32 characters or a `CORE_API_URL` that is not an `http://`/`https://` URL. If `karbon-api` is down, slow (over 120 s per call; 600 s for `run_schedule_now`) or mid-redeploy, a tool returns `core_unavailable` with no URL, stack or token; the list tools return `internal`. `core_unavailable` after a long call (`run_schedule_now`, `create_schedule`) may still have completed: check `list_runs` / `list_schedules` before retrying.

The internal API caps each response at 16 MiB (`RESPONSE_LIMIT_BYTES` in `src/api/client.ts`). A controller ruling raised the plan's 4 MB because `listPendingFiles` carries every pending PDF. A larger response fails the call: the list tools (`list_pending_files`, `list_runs`, `list_schedules`) return `internal` (they throw), the others `core_unavailable`. There is no pagination, so a pending backlog over the cap (roughly ten weeks of PDFs) stops the courier until it shrinks. Remedy: `list_pending_files` is the call that fails, so find the ids in the database: over `railway ssh -s postgres`, `SELECT id, folder, filename, created_at FROM files WHERE delivered_at IS NULL ORDER BY id`. Then either deliver the oldest by hand and mark them with `mark_file_delivered`, or remove them (`DELETE FROM files WHERE id = …`). `mark_file_delivered` on a file that was never uploaded drops it without delivering it.

A startup error names the missing variable only, never a value. A database connection failure reports only `state store unavailable`; the connection string is never printed.

**Synthetic mode never passes for live.** In synthetic mode the scheduler does not run (unless `ALLOW_SYNTHETIC_SCHEDULES=1`), every PDF carries "SYNTHETIC DATA — not from Karbon" above its title and as its as-of line, and every file name starts with `SYNTHETIC-`. A file without that prefix came from Karbon.

## Local run

<!-- AUTO-GENERATED from package.json scripts -->
| Command | What it does |
| --- | --- |
| `npm test` | Run the vitest suite (in-memory PGlite; no database or warehouse needed) |
| `npm run build` | Type-check and compile to `dist/` (`tsc -p .`) |
| `npm start` | Local all-in-one: core and MCP layer in one process (`dist/server.js`, port 8787); not deployed |
| `npm run start:api` | `karbon-api` locally (`dist/api-server.js`, port 8080) |
| `npm run start:mcp` | `karbon-mcp` locally (`dist/mcp-server.js`, port 8787) |
| `npm run reconcile` | Live reconciliation runner (`src/cli/reconcile.ts`); run through `scripts/dev-env.sh` |
<!-- END AUTO-GENERATED -->

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

The service keeps its state (schedules, layouts, run history, weekly totals snapshots, delivery targets and pending PDFs) in a private Postgres service in the same Railway project. It replaced Neon on 2026-10-17 (the owner), so no vendor beyond Railway holds this data. Each app service runs one replica (`replicas` in `.railway/railway.ts`; the scheduler and the Monday run assume one `karbon-api` process).

1. Service `postgres`, image `ghcr.io/railwayapp-templates/postgres-ssl:17`, volume `postgres-data` at `/var/lib/postgresql/data`, `PGDATA=/var/lib/postgresql/data/pgdata`, `POSTGRES_USER=postgres` (the role the app connects as, since 2026-10-17), `POSTGRES_DB=karbon`. `POSTGRES_PASSWORD` comes from `openssl rand -hex 32`, kept in the Keychain as `karbon-dashboards` / `postgres-password` and set through the CLI; it is never printed. The cluster was initialised as `karbon`, which stays as the bootstrap superuser (it cannot be dropped) with the same password. **No TCP proxy**: the database is reachable only on Railway's private network.
2. The app's `DATABASE_URL` is `postgresql://${{postgres.POSTGRES_USER}}:${{postgres.POSTGRES_PASSWORD}}@${{postgres.RAILWAY_PRIVATE_DOMAIN}}:5432/${{postgres.POSTGRES_DB}}` (reference variables, so the password never leaves Railway).
3. The image generates a self-signed root CA and a server certificate whose SAN includes `postgres.railway.internal`. Its root CA is the app's `DATABASE_CA_CERT`. Copy it with `railway ssh -s postgres -- cat /var/lib/postgresql/data/certs/root.crt` and compare SHA-256 fingerprints after setting it. Checked 2026-10-17: TLSv1.3 with `sslmode=verify-full` over the private hostname.
4. **Certificate expiry:** the certificates run 820 days (until 2029-01-14). Within 30 days of expiry the image regenerates them, **including the root CA**. After that, copy the new `root.crt` into `DATABASE_CA_CERT`, or the service fails with `state store unavailable` (and the Monday run alerts).
5. The service creates its tables on first start (`CREATE TABLE IF NOT EXISTS`, plus `ALTER TABLE … ADD COLUMN IF NOT EXISTS` for later columns, with a `schema_version` row), so there is no migration step. Schema v2 added `runs.heartbeat_at` (lease); v3 adds `runs.attempt` (claim generation). Both add-column steps are safe on a database that already has rows.
6. **Backups:** Railway volume backups for `postgres-data` are on (set through the API 2026-10-17): DAILY at 21:08 UTC, kept 6 days, and WEEKLY on Saturdays at 13:40 UTC, kept 27 days. Volume instance `40d3bbec-354a-4026-b178-d91594793558`. The restore check (go-live plan Task 4, Step 2) is still pending: do it in a scratch environment, never by restoring over production.
7. Tests use in-memory PGlite and never connect to a database. `test/store/neon.live.test.ts` (`LIVE_DB=1`) runs against any throwaway Postgres reachable from where it runs.

**What the database holds:** schedules, layouts, weekly totals and pending PDFs (totals only). No client data, by the same design that keeps it out of the layouts and snapshots.

## Deploy timing

Overlapping `karbon-api` deploys are safe from this change on (scheduler lease plus a drain: on SIGTERM the old process waits up to 60 s for an in-flight run, scheduled or `run_schedule_now` (Railway allows 90 s); a longer scheduled run is re-run once by the next process 2 to 3 minutes later (120 s without a heartbeat plus up to one 60 s tick); a longer manual run instead gets a NOT PRODUCED notice and an alert), so the old Monday 07:45-08:30 no-deploy rule is retired. Each re-claim starts a new attempt of the run, so the superseded process can neither keep the lease alive nor finish the run: its files and snapshot roll back and it logs `claim_lost` instead of alerting. `karbon-mcp` deploys are always safe: it holds no state.

## Infrastructure as Code

`.railway/railway.ts` declares `karbon-api`, `karbon-mcp`, `postgres` and its volume, with variables managed. It holds no secret: every secret is `preserve()` (keep the value Railway already has), and `CORE_API_URL` is composed from `karbon-api`'s private domain and `PORT`.

1. Run `railway config plan` before every `railway config apply`, and read it.
2. Never apply a plan that contains a delete, or any change to `postgres` or its volume.
3. Variables not in the file are removed on apply (managed mode), so add a new variable to the file first.
   After apply, the plan still shows `~ Update karbon-api networking` with no field change; it is cosmetic (the private endpoint `karbon-api.railway.internal` is live).
4. **Going live edits this file first.** Because variables are managed, a variable set only through the CLI is deleted by the next apply. Before setting the Karbon credentials, add `KARBON_SF_USER: preserve()` and `KARBON_SF_PASSWORD: preserve()` to `karbon-api`'s `env`, change `DATA_MODE` to `"live"` and remove `ALLOW_SYNTHETIC_SCHEDULES`; plan, apply, then set the two secrets from the Keychain and redeploy. The same applies to `ALERT_WEBHOOK_URL`, `EMAIL_ALERT_RECIPIENT`, `ALERT_SMTP_USER`, `ALERT_SMTP_PASSWORD` and `HEARTBEAT_URL`, which are already declared as `preserve()`.
5. Draining (`deploy.drainingSeconds: 90` on `karbon-api`) is in the file. If a future CLI drops the field, set it in the dashboard (Settings, Deploy) and check it with `get-service-config`.
6. `.railway/` stays in git but is excluded from the upload (`.railwayignore`), since Railway does not read it during a deploy. The `config/` directory is uploaded because `src/config.ts` reads `../config/*.json` relative to `dist/`.

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

## Alerts by email

`karbon-api` sends each alert (kinds `run_rejected`, `run_failed`, `undelivered`) by email through Gmail SMTP with an app password: From `ALERT_SMTP_USER`, To `EMAIL_ALERT_RECIPIENT`, Subject `Karbon dashboards alert: <kind>`, plain-text body `<kind>: <detail>` (the detail is a schedule slug, a date and a reason code, never client data). A send that fails or takes longer than 15 s is logged as `alert_email_failed` only, never with the address, host or password.

1. On the sending Google account, turn on **2-Step Verification** (an app password needs it).
2. Open myaccount.google.com/apppasswords, create an app password (name it `karbon-dashboards`) and copy the 16 characters once.
3. Store three Keychain items under service `karbon-dashboards` with `security add-generic-password -s karbon-dashboards -a <account> -w` (prompted, never on a command line): `alert-smtp-user` (the sending address), `alert-smtp-password` (the app password), `alert-recipient` (the address that receives alerts; it can be the same mailbox).
4. Ask the controller to set `ALERT_SMTP_USER`, `ALERT_SMTP_PASSWORD` and `EMAIL_ALERT_RECIPIENT` on `karbon-api` from the Keychain (they are declared `preserve()` in `.railway/railway.ts`; host and port keep their defaults, `smtp.gmail.com` and `465`) and to send one test alert.

If the app password is revoked, email alerts stop (logged as `alert_email_failed`) and an undelivered-file alert is retried every minute; the heartbeat monitor still covers a missed run.

`ALERT_WEBHOOK_URL` remains an optional second channel: the service POSTs `{"text":"<kind>: <detail>"}` to it (for example a Power Automate flow, which needs a Premium licence, or a webhook-to-email service). With both channels set, an alert goes to both and counts as delivered only if both accept it. With neither, alerts go to the log only (synthetic mode); live mode refuses to start without at least one channel.

## Test upload to GitHub

A test aid alongside the courier, not a replacement: after a run commits with status `produced`, `karbon-api` PUTs a copy of that run's **PDF only** (no totals file, no NOT PRODUCED notice) to a private GitHub repo through the Contents API, so produced dashboards can be looked at without the Microsoft 365 connector. It is best effort: a failure, a non-2xx or the 15 s timeout is logged (`courier` / `github_upload_failed`) and changes nothing about the run, its files, pending delivery state, alerts or the courier. A file already at that path (a `422` whose message names `sha`) counts as present and is never overwritten; any other `422` is a failure (`courier` / `github_upload`).

**Synthetic only.** `karbon-api` refuses to start with `GITHUB_UPLOAD_TOKEN` and `DATA_MODE=live`: live PDFs hold firm operational totals, and a repo in the owner's personal account would be a new home for firm data (a G2-style decision for the firm partner).

| Variable | Default | Notes |
| --- | --- | --- |
| `GITHUB_UPLOAD_TOKEN` | unset = off | Secret. `karbon-api` only; `karbon-mcp` refuses to start with it. Declared `preserve()` in `.railway/railway.ts`. |
| `GITHUB_UPLOAD_REPO` | none (required with the token) | `<github-owner>/claude-dashboards`. With the token set, a missing or malformed value stops `karbon-api` at start (the error names the variable only). Ignored while the token is unset. Declared `preserve()` in `.railway/railway.ts`. |
| `GITHUB_UPLOAD_BRANCH` | `main` | |

Token: github.com → Settings → Developer settings → Fine-grained personal access tokens → Generate. Resource owner `<github-owner>`, repository access **Only select repositories** → `claude-dashboards`, permission **Contents: Read and write**, nothing else, with an expiry. Store it with `security add-generic-password -s karbon-dashboards -a github-upload -w` (prompted, never on a command line), then set it on `karbon-api` through the CLI from the Keychain.

Files land at `<schedule slug>/<file name>` on the branch, e.g. `open-work-by-stage/SYNTHETIC-2026-10-19-open-work-by-stage.pdf`, one commit each (`dashboard: <file name>`).

## Courier and the Microsoft 365 connector

The first courier run by hand (2026-10-17, synthetic files) ended `0 uploaded, 0 already present, 4 failed`: the Microsoft 365 connector, signed in as `the owner's firm account`, holds only **read** permissions in the firm tenant (`Files.Read`, `Files.Read.All`, `Sites.Read.All`, `Mail.Read`, …). Creating the folder and uploading need **`Files.ReadWrite.All`** (delegated); drafting email needs **`Mail.ReadWrite`**.

- Tenant `<tenant-id>`; connector app (client ID) `07c030f6-5743-41b7-ba00-0a6e85f37c17`; the owner's user object ID `<user-object-id>`.
- Microsoft marks both permissions as not requiring admin consent, but the tenant's user-consent settings decide. First try disconnecting and reconnecting the connector in Claude and accept the expanded permissions; if the consent screen says "Need admin approval", the IT provider (IT admin) grants it, preferably **for the owner's account only** rather than organisation-wide. The request email was drafted on 2026-10-17.
- This revisits spec gate G1: the courier needs a one-time tenant consent after all, though not the application permission G1 originally described.
- The root folder target (`Claude Dashboards` in the owner's OneDrive) is already cached by the service as `root`. After consent, rerun `docs/courier-prompt.md`: expect `2 uploaded, 2 already present` (the 2026-10-17 manual test run's files share names with the scheduled run's; manual runs deployed after `f5b87fe` get `-manual-HHmm` names).
- **App registration: not now.** A service-side Graph upload (spec §4.8, productized path) would remove the courier, but it puts a Microsoft credential on Railway (a firm decision, like G2), needs admin consent anyway, and needs new code. If it is ever done: `Sites.Selected` scoped to the owner's OneDrive site, a certificate rather than a client secret.

## Railway acceptance log

Synthetic mode, go-live plan Task 6 (deployments of `c274047` and earlier on 2026-10-17).

| Date | Check | Result |
| --- | --- | --- |
| 2026-10-17 | `karbon-api` opens Postgres over verified TLS (no `state: in-memory`, no `state store unavailable`) | pass |
| 2026-10-17 | `karbon-api` has no public domain; `karbon-api.railway.internal` does not resolve from outside | pass |
| 2026-10-17 | Public `/health` → `ok`; `POST /mcp` with no or a wrong bearer → `401` (§8.7) | pass |
| 2026-10-17 | From inside `karbon-mcp`: `/v1/listMenu` without token `401`, with token `200` | pass |
| 2026-10-17 | Full chain over the public URL: `initialize`, 14 tools, `list_menu` | pass |
| 2026-10-17 | Redeploy of `karbon-api` one minute before a scheduled run: exactly one run, one PDF, one totals file (§8.4). The new container was up before the run minute, so the processes did not overlap during the run; the lease tests cover that case | pass, with that caveat |
| 2026-10-17 | `karbon-mcp` redeploy during `run_schedule_now`: run finished once | pass |
| 2026-10-17 | Rejected made-up client name in a layout: not in either service's log (§8.3) | pass |
| 2026-10-17 | Undelivered alert fires once per file 30 min after creation (logged; no alert channel yet) | pass |
| 2026-10-17 | SIGTERM on Railway logs `shutdown` then `drained`, clean exit | pass |
| 2026-10-17 | Courier ×2 with the Microsoft 365 connector | **blocked**: connector lacks write permission |
| pending | `.mcp.json` leak check (§8.8); test alert by email; backup restore | pending |

The test schedule `deploy-overlap-test` (id 1) and its four `SYNTHETIC-` pending files are still in the database; delete the schedule (`delete_schedule` 1, which cascades to its runs and files) after the courier test.

## Going live

Only after G2, G5, the reconciliation and the live name-check test pass (checklist items 5–7):

1. Store the Snowflake user and password in the Keychain (`snowflake-user`, `snowflake-password`), and have an alert channel (email or webhook) set on `karbon-api`: live mode refuses to start without one.
2. Edit `.railway/railway.ts` as described in "Infrastructure as Code" item 4, run `railway config plan` (expect only those variable changes and no delete), then apply.
3. Set `KARBON_SF_USER` and `KARBON_SF_PASSWORD` on `karbon-api` from the Keychain through the CLI (`--skip-deploys`), then `railway up --service karbon-api --detach`.
4. Expect `listening` with `dataMode: "live"` and no "scheduling off" line; then `ask_question` with the totals request returns real totals matching the reconciliation.

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
