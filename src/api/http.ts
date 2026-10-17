import { createHash, timingSafeEqual } from "node:crypto";
import express, {
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
} from "express";
import type { CoreApi } from "../core/api.js";
import { createLogger, type LogEvent } from "../log.js";

const MIN_TOKEN_LENGTH = 32;

/** The allowlist for the wire: a path segment is only ever used to index the API after it matches one of these. */
export const CORE_METHODS: readonly (keyof CoreApi)[] = [
  "listMenu",
  "ask",
  "previewDashboard",
  "createSchedule",
  "listSchedules",
  "updateSchedule",
  "pauseSchedule",
  "deleteSchedule",
  "runScheduleNow",
  "listRuns",
  "listPendingFiles",
  "markFileDelivered",
  "getDeliveryTargets",
  "setDeliveryTarget",
];

const digest = (s: string): Buffer => createHash("sha256").update(s).digest();

/** Constant-time compare: hash both sides to a fixed length first so neither length nor content leaks through timing. */
function sameToken(given: string, expected: Buffer): boolean {
  return timingSafeEqual(digest(given), expected);
}

const isMethod = (name: string): name is keyof CoreApi =>
  (CORE_METHODS as readonly string[]).includes(name);

/**
 * The core behind an internal token: POST /v1/<method> { args: [...] } calls that CoreApi method with positional args.
 * Arguments are validated inside CoreApi itself, as they are for the MCP tools.
 */
export function createApiApp(
  api: CoreApi,
  env: { INTERNAL_API_TOKEN?: string | undefined },
  opts: { log?: (e: LogEvent) => void } = {},
): express.Express {
  const token = env.INTERNAL_API_TOKEN;
  if (typeof token !== "string" || token.length < MIN_TOKEN_LENGTH) {
    throw new Error(
      `INTERNAL_API_TOKEN must be set to at least ${MIN_TOKEN_LENGTH} characters`,
    );
  }
  const expected = digest(token);
  const log = opts.log ?? ((e: LogEvent) => createLogger().log(e));

  const app = express();
  app.disable("x-powered-by");

  app.get("/health", (_req, res) => {
    res.status(200).type("text/plain").send("ok");
  });

  const auth: RequestHandler = (req, res, next) => {
    const m = /^Bearer (.+)$/.exec(req.get("authorization") ?? "");
    if (!m || !sameToken(m[1]!, expected)) {
      log({ kind: "auth", verdict: "rejected" });
      res.status(401).end(); // empty body: nothing to learn
      return;
    }
    next();
  };

  app.use("/v1", auth);
  // Only authenticated requests reach the body parser.
  app.use("/v1", express.json({ limit: "512kb" }));

  app.post("/v1/:method", async (req: Request, res: Response) => {
    const name = req.params.method;
    if (typeof name !== "string" || !isMethod(name)) {
      res.status(404).end();
      return;
    }
    const raw = (req.body as { args?: unknown } | undefined)?.args;
    const args = Array.isArray(raw) ? raw : [];
    try {
      const fn = api[name] as (...a: unknown[]) => unknown;
      const result = await fn.apply(api, args);
      res.status(200).json({ result });
    } catch {
      log({ kind: "question", verdict: "failed" }); // no message: it can carry SQL, a URL or a value
      if (!res.headersSent) res.status(500).json({ error: "internal" });
    }
  });

  // Any other route or verb: a bare 404, so the default page never echoes the path.
  app.use((_req, res) => {
    res.status(404).end();
  });

  // Body-parse failures and anything unexpected: no message, no stack, no echo.
  app.use(
    (_err: unknown, _req: Request, res: Response, _next: NextFunction) => {
      if (!res.headersSent) res.status(500).json({ error: "internal" });
    },
  );

  return app;
}
