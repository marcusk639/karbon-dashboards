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

export type AuditFilter = {
  from?: string;
  to?: string;
  action?: string;
  verdict?: AuditVerdict;
  limit?: number;
};
