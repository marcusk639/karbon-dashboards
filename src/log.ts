export type RejectCode =
  | "disallowed_request"
  | "unexpected_column"
  | "pattern_match"
  | "client_name"
  | "warehouse_error"
  | "warehouse_login";

export type LogEvent = {
  kind: "question" | "run" | "layout" | "courier" | "auth";
  verdict: "ok" | "rejected" | "failed";
  requestHash?: string;
  sqlHash?: string;
  rowCount?: number;
  code?: RejectCode;
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
