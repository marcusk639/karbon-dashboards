import { AsyncLocalStorage } from "node:async_hooks";
import { isIP } from "node:net";

/** Who a request came from, for the audit trail: set per request by the HTTP layers, read by the core. */
export type AuditContext = { surface: "mcp"; callerIp?: string };

export const auditContext = new AsyncLocalStorage<AuditContext>();

/** karbon-mcp tells karbon-api the client IP in this header, on calls that carry the internal token. */
export const CALLER_IP_HEADER = "x-karbon-caller-ip";

/** An IP address as the trail keeps it, or undefined for anything else (never free text from a header). */
export const callerIpOf = (v: unknown): string | undefined =>
  typeof v === "string" && v.length <= 64 && isIP(v) !== 0 ? v : undefined;

/** The context for one request from `ip`. */
export const callerContext = (ip: unknown): AuditContext => {
  const callerIp = callerIpOf(ip);
  return callerIp === undefined ? { surface: "mcp" } : { surface: "mcp", callerIp };
};
