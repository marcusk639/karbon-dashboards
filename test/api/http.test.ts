import request from "supertest";
import { randomBytes } from "node:crypto";
import { beforeEach, expect, test, vi } from "vitest";
import type { CoreApi } from "../../src/core/api.js";
import { CORE_METHODS, createApiApp } from "../../src/api/http.js";

function mockApi() {
  const f = () => vi.fn();
  return {
    listMenu: f(), ask: f(), previewDashboard: f(), createSchedule: f(), listSchedules: f(),
    updateSchedule: f(), pauseSchedule: f(), deleteSchedule: f(), runScheduleNow: f(),
    listRuns: f(), listPendingFiles: f(), markFileDelivered: f(), getDeliveryTargets: f(),
    setDeliveryTarget: f(),
  };
}

const TOKEN = randomBytes(24).toString("hex"); // 48 chars, made up per run

let api: ReturnType<typeof mockApi>;
let app: ReturnType<typeof createApiApp>;
beforeEach(() => {
  api = mockApi();
  app = createApiApp(
    api as unknown as CoreApi,
    { INTERNAL_API_TOKEN: TOKEN },
    { log: () => {} },
  );
});

const call = (
  method: string,
  body: object = { args: [] },
  token: string | null = TOKEN,
) => {
  const r = request(app)
    .post(`/v1/${method}`)
    .set("Content-Type", "application/json");
  return (token === null ? r : r.set("Authorization", `Bearer ${token}`)).send(
    body,
  );
};
const nothingCalled = () => {
  for (const fn of Object.values(api)) expect(fn).not.toHaveBeenCalled();
};

test("CORE_METHODS lists all fourteen CoreApi methods", () => {
  expect([...CORE_METHODS].sort()).toEqual(Object.keys(mockApi()).sort());
});

test("internal API rejects missing and wrong tokens", async () => {
  const none = await call("listRuns", { args: [5] }, null);
  expect(none.status).toBe(401);
  expect(none.text).toBe("");
  const wrong = await call("listRuns", { args: [5] }, "wrong");
  expect(wrong.status).toBe(401);
  expect(wrong.text).toBe("");
  nothingCalled();
});

test("unknown method is 404", async () => {
  for (const m of ["close", "__proto__", "constructor", "toString", "nope"]) {
    const r = await call(m);
    expect(r.status, m).toBe(404);
    expect(r.text, m).toBe("");
  }
  nothingCalled();
});

test("a call passes positional args and returns the result", async () => {
  api.pauseSchedule.mockResolvedValue({ ok: true });
  const r = await call("pauseSchedule", { args: [7, true] });
  expect(r.status).toBe(200);
  expect(r.body).toEqual({ result: { ok: true } });
  expect(api.pauseSchedule).toHaveBeenCalledWith(7, true);
});

test("args that are not an array call with no arguments", async () => {
  api.listSchedules.mockResolvedValue([]);
  const r = await call("listSchedules", { args: "x" });
  expect(r.status).toBe(200);
  expect(api.listSchedules).toHaveBeenCalledWith();
});

test("a domain failure is a 200 result", async () => {
  api.ask.mockResolvedValue({ ok: false, code: "guard", detail: "rejected" });
  const r = await call("ask", { args: [{ measures: ["jobs"] }] });
  expect(r.status).toBe(200);
  expect(r.body).toEqual({
    result: { ok: false, code: "guard", detail: "rejected" },
  });
});

test("a thrown error is a bare 500", async () => {
  api.listRuns.mockRejectedValue(new Error("SELECT secret FROM x"));
  const r = await call("listRuns", { args: [5] });
  expect(r.status).toBe(500);
  expect(r.body).toEqual({ error: "internal" });
  expect(r.text).not.toContain("SELECT");
});

test("a malformed body is a bare 500 with no echo", async () => {
  const r = await request(app)
    .post("/v1/listRuns")
    .set("Authorization", `Bearer ${TOKEN}`)
    .set("Content-Type", "application/json")
    .send("{ SELECT");
  expect(r.status).toBe(500);
  expect(r.body).toEqual({ error: "internal" });
  nothingCalled();
});

test("health needs no token", async () => {
  const r = await request(app).get("/health");
  expect(r.status).toBe(200);
  expect(r.text).toBe("ok");
});

test("short token refuses to build", () => {
  expect(() =>
    createApiApp(api as unknown as CoreApi, {
      INTERNAL_API_TOKEN: "x".repeat(31),
    }),
  ).toThrow(/INTERNAL_API_TOKEN/);
  expect(() => createApiApp(api as unknown as CoreApi, {})).toThrow(
    /INTERNAL_API_TOKEN/,
  );
});

test("unmatched routes are a bare 404", async () => {
  const auth = { Authorization: `Bearer ${TOKEN}` };
  const rs = [
    await request(app).get("/v1/listMenu").set(auth),
    await request(app).post("/v1/").set(auth),
    await request(app).post("/v1/a/b").set(auth),
    await request(app).get("/nope/<script>"),
  ];
  for (const r of rs) {
    expect(r.status).toBe(404);
    expect(r.text).toBe("");
  }
  nothingCalled();
});
