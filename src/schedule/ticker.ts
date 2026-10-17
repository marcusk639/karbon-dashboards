import { DateTime } from "luxon";
import type { Schedule } from "../store/db.js";
import { executeScheduledRun, failRun, type RunDeps } from "./run.js";
import { latestOccurrence } from "./due.js";
import { withLease } from "./lease.js";

export type TickerDeps = RunDeps & {
  /** Test seam; defaults to executeScheduledRun. */
  execute?: typeof executeScheduledRun;
  /** Called (never awaited into a failure) after any tick that executed at least one run, whatever its outcome. */
  heartbeat?: () => Promise<void>;
};

const UNDELIVERED_MIN = 30;

/** Railway SIGKILLs 90 s after SIGTERM: wait at most this long for an in-flight run before closing anyway. */
export const DRAIN_CAP_MS = 60_000;

/** yyyy-MM-dd for a run's files: the period key itself, or a manual run's local date (no colons). */
function fileDateOf(s: Schedule, periodKey: string, now: Date): string {
  if (!periodKey.startsWith("manual-")) return periodKey;
  const at = DateTime.fromISO(periodKey.slice("manual-".length), { zone: "utc" });
  return (at.isValid ? at : DateTime.fromJSDate(now)).setZone(s.cadence.timezone).toFormat("yyyy-MM-dd");
}

export function startTicker(
  deps: TickerDeps,
  opts: { intervalMs?: number; now?: () => Date } = {},
): { tickOnce(): Promise<void>; stop(): Promise<void> } {
  const clock = opts.now ?? (() => new Date());
  const execute = deps.execute ?? executeScheduledRun;
  const { store, alerter, log } = deps;
  let running = false;
  let inflight: Promise<void> = Promise.resolve();

  function tickOnce(): Promise<void> {
    if (running) return Promise.resolve();
    running = true;
    const tick = runTick();
    inflight = tick.catch(() => {});
    return tick;
  }

  async function runTick(): Promise<void> {
    try {
      const now = clock();
      const runDeps: RunDeps = { ...deps, now: () => now };
      try {
        await store.recoverInterrupted(now);
        for (const r of await store.listRuns(500)) {
          if (r.status !== "interrupted") continue;
          const s = await store.getSchedule(r.scheduleId);
          if (!s) continue;
          const occ = latestOccurrence(s.cadence, now);
          if (occ && occ.periodKey === r.periodKey && !s.paused) continue; // reclaimed below
          // Claim it back first: finishRun only ends a running row, and only one process wins the claim.
          const claimed = await store.claimRun(s.id, r.periodKey, now);
          if (claimed === null) continue;
          await failRun(s, claimed, r.periodKey, "warehouse_error", runDeps, fileDateOf(s, r.periodKey, now));
        }
      } catch {
        log.log({ kind: "run", verdict: "failed" });
      }
      let schedules: Schedule[] = [];
      try {
        schedules = await store.listSchedules();
      } catch {
        log.log({ kind: "run", verdict: "failed" });
      }
      let executed = 0;
      for (const s of schedules) {
        let runId: number | null = null;
        let periodKey = "";
        try {
          if (s.paused) continue;
          const occ = latestOccurrence(s.cadence, now);
          if (!occ || s.createdAt > occ.at.toISOString()) continue;
          periodKey = occ.periodKey;
          runId = await store.claimRun(s.id, periodKey, now);
          if (runId === null) continue;
          executed++;
          await withLease(store, runId, () => execute(s, runId!, periodKey, runDeps), { now: () => new Date(), log });
        } catch {
          try {
            log.log({ kind: "run", verdict: "failed", scheduleId: s.id });
          } catch {
            /* best effort */
          }
          if (runId !== null) {
            // Claimed but execution threw: NOT PRODUCED notice, finish, log and alert (failRun never throws).
            await failRun(s, runId, periodKey, "warehouse_error", runDeps);
          } else if (periodKey !== "") {
            // The claim itself threw: nothing was recorded, so the alert is the only trace.
            try {
              await alerter.alert("run_failed", `${s.slug} ${periodKey}: warehouse_error`);
            } catch {
              /* best effort */
            }
          }
        }
      }
      if (executed > 0 && deps.heartbeat) {
        try {
          await deps.heartbeat();
        } catch {
          /* best effort: a missed ping is what the external monitor alerts on */
        }
      }
      try {
        for (const f of await store.undeliveredOlderThan(UNDELIVERED_MIN, now)) {
          await alerter.alert("undelivered", `${f.folder} file ${f.fileId} undelivered`);
          await store.markAlerted(f.fileId, now);
        }
      } catch {
        log.log({ kind: "courier", verdict: "failed" });
      }
    } finally {
      running = false;
    }
  }

  const timer = setInterval(() => {
    tickOnce().catch(() => {
      try {
        log.log({ kind: "run", verdict: "failed" });
      } catch {
        /* swallow */
      }
    });
  }, opts.intervalMs ?? 60_000);
  timer.unref?.();
  return {
    tickOnce,
    /** Stops future ticks now; resolves once any tick already running has finished. */
    stop: () => {
      clearInterval(timer);
      return inflight;
    },
  };
}
