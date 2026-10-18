import nodemailer from "nodemailer";
import type SMTPTransport from "nodemailer/lib/smtp-transport/index.js";
import type { Logger } from "./log.js";

export type AlertKind = "run_rejected" | "run_failed" | "undelivered";

export interface Alerter {
  /**
   * `detail` must never contain data values. Resolves true when every configured channel accepted the alert: the
   * webhook answered 2xx and/or the email was sent; with no channel configured the log line is the alert. False when
   * any channel failed (non-2xx, SMTP error, timeout, network error). Never throws.
   */
  alert(kind: AlertKind, detail: string): Promise<boolean>;
}

type AlertEnv = {
  ALERT_WEBHOOK_URL?: string | undefined;
  EMAIL_ALERT_RECIPIENT?: string | undefined;
  ALERT_SMTP_USER?: string | undefined;
  ALERT_SMTP_PASSWORD?: string | undefined;
  ALERT_SMTP_HOST?: string | undefined;
  ALERT_SMTP_PORT?: string | undefined;
};

/** The transport factory is a seam: tests inject one so no socket is opened. */
export type MailTransport = { sendMail(message: { from: string; to: string; subject: string; text: string }): Promise<unknown> };
export type AlerterOptions = { createTransport?: (options: SMTPTransport.Options) => MailTransport };

const EMAIL_VARS = ["EMAIL_ALERT_RECIPIENT", "ALERT_SMTP_USER", "ALERT_SMTP_PASSWORD"] as const;
const set = (v: string | undefined): v is string => (v ?? "").trim() !== "";

/** Names of the email variables not set. All three missing means no email channel; some missing is a half-configured one. */
export const missingEmailVars = (env: AlertEnv): string[] => EMAIL_VARS.filter((n) => !set(env[n]));
export const hasWebhookChannel = (env: AlertEnv): boolean => set(env.ALERT_WEBHOOK_URL);
export const hasEmailChannel = (env: AlertEnv): boolean => missingEmailVars(env).length === 0;

const TIMEOUT_MS = 10_000;
const EMAIL_TIMEOUT_MS = 15_000;

export function createAlerter(
  env: AlertEnv,
  log: Logger = { log: (e) => console.log(JSON.stringify(e)) },
  opts: AlerterOptions = {},
): Alerter {
  const url = set(env.ALERT_WEBHOOK_URL) ? env.ALERT_WEBHOOK_URL : undefined;
  // LogEvent is whitelisted, so the alert goes to the log as a 'run' event without free text.
  const record = (kind: AlertKind): void =>
    log.log({ kind: "run", verdict: kind === "run_rejected" ? "rejected" : "failed" });

  const email = hasEmailChannel(env) ? env : undefined;
  const port = Number(env.ALERT_SMTP_PORT) || 465;
  const transport = email
    ? (opts.createTransport ?? ((o: SMTPTransport.Options) => nodemailer.createTransport(o)))({
        host: set(env.ALERT_SMTP_HOST) ? env.ALERT_SMTP_HOST : "smtp.gmail.com",
        port,
        secure: port !== 587, // 465 is implicit TLS; 587 upgrades with STARTTLS, which is required
        requireTLS: port === 587,
        auth: { user: email.ALERT_SMTP_USER!, pass: email.ALERT_SMTP_PASSWORD! },
        connectionTimeout: EMAIL_TIMEOUT_MS,
        greetingTimeout: EMAIL_TIMEOUT_MS,
        socketTimeout: EMAIL_TIMEOUT_MS,
      })
    : undefined;

  async function sendWebhook(kind: AlertKind, detail: string, hook: string): Promise<boolean> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(hook, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: `${kind}: ${detail}` }),
        signal: ctl.signal,
      });
      if (!res.ok) record(kind);
      return res.ok;
    } catch {
      record(kind);
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  async function sendEmail(kind: AlertKind, detail: string): Promise<boolean> {
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        transport!.sendMail({
          from: email!.ALERT_SMTP_USER!,
          to: email!.EMAIL_ALERT_RECIPIENT!,
          subject: `Karbon dashboards alert: ${kind}`,
          text: `${kind}: ${detail}`,
        }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("timeout")), EMAIL_TIMEOUT_MS);
        }),
      ]);
      return true;
    } catch {
      // Never the error: SMTP responses can echo the address, host or user.
      log.log({ kind: "run", verdict: "failed", code: "alert_email_failed" });
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async alert(kind, detail) {
      if (!url && !transport) {
        record(kind);
        return true;
      }
      const results = await Promise.all([url ? sendWebhook(kind, detail, url) : true, transport ? sendEmail(kind, detail) : true]);
      return results.every(Boolean);
    },
  };
}

/**
 * Dead-man's-switch ping (e.g. a Healthchecks-style URL): a bare GET with no body, so nothing about a
 * run leaves the service. The external monitor alerts if no ping arrives by ~08:30 CT on Mondays.
 * Never throws; a missing HEARTBEAT_URL makes it a no-op.
 */
export function createHeartbeat(env: { HEARTBEAT_URL?: string | undefined }): () => Promise<void> {
  const url = env.HEARTBEAT_URL;
  return async () => {
    if (!url) return;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    try {
      await fetch(url, { method: "GET", signal: ctl.signal });
    } catch {
      /* the monitor's silence is the alert */
    } finally {
      clearTimeout(timer);
    }
  };
}
