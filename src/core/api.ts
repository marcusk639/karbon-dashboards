import { DateTime } from "luxon";
import { createAlerter, createHeartbeat, type Alerter } from "../alert.js";
import { loadCatalog, loadGenericWords, loadLabels, type Catalog, type Labels } from "../config.js";
import { checkFilled, fillLayout, type FilledDashboard } from "../dashboard/fill.js";
import { checkLayout, type Layout } from "../dashboard/layout.js";
import { renderPdf } from "../dashboard/render.js";
import { createSnowflakeSource } from "../data/snowflake.js";
import { createSyntheticSource } from "../data/synthetic.js";
import { findPatterns } from "../guard/patterns.js";
import type { DataSource, MenuRequest, ResultTable } from "../data/types.js";
import { runMenuRequest, type GuardResult } from "../guard/run.js";
import { assertCounts, type NameChecker } from "../guard/names.js";
import { createLogger, type LogEvent, type Logger } from "../log.js";
import { buildQuery, RequestError, validateRequest } from "../query/build.js";
import { executeScheduledRun } from "../schedule/run.js";
import { latestOccurrence, type Cadence } from "../schedule/due.js";
import { withLease } from "../schedule/lease.js";
import { startTicker as startScheduleTicker } from "../schedule/ticker.js";
import { createPgDb, createPgliteDb, type Db } from "../store/adapter.js";
import { openStore, type RunSummary, type Schedule, type Store, type Target } from "../store/db.js";

// R5: everything the MCP layer needs is re-exported from here.
export type { Cadence, FilledDashboard, GuardResult, Layout, LogEvent, MenuRequest, RunSummary, Schedule, Target };

export type Failure = { ok: false; code: string; detail: string };
export type Done = { ok: true } | Failure;

/** Requests are validated by the guard, so the API accepts them as unknown rather than trusting a type. */
export type RawRequests = Record<string, unknown>;

export type ScheduleInput = {
  name: string;
  slug: string;
  cadence: Cadence;
  requests: RawRequests;
  layout: unknown;
};

export type MenuEntry = { name: string; meaning: string };
export type Menu = {
  cohorts: MenuEntry[];
  measures: (MenuEntry & { format: string })[];
  dimensions: MenuEntry[];
  filters: MenuEntry[];
};

export type PreviewResult = { ok: true; pdfBase64: string; bytes: number; filled: FilledDashboard } | Failure;
export type RunNowResult =
  | { ok: true; runId: number; periodKey: string; status: "produced" | "rejected" | "failed" }
  | Failure;
export type PendingFileView = {
  fileId: number;
  folder: string;
  filename: string;
  contentType: string;
  bytes: number;
  contentBase64: string;
};

export interface CoreApi {
  listMenu(): Menu;
  ask(raw: unknown): Promise<GuardResult>;
  previewDashboard(requests: RawRequests, layout: unknown): Promise<PreviewResult>;
  createSchedule(input: ScheduleInput): Promise<{ ok: true; id: number } | Failure>;
  listSchedules(): Promise<Schedule[]>;
  updateSchedule(id: number, patch: Partial<ScheduleInput>): Promise<Done>;
  pauseSchedule(id: number, paused: boolean): Promise<Done>;
  deleteSchedule(id: number): Promise<Done>;
  runScheduleNow(id: number): Promise<RunNowResult>;
  listRuns(limit: number): Promise<RunSummary[]>;
  listPendingFiles(): Promise<PendingFileView[]>;
  markFileDelivered(fileId: number): Promise<Done>;
  getDeliveryTargets(): Promise<Record<string, Target>>;
  setDeliveryTarget(key: string, driveId: string, itemId: string): Promise<Done>;
}

export type CoreDeps = {
  catalog: Catalog;
  labels: Labels;
  generic: string[];
  data: DataSource;
  names: NameChecker;
  store: Store;
  alerter: Alerter;
  log: Logger;
  now: () => Date;
  /** True when the data source is synthetic: every output is stamped and prefixed so it cannot pass for live. */
  synthetic?: boolean;
};

const MAX_BYTES = 1_048_576;
const SLUG = /^[a-z0-9-]{3,60}$/;
/** Delivery-target keys the courier uses for itself; a slug may not collide with them. */
const RESERVED_SLUGS = new Set(["root"]);
const MAX_RUNS = 200;

