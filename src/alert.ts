import type { Logger } from "./log.js";

export type AlertKind = "run_rejected" | "run_failed" | "undelivered";

export interface Alerter {
  /**
   * `detail` must never contain data values. Resolves true when the alert went out: the webhook answered 2xx, or no
   * webhook is configured (the log line is then the alert). False on a non-2xx, timeout or network error. Never throws.
   */
  alert(kind: AlertKind, detail: string): Promise<boolean>;
}

const TIMEOUT_MS = 10_000;

export function createAlerter(
  env: { ALERT_WEBHOOK_URL?: string | undefined },
  log: Logger = { log: (e) => console.log(JSON.stringify(e)) },
): Alerter {
  const url = env.ALERT_WEBHOOK_URL;
  // LogEvent is whitelisted, so the alert goes to the log as a 'run' event without free text.
  const record = (kind: AlertKind): void =>
    log.log({ kind: "run", verdict: kind === "run_rejected" ? "rejected" : "failed" });
  return {
    async alert(kind, detail) {
      if (!url) {
        record(kind);
        return true;
      }
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text: `${kind}: ${detail}` }),
          signal: ctl.signal,
        });
        if (!res.ok) record(kind);
        return res.ok;
      } catch {
        record(kind);
        return false;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/**
 * Dead-man's-switch ping (e.g. a Healthchecks-style URL): a bare GET with no body, so nothing about a
 * run leaves the service. The external monitor alerts if no ping arrives by ~08:30 CT on Mondays.
 * Never throws; a missing HEARTBEAT_URL makes it a no-op.
 */
export function createHeartbeat(env: { HEARTBEAT_URL?: string | undefined }): () => Promise<void> {
  const url = env.HEARTBEAT_URL;
  return async () => {
    if (!url) return;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    try {
      await fetch(url, { method: "GET", signal: ctl.signal });
    } catch {
      /* the monitor's silence is the alert */
    } finally {
      clearTimeout(timer);
    }
  };
}
