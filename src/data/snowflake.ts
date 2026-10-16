import snowflake from "snowflake-sdk";
import { NAME_CHECK_SQL, type NameChecker } from "../guard/names.js";
import type { BuiltQuery, DataSource, ResultTable } from "./types.js";

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
function snowflakeConnect(user: string, password: string): Connect {
  return () =>
    new Promise<Executor>((resolve, reject) => {
      const conn = snowflake.createConnection({
        account: "<snowflake-account>",
        username: user,
        password,
        warehouse: "READ_WH",
        role: "PUBLIC",
        database: "KPI_DATABASE",
        schema: "SECURE_VIEWS",
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
  const user = need(env, "KARBON_SF_USER");
  const password = need(env, "KARBON_SF_PASSWORD");
  const open = connect ?? snowflakeConnect(user, password);

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

  const guarded = async <T>(work: (e: Executor) => Promise<T>): Promise<T> => {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, rej) => {
      timer = setTimeout(() => rej(new WarehouseError("warehouse_error", "query timed out")), timeoutMs);
    });
    try {
      return await Promise.race([getConn().then(work), timeout]);
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
        return [...t.rows].sort((a, b) => Number(a[idx]) - Number(b[idx])).map((r) => Number(r[hits]));
      },
    },
    async close() {
      const old = conn;
      conn = undefined;
      if (old) await (await old).close();
    },
  };
}
