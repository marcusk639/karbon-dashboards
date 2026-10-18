import { expect, test } from "vitest";
import { createSnowflakeSource, type Executor } from "../../src/data/snowflake.js";
import { NAME_CHECK_SQL } from "../../src/guard/names.js";
import type { BuiltQuery } from "../../src/data/types.js";

const ENV = { KARBON_SF_ACCOUNT: "acct", KARBON_SF_USER: "u", KARBON_SF_PASSWORD: "p" };
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
  const { KARBON_SF_ACCOUNT: _a, ...noAccount } = ENV;
  const { KARBON_SF_USER: _u, ...noUser } = ENV;
  const { KARBON_SF_PASSWORD: _p, ...noPassword } = ENV;
  expect(() => createSnowflakeSource(noAccount, [])).toThrow(/KARBON_SF_ACCOUNT/);
  expect(() => createSnowflakeSource(noUser, [])).toThrow(/KARBON_SF_USER/);
  expect(() => createSnowflakeSource(noPassword, [])).toThrow(/KARBON_SF_PASSWORD/);
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

// C1: a reused connection whose session has expired must not fail every later run.
const disconnected = (): Error =>
  Object.assign(new Error("Unable to perform operation because a connection was never established or has been terminated."), {
    code: 407002,
  });

test("a stale connection is replaced and the request retried once on a fresh one", async () => {
  let opened = 0;
  let closed = 0;
  const src = createSnowflakeSource(ENV, [], 1000, async () => {
    const n = ++opened;
    return {
      exec: async () => {
        if (n === 1) throw disconnected();
        return { columns: ["a"], rows: [[1]] };
      },
      close: async () => void closed++,
    };
  });
  expect(await src.data.run(Q, { measures: ["jobs"] })).toEqual({ columns: ["a"], rows: [[1]] });
  expect(opened).toBe(2);
  expect(closed).toBe(1);
});

test("two consecutive failures end as warehouse_error with no SDK text", async () => {
  let opened = 0;
  const src = createSnowflakeSource(ENV, [], 1000, async () => {
    opened++;
    return { exec: async () => { throw disconnected(); }, close: async () => {} };
  });
  const err = await src.data.run(Q, { measures: ["jobs"] }).catch((e) => e);
  expect(err.code).toBe("warehouse_error");
  expect(err.message).not.toMatch(/terminated/);
  expect(opened).toBe(2);
});

test("a login failure is not retried", async () => {
  let opened = 0;
  const src = createSnowflakeSource(ENV, [], 1000, async () => {
    opened++;
    throw new Error("Incorrect username or password");
  });
  const err = await src.data.run(Q, { measures: ["jobs"] }).catch((e) => e);
  expect(err.code).toBe("warehouse_login");
  expect(opened).toBe(1);
});

test("a hung reconnect is bounded by the same timeout budget", async () => {
  let opened = 0;
  const src = createSnowflakeSource(ENV, [], 30, async () => {
    if (++opened === 1) return { exec: async () => { throw disconnected(); }, close: async () => {} };
    return new Promise<never>(() => {});
  });
  const started = Date.now();
  const err = await src.data.run(Q, { measures: ["jobs"] }).catch((e) => e);
  expect(err.code).toBe("warehouse_error");
  expect(Date.now() - started).toBeLessThan(500);
  expect(opened).toBe(2);
});

test("a hung first connect is bounded by the timeout", async () => {
  const src = createSnowflakeSource(ENV, [], 20, () => new Promise<never>(() => {}));
  const err = await src.data.run(Q, { measures: ["jobs"] }).catch((e) => e);
  expect(err.code).toBe("warehouse_error");
});

test("close() after a failed login does not throw", async () => {
  const src = createSnowflakeSource(ENV, [], 1000, async () => {
    throw new Error("login refused");
  });
  await src.data.run(Q, { measures: ["jobs"] }).catch(() => {});
  await expect(src.close()).resolves.toBeUndefined();
});

test("close() while a login is still failing does not throw", async () => {
  let rejectOpen: (e: Error) => void = () => {};
  const src = createSnowflakeSource(ENV, [], 1000, () => new Promise<Executor>((_, rej) => (rejectOpen = rej)));
  const pending = src.data.run(Q, { measures: ["jobs"] }).catch(() => {});
  const closing = src.close();
  rejectOpen(new Error("login refused"));
  await expect(closing).resolves.toBeUndefined();
  await pending;
});

// I2: the warehouse result must index every input exactly once, 0..n-1, with finite non-negative counts.
test.each([
  ["a missing index", [[0, 0]]],
  ["a duplicated index", [[0, 0], [0, 0]]],
  ["an out-of-range index", [[0, 0], [2, 0]]],
  ["a non-numeric count", [[0, 0], [1, "x"]]],
  ["a negative count", [[0, 0], [1, -1]]],
])("names.countMatches fails closed on %s", async (_label, rows) => {
  const src = createSnowflakeSource(ENV, [], 1000, fake(async () => ({ columns: ["IDX", "HITS"], rows: rows as (string | number)[][] })));
  const err = await src.names.countMatches(["a", "b"]).catch((e) => e);
  expect(err).toBeInstanceOf(Error);
  expect(err.code).toBe("warehouse_error");
});
