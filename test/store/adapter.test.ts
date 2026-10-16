import { expect, test } from "vitest";
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
