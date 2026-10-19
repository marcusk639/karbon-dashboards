import { beforeEach, expect, test, vi } from "vitest";
import { memStore } from "../helpers/store.js";
import { createCoreApi, type CoreApi } from "../../src/core/api.js";
import { auditedAlerter, createAuditRecorder, type AuditRecorder } from "../../src/audit.js";
import { loadCatalog, loadGenericWords, loadLabels } from "../../src/config.js";
import { createSyntheticSource } from "../../src/data/synthetic.js";
import type { DataSource } from "../../src/data/types.js";
import type { LogEvent } from "../../src/log.js";
import { startTicker } from "../../src/schedule/ticker.js";
import type { Store } from "../../src/store/db.js";
import { LAYOUT, REQS } from "../dashboard/fixtures.js";

const NOW = new Date("2026-10-19T13:00:00Z"); // Monday 08:00 Central
const CADENCE = { weekday: 1 as const, time: "08:00", timezone: "America/Chicago" };
const synth = createSyntheticSource(1);
const NAME = /Zara|Quillfeather/; // a made-up client name the synthetic name checker knows

let store: Store;
let api: CoreApi;
let logged: LogEvent[];
let recorder: AuditRecorder;
let alert: ReturnType<typeof vi.fn>;

const base = () => ({
  catalog: loadCatalog(),
  labels: loadLabels(),
  generic: loadGenericWords(),
  names: synth.names,
  log: { log: (e: LogEvent) => logged.push(e) },
  now: () => NOW,
});

async function make(data: DataSource = synth.data, rec?: AuditRecorder): Promise<void> {
  store = await memStore();
  logged = [];
  alert = vi.fn(async () => true);
  recorder = rec ?? createAuditRecorder(store, { now: () => NOW, log: { log: (e) => logged.push(e) } });
  api = createCoreApi({ ...base(), data, store, alerter: { alert }, recorder });
}
beforeEach(async () => await make());

const rows = () => store.listAudit({ limit: 500 });
const failingRecorder = (): AuditRecorder => {
  const ok = createAuditRecorder({ addAuditEvent: async () => { throw new Error("state store unavailable"); } }, { now: () => NOW, log: { log: (e) => logged.push(e) } });
  return ok;
};

/** A source whose single dimension value is a made-up client name. */
const leaky: DataSource = {
  async run(q) {
    return { columns: [...q.columns], rows: [q.columns.map((_, i) => (i === 0 ? "Zara Quillfeather" : 3))], queryId: "q-leaky" };
  },
};

test("ask ok records the validated request, sql, binds, hash, counts and the full result", async () => {
  const req = { measures: ["jobs"], dimensions: ["stage"], filters: { due_between: { from: "2026-01-01", to: "2026-12-31" } } };
  const r = await api.ask(req);
  if (r.status !== "ok") throw new Error("ask failed");
  const [e, ...more] = await rows();
  expect(more).toEqual([]);
  expect(e).toMatchObject({
    surface: "mcp", action: "ask", verdict: "ok", at: NOW.toISOString(),
    request: req, sql: r.sql, rowCount: r.table.rows.length, colCount: 2,
    result: { columns: r.table.columns, rows: r.table.rows }, code: null, location: null,
  });
  expect(e!.binds).toEqual(expect.arrayContaining(["2026-01-01", "2026-12-31"]));
  expect(e!.sqlHash).toMatch(/^[0-9a-f]{16}$/);
  expect(e!.durationMs).toBeGreaterThanOrEqual(0);
});

test("the warehouse query id is recorded but never returned", async () => {
  await make({ async run(q, req) { return { ...(await synth.data.run(q, req)), queryId: "01b2-abc" }; } });
  const r = await api.ask({ measures: ["jobs"] });
  expect(JSON.stringify(r)).not.toContain("01b2-abc");
  expect((await rows())[0]!.warehouseQueryId).toBe("01b2-abc");
});

test("ask rejected for a client name keeps code, location and counts, never a value", async () => {
  await make(leaky);
  const r = await api.ask({ measures: ["jobs"], dimensions: ["stage"] });
  expect(r).toMatchObject({ status: "rejected", code: "client_name" });
  const [e] = await rows();
  expect(e).toMatchObject({ verdict: "rejected", code: "client_name", location: 'column "stage"', result: null, rowCount: 1, colCount: 2, warehouseQueryId: "q-leaky" });
  expect(JSON.stringify(e)).not.toMatch(NAME);
});

