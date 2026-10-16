import type { Logger } from "./log.js";

export type AlertKind = "run_rejected" | "run_failed" | "undelivered";

export interface Alerter {
  /** `detail` must never contain data values. */
  alert(kind: AlertKind, detail: string): Promise<void>;
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
        return;
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
      } catch {
        record(kind);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
