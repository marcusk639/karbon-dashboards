import { DateTime } from "luxon";
import type { Alerter } from "../alert.js";
import { noAudit, type AuditEvent, type AuditRecorder, type AuditSurface } from "../audit.js";
import type { FileUploader } from "../delivery/github.js";
import { checkFilled, fillLayout, type Snapshot } from "../dashboard/fill.js";
import { renderPdf } from "../dashboard/render.js";
import type { ResultTable } from "../data/types.js";
import { runAuditedRequest, type GuardDeps, type RejectCode } from "../guard/run.js";
import { buildQuery, validateRequest } from "../query/build.js";
import type { RunClaim, Schedule, Store } from "../store/db.js";

/**
 * `synthetic` marks every file (and the PDF) so synthetic output cannot pass for live. `uploader` gets a best-effort
 * copy of a produced PDF after its commit (best effort); it never affects the run. `recorder` records each request and
 * the run's outcome, filed as `auditAs` (default: the scheduler's `scheduled_run`); an audit outage never fails a run.
 */
export type RunDeps = GuardDeps & {
  store: Store;
  alerter: Alerter;
  synthetic?: boolean;
  uploader?: FileUploader;
  recorder?: AuditRecorder;
  auditAs?: { surface: AuditSurface; action: string; callerIp?: string };
};

type Started = { at: string; ms(): number };
const recorderOf = (deps: RunDeps): AuditRecorder => deps.recorder ?? noAudit(() => safeNow(deps));

/** The fields every event of this run shares. */
function runFields(
  schedule: Schedule,
  claim: RunClaim,
  deps: RunDeps,
): Pick<AuditEvent, "surface" | "action" | "callerIp" | "scheduleId" | "runId" | "attempt"> {
  const as = deps.auditAs;
  return {
    surface: as?.surface ?? "scheduler",
    action: as?.action ?? "scheduled_run",
    ...(as?.callerIp !== undefined ? { callerIp: as.callerIp } : {}),
    scheduleId: schedule.id,
    runId: claim.runId,
    attempt: claim.attempt,
  };
}

/** The run's summary event (best effort). */
async function noteRun(
  schedule: Schedule,
  claim: RunClaim,
  deps: RunDeps,
  t: Started,
  e: Pick<AuditEvent, "verdict"> & Partial<AuditEvent>,
): Promise<void> {
  try {
    await recorderOf(deps).note({ ...runFields(schedule, claim, deps), at: t.at, durationMs: t.ms(), ...e });
  } catch {
    /* note never throws, but never let the audit break a run */
  }
}

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
const claimLost = async (schedule: Schedule, claim: RunClaim, deps: RunDeps, t: Started): Promise<"failed"> => {
  try {
    deps.log.log({ kind: "run", verdict: "failed", code: "claim_lost" });
  } catch {
    /* logging is best effort */
  }
  await noteRun(schedule, claim, deps, t, { verdict: "failed", code: "claim_lost" });
  return "failed";
};

function safeNow(deps: GuardDeps): Date {
  try {
    return deps.now();
  } catch {
    return new Date();
  }
}

/** Write the NOT PRODUCED notice, finish the run, log and alert. Never throws. A lost claim writes and alerts nothing. */
export async function failRun(
  schedule: Schedule,
  claim: RunClaim,
  periodKey: string,
  code: RejectCode,
  deps: RunDeps,
  fileDate: string = periodKey,
  started?: Started,
): Promise<"rejected" | "failed"> {
  const { store } = deps;
  const t = started ?? recorderOf(deps).begin();
  const fileIds: number[] = [];
  const failed = code === "warehouse_error" || code === "warehouse_login";
  const status = failed ? "failed" : "rejected";
  const c = schedule.cadence;
  const body =
    `No dashboard this week. The run was ${phrase(code)}. The owner has been notified.\n` +
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
      const id = await tx.addFile(claim.runId, notice, at);
      if (!(await tx.finishRun(claim, status, code, at))) throw new ClaimLostError();
      fileIds.push(id);
    });
  } catch (err) {
    fileIds.length = 0; // rolled back
    if (err instanceof ClaimLostError) return claimLost(schedule, claim, deps, t);
    try {
      // Never leave the run "running"; the alert below still goes, unless the run is no longer ours.
      if (!(await store.finishRun(claim, status, code, at))) return claimLost(schedule, claim, deps, t);
    } catch {
      /* nothing more can be done */
    }
  }
  try {
    deps.log.log({ kind: "run", verdict: status, code, scheduleId: schedule.id });
  } catch {
    /* a throwing logger must not break the notice path */
  }
  await noteRun(schedule, claim, deps, t, { verdict: status, code, ...(fileIds.length > 0 ? { fileIds } : {}) });
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

  const audit = recorderOf(deps);
  const t = audit.begin();
  const notice = (code: RejectCode) => failRun(schedule, claim, periodKey, code, deps, fileDate, t);

  try {
    // 1. Every named request, through the guard.
    const results: Record<string, ResultTable> = {};
    const exempt = new Set<string>();
    let queriedAt: string | null = null;
    for (const [name, raw] of Object.entries(schedule.requests)) {
      const { result: r, audit: fields } = await runAuditedRequest(raw, deps);
      await audit.note({ ...runFields(schedule, claim, deps), ...fields });
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
    const fileIds: number[] = [];
    await store.transaction(async (tx) => {
      fileIds.push(await tx.addFile(claim.runId, pdfFile, now));
      fileIds.push(await tx.addFile(
        claim.runId,
        { folder: schedule.slug, filename: `${base}.totals.json`, content: Buffer.from(JSON.stringify(snapshot.totals), "utf8"), contentType: "application/json" },
        now,
      ));
      // A manual run (run_schedule_now) must not become the next scheduled run's comparison base.
      if (!periodKey.startsWith("manual-")) await tx.saveSnapshot(claim.runId, snapshot);
      // Superseded: roll back the files and snapshot too, so only the run's current owner lands anything.
      if (!(await tx.finishRun(claim, "produced", undefined, now))) throw new ClaimLostError();
    });
    const pdfId = fileIds[0]!;
    try {
      deps.log.log({ kind: "run", verdict: "ok", scheduleId: schedule.id });
    } catch {
      /* logging is best effort */
    }
    await noteRun(schedule, claim, deps, t, { verdict: "ok", fileIds, result: { bytes: pdf.length } });
    // Committed and still ours. Not awaited: a slow or failing upload must not hold the run or the ticker.
    try {
      const up = audit.begin();
      void deps.uploader
        ?.upload(pdfFile)
        .then((ok) =>
          audit.note({
            at: up.at, durationMs: up.ms(), surface: "system", action: "github_upload", verdict: ok ? "ok" : "failed",
            scheduleId: schedule.id, runId: claim.runId, attempt: claim.attempt, fileIds: [pdfId],
          }),
        )
        .catch(() => {});
    } catch {
      /* uploaders must not throw, but never let one break a run */
    }
    return "produced";
  } catch (err) {
    if (err instanceof ClaimLostError) return claimLost(schedule, claim, deps, t);
    return await notice("warehouse_error");
  }
}
