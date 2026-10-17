import { randomBytes } from "node:crypto";
import { afterEach, expect, test, vi } from "vitest";
import { createHttpCoreApi } from "../../src/api/client.js";

const TOKEN = randomBytes(24).toString("hex"); // made up per run
const BASE = "http://core.test";

type Call = { url: string; init: RequestInit };
function fakeFetch(respond: (c: Call) => Promise<Response>) {
  const calls: Call[] = [];
  const fn = vi.fn((url: string | URL | Request, init?: RequestInit) => {
    const c = { url: String(url), init: init ?? {} };
    calls.push(c);
    return respond(c);
  });
  return { fn: fn as unknown as typeof fetch, calls };
}
const json = (body: unknown, status = 200) =>
  Promise.resolve(
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    }),
  );
/** A fetch that never settles on its own but honours the abort signal, as the real one does. */
const hanging = (c: Call) =>
  new Promise<Response>((_res, rej) => {
    c.init.signal?.addEventListener("abort", () =>
      rej(new DOMException("aborted", "AbortError")),
    );
  });

const noLeak = (v: unknown) => {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  expect(s).not.toContain("core.test");
  expect(s).not.toContain(TOKEN);
};

afterEach(() => {
  vi.useRealTimers();
});

test("sends bearer and args", async () => {
  const f = fakeFetch(() => json({ result: { ok: true } }));
  const api = createHttpCoreApi({ baseUrl: BASE, token: TOKEN, fetch: f.fn });
  expect(await api.pauseSchedule(3, false)).toEqual({ ok: true });
  expect(f.calls).toHaveLength(1);
  const { url, init } = f.calls[0]!;
  expect(url).toBe("http://core.test/v1/pauseSchedule");
  expect(init.method).toBe("POST");
  expect(new Headers(init.headers).get("authorization")).toBe(
    `Bearer ${TOKEN}`,
  );
  expect(init.body).toBe('{"args":[3,false]}');
});

test("API down returns core_unavailable", async () => {
  const f = fakeFetch(() => Promise.reject(new TypeError("fetch failed")));
  const api = createHttpCoreApi({ baseUrl: BASE, token: TOKEN, fetch: f.fn });
  const asked = await api.ask({});
  expect(asked).toEqual({
    status: "rejected",
    code: "core_unavailable",
    detail: "core API unavailable",
  });
  noLeak(asked);
  const paused = await api.pauseSchedule(1, true);
  expect(paused).toEqual({
    ok: false,
    code: "core_unavailable",
    detail: "core API unavailable",
  });
  noLeak(paused);
});

test("non-200 and unparseable bodies return core_unavailable", async () => {
  for (const r of [
    json({ error: "internal" }, 500),
    Promise.resolve(new Response("not json")),
    json({ nope: 1 }),
  ]) {
    const api = createHttpCoreApi({
      baseUrl: BASE,
      token: TOKEN,
      fetch: fakeFetch(() => r).fn,
    });
    expect(await api.deleteSchedule(1)).toMatchObject({
      ok: false,
      code: "core_unavailable",
    });
  }
});

test("a timeout returns core_unavailable", async () => {
  vi.useFakeTimers();
  const api = createHttpCoreApi({
    baseUrl: BASE,
    token: TOKEN,
    fetch: fakeFetch(hanging).fn,
    timeoutMs: 1_000,
  });
  const p = api.previewDashboard({}, {});
  await vi.advanceTimersByTimeAsync(1_001);
  expect(await p).toEqual({
    ok: false,
    code: "core_unavailable",
    detail: "core API unavailable",
  });
});

test("runScheduleNow uses the long timeout", async () => {
  vi.useFakeTimers();
  const api = createHttpCoreApi({
    baseUrl: BASE,
    token: TOKEN,
    fetch: fakeFetch(hanging).fn,
    timeoutMs: 1_000,
    longTimeoutMs: 5_000,
  });
  let settled = false;
  const p = api.runScheduleNow(1).finally(() => {
    settled = true;
  });
  await vi.advanceTimersByTimeAsync(1_001);
  expect(settled).toBe(false);
  await vi.advanceTimersByTimeAsync(4_000);
  expect(await p).toEqual({
    ok: false,
    code: "core_unavailable",
    detail: "core API unavailable",
  });
});

test("a list call that fails throws", async () => {
  const api = createHttpCoreApi({
    baseUrl: BASE,
    token: TOKEN,
    fetch: fakeFetch(() => json({ error: "internal" }, 500)).fn,
  });
  for (const call of [
    () => api.listSchedules(),
    () => api.listRuns(5),
    () => api.listPendingFiles(),
    () => api.listMenu(),
    () => api.getDeliveryTargets(),
  ]) {
    const err = await call().then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(Error);
    noLeak((err as Error).message);
  }
});