const pickCadence = (c: Cadence): Cadence => ({ weekday: c.weekday, time: c.time, timezone: c.timezone });
const fail = (code: string, detail: string): Failure => ({ ok: false, code, detail });
const notFound = (what: string): Failure => fail("not_found", what);
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Reject a cadence the ticker would skip forever. Details are field locations only. */
function cadenceFailure(c: unknown): Failure | null {
  const bad = (field: string): Failure => fail("invalid_cadence", field === "" ? "cadence" : `cadence.${field}`);
  if (!isObj(c)) return bad("");
  if (typeof c.weekday !== "number" || !Number.isInteger(c.weekday) || c.weekday < 1 || c.weekday > 7) return bad("weekday");
  if (typeof c.time !== "string") return bad("time");
  if (typeof c.timezone !== "string" || c.timezone === "") return bad("timezone");
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: c.timezone }); // IANA names only; luxon also accepts "local" and offsets
  } catch {
    return bad("timezone");
  }
  try {
    latestOccurrence(c as Cadence, new Date());
  } catch (err) {
    const m = String((err as Error).message);
    return bad(m.includes("timezone") ? "timezone" : m.includes("weekday") ? "weekday" : "time");
  }
  return null;
}

export function createCoreApi(deps: CoreDeps): CoreApi {
  const { catalog, store } = deps;
  const guardDeps = {
    catalog, labels: deps.labels, generic: deps.generic, data: deps.data,
    names: deps.names, now: deps.now, log: deps.log,
  };

  /** Validate every named request; returns the normalised set or a failure naming the request. */
  function checkRequests(requests: unknown): { ok: true; requests: Record<string, MenuRequest> } | Failure {
    if (!isObj(requests) || Object.keys(requests).length === 0) return fail("disallowed_request", "requests");
    const out: Record<string, MenuRequest> = {};
    for (const [name, raw] of Object.entries(requests)) {
      try {
        out[name] = validateRequest(raw, catalog);
      } catch (err) {
        if (err instanceof RequestError) return fail("disallowed_request", `requests.${name}`);
        throw err;
      }
    }
    return { ok: true, requests: out };
  }

  /** Requests, then the layout. Nothing is stored unless both pass. */
  async function checkDesign(
    requests: unknown,
    layout: unknown,
  ): Promise<{ ok: true; requests: Record<string, MenuRequest>; layout: Layout } | Failure> {
    const r = checkRequests(requests);
    if (!r.ok) return r;
    try {
      const l = await checkLayout(layout, r.requests, { names: deps.names, catalog });
      if (!l.ok) return fail(l.code, l.detail);
      return { ok: true, requests: r.requests, layout: l.layout };
    } catch {
      return fail("warehouse_error", "name check failed"); // fail closed
    }
  }

  const slugFailure = async (slug: unknown, exceptId?: number): Promise<Failure | null> => {
    if (typeof slug !== "string" || !SLUG.test(slug) || RESERVED_SLUGS.has(slug)) return fail("invalid_slug", "slug");
    if ((await store.listSchedules()).some((s) => s.slug === slug && s.id !== exceptId)) return fail("duplicate_slug", "slug");
    return null;
  };
  const nameFailure = (name: unknown): Failure | null =>
    typeof name === "string" && name.trim() !== "" && name.length <= 200 ? null : fail("invalid_name", "name");

  /**
   * Claude-typed text outside the layout: the schedule name (stored), the slug (OneDrive folder, filenames,
   * alert text; hyphens read as spaces) and every request name (keys in totals.json). Pattern check (urls
   * included) then one name-check batch. Details are locations only; a request is named by its position.
   */
  async function authoredTextFailure(fields: { name: unknown; slug: unknown; requests: unknown }): Promise<Failure | null> {
    const texts: { path: string; text: string }[] = [];
    if (typeof fields.name === "string") texts.push({ path: "name", text: fields.name });
    if (typeof fields.slug === "string") texts.push({ path: "slug", text: fields.slug.replace(/-/g, " ") });
    if (isObj(fields.requests))
      Object.keys(fields.requests).forEach((k, i) => texts.push({ path: `requests[${i}] (name)`, text: k }));
    for (const t of texts)
      if (findPatterns(t.text, { urls: true }).length > 0) return fail("pattern_match", t.path);
    try {
      const counts = await deps.names.countMatches(texts.map((t) => t.text));
      assertCounts(counts, texts.length);
      const hit = counts.findIndex((n) => n > 0);
      return hit >= 0 ? fail("client_name", texts[hit]!.path) : null;
    } catch {
      return fail("warehouse_error", "name check failed"); // fail closed
    }
  }

  const localDate = (schedule: Schedule, now: Date): string =>
    DateTime.fromJSDate(now).setZone(schedule.cadence.timezone).toFormat("yyyy-MM-dd");

  return {
    listMenu() {
      return {
        cohorts: Object.entries(catalog.cohorts).map(([name, c]) => ({ name, meaning: c.meaning })),
        measures: Object.entries(catalog.measures).map(([name, m]) => ({ name, meaning: m.meaning, format: m.format })),
        dimensions: Object.entries(catalog.dimensions).map(([name, d]) => ({ name, meaning: d.meaning })),
        filters: [{ name: "due_between", meaning: "Only jobs whose due date is on or after `from` and before `to` (yyyy-MM-dd)." }],
      };
    },

    ask: (raw) => runMenuRequest(raw, guardDeps),

    async previewDashboard(requests, layout) {
      const design = await checkDesign(requests, layout);
      if (!design.ok) return design;

      const results: Record<string, ResultTable> = {};
      const exempt = new Set<string>();
      let queriedAt = "";
      for (const [name, raw] of Object.entries(design.requests)) {
        const r = await runMenuRequest(raw, guardDeps);
        if (r.status === "rejected") return fail(r.code, r.detail);
        results[name] = r.table;
        if (r.queriedAt > queriedAt) queriedAt = r.queriedAt;
        for (const s of buildQuery(raw, catalog, deps.labels).exemptStrings) exempt.add(s);
      }
      try {
        const filled = fillLayout(design.layout, results, null, new Date(queriedAt), catalog, { synthetic: deps.synthetic === true });
        const check = await checkFilled(filled, exempt, { names: deps.names });
        if (!check.ok) return fail(check.code, check.detail);
        const pdf = await renderPdf(filled);
        if (pdf.length >= MAX_BYTES) return fail("too_large", "pdf over 1048576 bytes");
        return { ok: true, pdfBase64: pdf.toString("base64"), bytes: pdf.length, filled };
      } catch {
        return fail("warehouse_error", "preview failed");
      }
    },

    async createSchedule(input) {
      const bad =
        (!isObj(input) ? fail("disallowed_request", "input") : null) ??
        nameFailure(input.name) ?? (await slugFailure(input.slug)) ?? cadenceFailure(input.cadence);
      if (bad) return bad;
      const text = await authoredTextFailure(input);
      if (text) return text;
      const design = await checkDesign(input.requests, input.layout);
      if (!design.ok) return design;
      const id = await store.createSchedule(
        { name: input.name, slug: input.slug, cadence: pickCadence(input.cadence), requests: design.requests, layout: design.layout },
        deps.now(),
      );
      return { ok: true, id };
    },

    listSchedules: () => store.listSchedules(),

    async updateSchedule(id, patch) {
      const cur = await store.getSchedule(id);
      if (!cur) return notFound(`schedule ${id}`);
      if (!isObj(patch)) return fail("disallowed_request", "patch");
      const bad =
        (patch.name !== undefined ? nameFailure(patch.name) : null) ??
        (patch.slug !== undefined ? await slugFailure(patch.slug, id) : null) ??
        (patch.cadence !== undefined ? cadenceFailure(patch.cadence) : null);
      if (bad) return bad;
      const text = await authoredTextFailure({
        name: patch.name ?? cur.name,
        slug: patch.slug ?? cur.slug,
        requests: patch.requests ?? cur.requests,
      });
      if (text) return text;
      // Re-validate the merged result so a changed request cannot orphan the stored layout.
      const design = await checkDesign(patch.requests ?? cur.requests, patch.layout ?? cur.layout);
      if (!design.ok) return design;
      await store.updateSchedule(id, {
        name: patch.name ?? cur.name,
        slug: patch.slug ?? cur.slug,
        cadence: patch.cadence ? pickCadence(patch.cadence) : cur.cadence,
        requests: design.requests,
        layout: design.layout,
      });
      return { ok: true };
    },

    async pauseSchedule(id, paused) {
      if (!(await store.getSchedule(id))) return notFound(`schedule ${id}`);
      await store.setPaused(id, paused);
      return { ok: true };
    },

    async deleteSchedule(id) {
      if (!(await store.getSchedule(id))) return notFound(`schedule ${id}`);
      await store.deleteSchedule(id); // cascades to runs, files and snapshots
      return { ok: true };
    },

    async runScheduleNow(id) {
      const schedule = await store.getSchedule(id);
      if (!schedule) return notFound(`schedule ${id}`);
      const now = deps.now();
      const periodKey = `manual-${now.toISOString()}`;
      const runId = await store.claimRun(id, periodKey, now);
      if (runId === null) return fail("busy", "a run for this moment already exists");
      const status = await withLease(store, runId, () => executeScheduledRun(schedule, runId, periodKey, { ...guardDeps, store, alerter: deps.alerter, synthetic: deps.synthetic === true }, localDate(schedule, now)), { now: deps.now });
      return { ok: true, runId, periodKey, status };
    },

    async listRuns(limit) {
      const n = Number.isFinite(limit) ? Math.min(Math.max(Math.trunc(limit), 1), MAX_RUNS) : 20;
      return store.listRuns(n);
    },

    async listPendingFiles() {
      return (await store.pendingFiles()).map((f) => ({
        fileId: f.fileId, folder: f.folder, filename: f.filename, contentType: f.contentType,
        bytes: f.bytes, contentBase64: f.content.toString("base64"),
      }));
    },

    async markFileDelivered(fileId) {
      if (!(await store.pendingFiles()).some((f) => f.fileId === fileId)) return notFound(`file ${fileId}`);
      await store.markDelivered(fileId, deps.now());
      return { ok: true };
    },

    getDeliveryTargets: () => store.getTargets(),

    async setDeliveryTarget(key, driveId, itemId) {
      const ok = (s: unknown): boolean => typeof s === "string" && s.trim() !== "" && s.length <= 500;
      if (!ok(key) || !ok(driveId) || !ok(itemId)) return fail("invalid_target", "key, driveId and itemId are required");
      await store.setTarget(key, { driveId, itemId });
      return { ok: true };
    },
  };
}

