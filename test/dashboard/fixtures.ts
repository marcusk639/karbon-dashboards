import { loadCatalog } from "../../src/config.js";
import type { MenuRequest, ResultTable } from "../../src/data/types.js";
import type { Layout } from "../../src/dashboard/layout.js";
import type { Snapshot } from "../../src/dashboard/fill.js";
import { FixtureNameChecker } from "../../src/guard/names.js";

export const cat = loadCatalog();
export const names = new FixtureNameChecker(["Avery Lee", "Jordan Quill"], ["the", "and"]);
export const d = { names, catalog: cat };

export const REQS: Record<string, MenuRequest> = {
  totals: { measures: ["jobs", "past_due", "budget_hrs"] },
  by_status: { measures: ["jobs", "past_due"], dimensions: ["primary_status"] },
  by_type: { measures: ["jobs"], dimensions: ["work_type"] },
};

export const LAYOUT: Layout = {
  title: "Open work",
  subtitle: "Weekly",
  tiles: [
    { label: "Open jobs", request: "totals", measure: "jobs", showChange: true },
    { label: "Past due", request: "totals", measure: "past_due", shareOf: "jobs", showChange: true },
    { label: "Budget hours", request: "totals", measure: "budget_hrs", showChange: false },
  ],
  charts: [{ title: "Jobs by status", request: "by_status", dimension: "primary_status", measure: "jobs" }],
  tables: [
    {
      title: "By work type",
      request: "by_type",
      columns: [
        { field: "work_type", label: "Work type" },
        { field: "jobs", label: "Jobs" },
      ],
      sortBy: { field: "jobs", dir: "desc" },
    },
  ],
  notes: ["Numbers come from Karbon."],
};

export const RESULTS: Record<string, ResultTable> = {
  totals: { columns: ["jobs", "past_due", "budget_hrs"], rows: [[238, 95, 1234.56]] },
  by_status: {
    columns: ["primary_status", "jobs", "past_due"],
    rows: [["In Progress", 200, 80], ["Other (unreviewed)", 38, 15]],
  },
  by_type: {
    columns: ["work_type", "jobs"],
    rows: [["Tax", 1200], ["Bookkeeping", 3000], ["Other (unreviewed)", null]],
  },
};

export const EMPTY_RESULTS: Record<string, ResultTable> = {
  totals: { columns: ["jobs", "past_due", "budget_hrs"], rows: [] },
  by_status: { columns: ["primary_status", "jobs", "past_due"], rows: [] },
  by_type: { columns: ["work_type", "jobs"], rows: [] },
};

export const PREV_2026_10_12: Snapshot = {
  periodKey: "2026-10-12",
  totals: {
    totals: { columns: ["jobs", "past_due", "budget_hrs"], rows: [[240, 92, 1000]] },
  },
};
