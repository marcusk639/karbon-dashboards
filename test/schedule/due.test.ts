import { expect, test } from "vitest";
import { latestOccurrence } from "../../src/schedule/due.js";

const MON8 = { weekday: 1, time: "08:00", timezone: "America/Chicago" } as const;

test("Monday 08:00 CDT is 13:00Z", () =>
  expect(latestOccurrence(MON8, new Date("2026-10-19T13:00:00Z"))).toEqual({
    at: new Date("2026-10-19T13:00:00Z"),
    periodKey: "2026-10-19",
  }));
test("one minute early -> previous week", () =>
  expect(latestOccurrence(MON8, new Date("2026-10-19T12:59:00Z"))!.periodKey).toBe("2026-10-12"));
test("after DST ends, 08:00 CST is 14:00Z", () => {
  expect(latestOccurrence(MON8, new Date("2026-11-02T13:30:00Z"))!.periodKey).toBe("2026-10-26");
  expect(latestOccurrence(MON8, new Date("2026-11-02T14:00:00Z"))).toEqual({
    at: new Date("2026-11-02T14:00:00Z"),
    periodKey: "2026-11-02",
  });
});
test("mid-week returns the most recent Monday", () =>
  expect(latestOccurrence(MON8, new Date("2026-10-23T20:00:00Z"))!.periodKey).toBe("2026-10-19"));
test("bad time format throws", () => {
  expect(() => latestOccurrence({ ...MON8, time: "8am" }, new Date())).toThrow();
  expect(() => latestOccurrence({ ...MON8, time: "25:00" }, new Date())).toThrow();
});
test("bad timezone throws", () =>
  expect(() => latestOccurrence({ ...MON8, timezone: "Nowhere/Land" }, new Date())).toThrow());
