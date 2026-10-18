import type { Alerter } from "./alert.js";
import type { Logger } from "./log.js";
import type { Store } from "./store/db.js";

export type AuditSurface = "mcp" | "scheduler" | "courier" | "system";
export type AuditVerdict = "ok" | "rejected" | "failed";

/**
 * One row of the audit trail (audit_events), in the private Postgres only. `request` is validated input or safe
 * arguments, never raw input that failed validation nor a rejected layout; `result` is kept only when `verdict` is ok.
 */
export type AuditEvent = {
  at: string;
  durationMs?: number;
  surface: AuditSurface;
  action: string;
  callerIp?: string;
  request?: unknown;
  sql?: string;
  binds?: (string | number)[];
  sqlHash?: string;
  warehouseQueryId?: string;
  verdict: AuditVerdict;
  code?: string;
  location?: string;
  rowCount?: number;
  colCount?: number;
  result?: unknown;
  scheduleId?: number;
  runId?: number;
  attempt?: number;
  fileIds?: number[];
};

type Required_ = "at" | "surface" | "action" | "verdict";
/** A stored event: absent fields read back as null. */
export type AuditRow = { id: number } & Pick<AuditEvent, Required_> & {
  [K in Exclude<keyof AuditEvent, Required_>]-?: Exclude<AuditEvent[K], undefined> | null;
};

/** A listed event: everything but the heavy fields, which only a lookup by id returns. */
export type AuditSummary = Omit<AuditRow, "result" | "sql" | "binds">;
export type AuditListed = AuditSummary & Partial<Pick<AuditRow, "result" | "sql" | "binds">>;

export type AuditFilter = {
  /** One event, in full (result, sql and binds included); the other fields are then ignored. */
  id?: number;
  from?: string;
  to?: string;
  action?: string;
  verdict?: AuditVerdict;
  limit?: number;
};

export type AuditRecorder = {
  /** Writes one event; rejects when it could not be written (ask and preview then refuse with audit_unavailable). */
  record(e: AuditEvent): Promise<void>;
  /** Writes one event; on failure logs audit_write_failed and resolves, so a run is never lost to an audit outage. */
  note(e: AuditEvent): Promise<void>;
  /** The start of an event: `at` from the injected clock, and the milliseconds elapsed since. */
  begin(): { at: string; ms(): number };
};

/** Rules 1 and 2, enforced here whatever the caller passed: no values unless ok, no raw input that failed validation. */
function sanitize(e: AuditEvent): AuditEvent {
  const out = { ...e };
  if (out.verdict !== "ok") delete out.result;
  if (out.code === "disallowed_request") delete out.request;
  return out;
}

export function createAuditRecorder(
  store: Pick<Store, "addAuditEvent">,
  opts: { now: () => Date; log: Logger },
): AuditRecorder {
  const record = async (e: AuditEvent): Promise<void> => {
    await store.addAuditEvent(sanitize(e));
  };
  return {
    record,
    async note(e) {
      try {
        await record(e);
      } catch {
        try {
          opts.log.log({ kind: "run", verdict: "failed", code: "audit_write_failed" });
        } catch {
          /* logging is best effort */
        }
      }
    },
    begin() {
      const start = performance.now();
      return { at: opts.now().toISOString(), ms: () => Math.round(performance.now() - start) };
    },
  };
}

/** Records nothing: for a core built without an audit trail (tests). */
export const noAudit = (now: () => Date): AuditRecorder => ({
  record: async () => {},
  note: async () => {},
  begin: () => ({ at: now().toISOString(), ms: () => 0 }),
});

/** Each alert as an `alert` event: its kind and whether every channel took it, never its detail text. */
export function auditedAlerter(alerter: Alerter, audit: AuditRecorder): Alerter {
  return {
    async alert(kind, detail) {
      const t = audit.begin();
      const delivered = await alerter.alert(kind, detail);
      await audit.note({
        at: t.at, durationMs: t.ms(), surface: "system", action: "alert",
        verdict: delivered ? "ok" : "failed", request: { kind, delivered },
      });
      return delivered;
    },
  };
}
