import snowflake from "snowflake-sdk";
import { NAME_CHECK_SQL, assertCounts, type NameChecker } from "../guard/names.js";
import type { BuiltQuery, DataSource, ResultTable } from "./types.js";

// The SDK's default logger writes ./snowflake.log and the console at INFO, including the username and
// connection details. Turn all of it off, and route anything that still gets through to a no-op.
const noop = (): void => {};
snowflake.configure({
  logLevel: "OFF",
  additionalLogToConsole: false,
  customLogger: { error: noop, warn: noop, info: noop, debug: noop, trace: noop },
});

export type Executor = {
  exec(sql: string, binds: (string | number)[]): Promise<ResultTable>;
  close(): Promise<void>;
};
export type Connect = () => Promise<Executor>;

export class WarehouseError extends Error {
  constructor(
    readonly code: "warehouse_login" | "warehouse_error",
    message: string,
  ) {
    super(message);
    this.name = "WarehouseError";
  }
}

const need = (env: NodeJS.ProcessEnv, name: string): string => {
  const v = env[name];
  if (v === undefined || v === "") throw new Error(`Missing environment variable ${name}`);
  return v;
};

/** The real connection (Global Constraints). Messages from the SDK are never propagated. */
function snowflakeConnect(account: string, user: string, password: string): Connect {
  return () =>
    new Promise<Executor>((resolve, reject) => {
      const conn = snowflake.createConnection({
        account,
        username: user,
        password,
        warehouse: "READ_WH",
        role: "PUBLIC",
        database: "KPI_DATABASE",
        schema: "SECURE_VIEWS",
        // Heartbeat the session so it is not expired between weekly runs; the retry in guarded() is the backstop.
        clientSessionKeepAlive: true,
      });
      conn.connect((err) => {
        if (err) return reject(new WarehouseError("warehouse_login", "login refused"));
        resolve({
          exec: (sql, binds) =>
            new Promise<ResultTable>((res, rej) => {
              conn.execute({
                sqlText: sql,
                binds,
                rowMode: "array",
                complete: (e, stmt, rows) => {
                  if (e || !stmt) return rej(new WarehouseError("warehouse_error", "query failed"));
                  const cols = stmt.getColumns();
                  if (!cols) return rej(new WarehouseError("warehouse_error", "query failed"));
                  const columns = cols.map((c) => c.getName());
                  res({ columns, rows: (rows ?? []) as ResultTable["rows"] });
                },
              });
            }),
          close: () => new Promise<void>((res) => conn.destroy(() => res())),
        });
      });
    });
}

export function createSnowflakeSource(
  env: NodeJS.ProcessEnv,
  generic: string[],
  timeoutMs = 120_000,
  connect?: Connect,
): { data: DataSource; names: NameChecker; close(): Promise<void> } {
  const account = need(env, "KARBON_SF_ACCOUNT");
  const user = need(env, "KARBON_SF_USER");
  const password = need(env, "KARBON_SF_PASSWORD");
  const open = connect ?? snowflakeConnect(account, user, password);

  let conn: Promise<Executor> | undefined;
  // Any connect-time failure that is not already classified is a login failure.
  const getConn = (): Promise<Executor> =>
    (conn ??= open().catch((err) => {
      throw err instanceof WarehouseError ? err : new WarehouseError("warehouse_login", "login refused");
    }));
  const reset = (): void => {
    const old = conn;
    conn = undefined;
    old?.then((e) => e.close()).catch(() => {});
  };

  // One attempt on the current (possibly reused) connection. Snowflake sessions expire after hours idle,
  // so the first query of the week can meet a terminated session: on any non-login failure the connection
  // is dropped and the work retried ONCE on a fresh one, inside the same timeout budget. A login failure
  // is never retried (repeated bad logins can lock the account).
  const attempt = async <T>(work: (e: Executor) => Promise<T>): Promise<T> => {
    try {
      return await work(await getConn());
    } catch (err) {
      reset();
      throw err instanceof WarehouseError ? err : new WarehouseError("warehouse_error", "query failed");
    }
  };
  const withRetry = async <T>(work: (e: Executor) => Promise<T>): Promise<T> => {
    try {
      return await attempt(work);
    } catch (err) {
      if (err instanceof WarehouseError && err.code === "warehouse_login") throw err;
      return attempt(work);
    }
  };

  const guarded = async <T>(work: (e: Executor) => Promise<T>): Promise<T> => {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, rej) => {
      timer = setTimeout(() => rej(new WarehouseError("warehouse_error", "query timed out")), timeoutMs);
    });
    try {
      return await Promise.race([withRetry(work), timeout]);
    } catch (err) {
      reset();
      throw err instanceof WarehouseError ? err : new WarehouseError("warehouse_error", "query failed");
    } finally {
      clearTimeout(timer);
    }
  };

  return {
    data: { run: (q: BuiltQuery) => guarded((e) => e.exec(q.sql, q.binds)) },
    names: {
      async countMatches(texts: string[]): Promise<number[]> {
        if (texts.length === 0) return [];
        const t = await guarded((e) => e.exec(NAME_CHECK_SQL, [JSON.stringify(texts), JSON.stringify(generic)]));
        const idx = t.columns.indexOf("IDX");
        const hits = t.columns.indexOf("HITS");
        if (idx < 0 || hits < 0) throw new WarehouseError("warehouse_error", "name check failed");
        // Every input must come back exactly once as IDX 0..n-1 with a finite non-negative HITS.
        const out: number[] = new Array<number>(texts.length);
        const seen = new Set<number>();
        for (const r of t.rows) {
          const i = Number(r[idx]);
          if (!Number.isInteger(i) || i < 0 || i >= texts.length || seen.has(i))
            throw new WarehouseError("warehouse_error", "name check failed");
          seen.add(i);
          out[i] = r[hits] === null || r[hits] === "" ? NaN : Number(r[hits]);
        }
        try {
          if (seen.size !== texts.length) throw new Error("missing index");
          assertCounts(out, texts.length);
        } catch {
          throw new WarehouseError("warehouse_error", "name check failed");
        }
        return out;
      },
    },
    async close() {
      const old = conn;
      conn = undefined;
      if (!old) return;
      // A connection that never opened (failed or still-failing login) has nothing to close.
      const e = await old.catch(() => undefined);
      await e?.close().catch(() => {});
    },
  };
}
