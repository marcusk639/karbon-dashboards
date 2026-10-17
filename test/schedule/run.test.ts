import { memStore } from "../helpers/store.js";
import { beforeEach, expect, test, vi } from "vitest";
import { loadCatalog, loadLabels, loadGenericWords } from "../../src/config.js";
import { createSyntheticSource } from "../../src/data/synthetic.js";
import type { DataSource } from "../../src/data/types.js";
import { type RunClaim, type Schedule, type Store } from "../../src/store/db.js";
import { executeScheduledRun } from "../../src/schedule/run.js";
import { FixtureNameChecker } from "../../src/guard/names.js";
import type { Alerter } from "../../src/alert.js";
import { LAYOUT, REQS } from "../dashboard/fixtures.js";

const NOW = new Date("2026-10-19T13:00:00Z");
let store: Store;
let alerter: Alerter & { alert: ReturnType<typeof vi.fn> };
let schedule: Schedule;
let claim: RunClaim;

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

beforeEach(async () => {
  store = await memStore();
  alerter = { alert: vi.fn(async () => true) };
  const id = await store.createSchedule(
    {
      name: "Open work by stage",
      slug: "open-work-by-stage",
      cadence: { weekday: 1, time: "08:00", timezone: "America/Chicago" },
      requests: REQS,
      layout: LAYOUT,
    },
    new Date("2026-10-01T00:00:00Z"),
  );
  schedule = (await store.getSchedule(id))!;
  claim = (await store.claimRun(id, "2026-10-19", NOW))!;
});

test("happy path stores PDF, totals and snapshot", async () => {
  expect(await executeScheduledRun(schedule, claim, "2026-10-19", mk(synth.data))).toBe("produced");
  const files = await store.pendingFiles();
  expect(files.map((f) => f.filename)).toEqual([
    "2026-10-19-open-work-by-stage.pdf",
    "2026-10-19-open-work-by-stage.totals.json",
  ]);
  expect(files[0]!.contentType).toBe("application/pdf");
  expect(files[0]!.folder).toBe("open-work-by-stage");
  expect(files[0]!.content.subarray(0, 4).toString()).toBe("%PDF");
  expect(Object.keys(JSON.parse(files[1]!.content.toString()))).toEqual(["totals", "by_status", "by_type"]);
  expect((await store.previousSnapshot(schedule.id, "2026-10-20"))?.periodKey).toBe("2026-10-19");
  expect((await store.listRuns(1))[0]!.status).toBe("produced");
  expect(alerter.alert).not.toHaveBeenCalled();
});

test("fileDate names the files while periodKey is the claim (R4)", async () => {
  await executeScheduledRun(schedule, claim, "manual-x", mk(synth.data), "2026-10-19");
  expect((await store.pendingFiles())[0]!.filename).toBe("2026-10-19-open-work-by-stage-manual.pdf"); // no time in an unreadable key
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
  expect(await executeScheduledRun(schedule, claim, "2026-10-19", deps)).toBe("rejected");
  const files = await store.pendingFiles();
  expect(files).toHaveLength(1);
  const f = files[0]!;
  expect(f.filename).toBe("2026-10-19-open-work-by-stage — NOT PRODUCED.txt");
  expect(f.contentType).toBe("text/plain");
  expect(f.content.toString()).toBe(
    "No dashboard this week. The run was rejected (possible client data). the owner has been notified.\nScheduled: 2026-10-19 08:00 America/Chicago",
  );
  expect(f.content.toString()).not.toContain("Avery");
  expect(alerter.alert).toHaveBeenCalledWith("run_rejected", expect.not.stringContaining("Avery"));
  expect((await store.listRuns(1))[0]).toMatchObject({ status: "rejected", code: "client_name" });
});

test("warehouse login failure -> failed notice", async () => {
  const data: DataSource = {
    async run() {
      throw Object.assign(new Error("login refused"), { code: "warehouse_login" });
    },
  };
  expect(await executeScheduledRun(schedule, claim, "2026-10-19", mk(data))).toBe("failed");
  expect((await store.pendingFiles())[0]!.content.toString()).toContain("could not complete (warehouse_login)");
  expect(alerter.alert).toHaveBeenCalledWith("run_failed", "open-work-by-stage 2026-10-19: warehouse_login");
  expect((await store.listRuns(1))[0]).toMatchObject({ status: "failed", code: "warehouse_login" });
});

