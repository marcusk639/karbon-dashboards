import { afterEach, expect, test, vi } from "vitest";
import { createAlerter } from "../src/alert.js";

afterEach(() => vi.unstubAllGlobals());

test("posts {text} to the webhook", async () => {
  const f = vi.fn(async () => new Response("ok"));
  vi.stubGlobal("fetch", f);
  await createAlerter({ ALERT_WEBHOOK_URL: "https://hooks.example/x" }).alert("run_failed", "s 2026-10-19: warehouse_error");
  expect(f).toHaveBeenCalledTimes(1);
  const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
  expect(url).toBe("https://hooks.example/x");
  expect(JSON.parse(init.body as string)).toEqual({ text: "run_failed: s 2026-10-19: warehouse_error" });
});

test("never throws; falls back to the log", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("net"); }));
  const events: unknown[] = [];
  await createAlerter({ ALERT_WEBHOOK_URL: "https://hooks.example/x" }, { log: (e) => events.push(e) }).alert("undelivered", "d");
  expect(events.length).toBeGreaterThan(0);
});

test("without a URL, only logs", async () => {
  const f = vi.fn();
  vi.stubGlobal("fetch", f);
  const events: unknown[] = [];
  await createAlerter({}, { log: (e) => events.push(e) }).alert("run_rejected", "d");
  expect(f).not.toHaveBeenCalled();
  expect(events).toHaveLength(1);
});
