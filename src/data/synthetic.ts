import { FixtureNameChecker, type NameChecker } from "../guard/names.js";
import type { BuiltQuery, DataSource, MenuRequest, ResultTable } from "./types.js";

const LABELS: Record<string, string[]> = {
  primary_status: ["Ready To Start", "In Progress", "Waiting"],
  stage: ["Preparing", "Review", "(no stage recorded)"],
  work_type: ["Individual Return", "Bookkeeping"],
};

// Made-up names; share no words with the synthetic labels above.
const MADE_UP_CLIENTS = ["Zara Quillfeather", "Bexley Thornwick", "Orlo Pemberton Holdings"];
const GENERIC = ["holdings"];

/** Small seeded PRNG (mulberry32): deterministic, no dependency. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const int = (rand: () => number, lo: number, hi: number): number => lo + Math.floor(rand() * (hi - lo + 1));

function measure(name: string, rand: () => number): number {
  switch (name) {
    case "jobs": return int(rand, 20, 400);
    case "past_due": return int(rand, 0, 60);
    case "stuck_over_30d": return int(rand, 0, 80);
    case "median_days_in_stage": return int(rand, 1, 45);
    case "median_age_days": return int(rand, 10, 200);
    case "budget_hrs": return int(rand, 100, 40000) / 10;
    case "budgeted_jobs": return int(rand, 0, 300);
    default: return int(rand, 0, 100);
  }
}

/** Cartesian product of the requested dimensions' made-up labels, in request order. */
function combos(dims: string[]): string[][] {
  return dims.reduce<string[][]>(
    (acc, d) => acc.flatMap((prefix) => (LABELS[d] ?? ["Other"]).map((l) => [...prefix, l])),
    [[]],
  );
}

export function createSyntheticSource(seed = 1): { data: DataSource; names: NameChecker } {
  const data: DataSource = {
    async run(q: BuiltQuery, req: MenuRequest): Promise<ResultTable> {
      const rand = prng(seed);
      const dims = req.dimensions ?? [];
      const measures = q.columns.slice(dims.length);
      const rows = combos(dims).map((labels) => [...labels, ...measures.map((m) => measure(m, rand))]);
      return { columns: [...q.columns], rows };
    },
  };
  return { data, names: new FixtureNameChecker(MADE_UP_CLIENTS, GENERIC) };
}
