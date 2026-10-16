import { expect, test } from "vitest";
import { openStore, type NewSchedule } from "../../src/store/db.js";
import type { Layout } from "../../src/dashboard/layout.js";

const SCHED: NewSchedule = {
  name: "Weekly open work",
  slug: "weekly-open-work",
  cadence: { weekday: 1, time: "08:00", timezone: "America/Chicago" },
  requests: { a: { measures: ["open_jobs"], dimensions: ["work_type"] } },
  layout: { title: "T" } as unknown as Layout,
};
const T = new Date("2026-10-19T13:00:00Z");
const FILE = { folder: "Weekly", filename: "a.pdf", content: Buffer.from("%PDF-x"), contentType: "application/pdf" };

test("schedule CRUD round-trips JSON fields", () => {
  const s = openStore(":memory:");
  const id = s.createSchedule(SCHED);
  const got = s.getSchedule(id)!;
  expect(got).toMatchObject({ id, name: SCHED.name, slug: SCHED.slug, cadence: SCHED.cadence, requests: SCHED.requests, layout: SCHED.layout, paused: false });
  expect(new Date(got.createdAt).toString()).not.toBe("Invalid Date");
  s.updateSchedule(id, { name: "Renamed" });
  expect(s.getSchedule(id)!.name).toBe("Renamed");
  s.setPaused(id, true);
  expect(s.listSchedules()[0]!.paused).toBe(true);
  expect(s.getSchedule(999)).toBeNull();
});

test("deleteSchedule cascades to runs, files and snapshots", () => {
  const s = openStore(":memory:");
  const id = s.createSchedule(SCHED);
  const run = s.claimRun(id, "2026-10-19", T)!;
  s.addFile(run, FILE);
  s.saveSnapshot(run, { periodKey: "2026-10-19", totals: {} });
  s.deleteSchedule(id);
  expect(s.getSchedule(id)).toBeNull();
  expect(s.listRuns(10)).toEqual([]);
  expect(s.pendingFiles()).toEqual([]);
  expect(s.previousSnapshot(id, "2099-01-01")).toBeNull();
});

test("claimRun is exactly-once; interrupted runs can be re-claimed", () => {
  const s = openStore(":memory:");
  const id = s.createSchedule(SCHED);
  expect(s.claimRun(id, "2026-10-19", T)).not.toBeNull();
  expect(s.claimRun(id, "2026-10-19", T)).toBeNull();
  expect(s.recoverInterrupted(new Date(T.getTime() + 16 * 60_000))).toBe(1);
  expect(s.claimRun(id, "2026-10-19", T)).not.toBeNull();
});

test("recoverInterrupted leaves young runs; finished runs are never re-claimed", () => {
  const s = openStore(":memory:");
  const id = s.createSchedule(SCHED);
  const run = s.claimRun(id, "2026-10-19", T)!;
  expect(s.recoverInterrupted(new Date(T.getTime() + 5 * 60_000))).toBe(0);
  s.finishRun(run, "rejected", "client_name");
  expect(s.claimRun(id, "2026-10-19", T)).toBeNull();
  expect(s.recoverInterrupted(new Date(T.getTime() + 60 * 60_000))).toBe(0);
});

test("listRuns newest first with code and finish time", () => {
  const s = openStore(":memory:");
  const id = s.createSchedule(SCHED);
  const r1 = s.claimRun(id, "2026-10-12", new Date("2026-10-12T13:00:00Z"))!;
  s.finishRun(r1, "produced");
  const r2 = s.claimRun(id, "2026-10-19", T)!;
  s.finishRun(r2, "rejected", "pattern_match");
  const runs = s.listRuns(10);
  expect(runs.map((r) => r.runId)).toEqual([r2, r1]);
  expect(runs[0]).toMatchObject({ scheduleId: id, periodKey: "2026-10-19", status: "rejected", code: "pattern_match" });
  expect(runs[0]!.finishedAt).not.toBeNull();
  expect(runs[1]!.code).toBeNull();
  expect(s.listRuns(1)).toHaveLength(1);
});

test("pending, delivered and alerting", () => {
  const s = openStore(":memory:");
  const id = s.createSchedule(SCHED);
  const run = s.claimRun(id, "2026-10-19", T)!;
  const fileId = s.addFile(run, FILE);
  const pending = s.pendingFiles();
  expect(pending).toHaveLength(1);
  expect(pending[0]).toMatchObject({ fileId, runId: run, folder: "Weekly", filename: "a.pdf", contentType: "application/pdf", bytes: 6 });
  expect(pending[0]!.content.equals(FILE.content)).toBe(true);
  expect(typeof pending[0]!.createdAt).toBe("string");

  const at = (min: number) => new Date(Date.now() + min * 60_000);
  expect(s.undeliveredOlderThan(30, new Date())).toEqual([]);
  expect(s.undeliveredOlderThan(30, at(31)).map((f) => f.fileId)).toEqual([fileId]);
  s.markAlerted(fileId, at(31));
  expect(s.undeliveredOlderThan(30, at(60))).toEqual([]);
  expect(s.pendingFiles()).toHaveLength(1); // alerted but still undelivered
  s.markDelivered(fileId, at(61));
  expect(s.pendingFiles()).toEqual([]);

  const f2 = s.addFile(run, { ...FILE, filename: "b.pdf" });
  s.markDelivered(f2, new Date());
  expect(s.undeliveredOlderThan(30, at(120))).toEqual([]);
});

test("previousSnapshot returns the latest strictly before the date", () => {
  const s = openStore(":memory:");
  const id = s.createSchedule(SCHED);
  const other = s.createSchedule({ ...SCHED, slug: "other" });
  const tot = (n: number) => ({ x: { columns: ["n"], rows: [[n]] } });
  for (const [d, n] of [["2026-10-05", 1], ["2026-10-12", 2], ["2026-10-19", 3]] as const) {
    const r = s.claimRun(id, d, T)!;
    s.saveSnapshot(r, { periodKey: d, totals: tot(n) });
  }
  const ro = s.claimRun(other, "2026-10-12", T)!;
  s.saveSnapshot(ro, { periodKey: "2026-10-12", totals: tot(99) });
  expect(s.previousSnapshot(id, "2026-10-19")).toEqual({ periodKey: "2026-10-12", totals: tot(2) });
  expect(s.previousSnapshot(id, "2026-10-05")).toBeNull();
  expect(s.previousSnapshot(id, "2026-10-20")!.periodKey).toBe("2026-10-19");
});

test("targets set/get/overwrite", () => {
  const s = openStore(":memory:");
  expect(s.getTargets()).toEqual({});
  s.setTarget("Weekly", { driveId: "d1", itemId: "i1" });
  s.setTarget("Weekly", { driveId: "d2", itemId: "i2" });
  s.setTarget("Other", { driveId: "d3", itemId: "i3" });
  expect(s.getTargets()).toEqual({ Weekly: { driveId: "d2", itemId: "i2" }, Other: { driveId: "d3", itemId: "i3" } });
});
