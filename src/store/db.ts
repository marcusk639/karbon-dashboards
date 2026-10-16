import Database from "better-sqlite3";
import type { MenuRequest } from "../data/types.js";
import type { Layout } from "../dashboard/layout.js";
import type { Snapshot } from "../dashboard/fill.js";
import type { RejectCode } from "../log.js";
import type { Cadence } from "../schedule/due.js";

export type Schedule = {
  id: number;
  name: string;
  slug: string;
  cadence: Cadence;
  requests: Record<string, MenuRequest>;
  layout: Layout;
  paused: boolean;
  createdAt: string;
};
export type NewSchedule = Omit<Schedule, "id" | "createdAt" | "paused"> & { paused?: boolean };
export type SchedulePatch = Partial<Omit<Schedule, "id" | "createdAt">>;

export type RunStatus = "running" | "interrupted" | "produced" | "rejected" | "failed";
export type RunSummary = {
  runId: number;
  scheduleId: number;
  periodKey: string;
  status: RunStatus;
  code: RejectCode | null;
  startedAt: string;
  finishedAt: string | null;
};

export type PendingFile = {
  fileId: number;
  runId: number;
  folder: string;
  filename: string;
  contentType: string;
  bytes: number;
  content: Buffer;
  createdAt: string;
};
export type NewFile = { folder: string; filename: string; content: Buffer; contentType: string };
export type Target = { driveId: string; itemId: string };

export interface Store {
  createSchedule(s: NewSchedule, now?: Date): number;
  updateSchedule(id: number, patch: SchedulePatch): void;
  setPaused(id: number, paused: boolean): void;
  deleteSchedule(id: number): void;
  listSchedules(): Schedule[];
  getSchedule(id: number): Schedule | null;
  claimRun(scheduleId: number, periodKey: string, now: Date): number | null;
  finishRun(runId: number, status: "produced" | "rejected" | "failed", code?: RejectCode, now?: Date): void;
  recoverInterrupted(now: Date, olderThanMin?: number): number;
  addFile(runId: number, f: NewFile, now?: Date): number;
  pendingFiles(): PendingFile[];
  markDelivered(fileId: number, now: Date): void;
  undeliveredOlderThan(min: number, now: Date): PendingFile[];
  markAlerted(fileId: number, now: Date): void;
  saveSnapshot(runId: number, s: Snapshot): void;
  previousSnapshot(scheduleId: number, beforeDate: string): Snapshot | null;
  getTargets(): Record<string, Target>;
  setTarget(key: string, t: Target): void;
  listRuns(limit: number): RunSummary[];
  close(): void;
}

