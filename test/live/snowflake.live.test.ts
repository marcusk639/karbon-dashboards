// Runs only with LIVE=1 (excluded in vitest.config.ts). Needs KARBON_SF_USER / KARBON_SF_PASSWORD,
// e.g. `LIVE=1 scripts/dev-env.sh npx vitest run test/live`.
import { afterAll, expect, test } from "vitest";
import { loadCatalog, loadGenericWords, loadLabels } from "../../src/config.js";
import { createSnowflakeSource } from "../../src/data/snowflake.js";
import { runMenuRequest } from "../../src/guard/run.js";
import { createLogger } from "../../src/log.js";
import { OPEN_WORK_REQUESTS } from "../../src/requests/open-work.js";

const generic = loadGenericWords();
const src = createSnowflakeSource(process.env, generic);
afterAll(() => src.close());

test("name check returns one number per text; a nonsense token has no hits", async () => {
  const counts = await src.names.countMatches(["Ready To Start", "zzqx"]);
  expect(counts).toHaveLength(2);
  expect(counts.every((n) => typeof n === "number")).toBe(true);
  expect(counts[1]).toBe(0);
});

test("open-work totals pass the guard and return one row", async () => {
  const res = await runMenuRequest(OPEN_WORK_REQUESTS.totals, {
    catalog: loadCatalog(),
    labels: loadLabels(),
    generic,
    data: src.data,
    names: src.names,
    now: () => new Date(),
    log: createLogger(() => {}),
  });
  expect(res.status).toBe("ok");
  if (res.status === "ok") expect(res.table.rows).toHaveLength(1);
});
