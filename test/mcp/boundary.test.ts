import { readFileSync } from "node:fs";
import { expect, test } from "vitest";

/** Every module specifier src/mcp/tools.ts pulls in, by any syntax. */
export function specifiers(src: string): string[] {
  const out: string[] = [];
  const re = /(?:from|import|require)\s*\(?\s*['"]([^'"]+)['"]/g;
  for (let m = re.exec(src); m; m = re.exec(src)) out.push(m[1]!);
  return out;
}
export function offending(src: string): string[] {
  return specifiers(src).filter(
    (s) => !(s === "../core/api.js" || s === "zod" || s.startsWith("@modelcontextprotocol/sdk/")),
  );
}

test("MCP layer imports only the CoreApi module, zod and the MCP SDK", () => {
  const src = readFileSync("src/mcp/tools.ts", "utf8");
  expect(specifiers(src).length).toBeGreaterThan(0);
  expect(offending(src)).toEqual([]);
});

test("the checker itself fails on any other relative import (a guard must be seen failing)", () => {
  expect(offending(`import { x } from '../data/types.js';`)).toEqual(["../data/types.js"]);
  expect(offending(`import type { x } from "../guard/run.js"`)).toEqual(["../guard/run.js"]);
  expect(offending(`import "./helper.js"`)).toEqual(["./helper.js"]);
  expect(offending(`const m = await import("../store/db.js")`)).toEqual(["../store/db.js"]);
  expect(offending(`const m = require('../query/build.js')`)).toEqual(["../query/build.js"]);
  expect(offending(`export * from '../config.js'`)).toEqual(["../config.js"]);
  expect(offending(`import { z } from "zod";\nimport type { CoreApi } from "../core/api.js";\nimport { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";`)).toEqual([]);
});
