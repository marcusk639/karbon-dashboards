import type { Logger } from "../log.js";
import type { RunClaim, Store } from "../store/db.js";

/** How often a live run refreshes its heartbeat. */
export const LEASE_TOUCH_MS = 30_000;
/** A `running` row with no heartbeat for this long belongs to a dead process and may be recovered. */
export const LEASE_STALE_SEC = 120;

/**
 * Runs fn while refreshing the run's heartbeat, so an overlapping process sees it as alive. Touch errors are swallowed;
 * the first one per run is logged (code only). A touch that finds the claim superseded logs `claim_lost` once and stops
 * touching; fn continues, and its commit rolls back when it finds the claim lost.
 */
export async function withLease<T>(
  store: Store,
  claim: RunClaim,
  fn: () => Promise<T>,
  opts: { everyMs?: number; now?: () => Date; log?: Logger } = {},
): Promise<T> {
  const now = opts.now ?? (() => new Date());
  let logged = false;
  const say = (code: "lease_touch_failed" | "claim_lost"): void => {
    try {
      opts.log?.log({ kind: "run", verdict: "failed", code });
    } catch {
      /* logging is best effort */
    }
  };
  const timer = setInterval(() => {
    store.touchRun(claim, now()).then(
      (held) => {
        if (held) return;
        clearInterval(timer); // touching another attempt's row would keep its lease alive
        say("claim_lost");
      },
      () => {
        // A missed touch only shortens the lease; it must never abort the run.
        if (logged) return;
        logged = true;
        say("lease_touch_failed");
      },
    );
  }, opts.everyMs ?? LEASE_TOUCH_MS);
  try {
    return await fn();
  } finally {
    clearInterval(timer);
  }
}
