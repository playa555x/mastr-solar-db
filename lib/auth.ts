import type { Database } from "bun:sqlite";
import { randomBytes } from "crypto";

const SESSION_TTL_MS = 8 * 60 * 60 * 1000; // 8 hours

export interface SessionUser {
  id: number;
  username: string;
  email: string;
  display_name: string | null;
  color: string;
  active: number;
  is_admin?: number;
  is_viewer?: number;
  pref_locale?: string;
}

export function createSession(db: Database, userId: number, ip: string, ua: string): string {
  const token = randomBytes(32).toString("hex");
  const now = Date.now();
  const expires = now + SESSION_TTL_MS;
  db.prepare(`
    INSERT INTO sessions (token, user_id, created_at, expires_at, ip, user_agent)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(token, userId, now, expires, ip, ua.substring(0, 200));
  return token;
}

export function getSession(db: Database, token: string): SessionUser | null {
  if (!token) return null;
  const row = db.prepare(`
    SELECT u.id, u.username, u.email, u.display_name, u.color, u.active, u.is_admin, u.is_viewer, u.pref_locale, s.expires_at
    FROM sessions s
    JOIN users u ON s.user_id = u.id
    WHERE s.token = ?
  `).get(token) as any;
  if (!row) return null;
  if (row.expires_at < Date.now()) {
    db.prepare("DELETE FROM sessions WHERE token = ?").run(token);
    return null;
  }
  if (row.active !== 1) return null;
  return {
    id: row.id,
    username: row.username,
    email: row.email,
    display_name: row.display_name,
    color: row.color,
    active: row.active,
    is_admin: row.is_admin || 0,
    is_viewer: row.is_viewer || 0,
    pref_locale: row.pref_locale || "de-DE",
  };
}

export function deleteSession(db: Database, token: string): void {
  db.prepare("DELETE FROM sessions WHERE token = ?").run(token);
}

export function cleanupExpiredSessions(db: Database): void {
  db.prepare("DELETE FROM sessions WHERE expires_at < ?").run(Date.now());
}

export function parseCookie(cookieHeader: string | null, name: string): string | null {
  if (!cookieHeader) return null;
  const parts = cookieHeader.split(";").map((p) => p.trim());
  for (const part of parts) {
    const [k, v] = part.split("=");
    if (k === name) return v || null;
  }
  return null;
}

export function getClientIP(req: Request): string {
  return req.headers.get("x-forwarded-for")?.split(",")[0].trim() ||
         req.headers.get("x-real-ip") ||
         "unknown";
}
