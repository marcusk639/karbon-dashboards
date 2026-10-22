# CLAUDE.md

Read `README.md` first (architecture, commands, layout). `docs/specs/2026-10-16-guarded-karbon-dashboards-design.md` is the binding authority; `docs/deploy.md` is the runbook; `docs/build-ledger-2026-10-16.md` holds past rulings.

## Commands

- `npm test` — vitest, in-memory PGlite, no network (~60 s). A timing-sensitive test can flake under load; rerun that file before debugging.
- `npm run build` — `tsc` to `dist/` (services run from `dist/`, so rebuild before `npm start`).
- Live tests: `LIVE=1 scripts/dev-env.sh npx vitest run test/live`; `LIVE_DB=1` for `test/store/*.live.test.ts`.
- Anything needing secrets runs through `scripts/dev-env.sh <cmd>` (loads the Keychain, service `karbon-dashboards`).

## Hard rules

- Never print, log, echo or write a secret, token, connection string or client value — not in code, tests, docs, commits or tool output. Logs carry reason codes and hashes only (`src/log.ts`).
- Claude-facing code never writes SQL or returns rows: requests are validated against `config/catalog.json`, then `src/query/` builds SQL and `src/guard/` checks results. Don't add a path around either.
- `karbon-mcp` must hold no warehouse or DB credentials (it refuses to start if any are set).
- Docs name people only by role ("the owner", "the firm partner", "IT admin") and use placeholders like `<tenant-id>`.
- Default `DATA_MODE=synthetic`; outputs are prefixed `SYNTHETIC-`. Going live is the owner's decision — never flip it unasked.

## Railway (`.railway/railway.ts`, managed variables)

- Always `railway config plan` before `apply`, and read it. Never apply a delete or any change to `postgres` or its volume.
- A variable not declared in the file is deleted on apply: declare it (as `preserve()` if sensitive) before setting its value.
- `config/` must ship: `src/config.ts` reads `../config/*.json` relative to `dist/`.
- Schema changes are additive and run on startup (`CREATE/ALTER … IF NOT EXISTS` + `schema_version`); there is no migration step.
