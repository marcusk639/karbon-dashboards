import { DateTime } from "luxon";
import { auditContext } from "../audit-context.js";
import {
  auditedAlerter, createAuditRecorder, noAudit, type AuditEvent, type AuditFilter, type AuditListed, type AuditRecorder, type AuditRow,
  type AuditSurface, type AuditVerdict,
} from "../audit.js";
import { createAlerter, createHeartbeat, hasEmailChannel, hasWebhookChannel, missingEmailVars, type Alerter } from "../alert.js";
import { loadCatalog, loadGenericWords, loadLabels, type Catalog, type Labels } from "../config.js";
import { checkFilled, fillLayout, type FilledDashboard } from "../dashboard/fill.js";
import { checkLayout, type Layout } from "../dashboard/layout.js";
import { renderPdf } from "../dashboard/render.js";
import { createSnowflakeSource } from "../data/snowflake.js";
import { createSyntheticSource } from "../data/synthetic.js";
import { createGithubUploader, type FileUploader } from "../delivery/github.js";
import { findPatterns } from "../guard/patterns.js";
import type { DataSource, MenuRequest, ResultTable } from "../data/types.js";
import { runAuditedRequest, settled, type GuardResult, type RequestAudit } from "../guard/run.js";
import { assertCounts, type NameChecker } from "../guard/names.js";
import { createLogger, logCode, type LogEvent, type Logger } from "../log.js";
import { buildQuery, RequestError, validateRequest } from "../query/build.js";
import { executeScheduledRun } from "../schedule/run.js";
import { latestOccurrence, type Cadence } from "../schedule/due.js";
import { withLease } from "../schedule/lease.js";
import { setTimeout as sleep } from "node:timers/promises";
import { DRAIN_CAP_MS, startTicker as startScheduleTicker } from "../schedule/ticker.js";
import { createPgDb, createPgliteDb, type Db } from "../store/adapter.js";
import { openStore, type RunSummary, type Schedule, type Store, type Target } from "../store/db.js";

// R5: everything the MCP layer needs is re-exported from here.
export type { AuditFilter, AuditListed, AuditRow, Cadence, FilledDashboard, GuardResult, Layout, LogEvent, MenuRequest, RunSummary, Schedule, Target };

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
  listMenu(): Promise<Menu>;
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
  /**
   * Audit events, newest first, without result, sql and binds; `limit` defaults to 100, at most 200. With `id`, that
   * one event in full.
   */
  listAudit(filter: AuditFilter): Promise<AuditListed[]>;
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
  /** Test aid: a best-effort copy of each produced PDF (GITHUB_UPLOAD_TOKEN). */
  uploader?: FileUploader;
  /** The audit trail (audit_events). Without one nothing is recorded (tests); createCore always passes one. */
  recorder?: AuditRecorder;
};

const MAX_BYTES = 1_048_576;
const SLUG = /^[a-z0-9-]{3,60}$/;
/** Delivery-target keys the courier uses for itself; a slug may not collide with them. */
const RESERVED_SLUGS = new Set(["root"]);
const MAX_RUNS = 200;
const AUDIT_LIMIT = { fallback: 100, max: 200 };
const VERDICTS: readonly string[] = ["ok", "rejected", "failed"];
const ACTION = /^[A-Za-z_]{1,64}$/;

/** The filter as the database sees it, or null when a field is not a known shape (it could match nothing). */
function auditFilter(f: unknown): (AuditFilter & { limit: number; summary?: boolean }) | null {
  const o = isObj(f) ? f : {};
  if (o.id !== undefined) {
    if (typeof o.id !== "number" || !Number.isSafeInteger(o.id) || o.id < 1) return null;
    return { id: o.id, limit: 1 }; // the one full row
  }
  const n = typeof o.limit === "number" && Number.isFinite(o.limit) ? Math.trunc(o.limit) : AUDIT_LIMIT.fallback;
  const out: AuditFilter & { limit: number; summary: boolean } = { limit: Math.min(Math.max(n, 1), AUDIT_LIMIT.max), summary: true };
  for (const k of ["from", "to"] as const) {
    if (o[k] === undefined) continue;
    const t = typeof o[k] === "string" ? Date.parse(o[k]) : NaN;
    if (Number.isNaN(t)) return null;
    out[k] = new Date(t).toISOString();
  }
  if (o.action !== undefined) {
    if (typeof o.action !== "string" || !ACTION.test(o.action)) return null;
    out.action = o.action;
  }
  if (o.verdict !== undefined) {
    if (typeof o.verdict !== "string" || !VERDICTS.includes(o.verdict)) return null;
    out.verdict = o.verdict as AuditVerdict;
  }
  return out;
}

