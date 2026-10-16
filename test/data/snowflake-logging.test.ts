import { expect, test, vi } from "vitest";

const configure = vi.fn();
vi.mock("snowflake-sdk", () => ({ default: { configure, createConnection: vi.fn() } }));

test("importing the module turns the SDK logger off", async () => {
  await import("../../src/data/snowflake.js");
  expect(configure).toHaveBeenCalledTimes(1);
  const opts = configure.mock.calls[0]![0];
  expect(opts.logLevel).toBe("OFF");
  expect(opts.additionalLogToConsole).toBe(false);
  for (const m of ["error", "warn", "info", "debug", "trace"]) expect(typeof opts.customLogger[m]).toBe("function");
});