test("an exception after the guard (filled check) ends failed, never running", async () => {
  const deps = mk(synth.data);
  deps.names = {
    countMatches: async (texts: string[]) => {
      if (texts.includes("Open work")) throw new Error("boom");
      return synth.names.countMatches(texts);
    },
  };
  expect(await executeScheduledRun(schedule, claim, "2026-10-19", deps)).toBe("failed");
  expect((await store.listRuns(1))[0]).toMatchObject({ status: "failed", code: "warehouse_error" });
  expect((await store.pendingFiles())[0]!.content.toString()).toContain("could not complete (warehouse_error)");
  expect(alerter.alert).toHaveBeenCalledWith("run_failed", expect.not.stringContaining("boom"));
});

test("a throw while storing leaves only the notice (atomic produce)", async () => {
  const deps = mk(synth.data);
  deps.store = { ...store, transaction: (fn) => store.transaction((tx) => fn({ ...tx, saveSnapshot: async () => { throw new Error("disk"); } })) } as Store;
  expect(await executeScheduledRun(schedule, claim, "2026-10-19", deps)).toBe("failed");
  expect((await store.pendingFiles()).map((f) => f.filename)).toEqual(["2026-10-19-open-work-by-stage — NOT PRODUCED.txt"]);
  expect((await store.listRuns(1))[0]).toMatchObject({ status: "failed", code: "warehouse_error" });
});

// I4: synthetic files are named so they cannot be mistaken for live ones.
test("in synthetic mode every file is prefixed SYNTHETIC-", async () => {
  expect(await executeScheduledRun(schedule, claim, "2026-10-19", { ...mk(synth.data), synthetic: true })).toBe("produced");
  expect((await store.pendingFiles()).map((f) => f.filename)).toEqual([
    "SYNTHETIC-2026-10-19-open-work-by-stage.pdf",
    "SYNTHETIC-2026-10-19-open-work-by-stage.totals.json",
  ]);
});
test("in synthetic mode the NOT PRODUCED notice is prefixed SYNTHETIC- too", async () => {
  const broken: DataSource = { run: async () => { throw new Error("x"); } };
  expect(await executeScheduledRun(schedule, claim, "2026-10-19", { ...mk(broken), synthetic: true })).toBe("failed");
  expect((await store.pendingFiles()).map((f) => f.filename)).toEqual(["SYNTHETIC-2026-10-19-open-work-by-stage — NOT PRODUCED.txt"]);
});

// m5: the notice and the run's end land together.
test("failRun writes the notice and finishes the run in one transaction", async () => {
  const spy = vi.spyOn(store, "transaction");
  const broken: DataSource = { run: async () => { throw new Error("x"); } };
  await executeScheduledRun(schedule, claim, "2026-10-19", mk(broken));
  expect(spy).toHaveBeenCalled();
  expect((await store.listRuns(1))[0]).toMatchObject({ status: "failed" });
});
test("failRun still finishes the run if writing the notice fails", async () => {
  vi.spyOn(store, "addFile").mockImplementation(() => { throw new Error("disk full"); });
  const broken: DataSource = { run: async () => { throw new Error("x"); } };
  expect(await executeScheduledRun(schedule, claim, "2026-10-19", mk(broken))).toBe("failed");
  expect((await store.listRuns(1))[0]).toMatchObject({ status: "failed", code: "warehouse_error" });
});

// m6: a manual run must not become next Monday's comparison base.
test("a manual run files its PDF but saves no snapshot", async () => {
  const id = schedule.id;
  const manual = (await store.claimRun(id, "manual-2026-10-19T13:00:00.000Z", NOW))!;
  expect(await executeScheduledRun(schedule, manual, "manual-2026-10-19T13:00:00.000Z", mk(synth.data), "2026-10-19")).toBe("produced");
  expect((await store.pendingFiles()).map((f) => f.filename)).toContain("2026-10-19-open-work-by-stage-manual-0800.pdf");
  expect(await store.previousSnapshot(id, "2026-10-26")).toBeNull();
});

