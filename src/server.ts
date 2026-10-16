import { createCore } from "./core/api.js";
import { createApp } from "./http.js";

const core = createCore(process.env);
const app = createApp(core.api, process.env); // throws, and the process exits, if MCP_BEARER_TOKEN is missing or short
const port = Number(process.env.PORT ?? 8787);

const http = app.listen(port, () => {
  console.log(JSON.stringify({ time: new Date().toISOString(), msg: "listening", port, dataMode: process.env.DATA_MODE ?? "synthetic" }));
});
const ticker = core.startTicker();

let closing = false;
async function shutdown(): Promise<void> {
  if (closing) return;
  closing = true;
  ticker.stop();
  http.close();
  await core.close();
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
