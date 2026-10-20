import type { Db } from "./adapter.js";
import type { MenuRequest } from "../data/types.js";
import type { Layout } from "../dashboard/layout.js";
import type { Snapshot } from "../dashboard/fill.js";
import type { RejectCode } from "../log.js";
import type { Cadence } from "../schedule/due.js";
import type { AuditEvent, AuditFilter, AuditListed, AuditRow } from "../audit.js";

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

/**
 * Ownership of a run: its row and the attempt that claimed it. A re-claim of an interrupted row bumps the attempt, so
 * a superseded process can no longer touch or finish the run.
 */
export type RunClaim = { runId: number; attempt: number };

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
  claimRun(scheduleId: number, periodKey: string, now: Date): Promise<RunClaim | null>;
  /** Ends a run; a no-op (false) unless the run is still `running` under this claim's attempt. */
  finishRun(claim: RunClaim, status: "produced" | "rejected" | "failed", code?: RejectCode, now?: Date): Promise<boolean>;
  /** Marks running rows interrupted whose last heartbeat (or start) is older than staleSec. Default 120. */
  recoverInterrupted(now: Date, staleSec?: number): Promise<number>;
  /** Heartbeat for a run in progress; a no-op (false) unless the run is still `running` under this claim's attempt. */
  touchRun(claim: RunClaim, now: Date): Promise<boolean>;
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
  addAuditEvent(e: AuditEvent): Promise<number>;
  /**
   * Newest first; `limit` is applied as given (the caller caps it). `id` selects that one event. `summary` leaves out
   * result, sql and binds (not even read from the table).
   */
  listAudit(filter: AuditFilter & { limit: number; summary?: boolean }): Promise<AuditListed[]>;
  /** Deletes events that started before `before`; returns how many. */
  purgeAudit(before: Date): Promise<number>;
  /** Run fn in one database transaction; fn gets a transaction-bound Store. All writes land or none do. */
  transaction<T>(fn: (tx: Store) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

const SCHEMA_VERSION = 4;

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
  `ALTER TABLE runs ADD COLUMN IF NOT EXISTS attempt integer NOT NULL DEFAULT 1`,
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
  // v4: the audit trail. Never written with rejected values, raw invalid input, file contents or credentials.
  `CREATE TABLE IF NOT EXISTS audit_events (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    at timestamptz NOT NULL,
    duration_ms integer,
    surface text NOT NULL,
    action text NOT NULL,
    caller_ip text,
    request jsonb,
    sql text,
    binds jsonb,
    sql_hash text,
    warehouse_query_id text,
    verdict text NOT NULL,
    code text,
    location text,
    row_count integer,
    col_count integer,
    result jsonb,
    schedule_id integer,
    run_id integer,
    attempt integer,
    file_ids integer[]
  )`,
  `CREATE INDEX IF NOT EXISTS audit_events_by_at ON audit_events (at)`,
  `CREATE INDEX IF NOT EXISTS audit_events_by_action ON audit_events (action, at)`,
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

type AuditDbRow = {
  id: number | string; at: Ts; duration_ms: number | null; surface: AuditRow["surface"]; action: string;
  caller_ip: string | null; request: unknown; sql: string | null; binds: (string | number)[] | null;
  sql_hash: string | null; warehouse_query_id: string | null; verdict: AuditRow["verdict"]; code: string | null;
  location: string | null; row_count: number | null; col_count: number | null; result: unknown;
  schedule_id: number | null; run_id: number | null; attempt: number | null; file_ids: number[] | null;
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

const json = (v: unknown): string | null => (v === undefined ? null : JSON.stringify(v));
const SUMMARY_COLUMNS =
  "id, at, duration_ms, surface, action, caller_ip, request, sql_hash, warehouse_query_id, verdict, code, location, " +
  "row_count, col_count, schedule_id, run_id, attempt, file_ids";

const toAudit = (r: AuditDbRow): AuditRow => ({
  id: Number(r.id), at: iso(r.at), durationMs: r.duration_ms, surface: r.surface, action: r.action, callerIp: r.caller_ip,
  request: r.request ?? null, sql: r.sql, binds: r.binds, sqlHash: r.sql_hash, warehouseQueryId: r.warehouse_query_id,
  verdict: r.verdict, code: r.code, location: r.location, rowCount: r.row_count, colCount: r.col_count,
  result: r.result ?? null, scheduleId: r.schedule_id, runId: r.run_id, attempt: r.attempt, fileIds: r.file_ids,
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
      const ins = await one<{ id: number; attempt: number }>(
        "INSERT INTO runs (schedule_id, period_key, status, started_at, heartbeat_at, attempt) VALUES ($1, $2, 'running', $3, $3, 1) ON CONFLICT (schedule_id, period_key) DO NOTHING RETURNING id, attempt",
        [scheduleId, periodKey, now.toISOString()],
      );
      if (ins) return { runId: ins.id, attempt: ins.attempt };
      const re = await one<{ id: number; attempt: number }>(
        "UPDATE runs SET status = 'running', started_at = $3, heartbeat_at = $3, finished_at = NULL, code = NULL, attempt = attempt + 1 WHERE schedule_id = $1 AND period_key = $2 AND status = 'interrupted' RETURNING id, attempt",
        [scheduleId, periodKey, now.toISOString()],
      );
      return re ? { runId: re.id, attempt: re.attempt } : null;
    },
    async finishRun(claim, status, code, now = new Date()) {
      // Only a running row of this attempt: a late finish from a process whose run was recovered (and perhaps
      // re-claimed) must not overwrite it.
      const r = await db.query<{ id: number }>(
        "UPDATE runs SET status = $1, code = $2, finished_at = $3 WHERE id = $4 AND attempt = $5 AND status = 'running' RETURNING id",
        [status, code ?? null, now.toISOString(), claim.runId, claim.attempt],
      );
      return r.rows.length > 0;
    },
    async recoverInterrupted(now, staleSec = 120) {
      const cutoff = new Date(now.getTime() - staleSec * 1000).toISOString();
      const r = await db.query<{ id: number }>(
        "UPDATE runs SET status = 'interrupted' WHERE status = 'running' AND COALESCE(heartbeat_at, started_at) < $1 RETURNING id",
        [cutoff],
      );
      return r.rows.length;
    },
    async touchRun(claim, now) {
      const r = await db.query<{ id: number }>(
        "UPDATE runs SET heartbeat_at = $3 WHERE id = $1 AND attempt = $2 AND status = 'running' RETURNING id",
        [claim.runId, claim.attempt, now.toISOString()],
      );
      return r.rows.length > 0;
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
    async addAuditEvent(e) {
      const r = await one<{ id: number | string }>(
        `INSERT INTO audit_events (at, duration_ms, surface, action, caller_ip, request, sql, binds, sql_hash,
          warehouse_query_id, verdict, code, location, row_count, col_count, result, schedule_id, run_id, attempt, file_ids)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8::jsonb, $9, $10, $11, $12, $13, $14, $15, $16::jsonb, $17, $18, $19, $20::integer[])
         RETURNING id`,
        [
          e.at, e.durationMs ?? null, e.surface, e.action, e.callerIp ?? null, json(e.request), e.sql ?? null, json(e.binds),
          e.sqlHash ?? null, e.warehouseQueryId ?? null, e.verdict, e.code ?? null, e.location ?? null, e.rowCount ?? null,
          e.colCount ?? null, json(e.result), e.scheduleId ?? null, e.runId ?? null, e.attempt ?? null, e.fileIds ?? null,
        ],
      );
      return Number(r!.id);
    },
    async listAudit(f) {
      const where: string[] = [];
      const params: unknown[] = [];
      const add = (sql: string, v: unknown): void => {
        params.push(v);
        where.push(sql.replace("?", `$${params.length}`));
      };
      if (f.id !== undefined) add("id = ?", f.id);
      if (f.from !== undefined) add("at >= ?", f.from);
      if (f.to !== undefined) add("at <= ?", f.to);
      if (f.action !== undefined) add("action = ?", f.action);
      if (f.verdict !== undefined) add("verdict = ?", f.verdict);
      params.push(f.limit);
      const cond = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
      const cols = f.summary ? SUMMARY_COLUMNS : "*";
      const rows = (
        await db.query<AuditDbRow>(`SELECT ${cols} FROM audit_events ${cond} ORDER BY at DESC, id DESC LIMIT $${params.length}`, params)
      ).rows.map(toAudit);
      if (!f.summary) return rows;
      return rows.map(({ result: _r, sql: _s, binds: _b, ...rest }) => rest);
    },
    async purgeAudit(before) {
      const r = await db.query<{ id: number }>("DELETE FROM audit_events WHERE at < $1 RETURNING id", [before.toISOString()]);
      return r.rows.length;
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
