import { createHash } from "node:crypto";
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
};

const hash = (s: string): string => createHash("sha256").update(s).digest("hex").slice(0, 16);

export async function runMenuRequest(raw: unknown, deps: GuardDeps): Promise<GuardResult> {
  const reject = (code: RejectCode, detail: string, extra: { requestHash?: string; sqlHash?: string } = {}): GuardResult => {
    deps.log.log({ kind: "question", verdict: "rejected", code, ...extra });
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

  let table: ResultTable;
  try {
    table = await deps.data.run(q, req);
  } catch (err) {
    const login = (err as { code?: unknown } | null)?.code === "warehouse_login";
    return reject(login ? "warehouse_login" : "warehouse_error", login ? "login refused" : "query failed", ids);
  }

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
  return { status: "ok", table, sql: q.sql, queriedAt: deps.now().toISOString() };
}
