---
title: "Guarded Karbon dashboards — design"
date: 2026-10-16
status: Design for review. Proof of concept as a Node.js service on Railway; developed on the owner's Mac. Nothing built yet. Revised 2026-10-16 after plan review (host moved from Cloud PC to Railway).
owner: Project owner
---

# Guarded Karbon dashboards: design

## 1. What this is and why

The firm's Karbon practice-management data sits in a Snowflake warehouse that Karbon hosts.
The owner wants Claude to answer questions about the firm's **work**, starting with "open
work by stage" for the firm partner's Monday report. The answer should arrive as a dashboard in a
OneDrive folder the firm partner can open, every Monday at 8:00 am Central, with **no client data
ever reaching Claude, a log, or the dashboard**.

The obstacle is that the only warehouse login the firm has sees all 58 Karbon views, including
client names, emails, addresses and client email subjects. That login cannot be narrowed;
only Karbon can create users or permissions in that account. POL-01 (the firm's draft
data-classification and AI-use policy, `docs/issue-synthesis/policies/`) blocks client
records (Class C) and tax-return data (Class D) from any cloud AI tool, and says any
Karbon-connected AI must be scoped to non-client data.

**So this project builds the narrowing itself:** a small always-on service that holds the
warehouse login, lets Claude ask only for approved measures and groupings, computes totals
inside Snowflake, checks everything that comes back for client data, and rejects any result
that fails. Claude sees totals or a rejection, nothing else. The same service runs the
weekly schedule and uploads the dashboard to OneDrive, with no AI involved at run time.

Background reading (in the cpa-consulting repo, `~/dev/cpa-consulting/`):

- `karbon-kb/snowflake-mcp-connection-guide-2026-09-03.md`: why off-the-shelf Snowflake
  MCP servers can't be used (token auth fails with `390432`, and they'd expose every view).
- `karbon-kb/power-bi-demo-build-guide-2026-10-15.md` §2.2: the documented queries A–G.
  Query D is the "open work by stage" definition this project must reproduce.
- `<firm>/karbon-analytics-query-runbook.md`: the documented Karbon queries and the
  connection table.
- `karbon-kb/power-bi-build-spec-2026-09-02.md` §4: the known data traps.

## 2. Goals, non-goals, anti-goals

**Goals (proof of concept)**

1. Answer "open work by stage" with numbers that match Snowsight query D exactly.
2. Let Claude ask **any question that needs no client data**, by combining approved
   measures and groupings, without Claude ever writing SQL.
3. Check every query result for client data **before Claude sees it**, and reject the
   whole result on any hit.
4. Let Claude set up a **schedule** for a question by talking to it. The service keeps the
   schedule and runs it with no one present.
5. Each scheduled run uploads a dashboard file into that question's own folder in the
   OneDrive folder shared with the firm partner.
6. Run as a Node.js service on Railway, written so it can move to Azure later without a
   rewrite.

**Non-goals (not in this version)**

- Client-level questions ("which clients are late"). Those stay in Karbon and Power BI.
- Email delivery. Files go to OneDrive only.
- Connecting from the claude.ai web app or Claude Dashboards. The design keeps that open
  (§4.11); it isn't built now.
- Azure. Phase 2+, and the firm's IT provider controls Azure and Microsoft 365 admin.
- Writing anything back to Karbon.
- Replacing the Power BI work or the owner's existing Monday workbook.
- Staff-level groupings (`ASSIGNED_TO`, per-person utilization). Excluded until the firm partner
  decides (§9).

**Anti-goals (failure even if everything "works")**

- **Any client name, email, phone, address, client ID or client-identifying label
  reaching Claude, a log, Railway's log stream, or OneDrive.** One leak is a failure of the
  whole project.
- **Numbers that disagree with the documented Snowsight queries.** The project's value is
  that its figures can be trusted without re-checking them.
- **A dashboard that changes shape from week to week.** the firm partner reads it every Monday; it
  must look the same each time, with only the numbers moving.
- **A query that silently uses a different set of jobs than the documented definition**
  (for example, forgetting to exclude `Planned` work: 988 rows instead of 239).
- **A silent failure.** If a Monday run doesn't produce a dashboard, the firm partner must be able to
  see that, rather than reading last week's file as if it were current.

