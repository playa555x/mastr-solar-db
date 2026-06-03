// Telegram-Bot-Commands.
// Pro User mit konfiguriertem `telegram_bot_token_enc` + `telegram_chat_id`
// wird `pollAndHandleUserUpdates()` aufgerufen — meist im cron/telegram-listen.ts (alle 30s).
// Kommandos werden gegen die Berechtigungen des jeweiligen Users ausgeführt
// (Mitarbeiter darf Status/Notiz, Admin zusätzlich Owner-Setzen).

import type { Database } from "bun:sqlite";
import { decrypt } from "./crypto";
import { logActivity } from "./activity";

const TG_API = "https://api.telegram.org";

interface TelegramUpdate {
  update_id: number;
  message?: {
    chat: { id: number };
    from?: { id: number; username?: string };
    text?: string;
    date: number;
  };
}

export function ensureTelegramOffsetColumn(db: Database): void {
  try {
    const cols = db.prepare("PRAGMA table_info(users)").all() as any[];
    if (!cols.some((c) => c.name === "telegram_last_update_id")) {
      db.run("ALTER TABLE users ADD COLUMN telegram_last_update_id INTEGER DEFAULT 0");
    }
  } catch (e) {
    console.error("[tg-cmd] ALTER users failed:", e);
  }
}

