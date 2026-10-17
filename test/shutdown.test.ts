import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { expect, test } from "vitest";

const TOKEN = () => randomBytes(24).toString("hex"); // made up per run

/** Start an entry point, wait for `listening`, SIGTERM it, and return its stdout lines once it exits. */
async function terminate(entry: string, env: NodeJS.ProcessEnv): Promise<{ code: number | null; lines: Record<string, unknown>[] }> {
  const proc = spawn("npx", ["tsx", entry], { env, stdio: ["ignore", "pipe", "pipe"], detached: true });
  let out = "";
  proc.stdout!.on("data", (b: Buffer) => (out += b.toString()));
  proc.stderr!.resume();
  const exited = new Promise<number | null>((resolve) => proc.on("exit", (code) => resolve(code)));
  try {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline && !out.includes('"listening"')) await sleep(100);
    expect(out).toContain('"listening"');
    process.kill(-proc.pid!, "SIGTERM"); // the whole group, as Railway signals the container
    const code = await exited;
    const lines = out
      .split("\n")
      .filter((l) => l.startsWith("{"))
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    return { code, lines };
  } finally {
    if (proc.exitCode === null) process.kill(-proc.pid!, "SIGKILL");
  }
}

test.each([
  ["src/api-server.ts", { INTERNAL_API_TOKEN: TOKEN(), PORT: "8796" }],
  ["src/server.ts", { MCP_BEARER_TOKEN: TOKEN(), PORT: "8795" }],
])("%s logs shutdown, then drained, then exits 0", { timeout: 30_000 }, async (entry, vars) => {
  const { code, lines } = await terminate(entry, { PATH: process.env.PATH, HOME: process.env.HOME, DATA_MODE: "synthetic", ...vars });
  const msgs = lines.map((l) => l.msg);
  expect(code).toBe(0);
  expect(msgs.indexOf("shutdown")).toBeGreaterThan(msgs.indexOf("listening"));
  expect(msgs.indexOf("drained")).toBeGreaterThan(msgs.indexOf("shutdown"));
  for (const l of lines.filter((x) => x.msg === "shutdown" || x.msg === "drained")) expect(Object.keys(l).sort()).toEqual(["msg", "time"]);
});