test("ask with an invalid request stores code and location only, never the raw input", async () => {
  const r = await api.ask({ measures: ["Zara Quillfeather"] });
  expect(r).toMatchObject({ status: "rejected", code: "disallowed_request" });
  const [e] = await rows();
  expect(e).toMatchObject({ verdict: "rejected", code: "disallowed_request", location: "measures[0] not in menu", request: null, sql: null, result: null });
  expect(JSON.stringify(e)).not.toMatch(NAME);
});

test("preview with a rejected layout stores code and location only", async () => {
  const r = await api.previewDashboard(REQS, { ...LAYOUT, title: "Zara Quillfeather jobs" });
  expect(r).toMatchObject({ ok: false, code: "client_name", detail: "title" });
  const all = await rows();
  expect(all).toHaveLength(1);
  expect(all[0]).toMatchObject({ action: "previewDashboard", verdict: "rejected", code: "client_name", location: "title", request: null, result: null });
  expect(JSON.stringify(all)).not.toMatch(NAME);
});

test("preview with an invalid request under a client-named key never stores the key", async () => {
  const r = await api.previewDashboard({ ...REQS, "Zara Quillfeather": { measures: ["nope"] } }, LAYOUT);
  expect(r).toMatchObject({ ok: false, code: "disallowed_request" });
  const all = await rows();
  expect(all).toHaveLength(1);
  expect(all[0]).toMatchObject({ code: "disallowed_request", location: "requests[3]", request: null });
  expect(JSON.stringify(all)).not.toMatch(NAME);
});

test("preview ok records one event per request and a summary with bytes and tables, never the PDF", async () => {
  const r = await api.previewDashboard(REQS, LAYOUT);
  if (!r.ok) throw new Error("preview failed");
  const all = await rows();
  expect(all).toHaveLength(4);
  const subs = all.filter((e) => e.sql !== null);
  const [summary] = all.filter((e) => e.sql === null);
  expect(subs).toHaveLength(3);
  for (const s of subs) expect(s).toMatchObject({ action: "previewDashboard", verdict: "ok" });
  expect(subs.map((s) => s.request)).toEqual(expect.arrayContaining(Object.values(REQS)));
  expect(summary).toMatchObject({ action: "previewDashboard", verdict: "ok", result: { bytes: r.bytes } });
  expect((summary!.result as { tables: unknown[] }).tables).toHaveLength(3);
  const text = JSON.stringify(all);
  expect(text).not.toContain(r.pdfBase64.slice(0, 40));
  expect(text).not.toContain("JVBER"); // base64 of "%PDF"
});

test("an audit write failure on ask returns audit_unavailable and no table", async () => {
  await make(synth.data, failingRecorder());
  const r = await api.ask({ measures: ["jobs"] });
  expect(r).toEqual({ status: "rejected", code: "audit_unavailable", detail: "audit log unavailable" });
  expect(logged).toContainEqual(expect.objectContaining({ code: "audit_unavailable" }));
});

test("an audit write failure on preview returns audit_unavailable and no PDF", async () => {
  await make(synth.data, failingRecorder());
  expect(await api.previewDashboard(REQS, LAYOUT)).toEqual({ ok: false, code: "audit_unavailable", detail: "audit log unavailable" });
});

test("every other method records one event per call", async () => {
  const c = await api.createSchedule({ name: "Open work", slug: "open-work", cadence: CADENCE, requests: REQS, layout: LAYOUT });
  if (!c.ok) throw new Error("create failed");
  await api.listMenu();
  await api.listSchedules();
  await api.pauseSchedule(c.id, true);
  await api.pauseSchedule(999, true);
  await api.listRuns(5);
  await api.listPendingFiles();
  await api.markFileDelivered(999);
  await api.getDeliveryTargets();
  await api.setDeliveryTarget("root", "drive-1", "item-1");
  await api.deleteSchedule(c.id);
  const all = (await rows()).reverse();
  expect(all.map((e) => [e.surface, e.action, e.verdict])).toEqual([
    ["mcp", "createSchedule", "ok"],
    ["mcp", "listMenu", "ok"],
    ["mcp", "listSchedules", "ok"],
    ["mcp", "pauseSchedule", "ok"],
    ["mcp", "pauseSchedule", "rejected"],
    ["mcp", "listRuns", "ok"],
    ["courier", "listPendingFiles", "ok"],
    ["courier", "markFileDelivered", "rejected"],
    ["courier", "getDeliveryTargets", "ok"],
    ["courier", "setDeliveryTarget", "ok"],
    ["mcp", "deleteSchedule", "ok"],
  ]);
  expect(all[0]).toMatchObject({ scheduleId: c.id, request: { slug: "open-work", cadence: CADENCE } });
  expect(all[4]).toMatchObject({ code: "not_found", scheduleId: 999 });
});