const pickCadence = (c: Cadence): Cadence => ({ weekday: c.weekday, time: c.time, timezone: c.timezone });
const fail = (code: string, detail: string): Failure => ({ ok: false, code, detail });
const notFound = (what: string): Failure => fail("not_found", what);
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

const AUDIT_DOWN = "audit log unavailable";
/** Codes that mean the call could not complete, as opposed to a refused input. */
const FAILED_CODES = new Set(["warehouse_error", "warehouse_login", "audit_unavailable", "core_unavailable", "internal"]);
const verdictOf = (code: string): AuditVerdict => (FAILED_CODES.has(code) ? "failed" : "rejected");
/** An id as the audit column takes it: the HTTP layer does not type-check scalars. */
const idOf = (v: unknown): number | undefined => (Number.isInteger(v) ? (v as number) : undefined);

/**
 * A failure's detail as the audit trail keeps it. checkRequests names an invalid request by its key, which is
 * unchecked free text: the trail names it by position instead.
 */
function auditLocation(detail: string, requests: unknown): string {
  if (!detail.startsWith("requests.")) return detail;
  const i = isObj(requests) ? Object.keys(requests).indexOf(detail.slice("requests.".length)) : -1;
  return i >= 0 ? `requests[${i}]` : "requests";
}

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
  const audit = deps.recorder ?? noAudit(deps.now);
  /** Who is calling, as the audit trail records it: the surface, and the client IP the HTTP layer saw. */
  const who = (surface: AuditSurface = "mcp"): Pick<AuditEvent, "surface" | "callerIp"> => {
    const ip = auditContext.getStore()?.callerIp;
    return ip === undefined ? { surface } : { surface, callerIp: ip };
  };

  type Fields = Partial<AuditEvent>;
  const outcomeOf = (r: { ok: boolean }, requests?: unknown): Fields => {
    if (r.ok) return { verdict: "ok" };
    const f = r as Failure;
    return { verdict: verdictOf(f.code), code: f.code, location: auditLocation(f.detail, requests) };
  };

  /**
   * One event per call, best effort (an audit outage never fails these calls). `fn` may fill in fields; `request` is
   * kept only when the call succeeded (never a rejected layout or name). A throw is recorded as failed and rethrown.
   */
  async function audited<T>(
    action: string,
    surface: AuditSurface,
    fn: (ev: Fields) => Promise<T>,
    outcome: (r: T) => Fields = () => ({ verdict: "ok" }),
  ): Promise<T> {
    const t = audit.begin();
    const ev: Fields = {};
    const write = (o: Fields): Promise<void> => {
      const { request, ...rest } = ev;
      return audit.note({
        ...who(surface), action, at: t.at, ...rest, ...(o.verdict === "ok" && request !== undefined ? { request } : {}),
        ...o, durationMs: t.ms(), verdict: o.verdict ?? "ok",
      });
    };
    let r: T;
    try {
      r = await fn(ev);
    } catch (err) {
      await write({ verdict: "failed", code: "internal" });
      throw err;
    }
    await write(outcome(r));
    return r;
  }

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

  /** Log a rejected design per call (spec §4.7): the code only, never the detail, which names a layout location. */
  const logged = async <T extends { ok: boolean }>(p: Promise<T>): Promise<T> => {
    const r = await p;
    if (!r.ok) deps.log.log({ kind: "layout", verdict: "rejected", code: logCode((r as unknown as Failure).code) });
    return r;
  };

  const api: CoreApi = {
    listMenu: () =>
      audited("listMenu", "mcp", async () => ({
        cohorts: Object.entries(catalog.cohorts).map(([name, c]) => ({ name, meaning: c.meaning })),
        measures: Object.entries(catalog.measures).map(([name, m]) => ({ name, meaning: m.meaning, format: m.format })),
        dimensions: Object.entries(catalog.dimensions).map(([name, d]) => ({ name, meaning: d.meaning })),
        filters: [{ name: "due_between", meaning: "Only jobs whose due date is on or after `from` and before `to` (yyyy-MM-dd)." }],
      })),

    // Fail closed: no table leaves unless its event is written.
    async ask(raw) {
      let run: Awaited<ReturnType<typeof runAuditedRequest>>;
      try {
        run = await runAuditedRequest(raw, guardDeps);
      } catch (err) {
        await audit.note({ ...who(), action: "ask", at: deps.now().toISOString(), verdict: "failed", code: "internal" });
        throw err;
      }
      try {
        await audit.record({ ...who(), action: "ask", ...run.audit });
      } catch {
        deps.log.log({ kind: "question", verdict: "failed", code: "audit_unavailable" });
        return { status: "rejected", code: "audit_unavailable", detail: AUDIT_DOWN };
      }
      return run.result;
    },

    // Fail closed: one event per request plus a summary, all written before the PDF is returned.
    async previewDashboard(requests, layout) {
      const t = audit.begin();
      const subs: RequestAudit[] = [];
      let r: PreviewResult;
      try {
        r = await preview(requests, layout, subs);
      } catch (err) {
        await audit.note({ ...who(), action: "previewDashboard", at: t.at, durationMs: t.ms(), verdict: "failed", code: "internal" });
        throw err;
      }
      // Arrays, not the named map: preview request names are not name-checked.
      const summary: AuditEvent = {
        ...who(), action: "previewDashboard", at: t.at, durationMs: t.ms(),
        ...(r.ok
          ? { verdict: "ok", request: { requests: subs.map((x) => x.request) }, result: { bytes: r.bytes, tables: subs.map((x) => x.result) } }
          : { ...outcomeOf(r, requests), verdict: verdictOf(r.code) }),
      };
      try {
        // Written only now that the outcome is known: a preview rejected after the guard keeps no table.
        for (const x of subs) await audit.record({ ...who(), action: "previewDashboard", ...settled(x, r.ok) });
        await audit.record(summary);
      } catch {
        return fail("audit_unavailable", AUDIT_DOWN);
      }
      return r;
    },

    createSchedule: (input) =>
      audited("createSchedule", "mcp", async (ev) => {
        const r = await createScheduleImpl(input, ev);
        if (r.ok) ev.scheduleId = r.id;
        return r;
      }, (r) => outcomeOf(r, isObj(input) ? input.requests : undefined)),

    listSchedules: () =>
      audited("listSchedules", "mcp", async (ev) => {
        const list = await store.listSchedules();
        ev.rowCount = list.length;
        return list;
      }),

    updateSchedule: (id, patch) =>
      audited("updateSchedule", "mcp", async (ev) => {
        ev.scheduleId = idOf(id);
        const r = await updateScheduleImpl(id, patch, ev);
        return r;
      }, (r) => outcomeOf(r, isObj(patch) ? patch.requests : undefined)),

    pauseSchedule: (id, paused) =>
      audited("pauseSchedule", "mcp", async (ev) => {
        Object.assign(ev, { scheduleId: idOf(id), request: { paused: paused === true } });
        if (!(await store.getSchedule(id))) return notFound(`schedule ${id}`);
        await store.setPaused(id, paused);
        return { ok: true } as Done;
      }, outcomeOf),

    deleteSchedule: (id) =>
      audited("deleteSchedule", "mcp", async (ev) => {
        ev.scheduleId = idOf(id);
        if (!(await store.getSchedule(id))) return notFound(`schedule ${id}`);
        await store.deleteSchedule(id); // cascades to runs, files and snapshots
        return { ok: true } as Done;
      }, outcomeOf),

    // The run files its own events (each request and the outcome); only a call that never starts a run is filed here.
    async runScheduleNow(id) {
      const t = audit.begin();
      const early = async (f: Failure): Promise<Failure> => {
        await audit.note({ ...who(), action: "runScheduleNow", at: t.at, durationMs: t.ms(), scheduleId: idOf(id), ...outcomeOf(f), verdict: verdictOf(f.code) });
        return f;
      };
      try {
        const schedule = await store.getSchedule(id);
        if (!schedule) return await early(notFound(`schedule ${id}`));
        const now = deps.now();
        const periodKey = `manual-${now.toISOString()}`;
        const claim = await store.claimRun(id, periodKey, now);
        if (claim === null) return await early(fail("busy", "a run for this moment already exists"));
        const runDeps = {
          ...guardDeps, store, alerter: deps.alerter, synthetic: deps.synthetic === true, uploader: deps.uploader,
          recorder: audit, auditAs: { action: "runScheduleNow", ...who() },
        };
        const status = await withLease(store, claim, () => executeScheduledRun(schedule, claim, periodKey, runDeps, localDate(schedule, now)), { now: deps.now, log: deps.log });
        return { ok: true, runId: claim.runId, periodKey, status };
      } catch (err) {
        await audit.note({ ...who(), action: "runScheduleNow", at: t.at, durationMs: t.ms(), scheduleId: idOf(id), verdict: "failed", code: "internal" });
        throw err;
      }
    },

    listRuns: (limit) =>
      audited("listRuns", "mcp", async (ev) => {
        const n = Number.isFinite(limit) ? Math.min(Math.max(Math.trunc(limit), 1), MAX_RUNS) : 20;
        const runs = await store.listRuns(n);
        Object.assign(ev, { request: { limit: n }, rowCount: runs.length });
        return runs;
      }),

    // Ids and byte counts only: the file contents never reach the trail.
    listPendingFiles: () =>
      audited("listPendingFiles", "courier", async (ev) => {
        const files = await store.pendingFiles();
        Object.assign(ev, {
          fileIds: files.map((f) => f.fileId), rowCount: files.length,
          result: { files: files.map((f) => ({ fileId: f.fileId, bytes: f.bytes })) },
        });
        return files.map((f) => ({
          fileId: f.fileId, folder: f.folder, filename: f.filename, contentType: f.contentType,
          bytes: f.bytes, contentBase64: f.content.toString("base64"),
        }));
      }),

    markFileDelivered: (fileId) =>
      audited("markFileDelivered", "courier", async (ev) => {
        const fid = idOf(fileId);
        Object.assign(ev, { request: { fileId: fid }, fileIds: fid === undefined ? undefined : [fid] });
        if (!(await store.pendingFiles()).some((f) => f.fileId === fileId)) return notFound(`file ${fileId}`);
        await store.markDelivered(fileId, deps.now());
        return { ok: true } as Done;
      }, outcomeOf),

    getDeliveryTargets: () =>
      audited("getDeliveryTargets", "courier", async (ev) => {
        const targets = await store.getTargets();
        ev.rowCount = Object.keys(targets).length;
        return targets;
      }),

    setDeliveryTarget: (key, driveId, itemId) =>
      audited("setDeliveryTarget", "courier", async (ev) => {
        const ok = (s: unknown): boolean => typeof s === "string" && s.trim() !== "" && s.length <= 500;
        if (!ok(key) || !ok(driveId) || !ok(itemId)) return fail("invalid_target", "key, driveId and itemId are required");
        ev.request = { key, driveId, itemId };
        await store.setTarget(key, { driveId, itemId });
        return { ok: true } as Done;
      }, outcomeOf),

    listAudit: (filter) =>
      audited("listAudit", "mcp", async (ev) => {
        const f = auditFilter(filter);
        if (f === null) return [];
        const events = await store.listAudit(f);
        const { summary: _s, ...asked } = f;
        Object.assign(ev, { request: asked, rowCount: events.length });
        return events;
      }),
  };

  async function preview(requests: RawRequests, layout: unknown, subs: RequestAudit[]): Promise<PreviewResult> {
    const design = await checkDesign(requests, layout);
    if (!design.ok) return design;

    const results: Record<string, ResultTable> = {};
    const exempt = new Set<string>();
    let queriedAt = "";
    for (const [name, raw] of Object.entries(design.requests)) {
      const { result: r, audit: sub } = await runAuditedRequest(raw, guardDeps);
      subs.push(sub);
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
  }

  async function createScheduleImpl(input: ScheduleInput, ev: Fields): Promise<{ ok: true; id: number } | Failure> {
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
    ev.request = { slug: input.slug, cadence: pickCadence(input.cadence), requests: Object.values(design.requests) };
    return { ok: true, id };
  }

  async function updateScheduleImpl(id: number, patch: Partial<ScheduleInput>, ev: Fields): Promise<Done> {
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
    const saved = {
      name: patch.name ?? cur.name,
      slug: patch.slug ?? cur.slug,
      cadence: patch.cadence ? pickCadence(patch.cadence) : cur.cadence,
      requests: design.requests,
      layout: design.layout,
    };
    await store.updateSchedule(id, saved);
    ev.request = { slug: saved.slug, cadence: saved.cadence, requests: Object.values(saved.requests) };
    return { ok: true };
  }

  return {
    ...api,
    previewDashboard: (requests, layout) => logged(api.previewDashboard(requests, layout)),
    createSchedule: (input) => logged(api.createSchedule(input)),
    updateSchedule: (id, patch) => logged(api.updateSchedule(id, patch)),
  };
}