async function tgSend(token: string, chatId: string | number, text: string): Promise<void> {
  try {
    await fetch(`${TG_API}/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: "Markdown",
        disable_web_page_preview: true,
      }),
    });
  } catch (e) {
    console.error("[tg-cmd] sendMessage failed:", e);
  }
}

async function tgGetUpdates(token: string, offset: number): Promise<TelegramUpdate[]> {
  try {
    const r = await fetch(`${TG_API}/bot${token}/getUpdates?offset=${offset + 1}&timeout=0&allowed_updates=["message"]`);
    if (!r.ok) return [];
    const d = (await r.json()) as any;
    return Array.isArray(d.result) ? d.result : [];
  } catch (e) {
    console.error("[tg-cmd] getUpdates failed:", e);
    return [];
  }
}

const HELP_TEXT = [
  "*Verfügbare Befehle:*",
  "`/help` — diese Übersicht",
  "`/me` — eigene Account-Info",
  "`/find <suchbegriff>` — Anlagen suchen (max. 5)",
  "`/status <mastr> <neuer_status>` — Status einer Anlage setzen",
  "`/note <mastr> <text>` — Notiz an Anlage anhängen",
  "",
  "_MaStR-Nummer in Backticks setzen oder ohne Leerzeichen schreiben._",
].join("\n");

function exec_help(): string { return HELP_TEXT; }

function exec_me(db: Database, userId: number): string {
  const u = db.prepare("SELECT username, display_name, email, is_admin, is_viewer FROM users WHERE id = ?").get(userId) as any;
  if (!u) return "User nicht gefunden.";
  const role = u.is_admin ? "Admin" : u.is_viewer ? "Viewer" : "Mitarbeiter";
  return [
    "*Mein Account*",
    `• Username: \`${u.username}\``,
    `• Anzeigename: ${u.display_name || "—"}`,
    `• Rolle: ${role}`,
    `• E-Mail: ${u.email || "—"}`,
  ].join("\n");
}

function exec_find(db: Database, userId: number, query: string): string {
  const q = `%${query.trim().toLowerCase()}%`;
  if (!query.trim()) return "Bitte einen Suchbegriff angeben. Beispiel: `/find Mustermann`";
  const rows = db.prepare(`
    SELECT mastr_nummer, name, betreiber_name, ort, plz, status, nettonennleistung
    FROM anlagen
    WHERE LOWER(COALESCE(betreiber_name, '')) LIKE ?
       OR LOWER(COALESCE(name, '')) LIKE ?
       OR LOWER(COALESCE(ort, '')) LIKE ?
       OR LOWER(COALESCE(mastr_nummer, '')) LIKE ?
    ORDER BY nettonennleistung DESC LIMIT 5
  `).all(q, q, q, q) as any[];
  if (rows.length === 0) return `Keine Treffer für "${query}".`;
  return rows.map((a) =>
    `• \`${a.mastr_nummer}\` — ${a.betreiber_name || a.name || "?"} · ${a.plz || ""} ${a.ort || ""} · ${a.nettonennleistung ? Math.round(a.nettonennleistung) + " kWp" : "?"} · _${a.status || "neu"}_`
  ).join("\n");
}

function exec_status(db: Database, userId: number, mastr: string, newStatus: string): string {
  if (!mastr || !newStatus) return "Format: `/status MASTR_NUMMER neuer_status`. Status z.B. `kontaktiert`, `terminiert`, `nicht_erreicht`.";
  const allowed = ["neu", "kontaktiert", "nicht_erreicht", "terminiert", "interessiert", "nicht_interessiert", "abgeschlossen", "verloren", "spam"];
  const ns = newStatus.toLowerCase().trim();
  if (!allowed.includes(ns)) return `Status "${ns}" unbekannt. Erlaubt: ${allowed.join(", ")}.`;
  const a = db.prepare("SELECT id, status FROM anlagen WHERE mastr_nummer = ?").get(mastr.trim().toUpperCase()) as any;
  if (!a) return `Anlage \`${mastr}\` nicht gefunden.`;
  const oldStatus = a.status || "neu";
  db.prepare("UPDATE anlagen SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(ns, a.id);
  logActivity(db, a.id, userId, "status_change", `Telegram: ${oldStatus} → ${ns}`, { source: "telegram" });
  return `✅ Status \`${mastr}\` jetzt: *${ns}* (war: ${oldStatus})`;
}

function exec_note(db: Database, userId: number, mastr: string, text: string): string {
  if (!mastr || !text) return "Format: `/note MASTR_NUMMER text...`";
  const a = db.prepare("SELECT id, betreiber_mastr FROM anlagen WHERE mastr_nummer = ?").get(mastr.trim().toUpperCase()) as any;
  if (!a) return `Anlage \`${mastr}\` nicht gefunden.`;
  const noteText = "📱 [Telegram] " + text.trim();
  db.prepare(`
    INSERT INTO notizen (anlage_id, betreiber_mastr, scope, text, user_id, created_at)
    VALUES (?, ?, 'anlage', ?, ?, CURRENT_TIMESTAMP)
  `).run(a.id, a.betreiber_mastr, noteText, userId);
  logActivity(db, a.id, userId, "note_added", `Telegram-Notiz: ${text.substring(0, 100)}`, { source: "telegram" });
  return `✅ Notiz an Anlage \`${mastr}\` angehängt (${text.length} Zeichen).`;
}

interface AuthorizedUser {
  id: number;
  username: string;
  is_admin: number;
  is_viewer: number;
  telegram_chat_id: string;
  telegram_bot_token_enc: string;
  telegram_last_update_id: number;
  active: number;
}

export async function pollAndHandleUserUpdates(db: Database, u: AuthorizedUser): Promise<{ processed: number; lastUpdateId: number }> {
  // Token zwingend erforderlich. chat_id kann beim ersten /start automatisch gelernt werden.
  if (!u.telegram_bot_token_enc) return { processed: 0, lastUpdateId: u.telegram_last_update_id || 0 };
  const token = decrypt(u.telegram_bot_token_enc);
  const offset = u.telegram_last_update_id || 0;
  const updates = await tgGetUpdates(token, offset);
  let maxId = offset;
  let processed = 0;
  let learnedChatId: string | null = u.telegram_chat_id ? String(u.telegram_chat_id) : null;
  for (const upd of updates) {
    if (upd.update_id > maxId) maxId = upd.update_id;
    const msg = upd.message;
    if (!msg || !msg.text) continue;
    const incomingChatId = String(msg.chat.id);
    // Erstkontakt: noch keine chat_id gespeichert → /start lernt sie
    if (!learnedChatId) {
      if (msg.text.trim() === "/start" || msg.text.trim() === "/help") {
        learnedChatId = incomingChatId;
        db.prepare("UPDATE users SET telegram_chat_id = ? WHERE id = ?").run(learnedChatId, u.id);
        await tgSend(token, incomingChatId, `✅ Chat verbunden mit Account *${u.username}*.\n\n${HELP_TEXT}`);
        processed++;
        continue;
      } else {
        await tgSend(token, incomingChatId, "⛔ Erster Kontakt: bitte `/start` senden, um diesen Chat zu verbinden.");
        continue;
      }
    }
    // Whitelist: nur die gespeicherte chat_id darf Commands ausführen
    if (incomingChatId !== learnedChatId) {
      await tgSend(token, incomingChatId, "⛔ Dieser Chat ist nicht autorisiert.");
      continue;
    }
    if (u.active !== 1) {
      await tgSend(token, msg.chat.id, "⛔ Account inaktiv.");
      continue;
    }
    if (u.is_viewer === 1) {
      await tgSend(token, msg.chat.id, "⛔ Viewer-Accounts dürfen keine Schreib-Commands ausführen.");
      continue;
    }
    const text = msg.text.trim();
    let reply: string;
    try {
      if (text === "/help" || text === "/start") reply = exec_help();
      else if (text === "/me") reply = exec_me(db, u.id);
      else if (text.startsWith("/find ")) reply = exec_find(db, u.id, text.slice(6));
      else if (text.startsWith("/status ")) {
        const rest = text.slice(8).trim();
        const m = rest.match(/^(\S+)\s+(\S+)$/);
        reply = m ? exec_status(db, u.id, m[1], m[2]) : "Format: `/status MASTR neuer_status`";
      } else if (text.startsWith("/note ")) {
        const rest = text.slice(6).trim();
        const idx = rest.indexOf(" ");
        if (idx < 0) reply = "Format: `/note MASTR text...`";
        else reply = exec_note(db, u.id, rest.slice(0, idx), rest.slice(idx + 1));
      } else {
        reply = "Unbekannter Befehl. `/help` für Übersicht.";
      }
    } catch (e: any) {
      reply = `❌ Fehler: ${e?.message || String(e)}`;
    }
    await tgSend(token, msg.chat.id, reply);
    processed++;
  }
  if (maxId > offset) {
    db.prepare("UPDATE users SET telegram_last_update_id = ? WHERE id = ?").run(maxId, u.id);
  }
  return { processed, lastUpdateId: maxId };
}

export async function pollAllConfiguredUsers(db: Database): Promise<{ users_scanned: number; commands_processed: number; global_processed: number }> {
  let commandsProcessed = 0;
  let globalProcessed = 0;

  // 1) Pro-User-Bots (Legacy/Multi-Tenant)
  const users = db.prepare(`
    SELECT id, username, is_admin, is_viewer, active,
      COALESCE(telegram_chat_id, '') as telegram_chat_id,
      telegram_bot_token_enc,
      COALESCE(telegram_last_update_id, 0) as telegram_last_update_id
    FROM users
    WHERE active = 1 AND telegram_bot_token_enc IS NOT NULL AND telegram_bot_token_enc != ''
  `).all() as AuthorizedUser[];
  for (const u of users) {
    try {
      const r = await pollAndHandleUserUpdates(db, u);
      commandsProcessed += r.processed;
    } catch (e) {
      console.error(`[tg-cmd] user ${u.username} failed:`, e);
    }
  }

  // 2) Globaler Bot (geteilte Instanz für alle User)
  try {
    globalProcessed = await pollGlobalBot(db);
  } catch (e) {
    console.error("[tg-cmd] global bot failed:", e);
  }

  return { users_scanned: users.length, commands_processed: commandsProcessed, global_processed: globalProcessed };
}

/**
 * Globaler-Bot-Polling: ein einziger Bot bedient alle User. Identifikation
 * pro Nachricht via chat_id → users.telegram_chat_id. Chat-Binding-Flow:
 *   1. User schreibt /start an den globalen Bot
 *   2. Bot antwortet mit dem Klartext-Chat-Code, den der User in Profil → Telegram-Settings einträgt
 *   3. Server verknüpft chat_id mit user_id, ab dann sind Commands autorisiert
 */
export async function pollGlobalBot(db: Database): Promise<number> {
  const tokenRow = db.prepare("SELECT value FROM app_settings WHERE key = 'telegram_global_bot_token_enc'").get() as any;
  if (!tokenRow?.value) return 0;
  const token = decrypt(tokenRow.value);
  const offsetRow = db.prepare("SELECT value FROM app_settings WHERE key = 'telegram_global_last_update_id'").get() as any;
  const offset = parseInt(offsetRow?.value || "0", 10) || 0;
  const updates = await tgGetUpdates(token, offset);
  let maxId = offset;
  let processed = 0;
  for (const upd of updates) {
    if (upd.update_id > maxId) maxId = upd.update_id;
    const msg = upd.message;
    if (!msg || !msg.text) continue;
    const incomingChatId = String(msg.chat.id);
    // chat_id → user?
    const u = db.prepare(`
      SELECT id, username, is_admin, is_viewer, active
      FROM users WHERE telegram_chat_id = ? AND active = 1
    `).get(incomingChatId) as any;
    const text = msg.text.trim();
    if (!u) {
      // Unbekannter Chat — zeige Chat-ID damit der User sie im UI eintragen kann.
      if (text === "/start" || text === "/help") {
        await tgSend(token, incomingChatId, [
          "👋 *Willkommen!*",
          "",
          "Damit dieser Bot dich erkennt, gehe in der CRM:",
          "Profil → Telegram-Settings → *Bot-Chat verbinden*",
          "",
          "Deine Chat-ID:",
          "`" + incomingChatId + "`",
          "",
          "Trage sie ein, dann sind alle Befehle freigeschaltet.",
        ].join("\n"));
      } else {
        await tgSend(token, incomingChatId, "⛔ Dieser Chat ist nicht verknüpft. Sende `/start`, um die Verknüpfungs-Anleitung zu sehen.");
      }
      processed++;
      continue;
    }
    if (u.is_viewer === 1) {
      await tgSend(token, incomingChatId, "⛔ Viewer-Accounts dürfen keine Schreib-Commands ausführen.");
      continue;
    }
    let reply: string;
    try {
      if (text === "/help" || text === "/start") reply = exec_help();
      else if (text === "/me") reply = exec_me(db, u.id);
      else if (text.startsWith("/find ")) reply = exec_find(db, u.id, text.slice(6));
      else if (text.startsWith("/status ")) {
        const rest = text.slice(8).trim();
        const m = rest.match(/^(\S+)\s+(\S+)$/);
        reply = m ? exec_status(db, u.id, m[1], m[2]) : "Format: `/status MASTR neuer_status`";
      } else if (text.startsWith("/note ")) {
        const rest = text.slice(6).trim();
        const idx = rest.indexOf(" ");
        if (idx < 0) reply = "Format: `/note MASTR text...`";
        else reply = exec_note(db, u.id, rest.slice(0, idx), rest.slice(idx + 1));
      } else {
        reply = "Unbekannter Befehl. `/help` für Übersicht.";
      }
    } catch (e: any) {
      reply = `❌ Fehler: ${e?.message || String(e)}`;
    }
    await tgSend(token, incomingChatId, reply);
    processed++;
  }
  if (maxId > offset) {
    db.prepare(`
      INSERT INTO app_settings (key, value) VALUES ('telegram_global_last_update_id', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
    `).run(String(maxId));
  }
  return processed;
}

/**
 * Notify ALL admins (mit gebundenen chat_id) via globalem Bot.
 * Fire-and-forget; Fehler werden geloggt aber nicht propagiert.
 *
 * Pro Admin gibt es die Spalte users.telegram_admin_notify (Default 1).
 * Wenn 0, wird übersprungen.
 */
export async function notifyAdminsViaBot(db: Database, event: string, summary: string): Promise<{ sent: number }> {
  try {
    const tokenRow = db.prepare("SELECT value FROM app_settings WHERE key = 'telegram_global_bot_token_enc'").get() as any;
    if (!tokenRow?.value) return { sent: 0 };
    const token = decrypt(tokenRow.value);
    const admins = db.prepare(`
      SELECT id, username, telegram_chat_id, COALESCE(telegram_admin_notify, 1) as enabled
      FROM users
      WHERE active = 1 AND is_admin = 1
        AND telegram_chat_id IS NOT NULL AND telegram_chat_id != ''
    `).all() as any[];
    let sent = 0;
    for (const a of admins) {
      if (a.enabled !== 1) continue;
      await tgSend(token, a.telegram_chat_id, `*${event}*\n${summary}`);
      sent++;
    }
    return { sent };
  } catch (e) {
    console.error("[tg-cmd] notifyAdmins failed:", e);
    return { sent: 0 };
  }
}

/**
 * Migration für users.telegram_admin_notify (Default 1).
 */
export function ensureAdminNotifyColumn(db: Database): void {
  try {
    const cols = db.prepare("PRAGMA table_info(users)").all() as any[];
    if (!cols.some(c => c.name === "telegram_admin_notify")) {
      db.run("ALTER TABLE users ADD COLUMN telegram_admin_notify INTEGER DEFAULT 1");
    }
  } catch (e) { console.error("[tg-cmd] ALTER users telegram_admin_notify failed:", e); }
}

/**
 * Erzeugt einen kurzen menschenlesbaren Summary-Text für ein Webhook-Event.
 * Falls Event unbekannt: JSON-Stringify der Daten (max 300 Zeichen).
 */
export function formatEventSummary(event: string, data: any): string {
  try {
    switch (event) {
      case "lead.created":
        return `📩 Neuer Lead *${data.ticket || data.lead_id}* — ${data.name || "?"}${data.firma ? ` (${data.firma})` : ""}\n${data.email || ""}${data.telefon ? " · " + data.telefon : ""}${data.plz || data.ort ? `\n📍 ${data.plz || ""} ${data.ort || ""}`.trim() : ""}${data.anlagen_leistung_kwp ? `\n☀️ ${data.anlagen_leistung_kwp} kWp` : ""}${data.matched_anlage_id ? `\n🔗 Anlage #${data.matched_anlage_id}` : ""}`;
      case "anfrage.received":
        return `📩 Check-Anfrage *${data.ticket || data.lead_id}* — ${data.name || "?"}${data.interest ? ` · ${data.interest}` : ""}\n${data.email || ""}${data.telefon ? " · " + data.telefon : ""}${data.matched_anlage_id ? `\n🔗 Anlage #${data.matched_anlage_id}` : ""}`;
      case "anlage.status_changed":
        return `🔁 Anlage *${data.mastr_nummer || "#" + data.anlage_id}*: \`${data.old_status || "neu"}\` → *${data.new_status}*\nvon ${data.changed_by?.username || "?"}`;
      case "anlage.owner_changed":
        return `👤 Anlage *#${data.anlage_id}*: Owner → ${data.new_owner_name || (data.new_owner_id ? "#" + data.new_owner_id : "—")}\nvon ${data.changed_by?.username || "?"}`;
      case "mention.created":
        return `📣 @${data.from?.username || "?"} markierte *@${data.to?.username || "?"}* in Anlage ${data.anlage_label || "?"}\n${(data.text || "").substring(0, 200)}`;
      case "termin.created":
        return `📅 Termin *${data.title}* am ${data.start?.slice(0, 16)?.replace("T", " ") || "?"}${data.location ? `\n📍 ${data.location}` : ""}${data.anlage_id ? `\n🔗 Anlage #${data.anlage_id}` : ""}\nvon ${data.created_by?.username || "?"}`;
      case "reminder.due":
        return `⏰ Reminder fällig — Kunde *${data.betreiber_name || data.betreiber_mastr}*\n${data.note || ""}\nfür User #${data.owner_user_id}`;
      default:
        const s = JSON.stringify(data);
        return s.length > 300 ? s.substring(0, 300) + "…" : s;
    }
  } catch {
    return event + " (Daten nicht lesbar)";
  }
}

/**
 * Bot-API Test — sendet eine Test-Nachricht an die konfigurierte chat_id.
 * Liefert getMe-Result (Bot-Name) bei Erfolg.
 */
export async function testBot(db: Database, userId: number): Promise<{ ok: boolean; bot?: any; error?: string }> {
  const u = db.prepare(`
    SELECT telegram_bot_token_enc, telegram_chat_id, display_name, username
    FROM users WHERE id = ?
  `).get(userId) as any;
  if (!u?.telegram_bot_token_enc) return { ok: false, error: "Bot-Token nicht gesetzt. Settings → Telegram → Bot-Token eintragen." };
  const token = decrypt(u.telegram_bot_token_enc);
  try {
    const meR = await fetch(`${TG_API}/bot${token}/getMe`);
    const me = (await meR.json()) as any;
    if (!me.ok) return { ok: false, error: `getMe: ${me.description || "Token ungültig"}` };
    if (!u.telegram_chat_id) {
      return { ok: false, bot: me.result, error: "Bot OK, aber kein Chat verbunden. Sende `/start` an @" + me.result.username };
    }
    await tgSend(token, u.telegram_chat_id, `✅ *Test*\nBot \`@${me.result.username}\` erreicht Chat von *${u.display_name || u.username}*.`);
    return { ok: true, bot: me.result };
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) };
  }
}
