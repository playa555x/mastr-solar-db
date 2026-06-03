import type { Database } from "bun:sqlite";
import { createHash } from "crypto";

export interface RequestLogInput {
  method: string;
  path: string;
  query: string | null;
  status: number;
  ip: string | null;
  userAgent: string | null;
  durationMs: number;
  responseSize: number | null;
  errorMessage: string | null;
  tokenId: number | null;
  userId: number | null;
  authType: "token" | "cookie" | "public" | "none";
  // Fuer Bug-Log:
  stack: string | null;
  requestBody: string | null;
}

// Bekannte Bug-Patterns mit Auto-Fix-Hinweisen.
// Wenn die Fehlermeldung zu einem Pattern passt, wird der Hint gespeichert.
const KNOWN_PATTERNS: Array<{ match: RegExp; hint: string }> = [
  {
    match: /no such table:|SQLITE_ERROR.*table/i,
    hint: "DB-Migration laeuft? Service neustarten via 'sudo systemctl restart mastr-solar' damit db-init.ts neue Tabellen anlegt.",
  },
  {
    match: /SQLITE_BUSY|database is locked/i,
    hint: "Concurrent write conflict. Lange Transaktionen vermeiden oder PRAGMA busy_timeout=5000 setzen.",
  },
  {
    match: /UNIQUE constraint failed/i,
    hint: "Doppelter INSERT — auf ON CONFLICT DO UPDATE pruefen oder vorher mit SELECT pruefen.",
  },
  {
    match: /FOREIGN KEY constraint failed/i,
    hint: "Referenzierte Zeile fehlt (z.B. user_id, anlage_id). Insert-Reihenfolge pruefen.",
  },
  {
    match: /ECONNREFUSED|fetch failed/i,
    hint: "Externer Dienst (SMTP, IMAP, OSM, Nominatim) nicht erreichbar. Retry mit exponential backoff oder Service-URL pruefen.",
  },
  {
    match: /timeout|ETIMEDOUT/i,
    hint: "Externer Aufruf hat das Timeout gerissen. Timeout erhoehen oder Operation in Cron auslagern.",
  },
  {
    match: /Cannot read prop|undefined is not|null is not/i,
    hint: "Defensive Programmierung — Optional Chaining (?.) und Default-Werte verwenden.",
  },
  {
    match: /JSON\.parse|Unexpected token/i,
    hint: "Request-Body ist kein gueltiges JSON. Auf Client-Seite Content-Type: application/json + JSON.stringify pruefen.",
  },
  {
    match: /ENOENT.*\.md/i,
    hint: "Doc-Datei fehlt im Deployment. scp + cp auf VPS und Pfad pruefen (docs/API.md).",
  },
];

function classifyBug(message: string | null, stack: string | null): string | null {
  const haystack = `${message || ""}\n${stack || ""}`;
  for (const p of KNOWN_PATTERNS) {
    if (p.match.test(haystack)) return p.hint;
  }
  return null;
}

function fingerprint(method: string, path: string, message: string | null): string {
  // Normalisiere Path: IDs, MaStR-Nummern, UUIDs durch Platzhalter ersetzen
  const normPath = path
    .replace(/\/\d+(?=\/|$)/g, "/:id")
    .replace(/\/(?:SEE|ABR|EEG|SEL|SNA|SME|SNB|SAE|GSE|VLE|GVE|MSE|MSB|LOK)\d{6,}/g, "/:mastr")
    .replace(/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "/:uuid");
  // Normalisiere Message: Zahlen, Pfade, Quoted-Strings entfernen
  const normMsg = (message || "").substring(0, 200).replace(/\d+/g, "N").replace(/'[^']*'/g, "'X'");
  const raw = `${method}|${normPath}|${normMsg}`;
  return createHash("sha256").update(raw).digest("hex").slice(0, 16);
}

