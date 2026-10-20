import { expect, test } from "vitest";
import { createPgliteDb } from "../../src/store/adapter.js";
import { openStore, type NewSchedule } from "../../src/store/db.js";
import type { AuditEvent } from "../../src/audit.js";
import type { Layout } from "../../src/dashboard/layout.js";
import { memStore } from "../helpers/store.js";

const FULL: AuditEvent = {
  at: "2026-10-19T13:00:00.000Z",
  durationMs: 42,
  surface: "mcp",
  action: "ask",
  callerIp: "203.0.113.7",
  request: { measures: ["jobs"], dimensions: ["stage"] },
  sql: "SELECT stage, COUNT(*) FROM v WHERE due >= ? GROUP BY 1",
  binds: ["2026-01-01", "Review"],
  sqlHash: "0123456789abcdef",
  warehouseQueryId: "01b2-0000-query",
  verdict: "ok",
  code: "none",
  location: 'column "stage"',
  rowCount: 2,
  colCount: 2,
  result: {
    columns: ["stage", "jobs"],
    rows: [
      ["Review", 3],
      ["Preparing", 5],
    ],
  },
  scheduleId: 7,
  runId: 11,
  attempt: 2,
  fileIds: [3, 4],
};

test("addAuditEvent round-trips every column", async () => {
  const s = await memStore();
  const id = await s.addAuditEvent(FULL);
  expect(id).toBeGreaterThan(0);
  const [row] = await s.listAudit({ limit: 10 });
  expect(row).toEqual({ id, ...FULL });
});

test("absent fields read back as null", async () => {
  const s = await memStore();
  await s.addAuditEvent({
    at: FULL.at,
    surface: "system",
    action: "audit_purge",
    verdict: "ok",
  });
  const [row] = await s.listAudit({ limit: 10 });
  expect(row).toMatchObject({
    surface: "system",
    action: "audit_purge",
    verdict: "ok",
    request: null,
    result: null,
    fileIds: null,
    callerIp: null,
  });
});

test("listAudit filters by time, action and verdict, newest first, limited", async () => {
  const s = await memStore();
  const at = (d: number) => new Date(Date.UTC(2026, 9, d, 12)).toISOString();
  await s.addAuditEvent({
    at: at(1),
    surface: "mcp",
    action: "ask",
    verdict: "ok",
  });
  await s.addAuditEvent({
    at: at(2),
    surface: "mcp",
    action: "ask",
    verdict: "rejected",
  });
  await s.addAuditEvent({
    at: at(3),
    surface: "mcp",
    action: "listRuns",
    verdict: "ok",
  });
  await s.addAuditEvent({
    at: at(4),
    surface: "mcp",
    action: "ask",
    verdict: "ok",
  });
  expect((await s.listAudit({ limit: 10 })).map((r) => r.at)).toEqual([
    at(4),
    at(3),
    at(2),
    at(1),
  ]);
  expect(
    (await s.listAudit({ action: "ask", limit: 10 })).map((r) => r.at),
  ).toEqual([at(4), at(2), at(1)]);
  expect(
    (await s.listAudit({ verdict: "rejected", limit: 10 })).map((r) => r.at),
  ).toEqual([at(2)]);
  expect(
    (await s.listAudit({ from: at(2), to: at(3), limit: 10 })).map((r) => r.at),
  ).toEqual([at(3), at(2)]);
  expect((await s.listAudit({ limit: 2 })).map((r) => r.at)).toEqual([
    at(4),
    at(3),
  ]);
});

test("purgeAudit removes events older than the cutoff only", async () => {
  const s = await memStore();
  await s.addAuditEvent({
    at: "2025-01-01T00:00:00.000Z",
    surface: "mcp",
    action: "ask",
    verdict: "ok",
  });
  await s.addAuditEvent({
    at: "2026-01-01T00:00:00.000Z",
    surface: "mcp",
    action: "ask",
    verdict: "ok",
  });
  expect(await s.purgeAudit(new Date("2025-06-01T00:00:00Z"))).toBe(1);
  expect((await s.listAudit({ limit: 10 })).map((r) => r.at)).toEqual([
    "2026-01-01T00:00:00.000Z",
  ]);
});

test("schema v4 opens on a v3 database with rows", async () => {
  const db = await createPgliteDb();
  const v3 = await openStore(db);
  const sched: NewSchedule = {
    name: "Weekly",
    slug: "weekly",
    cadence: { weekday: 1, time: "08:00", timezone: "America/Chicago" },
    requests: { a: { measures: ["jobs"] } },
    layout: { title: "T" } as unknown as Layout,
  };
  const id = await v3.createSchedule(sched);
  const run = (await v3.claimRun(
    id,
    "2026-10-19",
    new Date("2026-10-19T13:00:00Z"),
  ))!;
  await v3.addFile(run.runId, {
    folder: "weekly",
    filename: "a.pdf",
    content: Buffer.from("%PDF-x"),
    contentType: "application/pdf",
  });
  // Back to what a v3 database looks like: no audit table, version 3 only.
  await db.query("DROP TABLE audit_events");
  await db.query("DELETE FROM schema_version");
  await db.query("INSERT INTO schema_version (version) VALUES (3)");

  const v4 = await openStore(db);
  expect(await v4.listSchedules()).toHaveLength(1);
  expect(await v4.pendingFiles()).toHaveLength(1);
  await v4.addAuditEvent({
    at: FULL.at,
    surface: "mcp",
    action: "ask",
    verdict: "ok",
  });
  expect(await v4.listAudit({ limit: 5 })).toHaveLength(1);
  const v = await db.query<{ version: number }>(
    "SELECT version FROM schema_version ORDER BY version",
  );
  expect(v.rows).toEqual([{ version: 3 }, { version: 4 }]);
  const idx = await db.query<{ indexname: string }>(
    "SELECT indexname FROM pg_indexes WHERE tablename = 'audit_events' ORDER BY indexname",
  );
  expect(idx.rows.map((r) => r.indexname)).toEqual([
    "audit_events_by_action",
    "audit_events_by_at",
    "audit_events_pkey",
  ]);
});

test("listAudit in summary mode leaves out result, sql and binds; id selects one row", async () => {
  const s = await memStore();
  const a = await s.addAuditEvent(FULL);
  const b = await s.addAuditEvent({ ...FULL, action: "listRuns" });
  const [row] = await s.listAudit({ limit: 1, summary: true });
  expect(row!.id).toBe(b);
  for (const k of ["result", "sql", "binds"]) expect(row).not.toHaveProperty(k);
  expect(row).toMatchObject({ action: "listRuns", rowCount: 2, request: FULL.request });
  expect(await s.listAudit({ id: a, limit: 1 })).toEqual([{ id: a, ...FULL }]);
});
