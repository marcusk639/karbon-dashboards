import { expect, test } from "vitest";
import { findPatterns } from "../../src/guard/patterns.js";
import { FixtureNameChecker, NAME_CHECK_SQL, assertCounts } from "../../src/guard/names.js";

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

// I1: whole-name matching is on word boundaries, and only for names of two or more words.
test("a single-word name inside a longer word is not a hit", async () => {
  const n = new FixtureNameChecker(["Mary", "Chan"], []);
  expect(await n.countMatches(["Primary status", "Change since last week"])).toEqual([0, 0]);
});

test("a single-word name on the generic list is not a hit even as a whole word", async () => {
  const n = new FixtureNameChecker(["Status"], ["status"]);
  expect(await n.countMatches(["Primary status"])).toEqual([0]);
});

test("a multi-word name is matched on word boundaries", async () => {
  const n = new FixtureNameChecker(["Mary Smith"], ["mary", "smith"]);
  expect(await n.countMatches(["Mary Smith review", "rosemary smithson", "MARY-SMITH."])).toEqual([1, 0, 1]);
});

test("a multi-word name made of generic words is still caught as a phrase", async () => {
  const n = new FixtureNameChecker(["Ng Family Trust"], ["ng", "family", "trust"]);
  expect(await n.countMatches(["the ng family trust return", "family trust review"])).toEqual([1, 0]);
});

test("NAME_CHECK_SQL mirrors the fixture: phrase only for multi-word names, padded on word boundaries", () => {
  expect(NAME_CHECK_SQL).toMatch(/norm_name LIKE '% %'/);
  expect(NAME_CHECK_SQL).toContain("CONTAINS(' ' || i.norm_txt || ' ', ' ' || nm.norm_name || ' ')");
  expect(NAME_CHECK_SQL).not.toMatch(/CONTAINS\(i\.txt/);
});

// I2: a checker must return one finite non-negative integer per input, in input order.
test("assertCounts rejects NaN, negatives, fractions and wrong lengths", () => {
  expect(() => assertCounts([NaN], 1)).toThrow();
  expect(() => assertCounts([-1], 1)).toThrow();
  expect(() => assertCounts([0.5], 1)).toThrow();
  expect(() => assertCounts([0], 2)).toThrow();
  expect(() => assertCounts([0, 2], 2)).not.toThrow();
});
