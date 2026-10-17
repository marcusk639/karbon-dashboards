import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:net";
import { expect, test } from "vitest";

const TOKEN = () => randomBytes(24).toString("hex"); // made up per run

/** Hold a port the way the entries bind it (dual stack), so their listen fails with EADDRINUSE. */
async function holdPort(): Promise<{ port: number; server: Server }> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "::", resolve));
  return { port: (server.address() as { port: number }).port, server };
}

/** Start an entry point and return its exit code and stdout JSON lines once it exits on its own. */
async function runToExit(
  entry: string,
  env: NodeJS.ProcessEnv,
): Promise<{ code: number | null; lines: Record<string, unknown>[] }> {
  const proc = spawn("npx", ["tsx", entry], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  let out = "";
  proc.stdout!.on("data", (b: Buffer) => (out += b.toString()));
  proc.stderr!.resume();
  try {
    const code = await new Promise<number | null>((resolve) =>
      proc.on("exit", (c) => resolve(c)),
    );
    const lines = out
      .split("\n")
      .filter((l) => l.startsWith("{"))
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    return { code, lines };
  } finally {
    if (proc.exitCode === null) process.kill(-proc.pid!, "SIGKILL");
  }
}

// H2: a port already in use must stop the process, not log `listening` and run the scheduler without a listener.
test.each([
  ["src/api-server.ts", { INTERNAL_API_TOKEN: TOKEN() }],
  ["src/server.ts", { MCP_BEARER_TOKEN: TOKEN() }],
  [
    "src/mcp-server.ts",
    {
      MCP_BEARER_TOKEN: TOKEN(),
      INTERNAL_API_TOKEN: TOKEN(),
      CORE_API_URL: "http://127.0.0.1:9",
    },
  ],
])(
  "%s exits 1 with `listen failed` when its port is taken",
  { timeout: 30_000 },
  async (entry, vars) => {
    const { port, server } = await holdPort();
    try {
      const { code, lines } = await runToExit(entry, {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        DATA_MODE: "synthetic",
        PORT: String(port),
        ...vars,
      });
      expect(code).toBe(1);
      const msgs = lines.map((l) => l.msg);
      expect(msgs).not.toContain("listening");
      expect(msgs).not.toContain("scheduling off (DATA_MODE is not live)"); // the ticker never started
      const failed = lines.find((l) => l.msg === "listen failed");
      expect(failed).toMatchObject({
        msg: "listen failed",
        code: "EADDRINUSE",
      });
      expect(Object.keys(failed!).sort()).toEqual(["code", "msg", "time"]);
    } finally {
      server.close();
    }
  },
);
