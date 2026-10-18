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
