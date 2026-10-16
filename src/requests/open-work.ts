import type { MenuRequest } from "../data/types.js";

/** The three open-work requests used for reconciliation against Snowsight query D (and reused by Task 9). */
export const OPEN_WORK_REQUESTS: Record<"totals" | "by_status" | "by_stage", MenuRequest> = {
  totals: {
    measures: [
      "jobs",
      "past_due",
      "stuck_over_30d",
      "median_days_in_stage",
      "median_age_days",
      "budget_hrs",
      "budgeted_jobs",
    ],
  },
  by_status: { measures: ["jobs"], dimensions: ["primary_status"] },
  by_stage: {
    measures: ["jobs", "past_due", "median_days_in_stage", "median_age_days", "stuck_over_30d", "budget_hrs"],
    dimensions: ["primary_status", "stage"],
    orderBy: [
      { field: "stuck_over_30d", dir: "desc" },
      { field: "jobs", dir: "desc" },
    ],
  },
};
