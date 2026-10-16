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

/** One measure for a row whose job count is `jobs`; subsets of jobs are bounded fractions of it. */
function measure(name: string, rand: () => number, jobs: number): number {
  switch (name) {
    case "jobs": return jobs;
    case "past_due": return Math.floor(jobs * 0.3 * rand());
    case "stuck_over_30d": return Math.floor(jobs * 0.4 * rand());
    case "budgeted_jobs": return Math.floor(jobs * (0.4 + 0.6 * rand()));
    case "median_days_in_stage": return int(rand, 1, 45);
    case "median_age_days": return int(rand, 10, 200);
    case "budget_hrs": return int(rand, 100, 40000) / 10;
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
      const rows = combos(dims).map((labels) => {
        const jobs = int(rand, 20, 400); // generated first, whether or not it is requested
        return [...labels, ...measures.map((m) => measure(m, rand, jobs))];
      });
      return { columns: [...q.columns], rows };
    },
  };
  return { data, names: new FixtureNameChecker(MADE_UP_CLIENTS, GENERIC) };
}