export type Core = {
  api: CoreApi;
  /**
   * Start the schedule ticker. Call once, after the server is listening. Runs only when DATA_MODE=live
   * (or ALLOW_SYNTHETIC_SCHEDULES=1, for testing); otherwise returns an inactive handle.
   */
  startTicker(): { active: boolean; stop(): Promise<void> };
  close(): Promise<void>;
};

/**
 * Wire every module together. DATA_MODE=live uses Snowflake; anything else is synthetic.
 * Live mode refuses to start without DATABASE_URL and an alert channel (ALERT_WEBHOOK_URL, or the three email
 * variables; the error names variables only). GITHUB_UPLOAD_TOKEN works in both modes (the owner's decision 2026-10-18).
 * Synthetic mode without DATABASE_URL keeps its state in memory (lost on restart).
 */
export async function createCore(env: NodeJS.ProcessEnv): Promise<Core> {
  const live = env.DATA_MODE === "live";
  if (live && (env.DATABASE_URL ?? "").trim() === "") throw new Error("DATA_MODE=live requires DATABASE_URL to be set");
  const emailMissing = missingEmailVars(env);
  if (emailMissing.length > 0 && emailMissing.length < 3)
    throw new Error(`the email alert channel is partly configured: ${emailMissing.join(", ")} must also be set`);
  if (live && !hasWebhookChannel(env) && !hasEmailChannel(env))
    throw new Error(
      "DATA_MODE=live requires ALERT_WEBHOOK_URL or EMAIL_ALERT_RECIPIENT, ALERT_SMTP_USER and ALERT_SMTP_PASSWORD",
    );
  const catalog = loadCatalog();
  const labels = loadLabels();
  const generic = loadGenericWords();
  const log = createLogger();
  const uploader = createGithubUploader(env, { log: (e) => log.log(e) }) ?? undefined;

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
  const now = (): Date => new Date();
  const recorder = createAuditRecorder(store, { now, log });
  const alerter = auditedAlerter(createAlerter(env, log), recorder);
  await recorder.note({ at: now().toISOString(), surface: "system", action: "startup", verdict: "ok", request: { dataMode: live ? "live" : "synthetic" } });

  const deps: CoreDeps = {
    catalog, labels, generic, data: source.data, names: source.names, store, alerter, log, now, synthetic: !live, uploader, recorder,
  };
  const scheduling = live || env.ALLOW_SYNTHETIC_SCHEDULES === "1";
  const tickers: { stop(): Promise<void> }[] = [];
  // In-flight run_schedule_now calls, settled-never-rejecting, so close() drains them like ticker ticks.
  const manualRuns = new Set<Promise<void>>();
  const api = createCoreApi(deps);
  return {
    api: {
      ...api,
      runScheduleNow(id) {
        const run = api.runScheduleNow(id);
        const settled = run.then(() => {}, () => {});
        manualRuns.add(settled);
        void settled.then(() => manualRuns.delete(settled));
        return run;
      },
    },
    startTicker() {
      if (!scheduling) return { active: false, stop: async () => {} };
      const t = startScheduleTicker({ ...deps, heartbeat: createHeartbeat(env) });
      tickers.push(t);
      return { active: true, stop: t.stop };
    },
    async close() {
      // Drains ticker runs and manual runs alike. A stuck run must not hold the store open past Railway's SIGKILL; the unref'd timer never keeps the process alive.
      await Promise.race([
        Promise.all([...tickers.map((t) => t.stop()), ...manualRuns]),
        sleep(DRAIN_CAP_MS, undefined, { ref: false }),
      ]);
      try {
        await store.close();
      } finally {
        await source.close?.(); // one failing close must not skip the other
      }
    },
  };
}
