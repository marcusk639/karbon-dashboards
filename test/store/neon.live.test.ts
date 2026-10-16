import { afterAll, beforeAll, expect, test } from "vitest";
import { createPgDb, type Db } from "../../src/store/adapter.js";
import { openStore, type Store } from "../../src/store/db.js";

// Runs only with LIVE_DB=1 and a throwaway DATABASE_URL (see vitest.config.ts). It creates and deletes one schedule.
let db: Db;
let store: Store;
beforeAll(async () => {
  // Never fall back to PG* variables or localhost: a missing URL must stop the run.
  if ((process.env.DATABASE_URL ?? "").trim() === "") throw new Error("LIVE_DB=1 requires DATABASE_URL to be set");
  db = createPgDb(process.env.DATABASE_URL!);
  store = await openStore(db);
});
afterAll(async () => {
  await db.close();
});

test("smoke: schedule, exactly-once claim, atomic produce, BYTEA round-trip, cascade delete", async () => {
  const T = new Date("2026-10-19T13:00:00Z");
  const slug = `live-smoke-${Date.now()}`;
  const id = await store.createSchedule({
    name: "live smoke", slug, cadence: { weekday: 1, time: "08:00", timezone: "America/Chicago" },
    requests: {}, layout: { title: "T" } as never,
  }, T);
  try {
    const got = await Promise.all([store.claimRun(id, "2026-10-19", T), store.claimRun(id, "2026-10-19", T)]);
    expect(got.filter((x) => x !== null)).toHaveLength(1);
    const run = got.find((x) => x !== null)!;
    const pdf = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0xff, 0x10, 0x80]);
    await store.transaction(async (tx) => {
      await tx.addFile(run, { folder: slug, filename: "a.pdf", content: pdf, contentType: "application/pdf" }, T);
      await tx.saveSnapshot(run, { periodKey: "2026-10-19", totals: {} });
      await tx.finishRun(run, "produced", undefined, T);
    });
    // A throwing transaction leaves nothing behind.
    const before = (await store.pendingFiles()).length;
    await expect(
      store.transaction(async (tx) => {
        await tx.addFile(run, { folder: slug, filename: "rollback.pdf", content: pdf, contentType: "application/pdf" }, T);
        throw new Error("boom");
      }),
    ).rejects.toThrow();
    expect((await store.pendingFiles()).length).toBe(before);
    expect((await store.pendingFiles()).some((f) => f.filename === "rollback.pdf")).toBe(false);
    const mine = (await store.pendingFiles()).filter((f) => f.folder === slug);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.content.equals(pdf)).toBe(true);
    expect((await store.previousSnapshot(id, "2026-10-20"))!.periodKey).toBe("2026-10-19");
  } finally {
    await store.deleteSchedule(id);
  }
  expect(await store.getSchedule(id)).toBeNull();
});
