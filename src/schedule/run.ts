import { DateTime } from "luxon";
import type { Alerter } from "../alert.js";
import type { FileUploader } from "../delivery/github.js";
import { checkFilled, fillLayout, type Snapshot } from "../dashboard/fill.js";
import { renderPdf } from "../dashboard/render.js";
import type { ResultTable } from "../data/types.js";
import { runMenuRequest, type GuardDeps, type RejectCode } from "../guard/run.js";
import { buildQuery, validateRequest } from "../query/build.js";
import type { RunClaim, Schedule, Store } from "../store/db.js";

/**
 * `synthetic` marks every file (and the PDF) so synthetic output cannot pass for live. `uploader` gets a best-effort
 * copy of a produced PDF after its commit (test aid); it never affects the run.
 */
export type RunDeps = GuardDeps & { store: Store; alerter: Alerter; synthetic?: boolean; uploader?: FileUploader };

const prefix = (deps: { synthetic?: boolean }): string => (deps.synthetic ? "SYNTHETIC-" : "");

const MAX_BYTES = 1_048_576;

/**
 * A run's file name stem, before the extension. Scheduled: `<date>-<slug>` (spec §4.8). Manual (run_schedule_now):
 * `<date>-<slug>-manual-<HHmm>` in the schedule's local time, so it never overwrites the scheduled run's files of the
 * same date. No colons: OneDrive rejects them.
 */
export function fileStem(schedule: Schedule, periodKey: string, fileDate: string): string {
  if (!periodKey.startsWith("manual-")) return `${fileDate}-${schedule.slug}`;
  const at = DateTime.fromISO(periodKey.slice("manual-".length), { zone: "utc" }).setZone(schedule.cadence.timezone);
  return `${fileDate}-${schedule.slug}-manual${at.isValid ? `-${at.toFormat("HHmm")}` : ""}`;
}

const phrase = (code: RejectCode): string =>
  code === "client_name" || code === "pattern_match"
    ? "rejected (possible client data)"
    : code === "warehouse_error" || code === "warehouse_login"
      ? `could not complete (${code})`
      : `rejected (${code})`;


/**
 * Thrown inside a run's commit transaction when finishRun finds the claim superseded (the run was recovered and
 * re-claimed elsewhere), so every write of that transaction rolls back.
 */
export class ClaimLostError extends Error {
  constructor() {
    super("run claim lost");
    this.name = "ClaimLostError";
  }
}

/** A process that lost its claim wrote nothing and sends no alert: one log line, and the run counts as failed here. */
const claimLost = (deps: RunDeps): "failed" => {
  try {
    deps.log.log({ kind: "run", verdict: "failed", code: "claim_lost" });
  } catch {
    /* logging is best effort */
  }
  return "failed";
};

const safeNow = (deps: GuardDeps): Date => {
  try {
    return deps.now();
  } catch {
    return new Date();
  }
};

/** Write the NOT PRODUCED notice, finish the run, log and alert. Never throws. A lost claim writes and alerts nothing. */
export async function failRun(
  schedule: Schedule,
  claim: RunClaim,
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
    `No dashboard this week. The run was ${phrase(code)}. the owner has been notified.\n` +
    `Scheduled: ${periodKey} ${c.time} ${c.timezone}`;
  const at = safeNow(deps);
  const notice = {
    folder: schedule.slug,
    filename: `${prefix(deps)}${fileStem(schedule, periodKey, fileDate)} — NOT PRODUCED.txt`,
    content: Buffer.from(body, "utf8"),
    contentType: "text/plain",
  };
  try {
    // The notice and the run's end land together, or neither does.
    await store.transaction(async (tx) => {
      await tx.addFile(claim.runId, notice, at);
      if (!(await tx.finishRun(claim, status, code, at))) throw new ClaimLostError();
    });
  } catch (err) {
    if (err instanceof ClaimLostError) return claimLost(deps);
    try {
      // Never leave the run "running"; the alert below still goes, unless the run is no longer ours.
      if (!(await store.finishRun(claim, status, code, at))) return claimLost(deps);
    } catch {
      /* nothing more can be done */
    }
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
  claim: RunClaim,
  periodKey: string,
  deps: RunDeps,
  fileDate: string = periodKey,
): Promise<"produced" | "rejected" | "failed"> {
  const { store } = deps;
  const base = `${prefix(deps)}${fileStem(schedule, periodKey, fileDate)}`;
  const nowOf = (): Date => {
    try {
      return deps.now();
    } catch {
      return new Date();
    }
  };

  const notice = (code: RejectCode) => failRun(schedule, claim, periodKey, code, deps, fileDate);

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
    const previous = await store.previousSnapshot(schedule.id, fileDate);
    const filled = fillLayout(schedule.layout, results, previous, new Date(queriedAt ?? nowOf().toISOString()), deps.catalog, {
      synthetic: deps.synthetic === true,
    });
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
    const pdfFile = { folder: schedule.slug, filename: `${base}.pdf`, content: pdf, contentType: "application/pdf" };
    await store.transaction(async (tx) => {
      await tx.addFile(claim.runId, pdfFile, now);
      await tx.addFile(
        claim.runId,
        { folder: schedule.slug, filename: `${base}.totals.json`, content: Buffer.from(JSON.stringify(snapshot.totals), "utf8"), contentType: "application/json" },
        now,
      );
      // A manual run (run_schedule_now) must not become the next scheduled run's comparison base.
      if (!periodKey.startsWith("manual-")) await tx.saveSnapshot(claim.runId, snapshot);
      // Superseded: roll back the files and snapshot too, so only the run's current owner lands anything.
      if (!(await tx.finishRun(claim, "produced", undefined, now))) throw new ClaimLostError();
    });
    try {
      deps.log.log({ kind: "run", verdict: "ok", scheduleId: schedule.id });
    } catch {
      /* logging is best effort */
    }
    // Committed and still ours. Not awaited: a slow or failing upload must not hold the run or the ticker.
    try {
      void deps.uploader?.upload(pdfFile).catch(() => {});
    } catch {
      /* uploaders must not throw, but never let one break a run */
    }
    return "produced";
  } catch (err) {
    if (err instanceof ClaimLostError) return claimLost(deps);
    return await notice("warehouse_error");
  }
}
