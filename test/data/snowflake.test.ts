import { expect, test } from "vitest";
import { createSnowflakeSource, type Executor } from "../../src/data/snowflake.js";
import { NAME_CHECK_SQL } from "../../src/guard/names.js";
import type { BuiltQuery } from "../../src/data/types.js";

const ENV = { KARBON_SF_USER: "u", KARBON_SF_PASSWORD: "p" };
const Q: BuiltQuery = { sql: "SELECT 1", binds: ["x"], columns: ["a", "b"], exemptStrings: new Set() };

const fake = (impl: Executor["exec"], onClose = async () => {}): (() => Promise<Executor>) => async () => ({
  exec: impl,
  close: onClose,
});

test("run maps rows to a ResultTable in column order", async () => {
  const src = createSnowflakeSource(ENV, [], 1000, fake(async () => ({ columns: ["a", "b"], rows: [[1, "x"], [2, null]] })));
  expect(await src.data.run(Q, { measures: ["jobs"] })).toEqual({ columns: ["a", "b"], rows: [[1, "x"], [2, null]] });
});

test("names.countMatches binds [texts, generic] and returns HITS as numbers in IDX order", async () => {
  let seen: { sql: string; binds: (string | number)[] } | undefined;
  const src = createSnowflakeSource(
    ENV,
    ["the"],
    1000,
    fake(async (sql, binds) => {
      seen = { sql, binds };
      return { columns: ["IDX", "HITS"], rows: [[1, "0"], [0, 2]] };
    }),
  );
  expect(await src.names.countMatches(["a", "b"])).toEqual([2, 0]);
  expect(seen).toEqual({ sql: NAME_CHECK_SQL, binds: [JSON.stringify(["a", "b"]), JSON.stringify(["the"])] });
});

test("names.countMatches with no texts does not query", async () => {
  let calls = 0;
  const src = createSnowflakeSource(ENV, [], 1000, fake(async () => (calls++, { columns: [], rows: [] })));
  expect(await src.names.countMatches([])).toEqual([]);
  expect(calls).toBe(0);
});

test("a hung query times out with code warehouse_error and no SQL or binds in the message", async () => {
  const src = createSnowflakeSource(ENV, [], 20, fake(() => new Promise(() => {})));
  const err = await src.data.run(Q, { measures: ["jobs"] }).catch((e) => e);
  expect(err.code).toBe("warehouse_error");
  expect(err.message).not.toMatch(/SELECT|"x"/);
  const err2 = await src.names.countMatches(["secret-cell"]).catch((e) => e);
  expect(err2.code).toBe("warehouse_error");
  expect(err2.message).not.toContain("secret-cell");
});

test("login failure maps to warehouse_login; other failures to warehouse_error", async () => {
  const login = createSnowflakeSource(ENV, [], 1000, async () => {
    throw Object.assign(new Error("Incorrect username or password was specified. pw=hunter2"), { code: "390100" });
  });
  const e1 = await login.data.run(Q, { measures: ["jobs"] }).catch((e) => e);
  expect(e1.code).toBe("warehouse_login");
  expect(e1.message).not.toContain("hunter2");

  const other = createSnowflakeSource(ENV, [], 1000, fake(async () => { throw new Error("syntax error near 'x'"); }));
  const e2 = await other.data.run(Q, { measures: ["jobs"] }).catch((e) => e);
  expect(e2.code).toBe("warehouse_error");
  expect(e2.message).not.toContain("syntax");
});

test("missing env vars throw naming the variable, not a value", () => {
  expect(() => createSnowflakeSource({ KARBON_SF_PASSWORD: "p" }, [])).toThrow(/KARBON_SF_USER/);
  expect(() => createSnowflakeSource({ KARBON_SF_USER: "u" }, [])).toThrow(/KARBON_SF_PASSWORD/);
});

test("close closes the connection once opened, and is a no-op before", async () => {
  let closed = 0;
  const src = createSnowflakeSource(ENV, [], 1000, fake(async () => ({ columns: ["a"], rows: [] }), async () => void closed++));
  await src.close();
  expect(closed).toBe(0);
  await src.data.run(Q, { measures: ["jobs"] });
  await src.close();
  expect(closed).toBe(1);
});
