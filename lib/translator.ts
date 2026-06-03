/**
 * UGC-Translator über LibreTranslate (selbst-gehostet, Open-Source, gratis, unlimited).
 *
 * Architektur:
 *  - DB speichert IMMER auf Deutsch (Canonical / Single-Source-of-Truth)
 *  - LibreTranslate-Container laeuft lokal auf VPS (127.0.0.1:5050)
 *  - Auto-Source-Detection von LibreTranslate (kein Heuristik-Voting noetig)
 *  - Aggressive DB-Cache: Beim 2. Aufruf 0 ms + 0 Bytes
 *  - Setup: docker run -d --name libretranslate -p 127.0.0.1:5050:5000
 *           -e LT_LOAD_ONLY=de,en,fr libretranslate/libretranslate
 *  - Fallback: Google gtx (gratis, ohne Key) wenn LibreTranslate ausfaellt
 */
import type { Database } from "bun:sqlite";
import { createHash } from "crypto";
import { normalizeLocale } from "./i18n-server";

const LIBRETRANSLATE_URL = process.env.LIBRETRANSLATE_URL || "http://127.0.0.1:5050";
const GOOGLE_URL = "https://translate.googleapis.com/translate_a/single";

export function ensureTranslationsTable(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS translations (
      cache_key TEXT PRIMARY KEY,
      source_locale TEXT,
      target_locale TEXT NOT NULL,
      original_text TEXT NOT NULL,
      translated_text TEXT NOT NULL,
      provider TEXT NOT NULL DEFAULT 'libretranslate',
      created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    );
    CREATE INDEX IF NOT EXISTS idx_translations_target ON translations(target_locale);
  `);
}

function hashKey(text: string, target: string): string {
  return createHash("sha256").update(`${target}|${text}`).digest("hex").slice(0, 32);
}

/** LibreTranslate /translate (selbst-gehostet, Auto-Source). */
async function libreTranslate(text: string, target: string): Promise<{ text: string; source: string } | null> {
  try {
    const r = await fetch(`${LIBRETRANSLATE_URL}/translate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(15000),
      body: JSON.stringify({ q: text, source: "auto", target, format: "text" }),
    });
    if (!r.ok) return null;
    const j = await r.json() as any;
    const translated: string = j?.translatedText;
    const source: string = j?.detectedLanguage?.language || "auto";
    if (!translated) return null;
    return { text: translated, source };
  } catch (e) {
    console.error("translator: LibreTranslate-Fehler", e);
    return null;
  }
}

/** Google gtx Fallback (gratis, ohne Key, sl=auto). */
async function googleTranslate(text: string, target: string): Promise<{ text: string; source: string } | null> {
  try {
    const params = new URLSearchParams({
      client: "gtx", sl: "auto", tl: target, dt: "t", q: text,
    });
    const r = await fetch(`${GOOGLE_URL}?${params}`, {
      signal: AbortSignal.timeout(7000),
      headers: { "User-Agent": "Mozilla/5.0" },
    });
    if (!r.ok) return null;
    const j = await r.json();
    if (!Array.isArray(j) || !Array.isArray(j[0])) return null;
    const parts: string[] = [];
    for (const sentence of j[0]) {
      if (Array.isArray(sentence) && typeof sentence[0] === "string") parts.push(sentence[0]);
    }
    if (parts.length === 0) return null;
    return { text: parts.join(""), source: typeof j[2] === "string" ? j[2] : "auto" };
  } catch {
    return null;
  }
}

export async function translateText(
  db: Database,
  text: string,
  target: string,
): Promise<{ translated: string; cached: boolean; source?: string }> {
  const cleanText = (text || "").trim();
  if (!cleanText) return { translated: cleanText, cached: true };
  const tgt = normalizeLocale(target);
  const key = hashKey(cleanText, tgt);

  // Cache-Hit?
  const row = db.prepare(`SELECT translated_text, source_locale FROM translations WHERE cache_key = ?`).get(key) as any;
  if (row) return { translated: row.translated_text, cached: true, source: row.source_locale };

  // 1. Primary: LibreTranslate (selbst-gehostet, unlimited)
  let result = await libreTranslate(cleanText, tgt);
  let provider = "libretranslate";

  // 2. Fallback: Google gtx
  if (!result || result.text.trim() === "") {
    result = await googleTranslate(cleanText, tgt);
    provider = "google";
  }

  if (!result || result.text.trim() === "") {
    return { translated: cleanText, cached: false };
  }

  db.prepare(`
    INSERT OR REPLACE INTO translations
      (cache_key, source_locale, target_locale, original_text, translated_text, provider, created_at)
    VALUES (?, ?, ?, ?, ?, ?, strftime('%s','now'))
  `).run(key, result.source, tgt, cleanText, result.text, provider);

  return { translated: result.text, cached: false, source: result.source };
}

export async function translateBatch(
  db: Database,
  texts: string[],
  target: string,
): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const uniq = Array.from(new Set(texts.filter((t) => t && t.trim())));
  const tgt = normalizeLocale(target);
  if (uniq.length === 0) return out;

  // Bulk-Cache-Lookup
  const keys = uniq.map((t) => hashKey(t.trim(), tgt));
  const placeholders = keys.map(() => "?").join(",");
  const rows = db.prepare(`
    SELECT cache_key, translated_text FROM translations WHERE cache_key IN (${placeholders})
  `).all(...keys) as any[];
  const cached = new Map(rows.map((r) => [r.cache_key, r.translated_text]));

  const misses: string[] = [];
  for (const t of uniq) {
    const k = hashKey(t.trim(), tgt);
    if (cached.has(k)) out[t] = cached.get(k) as string;
    else misses.push(t);
  }

  // Parallel (LibreTranslate haelt locker viel aus, da self-hosted)
  const CONCURRENCY = 5;
  for (let i = 0; i < misses.length; i += CONCURRENCY) {
    const slice = misses.slice(i, i + CONCURRENCY);
    const results = await Promise.all(slice.map((t) => translateText(db, t, tgt)));
    slice.forEach((t, idx) => { out[t] = results[idx].translated; });
  }
  return out;
}
