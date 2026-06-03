// P1-10: Idempotency-Keys fuer POST/PUT/PATCH
// Client schickt Header `Idempotency-Key: <random>` → Antwort wird 24h gespeichert.
// Bei Retry mit gleichem Key + gleichem Body: gespeicherte Antwort wird zurueckgegeben (kein Duplikat).
// Bei gleichem Key + ANDEREM Body: 409 Conflict (Schutz vor Key-Reuse mit falscher Operation).

import type { Database } from "bun:sqlite";
import { createHash } from "crypto";

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // 24 Stunden — Fallback wenn kein Token-Override
const MIN_TTL_MIN = 5;
const MAX_TTL_MIN = 7 * 24 * 60; // 7 Tage

/**
 * Token-spezifische Idempotency-TTL aus DB lesen. Default = 24h.
 * Wird bei jedem Lookup einmal geholt; günstig durch Index auf api_tokens.id.
 */
function resolveTtlMs(db: Database, tokenId: number | null): number {
  if (!tokenId) return DEFAULT_TTL_MS;
  try {
    const r = db.prepare("SELECT idempotency_ttl_minutes FROM api_tokens WHERE id = ?").get(tokenId) as any;
    const m = r?.idempotency_ttl_minutes;
    if (typeof m === "number" && m >= MIN_TTL_MIN && m <= MAX_TTL_MIN) return m * 60 * 1000;
  } catch { /* Spalte existiert evtl. noch nicht — Fallback */ }
  return DEFAULT_TTL_MS;
}

// Aufruf-Variante für Migration: idempotent ALTER TABLE
export function ensureIdempotencyTtlColumn(db: Database): void {
  try {
    const cols = db.prepare("PRAGMA table_info(api_tokens)").all() as any[];
    const has = cols.some(c => c.name === "idempotency_ttl_minutes");
    if (!has) {
      db.run("ALTER TABLE api_tokens ADD COLUMN idempotency_ttl_minutes INTEGER");
    }
  } catch (e) {
    console.error("[idempotency] ALTER api_tokens failed:", e);
  }
}

export interface IdempotencyHit {
  status: number;
  body: string;
  cached: true;
}

export interface IdempotencyConflict {
  conflict: true;
  message: string;
}

/**
 * Lookup. Returns:
 *  - { cached: true, status, body } wenn Antwort gefunden + Body-Hash matched
 *  - { conflict: true, message } wenn Key existiert aber Body anders
 *  - null wenn Key unbekannt
 */
export function idempotencyLookup(
  db: Database,
  key: string,
  tokenId: number | null,
  userId: number | null,
  method: string,
  path: string,
  requestBody: string,
): IdempotencyHit | IdempotencyConflict | null {
  const requestHash = createHash("sha256").update(`${method}|${path}|${requestBody}`).digest("hex");
  const row = db.prepare(`
    SELECT request_hash, status, response_body, created_at
    FROM idempotency_log
    WHERE key = ? AND token_id IS ? AND user_id IS ?
  `).get(key, tokenId, userId) as any;
  if (!row) return null;
  // TTL pro Token (Fallback 24h)
  const ttlMs = resolveTtlMs(db, tokenId);
  const age = Date.now() - new Date(row.created_at + "Z").getTime();
  if (age > ttlMs) {
    db.prepare("DELETE FROM idempotency_log WHERE key = ? AND token_id IS ? AND user_id IS ?").run(key, tokenId, userId);
    return null;
  }
  if (row.request_hash !== requestHash) {
    return { conflict: true, message: "Idempotency-Key wurde bereits mit einem anderen Request-Body verwendet" };
  }
  return { cached: true, status: row.status, body: row.response_body };
}

export function idempotencyStore(
  db: Database,
  key: string,
  tokenId: number | null,
  userId: number | null,
  method: string,
  path: string,
  requestBody: string,
  status: number,
  responseBody: string,
): void {
  const requestHash = createHash("sha256").update(`${method}|${path}|${requestBody}`).digest("hex");
  try {
    db.prepare(`
      INSERT OR REPLACE INTO idempotency_log (key, token_id, user_id, method, path, request_hash, status, response_body)
      VALUES (?,?,?,?,?,?,?,?)
    `).run(key, tokenId, userId, method, path, requestHash, status, responseBody);
  } catch (e) {
    console.error("[idempotency] store failed:", e);
  }
}

export function cleanupIdempotency(db: Database): number {
  // Cleanup auf Basis des längsten möglichen TTLs (MAX_TTL_MIN); pro Token-spezifischer
  // Cutoff wäre hier teurer und Tabelle ist klein — Pragmatik.
  const maxTtlMs = MAX_TTL_MIN * 60 * 1000;
  const cutoff = new Date(Date.now() - maxTtlMs).toISOString();
  const r = db.prepare("DELETE FROM idempotency_log WHERE created_at < ?").run(cutoff);
  return r.changes;
}
