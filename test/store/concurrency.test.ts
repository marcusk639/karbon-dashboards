import { expect, test } from "vitest";
import { memStore } from "../helpers/store.js";
import type { NewSchedule } from "../../src/store/db.js";
import type { Layout } from "../../src/dashboard/layout.js";

const SCHED: NewSchedule = {
  name: "Weekly open work",
  slug: "weekly-open-work",
  cadence: { weekday: 1, time: "08:00", timezone: "America/Chicago" },
  requests: { a: { measures: ["open_jobs"], dimensions: ["work_type"] } },
  layout: { title: "T" } as unknown as Layout,
};
const T = new Date("2026-10-19T13:00:00Z");

test("two concurrent claimRun calls for one period: exactly one wins", async () => {
  const s = await memStore();
  const id = await s.createSchedule(SCHED);
  const got = await Promise.all([s.claimRun(id, "2026-10-19", T), s.claimRun(id, "2026-10-19", T)]);
  expect(got.filter((x) => x !== null)).toHaveLength(1);
  expect(await s.listRuns(10)).toHaveLength(1);
});

test("concurrent re-claim of an interrupted run: exactly one wins", async () => {
  const s = await memStore();
  const id = await s.createSchedule(SCHED);
  await s.claimRun(id, "2026-10-19", T);
  await s.recoverInterrupted(new Date(T.getTime() + 60 * 60_000));
  const got = await Promise.all([s.claimRun(id, "2026-10-19", T), s.claimRun(id, "2026-10-19", T), s.claimRun(id, "2026-10-19", T)]);
  expect(got.filter((x) => x !== null)).toHaveLength(1);
});

test("a transaction that throws rolls everything back", async () => {
  const s = await memStore();
  const id = await s.createSchedule(SCHED);
  const run = (await s.claimRun(id, "2026-10-19", T))!;
  await expect(
    s.transaction(async (tx) => {
      await tx.addFile(run.runId, { folder: "F", filename: "a.pdf", content: Buffer.from("x"), contentType: "application/pdf" });
      await tx.saveSnapshot(run.runId, { periodKey: "2026-10-19", totals: {} });
      await tx.finishRun(run, "produced");
      throw new Error("boom");
    }),
  ).rejects.toThrow("boom");
  expect(await s.pendingFiles()).toEqual([]);
  expect(await s.previousSnapshot(id, "2099-01-01")).toBeNull();
  expect((await s.listRuns(1))[0]!.status).toBe("running");
});

test("a committed transaction lands all writes and returns the callback's value", async () => {
  const s = await memStore();
  const id = await s.createSchedule(SCHED);
  const run = (await s.claimRun(id, "2026-10-19", T))!;
  const fileId = await s.transaction(async (tx) => {
    const f = await tx.addFile(run.runId, { folder: "F", filename: "a.pdf", content: Buffer.from("x"), contentType: "application/pdf" });
    await tx.finishRun(run, "produced");
    return f;
  });
  expect((await s.pendingFiles()).map((f) => f.fileId)).toEqual([fileId]);
  expect((await s.listRuns(1))[0]!.status).toBe("produced");
});

test("a PDF buffer round-trips through BYTEA byte for byte", async () => {
  const s = await memStore();
  const id = await s.createSchedule(SCHED);
  const run = (await s.claimRun(id, "2026-10-19", T))!;
  const pdf = Buffer.alloc(300_000);
  for (let i = 0; i < pdf.length; i++) pdf[i] = (i * 31 + 7) % 256; // every byte value, incl. 0x00 and 0xff
  pdf.write("%PDF-1.7\n", 0, "latin1");
  await s.addFile(run.runId, { folder: "F", filename: "a.pdf", content: pdf, contentType: "application/pdf" });
  const [f] = await s.pendingFiles();
  expect(Buffer.isBuffer(f!.content)).toBe(true);
  expect(f!.bytes).toBe(pdf.length);
  expect(f!.content.equals(pdf)).toBe(true);
});

test("opening the store twice on one database is idempotent and keeps data", async () => {
  const { createPgliteDb } = await import("../../src/store/adapter.js");
  const { openStore } = await import("../../src/store/db.js");
  const db = await createPgliteDb();
  const a = await openStore(db);
  await a.createSchedule(SCHED);
  const b = await openStore(db);
  expect(await b.listSchedules()).toHaveLength(1);
  const v = await db.query<{ version: number }>("SELECT version FROM schema_version");
  expect(v.rows).toEqual([{ version: 3 }]);
});
