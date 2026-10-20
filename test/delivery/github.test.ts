import { afterEach, expect, test, vi } from "vitest";
import { createGithubUploader } from "../../src/delivery/github.js";
import type { LogEvent } from "../../src/log.js";

const TOKEN = "test-token-not-real";
const REPO = "example-owner/claude-dashboards";
const FILE = {
  folder: "open-work-by-stage",
  filename: "SYNTHETIC-2026-10-19-open-work-by-stage manual.pdf",
  content: Buffer.from("%PDF-1.7 fake"),
  contentType: "application/pdf",
};
const OK: LogEvent[] = [
  { kind: "courier", verdict: "ok", code: "github_upload" },
];
const FAILED: LogEvent[] = [
  { kind: "courier", verdict: "failed", code: "github_upload_failed" },
];

afterEach(() => vi.useRealTimers());

function setup(respond: (signal: AbortSignal) => Promise<Response>) {
  const events: LogEvent[] = [];
  const fetch = vi.fn((_url: string, init: RequestInit) =>
    respond(init.signal!),
  );
  const uploader = createGithubUploader(
    { GITHUB_UPLOAD_TOKEN: TOKEN, GITHUB_UPLOAD_REPO: REPO },
    {
      fetch: fetch as unknown as typeof globalThis.fetch,
      log: (e) => events.push(e),
    },
  )!;
  return { uploader, fetch, events };
}

/** Nothing identifying reaches the log: no token, repo, path or filename. */
function expectClean(events: LogEvent[]): void {
  const text = JSON.stringify(events);
  for (const s of [
    TOKEN,
    "example-owner",
    "claude-dashboards",
    "open-work-by-stage",
    ".pdf",
    "api.github.com",
  ])
    expect(text).not.toContain(s);
}

