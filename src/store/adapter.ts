import { PGlite } from "@electric-sql/pglite";
import pg from "pg";

/** The only database surface the Store uses, so tests and synthetic mode run on in-memory PGlite with the same SQL. */
export interface Db {
  query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/** Fixed message for any failure on the real connection: driver errors can carry host names or credentials. */
export const STORE_UNAVAILABLE = "state store unavailable";

const fixed = (): Error => new Error(STORE_UNAVAILABLE);

/** pg Pool over DATABASE_URL (TLS comes from sslmode in the string). Errors never carry driver text. */
export function createPgDb(connectionString: string): Db {
  const pool = new pg.Pool({ connectionString, max: 5 });
  // An idle client dropping must not crash the process; the next query reports it.
  pool.on("error", () => {});

  const wrap = (c: { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }> }): Db => ({
    async query<T>(sql: string, params?: unknown[]) {
      try {
        const r = await c.query(sql, params);
        return { rows: r.rows as T[] };
      } catch {
        throw fixed();
      }
    },
    transaction: (fn) => fn(wrap(c)), // already inside a transaction (or a single client): no nesting
    close: async () => {},
  });

  return {
    query: wrap(pool).query,
    async transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
      let client: pg.PoolClient;
      try {
        client = await pool.connect();
      } catch {
        throw fixed();
      }
      try {
        const tx = wrap(client);
        await tx.query("BEGIN");
        try {
          const out = await fn(tx);
          await tx.query("COMMIT");
          return out;
        } catch (err) {
          try {
            await client.query("ROLLBACK");
          } catch {
            /* the original error is the one that matters */
          }
          throw err;
        }
      } finally {
        client.release();
      }
    },
    async close() {
      try {
        await pool.end();
      } catch {
        throw fixed();
      }
    },
  };
}

type PgliteLike = { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }> };

const wrapPglite = (c: PgliteLike, tx: (fn: (t: PgliteLike) => Promise<unknown>) => Promise<unknown>, close: () => Promise<void>): Db => ({
  async query<T>(sql: string, params?: unknown[]) {
    const r = await c.query(sql, params);
    return { rows: r.rows as T[] };
  },
  transaction: <T>(fn: (t: Db) => Promise<T>) =>
    tx((t) => fn(wrapPglite(t, (f) => f(t), async () => {}))) as Promise<T>,
  close,
});

/** In-memory Postgres (PGlite): no server needed. State is lost when the process ends. */
export async function createPgliteDb(): Promise<Db> {
  const lite = new PGlite();
  await lite.waitReady;
  return wrapPglite(
    lite as unknown as PgliteLike,
    (f) => lite.transaction((t) => f(t as unknown as PgliteLike)),
    () => lite.close(),
  );
}