// Deleting a schedule cascades (ON DELETE CASCADE) to its runs, and from runs to files and snapshots.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS schedules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  cadence TEXT NOT NULL,
  requests TEXT NOT NULL,
  layout TEXT NOT NULL,
  paused INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  schedule_id INTEGER NOT NULL REFERENCES schedules(id) ON DELETE CASCADE,
  period_key TEXT NOT NULL,
  status TEXT NOT NULL,
  code TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  UNIQUE (schedule_id, period_key)
);
CREATE TABLE IF NOT EXISTS files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  folder TEXT NOT NULL,
  filename TEXT NOT NULL,
  content_type TEXT NOT NULL,
  content BLOB NOT NULL,
  bytes INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  delivered_at TEXT,
  alerted_at TEXT
);
CREATE TABLE IF NOT EXISTS snapshots (
  run_id INTEGER PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
  schedule_id INTEGER NOT NULL,
  period_key TEXT NOT NULL,
  totals TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS snapshots_by_schedule ON snapshots (schedule_id, period_key);
CREATE TABLE IF NOT EXISTS targets (
  key TEXT PRIMARY KEY,
  drive_id TEXT NOT NULL,
  item_id TEXT NOT NULL
);
`;

type ScheduleRow = {
  id: number; name: string; slug: string; cadence: string; requests: string;
  layout: string; paused: number; created_at: string;
};
type FileRow = {
  id: number; run_id: number; folder: string; filename: string; content_type: string;
  content: Buffer; bytes: number; created_at: string;
};

const toSchedule = (r: ScheduleRow): Schedule => ({
  id: r.id,
  name: r.name,
  slug: r.slug,
  cadence: JSON.parse(r.cadence) as Cadence,
  requests: JSON.parse(r.requests) as Record<string, MenuRequest>,
  layout: JSON.parse(r.layout) as Layout,
  paused: r.paused === 1,
  createdAt: r.created_at,
});
const toPending = (r: FileRow): PendingFile => ({
  fileId: r.id,
  runId: r.run_id,
  folder: r.folder,
  filename: r.filename,
  contentType: r.content_type,
  bytes: r.bytes,
  content: r.content,
  createdAt: r.created_at,
});

export function openStore(path: string): Store {
  const db = new Database(path);
  db.pragma("foreign_keys = ON");
  if (path !== ":memory:") db.pragma("journal_mode = WAL");
  db.exec(SCHEMA);

  const iso = (d: Date) => d.toISOString();

  const claim = db.transaction((scheduleId: number, periodKey: string, now: Date): number | null => {
    const row = db
      .prepare("SELECT id, status FROM runs WHERE schedule_id = ? AND period_key = ?")
      .get(scheduleId, periodKey) as { id: number; status: string } | undefined;
    if (!row) {
      const info = db
        .prepare("INSERT INTO runs (schedule_id, period_key, status, started_at) VALUES (?, ?, 'running', ?)")
        .run(scheduleId, periodKey, iso(now));
      return Number(info.lastInsertRowid);
    }
    if (row.status !== "interrupted") return null;
    const info = db
      .prepare("UPDATE runs SET status = 'running', started_at = ?, finished_at = NULL, code = NULL WHERE id = ? AND status = 'interrupted'")
      .run(iso(now), row.id);
    return info.changes === 1 ? row.id : null;
  });

  return {
    createSchedule(s, now = new Date()) {
      const info = db
        .prepare("INSERT INTO schedules (name, slug, cadence, requests, layout, paused, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(s.name, s.slug, JSON.stringify(s.cadence), JSON.stringify(s.requests), JSON.stringify(s.layout), s.paused ? 1 : 0, now.toISOString());
      return Number(info.lastInsertRowid);
    },
    updateSchedule(id, patch) {
      const cur = this.getSchedule(id);
      if (!cur) throw new Error(`schedule ${id} not found`);
      const n = { ...cur, ...patch };
      db.prepare("UPDATE schedules SET name = ?, slug = ?, cadence = ?, requests = ?, layout = ?, paused = ? WHERE id = ?")
        .run(n.name, n.slug, JSON.stringify(n.cadence), JSON.stringify(n.requests), JSON.stringify(n.layout), n.paused ? 1 : 0, id);
    },
    setPaused(id, paused) {
      db.prepare("UPDATE schedules SET paused = ? WHERE id = ?").run(paused ? 1 : 0, id);
    },
    deleteSchedule(id) {
      db.prepare("DELETE FROM schedules WHERE id = ?").run(id);
    },
    listSchedules() {
      return (db.prepare("SELECT * FROM schedules ORDER BY id").all() as ScheduleRow[]).map(toSchedule);
    },
    getSchedule(id) {
      const r = db.prepare("SELECT * FROM schedules WHERE id = ?").get(id) as ScheduleRow | undefined;
      return r ? toSchedule(r) : null;
    },
    claimRun: (scheduleId, periodKey, now) => claim(scheduleId, periodKey, now),
    finishRun(runId, status, code, now = new Date()) {
      db.prepare("UPDATE runs SET status = ?, code = ?, finished_at = ? WHERE id = ?")
        .run(status, code ?? null, now.toISOString(), runId);
    },
    recoverInterrupted(now, olderThanMin = 15) {
      const cutoff = iso(new Date(now.getTime() - olderThanMin * 60_000));
      return db
        .prepare("UPDATE runs SET status = 'interrupted' WHERE status = 'running' AND started_at < ?")
        .run(cutoff).changes;
    },
    addFile(runId, f, now = new Date()) {
      const info = db
        .prepare("INSERT INTO files (run_id, folder, filename, content_type, content, bytes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(runId, f.folder, f.filename, f.contentType, f.content, f.content.length, now.toISOString());
      return Number(info.lastInsertRowid);
    },
    pendingFiles() {
      return (db.prepare("SELECT * FROM files WHERE delivered_at IS NULL ORDER BY id").all() as FileRow[]).map(toPending);
    },
    markDelivered(fileId, now) {
      db.prepare("UPDATE files SET delivered_at = ? WHERE id = ?").run(iso(now), fileId);
    },
    undeliveredOlderThan(min, now) {
      const cutoff = iso(new Date(now.getTime() - min * 60_000));
      return (
        db
          .prepare("SELECT * FROM files WHERE delivered_at IS NULL AND alerted_at IS NULL AND created_at <= ? ORDER BY id")
          .all(cutoff) as FileRow[]
      ).map(toPending);
    },
    markAlerted(fileId, now) {
      db.prepare("UPDATE files SET alerted_at = ? WHERE id = ?").run(iso(now), fileId);
    },
    saveSnapshot(runId, s) {
      const run = db.prepare("SELECT schedule_id FROM runs WHERE id = ?").get(runId) as { schedule_id: number } | undefined;
      if (!run) throw new Error(`run ${runId} not found`);
      db.prepare("INSERT OR REPLACE INTO snapshots (run_id, schedule_id, period_key, totals) VALUES (?, ?, ?, ?)")
        .run(runId, run.schedule_id, s.periodKey, JSON.stringify(s.totals));
    },
    previousSnapshot(scheduleId, beforeDate) {
      const r = db
        .prepare("SELECT period_key, totals FROM snapshots WHERE schedule_id = ? AND period_key < ? ORDER BY period_key DESC LIMIT 1")
        .get(scheduleId, beforeDate) as { period_key: string; totals: string } | undefined;
      return r ? { periodKey: r.period_key, totals: JSON.parse(r.totals) } : null;
    },
    getTargets() {
      const out: Record<string, Target> = {};
      for (const r of db.prepare("SELECT key, drive_id, item_id FROM targets").all() as { key: string; drive_id: string; item_id: string }[]) {
        out[r.key] = { driveId: r.drive_id, itemId: r.item_id };
      }
      return out;
    },
    setTarget(key, t) {
      db.prepare("INSERT OR REPLACE INTO targets (key, drive_id, item_id) VALUES (?, ?, ?)").run(key, t.driveId, t.itemId);
    },
    listRuns(limit) {
      return (
        db
          .prepare("SELECT id, schedule_id, period_key, status, code, started_at, finished_at FROM runs ORDER BY id DESC LIMIT ?")
          .all(limit) as { id: number; schedule_id: number; period_key: string; status: RunStatus; code: RejectCode | null; started_at: string; finished_at: string | null }[]
      ).map((r) => ({
        runId: r.id, scheduleId: r.schedule_id, periodKey: r.period_key, status: r.status,
        code: r.code, startedAt: r.started_at, finishedAt: r.finished_at,
      }));
    },
    close() {
      db.close();
    },
  };
}
