import type { Store } from "../store/db.js";
import { executeScheduledRun, type RunDeps } from "./run.js";
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
          store.recoverInterrupted(now);
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
        try {
          if (s.paused) continue;
          const occ = latestOccurrence(s.cadence, now);
          if (!occ || s.createdAt > occ.at.toISOString()) continue;
          const runId = store.claimRun(s.id, occ.periodKey, now);
          if (runId === null) continue;
          await execute(s, runId, occ.periodKey, runDeps);
        } catch {
          log.log({ kind: "run", verdict: "failed", scheduleId: s.id });
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

  const timer = setInterval(() => void tickOnce(), opts.intervalMs ?? 60_000);
  timer.unref?.();
  return { tickOnce, stop: () => clearInterval(timer) };
}
