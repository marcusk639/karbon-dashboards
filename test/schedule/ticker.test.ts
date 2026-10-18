import { memStore } from "../helpers/store.js";
import { beforeEach, expect, test, vi } from "vitest";
import { loadCatalog, loadLabels, loadGenericWords } from "../../src/config.js";
import { createSyntheticSource } from "../../src/data/synthetic.js";
import { type RunClaim, type Store } from "../../src/store/db.js";
import { startTicker } from "../../src/schedule/ticker.js";
import { createAlerter, type Alerter } from "../../src/alert.js";
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
const make = async (createdAt: string) =>
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

beforeEach(async () => {
  store = await memStore();
  alerter = { alert: vi.fn(async () => true) };
  runSpy = vi.fn(async (_s: unknown, claim: RunClaim) => {
    await store.finishRun(claim, "produced"); // like the real executor
    return "produced";
  });
});

test("ticker runs once per period across two ticks and a restart", async () => {
  await make("2026-10-01T00:00:00Z");
  const t = startTicker(deps(), { now: () => new Date("2026-10-19T13:05:00Z") });
  await t.tickOnce();
  await t.tickOnce();
  t.stop();
  await startTicker(deps(), { now: () => new Date("2026-10-19T13:06:00Z") }).tickOnce();
  expect(runSpy).toHaveBeenCalledTimes(1);
  expect(runSpy.mock.calls[0]![2]).toBe("2026-10-19");
});

test("a schedule created after the occurrence is not run", async () => {
  await make("2026-10-19T13:01:00Z");
  await startTicker(deps(), { now: () => new Date("2026-10-19T13:05:00Z") }).tickOnce();
  expect(runSpy).not.toHaveBeenCalled();
});

test("paused schedules are skipped; one failing schedule does not stop the others", async () => {
  const a = await make("2026-10-01T00:00:00Z");
  await make("2026-10-01T00:00:00Z");
  await store.setPaused(a, true);
  await startTicker(deps(), { now: () => new Date("2026-10-19T13:05:00Z") }).tickOnce();
  expect(runSpy).toHaveBeenCalledTimes(1);

  const s2 = await memStore();
  store = s2;
  await make("2026-10-01T00:00:00Z");
  await make("2026-10-01T00:00:00Z");
  runSpy.mockReset();
  runSpy.mockRejectedValueOnce(new Error("boom")).mockResolvedValue("produced");
  await startTicker(deps(), { now: () => new Date("2026-10-19T13:05:00Z") }).tickOnce();
  expect(runSpy).toHaveBeenCalledTimes(2);
  expect((await store.listRuns(5)).map((r) => r.status).sort()).toEqual(["failed", "running"]);
  expect(alerter.alert).toHaveBeenCalledWith("run_failed", expect.stringContaining("warehouse_error"));
});

test("restart within the scheduled minute runs once, not zero times", async () => {
  const id = await make("2026-10-01T00:00:00Z");
  await store.claimRun(id, "2026-10-19", new Date("2026-10-19T13:00:00Z")); // process A claimed, then died (no touches)
  const t = startTicker(deps(), { now: () => new Date("2026-10-19T13:02:30Z") }); // process B
  await t.tickOnce();
  t.stop();
  expect(runSpy).toHaveBeenCalledTimes(1);
  expect(runSpy.mock.calls[0]![2]).toBe("2026-10-19");
});

test("a live lease blocks a second process", async () => {
  const id = await make("2026-10-01T00:00:00Z");
  const run = (await store.claimRun(id, "2026-10-19", new Date("2026-10-19T13:00:00Z")))!; // process A
  await store.touchRun(run, new Date("2026-10-19T13:01:45Z"));
  const t = startTicker(deps(), { now: () => new Date("2026-10-19T13:02:00Z") }); // process B
  await t.tickOnce();
  expect(runSpy).not.toHaveBeenCalled();
  expect((await store.listRuns(1))[0]).toMatchObject({ periodKey: "2026-10-19", status: "running" });
  await store.finishRun(run, "produced"); // A finishes
  const later = startTicker(deps(), { now: () => new Date("2026-10-19T13:05:00Z") });
  await later.tickOnce();
  t.stop();
  later.stop();
  expect(runSpy).not.toHaveBeenCalled();
});

