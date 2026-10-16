import { expect, test } from "vitest";
import { createLogger } from "../src/log.js";

test("logger refuses unknown fields and never prints values", () => {
  const lines: string[] = [];
  const l = createLogger((s) => lines.push(s));
  l.log({ kind: "question", verdict: "rejected", code: "client_name", ...({ value: "Avery Lee" } as any) });
  expect(lines.join()).not.toContain("Avery");
  const o = JSON.parse(lines[0]!);
  expect(o).toMatchObject({ kind: "question", verdict: "rejected", code: "client_name" });
  expect(typeof o.time).toBe("string");
});
