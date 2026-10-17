import type { Logger } from "../log.js";
import type { Store } from "../store/db.js";

/** How often a live run refreshes its heartbeat. */
export const LEASE_TOUCH_MS = 30_000;
/** A `running` row with no heartbeat for this long belongs to a dead process and may be recovered. */
export const LEASE_STALE_SEC = 120;

/**
 * Runs fn while refreshing the run's heartbeat, so an overlapping process sees it as alive. Touch errors are swallowed;
 * the first one per run is logged (code only).
 */
export async function withLease<T>(
  store: Store,
  runId: number,
  fn: () => Promise<T>,
  opts: { everyMs?: number; now?: () => Date; log?: Logger } = {},
): Promise<T> {
  const now = opts.now ?? (() => new Date());
  let logged = false;
  const timer = setInterval(() => {
    store.touchRun(runId, now()).catch(() => {
      // A missed touch only shortens the lease; it must never abort the run.
      if (logged) return;
      logged = true;
      try {
        opts.log?.log({ kind: "run", verdict: "failed", code: "lease_touch_failed" });
      } catch {
        /* logging is best effort */
      }
    });
  }, opts.everyMs ?? LEASE_TOUCH_MS);
  try {
    return await fn();
  } finally {
    clearInterval(timer);
  }
}
