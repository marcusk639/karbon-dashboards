import { DateTime } from "luxon";
import type { Catalog, Format } from "../config.js";
import type { ResultTable } from "../data/types.js";
import type { NameChecker } from "../guard/names.js";
import { findPatterns } from "../guard/patterns.js";
import type { Layout } from "./layout.js";

export type Snapshot = { periodKey: string; totals: Record<string, ResultTable> };

export type FilledDashboard = {
  title: string;
  subtitle?: string;
  asOf: string;
  tiles: { label: string; value: string; change: string | null }[];
  charts: { title: string; bars: { label: string; value: number }[] }[];
  tables: { title: string; header: string[]; rows: string[][] }[];
  notes: string[];
  footnotes: string[];
};

const ZONE = "America/Chicago";
const UNREVIEWED = "Other (unreviewed)";
const DASH = "—";

const fmtInt = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const fmtHours = new Intl.NumberFormat("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 });

/** pct values are percentage points already (40 means 40%). */
function formatValue(n: number, format: Format): string {
  if (format === "hours") return fmtHours.format(n);
  if (format === "pct") return `${fmtInt.format(n)}%`;
  return fmtInt.format(n);
}

const colIndex = (t: ResultTable | undefined, name: string): number => (t ? t.columns.indexOf(name) : -1);

/** Row 0 of a request's result for one measure; null when absent. */
function totalOf(t: ResultTable | undefined, measure: string): number | null {
  const i = colIndex(t, measure);
  const v = t?.rows[0]?.[i];
  return i >= 0 && typeof v === "number" ? v : null;
}

function tileValue(layout: Layout["tiles"][number], results: Record<string, ResultTable>, catalog: Catalog): string {
  const format = catalog.measures[layout.measure]!.format;
  const v = totalOf(results[layout.request], layout.measure) ?? 0;
  const text = formatValue(v, format);
  if (layout.shareOf === undefined) return text;
  const base = totalOf(results[layout.request], layout.shareOf) ?? 0;
  if (base === 0) return text;
  return `${text} (${Math.round((v / base) * 100)}%)`;
}

function tileChange(
  tile: Layout["tiles"][number],
  current: number,
  previous: Snapshot | null,
  catalog: Catalog,
): string | null {
  if (!tile.showChange) return null;
  if (previous === null) return "No earlier run to compare";
  const before = totalOf(previous.totals[tile.request], tile.measure);
  if (before === null) return null;
  const format = catalog.measures[tile.measure]!.format;
  const diff = current - before;
  const body = formatValue(Math.abs(diff), format);
  if (diff === 0 || body === formatValue(0, format)) return `No change since ${previous.periodKey}`;
  return `${diff > 0 ? "+" : "-"}${body} since ${previous.periodKey}`;
}

function cell(v: string | number | null, field: string, catalog: Catalog): string {
  if (v === null) return DASH;
  const m = Object.hasOwn(catalog.measures, field) ? catalog.measures[field] : undefined;
  if (m && typeof v === "number") return formatValue(v, m.format);
  return String(v);
}

function sortRows(rows: ResultTable["rows"], idx: number, dir: "asc" | "desc"): ResultTable["rows"] {
  const sign = dir === "asc" ? 1 : -1;
  return rows
    .map((r, i) => ({ r, i }))
    .sort((a, b) => {
      const x = a.r[idx] ?? null;
      const y = b.r[idx] ?? null;
      if (x === null || y === null) return x === y ? a.i - b.i : x === null ? 1 : -1; // nulls last either way
      const c = typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y));
      return c !== 0 ? sign * c : a.i - b.i;
    })
    .map((o) => o.r);
}

