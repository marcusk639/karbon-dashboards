import { beforeEach, expect, test, vi } from "vitest";
import { loadCatalog, loadLabels, loadGenericWords } from "../../src/config.js";
import { createSyntheticSource } from "../../src/data/synthetic.js";
import { openStore, type Store } from "../../src/store/db.js";
import { startTicker } from "../../src/schedule/ticker.js";
import type { Alerter } from "../../src/alert.js";
import { LAYOUT, REQS } from "../dashboard/fixtures.js";

const synth = createSyntheticSource(1);
let store: Store;
let alerter: Alerter & { alert: ReturnType<typeof vi.fn> };
let runSpy: ReturnType<typeof vi.fn>;

function deps() {
  return {
    catalog: loadCatalog(),
    labels: loadLabels(),
    generic: loadGenericWords(),
    data: synth.data,
    names: synth.names,
    now: () => new Date("2026-10-19T13:05:00Z"),
    log: { log: () => {} },
    store,
    alerter,
    execute: runSpy as never,
  };
}
const make = (createdAt: string) =>
  store.createSchedule(
    {
      name: "Open work by stage",
      slug: "open-work-by-stage",
      cadence: { weekday: 1, time: "08:00", timezone: "America/Chicago" },
      requests: REQS,
      layout: LAYOUT,
    },
    new Date(createdAt),
  );

beforeEach(() => {
  store = openStore(":memory:");
  alerter = { alert: vi.fn(async () => {}) };
  runSpy = vi.fn(async () => "produced");
});

test("ticker runs once per period across two ticks and a restart", async () => {
  make("2026-10-01T00:00:00Z");
  const t = startTicker(deps(), { now: () => new Date("2026-10-19T13:05:00Z") });
  await t.tickOnce();
  await t.tickOnce();
  t.stop();
  await startTicker(deps(), { now: () => new Date("2026-10-19T13:06:00Z") }).tickOnce();
  expect(runSpy).toHaveBeenCalledTimes(1);
  expect(runSpy.mock.calls[0]![2]).toBe("2026-10-19");
});

test("a schedule created after the occurrence is not run", async () => {
  make("2026-10-19T13:01:00Z");
  await startTicker(deps(), { now: () => new Date("2026-10-19T13:05:00Z") }).tickOnce();
  expect(runSpy).not.toHaveBeenCalled();
});

test("paused schedules are skipped; one failing schedule does not stop the others", async () => {
  const a = make("2026-10-01T00:00:00Z");
  make("2026-10-01T00:00:00Z");
  store.setPaused(a, true);
  await startTicker(deps(), { now: () => new Date("2026-10-19T13:05:00Z") }).tickOnce();
  expect(runSpy).toHaveBeenCalledTimes(1);

  const s2 = openStore(":memory:");
  store = s2;
  make("2026-10-01T00:00:00Z");
  make("2026-10-01T00:00:00Z");
  runSpy.mockReset();
  runSpy.mockRejectedValueOnce(new Error("boom")).mockResolvedValue("produced");
  await startTicker(deps(), { now: () => new Date("2026-10-19T13:05:00Z") }).tickOnce();
  expect(runSpy).toHaveBeenCalledTimes(2);
});

test("first tick recovers interrupted runs", async () => {
  const id = make("2026-10-01T00:00:00Z");
  store.claimRun(id, "2026-10-12", new Date("2026-10-12T13:00:00Z")); // stuck 'running'
  await startTicker(deps(), { now: () => new Date("2026-10-19T13:05:00Z") }).tickOnce();
  expect(store.listRuns(5).find((r) => r.periodKey === "2026-10-12")!.status).toBe("interrupted");
});

test("undelivered after 30 min alerts exactly once", async () => {
  const id = make("2026-10-01T00:00:00Z");
  const runId = store.claimRun(id, "2026-10-19", new Date("2026-10-19T13:00:00Z"))!;
  store.addFile(
    runId,
    { folder: "open-work-by-stage", filename: "2026-10-19-open-work-by-stage.pdf", content: Buffer.from("x"), contentType: "application/pdf" },
    new Date("2026-10-19T13:00:00Z"),
  );
  const at = (iso: string) => startTicker(deps(), { now: () => new Date(iso) });
  await at("2026-10-19T13:29:00Z").tickOnce();
  expect(alerter.alert).toHaveBeenCalledTimes(0);
  await at("2026-10-19T13:31:00Z").tickOnce();
  expect(alerter.alert).toHaveBeenCalledTimes(1);
  expect(alerter.alert.mock.calls[0]![0]).toBe("undelivered");
  await at("2026-10-19T13:40:00Z").tickOnce();
  expect(alerter.alert).toHaveBeenCalledTimes(1);
});
