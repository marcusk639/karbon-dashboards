# Deploy notes

## Environment

| Variable | Needed | Notes |
| --- | --- | --- |
| `DATA_MODE` | always | `live` or `synthetic` (default). Only `live` reads Karbon. |
| `DATABASE_URL` | **live: required** | Neon Postgres connection string (pooled, `sslmode=require`), see "State store (Neon Postgres)". Live mode refuses to start without it. In synthetic mode, unset means in-memory state (lost on restart; the log says `state: in-memory (synthetic)`). Never log it or commit it. |
| `ALERT_WEBHOOK_URL` | **live: required** | Alerts for rejected/failed runs and undelivered files. Live mode refuses to start without it. |
| `KARBON_SF_USER`, `KARBON_SF_PASSWORD` | live | Keychain via `scripts/dev-env.sh` on the Mac; Railway variables in production. |
| `MCP_BEARER_TOKEN` | always | At least 32 characters. Never in a file (see "Connect Claude Code"). |
| `HEARTBEAT_URL` | recommended (live) | Dead-man's-switch ping, see "Heartbeat monitor". |
| `ALLOW_SYNTHETIC_SCHEDULES` | testing only | `1` starts the scheduler in synthetic mode. |
| `PORT` | optional | Default `8787`. |

A startup error names the missing variable only, never a value. A database connection failure reports only `state store unavailable`; the connection string is never printed.

**Synthetic mode never passes for live.** In synthetic mode the scheduler does not run (unless `ALLOW_SYNTHETIC_SCHEDULES=1`), every PDF carries "SYNTHETIC DATA — not from Karbon" above its title and as its as-of line, and every file name starts with `SYNTHETIC-`. A file without that prefix came from Karbon.

## State store (Neon Postgres)

The service keeps its state (schedules, layouts, run history, weekly totals snapshots, delivery targets and pending PDFs) in a Neon Postgres database. No Railway volume is needed, and `numReplicas` stays `1` (the scheduler and the Monday run assume one process).

1. **Firm-owned Neon account**, the same principle as gate G2 for Railway: the firm owns the account, not Marcus's personal one.
2. Create one Neon project in a region near the Railway service (for example AWS us-east).
3. Copy the **pooled** connection string. It has the form `postgresql://user:password@host/db?sslmode=require`; keep `sslmode=require` so TLS stays on.
4. Set it as the Railway variable `DATABASE_URL` (a secret variable). Never put it in the repo, an image, a log, a test or the MCP config. Tests use in-memory PGlite and never connect to a database.
5. The service creates its tables on first start (`CREATE TABLE IF NOT EXISTS`, with a `schema_version` row), so there is no migration step.
6. Optional smoke test against a **throwaway** database: `LIVE_DB=1 DATABASE_URL=... npx vitest run test/store/neon.live.test.ts`. It creates and deletes one schedule.

**What Neon will hold:** schedules, layouts, weekly totals and pending PDFs (totals only). No client data, by the same design that keeps it out of the layouts and snapshots. It is still a new vendor holding firm operational data, so it goes to Chris with the Railway request (gate G2).

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

1. Put that in the project's `.mcp.json` (it holds a placeholder, not a secret). Use the Railway URL in place of `localhost` for the deployed service.
2. Launch Claude Code through the Keychain wrapper so the variable exists only in that process: `scripts/dev-env.sh claude`.
3. Alternative: a `headersHelper` command in the server entry that reads the Keychain (`security find-generic-password -s karbon-dashboards -a mcp-bearer -w`) and prints the header as JSON, so the token is never in the environment of the whole session either. Check the current Claude Code MCP documentation for the exact `headersHelper` output format before relying on it.
4. Verify nothing leaked (prints only yes/no, never the token):
   `scripts/dev-env.sh bash -c 'for f in ~/.claude.json .mcp.json; do if grep -qF -- "$MCP_BEARER_TOKEN" "$f" 2>/dev/null; then echo "LEAK in $f"; else echo "clean: $f"; fi; done'`
   Any `LEAK` line: remove the entry, rotate the token (new Keychain value and Railway variable), and reconnect as above.

## Heartbeat monitor

Nothing inside the service can report that the service itself was down at 08:00. Set `HEARTBEAT_URL` to a dead-man's-switch check (for example a Healthchecks-style ping URL). After every scheduler tick that executed a run, whatever its outcome, the service sends a bare `GET` to it (no body, 10 s timeout, never fails the run).

Configure the monitor to expect one ping a week, due **Mondays by 08:30 America/Chicago**, and to alert Marcus when it is missing. A missing ping means the service did not run the Monday schedule at all (down, crashed, paused, or synthetic mode); a ping plus a `run_failed` alert means it ran and failed.

## Reconciliation log

Status: **pending manual (Marcus)**. Implementers hold no Karbon credentials (ruling R6).

Steps (Task 4, Step 6):

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

| Date | Run by | Result |
| ---- | ------ | ------ |
| pending | pending | pending |

## One-time facts

### Session time zone

Status: **pending**. Run `SHOW PARAMETERS LIKE 'TIMEZONE'` in Snowsight and record it (spec section 4.1).
If it is not `America/Chicago`, note that `CURRENT_DATE()` rolls over at a different hour; nothing changes in code.

- Recorded value: pending
- Date: pending

### Warehouse refresh timing

Status: **pending**. On one Monday, run `scripts/dev-env.sh npm run reconcile` (the `totals` block) at about 07:30, 08:00 and 09:00 Central (spec section 4.5). If the figures change after 08:00, record it here.
Then add this line to the layout's notes (Task 13, Step 2):

> Data reflects Karbon's warehouse as of its last refresh, which happens after 8:00 CT on Mondays.

| Time (CT) | jobs | past_due | stuck_over_30d | Changed? |
| --------- | ---- | -------- | -------------- | -------- |
| ~07:30 | pending | pending | pending | pending |
| ~08:00 | pending | pending | pending | pending |
| ~09:00 | pending | pending | pending | pending |
