import { z } from "zod";
import type { Catalog } from "../config.js";
import type { MenuRequest } from "../data/types.js";
import { assertCounts, type NameChecker } from "../guard/names.js";
import { findPatterns } from "../guard/patterns.js";
import { RequestError, validateRequest } from "../query/build.js";

const Text = z.string().min(1).max(200);

const LayoutSchema = z
  .object({
    title: Text,
    subtitle: Text.optional(),
    tiles: z.array(
      z
        .object({
          label: Text,
          request: Text,
          measure: Text,
          shareOf: Text.optional(),
          showChange: z.boolean(),
        })
        .strict(),
    ),
    charts: z.array(
      z.object({ title: Text, request: Text, dimension: Text, measure: Text }).strict(),
    ),
    tables: z.array(
      z
        .object({
          title: Text,
          request: Text,
          columns: z.array(z.object({ field: Text, label: Text }).strict()).min(1),
          sortBy: z.object({ field: Text, dir: z.enum(["asc", "desc"]) }).strict().optional(),
        })
        .strict(),
    ),
    notes: z.array(Text),
  })
  .strict();

export type Layout = z.infer<typeof LayoutSchema>;

export type LayoutResult =
  | { ok: true; layout: Layout }
  | { ok: false; code: "invalid_layout" | "pattern_match" | "client_name"; detail: string };

export type LayoutDeps = { names: NameChecker; catalog: Catalog };

const invalid = (detail: string): LayoutResult => ({ ok: false, code: "invalid_layout", detail });

const pathOf = (p: (string | number)[]): string =>
  p.reduce<string>((acc, k) => (typeof k === "number" ? `${acc}[${k}]` : acc ? `${acc}.${k}` : k), "");

/** Claude-authored strings with their field paths (never echoed back as text). */
function authoredText(l: Layout): { path: string; text: string }[] {
  const out: { path: string; text: string }[] = [{ path: "title", text: l.title }];
  if (l.subtitle !== undefined) out.push({ path: "subtitle", text: l.subtitle });
  l.tiles.forEach((t, i) => out.push({ path: `tiles[${i}].label`, text: t.label }));
  l.charts.forEach((c, i) => out.push({ path: `charts[${i}].title`, text: c.title }));
  l.tables.forEach((t, i) => {
    out.push({ path: `tables[${i}].title`, text: t.title });
    t.columns.forEach((c, j) => out.push({ path: `tables[${i}].columns[${j}].label`, text: c.label }));
  });
  l.notes.forEach((n, i) => out.push({ path: `notes[${i}]`, text: n }));
  return out;
}

export async function checkLayout(
  raw: unknown,
  requests: Record<string, MenuRequest>,
  deps: LayoutDeps,
): Promise<LayoutResult> {
  const parsed = LayoutSchema.safeParse(raw);
  if (!parsed.success) return invalid(pathOf(parsed.error.issues[0]?.path as (string | number)[] ?? []) || "layout");
  const layout = parsed.data;

  const valid = new Map<string, MenuRequest>();
  const lookup = (name: string): MenuRequest | null => {
    const cached = valid.get(name);
    if (cached) return cached;
    if (!Object.hasOwn(requests, name)) return null;
    try {
      const r = validateRequest(requests[name], deps.catalog);
      valid.set(name, r);
      return r;
    } catch (err) {
      if (err instanceof RequestError) return null;
      throw err;
    }
  };
  const inMeasures = (r: MenuRequest, f: string): boolean => r.measures.includes(f);
  const inDims = (r: MenuRequest, f: string): boolean => (r.dimensions ?? []).includes(f);

  for (const [i, t] of layout.tiles.entries()) {
    const r = lookup(t.request);
    if (!r) return invalid(`tiles[${i}].request`);
    if (!inMeasures(r, t.measure)) return invalid(`tiles[${i}].measure`);
    if (t.shareOf !== undefined && !inMeasures(r, t.shareOf)) return invalid(`tiles[${i}].shareOf`);
  }
  for (const [i, c] of layout.charts.entries()) {
    const r = lookup(c.request);
    if (!r) return invalid(`charts[${i}].request`);
    if (!inDims(r, c.dimension)) return invalid(`charts[${i}].dimension`);
    if (!inMeasures(r, c.measure)) return invalid(`charts[${i}].measure`);
  }
  for (const [i, t] of layout.tables.entries()) {
    const r = lookup(t.request);
    if (!r) return invalid(`tables[${i}].request`);
    for (const [j, c] of t.columns.entries())
      if (!inMeasures(r, c.field) && !inDims(r, c.field)) return invalid(`tables[${i}].columns[${j}].field`);
    if (t.sortBy && !inMeasures(r, t.sortBy.field) && !inDims(r, t.sortBy.field))
      return invalid(`tables[${i}].sortBy.field`);
  }

  const texts = authoredText(layout);
  for (const t of texts)
    if (findPatterns(t.text, { urls: true }).length > 0)
      return { ok: false, code: "pattern_match", detail: t.path };

  const counts = await deps.names.countMatches(texts.map((t) => t.text));
  // Fail closed: NaN, negatives, fractions or a wrong length throw (callers turn that into a refusal).
  assertCounts(counts, texts.length);
  const hit = counts.findIndex((n) => n > 0);
  if (hit >= 0) return { ok: false, code: "client_name", detail: texts[hit]!.path };

  return { ok: true, layout };
}
