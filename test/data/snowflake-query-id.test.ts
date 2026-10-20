import { expect, test, vi } from "vitest";

// A fake SDK connection whose statement reports a query id, so the real snowflakeConnect path is exercised.
const execute = vi.fn((o: { complete: (e: unknown, stmt: unknown, rows: unknown[]) => void }) =>
  o.complete(undefined, { getColumns: () => [{ getName: () => "jobs" }], getQueryId: () => "01b2-query" }, [[3]]),
);
const conn = { connect: (cb: (e?: unknown) => void) => cb(), execute, destroy: (cb: () => void) => cb() };
vi.mock("snowflake-sdk", () => ({ default: { configure: vi.fn(), createConnection: vi.fn(() => conn) } }));

test("a Snowflake result carries the statement's query id", async () => {
  const { createSnowflakeSource } = await import("../../src/data/snowflake.js");
  const src = createSnowflakeSource({ KARBON_SF_ACCOUNT: "acct", KARBON_SF_USER: "u", KARBON_SF_PASSWORD: "p" }, []);
  const t = await src.data.run({ sql: "SELECT 1", binds: [], columns: ["jobs"], exemptStrings: new Set() }, { measures: ["jobs"] });
  expect(t).toEqual({ columns: ["jobs"], rows: [[3]], queryId: "01b2-query" });
  await src.close();
});
