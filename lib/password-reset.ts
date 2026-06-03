// Self-Service-Passwort-Reset via Email-Token.
// Flow:
//   1) POST /api/auth/forgot-password { email }
//      → Token erstellt, gehasht in password_resets.
//      → Mail mit Link /?reset=<token> an User. Response IMMER {success:true}, egal ob Email existiert
//        (Email-Enumeration verhindern).
//   2) POST /api/auth/reset-password { token, new_password }
//      → Hash vergleichen, Ablauf prüfen, neues Passwort setzen.
//      → Token wird used_at-markiert (kein Re-Use).
//
// Sicherheit:
//   - Token = 32 random bytes (base64url). Wird hashed gespeichert (SHA-256).
//   - TTL 60 Minuten.
//   - Bei Reset werden alle bestehenden Sessions des Users invalidiert.
//   - Rate-Limit pro IP (5/h) verhindert Spam.

import { randomBytes, createHash } from "node:crypto";
import type { Database } from "bun:sqlite";

const TTL_MS = 60 * 60 * 1000;
const TOKEN_PREFIX = "msrst_";

export function ensurePasswordResetTable(db: Database): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS password_resets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      token_hash TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      used_at TEXT,
      ip_created TEXT,
      ip_used TEXT,
      FOREIGN KEY (user_id) REFERENCES users(id)
    )
  `);
  db.run("CREATE INDEX IF NOT EXISTS idx_password_resets_hash ON password_resets(token_hash)");
  db.run("CREATE INDEX IF NOT EXISTS idx_password_resets_user ON password_resets(user_id)");
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Erstellt einen Reset-Token für die Email, falls ein User existiert.
 * Liefert IMMER ein Token-Klartext (auch wenn der User nicht existiert, returnen wir ein Pseudotoken — der Server-Endpoint
 * sollte aber die Mail nur senden, wenn user!=null). Hier wird zentral entschieden:
 *   - returns { token: string | null, user_id: number | null, email_used: string }
 */
export function createPasswordReset(
  db: Database,
  emailRaw: string,
  ip: string | null,
): { token: string | null; user_id: number | null; email_used: string } {
  const email = (emailRaw || "").trim().toLowerCase();
  if (!email || !email.includes("@")) return { token: null, user_id: null, email_used: email };
  const user = db.prepare("SELECT id, email FROM users WHERE LOWER(email) = ? AND active = 1").get(email) as any;
  if (!user) return { token: null, user_id: null, email_used: email };
  const secret = randomBytes(32).toString("base64url");
  const token = TOKEN_PREFIX + secret;
  const hash = hashToken(token);
  const expires = new Date(Date.now() + TTL_MS).toISOString();
  db.prepare(`
    INSERT INTO password_resets (user_id, token_hash, expires_at, ip_created)
    VALUES (?, ?, ?, ?)
  `).run(user.id, hash, expires, ip);
  return { token, user_id: user.id, email_used: user.email };
}

/**
 * Token einlösen → setzt neues Passwort. Wirft Error bei ungültigem oder abgelaufenem Token.
 * Sessions des Users werden außerhalb invalidiert (per cleanupExpiredSessions o.ä.).
 */
export function consumePasswordReset(
  db: Database,
  token: string,
  newPasswordHash: string,
  ip: string | null,
): { user_id: number } {
  const hash = hashToken(token);
  const row = db.prepare(`
    SELECT id, user_id, expires_at, used_at FROM password_resets WHERE token_hash = ?
  `).get(hash) as any;
  if (!row) throw new Error("Token ungueltig");
  if (row.used_at) throw new Error("Token bereits verwendet");
  if (new Date(row.expires_at).getTime() < Date.now()) throw new Error("Token abgelaufen");
  db.prepare(`UPDATE users SET password_hash = ? WHERE id = ?`).run(newPasswordHash, row.user_id);
  db.prepare(`UPDATE password_resets SET used_at = CURRENT_TIMESTAMP, ip_used = ? WHERE id = ?`)
    .run(ip, row.id);
  // alle Sessions des Users killen — neuer Login erforderlich
  db.prepare(`DELETE FROM sessions WHERE user_id = ?`).run(row.user_id);
  return { user_id: row.user_id };
}

// Rate-Limit: max 5 Forgot-Requests pro IP pro Stunde
const ipBuckets = new Map<string, { count: number; reset: number }>();
export function checkForgotRate(ip: string | null): boolean {
  if (!ip) return true;
  const now = Date.now();
  const e = ipBuckets.get(ip);
  if (!e || e.reset < now) {
    ipBuckets.set(ip, { count: 1, reset: now + 3600_000 });
    return true;
  }
  e.count++;
  return e.count <= 5;
}

// Aufräumen — sollte ab und zu im Cron laufen.
export function cleanupExpiredResets(db: Database): number {
  const r = db.prepare(`DELETE FROM password_resets WHERE expires_at < ?`).run(new Date().toISOString());
  return Number(r.changes || 0);
}
