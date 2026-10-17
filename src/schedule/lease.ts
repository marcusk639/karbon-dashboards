import type { Store } from "../store/db.js";

/** How often a live run refreshes its heartbeat. */
export const LEASE_TOUCH_MS = 30_000;
/** A `running` row with no heartbeat for this long belongs to a dead process and may be recovered. */
export const LEASE_STALE_SEC = 120;

/** Runs fn while refreshing the run's heartbeat, so an overlapping process sees it as alive. Touch errors are swallowed. */
export async function withLease<T>(
  store: Store,
  runId: number,
  fn: () => Promise<T>,
  opts: { everyMs?: number; now?: () => Date } = {},
): Promise<T> {
  const now = opts.now ?? (() => new Date());
  const timer = setInterval(() => {
    store.touchRun(runId, now()).catch(() => {
      /* a missed touch only shortens the lease; it must never abort the run */
    });
  }, opts.everyMs ?? LEASE_TOUCH_MS);
  try {
    return await fn();
  } finally {
    clearInterval(timer);
  }
}
