import { createHttpCoreApi } from "./api/client.js";
import { createApp } from "./http.js";
import { createLogger } from "./log.js";

// karbon-mcp: the public MCP layer. It reaches the core only over HTTP (CORE_API_URL) and must never hold warehouse
// or database credentials, nor import src/core/api.ts or src/data/snowflake.ts (type-only imports are erased).

// A copy-paste of variables between services must not put credentials here: refuse, naming the variable only.
for (const name of [
  "KARBON_SF_USER",
  "KARBON_SF_PASSWORD",
  "DATABASE_URL",
  "DATABASE_CA_CERT",
  "POSTGRES_PASSWORD",
]) {
  if (process.env[name] !== undefined) {
    console.error(`${name} must not be set on the MCP service`);
    process.exit(1);
  }
}
for (const name of ["MCP_BEARER_TOKEN", "INTERNAL_API_TOKEN"]) {
  if ((process.env[name] ?? "").length < 32) {
    console.error(`${name} must be set to at least 32 characters`);
    process.exit(1);
  }
}
const baseUrl = process.env.CORE_API_URL ?? "";
let protocol = "";
try {
  protocol = new URL(baseUrl).protocol;
} catch {
  /* reported below */
}
if (protocol !== "http:" && protocol !== "https:") {
  console.error("CORE_API_URL must be an http:// or https:// URL");
  process.exit(1);
}

const logger = createLogger();
const api = createHttpCoreApi({
  baseUrl,
  token: process.env.INTERNAL_API_TOKEN!,
  log: (e) => logger.log(e),
});
const app = createApp(api, process.env);
const port = Number(process.env.PORT ?? 8787);

const http = app.listen(port, (err) => {
  if (err) {
    // A bind error (e.g. EADDRINUSE) stops the process: the error code only, never its message.
    const code = (err as NodeJS.ErrnoException).code;
    process.stdout.write(`${JSON.stringify({ time: new Date().toISOString(), msg: "listen failed", code })}\n`, () => process.exit(1));
    return;
  }
  console.log(
    JSON.stringify({ time: new Date().toISOString(), msg: "listening", port }),
  );
});

// No run state lives here: close and go. A tool call cut off mid-flight returns core_unavailable, and the call may
// still have completed on karbon-api, so callers check list_runs / list_schedules before retrying.
function shutdown(): void {
  http.close();
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
