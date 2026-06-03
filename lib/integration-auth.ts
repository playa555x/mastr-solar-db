import type { Database } from "bun:sqlite";
import { randomBytes, createHash } from "crypto";
import type { SessionUser } from "./auth";

export type ApiScope = "read" | "write" | "full";

export const SCOPE_LABELS: Record<ApiScope, string> = {
  read: "Nur Lesen — alle GET-Endpoints, keine Aenderungen",
  write: "Lesen + Schreiben — eigene Anlagen/Kunden/Reminders/Notizen erstellen/aendern",
  full: "Vollzugriff — wie Admin (inkl. Token-Verwaltung, User-Management)",
};

// Welche HTTP-Methoden sind pro Scope erlaubt
const SCOPE_METHODS: Record<ApiScope, Set<string>> = {
  read: new Set(["GET", "HEAD", "OPTIONS"]),
  write: new Set(["GET", "HEAD", "OPTIONS", "POST", "PUT", "PATCH", "DELETE"]),
  full: new Set(["GET", "HEAD", "OPTIONS", "POST", "PUT", "PATCH", "DELETE"]),
};

// Pfade die NIE per write-Scope erreichbar sind (admin-only Bereiche)
const ADMIN_ONLY_PREFIXES = ["/api/admin/", "/api/users", "/api/import/", "/api/audit"];

export interface ApiToken {
  id: number;
  name: string;
  token_hash: string;
  token_prefix: string;
  scope: ApiScope;
  created_by: number;
  created_at: string;
  expires_at: string | null;
  last_used_at: string | null;
  last_used_ip: string | null;
  request_count: number;
  revoked_at: string | null;
  revoked_by: number | null;
}

const TOKEN_PREFIX = "msolar_";

export function hashToken(plain: string): string {
  return createHash("sha256").update(plain).digest("hex");
}

/**
 * Erzeugt einen neuen Token. Gibt den Klartext-Token + DB-Row zurueck.
 * Der Klartext darf NUR EINMAL angezeigt werden (an den User direkt nach POST).
 * In der DB wird nur der SHA-256-Hash gespeichert.
 */
