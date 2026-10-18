import type { LogEvent } from "../log.js";

/** A best-effort copy of a produced file somewhere else. `upload` never rejects. */
export type FileUploader = {
  upload(f: {
    folder: string;
    filename: string;
    content: Buffer;
    contentType: string;
  }): Promise<void>;
};

const TIMEOUT_MS = 15_000;
const REPO = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;
const MAX_BODY = 4096;

/**
 * True when a 422's JSON `message` names `sha` (GitHub's '"sha" wasn't supplied': the path already holds a file).
 * Reads at most the first MAX_BODY bytes; the text is only inspected here, never logged.
 */
async function shaNotSupplied(res: Response): Promise<boolean> {
  const reader = res.body?.getReader();
  if (!reader) return false;
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (size < MAX_BODY) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.length;
  }
  void reader.cancel().catch(() => {});
  try {
    const text = Buffer.concat(chunks).subarray(0, MAX_BODY).toString("utf8");
    const message: unknown = JSON.parse(text)?.message;
    return typeof message === "string" && /\bsha\b/.test(message);
  } catch {
    return false;
  }
}

/**
 * Test aid (synthetic only, see createCore): PUT each produced PDF to a private GitHub repo via the Contents API.
 * Null when GITHUB_UPLOAD_TOKEN is unset. A 422 whose message names `sha` means the file is already there: it counts
 * as ok and is never overwritten (no sha is sent); any other 422 is a failure. Logs carry a code only: no URL, token,
 * repo, path, filename or response text.
 */
export function createGithubUploader(
  env: {
    GITHUB_UPLOAD_TOKEN?: string | undefined;
    GITHUB_UPLOAD_REPO?: string | undefined;
    GITHUB_UPLOAD_BRANCH?: string | undefined;
  },
  opts: {
    fetch?: typeof fetch;
    log?: (e: LogEvent) => void;
    timeoutMs?: number;
  } = {},
): FileUploader | null {
  const token = (env.GITHUB_UPLOAD_TOKEN ?? "").trim();
  if (token === "") return null; // off: an unused REPO variable must not stop the service
  const repo = (env.GITHUB_UPLOAD_REPO ?? "").trim();
  if (!REPO.test(repo))
    throw new Error("GITHUB_UPLOAD_REPO is required and must be owner/name");
  const branch = (env.GITHUB_UPLOAD_BRANCH ?? "").trim() || "main";
  const doFetch = opts.fetch ?? ((input, init) => fetch(input, init)); // resolved per call, so a stubbed global is seen
  const timeoutMs = opts.timeoutMs ?? TIMEOUT_MS;
  const log = (e: LogEvent): void => {
    try {
      opts.log?.(e);
    } catch {
      /* logging is best effort */
    }
  };
  return {
    async upload(f) {
      const path = `${encodeURIComponent(f.folder)}/${encodeURIComponent(f.filename)}`;
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), timeoutMs);
      try {
        const res = await doFetch(
          `https://api.github.com/repos/${repo}/contents/${path}`,
          {
            method: "PUT",
            headers: {
              Authorization: `Bearer ${token}`,
              Accept: "application/vnd.github+json",
              "X-GitHub-Api-Version": "2022-11-28",
            },
            body: JSON.stringify({
              message: `dashboard: ${f.filename}`,
              content: f.content.toString("base64"),
              branch,
            }),
            signal: ctl.signal,
          },
        );
        const ok =
          res.ok || (res.status === 422 && (await shaNotSupplied(res)));
        void res.body?.cancel().catch(() => {});
        log(
          ok
            ? { kind: "courier", verdict: "ok", code: "github_upload" }
            : {
                kind: "courier",
                verdict: "failed",
                code: "github_upload_failed",
              },
        );
      } catch {
        log({
          kind: "courier",
          verdict: "failed",
          code: "github_upload_failed",
        });
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