test("a rejected createSchedule stores code and location, never the name or layout", async () => {
  await api.createSchedule({ name: "Zara Quillfeather weekly", slug: "open-work", cadence: CADENCE, requests: REQS, layout: LAYOUT });
  await api.createSchedule({ name: "Open work", slug: "open-work", cadence: CADENCE, requests: REQS, layout: { ...LAYOUT, notes: ["Zara Quillfeather"] } });
  const all = await rows();
  expect(all.map((e) => [e.code, e.location, e.request])).toEqual([
    ["client_name", "notes[0]", null],
    ["client_name", "name", null],
  ]);
  expect(JSON.stringify(all)).not.toMatch(NAME);
});

test("runScheduleNow records each request and a run summary with file ids", async () => {
  const c = await api.createSchedule({ name: "Open work", slug: "open-work", cadence: CADENCE, requests: REQS, layout: LAYOUT });
  if (!c.ok) throw new Error("create failed");
  const r = await api.runScheduleNow(c.id);
  if (!r.ok) throw new Error("run failed");
  const runEvents = (await rows()).filter((e) => e.action === "runScheduleNow");
  expect(runEvents).toHaveLength(4);
  const files = await store.pendingFiles();
  const [summary] = runEvents.filter((e) => e.sql === null);
  expect(summary).toMatchObject({ surface: "mcp", verdict: "ok", scheduleId: c.id, runId: r.runId, attempt: 1 });
  expect([...summary!.fileIds!].sort()).toEqual(files.map((f) => f.fileId).sort());
  for (const e of runEvents) expect(e).toMatchObject({ scheduleId: c.id, runId: r.runId, attempt: 1 });
});

const runDeps = (data: DataSource = synth.data) => ({ ...base(), data, store, alerter: auditedAlerter({ alert }, recorder), recorder });

async function scheduleOne(): Promise<number> {
  return store.createSchedule({ name: "Open work", slug: "open-work", cadence: CADENCE, requests: REQS, layout: LAYOUT }, new Date("2026-10-01T00:00:00Z"));
}

test("a scheduled run records scheduled_run events with schedule, run, attempt and file ids", async () => {
  const id = await scheduleOne();
  const upload = vi.fn(async () => true);
  await startTicker({ ...runDeps(), uploader: { upload } }, { now: () => new Date("2026-10-19T13:05:00Z") }).tickOnce();
  await vi.waitFor(async () => expect((await rows()).some((e) => e.action === "github_upload")).toBe(true));
  const all = await rows();
  const runs = all.filter((e) => e.action === "scheduled_run");
  expect(runs).toHaveLength(4);
  const [summary] = runs.filter((e) => e.sql === null);
  const files = await store.pendingFiles();
  expect(summary).toMatchObject({ surface: "scheduler", verdict: "ok", scheduleId: id, attempt: 1, callerIp: null });
  expect([...summary!.fileIds!].sort()).toEqual(files.map((f) => f.fileId).sort());
  const pdf = files.find((f) => f.filename.endsWith(".pdf"))!;
  expect(all.find((e) => e.action === "github_upload")).toMatchObject({ surface: "system", verdict: "ok", fileIds: [pdf.fileId], runId: summary!.runId });
});

test("a rejected scheduled run records the rejection and the alert", async () => {
  await scheduleOne();
  await startTicker(runDeps(leaky), { now: () => new Date("2026-10-19T13:05:00Z") }).tickOnce();
  const all = await rows();
  const [summary] = all.filter((e) => e.action === "scheduled_run" && e.sql === null);
  expect(summary).toMatchObject({ verdict: "rejected", code: "client_name" });
  expect(summary!.fileIds).toHaveLength(1); // the NOT PRODUCED notice
  expect(all.find((e) => e.action === "alert")).toMatchObject({ surface: "system", verdict: "ok", request: { kind: "run_rejected", delivered: true } });
  expect(JSON.stringify(all)).not.toMatch(NAME);
});

