import { expect, test } from "vitest";
import { loadCatalog, loadGenericWords, parseLabels } from "../src/config.js";

test("catalog expressions are verbatim from query D", () => {
  const c = loadCatalog();
  expect(c.measures.stuck_over_30d.expr).toBe(
    "COUNT_IF(DATEDIFF('day', CURRENT_STATUS_ENTRY_DATE, CURRENT_DATE()) > 30)",
  );
  expect(c.dimensions.stage.expr).toBe(
    "COALESCE(NULLIF(SECONDARY_STATUS,''), '(no stage recorded)')",
  );
  expect(c.cohorts.active_work.where).toBe(
    "COMPLETED_DATETIME IS NULL AND PRIMARY_STATUS <> 'Planned'",
  );
  expect(c.dimensions.work_type.minGroup).toBe(3);
});
test("labels file rejects an alias outcome without an alias string", () => {
  expect(() =>
    parseLabels({
      primary_status: {},
      stage: {
        X: { outcome: "alias", date: "2026-10-16", reviewer: "Marcus Klein" },
      },
      work_type: {},
    }),
  ).toThrow();
});
test("generic words are lower-cased", () => {
  expect(loadGenericWords().every((w) => w === w.toLowerCase())).toBe(true);
});
