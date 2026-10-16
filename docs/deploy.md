# Deploy notes

## Reconciliation log

Status: **pending manual (the owner)**. Implementers hold no Karbon credentials (ruling R6).

Steps (Task 4, Step 6):

1. Complete the `primary_status` and `stage` reviews in `docs/label-review.md` (gate G5, spec section 9).
2. Within one hour of each other, run:
   - `scripts/dev-env.sh npm run reconcile` (prints `totals`, `by_status`, `by_stage`; exits 1 and prints the code if any is rejected)
   - Snowsight query D, copied from `~/dev/cpa-consulting/karbon-kb/power-bi-demo-build-guide-2026-10-15.md` section 2.2. Copy it; never retype it.
3. Expected: `by_stage` equals query D row for row. `budget_hrs` compared unrounded may differ by up to 0.1 h per row.
4. If `LIVE=1 scripts/dev-env.sh npx vitest run test/live` fails because `NAME_CHECK_SQL` errors in Snowflake, fix the SQL in `src/guard/names.ts` and keep `FixtureNameChecker` matching it.

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
