import { EventEmitter } from "node:events";
import { expect, test, vi } from "vitest";
import { createPgDb } from "../../src/store/adapter.js";

// Nothing listens on port 1, so this never reaches a real database.
test("a connection failure surfaces a fixed message that carries no part of the URL", async () => {
  const db = createPgDb("postgresql://svc_user:s3cret-pw@127.0.0.1:1/statedb?sslmode=require");
  const errs: Error[] = [];
  await db.query("SELECT 1").catch((e: Error) => errs.push(e));
  await db.transaction(async () => 1).catch((e: Error) => errs.push(e));
  await db.close().catch(() => {});
  expect(errs).toHaveLength(2);
  for (const e of errs) {
    expect(e.message).toBe("state store unavailable");
    expect(`${e.message}${e.stack}${JSON.stringify(e)}`).not.toMatch(/svc_user|s3cret-pw|127\.0\.0\.1|statedb/);
  }
});

function fakePool(opts: { rollbackFails?: boolean } = {}) {
  const client = Object.assign(new EventEmitter(), {
    query: vi.fn(async (sql: string) => {
      if (sql === "ROLLBACK" && opts.rollbackFails) throw new Error("socket closed host=db.example.invalid");
      return { rows: [] };
    }),
    release: vi.fn(),
  });
  const pool = Object.assign(new EventEmitter(), {
    query: vi.fn(async () => ({ rows: [] })),
    connect: vi.fn(async () => client),
    end: vi.fn(async () => {}),
  });
  return { pool, client };
}

test("a connection error mid-transaction is not unhandled, rejects with the fixed message, and destroys the client", async () => {
  const { pool, client } = fakePool();
  const db = createPgDb("postgresql://user:password@host/db?sslmode=require", pool as never);
  const err = await db
    .transaction(async () => {
      client.emit("error", Object.assign(new Error("read ECONNRESET db.example.invalid"), { code: "ECONNRESET" })); // would throw if unlistened
      await Promise.resolve();
      return 1;
    })
    .catch((e: Error) => e);
  expect((err as Error).message).toBe("state store unavailable");
  expect(client.release).toHaveBeenCalledTimes(1);
  expect(client.release.mock.calls[0]![0]).toBeTruthy();
  expect(client.listenerCount("error")).toBe(0); // the temporary listener is removed
});

test("a failed ROLLBACK destroys the client; a clean rollback returns it to the pool", async () => {
  const bad = fakePool({ rollbackFails: true });
  await createPgDb("x", bad.pool as never).transaction(async () => { throw new Error("boom"); }).catch(() => {});
  expect(bad.client.release.mock.calls[0]![0]).toBeTruthy();
  const ok = fakePool();
  const e = await createPgDb("x", ok.pool as never).transaction(async () => { throw new Error("boom"); }).catch((x: Error) => x);
  expect((e as Error).message).toBe("boom");
  expect(ok.client.release.mock.calls[0]![0]).toBeFalsy();
});

test("a masked error logs only a SQLSTATE, never the message", async () => {
  const { pool } = fakePool();
  pool.query.mockRejectedValueOnce(Object.assign(new Error("duplicate key value (secret-key)"), { code: "23505" }));
  pool.query.mockRejectedValueOnce(Object.assign(new Error("getaddrinfo db.example.invalid"), { code: "ENOTFOUND" }));
  const spy = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const db = createPgDb("x", pool as never);
    await db.query("SELECT 1").catch(() => {});
    await db.query("SELECT 1").catch(() => {});
    const out = spy.mock.calls.map((c) => String(c[0]));
    expect(out).toEqual(["state store error: sqlstate 23505"]);
  } finally {
    spy.mockRestore();
  }
});
