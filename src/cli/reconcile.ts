import { loadCatalog, loadGenericWords, loadLabels } from "../config.js";
import { createSnowflakeSource } from "../data/snowflake.js";
import type { ResultTable } from "../data/types.js";
import { runMenuRequest } from "../guard/run.js";
import { createLogger } from "../log.js";
import { OPEN_WORK_REQUESTS } from "../requests/open-work.js";

function plain(t: ResultTable): string {
  const cell = (v: string | number | null): string => (v === null ? "" : String(v));
  const all = [t.columns, ...t.rows.map((r) => r.map(cell))];
  const w = t.columns.map((_, i) => Math.max(...all.map((r) => (r[i] ?? "").length)));
  return all.map((r) => r.map((c, i) => c.padEnd(w[i]!)).join("  ").trimEnd()).join("\n");
}

async function main(): Promise<number> {
  const generic = loadGenericWords();
  const src = createSnowflakeSource(process.env, generic);
  const deps = {
    catalog: loadCatalog(),
    labels: loadLabels(),
    generic,
    data: src.data,
    names: src.names,
    now: () => new Date(),
    log: createLogger(() => {}),
  };
  let code = 0;
  try {
    for (const [name, req] of Object.entries(OPEN_WORK_REQUESTS)) {
      const res = await runMenuRequest(req, deps);
      console.log(`\n== ${name} ==`);
      if (res.status === "ok") {
        console.log(`(queried ${res.queriedAt})`);
        console.log(plain(res.table));
      } else {
        console.log(`REJECTED: ${res.code}`);
        code = 1;
      }
    }
  } finally {
    await src.close();
  }
  return code;
}

main().then(
  (c) => process.exit(c),
  (e: unknown) => {
    console.error(e instanceof Error ? e.message : "reconcile failed");
    process.exit(1);
  },
);
