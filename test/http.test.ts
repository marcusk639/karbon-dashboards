import request from "supertest";
import { beforeEach, expect, test, vi } from "vitest";
import { randomBytes } from "node:crypto";
import type { CoreApi } from "../src/core/api.js";
import { createApp } from "../src/http.js";
import type { LogEvent } from "../src/log.js";

const TOKEN = randomBytes(24).toString("hex"); // 48 chars, made up per run
const ACCEPT = "application/json, text/event-stream";
const INIT = {
  jsonrpc: "2.0", id: 1, method: "initialize",
  params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "0" } },
};

function mockApi() {
  const f = () => vi.fn();
  return {
    listMenu: f(), ask: f(), previewDashboard: f(), createSchedule: f(), listSchedules: f(),
    updateSchedule: f(), pauseSchedule: f(), deleteSchedule: f(), runScheduleNow: f(),
    listRuns: f(), listPendingFiles: f(), markFileDelivered: f(), getDeliveryTargets: f(),
    setDeliveryTarget: f(),
  };
}

let api: ReturnType<typeof mockApi>;
let events: LogEvent[];
let app: ReturnType<typeof createApp>;
beforeEach(() => {
  api = mockApi();
  events = [];
  app = createApp(api as unknown as CoreApi, { MCP_BEARER_TOKEN: TOKEN }, { log: (e) => events.push(e) });
});

const post = (token: string | null = TOKEN) => {
  const r = request(app).post("/mcp").set("Accept", ACCEPT).set("Content-Type", "application/json");
  return token === null ? r : r.set("Authorization", `Bearer ${token}`);
};
const callTool = async (name: string, args: object) => {
  const r = await post().send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } });
  expect(r.status).toBe(200);
  return r.body.result;
};

test("no token -> 401, empty body, the core is never called, and it is logged", async () => {
  const r = await post(null).send(INIT);
  expect(r.status).toBe(401);
  expect(r.text).toBe("");
  expect(api.ask).not.toHaveBeenCalled();
  expect(events).toEqual([{ kind: "auth", verdict: "rejected" }]);
});

test("wrong token, wrong scheme, wrong length -> the same bare 401", async () => {
  const bad = ["nope", TOKEN.slice(0, -1), TOKEN + "x", TOKEN.toUpperCase()];
  for (const t of bad) {
    const r = await post(t).send(INIT);
    expect(r.status).toBe(401);
    expect(r.text).toBe("");
  }
  const basic = await request(app).post("/mcp").set("Accept", ACCEPT).set("Authorization", `Basic ${TOKEN}`).send(INIT);
  expect(basic.status).toBe(401);
  expect(events).toHaveLength(bad.length + 1);
});

test("unauthenticated GET and DELETE on /mcp are also 401 before anything else", async () => {
  expect((await request(app).get("/mcp")).status).toBe(401);
  expect((await request(app).delete("/mcp")).status).toBe(401);
});

test("an unauthenticated malformed body is a 401, never a parse error", async () => {
  const r = await request(app).post("/mcp").set("Content-Type", "application/json").send("{not json");
  expect(r.status).toBe(401);
  expect(r.text).toBe("");
});

test("GET /health is 200 'ok' without auth and says nothing else", async () => {
  const r = await request(app).get("/health");
  expect(r.status).toBe(200);
  expect(r.text).toBe("ok");
});

test("an authenticated GET /mcp is 405 (stateless: no server-initiated stream)", async () => {
  const r = await request(app).get("/mcp").set("Authorization", `Bearer ${TOKEN}`);
  expect(r.status).toBe(405);
});

test("authenticated initialize and tools/list work statelessly", async () => {
  const init = await post().send(INIT);
  expect(init.status).toBe(200);
  expect(init.body.result.serverInfo.name).toBe("karbon-dashboards");
  expect(init.headers["mcp-session-id"]).toBeUndefined();
  const list = await post().send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  expect(list.body.result.tools).toHaveLength(14);
});

test("ask_question passes through rejection with no data", async () => {
  api.ask.mockResolvedValue({ status: "rejected", code: "client_name", detail: 'column "stage"' });
  const result = await callTool("ask_question", { request: { measures: ["jobs"] } });
  expect(result).toMatchObject({ structuredContent: { status: "rejected" } });
  expect(JSON.stringify(result)).not.toMatch(/"table"|"rows"/);
});

test("a malformed JSON body with a valid token is a 400, not a stack trace", async () => {
  const r = await request(app)
    .post("/mcp").set("Accept", ACCEPT).set("Content-Type", "application/json")
    .set("Authorization", `Bearer ${TOKEN}`).send("{not json");
  expect(r.status).toBe(400);
  expect(r.text).not.toMatch(/at |node_modules|SyntaxError/);
});

test("61st request in a minute -> 429; the first 60 are not", async () => {
  for (let i = 0; i < 60; i++) {
    const r = await request(app).get("/mcp").set("Authorization", `Bearer ${TOKEN}`);
    expect(r.status).toBe(405);
  }
  const r61 = await post().send(INIT);
  expect(r61.status).toBe(429);
  expect(api.ask).not.toHaveBeenCalled();
  expect(events.some((e) => e.kind === "auth" && e.verdict === "rejected")).toBe(true);
});

test("the limit counts unauthenticated attempts too, and /health is not limited", async () => {
  for (let i = 0; i < 60; i++) expect((await post("bad").send(INIT)).status).toBe(401);
  expect((await post("bad").send(INIT)).status).toBe(429);
  expect((await post().send(INIT)).status).toBe(429);
  expect((await request(app).get("/health")).status).toBe(200);
});

test("the window resets after a minute, per IP", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    vi.setSystemTime(new Date("2026-10-19T13:00:00Z"));
    for (let i = 0; i < 61; i++) await post("bad").send(INIT);
    expect((await post("bad").send(INIT)).status).toBe(429);
    vi.setSystemTime(new Date("2026-10-19T13:01:01Z"));
    expect((await post("bad").send(INIT)).status).toBe(401);
  } finally {
    vi.useRealTimers();
  }
});

test.each([undefined, "", "short", "x".repeat(31)])("refuses to start with MCP_BEARER_TOKEN %j", (tok) => {
  expect(() => createApp(api as unknown as CoreApi, { MCP_BEARER_TOKEN: tok })).toThrow(/MCP_BEARER_TOKEN/);
});

test("accepts a 32 character token", () => {
  expect(() => createApp(api as unknown as CoreApi, { MCP_BEARER_TOKEN: "y".repeat(32) })).not.toThrow();
});
