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

/**
 * Masked errors leave one fixed stderr line carrying only a SQLSTATE (exactly 5 of [0-9A-Z]), never driver text,
 * so an outage is diagnosable without leaking hosts or credentials.
 */
const SQLSTATE = /^[0-9A-Z]{5}$/;
function noteError(err: unknown): void {
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === "string" && SQLSTATE.test(code)) console.error(`state store error: sqlstate ${code}`);
}

type QueryResult = { rows: unknown[] };
type ClientLike = {
  query(sql: string, params?: unknown[]): Promise<QueryResult>;
  release(destroy?: boolean | Error): void;
  on(event: "error", fn: (err: Error) => void): unknown;
  removeListener(event: "error", fn: (err: Error) => void): unknown;
};
type PoolLike = {
  query(sql: string, params?: unknown[]): Promise<QueryResult>;
  connect(): Promise<ClientLike>;
  end(): Promise<void>;
  on(event: "error", fn: (err: Error) => void): unknown;
};

/**
 * Pool settings for DATABASE_URL. With `ca` (a PEM root, e.g. a private Postgres with a self-signed CA) TLS verifies
 * the chain against it and, by Node's default, the hostname. Any ssl* parameter in the URL (sslmode, ssl, sslrootcert, ...) would replace this `ssl` object
 * (pg lets URL parameters win), silently dropping the CA, so that combination is refused.
 */
export function pgPoolConfig(connectionString: string, ca?: string): pg.PoolConfig {
  if (ca === undefined) return { connectionString, max: 5 };
  if (/[?&]ssl[a-z]*=/i.test(connectionString))
    throw new Error("DATABASE_URL must not set sslmode or other ssl parameters when DATABASE_CA_CERT is set");
  return { connectionString, max: 5, ssl: { ca, rejectUnauthorized: true } };
}

/** pg Pool over DATABASE_URL (TLS from sslmode in the string, or from `ca`, see pgPoolConfig). Errors never carry driver text. `pool` is a test seam. */
export function createPgDb(
  connectionString: string,
  ca?: string,
  pool: PoolLike = new pg.Pool(pgPoolConfig(connectionString, ca)) as unknown as PoolLike,
): Db {
  // An idle client dropping must not crash the process; the next query reports it.
  pool.on("error", () => {});

  const wrap = (c: { query: (sql: string, params?: unknown[]) => Promise<QueryResult> }): Db => ({
    async query<T>(sql: string, params?: unknown[]) {
      try {
        const r = await c.query(sql, params);
        return { rows: r.rows as T[] };
      } catch (err) {
        noteError(err);
        throw fixed();
      }
    },
    transaction: (fn) => fn(wrap(c)), // already inside a transaction (or a single client): no nesting
    close: async () => {},
  });

  return {
    query: wrap(pool).query,
    async transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
      let client: ClientLike;
      try {
        client = await pool.connect();
      } catch (err) {
        noteError(err);
        throw fixed();
      }
      // pg-pool drops its own error listener on checkout: without this a connection drop mid-transaction is an
      // unhandled 'error' event that crashes the process with raw driver text.
      let broken = false;
      const onError = (err: Error): void => {
        broken = true;
        noteError(err);
      };
      client.on("error", onError);
      try {
        const tx = wrap(client);
        await tx.query("BEGIN");
        try {
          const out = await fn(tx);
          if (broken) throw fixed();
          await tx.query("COMMIT");
          return out;
        } catch (err) {
          try {
            await client.query("ROLLBACK");
          } catch {
            broken = true; // never hand a client in an unknown state back to the pool
          }
          throw broken ? fixed() : err;
        }
      } finally {
        client.removeListener("error", onError);
        client.release(broken);
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
