import { createHash, timingSafeEqual } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import express, { type NextFunction, type Request, type RequestHandler, type Response } from "express";
import type { CoreApi } from "./core/api.js";
import { createLogger, type LogEvent } from "./log.js";
import { registerTools } from "./mcp/tools.js";

const MIN_TOKEN_LENGTH = 32;
const WINDOW_MS = 60_000;
const LIMIT = 60;

const digest = (s: string): Buffer => createHash("sha256").update(s).digest();

/** Constant-time compare: hash both sides to a fixed length first so neither length nor content leaks through timing. */
function sameToken(given: string, expected: Buffer): boolean {
  return timingSafeEqual(digest(given), expected);
}

const rpcError = (code: number, message: string) => ({ jsonrpc: "2.0", error: { code, message }, id: null });

export type AppOptions = { log?: (e: LogEvent) => void; maxTrackedIps?: number };

export function createApp(
  api: CoreApi,
  env: { MCP_BEARER_TOKEN?: string | undefined; TRUST_PROXY_HOPS?: string | undefined },
  opts: AppOptions = {},
): express.Express {
  const token = env.MCP_BEARER_TOKEN;
  if (typeof token !== "string" || token.length < MIN_TOKEN_LENGTH) {
    throw new Error(`MCP_BEARER_TOKEN must be set to at least ${MIN_TOKEN_LENGTH} characters`);
  }
  const expected = digest(token);
  const log = opts.log ?? ((e: LogEvent) => createLogger().log(e));
  const rejected = (): void => log({ kind: "auth", verdict: "rejected" });

  const app = express();
  app.disable("x-powered-by");
  // Railway terminates TLS at one proxy hop, so req.ip is the client entry that hop appended to X-Forwarded-For.
  // Override with TRUST_PROXY_HOPS (0 when running with no proxy in front).
  const hops = Number(env.TRUST_PROXY_HOPS ?? 1);
  app.set("trust proxy", Number.isInteger(hops) && hops >= 0 ? hops : 1);

  app.get("/health", (_req, res) => {
    res.status(200).type("text/plain").send("ok");
  });

  // Fixed window per IP. Counts every /mcp request, authenticated or not, so guessing the token is throttled too.
  const maxIps = opts.maxTrackedIps ?? 10_000;
  const windows = new Map<string, { start: number; count: number }>();
  const limiter: RequestHandler = (req, res, next) => {
    const now = Date.now();
    const key = req.ip ?? "unknown";
    let w = windows.get(key);
    if (!w || now - w.start >= WINDOW_MS) {
      if (!w && windows.size >= maxIps) for (const [k, v] of windows) if (now - v.start >= WINDOW_MS) windows.delete(k);
      if (!w && windows.size >= maxIps) {
        // Table full of live windows: refuse the new key rather than grow without bound.
        rejected();
        res.status(429).set("Retry-After", "60").end();
        return;
      }
      w = { start: now, count: 0 };
      windows.set(key, w);
    }
    w.count += 1;
    if (w.count > LIMIT) {
      rejected();
      res.status(429).set("Retry-After", String(Math.ceil((w.start + WINDOW_MS - now) / 1000))).end();
      return;
    }
    next();
  };

  const auth: RequestHandler = (req, res, next) => {
    const m = /^Bearer (.+)$/.exec(req.get("authorization") ?? "");
    if (!m || !sameToken(m[1]!, expected)) {
      rejected();
      res.status(401).end(); // empty body: nothing to learn
      return;
    }
    next();
  };

  app.use("/mcp", limiter, auth);
  // Only authenticated requests reach the body parser.
  app.use("/mcp", express.json({ limit: "512kb" }));

  app.post("/mcp", async (req: Request, res: Response) => {
    // Stateless: a fresh server and transport per request, nothing kept between calls.
    const server = new McpServer({ name: "karbon-dashboards", version: "1.0.0" });
    registerTools(server, api, log);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch {
      if (!res.headersSent) res.status(500).json(rpcError(-32603, "Internal server error"));
    }
  });

  app.all("/mcp", (_req, res) => {
    res.status(405).set("Allow", "POST").json(rpcError(-32000, "Method not allowed"));
  });

  // Body-parse failures and anything unexpected: no stack, no echo.
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const status = (err as { status?: unknown } | null)?.status === 413 ? 413 : 400;
    if (!res.headersSent) res.status(status).json(rpcError(status === 413 ? -32600 : -32700, status === 413 ? "Request too large" : "Parse error"));
  });

  return app;
}
