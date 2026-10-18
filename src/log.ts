export type RejectCode =
  | "disallowed_request"
  | "unexpected_column"
  | "pattern_match"
  | "client_name"
  | "warehouse_error"
  | "warehouse_login"
  | "core_unavailable"
  | "audit_unavailable";

/**
 * Codes for a rejected design (preview, create, update), a lapsed heartbeat, a lost run claim, the GitHub test
 * upload, a failed alert email and a failed audit write: fixed names, never a detail.
 */
const DESIGN_CODES = [
  "invalid_layout",
  "invalid_slug",
  "duplicate_slug",
  "invalid_name",
  "invalid_cadence",
  "not_found",
  "too_large",
  "lease_touch_failed",
  "claim_lost",
  "github_upload",
  "github_upload_failed",
  "alert_email_failed",
  "audit_write_failed",
] as const;

export type LogCode = RejectCode | (typeof DESIGN_CODES)[number];

const LOG_CODES: ReadonlySet<string> = new Set<string>([
  "disallowed_request", "unexpected_column", "pattern_match", "client_name",
  "warehouse_error", "warehouse_login", "core_unavailable", "audit_unavailable", ...DESIGN_CODES,
] satisfies LogCode[]);

/** A Failure's code as a log code, or undefined when it is not a known name (a log line never carries free text). */
export const logCode = (code: string): LogCode | undefined => (LOG_CODES.has(code) ? (code as LogCode) : undefined);

export type LogEvent = {
  kind: "question" | "run" | "layout" | "courier" | "auth";
  verdict: "ok" | "rejected" | "failed";
  requestHash?: string;
  sqlHash?: string;
  rowCount?: number;
  code?: LogCode;
  scheduleId?: number;
};

export type Logger = { log(e: LogEvent): void };

const KEYS = ["kind", "verdict", "requestHash", "sqlHash", "rowCount", "code", "scheduleId"] as const;

export function createLogger(sink: (line: string) => void = (l) => console.log(l)): Logger {
  return {
    log(e: LogEvent): void {
      const out: Record<string, unknown> = { time: new Date().toISOString() };
      for (const k of KEYS) if (e[k] !== undefined) out[k] = e[k];
      sink(JSON.stringify(out));
    },
  };
}
