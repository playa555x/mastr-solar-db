import nodemailer from "nodemailer";
import type { Database } from "bun:sqlite";
import { decrypt } from "./crypto";

export interface UserSmtpRow {
  smtp_host: string | null;
  smtp_port: number | null;
  smtp_secure: number | null;
  smtp_user: string | null;
  smtp_pass_enc: string | null;
  smtp_from_name: string | null;
  smtp_from_email: string | null;
}

export function hasOwnSmtp(user: UserSmtpRow): boolean {
  return !!(user.smtp_host && user.smtp_port && user.smtp_user && user.smtp_pass_enc);
}

export function buildTransport(user: UserSmtpRow) {
  if (!hasOwnSmtp(user)) {
    throw new Error("SMTP nicht konfiguriert. Bitte unter Einstellungen einrichten.");
  }
  const pass = decrypt(user.smtp_pass_enc!);
  return nodemailer.createTransport({
    host: user.smtp_host!,
    port: user.smtp_port!,
    secure: user.smtp_secure === 1,
    auth: { user: user.smtp_user!, pass },
  });
}

/**
 * Smart SMTP-Resolver mit Auto-Fallback auf Admin-SMTP:
 *   1. Wenn user.smtp_* gesetzt → eigener Transport
 *   2. Sonst: lade Admin-Row (is_admin=1 oder username='admin') → nutze dessen SMTP
 *   3. Im "from": IMMER die Email/Name des urspruenglichen Users (Reply-To bleibt korrekt)
 *
 * Damit kann jeder User Mails versenden ohne eigene SMTP-Konfig.
 * Voraussetzung: Admin-SMTP-Provider erlaubt "Send-As" oder hat ein Reply-To-Header-Feld.
 * Bei IONOS: from MUSS = login sein, daher setzen wir from=admin.from + reply-to=user.email.
 */
export function buildTransportWithFallback(db: Database, user: UserSmtpRow & { id?: number; username?: string; email?: string; display_name?: string | null }) {
  // 1. Eigene SMTP-Config
  if (hasOwnSmtp(user)) {
    return { transport: buildTransport(user), effectiveFrom: fromAddress(user), replyTo: null as string | null, fallback: false };
  }
  // 2. Admin-Fallback
  const admin = db.prepare(`
    SELECT id, username, email, display_name,
      smtp_host, smtp_port, smtp_secure, smtp_user, smtp_pass_enc,
      smtp_from_name, smtp_from_email
    FROM users WHERE active = 1 AND (is_admin = 1 OR username = 'admin')
    ORDER BY id ASC LIMIT 1
  `).get() as any;
  if (!admin || !hasOwnSmtp(admin)) {
    throw new Error("Weder eigene SMTP noch Admin-SMTP konfiguriert. Bitte Admin einrichtet IONOS/SMTP in Einstellungen.");
  }
  // From muss = Admin-SMTP-Login sein (IONOS-Pflicht), aber wir setzen Reply-To auf User-Email
  const adminFromName = user.display_name || user.username || admin.smtp_from_name || "Repowering DE";
  const adminFromEmail = admin.smtp_from_email || admin.smtp_user;
  const effectiveFrom = `"${String(adminFromName).replace(/"/g, "")}" <${adminFromEmail}>`;
  const replyTo = user.email || null;
  return { transport: buildTransport(admin), effectiveFrom, replyTo, fallback: true };
}

export function fromAddress(user: UserSmtpRow & { email?: string; display_name?: string | null }): string {
  const email = user.smtp_from_email || user.smtp_user || (user as any).email;
  const name = user.smtp_from_name || (user as any).display_name || "";
  return name ? `"${name.replace(/"/g, "")}" <${email}>` : email;
}

export function renderTemplate(tpl: string, vars: Record<string, string | number | undefined | null>): string {
  let out = tpl;
  for (const [k, v] of Object.entries(vars)) {
    const val = v === null || v === undefined ? "" : String(v);
    out = out.replace(new RegExp(`{{\\s*${k}\\s*}}`, "g"), val);
  }
  return out;
}

/**
 * TEST-MODE-Wrapper fuer ausgehende Mails. Wenn `test_mode_email` in app_settings
 * gesetzt ist (= NICHT leer), wird:
 *   - tatsaechlicher Empfaenger ueberschrieben mit test_mode_email
 *   - Original-Empfaenger als Tag im Betreff sichtbar: "[TESTMODE → orig@example.com]"
 *   - Original-To in Body als Banner oben einfaerbt
 * Wenn test_mode_email leer/NULL ist -> normaler Versand.
 */
export function applyTestModeOverride(
  testModeEmail: string | null | undefined,
  mailOpts: { to: string; subject?: string; html?: string; text?: string; [k: string]: any },
): { to: string; subject?: string; html?: string; text?: string; [k: string]: any } {
  const tm = (testModeEmail || "").trim();
  if (!tm) return mailOpts; // kein Test-Modus
  const origTo = mailOpts.to;
  const subject = `[TESTMODE → ${origTo}] ${mailOpts.subject || ""}`.trim();
  const banner = `<div style="background:#fee2e2;border:1px solid #ef4444;color:#991b1b;padding:10px 14px;border-radius:6px;margin:0 0 16px 0;font-family:Arial,sans-serif;font-size:13px;">
    <strong>⚠ TEST-MODUS aktiv:</strong> Diese Mail wäre eigentlich an <strong>${origTo}</strong> gegangen. Test-Empfänger: <strong>${tm}</strong>. Im Settings-Tab abschalten: <code>test_mode_email</code> auf leer setzen.
  </div>`;
  return {
    ...mailOpts,
    to: tm,
    subject,
    html: mailOpts.html ? banner + mailOpts.html : banner,
    text: mailOpts.text ? `[TESTMODE → ${origTo}]\n\n` + mailOpts.text : `[TESTMODE → ${origTo}]`,
  };
}
