import { createHash } from "node:crypto";
import type { AuditEvent } from "../audit.js";
import type { Catalog, Labels } from "../config.js";
import type { DataSource, ResultTable } from "../data/types.js";
import type { Logger, RejectCode } from "../log.js";
import { buildQuery, RequestError, validateRequest } from "../query/build.js";
import type { NameChecker } from "./names.js";
import { findPatterns } from "./patterns.js";

export type { RejectCode } from "../log.js";

export type GuardResult =
  | { status: "ok"; table: ResultTable; sql: string; queriedAt: string }
  | { status: "rejected"; code: RejectCode; detail: string };

export type GuardDeps = {
  catalog: Catalog;
  labels: Labels;
  generic: string[];
  data: DataSource;
  names: NameChecker;
  now: () => Date;
  log: Logger;
  /**
   * Told once per request, at its return point or before a throw, what the audit trail may keep: the validated request, sql, binds,
   * hashes, warehouse query id, verdict, code, location (the detail), counts, and the table only when ok.
   */
  audit?: (e: Partial<AuditEvent>) => void;
};

/** Audit fields of one guarded request: at, duration and everything the guard reported. */
export type RequestAudit = Omit<AuditEvent, "surface" | "action">;

/** How the whole call ended, as its request rows record it. */
export type CallOutcome = { verdict: "ok" } | { verdict: "rejected" | "failed"; code: string; location?: string };

/**
 * A request's fields once the whole call's outcome is known: an accepted table is kept only when the call ended ok,
 * since a later check (the filled layout, the PDF size, another request) can still reject what the guard let
 * through. Such a request takes the call's verdict, code and location; one the guard refused keeps its own. Counts stay.
 */
export function settled(fields: RequestAudit, call: CallOutcome): RequestAudit {
  if (call.verdict === "ok") return fields;
  const { result: _dropped, ...rest } = fields;
  if (rest.verdict !== "ok") return rest;
  return { ...rest, verdict: call.verdict, code: call.code, location: call.location };
}

const hash = (s: string): string => createHash("sha256").update(s).digest("hex").slice(0, 16);

export async function runMenuRequest(raw: unknown, deps: GuardDeps): Promise<GuardResult> {
  // Filled in as the request gets further; never holds raw input that failed validation.
  const seen: Partial<AuditEvent> = {};
  try {
    return await guarded(raw, deps, seen);
  } catch (err) {
    // A throw after the query ran must still leave its sql in the trail.
    try {
      deps.audit?.({ ...seen, verdict: "failed", code: "internal" });
    } catch {
      /* the collector must never change the guard's answer */
    }
    throw err;
  }
}

