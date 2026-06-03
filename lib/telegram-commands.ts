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
  if (!u.telegram_bot_token_enc || !u.telegram_chat_id) return { processed: 0, lastUpdateId: u.telegram_last_update_id || 0 };
  const token = decrypt(u.telegram_bot_token_enc);
  const offset = u.telegram_last_update_id || 0;
  const updates = await tgGetUpdates(token, offset);
  let maxId = offset;
  let processed = 0;
  for (const upd of updates) {
    if (upd.update_id > maxId) maxId = upd.update_id;
    const msg = upd.message;
    if (!msg || !msg.text) continue;
    // Nur Nachrichten aus der konfigurierten chat_id akzeptieren (Whitelist-Trust)
    if (String(msg.chat.id) !== String(u.telegram_chat_id)) {
      await tgSend(token, msg.chat.id, "⛔ Dieser Chat ist nicht autorisiert.");
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

export async function pollAllConfiguredUsers(db: Database): Promise<{ users_scanned: number; commands_processed: number }> {
  const users = db.prepare(`
    SELECT id, username, is_admin, is_viewer, active,
      telegram_chat_id, telegram_bot_token_enc, COALESCE(telegram_last_update_id, 0) as telegram_last_update_id
    FROM users
    WHERE active = 1 AND telegram_chat_id IS NOT NULL AND telegram_bot_token_enc IS NOT NULL
  `).all() as AuthorizedUser[];
  let commandsProcessed = 0;
  for (const u of users) {
    try {
      const r = await pollAndHandleUserUpdates(db, u);
      commandsProcessed += r.processed;
    } catch (e) {
      console.error(`[tg-cmd] user ${u.username} failed:`, e);
    }
  }
  return { users_scanned: users.length, commands_processed: commandsProcessed };
}