test("a failed alert is recorded as not delivered", async () => {
  const a = auditedAlerter({ alert: async () => false }, recorder);
  expect(await a.alert("undelivered", "open-work file 3 undelivered")).toBe(false);
  expect((await rows())[0]).toMatchObject({ action: "alert", verdict: "failed", request: { kind: "undelivered", delivered: false } });
});

test("an audit outage never loses a scheduled run: it is produced and audit_write_failed is logged", async () => {
  await scheduleOne();
  recorder = failingRecorder();
  await startTicker(runDeps(), { now: () => new Date("2026-10-19T13:05:00Z") }).tickOnce();
  expect((await store.listRuns(5))[0]).toMatchObject({ status: "produced" });
  expect(logged).toContainEqual({ kind: "run", verdict: "failed", code: "audit_write_failed" });
});

test("listAudit filters, orders newest first, defaults to 100 and caps at 200", async () => {
  for (let d = 1; d <= 3; d++)
    await store.addAuditEvent({ at: new Date(Date.UTC(2026, 9, d)).toISOString(), surface: "mcp", action: d === 2 ? "listRuns" : "ask", verdict: d === 3 ? "rejected" : "ok" });
  expect((await api.listAudit({ action: "ask" })).map((e) => e.at.slice(0, 10))).toEqual(["2026-10-03", "2026-10-01"]);
  expect((await api.listAudit({ verdict: "rejected" })).map((e) => e.at.slice(0, 10))).toEqual(["2026-10-03"]);
  expect((await api.listAudit({ from: "2026-10-02T00:00:00Z", to: "2026-10-02T23:59:59Z" })).map((e) => e.action)).toEqual(["listRuns"]);
  const spy = vi.spyOn(store, "listAudit");
  await api.listAudit({});
  await api.listAudit({ limit: 10_000 });
  await api.listAudit({ limit: 0 });
  expect(spy.mock.calls.map((c) => c[0].limit)).toEqual([100, 200, 1]);
  // A filter that is not a known shape matches nothing rather than reaching the database as free text.
  expect(await api.listAudit({ action: "Zara Quillfeather" })).toEqual([]);
  expect(await api.listAudit({ from: "not a date" })).toEqual([]);
  const own = (await rows()).filter((e) => e.action === "listAudit");
  expect(own.length).toBeGreaterThan(0);
  expect(JSON.stringify(own)).not.toMatch(NAME);
});

test("the ticker purges events older than 365 days once a day and records audit_purge", async () => {
  const day = 86_400_000;
  const now = new Date("2026-10-19T13:05:00Z");
  await store.addAuditEvent({ at: new Date(now.getTime() - 366 * day).toISOString(), surface: "mcp", action: "ask", verdict: "ok" });
  await store.addAuditEvent({ at: new Date(now.getTime() - 364 * day).toISOString(), surface: "mcp", action: "ask", verdict: "ok" });
  let clock = now;
  const t = startTicker(runDeps(), { now: () => clock });
  await t.tickOnce();
  const after = await rows();
  expect(after.filter((e) => e.action === "ask")).toHaveLength(1);
  expect(after.find((e) => e.action === "audit_purge")).toMatchObject({ surface: "system", verdict: "ok", rowCount: 1 });
  // Same day: no second purge.
  await store.addAuditEvent({ at: new Date(now.getTime() - 400 * day).toISOString(), surface: "mcp", action: "ask", verdict: "ok" });
  clock = new Date(now.getTime() + 3_600_000);
  await t.tickOnce();
  expect((await rows()).filter((e) => e.action === "audit_purge")).toHaveLength(1);
  clock = new Date(now.getTime() + day);
  await t.tickOnce();
  expect((await rows()).filter((e) => e.action === "audit_purge")).toHaveLength(2);
  expect((await rows()).filter((e) => e.action === "ask")).toHaveLength(1);
  await t.stop();
});

