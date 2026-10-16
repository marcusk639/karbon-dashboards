import { expect, test } from "vitest";
import { loadCatalog } from "../../src/config.js";
import { validateRequest } from "../../src/query/build.js";
import { OPEN_WORK_REQUESTS } from "../../src/requests/open-work.js";

const cat = loadCatalog();
test.each(Object.entries(OPEN_WORK_REQUESTS))("%s validates against the real catalog", (_n, req) => {
  expect(() => validateRequest(req, cat)).not.toThrow();
});
test("by_stage is the Task 2 OPEN_WORK request", () => {
  expect(OPEN_WORK_REQUESTS.by_stage.dimensions).toEqual(["primary_status", "stage"]);
  expect(OPEN_WORK_REQUESTS.totals.dimensions ?? []).toEqual([]);
});
