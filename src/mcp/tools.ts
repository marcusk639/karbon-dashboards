import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Cadence, CoreApi } from "../core/api.js";

/** The MCP layer is a thin skin: every tool is one direct call into CoreApi. */

const NO_SQL = "SQL cannot be supplied: you choose names from the menu (list_menu) and the server builds the query.";

type Out = Record<string, unknown>;
const hasOk = (v: Out): boolean => v.ok === false;

/** structuredContent is the API result; the text part is a one-line summary, never data. */
function result(v: Out, summary: string) {
  const failed = hasOk(v);
  const text = failed ? `Failed: ${String(v.code)} (${String(v.detail)})` : summary;
  return { content: [{ type: "text" as const, text }], structuredContent: v, ...(failed ? { isError: true } : {}) };
}

// Loose on purpose: the guard / validators reject unknown keys with a reason, instead of zod silently stripping them.
const Obj = z.record(z.string(), z.unknown());
const Requests = z.record(z.string(), z.unknown()).describe("Named menu requests, e.g. { totals: { measures: [...] } }");
const Cadence_ = z
  .object({ weekday: z.number(), time: z.string(), timezone: z.string() })
  .describe("weekday 1 (Monday) to 7 (Sunday), time HH:mm, timezone an IANA name such as America/Chicago");
const Layout_ = Obj.describe("Dashboard layout: title, subtitle?, tiles, charts, tables, notes. References requests by name.");

