import { DateTime } from "luxon";
import type { Schedule } from "../store/db.js";
import { executeScheduledRun, failRun, type RunDeps } from "./run.js";
import { latestOccurrence } from "./due.js";

export type TickerDeps = RunDeps & {
  /** Test seam; defaults to executeScheduledRun. */
  execute?: typeof executeScheduledRun;
  /** Called (never awaited into a failure) after any tick that executed at least one run, whatever its outcome. */
  heartbeat?: () => Promise<void>;
};

const UNDELIVERED_MIN = 30;

/** yyyy-MM-dd for a run's files: the period key itself, or a manual run's local date (no colons). */
function fileDateOf(s: Schedule, periodKey: string, now: Date): string {
  if (!periodKey.startsWith("manual-")) return periodKey;
  const at = DateTime.fromISO(periodKey.slice("manual-".length), { zone: "utc" });
  return (at.isValid ? at : DateTime.fromJSDate(now)).setZone(s.cadence.timezone).toFormat("yyyy-MM-dd");
}

export function startTicker(
  deps: TickerDeps,
  opts: { intervalMs?: number; now?: () => Date } = {},
): { tickOnce(): Promise<void>; stop(): void } {
  const clock = opts.now ?? (() => new Date());
  const execute = deps.execute ?? executeScheduledRun;
  const { store, alerter, log } = deps;
  let first = true;
  let running = false;

  async function tickOnce(): Promise<void> {
    if (running) return;
    running = true;
    try {
      const now = clock();
      const runDeps: RunDeps = { ...deps, now: () => now };
      if (first) {
        first = false;
        try {
          // Exactly one replica, and nothing is in flight before this process's first tick.
          await store.recoverInterrupted(now, 0);
          for (const r of await store.listRuns(500)) {
            if (r.status !== "interrupted") continue;
            const s = await store.getSchedule(r.scheduleId);
            if (!s) continue;
            const occ = latestOccurrence(s.cadence, now);
            if (occ && occ.periodKey === r.periodKey && !s.paused) continue; // reclaimed below
            await failRun(s, r.runId, r.periodKey, "warehouse_error", runDeps, fileDateOf(s, r.periodKey, now));
          }
        } catch {
          log.log({ kind: "run", verdict: "failed" });
        }
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
          await execute(s, runId, periodKey, runDeps);
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
  return { tickOnce, stop: () => clearInterval(timer) };
}
