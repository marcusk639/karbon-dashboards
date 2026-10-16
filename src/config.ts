import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const configPath = (name: string): string =>
  fileURLToPath(new URL(`../config/${name}`, import.meta.url));

const FormatSchema = z.enum(["int", "pct", "hours"]);
const LabelKindSchema = z.enum(["primary_status", "stage", "work_type"]);

const CatalogSchema = z.object({
  source: z.string().min(1),
  cohorts: z.record(z.string(), z.object({ where: z.string().min(1), meaning: z.string().min(1) })),
  measures: z.record(
    z.string(),
    z.object({ expr: z.string().min(1), meaning: z.string().min(1), format: FormatSchema }),
  ),
  dimensions: z.record(
    z.string(),
    z.object({
      expr: z.string().min(1),
      labels: LabelKindSchema,
      minGroup: z.number().int().positive().nullable(),
      meaning: z.string().min(1),
    }),
  ),
  filters: z.object({ due_between: z.object({ column: z.literal("DUE_DATETIME") }) }),
});

const LabelOutcomeSchema = z
  .object({
    outcome: z.enum(["approve", "alias", "other"]),
    alias: z.string().min(1).optional(),
    date: z.string().min(1),
    reviewer: z.string().min(1),
  })
  .refine((o) => o.outcome !== "alias" || o.alias !== undefined, {
    message: "alias outcome requires an alias string",
    path: ["alias"],
  });

const LabelsSchema = z.object({
  primary_status: z.record(z.string(), LabelOutcomeSchema),
  stage: z.record(z.string(), LabelOutcomeSchema),
  work_type: z.record(z.string(), LabelOutcomeSchema),
});

export type Format = z.infer<typeof FormatSchema>;
export type Catalog = z.infer<typeof CatalogSchema>;
export type LabelOutcome = {
  outcome: "approve" | "alias" | "other";
  alias?: string;
  date: string;
  reviewer: string;
};
export type Labels = Record<"primary_status" | "stage" | "work_type", Record<string, LabelOutcome>>;

const readJson = (path: string): unknown => JSON.parse(readFileSync(path, "utf8"));

export function parseCatalog(raw: unknown): Catalog {
  return CatalogSchema.parse(raw);
}

export function parseLabels(raw: unknown): Labels {
  return LabelsSchema.parse(raw) as Labels;
}

export function loadCatalog(path: string = configPath("catalog.json")): Catalog {
  return parseCatalog(readJson(path));
}

export function loadLabels(path: string = configPath("labels.json")): Labels {
  return parseLabels(readJson(path));
}

export function loadGenericWords(path: string = configPath("generic-words.json")): string[] {
  return z.array(z.string()).parse(readJson(path)).map((w) => w.toLowerCase());
}
