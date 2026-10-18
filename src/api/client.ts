import { auditContext, CALLER_IP_HEADER, callerIpOf } from "../audit-context.js";
import type { CoreApi, Failure } from "../core/api.js";
import type { LogEvent } from "../log.js";

export type HttpCoreApiOptions = {
  baseUrl: string;
  token: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  longTimeoutMs?: number;
  /** Told of every call that ends core_unavailable (code only). */
  log?: (e: LogEvent) => void;
};

const DETAIL = "core API unavailable";

/** Largest response read from the core: listPendingFiles carries every undelivered PDF, base64, so weeks of backlog fit. */
export const RESPONSE_LIMIT_BYTES = 16 * 1024 * 1024;

/** A transport failure with a fixed message: never the URL, the token or the cause. */
class Unavailable extends Error {
  constructor() {
    super(DETAIL);
  }
}

/** Read the body as text, giving up once it passes the limit (declared or actual) so a runaway response is never buffered. */
async function readCapped(res: Response): Promise<string> {
  if (Number(res.headers.get("content-length") ?? 0) > RESPONSE_LIMIT_BYTES) throw new Unavailable();
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > RESPONSE_LIMIT_BYTES) {
      await reader.cancel().catch(() => {});
      throw new Unavailable();
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** For methods that return a Failure on their own: an unreachable core is one more Failure. */
const orFail = <T>(p: Promise<T>): Promise<T | Failure> =>
  p.catch((): Failure => ({
    ok: false,
    code: "core_unavailable",
    detail: DETAIL,
  }));

/**
 * CoreApi over HTTP to the internal API (src/api/http.ts). Timeout, transport error, non-200 or an unparseable
 * body resolve to core_unavailable; the methods that return a list, the menu or the targets throw instead, so the
 * tool guard turns that into `internal`.
 */
export function createHttpCoreApi(opts: HttpCoreApiOptions): CoreApi {
  const doFetch = opts.fetch ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const longTimeoutMs = opts.longTimeoutMs ?? 600_000;
  const base = opts.baseUrl.replace(/\/+$/, "");

  async function call<T>(
    method: keyof CoreApi,
    args: unknown[],
    ms = timeoutMs,
  ): Promise<T> {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), ms);
    // The client IP of the MCP request this call serves, for karbon-api's audit trail.
    const ip = callerIpOf(auditContext.getStore()?.callerIp);
    try {
      const res = await doFetch(`${base}/v1/${method}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${opts.token}`,
          "content-type": "application/json",
          ...(ip !== undefined ? { [CALLER_IP_HEADER]: ip } : {}),
        },
        body: JSON.stringify({ args }),
        signal: abort.signal,
      });
      if (res.status !== 200) {
        await res.body?.cancel().catch(() => {}); // release the connection rather than leave the body unread
        throw new Unavailable();
      }
      const body = JSON.parse(await readCapped(res)) as unknown;
      if (typeof body !== "object" || body === null || !("result" in body))
        throw new Unavailable();
      return body.result as T;
    } catch {
      try {
        opts.log?.({ kind: "question", verdict: "failed", code: "core_unavailable" });
      } catch {
        /* logging is best effort */
      }
      throw new Unavailable(); // drop the cause: it can carry the URL
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    listMenu: () => call("listMenu", []),
    ask: (raw) =>
      call<Awaited<ReturnType<CoreApi["ask"]>>>("ask", [raw]).catch(() => ({
        status: "rejected" as const,
        code: "core_unavailable" as const,
        detail: DETAIL,
      })),
    previewDashboard: (requests, layout) =>
      orFail(call("previewDashboard", [requests, layout])),
    createSchedule: (input) => orFail(call("createSchedule", [input])),
    listSchedules: () => call("listSchedules", []),
    updateSchedule: (id, patch) => orFail(call("updateSchedule", [id, patch])),
    pauseSchedule: (id, paused) => orFail(call("pauseSchedule", [id, paused])),
    deleteSchedule: (id) => orFail(call("deleteSchedule", [id])),
    runScheduleNow: (id) => orFail(call("runScheduleNow", [id], longTimeoutMs)),
    listRuns: (limit) => call("listRuns", [limit]),
    listPendingFiles: () => call("listPendingFiles", []),
    markFileDelivered: (fileId) => orFail(call("markFileDelivered", [fileId])),
    getDeliveryTargets: () => call("getDeliveryTargets", []),
    setDeliveryTarget: (key, driveId, itemId) =>
      orFail(call("setDeliveryTarget", [key, driveId, itemId])),
  };
}
