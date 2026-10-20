import request from "supertest";
import { randomBytes } from "node:crypto";
import { expect, test, vi } from "vitest";
import { createHttpCoreApi } from "../../src/api/client.js";
import { createApiApp } from "../../src/api/http.js";
import { auditContext } from "../../src/audit-context.js";
import { createAuditRecorder } from "../../src/audit.js";
import { loadCatalog, loadGenericWords, loadLabels } from "../../src/config.js";
import { createCoreApi, type CoreApi } from "../../src/core/api.js";
import { createSyntheticSource } from "../../src/data/synthetic.js";
import { createApp } from "../../src/http.js";
import { memStore } from "../helpers/store.js";

const TOKEN = randomBytes(24).toString("hex"); // made up per run
const IP = "203.0.113.9"; // documentation range

test("the HTTP client sends the caller IP from the request context, and nothing outside one", async () => {
  const headers: Headers[] = [];
  const fetch = vi.fn(async (_u: unknown, init?: RequestInit) => {
    headers.push(new Headers(init?.headers));
    return new Response('{"result":[]}', { status: 200 });
  });
  const api = createHttpCoreApi({ baseUrl: "http://core.test", token: TOKEN, fetch: fetch as unknown as typeof globalThis.fetch });
  await auditContext.run({ surface: "mcp", callerIp: IP }, () => api.listRuns(5));
  await api.listRuns(5);
  expect(headers[0]!.get("x-karbon-caller-ip")).toBe(IP);
  expect(headers[1]!.has("x-karbon-caller-ip")).toBe(false);
});

const seenBy = () => {
  const seen: (string | undefined)[] = [];
  const api = { listRuns: vi.fn(async () => { seen.push(auditContext.getStore()?.callerIp); return []; }) };
  return { api: api as unknown as CoreApi, seen, fn: api.listRuns };
};

test("the internal API runs an authenticated call inside the caller's context", async () => {
  const { api, seen } = seenBy();
  const app = createApiApp(api, { INTERNAL_API_TOKEN: TOKEN }, { log: () => {} });
  const post = () => request(app).post("/v1/listRuns").set("Authorization", `Bearer ${TOKEN}`).set("Content-Type", "application/json");
  expect((await post().set("x-karbon-caller-ip", IP).send({ args: [5] })).status).toBe(200);
  expect((await post().set("x-karbon-caller-ip", "Zara Quillfeather").send({ args: [5] })).status).toBe(200);
  expect((await post().send({ args: [5] })).status).toBe(200);
  expect(seen).toEqual([IP, undefined, undefined]);
});

test("without the internal token the header is never trusted: the request is refused", async () => {
  const { api, fn } = seenBy();
  const app = createApiApp(api, { INTERNAL_API_TOKEN: TOKEN }, { log: () => {} });
  const r = await request(app).post("/v1/listRuns").set("x-karbon-caller-ip", IP).set("Content-Type", "application/json").send({ args: [5] });
  expect(r.status).toBe(401);
  expect(fn).not.toHaveBeenCalled();
});

test("the MCP layer runs each tool call inside a context carrying the client IP", async () => {
  const { api, seen } = seenBy();
  const mcpToken = randomBytes(24).toString("hex");
  const app = createApp(api, { MCP_BEARER_TOKEN: mcpToken }, { log: () => {} }); // one trusted proxy hop
  const r = await request(app)
    .post("/mcp")
    .set("Authorization", `Bearer ${mcpToken}`)
    .set("Accept", "application/json, text/event-stream")
    .set("Content-Type", "application/json")
    .set("X-Forwarded-For", IP)
    .send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "list_runs", arguments: { limit: 5 } } });
  expect(r.status).toBe(200);
  expect(seen).toEqual([IP]);
});

test("a call through the internal API with the header records the caller IP in the audit row", async () => {
  const store = await memStore();
  const synth = createSyntheticSource(1);
  const now = () => new Date("2026-10-19T13:00:00Z");
  const core = createCoreApi({
    catalog: loadCatalog(), labels: loadLabels(), generic: loadGenericWords(), data: synth.data, names: synth.names,
    store, alerter: { alert: async () => true }, log: { log: () => {} }, now,
    recorder: createAuditRecorder(store, { now, log: { log: () => {} } }),
  });
  const app = createApiApp(core, { INTERNAL_API_TOKEN: TOKEN }, { log: () => {} });
  const r = await request(app).post("/v1/ask").set("Authorization", `Bearer ${TOKEN}`).set("x-karbon-caller-ip", IP)
    .set("Content-Type", "application/json").send({ args: [{ measures: ["jobs"] }] });
  expect(r.body.result.status).toBe("ok");
  const rows = await store.listAudit({ limit: 10 });
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ surface: "mcp", action: "ask", callerIp: IP });
  const text = JSON.stringify(rows);
  expect(text).not.toContain(TOKEN);
  expect(text).not.toMatch(/Bearer|authorization/i);
});
