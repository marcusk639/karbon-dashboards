import { afterEach, expect, test, vi } from "vitest";
import { createAlerter, createHeartbeat } from "../src/alert.js";

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

test("heartbeat GETs the URL with no body and never throws", async () => {
  const f = vi.fn(async () => new Response("ok"));
  vi.stubGlobal("fetch", f);
  await createHeartbeat({ HEARTBEAT_URL: "https://hc.example/ping/abc" })();
  const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
  expect(url).toBe("https://hc.example/ping/abc");
  expect(init.method).toBe("GET");
  expect(init.body).toBeUndefined();
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("net"); }));
  await expect(createHeartbeat({ HEARTBEAT_URL: "https://hc.example/ping/abc" })()).resolves.toBeUndefined();
});

test("heartbeat without a URL does nothing", async () => {
  const f = vi.fn();
  vi.stubGlobal("fetch", f);
  await createHeartbeat({})();
  expect(f).not.toHaveBeenCalled();
});

// H1: the ticker retries an undelivered-file alert whose webhook did not answer 2xx, so alert reports delivery.
test("alert resolves true on a 2xx, false on a non-2xx, a network error or a timeout", async () => {
  const hook = { ALERT_WEBHOOK_URL: "https://hooks.example/x" };
  vi.stubGlobal("fetch", vi.fn(async () => new Response("ok", { status: 200 })));
  expect(await createAlerter(hook, { log: () => {} }).alert("undelivered", "d")).toBe(true);
  vi.stubGlobal("fetch", vi.fn(async () => new Response("no", { status: 500 })));
  expect(await createAlerter(hook, { log: () => {} }).alert("undelivered", "d")).toBe(false);
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("net"); }));
  expect(await createAlerter(hook, { log: () => {} }).alert("undelivered", "d")).toBe(false);
  vi.stubGlobal("fetch", vi.fn(async () => { throw new DOMException("aborted", "AbortError"); }));
  expect(await createAlerter(hook, { log: () => {} }).alert("undelivered", "d")).toBe(false);
});

test("alert without a URL resolves true: the log line is the alert", async () => {
  vi.stubGlobal("fetch", vi.fn());
  expect(await createAlerter({}, { log: () => {} }).alert("undelivered", "d")).toBe(true);
});
