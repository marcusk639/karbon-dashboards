import type { Catalog, Labels } from "../config.js";
import type { BuiltQuery, MenuRequest } from "../data/types.js";

export type { MenuRequest } from "../data/types.js";

export class RequestError extends Error {
  readonly code = "disallowed_request" as const;
  constructor(message: string) {
    super(message);
    this.name = "RequestError";
  }
}

const UNREVIEWED = "Other (unreviewed)";
const OTHER = "Other";
const MAX_DIMENSIONS = 3;

const has = (o: object, k: string): boolean => Object.hasOwn(o, k);
const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function isIsoDate(s: unknown): s is string {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

function nameList(
  v: unknown,
  key: string,
  allowed: object,
  min: number,
  max: number,
): string[] {
  if (!Array.isArray(v)) throw new RequestError(`${key} must be a list`);
  if (v.length < min) throw new RequestError(`${key} needs at least ${min}`);
  if (v.length > max) throw new RequestError(`${key} allows at most ${max}`);
  const seen = new Set<string>();
  v.forEach((n, i) => {
    if (typeof n !== "string" || !has(allowed, n))
      throw new RequestError(`${key}[${i}] not in menu`);
    if (seen.has(n)) throw new RequestError(`${key}[${i}] repeated`);
    seen.add(n);
  });
  return v as string[];
}

export function validateRequest(req: unknown, catalog: Catalog): MenuRequest {
  if (!isObj(req)) throw new RequestError("request must be an object");
  const allowedKeys = ["measures", "dimensions", "filters", "orderBy"];
  for (const k of Object.keys(req))
    if (!allowedKeys.includes(k)) throw new RequestError("request has a key not in menu");

  const measures = nameList(req.measures, "measures", catalog.measures, 1, Infinity);
  const dimensions =
    req.dimensions === undefined
      ? undefined
      : nameList(req.dimensions, "dimensions", catalog.dimensions, 0, MAX_DIMENSIONS);
  const out: MenuRequest = { measures };
  if (dimensions !== undefined) out.dimensions = dimensions;

  if (req.filters !== undefined) {
    if (!isObj(req.filters)) throw new RequestError("filters must be an object");
    for (const k of Object.keys(req.filters))
      if (k !== "due_between") throw new RequestError("filters has a key not in menu");
    const db = req.filters.due_between;
    if (db !== undefined) {
      if (!isObj(db)) throw new RequestError("filters.due_between must be an object");
      for (const k of Object.keys(db))
        if (k !== "from" && k !== "to")
          throw new RequestError("filters.due_between has a key not in menu");
      if (!isIsoDate(db.from)) throw new RequestError("filters.due_between.from not a date");
      if (!isIsoDate(db.to)) throw new RequestError("filters.due_between.to not a date");
      if (!(db.from < db.to))
        throw new RequestError("filters.due_between.from must be before to");
      out.filters = { due_between: { from: db.from, to: db.to } };
    } else {
      out.filters = {};
    }
  }

  if (req.orderBy !== undefined) {
    if (!Array.isArray(req.orderBy)) throw new RequestError("orderBy must be a list");
    const inRequest = new Set<string>([...measures, ...(dimensions ?? [])]);
    out.orderBy = req.orderBy.map((o, i) => {
      if (!isObj(o)) throw new RequestError(`orderBy[${i}] must be an object`);
      if (typeof o.field !== "string" || !inRequest.has(o.field))
        throw new RequestError(`orderBy[${i}].field not in request`);
      if (o.dir !== "asc" && o.dir !== "desc")
        throw new RequestError(`orderBy[${i}].dir not in menu`);
      return { field: o.field, dir: o.dir };
    });
  }
  return out;
}

type Piece = { sql: string; binds: (string | number)[] };

function labelExpr(
  baseExpr: string,
  entries: Labels["stage"],
  exempt: Set<string>,
): Piece {
  const names = Object.keys(entries);
  if (names.length === 0) return { sql: `'${UNREVIEWED}'`, binds: [] };
  const binds: (string | number)[] = [];
  const whens: string[] = [];
  for (const name of names) {
    const e = entries[name]!;
    const out = e.outcome === "approve" ? name : e.outcome === "alias" ? e.alias! : OTHER;
    exempt.add(out);
    whens.push(`WHEN ${baseExpr} = ? THEN ?`);
    binds.push(name, out);
  }
  return { sql: `CASE ${whens.join(" ")} ELSE '${UNREVIEWED}' END`, binds };
}

export function buildQuery(input: MenuRequest, catalog: Catalog, labels: Labels): BuiltQuery {
  // Never trust the caller: re-validate (idempotent) before any SQL is assembled.
  const req = validateRequest(input, catalog);
  const dims = req.dimensions ?? [];
  const exempt = new Set<string>([OTHER, UNREVIEWED]);
  const binds: (string | number)[] = [];

  const innerDims: string[] = [];
  for (const d of dims) {
    const def = catalog.dimensions[d]!;
    const mapped = labelExpr(def.expr, labels[def.labels], exempt);
    let sql = mapped.sql;
    let b = mapped.binds;
    if (def.minGroup !== null) {
      sql =
        `CASE WHEN COUNT(*) OVER (PARTITION BY ${mapped.sql}) < ${def.minGroup} ` +
        `THEN '${OTHER}' ELSE ${mapped.sql} END`;
      b = [...mapped.binds, ...mapped.binds];
    }
    innerDims.push(`${sql} AS "${d}"`);
    binds.push(...b);
  }

  let where = catalog.cohorts.active_work!.where;
  const due = req.filters?.due_between;
  if (due) {
    where = `(${where}) AND DUE_DATETIME >= ? AND DUE_DATETIME < ?`;
    binds.push(due.from, due.to);
  }

  const inner = ["t.*", ...innerDims].join(", ");
  const selectList = [
    ...dims.map((d) => `"${d}"`),
    ...req.measures.map((m) => `${catalog.measures[m]!.expr} AS "${m}"`),
  ].join(", ");

  let sql = `SELECT ${selectList} FROM (SELECT ${inner} FROM ${catalog.source} t WHERE ${where})`;
  if (dims.length > 0) sql += ` GROUP BY ${dims.map((d) => `"${d}"`).join(", ")}`;
  if (req.orderBy && req.orderBy.length > 0)
    sql += ` ORDER BY ${req.orderBy
      .map((o) => `"${o.field}" ${o.dir === "desc" ? "DESC" : "ASC"}`)
      .join(", ")}`;

  return { sql, binds, columns: [...dims, ...req.measures], exemptStrings: exempt };
}
