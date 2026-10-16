import { memStore } from "../helpers/store.js";
import { expect, test } from "vitest";
import { type NewSchedule } from "../../src/store/db.js";
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

test("schedule CRUD round-trips JSON fields", async () => {
  const s = await memStore();
  const id = await s.createSchedule(SCHED);
  const got = await s.getSchedule(id)!;
  expect(got).toMatchObject({ id, name: SCHED.name, slug: SCHED.slug, cadence: SCHED.cadence, requests: SCHED.requests, layout: SCHED.layout, paused: false });
  expect(new Date(got.createdAt).toString()).not.toBe("Invalid Date");
  await s.updateSchedule(id, { name: "Renamed" });
  expect((await s.getSchedule(id))!.name).toBe("Renamed");
  await s.setPaused(id, true);
  expect((await s.listSchedules())[0]!.paused).toBe(true);
  expect(await s.getSchedule(999)).toBeNull();
});

test("createSchedule stamps the injected time", async () => {
  const s = await memStore();
  const id = await s.createSchedule(SCHED, T);
  expect((await s.getSchedule(id))!.createdAt).toBe(T.toISOString());
});

test("deleteSchedule cascades to runs, files and snapshots", async () => {
  const s = await memStore();
  const id = await s.createSchedule(SCHED);
  const run = await s.claimRun(id, "2026-10-19", T)!;
  await s.addFile(run, FILE);
  await s.saveSnapshot(run, { periodKey: "2026-10-19", totals: {} });
  await s.deleteSchedule(id);
  expect(await s.getSchedule(id)).toBeNull();
  expect(await s.listRuns(10)).toEqual([]);
  expect(await s.pendingFiles()).toEqual([]);
  expect(await s.previousSnapshot(id, "2099-01-01")).toBeNull();
});

test("claimRun is exactly-once; interrupted runs can be re-claimed", async () => {
  const s = await memStore();
  const id = await s.createSchedule(SCHED);
  expect(await s.claimRun(id, "2026-10-19", T)).not.toBeNull();
  expect(await s.claimRun(id, "2026-10-19", T)).toBeNull();
  expect(await s.recoverInterrupted(new Date(T.getTime() + 16 * 60_000))).toBe(1);
  expect(await s.claimRun(id, "2026-10-19", T)).not.toBeNull();
});

test("recoverInterrupted leaves young runs; finished runs are never re-claimed", async () => {
  const s = await memStore();
  const id = await s.createSchedule(SCHED);
  const run = await s.claimRun(id, "2026-10-19", T)!;
  expect(await s.recoverInterrupted(new Date(T.getTime() + 5 * 60_000))).toBe(0);
  await s.finishRun(run, "rejected", "client_name");
  expect(await s.claimRun(id, "2026-10-19", T)).toBeNull();
  expect(await s.recoverInterrupted(new Date(T.getTime() + 60 * 60_000))).toBe(0);
});

test("listRuns newest first with code and finish time", async () => {
  const s = await memStore();
  const id = await s.createSchedule(SCHED);
  const r1 = await s.claimRun(id, "2026-10-12", new Date("2026-10-12T13:00:00Z"))!;
  await s.finishRun(r1, "produced", undefined, new Date("2026-10-12T13:05:00Z"));
  const r2 = await s.claimRun(id, "2026-10-19", T)!;
  await s.finishRun(r2, "rejected", "pattern_match");
  const runs = await s.listRuns(10);
  expect(runs.map((r) => r.runId)).toEqual([r2, r1]);
  expect(runs[0]).toMatchObject({ scheduleId: id, periodKey: "2026-10-19", status: "rejected", code: "pattern_match" });
  expect(runs[0]!.finishedAt).not.toBeNull();
  expect(runs[1]!.code).toBeNull();
  expect(await s.listRuns(1)).toHaveLength(1);
});

test("pending, delivered and alerting", async () => {
  const s = await memStore();
  const id = await s.createSchedule(SCHED);
  const run = await s.claimRun(id, "2026-10-19", T)!;
  const fileId = await s.addFile(run, FILE, T);
  const pending = await s.pendingFiles();
  expect(pending).toHaveLength(1);
  expect(pending[0]).toMatchObject({ fileId, runId: run, folder: "Weekly", filename: "a.pdf", contentType: "application/pdf", bytes: 6 });
  expect(pending[0]!.content.equals(FILE.content)).toBe(true);
  expect(typeof pending[0]!.createdAt).toBe("string");

  const at = (min: number) => new Date(T.getTime() + min * 60_000);
  expect(await s.undeliveredOlderThan(30, at(29))).toEqual([]);
  expect((await s.undeliveredOlderThan(30, at(31))).map((f) => f.fileId)).toEqual([fileId]);
  await s.markAlerted(fileId, at(31));
  expect(await s.undeliveredOlderThan(30, at(40))).toEqual([]);
  expect(await s.pendingFiles()).toHaveLength(1); // alerted but still undelivered
  await s.markDelivered(fileId, at(61));
  expect(await s.pendingFiles()).toEqual([]);

  const f2 = await s.addFile(run, { ...FILE, filename: "b.pdf" });
  await s.markDelivered(f2, new Date());
  expect(await s.undeliveredOlderThan(30, at(120))).toEqual([]);
});

test("previousSnapshot returns the latest strictly before the date", async () => {
  const s = await memStore();
  const id = await s.createSchedule(SCHED);
  const other = await s.createSchedule({ ...SCHED, slug: "other" });
  const tot = (n: number) => ({ x: { columns: ["n"], rows: [[n]] } });
  for (const [d, n] of [["2026-10-05", 1], ["2026-10-12", 2], ["2026-10-19", 3]] as const) {
    const r = await s.claimRun(id, d, T)!;
    await s.saveSnapshot(r, { periodKey: d, totals: tot(n) });
  }
  const ro = await s.claimRun(other, "2026-10-12", T)!;
  await s.saveSnapshot(ro, { periodKey: "2026-10-12", totals: tot(99) });
  expect(await s.previousSnapshot(id, "2026-10-19")).toEqual({ periodKey: "2026-10-12", totals: tot(2) });
  expect(await s.previousSnapshot(id, "2026-10-05")).toBeNull();
  expect((await s.previousSnapshot(id, "2026-10-20"))!.periodKey).toBe("2026-10-19");
});

test("targets set/get/overwrite", async () => {
  const s = await memStore();
  expect(await s.getTargets()).toEqual({});
  await s.setTarget("Weekly", { driveId: "d1", itemId: "i1" });
  await s.setTarget("Weekly", { driveId: "d2", itemId: "i2" });
  await s.setTarget("Other", { driveId: "d3", itemId: "i3" });
  expect(await s.getTargets()).toEqual({ Weekly: { driveId: "d2", itemId: "i2" }, Other: { driveId: "d3", itemId: "i3" } });
});