test("a lapsed lease is recovered once", async () => {
  const id = await make("2026-10-01T00:00:00Z");
  const run = (await store.claimRun(id, "2026-10-19", new Date("2026-10-19T13:00:00Z")))!; // A claims, then dies
  await store.touchRun(run, new Date("2026-10-19T13:00:30Z"));
  const at = (iso: string) => startTicker(deps(), { now: () => new Date(iso) });
  await at("2026-10-19T13:02:00Z").tickOnce(); // 90 s since touch: still live
  expect(runSpy).not.toHaveBeenCalled();
  await at("2026-10-19T13:02:31Z").tickOnce(); // 121 s since touch: lapsed
  expect(runSpy).toHaveBeenCalledTimes(1);
  await at("2026-10-19T13:03:00Z").tickOnce();
  expect(runSpy).toHaveBeenCalledTimes(1);
});

test("a long run that keeps touching is never swept", async () => {
  const id = await make("2026-10-01T00:00:00Z");
  const clock = { at: new Date("2026-10-19T12:00:00Z") };
  const t = startTicker(deps(), { now: () => clock.at });
  await t.tickOnce();
  runSpy.mockClear();
  const run = (await store.claimRun(id, "manual-2026-10-19T13:00:00.000Z", new Date("2026-10-19T13:00:00Z")))!;
  await store.touchRun(run, new Date("2026-10-19T13:19:40Z"));
  clock.at = new Date("2026-10-19T13:20:00Z");
  await t.tickOnce();
  t.stop();
  expect(await store.pendingFiles()).toEqual([]);
  expect((await store.listRuns(5)).find((r) => r.runId === run.runId)!.status).toBe("running");
});

test("a store outage at 08:00 is retried on the next tick", async () => {
  await make("2026-10-01T00:00:00Z");
  vi.spyOn(store, "claimRun").mockRejectedValueOnce(new Error("connection terminated"));
  const t = startTicker(deps(), { now: () => new Date("2026-10-19T13:00:30Z") });
  await t.tickOnce();
  expect(runSpy).not.toHaveBeenCalled();
  expect(alerter.alert).toHaveBeenCalledWith("run_failed", "open-work-by-stage 2026-10-19: warehouse_error");
  await startTicker(deps(), { now: () => new Date("2026-10-19T13:01:30Z") }).tickOnce();
  t.stop();
  expect(runSpy).toHaveBeenCalledTimes(1);
  expect(runSpy.mock.calls[0]![2]).toBe("2026-10-19");
});

test("interrupted run for a past period gets a notice and an alert", async () => {
  const id = await make("2026-10-01T00:00:00Z");
  await store.claimRun(id, "2026-10-12", new Date("2026-10-12T13:00:00Z"));
  await startTicker(deps(), { now: () => new Date("2026-10-19T13:05:00Z") }).tickOnce();
  const run = (await store.listRuns(5)).find((r) => r.periodKey === "2026-10-12")!;
  expect(run).toMatchObject({ status: "failed", code: "warehouse_error" });
  expect((await store.pendingFiles()).map((f) => f.filename)).toContain("2026-10-12-open-work-by-stage — NOT PRODUCED.txt");
  expect(alerter.alert).toHaveBeenCalledWith("run_failed", "open-work-by-stage 2026-10-12: warehouse_error");
});

