import { createApiApp } from "./api/http.js";
import { createCore } from "./core/api.js";

// karbon-api: the core (warehouse, state store, scheduler) behind INTERNAL_API_TOKEN, on Railway's private network only.

// Check the token first: a bad one must never open the store or read warehouse credentials.
if ((process.env.INTERNAL_API_TOKEN ?? "").length < 32) {
  console.error("INTERNAL_API_TOKEN must be set to at least 32 characters");
  process.exit(1);
}
let core: Awaited<ReturnType<typeof createCore>>;
try {
  core = await createCore(process.env);
} catch (err) {
  // Configuration errors name the missing variable only, never a value.
  console.error(err instanceof Error ? err.message : "startup failed");
  process.exit(1);
}
const app = createApiApp(core.api, process.env);
const port = Number(process.env.PORT ?? 8080);

// "::" is dual stack: Railway private networking resolves to IPv4 and IPv6 in this environment.
const http = app.listen(port, "::", () => {
  console.log(
    JSON.stringify({
      time: new Date().toISOString(),
      msg: "listening",
      port,
      dataMode: process.env.DATA_MODE ?? "synthetic",
    }),
  );
});
const ticker = core.startTicker();
if (!ticker.active)
  console.log(
    JSON.stringify({
      time: new Date().toISOString(),
      msg: "scheduling off (DATA_MODE is not live)",
    }),
  );

/** One JSON line, like `listening`, so a drain is visible in Railway's logs. */
const say = (msg: string, then?: () => void): void => {
  process.stdout.write(`${JSON.stringify({ time: new Date().toISOString(), msg })}\n`, then);
};

let closing = false;
async function shutdown(): Promise<void> {
  if (closing) return;
  closing = true;
  say("shutdown");
  http.close();
  try {
    await core.close(); // stops the ticker and waits for an in-flight run, capped at DRAIN_CAP_MS
  } catch {
    /* shutting down anyway */
  }
  say("drained", () => process.exit(0)); // exit once the line is out: stdout to a pipe is asynchronous
}
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
