import { expect, test } from "vitest";
import { findPatterns } from "../../src/guard/patterns.js";
import { FixtureNameChecker } from "../../src/guard/names.js";

test.each([
  ["a.b@x.com", "email"],
  ["(337) 555-0142", "phone"],
  ["123-45-6789", "ssn"],
  ["72-1234567", "ein"],
  ["mcC3q74sXb9Q", "opaque_id"],
])("%s -> %s", (t, k) => expect(findPatterns(t)).toContain(k));

test("ordinary labels pass", () => {
  for (const t of ["Ready To Start", "(no stage recorded)", "Other (unreviewed)", "2026-10-19"])
    expect(findPatterns(t)).toEqual([]);
});

test("urls only flagged when asked", () => {
  expect(findPatterns("see https://x.io")).toEqual([]);
  expect(findPatterns("see www.x.io", { urls: true })).toContain("url");
});

test("short surname caught, generic word ignored", async () => {
  const n = new FixtureNameChecker(["Ng Family Trust", "Lee, Avery"], ["family", "trust"]);
  expect(await n.countMatches(["Waiting on Ng", "Family trust review", "Payroll"])).toEqual([1, 0, 0]);
});

test("full-name containment adds a hit", async () => {
  const n = new FixtureNameChecker(["Lee, Avery"], []);
  expect(await n.countMatches(["x lee, avery y"])).toEqual([3]);
});
