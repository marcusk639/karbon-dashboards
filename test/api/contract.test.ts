import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { randomBytes } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { createHttpCoreApi } from "../../src/api/client.js";
import { createApiApp } from "../../src/api/http.js";
import { createCore, type Core, type CoreApi } from "../../src/core/api.js";
import { registerTools } from "../../src/mcp/tools.js";
import { OPEN_WORK_REQUESTS } from "../../src/requests/open-work.js";
import { LAYOUT, REQS } from "../dashboard/fixtures.js";

const TOKEN = randomBytes(24).toString("hex"); // made up per run
const CADENCE = {
  weekday: 1 as const,
  time: "08:00",
  timezone: "America/Chicago",
};

let core: Core;
let server: Server;
let client: CoreApi;

beforeAll(async () => {
  vi.spyOn(console, "log").mockImplementation(() => {}); // the core's own startup and audit lines
  vi.useFakeTimers({ toFake: ["Date"] }); // a fixed clock so queriedAt matches across both paths
  vi.setSystemTime(new Date("2026-10-19T13:00:00Z"));
  core = await createCore({
    DATA_MODE: "synthetic",
    ALLOW_SYNTHETIC_SCHEDULES: "1",
    INTERNAL_API_TOKEN: TOKEN,
  });
  const app = createApiApp(
    core.api,
    { INTERNAL_API_TOKEN: TOKEN },
    { log: () => {} },
  );
  server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;
  client = createHttpCoreApi({
    baseUrl: `http://127.0.0.1:${port}`,
    token: TOKEN,
  });
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await core.close();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

test("the HTTP path matches the in-process path", async () => {
  expect(await client.listMenu()).toEqual(await core.api.listMenu());
  expect(await client.ask(OPEN_WORK_REQUESTS.totals)).toEqual(
    await core.api.ask(OPEN_WORK_REQUESTS.totals),
  );

  const input = {
    name: "Open work",
    slug: "open-work",
    cadence: CADENCE,
    requests: REQS,
    layout: LAYOUT,
  };
  const created = await client.createSchedule(input);
  expect(created).toMatchObject({ ok: true });
  // The same input a second time is a duplicate slug on both paths.
  expect(await client.createSchedule(input)).toEqual(
    await core.api.createSchedule(input),
  );
  expect(await client.listSchedules()).toEqual(await core.api.listSchedules());

  const viaHttp = await client.previewDashboard(REQS, LAYOUT);
  const inProc = await core.api.previewDashboard(REQS, LAYOUT);
  if (!viaHttp.ok || !inProc.ok) throw new Error("preview failed");
  expect(viaHttp.bytes).toBe(inProc.bytes);
  expect(viaHttp.filled).toEqual(inProc.filled);

  expect(await client.listRuns(5)).toEqual(await core.api.listRuns(5));
  expect(await client.listPendingFiles()).toEqual(
    await core.api.listPendingFiles(),
  );
  expect(await client.getDeliveryTargets()).toEqual(
    await core.api.getDeliveryTargets(),
  );
});

async function connect(api: CoreApi) {
  const s = new McpServer({ name: "t", version: "0" });
  registerTools(s, api);
  const c = new Client({ name: "c", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([s.connect(a), c.connect(b)]);
  return c;
}

test("registerTools over the HTTP client", async () => {
  const viaHttp = await connect(client);
  const inProc = await connect(core.api);
  const calls = [
    { name: "list_menu", arguments: {} },
    {
      name: "ask_question",
      arguments: { request: OPEN_WORK_REQUESTS.by_status },
    },
    {
      name: "ask_question",
      arguments: { request: { measures: ["no_such_measure"] } },
    },
  ];
  for (const call of calls) {
    const a = await viaHttp.callTool(call);
    const b = await inProc.callTool(call);
    expect(a.structuredContent, call.name).toEqual(b.structuredContent);
    expect(a.structuredContent, call.name).toBeDefined();
  }
  await Promise.all([viaHttp.close(), inProc.close()]);
});
