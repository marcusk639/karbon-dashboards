import type { Store } from "../store/db.js";
import { executeScheduledRun, failRun, type RunDeps } from "./run.js";
import { latestOccurrence } from "./due.js";

export type TickerDeps = RunDeps & {
  /** Test seam; defaults to executeScheduledRun. */
  execute?: typeof executeScheduledRun;
};

const UNDELIVERED_MIN = 30;

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
          store.recoverInterrupted(now, 0);
          for (const r of store.listRuns(500)) {
            if (r.status !== "interrupted") continue;
            const s = store.getSchedule(r.scheduleId);
            if (!s) continue;
            const occ = latestOccurrence(s.cadence, now);
            if (occ && occ.periodKey === r.periodKey && !s.paused) continue; // reclaimed below
            await failRun(s, r.runId, r.periodKey, "warehouse_error", runDeps);
          }
        } catch {
          log.log({ kind: "run", verdict: "failed" });
        }
      }
      let schedules: ReturnType<Store["listSchedules"]> = [];
      try {
        schedules = store.listSchedules();
      } catch {
        log.log({ kind: "run", verdict: "failed" });
      }
      for (const s of schedules) {
        let runId: number | null = null;
        let periodKey = "";
        try {
          if (s.paused) continue;
          const occ = latestOccurrence(s.cadence, now);
          if (!occ || s.createdAt > occ.at.toISOString()) continue;
          periodKey = occ.periodKey;
          runId = store.claimRun(s.id, periodKey, now);
          if (runId === null) continue;
          await execute(s, runId, periodKey, runDeps);
        } catch {
          try {
            log.log({ kind: "run", verdict: "failed", scheduleId: s.id });
          } catch {
            /* best effort */
          }
          if (runId !== null) {
            try {
              store.finishRun(runId, "failed", "warehouse_error", now);
            } catch {
              /* best effort */
            }
            try {
              await alerter.alert("run_failed", `${s.slug} ${periodKey}: warehouse_error`);
            } catch {
              /* best effort */
            }
          }
        }
      }
      try {
        for (const f of store.undeliveredOlderThan(UNDELIVERED_MIN, now)) {
          await alerter.alert("undelivered", `${f.folder} file ${f.fileId} undelivered`);
          store.markAlerted(f.fileId, now);
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
