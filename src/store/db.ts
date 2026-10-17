import type { Db } from "./adapter.js";
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
  createSchedule(s: NewSchedule, now?: Date): Promise<number>;
  updateSchedule(id: number, patch: SchedulePatch): Promise<void>;
  setPaused(id: number, paused: boolean): Promise<void>;
  deleteSchedule(id: number): Promise<void>;
  listSchedules(): Promise<Schedule[]>;
  getSchedule(id: number): Promise<Schedule | null>;
  claimRun(scheduleId: number, periodKey: string, now: Date): Promise<number | null>;
  /** Ends a run; a no-op unless the run is still `running`. */
  finishRun(runId: number, status: "produced" | "rejected" | "failed", code?: RejectCode, now?: Date): Promise<void>;
  /** Marks running rows interrupted whose last heartbeat (or start) is older than staleSec. Default 120. */
  recoverInterrupted(now: Date, staleSec?: number): Promise<number>;
  /** Heartbeat for a run in progress; a no-op unless the run is still `running`. */
  touchRun(runId: number, now: Date): Promise<void>;
  addFile(runId: number, f: NewFile, now?: Date): Promise<number>;
  pendingFiles(): Promise<PendingFile[]>;
  markDelivered(fileId: number, now: Date): Promise<void>;
  undeliveredOlderThan(min: number, now: Date): Promise<PendingFile[]>;
  markAlerted(fileId: number, now: Date): Promise<void>;
  saveSnapshot(runId: number, s: Snapshot): Promise<void>;
  previousSnapshot(scheduleId: number, beforeDate: string): Promise<Snapshot | null>;
  getTargets(): Promise<Record<string, Target>>;
  setTarget(key: string, t: Target): Promise<void>;
  listRuns(limit: number): Promise<RunSummary[]>;
  /** Run fn in one database transaction; fn gets a transaction-bound Store. All writes land or none do. */
  transaction<T>(fn: (tx: Store) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

const SCHEMA_VERSION = 2;

// Deleting a schedule cascades (ON DELETE CASCADE) to its runs, and from runs to files and snapshots.
const SCHEMA: string[] = [
  `CREATE TABLE IF NOT EXISTS schema_version (version integer PRIMARY KEY)`,
  `CREATE TABLE IF NOT EXISTS schedules (
    id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name text NOT NULL,
    slug text NOT NULL,
    cadence text NOT NULL,
    requests text NOT NULL,
    layout text NOT NULL,
    paused boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS runs (
    id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    schedule_id integer NOT NULL REFERENCES schedules(id) ON DELETE CASCADE,
    period_key text NOT NULL,
    status text NOT NULL,
    code text,
    started_at timestamptz NOT NULL,
    finished_at timestamptz,
    UNIQUE (schedule_id, period_key)
  )`,
  `ALTER TABLE runs ADD COLUMN IF NOT EXISTS heartbeat_at timestamptz`,
  `CREATE TABLE IF NOT EXISTS files (
    id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    run_id integer NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    folder text NOT NULL,
    filename text NOT NULL,
    content_type text NOT NULL,
    content bytea NOT NULL,
    bytes integer NOT NULL,
    created_at timestamptz NOT NULL,
    delivered_at timestamptz,
    alerted_at timestamptz
  )`,
  `CREATE TABLE IF NOT EXISTS snapshots (
    run_id integer PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
    schedule_id integer NOT NULL,
    period_key text NOT NULL,
    totals text NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS snapshots_by_schedule ON snapshots (schedule_id, period_key)`,
  `CREATE TABLE IF NOT EXISTS targets (
    key text PRIMARY KEY,
    drive_id text NOT NULL,
    item_id text NOT NULL
  )`,
];

type Ts = Date | string;
type ScheduleRow = {
  id: number; name: string; slug: string; cadence: string; requests: string;
  layout: string; paused: boolean; created_at: Ts;
};
type FileRow = {
  id: number; run_id: number; folder: string; filename: string; content_type: string;
  content: Uint8Array; bytes: number; created_at: Ts;
};
type RunRow = {
  id: number; schedule_id: number; period_key: string; status: RunStatus; code: RejectCode | null;
  started_at: Ts; finished_at: Ts | null;
};

const iso = (d: Ts): string => (typeof d === "string" ? new Date(d) : d).toISOString();

const toSchedule = (r: ScheduleRow): Schedule => ({
  id: r.id,
  name: r.name,
  slug: r.slug,
  cadence: JSON.parse(r.cadence) as Cadence,
  requests: JSON.parse(r.requests) as Record<string, MenuRequest>,
  layout: JSON.parse(r.layout) as Layout,
  paused: r.paused,
  createdAt: iso(r.created_at),
});
const toPending = (r: FileRow): PendingFile => ({
  fileId: r.id,
  runId: r.run_id,
  folder: r.folder,
  filename: r.filename,
  contentType: r.content_type,
  bytes: r.bytes,
  content: Buffer.from(r.content),
  createdAt: iso(r.created_at),
});

function makeStore(db: Db): Store {
  const one = async <T>(sql: string, params: unknown[]): Promise<T | undefined> => (await db.query<T>(sql, params)).rows[0];

  const store: Store = {
    async createSchedule(s, now = new Date()) {
      const r = await one<{ id: number }>(
        "INSERT INTO schedules (name, slug, cadence, requests, layout, paused, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id",
        [s.name, s.slug, JSON.stringify(s.cadence), JSON.stringify(s.requests), JSON.stringify(s.layout), s.paused === true, now.toISOString()],
      );
      return r!.id;
    },
    async updateSchedule(id, patch) {
      const cur = await store.getSchedule(id);
      if (!cur) throw new Error(`schedule ${id} not found`);
      const n = { ...cur, ...patch };
      await db.query("UPDATE schedules SET name = $1, slug = $2, cadence = $3, requests = $4, layout = $5, paused = $6 WHERE id = $7", [
        n.name, n.slug, JSON.stringify(n.cadence), JSON.stringify(n.requests), JSON.stringify(n.layout), n.paused, id,
      ]);
    },
    async setPaused(id, paused) {
      await db.query("UPDATE schedules SET paused = $1 WHERE id = $2", [paused, id]);
    },
    async deleteSchedule(id) {
      await db.query("DELETE FROM schedules WHERE id = $1", [id]);
    },
    async listSchedules() {
      return (await db.query<ScheduleRow>("SELECT * FROM schedules ORDER BY id")).rows.map(toSchedule);
    },
    async getSchedule(id) {
      const r = await one<ScheduleRow>("SELECT * FROM schedules WHERE id = $1", [id]);
      return r ? toSchedule(r) : null;
    },
    // Exactly-once is decided by the unique (schedule_id, period_key) row, atomically in SQL and across processes.
    async claimRun(scheduleId, periodKey, now) {
      const ins = await one<{ id: number }>(
        "INSERT INTO runs (schedule_id, period_key, status, started_at, heartbeat_at) VALUES ($1, $2, 'running', $3, $3) ON CONFLICT (schedule_id, period_key) DO NOTHING RETURNING id",
        [scheduleId, periodKey, now.toISOString()],
      );
      if (ins) return ins.id;
      const re = await one<{ id: number }>(
        "UPDATE runs SET status = 'running', started_at = $3, heartbeat_at = $3, finished_at = NULL, code = NULL WHERE schedule_id = $1 AND period_key = $2 AND status = 'interrupted' RETURNING id",
        [scheduleId, periodKey, now.toISOString()],
      );
      return re ? re.id : null;
    },
    async finishRun(runId, status, code, now = new Date()) {
      // Only a running row: a late finish from a process whose run was already recovered must not overwrite it.
      await db.query("UPDATE runs SET status = $1, code = $2, finished_at = $3 WHERE id = $4 AND status = 'running'", [status, code ?? null, now.toISOString(), runId]);
    },
    async recoverInterrupted(now, staleSec = 120) {
      const cutoff = new Date(now.getTime() - staleSec * 1000).toISOString();
      const r = await db.query<{ id: number }>(
        "UPDATE runs SET status = 'interrupted' WHERE status = 'running' AND COALESCE(heartbeat_at, started_at) < $1 RETURNING id",
        [cutoff],
      );
      return r.rows.length;
    },
    async touchRun(runId, now) {
      await db.query("UPDATE runs SET heartbeat_at = $2 WHERE id = $1 AND status = 'running'", [runId, now.toISOString()]);
    },
    async addFile(runId, f, now = new Date()) {
      const r = await one<{ id: number }>(
        "INSERT INTO files (run_id, folder, filename, content_type, content, bytes, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id",
        [runId, f.folder, f.filename, f.contentType, f.content, f.content.length, now.toISOString()],
      );
      return r!.id;
    },
    async pendingFiles() {
      return (await db.query<FileRow>("SELECT * FROM files WHERE delivered_at IS NULL ORDER BY id")).rows.map(toPending);
    },
    async markDelivered(fileId, now) {
      await db.query("UPDATE files SET delivered_at = $1 WHERE id = $2", [now.toISOString(), fileId]);
    },
    async undeliveredOlderThan(min, now) {
      const cutoff = new Date(now.getTime() - min * 60_000).toISOString();
      return (
        await db.query<FileRow>(
          "SELECT * FROM files WHERE delivered_at IS NULL AND alerted_at IS NULL AND created_at <= $1 ORDER BY id",
          [cutoff],
        )
      ).rows.map(toPending);
    },
    async markAlerted(fileId, now) {
      await db.query("UPDATE files SET alerted_at = $1 WHERE id = $2", [now.toISOString(), fileId]);
    },
    async saveSnapshot(runId, s) {
      const run = await one<{ schedule_id: number }>("SELECT schedule_id FROM runs WHERE id = $1", [runId]);
      if (!run) throw new Error(`run ${runId} not found`);
      await db.query(
        "INSERT INTO snapshots (run_id, schedule_id, period_key, totals) VALUES ($1, $2, $3, $4) ON CONFLICT (run_id) DO UPDATE SET schedule_id = EXCLUDED.schedule_id, period_key = EXCLUDED.period_key, totals = EXCLUDED.totals",
        [runId, run.schedule_id, s.periodKey, JSON.stringify(s.totals)],
      );
    },
    async previousSnapshot(scheduleId, beforeDate) {
      // yyyy-MM-dd keys compare as text; COLLATE "C" pins byte order whatever the database default is.
      const r = await one<{ period_key: string; totals: string }>(
        'SELECT period_key, totals FROM snapshots WHERE schedule_id = $1 AND period_key < $2 COLLATE "C" ORDER BY period_key COLLATE "C" DESC LIMIT 1',
        [scheduleId, beforeDate],
      );
      return r ? { periodKey: r.period_key, totals: JSON.parse(r.totals) } : null;
    },
    async getTargets() {
      const out: Record<string, Target> = {};
      for (const r of (await db.query<{ key: string; drive_id: string; item_id: string }>("SELECT key, drive_id, item_id FROM targets")).rows) {
        out[r.key] = { driveId: r.drive_id, itemId: r.item_id };
      }
      return out;
    },
    async setTarget(key, t) {
      await db.query(
        "INSERT INTO targets (key, drive_id, item_id) VALUES ($1, $2, $3) ON CONFLICT (key) DO UPDATE SET drive_id = EXCLUDED.drive_id, item_id = EXCLUDED.item_id",
        [key, t.driveId, t.itemId],
      );
    },
    async listRuns(limit) {
      return (
        await db.query<RunRow>(
          "SELECT id, schedule_id, period_key, status, code, started_at, finished_at FROM runs ORDER BY id DESC LIMIT $1",
          [limit],
        )
      ).rows.map((r) => ({
        runId: r.id, scheduleId: r.schedule_id, periodKey: r.period_key, status: r.status, code: r.code,
        startedAt: iso(r.started_at), finishedAt: r.finished_at === null ? null : iso(r.finished_at),
      }));
    },
    transaction: (fn) => db.transaction((tx) => fn(makeStore(tx))),
    close: () => db.close(),
  };
  return store;
}

/** Create the schema if absent (idempotent) and return the Store. */
export async function openStore(db: Db): Promise<Store> {
  await db.transaction(async (tx) => {
    for (const stmt of SCHEMA) await tx.query(stmt);
    await tx.query("INSERT INTO schema_version (version) VALUES ($1) ON CONFLICT (version) DO NOTHING", [SCHEMA_VERSION]);
  });
  return makeStore(db);
}
