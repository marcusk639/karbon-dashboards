import type { Alerter } from "../alert.js";
import { checkFilled, fillLayout, type Snapshot } from "../dashboard/fill.js";
import { renderPdf } from "../dashboard/render.js";
import type { ResultTable } from "../data/types.js";
import { runMenuRequest, type GuardDeps, type RejectCode } from "../guard/run.js";
import { buildQuery, validateRequest } from "../query/build.js";
import type { Schedule, Store } from "../store/db.js";

export type RunDeps = GuardDeps & { store: Store; alerter: Alerter };

const MAX_BYTES = 1_048_576;

const phrase = (code: RejectCode): string =>
  code === "client_name" || code === "pattern_match"
    ? "rejected (possible client data)"
    : code === "warehouse_error" || code === "warehouse_login"
      ? `could not complete (${code})`
      : `rejected (${code})`;


const safeNow = (deps: GuardDeps): Date => {
  try {
    return deps.now();
  } catch {
    return new Date();
  }
};

/** Write the NOT PRODUCED notice, finish the run, log and alert. Never throws. */
export async function failRun(
  schedule: Schedule,
  runId: number,
  periodKey: string,
  code: RejectCode,
  deps: RunDeps,
  fileDate: string = periodKey,
): Promise<"rejected" | "failed"> {
  const { store } = deps;
  const failed = code === "warehouse_error" || code === "warehouse_login";
  const status = failed ? "failed" : "rejected";
  const c = schedule.cadence;
  const body =
    `No dashboard this week. The run was ${phrase(code)}. Marcus has been notified.\n` +
    `Scheduled: ${periodKey} ${c.time} ${c.timezone}`;
  try {
    store.addFile(
      runId,
      { folder: schedule.slug, filename: `${fileDate}-${schedule.slug} — NOT PRODUCED.txt`, content: Buffer.from(body, "utf8"), contentType: "text/plain" },
      safeNow(deps),
    );
  } catch {
    /* still finish the run and alert below */
  }
  try {
    store.finishRun(runId, status, code, safeNow(deps));
  } catch {
    /* nothing more can be done */
  }
  try {
    deps.log.log({ kind: "run", verdict: status, code, scheduleId: schedule.id });
  } catch {
    /* a throwing logger must not break the notice path */
  }
  try {
    await deps.alerter.alert(failed ? "run_failed" : "run_rejected", `${schedule.slug} ${periodKey}: ${code}`);
  } catch {
    /* alerters must not throw, but never let one break a run */
  }
  return status;
}

export async function executeScheduledRun(
  schedule: Schedule,
  runId: number,
  periodKey: string,
  deps: RunDeps,
  fileDate: string = periodKey,
): Promise<"produced" | "rejected" | "failed"> {
  const { store } = deps;
  const base = `${fileDate}-${schedule.slug}`;
  const nowOf = (): Date => {
    try {
      return deps.now();
    } catch {
      return new Date();
    }
  };

  const notice = (code: RejectCode) => failRun(schedule, runId, periodKey, code, deps, fileDate);

  try {
    // 1. Every named request, through the guard.
    const results: Record<string, ResultTable> = {};
    const exempt = new Set<string>();
    let queriedAt: string | null = null;
    for (const [name, raw] of Object.entries(schedule.requests)) {
      const r = await runMenuRequest(raw, deps);
      if (r.status === "rejected") return await notice(r.code);
      results[name] = r.table;
      if (queriedAt === null || r.queriedAt > queriedAt) queriedAt = r.queriedAt;
      const q = buildQuery(validateRequest(raw, deps.catalog), deps.catalog, deps.labels);
      for (const s of q.exemptStrings) exempt.add(s);
    }

    // 3. Fill and check.
    const previous = store.previousSnapshot(schedule.id, fileDate);
    const filled = fillLayout(schedule.layout, results, previous, new Date(queriedAt ?? nowOf().toISOString()), deps.catalog);
    const check = await checkFilled(filled, exempt, { names: deps.names });
    if (!check.ok) return await notice(check.code);

    // 4. Render.
    const pdf = await renderPdf(filled);
    if (pdf.length >= MAX_BYTES) {
      deps.log.log({ kind: "run", verdict: "failed", code: "warehouse_error", scheduleId: schedule.id });
      return await notice("warehouse_error"); // pdf too large
    }

    // 5. Store.
    const snapshot: Snapshot = { periodKey: fileDate, totals: results };
    const now = nowOf();
    store.transaction(() => {
      store.addFile(runId, { folder: schedule.slug, filename: `${base}.pdf`, content: pdf, contentType: "application/pdf" }, now);
      store.addFile(
        runId,
        { folder: schedule.slug, filename: `${base}.totals.json`, content: Buffer.from(JSON.stringify(snapshot.totals), "utf8"), contentType: "application/json" },
        now,
      );
      store.saveSnapshot(runId, snapshot);
      store.finishRun(runId, "produced", undefined, now);
    });
    try {
      deps.log.log({ kind: "run", verdict: "ok", scheduleId: schedule.id });
    } catch {
      /* logging is best effort */
    }
    return "produced";
  } catch {
    return await notice("warehouse_error");
  }
}
