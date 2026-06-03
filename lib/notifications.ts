import type { Database } from "bun:sqlite";
import { decrypt } from "./crypto";
import nodemailer from "nodemailer";
import { sendToSelf as tgSendToSelf } from "./telegram-mtproto";
import { t as tt } from "./i18n-server";

export type NotifType = "mention" | "dm" | "assignment" | "comment" | "reminder";

// Mapping: welche Settings-Spalte gilt fuer welchen Notif-Type.
// "comment" alias "mention" (legacy). Neue Types muessen hier eingetragen werden.
const SETTINGS_KEY: Record<NotifType, "mention" | "dm" | "assignment" | "reminder"> = {
  mention: "mention",
  comment: "mention",
  dm: "dm",
  assignment: "assignment",
  reminder: "reminder",
};

export interface NotifyOpts {
  userId: number;          // Empfaenger
  type: NotifType;
  /** Vorab-formatierter Titel — wird verwendet wenn titleKey nicht gesetzt. */
  title?: string;
  /** Vorab-formatierter Body — wird verwendet wenn bodyKey nicht gesetzt. */
  body?: string;
  /** i18n-Key fuer Titel; in Empfaenger-Locale aufgeloest. */
  titleKey?: string;
  titleArgs?: Record<string, string | number>;
  /** i18n-Key fuer Body; in Empfaenger-Locale aufgeloest. */
  bodyKey?: string;
  bodyArgs?: Record<string, string | number>;
  anlageId?: number;
  messageId?: number;
  fromUserId?: number;
  fromUserName?: string;
  url?: string;            // Tiefe Verlinkung
}

/**
 * Schreibt In-App-Notification + sendet ggf. Email + Telegram nach User-Settings.
 * Schluesselt Empfaenger-Settings auf um Channels selektiv zu aktivieren.
 */
