import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, expect, test } from "vitest";

const TOKEN = () => randomBytes(24).toString("hex"); // made up per run
const SECRET = "s3cr3t-value";
const FORBIDDEN = [
  "KARBON_SF_USER",
  "KARBON_SF_PASSWORD",
  "DATABASE_URL",
  "DATABASE_CA_CERT",
  "POSTGRES_PASSWORD",
];

/** Built explicitly, never inherited: only what npx needs to run, plus the variables under test. */
const baseEnv = (): NodeJS.ProcessEnv => ({
  PATH: process.env.PATH,
  HOME: process.env.HOME,
  MCP_BEARER_TOKEN: TOKEN(),
  INTERNAL_API_TOKEN: TOKEN(),
  CORE_API_URL: "http://127.0.0.1:9",
});

let child: ChildProcess | undefined;
afterEach(async () => {
  if (child?.pid === undefined || child.exitCode !== null) return;
  const exited = new Promise((resolve) => child!.once("exit", resolve));
  // npx runs tsx runs node: signal the whole process group, or the server outlives the test holding its port.
  process.kill(-child.pid, "SIGKILL");
  await exited;
  child = undefined;
});

function run(env: NodeJS.ProcessEnv): {
  proc: ChildProcess;
  done: Promise<{ code: number | null; stderr: string }>;
} {
  const proc = spawn("npx", ["tsx", "src/mcp-server.ts"], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true, // its own process group, so afterEach can kill the grandchildren too
  });
  let stderr = "";
  proc.stderr!.on("data", (b: Buffer) => (stderr += b.toString()));
  proc.stdout!.resume();
  const done = new Promise<{ code: number | null; stderr: string }>((resolve) =>
    proc.on("exit", (code) => resolve({ code, stderr })),
  );
  return { proc, done };
}

test(
  "mcp server refuses warehouse and database variables",
  { timeout: 10_000 },
  async () => {
    await Promise.all(
      FORBIDDEN.map(async (name) => {
        const { code, stderr } = await run({ ...baseEnv(), [name]: SECRET })
          .done;
        expect(code, name).toBe(1);
        expect(stderr, name).toContain(name);
        expect(stderr, name).not.toContain(SECRET);
      }),
    );
  },
);

test(
  "mcp server starts with only its own variables",
  { timeout: 10_000 },
  async () => {
    // A server left over from an earlier run would make this pass for the wrong reason.
    await expect(fetch("http://127.0.0.1:8798/health")).rejects.toThrow();
    const { proc } = run({ ...baseEnv(), PORT: "8798" });
    child = proc;
    const deadline = Date.now() + 5_000;
    let body = "";
    while (Date.now() < deadline) {
      try {
        const r = await fetch("http://127.0.0.1:8798/health");
        body = await r.text();
        if (r.status === 200) break;
      } catch {
        /* not listening yet */
      }
      await sleep(100);
    }
    expect(body).toBe("ok");
  },
);

/** Every src module loaded at runtime from `entry`; `import type` / `export type` are erased by tsc and skipped. */
function runtimeGraph(entry: string): string[] {
  const seen = new Set<string>();
  const walk = (file: string): void => {
    if (seen.has(file)) return;
    seen.add(file);
    const src = readFileSync(file, "utf8");
    const re = /(?:^|\n)\s*(?:import|export)(?!\s+type\b)[^;]*?from\s*["'](\.[^"']+)["']|import\s*\(?\s*["'](\.[^"']+)["']/g;
    for (const m of src.matchAll(re)) walk(resolve(dirname(file), (m[1] ?? m[2])!.replace(/\.js$/, ".ts")));
  };
  walk(resolve(entry));
  return [...seen].map((f) => relative(process.cwd(), f)).sort();
}

test("mcp server never loads the core or the warehouse driver", () => {
  const graph = runtimeGraph("src/mcp-server.ts");
  expect(graph).toContain("src/api/client.ts");
  expect(graph).not.toContain("src/core/api.ts");
  expect(graph).not.toContain("src/data/snowflake.ts");
  // The walker must see a runtime import when there is one.
  expect(runtimeGraph("src/server.ts")).toContain("src/data/snowflake.ts");
});