export function createApiToken(db: Database, input: {
  name: string;
  scope: ApiScope;
  created_by: number;
  expires_at?: string | null;
  is_sandbox?: boolean;
}): { token: string; row: ApiToken } {
  if (!input.name || input.name.length < 3) throw new Error("Name muss mind. 3 Zeichen lang sein");
  if (!["read", "write", "full"].includes(input.scope)) throw new Error("Ungueltiger Scope");
  const secret = randomBytes(24).toString("base64url");
  // Sandbox-Tokens haben den Prefix `msolar_test_` — sofort erkennbar in Logs / cURL
  const tokPrefix = input.is_sandbox ? `${TOKEN_PREFIX}test_` : TOKEN_PREFIX;
  const token = `${tokPrefix}${secret}`;
  const hash = hashToken(token);
  const prefix = token.substring(0, 19); // genug um msolar_test_xxxx zu zeigen
  const r = db.prepare(`
    INSERT INTO api_tokens (name, token_hash, token_prefix, scope, created_by, expires_at, is_sandbox)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(input.name, hash, prefix, input.scope, input.created_by, input.expires_at || null, input.is_sandbox ? 1 : 0);
  const row = getApiTokenById(db, Number(r.lastInsertRowid))!;
  return { token, row };
}

export function getApiTokenById(db: Database, id: number): ApiToken | null {
  return (db.prepare("SELECT * FROM api_tokens WHERE id = ?").get(id) as ApiToken | undefined) || null;
}

export function listApiTokens(db: Database): ApiToken[] {
  return db.prepare(`
    SELECT t.*,
      cu.username as created_by_username, cu.display_name as created_by_display_name,
      ru.username as revoked_by_username
    FROM api_tokens t
    LEFT JOIN users cu ON t.created_by = cu.id
    LEFT JOIN users ru ON t.revoked_by = ru.id
    ORDER BY t.revoked_at IS NOT NULL ASC, t.created_at DESC
  `).all() as ApiToken[];
}

export function revokeApiToken(db: Database, id: number, revoked_by: number): void {
  db.prepare(`
    UPDATE api_tokens
    SET revoked_at = CURRENT_TIMESTAMP, revoked_by = ?
    WHERE id = ? AND revoked_at IS NULL
  `).run(revoked_by, id);
  // Cache-Eintrag dieses Tokens entfernen — sofortige Wirkung.
  // invalidateTokenCache wird unten definiert; forward-Reference via Funktion.
  try { (globalThis as any).__invalidate_api_token_cache?.(id); } catch {}
}

/**
 * Rotation: erstellt einen NEUEN Token mit gleichem Namen/Scope/Expires wie der alte
 * und revoked den alten. Liefert {token, row} des NEUEN Tokens zurueck.
 * Optional graceMinutes >0 → alter Token bleibt weiter gueltig fuer N Minuten (Soft-Rotation).
 * Default = 0 (Hard-Rotation, alter Token sofort tot).
 *
 * Anwendungsfall: Secret-Leak, periodische Rotation, Compliance.
 */
export function rotateApiToken(
  db: Database,
  oldId: number,
  rotated_by: number,
  graceMinutes = 0,
): { token: string; row: ApiToken; old_id: number; old_grace_until: string | null } {
  const old = getApiTokenById(db, oldId);
  if (!old) throw new Error("Alter Token nicht gefunden");
  if (old.revoked_at) throw new Error("Token bereits widerrufen — Rotation nicht moeglich");
  // 1. neuen Token mit gleichen Eigenschaften erstellen
  const created = createApiToken(db, {
    name: old.name + " (rotated)",
    scope: old.scope,
    created_by: rotated_by,
    expires_at: old.expires_at,
  });
  // 2. alten Token revoken — entweder sofort oder mit Grace
  let graceUntil: string | null = null;
  if (graceMinutes > 0) {
    const until = new Date(Date.now() + graceMinutes * 60 * 1000).toISOString();
    db.prepare(`
      UPDATE api_tokens
      SET expires_at = ?, revoked_at = NULL, revoked_by = NULL
      WHERE id = ?
    `).run(until, oldId);
    graceUntil = until;
    try { (globalThis as any).__invalidate_api_token_cache?.(oldId); } catch {}
  } else {
    revokeApiToken(db, oldId, rotated_by);
  }
  return { token: created.token, row: created.row, old_id: oldId, old_grace_until: graceUntil };
}

// ===== Token-Cache (P2-25) =====
// In-Process LRU mit TTL. Reduziert pro Request: DB-SELECT auf api_tokens + UPDATE on last_used_at.
// Bei Restart leer — invalidiert sich automatisch durch TTL und revokeApiToken().
const TOKEN_CACHE = new Map<string, { user: SessionUser; token: ApiToken; cachedAt: number }>();
const TOKEN_CACHE_TTL_MS = 5 * 60 * 1000;   // 5 min
const TOKEN_CACHE_MAX = 1000;

function cacheGet(hash: string) {
  const e = TOKEN_CACHE.get(hash);
  if (!e) return null;
  if (Date.now() - e.cachedAt > TOKEN_CACHE_TTL_MS) {
    TOKEN_CACHE.delete(hash);
    return null;
  }
  return e;
}
function cacheSet(hash: string, user: SessionUser, token: ApiToken) {
  if (TOKEN_CACHE.size >= TOKEN_CACHE_MAX) {
    const oldest = TOKEN_CACHE.keys().next().value;
    if (oldest !== undefined) TOKEN_CACHE.delete(oldest);
  }
  TOKEN_CACHE.set(hash, { user, token, cachedAt: Date.now() });
}
export function invalidateTokenCache(tokenIdOrHash?: number | string) {
  if (tokenIdOrHash === undefined) { TOKEN_CACHE.clear(); return; }
  if (typeof tokenIdOrHash === "string") { TOKEN_CACHE.delete(tokenIdOrHash); return; }
  for (const [k, v] of TOKEN_CACHE.entries()) {
    if (v.token.id === tokenIdOrHash) TOKEN_CACHE.delete(k);
  }
}
// Globaler Forward-Pointer fuer revokeApiToken (das vor invalidateTokenCache deklariert wird).
(globalThis as any).__invalidate_api_token_cache = invalidateTokenCache;

// ===== Last-used Batch (vermeidet UPDATE-pro-Request) =====
// Akkumuliere request_count und schreibe alle 30s oder bei 100 pending einen Bulk-Flush.
const PENDING_USAGE = new Map<number, { count: number; lastIp: string; lastUsedAt: string }>();
let lastFlush = Date.now();
function flushUsage(db: Database) {
  if (PENDING_USAGE.size === 0) return;
  try {
    const tx = db.transaction(() => {
      const stmt = db.prepare(`
        UPDATE api_tokens
        SET last_used_at = ?, last_used_ip = ?, request_count = request_count + ?
        WHERE id = ?
      `);
      for (const [id, v] of PENDING_USAGE.entries()) {
        stmt.run(v.lastUsedAt, v.lastIp, v.count, id);
      }
    });
    tx();
  } catch (e) {
    console.error("[token-usage] flush failed:", e);
  }
  PENDING_USAGE.clear();
  lastFlush = Date.now();
}
function recordUsage(db: Database, tokenId: number, ip: string) {
  const now = new Date().toISOString().slice(0, 19).replace("T", " ");
  const e = PENDING_USAGE.get(tokenId);
  if (e) { e.count++; e.lastIp = ip; e.lastUsedAt = now; }
  else PENDING_USAGE.set(tokenId, { count: 1, lastIp: ip, lastUsedAt: now });
  if (PENDING_USAGE.size >= 100 || Date.now() - lastFlush > 30_000) flushUsage(db);
}
// Bei graceful shutdown spaeter aufrufen — hier auch periodisch nach 60s:
setInterval(() => { /* will be wired from server */ }, 60_000);

// ===== Rate-Limit pro Token (P0-2) =====
// Token-Bucket: max 10 req/s und max 600 req/min pro Token-ID.
// In-Process Map; bei mehreren Prozessen (gibt's nicht) muesste Redis ran.
const RL_BUCKETS = new Map<number, { secCount: number; secReset: number; minCount: number; minReset: number }>();
const RL_PER_SEC = 10;
const RL_PER_MIN = 600;
export interface RateLimitResult { allowed: boolean; reason?: string; retryAfter?: number; }
export function checkTokenRateLimit(tokenId: number): RateLimitResult {
  const now = Date.now();
  let b = RL_BUCKETS.get(tokenId);
  if (!b) { b = { secCount: 0, secReset: now + 1000, minCount: 0, minReset: now + 60_000 }; RL_BUCKETS.set(tokenId, b); }
  if (now > b.secReset) { b.secCount = 0; b.secReset = now + 1000; }
  if (now > b.minReset) { b.minCount = 0; b.minReset = now + 60_000; }
  b.secCount++;
  b.minCount++;
  if (b.secCount > RL_PER_SEC) {
    return { allowed: false, reason: `Rate limit: max ${RL_PER_SEC} requests/second per token`, retryAfter: Math.ceil((b.secReset - now) / 1000) };
  }
  if (b.minCount > RL_PER_MIN) {
    return { allowed: false, reason: `Rate limit: max ${RL_PER_MIN} requests/minute per token`, retryAfter: Math.ceil((b.minReset - now) / 1000) };
  }
  return { allowed: true };
}

/**
 * Validiert einen Token aus dem Authorization-Header und gibt
 * den zugehoerigen User (als SessionUser-kompatibel) zurueck, oder null.
 * Nutzt Cache + Batch-Update fuer Performance.
 */
/**
 * IP-Whitelist-Check. Akzeptiert CSV mit Mix aus:
 *   - exakte IPv4 oder IPv6 Adresse (z.B. "1.2.3.4", "::1")
 *   - IPv4 CIDR (z.B. "10.0.0.0/8", "192.168.1.0/24")
 * IPv6-CIDRs werden derzeit NICHT unterstützt — nur exact match.
 *
 * Leerer/null whitelist string = uneingeschränkt (Default).
 */
export function matchIpWhitelist(ip: string | null, whitelistCsv: string | null | undefined): boolean {
  if (!whitelistCsv || !whitelistCsv.trim()) return true;
  if (!ip) return false;
  const norm = ip.trim();
  const entries = whitelistCsv.split(",").map(s => s.trim()).filter(Boolean);
  for (const e of entries) {
    if (e === norm) return true;
    if (e.includes("/")) {
      // CIDR
      const [base, bitsStr] = e.split("/");
      const bits = parseInt(bitsStr, 10);
      if (isNaN(bits) || bits < 0 || bits > 32) continue;
      // Nur IPv4 CIDR
      const baseInt = ipv4ToInt(base);
      const ipInt = ipv4ToInt(norm);
      if (baseInt === null || ipInt === null) continue;
      const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
      if ((baseInt & mask) === (ipInt & mask)) return true;
    }
  }
  return false;
}
function ipv4ToInt(ip: string): number | null {
  const p = ip.split(".");
  if (p.length !== 4) return null;
  let v = 0;
  for (const part of p) {
    const n = parseInt(part, 10);
    if (isNaN(n) || n < 0 || n > 255) return null;
    v = (v << 8) | n;
  }
  return v >>> 0;
}

export function validateApiToken(db: Database, authHeader: string | null, ip: string): { user: SessionUser; token: ApiToken } | null {
  if (!authHeader) return null;
  const m = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!m) return null;
  const plain = m[1].trim();
  if (!plain.startsWith(TOKEN_PREFIX)) return null;
  const hash = hashToken(plain);

  // 1) Cache-Hit?
  const cached = cacheGet(hash);
  if (cached) {
    // IP-Whitelist auch im Cache-Pfad prüfen — sonst könnte sich der Schutz durch TTL umgehen lassen.
    const wl = (cached.token as any).ip_whitelist as string | null | undefined;
    if (!matchIpWhitelist(ip, wl)) return null;
    recordUsage(db, cached.token.id, ip);
    return { user: cached.user, token: cached.token };
  }

  // 2) DB-Lookup
  const row = db.prepare(`
    SELECT t.*, u.id as user_id, u.username, u.email, u.display_name, u.color, u.active, u.is_admin
    FROM api_tokens t
    JOIN users u ON t.created_by = u.id
    WHERE t.token_hash = ?
      AND t.revoked_at IS NULL
      AND (t.expires_at IS NULL OR t.expires_at > CURRENT_TIMESTAMP)
      AND u.active = 1
  `).get(hash) as any;
  if (!row) return null;

  // IP-Whitelist (Spalte kann fehlen — fallback null)
  const wl = row.ip_whitelist as string | null | undefined;
  if (!matchIpWhitelist(ip, wl)) return null;

  const user: SessionUser = {
    id: row.user_id,
    username: row.username,
    email: row.email,
    display_name: row.display_name,
    color: row.color,
    active: row.active,
    is_admin: row.is_admin || 0,
  };
  const token = row as ApiToken;

  cacheSet(hash, user, token);
  recordUsage(db, token.id, ip);
  return { user, token };
}

// Sandbox-Token-Spalte: is_sandbox INTEGER 0/1
export function ensureSandboxColumn(db: Database): void {
  try {
    const cols = db.prepare("PRAGMA table_info(api_tokens)").all() as any[];
    const has = cols.some(c => c.name === "is_sandbox");
    if (!has) db.run("ALTER TABLE api_tokens ADD COLUMN is_sandbox INTEGER NOT NULL DEFAULT 0");
  } catch (e) {
    console.error("[integration-auth] ALTER api_tokens is_sandbox failed:", e);
  }
}

// Idempotente Migration für die neue Spalte
export function ensureIpWhitelistColumn(db: Database): void {
  try {
    const cols = db.prepare("PRAGMA table_info(api_tokens)").all() as any[];
    const has = cols.some(c => c.name === "ip_whitelist");
    if (!has) {
      db.run("ALTER TABLE api_tokens ADD COLUMN ip_whitelist TEXT");
    }
  } catch (e) {
    console.error("[integration-auth] ALTER api_tokens ip_whitelist failed:", e);
  }
}

// Periodischer Flush — vom server.ts gestartet
export function startTokenUsageFlush(db: Database, intervalMs = 30_000) {
  return setInterval(() => flushUsage(db), intervalMs);
}

/**
 * Prueft ob ein Request mit gegebenem Scope auf gegebenen Pfad+Methode zugreifen darf.
 * Returns null wenn erlaubt, sonst eine Begruendung.
 */
export function denyReason(scope: ApiScope, method: string, pathname: string): string | null {
  const allowedMethods = SCOPE_METHODS[scope];
  if (!allowedMethods.has(method.toUpperCase())) {
    return `Scope '${scope}' erlaubt diese HTTP-Methode nicht (${method})`;
  }
  // P1-14: Admin-Pfade sind fuer ALLE Scopes gesperrt — auch fuer 'full'.
  // Begruendung: gestohlener Token darf nicht zu Admin-Zugang fuehren.
  for (const prefix of ADMIN_ONLY_PREFIXES) {
    if (pathname.startsWith(prefix)) {
      return `Admin-Endpoints sind fuer API-Tokens gesperrt (${prefix}) — bitte mit Browser-Login zugreifen`;
    }
  }
  return null;
}
