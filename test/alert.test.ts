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

// Email channel (Gmail SMTP). The transport factory is a seam: no test opens a socket.
const EMAIL_ENV = {
  EMAIL_ALERT_RECIPIENT: "owner@example.test",
  ALERT_SMTP_USER: "sender@example.test",
  ALERT_SMTP_PASSWORD: "app-pass-not-real",
};
const mailer = (impl: () => Promise<unknown> = async () => ({})) => {
  const sendMail = vi.fn(impl);
  const createTransport = vi.fn((_options: unknown) => ({ sendMail }));
  return { sendMail, createTransport };
};

test("email only: one sendMail with From, To, Subject and the same body the webhook gets", async () => {
  const f = vi.fn();
  vi.stubGlobal("fetch", f);
  const m = mailer();
  const ok = await createAlerter(EMAIL_ENV, { log: () => {} }, { createTransport: m.createTransport }).alert(
    "run_failed",
    "s 2026-10-19: warehouse_error",
  );
  expect(ok).toBe(true);
  expect(f).not.toHaveBeenCalled();
  expect(m.sendMail).toHaveBeenCalledTimes(1);
  expect(m.sendMail).toHaveBeenCalledWith({
    from: "sender@example.test",
    to: "owner@example.test",
    subject: "Karbon dashboards alert: run_failed",
    text: "run_failed: s 2026-10-19: warehouse_error",
  });
});

test("email defaults to smtp.gmail.com:465 with implicit TLS, and uses STARTTLS on 587", async () => {
  const m = mailer();
  await createAlerter(EMAIL_ENV, { log: () => {} }, { createTransport: m.createTransport }).alert("undelivered", "d");
  expect(m.createTransport.mock.calls[0]![0]).toMatchObject({
    host: "smtp.gmail.com",
    port: 465,
    secure: true,
    auth: { user: "sender@example.test", pass: "app-pass-not-real" },
  });
  const m2 = mailer();
  await createAlerter(
    { ...EMAIL_ENV, ALERT_SMTP_HOST: "smtp.example.test", ALERT_SMTP_PORT: "587" },
    { log: () => {} },
    { createTransport: m2.createTransport },
  ).alert("undelivered", "d");
  expect(m2.createTransport.mock.calls[0]![0]).toMatchObject({ host: "smtp.example.test", port: 587, secure: false, requireTLS: true });
});

test("an SMTP failure resolves false and logs alert_email_failed without address, host or password", async () => {
  const events: unknown[] = [];
  const m = mailer(async () => {
    throw new Error("535 bad credentials for owner@example.test on smtp.gmail.com app-pass-not-real");
  });
  const ok = await createAlerter(EMAIL_ENV, { log: (e) => events.push(e) }, { createTransport: m.createTransport }).alert("undelivered", "d");
  expect(ok).toBe(false);
  expect(events).toEqual([{ kind: "run", verdict: "failed", code: "alert_email_failed" }]);
  expect(JSON.stringify(events)).not.toMatch(/example\.test|gmail|app-pass|535/);
});

test("an SMTP send that never answers times out after 15 s and resolves false", async () => {
  vi.useFakeTimers();
  try {
    const events: unknown[] = [];
    const m = mailer(() => new Promise(() => {}));
    const p = createAlerter(EMAIL_ENV, { log: (e) => events.push(e) }, { createTransport: m.createTransport }).alert("undelivered", "d");
    await vi.advanceTimersByTimeAsync(14_999);
    expect(events).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(2);
    expect(await p).toBe(false);
    expect(events).toEqual([{ kind: "run", verdict: "failed", code: "alert_email_failed" }]);
  } finally {
    vi.useRealTimers();
  }
});

test("both channels: true only when the webhook and the email both accepted", async () => {
  const both = { ...EMAIL_ENV, ALERT_WEBHOOK_URL: "https://hooks.example/x" };
  const run = async (status: number, emailOk: boolean) => {
    const f = vi.fn(async () => new Response("x", { status }));
    vi.stubGlobal("fetch", f);
    const m = mailer(async () => {
      if (!emailOk) throw new Error("smtp");
      return {};
    });
    const ok = await createAlerter(both, { log: () => {} }, { createTransport: m.createTransport }).alert("undelivered", "d");
    expect(f).toHaveBeenCalledTimes(1); // each channel is tried even when the other fails
    expect(m.sendMail).toHaveBeenCalledTimes(1);
    return ok;
  };
  expect(await run(200, true)).toBe(true);
  expect(await run(500, true)).toBe(false);
  expect(await run(200, false)).toBe(false);
  expect(await run(500, false)).toBe(false);
});

test("a partly configured email channel sends nothing by email", async () => {
  const m = mailer();
  const { ALERT_SMTP_PASSWORD: _omit, ...partial } = EMAIL_ENV;
  expect(await createAlerter(partial, { log: () => {} }, { createTransport: m.createTransport }).alert("undelivered", "d")).toBe(true);
  expect(m.createTransport).not.toHaveBeenCalled();
});