## 3. Decisions already made (by the owner)

| #   | Decision                                                                                                                                                                                                         |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Version one answers one question, open work by stage, but the design must be able to answer any question that needs no client data.                                                                              |
| D2  | Every result coming back from Snowflake is checked for client data inside the service. A result with any client data is rejected before any dashboard is built, and Claude never sees it.                        |
| D3  | The system can schedule queries.                                                                                                                                                                                 |
| D4  | The service runs on **Railway as a Node.js service** for the proof of concept, until a fully productized version moves it (most likely Azure). Revised from "Cloud PC" on 2026-10-16.                            |
| D5  | Schedules can be created by talking to Claude, and are stored in the service.                                                                                                                                    |
| D6  | Each scheduled run, **the service** runs the query and builds the dashboard. Claude designs the dashboard once, when the schedule is created; no AI is involved at run time.                                     |
| D7  | Output goes to the OneDrive folder `Claude Dashboards` in the owner's firm OneDrive, which is shared with the firm partner. No email. Each question gets its own subfolder.                                                    |
| D8  | The firm partner sees the dashboard first, with any other information ordered logically around it.                                                                                                                          |
| D9  | Everything lives in a **standalone repo, `~/dev/karbon-dashboards`** (revised 2026-10-16: first a directory in cpa-consulting, moved out so nothing from that repo's history can reach Railway). It is the firm engagement work. |
| D10 | The open-work-by-stage schedule runs **Mondays at 8:00 am Central Time** (`America/Chicago`).                                                                                                                    |

## 4. How it works

```
 the owner, in Claude Code              Scheduled Claude courier (firm Claude account,
 (firm Claude account)               Microsoft 365 connector, as the owner)
        │ remote MCP + sign-in                │ remote MCP + sign-in
        ▼                                      ▼
 ┌──────────────────── Railway, firm-owned account ────────────────────┐
 │  MCP layer: Claude's only way in. Translates tool calls to API calls │
 │        │  internal API calls                                          │
 │        ▼                                                              │
 │  Core API server (Node.js)                                            │
 │    menu → SQL ─────────────────────────────► Snowflake (Karbon)       │
 │    checks on every result ◄───────────────── totals only              │
 │      (name check runs back inside Snowflake)                          │
 │    scheduler (Mon 08:00 America/Chicago) → fill layout → check → PDF  │
 │    pending files, run history, snapshots                              │
 └──────────────────────────────────────────────────────────────────────┘
                     courier uploads pending files
                                   ▼
          OneDrive: Claude Dashboards/<question>/<date>-<question>.pdf
                                        (folder shared with the firm partner)
```

### 4.1 The menu: approved measures and groupings (D1, D2)

Claude never writes SQL. It asks with a structured request: which **measures**, grouped by
which **dimensions**, with which **filters**. The service builds the SQL from a catalog it
owns. Only things in the catalog can be asked for.

The catalog is a configuration file in the project. Each entry gives the SQL expression,
the source view, a plain-English meaning Claude can read (including any trap), and whether
the dimension needs a minimum group size (§4.3).

**Starting catalog, enough for "open work by stage" and nearby questions.** All come from
`KPI_DATABASE.SECURE_VIEWS.WORK_ITEM_DETAILS`, and the expressions must match query D
exactly:

| Kind      | Name                   | Definition (from query D)                                                                     |
| --------- | ---------------------- | --------------------------------------------------------------------------------------------- |
| Cohort    | `active_work`          | `COMPLETED_DATETIME IS NULL AND PRIMARY_STATUS <> 'Planned'` (see note on blank status below) |
| Measure   | `jobs`                 | `COUNT(*)`                                                                                    |
| Measure   | `past_due`             | `COUNT_IF(IS_WORK_ITEM_OVERDUE)` (Karbon's own flag, decided 2026-10-15)                      |
| Measure   | `stuck_over_30d`       | `COUNT_IF(DATEDIFF('day', CURRENT_STATUS_ENTRY_DATE, CURRENT_DATE()) > 30)`                   |
| Measure   | `median_days_in_stage` | `ROUND(MEDIAN(DATEDIFF('day', CURRENT_STATUS_ENTRY_DATE, CURRENT_DATE())), 0)`                |
| Measure   | `median_age_days`      | `ROUND(MEDIAN(DATEDIFF('day', CREATED_DATETIME, CURRENT_DATE())), 0)`                         |
| Measure   | `budget_hrs`           | `ROUND(SUM(COALESCE(BUDGETED_MINUTES,0))/60.0, 1)`                                            |
| Measure   | `budgeted_jobs`        | `COUNT_IF(BUDGETED_MINUTES > 0)`                                                              |
| Dimension | `primary_status`       | `PRIMARY_STATUS`, through the reviewed label list (§4.3)                                      |
| Dimension | `stage`                | `COALESCE(NULLIF(SECONDARY_STATUS,''), '(no stage recorded)')`, through the reviewed list     |
| Dimension | `work_type`            | `WORK_TYPE`, through the reviewed list, minimum group size applies                            |
| Filter    | `due_between`          | `DUE_DATETIME` within a date range (bound parameters)                                         |

- **Every query is restricted to one cohort.** Version one has one cohort, `active_work`.
  The service always adds it; Claude cannot remove it.
- **Blank `PRIMARY_STATUS`:** Snowflake's `<> 'Planned'` already drops a blank status, so
  query D and the cohort agree. Keep the expression exactly as query D has it.
- **`CURRENT_DATE()` is Snowflake's date in the account's session time zone**, not the
  service's clock, so Railway's UTC clock doesn't change the figures. (The session time
  zone itself is still unverified; `SHOW PARAMETERS LIKE 'TIMEZONE'` settles it.)
- **Never allowed, at any time:** any column from the client, contact, email, triage,
  billing, WIP, invoice, payment, custom-field or client-task views; `CLIENT*`,
  `WORK_TITLE`, `WORK_DESCRIPTION`, `INTERNAL_TASK_TITLE`, `SECTION_NAME`, `CONTACT*`,
  `EMAIL*`, `REPORTING_DATE` (it changes every refresh and isn't a real date; build spec
  trap 2).
- **Growing the menu** means adding catalog entries, never code. Each new entry gets the
  same review as the first ones (§8).

### 4.2 Totals are computed inside Snowflake

Every generated query is a `GROUP BY` aggregate. The service never selects individual
rows, so no client row leaves Snowflake, not even to Railway. A request with no grouping
returns one total row.

### 4.3 The checks, before Claude sees anything (D2)

Every result is checked inside the service. **Any failure rejects the whole result.**
Claude receives only `rejected` plus a reason category (for example
`possible client name in column "work_type"`), never the value, and no dashboard is built.
In order:

1. **Column allow-list.** Every returned column must be a catalog measure or dimension.
2. **Reviewed labels, for every text dimension.** `primary_status`, `stage` and
   `work_type` values each pass through an **exact-value** label file (5, 18 and 52 values
   on 2026-10-16; 2 stages and 9 work types contained a rare client-name word). The owner
   gives each value **one of three outcomes**:
   - **approve as is**, only if it names no client;
   - **rename to a generic alias** (for example, a client-specific work type becomes
     "Trust: other"). This is the outcome for any label that names or implies a client;
   - **fold into "Other"**.

   A value not in the file becomes **"Other (unreviewed)"**, and the dashboard says how
   many were folded. Approved and aliased values are exempt from the name check (3) **for
   that exact string only**: The owner's review is the human de-identification POL-01 Class B
   requires. The file records each value's outcome, date and reviewer. A change of even one
   character makes it a new, unreviewed value.

   **Candidate labels never pass through Claude.** the owner lists them himself in Snowsight
   (he can see client data; Claude can't) and writes the outcomes into the label file. The
   file holds only approved strings and aliases, so it can be tracked in git.

3. **Client-name check, run inside Snowflake.** The service never downloads client names.
   It sends the remaining text values (and, for layouts and rendered output, all text)
   back to Snowflake as bound parameters, in a query that compares them with Karbon's
   client and contact names and returns **only the number of matches per input**. That
   keeps §4.2 true. Name sources:
   - `DIMN_CLIENT`: `CLIENT`, `FIRST_NAME`, `MIDDLE_NAME`, `LAST_NAME`, `PREFERRED_NAME`;
   - `DIMN_CLIENT_ACCOUNTING_DETAIL`: `LEGAL_NAME`, `TRADING_NAME`, `BUSINESS_NAME`;
   - `CONTACT_MEMBER_RELATIONSHIP`: `CONTACT`, `RELATED_CONTACT`;
   - `DIMN_ORGANIZATION_MEMBER`: `ORGANIZATION`.

   Match on **whole names and on individual name words of any length**, so short surnames
   such as "Lee" or "Ng" are caught. A word is ignored only if it's on a short, reviewed
   list of ordinary English and accounting words (`payroll`, `tax`, `review`, …), and
   the owner approves every addition. **Never use a frequency rule:** on 2026-10-16 a test
   treated words found in 3 or more client names as generic, and that was wrong because
   family surnames recur across clients.

4. **Pattern check** (in the service): email addresses, phone numbers, EIN or SSN shapes,
   and Karbon client ID shapes.
5. **Minimum group size.** For dimensions that could identify a client by implication
   (`work_type` in v1, and any future person or template dimension), any group smaller
   than **3** is folded into "Other". Status and stage groupings aren't size-limited; a
   stage holding 2 jobs identifies no one.

**The same checks run on two more things:** the layout when it's saved (§4.5), and the
**filled-in layout just before it's rendered to PDF**. Checking the filled-in layout is
the reliable check, because chart labels drawn into a PDF may not come back out as text.
If the renderer allows it, check the PDF's text as well.

**What the checks can't promise.** They catch what they know to look for. That's why the
menu (§4.1) is the main protection and the checks are the backstop. Never rely on the
checks alone.

### 4.4 Schedules (D3, D5, D6, D10)

Claude creates a schedule by calling a service tool with:

- one or more **named menu requests**. A dashboard usually needs several shapes: open work
  by stage needs cohort-wide totals for the tiles (including the two medians, which can't
  be derived from per-stage rows), a by-status result for the bar chart, and a
  by-status-and-stage result for the table. Every request is checked on its own, and
  **if any is rejected, the whole run is rejected**;
- when to run, **with an explicit time zone** (`America/Chicago` for the Monday report).
  Use the service's own scheduler with that zone, not Railway's cron, which runs in UTC
  and would drift an hour at each daylight-saving change;
- a short name, which becomes the OneDrive subfolder (for example `open-work-by-stage`);
- the **dashboard layout** Claude designed (§4.5).

The service saves the schedule in its state store (§4.7) and confirms. Claude can also
list, change, pause, delete, and run a schedule immediately.

**Each scheduled run:** run the requests → check → save the totals as this period's
snapshot (§4.6) → fill the layout → check the filled layout → render the PDF → upload it
and the totals to OneDrive (§4.8). **Claude is not involved at run time.**

- **Exactly once per period.** A restart or redeploy must not run a schedule twice, and a
  run missed while the service was down runs once when it comes back, labelled with the
  time it actually ran.
- **One run at a time per schedule.** Interactive use and the scheduler must not write the
  state store at the same moment.
- **Failures are visible (anti-goal).** If a run is rejected or fails, the service uploads
  a short notice into that question's folder instead, for example
  `2026-10-19-open-work-by-stage — NOT PRODUCED.txt`: "No dashboard this week. The run was
  rejected (possible client data). The owner has been notified." The notice carries only the
  reason category. The service also alerts the owner (builder's choice of channel; a Railway
  notification or an email to the owner is enough).

### 4.5 The dashboard (D6, D7, D8)

**Designed once by Claude, filled in by the service.** When a schedule is created, Claude
writes the layout as a template with named placeholders for the numbers. The service
fills it each run. The template:

- may reference only the schedule's own result fields, plus the run time and the previous
  period's values;
- is checked when saved: no external links, scripts or remote resources, plus the §4.3
  name and pattern checks, so text Claude typed into it is checked too;
- renders without network access.

**Layout rules (D8).** The dashboard fills the top of the page, with supporting detail
below in a logical order. For open work by stage, the builder's default (adjust once with
The owner):

1. Title, "data as of", and a one-line definition of "active work". There is no permitted
   warehouse refresh marker (`REPORTING_DATE` is banned), so "as of" is the **query run
   time**, labelled exactly that way: "Queried from Karbon's warehouse 2026-10-19 08:02
   CT". It must not claim when Karbon last refreshed. **Check once when Karbon's
   warehouse refreshes**; if it's after 8:00 CT on Mondays, the dashboard shows the
   previous working day's data, and the line under the title should say so.
2. **The dashboard:** headline tiles (active jobs, past due with its share, stuck over 30
   days, budgeted hours), each with the change since last week, then a status bar chart
   and the stage table (primary status, stage, jobs, past due, median days in stage,
   median age, stuck over 30 days, budgeted hours), sorted by stuck over 30 days, highest
   first.
3. Underneath: what each measure means, what was folded into "Other" and why, and the
   comparison date used.

Follow `karbon-kb/dashboard-display-guidance-2026-09-03.md`: no dual axes, a table once
there are more than about seven categories, red/amber/green only with text, and say which
ageing measure a visual shows.

**One PDF per run, one page if it fits.** PDF because OneDrive and phones preview it
reliably; OneDrive does not preview HTML.

### 4.6 Week-over-week

Each run's **totals** (never anything else) are kept as a dated snapshot in the state
store **and** uploaded beside the PDF as a small data file, so the history survives a
Railway reset. "Change since last week" comes from the previous snapshot for the same
schedule. The first run shows no change. A missed week compares with the most recent
earlier snapshot and says which date it used.

### 4.7 Hosting on Railway (D4)

- **Two layers, one deployment** (the owner's suggestion, 2026-10-16), on **a firm-owned
  Railway account**, not the owner's personal one (§9, gate G2):
  - **The core API server** holds everything that matters: the catalog, SQL generation,
    the Snowflake connection, the checks, the scheduler, the renderer, the state and the
    pending files. It is the only part that talks to Snowflake.
  - **The MCP layer** is thin: it turns Claude's tool calls into calls to the core API and
    passes back what the API returns. It has no Snowflake access and no logic of its own,
    so every protection lives in one place and can be tested without Claude.
  - **One service or two** on Railway is the builder's call. If two, the core API is
    reachable only on Railway's private network, never from the internet, so the MCP layer
    is the only public door.
  - The split also gives later front doors (an admin page, Claude Dashboards over OAuth,
    an Azure move) the same core with no changes to the protections.
- **State** (schedules, layouts, snapshots, run history) ~~lives in Railway storage, either
  a volume or a small managed database (builder's call).~~ **Superseded 2026-10-16:** the
  state lives in a **Neon Postgres** database reached through `DATABASE_URL` (a Railway
  secret variable), not in a SQLite file on a Railway volume. It contains no client data by
  design: layouts and labels are checked, snapshots are totals. Neon is a new vendor holding
  firm operational data, so it is requested from the firm partner with Railway (gate G2).
  **Superseded 2026-10-17:** a private Postgres service in the same Railway project
  (`postgres-ssl:17`, TLS verified with `DATABASE_CA_CERT`), see docs/deploy.md.
- **Secrets** (the Karbon warehouse password and the MCP sign-in secret; the service holds
  no Microsoft credential, because uploads go through the courier, §4.8) live only in Railway's secret variables. Never in the repo, an image, a log, or
  the MCP config file on the Mac. On the Mac during development, keep them in the
  Keychain and load them into the environment at start.
- **Logs.** Railway keeps the service's console output, so treat the console as an outside
  party. Log per call and per run: time, tool or schedule, the menu request, a hash of the
  generated SQL, row count, the verdict and the reason category. **Never values from a
  rejected result, never client names, never secrets.** Totals from accepted results may
  be logged.
- **The MCP endpoint faces the internet**, so it must require sign-in on every request. For
  the proof of concept, a long random bearer secret that Claude Code sends as a header is
  enough. Add rate limiting, and refuse anything without the secret before doing any
  work. (claude.ai connectors need OAuth; that's phase 2, §4.11.)
- **Snowflake from Railway.** Password sign-in from Railway's network works today because
  Karbon's account has no network policy. If Karbon ever adds an IP allow-list, the
  service needs a fixed outgoing address, which Railway offers on paid plans.
- **Programmatic access tokens won't work** (`390432`; only Karbon can fix it). If Karbon
  or Snowflake turns on MFA for this login, this project and the Power BI refresh break
  together. The service must fail with a clear reason, upload the "not produced" notice,
  and never hang.

### 4.8 Uploading to OneDrive: Claude as courier (D7)

**The owner's decision (2026-10-16):** upload with the Microsoft 365 connector, signed in as
The owner, instead of having the service call Microsoft Graph itself. That avoids any IT
provider involvement. The connector only exists inside a Claude session, so the upload is
done by a **scheduled Claude task acting purely as a courier**:

1. **08:00 Central:** the service runs the schedule, checks everything, renders the PDF
   and holds the finished files as **pending**. No AI is involved in producing them (D6).
2. **About 08:05 Central:** a scheduled Claude task, signed in as the owner with the
   Microsoft 365 connector, asks the service for pending files, uploads each one to
   `Claude Dashboards/<schedule-name>/` (creating the folder on first use), and tells the
   service each file has been delivered. The courier must not alter, summarize or rewrite
   anything; it moves files.

**Files per run:**

- `<YYYY-MM-DD>-<schedule-name>.pdf`, the dashboard;
- `<YYYY-MM-DD>-<schedule-name>.totals.json`, the checked totals (§4.6);
- or `<YYYY-MM-DD>-<schedule-name> — NOT PRODUCED.txt` (§4.4).

**Constraints from the connector** (its upload tool, read 2026-10-16):

- **1 MB per file, no chunked upload.** The PDF must stay under 1 MB; a vector PDF of one
  page does easily, so don't embed large images.
- **PDFs go as base64**, as one unbroken string. The service should hand the courier the
  base64 and the exact byte count, so the upload can be checked against it.
- **Never overwrite.** Upload with "fail if exists". A same-named file means the run
  already happened; mark it delivered and move on.
- The tool needs the OneDrive drive ID and the folder's item ID. Look them up once, on the
  first courier run, and have the service store them.

**What this changes elsewhere:**

- **Claude sees the finished dashboard** while carrying it. That's covered: The firm partner has
  approved Claude and the firm has a subscription (G3, cleared 2026-10-16). The courier
  runs under the **firm** Claude account, never the owner's personal one.
- **Why the core API can't upload by itself.** The Microsoft 365 connector exists only
  inside Claude sessions; a server can't borrow it. For the core API to upload with no
  Claude involved, it would need its own Microsoft Graph permission from the IT provider,
  which is the productized path below.
- **The courier task has to reach the service.** **Verify before relying on it** (build
  step 7): which scheduled-task feature runs it (a Claude Code cloud routine or a claude.ai
  scheduled task), whether that feature can use both the Microsoft 365 connector and a
  custom connector to this service, and which sign-in the custom connector needs. claude.ai
  custom connectors generally expect OAuth rather than a fixed secret, so the service may
  need OAuth sooner than phase 2.
- **If the courier fails,** nothing new appears for the firm partner and nothing says why. So the
  service alerts the owner if any pending file is still undelivered at **08:30 Central**.
- **Graph directly from the service** (an app permission approved by the IT provider)
  remains the productized path. It removes the courier, so delivery stops depending on an
  AI session.

### 4.9 Tools Claude sees (the MCP layer)

Each tool maps to a core API call. The builder names them, but the set covers:

- **See the menu:** measures, dimensions, filters and cohorts with their meanings.
- **Ask a question:** run a menu request and get totals or a rejection. Every result
  carries the query run time and the generated SQL text (catalog expressions only, no
  data), and is a plain table of totals.
- **Preview a dashboard:** fill a layout and return the PDF, without uploading, so Claude
  and the owner can check it before saving a schedule.
- **Manage schedules:** create, list, update, pause, delete, run now.
- **See recent runs:** status per run (uploaded, rejected, failed) with reason categories.
- **Courier:** list pending files (with base64 content and exact byte counts) and mark a
  file delivered. Only the courier needs these.

No tool runs free-form SQL, reads a view outside the catalog, returns individual rows, or
returns label candidates.

### 4.10 Synthetic mode, for design and tests

With Claude approved (G3), Claude may work with live totals. A synthetic mode is still
worth having: the core API answers menu requests from a fixture of made-up totals with the
same shapes as the real ones. Use it for the automated tests, and for designing and
previewing layouts without waiting on Snowflake. Live numbers are reconciled with a
command-line runner on the Mac, with no Claude in the loop, so the reconciliation can't be
influenced by how Claude asks (§8).

### 4.11 How this relates to Claude Dashboards

Anthropic's Claude Dashboards
([help article](https://support.claude.com/en/articles/17454700-get-started-with-claude-dashboards),
read 2026-10-16) is the obvious off-the-shelf alternative:

- **Why not use it directly on Karbon's warehouse.** "Claude writes a SQL query for each
  chart and runs it against your data source." Connected to Karbon's warehouse, Claude
  would write SQL against all 58 views, and each new question would be fresh SQL rather
  than the documented query.
- **The later route it opens.** A dashboard can also be built from "other apps you've
  connected to Claude". Because this service already has an HTTPS endpoint on Railway,
  adding OAuth would let it be connected in claude.ai, and Claude Dashboards could draw
  charts from the menu tools instead of raw SQL. **Unverified:** whether such a dashboard
  refreshes itself the way warehouse dashboards do. Test it before relying on it.
- **Choices that keep that route open now:** each result carries its run time and
  generated SQL, and results are plain tables of totals (§4.9).
- **Availability:** beta on Pro, Max, Team and Enterprise plans; on Enterprise it's off
  until an owner turns it on (Organization settings → Artifacts). Dashboards start private
  and are shared with a Share button. A firm deployment means a firm-administered plan.

## 5. Build order

Each step ends with something that runs. The riskiest unknowns come first.

1. **Ask for G2 straight away** (§9: the firm-owned Railway account holding the Karbon
   password). It takes calendar time; building continues on the Mac meanwhile.
2. **Bare end-to-end on the Mac, no Claude:** catalog → SQL → live query D → totals → a
   plain PDF on disk. Reconcile against Snowsight the same day (§8.1).
3. **The checks (§4.3)**, each with a test that makes it fire (§8.2).
4. **The MCP layer over the core API**, connected from Claude Code on the Mac: the menu,
   questions, layout preview, first in synthetic mode, then live.
5. **Schedules and the scheduler**, including exactly-once, the failure notice and
   week-over-week.
6. **Railway deploy** (after G2): secrets, sign-in, rate limit, logs reviewed for leaks.
7. **Courier delivery:** verify the scheduled-task feature can reach both the service and
   the Microsoft 365 connector (§4.8), then deliver the first real Monday run by hand.
   The owner checks it before he shares the folder with the firm partner. Then switch on the scheduled
   courier under the firm Claude account.

## 6. Data handling in the repo

- Runtime state (schedules, snapshots, run history, previews) never goes in the repo. Add
  ignore rules for any local state directory before the first run.
- The label file (§4.3, approved strings and aliases only) and the generic-word list may be
  tracked, because they contain only reviewed non-client text. Re-check that before every
  commit.
- **Tests must not use real client data in tracked files.** Use synthetic fixtures,
  including made-up client names for the guard tests. The 2026-10-16 full export
  (`<firm>/exports/2026-10-16-karbon-full/`, gitignored) may be used for local checks only,
  never copied into the project.
- **Scan staged diffs before every commit** for client names and credential shapes, as the
  root `CLAUDE.md` requires.
- **This repo holds only this project**, so deploying it can't carry anything else. (That's why
  it left cpa-consulting, whose history carries compensation figures that must never
  reach a hosting service.)

## 7. What's left to the builder

Libraries (the MCP TypeScript SDK and Snowflake's Node driver are the obvious starting
points), the catalog and label file formats, the state store, the template engine, the PDF
renderer (one that doesn't need a full browser keeps the image small, but either is fine on
Railway), tool names and parameter shapes, project layout, the alert channel, and the
test setup. Keep it small: one service.

## 8. Acceptance: how we know it works

1. **Numbers match.** The test that counts is **live and same-day**: run the service's
   open-work-by-stage requests from the command-line runner and Snowsight query D (copied
   from the demo guide, never retyped) within the same hour, and compare row for row.
   `CURRENT_DATE()` stays in the expressions exactly as query D has it; there's no as-of
   date parameter. Separately:
   - **Unit tests** use synthetic fixtures and compare the generated SQL's expressions with
     query D's text, so no warehouse is needed.
   - **For orientation only,** the 2026-10-16 export gave 239 active, 95 past due, 87
     stuck over 30 days, 237 budgeted, status split 106 / 94 / 39, median days in stage
     18, median age 107 and 714.0 budgeted hours. Later runs will differ.
   - Query D rounds budgeted hours per row, so a summed figure can differ from the
     unrounded total by up to about a tenth of an hour per row. Compare unrounded.
2. **The checks fire.** Break each one on purpose and watch it reject (a guard never seen
   failing is not a guard; see the `transform-verification` skill):
   - a menu request naming a disallowed column is refused before any SQL runs;
   - a result carrying a made-up client name, including a 2-letter surname, is rejected,
     and Claude gets only the reason category;
   - an email, phone or ID shape in a result is rejected;
   - a work-type group of 2 is folded into "Other";
   - an unreviewed label becomes "Other (unreviewed)", and an aliased label shows its
     alias;
   - a layout containing a client name, a link or a script is refused when saved;
   - a filled-in layout containing a client name is blocked before rendering, and nothing
     is uploaded except the "not produced" notice.
3. **Nothing leaks into logs.** After the guard tests, Railway's log stream and the run
   history hold reason categories and no rejected values.
4. **Schedules work on Railway.** Create a schedule from Claude Code, close Claude, and the
   service has the PDF and totals file pending at 8:00 Central; the courier puts
   them in the right OneDrive subfolder by about 8:05. Re-running the courier uploads
   nothing twice, and an undelivered file triggers the 8:30 alert. Redeploy
   during the scheduled minute: the run happens once, not twice and not zero times. Across
   a daylight-saving change it still runs at 8:00 Central.
5. **Week-over-week works** across two runs, and the dashboard says which date it compared
   with.
6. **Failures are visible.** Force a rejection: the "not produced" notice appears in the
   folder and the owner is alerted.
7. **The endpoint refuses strangers.** A request without the sign-in secret is refused
   before any query runs.
8. **Secrets stay secret.** No secret appears in the repo, the image, logs or the Mac's
   MCP config.

## 9. Gates (decisions outside the build)

| Gate | Who    | What                                                                                                                                                                                                                                                                                             | Blocks                                      |
| ---- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------- |
| G1   | —      | ~~Microsoft Graph upload permission from the IT provider~~ **Not needed for the proof of concept** (2026-10-16): uploads go through the Microsoft 365 connector as the owner (§4.8). Needed again only for the productized, courier-free path. **Revisited 2026-10-17:** the connector itself holds only read permissions in the firm tenant, so the courier needs a one-time delegated consent for `Files.ReadWrite.All` on the owner's account from the IT provider (see docs/deploy.md, "Courier and the Microsoft 365 connector")                                                       | —                                           |
| G2   | The firm partner  | A **firm-owned Railway account** holding the Karbon warehouse password, and Railway as a new vendor for firm systems. Under POL-01 and the GLBA Safeguards Rule this is a firm decision: the password opens every client record in the warehouse, even though the service only ever pulls totals | Railway deploy (step 6)                     |
| G3   | The firm partner  | ~~Claude approved as a firm tool~~ **Cleared 2026-10-16** (per the owner): The firm partner approved Claude and the firm has a subscription. Still to do: add a line to POL-01 describing this pipeline, and run all Claude use for it under the firm account                                                  | —                                           |
| G4   | The firm partner  | Staff-level groupings (`ASSIGNED_TO`, per-person utilization). Personnel data, not client data                                                                                                                                                                                                   | Any staff dimension. Excluded until decided |
| G5   | The owner | Review the label file (status, stage, work type) and the generic-word list                                                                                                                                                                                                                       | The first live run                          |
| G6   | The owner | Share the OneDrive `Claude Dashboards` folder with the firm partner, after checking the first real PDF                                                                                                                                                                                                      | The firm partner seeing anything                       |

**If G2 is refused,** the fallback is the Cloud PC: the same service runs there,
writing into the synced OneDrive folder from a signed-in session that's disconnected
rather than signed out, because OneDrive only syncs while the user is signed in.