export async function notify(db: Database, opts: NotifyOpts): Promise<void> {
  const u = db.prepare(`
    SELECT id, username, email, display_name, active, pref_locale,
      notif_email_mention, notif_email_dm, notif_email_assignment, notif_email_reminder,
      notif_telegram_mention, notif_telegram_dm, notif_telegram_assignment, notif_telegram_reminder,
      telegram_chat_id, telegram_bot_token_enc
    FROM users WHERE id = ?
  `).get(opts.userId) as any;
  if (!u || u.active !== 1) return;

  // ARCHITEKTUR: DB speichert IMMER auf Deutsch (Single-Source-of-Truth / Canonical).
  // Display-Layer (Frontend tr() via Google Translate) uebersetzt zur Anzeigezeit
  // in die User-Locale. Daher: Persistenz fix auf de-DE.
  const persistTitle = opts.titleKey ? tt("de-DE", opts.titleKey, opts.titleArgs) : (opts.title || "");
  const persistBody = opts.bodyKey ? tt("de-DE", opts.bodyKey, opts.bodyArgs) : (opts.body || "");

  // Email/Telegram sollen in der Empfaenger-Sprache rausgehen (1× echte i18n-Resolution).
  const emailLocale = u.pref_locale || "de-DE";
  const channelTitle = opts.titleKey ? tt(emailLocale, opts.titleKey, opts.titleArgs) : (opts.title || "");
  const channelBody = opts.bodyKey ? tt(emailLocale, opts.bodyKey, opts.bodyArgs) : (opts.body || "");

  // 1. In-App immer — gespeichert auf Deutsch.
  try {
    db.prepare(`
      INSERT INTO notifications (user_id, type, title, body, anlage_id, message_id, from_user_id)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(opts.userId, opts.type, persistTitle, persistBody, opts.anlageId ?? null, opts.messageId ?? null, opts.fromUserId ?? null);
  } catch (e) {
    console.error("In-App-Notification-Fehler:", e);
  }

  const settingsKey = SETTINGS_KEY[opts.type];
  const resolvedOpts: NotifyOpts = { ...opts, title: channelTitle, body: channelBody };

  // 2. Email (wenn aktiviert + SMTP des Empfaengers konfiguriert oder fallback)
  const emailEnabled = u[`notif_email_${settingsKey}`] === 1;
  if (emailEnabled && u.email) {
    void sendEmailNotification(db, resolvedOpts, u).catch((e) => console.error("Email-Notify-Fehler:", e));
  }

  // 3. Telegram (wenn aktiviert + Token + chat_id)
  const tgEnabled = u[`notif_telegram_${settingsKey}`] === 1;
  if (tgEnabled && u.telegram_bot_token_enc && u.telegram_chat_id) {
    void sendTelegramNotification(resolvedOpts, u).catch((e) => console.error("Telegram-Notify-Fehler:", e));
  }
}

async function sendEmailNotification(db: Database, opts: NotifyOpts, recipient: any): Promise<void> {
  // Sender: bevorzugt der Sender-User mit eigener SMTP, fallback erster User mit SMTP
  let sender = opts.fromUserId
    ? db.prepare(`
        SELECT email, display_name, username, smtp_host, smtp_port, smtp_secure, smtp_user, smtp_pass_enc, smtp_from_name, smtp_from_email
        FROM users WHERE id = ? AND smtp_host IS NOT NULL
      `).get(opts.fromUserId) as any
    : null;
  if (!sender) {
    sender = db.prepare(`
      SELECT email, display_name, username, smtp_host, smtp_port, smtp_secure, smtp_user, smtp_pass_enc, smtp_from_name, smtp_from_email
      FROM users WHERE smtp_host IS NOT NULL AND smtp_pass_enc IS NOT NULL LIMIT 1
    `).get() as any;
  }
  if (!sender) return; // kein SMTP konfiguriert

  const transport = nodemailer.createTransport({
    host: sender.smtp_host,
    port: sender.smtp_port,
    secure: sender.smtp_secure === 1,
    auth: { user: sender.smtp_user, pass: decrypt(sender.smtp_pass_enc) },
  });
  const fromAddr = sender.smtp_from_email || sender.smtp_user || sender.email;
  const fromName = sender.smtp_from_name || sender.display_name || sender.username || "Solar DB";

  const link = opts.url || (opts.anlageId ? `/?#anlage-${opts.anlageId}` : "/");
  await transport.sendMail({
    from: `"${fromName}" <${fromAddr}>`,
    to: recipient.email,
    subject: `[Solar DB] ${opts.title}`,
    html: `
      <div style="font-family: system-ui, sans-serif; padding: 16px;">
        <h2 style="font-size: 16px; color: #0f172a;">${escapeHtml(opts.title)}</h2>
        <div style="color: #334155; white-space: pre-wrap; padding: 12px; background: #f8fafc; border-left: 3px solid #0284c7; border-radius: 4px;">${escapeHtml(opts.body)}</div>
        <p style="margin-top: 16px; font-size: 13px; color: #64748b;">
          Direkt im System ansehen — Login ${escapeHtml(recipient.username || "")}
        </p>
      </div>
    `,
  });
}

async function sendTelegramNotification(opts: NotifyOpts, recipient: any): Promise<void> {
  const token = decrypt(recipient.telegram_bot_token_enc);
  const chatId = recipient.telegram_chat_id;
  if (!token || !chatId) return;
  const text = `*${opts.title}*\n\n${opts.body}`;
  const url = `https://api.telegram.org/bot${encodeURIComponent(token)}/sendMessage`;
  await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "Markdown", disable_web_page_preview: true }),
  });
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/**
 * Findet @mentions im Text und gibt mentioned_user_ids zurueck.
 * Erkennt @username ODER @vorname (erstes Wort von display_name), case-insensitive.
 * Beispiel: User username='admin', display_name='Emir Mustermann' wird sowohl von @admin als auch @emir gefunden.
 */
export function parseMentions(db: Database, text: string): { username: string; user_id: number }[] {
  if (!text) return [];
  const matches = text.match(/@([a-zA-ZäöüÄÖÜßéèêàâ0-9_-]{2,32})/g);
  if (!matches) return [];
  const tokens = Array.from(new Set(matches.map((m) => m.substring(1).toLowerCase())));
  const result: { username: string; user_id: number }[] = [];
  const seen = new Set<number>();
  for (const t of tokens) {
    // Erster Treffer: exakter username
    let row = db.prepare("SELECT id, username FROM users WHERE LOWER(username) = ? AND active = 1").get(t) as any;
    // Fallback: erstes Wort des display_name
    if (!row) {
      row = db.prepare(`
        SELECT id, username FROM users
        WHERE active = 1 AND display_name IS NOT NULL AND display_name != ''
          AND LOWER(SUBSTR(display_name, 1, INSTR(display_name || ' ', ' ') - 1)) = ?
        LIMIT 1
      `).get(t) as any;
    }
    if (row && !seen.has(row.id)) {
      seen.add(row.id);
      result.push({ username: row.username, user_id: row.id });
    }
  }
  return result;
}
