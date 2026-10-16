import { beforeEach, expect, test, vi } from "vitest";
import { loadCatalog, loadLabels, loadGenericWords } from "../../src/config.js";
import { createSyntheticSource } from "../../src/data/synthetic.js";
import type { DataSource } from "../../src/data/types.js";
import { openStore, type Schedule, type Store } from "../../src/store/db.js";
import { executeScheduledRun } from "../../src/schedule/run.js";
import { FixtureNameChecker } from "../../src/guard/names.js";
import type { Alerter } from "../../src/alert.js";
import { LAYOUT, REQS } from "../dashboard/fixtures.js";

const NOW = new Date("2026-10-19T13:00:00Z");
let store: Store;
let alerter: Alerter & { alert: ReturnType<typeof vi.fn> };
let schedule: Schedule;
let runId: number;

const synth = createSyntheticSource(1);
function mk(data: DataSource) {
  return {
    catalog: loadCatalog(),
    labels: loadLabels(),
    generic: loadGenericWords(),
    data,
    names: synth.names,
    now: () => NOW,
    log: { log: () => {} },
    store,
    alerter,
  };
}

beforeEach(() => {
  store = openStore(":memory:");
  alerter = { alert: vi.fn(async () => {}) };
  const id = store.createSchedule(
    {
      name: "Open work by stage",
      slug: "open-work-by-stage",
      cadence: { weekday: 1, time: "08:00", timezone: "America/Chicago" },
      requests: REQS,
      layout: LAYOUT,
    },
    new Date("2026-10-01T00:00:00Z"),
  );
  schedule = store.getSchedule(id)!;
  runId = store.claimRun(id, "2026-10-19", NOW)!;
});

test("happy path stores PDF, totals and snapshot", async () => {
  expect(await executeScheduledRun(schedule, runId, "2026-10-19", mk(synth.data))).toBe("produced");
  const files = store.pendingFiles();
  expect(files.map((f) => f.filename)).toEqual([
    "2026-10-19-open-work-by-stage.pdf",
    "2026-10-19-open-work-by-stage.totals.json",
  ]);
  expect(files[0]!.contentType).toBe("application/pdf");
  expect(files[0]!.folder).toBe("open-work-by-stage");
  expect(files[0]!.content.subarray(0, 4).toString()).toBe("%PDF");
  expect(Object.keys(JSON.parse(files[1]!.content.toString()))).toEqual(["totals", "by_status", "by_type"]);
  expect(store.previousSnapshot(schedule.id, "2026-10-20")?.periodKey).toBe("2026-10-19");
  expect(store.listRuns(1)[0]!.status).toBe("produced");
  expect(alerter.alert).not.toHaveBeenCalled();
});

test("fileDate names the files while periodKey is the claim (R4)", async () => {
  await executeScheduledRun(schedule, runId, "manual-x", mk(synth.data), "2026-10-19");
  expect(store.pendingFiles()[0]!.filename).toBe("2026-10-19-open-work-by-stage.pdf");
});

test("client name in a result -> notice only, alert, no PDF", async () => {
  const data: DataSource = {
    async run(q, req) {
      if (req.dimensions?.includes("primary_status")) return { columns: q.columns, rows: [["Avery Lee", 2, 1]] };
      return synth.data.run(q, req);
    },
  };
  const deps = mk(data);
  deps.names = new FixtureNameChecker(["Avery Lee"], loadGenericWords());
  expect(await executeScheduledRun(schedule, runId, "2026-10-19", deps)).toBe("rejected");
  const files = store.pendingFiles();
  expect(files).toHaveLength(1);
  const f = files[0]!;
  expect(f.filename).toBe("2026-10-19-open-work-by-stage — NOT PRODUCED.txt");
  expect(f.contentType).toBe("text/plain");
  expect(f.content.toString()).toBe(
    "No dashboard this week. The run was rejected (possible client data). Marcus has been notified.\nScheduled: 2026-10-19 08:00 America/Chicago",
  );
  expect(f.content.toString()).not.toContain("Avery");
  expect(alerter.alert).toHaveBeenCalledWith("run_rejected", expect.not.stringContaining("Avery"));
  expect(store.listRuns(1)[0]).toMatchObject({ status: "rejected", code: "client_name" });
});

test("warehouse login failure -> failed notice", async () => {
  const data: DataSource = {
    async run() {
      throw Object.assign(new Error("login refused"), { code: "warehouse_login" });
    },
  };
  expect(await executeScheduledRun(schedule, runId, "2026-10-19", mk(data))).toBe("failed");
  expect(store.pendingFiles()[0]!.content.toString()).toContain("could not complete (warehouse_login)");
  expect(alerter.alert).toHaveBeenCalledWith("run_failed", "open-work-by-stage 2026-10-19: warehouse_login");
  expect(store.listRuns(1)[0]).toMatchObject({ status: "failed", code: "warehouse_login" });
});

test("an exception after the guard (filled check) ends failed, never running", async () => {
  const deps = mk(synth.data);
  deps.names = {
    countMatches: async (texts: string[]) => {
      if (texts.includes("Open work")) throw new Error("boom");
      return synth.names.countMatches(texts);
    },
  };
  expect(await executeScheduledRun(schedule, runId, "2026-10-19", deps)).toBe("failed");
  expect(store.listRuns(1)[0]).toMatchObject({ status: "failed", code: "warehouse_error" });
  expect(store.pendingFiles()[0]!.content.toString()).toContain("could not complete (warehouse_error)");
  expect(alerter.alert).toHaveBeenCalledWith("run_failed", expect.not.stringContaining("boom"));
});

test("a throw while storing leaves only the notice (atomic produce)", async () => {
  const deps = mk(synth.data);
  deps.store = { ...store, saveSnapshot: () => { throw new Error("disk"); }, transaction: store.transaction.bind(store) } as Store;
  expect(await executeScheduledRun(schedule, runId, "2026-10-19", deps)).toBe("failed");
  expect(store.pendingFiles().map((f) => f.filename)).toEqual(["2026-10-19-open-work-by-stage — NOT PRODUCED.txt"]);
  expect(store.listRuns(1)[0]).toMatchObject({ status: "failed", code: "warehouse_error" });
});

// I4: synthetic files are named so they cannot be mistaken for live ones.
test("in synthetic mode every file is prefixed SYNTHETIC-", async () => {
  expect(await executeScheduledRun(schedule, runId, "2026-10-19", { ...mk(synth.data), synthetic: true })).toBe("produced");
  expect(store.pendingFiles().map((f) => f.filename)).toEqual([
    "SYNTHETIC-2026-10-19-open-work-by-stage.pdf",
    "SYNTHETIC-2026-10-19-open-work-by-stage.totals.json",
  ]);
});
test("in synthetic mode the NOT PRODUCED notice is prefixed SYNTHETIC- too", async () => {
  const broken: DataSource = { run: async () => { throw new Error("x"); } };
  expect(await executeScheduledRun(schedule, runId, "2026-10-19", { ...mk(broken), synthetic: true })).toBe("failed");
  expect(store.pendingFiles().map((f) => f.filename)).toEqual(["SYNTHETIC-2026-10-19-open-work-by-stage — NOT PRODUCED.txt"]);
});