async function guarded(raw: unknown, deps: GuardDeps, seen: Partial<AuditEvent>): Promise<GuardResult> {
  const report = (e: Partial<AuditEvent>): void => {
    try {
      deps.audit?.({ ...seen, ...e });
    } catch {
      /* the collector must never change the guard's answer */
    }
  };
  const reject = (code: RejectCode, detail: string, extra: { requestHash?: string; sqlHash?: string } = {}): GuardResult => {
    deps.log.log({ kind: "question", verdict: "rejected", code, ...extra });
    const failed = code === "warehouse_error" || code === "warehouse_login";
    report({ verdict: failed ? "failed" : "rejected", code, location: detail });
    return { status: "rejected", code, detail };
  };

  let req;
  try {
    req = validateRequest(raw, deps.catalog);
  } catch (err) {
    if (err instanceof RequestError) return reject("disallowed_request", err.message);
    throw err;
  }
  const requestHash = hash(JSON.stringify(req));
  const q = buildQuery(req, deps.catalog, deps.labels);
  const ids = { requestHash, sqlHash: hash(q.sql) };
  Object.assign(seen, { request: req, sql: q.sql, binds: q.binds, sqlHash: ids.sqlHash });

  let table: ResultTable;
  try {
    table = await deps.data.run(q, req);
  } catch (err) {
    const login = (err as { code?: unknown } | null)?.code === "warehouse_login";
    return reject(login ? "warehouse_login" : "warehouse_error", login ? "login refused" : "query failed", ids);
  }
  if (typeof table?.queryId === "string") seen.warehouseQueryId = table.queryId.slice(0, 200);
  if (Array.isArray(table?.columns)) seen.colCount = table.columns.length;
  if (Array.isArray(table?.rows)) seen.rowCount = table.rows.length;

  const cols = table.columns;
  if (cols.length !== q.columns.length || cols.some((c, i) => c !== q.columns[i])) {
    return reject("unexpected_column", "result columns differ from the request", ids);
  }
  if (!Array.isArray(table.rows) || table.rows.some((r) => !Array.isArray(r) || r.length !== cols.length)) {
    return reject("unexpected_column", "row width differs from columns", ids);
  }
  const badCell = (v: unknown): boolean =>
    !(v === null || typeof v === "string" || (typeof v === "number" && Number.isFinite(v)));
  if (table.rows.some((r) => r.some(badCell))) {
    return reject("unexpected_column", "unexpected cell type", ids);
  }

  // Pattern check on every string cell.
  for (let c = 0; c < table.columns.length; c++) {
    for (const row of table.rows) {
      const v = row[c];
      if (typeof v === "string" && findPatterns(v).length > 0) {
        return reject("pattern_match", `column "${table.columns[c]}"`, ids);
      }
    }
  }

  // Name check on non-exempt string cells, one batch.
  const cells: { text: string; col: string }[] = [];
  for (let c = 0; c < table.columns.length; c++) {
    for (const row of table.rows) {
      const v = row[c];
      if (typeof v === "string" && !q.exemptStrings.has(v)) cells.push({ text: v, col: table.columns[c]! });
    }
  }
  if (cells.length > 0) {
    let counts: number[];
    try {
      counts = await deps.names.countMatches(cells.map((x) => x.text));
    } catch {
      return reject("warehouse_error", "name check failed", ids); // fail closed
    }
    if (
      !Array.isArray(counts) ||
      counts.length !== cells.length ||
      counts.some((n) => typeof n !== "number" || !Number.isFinite(n))
    ) {
      return reject("warehouse_error", "name check failed", ids);
    }
    const i = counts.findIndex((n) => n > 0);
    if (i >= 0) return reject("client_name", `column "${cells[i]!.col}"`, ids);
  }

  deps.log.log({ kind: "question", verdict: "ok", rowCount: table.rows.length, ...ids });
  const accepted: ResultTable = { columns: table.columns, rows: table.rows }; // the query id stays in the audit trail
  report({ verdict: "ok", result: accepted });
  return { status: "ok", table: accepted, sql: q.sql, queriedAt: deps.now().toISOString() };
}

/** runMenuRequest, plus the audit fields of this one request (`at` from deps.now, duration, what the guard reported). */
/** Run one request through the guard; its audit fields are also pushed to `into`, even when the guard throws. */
export async function runAuditedRequest(
  raw: unknown,
  deps: GuardDeps,
  into?: RequestAudit[],
): Promise<{ result: GuardResult; audit: RequestAudit }> {
  const at = deps.now().toISOString();
  const start = performance.now();
  let part: Partial<AuditEvent> = {};
  const fields = (verdict: AuditEvent["verdict"]): RequestAudit => ({ ...part, at, durationMs: Math.round(performance.now() - start), verdict });
  let result: GuardResult;
  try {
    result = await runMenuRequest(raw, { ...deps, audit: (e) => (part = e) });
  } catch (err) {
    into?.push(fields("failed"));
    throw err;
  }
  const audit = fields(part.verdict ?? (result.status === "ok" ? "ok" : "rejected"));
  into?.push(audit);
  return { result, audit };
}