test("PUTs the PDF to the Contents API of the configured repo and default branch", async () => {
  const { uploader, fetch, events } = setup(
    async () => new Response("{}", { status: 201 }),
  );
  await expect(uploader.upload(FILE)).resolves.toBe(true);
  expect(fetch).toHaveBeenCalledTimes(1);
  const [url, init] = fetch.mock.calls[0]!;
  expect(url).toBe(
    "https://api.github.com/repos/example-owner/claude-dashboards/contents/open-work-by-stage/SYNTHETIC-2026-10-19-open-work-by-stage%20manual.pdf",
  );
  expect(init.method).toBe("PUT");
  expect(init.headers).toEqual({
    Authorization: `Bearer ${TOKEN}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  });
  expect(JSON.parse(init.body as string)).toEqual({
    message: `dashboard: ${FILE.filename}`,
    content: FILE.content.toString("base64"),
    branch: "main",
  });
  expect(events).toEqual(OK);
  expectClean(events);
});

test("honours GITHUB_UPLOAD_REPO and GITHUB_UPLOAD_BRANCH", async () => {
  const fetch = vi.fn(async () => new Response("{}", { status: 201 }));
  await createGithubUploader(
    {
      GITHUB_UPLOAD_TOKEN: TOKEN,
      GITHUB_UPLOAD_REPO: "someone/other.repo",
      GITHUB_UPLOAD_BRANCH: "test",
    },
    { fetch: fetch as unknown as typeof globalThis.fetch, log: () => {} },
  )!.upload(FILE);
  const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
  expect(
    url.startsWith("https://api.github.com/repos/someone/other.repo/contents/"),
  ).toBe(true);
  expect(JSON.parse(init.body as string).branch).toBe("test");
});

test("a non-ASCII filename is percent-encoded as UTF-8 in the path, raw in the message", async () => {
  const { uploader, fetch } = setup(
    async () => new Response("{}", { status: 201 }),
  );
  const filename = "SYNTHETIC-2026-10-19-open-work-by-stage — manual.pdf";
  await uploader.upload({ ...FILE, filename });
  const [url, init] = fetch.mock.calls[0]!;
  expect(url).toBe(
    "https://api.github.com/repos/example-owner/claude-dashboards/contents/open-work-by-stage/SYNTHETIC-2026-10-19-open-work-by-stage%20%E2%80%94%20manual.pdf",
  );
  expect(JSON.parse(init.body as string).message).toBe(`dashboard: ${filename}`);
});

// GitHub's answer for a PUT without sha to a path that already holds a file.
const SHA_422 = JSON.stringify({
  message: 'Invalid request.\n\n"sha" wasn\'t supplied.',
  documentation_url: "https://docs.github.com/rest/repos/contents",
  status: "422",
});

test("a 422 for an existing file (sha not supplied) is logged ok, with no second request and no sha", async () => {
  const { uploader, fetch, events } = setup(
    async () => new Response(SHA_422, { status: 422 }),
  );
  await expect(uploader.upload(FILE)).resolves.toBe(true);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(JSON.parse(fetch.mock.calls[0]![1].body as string)).not.toHaveProperty(
    "sha",
  );
  expect(events).toEqual(OK);
});

test.each([
  ["another message", JSON.stringify({ message: "No commit found for the ref main" })],
  ["no JSON body", "not json"],
  ["an empty body", ""],
  ["sha past the first 4 KB", JSON.stringify({ message: `${"x".repeat(5000)} sha` })],
])("any other 422 (%s) is logged failed", async (_name, body) => {
  const { uploader, events } = setup(
    async () => new Response(body, { status: 422 }),
  );
  await expect(uploader.upload(FILE)).resolves.toBe(false);
  expect(events).toEqual(FAILED);
  expectClean(events);
});

test.each([
  [
    "a 500",
    async () =>
      new Response("boom example-owner/claude-dashboards", { status: 500 }),
  ],
  [
    "a network error",
    async () => {
      throw new Error(`fetch failed ${TOKEN}`);
    },
  ],
])("%s is logged failed and never throws", async (_name, respond) => {
  const { uploader, events } = setup(respond);
  await expect(uploader.upload(FILE)).resolves.toBe(false);
  expect(events).toEqual(FAILED);
  expectClean(events);
});

test("a request that never answers is aborted after 15 s and logged failed", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const { uploader, events } = setup(
    (signal) =>
      new Promise((_resolve, reject) =>
        signal.addEventListener("abort", () => reject(new Error("aborted"))),
      ),
  );
  let settled = false;
  const p = uploader.upload(FILE).then(() => (settled = true));
  await vi.advanceTimersByTimeAsync(14_999);
  expect(settled).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  await p;
  expect(events).toEqual(FAILED);
  expectClean(events);
});

test("a throwing logger does not make upload reject", async () => {
  const uploader = createGithubUploader(
    { GITHUB_UPLOAD_TOKEN: TOKEN, GITHUB_UPLOAD_REPO: REPO },
    {
      fetch: (async () =>
        new Response("{}", {
          status: 500,
        })) as unknown as typeof globalThis.fetch,
      log: () => {
        throw new Error("log down");
      },
    },
  )!;
  await expect(uploader.upload(FILE)).resolves.toBe(false);
});

test("without GITHUB_UPLOAD_TOKEN there is no uploader and no fetch", () => {
  const fetch = vi.fn();
  expect(
    createGithubUploader(
      {},
      { fetch: fetch as unknown as typeof globalThis.fetch },
    ),
  ).toBeNull();
  expect(
    createGithubUploader(
      { GITHUB_UPLOAD_TOKEN: "" },
      { fetch: fetch as unknown as typeof globalThis.fetch },
    ),
  ).toBeNull();
  expect(fetch).not.toHaveBeenCalled();
});

test("a malformed GITHUB_UPLOAD_REPO without a token is ignored: the feature is off", () => {
  expect(createGithubUploader({ GITHUB_UPLOAD_REPO: "not a repo" })).toBeNull();
});

test.each([undefined, "", "  "])(
  "a token without GITHUB_UPLOAD_REPO (%j) is refused, naming the variable only",
  (repo) => {
    let msg = "";
    try {
      createGithubUploader({
        GITHUB_UPLOAD_TOKEN: TOKEN,
        GITHUB_UPLOAD_REPO: repo,
      });
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toContain("GITHUB_UPLOAD_REPO");
    expect(msg).not.toContain(TOKEN);
  },
);

test.each([
  "example-owner",
  "a/b/c",
  "owner/name?x=1",
  "https://github.com/a/b",
  "own er/name",
])(
  "a malformed GITHUB_UPLOAD_REPO (%s) is refused, naming the variable only",
  (repo) => {
    let msg = "";
    try {
      createGithubUploader({
        GITHUB_UPLOAD_TOKEN: TOKEN,
        GITHUB_UPLOAD_REPO: repo,
      });
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toContain("GITHUB_UPLOAD_REPO");
    expect(msg).not.toContain(repo);
    expect(msg).not.toContain(TOKEN);
  },
);
