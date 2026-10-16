import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { expect, test, vi } from "vitest";
import type { CoreApi } from "../../src/core/api.js";
import { registerTools } from "../../src/mcp/tools.js";

export function mockApi(): { [K in keyof CoreApi]: ReturnType<typeof vi.fn> } {
  const f = () => vi.fn();
  return {
    listMenu: f(), ask: f(), previewDashboard: f(), createSchedule: f(), listSchedules: f(),
    updateSchedule: f(), pauseSchedule: f(), deleteSchedule: f(), runScheduleNow: f(),
    listRuns: f(), listPendingFiles: f(), markFileDelivered: f(), getDeliveryTargets: f(),
    setDeliveryTarget: f(),
  };
}

async function connect(api: ReturnType<typeof mockApi>) {
  const server = new McpServer({ name: "t", version: "0" });
  registerTools(server, api as unknown as CoreApi);
  const client = new Client({ name: "c", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

const EXPECTED = [
  "list_menu", "ask_question", "preview_dashboard", "create_schedule", "list_schedules",
  "update_schedule", "pause_schedule", "delete_schedule", "run_schedule_now", "list_runs",
  "list_pending_files", "mark_file_delivered", "get_delivery_targets", "set_delivery_target",
];

test("registers exactly the fourteen tools, each saying SQL cannot be supplied", async () => {
  const client = await connect(mockApi());
  const { tools } = await client.listTools();
  expect(tools.map((t) => t.name).sort()).toEqual([...EXPECTED].sort());
  for (const t of tools) {
    expect(t.description, t.name).toBeTruthy();
    expect(t.description!, t.name).toMatch(/Returns/);
    expect(t.description!, t.name).toMatch(/SQL/);
  }
});

test("delete_schedule's description says it deletes run history and undelivered files", async () => {
  const { tools } = await (await connect(mockApi())).listTools();
  const d = tools.find((t) => t.name === "delete_schedule")!.description!;
  expect(d).toMatch(/run history/i);
  expect(d).toMatch(/undelivered files/i);
});

test("ask_question passes through rejection with no data", async () => {
  const api = mockApi();
  api.ask.mockResolvedValue({ status: "rejected", code: "client_name", detail: 'column "stage"' });
  const r = await (await connect(api)).callTool({ name: "ask_question", arguments: { request: { measures: ["jobs"] } } });
  expect(r).toMatchObject({ structuredContent: { status: "rejected", code: "client_name" } });
  expect(api.ask).toHaveBeenCalledWith({ measures: ["jobs"] });
  expect(JSON.stringify(r)).not.toMatch(/"table"/);
});

test("ask_question returns table, sql text and queriedAt, never binds", async () => {
  const api = mockApi();
  api.ask.mockResolvedValue({
    status: "ok", sql: "SELECT COUNT(*) FROM KPI_DATABASE.SECURE_VIEWS.WORK_ITEM_DETAILS WHERE x = ?",
    binds: ["2026-01-01"], queriedAt: "2026-10-19T13:00:00.000Z",
    table: { columns: ["jobs"], rows: [[3]] },
  });
  const r = await (await connect(api)).callTool({ name: "ask_question", arguments: { request: { measures: ["jobs"] } } });
  const sc = r.structuredContent as { sql: string };
  expect(sc.sql).toContain("FROM KPI_DATABASE.SECURE_VIEWS.WORK_ITEM_DETAILS");
  expect((r.structuredContent as { queriedAt: string }).queriedAt).toBe("2026-10-19T13:00:00.000Z");
  expect(JSON.stringify(r)).not.toMatch(/binds|2026-01-01/);
});

test("an exception inside a CoreApi call becomes a structured internal error without its message", async () => {
  const api = mockApi();
  api.listRuns.mockImplementation(() => { throw new Error("SECRET_SQLITE_DETAIL"); });
  const r = await (await connect(api)).callTool({ name: "list_runs", arguments: {} });
  expect(r).toMatchObject({ isError: true, structuredContent: { ok: false, code: "internal", detail: "unexpected error" } });
  expect(JSON.stringify(r)).toContain("internal");
  expect(JSON.stringify(r)).not.toContain("SECRET");
});

test("extra keys in a request reach the guard unchanged (they are rejected there, not silently stripped)", async () => {
  const api = mockApi();
  api.ask.mockResolvedValue({ status: "rejected", code: "disallowed_request", detail: "x" });
  await (await connect(api)).callTool({ name: "ask_question", arguments: { request: { measures: ["jobs"], sql: "select 1" } } });
  expect(api.ask).toHaveBeenCalledWith({ measures: ["jobs"], sql: "select 1" });
});

test("create_schedule forwards its input and returns the api result; failures flag isError", async () => {
  const api = mockApi();
  const cadence = { weekday: 1, time: "08:00", timezone: "America/Chicago" };
  api.createSchedule.mockResolvedValueOnce({ ok: true, id: 7 });
  api.createSchedule.mockResolvedValueOnce({ ok: false, code: "invalid_layout", detail: "tiles[0].request" });
  const client = await connect(api);
  const args = { name: "n", slug: "open-work", cadence, requests: { a: { measures: ["jobs"] } }, layout: { title: "t" } };
  const ok = await client.callTool({ name: "create_schedule", arguments: args });
  expect(ok.structuredContent).toEqual({ ok: true, id: 7 });
  expect(ok.isError).toBeFalsy();
  expect(api.createSchedule).toHaveBeenCalledWith(args);
  const bad = await client.callTool({ name: "create_schedule", arguments: args });
  expect(bad).toMatchObject({ isError: true, structuredContent: { ok: false, code: "invalid_layout" } });
});

test("list tools wrap arrays in an object so structuredContent is valid", async () => {
  const api = mockApi();
  api.listSchedules.mockReturnValue([]);
  api.listRuns.mockReturnValue([]);
  api.listPendingFiles.mockReturnValue([
    { fileId: 1, folder: "f", filename: "a.pdf", contentType: "application/pdf", bytes: 3, contentBase64: "QUJD" },
  ]);
  const client = await connect(api);
  expect((await client.callTool({ name: "list_schedules", arguments: {} })).structuredContent).toEqual({ schedules: [] });
  expect((await client.callTool({ name: "list_runs", arguments: { limit: 5 } })).structuredContent).toEqual({ runs: [] });
  expect(api.listRuns).toHaveBeenCalledWith(5);
  expect((await client.callTool({ name: "list_pending_files", arguments: {} })).structuredContent).toMatchObject({
    files: [{ fileId: 1, contentBase64: "QUJD" }],
  });
});

test("the remaining tools call straight through", async () => {
  const api = mockApi();
  api.pauseSchedule.mockReturnValue({ ok: true });
  api.deleteSchedule.mockReturnValue({ ok: true });
  api.markFileDelivered.mockReturnValue({ ok: true });
  api.setDeliveryTarget.mockReturnValue({ ok: true });
  api.getDeliveryTargets.mockReturnValue({});
  api.runScheduleNow.mockResolvedValue({ ok: true, runId: 1, status: "produced", periodKey: "manual-x" });
  api.updateSchedule.mockResolvedValue({ ok: true });
  api.previewDashboard.mockResolvedValue({ ok: false, code: "pattern_match", detail: "notes[0]" });
  api.listMenu.mockReturnValue({ cohorts: [], measures: [], dimensions: [], filters: [] });
  const c = await connect(api);
  await c.callTool({ name: "pause_schedule", arguments: { id: 2, paused: true } });
  expect(api.pauseSchedule).toHaveBeenCalledWith(2, true);
  await c.callTool({ name: "delete_schedule", arguments: { id: 2 } });
  expect(api.deleteSchedule).toHaveBeenCalledWith(2);
  await c.callTool({ name: "mark_file_delivered", arguments: { fileId: 4 } });
  expect(api.markFileDelivered).toHaveBeenCalledWith(4);
  await c.callTool({ name: "set_delivery_target", arguments: { key: "k", driveId: "d", itemId: "i" } });
  expect(api.setDeliveryTarget).toHaveBeenCalledWith("k", "d", "i");
  await c.callTool({ name: "run_schedule_now", arguments: { id: 9 } });
  expect(api.runScheduleNow).toHaveBeenCalledWith(9);
  await c.callTool({ name: "update_schedule", arguments: { id: 9, patch: { name: "x" } } });
  expect(api.updateSchedule).toHaveBeenCalledWith(9, { name: "x" });
  const p = await c.callTool({ name: "preview_dashboard", arguments: { requests: {}, layout: {} } });
  expect(p).toMatchObject({ isError: true, structuredContent: { code: "pattern_match" } });
  expect((await c.callTool({ name: "get_delivery_targets", arguments: {} })).structuredContent).toEqual({ targets: {} });
  expect((await c.callTool({ name: "list_menu", arguments: {} })).structuredContent).toMatchObject({ cohorts: [] });
});
