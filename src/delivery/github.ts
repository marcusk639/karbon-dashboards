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

/**
 * Test aid (synthetic only, see createCore): PUT each produced PDF to a private GitHub repo via the Contents API.
 * Null when GITHUB_UPLOAD_TOKEN is unset. A 422 means the file is already there: it counts as ok and is never
 * overwritten (no sha is sent). Logs carry a code only: no URL, token, repo, path, filename or response text.
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
  const repo =
    (env.GITHUB_UPLOAD_REPO ?? "").trim() || "example-owner/claude-dashboards";
  if (!REPO.test(repo))
    throw new Error("GITHUB_UPLOAD_REPO must be owner/name");
  const token = (env.GITHUB_UPLOAD_TOKEN ?? "").trim();
  if (token === "") return null;
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
        void res.body?.cancel().catch(() => {}); // the response text is never read
        const ok = res.ok || res.status === 422;
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