test("undelivered after 30 min alerts exactly once", async () => {
  const id = await make("2026-10-01T00:00:00Z");
  const claim = (await store.claimRun(id, "2026-10-19", new Date("2026-10-19T13:00:00Z")))!;
  await store.addFile(
    claim.runId,
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

// H1: an undelivered-file alert the webhook did not take is retried on the next tick, not marked sent.
async function undeliveredFile(): Promise<void> {
  const id = await make("2026-10-01T00:00:00Z");
  const claim = (await store.claimRun(id, "2026-10-19", new Date("2026-10-19T13:00:00Z")))!;
  await store.addFile(
    claim.runId,
    { folder: "open-work-by-stage", filename: "2026-10-19-open-work-by-stage.pdf", content: Buffer.from("x"), contentType: "application/pdf" },
    new Date("2026-10-19T13:00:00Z"),
  );
}
const undeliveredCalls = () => alerter.alert.mock.calls.filter((c) => c[0] === "undelivered").length;

test("an undelivered alert the webhook refused is retried on the next tick", async () => {
  await undeliveredFile();
  alerter.alert.mockResolvedValueOnce(false); // webhook answered 500
  const at = (iso: string) => startTicker(deps(), { now: () => new Date(iso) });
  await at("2026-10-19T13:31:00Z").tickOnce();
  expect(undeliveredCalls()).toBe(1);
  await at("2026-10-19T13:32:00Z").tickOnce();
  expect(undeliveredCalls()).toBe(2);
  await at("2026-10-19T13:33:00Z").tickOnce(); // delivered on the retry: marked, not sent again
  expect(undeliveredCalls()).toBe(2);
});

test("an undelivered alert the email channel failed is retried on the next tick", async () => {
  await undeliveredFile();
  const sendMail = vi.fn().mockRejectedValueOnce(new Error("smtp")).mockResolvedValue({});
  alerter = createAlerter(
    { EMAIL_ALERT_RECIPIENT: "owner@example.test", ALERT_SMTP_USER: "sender@example.test", ALERT_SMTP_PASSWORD: "pw-not-real" },
    { log: () => {} },
    { createTransport: () => ({ sendMail }) },
  ) as typeof alerter;
  const at = (iso: string) => startTicker(deps(), { now: () => new Date(iso) });
  await at("2026-10-19T13:31:00Z").tickOnce();
  expect(sendMail).toHaveBeenCalledTimes(1);
  await at("2026-10-19T13:32:00Z").tickOnce();
  expect(sendMail).toHaveBeenCalledTimes(2);
  await at("2026-10-19T13:33:00Z").tickOnce(); // delivered on the retry: marked, not sent again
  expect(sendMail).toHaveBeenCalledTimes(2);
});

test("an undelivered alert the webhook took, or that had only the log, is marked once", async () => {
  await undeliveredFile();
  alerter.alert.mockResolvedValue(true); // 2xx, or no ALERT_WEBHOOK_URL
  const at = (iso: string) => startTicker(deps(), { now: () => new Date(iso) });
  await at("2026-10-19T13:31:00Z").tickOnce();
  await at("2026-10-19T13:32:00Z").tickOnce();
  expect(undeliveredCalls()).toBe(1);
});

// I6: a dead-man's-switch heartbeat after every tick that executed a run, whatever the outcome.
test("heartbeat fires after a tick that ran a schedule, and not after an idle tick", async () => {
  await make("2026-10-01T00:00:00Z");
  const heartbeat = vi.fn(async () => {});
  const t = startTicker({ ...deps(), heartbeat }, { now: () => new Date("2026-10-19T13:05:00Z") });
  await t.tickOnce();
  expect(heartbeat).toHaveBeenCalledTimes(1);
  await t.tickOnce(); // already claimed: nothing executed
  expect(heartbeat).toHaveBeenCalledTimes(1);
  t.stop();
});

test("heartbeat fires after a failed run too, and a throwing heartbeat breaks nothing", async () => {
  await make("2026-10-01T00:00:00Z");
  runSpy.mockRejectedValueOnce(new Error("boom"));
  const heartbeat = vi.fn(async () => { throw new Error("net"); });
  await startTicker({ ...deps(), heartbeat }, { now: () => new Date("2026-10-19T13:05:00Z") }).tickOnce();
  expect(heartbeat).toHaveBeenCalledTimes(1);
  expect(alerter.alert).toHaveBeenCalledWith("run_failed", expect.stringContaining("warehouse_error"));
});

// m1: a claim that throws still alerts; a claimed run whose execution throws gets a NOT PRODUCED notice.
test("claimRun throwing alerts run_failed with slug, period and warehouse_error", async () => {
  await make("2026-10-01T00:00:00Z");
  const d = deps();
  const broken = { ...store, claimRun: async () => { await Promise.resolve(); throw new Error("connection terminated"); } } as typeof store;
  await startTicker({ ...d, store: broken }, { now: () => new Date("2026-10-19T13:05:00Z") }).tickOnce();
  expect(runSpy).not.toHaveBeenCalled();
  expect(alerter.alert).toHaveBeenCalledWith("run_failed", "open-work-by-stage 2026-10-19: warehouse_error");
});

test("a claimed run whose execution throws ends failed with a NOT PRODUCED notice", async () => {
  await make("2026-10-01T00:00:00Z");
  runSpy.mockRejectedValueOnce(new Error("boom"));
  await startTicker(deps(), { now: () => new Date("2026-10-19T13:05:00Z") }).tickOnce();
  expect((await store.listRuns(5))[0]).toMatchObject({ status: "failed", code: "warehouse_error" });
  expect((await store.pendingFiles()).map((f) => f.filename)).toEqual(["2026-10-19-open-work-by-stage — NOT PRODUCED.txt"]);
});

// m4: an interrupted manual run's notice is named by its local date and time — no colons (OneDrive rejects them).
test("an interrupted manual run gets a notice named by its local date and time", async () => {
  const id = await make("2026-10-01T00:00:00Z");
  await store.claimRun(id, "manual-2026-10-14T02:30:00.000Z", new Date("2026-10-14T02:30:00Z")); // Tue 21:30 Chicago, 13th
  await startTicker(deps(), { now: () => new Date("2026-10-19T13:05:00Z") }).tickOnce();
  const names = (await store.pendingFiles()).map((f) => f.filename);
  expect(names).toContain("2026-10-13-open-work-by-stage-manual-2130 — NOT PRODUCED.txt");
  expect(names.every((n) => !n.includes(":"))).toBe(true);
});

// M6: a run stranded by a store outage is recovered on a later tick, without a restart.
test("a later tick recovers a run whose lease lapsed", async () => {
  const id = await make("2026-10-01T00:00:00Z");
  const clock = { at: new Date("2026-10-19T12:00:00Z") };
  const t = startTicker(deps(), { now: () => clock.at });
  await t.tickOnce(); // first tick runs the previous Monday's period
  runSpy.mockClear();
  await store.claimRun(id, "2026-10-19", new Date("2026-10-19T13:00:00Z")); // claimed, then the store went away
  clock.at = new Date("2026-10-19T13:20:00Z");
  await t.tickOnce();
  t.stop();
  expect(runSpy).toHaveBeenCalledTimes(1);
  expect(runSpy.mock.calls[0]![2]).toBe("2026-10-19");
});

test("a later tick leaves a young running run alone", async () => {
  const id = await make("2026-10-01T00:00:00Z");
  const clock = { at: new Date("2026-10-19T12:00:00Z") };
  const t = startTicker(deps(), { now: () => clock.at });
  await t.tickOnce();
  runSpy.mockClear();
  const run = (await store.claimRun(id, "2026-10-19", new Date("2026-10-19T13:10:00Z")))!;
  await store.touchRun(run, new Date("2026-10-19T13:19:40Z")); // lease is live
  clock.at = new Date("2026-10-19T13:20:00Z");
  await t.tickOnce();
  t.stop();
  expect(runSpy).not.toHaveBeenCalled();
  expect((await store.listRuns(1))[0]).toMatchObject({ periodKey: "2026-10-19", status: "running" });
});

test("stop waits for the in-flight run", async () => {
  await make("2026-10-01T00:00:00Z");
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  runSpy.mockImplementation(async (_s: unknown, claim: RunClaim) => {
    await gate;
    await store.finishRun(claim, "produced");
    return "produced";
  });
  const t = startTicker(deps(), { now: () => new Date("2026-10-19T13:05:00Z") });
  const tick = t.tickOnce();
  await vi.waitFor(() => expect(runSpy).toHaveBeenCalledTimes(1));
  let settled = false;
  const stopped = t.stop().then(() => (settled = true));
  await Promise.resolve();
  await Promise.resolve();
  expect(settled).toBe(false);
  release();
  await stopped;
  await tick;
  expect((await store.listRuns(1))[0]).toMatchObject({ periodKey: "2026-10-19", status: "produced" });
});

// I1: the ticker keeps a slow run's lease alive on the wall clock, not the tick's frozen `now`.
test("a slow scheduled run keeps touching its lease with wall-clock time", async () => {
  await make("2026-10-01T00:00:00Z");
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
  try {
    vi.setSystemTime(new Date("2026-10-19T13:05:00Z"));
    const frozen = new Date("2026-10-19T13:05:00Z");
    const touch = vi.spyOn(store, "touchRun");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let started!: (claim: RunClaim) => void;
    const begun = new Promise<RunClaim>((resolve) => (started = resolve));
    runSpy.mockImplementation(async (_s: unknown, claim: RunClaim) => {
      started(claim);
      await gate;
      await store.finishRun(claim, "produced");
      return "produced";
    });
    const tick = startTicker(deps(), { now: () => frozen }).tickOnce();
    const claim = await begun;
    await vi.advanceTimersByTimeAsync(95_000);
    const calls = touch.mock.calls.filter((c) => c[0] === claim);
    expect(calls.length).toBeGreaterThanOrEqual(3);
    for (const [, at] of calls) expect(at.getTime()).not.toBe(frozen.getTime());
    release();
    await tick;
  } finally {
    vi.useRealTimers();
  }
});

test("a failing lease touch during a scheduled run is logged once, by code", async () => {
  await make("2026-10-01T00:00:00Z");
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  try {
    vi.spyOn(store, "touchRun").mockRejectedValue(new Error("connection terminated"));
    const log = vi.fn();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let started!: () => void;
    const begun = new Promise<void>((resolve) => (started = resolve));
    runSpy.mockImplementation(async (_s: unknown, claim: RunClaim) => {
      started();
      await gate;
      await store.finishRun(claim, "produced");
      return "produced";
    });
    const tick = startTicker({ ...deps(), log: { log } }, { now: () => new Date("2026-10-19T13:05:00Z") }).tickOnce();
    await begun;
    await vi.advanceTimersByTimeAsync(65_000);
    release();
    await tick;
    expect(log.mock.calls.filter(([e]) => e.code === "lease_touch_failed")).toEqual([
      [{ kind: "run", verdict: "failed", code: "lease_touch_failed" }],
    ]);
  } finally {
    vi.useRealTimers();
  }
});

// I1 / gap 8: two processes over one store recover an interrupted row exactly once.
test("two tickers and an interrupted current-period row: exactly one execute", async () => {
  const id = await make("2026-10-01T00:00:00Z");
  await store.claimRun(id, "2026-10-19", new Date("2026-10-19T13:00:00Z")); // claimed, then the process died
  const at = () => startTicker(deps(), { now: () => new Date("2026-10-19T13:05:00Z") });
  await Promise.all([at().tickOnce(), at().tickOnce()]);
  expect(runSpy).toHaveBeenCalledTimes(1);
  expect(runSpy.mock.calls[0]![1]).toMatchObject({ attempt: 2 });
  expect((await store.listRuns(5)).find((r) => r.periodKey === "2026-10-19")!.status).toBe("produced");
});

test("two tickers and an interrupted past-period row: exactly one NOT PRODUCED notice", async () => {
  const id = await make("2026-10-01T00:00:00Z");
  await store.claimRun(id, "2026-10-12", new Date("2026-10-12T13:00:00Z"));
  const at = () => startTicker(deps(), { now: () => new Date("2026-10-19T13:05:00Z") });
  await Promise.all([at().tickOnce(), at().tickOnce()]);
  const notices = (await store.pendingFiles()).filter((f) => f.filename === "2026-10-12-open-work-by-stage — NOT PRODUCED.txt");
  expect(notices).toHaveLength(1);
  expect(alerter.alert.mock.calls.filter((c) => c[1] === "open-work-by-stage 2026-10-12: warehouse_error")).toHaveLength(1);
  expect((await store.listRuns(5)).find((r) => r.periodKey === "2026-10-12")).toMatchObject({ status: "failed", code: "warehouse_error" });
});
