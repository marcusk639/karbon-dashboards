import { memStore } from "../helpers/store.js";
import { beforeEach, expect, test, vi } from "vitest";
import { createCoreApi, createCore, type CoreApi } from "../../src/core/api.js";
import { loadCatalog, loadGenericWords, loadLabels } from "../../src/config.js";
import { createSyntheticSource } from "../../src/data/synthetic.js";
import type { DataSource } from "../../src/data/types.js";
import { FixtureNameChecker } from "../../src/guard/names.js";
import { type Store } from "../../src/store/db.js";
import { LAYOUT, REQS } from "../dashboard/fixtures.js";

const NOW = new Date("2026-10-19T13:00:00Z"); // Monday 08:00 Central
const CADENCE = { weekday: 1 as const, time: "08:00", timezone: "America/Chicago" };
const synth = createSyntheticSource(1);

let store: Store;
let api: CoreApi;
let alert: ReturnType<typeof vi.fn>;

async function make(data: DataSource = synth.data): Promise<void> {
  store = await memStore();
  alert = vi.fn(async () => {});
  api = createCoreApi({
    catalog: loadCatalog(),
    labels: loadLabels(),
    generic: loadGenericWords(),
    data,
    names: synth.names,
    store,
    alerter: { alert },
    log: { log: () => {} },
    now: () => NOW,
  });
}
beforeEach(async () => await make());

const input = (over: object = {}) => ({
  name: "Open work",
  slug: "open-work",
  cadence: CADENCE,
  requests: REQS,
  layout: LAYOUT,
  ...over,
});