export type Core = {
  api: CoreApi;
  /**
   * Start the schedule ticker. Call once, after the server is listening. Runs only when DATA_MODE=live
   * (or ALLOW_SYNTHETIC_SCHEDULES=1, for testing); otherwise returns an inactive handle.
   */
  startTicker(): { active: boolean; stop(): void };
  close(): Promise<void>;
};

/**
 * Wire every module together. DATA_MODE=live uses Snowflake; anything else is synthetic.
 * Live mode refuses to start without DATABASE_URL and ALERT_WEBHOOK_URL (the error names the variable only).
 * Synthetic mode without DATABASE_URL keeps its state in memory (lost on restart).
 */
export async function createCore(env: NodeJS.ProcessEnv): Promise<Core> {
  const live = env.DATA_MODE === "live";
  if (live)
    for (const name of ["DATABASE_URL", "ALERT_WEBHOOK_URL"])
      if ((env[name] ?? "").trim() === "") throw new Error(`DATA_MODE=live requires ${name} to be set`);
  const catalog = loadCatalog();
  const labels = loadLabels();
  const generic = loadGenericWords();
  const log = createLogger();

  const source: { data: DataSource; names: NameChecker; close?(): Promise<void> } =
    live ? createSnowflakeSource(env, generic) : createSyntheticSource(1);

  const url = (env.DATABASE_URL ?? "").trim();
  let db: Db;
  if (url !== "") {
    const ca = (env.DATABASE_CA_CERT ?? "").trim();
    db = createPgDb(url, ca === "" ? undefined : ca);
  } else {
    db = await createPgliteDb();
    console.log(JSON.stringify({ time: new Date().toISOString(), msg: "state: in-memory (synthetic)" }));
  }
  let store: Store;
  try {
    store = await openStore(db);
  } catch (err) {
    await db.close().catch(() => {});
    await source.close?.().catch(() => {});
    throw err instanceof Error && err.message === "state store unavailable" ? err : new Error("state store unavailable");
  }
  const alerter = createAlerter(env, log);
  const now = (): Date => new Date();

  const deps: CoreDeps = {
    catalog, labels, generic, data: source.data, names: source.names, store, alerter, log, now, synthetic: !live,
  };
  const scheduling = live || env.ALLOW_SYNTHETIC_SCHEDULES === "1";
  const tickers: { stop(): void }[] = [];
  return {
    api: createCoreApi(deps),
    startTicker() {
      if (!scheduling) return { active: false, stop: () => {} };
      const t = startScheduleTicker({ ...deps, heartbeat: createHeartbeat(env) });
      tickers.push(t);
      return { active: true, stop: t.stop };
    },
    async close() {
      for (const t of tickers) t.stop();
      try {
        await store.close();
      } finally {
        await source.close?.(); // one failing close must not skip the other
      }
    },
  };
}