/** Synthetic data whose dimension labels carry a URL: the guard accepts it, the filled-layout check does not. */
const LEAK = "example-leak";
const urlLabels: DataSource = {
  async run(q, req) {
    const t = await synth.data.run(q, req);
    const dims = req.dimensions?.length ?? 0;
    return { ...t, rows: t.rows.map((r) => r.map((v, i) => (i < dims ? `see www.${LEAK}.com/x` : v))) };
  },
};

test("a preview rejected after the guard accepted its tables keeps no value from them", async () => {
  await make(urlLabels);
  const r = await api.previewDashboard(REQS, LAYOUT);
  expect(r).toMatchObject({ ok: false, code: "pattern_match" });
  const all = await rows();
  const subs = all.filter((e) => e.sql !== null);
  expect(subs).toHaveLength(3);
  for (const s of subs) {
    expect(s.result).toBeNull();
    expect(s.rowCount).toBeGreaterThan(0);
    // The guard passed it, but the call was rejected: the row says so.
    expect(s).toMatchObject({ verdict: "rejected", code: "pattern_match" });
  }
  expect(JSON.stringify(all)).not.toContain(LEAK);
});

test("a scheduled run rejected after the guard accepted its tables keeps no value from them", async () => {
  await scheduleOne();
  await startTicker(runDeps(urlLabels), { now: () => new Date("2026-10-19T13:05:00Z") }).tickOnce();
  expect((await store.listRuns(5))[0]).toMatchObject({ status: "rejected", code: "pattern_match" });
  const all = await rows();
  const subs = all.filter((e) => e.action === "scheduled_run" && e.sql !== null);
  expect(subs).toHaveLength(3);
  for (const s of subs) {
    expect(s.result).toBeNull();
    expect(s.rowCount).toBeGreaterThan(0);
    expect(s).toMatchObject({ verdict: "rejected", code: "pattern_match" });
  }
  expect(JSON.stringify(all)).not.toContain(LEAK);
});

test("listAudit lists summaries without result, sql or binds; an id returns that one full row", async () => {
  const r = await api.ask({ measures: ["jobs"], dimensions: ["stage"] });
  if (r.status !== "ok") throw new Error("ask failed");
  const [summary] = await api.listAudit({ action: "ask" });
  expect(summary).toMatchObject({ action: "ask", verdict: "ok", rowCount: r.table.rows.length, request: { measures: ["jobs"], dimensions: ["stage"] } });
  for (const k of ["result", "sql", "binds"]) expect(summary).not.toHaveProperty(k);
  const full = await api.listAudit({ id: summary!.id });
  expect(full).toHaveLength(1);
  expect(full[0]).toMatchObject({ id: summary!.id, sql: r.sql, result: { columns: r.table.columns, rows: r.table.rows } });
  expect(full[0]!.binds).toBeDefined();
  expect(await api.listAudit({ id: 999_999 })).toEqual([]);
  expect(await api.listAudit({ id: 1.5 })).toEqual([]);
  expect(await api.listAudit({ id: -1 })).toEqual([]);
});

/** Leaks a made-up client name only into the work_type breakdown: the other requests pass the guard. */
const leaksWorkType: DataSource = {
  async run(q, req) {
    const t = await synth.data.run(q, req);
    if (!req.dimensions?.includes("work_type")) return t;
    return { ...t, rows: t.rows.map((r) => r.map((v, i) => (i === 0 ? "Zara Quillfeather" : v))) };
  },
};

test("a preview with one guard-rejected request marks every request row rejected and keeps no value", async () => {
  await make(leaksWorkType);
  const r = await api.previewDashboard(REQS, LAYOUT);
  expect(r).toMatchObject({ ok: false, code: "client_name" });
  const all = await rows();
  const subs = all.filter((e) => e.sql !== null);
  expect(subs).toHaveLength(3);
  for (const s of subs) expect(s).toMatchObject({ verdict: "rejected", code: "client_name", result: null });
  expect(all.filter((e) => e.sql === null)).toHaveLength(1);
  expect(JSON.stringify(all)).not.toMatch(NAME);
});

/** Answers the first query, then returns a malformed table that makes the guard throw after the SQL ran. */
const breaksOnSecond = (): DataSource => {
  let n = 0;
  return {
    async run(q, req) {
      if (++n === 1) return synth.data.run(q, req);
      return {} as never;
    },
  };
};

