import { createCore } from "./core/api.js";
import { setTimeout as sleep } from "node:timers/promises";
import { createApp } from "./http.js";
import { DRAIN_CAP_MS } from "./schedule/ticker.js";

// Check the token first: a bad one must never open the store or read warehouse credentials.
if ((process.env.MCP_BEARER_TOKEN ?? "").length < 32) {
  console.error("MCP_BEARER_TOKEN must be set to at least 32 characters");
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
const app = createApp(core.api, process.env);
const port = Number(process.env.PORT ?? 8787);

const http = app.listen(port, () => {
  console.log(JSON.stringify({ time: new Date().toISOString(), msg: "listening", port, dataMode: process.env.DATA_MODE ?? "synthetic" }));
});
const ticker = core.startTicker();
if (!ticker.active)
  console.log(JSON.stringify({ time: new Date().toISOString(), msg: "scheduling off (DATA_MODE is not live)" }));

let closing = false;
async function shutdown(): Promise<void> {
  if (closing) return;
  closing = true;
  await Promise.race([ticker.stop(), sleep(DRAIN_CAP_MS, undefined, { ref: false })]);
  http.close();
  try {
    await core.close();
  } catch {
    /* shutting down anyway */
  }
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