export function registerTools(server: McpServer, api: CoreApi): void {
  server.registerTool(
    "list_menu",
    {
      description:
        "Returns the menu of cohorts, measures, dimensions and filters you may ask for, with their names and meanings only. " + NO_SQL,
      inputSchema: {},
    },
    async () => {
      const m = api.listMenu();
      return result(m as unknown as Out, `Menu: ${m.measures.length} measures, ${m.dimensions.length} dimensions.`);
    },
  );

  server.registerTool(
    "ask_question",
    {
      description:
        "Runs one menu request through the privacy guard. Returns { status:'ok', table, queriedAt } (aggregates only) or { status:'rejected', code, detail } (a code and a location, never data). " +
        "request = { measures: [...], dimensions?: [...], filters?: { due_between: { from, to } }, orderBy?: [{ field, dir }] }. " + NO_SQL,
      inputSchema: { request: Obj },
    },
    async ({ request }) => {
      const r = await api.ask(request);
      // The generated SQL stays on the server.
      const out: Out =
        r.status === "ok" ? { status: r.status, table: r.table, queriedAt: r.queriedAt } : { status: r.status, code: r.code, detail: r.detail };
      return result(out, r.status === "ok" ? `${r.table.rows.length} rows.` : `Rejected: ${r.code}`);
    },
  );

  server.registerTool(
    "preview_dashboard",
    {
      description:
        "Runs every named request through the guard, fills the layout, checks it and renders the PDF once, without storing or scheduling anything. " +
        "Returns { ok, pdfBase64, bytes, filled } or { ok:false, code, detail }. " + NO_SQL,
      inputSchema: { requests: Requests, layout: Layout_ },
    },
    async ({ requests, layout }) => {
      const r = await api.previewDashboard(requests, layout);
      return result(r as unknown as Out, r.ok ? `Preview rendered, ${r.bytes} bytes.` : "");
    },
  );

  server.registerTool(
    "create_schedule",
    {
      description:
        "Creates a recurring dashboard schedule after validating every request and the layout. Returns { ok:true, id } or { ok:false, code, detail }. " +
        "slug is lowercase letters, digits and hyphens, 3 to 60 characters, and names the delivery folder. " + NO_SQL,
      inputSchema: { name: z.string(), slug: z.string(), cadence: Cadence_, requests: Requests, layout: Layout_ },
    },
    async (a) => {
      const r = await api.createSchedule({ ...a, cadence: a.cadence as Cadence });
      return result(r as unknown as Out, r.ok ? `Created schedule ${r.id}.` : "");
    },
  );

  server.registerTool(
    "list_schedules",
    {
      description: "Returns every schedule with its cadence, requests, layout and paused flag. " + NO_SQL,
      inputSchema: {},
    },
    async () => {
      const schedules = api.listSchedules();
      return result({ schedules }, `${schedules.length} schedules.`);
    },
  );

  server.registerTool(
    "update_schedule",
    {
      description:
        "Changes fields of a schedule (name, slug, cadence, requests, layout) and re-validates the whole result before saving. Returns { ok } or { ok:false, code, detail }. " + NO_SQL,
      inputSchema: {
        id: z.number(),
        patch: z.object({
          name: z.string().optional(),
          slug: z.string().optional(),
          cadence: Cadence_.optional(),
          requests: Requests.optional(),
          layout: Layout_.optional(),
        }),
      },
    },
    async ({ id, patch }) => {
      const r = await api.updateSchedule(id, patch as Parameters<CoreApi["updateSchedule"]>[1]);
      return result(r as unknown as Out, `Updated schedule ${id}.`);
    },
  );

  server.registerTool(
    "pause_schedule",
    {
      description: "Pauses or resumes a schedule. Returns { ok } or { ok:false, code, detail }. " + NO_SQL,
      inputSchema: { id: z.number(), paused: z.boolean() },
    },
    async ({ id, paused }) => result(api.pauseSchedule(id, paused) as unknown as Out, `Schedule ${id} ${paused ? "paused" : "resumed"}.`),
  );

  server.registerTool(
    "delete_schedule",
    {
      description:
        "Permanently deletes a schedule AND its run history AND any undelivered files it produced; this cannot be undone. " +
        "Returns { ok } or { ok:false, code, detail }. " + NO_SQL,
      inputSchema: { id: z.number() },
    },
    async ({ id }) => result(api.deleteSchedule(id) as unknown as Out, `Schedule ${id} deleted.`),
  );

  server.registerTool(
    "run_schedule_now",
    {
      description:
        "Runs a schedule immediately through the same guarded path as the weekly run. Returns { ok, runId, periodKey, status } where status is produced, rejected or failed; " +
        "the PDF (or a NOT PRODUCED notice) then appears in list_pending_files. " + NO_SQL,
      inputSchema: { id: z.number() },
    },
    async ({ id }) => {
      const r = await api.runScheduleNow(id);
      return result(r as unknown as Out, r.ok ? `Run ${r.runId}: ${r.status}.` : "");
    },
  );

  server.registerTool(
    "list_runs",
    {
      description: "Returns the most recent runs (newest first) with status and code, never data. " + NO_SQL,
      inputSchema: { limit: z.number().optional() },
    },
    async ({ limit }) => {
      const runs = api.listRuns(limit ?? 20);
      return result({ runs }, `${runs.length} runs.`);
    },
  );

  server.registerTool(
    "list_pending_files",
    {
      description:
        "Returns files not yet delivered as { fileId, folder, filename, contentType, bytes, contentBase64 }; upload each, then call mark_file_delivered. " + NO_SQL,
      inputSchema: {},
    },
    async () => {
      const files = api.listPendingFiles();
      return result({ files }, `${files.length} pending files.`);
    },
  );

  server.registerTool(
    "mark_file_delivered",
    {
      description: "Marks a pending file as delivered so it is no longer listed. Returns { ok } or { ok:false, code, detail }. " + NO_SQL,
      inputSchema: { fileId: z.number() },
    },
    async ({ fileId }) => result(api.markFileDelivered(fileId) as unknown as Out, `File ${fileId} marked delivered.`),
  );

  server.registerTool(
    "get_delivery_targets",
    {
      description: "Returns the delivery targets as { targets: { <key>: { driveId, itemId } } }. " + NO_SQL,
      inputSchema: {},
    },
    async () => result({ targets: api.getDeliveryTargets() }, "Delivery targets."),
  );

  server.registerTool(
    "set_delivery_target",
    {
      description: "Sets the drive and folder item a schedule folder is delivered to. Returns { ok } or { ok:false, code, detail }. " + NO_SQL,
      inputSchema: { key: z.string(), driveId: z.string(), itemId: z.string() },
    },
    async ({ key, driveId, itemId }) => result(api.setDeliveryTarget(key, driveId, itemId) as unknown as Out, `Target ${key} set.`),
  );
}