test("a preview that throws records every request it ran, without results, then the failed call", async () => {
  await make(breaksOnSecond());
  await expect(api.previewDashboard(REQS, LAYOUT)).rejects.toThrow();
  const all = await rows();
  const subs = all.filter((e) => e.sql !== null);
  expect(subs).toHaveLength(2);
  for (const s of subs) expect(s).toMatchObject({ action: "previewDashboard", verdict: "failed", code: "internal", result: null });
  expect(all.filter((e) => e.sql === null)).toEqual([expect.objectContaining({ verdict: "failed", code: "internal" })]);
});

test("an ask that throws after its query ran records the sql, failed/internal and a duration", async () => {
  await make({ async run() { return {} as never; } });
  await expect(api.ask({ measures: ["jobs"] })).rejects.toThrow();
  const [e, ...more] = await rows();
  expect(more).toEqual([]);
  expect(e).toMatchObject({ action: "ask", verdict: "failed", code: "internal", result: null });
  expect(e!.sql).toEqual(expect.any(String));
  expect(e!.durationMs).toBeGreaterThanOrEqual(0);
});

test("a scheduled run that throws mid-way records its requests as failed and still files a notice", async () => {
  await scheduleOne();
  await startTicker(runDeps(breaksOnSecond()), { now: () => new Date("2026-10-19T13:05:00Z") }).tickOnce();
  expect((await store.listRuns(5))[0]).toMatchObject({ status: "failed" });
  const subs = (await rows()).filter((e) => e.action === "scheduled_run" && e.sql !== null);
  expect(subs).toHaveLength(2);
  for (const s of subs) expect(s).toMatchObject({ verdict: "failed", result: null });
});

test("a preview refused because the audit log is down is logged", async () => {
  await make(synth.data, failingRecorder());
  expect(await api.previewDashboard(REQS, LAYOUT)).toMatchObject({ ok: false, code: "audit_unavailable" });
  expect(logged).toContainEqual({ kind: "layout", verdict: "failed", code: "audit_unavailable" });
});

test("a failed or rejected GitHub copy is recorded as failed", async () => {
  for (const upload of [vi.fn(async () => false), vi.fn(async () => { throw new Error("network"); })]) {
    await make();
    await scheduleOne();
    await startTicker({ ...runDeps(), uploader: { upload } }, { now: () => new Date("2026-10-19T13:05:00Z") }).tickOnce();
    await vi.waitFor(async () => expect((await rows()).find((e) => e.action === "github_upload")).toMatchObject({ verdict: "failed" }));
  }
});

test("purge keeps an event exactly 365 days old and drops one a millisecond older", async () => {
  const now = new Date("2026-10-19T13:05:00Z");
  const cutoff = now.getTime() - 365 * 86_400_000;
  await store.addAuditEvent({ at: new Date(cutoff).toISOString(), surface: "mcp", action: "ask", verdict: "ok" });
  await store.addAuditEvent({ at: new Date(cutoff - 1).toISOString(), surface: "mcp", action: "ask", verdict: "ok" });
  await startTicker(runDeps(), { now: () => now }).tickOnce();
  const after = await rows();
  expect(after.filter((e) => e.action === "ask").map((e) => e.at)).toEqual([new Date(cutoff).toISOString()]);
  expect(after.find((e) => e.action === "audit_purge")).toMatchObject({ rowCount: 1 });
});

test("a failed purge logs audit_purge_failed and is retried on the next tick", async () => {
  const now = new Date("2026-10-19T13:05:00Z");
  const purge = vi.spyOn(store, "purgeAudit").mockRejectedValueOnce(new Error("lock timeout"));
  let clock = now;
  const t = startTicker(runDeps(), { now: () => clock });
  await t.tickOnce();
  expect(logged).toContainEqual({ kind: "run", verdict: "failed", code: "audit_purge_failed" });
  expect((await rows()).some((e) => e.action === "audit_purge")).toBe(false);
  clock = new Date(now.getTime() + 60_000);
  await t.tickOnce();
  expect(purge).toHaveBeenCalledTimes(2);
  expect((await rows()).some((e) => e.action === "audit_purge")).toBe(true);
  await t.stop();
});

test("an id that is not a number never reaches the audit location", async () => {
  const r = await api.markFileDelivered("Zara Quillfeather" as never);
  expect(r).toMatchObject({ ok: false, code: "not_found" });
  expect(JSON.stringify(await rows())).not.toMatch(NAME);
});
