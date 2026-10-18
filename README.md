# karbon-dashboards

Guarded Karbon dashboards: answers client-free questions about a CPA firm's Karbon work through a locked-down MCP server, and every Monday at 08:00 Central produces a checked "open work by stage" PDF that a Claude courier uploads to OneDrive.

Claude never writes SQL and never sees a client row. It picks measures, groupings and filters from an approved menu. The service builds the SQL, computes the totals inside Snowflake, and runs every check before anything leaves the warehouse.

## How it works

```
Claude ──bearer──▶ karbon-mcp (public) ──internal token──▶ karbon-api (private) ──▶ Snowflake (Karbon)
                                                              │
                                                              ├─▶ Postgres (state, private)
                                                              └─▶ PDFs held as pending files ──▶ courier ──▶ OneDrive
```

- **karbon-api** (`src/api-server.ts`): the core. It holds the catalog and SQL generation, the Snowflake connection, every privacy check, the scheduler, the PDF renderer and the state store. It has no public address.
- **karbon-mcp** (`src/mcp-server.ts`): the only public endpoint. It authenticates Claude, rate-limits, and turns each tool call into one call to karbon-api. It holds no warehouse or database credentials and refuses to start if any are set.
- **State**: a private Postgres reached over verified TLS. It stores schedules, layouts, run history, weekly totals and pending files: totals only, no client data.
- **Courier**: a scheduled Claude task that moves pending files into OneDrive (`docs/courier-prompt.md`). It moves files only and never reads or changes them.

## Guarantees

- **Menu only:** a request is validated against `config/catalog.json` before any SQL exists. No code path selects individual rows.
- **Checked results:** results are checked for client names (inside Snowflake), email, phone and ID patterns, and small groups. Unreviewed labels become `Other (unreviewed)`.
- **Exactly once:** each scheduled period runs once, even across overlapping deploys (a heartbeat lease plus a claim generation). A failed run produces a `NOT PRODUCED` notice and an alert, never a silent gap.
- **Clean logs:** only reason codes and hashes are logged, never values, client names, URLs or tokens.
- **No secrets or identifiers in the repo:** credentials, account identifiers and repository names come from environment variables only, from the macOS Keychain locally or from Railway variables in production.
- **Synthetic mode** (`DATA_MODE=synthetic`, the default) uses made-up data. Every file it produces is prefixed `SYNTHETIC-`.

## Requirements

- Node.js 22
- For live mode: Snowflake username/password access to the Karbon warehouse (`KARBON_SF_ACCOUNT`, `KARBON_SF_USER`, `KARBON_SF_PASSWORD`), and a Postgres database (`DATABASE_URL`)

## Getting started

```bash
npm ci
npm run build
npm test
```

Run both services locally in synthetic mode (tokens are generated inline and never printed):

```bash
export INTERNAL_API_TOKEN=$(openssl rand -base64 48) MCP_BEARER_TOKEN=$(openssl rand -base64 48)
PORT=8080 DATA_MODE=synthetic node dist/api-server.js &
PORT=8787 CORE_API_URL=http://localhost:8080 node dist/mcp-server.js &
curl -s localhost:8787/health        # ok
```

Or run a single all-in-one process for use from Claude Code: `npm start` (port 8787, needs only `MCP_BEARER_TOKEN`).

## Commands

| Command                                   | What it does                                                                                                  |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `npm test`                                | Run the vitest suite (in-memory PGlite; no database or warehouse needed)                                      |
| `npm run build`                           | Type-check and compile to `dist/`                                                                             |
| `npm start`                               | Local all-in-one (core and MCP in one process)                                                                |
| `npm run start:api` / `npm run start:mcp` | Run each service on its own                                                                                   |
| `npm run reconcile`                       | Live reconciliation against the warehouse (run through `scripts/dev-env.sh`, which loads the Keychain values) |

## Connecting Claude Code

Add the server to `.mcp.json` with a placeholder header (`"Authorization": "Bearer ${MCP_BEARER_TOKEN}"`), never the token itself, then launch Claude Code through `scripts/dev-env.sh claude`. `docs/deploy.md` ("Connect Claude Code") includes a check that the token didn't end up in any config file.

## Deployment

Both services and the database run on Railway, defined in `.railway/railway.ts`. Always run `railway config plan` before an apply and never apply a plan that deletes anything. Variables are managed by that file, so declare a new variable there (as `preserve()` for anything sensitive) before setting its value. The runbook in `docs/deploy.md` covers variables per service, rotation, backups, alerts, the courier and the go-live checklist.

## Project layout

```
src/
  api/          internal HTTP API (server) and the CoreApi HTTP client
  core/         createCore: wires the catalog, checks, store, scheduler and API
  query/        menu request → SQL
  guard/        result checks (client names, patterns, small groups)
  data/         Snowflake source and the synthetic source
  dashboard/    layout schema, fill and PDF render
  schedule/     due times, runs, ticker, run lease
  store/        Postgres / PGlite adapter and the state store
  mcp/          MCP tool definitions
  delivery/     best-effort copy of produced PDFs to a private GitHub repo
config/         catalog, reviewed labels, generic words
docs/           spec, plans, runbook (deploy.md), courier prompt, build ledger
```

## Documentation

- `docs/specs/2026-10-16-guarded-karbon-dashboards-design.md`: the design spec (the binding authority)
- `docs/plans/`: implementation and go-live plans
- `docs/deploy.md`: runbook and current status
- `docs/build-ledger-2026-10-16.md`: rulings and deferred findings

People and organisations in these documents appear as role indicators ("the owner", "the firm partner", "IT admin", "the firm") and placeholders such as `<tenant-id>`.

## Licence

No licence file is included. All rights reserved.