export function fillLayout(
  layout: Layout,
  results: Record<string, ResultTable>,
  previous: Snapshot | null,
  queriedAt: Date,
  catalog: Catalog,
): FilledDashboard {
  const used: string[] = [];
  const use = (m: string): void => {
    if (Object.hasOwn(catalog.measures, m) && !used.includes(m)) used.push(m);
  };
  // Unreviewed-label count per (request, dimension); the largest is reported so one job
  // seen through two cuts is not counted twice.
  const unreviewed = new Map<string, number>();
  const noteUnreviewed = (request: string, dimension: string): void => {
    const t = results[request];
    const di = colIndex(t, dimension);
    if (!t || di < 0) return;
    const ji = t.columns.indexOf("jobs");
    let n = 0;
    let seen = false;
    for (const row of t.rows) {
      if (row[di] !== UNREVIEWED) continue;
      seen = true;
      const j = ji >= 0 ? row[ji] : null;
      n += ji >= 0 && typeof j === "number" ? j : ji >= 0 ? 0 : 1;
    }
    if (seen) unreviewed.set(`${request}\u0000${dimension}`, n);
  };

  const tiles = layout.tiles.map((t) => {
    use(t.measure);
    if (t.shareOf !== undefined) use(t.shareOf);
    const current = totalOf(results[t.request], t.measure) ?? 0;
    return { label: t.label, value: tileValue(t, results, catalog), change: tileChange(t, current, previous, catalog) };
  });

  const charts = layout.charts.map((c) => {
    use(c.measure);
    noteUnreviewed(c.request, c.dimension);
    const t = results[c.request];
    const di = colIndex(t, c.dimension);
    const mi = colIndex(t, c.measure);
    const bars = (t?.rows ?? []).map((row) => {
      const label = row[di];
      const v = row[mi];
      return { label: label === null || label === undefined ? DASH : String(label), value: typeof v === "number" ? v : 0 };
    });
    return { title: c.title, bars };
  });

  const tables = layout.tables.map((tb) => {
    const t = results[tb.request];
    const idxs = tb.columns.map((c) => colIndex(t, c.field));
    for (const c of tb.columns) {
      use(c.field);
      if (Object.hasOwn(catalog.dimensions, c.field)) noteUnreviewed(tb.request, c.field);
    }
    let rows = t?.rows ?? [];
    if (tb.sortBy) {
      const si = colIndex(t, tb.sortBy.field);
      if (si >= 0) rows = sortRows(rows, si, tb.sortBy.dir);
    }
    return {
      title: tb.title,
      header: tb.columns.map((c) => c.label),
      rows: rows.map((row) => tb.columns.map((c, k) => cell(idxs[k]! >= 0 ? (row[idxs[k]!] ?? null) : null, c.field, catalog))),
    };
  });

  const footnotes = used.map((m) => catalog.measures[m]!.meaning);
  if (unreviewed.size > 0) {
    const n = Math.max(...unreviewed.values());
    footnotes.push(`${n} jobs had a label not yet reviewed and are shown as "${UNREVIEWED}".`);
  }
  if (previous !== null) footnotes.push(`Compared with the run of ${previous.periodKey}.`);

  const stamp = DateTime.fromJSDate(queriedAt).setZone(ZONE).toFormat("yyyy-MM-dd HH:mm");
  const out: FilledDashboard = {
    title: layout.title,
    asOf: `Queried from Karbon's warehouse ${stamp} CT`,
    tiles,
    charts,
    tables,
    notes: [...layout.notes],
    footnotes,
  };
  if (layout.subtitle !== undefined) out.subtitle = layout.subtitle;
  return out;
}

export type FilledCheck =
  | { ok: true }
  | { ok: false; code: "pattern_match" | "client_name"; detail: string };

const NUMERIC = /^[+-]?[\d,]*\.?\d+(?:%| \([\d,]+%\))?$/;
const CHANGE = /^(?:[+-][\d,.]+%? since \d{4}-\d{2}-\d{2}|No change since \d{4}-\d{2}-\d{2}|No earlier run to compare)$/;
const nameCheckable = (s: string): boolean => !NUMERIC.test(s) && !CHANGE.test(s) && /[A-Za-z]/.test(s);

export async function checkFilled(
  f: FilledDashboard,
  exempt: Set<string>,
  deps: { names: NameChecker },
): Promise<FilledCheck> {
  const all: { path: string; text: string; names: boolean }[] = [];
  const add = (path: string, text: string, names = true): void => {
    all.push({ path, text, names: names && !exempt.has(text) && nameCheckable(text) });
  };
  add("title", f.title);
  if (f.subtitle !== undefined) add("subtitle", f.subtitle);
  add("asOf", f.asOf, false);
  f.tiles.forEach((t, i) => {
    add(`tiles[${i}].label`, t.label);
    add(`tiles[${i}].value`, t.value);
    if (t.change !== null) add(`tiles[${i}].change`, t.change);
  });
  f.charts.forEach((c, i) => {
    add(`charts[${i}].title`, c.title);
    c.bars.forEach((b, j) => add(`charts[${i}].bars[${j}].label`, b.label));
  });
  f.tables.forEach((t, i) => {
    add(`tables[${i}].title`, t.title);
    t.header.forEach((h, j) => add(`tables[${i}].header[${j}]`, h));
    t.rows.forEach((r, j) => r.forEach((c, k) => add(`tables[${i}].rows[${j}][${k}]`, c)));
  });
  f.notes.forEach((n, i) => add(`notes[${i}]`, n));
  f.footnotes.forEach((n, i) => add(`footnotes[${i}]`, n, false));

  for (const a of all)
    if (findPatterns(a.text, { urls: true }).length > 0) return { ok: false, code: "pattern_match", detail: a.path };

  const toCheck = all.filter((a) => a.names);
  if (toCheck.length > 0) {
    const counts = await deps.names.countMatches(toCheck.map((a) => a.text));
    if (!Array.isArray(counts) || counts.length !== toCheck.length)
      throw new Error("name check returned a malformed result");
    const hit = counts.findIndex((n) => n > 0);
    if (hit >= 0) return { ok: false, code: "client_name", detail: toCheck[hit]!.path };
  }
  return { ok: true };
}
