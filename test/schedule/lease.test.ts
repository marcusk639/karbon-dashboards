import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { withLease } from "../../src/schedule/lease.js";
import type { Store } from "../../src/store/db.js";

let touchRun: ReturnType<typeof vi.fn>;
let store: Store;

beforeEach(() => {
  vi.useFakeTimers();
  touchRun = vi.fn(async () => {});
  store = { touchRun } as unknown as Store;
});
afterEach(() => {
  vi.useRealTimers();
});

test("withLease touches every 30 s until fn settles", async () => {
  const p = withLease(store, 7, () => new Promise<string>((res) => setTimeout(() => res("produced"), 95_000)));
  await vi.advanceTimersByTimeAsync(95_000);
  expect(await p).toBe("produced");
  expect(touchRun).toHaveBeenCalledTimes(3);
  expect(touchRun.mock.calls[0]![0]).toBe(7);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(touchRun).toHaveBeenCalledTimes(3);
});

test("a failing touch does not abort the run", async () => {
  touchRun.mockRejectedValue(new Error("store down"));
  const p = withLease(store, 7, () => new Promise<string>((res) => setTimeout(() => res("produced"), 40_000)));
  await vi.advanceTimersByTimeAsync(40_000);
  await expect(p).resolves.toBe("produced");
  expect(touchRun).toHaveBeenCalledTimes(1);
});

test("withLease rethrows fn's error and still stops touching", async () => {
  const p = withLease(store, 7, () => new Promise<string>((_, rej) => setTimeout(() => rej(new Error("boom")), 35_000)));
  const settled = expect(p).rejects.toThrow("boom");
  await vi.advanceTimersByTimeAsync(35_000);
  await settled;
  expect(touchRun).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(120_000);
  expect(touchRun).toHaveBeenCalledTimes(1);
});