test("listMenu returns names and meanings, never SQL", async () => {
  const m = api.listMenu();
  expect(m.measures.map((x) => x.name)).toContain("jobs");
  expect(m.dimensions.map((x) => x.name)).toContain("stage");
  expect(m.filters.map((x) => x.name)).toEqual(["due_between"]);
  const text = JSON.stringify(m);
  expect(text).not.toMatch(/SELECT|COUNT\(|KPI_DATABASE|FROM /i);
  for (const x of [...m.cohorts, ...m.measures, ...m.dimensions]) expect(x.meaning.length).toBeGreaterThan(0);
});

test("ask passes the guard result through", async () => {
  const ok = await api.ask({ measures: ["jobs"] });
  expect(ok.status).toBe("ok");
  const bad = await api.ask({ measures: ["jobs"], sql: "select 1" });
  expect(bad).toMatchObject({ status: "rejected", code: "disallowed_request" });
});

test("create_schedule refuses a layout with a URL", async () => {
  const layout = { ...LAYOUT, notes: ["see https://example.com/x"] };
  expect(await api.createSchedule(input({ layout }))).toEqual({ ok: false, code: "pattern_match", detail: "notes[0]" });
  expect(await store.listSchedules()).toHaveLength(0);
});

test("create_schedule refuses an unknown request and reports only its location", async () => {
  const r = await api.createSchedule(input({ requests: { ...REQS, totals: { measures: ["jobs"], sql: "x" } } }));
  expect(r).toEqual({ ok: false, code: "disallowed_request", detail: "requests.totals" });
});

test("create_schedule refuses a layout naming a client", async () => {
  const r = await api.createSchedule(input({ layout: { ...LAYOUT, title: "Zara Quillfeather jobs" } }));
  expect(r).toEqual({ ok: false, code: "client_name", detail: "title" });
});

test("create_schedule refuses a layout that references a missing request", async () => {
  const r = await api.createSchedule(input({ requests: { totals: REQS.totals! } }));
  expect(r).toMatchObject({ ok: false, code: "invalid_layout" });
});

test.each([
  [{ weekday: 0, time: "08:00", timezone: "America/Chicago" }, "cadence.weekday"],
  [{ weekday: 8, time: "08:00", timezone: "America/Chicago" }, "cadence.weekday"],
  [{ weekday: 1.5, time: "08:00", timezone: "America/Chicago" }, "cadence.weekday"],
  [{ weekday: 1, time: "8:00", timezone: "America/Chicago" }, "cadence.time"],
  [{ weekday: 1, time: "24:00", timezone: "America/Chicago" }, "cadence.time"],
  [{ weekday: 1, time: "08:00", timezone: "Mars/Olympus" }, "cadence.timezone"],
  [{ weekday: 1, time: "08:00", timezone: "" }, "cadence.timezone"],
  [{ weekday: 1, time: "08:00", timezone: 5 }, "cadence.timezone"],
  [{ weekday: 1, time: "08:00" }, "cadence.timezone"],
  [null, "cadence"],
])("cadence %j is rejected at %s", async (cadence, detail) => {
  expect(await api.createSchedule(input({ cadence }))).toEqual({ ok: false, code: "invalid_cadence", detail });
});

test.each(["ab", "Has-Caps", "has space", "a".repeat(61), "under_score", "root"])("slug %j is rejected", async (slug) => {
  expect(await api.createSchedule(input({ slug }))).toEqual({ ok: false, code: "invalid_slug", detail: "slug" });
});

test("update_schedule rejects the reserved slug root", async () => {
  const id = ((await api.createSchedule(input())) as { id: number }).id;
  expect(await api.updateSchedule(id, { slug: "root" })).toEqual({ ok: false, code: "invalid_slug", detail: "slug" });
});

test("a duplicate slug is rejected", async () => {
  expect((await api.createSchedule(input())).ok).toBe(true);
  expect(await api.createSchedule(input({ name: "Other" }))).toEqual({ ok: false, code: "duplicate_slug", detail: "slug" });
});

test("create, list, update (re-validated), pause and delete", async () => {
  const c = await api.createSchedule(input());
  expect(c.ok).toBe(true);
  const id = (c as { id: number }).id;
  expect((await api.listSchedules()).map((s) => s.slug)).toEqual(["open-work"]);

  expect(await api.updateSchedule(id, { cadence: { weekday: 9 as never, time: "08:00", timezone: "America/Chicago" } })).toMatchObject({
    ok: false,
    code: "invalid_cadence",
  });
  expect(await api.updateSchedule(id, { layout: { ...LAYOUT, notes: ["http://x.test"] } })).toMatchObject({ ok: false, code: "pattern_match" });
  expect((await store.getSchedule(id))!.layout.notes).toEqual(LAYOUT.notes); // unchanged

  expect(await api.updateSchedule(id, { name: "Renamed", cadence: { ...CADENCE, weekday: 2 } })).toEqual({ ok: true });
  expect(await store.getSchedule(id)).toMatchObject({ name: "Renamed", cadence: { weekday: 2 } });
  expect(await api.updateSchedule(999, { name: "x" })).toMatchObject({ ok: false, code: "not_found" });

  expect(await api.pauseSchedule(id, true)).toEqual({ ok: true });
  expect((await store.getSchedule(id))!.paused).toBe(true);
  expect(await api.pauseSchedule(999, true)).toMatchObject({ ok: false, code: "not_found" });

  expect(await api.deleteSchedule(id)).toEqual({ ok: true });
  expect(await api.listSchedules()).toEqual([]);
  expect(await api.deleteSchedule(id)).toMatchObject({ ok: false, code: "not_found" });
});

test("preview returns a PDF, its size and the filled dashboard", async () => {
  const r = await api.previewDashboard(REQS, LAYOUT);
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  const pdf = Buffer.from(r.pdfBase64, "base64");
  expect(pdf.subarray(0, 4).toString()).toBe("%PDF");
  expect(r.bytes).toBe(pdf.length);
  expect(r.bytes).toBeLessThan(1_048_576);
  expect(r.filled.title).toBe("Open work");
});

test("preview returns the guard's code when a request is rejected", async () => {
  await make({ run: async () => { throw Object.assign(new Error("x"), { code: "warehouse_login" }); } });
  expect(await api.previewDashboard(REQS, LAYOUT)).toEqual({ ok: false, code: "warehouse_login", detail: "login refused" });
});

test("preview rejects a result that carries a client name", async () => {
  const names = new FixtureNameChecker(["Avery Lee"], loadGenericWords());
  const data: DataSource = {
    run: async (q) => ({ columns: [...q.columns], rows: [q.columns.map((c, i) => (i === 0 && q.columns.length > 1 ? "Avery Lee" : 1))] }),
  };
  store = await memStore();
  api = createCoreApi({
    catalog: loadCatalog(), labels: loadLabels(), generic: loadGenericWords(),
    data, names, store, alerter: { alert: async () => {} }, log: { log: () => {} }, now: () => NOW,
  });
  const r = await api.previewDashboard(REQS, LAYOUT);
  expect(r).toMatchObject({ ok: false, code: "client_name" });
});

test("run_schedule_now claims manual-<ISO>, files under today's local date, PDF becomes pending", async () => {
  const id = ((await api.createSchedule(input())) as { id: number }).id;
  const r = await api.runScheduleNow(id);
  expect(r).toMatchObject({ ok: true, status: "produced", periodKey: "manual-2026-10-19T13:00:00.000Z" });
  const runs = await api.listRuns(10);
  expect(runs).toHaveLength(1);
  expect(runs[0]).toMatchObject({ scheduleId: id, periodKey: "manual-2026-10-19T13:00:00.000Z", status: "produced" });

  const files = await api.listPendingFiles();
  expect(files.map((f) => f.filename)).toEqual(["2026-10-19-open-work.pdf", "2026-10-19-open-work.totals.json"]);
  const pdf = files[0]!;
  expect(pdf).toMatchObject({ folder: "open-work", contentType: "application/pdf" });
  expect(Buffer.from(pdf.contentBase64, "base64").subarray(0, 4).toString()).toBe("%PDF");
  expect(pdf.bytes).toBe(Buffer.from(pdf.contentBase64, "base64").length);
  expect(Object.keys(pdf).sort()).toEqual(["bytes", "contentBase64", "contentType", "fileId", "filename", "folder"]);
});

test("the local file date follows the schedule's zone, not UTC", async () => {
  // 2026-10-20T03:00Z is still Monday 22:00 in Chicago
  store = await memStore();
  api = createCoreApi({
    catalog: loadCatalog(), labels: loadLabels(), generic: loadGenericWords(),
    data: synth.data, names: synth.names, store, alerter: { alert: async () => {} },
    log: { log: () => {} }, now: () => new Date("2026-10-20T03:00:00Z"),
  });
  const id = ((await api.createSchedule(input())) as { id: number }).id;
  await api.runScheduleNow(id);
  expect((await api.listPendingFiles())[0]!.filename).toBe("2026-10-19-open-work.pdf");
});

test("run_schedule_now on an unknown schedule, and a run that fails produces a notice", async () => {
  expect(await api.runScheduleNow(42)).toMatchObject({ ok: false, code: "not_found" });
  await make({ run: async () => { throw new Error("down"); } });
  const id = ((await api.createSchedule(input())) as { id: number }).id;
  expect(await api.runScheduleNow(id)).toMatchObject({ ok: true, status: "failed" });
  expect((await api.listPendingFiles())[0]!.filename).toContain("NOT PRODUCED");
  expect(alert).toHaveBeenCalled();
});

test("mark delivered removes the file from pending; unknown id is not_found", async () => {
  const id = ((await api.createSchedule(input())) as { id: number }).id;
  await api.runScheduleNow(id);
  const [a, b] = await api.listPendingFiles();
  expect(await api.markFileDelivered(a!.fileId)).toEqual({ ok: true });
  expect((await api.listPendingFiles()).map((f) => f.fileId)).toEqual([b!.fileId]);
  expect(await api.markFileDelivered(9999)).toMatchObject({ ok: false, code: "not_found" });
});

test("delivery targets round-trip and are validated", async () => {
  expect(await api.getDeliveryTargets()).toEqual({});
  expect(await api.setDeliveryTarget("open-work", "drive1", "item1")).toEqual({ ok: true });
  expect(await api.getDeliveryTargets()).toEqual({ "open-work": { driveId: "drive1", itemId: "item1" } });
  expect(await api.setDeliveryTarget("", "d", "i")).toMatchObject({ ok: false, code: "invalid_target" });
  expect(await api.setDeliveryTarget("k", "", "i")).toMatchObject({ ok: false, code: "invalid_target" });
});

test("list_runs clamps the limit", async () => {
  expect(await api.listRuns(-5)).toEqual([]);
  expect(await api.listRuns(1e9)).toEqual([]);
});

test("createCore in synthetic mode wires a working api, ticker and close", async () => {
  const core = await createCore({ DATA_MODE: "synthetic" });
  expect((await core.api.ask({ measures: ["jobs"] })).status).toBe("ok");
  const t = core.startTicker();
  t.stop();
  await core.close();
});

// I3: every Claude-typed string outside the layout is checked too — slug, schedule name, request names.
test("create_schedule refuses a slug that spells a client name, detail is the location only", async () => {
  const r = await api.createSchedule(input({ slug: "zara-quillfeather-jobs" }));
  expect(r).toEqual({ ok: false, code: "client_name", detail: "slug" });
  expect(await store.listSchedules()).toHaveLength(0);
});

test("create_schedule refuses a schedule name naming a client", async () => {
  const r = await api.createSchedule(input({ name: "Bexley Thornwick weekly" }));
  expect(r).toEqual({ ok: false, code: "client_name", detail: "name" });
});

test("create_schedule refuses a schedule name carrying a pattern (url)", async () => {
  const r = await api.createSchedule(input({ name: "see www.example.com" }));
  expect(r).toEqual({ ok: false, code: "pattern_match", detail: "name" });
});

test("create_schedule refuses a request name naming a client, without echoing it", async () => {
  const requests = { ...REQS, "Zara Quillfeather": { measures: ["jobs"] } };
  const r = await api.createSchedule(input({ requests }));
  expect(r).toMatchObject({ ok: false, code: "client_name" });
  expect(JSON.stringify(r)).not.toMatch(/Zara|Quillfeather/);
});

test("create_schedule refuses a request name carrying an email", async () => {
  const requests = { ...REQS, "x@example.com": { measures: ["jobs"] } };
  const r = await api.createSchedule(input({ requests }));
  expect(r).toMatchObject({ ok: false, code: "pattern_match" });
  expect(JSON.stringify(r)).not.toContain("example.com");
});

test("update_schedule checks a patched slug, name and request names", async () => {
  const c = await api.createSchedule(input());
  if (!c.ok) throw new Error("create failed");
  expect(await api.updateSchedule(c.id, { slug: "orlo-pemberton" })).toEqual({ ok: false, code: "client_name", detail: "slug" });
  expect(await api.updateSchedule(c.id, { name: "Zara Quillfeather" })).toEqual({ ok: false, code: "client_name", detail: "name" });
  const requests = { ...REQS, "Bexley Thornwick": { measures: ["jobs"] } };
  expect(await api.updateSchedule(c.id, { requests })).toMatchObject({ ok: false, code: "client_name" });
  expect((await store.getSchedule(c.id))!.slug).toBe("open-work");
});

test("a name check that throws on authored text fails closed", async () => {
  store = await memStore();
  api = createCoreApi({
    catalog: loadCatalog(), labels: loadLabels(), generic: loadGenericWords(), data: synth.data,
    names: { countMatches: async () => { throw new Error("down"); } },
    store, alerter: { alert: vi.fn(async () => {}) }, log: { log: () => {} }, now: () => NOW,
  });
  expect(await api.createSchedule(input())).toEqual({ ok: false, code: "warehouse_error", detail: "name check failed" });
});

// I4: the ticker runs only against live data; live refuses to start without its state path and alert hook.
test("createCore in synthetic mode does not start the ticker unless explicitly allowed", async () => {
  const off = await createCore({ DATA_MODE: "synthetic" });
  const t = off.startTicker();
  expect(t.active).toBe(false);
  await off.close();
  const on = await createCore({ DATA_MODE: "synthetic", ALLOW_SYNTHETIC_SCHEDULES: "1" });
  const t2 = on.startTicker();
  expect(t2.active).toBe(true);
  await on.close();
});

test("createCore in synthetic mode marks previews as synthetic", async () => {
  const core = await createCore({ DATA_MODE: "synthetic" });
  const r = await core.api.previewDashboard(REQS, LAYOUT);
  expect(r).toMatchObject({ ok: true, filled: { banner: "SYNTHETIC DATA — not from Karbon" } });
  await core.close();
});

test.each([
  ["DATABASE_URL", { ALERT_WEBHOOK_URL: "https://hooks.invalid/secret-hook" }],
  ["ALERT_WEBHOOK_URL", { DATABASE_URL: "postgresql://user:password@host/db?sslmode=require" }],
])("createCore in live mode refuses to start without %s, naming only the variable", async (missing, env) => {
  const full = { DATA_MODE: "live", KARBON_SF_USER: "u", KARBON_SF_PASSWORD: "pw-not-real", ...env };
  let msg = "";
  try {
    await createCore(full);
  } catch (e) {
    msg = (e as Error).message;
  }
  expect(msg).toContain(missing);
  expect(msg).not.toMatch(/secret-hook|pw-not-real|password@host/);
});