// T6(b): a manual run is named <date>-<slug>-manual-<HHmm> (local time, no colons) so it never collides with the
// scheduled run's files of the same date; scheduled names keep the spec §4.8 pattern.
test("a manual run on a scheduled run's date gets distinct filenames", async () => {
  expect(await executeScheduledRun(schedule, claim, "2026-10-19", mk(synth.data))).toBe("produced");
  const manual = (await store.claimRun(schedule.id, "manual-2026-10-19T13:00:00.000Z", NOW))!;
  expect(await executeScheduledRun(schedule, manual, "manual-2026-10-19T13:00:00.000Z", { ...mk(synth.data), synthetic: true }, "2026-10-19")).toBe("produced");
  const failing = (await store.claimRun(schedule.id, "manual-2026-10-19T15:45:30.000Z", NOW))!;
  const down: DataSource = { run: async () => { throw new Error("down"); } };
  expect(await executeScheduledRun(schedule, failing, "manual-2026-10-19T15:45:30.000Z", mk(down), "2026-10-19")).toBe("failed");
  const names = (await store.pendingFiles()).map((f) => f.filename);
  expect(names).toEqual([
    "2026-10-19-open-work-by-stage.pdf",
    "2026-10-19-open-work-by-stage.totals.json",
    "SYNTHETIC-2026-10-19-open-work-by-stage-manual-0800.pdf",
    "SYNTHETIC-2026-10-19-open-work-by-stage-manual-0800.totals.json",
    "2026-10-19-open-work-by-stage-manual-1045 — NOT PRODUCED.txt",
  ]);
  expect(names.every((n) => !n.includes(":"))).toBe(true);
});

// I1: a process whose claim was superseded before its commit writes nothing and alerts nobody.
async function supersede(): Promise<void> {
  const later = new Date(NOW.getTime() + 16 * 60_000);
  await store.recoverInterrupted(later);
  expect(await store.claimRun(schedule.id, "2026-10-19", later)).toMatchObject({ attempt: 2 });
}
const CLAIM_LOST = [{ kind: "run", verdict: "failed", code: "claim_lost" }];
const runLines = (log: ReturnType<typeof vi.fn>) => log.mock.calls.filter(([e]) => e.kind === "run");

test("a run whose claim was lost before commit leaves no files, no snapshot and no alert", async () => {
  const log = vi.fn();
  await supersede();
  expect(await executeScheduledRun(schedule, claim, "2026-10-19", { ...mk(synth.data), log: { log } })).toBe("failed");
  expect(await store.pendingFiles()).toEqual([]);
  expect(await store.previousSnapshot(schedule.id, "2026-10-20")).toBeNull();
  expect(alerter.alert).not.toHaveBeenCalled();
  expect((await store.listRuns(1))[0]).toMatchObject({ status: "running" }); // still the new owner's
  expect(runLines(log)).toEqual([CLAIM_LOST]); // no run verdict but claim_lost
});

test("a rejected run whose claim was lost writes no notice and sends no alert", async () => {
  const log = vi.fn();
  const broken: DataSource = { run: async () => { throw new Error("x"); } };
  await supersede();
  expect(await executeScheduledRun(schedule, claim, "2026-10-19", { ...mk(broken), log: { log } })).toBe("failed");
  expect(await store.pendingFiles()).toEqual([]);
  expect(alerter.alert).not.toHaveBeenCalled();
  expect((await store.listRuns(1))[0]).toMatchObject({ status: "running" });
  expect(runLines(log)).toEqual([CLAIM_LOST]); // no run verdict but claim_lost
});

test("failRun's fallback finish does not alert when the claim was lost", async () => {
  const log = vi.fn();
  const broken: DataSource = { run: async () => { throw new Error("x"); } };
  await supersede();
  const deps = { ...mk(broken), log: { log } };
  deps.store = { ...store, transaction: async () => { throw new Error("disk full"); } } as Store; // the notice cannot be written
  expect(await executeScheduledRun(schedule, claim, "2026-10-19", deps)).toBe("failed");
  expect(alerter.alert).not.toHaveBeenCalled();
  expect((await store.listRuns(1))[0]).toMatchObject({ status: "running" });
  expect(runLines(log)).toEqual([CLAIM_LOST]); // no run verdict but claim_lost
});