// P0-4: Stack/Body/Message vor DB-Insert redacten — Token, Passwoerter, Emails, Telefon.
const REDACTORS: Array<[RegExp, string]> = [
  [/msolar_[A-Za-z0-9_-]{20,}/g, "msolar_[REDACTED]"],
  [/Bearer\s+[A-Za-z0-9_\-\.]{20,}/gi, "Bearer [REDACTED]"],
  [/(['"]?password['"]?\s*[:=]\s*['"])[^'"]+(['"])/gi, "$1[REDACTED]$2"],
  [/(['"]?token['"]?\s*[:=]\s*['"])[^'"]+(['"])/gi, "$1[REDACTED]$2"],
  [/(['"]?secret['"]?\s*[:=]\s*['"])[^'"]+(['"])/gi, "$1[REDACTED]$2"],
  [/(['"]?api[_-]?key['"]?\s*[:=]\s*['"])[^'"]+(['"])/gi, "$1[REDACTED]$2"],
  [/\$2[aby]\$\d{1,2}\$[./A-Za-z0-9]{53}/g, "[BCRYPT_HASH_REDACTED]"],
  [/[a-f0-9]{64}/g, "[SHA256_REDACTED]"],
  [/[\w.+-]+@[\w-]+\.[\w.-]+/g, "[EMAIL_REDACTED]"],
  [/\+?\d{1,3}[\s().-]?\d{2,4}[\s().-]?\d{2,}/g, (m: string) => m.length > 7 ? "[PHONE_REDACTED]" : m] as any,
  // Server-Pfade auf /home/, C:\Users\, /opt/ koennen Username verraten
  [/\/home\/[^\/\s'"]+/g, "/home/[USER]"],
  [/C:\\Users\\[^\\\s'"]+/g, "C:\\Users\\[USER]"],
];
export function redact(text: string | null): string | null {
  if (!text) return text;
  let out = text;
  for (const [re, sub] of REDACTORS) {
    out = typeof sub === "string" ? out.replace(re, sub) : out.replace(re, sub as any);
  }
  return out;
}

export function logApiRequest(db: Database, input: RequestLogInput): void {
  try {
    // P0-4: error_message + query + body vor Insert redacten
    const errMsgRedacted = redact(input.errorMessage);
    const queryRedacted = redact(input.query);
    db.prepare(`
      INSERT INTO api_request_log
        (token_id, user_id, auth_type, method, path, query, status, ip, user_agent, duration_ms, response_size, error_message)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      input.tokenId,
      input.userId,
      input.authType,
      input.method,
      input.path,
      queryRedacted,
      input.status,
      input.ip,
      input.userAgent,
      input.durationMs,
      input.responseSize,
      errMsgRedacted,
    );

    // Token-Stats sind durch validateApiToken bereits gesetzt, hier aber noch einmal Aktualisierung
    // (wir wollen auch failed-requests im request_count haben).
    // Skip: validateApiToken updated bereits. Hier nicht doppelt.

    // Bei Fehlern: zusaetzlich in bug_log
    const isError = input.status >= 500 || (input.status >= 400 && input.errorMessage && input.errorMessage.length > 0 && input.status !== 401 && input.status !== 403 && input.status !== 404);
    if (input.status >= 500 || input.stack) {
      const fp = fingerprint(input.method, input.path, input.errorMessage);
      const hint = classifyBug(input.errorMessage, input.stack);
      const stackRedacted = redact(input.stack);
      const bodyRedacted = redact(input.requestBody?.slice(0, 4000) || null);
      const existing = db.prepare("SELECT id FROM api_bug_log WHERE fingerprint = ?").get(fp) as any;
      if (existing) {
        db.prepare(`
          UPDATE api_bug_log
          SET occurrence_count = occurrence_count + 1,
              last_seen_at = CURRENT_TIMESTAMP,
              resolved_at = NULL, resolved_by = NULL, resolution_note = NULL
          WHERE id = ?
        `).run(existing.id);
      } else {
        db.prepare(`
          INSERT INTO api_bug_log
            (fingerprint, method, path, query, status, token_id, user_id, ip, error_message, stack_trace, request_body, auto_fix_hint)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
        `).run(
          fp,
          input.method,
          input.path,
          queryRedacted,
          input.status,
          input.tokenId,
          input.userId,
          input.ip,
          errMsgRedacted,
          stackRedacted,
          bodyRedacted,
          hint,
        );
      }
    }
  } catch (e) {
    // Logging darf NIE den Request killen — Fehler nur auf stderr.
    console.error("[api-audit] log failed:", e);
  }
}

export interface ListRequestsFilter {
  tokenId?: number;
  userId?: number;
  method?: string;
  pathContains?: string;
  status?: number;
  statusMin?: number;
  statusMax?: number;
  from?: string;
  to?: string;
  q?: string; // Volltext: path, query, ip, ua, error
  limit?: number;
  offset?: number;
}

export function listApiRequests(db: Database, f: ListRequestsFilter) {
  const where: string[] = [];
  const params: any[] = [];
  if (f.tokenId !== undefined) { where.push("r.token_id = ?"); params.push(f.tokenId); }
  if (f.userId !== undefined) { where.push("r.user_id = ?"); params.push(f.userId); }
  if (f.method) { where.push("r.method = ?"); params.push(f.method.toUpperCase()); }
  if (f.pathContains) { where.push("r.path LIKE ?"); params.push(`%${f.pathContains}%`); }
  if (f.status !== undefined) { where.push("r.status = ?"); params.push(f.status); }
  if (f.statusMin !== undefined) { where.push("r.status >= ?"); params.push(f.statusMin); }
  if (f.statusMax !== undefined) { where.push("r.status <= ?"); params.push(f.statusMax); }
  if (f.from) { where.push("r.created_at >= ?"); params.push(f.from); }
  if (f.to) { where.push("r.created_at <= ?"); params.push(f.to); }
  if (f.q) {
    where.push("(r.path LIKE ? OR r.query LIKE ? OR r.ip LIKE ? OR r.user_agent LIKE ? OR r.error_message LIKE ?)");
    const q = `%${f.q}%`; for (let i = 0; i < 5; i++) params.push(q);
  }
  const wc = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const limit = Math.min(500, Math.max(1, f.limit || 100));
  const offset = Math.max(0, f.offset || 0);

  const total = (db.prepare(`SELECT COUNT(*) c FROM api_request_log r ${wc}`).get(...params) as any).c;
  const rows = db.prepare(`
    SELECT r.*,
      t.name as token_name, t.scope as token_scope, t.token_prefix,
      u.username as user_username, u.display_name as user_display_name
    FROM api_request_log r
    LEFT JOIN api_tokens t ON r.token_id = t.id
    LEFT JOIN users u ON r.user_id = u.id
    ${wc}
    ORDER BY r.created_at DESC
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset);

  return { data: rows, total, limit, offset };
}

export function listApiBugs(db: Database, opts: { status?: "open" | "resolved" | "all"; q?: string; limit?: number; offset?: number }) {
  const where: string[] = [];
  const params: any[] = [];
  if (opts.status === "open") where.push("b.resolved_at IS NULL");
  else if (opts.status === "resolved") where.push("b.resolved_at IS NOT NULL");
  if (opts.q) {
    where.push("(b.path LIKE ? OR b.error_message LIKE ? OR b.auto_fix_hint LIKE ?)");
    const q = `%${opts.q}%`; for (let i = 0; i < 3; i++) params.push(q);
  }
  const wc = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const limit = Math.min(500, Math.max(1, opts.limit || 100));
  const offset = Math.max(0, opts.offset || 0);

  const total = (db.prepare(`SELECT COUNT(*) c FROM api_bug_log b ${wc}`).get(...params) as any).c;
  const rows = db.prepare(`
    SELECT b.*,
      t.name as token_name, t.scope as token_scope,
      u.username as user_username,
      ru.username as resolved_by_username
    FROM api_bug_log b
    LEFT JOIN api_tokens t ON b.token_id = t.id
    LEFT JOIN users u ON b.user_id = u.id
    LEFT JOIN users ru ON b.resolved_by = ru.id
    ${wc}
    ORDER BY b.resolved_at IS NULL DESC, b.last_seen_at DESC
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset);

  return { data: rows, total, limit, offset };
}

export function resolveBug(db: Database, id: number, userId: number, note: string | null): boolean {
  const r = db.prepare(`
    UPDATE api_bug_log
    SET resolved_at = CURRENT_TIMESTAMP, resolved_by = ?, resolution_note = ?
    WHERE id = ? AND resolved_at IS NULL
  `).run(userId, note, id);
  return r.changes > 0;
}

export function reopenBug(db: Database, id: number): boolean {
  const r = db.prepare(`
    UPDATE api_bug_log SET resolved_at = NULL, resolved_by = NULL, resolution_note = NULL WHERE id = ?
  `).run(id);
  return r.changes > 0;
}
