import { Database } from "bun:sqlite";
import { file } from "bun";
import { mkdirSync, existsSync, writeFileSync, unlinkSync, readFileSync } from "fs";
import { dirname, join, extname } from "path";
import { randomBytes } from "crypto";

import { initSchema, seedDefaultTemplates, bootstrapAdmin } from "./lib/db-init";
import { initMasterKey, encrypt, decrypt } from "./lib/crypto";
import {
  createSession, getSession, deleteSession, cleanupExpiredSessions,
  parseCookie, getClientIP, type SessionUser,
} from "./lib/auth";
import { buildTransport, buildTransportWithFallback, fromAddress, renderTemplate, applyTestModeOverride } from "./lib/mailer";
import { detectAnrede, detectAnredeLocalized } from "./lib/anrede";
import { generateICS } from "./lib/ics-helper";
import { logActivity as logActivityRaw, autoAssignOwner, autoAssignOwnerForBetreiber } from "./lib/activity";
// Wrapper um logActivity: schreibt zusätzlich SSE-Event an Subscriber des Users.
function logActivity(db: any, anlageId: number, userId: number, type: string, description: string, metadata?: any, apiTokenId?: number | null): void {
  logActivityRaw(db, anlageId, userId, type as any, description, metadata, apiTokenId);
  try {
    ssePublish(`user.${userId}.activity`, {
      kind: "activity",
      type,
      description,
      anlage_id: anlageId,
      created_at: new Date().toISOString(),
    });
  } catch {}
}
import { logApiRequest, listApiRequests, listApiBugs, resolveBug, reopenBug } from "./lib/api-audit";
import { log, newTraceId } from "./lib/logger";
import { idempotencyLookup, idempotencyStore, cleanupIdempotency, ensureIdempotencyTtlColumn } from "./lib/idempotency";
import { withEnglishAliases, mapEnglish } from "./lib/field-aliases";
import { notify, parseMentions } from "./lib/notifications";
import { t as tt, normalizeLocale } from "./lib/i18n-server";
import { ensureTranslationsTable, translateBatch } from "./lib/translator";
import {
  ensureWebhookTables, createWebhook, listWebhooks, getWebhookById,
  updateWebhook, deleteWebhook, listDeliveries, fireEvent, testWebhook,
  ALL_EVENTS as WEBHOOK_EVENTS,
  type WebhookEvent,
} from "./lib/webhooks";
import {
  ensurePasswordResetTable, createPasswordReset, consumePasswordReset, checkForgotRate,
} from "./lib/password-reset";
import { ensureSignatureColumns, pickSignature } from "./lib/signatures";
import { encodeCursor, decodeCursor } from "./lib/cursor";
import { publish as ssePublish, sseResponse } from "./lib/sse-bus";
import { runGraphQL } from "./lib/graphql-schema";
import {
  createReminder, listReminders, getReminder, markDone as reminderDone,
  snooze as reminderSnooze, updateReminder, deleteReminder,
} from "./lib/reminders";
import { startLogin as tgStartLogin, finishLogin as tgFinishLogin, logoutSession as tgLogout, sendToSelf as tgSendToSelf } from "./lib/telegram-mtproto";
import { generateCallSummary } from "./lib/ai-summary";
import { generateTrackingToken, injectTracking, hashShort, TRANSPARENT_GIF } from "./lib/email-tracker";
import { logAudit } from "./lib/audit";
import {
  createApiToken, listApiTokens, revokeApiToken, rotateApiToken, ensureIpWhitelistColumn, matchIpWhitelist,
  validateApiToken, denyReason, SCOPE_LABELS,
  checkTokenRateLimit, startTokenUsageFlush, invalidateTokenCache,
  type ApiScope,
} from "./lib/integration-auth";
import { computeEconomics } from "./lib/pv-economics";
import { getAppSettings, updateAppSetting, SETTINGS_META, localizeSettingsMeta, type AppSettings } from "./lib/app-settings";
import { clearLeadWeightCache, rescoreAll } from "./lib/lead-score";

// ======== Configuration ========
// TEST_DB hat Prio fuer Fixture-Runs; DB_PATH fuer Produktion; sonst Default
const DB_PATH = process.env.TEST_DB || process.env.DB_PATH || "mastr-solar.db";
const DATA_DIR = process.env.DATA_DIR || dirname(DB_PATH === "mastr-solar.db" ? "./data/x" : DB_PATH);
const UPLOADS_DIR = process.env.UPLOADS_DIR || join(DATA_DIR, "uploads");
const MASTER_KEY_PATH = process.env.MASTER_KEY_PATH || join(DATA_DIR, ".master.key");
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const ALLOWED_MIME = new Set([
  "application/pdf",
  "image/png", "image/jpeg", "image/webp",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/msword",
  "application/vnd.ms-excel",
  "text/plain",
]);

// ======== Init ========
if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
if (!existsSync(UPLOADS_DIR)) mkdirSync(UPLOADS_DIR, { recursive: true });
if (!existsSync(join(UPLOADS_DIR, "global"))) mkdirSync(join(UPLOADS_DIR, "global"), { recursive: true });
if (!existsSync(dirname(DB_PATH))) mkdirSync(dirname(DB_PATH), { recursive: true });

initMasterKey(MASTER_KEY_PATH);

const db = new Database(DB_PATH);
// WAL + busy_timeout: Import-Job laeuft als separater Prozess, schreibt parallel.
// Ohne busy_timeout knallt jeder DB-Write des Servers waehrend des Imports mit
// SQLITE_BUSY und der Server-Prozess crasht (Restart=always → Endlosschleife).
// 30s warten ist mehr als genug fuer alle realistischen Lock-Konflikte.
db.prepare("PRAGMA journal_mode = WAL").run();
db.prepare("PRAGMA busy_timeout = 30000").run();
db.prepare("PRAGMA synchronous = NORMAL").run();
initSchema(db);
seedDefaultTemplates(db);
bootstrapAdmin(db);
// Zentrale Migrationen — idempotent + Audit-Trail in schema_migrations.
import { runMigrations, migrationStatus } from "./lib/migrations";
const __fresh = runMigrations(db);
if (__fresh.length > 0) console.log(`[migrations] ${__fresh.length} new applied this start.`);

setInterval(() => cleanupExpiredSessions(db), 5 * 60 * 1000);

console.log(`DB: ${DB_PATH}`);
console.log(`Data: ${DATA_DIR}`);
console.log(`Uploads: ${UPLOADS_DIR}`);

// ======== Helpers ========
function json(data: any, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: { "Content-Type": "application/json", ...(init.headers || {}) },
  });
}
// P1-9: Strukturierte Error-Codes. Jeder Fehler bekommt code + message.
// Default-Codes aus Statuscode abgeleitet, kann via extra.code ueberschrieben werden.
const DEFAULT_ERROR_CODES: Record<number, string> = {
  400: "BAD_REQUEST",
  401: "UNAUTHORIZED",
  403: "FORBIDDEN",
  404: "NOT_FOUND",
  409: "CONFLICT",
  413: "PAYLOAD_TOO_LARGE",
  422: "VALIDATION_FAILED",
  429: "RATE_LIMITED",
  500: "INTERNAL_ERROR",
  502: "BAD_GATEWAY",
  503: "SERVICE_UNAVAILABLE",
};
// i18n-Server-Lookup: deutsch -> Key (alle srverr.* + ausgewaehlte error.* aus locales)
// Beim Start einmal aufgebaut. Bei err()-Aufruf wird die deutsche Message in der
// User-Locale (asyncLocale.getStore()) wieder uebersetzt.
import { AsyncLocalStorage } from "node:async_hooks";
export const requestLocaleStore = new AsyncLocalStorage<string>();
function buildGermanToKeyMap(): Map<string, string> {
  const de = JSON.parse(require("node:fs").readFileSync("static/locales/de.json", "utf-8")) as Record<string, string>;
  const map = new Map<string, string>();
  for (const [k, v] of Object.entries(de)) {
    if (k.startsWith("_")) continue;
    // Nur fuer Server-Errors relevant: srverr.* + error.*
    if (!k.startsWith("srverr.") && !k.startsWith("error.")) continue;
    if (typeof v === "string" && !map.has(v)) map.set(v, k);
  }
  return map;
}
const GERMAN_ERROR_TO_KEY = buildGermanToKeyMap();

// Dynamische Pattern: deutsche Messages mit eingebetteten Werten matchen und
// auf i18n-Keys mit {value}/{error}/{mime}-Substitution mappen.
// Reihenfolge ist relevant — erster Match gewinnt.
const DYNAMIC_ERROR_PATTERNS: { re: RegExp; key: string; arg: string }[] = [
  { re: /^Ungueltige default_tab: (.+)$/,            key: "srverr.invalid_default_tab", arg: "value" },
  { re: /^Ungueltige Sortierung: (.+)$/,             key: "srverr.invalid_sort",        arg: "value" },
  { re: /^Ungueltiger Marker-Mode: (.+)$/,           key: "srverr.invalid_marker_mode", arg: "value" },
  { re: /^MIME-Typ (.+) nicht erlaubt$/,             key: "srverr.mime_not_allowed",    arg: "mime"  },
  { re: /^SMTP-Test fehlgeschlagen: (.+)$/,          key: "srverr.smtp_test_failed",    arg: "error" },
  { re: /^IMAP-Test fehlgeschlagen: (.+)$/,          key: "srverr.imap_test_failed",    arg: "error" },
  { re: /^Poll fehlgeschlagen: (.+)$/,               key: "srverr.poll_failed",         arg: "error" },
  { re: /^Telegram-Login fehlgeschlagen: (.+)$/,     key: "srverr.telegram_login_failed", arg: "error" },
  { re: /^Login-Fehler: (.+)$/,                      key: "srverr.login_error",         arg: "error" },
  { re: /^Test fehlgeschlagen: (.+)$/,               key: "srverr.test_failed",         arg: "error" },
  { re: /^Uebersetzung fehlgeschlagen: (.*)$/,       key: "srverr.translation_failed_with_error", arg: "error" },
];

function err(message: string, status = 400, extra: any = {}): Response {
  const code = extra.code || DEFAULT_ERROR_CODES[status] || "UNKNOWN_ERROR";
  let localized = message;
  try {
    const loc = requestLocaleStore.getStore();
    if (loc && loc !== "de") {
      // 1. Statischer Match
      const key = GERMAN_ERROR_TO_KEY.get(message) || GERMAN_ERROR_TO_KEY.get(message.replace(/[:\s]+$/, ""));
      if (key) {
        localized = tt(loc, key);
      } else {
        // 2. Dynamische Patterns
        let matched = false;
        for (const p of DYNAMIC_ERROR_PATTERNS) {
          const m = message.match(p.re);
          if (m) {
            localized = tt(loc, p.key, { [p.arg]: m[1] });
            matched = true;
            break;
          }
        }
        // (Falls weder statisch noch dynamisch: Originalmessage bleibt.)
        void matched;
      }
    }
  } catch {}
  const body = { error: localized, code, message: localized, ...extra };
  return json(body, { status });
}
// Memoization pro Request — verhindert dass getUser mehrfach pro Request DB hittet
// UND verhindert dass Rate-Limit-Counter pro Request mehrfach erhoeht wird.
const USER_PER_REQUEST = new WeakMap<Request, SessionUser | null>();

function getUser(req: Request): SessionUser | null {
  if (USER_PER_REQUEST.has(req)) return USER_PER_REQUEST.get(req) ?? null;
  let result: SessionUser | null = null;
  // 1. Session-Cookie (Browser-Login)
  const token = parseCookie(req.headers.get("Cookie"), "sid");
  if (token) {
    const u = getSession(db, token);
    if (u) result = u;
  }
  // 2. API-Token (Authorization: Bearer xxx) — fuer Maschinen/Integrationen
  if (!result) {
    const ip = getClientIP(req as any) || "?";
    const auth = req.headers.get("Authorization");
    const apiRes = validateApiToken(db, auth, ip);
    if (apiRes) {
      // WICHTIG: Cache liefert dasselbe User-Objekt zurueck → pro Request neu KLONEN,
      // sonst persistieren _api_scope_deny und _api_rate_limited zwischen Requests.
      const user: SessionUser = { ...apiRes.user };
      // Scope-Check pro Request
      const urlObj = new URL(req.url);
      // v1-Alias auch hier beruecksichtigen
      let scopePath = urlObj.pathname;
      if (scopePath.startsWith("/api/v1/")) scopePath = "/api/" + scopePath.slice(8);
      const reason = denyReason(apiRes.token.scope, req.method, scopePath);
      if (reason) (user as any)._api_scope_deny = reason;
      (user as any)._api_token = true;
      (user as any)._api_scope = apiRes.token.scope;
      (user as any)._api_token_id = apiRes.token.id;
      (user as any)._api_token_name = apiRes.token.name;
      (user as any)._api_is_sandbox = !!(apiRes.token as any).is_sandbox;
      // Rate-Limit pro Token (P0-2): EINMAL pro Request.
      const rl = checkTokenRateLimit(apiRes.token.id);
      if (!rl.allowed) (user as any)._api_rate_limited = rl;
      result = user;
    }
  }
  USER_PER_REQUEST.set(req, result);
  return result;
}
function requireUser(req: Request): { user: SessionUser } | { response: Response } {
  const u = getUser(req);
  if (!u) return { response: err("Nicht autorisiert", 401, { code: "UNAUTHORIZED" }) };
  if ((u as any)._api_scope_deny) return { response: err((u as any)._api_scope_deny, 403) };
  // P0-2: 429 Too Many Requests bei Token-Rate-Limit-Verletzung
  const rl = (u as any)._api_rate_limited;
  if (rl) {
    return { response: new Response(JSON.stringify({ error: rl.reason, code: "RATE_LIMITED", retry_after: rl.retryAfter }), {
      status: 429,
      headers: { "Content-Type": "application/json", "Retry-After": String(rl.retryAfter || 1) },
    }) };
  }
  return { user: u };
}
// True wenn der Request via API-Token (NICHT via Browser-Cookie) reinkam.
// Wird genutzt um Fremdsystem-Zugriffe auf "bearbeitete" Anlagen zu beschraenken
// (owner_id IS NOT NULL), damit Integrationen nicht die komplette Stammdaten-DB abziehen.
function isApiClient(u: SessionUser): boolean {
  return !!(u as any)._api_token;
}
// Helper: API-Token-ID des Aufrufers (null bei Cookie-Auth)
function tid(u: SessionUser): number | null {
  return (u as any)._api_token_id ?? null;
}
// Pruefung pro Anlage — fuer Detail-Endpoints. Bei API-Client + ownerlose Anlage: false.
function anlageVisibleToClient(db: import("bun:sqlite").Database, anlageId: number, u: SessionUser): boolean {
  if (!isApiClient(u)) return true;
  const r = db.prepare("SELECT owner_id FROM anlagen WHERE id = ?").get(anlageId) as any;
  return !!(r && r.owner_id);
}

// ===== Viewer-Rolle (Read-only, nur telefonierte Anlagen) ============================
// Eingefuehrt 2026-05-17: Login fuer Stakeholder die einen reinen Lese-Einblick
// in die Anlagen brauchen die wir bereits aktiv bearbeitet haben (= telefoniert).
// Sie sehen KEINE Nutzerliste, KEINE Einstellungen und duerfen NICHTS schreiben.
function isViewer(u: SessionUser): boolean {
  return u.is_viewer === 1;
}
// Pruefung pro Anlage — fuer Detail-Endpoints.
// Viewer sieht alle BEARBEITETEN Anlagen: Calls ODER Notizen ODER Mails ODER Owner ODER Status != 'neu'
function anlageVisibleToViewer(db: import("bun:sqlite").Database, anlageId: number, u: SessionUser): boolean {
  if (!isViewer(u)) return true;
  const r = db.prepare(`
    SELECT 1 FROM anlagen a WHERE a.id = ?
      AND (
        a.owner_id IS NOT NULL
        OR (a.status IS NOT NULL AND a.status != 'neu')
        OR EXISTS (SELECT 1 FROM calls c WHERE c.anlage_id = a.id)
        OR EXISTS (SELECT 1 FROM sent_emails s WHERE s.anlage_id = a.id)
        OR EXISTS (SELECT 1 FROM notizen n WHERE n.anlage_id = a.id)
      )
    LIMIT 1
  `).get(anlageId) as any;
  return !!r;
}
// Gleiche Logik als SQL-Snippet fuer Listen-Endpoints (referenziert a.id im aeusseren Query)
const VIEWER_VISIBLE_SQL = `(
  a.owner_id IS NOT NULL
  OR (a.status IS NOT NULL AND a.status != 'neu')
  OR EXISTS (SELECT 1 FROM calls c WHERE c.anlage_id = a.id)
  OR EXISTS (SELECT 1 FROM sent_emails s WHERE s.anlage_id = a.id)
  OR EXISTS (SELECT 1 FROM notizen n WHERE n.anlage_id = a.id)
)`;
// Whitelist erlaubter Schreib-Endpoints fuer Viewer (Login, Logout, eigenes Profil + Passwort).
const VIEWER_WRITE_ALLOWED = new Set<string>([
  "POST /api/auth/login",
  "POST /api/auth/logout",
  "POST /api/me/password",
  "PUT /api/me/profile",
]);
// Liefert Sperrgrund (oder null wenn erlaubt). Wird im globalen Auth-Gate aufgerufen.
/**
 * Forward Repowering-Check an Zoho-Form. Synchron mit 8s Timeout.
 * Status:
 *   - 'success' = HTTP 200/302 (Zoho akzeptiert)
 *   - 'captcha' = Antwort enthaelt CAPTCHA-Hinweis
 *   - 'http_error' = anderer HTTP-Code
 *   - 'network_error' = Timeout / DNS / etc.
 */
async function forwardToZoho(data: {
  vorname: string; nachname: string; email: string; telefon: string;
  firma?: string | null; strasse?: string | null; plz?: string | null; ort?: string | null;
  inbetriebnahme?: string | null; kwp?: number | null;
}, db?: import("bun:sqlite").Database): Promise<{ status: string; httpCode: number | null; body: string }> {
  // Setting-Check: Zoho-Forward kann komplett ausgeschaltet werden (Default an wenn Setting fehlt)
  if (db) {
    const en = (db.prepare("SELECT value FROM app_settings WHERE key = 'zoho_forward_enabled'").get() as any)?.value;
    if (en === "0" || en === "false") {
      return { status: "disabled", httpCode: null, body: "zoho_forward_enabled=0 (paused via app_settings)" };
    }
  }
  const zohoUrl = "https://forms.zohopublic.eu/feedgy/form/IstIhreAnlagefrRepoweringgeeignet/formperma/cm-LITkzeTcG-5qozDiAH_sLXkOCXiN_7fHstE37ijw/htmlRecords/submit";
  const form = new FormData();
  form.append("Nachname", data.nachname);
  form.append("Vorname", data.vorname);
  form.append("Email", data.email);
  form.append("Telefon", data.telefon);
  if (data.firma) form.append("Firmenname", data.firma);
  if (data.strasse) form.append("Adresse", data.strasse);
  if (data.plz) form.append("Postleitzahl", data.plz);
  if (data.ort) form.append("Stadt", data.ort);
  if (data.inbetriebnahme) form.append("Inbetriebnahmedatum", data.inbetriebnahme);
  if (data.kwp != null) form.append("Nennleistung", String(data.kwp));
  form.append("AGB_Acceptance", "true");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const r = await fetch(zohoUrl, {
      method: "POST", body: form, signal: controller.signal,
      headers: { "User-Agent": "Repowering-DE-CRM/1.0", "Accept": "application/json,text/html" },
    });
    const txt = await r.text().catch(() => "");
    if (r.status >= 200 && r.status < 400) {
      // Zoho liefert oft 200 selbst bei Validation-Fehlern — pruefe auf bekannte Marker
      const lower = txt.toLowerCase();
      if (lower.includes("captcha") || lower.includes("recaptcha")) {
        return { status: "captcha", httpCode: r.status, body: txt };
      }
      if (lower.includes("error") && lower.includes("required")) {
        return { status: "validation_error", httpCode: r.status, body: txt };
      }
      return { status: "success", httpCode: r.status, body: txt.slice(0, 200) };
    }
    return { status: "http_error", httpCode: r.status, body: txt };
  } catch (e: any) {
    return { status: "network_error", httpCode: null, body: String(e?.message || e) };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * HMAC-signed Token fuer /check Prefill-Links — verhindert dass beliebige Nutzer fremde Anlagedaten ziehen koennen.
 * Format: base64url(anlageId|expiryUnix|hmac8)
 * TTL Standard: 90 Tage (Lead-Akquise-Fenster).
 */
function signCheckToken(anlageId: number, ttlSeconds = 60 * 60 * 24 * 90): string {
  const expiry = Math.floor(Date.now() / 1000) + ttlSeconds;
  const payload = `${anlageId}|${expiry}`;
  const secret = process.env.CHECK_TOKEN_SECRET || process.env.SESSION_SECRET || "repowering-default-secret-change-me";
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(payload + "|" + secret);
  const hmac = hasher.digest("hex").slice(0, 16);
  return Buffer.from(`${payload}|${hmac}`).toString("base64url");
}

/**
 * Baut Where-Klausel + Params für Campaign-Filter (verwendet in /api/campaigns/:id/start UND /api/campaigns/preview).
 * Ergaenzt um: leistung_max, baujahr_min/max, plz_prefix, lead_score_min, exclude_kontaktiert.
 */
/**
 * SLA-Tage pro Status. Wird in `/api/stale-anlagen` und im Dashboard-Widget verwendet.
 * Konfigurierbar über app_settings (Key `sla_<status>_tage`, z.B. `sla_kontaktiert_tage=14`).
 * Wenn nicht gesetzt → DEFAULT_SLA.
 */
const DEFAULT_SLA: Record<string, number> = {
  neu: 7,
  kontaktiert: 14,
  nicht_erreicht: 10,
  terminiert: 30,
  interessiert: 21,
  abgeschlossen: 60,
  // Endstatus: kein SLA (0 = nie als stale markiert)
  nicht_interessiert: 0,
  gewonnen: 0,
  verloren: 0,
};

function getSlaMap(db: import("bun:sqlite").Database): Record<string, number> {
  const rows = db.prepare(`SELECT key, value FROM app_settings WHERE key LIKE 'sla_%_tage'`).all() as any[];
  const map = { ...DEFAULT_SLA };
  for (const r of rows) {
    const m = r.key.match(/^sla_(.+)_tage$/);
    if (m && !isNaN(parseInt(r.value))) map[m[1]] = parseInt(r.value);
  }
  return map;
}

/**
 * DSGVO-Anonymisierung — Art. 17 DSGVO "Recht auf Vergessenwerden".
 * Strategie: PERSONENBEZOGENE Daten anonymisieren, MaStR-Anlage bleibt (oeffentliches Register).
 *
 * Was wird betroffen (Treffer per email ODER mastr_nummer ODER betreiber_mastr):
 *   - betreiber: email/telefon/website + name (anlage hat eigenes betreiber_name)
 *   - anlagen: kontakt_email/kontakt_telefon/kontakt_website/kontakt_strasse leeren
 *   - public_leads: name/email/telefon/firma/strasse → anonymisiert
 *   - sent_emails: zu_addr → anonymisiert (audit-trail bleibt mit Hash)
 *   - email_replies: from_addr/subject/body → anonymisiert
 *   - calls: comment → anonymisiert (Datum + Status bleiben fuer Statistik)
 *   - notizen: text → anonymisiert
 *   - reminders: note → anonymisiert
 *   - notifications: title/body → anonymisiert
 *
 * Audit-Log: Was anonymisiert wurde wird OHNE PII protokolliert (nur Counts).
 */
function dsgvoAnonymize(
  db: import("bun:sqlite").Database,
  email: string | null,
  mastrNummer: string | null,
  betreiberMastr: string | null,
  reason: string,
  byUserId: number,
): Record<string, number> {
  const emailLower = email ? email.toLowerCase().trim() : null;
  const tag = `[ANONYMISIERT-${Math.floor(Date.now()/1000)}]`;
  const counts: Record<string, number> = {};
  // Email-Adresse-Hash fuer audit (verhindert Re-Identifikation aber erlaubt Duplikat-Erkennung)
  const emailHash = emailLower ? Bun.CryptoHasher && new Bun.CryptoHasher("sha256").update(emailLower).digest("hex").slice(0, 12) : null;

  const tx = db.transaction(() => {
    // 1. anlagen.kontakt_* anonymisieren wenn passend
    if (emailLower) {
      const r = db.prepare(`
        UPDATE anlagen SET kontakt_email=NULL, kontakt_telefon=NULL, kontakt_website=NULL, kontakt_strasse=NULL
        WHERE LOWER(kontakt_email) = ?
      `).run(emailLower);
      counts.anlagen_kontakt_geleert = r.changes;
    }
    if (mastrNummer) {
      const r = db.prepare(`
        UPDATE anlagen SET kontakt_email=NULL, kontakt_telefon=NULL, kontakt_website=NULL, kontakt_strasse=NULL
        WHERE mastr_nummer = ?
      `).run(mastrNummer);
      counts.anlagen_kontakt_geleert = (counts.anlagen_kontakt_geleert || 0) + r.changes;
    }
    // 2. betreiber-Tabelle leeren (Email/Tel/Website/Name)
    if (emailLower) {
      const r = db.prepare(`
        UPDATE betreiber SET email=NULL, telefon=NULL, website=NULL, name='[anonymisiert]', strasse=NULL, plz=NULL, ort=NULL
        WHERE LOWER(email) = ?
      `).run(emailLower);
      counts.betreiber_anonymisiert = r.changes;
    }
    if (betreiberMastr) {
      const r = db.prepare(`
        UPDATE betreiber SET email=NULL, telefon=NULL, website=NULL, name='[anonymisiert]', strasse=NULL, plz=NULL, ort=NULL
        WHERE mastr_nummer = ?
      `).run(betreiberMastr);
      counts.betreiber_anonymisiert = (counts.betreiber_anonymisiert || 0) + r.changes;
    }
    // 3. public_leads
    if (emailLower) {
      const r = db.prepare(`
        UPDATE public_leads SET name='[anonymisiert]', email='deleted@anonymisiert.tld', telefon=NULL, firma=NULL, strasse=NULL, nachricht=?, ip=NULL, user_agent=NULL
        WHERE LOWER(email) = ?
      `).run(tag, emailLower);
      counts.public_leads = r.changes;
    }
    // 4. sent_emails — Empfaenger anonymisieren, Inhalt bleibt zwecks Audit-Trail entfernt
    if (emailLower) {
      const r = db.prepare(`
        UPDATE sent_emails SET to_addr='deleted@anonymisiert.tld', cc_addr=NULL, body_preview=?
        WHERE LOWER(to_addr) = ? OR LOWER(cc_addr) LIKE ?
      `).run(tag, emailLower, "%" + emailLower + "%");
      counts.sent_emails = r.changes;
    }
    // 5. email_replies (eingehende)
    if (emailLower) {
      const r = db.prepare(`
        UPDATE email_replies SET from_addr='deleted@anonymisiert.tld', subject=?, body_text=?, body_html=?
        WHERE LOWER(from_addr) = ?
      `).run(tag, tag, tag, emailLower);
      counts.email_replies = r.changes;
    }
    // 6. notizen, reminders, calls — fuer Anlagen die zu diesem Betreiber gehoeren
    if (betreiberMastr) {
      const r1 = db.prepare(`UPDATE notizen SET text=? WHERE betreiber_mastr = ?`).run(tag, betreiberMastr);
      counts.notizen = r1.changes;
      const r2 = db.prepare(`UPDATE reminders SET note=? WHERE betreiber_mastr = ?`).run(tag, betreiberMastr);
      counts.reminders = r2.changes;
      const r3 = db.prepare(`
        UPDATE calls SET comment=?
        WHERE anlage_id IN (SELECT id FROM anlagen WHERE betreiber_mastr = ?)
      `).run(tag, betreiberMastr);
      counts.calls = r3.changes;
    }
    // 7. email_drafts
    if (emailLower) {
      const r = db.prepare(`DELETE FROM email_drafts WHERE LOWER(to_addr) = ?`).run(emailLower);
      counts.email_drafts_geloescht = r.changes;
    }
    // 8. Audit-Log
    db.prepare(`
      INSERT INTO audit_log (user_id, username, action, target_type, target_id, detail, created_at)
      VALUES (?, '', 'dsgvo_anonymize', 'person', NULL, ?, CURRENT_TIMESTAMP)
    `).run(byUserId, JSON.stringify({
      email_hash: emailHash,
      mastr: mastrNummer,
      betreiber_mastr: betreiberMastr,
      reason,
      counts,
    }));
  });
  tx();
  return counts;
}

function buildCampaignWhere(filter: any, currentUserId: number, excludeCampaignId?: number): { where: string[]; params: any[] } {
  const where: string[] = [
    "a.betreiber_mastr LIKE 'ABR%'",
    "((b.email IS NOT NULL AND b.email != '') OR (a.kontakt_email IS NOT NULL AND a.kontakt_email != ''))",
  ];
  const params: any[] = [];
  if (filter.bundesland) { where.push("a.bundesland = ?"); params.push(filter.bundesland); }
  if (filter.status) { where.push("a.status = ?"); params.push(filter.status); }
  if (filter.leistung_min) { where.push("a.nettonennleistung >= ?"); params.push(parseFloat(filter.leistung_min)); }
  if (filter.leistung_max) { where.push("a.nettonennleistung <= ?"); params.push(parseFloat(filter.leistung_max)); }
  if (filter.baujahr_min) { where.push("CAST(substr(a.inbetriebnahme, 1, 4) AS INTEGER) >= ?"); params.push(parseInt(filter.baujahr_min)); }
  if (filter.baujahr_max) { where.push("CAST(substr(a.inbetriebnahme, 1, 4) AS INTEGER) <= ?"); params.push(parseInt(filter.baujahr_max)); }
  if (filter.plz_prefix) { where.push("a.plz LIKE ?"); params.push(String(filter.plz_prefix) + "%"); }
  if (filter.lead_score_min) { where.push("a.lead_score >= ?"); params.push(parseFloat(filter.lead_score_min)); }
  if (filter.exclude_kontaktiert) where.push("a.status NOT IN ('kontaktiert','terminiert','interessiert','abgeschlossen','gewonnen')");
  if (filter.owner === "me") { where.push("a.owner_id = ?"); params.push(currentUserId); }
  else if (filter.owner === "unassigned") { where.push("a.owner_id IS NULL"); }
  else if (filter.owner) { where.push("a.owner_id = ?"); params.push(parseInt(filter.owner)); }
  // Anti-Duplikat: keine Anlage die schon in einer anderen Kampagne (running) ist
  if (excludeCampaignId) {
    where.push(`a.id NOT IN (SELECT anlage_id FROM campaign_recipients WHERE status IN ('sent','pending') AND campaign_id != ${parseInt(String(excludeCampaignId))})`);
  } else {
    where.push(`a.id NOT IN (SELECT anlage_id FROM campaign_recipients WHERE status IN ('sent','pending'))`);
  }
  return { where, params };
}

function verifyCheckToken(token: string): { anlageId: number } | null {
  try {
    const decoded = Buffer.from(token, "base64url").toString("utf8");
    const parts = decoded.split("|");
    if (parts.length !== 3) return null;
    const anlageId = parseInt(parts[0]);
    const expiry = parseInt(parts[1]);
    const givenHmac = parts[2];
    if (isNaN(anlageId) || isNaN(expiry)) return null;
    if (Date.now() / 1000 > expiry) return null;
    const secret = process.env.CHECK_TOKEN_SECRET || process.env.SESSION_SECRET || "repowering-default-secret-change-me";
    const hasher = new Bun.CryptoHasher("sha256");
    hasher.update(`${anlageId}|${expiry}|${secret}`);
    const expected = hasher.digest("hex").slice(0, 16);
    if (expected !== givenHmac) return null;
    return { anlageId };
  } catch { return null; }
}

function viewerDeny(method: string, path: string): string | null {
  // Admin-Bereiche bleiben gesperrt (User-Verwaltung, Firma-Settings, DSGVO etc.)
  if (path.startsWith("/api/admin/")) return "Viewer-Account: kein Admin-Zugriff";
  // Andere Nutzer einsehen/aendern bleibt gesperrt — eigenes Profil geht via /api/me/*
  if (path === "/api/users" || path.startsWith("/api/users/")) return "Viewer-Account: Nutzerliste gesperrt";
  // SMTP/IMAP/Notification/Telegram Einstellungen + alles andere → erlaubt
  // (Die Datensicht-Einschraenkung bleibt durch VIEWER_VISIBLE_SQL in den Listen-Endpoints)
  return null;
}
function requireAdmin(req: Request): { user: SessionUser } | { response: Response } {
  const r = requireUser(req);
  if ("response" in r) return r;
  // P1-14: API-Tokens duerfen NIE Admin-Endpoints aufrufen — auch nicht mit full-Scope.
  // Schuetzt vor Token-Diebstahl: ein gestohlener Token kann nicht neue Tokens erzeugen.
  if ((r.user as any)._api_token) {
    return { response: err("Admin-Endpoints sind fuer API-Tokens gesperrt — bitte mit Browser-Login zugreifen", 403, { code: "ADMIN_NOT_API" }) };
  }
  if (r.user.is_admin !== 1 && r.user.username !== "admin") {
    return { response: err("Nur fuer Administratoren", 403, { code: "ADMIN_REQUIRED" }) };
  }
  return r;
}

// Login Rate-Limit (in-memory, 5 attempts / minute / IP)
const loginAttempts = new Map<string, { count: number; reset: number }>();
function checkLoginRate(ip: string): boolean {
  const now = Date.now();
  const e = loginAttempts.get(ip);
  if (!e || e.reset < now) {
    loginAttempts.set(ip, { count: 1, reset: now + 60_000 });
    return true;
  }
  if (e.count >= 5) return false;
  e.count++;
  return true;
}

// Public-Lead Rate-Limit: 5 Anfragen / Stunde / IP (Bot-Schutz)
const publicLeadAttempts = new Map<string, { count: number; reset: number }>();
function checkPublicLeadRate(ip: string): boolean {
  const now = Date.now();
  const e = publicLeadAttempts.get(ip);
  if (!e || e.reset < now) {
    publicLeadAttempts.set(ip, { count: 1, reset: now + 60 * 60_000 });
    return true;
  }
  if (e.count >= 5) return false;
  e.count++;
  return true;
}

const PUBLIC_PREFIXES = ["/api/auth/login", "/api/termine/accept", "/api/termine/decline", "/t/o/", "/t/c/", "/api/health", "/api/healthz", "/api/metrics", "/docs/", "/api/public/"];
function isPublic(pathname: string): boolean {
  if (pathname === "/" || pathname === "/login") return true;
  if (pathname === "/interesse" || pathname === "/partner" || pathname === "/check" || pathname === "/impressum" || pathname === "/datenschutz") return true;
  if (pathname.startsWith("/static/") || pathname.startsWith("/favicon")) return true;
  if (pathname.startsWith("/api/i18n/")) return true;
  // Session-Check muss public sein — sonst 401-Spam in der Browser-Console beim Page-Load.
  // Der Endpoint liefert ohne Cookie {authenticated:false}, mit Cookie {authenticated:true,...user}.
  if (pathname === "/api/auth/me") return true;
  for (const p of PUBLIC_PREFIXES) if (pathname.startsWith(p)) return true;
  return false;
}

// ======== Server ========
const server = Bun.serve({
  port: process.env.PORT ? parseInt(process.env.PORT) : 8080,
  maxRequestBodySize: MAX_UPLOAD_BYTES + 1024 * 1024,
  // Bun-Default idleTimeout = 10s -> killt langlaufende Endpoints wie IMAP-Full-Import.
  // Bun begrenzt idleTimeout auf max 255s — das nehmen wir.
  idleTimeout: 255,
  async fetch(reqOuter) {
    // Locale fuer i18n-Fehlermeldungen (X-Locale > Accept-Language > "de")
    const xLocale = reqOuter.headers.get("x-locale");
    const acceptLang = reqOuter.headers.get("accept-language") || "";
    const locale = normalizeLocale(xLocale || acceptLang.split(",")[0] || "de");
    return requestLocaleStore.run(locale, () => handleRequest(reqOuter));
  },
});

// === API Versioning (Stripe-Style) ===
// Header `API-Version: 2026-06-03`. Server kennt eine Liste verfügbarer
// Versions-Snapshots. Bei fehlendem Header → LATEST. Bei unbekanntem Wert →
// LATEST + Warning-Header. Aktuell ein einziger Snapshot — Pfad-Alias /api/v1
// bleibt erhalten.
const API_VERSIONS = ["2026-06-03"];
const API_VERSION_LATEST = API_VERSIONS[API_VERSIONS.length - 1];
function resolveApiVersion(req: Request): { version: string; warning: string | null } {
  const v = (req.headers.get("api-version") || req.headers.get("x-api-version") || "").trim();
  if (!v) return { version: API_VERSION_LATEST, warning: null };
  if (API_VERSIONS.includes(v)) return { version: v, warning: null };
  return { version: API_VERSION_LATEST, warning: `Unknown API-Version "${v}", using latest ${API_VERSION_LATEST}` };
}

async function handleRequest(req: Request): Promise<Response> {
    const t0 = Date.now();
    let url: URL;
    try {
      url = new URL(req.url);
    } catch {
      return new Response("Bad Request", { status: 400 });
    }
    // P1-6: /api/v1/* ist Alias auf /api/* (Routing-Rewrite, transparent fuer Routes)
    let path = url.pathname;
    if (path.startsWith("/api/v1/")) {
      path = "/api/" + path.slice(8);
    }
    const method = req.method;
    const ip = getClientIP(req);
    // API-Version aus Header — nur für /api/* Calls relevant.
    const apiV = path.startsWith("/api/") ? resolveApiVersion(req) : null;
    const ua = req.headers.get("user-agent") || null;

    // Request-Body fuer Bug-Log nur bei Fehlern lesen — sonst Stream verbrauchen wir nicht.
    // Wir kapseln die eigentliche Logik in einer inneren Funktion, damit wir nach Abschluss loggen koennen.
    let resp: Response | undefined;
    let caughtError: any = null;
    let errorMessage: string | null = null;
    let stackTrace: string | null = null;
    let idempotencyHit = false;

    // P1-10: Idempotency-Key-Handling fuer POST/PUT/PATCH
    // Body wird gelesen → fuer den eigentlichen Handler clonen wir den Request mit Body.
    let idempotencyKey: string | null = null;
    let idempotencyBody: string | null = null;
    let replayedReq: Request = req;
    if (["POST", "PUT", "PATCH"].includes(method)) {
      idempotencyKey = req.headers.get("idempotency-key");
      if (idempotencyKey) {
        try {
          idempotencyBody = await req.text();
          // Cache-Lookup
          const u = getUser(req);
          const tokenId = (u as any)?._api_token_id ?? null;
          const userId = u?.id ?? null;
          const hit = idempotencyLookup(db, idempotencyKey, tokenId, userId, method, path, idempotencyBody);
          if (hit && "cached" in hit) {
            resp = new Response(hit.body, {
              status: hit.status,
              headers: { "Content-Type": "application/json", "X-Idempotent-Replay": "true" },
            });
            idempotencyHit = true;
          } else if (hit && "conflict" in hit) {
            resp = err(hit.message, 409, { code: "IDEMPOTENCY_KEY_REUSE" });
            idempotencyHit = true;
          } else {
            // Body zurueck in neuen Request stopfen, damit Route-Handler ihn lesen kann
            replayedReq = new Request(req.url, {
              method: req.method,
              headers: req.headers,
              body: idempotencyBody,
            });
          }
        } catch (e) {
          // Body nicht lesbar → ignoriere Idempotency, fahre normal fort
          log.warn("idempotency_body_unreadable", { method, path, error: String(e) });
        }
      }
    }

    try {
      if (!resp) resp = await (async (): Promise<Response> => {
      const req = replayedReq; // Body-restorierter Request fuer alle Routing-Handler
      // Auth gating + zentrale Scope/Rate-Checks fuer alle nicht-public Endpoints
      if (!isPublic(path)) {
        const u = getUser(req);
        if (!u && (path.startsWith("/api/") || path === "/graphql")) return err("Nicht autorisiert", 401);
        // Scope-Deny: greift fuer ALLE Endpoints, auch die ohne explizites requireUser
        if (u && (u as any)._api_scope_deny) {
          return err((u as any)._api_scope_deny, 403, { code: "ADMIN_NOT_API" });
        }
        // Rate-Limit-Deny: dito
        if (u && (u as any)._api_rate_limited) {
          const rl = (u as any)._api_rate_limited;
          return new Response(JSON.stringify({ error: rl.reason, code: "RATE_LIMITED", retry_after: rl.retryAfter }), {
            status: 429,
            headers: { "Content-Type": "application/json", "Retry-After": String(rl.retryAfter || 1) },
          });
        }
        // Viewer-Deny: blockt Schreibvorgaenge, Admin, User-Liste, Einstellungen.
        if (u && isViewer(u)) {
          const reason = viewerDeny(method, path);
          if (reason) return err(reason, 403, { code: "VIEWER_READONLY" });
        }
        // Sandbox-Token: write-Endpoints liefern eine synthetische 200-Response zurueck OHNE DB-Schreibzugriff.
        // Reads (GET/HEAD/OPTIONS) durchlaufen normal — also kann gegen echte Daten gelesen werden,
        // aber Tests koennen ohne Furcht POST/PUT etc. ausprobieren.
        if (u && (u as any)._api_is_sandbox && ["POST", "PUT", "PATCH", "DELETE"].includes(method) && path.startsWith("/api/")) {
          const fakeId = Math.floor(900_000_000 + Math.random() * 99_999_999);
          return new Response(JSON.stringify({
            success: true,
            sandbox: true,
            sandbox_note: "Sandbox-Token: keine Daten persistiert. Response synthetisch.",
            id: fakeId,
            method,
            path,
          }), {
            status: 200,
            headers: { "Content-Type": "application/json", "X-Sandbox": "1" },
          });
        }
      }

      // ===== AUTH =====
      if (path === "/api/auth/login" && method === "POST") {
        if (!checkLoginRate(ip)) return err("Zu viele Login-Versuche. Bitte spaeter erneut.", 429);
        const body = (await req.json()) as any;
        const username = (body.username || "").trim();
        const password = body.password || "";
        const totpCode = String(body.totp_code || "").trim();
        if (!username || !password) return err("Username und Passwort erforderlich", 400, { code: "VALIDATION" });
        // Username case-insensitive matchen (User tippt "Harold", in DB ist "harold")
        const row = db.prepare(`
          SELECT id, password_hash, active, totp_enabled, totp_secret_enc FROM users WHERE LOWER(username) = LOWER(?)
        `).get(username) as any;
        if (!row || row.active !== 1) {
          logAudit(db, { username, action: "login_failed", ip });
          return err("Ungueltige Zugangsdaten", 401, { code: "INVALID_CREDENTIALS" });
        }
        const ok = await Bun.password.verify(password, row.password_hash);
        if (!ok) {
          logAudit(db, { userId: row.id, username, action: "login_failed", ip });
          return err("Ungueltige Zugangsdaten", 401, { code: "INVALID_CREDENTIALS" });
        }
        // 2FA-Check (wenn fuer User aktiviert)
        if (row.totp_enabled === 1 && row.totp_secret_enc) {
          if (!totpCode) {
            return json({ success: false, totp_required: true }, { status: 401 });
          }
          if (!/^\d{6}$/.test(totpCode)) return err("2FA-Code muss 6 Ziffern haben", 401);
          const { authenticator } = await import("otplib");
          if (!authenticator.check(totpCode, decrypt(row.totp_secret_enc))) {
            logAudit(db, { userId: row.id, username, action: "login_failed", detail: "totp_wrong", ip });
            return err("2FA-Code falsch", 401);
          }
        }
        const token = createSession(db, row.id, ip, req.headers.get("user-agent") || "");
        logAudit(db, { userId: row.id, username, action: "login", ip });
        return json({ success: true }, {
          headers: {
            "Set-Cookie": `sid=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${8 * 60 * 60}`,
          },
        });
      }

      // ===== SELF-SERVICE PASSWORT-RESET =====
      // Schritt 1: Token via Email anfordern. Antwort IMMER {success:true} um Email-Enumeration zu verhindern.
      if (path === "/api/auth/forgot-password" && method === "POST") {
        if (!checkForgotRate(ip)) return err("Zu viele Anfragen. Bitte spaeter erneut versuchen.", 429);
        let b: any = {}; try { b = await req.json(); } catch {}
        const emailRaw = String(b.email || "").trim();
        if (!emailRaw || !emailRaw.includes("@")) return err("Bitte gueltige E-Mail-Adresse angeben");
        const result = createPasswordReset(db, emailRaw, ip);
        if (result.token && result.user_id) {
          // Mail versenden — best-effort. Wir nutzen den Admin-SMTP-Fallback, wenn der User selber keinen hat.
          try {
            const sender = db.prepare(`
              SELECT email, display_name, username, smtp_host, smtp_port, smtp_secure, smtp_user, smtp_pass_enc, smtp_from_name, smtp_from_email
              FROM users WHERE smtp_host IS NOT NULL AND smtp_pass_enc IS NOT NULL LIMIT 1
            `).get() as any;
            if (sender) {
              const settings = getAppSettings(db) as any;
              const firmaName = settings?.firma_name || "Repowering DE";
              const origin = `https://${req.headers.get("host") || "mastr-solar.51.195.86.119.nip.io"}`;
              const link = `${origin}/?reset=${encodeURIComponent(result.token)}`;
              const user = db.prepare("SELECT pref_locale FROM users WHERE id = ?").get(result.user_id) as any;
              const loc = user?.pref_locale || "de-DE";
              const subject = tt(loc, "auth.reset_email.subject", { firma: firmaName });
              const body = tt(loc, "auth.reset_email.body", { firma: firmaName, link });
              const transport = nodemailer.createTransport({
                host: sender.smtp_host, port: sender.smtp_port, secure: sender.smtp_secure === 1,
                auth: { user: sender.smtp_user, pass: decrypt(sender.smtp_pass_enc) },
              });
              await transport.sendMail({
                from: { name: sender.smtp_from_name || firmaName, address: sender.smtp_from_email || sender.email },
                to: result.email_used,
                subject,
                text: body,
                html: body.replace(/\n/g, "<br>"),
              });
              log.info("password_reset_email_sent", { user_id: result.user_id });
            } else {
              log.warn("password_reset_no_smtp_configured", { user_id: result.user_id });
            }
          } catch (e: any) {
            log.error("password_reset_email_failed", { user_id: result.user_id, error: String(e?.message || e) });
          }
        }
        return json({ success: true, message: "Falls ein Account mit dieser E-Mail existiert, wurde ein Reset-Link gesendet." });
      }
      // Schritt 2: Token einlösen + neues Passwort setzen
      if (path === "/api/auth/reset-password" && method === "POST") {
        let b: any = {}; try { b = await req.json(); } catch {}
        const token = String(b.token || "").trim();
        const newPw = String(b.new_password || "");
        if (!token) return err("Token fehlt");
        if (newPw.length < 6) return err("Passwort zu kurz (min 6 Zeichen)");
        try {
          const hash = await Bun.password.hash(newPw, { algorithm: "bcrypt", cost: 10 });
          const r = consumePasswordReset(db, token, hash, ip);
          logAudit(db, { userId: r.user_id, username: "(self-service)", action: "password_reset", ip });
          return json({ success: true });
        } catch (e: any) {
          return err(e?.message || "Reset fehlgeschlagen", 400);
        }
      }

      if (path === "/api/auth/logout" && method === "POST") {
        const token = parseCookie(req.headers.get("Cookie"), "sid");
        const u = getUser(req);
        if (token) deleteSession(db, token);
        if (u) logAudit(db, { userId: u.id, username: u.username, action: "logout", ip });
        return json({ success: true }, {
          headers: { "Set-Cookie": "sid=; Path=/; HttpOnly; Max-Age=0" },
        });
      }

      if (path === "/api/auth/me" && method === "GET") {
        // Session-Check liefert IMMER 200 — kein 401-Spam in der Browser-Console.
        // Body unterscheidet authentifiziert vs. nicht.
        const u = getUser(req);
        if (!u) return json({ authenticated: false });
        const extra = db.prepare("SELECT onboarding_done FROM users WHERE id = ?").get(u.id) as any;
        return json({ authenticated: true, ...u, onboarding_done: extra?.onboarding_done === 1 });
      }
      if (path === "/api/onboarding/complete" && method === "POST") {
        const auth = requireUser(req); if ("response" in auth) return auth.response;
        db.prepare("UPDATE users SET onboarding_done = 1 WHERE id = ?").run(auth.user.id);
        return json({ success: true });
      }
      if (path === "/api/onboarding/reset" && method === "POST") {
        const auth = requireUser(req); if ("response" in auth) return auth.response;
        db.prepare("UPDATE users SET onboarding_done = 0 WHERE id = ?").run(auth.user.id);
        return json({ success: true });
      }

      // ===== EMAIL DRAFTS =====
      if (path === "/api/drafts" && method === "GET") {
        const auth = requireUser(req); if ("response" in auth) return auth.response;
        const anlageId = url.searchParams.get("anlage_id");
        const sql = anlageId
          ? `SELECT d.*, a.name as anlage_name FROM email_drafts d LEFT JOIN anlagen a ON d.anlage_id = a.id WHERE d.user_id = ? AND d.anlage_id = ? ORDER BY d.updated_at DESC`
          : `SELECT d.*, a.name as anlage_name FROM email_drafts d LEFT JOIN anlagen a ON d.anlage_id = a.id WHERE d.user_id = ? ORDER BY d.updated_at DESC LIMIT 50`;
        const rows = anlageId
          ? db.prepare(sql).all(auth.user.id, parseInt(anlageId))
          : db.prepare(sql).all(auth.user.id);
        return json(rows);
      }
      if (path === "/api/drafts" && method === "POST") {
        const auth = requireUser(req); if ("response" in auth) return auth.response;
        const b = (await req.json()) as any;
        const r = db.prepare(`
          INSERT INTO email_drafts (user_id, anlage_id, to_addr, cc_addr, subject, body_html, attachment_ids, create_termin, termin_title, termin_start, termin_end, termin_description)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          auth.user.id, b.anlage_id || null, b.to_addr || null, b.cc_addr || null,
          b.subject || null, b.body_html || null,
          JSON.stringify(b.attachment_ids || []),
          b.create_termin ? 1 : 0,
          b.termin_title || null, b.termin_start || null, b.termin_end || null, b.termin_description || null,
        );
        return json({ success: true, id: r.lastInsertRowid });
      }
      const draftIdMatch = path.match(/^\/api\/drafts\/(\d+)$/);
      if (draftIdMatch && method === "PUT") {
        const auth = requireUser(req); if ("response" in auth) return auth.response;
        const id = parseInt(draftIdMatch[1]);
        const owner = db.prepare("SELECT user_id FROM email_drafts WHERE id = ?").get(id) as any;
        if (!owner || owner.user_id !== auth.user.id) return err("Nicht erlaubt", 403);
        const b = (await req.json()) as any;
        db.prepare(`
          UPDATE email_drafts SET
            to_addr = ?, cc_addr = ?, subject = ?, body_html = ?,
            attachment_ids = ?, create_termin = ?,
            termin_title = ?, termin_start = ?, termin_end = ?, termin_description = ?,
            updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).run(
          b.to_addr || null, b.cc_addr || null, b.subject || null, b.body_html || null,
          JSON.stringify(b.attachment_ids || []),
          b.create_termin ? 1 : 0,
          b.termin_title || null, b.termin_start || null, b.termin_end || null, b.termin_description || null,
          id,
        );
        return json({ success: true });
      }
      if (draftIdMatch && method === "DELETE") {
        const auth = requireUser(req); if ("response" in auth) return auth.response;
        const id = parseInt(draftIdMatch[1]);
        const owner = db.prepare("SELECT user_id FROM email_drafts WHERE id = ?").get(id) as any;
        if (!owner || owner.user_id !== auth.user.id) return err("Nicht erlaubt", 403);
        db.prepare("DELETE FROM email_drafts WHERE id = ?").run(id);
        return json({ success: true });
      }

      // ===== USERS =====
      if (path === "/api/users" && method === "GET") {
        const rows = db.prepare(`
          SELECT id, username, email, display_name, color, active, created_at,
            COALESCE(is_admin, 0)  AS is_admin,
            COALESCE(is_viewer, 0) AS is_viewer,
            CASE WHEN smtp_host IS NOT NULL THEN 1 ELSE 0 END as smtp_configured
          FROM users ORDER BY id
        `).all();
        return json(rows);
      }

      if (path === "/api/users" && method === "POST") {
        const auth = requireUser(req); if ("response" in auth) return auth.response;
        // Rollenvergabe: nur Admins duerfen neue Admins/Viewer anlegen
        if (auth.user.is_admin !== 1 && auth.user.username !== "admin") {
          return err("Nur Admin darf Benutzer anlegen", 403, { code: "ADMIN_REQUIRED" });
        }
        const b = (await req.json()) as any;
        const username = (b.username || "").trim().toLowerCase();
        const password = b.password || "";
        const email = (b.email || "").trim();
        const display_name = b.display_name || username;
        const color = b.color || "#3b82f6";
        const is_admin  = b.is_admin  === 1 || b.is_admin  === true ? 1 : 0;
        const is_viewer = b.is_viewer === 1 || b.is_viewer === true ? 1 : 0;
        if (is_admin && is_viewer) return err("Rollen Admin und Viewer schliessen sich aus", 400);
        if (!username || !password || !email) return err("Username, Passwort, Email erforderlich");
        // Username darf nur a-z 0-9 . _ - enthalten — keine Leerzeichen, keine Umlaute, kein @
        if (!/^[a-z0-9_.-]{2,32}$/.test(username)) {
          return err("Login-Name darf nur Kleinbuchstaben, Zahlen, Punkt/Bindestrich/Underscore enthalten (2-32 Zeichen). Keine Leerzeichen.", 400, { code: "INVALID_USERNAME" });
        }
        if (password.length < 6) return err("Passwort zu kurz (min 6 Zeichen)");
        const exists = db.prepare("SELECT id FROM users WHERE username = ?").get(username);
        if (exists) return err("Username bereits vergeben", 409);
        const hash = await Bun.password.hash(password, { algorithm: "bcrypt", cost: 10 });
        db.prepare(`
          INSERT INTO users (username, email, display_name, password_hash, color, active, is_admin, is_viewer)
          VALUES (?, ?, ?, ?, ?, 1, ?, ?)
        `).run(username, email, display_name, hash, color, is_admin, is_viewer);
        log.info("user_created", { by: auth.user.username, username, role: is_admin ? "admin" : (is_viewer ? "viewer" : "user") });
        return json({ success: true });
      }

      const userIdMatch = path.match(/^\/api\/users\/(\d+)$/);
      if (userIdMatch && method === "PUT") {
        const auth = requireUser(req); if ("response" in auth) return auth.response;
        const id = parseInt(userIdMatch[1]);
        const b = (await req.json()) as any;
        const isSelf = id === auth.user.id;
        const isAdmin = auth.user.is_admin === 1 || auth.user.username === "admin";
        // Rollenvergabe nur durch Admins, und nicht an sich selbst (Self-Lockout vermeiden)
        const wantsRoleChange = b.is_admin !== undefined || b.is_viewer !== undefined;
        if (wantsRoleChange && !isAdmin) return err("Nur Admin darf Rollen aendern", 403);
        if (wantsRoleChange && isSelf) return err("Eigene Rolle kann nicht geaendert werden", 400);
        const allowed = isAdmin ? ["email", "display_name", "color", "active", "is_admin", "is_viewer"] : ["email", "display_name", "color"];
        const fields: string[] = [];
        const vals: any[] = [];
        for (const k of allowed) {
          if (b[k] !== undefined) {
            const v = (k === "is_admin" || k === "is_viewer" || k === "active")
              ? (b[k] === 1 || b[k] === true ? 1 : 0) : b[k];
            fields.push(`${k} = ?`); vals.push(v);
          }
        }
        if (fields.length === 0) return err("Keine Aenderungen");
        // Konsistenz: admin und viewer schliessen sich aus
        if (b.is_admin === 1 && b.is_viewer === 1) return err("Rollen Admin und Viewer schliessen sich aus", 400);
        vals.push(id);
        db.prepare(`UPDATE users SET ${fields.join(", ")} WHERE id = ?`).run(...vals);
        if (wantsRoleChange) {
          log.info("user_role_changed", { by: auth.user.username, target_id: id, is_admin: b.is_admin, is_viewer: b.is_viewer });
        }
        return json({ success: true });
      }
      if (userIdMatch && method === "DELETE") {
        const auth = requireUser(req); if ("response" in auth) return auth.response;
        const id = parseInt(userIdMatch[1]);
        if (id === auth.user.id) return err("Eigenen Account nicht loeschen");
        db.prepare("UPDATE users SET active = 0 WHERE id = ?").run(id);
        db.prepare("DELETE FROM sessions WHERE user_id = ?").run(id);
        return json({ success: true });
      }

      const userPwMatch = path.match(/^\/api\/users\/(\d+)\/password$/);
      if (userPwMatch && method === "POST") {
        const auth = requireUser(req); if ("response" in auth) return auth.response;
        const id = parseInt(userPwMatch[1]);
        // Nur Admin darf andere User-Passwoerter aendern. Self-Service laeuft ueber /api/me/password.
        if (id !== auth.user.id) {
          if (auth.user.is_admin !== 1 && auth.user.username !== "admin") {
            return err("Nur Admin darf fremde Passwoerter aendern", 403);
          }
        }
        const b = (await req.json()) as any;
        if (!b.password || b.password.length < 6) return err("Passwort zu kurz (min 6)");
        const hash = await Bun.password.hash(b.password, { algorithm: "bcrypt", cost: 10 });
        db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(hash, id);
        if (id !== auth.user.id) {
          db.prepare("DELETE FROM sessions WHERE user_id = ?").run(id);
        }
        return json({ success: true });
      }

      // ===== PERSOENLICHES PROFIL =====
      // Konsolidierter Endpunkt — liefert alles was der eingeloggte User selbst sieht/aendert.
      if (path === "/api/me/profile" && method === "GET") {
        const auth = requireUser(req); if ("response" in auth) return auth.response;
        const r = db.prepare(`
          SELECT id, username, email, display_name, color, phone, bio, is_admin, onboarding_done,
            pref_default_tab, pref_default_filter, pref_reminder_snooze_min,
            pref_anlagen_sort, pref_map_marker_mode, pref_quiet_hours_start, pref_quiet_hours_end, pref_locale,
            totp_enabled, created_at
          FROM users WHERE id = ?
        `).get(auth.user.id) as any;
        // pref_default_filter ist JSON-String → parsen
        if (r?.pref_default_filter) {
          try { r.pref_default_filter = JSON.parse(r.pref_default_filter); }
          catch { r.pref_default_filter = null; }
        }
        return json(r);
      }
      if (path === "/api/me/profile" && method === "PUT") {
        const auth = requireUser(req); if ("response" in auth) return auth.response;
        const b = (await req.json()) as any;
        // Whitelist — User darf NICHT is_admin, username, password_hash o.ae. veraendern.
        const editable = [
          "display_name", "email", "color", "phone", "bio",
          "pref_default_tab", "pref_reminder_snooze_min",
          "pref_anlagen_sort", "pref_map_marker_mode",
          "pref_quiet_hours_start", "pref_quiet_hours_end", "pref_locale",
        ];
        const ALLOWED_TABS = ["dashboard", "anlagen", "karte", "kunden", "anfragen", "settings", "profile"];
        const ALLOWED_SORTS = ["lead_score_desc", "lead_score_asc", "leistung_desc", "leistung_asc", "inbetriebnahme_desc", "name_asc"];
        const ALLOWED_MARKERS = ["status", "lead_score", "owner"];
        const sets: string[] = [];
        const vals: any[] = [];
        for (const k of editable) {
          if (b[k] === undefined) continue;
          let v = b[k] === "" ? null : b[k];
          if (k === "pref_default_tab" && v !== null && !ALLOWED_TABS.includes(v)) return err(`Ungueltige default_tab: ${v}`);
          if (k === "pref_anlagen_sort" && v !== null && !ALLOWED_SORTS.includes(v)) return err(`Ungueltige Sortierung: ${v}`);
          if (k === "pref_map_marker_mode" && v !== null && !ALLOWED_MARKERS.includes(v)) return err(`Ungueltiger Marker-Mode: ${v}`);
          if (k === "pref_reminder_snooze_min" && v !== null) {
            const n = parseInt(v); if (isNaN(n) || n < 5 || n > 10080) return err("Snooze 5-10080 min");
            v = n;
          }
          if ((k === "pref_quiet_hours_start" || k === "pref_quiet_hours_end") && v !== null) {
            if (!/^\d{2}:\d{2}$/.test(v)) return err(`${k} muss HH:MM sein`);
          }
          if (k === "email" && v !== null && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) return err("Email ungueltig");
          sets.push(`${k} = ?`); vals.push(v);
        }
        if (b.pref_default_filter !== undefined) {
          const f = b.pref_default_filter;
          sets.push("pref_default_filter = ?");
          vals.push(f === null ? null : JSON.stringify(f));
        }
        if (sets.length === 0) return err("Keine Aenderungen");
        vals.push(auth.user.id);
        db.prepare(`UPDATE users SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
        return json({ success: true });
      }
      // Eigenes Passwort mit current-password-Check (Self-Service)
      if (path === "/api/me/password" && method === "POST") {
        const auth = requireUser(req); if ("response" in auth) return auth.response;
        const b = (await req.json()) as any;
        if (!b.current_password || !b.new_password) return err("current_password und new_password erforderlich");
        if (b.new_password.length < 6) return err("Neues Passwort zu kurz (min 6)");
        const u = db.prepare("SELECT password_hash FROM users WHERE id = ?").get(auth.user.id) as any;
        if (!u) return err("User nicht gefunden", 404);
        const ok = await Bun.password.verify(b.current_password, u.password_hash);
        if (!ok) return err("Aktuelles Passwort falsch", 403);
        const hash = await Bun.password.hash(b.new_password, { algorithm: "bcrypt", cost: 10 });
        db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(hash, auth.user.id);
        // Alle anderen Sessions invalidieren — der current request bleibt aktiv (Cookie unveraendert).
        const cookieToken = req.headers.get("cookie")?.match(/session=([^;]+)/)?.[1];
        if (cookieToken) {
          db.prepare("DELETE FROM sessions WHERE user_id = ? AND token != ?").run(auth.user.id, cookieToken);
        } else {
          db.prepare("DELETE FROM sessions WHERE user_id = ?").run(auth.user.id);
        }
        return json({ success: true });
      }

      // ===== USER ACTIVITY HISTORY — Live-Stream (SSE) =====
      // GET /api/me/activity/stream — Server-Sent-Events. Liefert neue Activity-Einträge
      // sobald sie passieren (logActivity-Wrapper publisht ans user.<id>.activity Topic).
      if (path === "/api/me/activity/stream" && method === "GET") {
        const auth = requireUser(req); if ("response" in auth) return auth.response;
        return sseResponse(req, `user.${auth.user.id}.activity`);
      }
      // ===== IMPORT-PROGRESS — Live-Stream (SSE, Admin-only) =====
      // Pollt import_log alle 2s und schickt nur bei Änderung einen Event.
      if (path === "/api/admin/import/stream" && method === "GET") {
        const auth = requireAdmin(req); if ("response" in auth) return auth.response;
        return sseResponse(req, "import.progress", {
          onOpen: (write) => {
            let lastSig = "";
            const tick = () => {
              if (req.signal.aborted) return;
              try {
                const running = db.prepare(`SELECT id, started_at, status, anlagen_inserted FROM import_log WHERE status = 'running' ORDER BY id DESC LIMIT 1`).get() as any;
                const last = db.prepare(`SELECT id, started_at, finished_at, status, anlagen_inserted, error_message FROM import_log WHERE status IN ('success','failed') ORDER BY id DESC LIMIT 1`).get() as any;
                const sig = JSON.stringify({ running, last });
                if (sig !== lastSig) {
                  write("progress", { running, last });
                  lastSig = sig;
                }
              } catch (e) { /* swallow */ }
              setTimeout(tick, 2000);
            };
            tick();
          },
        });
      }
      // ===== WEBHOOK-DELIVERY — Live-Stream (SSE, Admin-only) =====
      if (path === "/api/admin/webhooks/stream" && method === "GET") {
        const auth = requireAdmin(req); if ("response" in auth) return auth.response;
        return sseResponse(req, "webhook.delivery");
      }

      // ===== USER ACTIVITY HISTORY — AI-Zusammenfassung =====
      // POST /api/me/activity/summary  { days?: number = 7 }
      // Bündelt eigene Aktivitäten + Mentions der letzten N Tage und schickt sie an Claude.
      // Antwort in User-Locale (pref_locale).
      if (path === "/api/me/activity/summary" && method === "POST") {
        const auth = requireUser(req); if ("response" in auth) return auth.response;
        let b: any = {}; try { b = await req.json(); } catch {}
        const days = Math.max(1, Math.min(31, parseInt(b.days || "7", 10) || 7));
        const since = new Date(Date.now() - days * 86400_000).toISOString();
        const uid = auth.user.id;
        const u = db.prepare("SELECT ai_provider, anthropic_key_enc, pref_locale FROM users WHERE id = ?").get(uid) as any;
        if (!u) return err("User nicht gefunden", 404);
        if (!u.anthropic_key_enc) return err("Anthropic-API-Key fehlt — bitte in Settings → AI eintragen", 400);
        const acts = db.prepare(`
          SELECT a.type, a.description, a.created_at, an.mastr_nummer, an.eigentuemer_name
          FROM activities a LEFT JOIN anlagen an ON an.id = a.anlage_id
          WHERE a.user_id = ? AND a.created_at >= ?
          ORDER BY a.created_at DESC LIMIT 500
        `).all(uid, since) as any[];
        const mentions = db.prepare(`
          SELECT n.type, n.body, n.title, n.created_at, u.username as target_username, an.mastr_nummer
          FROM notifications n
          LEFT JOIN users u ON u.id = n.user_id
          LEFT JOIN anlagen an ON an.id = n.anlage_id
          WHERE n.from_user_id = ? AND n.type IN ('mention','comment') AND n.created_at >= ?
          ORDER BY n.created_at DESC LIMIT 200
        `).all(uid, since) as any[];
        if (acts.length === 0 && mentions.length === 0) {
          return json({ summary: tt(u.pref_locale || "de", "ai.summary.empty"), days, activity_count: 0 });
        }
        const locale = (u.pref_locale || "de-DE").slice(0, 2);
        const lang = { de: "Deutsch", en: "English", fr: "Français" }[locale] || "Deutsch";
        const lines: string[] = [];
        for (const a of acts.slice(0, 100)) lines.push(`[${a.created_at.slice(0, 10)}] ${a.type}: ${a.description}${a.mastr_nummer ? ` (Anlage ${a.mastr_nummer})` : ""}`);
        for (const m of mentions.slice(0, 50)) lines.push(`[${m.created_at.slice(0, 10)}] mention @${m.target_username || "?"}: ${(m.body || m.title || "").substring(0, 200)}`);
        const sysPrompt = `You are a concise CRM assistant. Summarise the user's activity for the last ${days} days. Output ${lang} only. Use Markdown headings: ## Highlights, ## Bottlenecks, ## Next steps. Keep under 300 words. No invented details.`;
        const userPrompt = `User activity log (last ${days} days):\n\n${lines.join("\n")}\n\nProduce the summary now.`;
        try {
          const apiKey = decrypt(u.anthropic_key_enc);
          const r = await fetch("https://api.anthropic.com/v1/messages", {
            method: "POST",
            headers: {
              "x-api-key": apiKey,
              "anthropic-version": "2023-06-01",
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              model: "claude-haiku-4-5-20251001",
              max_tokens: 800,
              system: sysPrompt,
              messages: [{ role: "user", content: userPrompt }],
            }),
          });
          if (!r.ok) {
            const t = await r.text();
            return err(`Anthropic ${r.status}: ${t.substring(0, 300)}`, 502);
          }
          const d = await r.json() as any;
          const summary = (d.content?.[0]?.text || "").trim();
          return json({ summary, days, activity_count: acts.length + mentions.length, model: d.model });
        } catch (e: any) {
          return err(`AI-Zusammenfassung fehlgeschlagen: ${e.message || e}`, 500);
        }
      }

      // ===== USER ACTIVITY HISTORY — Bulk-Mark-Read (eingehende Mentions) =====
      // PATCH /api/me/activity/mark-read  { ids: [<notification-id ohne i-prefix>] }
      // Setzt read_at = now für alle notifications die zu mir kommen (user_id = me).
      if (path === "/api/me/activity/mark-read" && method === "PATCH") {
        const auth = requireUser(req); if ("response" in auth) return auth.response;
        const b = (await req.json()) as any;
        const ids = Array.isArray(b.ids)
          ? b.ids.map((x: any) => (typeof x === "string" && x.startsWith("i") ? parseInt(x.slice(1), 10) : parseInt(x, 10))).filter((n: number) => !isNaN(n))
          : [];
        if (ids.length === 0) return err("ids erforderlich (Array)");
        if (ids.length > 500) return err("Maximal 500 IDs pro Aufruf", 413);
        const placeholders = ids.map(() => "?").join(",");
        const r = db.prepare(`
          UPDATE notifications
          SET read_at = COALESCE(read_at, CURRENT_TIMESTAMP)
          WHERE user_id = ? AND id IN (${placeholders})
        `).run(auth.user.id, ...ids);
        return json({ marked: Number(r.changes || 0), requested: ids.length });
      }

      // ===== USER ACTIVITY HISTORY — CSV-Export =====
      // Liefert das gleiche Feed wie /api/me/activity, aber als RFC-4180 CSV (mit BOM für Excel).
      // Maximale Pagination wird auf 5000 erhöht — das ist ein einmaliger Export, kein Pagination-Stream.
      if (path === "/api/me/activity.csv" && method === "GET") {
        const auth = requireUser(req); if ("response" in auth) return auth.response;
        const kind = (url.searchParams.get("kind") || "all").toLowerCase();
        const typeFilter = url.searchParams.get("type") || "";
        const q = (url.searchParams.get("q") || "").trim();
        const from = url.searchParams.get("from") || "";
        const to = url.searchParams.get("to") || "";
        const uid = auth.user.id;
        const rows: any[] = [];
        // Block A: Activities
        if (kind === "all" || kind === "activity") {
          const where: string[] = ["a.user_id = ?"]; const params: any[] = [uid];
          if (typeFilter) { where.push("a.type = ?"); params.push(typeFilter); }
          if (from) { where.push("a.created_at >= ?"); params.push(from); }
          if (to)   { where.push("a.created_at <= ?"); params.push(to); }
          if (q)    { where.push("(a.description LIKE ? OR an.mastr_nummer LIKE ? OR an.adresse LIKE ?)");
                     params.push("%"+q+"%","%"+q+"%","%"+q+"%"); }
          const r = db.prepare(`
            SELECT a.id, a.type, a.description, a.created_at, a.anlage_id,
                   an.mastr_nummer, an.adresse, an.eigentuemer_name
            FROM activities a LEFT JOIN anlagen an ON an.id = a.anlage_id
            WHERE ${where.join(" AND ")}
            ORDER BY a.created_at DESC LIMIT 5000
          `).all(...params) as any[];
          for (const x of r) rows.push({
            created_at: x.created_at, kind: "activity", type: x.type,
            description: x.description || "",
            anlage_label: x.mastr_nummer ? `${x.eigentuemer_name || ""} (${x.mastr_nummer})`.trim() : "",
            anlage_adresse: x.adresse || "",
            target_user: "", from_user: "",
          });
        }
        if (kind === "all" || kind === "mention") {
          const where: string[] = ["n.from_user_id = ?", "n.type IN ('mention','comment')"]; const params: any[] = [uid];
          if (from) { where.push("n.created_at >= ?"); params.push(from); }
          if (to)   { where.push("n.created_at <= ?"); params.push(to); }
          if (q)    { where.push("(n.title LIKE ? OR n.body LIKE ? OR u.username LIKE ?)");
                     params.push("%"+q+"%","%"+q+"%","%"+q+"%"); }
          const r = db.prepare(`
            SELECT n.id, n.type, n.title, n.body, n.created_at, n.anlage_id,
                   u.username as tu, u.display_name as tud,
                   an.mastr_nummer, an.adresse, an.eigentuemer_name
            FROM notifications n
            LEFT JOIN users u ON u.id = n.user_id
            LEFT JOIN anlagen an ON an.id = n.anlage_id
            WHERE ${where.join(" AND ")}
            ORDER BY n.created_at DESC LIMIT 5000
          `).all(...params) as any[];
          for (const x of r) rows.push({
            created_at: x.created_at, kind: "mention", type: x.type,
            description: x.body || x.title || "",
            anlage_label: x.mastr_nummer ? `${x.eigentuemer_name || ""} (${x.mastr_nummer})`.trim() : "",
            anlage_adresse: x.adresse || "",
            target_user: x.tud || x.tu || "",
            from_user: "",
          });
        }
        if (kind === "all" || kind === "incoming") {
          const where: string[] = ["n.user_id = ?", "n.type IN ('mention','comment')", "(n.from_user_id IS NULL OR n.from_user_id != ?)"];
          const params: any[] = [uid, uid];
          if (from) { where.push("n.created_at >= ?"); params.push(from); }
          if (to)   { where.push("n.created_at <= ?"); params.push(to); }
          if (q)    { where.push("(n.title LIKE ? OR n.body LIKE ? OR uf.username LIKE ?)");
                     params.push("%"+q+"%","%"+q+"%","%"+q+"%"); }
          const r = db.prepare(`
            SELECT n.id, n.type, n.title, n.body, n.created_at, n.anlage_id,
                   uf.username as fu, uf.display_name as fud,
                   an.mastr_nummer, an.adresse, an.eigentuemer_name
            FROM notifications n
            LEFT JOIN users uf ON uf.id = n.from_user_id
            LEFT JOIN anlagen an ON an.id = n.anlage_id
            WHERE ${where.join(" AND ")}
            ORDER BY n.created_at DESC LIMIT 5000
          `).all(...params) as any[];
          for (const x of r) rows.push({
            created_at: x.created_at, kind: "incoming", type: x.type,
            description: x.body || x.title || "",
            anlage_label: x.mastr_nummer ? `${x.eigentuemer_name || ""} (${x.mastr_nummer})`.trim() : "",
            anlage_adresse: x.adresse || "",
            target_user: "",
            from_user: x.fud || x.fu || "",
          });
        }
        rows.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
        // RFC-4180 CSV
        function csvEscape(v: any): string {
          const s = String(v ?? "");
          if (s.includes(",") || s.includes("\"") || s.includes("\n") || s.includes("\r")) {
            return "\"" + s.replace(/"/g, "\"\"") + "\"";
          }
          return s;
        }
        const cols = ["created_at","kind","type","description","anlage_label","anlage_adresse","target_user","from_user"];
        const lines = [cols.join(",")];
        for (const r of rows) lines.push(cols.map(c => csvEscape((r as any)[c])).join(","));
        const csv = "﻿" + lines.join("\r\n") + "\r\n"; // BOM für Excel
        const fname = `activity-${auth.user.username}-${new Date().toISOString().slice(0,10)}.csv`;
        return new Response(csv, {
          status: 200,
          headers: {
            "Content-Type": "text/csv; charset=utf-8",
            "Content-Disposition": `attachment; filename="${fname}"`,
            "Cache-Control": "no-store",
          },
        });
      }

      // ===== USER ACTIVITY HISTORY (Profil > Verlauf) =====
      // Liefert kombiniertes Feed: eigene Activities + ausgehende Mentions.
      // Query-Parameter:
      //   kind=all | activity | mention   (default: all)
      //   type=status_change|owner_change|note_added|note_deleted|email_sent|termin_created|comment_added|kontakt_updated|owner_auto_assign
      //          (nur fuer kind=activity wirksam; ignoriert bei kind=mention)
      //   q=Volltext-Suche in description/title/body
      //   from=ISO-Date, to=ISO-Date
      //   limit (1..200, default 50), offset (default 0)
      if (path === "/api/me/activity" && method === "GET") {
        const auth = requireUser(req); if ("response" in auth) return auth.response;
        const kind = (url.searchParams.get("kind") || "all").toLowerCase();
        const typeFilter = url.searchParams.get("type") || "";
        const q = (url.searchParams.get("q") || "").trim();
        const from = url.searchParams.get("from") || "";
        const to = url.searchParams.get("to") || "";
        const limit = Math.min(200, Math.max(1, parseInt(url.searchParams.get("limit") || "50", 10) || 50));
        const offset = Math.max(0, parseInt(url.searchParams.get("offset") || "0", 10) || 0);
        // Optionaler opaque Cursor — überschreibt offset, wenn vorhanden.
        // Cursor zeigt auf "vor diesem Eintrag weitermachen" (DESC by created_at).
        const cursorParam = url.searchParams.get("cursor");
        const cursor = decodeCursor(cursorParam);
        const uid = auth.user.id;

        // Collect rows from BOTH sources. Filtering happens in SQL where simple; merge in JS.
        const rows: any[] = [];

        if (kind === "all" || kind === "activity") {
          const where: string[] = ["a.user_id = ?"];
          const params: any[] = [uid];
          if (typeFilter && kind === "activity") { where.push("a.type = ?"); params.push(typeFilter); }
          else if (typeFilter && kind === "all") { where.push("a.type = ?"); params.push(typeFilter); }
          if (from) { where.push("a.created_at >= ?"); params.push(from); }
          if (to)   { where.push("a.created_at <= ?"); params.push(to); }
          if (q)    { where.push("(a.description LIKE ? OR an.mastr_nummer LIKE ? OR an.adresse LIKE ?)");
                     params.push("%" + q + "%", "%" + q + "%", "%" + q + "%"); }
          const sql = `
            SELECT a.id, a.type, a.description, a.metadata, a.created_at,
                   a.anlage_id, an.mastr_nummer, an.adresse,
                   an.eigentuemer_name
            FROM activities a
            LEFT JOIN anlagen an ON an.id = a.anlage_id
            WHERE ${where.join(" AND ")}
            ORDER BY a.created_at DESC
            LIMIT 500
          `;
          const r = db.prepare(sql).all(...params) as any[];
          for (const x of r) {
            rows.push({
              id: "a" + x.id,
              kind: "activity",
              type: x.type,
              description: x.description,
              metadata: x.metadata ? (() => { try { return JSON.parse(x.metadata); } catch { return null; } })() : null,
              anlage_id: x.anlage_id,
              anlage_label: x.mastr_nummer ? `${x.eigentuemer_name || ""} (${x.mastr_nummer})`.trim() : null,
              anlage_adresse: x.adresse || null,
              target_user_id: null,
              target_user_name: null,
              created_at: x.created_at,
            });
          }
        }
        if (kind === "all" || kind === "mention") {
          // Ausgehende Mentions: notifications WHERE from_user_id = me AND type IN ('mention','comment')
          const where: string[] = ["n.from_user_id = ?", "n.type IN ('mention','comment')"];
          const params: any[] = [uid];
          if (from) { where.push("n.created_at >= ?"); params.push(from); }
          if (to)   { where.push("n.created_at <= ?"); params.push(to); }
          if (q)    { where.push("(n.title LIKE ? OR n.body LIKE ? OR u.username LIKE ? OR u.display_name LIKE ?)");
                     params.push("%" + q + "%", "%" + q + "%", "%" + q + "%", "%" + q + "%"); }
          const sql = `
            SELECT n.id, n.type, n.title, n.body, n.anlage_id, n.created_at,
                   n.user_id as target_user_id, u.username as target_username, u.display_name as target_display_name,
                   an.mastr_nummer, an.adresse, an.eigentuemer_name
            FROM notifications n
            LEFT JOIN users u ON u.id = n.user_id
            LEFT JOIN anlagen an ON an.id = n.anlage_id
            WHERE ${where.join(" AND ")}
            ORDER BY n.created_at DESC
            LIMIT 500
          `;
          const r = db.prepare(sql).all(...params) as any[];
          for (const x of r) {
            rows.push({
              id: "m" + x.id,
              kind: "mention",
              type: x.type,                    // "mention" | "comment"
              description: x.body || x.title || "",
              metadata: null,
              anlage_id: x.anlage_id,
              anlage_label: x.mastr_nummer ? `${x.eigentuemer_name || ""} (${x.mastr_nummer})`.trim() : null,
              anlage_adresse: x.adresse || null,
              target_user_id: x.target_user_id,
              target_user_name: x.target_display_name || x.target_username || null,
              created_at: x.created_at,
            });
          }
        }
        // Incoming Mentions: notifications WHERE user_id = me AND type IN ('mention','comment') AND from_user_id != me
        // → wo MICH jemand markiert hat
        if (kind === "all" || kind === "incoming") {
          const where: string[] = ["n.user_id = ?", "n.type IN ('mention','comment')", "(n.from_user_id IS NULL OR n.from_user_id != ?)"];
          const params: any[] = [uid, uid];
          if (from) { where.push("n.created_at >= ?"); params.push(from); }
          if (to)   { where.push("n.created_at <= ?"); params.push(to); }
          if (q)    { where.push("(n.title LIKE ? OR n.body LIKE ? OR uf.username LIKE ? OR uf.display_name LIKE ?)");
                     params.push("%" + q + "%", "%" + q + "%", "%" + q + "%", "%" + q + "%"); }
          const sql = `
            SELECT n.id, n.type, n.title, n.body, n.anlage_id, n.created_at, n.read_at,
                   n.from_user_id, uf.username as from_username, uf.display_name as from_display_name,
                   an.mastr_nummer, an.adresse, an.eigentuemer_name
            FROM notifications n
            LEFT JOIN users uf ON uf.id = n.from_user_id
            LEFT JOIN anlagen an ON an.id = n.anlage_id
            WHERE ${where.join(" AND ")}
            ORDER BY n.created_at DESC
            LIMIT 500
          `;
          const r = db.prepare(sql).all(...params) as any[];
          for (const x of r) {
            rows.push({
              id: "i" + x.id,
              kind: "incoming",
              type: x.type,
              description: x.body || x.title || "",
              metadata: { read: !!x.read_at, from_user_id: x.from_user_id },
              anlage_id: x.anlage_id,
              anlage_label: x.mastr_nummer ? `${x.eigentuemer_name || ""} (${x.mastr_nummer})`.trim() : null,
              anlage_adresse: x.adresse || null,
              target_user_id: null,
              target_user_name: null,
              from_user_id: x.from_user_id,
              from_user_name: x.from_display_name || x.from_username || null,
              created_at: x.created_at,
            });
          }
        }
        // Sort merged feed descending by created_at + secondary by numeric-id portion of synthetic id.
        rows.sort((a, b) => {
          const c = String(b.created_at).localeCompare(String(a.created_at));
          if (c !== 0) return c;
          // Sekundär: id-Stelle hinter Prefix-Buchstabe (a/m/i)
          const ai = parseInt(String(a.id).slice(1), 10) || 0;
          const bi = parseInt(String(b.id).slice(1), 10) || 0;
          return bi - ai;
        });
        const total = rows.length;
        // Cursor-Mode: skip alles vor (und inkl.) der Cursor-Marke; sonst offset.
        let startIdx = offset;
        if (cursor) {
          const idx = rows.findIndex((r) => {
            const ts = r.created_at || "";
            const rid = parseInt(String(r.id).slice(1), 10) || 0;
            if (ts < (cursor.ts || "")) return true;
            if (ts === (cursor.ts || "") && rid < cursor.id) return true;
            return false;
          });
          startIdx = idx >= 0 ? idx : rows.length;
        }
        const page = rows.slice(startIdx, startIdx + limit);
        // Cursor für nächste Seite — aus dem LETZTEN Eintrag dieser Seite
        let nextCursor: string | null = null;
        if (page.length > 0 && startIdx + page.length < rows.length) {
          const last = page[page.length - 1];
          const lastId = parseInt(String(last.id).slice(1), 10) || 0;
          nextCursor = encodeCursor({ id: lastId, ts: last.created_at || null });
        }
        return json({ items: page, total, limit, offset: startIdx, next_cursor: nextCursor });
      }

      // ===== SMTP SETTINGS =====
      if (path === "/api/settings/smtp" && method === "GET") {
        const auth = requireUser(req); if ("response" in auth) return auth.response;
        const r = db.prepare(`
          SELECT smtp_host, smtp_port, smtp_secure, smtp_user, smtp_from_name, smtp_from_email,
            signature_html, signature_html_en, signature_html_fr,
            CASE WHEN smtp_pass_enc IS NOT NULL AND smtp_pass_enc != '' THEN 1 ELSE 0 END as has_password
          FROM users WHERE id = ?
        `).get(auth.user.id);
        return json(r);
      }
      if (path === "/api/settings/smtp" && method === "PUT") {
        const auth = requireUser(req); if ("response" in auth) return auth.response;
        const b = (await req.json()) as any;
        const fields = ["smtp_host", "smtp_port", "smtp_secure", "smtp_user", "smtp_from_name", "smtp_from_email", "signature_html", "signature_html_en", "signature_html_fr"];
        const sets: string[] = [];
        const vals: any[] = [];
        for (const k of fields) {
          if (b[k] !== undefined) { sets.push(`${k} = ?`); vals.push(b[k]); }
        }
        if (b.smtp_pass !== undefined && b.smtp_pass !== "") {
          sets.push("smtp_pass_enc = ?");
          vals.push(encrypt(b.smtp_pass));
        }
        if (sets.length === 0) return err("Keine Aenderungen");
        vals.push(auth.user.id);
        db.prepare(`UPDATE users SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
        return json({ success: true });
      }
      if (path === "/api/settings/smtp/test" && method === "POST") {
        const auth = requireUser(req); if ("response" in auth) return auth.response;
        try {
          // 1. Eigene SMTP-Config laden
          let u = db.prepare(`
            SELECT id, email, display_name, smtp_host, smtp_port, smtp_secure, smtp_user, smtp_pass_enc, smtp_from_name, smtp_from_email
            FROM users WHERE id = ?
          `).get(auth.user.id) as any;
          let usedFallback = false;
          // 2. Fallback: wenn eigene SMTP fehlt, nimm die des ersten Admin-Users
          if (!u?.smtp_host || !u?.smtp_pass_enc) {
            const fallback = db.prepare(`
              SELECT id, email, display_name, smtp_host, smtp_port, smtp_secure, smtp_user, smtp_pass_enc, smtp_from_name, smtp_from_email
              FROM users WHERE smtp_host IS NOT NULL AND smtp_pass_enc IS NOT NULL
              ORDER BY (is_admin = 1) DESC, id ASC LIMIT 1
            `).get() as any;
            if (!fallback) {
              return err(
                "Keine SMTP-Konfiguration vorhanden. Bitte in Einstellungen → SMTP Host, Port, Benutzer, Passwort eintragen. " +
                "Tipp: Wenn nur der Admin SMTP konfiguriert, koennen Mitarbeiter dessen Versand mitnutzen.",
                400, { code: "NO_SMTP_CONFIG" }
              );
            }
            u = { ...fallback, email: auth.user.email || fallback.email };
            usedFallback = true;
          }
          // Empfaenger: bevorzugt user.email — aber wenn die nicht routbar ist
          // (z.B. .local-Domain als Platzhalter), fallback auf smtp_user.
          const isRoutable = (em: string | null | undefined): boolean => {
            if (!em) return false;
            const dom = em.split("@")[1] || "";
            if (!dom.includes(".")) return false;
            const tld = dom.split(".").pop() || "";
            return !["local", "localhost", "test", "example", "invalid"].includes(tld);
          };
          const recipient = isRoutable(u.email) ? u.email : u.smtp_user;
          const transport = buildTransport(u);
          await transport.verify();
          await transport.sendMail({
            from: fromAddress(u),
            to: recipient,
            subject: "Test-Mail aus Solar DB" + (usedFallback ? " (via Admin-SMTP-Fallback)" : ""),
            html: `<p>Diese Test-Mail bestaetigt, dass die SMTP-Konfiguration funktioniert.</p>${usedFallback ? "<p><em>Hinweis: Du hast keine eigene SMTP — Versand laeuft ueber den Admin-Server.</em></p>" : ""}`,
          });
          return json({
            success: true,
            message: `Test-Mail an ${recipient} gesendet${usedFallback ? " (via Admin-SMTP-Fallback)" : ""}`,
            used_fallback: usedFallback,
          });
        } catch (e: any) {
          // Bessere Diagnose der haeufigsten SMTP-Fehler
          let hint = "";
          if (/EAUTH|535|Username/i.test(e.message)) hint = " → Benutzername/Passwort vermutlich falsch. Bei IONOS: volle Mail-Adresse als Benutzer.";
          else if (/ECONNECT|getaddrinfo|ENOTFOUND/i.test(e.message)) hint = " → Host nicht erreichbar. SMTP-Host pruefen.";
          else if (/timeout/i.test(e.message)) hint = " → Server reagiert nicht. Port + TLS-Einstellung pruefen.";
          else if (/SSL|TLS/i.test(e.message)) hint = " → TLS-Problem. Versuche secure=true bei Port 465 oder false bei 587.";
          return err(`SMTP-Test fehlgeschlagen: ${e.message}${hint}`, 400, { code: "SMTP_TEST_FAILED" });
        }
      }

      // ===== IMAP SETTINGS (Reply-Tracking) =====
      if (path === "/api/settings/imap" && method === "GET") {
        const auth = requireUser(req); if ("response" in auth) return auth.response;
        const r = db.prepare(`
          SELECT imap_host, imap_port, imap_secure, imap_user, imap_enabled,
            CASE WHEN imap_pass_enc IS NOT NULL AND imap_pass_enc != '' THEN 1 ELSE 0 END as has_password,
            CASE WHEN smtp_pass_enc IS NOT NULL AND smtp_pass_enc != '' THEN 1 ELSE 0 END as has_smtp_password
          FROM users WHERE id = ?
        `).get(auth.user.id);
        return json(r);
      }
      if (path === "/api/settings/imap" && method === "PUT") {
        const auth = requireUser(req); if ("response" in auth) return auth.response;
        const b = (await req.json()) as any;
        const fields = ["imap_host", "imap_port", "imap_secure", "imap_user", "imap_enabled"];
        const sets: string[] = []; const vals: any[] = [];
        for (const k of fields) {
          if (b[k] !== undefined) { sets.push(`${k} = ?`); vals.push(b[k]); }
        }
        if (b.imap_pass !== undefined && b.imap_pass !== "") {
          sets.push("imap_pass_enc = ?"); vals.push(encrypt(b.imap_pass));
        }
        if (sets.length === 0) return err("Keine Aenderungen");
        vals.push(auth.user.id);
        db.prepare(`UPDATE users SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
        return json({ success: true });
      }
      if (path === "/api/settings/imap/test" && method === "POST") {
        const auth = requireUser(req); if ("response" in auth) return auth.response;
        try {
          const { ImapFlow } = await import("imapflow");
          const u = db.prepare(`
            SELECT email, imap_host, imap_port, imap_secure, imap_user, imap_pass_enc, smtp_user, smtp_pass_enc
            FROM users WHERE id = ?
          `).get(auth.user.id) as any;
          if (!u.imap_host) return err("IMAP-Host fehlt", 400);
          const passEnc = u.imap_pass_enc || u.smtp_pass_enc;
          const user = u.imap_user || u.smtp_user || u.email;
          if (!passEnc) return err("Kein IMAP-Passwort (oder SMTP-Fallback) gesetzt", 400);
          const client = new ImapFlow({
            host: u.imap_host, port: u.imap_port || 993, secure: !!u.imap_secure,
            auth: { user, pass: decrypt(passEnc) }, logger: false, socketTimeout: 15_000,
          });
          await client.connect();
          const status = await client.status("INBOX", { messages: true, uidNext: true });
          await client.logout();
          return json({ success: true, message: `INBOX OK: ${status.messages || 0} Nachrichten`, uidNext: status.uidNext });
        } catch (e: any) {
          return err(`IMAP-Test fehlgeschlagen: ${e.message}`, 400);
        }
      }
      if (path === "/api/settings/imap/poll-now" && method === "POST") {
        const auth = requireUser(req); if ("response" in auth) return auth.response;
        try {
          const { pollUserImap } = await import("./lib/imap-poller");
          const full = url.searchParams.get("full") === "1";
          // Bei Full-Import: imap_last_uid zuruecksetzen, viel groesseres Limit
          if (full) {
            db.prepare("UPDATE users SET imap_last_uid = 0 WHERE id = ?").run(auth.user.id);
          }
          const u = db.prepare(`
            SELECT id, username, email,
              imap_host, imap_port, imap_secure, imap_user, imap_pass_enc, imap_last_uid,
              smtp_user, smtp_pass_enc
            FROM users WHERE id = ?
          `).get(auth.user.id) as any;
          const stats = await pollUserImap(db, u, { maxFetch: full ? 5000 : 200 });
          return json({ success: true, full, ...stats });
        } catch (e: any) {
          return err(`Poll fehlgeschlagen: ${e.message}`, 400);
        }
      }

      // ===== EMAIL REPLIES (Inbox) =====
      if (path === "/api/replies" && method === "GET") {
        const auth = requireUser(req); if ("response" in auth) return auth.response;
        const u = new URL(req.url);
        const onlyUnread = u.searchParams.get("unread") === "1";
        const where = onlyUnread ? "AND r.read_at IS NULL" : "";
        const rows = db.prepare(`
          SELECT r.id, r.user_id, r.sent_email_id, r.anlage_id, r.from_addr, r.from_name,
            r.subject, substr(r.body_text, 1, 300) as body_preview, r.received_at, r.read_at,
            a.name as anlage_name, a.mastr_nummer, a.status as anlage_status
          FROM email_replies r
          LEFT JOIN anlagen a ON r.anlage_id = a.id
          WHERE r.user_id = ? ${where}
          ORDER BY r.received_at DESC
          LIMIT 200
        `).all(auth.user.id);
        return json(rows);
      }
      const replyIdMatch = path.match(/^\/api\/replies\/(\d+)$/);
      if (replyIdMatch && method === "GET") {
        const auth = requireUser(req); if ("response" in auth) return auth.response;
        const id = parseInt(replyIdMatch[1]);
        const r = db.prepare(`
          SELECT r.*, a.name as anlage_name, a.mastr_nummer
          FROM email_replies r
          LEFT JOIN anlagen a ON r.anlage_id = a.id
          WHERE r.id = ? AND r.user_id = ?
        `).get(id, auth.user.id) as any;
        if (!r) return err("Nicht gefunden", 404, { code: "NOT_FOUND" });
        // Anhaenge mitliefern (ohne file_path — der bleibt server-intern)
        const atts = db.prepare(`
          SELECT id, filename, content_type, size_bytes, content_id
          FROM email_reply_attachments WHERE reply_id = ? ORDER BY id
        `).all(id);
        r.attachments = atts;
        return json(r);
      }

      // Download eines Anhangs
      const replyAttMatch = path.match(/^\/api\/replies\/(\d+)\/attachments\/(\d+)$/);
      if (replyAttMatch && method === "GET") {
        const auth = requireUser(req); if ("response" in auth) return auth.response;
        const replyId = parseInt(replyAttMatch[1]);
        const attId = parseInt(replyAttMatch[2]);
        const att = db.prepare(`
          SELECT a.filename, a.content_type, a.size_bytes, a.file_path
          FROM email_reply_attachments a
          JOIN email_replies r ON r.id = a.reply_id
          WHERE a.id = ? AND a.reply_id = ? AND r.user_id = ?
        `).get(attId, replyId, auth.user.id) as any;
        if (!att) return err("Anhang nicht gefunden", 404);
        const f = file(att.file_path);
        if (!(await f.exists())) return err("Datei fehlt auf Disk", 404);
        const download = url.searchParams.get("dl") === "1";
        return new Response(f, {
          headers: {
            "Content-Type": att.content_type || "application/octet-stream",
            "Content-Disposition": `${download ? "attachment" : "inline"}; filename="${att.filename}"`,
            "Cache-Control": "private, max-age=300",
          },
        });
      }
      if (replyIdMatch && method === "PUT") {
        const auth = requireUser(req); if ("response" in auth) return auth.response;
        const id = parseInt(replyIdMatch[1]);
        const b = (await req.json()) as any;
        const sets: string[] = []; const vals: any[] = [];
        if (b.read === true || b.read === 1) { sets.push("read_at = COALESCE(read_at, CURRENT_TIMESTAMP)"); }
        if (b.read === false || b.read === 0) { sets.push("read_at = NULL"); }
        if (b.anlage_id !== undefined) { sets.push("anlage_id = ?"); vals.push(b.anlage_id || null); }
        if (sets.length === 0) return err("Keine Aenderungen");
        vals.push(id, auth.user.id);
        db.prepare(`UPDATE email_replies SET ${sets.join(", ")} WHERE id = ? AND user_id = ?`).run(...vals);
        return json({ success: true });
      }
      const repliesAnlageMatch = path.match(/^\/api\/anlagen\/(\d+)\/replies$/);
      if (repliesAnlageMatch && method === "GET") {
        const auth = requireUser(req); if ("response" in auth) return auth.response;
        const id = parseInt(repliesAnlageMatch[1]);
        const rows = db.prepare(`
          SELECT id, from_addr, from_name, subject, substr(body_text, 1, 500) as body_preview, received_at, read_at
          FROM email_replies WHERE anlage_id = ?
          ORDER BY received_at DESC LIMIT 50
        `).all(id);
        return json(rows);
      }

      // ===== EMAIL TEMPLATES =====
      if (path === "/api/email-templates" && method === "GET") {
        const auth = requireUser(req); if ("response" in auth) return auth.response;
        const rows = db.prepare(`
          SELECT id, user_id, name, subject, body_html, is_default, created_at
          FROM email_templates
          WHERE user_id IS NULL OR user_id = ?
          ORDER BY user_id IS NULL DESC, name
        `).all(auth.user.id);
        return json(rows);
      }
      if (path === "/api/email-templates" && method === "POST") {
        const auth = requireUser(req); if ("response" in auth) return auth.response;
        const b = (await req.json()) as any;
        if (!b.name) return err("Name erforderlich");
        const userId = b.is_global ? null : auth.user.id;
        db.prepare(`
          INSERT INTO email_templates (user_id, name, subject, body_html, is_default)
          VALUES (?, ?, ?, ?, 0)
        `).run(userId, b.name, b.subject || "", b.body_html || "");
        return json({ success: true });
      }
      const tplIdMatch = path.match(/^\/api\/email-templates\/(\d+)$/);
      if (tplIdMatch && method === "PUT") {
        const auth = requireUser(req); if ("response" in auth) return auth.response;
        const id = parseInt(tplIdMatch[1]);
        const b = (await req.json()) as any;
        db.prepare(`UPDATE email_templates SET name = ?, subject = ?, body_html = ? WHERE id = ?`)
          .run(b.name, b.subject || "", b.body_html || "", id);
        return json({ success: true });
      }
      if (tplIdMatch && method === "DELETE") {
        const auth = requireUser(req); if ("response" in auth) return auth.response;
        db.prepare("DELETE FROM email_templates WHERE id = ?").run(parseInt(tplIdMatch[1]));
        return json({ success: true });
      }

      // ===== ATTACHMENTS =====
      // ===== ANLAGEN-BILDER (Foto-Dokumentation) =====
      const anlImgsListMatch = path.match(/^\/api\/anlagen\/(\d+)\/images$/);
      if (anlImgsListMatch && method === "GET") {
        const auth = requireUser(req); if ("response" in auth) return auth.response;
        const anlageId = parseInt(anlImgsListMatch[1]);
        const exists = db.prepare("SELECT id FROM anlagen WHERE id = ?").get(anlageId);
        if (!exists) return err("Anlage nicht gefunden", 404, { code: "NOT_FOUND" });
        const rows = db.prepare(`
          SELECT i.*, u.display_name as uploaded_by_name
          FROM anlage_images i
          LEFT JOIN users u ON u.id = i.uploaded_by
          WHERE i.anlage_id = ?
          ORDER BY i.uploaded_at DESC
        `).all(anlageId) as any[];
        const { toAnlageImageView } = await import("./lib/anlage-images");
        return json(rows.map(toAnlageImageView));
      }
      if (anlImgsListMatch && method === "POST") {
        const auth = requireUser(req); if ("response" in auth) return auth.response;
        if (auth.user.is_viewer === 1) return err("Viewer-Account darf nicht hochladen", 403);
        const anlageId = parseInt(anlImgsListMatch[1]);
        const exists = db.prepare("SELECT id FROM anlagen WHERE id = ?").get(anlageId);
        if (!exists) return err("Anlage nicht gefunden", 404, { code: "NOT_FOUND" });
        const cl = parseInt(req.headers.get("content-length") || "0");
        const { ALLOWED_IMAGE_MIME, MAX_IMAGE_BYTES, toAnlageImageView } = await import("./lib/anlage-images");
        if (cl > MAX_IMAGE_BYTES + 1024 * 1024) return err("Bild zu gross (max 10 MB)", 413);
        const fd = await req.formData();
        const f = fd.get("file") as File | null;
        const caption = String(fd.get("caption") || "").trim().substring(0, 200) || null;
        if (!f) return err("Keine Datei");
        if (f.size > MAX_IMAGE_BYTES) return err("Bild zu gross (max 10 MB)", 413);
        if (!ALLOWED_IMAGE_MIME.has(f.type)) return err(`Nur Bilder (JPG/PNG/WebP/GIF) — abgewiesen: ${f.type}`, 415);
        const ext = extname(f.name).toLowerCase().substring(0, 10) || ".bin";
        const dir = join(UPLOADS_DIR, "anlage-images", String(anlageId));
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
        const uuid = randomBytes(16).toString("hex");
        const storedPath = join(dir, uuid + ext);
        await Bun.write(storedPath, f);
        const res = db.prepare(`
          INSERT INTO anlage_images (anlage_id, stored_path, original_name, mime_type, size_bytes, caption, uploaded_by)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(anlageId, storedPath, f.name, f.type, f.size, caption, auth.user.id);
        logActivity(db, "anlage", anlageId, "image_uploaded", auth.user.id, auth.user.username, `image=${f.name}`);
        const row = db.prepare(`
          SELECT i.*, u.display_name as uploaded_by_name
          FROM anlage_images i LEFT JOIN users u ON u.id = i.uploaded_by
          WHERE i.id = ?
        `).get(Number(res.lastInsertRowid));
        return json({ success: true, image: toAnlageImageView(row) });
      }
      const anlImgOneMatch = path.match(/^\/api\/anlagen\/(\d+)\/images\/(\d+)$/);
      if (anlImgOneMatch && method === "GET") {
        const auth = requireUser(req); if ("response" in auth) return auth.response;
        const anlageId = parseInt(anlImgOneMatch[1]);
        const imgId = parseInt(anlImgOneMatch[2]);
        const r = db.prepare("SELECT * FROM anlage_images WHERE id = ? AND anlage_id = ?").get(imgId, anlageId) as any;
        if (!r) return err("Nicht gefunden", 404, { code: "NOT_FOUND" });
        return new Response(file(r.stored_path), {
          headers: {
            "Content-Type": r.mime_type || "application/octet-stream",
            "Cache-Control": "private, max-age=3600",
          },
        });
      }
      if (anlImgOneMatch && method === "PATCH") {
        const auth = requireUser(req); if ("response" in auth) return auth.response;
        if (auth.user.is_viewer === 1) return err("Viewer-Account darf nicht ändern", 403);
        const anlageId = parseInt(anlImgOneMatch[1]);
        const imgId = parseInt(anlImgOneMatch[2]);
        const r = db.prepare("SELECT * FROM anlage_images WHERE id = ? AND anlage_id = ?").get(imgId, anlageId) as any;
        if (!r) return err("Nicht gefunden", 404, { code: "NOT_FOUND" });
        const b = (await req.json()) as any;
        const caption = String(b.caption || "").trim().substring(0, 200) || null;
        db.prepare("UPDATE anlage_images SET caption = ? WHERE id = ?").run(caption, imgId);
        return json({ success: true, caption });
      }
      if (anlImgOneMatch && method === "DELETE") {
        const auth = requireUser(req); if ("response" in auth) return auth.response;
        if (auth.user.is_viewer === 1) return err("Viewer-Account darf nicht löschen", 403);
        const anlageId = parseInt(anlImgOneMatch[1]);
        const imgId = parseInt(anlImgOneMatch[2]);
        const r = db.prepare("SELECT * FROM anlage_images WHERE id = ? AND anlage_id = ?").get(imgId, anlageId) as any;
        if (!r) return err("Nicht gefunden", 404, { code: "NOT_FOUND" });
        if (r.uploaded_by !== auth.user.id && !auth.user.is_admin) return err("Nur Uploader oder Admin darf löschen", 403);
        try { unlinkSync(r.stored_path); } catch {}
        db.prepare("DELETE FROM anlage_images WHERE id = ?").run(imgId);
        logActivity(db, "anlage", anlageId, "image_deleted", auth.user.id, auth.user.username, `image_id=${imgId}`);
        return json({ success: true });
      }

      if (path === "/api/attachments" && method === "GET") {
        const auth = requireUser(req); if ("response" in auth) return auth.response;
        const rows = db.prepare(`
          SELECT id, user_id, original_name, mime_type, size_bytes, created_at,
            CASE WHEN user_id IS NULL THEN 1 ELSE 0 END as is_global
          FROM attachments
          WHERE user_id IS NULL OR user_id = ?
          ORDER BY created_at DESC
        `).all(auth.user.id);
        return json(rows);
      }
      if (path === "/api/attachments" && method === "POST") {
        const auth = requireUser(req); if ("response" in auth) return auth.response;
        const cl = parseInt(req.headers.get("content-length") || "0");
        if (cl > MAX_UPLOAD_BYTES + 1024 * 1024) return err("Datei zu gross (max 10 MB)", 413);
        const fd = await req.formData();
        const f = fd.get("file") as File | null;
        const isGlobal = fd.get("is_global") === "1";
        if (!f) return err("Keine Datei");
        if (f.size > MAX_UPLOAD_BYTES) return err("Datei zu gross (max 10 MB)", 413);
        if (!ALLOWED_MIME.has(f.type)) return err(`MIME-Typ ${f.type} nicht erlaubt`, 415);
        const ext = extname(f.name).toLowerCase().substring(0, 10) || ".bin";
        const subdir = isGlobal ? "global" : String(auth.user.id);
        const dir = join(UPLOADS_DIR, subdir);
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
        const uuid = randomBytes(16).toString("hex");
        const storedPath = join(dir, uuid + ext);
        await Bun.write(storedPath, f);
        const res = db.prepare(`
          INSERT INTO attachments (user_id, original_name, stored_path, mime_type, size_bytes)
          VALUES (?, ?, ?, ?, ?)
        `).run(isGlobal ? null : auth.user.id, f.name, storedPath, f.type, f.size);
        return json({ success: true, id: Number(res.lastInsertRowid), original_name: f.name });
      }
      const attIdMatch = path.match(/^\/api\/attachments\/(\d+)$/);
      if (attIdMatch && method === "GET") {
        const auth = requireUser(req); if ("response" in auth) return auth.response;
        const id = parseInt(attIdMatch[1]);
        const r = db.prepare("SELECT * FROM attachments WHERE id = ? AND (user_id IS NULL OR user_id = ?)").get(id, auth.user.id) as any;
        if (!r) return err("Nicht gefunden", 404, { code: "NOT_FOUND" });
        return new Response(file(r.stored_path), {
          headers: {
            "Content-Type": r.mime_type || "application/octet-stream",
            "Content-Disposition": `attachment; filename="${encodeURIComponent(r.original_name)}"`,
          },
        });
      }
      if (attIdMatch && method === "DELETE") {
        const auth = requireUser(req); if ("response" in auth) return auth.response;
        const id = parseInt(attIdMatch[1]);
        const r = db.prepare("SELECT * FROM attachments WHERE id = ?").get(id) as any;
        if (!r) return err("Nicht gefunden", 404, { code: "NOT_FOUND" });
        if (r.user_id !== null && r.user_id !== auth.user.id) return err("Nicht erlaubt", 403);
        try { unlinkSync(r.stored_path); } catch {}
        db.prepare("DELETE FROM attachments WHERE id = ?").run(id);
        return json({ success: true });
      }

      // ===== STATIC =====
      if (path === "/" || path === "/login") {
        return new Response(file("static/index.html"), {
          headers: {
            "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": "no-cache, no-store, must-revalidate",
            "Pragma": "no-cache",
            "Expires": "0",
          },
        });
      }
      // Generic /static/* Handler — fuer theme.css und kuenftige Assets.
      // Whitelist nur sicherer Extensions, Pfad-Traversal verhindern.
      if (path.startsWith("/static/") && method === "GET") {
        const safe = path.replace(/\.\.\//g, "").replace(/^\/+/, "");
        const ext = safe.split(".").pop()?.toLowerCase() || "";
        const allowed: Record<string, string> = {
          css: "text/css; charset=utf-8",
          js:  "application/javascript; charset=utf-8",
          png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
          gif: "image/gif", svg: "image/svg+xml", webp: "image/webp", ico: "image/x-icon",
          woff: "font/woff", woff2: "font/woff2", ttf: "font/ttf",
          json: "application/json; charset=utf-8",
        };
        const ct = allowed[ext];
        if (ct) {
          const f = file(safe);
          if (await f.exists()) {
            return new Response(f, {
              headers: {
                "Content-Type": ct,
                "Cache-Control": "public, max-age=600",
              },
            });
          }
        }
      }
      // i18n-Locale-Auslieferung (public, lang gegen Whitelist validiert).
      // ETag-fähig, 5min Browser-Cache. Frontend laedt /api/i18n/de.json, en.json, fr.json.
      const i18nMatch = path.match(/^\/api\/i18n\/([a-z]{2})\.json$/);
      if (i18nMatch && method === "GET") {
        const lang = i18nMatch[1];
        const ALLOWED_LANGS = ["de", "en", "fr"];
        if (!ALLOWED_LANGS.includes(lang)) return err("Sprache nicht unterstuetzt", 404, { code: "LANG_NOT_SUPPORTED" });
        const f = file(`static/locales/${lang}.json`);
        if (!(await f.exists())) return err("Locale-Datei fehlt", 404, { code: "LOCALE_MISSING" });
        return new Response(f, {
          headers: {
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "public, max-age=300",
            "Vary": "Accept-Language",
          },
        });
      }

      // UGC-Translation (Notizen/Kommentare/Lead-Texte/Mails) per MyMemory + DB-Cache.
      // Target wird aus User-pref_locale gezogen; Body = { texts: string[], to?: locale }
      if (path === "/api/translate/batch" && method === "POST") {
        const auth = requireUser(req); if ("response" in auth) return auth.response;
        let body: any = {};
        try { body = await req.json(); } catch {}
        const texts: string[] = Array.isArray(body?.texts) ? body.texts.filter((x: any) => typeof x === "string") : [];
        if (texts.length === 0) return json({});
        const to = (body?.to as string) || (auth.user as any).pref_locale || "de-DE";
        try {
          const map = await translateBatch(db, texts.slice(0, 100), to);
          return json(map);
        } catch (e: any) {
          return err("Uebersetzung fehlgeschlagen: " + (e?.message || e), 502);
        }
      }

      // ===== GraphQL =====
      // POST /graphql  Body: { query, variables?, operationName? }
      // Authentifizierung über vorhandene Session / Bearer.
      if (path === "/graphql" && method === "POST") {
        const auth = requireUser(req); if ("response" in auth) return auth.response;
        let body: any = {}; try { body = await req.json(); } catch {}
        if (!body.query || typeof body.query !== "string") return err("query erforderlich");
        try {
          const result = await runGraphQL(body.query, body.variables, {
            db,
            userId: auth.user.id,
            isAdmin: auth.user.is_admin === 1 || auth.user.username === "admin",
            isViewer: !!(auth.user as any).is_viewer,
          });
          return json(result);
        } catch (e: any) {
          return err(`GraphQL-Fehler: ${e.message || e}`, 500);
        }
      }

      // ===== API-Versions-Discovery =====
      if (path === "/api/versions" && method === "GET") {
        return json({
          versions: API_VERSIONS,
          latest: API_VERSION_LATEST,
          how_to_use: "Set header 'API-Version: <version>' on each request. Unknown values fall back to latest with a Warning header.",
        });
      }

      // Health-Endpoint (auth-free) — fuer Uptime-Checks und API-Doku
      if (path === "/api/health") {
        return json({ ok: true, time: new Date().toISOString() });
      }
      // P2-20: Deep-Health — DB-Check, Disk-Check, Migrations-Version, Counts
      if (path === "/api/healthz") {
        const checks: Record<string, any> = {};
        try {
          const r = db.prepare("SELECT 1 as x").get() as any;
          checks.db = r?.x === 1 ? "ok" : "fail";
        } catch (e: any) { checks.db = `fail: ${e?.message}`; }
        try {
          const c = (db.prepare("SELECT COUNT(*) as c FROM anlagen").get() as any).c;
          checks.anlagen_count = c;
        } catch (e: any) { checks.anlagen_count = `fail: ${e?.message}`; }
        try {
          const ob = (db.prepare("SELECT COUNT(*) as c FROM api_bug_log WHERE resolved_at IS NULL").get() as any).c;
          checks.open_bugs = ob;
        } catch { checks.open_bugs = -1; }
        try {
          checks.memory_rss_mb = Math.round(process.memoryUsage().rss / 1024 / 1024);
        } catch {}
        const ok = checks.db === "ok";
        return new Response(JSON.stringify({ status: ok ? "healthy" : "degraded", checks, time: new Date().toISOString() }), {
          status: ok ? 200 : 503,
          headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
        });
      }
      // P2-21: Prometheus-Exposition (text/plain, kein JSON)
      if (path === "/api/metrics") {
        try {
          const since = new Date(Date.now() - 3600_000).toISOString();
          const stats = {
            total: (db.prepare("SELECT COUNT(*) c FROM api_request_log WHERE created_at >= ?").get(since) as any).c,
            ok: (db.prepare("SELECT COUNT(*) c FROM api_request_log WHERE created_at >= ? AND status < 400").get(since) as any).c,
            client_err: (db.prepare("SELECT COUNT(*) c FROM api_request_log WHERE created_at >= ? AND status >= 400 AND status < 500").get(since) as any).c,
            server_err: (db.prepare("SELECT COUNT(*) c FROM api_request_log WHERE created_at >= ? AND status >= 500").get(since) as any).c,
            open_bugs: (db.prepare("SELECT COUNT(*) c FROM api_bug_log WHERE resolved_at IS NULL").get() as any).c,
            active_tokens: (db.prepare("SELECT COUNT(*) c FROM api_tokens WHERE revoked_at IS NULL").get() as any).c,
            anlagen_total: (db.prepare("SELECT COUNT(*) c FROM anlagen").get() as any).c,
            anlagen_owned: (db.prepare("SELECT COUNT(*) c FROM anlagen WHERE owner_id IS NOT NULL").get() as any).c,
            reminders_pending: (db.prepare("SELECT COUNT(*) c FROM reminders WHERE status='pending'").get() as any).c,
          };
          const mem = process.memoryUsage();
          const out = [
            `# HELP mastr_api_requests_total Number of API requests in the last hour (by class)`,
            `# TYPE mastr_api_requests_total counter`,
            `mastr_api_requests_total{class="ok"} ${stats.ok}`,
            `mastr_api_requests_total{class="client_err"} ${stats.client_err}`,
            `mastr_api_requests_total{class="server_err"} ${stats.server_err}`,
            ``,
            `# HELP mastr_api_open_bugs Open bug count`,
            `# TYPE mastr_api_open_bugs gauge`,
            `mastr_api_open_bugs ${stats.open_bugs}`,
            ``,
            `# HELP mastr_api_active_tokens Number of active (non-revoked) tokens`,
            `# TYPE mastr_api_active_tokens gauge`,
            `mastr_api_active_tokens ${stats.active_tokens}`,
            ``,
            `# HELP mastr_anlagen_total Total anlagen in DB`,
            `# TYPE mastr_anlagen_total gauge`,
            `mastr_anlagen_total ${stats.anlagen_total}`,
            ``,
            `# HELP mastr_anlagen_owned Anlagen with assigned owner (worked on)`,
            `# TYPE mastr_anlagen_owned gauge`,
            `mastr_anlagen_owned ${stats.anlagen_owned}`,
            ``,
            `# HELP mastr_reminders_pending Pending reminders`,
            `# TYPE mastr_reminders_pending gauge`,
            `mastr_reminders_pending ${stats.reminders_pending}`,
            ``,
            `# HELP mastr_memory_rss_bytes Resident set size`,
            `# TYPE mastr_memory_rss_bytes gauge`,
            `mastr_memory_rss_bytes ${mem.rss}`,
            ``,
          ].join("\n");
          return new Response(out, { headers: { "Content-Type": "text/plain; version=0.0.4; charset=utf-8", "Cache-Control": "no-store" } });
        } catch (e: any) {
          return new Response(`# error: ${e?.message}`, { status: 500, headers: { "Content-Type": "text/plain" } });
        }
      }
      // OpenAPI 3.1 Spec (gleicher Basic-Auth-Schutz wie Markdown-Doku)
      if (path === "/docs/openapi.yaml" || path === "/docs/openapi.yml" || path === "/docs/openapi.json") {
        const docPwRow = db.prepare("SELECT hash FROM app_secrets WHERE key = 'docs_api_password'").get() as { hash: string } | undefined;
        if (!docPwRow?.hash) return new Response("API-Doku gesperrt", { status: 503 });
        const authHdr = req.headers.get("authorization") || "";
        if (!authHdr.toLowerCase().startsWith("basic ")) {
          return new Response("Authentifizierung erforderlich", { status: 401, headers: { "WWW-Authenticate": 'Basic realm="mastr-solar API Docs"', "Cache-Control": "no-store" } });
        }
        let plainPw = "";
        try { const dec = atob(authHdr.slice(6).trim()); const i = dec.indexOf(":"); plainPw = i >= 0 ? dec.slice(i + 1) : dec; } catch {}
        const ok = await Bun.password.verify(plainPw, docPwRow.hash).catch(() => false);
        if (!ok) return new Response("Falsches Passwort", { status: 401, headers: { "WWW-Authenticate": 'Basic realm="mastr-solar API Docs"' } });
        if (path.endsWith(".json")) {
          // YAML → JSON: schnelle Konvertierung via Bun's eingebautes Modul oder Library
          // Da YAML in der OpenAPI standardisiert ist, liefern wir Plain-YAML; JSON-Variante optional.
          return new Response('{"error":"openapi.json nicht generiert — bitte openapi.yaml verwenden"}', { status: 501, headers: { "Content-Type": "application/json" } });
        }
        return new Response(file("docs/openapi.yaml"), {
          headers: {
            "Content-Type": "application/yaml; charset=utf-8",
            "Cache-Control": "private, must-revalidate",
            "X-Robots-Tag": "noindex, nofollow",
          },
        });
      }

      // Statische API-Dokumentation (markdown, mehrsprachig) — geschuetzt mit HTTP Basic Auth.
      const docsMatch = path.match(/^\/docs\/(API(?:\.(en|fr))?)(\.md)?$/);
      if (docsMatch) {
        const langSuffix = docsMatch[2] ? `.${docsMatch[2]}` : "";
        const docFile = `docs/API${langSuffix}.md`;
        const row = db.prepare("SELECT hash FROM app_secrets WHERE key = 'docs_api_password'").get() as { hash: string } | undefined;
        if (!row || !row.hash) {
          // Noch kein Passwort gesetzt → komplett blockieren (sicher per default).
          return new Response("API-Doku ist gesperrt. Bitte Admin kontaktieren.", { status: 503 });
        }
        const authHeader = req.headers.get("authorization") || "";
        if (!authHeader.toLowerCase().startsWith("basic ")) {
          return new Response("Authentifizierung erforderlich", {
            status: 401,
            headers: {
              "WWW-Authenticate": 'Basic realm="mastr-solar API Docs", charset="UTF-8"',
              "Content-Type": "text/plain; charset=utf-8",
              "Cache-Control": "no-store",
            },
          });
        }
        let plain = "";
        try {
          const decoded = atob(authHeader.slice(6).trim());
          const idx = decoded.indexOf(":");
          plain = idx >= 0 ? decoded.slice(idx + 1) : decoded;
        } catch {
          return new Response("Bad Authorization header", { status: 400 });
        }
        let ok = false;
        try {
          ok = await Bun.password.verify(plain, row.hash);
        } catch {
          ok = false;
        }
        if (!ok) {
          // Bewusst kurze Bremse — kein Timing-Channel, bcrypt selbst ist schon ~100ms.
          return new Response("Falsches Passwort", {
            status: 401,
            headers: {
              "WWW-Authenticate": 'Basic realm="mastr-solar API Docs", charset="UTF-8"',
              "Content-Type": "text/plain; charset=utf-8",
              "Cache-Control": "no-store",
            },
          });
        }
        // P2-23: ETag aus mtime fuer 304-Caching
        let etag = "";
        try {
          const st = await Bun.file(docFile).stat?.();
          if (st) etag = `"${(st as any).mtimeMs?.toString(16) || ""}-${(st as any).size?.toString(16) || ""}"`;
        } catch {}
        const ifNoneMatch = req.headers.get("if-none-match");
        if (etag && ifNoneMatch === etag) {
          return new Response(null, { status: 304, headers: { ETag: etag, "Cache-Control": "private, must-revalidate" } });
        }
        const baseHeaders: Record<string, string> = {
          "Content-Type": "text/markdown; charset=utf-8",
          "Cache-Control": "private, must-revalidate",
          "Content-Disposition": `inline; filename="mastr-solar-API${langSuffix}.md"`,
          "X-Robots-Tag": "noindex, nofollow",
        };
        if (etag) baseHeaders.ETag = etag;
        return new Response(file(docFile), { headers: baseHeaders });
      }
      if (path === "/favicon.ico" || path === "/favicon.svg") {
        const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="6" fill="#0f172a"/><circle cx="16" cy="16" r="6" fill="#fbbf24"/><g stroke="#fbbf24" stroke-width="2" stroke-linecap="round"><line x1="16" y1="2" x2="16" y2="6"/><line x1="16" y1="26" x2="16" y2="30"/><line x1="2" y1="16" x2="6" y2="16"/><line x1="26" y1="16" x2="30" y2="16"/><line x1="6" y1="6" x2="9" y2="9"/><line x1="23" y1="23" x2="26" y2="26"/><line x1="6" y1="26" x2="9" y2="23"/><line x1="23" y1="9" x2="26" y2="6"/></g></svg>`;
        return new Response(svg, { headers: { "Content-Type": "image/svg+xml", "Cache-Control": "public, max-age=86400" } });
      }

      // ===== IMPORT (Bulk-Datenstand) =====
      if (path === "/api/import/status" && method === "GET") {
        const auth = requireUser(req); if ("response" in auth) return auth.response;
        const last = db.prepare(`
          SELECT * FROM import_log
          WHERE status IN ('success', 'failed')
          ORDER BY id DESC LIMIT 1
        `).get();
        const running = db.prepare(`
          SELECT * FROM import_log WHERE status = 'running' ORDER BY id DESC LIMIT 1
        `).get();
        const counts = db.prepare(`
          SELECT
            (SELECT COUNT(*) FROM anlagen) as anlagen_total,
            (SELECT COUNT(*) FROM anlagen WHERE energietraeger LIKE '%Solar%' OR energietraeger LIKE '%Photovoltaik%') as anlagen_pv,
            (SELECT COUNT(*) FROM betreiber) as betreiber_total,
            (SELECT MAX(letzte_aenderung) FROM anlagen) as last_data_update
        `).get();
        return json({ last, running, counts });
      }

      if (path === "/api/import/log" && method === "GET") {
        const auth = requireUser(req); if ("response" in auth) return auth.response;
        const limit = Math.min(50, Math.max(1, parseInt(url.searchParams.get("limit") || "20")));
        const rows = db.prepare(`
          SELECT * FROM import_log ORDER BY id DESC LIMIT ?
        `).all(limit);
        return json(rows);
      }

      // ===== MESSAGES: Comments an Anlagen + DMs zwischen Usern =====
      const commentMatch = path.match(/^\/api\/anlagen\/(\d+)\/comments$/);
      if (commentMatch && method === "GET") {
        const auth = requireUser(req); if ("response" in auth) return auth.response;
        const id = parseInt(commentMatch[1]);
        const rows = db.prepare(`
          SELECT m.*, u.username as user_username, u.display_name as user_display_name, u.color as user_color
          FROM messages m LEFT JOIN users u ON m.from_user_id = u.id
          WHERE m.anlage_id = ? AND m.type = 'comment'
          ORDER BY m.created_at ASC
        `).all(id);
        return json(rows);
      }
      if (commentMatch && method === "POST") {
        const auth = requireUser(req); if ("response" in auth) return auth.response;
        const id = parseInt(commentMatch[1]);
        const b = (await req.json()) as any;
        if (!b.text || !b.text.trim()) return err("Text leer");
        const r = db.prepare(`
          INSERT INTO messages (type, anlage_id, from_user_id, text)
          VALUES ('comment', ?, ?, ?)
        `).run(id, auth.user.id, b.text);
        const messageId = r.lastInsertRowid as number;
        autoAssignOwner(db, id, auth.user.id);
        logActivity(db, id, auth.user.id, "comment_added", b.text.substring(0, 100), undefined, tid(auth.user));

        // Mentions parsen + benachrichtigen
        const mentions = parseMentions(db, b.text);
        const anlage = db.prepare("SELECT name, mastr_nummer, owner_id FROM anlagen WHERE id = ?").get(id) as any;
        const anlageLabel = anlage?.name || anlage?.mastr_nummer || `#${id}`;
        const senderName = auth.user.display_name || auth.user.username;
        for (const m of mentions) {
          if (m.user_id === auth.user.id) continue;
          await notify(db, {
            userId: m.user_id,
            type: "mention",
            titleKey: "notif.mention_chat_title",
            titleArgs: { from: senderName, anlage: anlageLabel },
            body: b.text,
            anlageId: id,
            messageId,
            fromUserId: auth.user.id,
            fromUserName: senderName,
          });
          try { fireEvent(db, "mention.created", {
            anlage_id: id,
            anlage_label: anlageLabel,
            from: { id: auth.user.id, username: auth.user.username, display_name: senderName },
            to: { id: m.user_id, username: m.username },
            text: b.text,
            channel: "comment",
          }); } catch (e) { console.error("webhook fireEvent:", e); }
        }
        // Optional: Owner benachrichtigen wenn er nicht selbst kommentiert + nicht schon erwaehnt
        if (anlage?.owner_id && anlage.owner_id !== auth.user.id && !mentions.find((mm) => mm.user_id === anlage.owner_id)) {
          await notify(db, {
            userId: anlage.owner_id,
            type: "comment",
            titleKey: "notif.comment_title",
            titleArgs: { anlage: anlageLabel },
            body: `${senderName}: ${b.text.substring(0, 200)}`,
            anlageId: id,
            messageId,
            fromUserId: auth.user.id,
            fromUserName: senderName,
          });
        }
        return json({ success: true, id: messageId });
      }
      const commentDelMatch = path.match(/^\/api\/comments\/(\d+)$/);
      if (commentDelMatch && method === "DELETE") {
        const auth = requireUser(req); if ("response" in auth) return auth.response;
        const cid = parseInt(commentDelMatch[1]);
        const m = db.prepare("SELECT from_user_id FROM messages WHERE id = ?").get(cid) as any;
        if (!m) return err("Nicht gefunden", 404, { code: "NOT_FOUND" });
        if (m.from_user_id !== auth.user.id) return err("Nur eigene Kommentare loeschbar", 403);
        db.prepare("DELETE FROM messages WHERE id = ?").run(cid);
        return json({ success: true });
      }

      // ===== DM (Direct Messages) =====
      if (path === "/api/dm/threads" && method === "GET") {
        const auth = requireUser(req); if ("response" in auth) return auth.response;
        // Liste aller User mit denen du DMs hattest + ungelesene Counts
        const threads = db.prepare(`
          SELECT u.id, u.username, u.display_name, u.color,
            (SELECT text FROM messages WHERE type='dm' AND ((from_user_id = ? AND to_user_id = u.id) OR (from_user_id = u.id AND to_user_id = ?)) ORDER BY created_at DESC LIMIT 1) as last_text,
            (SELECT created_at FROM messages WHERE type='dm' AND ((from_user_id = ? AND to_user_id = u.id) OR (from_user_id = u.id AND to_user_id = ?)) ORDER BY created_at DESC LIMIT 1) as last_at,
            (SELECT COUNT(*) FROM notifications WHERE user_id = ? AND from_user_id = u.id AND type = 'dm' AND read_at IS NULL) as unread_count
          FROM users u
          WHERE u.id != ? AND u.active = 1
          ORDER BY last_at DESC NULLS LAST, u.username
        `).all(auth.user.id, auth.user.id, auth.user.id, auth.user.id, auth.user.id, auth.user.id);
        return json(threads);
      }
      const dmHistMatch = path.match(/^\/api\/dm\/(\d+)$/);
      if (dmHistMatch && method === "GET") {
        const auth = requireUser(req); if ("response" in auth) return auth.response;
        const otherId = parseInt(dmHistMatch[1]);
        const rows = db.prepare(`
          SELECT m.*, u.username as user_username, u.display_name as user_display_name, u.color as user_color
          FROM messages m LEFT JOIN users u ON m.from_user_id = u.id
          WHERE m.type = 'dm' AND ((m.from_user_id = ? AND m.to_user_id = ?) OR (m.from_user_id = ? AND m.to_user_id = ?))
          ORDER BY m.created_at ASC
        `).all(auth.user.id, otherId, otherId, auth.user.id);
        // DM-Notifications als gelesen markieren
        db.prepare(`
          UPDATE notifications SET read_at = CURRENT_TIMESTAMP
          WHERE user_id = ? AND from_user_id = ? AND type = 'dm' AND read_at IS NULL
        `).run(auth.user.id, otherId);
        return json(rows);
      }
      if (dmHistMatch && method === "POST") {
        const auth = requireUser(req); if ("response" in auth) return auth.response;
        const otherId = parseInt(dmHistMatch[1]);
        const b = (await req.json()) as any;
        if (!b.text || !b.text.trim()) return err("Text leer");
        const r = db.prepare(`
          INSERT INTO messages (type, from_user_id, to_user_id, text)
          VALUES ('dm', ?, ?, ?)
        `).run(auth.user.id, otherId, b.text);
        const messageId = r.lastInsertRowid as number;
        const senderName = auth.user.display_name || auth.user.username;
        await notify(db, {
          userId: otherId,
          type: "dm",
          titleKey: "notif.dm_title",
          titleArgs: { from: senderName },
          body: b.text,
          messageId,
          fromUserId: auth.user.id,
          fromUserName: senderName,
        });
        return json({ success: true, id: messageId });
      }

      // ===== NOTIFICATIONS =====
      if (path === "/api/notifications" && method === "GET") {
        const auth = requireUser(req); if ("response" in auth) return auth.response;
        const limit = Math.min(50, parseInt(url.searchParams.get("limit") || "30"));
        const onlyUnread = url.searchParams.get("unread") === "1";
        const where = onlyUnread ? "AND read_at IS NULL" : "";
        const list = db.prepare(`
          SELECT n.*, u.username as from_username, u.display_name as from_display_name, u.color as from_color
          FROM notifications n LEFT JOIN users u ON n.from_user_id = u.id
          WHERE n.user_id = ? ${where}
          ORDER BY n.created_at DESC LIMIT ?
        `).all(auth.user.id, limit);
        const unreadCount = (db.prepare("SELECT COUNT(*) c FROM notifications WHERE user_id = ? AND read_at IS NULL").get(auth.user.id) as any).c;
        return json({ list, unreadCount });
      }
      const notifReadMatch = path.match(/^\/api\/notifications\/(\d+)\/read$/);
      if (notifReadMatch && method === "POST") {
        const auth = requireUser(req); if ("response" in auth) return auth.response;
        db.prepare("UPDATE notifications SET read_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?").run(parseInt(notifReadMatch[1]), auth.user.id);
        return json({ success: true });
      }
      if (path === "/api/notifications/read-all" && method === "POST") {
        const auth = requireUser(req); if ("response" in auth) return auth.response;
        db.prepare("UPDATE notifications SET read_at = CURRENT_TIMESTAMP WHERE user_id = ? AND read_at IS NULL").run(auth.user.id);
        return json({ success: true });
      }

      // ===== NOTIFICATION-SETTINGS (incl. Telegram) =====
      if (path === "/api/settings/notifications" && method === "GET") {
        const auth = requireUser(req); if ("response" in auth) return auth.response;
        const r = db.prepare(`
          SELECT notif_email_mention, notif_email_dm, notif_email_assignment,
            notif_telegram_mention, notif_telegram_dm, notif_telegram_assignment,
            telegram_chat_id, telegram_phone, telegram_user_id,
            COALESCE(telegram_admin_notify, 1) as telegram_admin_notify,
            CASE WHEN telegram_bot_token_enc IS NOT NULL AND telegram_bot_token_enc != '' THEN 1 ELSE 0 END as has_telegram_token,
            CASE WHEN telegram_session_enc IS NOT NULL AND telegram_session_enc != '' THEN 1 ELSE 0 END as has_telegram_session
          FROM users WHERE id = ?
        `).get(auth.user.id);
        return json(r);
      }
      if (path === "/api/settings/notifications" && method === "PUT") {
        const auth = requireUser(req); if ("response" in auth) return auth.response;
        const b = (await req.json()) as any;
        const fields: string[] = [];
        const vals: any[] = [];
        for (const k of [
          "notif_email_mention", "notif_email_dm", "notif_email_assignment",
          "notif_telegram_mention", "notif_telegram_dm", "notif_telegram_assignment",
          "telegram_chat_id", "telegram_admin_notify",
        ]) {
          if (b[k] !== undefined) { fields.push(`${k} = ?`); vals.push(b[k]); }
        }
        if (b.telegram_bot_token !== undefined && b.telegram_bot_token !== "") {
          fields.push("telegram_bot_token_enc = ?");
          vals.push(encrypt(b.telegram_bot_token));
        }
        if (fields.length === 0) return err("Keine Aenderungen");
        vals.push(auth.user.id);
        db.prepare(`UPDATE users SET ${fields.join(", ")} WHERE id = ?`).run(...vals);
        return json({ success: true });
      }
      // ===== TELEGRAM MTPROTO LOGIN =====
      if (path === "/api/settings/telegram/login-start" && method === "POST") {
        const auth = requireUser(req); if ("response" in auth) return auth.response;
        const b = (await req.json()) as any;
        if (!b.phone) return err("Telefonnummer erforderlich");
        try {
          const { loginToken } = await tgStartLogin(b.phone);
          return json({ success: true, loginToken, message: "SMS-Code wurde an deine Telegram-App gesendet" });
        } catch (e: any) {
          return err(`Telegram-Login fehlgeschlagen: ${e.message || String(e)}`, 400);
        }
      }
      if (path === "/api/settings/telegram/login-finish" && method === "POST") {
        const auth = requireUser(req); if ("response" in auth) return auth.response;
        const b = (await req.json()) as any;
        if (!b.loginToken || !b.code) return err("Login-Token und Code erforderlich");
        try {
          const result = await tgFinishLogin(b.loginToken, b.code, b.password);
          // Session encrypted in DB speichern
          db.prepare(`
            UPDATE users SET
              telegram_session_enc = ?,
              telegram_phone = ?,
              telegram_user_id = ?,
              telegram_chat_id = ?
            WHERE id = ?
          `).run(
            encrypt(result.sessionString),
            result.phone,
            result.userId,
            String(result.userId),
            auth.user.id,
          );
          return json({ success: true, userId: result.userId, username: result.username, firstName: result.firstName });
        } catch (e: any) {
          const msg = e.message || String(e);
          if (msg.includes("SESSION_PASSWORD_NEEDED") || msg.includes("2FA")) {
            return err("2FA-Passwort erforderlich", 401, { needs_2fa: true });
          }
          return err(`Login-Fehler: ${msg}`, 400);
        }
      }
      if (path === "/api/settings/telegram/logout" && method === "POST") {
        const auth = requireUser(req); if ("response" in auth) return auth.response;
        const u = db.prepare("SELECT telegram_session_enc FROM users WHERE id = ?").get(auth.user.id) as any;
        if (u?.telegram_session_enc) {
          try { await tgLogout(decrypt(u.telegram_session_enc)); } catch {}
        }
        db.prepare(`UPDATE users SET telegram_session_enc = NULL, telegram_phone = NULL, telegram_user_id = NULL, telegram_chat_id = NULL WHERE id = ?`).run(auth.user.id);
        return json({ success: true });
      }
      if (path === "/api/settings/telegram/test" && method === "POST") {
        const auth = requireUser(req); if ("response" in auth) return auth.response;
        const u = db.prepare("SELECT telegram_session_enc, display_name, username FROM users WHERE id = ?").get(auth.user.id) as any;
        if (!u?.telegram_session_enc) return err("Telegram nicht verbunden — bitte erst einloggen", 400);
        try {
          await tgSendToSelf(u.telegram_session_enc, `*Solar DB* — Test-Nachricht fuer ${u.display_name || u.username}\n\nWenn du das in deinen Saved Messages siehst, ist alles eingerichtet.`);
          return json({ success: true, message: "Test-Nachricht in deine Saved Messages gesendet" });
        } catch (e: any) {
          return err(`Test fehlgeschlagen: ${e.message || String(e)}`, 500);
        }
      }
      // BOT-Variante: testet @BotFather-Bot-Token via Bot-API
      if (path === "/api/settings/telegram-bot/test" && method === "POST") {
        const auth = requireUser(req); if ("response" in auth) return auth.response;
        const { testBot } = await import("./lib/telegram-commands");
        const r = await testBot(db, auth.user.id);
        if (!r.ok) return err(r.error || "Test fehlgeschlagen", 400, r.bot ? { bot: r.bot } : {});
        return json({ success: true, bot: r.bot });
      }
      // BOT-Variante: manueller Poll-Trigger (für Admin-Debugging — sollte normalerweise systemd-Timer erledigen)
      if (path === "/api/settings/telegram-bot/poll-now" && method === "POST") {
        const auth = requireAdmin(req); if ("response" in auth) return auth.response;
        const { pollAllConfiguredUsers } = await import("./lib/telegram-commands");
        const r = await pollAllConfiguredUsers(db);
        return json({ success: true, ...r });
      }
      // ===== Globaler Bot — Admin setzt Token einmalig (encrypted in app_settings) =====
      if (path === "/api/admin/telegram-global-bot" && method === "GET") {
        const auth = requireAdmin(req); if ("response" in auth) return auth.response;
        const row = db.prepare("SELECT value FROM app_settings WHERE key = 'telegram_global_bot_token_enc'").get() as any;
        const usersWithChat = db.prepare("SELECT COUNT(*) c FROM users WHERE telegram_chat_id IS NOT NULL AND telegram_chat_id != ''").get() as any;
        return json({
          has_token: !!row?.value,
          users_with_chat: usersWithChat?.c || 0,
        });
      }
      if (path === "/api/admin/telegram-global-bot" && method === "PUT") {
        const auth = requireAdmin(req); if ("response" in auth) return auth.response;
        const b = (await req.json()) as any;
        const tok = String(b.token || "").trim();
        if (!/^\d{6,15}:[A-Za-z0-9_-]{30,}$/.test(tok)) return err("Token-Format ungueltig", 400);
        // Test via getMe vor dem Speichern
        try {
          const r = await fetch(`https://api.telegram.org/bot${tok}/getMe`);
          const me = (await r.json()) as any;
          if (!me.ok) return err(`Telegram-API-Fehler: ${me.description || "Token ungültig"}`, 400);
          db.prepare(`
            INSERT INTO app_settings (key, value, updated_by) VALUES ('telegram_global_bot_token_enc', ?, ?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = CURRENT_TIMESTAMP
          `).run(encrypt(tok), auth.user.id);
          logAudit(db, auth.user.id, auth.user.username, "telegram_global_bot_token_set", "app_settings", null, `bot=@${me.result.username}`);
          return json({ success: true, bot: me.result });
        } catch (e: any) {
          return err(`Test fehlgeschlagen: ${e?.message || String(e)}`, 500);
        }
      }
      if (path === "/api/admin/telegram-global-bot" && method === "DELETE") {
        const auth = requireAdmin(req); if ("response" in auth) return auth.response;
        db.prepare("DELETE FROM app_settings WHERE key IN ('telegram_global_bot_token_enc', 'telegram_global_last_update_id')").run();
        logAudit(db, auth.user.id, auth.user.username, "telegram_global_bot_token_removed", "app_settings", null, "");
        return json({ success: true });
      }
      // ===== User-Self-Bind: Chat-ID nach /start eintragen =====
      // POST /api/me/telegram-chat  { chat_id: "..." }
      if (path === "/api/me/telegram-chat" && method === "PUT") {
        const auth = requireUser(req); if ("response" in auth) return auth.response;
        const b = (await req.json()) as any;
        const chatId = String(b.chat_id || "").trim();
        if (!chatId) return err("chat_id erforderlich");
        if (!/^-?\d{4,20}$/.test(chatId)) return err("chat_id muss numerisch sein");
        // Prüfen ob jemand anderes diese chat_id schon hat (eindeutig pro Bot)
        const conflict = db.prepare("SELECT id, username FROM users WHERE telegram_chat_id = ? AND id != ?").get(chatId, auth.user.id) as any;
        if (conflict) return err(`Chat-ID bereits an User ${conflict.username} vergeben`, 409);
        db.prepare("UPDATE users SET telegram_chat_id = ? WHERE id = ?").run(chatId, auth.user.id);
        return json({ success: true, chat_id: chatId });
      }

      // ===== TRACKING (public, kein Auth) =====
      const openMatch = path.match(/^\/t\/o\/([a-f0-9]{32})\.png$/i);
      if (openMatch && method === "GET") {
        const token = openMatch[1];
        try {
          const sent = db.prepare("SELECT id, first_open_at FROM sent_emails WHERE tracking_token = ?").get(token) as any;
          if (sent) {
            const ipH = hashShort(req.headers.get("x-forwarded-for") || ip);
            const uaH = hashShort(req.headers.get("user-agent"));
            db.prepare("INSERT INTO email_events (sent_email_id, event_type, ip_hash, ua_hash) VALUES (?, 'open', ?, ?)").run(sent.id, ipH, uaH);
            db.prepare(`
              UPDATE sent_emails SET
                open_count = open_count + 1,
                first_open_at = COALESCE(first_open_at, CURRENT_TIMESTAMP),
                last_event_at = CURRENT_TIMESTAMP
              WHERE id = ?
            `).run(sent.id);
          }
        } catch (e) { console.error("Open-Track-Fehler:", e); }
        return new Response(TRANSPARENT_GIF, { headers: { "Content-Type": "image/gif", "Cache-Control": "no-store, max-age=0" } });
      }
      const clickMatch = path.match(/^\/t\/c\/([a-f0-9]{32})$/i);
      if (clickMatch && method === "GET") {
        const token = clickMatch[1];
        const target = url.searchParams.get("u") || "/";
        try {
          const sent = db.prepare("SELECT id FROM sent_emails WHERE tracking_token = ?").get(token) as any;
          if (sent) {
            const ipH = hashShort(req.headers.get("x-forwarded-for") || ip);
            const uaH = hashShort(req.headers.get("user-agent"));
            db.prepare("INSERT INTO email_events (sent_email_id, event_type, url, ip_hash, ua_hash) VALUES (?, 'click', ?, ?, ?)").run(sent.id, target.substring(0, 500), ipH, uaH);
            db.prepare(`
              UPDATE sent_emails SET
                click_count = click_count + 1,
                last_event_at = CURRENT_TIMESTAMP
              WHERE id = ?
            `).run(sent.id);
          }
        } catch (e) { console.error("Click-Track-Fehler:", e); }
        // Validate target URL
        try {
          const u = new URL(target);
          if (!/^https?:$/.test(u.protocol)) throw new Error("bad");
          return Response.redirect(u.toString(), 302);
        } catch {
          return new Response("Ungueltige URL", { status: 400 });
        }
      }

      // ===== CALLS =====
      const callsAnlMatch = path.match(/^\/api\/anlagen\/(\d+)\/calls$/);
      if (callsAnlMatch && method === "GET") {
        const auth = requireUser(req); if ("response" in auth) return auth.response;
        const aid = parseInt(callsAnlMatch[1]);
        const rows = db.prepare(`
          SELECT c.*, u.username as user_username, u.display_name as user_display_name, u.color as user_color
          FROM calls c LEFT JOIN users u ON c.user_id = u.id
          WHERE c.anlage_id = ? ORDER BY c.started_at DESC LIMIT 100
        `).all(aid);
        return json(rows);
      }
      if (callsAnlMatch && method === "POST") {
        const auth = requireUser(req); if ("response" in auth) return auth.response;
        const aid = parseInt(callsAnlMatch[1]);
        const b = (await req.json()) as any;
        const anlage = db.prepare("SELECT status, betreiber_mastr FROM anlagen WHERE id = ?").get(aid) as any;
        const r = db.prepare(`
          INSERT INTO calls (user_id, anlage_id, betreiber_mastr, direction, phone_number, contact_name, started_at, duration_seconds, outcome, notes, status_before)
          VALUES (?, ?, ?, ?, ?, ?, COALESCE(?, CURRENT_TIMESTAMP), ?, ?, ?, ?)
        `).run(
          auth.user.id, aid, anlage?.betreiber_mastr || null,
          b.direction || "out", b.phone_number || null, b.contact_name || null,
          b.started_at || null, b.duration_seconds || null,
          b.outcome || null, b.notes || null, anlage?.status || null,
        );
        const callId = r.lastInsertRowid as number;
        autoAssignOwner(db, aid, auth.user.id);
        const desc = `Anruf ${b.outcome || "—"} · ${b.duration_seconds ? Math.round(b.duration_seconds / 60) + ' Min' : '?'}`;
        logActivity(db, aid, auth.user.id, "comment_added", desc, { call_id: callId, outcome: b.outcome }, tid(auth.user));
        // Status-Update wenn vom User mitgegeben
        if (b.new_status && b.new_status !== anlage?.status) {
          const oldStatus = anlage?.status || null;
          db.prepare("UPDATE anlagen SET status=?, updated_at=CURRENT_TIMESTAMP WHERE id=?").run(b.new_status, aid);
          db.prepare("UPDATE calls SET status_after=? WHERE id=?").run(b.new_status, callId);
          logActivity(db, aid, auth.user.id, "status_change", `Status: ${oldStatus || '—'} → ${b.new_status}`, undefined, tid(auth.user));
          try { fireEvent(db, "anlage.status_changed", {
            anlage_id: aid,
            mastr_nummer: anlage?.mastr_nummer || null,
            old_status: oldStatus,
            new_status: b.new_status,
            changed_by: { id: auth.user.id, username: auth.user.username },
          }); } catch (e) { console.error("webhook fireEvent:", e); }
        }
        return json({ success: true, id: callId });
      }
      const callIdMatch = path.match(/^\/api\/calls\/(\d+)$/);
      if (callIdMatch && method === "PUT") {
        const auth = requireUser(req); if ("response" in auth) return auth.response;
        const id = parseInt(callIdMatch[1]);
        const b = (await req.json()) as any;
        const fields: string[] = [];
        const vals: any[] = [];
        for (const k of ["duration_seconds", "outcome", "notes"]) {
          if (b[k] !== undefined) { fields.push(`${k} = ?`); vals.push(b[k]); }
        }
        if (!fields.length) return err("Keine Aenderungen");
        vals.push(id);
        db.prepare(`UPDATE calls SET ${fields.join(", ")} WHERE id = ?`).run(...vals);
        return json({ success: true });
      }
      const callSumMatch = path.match(/^\/api\/calls\/(\d+)\/summary$/);
      if (callSumMatch && method === "POST") {
        const auth = requireUser(req); if ("response" in auth) return auth.response;
        const cid = parseInt(callSumMatch[1]);
        const c = db.prepare(`
          SELECT c.*, a.name as anlagenname, a.ort, a.bundesland, a.nettonennleistung, a.betreiber_name, a.status as anlage_status
          FROM calls c LEFT JOIN anlagen a ON c.anlage_id = a.id
          WHERE c.id = ?
        `).get(cid) as any;
        if (!c) return err("Anruf nicht gefunden", 404);
        if (!c.notes || c.notes.trim().length < 5) return err("Notiz zu kurz fuer KI-Analyse (min 5 Zeichen)");
        const u = db.prepare("SELECT ai_provider, anthropic_key_enc, ollama_url FROM users WHERE id = ?").get(auth.user.id) as any;
        try {
          const result = await generateCallSummary(u, {
            anlagenname: c.anlagenname || "",
            ort: c.ort || "",
            bundesland: c.bundesland || "",
            leistung: c.nettonennleistung,
            betreiber: c.betreiber_name || "",
            current_status: c.anlage_status || "",
            duration_seconds: c.duration_seconds,
            outcome: c.outcome,
            notes: c.notes,
          });
          db.prepare(`
            UPDATE calls SET ai_summary = ?, ai_next_steps = ?, ai_sentiment = ? WHERE id = ?
          `).run(result.summary, JSON.stringify(result.next_steps), result.sentiment, cid);
          return json(result);
        } catch (e: any) {
          return err(`KI-Analyse fehlgeschlagen: ${e.message || String(e)}`, 500);
        }
      }

      // ===== CALL-SCRIPTS =====
      if (path === "/api/scripts" && method === "GET") {
        const auth = requireUser(req); if ("response" in auth) return auth.response;
        const status = url.searchParams.get("status") || null;
        const where: string[] = ["(s.user_id IS NULL OR s.user_id = ?)"];
        const params: any[] = [auth.user.id];
        if (status) { where.push("(s.applies_to_status IS NULL OR s.applies_to_status = ?)"); params.push(status); }
        const rows = db.prepare(`
          SELECT s.* FROM call_scripts s
          WHERE ${where.join(" AND ")}
          ORDER BY s.user_id IS NULL DESC, s.is_default DESC, s.name
        `).all(...params);
        return json(rows);
      }
      if (path === "/api/scripts" && method === "POST") {
        const auth = requireUser(req); if ("response" in auth) return auth.response;
        const b = (await req.json()) as any;
        if (!b.name) return err("Name fehlt");
        db.prepare(`
          INSERT INTO call_scripts (user_id, name, applies_to_status, body_md, is_default)
          VALUES (?, ?, ?, ?, ?)
        `).run(b.is_global ? null : auth.user.id, b.name, b.applies_to_status || null, b.body_md || "", b.is_default ? 1 : 0);
        return json({ success: true });
      }
      const scriptIdMatch = path.match(/^\/api\/scripts\/(\d+)$/);
      if (scriptIdMatch && method === "PUT") {
        const auth = requireUser(req); if ("response" in auth) return auth.response;
        const id = parseInt(scriptIdMatch[1]);
        const b = (await req.json()) as any;
        db.prepare(`
          UPDATE call_scripts SET name=?, applies_to_status=?, body_md=?, is_default=? WHERE id=?
        `).run(b.name, b.applies_to_status || null, b.body_md || "", b.is_default ? 1 : 0, id);
        return json({ success: true });
      }
      if (scriptIdMatch && method === "DELETE") {
        const auth = requireUser(req); if ("response" in auth) return auth.response;
        db.prepare("DELETE FROM call_scripts WHERE id = ?").run(parseInt(scriptIdMatch[1]));
        return json({ success: true });
      }

      // ===== AI-SETTINGS =====
      if (path === "/api/settings/ai" && method === "GET") {
        const auth = requireUser(req); if ("response" in auth) return auth.response;
        const r = db.prepare(`
          SELECT ai_provider, ollama_url,
            CASE WHEN anthropic_key_enc IS NOT NULL AND anthropic_key_enc != '' THEN 1 ELSE 0 END as has_anthropic_key
          FROM users WHERE id = ?
        `).get(auth.user.id);
        return json(r);
      }
      if (path === "/api/settings/ai" && method === "PUT") {
        const auth = requireUser(req); if ("response" in auth) return auth.response;
        const b = (await req.json()) as any;
        const fields: string[] = [];
        const vals: any[] = [];
        if (b.ai_provider !== undefined) { fields.push("ai_provider = ?"); vals.push(b.ai_provider); }
        if (b.ollama_url !== undefined) { fields.push("ollama_url = ?"); vals.push(b.ollama_url || null); }
        if (b.anthropic_key !== undefined && b.anthropic_key !== "") {
          fields.push("anthropic_key_enc = ?"); vals.push(encrypt(b.anthropic_key));
        }
        if (b.anthropic_key === "") {
          fields.push("anthropic_key_enc = NULL");
        }
        if (!fields.length) return err("Keine Aenderungen");
        vals.push(auth.user.id);
        db.prepare(`UPDATE users SET ${fields.join(", ")} WHERE id = ?`).run(...vals);
        return json({ success: true });
      }

      // ===== SENT-EMAIL Tracking-Stats =====
      const sentEvMatch = path.match(/^\/api\/sent-emails\/(\d+)\/events$/);
      if (sentEvMatch && method === "GET") {
        const auth = requireUser(req); if ("response" in auth) return auth.response;
        const id = parseInt(sentEvMatch[1]);
        const events = db.prepare("SELECT * FROM email_events WHERE sent_email_id = ? ORDER BY created_at DESC").all(id);
        return json(events);
      }

      // ===== CAMPAIGNS =====
      if (path === "/api/campaigns" && method === "GET") {
        const auth = requireUser(req); if ("response" in auth) return auth.response;
        const rows = db.prepare(`
          SELECT c.*, t.name as template_name,
            (SELECT COUNT(*) FROM campaign_recipients r WHERE r.campaign_id = c.id AND r.status='sent') as sent,
            (SELECT COUNT(*) FROM campaign_recipients r WHERE r.campaign_id = c.id AND r.status='pending') as pending,
            (SELECT COUNT(*) FROM campaign_recipients r WHERE r.campaign_id = c.id AND r.status='failed') as failed
          FROM campaigns c
          LEFT JOIN email_templates t ON c.template_id = t.id
          ORDER BY c.created_at DESC
        `).all();
        return json(rows);
      }
      if (path === "/api/campaigns" && method === "POST") {
        const auth = requireUser(req); if ("response" in auth) return auth.response;
        const b = (await req.json()) as any;
        if (!b.name || !b.template_id) return err("Name + Template erforderlich");
        const r = db.prepare(`
          INSERT INTO campaigns (user_id, name, template_id, filter_json, attachment_ids, per_day, delay_minutes, status,
            ab_template_b_id, ab_split_pct)
          VALUES (?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?)
        `).run(
          auth.user.id, b.name, b.template_id,
          JSON.stringify(b.filter || {}),
          JSON.stringify(b.attachment_ids || []),
          parseInt(b.per_day) || 50,
          parseInt(b.delay_minutes) || 5,
          b.ab_template_b_id ? parseInt(b.ab_template_b_id) : null,
          b.ab_split_pct ? Math.max(10, Math.min(90, parseInt(b.ab_split_pct))) : 50,
        );
        return json({ success: true, id: r.lastInsertRowid });
      }
      // A/B-Stats fuer eine Kampagne
      const campAbStatsMatch = path.match(/^\/api\/campaigns\/(\d+)\/ab-stats$/);
      if (campAbStatsMatch && method === "GET") {
        const auth = requireUser(req); if ("response" in auth) return auth.response;
        const id = parseInt(campAbStatsMatch[1]);
        const stats = db.prepare(`
          SELECT
            r.variant, r.template_id_used,
            t.name as template_name, t.subject as template_subject,
            COUNT(*) as total,
            SUM(CASE WHEN r.status='sent' THEN 1 ELSE 0 END) as sent,
            SUM(CASE WHEN s.open_count > 0 THEN 1 ELSE 0 END) as opened,
            SUM(s.open_count) as opens_total,
            SUM(s.click_count) as clicks_total,
            (SELECT COUNT(*) FROM email_replies er WHERE er.sent_email_id IN
              (SELECT s2.id FROM sent_emails s2 JOIN campaign_recipients r2 ON s2.id=r2.sent_email_id
                WHERE r2.campaign_id=? AND r2.template_id_used=r.template_id_used)) as replies
          FROM campaign_recipients r
          LEFT JOIN sent_emails s ON r.sent_email_id = s.id
          LEFT JOIN email_templates t ON r.template_id_used = t.id
          WHERE r.campaign_id = ?
          GROUP BY r.variant, r.template_id_used
        `).all(id, id);
        const c = db.prepare("SELECT ab_winner_template_id, ab_decided_at FROM campaigns WHERE id=?").get(id);
        return json({ stats, ...c });
      }
      const campIdMatch = path.match(/^\/api\/campaigns\/(\d+)$/);
      if (campIdMatch && method === "DELETE") {
        const auth = requireUser(req); if ("response" in auth) return auth.response;
        const id = parseInt(campIdMatch[1]);
        db.prepare("DELETE FROM campaign_recipients WHERE campaign_id = ?").run(id);
        db.prepare("DELETE FROM campaigns WHERE id = ?").run(id);
        return json({ success: true });
      }
      const campStartMatch = path.match(/^\/api\/campaigns\/(\d+)\/(start|pause|resume)$/);
      if (campStartMatch && method === "POST") {
        const auth = requireUser(req); if ("response" in auth) return auth.response;
        const id = parseInt(campStartMatch[1]);
        const action = campStartMatch[2];
        const c = db.prepare("SELECT * FROM campaigns WHERE id = ?").get(id) as any;
        if (!c) return err("Nicht gefunden", 404, { code: "NOT_FOUND" });

        if (action === "pause") {
          db.prepare("UPDATE campaigns SET status='paused' WHERE id = ?").run(id);
          return json({ success: true });
        }
        if (action === "resume") {
          db.prepare("UPDATE campaigns SET status='active' WHERE id = ?").run(id);
          return json({ success: true });
        }
        // start: recipients populieren basierend auf filter
        if (c.status !== "draft") return err("Kampagne bereits gestartet", 409);
        const filter = c.filter_json ? JSON.parse(c.filter_json) : {};
        const { where, params } = buildCampaignWhere(filter, auth.user.id, id);

        const candidates = db.prepare(`
          SELECT a.id as anlage_id,
            COALESCE(NULLIF(b.email, ''), NULLIF(a.kontakt_email, '')) as to_addr
          FROM anlagen a
          LEFT JOIN betreiber b ON a.betreiber_mastr = b.mastr_nummer
          WHERE ${where.join(" AND ")}
          GROUP BY a.id
        `).all(...params) as any[];
        if (candidates.length === 0) return err("Keine Empfaenger fuer dieses Filter", 400);

        // Drip-Schedule berechnen: per_day pro Tag, delay_minutes Abstand
        const perDay = c.per_day || 50;
        const delayMs = (c.delay_minutes || 5) * 60 * 1000;
        let cursor = Date.now();
        // A/B-Test: wenn ab_template_b_id gesetzt → split-pct % bekommen Variante B, Rest A
        const hasAB = !!c.ab_template_b_id;
        const splitPct = c.ab_split_pct ?? 50;
        const insertR = db.prepare(`
          INSERT INTO campaign_recipients (campaign_id, anlage_id, to_addr, scheduled_for, status, variant, template_id_used)
          VALUES (?, ?, ?, datetime(?, 'unixepoch'), 'pending', ?, ?)
        `);
        const tx = db.transaction((rows: any[]) => {
          let dailyCount = 0;
          let dayBase = Date.now();
          let idx = 0;
          for (const r of rows) {
            if (dailyCount >= perDay) {
              dayBase += 24 * 3600 * 1000;
              dailyCount = 0;
              cursor = dayBase;
            }
            let variant: string | null = null;
            let tplUsed = c.template_id;
            if (hasAB) {
              // Deterministischer 50/50-Split via index modulo
              const isB = (idx * 100 + 47) % 100 < splitPct;
              variant = isB ? "B" : "A";
              tplUsed = isB ? c.ab_template_b_id : c.template_id;
            }
            insertR.run(c.id, r.anlage_id, r.to_addr, Math.floor(cursor / 1000), variant, tplUsed);
            cursor += delayMs;
            dailyCount++;
            idx++;
          }
        });
        tx(candidates);
        db.prepare("UPDATE campaigns SET total_count=?, status='active', started_at=CURRENT_TIMESTAMP WHERE id=?").run(candidates.length, id);
        return json({ success: true, total: candidates.length });
      }
      const campRecMatch = path.match(/^\/api\/campaigns\/(\d+)\/recipients$/);
      if (campRecMatch && method === "GET") {
        const auth = requireUser(req); if ("response" in auth) return auth.response;
        const id = parseInt(campRecMatch[1]);
        const limit = Math.min(500, parseInt(url.searchParams.get("limit") || "100"));
        const rows = db.prepare(`
          SELECT r.*, a.name as anlage_name FROM campaign_recipients r
          LEFT JOIN anlagen a ON r.anlage_id = a.id
          WHERE r.campaign_id = ? ORDER BY r.scheduled_for LIMIT ?
        `).all(id, limit);
        return json(rows);
      }
      const campPreviewMatch = path.match(/^\/api\/campaigns\/preview$/);
      if (campPreviewMatch && method === "POST") {
        const auth = requireUser(req); if ("response" in auth) return auth.response;
        const b = (await req.json()) as any;
        const filter = b.filter || {};
        const { where, params } = buildCampaignWhere(filter, auth.user.id);
        const c = (db.prepare(`
          SELECT COUNT(DISTINCT a.id) as count FROM anlagen a
          LEFT JOIN betreiber b ON a.betreiber_mastr = b.mastr_nummer
          WHERE ${where.join(" AND ")}
        `).get(...params) as any).count;
        // Plus: 3 Beispiel-Anlagen als Vorschau (Name + Ort + kWp)
        const samples = db.prepare(`
          SELECT a.id, a.name, a.ort, a.bundesland, a.nettonennleistung, a.betreiber_name,
            COALESCE(NULLIF(b.email, ''), NULLIF(a.kontakt_email, '')) as email
          FROM anlagen a
          LEFT JOIN betreiber b ON a.betreiber_mastr = b.mastr_nummer
          WHERE ${where.join(" AND ")}
          ORDER BY a.lead_score DESC, a.nettonennleistung DESC
          LIMIT 3
        `).all(...params);
        return json({ count: c, samples });
      }

      // ===== BETREIBER-KONTAKTDATEN lesen + editieren =====
      const betreiberMatch = path.match(/^\/api\/betreiber\/by-mastr\/([A-Za-z0-9]+)$/);
      if (betreiberMatch && method === "GET") {
        const auth = requireUser(req); if ("response" in auth) return auth.response;
        const mastr = betreiberMatch[1];
        const row = db.prepare("SELECT * FROM betreiber WHERE mastr_nummer = ?").get(mastr);
        if (!row) return err("Betreiber nicht gefunden", 404);
        return json(row);
      }
      if (betreiberMatch && method === "PUT") {
        const auth = requireUser(req); if ("response" in auth) return auth.response;
        const mastr = betreiberMatch[1];
        const b = (await req.json()) as any;
        // Whitelist editierbarer Felder
        const allowed = ["name", "email", "telefon", "fax", "website", "strasse", "hausnummer", "plz", "ort", "land", "rechtsform"];
        const fields: string[] = [];
        const vals: any[] = [];
        for (const k of allowed) {
          if (b[k] !== undefined) { fields.push(`${k} = ?`); vals.push(b[k] === "" ? null : b[k]); }
        }
        if (fields.length === 0) return err("Keine Aenderungen");

        // Existiert der Betreiber bereits?
        const existing = db.prepare("SELECT id FROM betreiber WHERE mastr_nummer = ?").get(mastr) as any;
        if (existing) {
          fields.push("updated_at = CURRENT_TIMESTAMP");
          vals.push(mastr);
          db.prepare(`UPDATE betreiber SET ${fields.join(", ")} WHERE mastr_nummer = ?`).run(...vals);
        } else {
          // Insert mit nur den uebergebenen Feldern + mastr_nummer
          const cols = ["mastr_nummer", ...allowed.filter((k) => b[k] !== undefined)];
          const placeholders = cols.map(() => "?").join(", ");
          const values = [mastr, ...allowed.filter((k) => b[k] !== undefined).map((k) => b[k] === "" ? null : b[k])];
          db.prepare(`INSERT INTO betreiber (${cols.join(", ")}) VALUES (${placeholders})`).run(...values);
        }
        return json({ success: true });
      }

      // ===== ENRICH (Kontaktdaten via Schnellsuche) =====
      if (path === "/api/enrich/status" && method === "GET") {
        const auth = requireUser(req); if ("response" in auth) return auth.response;
        const last = db.prepare(`SELECT * FROM enrich_log WHERE status IN ('success','failed') ORDER BY id DESC LIMIT 1`).get();
        const running = db.prepare(`SELECT * FROM enrich_log WHERE status = 'running' ORDER BY id DESC LIMIT 1`).get();
        const counts = db.prepare(`
          SELECT
            (SELECT COUNT(DISTINCT betreiber_mastr) FROM anlagen WHERE betreiber_mastr LIKE 'ABR%') as abr_total,
            (SELECT COUNT(*) FROM betreiber WHERE email IS NOT NULL AND email != '') as with_email,
            (SELECT COUNT(*) FROM betreiber WHERE telefon IS NOT NULL AND telefon != '') as with_phone,
            (SELECT COUNT(DISTINCT a.betreiber_mastr) FROM anlagen a LEFT JOIN betreiber b ON b.mastr_nummer = a.betreiber_mastr WHERE a.betreiber_mastr LIKE 'ABR%' AND (b.email IS NULL OR b.email = '') AND (b.telefon IS NULL OR b.telefon = '')) as missing
        `).get();
        return json({ last, running, counts });
      }
      if (path === "/api/enrich/log" && method === "GET") {
        const auth = requireUser(req); if ("response" in auth) return auth.response;
        const limit = Math.min(50, Math.max(1, parseInt(url.searchParams.get("limit") || "10")));
        return json(db.prepare(`SELECT * FROM enrich_log ORDER BY id DESC LIMIT ?`).all(limit));
      }
      if (path === "/api/enrich/run" && method === "POST") {
        const auth = requireUser(req); if ("response" in auth) return auth.response;
        const active = db.prepare("SELECT id FROM enrich_log WHERE status = 'running'").get();
        if (active) return err("Anreicherung laeuft bereits", 409);
        const body = await req.json().catch(() => ({})) as any;
        const limitArg = parseInt(body.limit) || 5000;
        const concurrency = body.concurrency ? Math.max(1, Math.min(20, parseInt(body.concurrency))) : 5;
        const bundesland = (body.bundesland && typeof body.bundesland === "string" && body.bundesland.trim()) || null;

        // Args via JSON-File an cron-Skript uebergeben (systemd-Service kann ENV nicht dynamisch)
        try {
          writeFileSync(join(DATA_DIR, "enrich-args.json"), JSON.stringify({
            limit: limitArg, concurrency, bundesland, rate_ms: 600,
          }));
        } catch (e: any) {
          return err(`Args-File schreiben fehlgeschlagen: ${e.message}`, 500);
        }

        try {
          const useSystemd = process.env.USE_SYSTEMD_IMPORT !== "0" && process.platform === "linux";
          const cmd = useSystemd
            ? ["sudo", "-n", "systemctl", "start", "--no-block", "mastr-solar-enrich.service"]
            : [process.env.BUN_BIN || process.execPath, "cron/enrich-contacts.ts"];
          const proc = Bun.spawn({
            cmd, cwd: process.cwd(),
            env: { ...process.env, ENRICH_SOURCE: "manual" },
            stdout: "ignore", stderr: "ignore", stdin: "ignore",
          });
          proc.unref();
          const blMsg = bundesland ? `, Bundesland=${bundesland}` : "";
          return json({ success: true, message: `Anreicherung gestartet (limit=${limitArg}${blMsg})` });
        } catch (e: any) {
          return err(`Anreicherung-Start fehlgeschlagen: ${e.message}`, 500);
        }
      }

      if (path === "/api/import/run" && method === "POST") {
        const auth = requireUser(req); if ("response" in auth) return auth.response;
        const active = db.prepare("SELECT id FROM import_log WHERE status = 'running'").get();
        if (active) return err("Import laeuft bereits", 409);

        // Nutze existierenden systemd-Service mastr-solar-import.service (von Cron-Timer)
        // -> komplett unabhaengig vom App-Service, ueberlebt Restarts der App
        try {
          const useSystemd = process.env.USE_SYSTEMD_IMPORT !== "0" && process.platform === "linux";
          let cmd: string[];
          if (useSystemd) {
            cmd = ["sudo", "-n", "systemctl", "start", "--no-block", "mastr-solar-import.service"];
          } else {
            const bunBin = process.env.BUN_BIN || process.execPath;
            cmd = [bunBin, "cron/daily-update.ts"];
          }
          const proc = Bun.spawn({
            cmd,
            cwd: process.cwd(),
            env: { ...process.env, IMPORT_SOURCE: "manual" },
            stdout: "ignore",
            stderr: "ignore",
            stdin: "ignore",
          });
          proc.unref();
          return json({ success: true, message: "Import im Hintergrund gestartet" });
        } catch (e: any) {
          return err(`Import-Start fehlgeschlagen: ${e.message}`, 500);
        }
      }

      // ===== STATS =====
      // ===== APP-SETTINGS =====
      // GET: alle User koennen Settings LESEN (UI braucht Sichtbarkeits-Flags + Modul-Wp Default)
      if (path === "/api/app-settings" && method === "GET") {
        const auth = requireUser(req); if ("response" in auth) return auth.response;
        const loc = (auth.user as any).pref_locale || "de-DE";
        const meta = localizeSettingsMeta(SETTINGS_META, (k, fb) => tt(loc, k, undefined) || fb);
        return json({ values: getAppSettings(db), meta });
      }
      // Schreiben nur Admin
      if (path === "/api/admin/app-settings" && method === "GET") {
        const auth = requireAdmin(req); if ("response" in auth) return auth.response;
        const loc = (auth.user as any).pref_locale || "de-DE";
        const meta = localizeSettingsMeta(SETTINGS_META, (k, fb) => tt(loc, k, undefined) || fb);
        return json({ values: getAppSettings(db), meta });
      }
      if (path === "/api/admin/app-settings" && method === "PUT") {
        const auth = requireAdmin(req); if ("response" in auth) return auth.response;
        const b = (await req.json()) as Partial<AppSettings>;
        const errors: string[] = [];
        const updated: string[] = [];
        for (const [key, val] of Object.entries(b)) {
          if (val === undefined) continue;  // null bzw. leerer String ist erlaubt (Feld leeren)
          const meta = SETTINGS_META.find(m => m.key === key);
          if (!meta) { errors.push(`${key}: unbekannt`); continue; }
          try {
            // updateAppSetting macht selber type-conversion (number/boolean/text/email)
            updateAppSetting(db, key as keyof AppSettings, val == null ? "" : (val as any), auth.user.id);
            updated.push(key);
          } catch (e: any) {
            errors.push(e?.message || `${key}: Fehler`);
          }
        }
        if (errors.length > 0) return err(errors.join("; "), 400);
        logAudit(db, auth.user.id, auth.user.username, "app_settings_updated", "settings", null, updated.join(","));
        // Cache invalidieren wenn Lead-Weights geaendert wurden
        if (updated.some(k => k.startsWith("lead_w_"))) clearLeadWeightCache();
        return json({ values: getAppSettings(db), updated });
      }
      // POST /api/admin/rescore-all — manuell alle Lead-Scores neu berechnen
      if (path === "/api/admin/rescore-all" && method === "POST") {
        const auth = requireAdmin(req); if ("response" in auth) return auth.response;
        clearLeadWeightCache();
        const r = rescoreAll(db);
        return json({ success: true, ...r });
      }

      // ===== API-TOKENS (Admin-only) =====
      if (path === "/api/admin/api-tokens" && method === "GET") {
        const auth = requireAdmin(req); if ("response" in auth) return auth.response;
        const rows = listApiTokens(db);
        // Klartext-Token wird NIE zurueckgegeben — nur die ungefaehrliche Prefix-Anzeige
        return json({ tokens: rows, scope_labels: SCOPE_LABELS });
      }
      if (path === "/api/admin/api-tokens" && method === "POST") {
        const auth = requireAdmin(req); if ("response" in auth) return auth.response;
        const b = (await req.json()) as any;
        if (!b.name || !b.scope) return err("Name und Scope erforderlich");
        try {
          const { token, row } = createApiToken(db, {
            name: String(b.name).substring(0, 80),
            scope: b.scope as ApiScope,
            created_by: auth.user.id,
            expires_at: b.expires_at || null,
            is_sandbox: !!b.is_sandbox,
          });
          logAudit(db, auth.user.id, auth.user.username, "api_token_created", "api_token", row.id, `name=${row.name} scope=${row.scope} sandbox=${!!b.is_sandbox}`);
          // ACHTUNG: Klartext-Token nur HIER einmalig zurueckgeben
          return json({ ...row, token });
        } catch (e: any) {
          return err(e?.message || "Erstellen fehlgeschlagen", 400);
        }
      }
      const apiTokenIdMatch = path.match(/^\/api\/admin\/api-tokens\/(\d+)$/);
      if (apiTokenIdMatch && method === "DELETE") {
        const auth = requireAdmin(req); if ("response" in auth) return auth.response;
        const id = parseInt(apiTokenIdMatch[1]);
        revokeApiToken(db, id, auth.user.id);
        logAudit(db, auth.user.id, auth.user.username, "api_token_revoked", "api_token", id);
        return json({ success: true });
      }
      // PATCH /api/admin/api-tokens/:id — idempotency_ttl_minutes + ip_whitelist konfigurierbar
      if (apiTokenIdMatch && (method === "PATCH" || method === "PUT")) {
        const auth = requireAdmin(req); if ("response" in auth) return auth.response;
        const id = parseInt(apiTokenIdMatch[1]);
        let b: any = {}; try { b = await req.json(); } catch {}
        const sets: string[] = []; const vals: any[] = []; const log_parts: string[] = [];
        if (b.idempotency_ttl_minutes !== undefined) {
          const v = b.idempotency_ttl_minutes;
          if (v === null) { sets.push("idempotency_ttl_minutes = NULL"); }
          else {
            const n = parseInt(v, 10);
            if (isNaN(n) || n < 5 || n > 7 * 24 * 60) return err("idempotency_ttl_minutes muss zwischen 5 und 10080 liegen (oder null)", 400);
            sets.push("idempotency_ttl_minutes = ?"); vals.push(n);
          }
          log_parts.push("idempotency_ttl_minutes=" + b.idempotency_ttl_minutes);
        }
        if (b.ip_whitelist !== undefined) {
          // null oder "" → entfernen; sonst CSV validieren
          if (b.ip_whitelist === null || (typeof b.ip_whitelist === "string" && b.ip_whitelist.trim() === "")) {
            sets.push("ip_whitelist = NULL");
            log_parts.push("ip_whitelist=null");
          } else if (typeof b.ip_whitelist === "string") {
            const entries = b.ip_whitelist.split(",").map((s: string) => s.trim()).filter(Boolean);
            for (const e of entries) {
              // Plausibilität: exakte IPv4, IPv6 oder IPv4/CIDR
              const ok = /^(\d{1,3}\.){3}\d{1,3}(\/\d{1,2})?$/.test(e) || /^[0-9a-fA-F:]+$/.test(e);
              if (!ok) return err("Ungueltiger Whitelist-Eintrag: " + e, 400);
            }
            sets.push("ip_whitelist = ?"); vals.push(entries.join(","));
            log_parts.push("ip_whitelist=" + entries.length + "_entries");
          } else {
            return err("ip_whitelist muss string oder null sein", 400);
          }
        }
        if (sets.length === 0) return err("Keine Aenderungen");
        vals.push(id);
        db.prepare(`UPDATE api_tokens SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
        // Token-Cache invalidieren — sonst greift die neue Whitelist erst nach TTL
        try { (globalThis as any).__invalidate_api_token_cache?.(id); } catch {}
        logAudit(db, auth.user.id, auth.user.username, "api_token_updated", "api_token", id, log_parts.join(" "));
        return json({ success: true });
      }
      // ===== WEBHOOKS (Admin-only) =====
      if (path === "/api/admin/webhooks" && method === "GET") {
        const auth = requireAdmin(req); if ("response" in auth) return auth.response;
        const rows = listWebhooks(db).map(w => ({ ...w, events: (() => { try { return JSON.parse(w.events); } catch { return []; } })() }));
        return json({ webhooks: rows, all_events: WEBHOOK_EVENTS });
      }
      if (path === "/api/admin/webhooks" && method === "POST") {
        const auth = requireAdmin(req); if ("response" in auth) return auth.response;
        const b = (await req.json()) as any;
        try {
          const w = createWebhook(db, {
            url: String(b.url || "").trim(),
            events: Array.isArray(b.events) ? b.events as WebhookEvent[] : [],
            description: b.description || null,
            created_by: auth.user.id,
          });
          logAudit(db, auth.user.id, auth.user.username, "webhook_created", "webhook", w.id, `url=${w.url} events=${w.events}`);
          // ACHTUNG: Secret nur HIER einmalig in Klartext mitliefern
          return json({ ...w, events: JSON.parse(w.events) });
        } catch (e: any) {
          return err(e?.message || "Erstellen fehlgeschlagen", 400);
        }
      }
      const webhookIdMatch = path.match(/^\/api\/admin\/webhooks\/(\d+)$/);
      if (webhookIdMatch && method === "PUT") {
        const auth = requireAdmin(req); if ("response" in auth) return auth.response;
        const id = parseInt(webhookIdMatch[1]);
        const b = (await req.json()) as any;
        try {
          updateWebhook(db, id, {
            url: b.url,
            events: b.events as WebhookEvent[] | undefined,
            enabled: b.enabled === undefined ? undefined : (b.enabled ? 1 : 0),
            description: b.description,
          });
          logAudit(db, auth.user.id, auth.user.username, "webhook_updated", "webhook", id);
          const w = getWebhookById(db, id);
          return json(w ? { ...w, events: JSON.parse(w.events) } : { id });
        } catch (e: any) { return err(e?.message || "Update fehlgeschlagen", 400); }
      }
      if (webhookIdMatch && method === "DELETE") {
        const auth = requireAdmin(req); if ("response" in auth) return auth.response;
        const id = parseInt(webhookIdMatch[1]);
        deleteWebhook(db, id);
        logAudit(db, auth.user.id, auth.user.username, "webhook_deleted", "webhook", id);
        return json({ success: true });
      }
      const webhookTestMatch = path.match(/^\/api\/admin\/webhooks\/(\d+)\/test$/);
      if (webhookTestMatch && method === "POST") {
        const auth = requireAdmin(req); if ("response" in auth) return auth.response;
        const id = parseInt(webhookTestMatch[1]);
        try {
          const r = await testWebhook(db, id);
          logAudit(db, auth.user.id, auth.user.username, "webhook_tested", "webhook", id, `status=${r.status} ok=${r.ok}`);
          return json(r);
        } catch (e: any) { return err(e?.message || "Test fehlgeschlagen", 400); }
      }
      const webhookDeliveriesMatch = path.match(/^\/api\/admin\/webhooks\/(\d+)\/deliveries$/);
      if (webhookDeliveriesMatch && method === "GET") {
        const auth = requireAdmin(req); if ("response" in auth) return auth.response;
        const id = parseInt(webhookDeliveriesMatch[1]);
        const limit = Math.min(200, Math.max(1, parseInt(url.searchParams.get("limit") || "50", 10) || 50));
        return json({ deliveries: listDeliveries(db, id, limit) });
      }

      // Token-Rotation: alten Token revoken (optional mit Grace-Period) + neuen Token mit gleichem Scope/Name liefern
      const apiTokenRotateMatch = path.match(/^\/api\/admin\/api-tokens\/(\d+)\/rotate$/);
      if (apiTokenRotateMatch && method === "POST") {
        const auth = requireAdmin(req); if ("response" in auth) return auth.response;
        const id = parseInt(apiTokenRotateMatch[1]);
        let body: any = {}; try { body = await req.json(); } catch {}
        const grace = Math.max(0, Math.min(7 * 24 * 60, parseInt(body.grace_minutes ?? "0", 10) || 0));
        try {
          const out = rotateApiToken(db, id, auth.user.id, grace);
          logAudit(db, auth.user.id, auth.user.username, "api_token_rotated", "api_token", id,
            `new_id=${out.row.id} grace_minutes=${grace}`);
          // ACHTUNG: Klartext-Token nur HIER einmalig zurueckgeben
          return json({ ...out.row, token: out.token, old_id: out.old_id, old_grace_until: out.old_grace_until });
        } catch (e: any) {
          return err(e?.message || "Rotation fehlgeschlagen", 400);
        }
      }

      // ===== API-NUTZUNGS-VERLAUF (Admin) =====
      if (path === "/api/admin/api-usage" && method === "GET") {
        const auth = requireAdmin(req); if ("response" in auth) return auth.response;
        const p = url.searchParams;
        const r = listApiRequests(db, {
          tokenId: p.get("token_id") ? parseInt(p.get("token_id")!) : undefined,
          userId: p.get("user_id") ? parseInt(p.get("user_id")!) : undefined,
          method: p.get("method") || undefined,
          pathContains: p.get("path") || undefined,
          status: p.get("status") ? parseInt(p.get("status")!) : undefined,
          statusMin: p.get("status_min") ? parseInt(p.get("status_min")!) : undefined,
          statusMax: p.get("status_max") ? parseInt(p.get("status_max")!) : undefined,
          from: p.get("from") || undefined,
          to: p.get("to") || undefined,
          q: p.get("q") || undefined,
          limit: parseInt(p.get("limit") || "100"),
          offset: parseInt(p.get("offset") || "0"),
        });
        return json(r);
      }
      // Aggregat-Stats fuer das Usage-Dashboard
      if (path === "/api/admin/api-usage/stats" && method === "GET") {
        const auth = requireAdmin(req); if ("response" in auth) return auth.response;
        const since = url.searchParams.get("since") || new Date(Date.now() - 7 * 86400_000).toISOString();
        const stats = {
          total: (db.prepare("SELECT COUNT(*) c FROM api_request_log WHERE created_at >= ?").get(since) as any).c,
          ok:    (db.prepare("SELECT COUNT(*) c FROM api_request_log WHERE created_at >= ? AND status < 400").get(since) as any).c,
          client_err: (db.prepare("SELECT COUNT(*) c FROM api_request_log WHERE created_at >= ? AND status >= 400 AND status < 500").get(since) as any).c,
          server_err: (db.prepare("SELECT COUNT(*) c FROM api_request_log WHERE created_at >= ? AND status >= 500").get(since) as any).c,
          token_requests: (db.prepare("SELECT COUNT(*) c FROM api_request_log WHERE created_at >= ? AND auth_type = 'token'").get(since) as any).c,
          unique_tokens: (db.prepare("SELECT COUNT(DISTINCT token_id) c FROM api_request_log WHERE created_at >= ? AND token_id IS NOT NULL").get(since) as any).c,
          unique_ips: (db.prepare("SELECT COUNT(DISTINCT ip) c FROM api_request_log WHERE created_at >= ?").get(since) as any).c,
          open_bugs: (db.prepare("SELECT COUNT(*) c FROM api_bug_log WHERE resolved_at IS NULL").get() as any).c,
          top_paths: db.prepare(`
            SELECT path, COUNT(*) c FROM api_request_log
            WHERE created_at >= ? GROUP BY path ORDER BY c DESC LIMIT 10
          `).all(since),
          per_token: db.prepare(`
            SELECT t.id, t.name, t.scope, COUNT(r.id) c, MAX(r.created_at) last
            FROM api_tokens t LEFT JOIN api_request_log r ON r.token_id = t.id AND r.created_at >= ?
            WHERE t.revoked_at IS NULL
            GROUP BY t.id ORDER BY c DESC
          `).all(since),
        };
        return json(stats);
      }
      // Bug-Liste (offen + geschlossen)
      if (path === "/api/admin/api-bugs" && method === "GET") {
        const auth = requireAdmin(req); if ("response" in auth) return auth.response;
        const p = url.searchParams;
        const r = listApiBugs(db, {
          status: (p.get("status") as any) || "open",
          q: p.get("q") || undefined,
          limit: parseInt(p.get("limit") || "100"),
          offset: parseInt(p.get("offset") || "0"),
        });
        return json(r);
      }
      const bugResolveMatch = path.match(/^\/api\/admin\/api-bugs\/(\d+)\/(resolve|reopen)$/);
      if (bugResolveMatch && method === "POST") {
        const auth = requireAdmin(req); if ("response" in auth) return auth.response;
        const id = parseInt(bugResolveMatch[1]);
        const action = bugResolveMatch[2];
        if (action === "resolve") {
          const body = await req.json().catch(() => ({})) as any;
          const ok = resolveBug(db, id, auth.user.id, body?.note || null);
          return json({ success: ok });
        } else {
          const ok = reopenBug(db, id);
          return json({ success: ok });
        }
      }

      // ===== DASHBOARD =====
      if (path === "/api/dashboard" && method === "GET") {
        const auth = requireUser(req); if ("response" in auth) return auth.response;
        const me = auth.user.id;
        const now = new Date();
        const startOfDay = new Date(now); startOfDay.setHours(0,0,0,0);
        const endOfDay = new Date(now); endOfDay.setHours(23,59,59,999);
        const startOfWeek = new Date(now); startOfWeek.setDate(now.getDate() - 6); startOfWeek.setHours(0,0,0,0);
        const endOfNextWeek = new Date(now); endOfNextWeek.setDate(now.getDate() + 7); endOfNextWeek.setHours(23,59,59,999);

        // Quick-Stats: meine offene Reminders + heute/Woche-Counts
        const myOpenReminders = (db.prepare(
          `SELECT COUNT(*) c FROM reminders WHERE status = 'pending' AND owner_user_id = ?`
        ).get(me) as any).c;

        const dueToday = (db.prepare(
          `SELECT COUNT(*) c FROM reminders WHERE status = 'pending' AND due_at <= ?`
        ).get(endOfDay.toISOString()) as any).c;

        const myTerminToday = (db.prepare(
          `SELECT COUNT(*) c FROM termine WHERE user_id = ? AND start_ts >= ? AND start_ts <= ?`
        ).get(me, startOfDay.getTime(), endOfDay.getTime()) as any).c;

        const myCallsWeek = (db.prepare(
          `SELECT COUNT(*) c FROM calls WHERE user_id = ? AND started_at >= ?`
        ).get(me, startOfWeek.toISOString().replace("T"," ").substring(0,19)) as any).c;

        const myMailsWeek = (db.prepare(
          `SELECT COUNT(*) c FROM sent_emails WHERE user_id = ? AND sent_at >= ? AND status = 'sent'`
        ).get(me, startOfWeek.toISOString().replace("T"," ").substring(0,19)) as any).c;

        const newLeadsWeek = (db.prepare(
          `SELECT COUNT(*) c FROM anlagen WHERE owner_id = ? AND updated_at >= ?`
        ).get(me, startOfWeek.toISOString().replace("T"," ").substring(0,19)) as any).c;

        // Heute fällig: Reminders + Termine, gemischt
        const remindersDue = db.prepare(`
          SELECT r.id, r.due_at, r.note, r.betreiber_mastr,
            b.name as betreiber_name,
            ou.username as owner_username, ou.display_name as owner_display_name, ou.color as owner_color
          FROM reminders r
          LEFT JOIN betreiber b ON b.mastr_nummer = r.betreiber_mastr
          LEFT JOIN users ou ON r.owner_user_id = ou.id
          WHERE r.status = 'pending' AND r.due_at <= ?
          ORDER BY r.due_at ASC LIMIT 50
        `).all(endOfDay.toISOString());

        const termineToday = db.prepare(`
          SELECT t.id, t.title, t.start_ts, t.end_ts, t.anlage_id, t.location,
            a.name as anlage_name,
            u.username as user_username, u.display_name as user_display_name, u.color as user_color
          FROM termine t
          LEFT JOIN anlagen a ON t.anlage_id = a.id
          LEFT JOIN users u ON t.user_id = u.id
          WHERE t.user_id = ? AND t.start_ts >= ? AND t.start_ts <= ?
          ORDER BY t.start_ts ASC
        `).all(me, startOfDay.getTime(), endOfNextWeek.getTime());

        // Mein Verlauf: pro (Anlage, Type, Stunde) aggregiert, count >= 1
        // -> verhindert dass 3 Notizen in derselben Minute als 3 Zeilen erscheinen
        const myActivities = db.prepare(`
          SELECT
            MAX(a.id) as id,
            a.anlage_id,
            a.type,
            COUNT(*) as count,
            MAX(a.description) as description,
            MAX(a.created_at) as created_at,
            an.name as anlage_name,
            an.mastr_nummer as anlage_mastr
          FROM activities a
          LEFT JOIN anlagen an ON a.anlage_id = an.id
          WHERE a.user_id = ?
          GROUP BY a.anlage_id, a.type, substr(a.created_at, 1, 13)
          ORDER BY MAX(a.created_at) DESC
          LIMIT 30
        `).all(me);

        // Lead-Funnel: ALLE definierten Stati zeigen, auch mit count=0
        const funnel = db.prepare(`
          WITH all_statuses(status, sort_order) AS (
            SELECT 'neu', 1 UNION ALL
            SELECT 'kontaktiert', 2 UNION ALL
            SELECT 'terminiert', 3 UNION ALL
            SELECT 'interessiert', 4 UNION ALL
            SELECT 'nicht_interessiert', 5 UNION ALL
            SELECT 'abgeschlossen', 6
          )
          SELECT s.status, COALESCE(c.c, 0) as c
          FROM all_statuses s
          LEFT JOIN (
            SELECT COALESCE(status,'neu') as status, COUNT(*) c FROM anlagen GROUP BY 1
          ) c ON c.status = s.status
          ORDER BY s.sort_order
        `).all();

        // Top-3 Leads (mit höchstem Score, status != 'gewonnen' und != 'verloren')
        const topLeads = db.prepare(`
          SELECT id, mastr_nummer, name, ort, bundesland, nettonennleistung, status, lead_score, owner_id
          FROM anlagen
          WHERE COALESCE(status,'neu') NOT IN ('gewonnen','verloren')
          ORDER BY lead_score DESC, nettonennleistung DESC LIMIT 5
        `).all();

        // Unread Mention-Notifications (mein Posteingang)
        const unreadNotifs = (db.prepare(
          `SELECT COUNT(*) c FROM notifications WHERE user_id = ? AND read_at IS NULL`
        ).get(me) as any).c;

        // Letzte Notifications (gelesen + ungelesen, neueste zuerst)
        const recentNotifications = db.prepare(`
          SELECT n.id, n.type, n.title, n.body, n.anlage_id, n.read_at, n.created_at,
            fu.username as from_username, fu.display_name as from_display_name, fu.color as from_color,
            an.name as anlage_name
          FROM notifications n
          LEFT JOIN users fu ON n.from_user_id = fu.id
          LEFT JOIN anlagen an ON n.anlage_id = an.id
          WHERE n.user_id = ?
          ORDER BY n.created_at DESC LIMIT 15
        `).all(me);

        // Stale-Detection: Top 10 ueberfaellige Anlagen des Users
        // WICHTIG: Nur Anlagen MIT owner_id zaehlen — sonst sind es 82k unangetastete MaStR-Defaults
        // (Status="neu" ist Default seit Import, nicht aktiv gesetzt → kein "Pipeline-Stau" Sinn)
        const slaMap = getSlaMap(db);
        const checkable = Object.entries(slaMap).filter(([_, days]) => days > 0);
        let staleCount = 0;
        let staleAnlagen: any[] = [];
        if (checkable.length > 0) {
          const caseSql = checkable.map(([s, d]) => `WHEN a.status = '${s}' THEN ${d}`).join(" ");
          const statusList = checkable.map(([s]) => `'${s}'`).join(",");
          const isAdmin = auth.user.is_admin === 1 || auth.user.username === "admin";
          // Admin sieht ALLE zugewiesenen, User nur seine eigenen
          const ownerFilter = isAdmin ? "AND a.owner_id IS NOT NULL" : `AND a.owner_id = ${me}`;
          const cntRow = db.prepare(`
            SELECT COUNT(*) as cnt FROM anlagen a
            WHERE a.status IN (${statusList})
              AND a.status_changed_at IS NOT NULL
              AND CAST(JULIANDAY('now') - JULIANDAY(a.status_changed_at) AS INTEGER) >
                  (CASE ${caseSql} ELSE 9999 END)
              ${ownerFilter}
          `).get() as any;
          staleCount = cntRow?.cnt || 0;
          staleAnlagen = db.prepare(`
            SELECT a.id, a.mastr_nummer, a.name, a.ort, a.bundesland, a.status, a.lead_score, a.nettonennleistung,
              a.owner_id,
              o.username as owner_username, o.display_name as owner_display_name,
              CAST(JULIANDAY('now') - JULIANDAY(a.status_changed_at) AS INTEGER) as days_in_status,
              CASE ${caseSql} ELSE 9999 END as sla_days,
              CAST(JULIANDAY('now') - JULIANDAY(a.status_changed_at) AS INTEGER) -
                (CASE ${caseSql} ELSE 9999 END) as overdue_days
            FROM anlagen a
            LEFT JOIN users o ON a.owner_id = o.id
            WHERE a.status IN (${statusList})
              AND a.status_changed_at IS NOT NULL
              AND CAST(JULIANDAY('now') - JULIANDAY(a.status_changed_at) AS INTEGER) >
                  (CASE ${caseSql} ELSE 9999 END)
              ${ownerFilter}
            ORDER BY overdue_days DESC, a.lead_score DESC
            LIMIT 8
          `).all() as any[];
        }

        return json({
          user: { id: me, username: auth.user.username, display_name: auth.user.display_name },
          quick_stats: {
            my_open_reminders: myOpenReminders,
            due_today_total: dueToday,
            my_termine_today: myTerminToday,
            my_calls_week: myCallsWeek,
            my_mails_week: myMailsWeek,
            new_leads_week: newLeadsWeek,
            unread_notifications: unreadNotifs,
            stale_count: staleCount,
          },
          reminders_due: remindersDue,
          termine_upcoming: termineToday,
          my_activities: myActivities,
          funnel,
          top_leads: topLeads,
          recent_notifications: recentNotifications,
          stale_anlagen: staleAnlagen,
        });
      }
      // ===== AUTOMATIONS — Pipeline-Regeln =====
      if (path === "/api/automations" && method === "GET") {
        const auth = requireUser(req); if ("response" in auth) return auth.response;
        const rows = db.prepare(`
          SELECT a.*, u.username as created_by_username, u.display_name as created_by_display_name,
            (SELECT COUNT(*) FROM automation_log WHERE automation_id = a.id AND success = 1) as success_count,
            (SELECT COUNT(*) FROM automation_log WHERE automation_id = a.id AND success = 0) as fail_count
          FROM automations a LEFT JOIN users u ON a.created_by = u.id
          ORDER BY a.is_active DESC, a.created_at DESC
        `).all();
        return json(rows);
      }
      if (path === "/api/automations" && method === "POST") {
        const auth = requireUser(req); if ("response" in auth) return auth.response;
        if (!auth.user.is_admin && auth.user.username !== "admin") return err("Nur Admin", 403);
        const b = (await req.json()) as any;
        if (!b.name || !b.trigger_type || !b.action_type) return err("name, trigger_type, action_type erforderlich");
        const allowedTriggers = ["status_stale", "no_reply", "email_opened_n_times"];
        const allowedActions = ["set_status", "create_reminder", "notify_owner", "send_email"];
        if (!allowedTriggers.includes(b.trigger_type)) return err("Ungueltiger trigger_type");
        if (!allowedActions.includes(b.action_type)) return err("Ungueltiger action_type");
        const r = db.prepare(`
          INSERT INTO automations (name, trigger_type, trigger_config, action_type, action_config, is_active, created_by)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(
          String(b.name).slice(0, 200),
          b.trigger_type,
          JSON.stringify(b.trigger_config || {}),
          b.action_type,
          JSON.stringify({ type: b.action_type, ...(b.action_config || {}) }),
          b.is_active === false ? 0 : 1,
          auth.user.id,
        );
        return json({ success: true, id: r.lastInsertRowid });
      }
      const automationIdMatch = path.match(/^\/api\/automations\/(\d+)$/);
      if (automationIdMatch && method === "PUT") {
        const auth = requireUser(req); if ("response" in auth) return auth.response;
        if (!auth.user.is_admin && auth.user.username !== "admin") return err("Nur Admin", 403);
        const id = parseInt(automationIdMatch[1]);
        const b = (await req.json()) as any;
        db.prepare(`
          UPDATE automations SET name = ?, trigger_type = ?, trigger_config = ?, action_type = ?, action_config = ?, is_active = ?
          WHERE id = ?
        `).run(
          String(b.name || "").slice(0, 200),
          b.trigger_type,
          JSON.stringify(b.trigger_config || {}),
          b.action_type,
          JSON.stringify({ type: b.action_type, ...(b.action_config || {}) }),
          b.is_active === false ? 0 : 1,
          id,
        );
        return json({ success: true });
      }
      if (automationIdMatch && method === "DELETE") {
        const auth = requireUser(req); if ("response" in auth) return auth.response;
        if (!auth.user.is_admin && auth.user.username !== "admin") return err("Nur Admin", 403);
        const id = parseInt(automationIdMatch[1]);
        db.prepare(`DELETE FROM automation_log WHERE automation_id = ?`).run(id);
        db.prepare(`DELETE FROM automations WHERE id = ?`).run(id);
        return json({ success: true });
      }
      const automationLogMatch = path.match(/^\/api\/automations\/(\d+)\/log$/);
      if (automationLogMatch && method === "GET") {
        const auth = requireUser(req); if ("response" in auth) return auth.response;
        const id = parseInt(automationLogMatch[1]);
        const rows = db.prepare(`
          SELECT al.*, a.name as anlage_name, a.mastr_nummer
          FROM automation_log al LEFT JOIN anlagen a ON al.anlage_id = a.id
          WHERE al.automation_id = ? ORDER BY al.fired_at DESC LIMIT 50
        `).all(id);
        return json(rows);
      }

      // ===== DSGVO Anonymisierung — Art. 17 "Recht auf Vergessenwerden" =====
      // GET /api/admin/dsgvo/preview?email=… — zeigt was anonymisiert WUERDE (kein Schreibzugriff)
      if (path === "/api/admin/dsgvo/preview" && method === "GET") {
        const auth = requireUser(req); if ("response" in auth) return auth.response;
        if (!auth.user.is_admin && auth.user.username !== "admin") return err("Nur Admin", 403);
        const email = (url.searchParams.get("email") || "").toLowerCase().trim();
        if (!email) return err("Email-Parameter fehlt", 400);
        // Suche alle Stellen wo diese Email vorkommt + zugeordnete Anlagen/Betreiber
        const anlagen = db.prepare(`
          SELECT a.id, a.mastr_nummer, a.name, a.ort, a.bundesland, a.betreiber_mastr, a.betreiber_name, a.kontakt_email, a.kontakt_telefon
          FROM anlagen a WHERE LOWER(a.kontakt_email) = ?
          UNION
          SELECT a.id, a.mastr_nummer, a.name, a.ort, a.bundesland, a.betreiber_mastr, a.betreiber_name, a.kontakt_email, a.kontakt_telefon
          FROM anlagen a JOIN betreiber b ON a.betreiber_mastr = b.mastr_nummer WHERE LOWER(b.email) = ?
        `).all(email, email) as any[];
        const betreiber = db.prepare(`SELECT mastr_nummer, name, email, telefon FROM betreiber WHERE LOWER(email) = ?`).all(email) as any[];
        const leads = db.prepare(`SELECT id, name, email, telefon, firma, created_at FROM public_leads WHERE LOWER(email) = ?`).all(email) as any[];
        const sentMails = (db.prepare(`SELECT COUNT(*) as cnt FROM sent_emails WHERE LOWER(to_addr) = ? OR LOWER(cc_addr) LIKE ?`).get(email, "%" + email + "%") as any)?.cnt || 0;
        const replies = (db.prepare(`SELECT COUNT(*) as cnt FROM email_replies WHERE LOWER(from_addr) = ?`).get(email) as any)?.cnt || 0;
        const betreiberMastr = anlagen[0]?.betreiber_mastr || betreiber[0]?.mastr_nummer || null;
        let calls = 0, notizen = 0, reminders = 0;
        if (betreiberMastr) {
          calls = (db.prepare(`SELECT COUNT(*) as cnt FROM calls WHERE anlage_id IN (SELECT id FROM anlagen WHERE betreiber_mastr = ?)`).get(betreiberMastr) as any)?.cnt || 0;
          notizen = (db.prepare(`SELECT COUNT(*) as cnt FROM notizen WHERE betreiber_mastr = ?`).get(betreiberMastr) as any)?.cnt || 0;
          reminders = (db.prepare(`SELECT COUNT(*) as cnt FROM reminders WHERE betreiber_mastr = ?`).get(betreiberMastr) as any)?.cnt || 0;
        }
        return json({
          email, betreiber_mastr: betreiberMastr,
          summary: {
            anlagen: anlagen.length,
            betreiber: betreiber.length,
            public_leads: leads.length,
            sent_emails: sentMails,
            email_replies: replies,
            calls, notizen, reminders,
          },
          anlagen: anlagen.slice(0, 10),
          betreiber, leads,
        });
      }
      // POST /api/admin/dsgvo/anonymize { email, mastr_nummer?, reason } — fuehrt die Anonymisierung aus
      if (path === "/api/admin/dsgvo/anonymize" && method === "POST") {
        const auth = requireUser(req); if ("response" in auth) return auth.response;
        if (!auth.user.is_admin && auth.user.username !== "admin") return err("Nur Admin", 403);
        const b = (await req.json()) as any;
        const email = (b.email || "").toLowerCase().trim();
        const mastrNummer = b.mastr_nummer ? String(b.mastr_nummer).toUpperCase().replace(/[^A-Z0-9]/g, "") : null;
        const reason = (b.reason || "DSGVO Art. 17 Loeschungsantrag").trim().slice(0, 500);
        if (!email && !mastrNummer) return err("Email oder MaStR-Nummer erforderlich", 400);
        // BetreiberMastr automatisch finden
        let betreiberMastr: string | null = null;
        if (email) {
          const a = db.prepare(`
            SELECT a.betreiber_mastr FROM anlagen a WHERE LOWER(a.kontakt_email) = ?
            UNION
            SELECT mastr_nummer as betreiber_mastr FROM betreiber WHERE LOWER(email) = ?
            LIMIT 1
          `).get(email, email) as any;
          if (a) betreiberMastr = a.betreiber_mastr;
        }
        if (mastrNummer && !betreiberMastr) {
          const a = db.prepare("SELECT betreiber_mastr FROM anlagen WHERE mastr_nummer = ?").get(mastrNummer) as any;
          if (a) betreiberMastr = a.betreiber_mastr;
        }
        const counts = dsgvoAnonymize(db, email || null, mastrNummer, betreiberMastr, reason, auth.user.id);
        log.info("dsgvo_anonymize_executed", { byUserId: auth.user.id, counts });
        return json({ success: true, betreiber_mastr: betreiberMastr, counts });
      }

      // GET /api/anlagen/:id/timeline — chronologische Touches fuer Pre-Call-Briefing
      const timelineMatch = path.match(/^\/api\/anlagen\/(\d+)\/timeline$/);
      if (timelineMatch && method === "GET") {
        const auth = requireUser(req); if ("response" in auth) return auth.response;
        const aid = parseInt(timelineMatch[1]);
        // Sammle alle Events: sent_emails, email_replies, calls, notizen, reminders, activities, status_changes (via lead_score_log)
        const events: any[] = [];
        // 1. Sent mails
        for (const m of db.prepare(`
          SELECT s.id, s.sent_at as ts, s.subject, s.status, s.to_addr,
            (SELECT COUNT(*) FROM email_events WHERE sent_email_id=s.id AND event_type='open') as opens,
            (SELECT COUNT(*) FROM email_events WHERE sent_email_id=s.id AND event_type='click') as clicks,
            u.username as user_username, u.display_name as user_display_name
          FROM sent_emails s LEFT JOIN users u ON s.user_id = u.id
          WHERE s.anlage_id = ? ORDER BY s.sent_at DESC LIMIT 50
        `).all(aid) as any[]) {
          events.push({
            type: "email_sent", ts: m.ts, icon: "✉",
            title: m.subject || "(ohne Betreff)",
            subtitle: `An: ${m.to_addr}` + (m.opens > 0 ? ` · ${m.opens}× geoeffnet` : "") + (m.clicks > 0 ? ` · ${m.clicks}× geklickt` : ""),
            user: m.user_display_name || m.user_username,
            badge: m.opens > 0 ? "geoeffnet" : m.status,
            badge_color: m.clicks > 0 ? "cyan" : m.opens > 0 ? "emerald" : "ink",
            id: m.id,
          });
        }
        // 2. Email-Replies
        for (const r of db.prepare(`
          SELECT id, received_at as ts, subject, from_addr, substr(body_text, 1, 200) as snippet
          FROM email_replies WHERE anlage_id = ? ORDER BY received_at DESC LIMIT 30
        `).all(aid) as any[]) {
          events.push({
            type: "email_reply", ts: r.ts, icon: "📩",
            title: r.subject || "(ohne Betreff)",
            subtitle: `Von: ${r.from_addr}` + (r.snippet ? ` · ${String(r.snippet).slice(0, 100)}` : ""),
            badge: "Antwort",
            badge_color: "emerald",
            id: r.id,
          });
        }
        // 3. Calls
        for (const c of db.prepare(`
          SELECT c.id, c.started_at as ts, c.duration_seconds, c.outcome, c.notes, c.ai_summary, c.ai_sentiment,
            u.username as user_username, u.display_name as user_display_name
          FROM calls c LEFT JOIN users u ON c.user_id = u.id
          WHERE c.anlage_id = ? ORDER BY c.started_at DESC LIMIT 30
        `).all(aid) as any[]) {
          const sentIcon = c.ai_sentiment === "positive" ? " 😊" : c.ai_sentiment === "negative" ? " 😐" : "";
          events.push({
            type: "call", ts: c.ts, icon: "📞",
            title: `Anruf · ${c.outcome || "?"}` + (c.duration_seconds ? ` · ${Math.round(c.duration_seconds/60)} Min` : "") + sentIcon,
            subtitle: c.notes || c.ai_summary || "",
            user: c.user_display_name || c.user_username,
            badge: c.outcome === "reached" ? "Erreicht" : c.outcome === "voicemail" ? "Mailbox" : c.outcome,
            badge_color: c.outcome === "reached" ? "emerald" : "amber",
            id: c.id,
          });
        }
        // 4. Notizen
        const anlageRow = db.prepare("SELECT betreiber_mastr FROM anlagen WHERE id = ?").get(aid) as any;
        if (anlageRow?.betreiber_mastr) {
          for (const n of db.prepare(`
            SELECT n.id, n.created_at as ts, n.text, n.scope,
              u.username as user_username, u.display_name as user_display_name
            FROM notizen n LEFT JOIN users u ON n.user_id = u.id
            WHERE n.anlage_id = ? OR n.betreiber_mastr = ?
            ORDER BY n.created_at DESC LIMIT 30
          `).all(aid, anlageRow.betreiber_mastr) as any[]) {
            events.push({
              type: "note", ts: n.ts, icon: "📝",
              title: "Notiz" + (n.scope === "betreiber" ? " (Kunde)" : ""),
              subtitle: String(n.text || "").slice(0, 200),
              user: n.user_display_name || n.user_username,
              badge: null, badge_color: null,
              id: n.id,
            });
          }
        }
        // 5. Activities (status_change, owner_change, kontakt_updated, etc.)
        for (const a of db.prepare(`
          SELECT a.id, a.created_at as ts, a.type, a.description,
            u.username as user_username, u.display_name as user_display_name
          FROM activities a LEFT JOIN users u ON a.user_id = u.id
          WHERE a.anlage_id = ? ORDER BY a.created_at DESC LIMIT 30
        `).all(aid) as any[]) {
          const iconMap: Record<string, string> = {
            status_change: "🔄", owner_change: "👤", owner_auto_assign: "👤",
            owner_restored: "👤", kontakt_updated: "✏", note_added: "📝",
            comment_added: "💬", termin_created: "📅",
          };
          events.push({
            type: a.type, ts: a.ts, icon: iconMap[a.type] || "•",
            title: a.type.replace(/_/g, " "),
            subtitle: a.description || "",
            user: a.user_display_name || a.user_username,
            badge: null, badge_color: "ink",
            id: a.id,
          });
        }
        // 6. Reminders (Wiedervorlagen)
        if (anlageRow?.betreiber_mastr) {
          for (const r of db.prepare(`
            SELECT r.id, r.due_at as ts, r.note, r.status,
              u.username as user_username, u.display_name as user_display_name
            FROM reminders r LEFT JOIN users u ON r.owner_user_id = u.id
            WHERE r.betreiber_mastr = ? ORDER BY r.due_at DESC LIMIT 10
          `).all(anlageRow.betreiber_mastr) as any[]) {
            events.push({
              type: "reminder", ts: r.ts, icon: "⏰",
              title: `Wiedervorlage: ${r.status}`,
              subtitle: r.note || "",
              user: r.user_display_name || r.user_username,
              badge: r.status,
              badge_color: r.status === "pending" ? "amber" : "emerald",
              id: r.id,
            });
          }
        }
        // Sortieren absteigend nach ts
        events.sort((a, b) => (b.ts || "").localeCompare(a.ts || ""));
        return json({ events: events.slice(0, 80), total: events.length });
      }

      // ===== TAGESPLAN ===== "Was mache ich jetzt?" — priorisierte Anrufliste fuer den Verkaeufer
      if (path === "/api/dashboard/tagesplan" && method === "GET") {
        const auth = requireUser(req); if ("response" in auth) return auth.response;
        const me = auth.user.id;
        const items: any[] = [];
        // Priority 1: Wiedervorlagen heute oder ueberfaellig (Reminders)
        const reminders = db.prepare(`
          SELECT r.id as ref_id, r.due_at, r.note, r.betreiber_mastr,
            a.id as anlage_id, a.name as anlage_name, a.ort, a.bundesland, a.nettonennleistung,
            a.kontakt_email, a.kontakt_telefon, a.status, a.lead_score
          FROM reminders r
          LEFT JOIN anlagen a ON a.betreiber_mastr = r.betreiber_mastr
          WHERE r.status = 'pending' AND r.owner_user_id = ?
            AND date(r.due_at) <= date('now')
          ORDER BY r.due_at ASC LIMIT 20
        `).all(me) as any[];
        for (const r of reminders) {
          items.push({
            kind: "reminder",
            priority: 1,
            ref_id: r.ref_id,
            anlage_id: r.anlage_id,
            title: r.anlage_name || r.betreiber_mastr,
            subtitle: r.note || "Wiedervorlage faellig",
            location: [r.ort, r.bundesland].filter(Boolean).join(" · "),
            leistung: r.nettonennleistung,
            status: r.status,
            score: r.lead_score,
            email: r.kontakt_email,
            phone: r.kontakt_telefon,
            badge: "⏰ Wiedervorlage",
            badge_color: "amber",
            time_label: r.due_at,
          });
        }
        // Priority 2: Pipeline-Stau Anlagen des Users
        const slaMap = getSlaMap(db);
        const checkable = Object.entries(slaMap).filter(([_, d]) => d > 0);
        if (checkable.length > 0) {
          const caseSql = checkable.map(([s, d]) => `WHEN a.status = '${s}' THEN ${d}`).join(" ");
          const statusList = checkable.map(([s]) => `'${s}'`).join(",");
          const stale = db.prepare(`
            SELECT a.id as anlage_id, a.name, a.ort, a.bundesland, a.nettonennleistung,
              a.status, a.lead_score, a.kontakt_email, a.kontakt_telefon,
              CAST(JULIANDAY('now') - JULIANDAY(a.status_changed_at) AS INTEGER) as days_in_status,
              CAST(JULIANDAY('now') - JULIANDAY(a.status_changed_at) AS INTEGER) -
                (CASE ${caseSql} ELSE 9999 END) as overdue_days
            FROM anlagen a
            WHERE a.status IN (${statusList})
              AND a.owner_id = ?
              AND a.status_changed_at IS NOT NULL
              AND CAST(JULIANDAY('now') - JULIANDAY(a.status_changed_at) AS INTEGER) >
                  (CASE ${caseSql} ELSE 9999 END)
            ORDER BY overdue_days DESC, a.lead_score DESC
            LIMIT 10
          `).all(me) as any[];
          for (const s of stale) {
            items.push({
              kind: "stale",
              priority: 2,
              ref_id: s.anlage_id,
              anlage_id: s.anlage_id,
              title: s.name,
              subtitle: `Seit ${s.days_in_status}T in "${s.status}" (+${s.overdue_days}T)`,
              location: [s.ort, s.bundesland].filter(Boolean).join(" · "),
              leistung: s.nettonennleistung,
              status: s.status,
              score: s.lead_score,
              email: s.kontakt_email,
              phone: s.kontakt_telefon,
              badge: "🚨 Pipeline-Stau",
              badge_color: "rose",
              time_label: null,
            });
          }
        }
        // Priority 3: Top-Score-Leads des Users die NIE kontaktiert wurden (Status=neu) — wenn noch Platz
        const remaining = Math.max(0, 25 - items.length);
        if (remaining > 0) {
          const top = db.prepare(`
            SELECT a.id as anlage_id, a.name, a.ort, a.bundesland, a.nettonennleistung,
              a.status, a.lead_score, a.kontakt_email, a.kontakt_telefon
            FROM anlagen a
            WHERE a.owner_id = ? AND a.status = 'neu'
              AND ((a.kontakt_email IS NOT NULL AND a.kontakt_email != '')
                OR (a.kontakt_telefon IS NOT NULL AND a.kontakt_telefon != ''))
            ORDER BY a.lead_score DESC, a.nettonennleistung DESC
            LIMIT ?
          `).all(me, remaining) as any[];
          for (const t of top) {
            items.push({
              kind: "top_lead",
              priority: 3,
              ref_id: t.anlage_id,
              anlage_id: t.anlage_id,
              title: t.name,
              subtitle: t.lead_score > 0 ? `Top-Score Lead — noch nie kontaktiert` : "Noch nie kontaktiert",
              location: [t.ort, t.bundesland].filter(Boolean).join(" · "),
              leistung: t.nettonennleistung,
              status: t.status,
              score: t.lead_score,
              email: t.kontakt_email,
              phone: t.kontakt_telefon,
              badge: "⭐ Top-Lead",
              badge_color: "cyan",
              time_label: null,
            });
          }
        }
        return json({
          items,
          counts: {
            reminders: items.filter(i => i.kind === "reminder").length,
            stale: items.filter(i => i.kind === "stale").length,
            top_leads: items.filter(i => i.kind === "top_lead").length,
            total: items.length,
          },
        });
      }

      // ===== STALE-DETECTION (Pipeline-Stau) =====
      if (path === "/api/stale-anlagen" && method === "GET") {
        const auth = requireUser(req); if ("response" in auth) return auth.response;
        const slaMap = getSlaMap(db);
        const onlyMine = url.searchParams.get("only_mine") === "1";
        // Status mit SLA > 0 zaehlen als pruefbar; SQL-Liste bauen
        const checkable = Object.entries(slaMap).filter(([_, days]) => days > 0);
        if (checkable.length === 0) return json({ count: 0, anlagen: [] });
        // CASE-Statement das pro Status den SLA-Tag setzt
        const caseSql = checkable.map(([s, d]) => `WHEN a.status = '${s}' THEN ${d}`).join(" ");
        const statusList = checkable.map(([s]) => `'${s}'`).join(",");
        const ownerFilter = onlyMine ? `AND a.owner_id = ${auth.user.id}` : "";
        const rows = db.prepare(`
          SELECT a.id, a.mastr_nummer, a.name, a.plz, a.ort, a.bundesland,
            a.nettonennleistung, a.status, a.lead_score, a.betreiber_name,
            a.status_changed_at, a.owner_id,
            o.username as owner_username, o.display_name as owner_display_name, o.color as owner_color,
            CAST(JULIANDAY('now') - JULIANDAY(a.status_changed_at) AS INTEGER) as days_in_status,
            CASE ${caseSql} ELSE 9999 END as sla_days,
            CAST(JULIANDAY('now') - JULIANDAY(a.status_changed_at) AS INTEGER) -
              (CASE ${caseSql} ELSE 9999 END) as overdue_days
          FROM anlagen a
          LEFT JOIN users o ON a.owner_id = o.id
          WHERE a.status IN (${statusList})
            AND a.status_changed_at IS NOT NULL
            AND CAST(JULIANDAY('now') - JULIANDAY(a.status_changed_at) AS INTEGER) >
                (CASE ${caseSql} ELSE 9999 END)
            ${ownerFilter}
          ORDER BY overdue_days DESC, a.lead_score DESC
          LIMIT 100
        `).all() as any[];
        return json({ count: rows.length, sla_map: slaMap, anlagen: rows });
      }

      if (path === "/api/stats" && method === "GET") {
        const a = db.prepare(`SELECT COUNT(*) as total, SUM(nettonennleistung) as gesamtleistung FROM anlagen`).get() as any;
        const byStatus = db.prepare(`SELECT status, COUNT(*) as count FROM anlagen GROUP BY status`).all();
        return json({ total: a.total || 0, gesamtleistung: a.gesamtleistung || 0, byStatus });
      }

      // ===== BUNDESLAENDER (dynamic for filter) =====
      if (path === "/api/bundeslaender" && method === "GET") {
        const rows = db.prepare(`
          SELECT bundesland, COUNT(*) as count
          FROM anlagen
          WHERE bundesland IS NOT NULL AND bundesland != ''
          GROUP BY bundesland
          ORDER BY bundesland
        `).all();
        return json(rows);
      }

      // ===== 2FA (TOTP) =====
      if (path === "/api/2fa/status" && method === "GET") {
        const auth = requireUser(req); if ("response" in auth) return auth.response;
        const u = db.prepare("SELECT totp_enabled FROM users WHERE id=?").get(auth.user.id) as any;
        return json({ enabled: !!u?.totp_enabled });
      }
      if (path === "/api/2fa/enable-start" && method === "POST") {
        const auth = requireUser(req); if ("response" in auth) return auth.response;
        const { authenticator } = await import("otplib");
        const QRCode = (await import("qrcode")).default;
        const secret = authenticator.generateSecret();
        // Speichere temporaer (bis Verify) verschluesselt
        db.prepare("UPDATE users SET totp_secret_enc=? WHERE id=?").run(encrypt(secret), auth.user.id);
        const otpauth = authenticator.keyuri(auth.user.username, "MaStR-Solar-DB", secret);
        const qrDataUrl = await QRCode.toDataURL(otpauth);
        return json({ secret, otpauth, qr: qrDataUrl });
      }
      if (path === "/api/2fa/enable-verify" && method === "POST") {
        const auth = requireUser(req); if ("response" in auth) return auth.response;
        const b = (await req.json()) as any;
        const code = String(b.code || "").trim();
        if (!/^\d{6}$/.test(code)) return err("Code muss 6 Ziffern haben");
        const u = db.prepare("SELECT totp_secret_enc FROM users WHERE id=?").get(auth.user.id) as any;
        if (!u?.totp_secret_enc) return err("Kein 2FA-Setup laufend", 400);
        const { authenticator } = await import("otplib");
        const secret = decrypt(u.totp_secret_enc);
        if (!authenticator.check(code, secret)) return err("Code falsch", 400);
        db.prepare("UPDATE users SET totp_enabled=1 WHERE id=?").run(auth.user.id);
        logAudit(db, { userId: auth.user.id, username: auth.user.username, action: "2fa_enable", ip });
        return json({ success: true });
      }
      if (path === "/api/2fa/disable" && method === "POST") {
        const auth = requireUser(req); if ("response" in auth) return auth.response;
        const b = (await req.json()) as any;
        const code = String(b.code || "").trim();
        const u = db.prepare("SELECT totp_secret_enc, totp_enabled FROM users WHERE id=?").get(auth.user.id) as any;
        if (!u?.totp_enabled) return json({ success: true });
        const { authenticator } = await import("otplib");
        if (!authenticator.check(code, decrypt(u.totp_secret_enc))) return err("Code falsch", 400);
        db.prepare("UPDATE users SET totp_enabled=0, totp_secret_enc=NULL WHERE id=?").run(auth.user.id);
        logAudit(db, { userId: auth.user.id, username: auth.user.username, action: "2fa_disable", ip });
        return json({ success: true });
      }

      // ===== AUDIT-LOG =====
      if ((path === "/api/audit-log" || path === "/api/audit-log.csv") && method === "GET") {
        const auth = requireUser(req); if ("response" in auth) return auth.response;
        if (!auth.user.is_admin && auth.user.username !== "admin") return err("Nur Admin", 403, { code: "ADMIN_ONLY" });
        const u = new URL(req.url);
        const isCsv = path.endsWith(".csv");
        const limit = isCsv
          ? Math.min(50_000, parseInt(u.searchParams.get("limit") || "10000"))
          : Math.min(500, parseInt(u.searchParams.get("limit") || "100"));
        const offset = Math.max(0, parseInt(u.searchParams.get("offset") || "0"));
        const action  = u.searchParams.get("action") || "";
        const userId  = u.searchParams.get("user_id") || "";
        const entity  = u.searchParams.get("entity") || "";
        const q       = (u.searchParams.get("q") || "").trim();
        const from    = u.searchParams.get("from") || "";
        const to      = u.searchParams.get("to") || "";
        const where: string[] = []; const args: any[] = [];
        if (action) { where.push("action = ?"); args.push(action); }
        if (userId) { where.push("user_id = ?"); args.push(parseInt(userId)); }
        if (entity) { where.push("entity = ?"); args.push(entity); }
        if (from)   { where.push("created_at >= ?"); args.push(from); }
        if (to)     { where.push("created_at <= ?"); args.push(to); }
        if (q)      { where.push("(username LIKE ? OR action LIKE ? OR detail LIKE ?)");
                     args.push("%"+q+"%","%"+q+"%","%"+q+"%"); }
        const wc = where.length ? `WHERE ${where.join(" AND ")}` : "";
        const total = (db.prepare(`SELECT COUNT(*) c FROM audit_log ${wc}`).get(...args) as any).c;
        const rows = db.prepare(`
          SELECT id, user_id, username, action, entity, entity_id, detail, ip_hash, created_at
          FROM audit_log ${wc}
          ORDER BY created_at DESC LIMIT ? OFFSET ?
        `).all(...args, limit, offset) as any[];
        if (!isCsv) {
          return json({ items: rows, total, limit, offset });
        }
        // RFC-4180 CSV mit BOM für Excel
        function esc(v: any) {
          const s = String(v ?? "");
          return /[,"\n\r]/.test(s) ? "\"" + s.replace(/"/g, "\"\"") + "\"" : s;
        }
        const cols = ["created_at","username","user_id","action","entity","entity_id","detail","ip_hash"];
        const lines = [cols.join(",")];
        for (const r of rows) lines.push(cols.map(c => esc((r as any)[c])).join(","));
        const csv = "﻿" + lines.join("\r\n") + "\r\n";
        const fname = `audit-${new Date().toISOString().slice(0,10)}.csv`;
        return new Response(csv, {
          status: 200,
          headers: {
            "Content-Type": "text/csv; charset=utf-8",
            "Content-Disposition": `attachment; filename="${fname}"`,
            "Cache-Control": "no-store",
          },
        });
      }

      // ===== GDPR-EXPORT =====
      const gdprMatch = path.match(/^\/api\/anlagen\/(\d+)\/gdpr-export$/);
      if (gdprMatch && method === "GET") {
        const auth = requireUser(req); if ("response" in auth) return auth.response;
        const id = parseInt(gdprMatch[1]);
        const { gdprExportAnlage, logAudit } = await import("./lib/audit");
        try {
          const data = gdprExportAnlage(db, id);
          logAudit(db, {
            userId: auth.user.id, username: auth.user.username,
            action: "gdpr_export", entity: "anlage", entityId: id,
            ip: req.headers.get("x-forwarded-for") || null,
          });
          return new Response(JSON.stringify(data, null, 2), {
            headers: {
              "Content-Type": "application/json; charset=utf-8",
              "Content-Disposition": `attachment; filename="gdpr-anlage-${id}-${new Date().toISOString().substring(0,10)}.json"`,
            },
          });
        } catch (e: any) {
          return err(e.message, 404);
        }
      }

      // ===== PDF-ANGEBOT =====
      const quoteMatch = path.match(/^\/api\/anlagen\/(\d+)\/quote$/);
      if (quoteMatch && method === "GET") {
        const auth = requireUser(req); if ("response" in auth) return auth.response;
        const id = parseInt(quoteMatch[1]);
        const u = new URL(req.url);
        const opts = {
          mehrertrag_pct: u.searchParams.get("mehrertrag_pct") ? parseFloat(u.searchParams.get("mehrertrag_pct")!) : undefined,
          repowering_capex_per_kwp: u.searchParams.get("capex_per_kwp") ? parseFloat(u.searchParams.get("capex_per_kwp")!) : undefined,
          strompreis_eur_kwh: u.searchParams.get("strompreis") ? parseFloat(u.searchParams.get("strompreis")!) : undefined,
          laufzeit_jahre: u.searchParams.get("laufzeit") ? parseInt(u.searchParams.get("laufzeit")!) : undefined,
        };
        const user = db.prepare("SELECT display_name, username, smtp_from_name, signature_html, email FROM users WHERE id = ?").get(auth.user.id) as any;
        const { buildQuoteHtml } = await import("./lib/pdf-quote");
        try {
          const html = buildQuoteHtml(db, { anlageId: id, user, options: opts });
          return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
        } catch (e: any) {
          return err(e.message || "Fehler", 400);
        }
      }

      // ===== MAP =====
      if (path === "/api/map/markers" && method === "GET") {
        const auth = requireUser(req); if ("response" in auth) return auth.response;
        const u = new URL(req.url);
        const status = u.searchParams.get("status") || "";
        const owner = u.searchParams.get("owner") || "";
        const minScore = parseInt(u.searchParams.get("min_score") || "0");
        // Neue Filter — synchron mit dem gemeinsamen Filter-Block ueber alle Tabs
        const bundesland = u.searchParams.get("bundesland") || "";
        const leistungMin = parseFloat(u.searchParams.get("leistung_min") || "0");
        const mitKontakt = u.searchParams.get("mit_kontakt") || "";
        const datumVon = u.searchParams.get("datum_von") || "";
        const datumBis = u.searchParams.get("datum_bis") || "";
        const search = (u.searchParams.get("q") || u.searchParams.get("search") || "").trim().toLowerCase();
        const limit = 100000;
        // DE-Bounding-Box (mit kleinem Puffer): verhindert dass kaputte MaStR-Koordinaten
        // (z.B. lat=47,lng=5 → Frankreich) auf der Karte erscheinen.
        const where: string[] = [
          "a.breitengrad IS NOT NULL", "a.laengengrad IS NOT NULL",
          "a.breitengrad BETWEEN 47.2 AND 55.1",
          "a.laengengrad BETWEEN 5.8 AND 15.1",
        ];
        const args: any[] = [];
        if (status) { where.push("a.status = ?"); args.push(status); }
        if (minScore > 0) { where.push("a.lead_score >= ?"); args.push(minScore); }
        if (owner === "me") { where.push("a.owner_id = ?"); args.push(auth.user.id); }
        else if (owner === "unassigned") { where.push("a.owner_id IS NULL"); }
        else if (owner) { where.push("a.owner_id = ?"); args.push(parseInt(owner)); }
        if (bundesland) { where.push("a.bundesland = ?"); args.push(bundesland); }
        if (leistungMin > 0) { where.push("a.nettonennleistung >= ?"); args.push(leistungMin); }
        if (mitKontakt === "ja") where.push("EXISTS (SELECT 1 FROM betreiber b WHERE b.mastr_nummer = a.betreiber_mastr AND (b.email IS NOT NULL OR b.telefon IS NOT NULL))");
        if (mitKontakt === "nein") where.push("NOT EXISTS (SELECT 1 FROM betreiber b WHERE b.mastr_nummer = a.betreiber_mastr AND (b.email IS NOT NULL OR b.telefon IS NOT NULL))");
        if (datumVon) { where.push("a.inbetriebnahme >= ?"); args.push(datumVon); }
        if (datumBis) { where.push("a.inbetriebnahme <= ?"); args.push(datumBis); }
        if (search) {
          where.push("(LOWER(a.name) LIKE ? OR LOWER(a.betreiber_name) LIKE ? OR a.plz LIKE ? OR LOWER(a.ort) LIKE ? OR LOWER(a.mastr_nummer) LIKE ?)");
          const like = `%${search}%`;
          args.push(like, like, like, like, like);
        }
        // API-Client: nur bearbeitete Anlagen auf der Karte.
        if (isApiClient(auth.user)) where.push("a.owner_id IS NOT NULL");
        // Viewer: alle bearbeiteten Anlagen (Owner, Status, Calls, Mails oder Notizen)
        if (isViewer(auth.user)) where.push(VIEWER_VISIBLE_SQL);
        // SLIM payload: nur die Render-Felder. Detail beim Klick via /api/anlagen/:id
        // 50k × 11 Felder (12.6 MB JSON) -> 50k × 4 Felder (~3 MB JSON) -> ~500 KB gzipped
        const rows = db.prepare(`
          SELECT a.id, a.breitengrad as lat, a.laengengrad as lng,
            CAST(a.nettonennleistung AS INTEGER) as p,
            a.geocode_precision as pr
          FROM anlagen a
          WHERE ${where.join(" AND ")}
          ORDER BY a.lead_score DESC, a.nettonennleistung DESC
          LIMIT ${limit}
        `).all(...args);
        return json(rows);
      }
      const geocodeOneMatch = path.match(/^\/api\/anlagen\/(\d+)\/geocode$/);
      if (geocodeOneMatch && method === "POST") {
        const auth = requireUser(req); if ("response" in auth) return auth.response;
        const id = parseInt(geocodeOneMatch[1]);
        const a = db.prepare("SELECT id, strasse, hausnummer, plz, ort FROM anlagen WHERE id=?").get(id) as any;
        if (!a) return err("Nicht gefunden", 404, { code: "NOT_FOUND" });
        const { geocodeAddress } = await import("./lib/geocoder");
        const result = await geocodeAddress(a);
        if (!result) return err("Adresse nicht gefunden", 404);
        db.prepare("UPDATE anlagen SET breitengrad=?, laengengrad=?, geocoded_at=CURRENT_TIMESTAMP WHERE id=?")
          .run(result.lat, result.lng, id);
        return json({ success: true, ...result });
      }
      if (path === "/api/geocode/batch" && method === "POST") {
        const auth = requireUser(req); if ("response" in auth) return auth.response;
        if (!auth.user.is_admin && auth.user.username !== "admin") return err("Nur Admin", 403, { code: "ADMIN_ONLY" });
        const b = (await req.json().catch(() => ({}))) as any;
        const limit = Math.min(500, parseInt(b.limit || "50"));
        const { geocodeBatch } = await import("./lib/geocoder");
        const stats = await geocodeBatch(db, { limit });
        return json({ success: true, ...stats });
      }

      // ===== REPORTING =====
      if (path === "/api/reporting/kpis" && method === "GET") {
        const auth = requireUser(req); if ("response" in auth) return auth.response;
        const u = new URL(req.url);
        const days = Math.min(365, Math.max(1, parseInt(u.searchParams.get("days") || "30")));
        const userFilter = u.searchParams.get("user_id");
        const userWhere = userFilter ? "AND user_id = ?" : "";
        const args: any[] = userFilter ? [parseInt(userFilter)] : [];

        const today = (db.prepare(`
          SELECT
            (SELECT COUNT(*) FROM sent_emails WHERE date(sent_at)=date('now') ${userWhere}) as mails_today,
            (SELECT COUNT(*) FROM calls WHERE date(started_at)=date('now') ${userWhere}) as calls_today,
            (SELECT COUNT(*) FROM email_replies WHERE date(received_at)=date('now') ${userWhere}) as replies_today,
            (SELECT COUNT(*) FROM termine WHERE date(start_ts/1000,'unixepoch')=date('now') ${userWhere}) as termine_today
        `).get(...args, ...args, ...args, ...args) as any);

        const totals = (db.prepare(`
          SELECT
            (SELECT COUNT(*) FROM anlagen WHERE status='neu') as leads_neu,
            (SELECT COUNT(*) FROM anlagen WHERE status='kontaktiert') as leads_kontaktiert,
            (SELECT COUNT(*) FROM anlagen WHERE status='interessiert') as leads_interessiert,
            (SELECT COUNT(*) FROM anlagen WHERE status='geantwortet') as leads_geantwortet,
            (SELECT COUNT(*) FROM anlagen WHERE status='gewonnen') as leads_gewonnen,
            (SELECT COUNT(*) FROM anlagen WHERE status='nicht_interessiert') as leads_verloren,
            (SELECT COUNT(*) FROM anlagen) as anlagen_total,
            (SELECT COUNT(*) FROM campaigns WHERE status='active') as kampagnen_aktiv
        `).get() as any);

        // Pro Tag (letzte N Tage)
        const userJoin = userFilter ? "AND user_id = ?" : "";
        const daily = db.prepare(`
          SELECT date(sent_at) as day, COUNT(*) as count
          FROM sent_emails
          WHERE sent_at >= date('now', '-${days} days') ${userJoin}
          GROUP BY date(sent_at) ORDER BY day
        `).all(...(userFilter ? [parseInt(userFilter)] : []));

        const dailyCalls = db.prepare(`
          SELECT date(started_at) as day, COUNT(*) as count
          FROM calls
          WHERE started_at >= date('now', '-${days} days') ${userJoin}
          GROUP BY date(started_at) ORDER BY day
        `).all(...(userFilter ? [parseInt(userFilter)] : []));

        const dailyReplies = db.prepare(`
          SELECT date(received_at) as day, COUNT(*) as count
          FROM email_replies
          WHERE received_at >= date('now', '-${days} days') ${userJoin}
          GROUP BY date(received_at) ORDER BY day
        `).all(...(userFilter ? [parseInt(userFilter)] : []));

        // Pro User (alle aktive)
        const perUser = db.prepare(`
          SELECT u.id, u.username, u.display_name, u.color,
            (SELECT COUNT(*) FROM sent_emails WHERE user_id=u.id AND sent_at >= date('now', '-${days} days')) as mails,
            (SELECT COUNT(*) FROM calls WHERE user_id=u.id AND started_at >= date('now', '-${days} days')) as calls,
            (SELECT COUNT(*) FROM email_replies WHERE user_id=u.id AND received_at >= date('now', '-${days} days')) as replies,
            (SELECT COUNT(*) FROM anlagen WHERE owner_id=u.id) as owned_anlagen,
            (SELECT COUNT(*) FROM anlagen WHERE owner_id=u.id AND status='gewonnen') as won
          FROM users u WHERE u.active=1
          ORDER BY mails DESC
        `).all();

        // Conversion-Funnel
        const funnel = (db.prepare(`
          SELECT
            (SELECT COUNT(*) FROM anlagen) as gesamt,
            (SELECT COUNT(*) FROM anlagen WHERE status != 'neu') as kontaktiert,
            (SELECT COUNT(*) FROM email_events WHERE event_type='open') as opens,
            (SELECT COUNT(*) FROM email_events WHERE event_type='click') as clicks,
            (SELECT COUNT(*) FROM email_replies) as replies,
            (SELECT COUNT(*) FROM anlagen WHERE status='interessiert') as interessiert,
            (SELECT COUNT(*) FROM anlagen WHERE status='gewonnen') as gewonnen
        `).get() as any);

        // Top-10-Score
        const topScore = db.prepare(`
          SELECT a.id, a.name, a.mastr_nummer, a.ort, a.lead_score, a.status,
            o.username as owner_username
          FROM anlagen a
          LEFT JOIN users o ON a.owner_id = o.id
          WHERE a.lead_score > 0
          ORDER BY a.lead_score DESC LIMIT 10
        `).all();

        // Conversion-Funnel: Reihenfolge der Pipeline-Stages
        const stages = ["neu","kontaktiert","nicht_erreicht","terminiert","interessiert","abgeschlossen","gewonnen"];
        // Pro Stage: wieviele Anlagen sind aktuell DA oder WEITERGEZOGEN.
        // Definition: "in oder hinter stage" = aktueller Status >= dieser stage in Reihenfolge
        const stageRank: Record<string, number> = {};
        stages.forEach((s, i) => (stageRank[s] = i));
        // Fuer Conversion: zaehle alle Anlagen mit owner_id (= aktiv bearbeitet) und gruppiere nach hoechstem erreichtem stage
        const activeRows = db.prepare(`
          SELECT status, COUNT(*) as cnt
          FROM anlagen WHERE owner_id IS NOT NULL AND status IS NOT NULL
          GROUP BY status
        `).all() as any[];
        const byStatus: Record<string, number> = {};
        for (const r of activeRows) byStatus[r.status] = r.cnt;
        // Cumulative: jeder Stage zeigt "diese Stage UND alle folgenden" → echter Funnel
        const conversionFunnel = stages.map((s, i) => {
          // verloren/nicht_interessiert zaehlen nicht zum Funnel-Fortschritt, sind aber visualisiert
          let cumulative = 0;
          for (let j = i; j < stages.length; j++) cumulative += byStatus[stages[j]] || 0;
          const drop = (i > 0) ? Math.max(0, (stages.slice(i-1).reduce((acc,st)=>acc+(byStatus[st]||0),0)) - cumulative) : 0;
          return {
            status: s,
            label: s,
            count: byStatus[s] || 0,
            cumulative,
            conversion_pct: null as number | null,  // wird unten gefuellt
            drop_off: drop,
          };
        });
        // Conversion-% von Stage zu naechstem Stage
        for (let i = 1; i < conversionFunnel.length; i++) {
          const prev = conversionFunnel[i-1].cumulative;
          const here = conversionFunnel[i].cumulative;
          conversionFunnel[i].conversion_pct = prev > 0 ? Math.round((here / prev) * 1000) / 10 : null;
        }
        // Verlust-Status getrennt
        const lostStatus = {
          nicht_interessiert: byStatus.nicht_interessiert || 0,
          verloren: byStatus.verloren || 0,
        };

        return json({ today, totals, daily, dailyCalls, dailyReplies, perUser, funnel, topScore, days, conversion_funnel: conversionFunnel, lost_status: lostStatus });
      }

      // ===== LEAD-SCORE =====
      const rescoreMatch = path.match(/^\/api\/anlagen\/(\d+)\/rescore$/);
      if (rescoreMatch && method === "POST") {
        const auth = requireUser(req); if ("response" in auth) return auth.response;
        const id = parseInt(rescoreMatch[1]);
        const { rescoreAnlage } = await import("./lib/lead-score");
        const score = rescoreAnlage(db, id);
        return json({ success: true, score });
      }
      if (path === "/api/lead-score/rescore-all" && method === "POST") {
        const auth = requireUser(req); if ("response" in auth) return auth.response;
        const { rescoreAll } = await import("./lib/lead-score");
        const r = rescoreAll(db);
        return json({ success: true, ...r });
      }

      // ===== ANLAGEN =====
      // GET /api/anlagen/nearby?lat=…&lng=…&limit=20&exclude_id=… — die N naechsten Anlagen
      // Performance: Bounding-Box-Pre-Filter (~50km), dann Haversine pro Kandidat, dann sortieren.
      if (path === "/api/anlagen/nearby" && method === "GET") {
        const auth = requireUser(req); if ("response" in auth) return auth.response;
        const u = new URL(req.url);
        const lat = parseFloat(u.searchParams.get("lat") || "");
        const lng = parseFloat(u.searchParams.get("lng") || "");
        if (isNaN(lat) || isNaN(lng)) return err("lat + lng erforderlich", 400, { code: "MISSING_COORDS" });
        const limit = Math.min(50, Math.max(1, parseInt(u.searchParams.get("limit") || "20")));
        const excludeId = parseInt(u.searchParams.get("exclude_id") || "0");
        const radiusKm = Math.min(200, Math.max(5, parseInt(u.searchParams.get("radius_km") || "100")));
        // Filter-Params
        const leistungMin = parseFloat(u.searchParams.get("leistung_min") || "");  // in kWp
        const leistungMax = parseFloat(u.searchParams.get("leistung_max") || "");  // in kWp
        const baujahrMin = parseInt(u.searchParams.get("baujahr_min") || "");
        const baujahrMax = parseInt(u.searchParams.get("baujahr_max") || "");
        const onlyContact = u.searchParams.get("only_contact") !== "0";  // Default: nur mit Kontakt
        // Bounding-Box (grob): 1° lat = ~111km, 1° lng = ~111km * cos(lat)
        const latDelta = radiusKm / 111;
        const lngDelta = radiusKm / (111 * Math.cos(lat * Math.PI / 180));
        const where: string[] = [
          "a.breitengrad BETWEEN ? AND ?",
          "a.laengengrad BETWEEN ? AND ?",
          "a.id != ?",
        ];
        const params: any[] = [lat - latDelta, lat + latDelta, lng - lngDelta, lng + lngDelta, excludeId];
        if (!isNaN(leistungMin)) { where.push("a.nettonennleistung >= ?"); params.push(leistungMin); }
        if (!isNaN(leistungMax)) { where.push("a.nettonennleistung <= ?"); params.push(leistungMax); }
        if (!isNaN(baujahrMin)) { where.push("CAST(substr(a.inbetriebnahme,1,4) AS INTEGER) >= ?"); params.push(baujahrMin); }
        if (!isNaN(baujahrMax)) { where.push("CAST(substr(a.inbetriebnahme,1,4) AS INTEGER) <= ?"); params.push(baujahrMax); }
        if (onlyContact) {
          where.push(`(
            (a.kontakt_email IS NOT NULL AND a.kontakt_email != '') OR
            (a.kontakt_telefon IS NOT NULL AND a.kontakt_telefon != '') OR
            EXISTS (SELECT 1 FROM betreiber b2 WHERE b2.mastr_nummer = a.betreiber_mastr AND ((b2.email IS NOT NULL AND b2.email != '') OR (b2.telefon IS NOT NULL AND b2.telefon != '')))
          )`);
        }
        const candidates = db.prepare(`
          SELECT a.id, a.mastr_nummer, a.name, a.ort, a.bundesland, a.plz, a.strasse,
            a.nettonennleistung, a.inbetriebnahme, a.status, a.lead_score, a.kontakt_email, a.kontakt_telefon,
            a.betreiber_name, a.breitengrad as lat, a.laengengrad as lng,
            a.geocode_precision, a.owner_id,
            o.username as owner_username, o.display_name as owner_display_name, o.color as owner_color
          FROM anlagen a
          LEFT JOIN users o ON a.owner_id = o.id
          WHERE ${where.join(" AND ")}
          LIMIT 3000
        `).all(...params) as any[];
        // Haversine
        const toRad = (deg: number) => deg * Math.PI / 180;
        const R = 6371;
        const withDist = candidates.map(c => {
          const dLat = toRad(c.lat - lat);
          const dLng = toRad(c.lng - lng);
          const h = Math.sin(dLat/2)**2 + Math.cos(toRad(lat)) * Math.cos(toRad(c.lat)) * Math.sin(dLng/2)**2;
          const distKm = 2 * R * Math.asin(Math.sqrt(h));
          return { ...c, distance_km: Math.round(distKm * 10) / 10 };
        }).sort((a, b) => a.distance_km - b.distance_km).slice(0, limit);
        return json({ origin: { lat, lng }, count: withDist.length, anlagen: withDist });
      }

      // ===== BULK-UPDATE Anlagen =====
      // PATCH /api/anlagen/bulk  { ids: number[], changes: { status?, owner_id? } }
      // Limit: 100 ids. Erlaubte Felder: status, owner_id (bewusst eng — alles weitere ist single-row).
      if (path === "/api/anlagen/bulk" && method === "PATCH") {
        const auth = requireUser(req); if ("response" in auth) return auth.response;
        const b = (await req.json()) as any;
        const ids = Array.isArray(b.ids) ? b.ids.map((x: any) => parseInt(x, 10)).filter((n: number) => !isNaN(n)) : [];
        if (ids.length === 0) return err("ids erforderlich (Array von Anlagen-IDs)");
        if (ids.length > 100) return err("Maximal 100 IDs pro Bulk-Aufruf", 413);
        const changes = b.changes && typeof b.changes === "object" ? b.changes : {};
        const setParts: string[] = []; const setVals: any[] = [];
        const changedDesc: string[] = [];
        if (typeof changes.status === "string") { setParts.push("status = ?"); setVals.push(changes.status); changedDesc.push(`status=${changes.status}`); }
        let newOwnerId: number | null | undefined = undefined;
        if (changes.owner_id !== undefined) {
          newOwnerId = changes.owner_id === null ? null : parseInt(changes.owner_id, 10);
          if (newOwnerId !== null && isNaN(newOwnerId)) return err("owner_id muss number oder null sein");
          setParts.push("owner_id = ?"); setVals.push(newOwnerId);
          changedDesc.push(`owner_id=${newOwnerId === null ? "null" : newOwnerId}`);
        }
        if (setParts.length === 0) return err("Keine erlaubten Aenderungen (status oder owner_id)");
        setParts.push("updated_at = CURRENT_TIMESTAMP");
        const placeholders = ids.map(() => "?").join(",");
        const stmt = db.prepare(`UPDATE anlagen SET ${setParts.join(", ")} WHERE id IN (${placeholders})`);
        // Vor-Snapshot für Owner-Change-Webhooks
        let preOwners: Map<number, number | null> = new Map();
        if (newOwnerId !== undefined) {
          const rows = db.prepare(`SELECT id, owner_id FROM anlagen WHERE id IN (${placeholders})`).all(...ids) as any[];
          preOwners = new Map(rows.map(r => [r.id, r.owner_id]));
        }
        const r = stmt.run(...setVals, ...ids);
        // Activity-Log pro betroffene Anlage
        for (const id of ids) {
          logActivity(db, id, auth.user.id, "stammdaten_edit", `Bulk: ${changedDesc.join(", ")}`, { bulk: true, fields: Object.keys(changes) }, tid(auth.user));
          if (newOwnerId !== undefined) {
            const old = preOwners.get(id);
            if (old !== newOwnerId) {
              try { fireEvent(db, "anlage.owner_changed", {
                anlage_id: id,
                old_owner_id: old ?? null,
                new_owner_id: newOwnerId,
                new_owner_name: null,
                changed_by: { id: auth.user.id, username: auth.user.username },
                bulk: true,
              }); } catch (e) { console.error("webhook fireEvent:", e); }
            }
          }
        }
        logAudit(db, auth.user.id, auth.user.username, "anlagen_bulk_update", "anlagen", null, `count=${ids.length} ${changedDesc.join(" ")}`);
        return json({ updated: Number(r.changes || 0), requested: ids.length, changes: changedDesc });
      }
      // PATCH /api/kunden/bulk  { mastr_nummern: string[], changes: { status_for_anlagen?, owner_id_for_anlagen? } }
      // Wirkt auf ALLE Anlagen des jeweiligen Betreibers (mastr_nummer = betreiber-Identifikation).
      if (path === "/api/kunden/bulk" && method === "PATCH") {
        const auth = requireUser(req); if ("response" in auth) return auth.response;
        const b = (await req.json()) as any;
        const mastrs = Array.isArray(b.mastr_nummern) ? b.mastr_nummern.map((s: any) => String(s).trim()).filter((s: string) => s.length > 0) : [];
        if (mastrs.length === 0) return err("mastr_nummern erforderlich (Array)");
        if (mastrs.length > 100) return err("Maximal 100 mastr_nummern pro Bulk-Aufruf", 413);
        const changes = b.changes && typeof b.changes === "object" ? b.changes : {};
        const setParts: string[] = []; const setVals: any[] = []; const changedDesc: string[] = [];
        if (typeof changes.status_for_anlagen === "string") { setParts.push("status = ?"); setVals.push(changes.status_for_anlagen); changedDesc.push(`status=${changes.status_for_anlagen}`); }
        if (changes.owner_id_for_anlagen !== undefined) {
          const oid = changes.owner_id_for_anlagen === null ? null : parseInt(changes.owner_id_for_anlagen, 10);
          if (oid !== null && isNaN(oid)) return err("owner_id_for_anlagen muss number oder null sein");
          setParts.push("owner_id = ?"); setVals.push(oid);
          changedDesc.push(`owner_id=${oid === null ? "null" : oid}`);
        }
        if (setParts.length === 0) return err("Keine erlaubten Aenderungen");
        setParts.push("updated_at = CURRENT_TIMESTAMP");
        const placeholders = mastrs.map(() => "?").join(",");
        const r = db.prepare(`UPDATE anlagen SET ${setParts.join(", ")} WHERE betreiber_mastr IN (${placeholders})`).run(...setVals, ...mastrs);
        logAudit(db, auth.user.id, auth.user.username, "kunden_bulk_update", "kunden", null, `count_kunden=${mastrs.length} affected_anlagen=${r.changes} ${changedDesc.join(" ")}`);
        return json({ updated_anlagen: Number(r.changes || 0), requested_kunden: mastrs.length, changes: changedDesc });
      }

      if (path === "/api/anlagen" && method === "GET") {
        const auth = requireUser(req); if ("response" in auth) return auth.response;
        const search = url.searchParams.get("search") || "";
        const bundesland = url.searchParams.get("bundesland") || "";
        const status = url.searchParams.get("status") || "";
        const mit_kontakt = url.searchParams.get("mit_kontakt") || "";
        const leistung_min = url.searchParams.get("leistung_min") || "";
        const leistung_max = url.searchParams.get("leistung_max") || "";
        const datum_von = url.searchParams.get("datum_von") || "";
        const datum_bis = url.searchParams.get("datum_bis") || "";
        const owner = url.searchParams.get("owner") || ""; // "me" | "<id>" | "unassigned" | ""
        const sortBy = ["nettonennleistung", "inbetriebnahme", "name", "ort", "bundesland", "lead_score"].includes(url.searchParams.get("sortBy") || "")
          ? url.searchParams.get("sortBy")! : "nettonennleistung";
        const sortDir = (url.searchParams.get("sortDir") || "desc").toLowerCase() === "asc" ? "ASC" : "DESC";
        const page = Math.max(1, parseInt(url.searchParams.get("page") || "1"));
        const limit = Math.min(200, Math.max(1, parseInt(url.searchParams.get("limit") || "50")));
        const offset = (page - 1) * limit;
        // P2-24: Cursor-Pagination — alternative zu page+limit, stabil bei wachsenden Listen.
        const after = url.searchParams.get("after");
        const useCursor = after !== null && /^\d+$/.test(after);

        const where: string[] = [];
        const params: any[] = [];
        if (useCursor) {
          where.push("a.id > ?");
          params.push(parseInt(after!));
        }
        if (search) {
          where.push(`(a.name LIKE ? OR a.betreiber_name LIKE ? OR a.ort LIKE ? OR a.plz LIKE ? OR b.email LIKE ? OR b.telefon LIKE ?)`);
          const p = `%${search}%`; for (let i = 0; i < 6; i++) params.push(p);
        }
        if (bundesland) { where.push("a.bundesland = ?"); params.push(bundesland); }
        if (status) { where.push("a.status = ?"); params.push(status); }
        if (mit_kontakt === "ja") where.push("(b.email IS NOT NULL OR b.telefon IS NOT NULL)");
        if (mit_kontakt === "nein") where.push("(b.email IS NULL AND b.telefon IS NULL)");
        if (leistung_min) { where.push("a.nettonennleistung >= ?"); params.push(parseFloat(leistung_min)); }
        if (leistung_max) { where.push("a.nettonennleistung <= ?"); params.push(parseFloat(leistung_max)); }
        if (datum_von) { where.push("a.inbetriebnahme >= ?"); params.push(datum_von); }
        if (datum_bis) { where.push("a.inbetriebnahme <= ?"); params.push(datum_bis); }
        if (owner) {
          if (owner === "me") {
            const u = getUser(req);
            if (u) { where.push("a.owner_id = ?"); params.push(u.id); }
          } else if (owner === "unassigned") {
            where.push("a.owner_id IS NULL");
          } else {
            where.push("a.owner_id = ?");
            params.push(parseInt(owner));
          }
        }
        // API-Client darf nur bereits bearbeitete Anlagen sehen (owner_id NOT NULL).
        // Verhindert dass Fremdsysteme den kompletten MaStR-Stamm abziehen.
        if (isApiClient(auth.user)) {
          where.push("a.owner_id IS NOT NULL");
        }
        // Viewer-Rolle: alle bearbeiteten Anlagen (Owner, Status, Calls, Mails oder Notizen)
        if (isViewer(auth.user)) {
          where.push(VIEWER_VISIBLE_SQL);
        }
        const wc = where.length ? `WHERE ${where.join(" AND ")}` : "";

        const total = (db.prepare(`SELECT COUNT(*) as t FROM anlagen a LEFT JOIN betreiber b ON a.betreiber_mastr = b.mastr_nummer ${wc}`).get(...params) as any).t;
        const orderClause = useCursor ? "ORDER BY a.id ASC" : `ORDER BY a.${sortBy} ${sortDir}`;
        const limitClause = useCursor ? "LIMIT ?" : "LIMIT ? OFFSET ?";
        const limitParams = useCursor ? [limit] : [limit, offset];
        const data = db.prepare(`
          SELECT a.*,
            b.email as kontakt_email, b.telefon as kontakt_telefon, b.website as kontakt_website,
            b.strasse as kontakt_strasse, b.plz as kontakt_plz, b.ort as kontakt_ort,
            o.username as owner_username, o.display_name as owner_display_name, o.color as owner_color,
            (SELECT t.start_ts FROM termine t WHERE t.anlage_id = a.id ORDER BY t.start_ts DESC LIMIT 1) as latest_termin_start,
            (SELECT t.end_ts   FROM termine t WHERE t.anlage_id = a.id ORDER BY t.start_ts DESC LIMIT 1) as latest_termin_end,
            (SELECT t.title    FROM termine t WHERE t.anlage_id = a.id ORDER BY t.start_ts DESC LIMIT 1) as latest_termin_title
          FROM anlagen a
          LEFT JOIN betreiber b ON a.betreiber_mastr = b.mastr_nummer
          LEFT JOIN users o ON a.owner_id = o.id
          ${wc}
          ${orderClause}
          ${limitClause}
        `).all(...params, ...limitParams) as any[];
        const nextCursor = useCursor && data.length > 0 ? data[data.length - 1].id : null;
        // P1-8 additive: ?lang=en haengt englische Feldnamen an
        const useEn = url.searchParams.get("lang") === "en";
        const finalData = useEn ? mapEnglish(data, "anlage") : data;
        return json({
          data: finalData,
          pagination: useCursor
            ? { mode: "cursor", limit, returned: data.length, next_cursor: nextCursor, has_more: data.length === limit }
            : { mode: "offset", page, limit, total, pages: Math.ceil(total / limit) },
        });
      }

      const anlageIdMatch = path.match(/^\/api\/anlagen\/(\d+)$/);
      if (anlageIdMatch && method === "GET") {
        const auth = requireUser(req); if ("response" in auth) return auth.response;
        const id = parseInt(anlageIdMatch[1]);
        const a = db.prepare(`
          SELECT a.*,
            b.email as kontakt_email, b.telefon as kontakt_telefon, b.fax as kontakt_fax, b.website as kontakt_website,
            b.strasse as kontakt_strasse, b.plz as kontakt_plz, b.ort as kontakt_ort,
            o.username as owner_username, o.display_name as owner_display_name, o.color as owner_color
          FROM anlagen a
          LEFT JOIN betreiber b ON a.betreiber_mastr = b.mastr_nummer
          LEFT JOIN users o ON a.owner_id = o.id
          WHERE a.id = ?
        `).get(id) as any;
        if (!a) return err("Nicht gefunden", 404, { code: "NOT_FOUND" });
        // API-Client darf nicht-bearbeitete Anlagen nicht einsehen.
        if (isApiClient(auth.user) && !a.owner_id) return err("Nicht gefunden", 404, { code: "NOT_FOUND" });
        // Viewer darf nur Anlagen einsehen die bereits telefoniert wurden.
        if (isViewer(auth.user) && !anlageVisibleToViewer(db, id, auth.user)) {
          return err("Nicht gefunden", 404, { code: "NOT_FOUND" });
        }
        // Unified Notizen-Feed: anlage-spezifische + alle Notizen des zugehoerigen Kunden
        const notizen = db.prepare(`
          SELECT n.*, u.username as user_username, u.display_name as user_display_name, u.color as user_color
          FROM notizen n LEFT JOIN users u ON n.user_id = u.id
          WHERE n.anlage_id = ?
             OR (n.betreiber_mastr IS NOT NULL AND n.betreiber_mastr = ?)
          ORDER BY n.created_at DESC
        `).all(id, a.betreiber_mastr || "");

        // Weitere Anlagen desselben Kunden (ohne diese selbst)
        const related_anlagen = a.betreiber_mastr ? db.prepare(`
          SELECT id, mastr_nummer, name, plz, ort, bundesland, nettonennleistung, status, inbetriebnahme
          FROM anlagen
          WHERE betreiber_mastr = ? AND id != ?
          ORDER BY nettonennleistung DESC
          LIMIT 50
        `).all(a.betreiber_mastr, id) : [];

        // Offene Wiedervorlagen fuer den Kunden
        const reminders = a.betreiber_mastr ? db.prepare(`
          SELECT r.*, ou.username as owner_username, ou.display_name as owner_display_name, ou.color as owner_color
          FROM reminders r LEFT JOIN users ou ON r.owner_user_id = ou.id
          WHERE r.betreiber_mastr = ? AND r.status = 'pending'
          ORDER BY r.due_at ASC
        `).all(a.betreiber_mastr) : [];
        const sent = db.prepare(`
          SELECT s.*, u.username as user_username
          FROM sent_emails s LEFT JOIN users u ON s.user_id = u.id
          WHERE s.anlage_id = ? ORDER BY s.sent_at DESC LIMIT 50
        `).all(id);
        const calls = db.prepare(`
          SELECT c.*, u.username as user_username, u.display_name as user_display_name, u.color as user_color
          FROM calls c LEFT JOIN users u ON c.user_id = u.id
          WHERE c.anlage_id = ? ORDER BY c.started_at DESC LIMIT 50
        `).all(id);
        const termine = db.prepare(`
          SELECT t.*, u.username as user_username, u.color as user_color
          FROM termine t LEFT JOIN users u ON t.user_id = u.id
          WHERE t.anlage_id = ? ORDER BY t.start_ts DESC LIMIT 50
        `).all(id);
        const activities = db.prepare(`
          SELECT a.*, u.username as user_username, u.display_name as user_display_name, u.color as user_color
          FROM activities a LEFT JOIN users u ON a.user_id = u.id
          WHERE a.anlage_id = ? ORDER BY a.created_at DESC LIMIT 100
        `).all(id);
        const messages = db.prepare(`
          SELECT m.*, u.username as user_username, u.display_name as user_display_name, u.color as user_color
          FROM messages m LEFT JOIN users u ON m.from_user_id = u.id
          WHERE m.anlage_id = ? AND m.type = 'comment' ORDER BY m.created_at ASC
        `).all(id);
        const appCfg = getAppSettings(db);
        const moduleWpOverride = parseInt(url.searchParams.get("module_wp") || "0");
        if (moduleWpOverride >= 400 && moduleWpOverride <= 900) {
          (appCfg as any).repowering_module_wp = moduleWpOverride;
        }
        const economics = computeEconomics(a, appCfg);
        return json({ ...a, notizen_liste: notizen, sent_emails: sent, termine, activities, messages, calls, related_anlagen, reminders, economics });
      }
      if (anlageIdMatch && method === "PUT") {
        const auth = requireUser(req); if ("response" in auth) return auth.response;
        const id = parseInt(anlageIdMatch[1]);
        const b = (await req.json()) as any;
        const before = db.prepare("SELECT status, owner_id FROM anlagen WHERE id = ?").get(id) as any;
        if (!before) return err("Anlage nicht gefunden", 404);
        // P0-1 + Owner-Schutz: API-Client darf nicht via PUT existenz-leakieren auf ownerlose Anlagen
        if (isApiClient(auth.user) && !before.owner_id) return err("Anlage nicht gefunden", 404);

        // Whitelist editable fields fuer Anlagen-Stammdaten
        // WICHTIG: jedes Feld in dieser Liste, das vom User geaendert wird, kommt in
        // anlagen.edited_fields (JSON array) — der Daily-Import (lib/mastr-importer.ts)
        // ueberschreibt diese Felder dann NICHT mehr.
        const editable = [
          "name", "betreiber_name",
          "strasse", "hausnummer", "plz", "ort", "bundesland", "landkreis", "gemeinde",
          "breitengrad", "laengengrad",
          "bruttoleistung", "nettonennleistung", "anzahl_module",
          "inbetriebnahme", "energietraeger", "anlagentyp",
          "lage_einheit", "hauptausrichtung", "hauptausrichtung_neigungswinkel",
          "modulhersteller", "wechselrichterhersteller", "wechselrichter_anzahl",
        ];
        const fields: string[] = [];
        const vals: any[] = [];
        const touchedFields: string[] = [];
        for (const k of editable) {
          if (b[k] !== undefined) {
            fields.push(`${k} = ?`);
            vals.push(b[k] === "" ? null : b[k]);
            touchedFields.push(k);
          }
        }
        if (fields.length > 0) {
          // edited_fields atomar mergen: vorhandene + neu beruehrte, dedupliziert
          // Trick: json_group_array + DISTINCT auf UNION ALL aus alter Liste + neuen Eintraegen
          const newFieldsJsonArray = JSON.stringify(touchedFields);
          fields.push(`edited_fields = (
            SELECT json_group_array(DISTINCT value) FROM (
              SELECT value FROM json_each(COALESCE(edited_fields, '[]'))
              UNION ALL
              SELECT value FROM json_each(?)
            )
          )`);
          vals.push(newFieldsJsonArray);
          fields.push("updated_at = CURRENT_TIMESTAMP");
          vals.push(id);
          db.prepare(`UPDATE anlagen SET ${fields.join(", ")} WHERE id = ?`).run(...vals);
          logActivity(db, id, auth.user.id, "stammdaten_edit",
            `Anlagen-Stammdaten geändert: ${touchedFields.join(", ")}`,
            { fields: touchedFields }, tid(auth.user));
        }

        if (b.status !== undefined) {
          db.prepare("UPDATE anlagen SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(b.status, id);
          if (before && before.status !== b.status) {
            logActivity(db, id, auth.user.id, "status_change", `Status: ${before.status || "—"} → ${b.status}`, { from: before.status, to: b.status }, tid(auth.user));
          }
          autoAssignOwner(db, id, auth.user.id);
        }
        if (b.notizen !== undefined) {
          db.prepare("UPDATE anlagen SET notizen = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(b.notizen, id);
        }

        // Owner explizit aendern — NUR aktueller Owner oder Admin darf das.
        // Wenn die Anlage noch keinen Owner hat, darf jeder User sie beanspruchen.
        if (b.owner_id !== undefined) {
          const newOwnerId = b.owner_id ? parseInt(b.owner_id) : null;
          const currentOwnerId = before?.owner_id || null;
          const isAdmin = auth.user.is_admin === 1 || auth.user.username === "admin";
          const isOwner = currentOwnerId === auth.user.id;
          if (currentOwnerId !== null && !isOwner && !isAdmin) {
            return err("Nur der aktuelle Eigentuemer oder ein Admin darf den Eigentuemer aendern.", 403);
          }
          db.prepare("UPDATE anlagen SET owner_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(newOwnerId, id);
          if (currentOwnerId !== newOwnerId) {
            const newOwner = newOwnerId ? db.prepare("SELECT username, display_name FROM users WHERE id = ?").get(newOwnerId) as any : null;
            const newOwnerName = newOwner ? (newOwner.display_name || newOwner.username) : "Niemand";
            logActivity(db, id, auth.user.id, "owner_change", `Zuweisung: → ${newOwnerName}`, { to: newOwnerId }, tid(auth.user));
            try { fireEvent(db, "anlage.owner_changed", {
              anlage_id: id,
              old_owner_id: currentOwnerId,
              new_owner_id: newOwnerId,
              new_owner_name: newOwnerName,
              changed_by: { id: auth.user.id, username: auth.user.username },
            }); } catch (e) { console.error("webhook fireEvent:", e); }

            // Notification an neuen Owner (nicht an sich selbst)
            if (newOwnerId && newOwnerId !== auth.user.id) {
              const anlage = db.prepare("SELECT name, mastr_nummer, ort FROM anlagen WHERE id = ?").get(id) as any;
              const anlageLabel = anlage?.name || anlage?.mastr_nummer || `#${id}`;
              await notify(db, {
                userId: newOwnerId,
                type: "assignment",
                titleKey: "notif.assignment_title",
                titleArgs: { anlage: anlageLabel },
                bodyKey: "notif.assignment_body",
                bodyArgs: {
                  from: auth.user.display_name || auth.user.username,
                  anlage: anlageLabel,
                  ort_suffix: anlage?.ort ? ` (${anlage.ort})` : "",
                },
                anlageId: id,
                fromUserId: auth.user.id,
                fromUserName: auth.user.display_name || auth.user.username,
              });
            }
          }
        }
        return json({ success: true });
      }

      const notizMatch = path.match(/^\/api\/anlagen\/(\d+)\/notizen$/);
      if (notizMatch && method === "POST") {
        const auth = requireUser(req); if ("response" in auth) return auth.response;
        const id = parseInt(notizMatch[1]);
        const b = (await req.json()) as any;
        if (!b.text || !b.text.trim()) return err("Text leer");

        // Scope: 'betreiber' (default - sichtbar bei allen Anlagen des Kunden) oder 'anlage' (nur hier)
        const scope = b.scope === "anlage" ? "anlage" : "betreiber";
        const anlage = db.prepare("SELECT betreiber_mastr FROM anlagen WHERE id = ?").get(id) as any;
        const betreiberMastr = scope === "betreiber" ? (anlage?.betreiber_mastr || null) : null;

        const r = db.prepare(`
          INSERT INTO notizen (anlage_id, betreiber_mastr, scope, text, user_id)
          VALUES (?, ?, ?, ?, ?)
        `).run(id, betreiberMastr, scope, b.text, auth.user.id);
        autoAssignOwner(db, id, auth.user.id);
        logActivity(db, id, auth.user.id, "note_added", b.text.substring(0, 100), undefined, tid(auth.user));

        // @mentions in der Notiz benachrichtigen
        const mentions = parseMentions(db, b.text);
        if (mentions.length > 0) {
          const anlageInfo = db.prepare("SELECT name, mastr_nummer FROM anlagen WHERE id = ?").get(id) as any;
          const anlageLabel = anlageInfo?.name || anlageInfo?.mastr_nummer || `#${id}`;
          const senderName = auth.user.display_name || auth.user.username;
          for (const m of mentions) {
            if (m.user_id === auth.user.id) continue;
            await notify(db, {
              userId: m.user_id,
              type: "mention",
              titleKey: "notif.mention_note_title",
              titleArgs: { from: senderName, anlage: anlageLabel },
              body: b.text,
              anlageId: id,
              fromUserId: auth.user.id,
              fromUserName: senderName,
            });
          }
        }
        return json({ success: true, id: r.lastInsertRowid, scope });
      }

      // Notiz direkt am Kunden anlegen (ohne Anlage-Kontext)
      const kundeNotizMatch = path.match(/^\/api\/kunden\/([A-Za-z0-9]+)\/notizen$/);
      if (kundeNotizMatch && method === "POST") {
        const auth = requireUser(req); if ("response" in auth) return auth.response;
        const mastr = kundeNotizMatch[1];
        const b = (await req.json()) as any;
        if (!b.text || !b.text.trim()) return err("Text leer");
        const r = db.prepare(`
          INSERT INTO notizen (anlage_id, betreiber_mastr, scope, text, user_id)
          VALUES (NULL, ?, 'betreiber', ?, ?)
        `).run(mastr, b.text, auth.user.id);

        // Erste Aktion im Kundenmenue = Eigentuemer aller noch nicht beanspruchten Anlagen dieses Betreibers.
        autoAssignOwnerForBetreiber(db, mastr, auth.user.id);

        // @mentions in der Kunden-Notiz benachrichtigen
        const mentions = parseMentions(db, b.text);
        if (mentions.length > 0) {
          const betreiberInfo = db.prepare("SELECT name FROM betreiber WHERE mastr_nummer = ?").get(mastr) as any;
          const kundeLabel = betreiberInfo?.name || mastr;
          const senderName = auth.user.display_name || auth.user.username;
          for (const m of mentions) {
            if (m.user_id === auth.user.id) continue;
            await notify(db, {
              userId: m.user_id,
              type: "mention",
              titleKey: "notif.mention_kunden_note_title",
              titleArgs: { from: senderName, kunde: kundeLabel },
              body: b.text,
              fromUserId: auth.user.id,
              fromUserName: senderName,
              url: `/?#kunde-${mastr}`,
            });
          }
        }
        return json({ success: true, id: r.lastInsertRowid });
      }

      const notizDelMatch = path.match(/^\/api\/notizen\/(\d+)$/);
      if (notizDelMatch && method === "DELETE") {
        const auth = requireUser(req); if ("response" in auth) return auth.response;
        db.prepare("DELETE FROM notizen WHERE id = ?").run(parseInt(notizDelMatch[1]));
        return json({ success: true });
      }

      // ===== REMINDERS / WIEDERVORLAGEN =====
      if (path === "/api/reminders" && method === "GET") {
        const auth = requireUser(req); if ("response" in auth) return auth.response;
        const status = url.searchParams.get("status") || "pending";
        const betreiber = url.searchParams.get("betreiber_mastr") || undefined;
        const limit = parseInt(url.searchParams.get("limit") || "200");
        // Viewer: nur Reminder zu Betreibern mit mind. einer telefonierten Anlage.
        const viewerFilter = isViewer(auth.user)
          ? "AND EXISTS (SELECT 1 FROM anlagen a JOIN calls c ON c.anlage_id = a.id WHERE a.betreiber_mastr = r.betreiber_mastr)"
          : "";
        const rows = db.prepare(`
          SELECT r.*,
            b.name as betreiber_name,
            ou.username as owner_username, ou.display_name as owner_display_name, ou.color as owner_color,
            cu.username as created_by_username
          FROM reminders r
          LEFT JOIN betreiber b ON b.mastr_nummer = r.betreiber_mastr
          LEFT JOIN users ou ON r.owner_user_id = ou.id
          LEFT JOIN users cu ON r.created_by = cu.id
          WHERE (? = 'all' OR r.status = ?)
            AND (? IS NULL OR r.betreiber_mastr = ?)
            ${viewerFilter}
          ORDER BY r.due_at ASC
          LIMIT ?
        `).all(status, status, betreiber || null, betreiber || null, limit);
        return json(rows);
      }
      if (path === "/api/reminders/today" && method === "GET") {
        const auth = requireUser(req); if ("response" in auth) return auth.response;
        const endOfDay = new Date();
        endOfDay.setHours(23, 59, 59, 999);
        const rows = db.prepare(`
          SELECT r.*,
            b.name as betreiber_name,
            ou.username as owner_username, ou.display_name as owner_display_name, ou.color as owner_color
          FROM reminders r
          LEFT JOIN betreiber b ON b.mastr_nummer = r.betreiber_mastr
          LEFT JOIN users ou ON r.owner_user_id = ou.id
          WHERE r.status = 'pending' AND r.due_at <= ?
          ORDER BY r.due_at ASC
          LIMIT 200
        `).all(endOfDay.toISOString());
        return json(rows);
      }
      if (path === "/api/reminders" && method === "POST") {
        const auth = requireUser(req); if ("response" in auth) return auth.response;
        const b = (await req.json()) as any;
        if (!b.betreiber_mastr) return err("betreiber_mastr fehlt");
        if (!b.due_at) return err("due_at fehlt");
        try {
          const r = createReminder(db, {
            betreiber_mastr: b.betreiber_mastr,
            due_at: b.due_at,
            note: b.note || null,
            owner_user_id: b.owner_user_id ? parseInt(b.owner_user_id) : auth.user.id,
            created_by: auth.user.id,
          });
          // Erste Aktion im Kundenmenue = Eigentuemer aller noch nicht beanspruchten Anlagen dieses Betreibers.
          autoAssignOwnerForBetreiber(db, b.betreiber_mastr, auth.user.id);
          return json(r);
        } catch (e: any) {
          return err(e?.message || "Reminder anlegen fehlgeschlagen", 400);
        }
      }
      const reminderIdMatch = path.match(/^\/api\/reminders\/(\d+)$/);
      if (reminderIdMatch && method === "PATCH") {
        const auth = requireUser(req); if ("response" in auth) return auth.response;
        const id = parseInt(reminderIdMatch[1]);
        const b = (await req.json()) as any;
        try {
          if (b.action === "done") {
            const r = reminderDone(db, id, auth.user.id);
            return json(r);
          }
          if (b.action === "snooze" && b.until) {
            const r = reminderSnooze(db, id, b.until);
            return json(r);
          }
          const r = updateReminder(db, id, {
            due_at: b.due_at,
            note: b.note,
            owner_user_id: b.owner_user_id !== undefined ? (b.owner_user_id ? parseInt(b.owner_user_id) : null) : undefined,
          });
          if (!r) return err("Nicht gefunden", 404, { code: "NOT_FOUND" });
          return json(r);
        } catch (e: any) {
          return err(e?.message || "Reminder-Update fehlgeschlagen", 400);
        }
      }
      if (reminderIdMatch && method === "DELETE") {
        const auth = requireUser(req); if ("response" in auth) return auth.response;
        deleteReminder(db, parseInt(reminderIdMatch[1]));
        return json({ success: true });
      }

      // ===== KUNDEN (gruppiert nach betreiber_mastr) =====
      if (path === "/api/kunden" && method === "GET") {
        const auth = requireUser(req); if ("response" in auth) return auth.response;
        const q = (url.searchParams.get("q") || "").trim().toLowerCase();
        const limit = Math.min(2000, Math.max(1, parseInt(url.searchParams.get("limit") || "500")));
        // API-Client darf nur Kunden mit mindestens einer bearbeiteten Anlage sehen.
        const apiFilter = isApiClient(auth.user) ? "AND EXISTS (SELECT 1 FROM anlagen a2 WHERE a2.betreiber_mastr = a.betreiber_mastr AND a2.owner_id IS NOT NULL)" : "";
        // Viewer: nur Kunden mit mindestens einer bearbeiteten Anlage (Owner, Status, Calls, Mails oder Notizen)
        const viewerFilter = isViewer(auth.user) ? `AND EXISTS (
          SELECT 1 FROM anlagen a3 WHERE a3.betreiber_mastr = a.betreiber_mastr
            AND (
              a3.owner_id IS NOT NULL
              OR (a3.status IS NOT NULL AND a3.status != 'neu')
              OR EXISTS (SELECT 1 FROM calls c WHERE c.anlage_id = a3.id)
              OR EXISTS (SELECT 1 FROM sent_emails s WHERE s.anlage_id = a3.id)
              OR EXISTS (SELECT 1 FROM notizen n WHERE n.anlage_id = a3.id)
            )
        )` : "";
        // Owner-Filter: "me" | "unassigned" | "<id>". Wirkt: Kunde hat MIN. EINE Anlage mit owner_id = ?
        const ownerParam = url.searchParams.get("owner") || "";
        let ownerFilter = "";
        const ownerArgs: any[] = [];
        if (ownerParam === "me") {
          ownerFilter = "AND EXISTS (SELECT 1 FROM anlagen ao WHERE ao.betreiber_mastr = a.betreiber_mastr AND ao.owner_id = ?)";
          ownerArgs.push(auth.user.id);
        } else if (ownerParam === "unassigned") {
          // Kunde wo KEINE Anlage einen Owner hat
          ownerFilter = "AND NOT EXISTS (SELECT 1 FROM anlagen ao WHERE ao.betreiber_mastr = a.betreiber_mastr AND ao.owner_id IS NOT NULL)";
        } else if (ownerParam) {
          const oid = parseInt(ownerParam, 10);
          if (!isNaN(oid)) {
            ownerFilter = "AND EXISTS (SELECT 1 FROM anlagen ao WHERE ao.betreiber_mastr = a.betreiber_mastr AND ao.owner_id = ?)";
            ownerArgs.push(oid);
          }
        }
        // Kunden-Liste: Stammdaten (Name/Adresse) per COALESCE aus anlagen ableiten,
        // falls keine betreiber-Row existiert (~25 % der Faelle). betreiber liefert
        // nur die Enricher-Felder (email/telefon) + Override-Adresse.
        const rows = db.prepare(`
          SELECT
            a.betreiber_mastr as mastr_nummer,
            COALESCE(b.name, MAX(a.betreiber_name))  as name,
            COALESCE(b.plz,  MAX(a.plz))             as betreiber_plz,
            COALESCE(b.ort,  MAX(a.ort))             as betreiber_ort,
            b.email, b.telefon,
            COUNT(a.id) as anlagen_count,
            ROUND(SUM(COALESCE(a.nettonennleistung, 0)), 2) as gesamt_leistung_kw,
            MAX(a.updated_at) as letzte_aktivitaet,
            (SELECT COUNT(*) FROM reminders r WHERE r.betreiber_mastr = a.betreiber_mastr AND r.status = 'pending') as offene_reminders
          FROM anlagen a
          LEFT JOIN betreiber b ON a.betreiber_mastr = b.mastr_nummer
          WHERE a.betreiber_mastr IS NOT NULL AND a.betreiber_mastr != ''
            ${apiFilter}
            ${viewerFilter}
            ${ownerFilter}
            AND (? = '' OR LOWER(COALESCE(b.name, a.betreiber_name)) LIKE ? OR LOWER(a.betreiber_mastr) LIKE ?)
          GROUP BY a.betreiber_mastr
          ORDER BY anlagen_count DESC, gesamt_leistung_kw DESC
          LIMIT ?
        `).all(...ownerArgs, q, `%${q}%`, `%${q}%`, limit) as any[];
        const useEn = url.searchParams.get("lang") === "en";
        return json(useEn ? mapEnglish(rows, "kunde") : rows);
      }
      const kundeDetailMatch = path.match(/^\/api\/kunden\/([A-Za-z0-9]+)$/);
      if (kundeDetailMatch && method === "GET") {
        const auth = requireUser(req); if ("response" in auth) return auth.response;
        const mastr = kundeDetailMatch[1];
        const betreiber = db.prepare("SELECT * FROM betreiber WHERE mastr_nummer = ?").get(mastr) as any;
        // API-Client: nur bearbeitete Anlagen dieses Kunden.
        const anlagenFilter = isApiClient(auth.user) ? "AND owner_id IS NOT NULL" : "";
        const anlagen = db.prepare(`
          SELECT id, mastr_nummer, name, plz, ort, bundesland, nettonennleistung, status, inbetriebnahme, owner_id, lead_score,
            breitengrad, laengengrad
          FROM anlagen WHERE betreiber_mastr = ? ${anlagenFilter} ORDER BY nettonennleistung DESC
        `).all(mastr) as any[];
        // API-Client: wenn keine bearbeitete Anlage existiert → 404.
        if (isApiClient(auth.user) && anlagen.length === 0) return err("Nicht gefunden", 404, { code: "NOT_FOUND" });
        // Stammdaten (Name/Adresse) aus anlagen ableiten falls betreiber-Row fehlt.
        // Wir nehmen den Wert der groessten Anlage (anlagen ist nach Leistung sortiert).
        const fallback = anlagen[0] || (db.prepare(
          "SELECT betreiber_name, plz, ort, bundesland FROM anlagen WHERE betreiber_mastr = ? ORDER BY nettonennleistung DESC LIMIT 1"
        ).get(mastr) as any) || {};
        // betreiber-Row wird IMMER zurueckgegeben, mit COALESCE-Fallback. So muss das
        // Frontend nicht zwischen "Row existiert" und "Row fehlt" unterscheiden.
        const kundeBetreiber = {
          mastr_nummer: mastr,
          name:       betreiber?.name       || fallback.betreiber_name || fallback.name || null,
          strasse:    betreiber?.strasse    || null,
          hausnummer: betreiber?.hausnummer || null,
          plz:        betreiber?.plz        || fallback.plz  || null,
          ort:        betreiber?.ort        || fallback.ort  || null,
          bundesland: betreiber?.bundesland || fallback.bundesland || null,
          email:      betreiber?.email      || null,
          telefon:    betreiber?.telefon    || null,
          fax:        betreiber?.fax        || null,
          website:    betreiber?.website    || null,
          rechtsform:       betreiber?.rechtsform       || null,
          handelsregister:  betreiber?.handelsregister  || null,
          umsatzsteuer_id:  betreiber?.umsatzsteuer_id  || null,
          // Flag fuer Frontend: stammen die Adress-Daten aus anlagen (Anlagen-Ort) statt
          // aus dem Betreiber-Sitz? Dann im UI als "Anlagen-Adresse (Sitz unbekannt)" labeln.
          address_from_anlage: !betreiber?.plz && !!fallback.plz,
        };
        const notizen = db.prepare(`
          SELECT n.*, u.username as user_username, u.display_name as user_display_name, u.color as user_color,
            (SELECT name FROM anlagen WHERE id = n.anlage_id) as anlage_name
          FROM notizen n LEFT JOIN users u ON n.user_id = u.id
          WHERE n.betreiber_mastr = ?
             OR n.anlage_id IN (SELECT id FROM anlagen WHERE betreiber_mastr = ?)
          ORDER BY n.created_at DESC
        `).all(mastr, mastr);
        const reminders = db.prepare(`
          SELECT r.*,
            ou.username as owner_username, ou.display_name as owner_display_name, ou.color as owner_color
          FROM reminders r LEFT JOIN users ou ON r.owner_user_id = ou.id
          WHERE r.betreiber_mastr = ?
          ORDER BY (r.status = 'done') ASC, r.due_at ASC
          LIMIT 200
        `).all(mastr);
        const calls = db.prepare(`
          SELECT c.*, u.username as user_username, u.display_name as user_display_name, u.color as user_color
          FROM calls c LEFT JOIN users u ON c.user_id = u.id
          WHERE c.betreiber_mastr = ? OR c.anlage_id IN (SELECT id FROM anlagen WHERE betreiber_mastr = ?)
          ORDER BY c.started_at DESC LIMIT 100
        `).all(mastr, mastr);
        return json({ betreiber: kundeBetreiber, anlagen, notizen, reminders, calls });
      }

      // Position einer Anlage via OSM Overpass praezisieren
      // Sucht echte solar-getaggte Polygone in OSM in der Naehe und nimmt deren Zentrum.
      const refineMatch = path.match(/^\/api\/anlagen\/(\d+)\/refine-location$/);
      if (refineMatch && method === "POST") {
        const auth = requireUser(req); if ("response" in auth) return auth.response;
        const id = parseInt(refineMatch[1]);
        const a = db.prepare("SELECT id, breitengrad, laengengrad, plz, ort, name FROM anlagen WHERE id = ?").get(id) as any;
        if (!a) return err("Anlage nicht gefunden", 404);

        // Startpunkt: existierende Koords (oder PLZ-Lookup nachladen)
        let startLat = a.breitengrad as number | null;
        let startLng = a.laengengrad as number | null;
        if (!startLat || !startLng) {
          try {
            const q = [a.plz, a.ort].filter(Boolean).join(" ");
            const r = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=de&q=${encodeURIComponent(q)}`, { headers: { "User-Agent": "mastr-solar/1.0" } });
            const arr = await r.json() as any[];
            if (arr?.[0]) { startLat = parseFloat(arr[0].lat); startLng = parseFloat(arr[0].lon); }
          } catch {}
          if (!startLat || !startLng) return err("Kein Startpunkt fuer Praezisierung — Adresse fehlt", 400);
        }

        // Overpass-Query: solar generators within 5km
        const overpassQuery = `
[out:json][timeout:30];
(
  way["power"="generator"]["generator:source"="solar"](around:5000,${startLat},${startLng});
  way["plant:source"="solar"](around:5000,${startLat},${startLng});
  way["landuse"="industrial"]["industrial"="solar"](around:5000,${startLat},${startLng});
  relation["power"="plant"]["plant:source"="solar"](around:5000,${startLat},${startLng});
);
out center tags;
`.trim();

        try {
          const oRes = await fetch("https://overpass-api.de/api/interpreter", {
            method: "POST",
            body: "data=" + encodeURIComponent(overpassQuery),
            headers: { "User-Agent": "mastr-solar/1.0" },
          });
          if (!oRes.ok) return err(`Overpass-API Fehler ${oRes.status}`, 502);
          const data = await oRes.json() as any;
          const elements = (data.elements || []) as any[];
          if (elements.length === 0) {
            return json({ success: false, message: "Kein Solar-Polygon in OSM im 5km Umkreis gefunden", elements_count: 0 });
          }
          // Naechsten zur Startposition finden (Haversine)
          const toRad = (d: number) => d * Math.PI / 180;
          const dist = (lat1: number, lng1: number, lat2: number, lng2: number) => {
            const R = 6371000;
            const dLat = toRad(lat2 - lat1), dLng = toRad(lng2 - lng1);
            const A = Math.sin(dLat/2)**2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng/2)**2;
            return R * 2 * Math.atan2(Math.sqrt(A), Math.sqrt(1-A));
          };
          let best: any = null; let bestDist = Infinity;
          for (const e of elements) {
            const c = e.center || (e.lat && e.lon ? { lat: e.lat, lon: e.lon } : null);
            if (!c) continue;
            const d = dist(startLat, startLng, c.lat, c.lon);
            if (d < bestDist) { bestDist = d; best = { ...e, center: c, distance_m: Math.round(d) }; }
          }
          if (!best) return json({ success: false, message: "Keine verwertbaren OSM-Elemente" });

          // Update DB
          db.prepare(`
            UPDATE anlagen SET
              breitengrad = ?, laengengrad = ?,
              position_refined_at = CURRENT_TIMESTAMP,
              position_refined_distance_m = ?,
              position_osm_ref = ?,
              updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
          `).run(best.center.lat, best.center.lon, best.distance_m, `${best.type}/${best.id}`, id);
          logActivity(db, id, auth.user.id, "kontakt_updated", `Position via OSM praezisiert (Δ ${best.distance_m}m, OSM ${best.type}/${best.id})`, undefined, tid(auth.user));

          return json({
            success: true,
            old: { lat: startLat, lng: startLng },
            new: { lat: best.center.lat, lng: best.center.lon },
            distance_moved_m: best.distance_m,
            osm_ref: `${best.type}/${best.id}`,
            osm_name: best.tags?.name || best.tags?.operator || null,
            candidates: elements.length,
          });
        } catch (e: any) {
          return err(`Overpass-Fehler: ${e?.message || e}`, 502);
        }
      }

      // Nachbar-Anlagen am Standort (innerhalb radius_m, Default 2000)
      const neighborsMatch = path.match(/^\/api\/anlagen\/(\d+)\/neighbors$/);
      if (neighborsMatch && method === "GET") {
        const auth = requireUser(req); if ("response" in auth) return auth.response;
        const id = parseInt(neighborsMatch[1]);
        // API-Client: Quell-Anlage muss bearbeitet sein.
        if (!anlageVisibleToClient(db, id, auth.user)) return err("Nicht gefunden", 404, { code: "NOT_FOUND" });
        const a = db.prepare("SELECT id, breitengrad, laengengrad, betreiber_mastr FROM anlagen WHERE id = ?").get(id) as any;
        if (!a || !a.breitengrad) return json([]);
        const radiusM = Math.min(20000, parseInt(url.searchParams.get("radius") || "2000"));
        // Grobe Bounding Box (1° lat ≈ 111 km, 1° lng ≈ 71 km bei 50° N)
        const latDelta = radiusM / 111000;
        const lngDelta = radiusM / 71000;
        const apiNeighborFilter = isApiClient(auth.user) ? "AND owner_id IS NOT NULL" : "";
        const bbox = db.prepare(`
          SELECT id, mastr_nummer, name, plz, ort, nettonennleistung, betreiber_mastr, betreiber_name,
            breitengrad, laengengrad, inbetriebnahme, status
          FROM anlagen
          WHERE id != ?
            ${apiNeighborFilter}
            AND breitengrad BETWEEN ? AND ?
            AND laengengrad BETWEEN ? AND ?
          LIMIT 500
        `).all(id, a.breitengrad - latDelta, a.breitengrad + latDelta, a.laengengrad - lngDelta, a.laengengrad + lngDelta) as any[];
        // Haversine-Distanz pro Treffer berechnen und filtern
        const toRad = (d: number) => d * Math.PI / 180;
        const result = bbox.map((n) => {
          const dLat = toRad(n.breitengrad - a.breitengrad);
          const dLng = toRad(n.laengengrad - a.laengengrad);
          const A = Math.sin(dLat/2)**2 + Math.cos(toRad(a.breitengrad)) * Math.cos(toRad(n.breitengrad)) * Math.sin(dLng/2)**2;
          const distance_m = Math.round(6371000 * 2 * Math.atan2(Math.sqrt(A), Math.sqrt(1-A)));
          return { ...n, distance_m, same_betreiber: n.betreiber_mastr === a.betreiber_mastr ? 1 : 0 };
        }).filter((n) => n.distance_m <= radiusM)
          .sort((x, y) => x.distance_m - y.distance_m)
          .slice(0, 100);
        return json(result);
      }

      // Andere Anlagen desselben Kunden (Standalone-Endpoint fuer das UI)
      const anlageRelatedMatch = path.match(/^\/api\/anlagen\/(\d+)\/related$/);
      if (anlageRelatedMatch && method === "GET") {
        const auth = requireUser(req); if ("response" in auth) return auth.response;
        const id = parseInt(anlageRelatedMatch[1]);
        if (!anlageVisibleToClient(db, id, auth.user)) return err("Nicht gefunden", 404, { code: "NOT_FOUND" });
        const a = db.prepare("SELECT betreiber_mastr FROM anlagen WHERE id = ?").get(id) as any;
        if (!a || !a.betreiber_mastr) return json([]);
        const apiRelFilter = isApiClient(auth.user) ? "AND owner_id IS NOT NULL" : "";
        const rows = db.prepare(`
          SELECT id, mastr_nummer, name, plz, ort, bundesland, nettonennleistung, status, inbetriebnahme
          FROM anlagen WHERE betreiber_mastr = ? AND id != ? ${apiRelFilter}
          ORDER BY nettonennleistung DESC LIMIT 100
        `).all(a.betreiber_mastr, id);
        return json(rows);
      }

      // ===== EMAIL SEND =====
      const sendMailMatch = path.match(/^\/api\/anlagen\/(\d+)\/email$/);
      if (sendMailMatch && method === "POST") {
        const auth = requireUser(req); if ("response" in auth) return auth.response;
        const anlageId = parseInt(sendMailMatch[1]);
        const b = (await req.json()) as any;
        if (!b.to || !b.subject || !b.body_html) return err("Empfaenger, Betreff, Body erforderlich");

        const u = db.prepare(`SELECT * FROM users WHERE id = ?`).get(auth.user.id) as any;
        const anlage = db.prepare("SELECT * FROM anlagen WHERE id = ?").get(anlageId) as any;
        if (!anlage) return err("Anlage nicht gefunden", 404);

        // Render placeholders — Anlage + Sender-Profile + Feedgy-Template-Variablen
        const adminProfile = db.prepare(`
          SELECT phone, bio, signature_html, signature_html_en, signature_html_fr,
            email AS user_email, smtp_from_email, smtp_from_name, display_name, pref_locale
          FROM users WHERE id = ?
        `).get(auth.user.id) as any || {};
        const appSettings = db.prepare(`SELECT key, value FROM app_settings`).all() as any[];
        const settings: Record<string, string> = {};
        for (const s of appSettings || []) settings[s.key] = s.value;
        // Locale-aware Anrede: nutzt pref_locale des bearbeitenden Users für die Preview.
        // Für tatsächlichen Versand an externe Empfänger (bulk/automation) bleibt der DE-Default in detectAnrede() aktiv.
        const anredeInfo = detectAnredeLocalized(anlage.betreiber_name, (auth.user as any).pref_locale || "de-DE");
        const leistungNum = anlage.nettonennleistung ? Math.round(anlage.nettonennleistung) : 0;
        // DE-Zahlenformat 1.234.567
        const fmt = (n: number) => n.toLocaleString('de-DE');
        const vars = {
          // Anlage
          anlagenname: anlage.name || anlage.mastr_nummer || "",
          ort: anlage.ort || "",
          plz: anlage.plz || "",
          leistung: leistungNum ? fmt(leistungNum) : "",
          // Repowering: neue Module ca. 2.5× Leistungsdichte
          leistung_neu_kwp: leistungNum ? fmt(Math.round(leistungNum * 2.5)) : "",
          // Marktwert-Spannen (typisch 180-320 EUR/kWp fuer gebrauchte PV)
          marktwert_eur: leistungNum ? fmt(Math.round(leistungNum * 250)) : "",
          marktwert_eur_low: leistungNum ? fmt(Math.round(leistungNum * 180)) : "",
          marktwert_eur_high: leistungNum ? fmt(Math.round(leistungNum * 320)) : "",
          // Legacy-Aliase (alte Templates nutzen leistung_x25 als "ca-Wert") — auf Marktwert mappen
          leistung_x25: leistungNum ? fmt(Math.round(leistungNum * 250)) : "",
          leistung_x30: leistungNum ? fmt(Math.round(leistungNum * 320)) : "",
          jahres_ertrag_kwh: leistungNum ? fmt(Math.round(leistungNum * 950)) : "",
          jahres_ertrag_neu_kwh: leistungNum ? fmt(Math.round(leistungNum * 2.5 * 950)) : "",
          betreiber: anlage.betreiber_name || "",
          // Anrede aus Heuristik
          anrede: anredeInfo.anrede,
          anrede_kurz: anredeInfo.anrede_kurz,
          gender: anredeInfo.gender,
          vorname: anredeInfo.vorname,
          nachname: anredeInfo.nachname,
          datum: new Date().toLocaleDateString("de-DE"),
          jahr: new Date().getFullYear().toString(),
          termin: b.termin_text || "",
          // Sender (Profil + User)
          absender_name: adminProfile.smtp_from_name || adminProfile.display_name || u.display_name || u.username || "",
          absender_email: adminProfile.smtp_from_email || adminProfile.user_email || u.email || "",
          absender_position: adminProfile.bio || "",
          absender_tel: adminProfile.phone || "",
          // Firma (aus app_settings)
          firma_name: settings.firma_name || "Repowering DE",
          firma_adresse: settings.firma_adresse || "",
          firma_url: settings.firma_url || "https://repowering-de.de",
          firma_url_display: (settings.firma_url || "repowering-de.de").replace(/^https?:\/\//, ""),
          // Direkt-Link zum Repowering-Eignungs-Check (Zoho-Form embedded auf /check)
          check_url: (settings.firma_url || "https://repowering-de.de") + "/check",
          // Pre-filled Check-Link: Kunde sieht Formular mit seinen Daten schon ausgefuellt (signed Token, TTL 90 Tage)
          check_url_prefilled: anlage?.id ? `${settings.firma_url || "https://repowering-de.de"}/check?t=${signCheckToken(anlage.id)}` : ((settings.firma_url || "https://repowering-de.de") + "/check"),
          firma_register: settings.firma_register || "",
          // Technik-Defaults aus app_settings (DRY: re-use repowering_module_wp)
          modul_wp_neu: settings.repowering_module_wp || "720",
          modul_wp_alt: settings.modul_wp_alt || "230",
          // Free-form text blocks (User schreibt im Compose)
          preheader: b.preheader || "Bewertung Ihrer PV-Anlage",
          textblock1: b.textblock1 || "",
          textblock2: b.textblock2 || "",
          cta_label: b.cta_label || "Kostenlose Analyse anfordern →",
          cta_url: b.cta_url || (anlage?.id ? `${settings.firma_url || "https://repowering-de.de"}/check?t=${signCheckToken(anlage.id)}` : (settings.firma_url || "https://repowering-de.de") + "/check"),
        };
        const subject = renderTemplate(b.subject, vars);
        // Signatur in Empfänger-Locale (Fallback: Sender-Locale). Wir nutzen pref_locale des Senders
        // als pragmatischen Default — Anlage-Empfänger hat keine pref_locale in der DB.
        const sigLocale = (b.locale as string | undefined) || u.pref_locale || "de";
        const sig = pickSignature(u as any, sigLocale);
        let bodyHtml = renderTemplate(b.body_html, vars) + (sig ? `<br><br>${sig}` : "");
        // Email-Tracking-Injection
        const trackingToken = generateTrackingToken();
        const trackBase = process.env.PUBLIC_BASE_URL || `${url.origin}`;
        bodyHtml = injectTracking(bodyHtml, trackingToken, trackBase);

        // Attachments
        const attachments: any[] = [];
        if (Array.isArray(b.attachment_ids) && b.attachment_ids.length > 0) {
          const placeholders = b.attachment_ids.map(() => "?").join(",");
          const rows = db.prepare(`
            SELECT id, original_name, stored_path, mime_type
            FROM attachments
            WHERE id IN (${placeholders}) AND (user_id IS NULL OR user_id = ?)
          `).all(...b.attachment_ids, auth.user.id) as any[];
          for (const a of rows) {
            attachments.push({ filename: a.original_name, path: a.stored_path, contentType: a.mime_type });
          }
        }

        // Optional Termin
        let terminId: number | null = null;
        if (b.create_termin && b.termin_start && b.termin_end) {
          const startTs = new Date(b.termin_start).getTime();
          const endTs = new Date(b.termin_end).getTime();
          const uid = `${randomBytes(8).toString("hex")}@mastr-solar`;
          const acceptToken = randomBytes(16).toString("hex");
          const title = b.termin_title || `Termin ${anlage.name || anlage.ort}`;
          const r = db.prepare(`
            INSERT INTO termine (user_id, anlage_id, uid, title, description, location, start_ts, end_ts, attendee_email, accept_token, status)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'tentative')
          `).run(auth.user.id, anlageId, uid, title, b.termin_description || "", anlage.ort || "", startTs, endTs, b.to, acceptToken);
          terminId = r.lastInsertRowid as number;

          const acceptUrl = `${url.origin}/api/termine/accept?token=${acceptToken}`;
          const ics = generateICS({
            uid, title, description: b.termin_description || "", location: anlage.ort || "",
            start_ts: startTs, end_ts: endTs,
            attendee_email: b.to, organizer_email: u.smtp_from_email || u.email,
            organizer_name: u.smtp_from_name || u.display_name || u.username,
            acceptUrl,
          });
          attachments.push({ filename: "termin.ics", content: ics, contentType: "text/calendar; method=REQUEST" });
        }

        try {
          // Smart-Transport: eigene SMTP wenn vorhanden, sonst Admin-Fallback (Reply-To wird auf User-Email gesetzt)
          const { transport, effectiveFrom, replyTo, fallback } = buildTransportWithFallback(db, u);
          const testModeEmail = (db.prepare("SELECT value FROM app_settings WHERE key = 'test_mode_email'").get() as any)?.value || null;
          const mailOpts: any = applyTestModeOverride(testModeEmail, {
            from: effectiveFrom,
            to: b.to,
            cc: b.cc || undefined,
            subject,
            html: bodyHtml,
            attachments,
            icalEvent: terminId ? { method: "REQUEST", content: attachments.find(a => a.filename === "termin.ics")?.content } : undefined,
          });
          if (replyTo) mailOpts.replyTo = replyTo;
          if (fallback) log.info("mail_send_via_admin_fallback", { userId: u.id, username: u.username, to: b.to });
          if (testModeEmail) mailOpts.cc = undefined;
          const info = await transport.sendMail(mailOpts);
          db.prepare(`
            INSERT INTO sent_emails (user_id, anlage_id, to_addr, cc_addr, subject, body_preview, termin_id, status, attachment_ids, tracking_token)
            VALUES (?, ?, ?, ?, ?, ?, ?, 'sent', ?, ?)
          `).run(auth.user.id, anlageId, b.to, b.cc || null, subject, bodyHtml.substring(0, 500), terminId, JSON.stringify(b.attachment_ids || []), trackingToken);
          // Mark anlage status
          if (anlage.status === "neu") {
            db.prepare("UPDATE anlagen SET status = 'kontaktiert', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(anlageId);
          }
          autoAssignOwner(db, anlageId, auth.user.id);
          logActivity(db, anlageId, auth.user.id, "email_sent", `An: ${b.to} · ${subject}`, { to: b.to, subject }, tid(auth.user));
          // @-Mentions im Mail-Body erkennen → In-App-Notification + Webhook
          try {
            // Wir scannen den TEXT-Anteil — primaer das Subject + body (gestrippt von HTML).
            const plain = (subject + "\n" + bodyHtml.replace(/<[^>]*>/g, " ")).slice(0, 20000);
            const mentions = parseMentions(db, plain);
            const senderName = auth.user.display_name || auth.user.username;
            const anlageLabel = anlage.name || anlage.mastr_nummer || `#${anlageId}`;
            for (const m of mentions) {
              if (m.user_id === auth.user.id) continue;
              await notify(db, {
                userId: m.user_id,
                type: "mention",
                titleKey: "notif.mention_chat_title",
                titleArgs: { from: senderName, anlage: anlageLabel },
                body: `(E-Mail an ${b.to}) ${subject}`,
                anlageId: anlageId,
                fromUserId: auth.user.id,
                fromUserName: senderName,
              });
              try { fireEvent(db, "mention.created", {
                anlage_id: anlageId,
                anlage_label: anlageLabel,
                from: { id: auth.user.id, username: auth.user.username, display_name: senderName },
                to: { id: m.user_id, username: m.username },
                text: subject,
                channel: "email",
              }); } catch (e) { console.error("webhook fireEvent:", e); }
            }
          } catch (e) { console.error("mail mention parse:", e); }
          return json({ success: true, messageId: info.messageId, terminId });
        } catch (e: any) {
          db.prepare(`
            INSERT INTO sent_emails (user_id, anlage_id, to_addr, cc_addr, subject, status, error)
            VALUES (?, ?, ?, ?, ?, 'failed', ?)
          `).run(auth.user.id, anlageId, b.to, b.cc || null, subject, e.message);
          return err(`Mail-Versand fehlgeschlagen: ${e.message}`, 500);
        }
      }

      // ===== TERMINE =====
      // Reminders im FullCalendar-Format (paralleler Layer zu termine)
      if (path === "/api/reminders/calendar" && method === "GET") {
        const auth = requireUser(req); if ("response" in auth) return auth.response;
        const from = url.searchParams.get("from");
        const to = url.searchParams.get("to");
        const where: string[] = ["r.status != 'done'"];
        const params: any[] = [];
        // URL-Param ueber querystring dekodiert "+" zu Leerzeichen — vor Date()-Parse
        // wieder zu "+" reparieren. Bei Invalid-Date silently weglassen.
        const parseDate = (s: string | null) => {
          if (!s) return null;
          const fixed = s.replace(/ /g, "+");
          const d = new Date(fixed);
          return isNaN(d.getTime()) ? null : d.toISOString();
        };
        const fromIso = parseDate(from);
        const toIso   = parseDate(to);
        if (fromIso) { where.push("r.due_at >= ?"); params.push(fromIso); }
        if (toIso)   { where.push("r.due_at <= ?"); params.push(toIso); }
        const rows = db.prepare(`
          SELECT r.id, r.due_at, r.note, r.status, r.betreiber_mastr,
            b.name as betreiber_name,
            ou.username as owner_username, ou.display_name as owner_display_name, ou.color as owner_color
          FROM reminders r
          LEFT JOIN betreiber b ON b.mastr_nummer = r.betreiber_mastr
          LEFT JOIN users ou ON r.owner_user_id = ou.id
          WHERE ${where.join(" AND ")}
          ORDER BY r.due_at
        `).all(...params);
        return json(rows);
      }

      if (path === "/api/termine" && method === "GET") {
        const auth = requireUser(req); if ("response" in auth) return auth.response;
        const from = url.searchParams.get("from");
        const to = url.searchParams.get("to");
        const where: string[] = [];
        const params: any[] = [];
        if (from) { where.push("t.end_ts >= ?"); params.push(new Date(from).getTime()); }
        if (to) { where.push("t.start_ts <= ?"); params.push(new Date(to).getTime()); }
        // Viewer: nur Termine zu telefonierten Anlagen.
        if (isViewer(auth.user)) {
          where.push("EXISTS (SELECT 1 FROM calls c WHERE c.anlage_id = t.anlage_id)");
        }
        const wc = where.length ? `WHERE ${where.join(" AND ")}` : "";
        const rows = db.prepare(`
          SELECT t.*, u.username as user_username, u.display_name as user_display_name, u.color as user_color,
            a.name as anlage_name, a.ort as anlage_ort
          FROM termine t
          LEFT JOIN users u ON t.user_id = u.id
          LEFT JOIN anlagen a ON t.anlage_id = a.id
          ${wc}
          ORDER BY t.start_ts
        `).all(...params);
        return json(rows);
      }
      if (path === "/api/termine" && method === "POST") {
        const auth = requireUser(req); if ("response" in auth) return auth.response;
        const b = (await req.json()) as any;
        if (!b.title || !b.start || !b.end) return err("Titel, Start, Ende erforderlich");
        const uid = `${randomBytes(8).toString("hex")}@mastr-solar`;
        const accept_token = randomBytes(16).toString("hex");
        const r = db.prepare(`
          INSERT INTO termine (user_id, anlage_id, uid, title, description, location, start_ts, end_ts, attendee_email, attendee_name, accept_token, status)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'confirmed')
        `).run(
          auth.user.id, b.anlage_id || null, uid, b.title, b.description || "", b.location || "",
          new Date(b.start).getTime(), new Date(b.end).getTime(),
          b.attendee_email || null, b.attendee_name || null, accept_token,
        );
        const terminId = Number(r.lastInsertRowid);
        try { fireEvent(db, "termin.created", {
          termin_id: terminId,
          uid,
          title: b.title,
          start: new Date(b.start).toISOString(),
          end: new Date(b.end).toISOString(),
          location: b.location || null,
          description: b.description || null,
          anlage_id: b.anlage_id || null,
          attendee_email: b.attendee_email || null,
          attendee_name: b.attendee_name || null,
          created_by: { id: auth.user.id, username: auth.user.username },
        }); } catch (e) { console.error("webhook fireEvent:", e); }
        return json({ success: true, id: terminId });
      }
      const terminIdMatch = path.match(/^\/api\/termine\/(\d+)$/);
      if (terminIdMatch && method === "PUT") {
        const auth = requireUser(req); if ("response" in auth) return auth.response;
        const id = parseInt(terminIdMatch[1]);
        const b = (await req.json()) as any;
        const sets: string[] = [];
        const vals: any[] = [];
        if (b.title !== undefined) { sets.push("title = ?"); vals.push(b.title); }
        if (b.description !== undefined) { sets.push("description = ?"); vals.push(b.description); }
        if (b.location !== undefined) { sets.push("location = ?"); vals.push(b.location); }
        if (b.start !== undefined) { sets.push("start_ts = ?"); vals.push(new Date(b.start).getTime()); }
        if (b.end !== undefined) { sets.push("end_ts = ?"); vals.push(new Date(b.end).getTime()); }
        if (b.status !== undefined) { sets.push("status = ?"); vals.push(b.status); }
        if (sets.length === 0) return err("Keine Aenderungen");
        sets.push("sequence = sequence + 1", "updated_at = CURRENT_TIMESTAMP");
        vals.push(id);
        db.prepare(`UPDATE termine SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
        return json({ success: true });
      }
      if (terminIdMatch && method === "DELETE") {
        const auth = requireUser(req); if ("response" in auth) return auth.response;
        db.prepare("DELETE FROM termine WHERE id = ?").run(parseInt(terminIdMatch[1]));
        return json({ success: true });
      }

      // Public RSVP (Token-based)
      if (path === "/api/termine/accept" && method === "GET") {
        const token = url.searchParams.get("token");
        if (!token) return new Response("Ungueltiger Link", { status: 400 });
        const t = db.prepare("SELECT id FROM termine WHERE accept_token = ?").get(token) as any;
        if (!t) return new Response("Termin nicht gefunden", { status: 404 });
        db.prepare("UPDATE termine SET rsvp_status = 'accepted', status = 'confirmed' WHERE id = ?").run(t.id);
        return new Response(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Bestaetigt</title></head><body style="font-family: system-ui; padding: 40px; text-align: center;"><h1>Termin bestaetigt</h1><p>Vielen Dank, der Termin wurde bestaetigt.</p></body></html>`, {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }
      if (path === "/api/termine/decline" && method === "GET") {
        const token = url.searchParams.get("token");
        if (!token) return new Response("Ungueltiger Link", { status: 400 });
        const t = db.prepare("SELECT id FROM termine WHERE accept_token = ?").get(token) as any;
        if (!t) return new Response("Termin nicht gefunden", { status: 404 });
        db.prepare("UPDATE termine SET rsvp_status = 'declined', status = 'cancelled' WHERE id = ?").run(t.id);
        return new Response(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Abgelehnt</title></head><body style="font-family: system-ui; padding: 40px; text-align: center;"><h1>Termin abgelehnt</h1><p>Der Termin wurde abgelehnt.</p></body></html>`, {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }

      // ===== CSV Export (admin only) =====
      if (path === "/api/export/csv" && method === "GET") {
        const auth = requireUser(req); if ("response" in auth) return auth.response;
        if (auth.user.username !== "admin" && !auth.user.is_admin) return err("Nur Admin darf exportieren", 403);
        logAudit(db, { userId: auth.user.id, username: auth.user.username, action: "csv_export", ip });
        const rows = db.prepare(`
          SELECT a.name, a.betreiber_name, a.betreiber_mastr, a.mastr_nummer,
            a.strasse, a.plz, a.ort, a.bundesland,
            a.nettonennleistung, a.bruttoleistung, a.inbetriebnahme,
            a.energietraeger, a.status,
            b.email, b.telefon, b.website
          FROM anlagen a LEFT JOIN betreiber b ON a.betreiber_mastr = b.mastr_nummer
          ORDER BY a.nettonennleistung DESC
        `).all() as any[];
        let csv = "Name;Betreiber;Betreiber MaStR;MaStR-Nr;Strasse;PLZ;Ort;Bundesland;Leistung (kW);Bruttoleistung (kWp);Inbetriebnahme;Energietraeger;Status;Email;Telefon;Website\n";
        for (const a of rows) {
          csv += [a.name, a.betreiber_name, a.betreiber_mastr, a.mastr_nummer, a.strasse, a.plz, a.ort, a.bundesland, a.nettonennleistung, a.bruttoleistung, a.inbetriebnahme, a.energietraeger, a.status, a.email, a.telefon, a.website].map(v => v ?? "").join(";") + "\n";
        }
        return new Response(csv, {
          headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": "attachment; filename=mastr-solar-anlagen.csv" },
        });
      }

      // ============== PUBLIC LANDINGPAGE ==============
      // GET /interesse, /partner  -> serve static/lead.html (single page, sections via hash)
      if ((path === "/interesse" || path === "/partner") && method === "GET") {
        return new Response(file("static/lead.html"), {
          headers: {
            "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": "public, max-age=300",
            "X-Frame-Options": "SAMEORIGIN",
            "X-Content-Type-Options": "nosniff",
            "Referrer-Policy": "strict-origin-when-cross-origin",
          },
        });
      }
      // GET /check -> Repowering-Eignungs-Check
      if (path === "/check" && method === "GET") {
        return new Response(file("static/check.html"), {
          headers: {
            "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": "public, max-age=300",
            "X-Content-Type-Options": "nosniff",
            "Referrer-Policy": "strict-origin-when-cross-origin",
          },
        });
      }
      // GET /impressum + /datenschutz — Settings-driven, Platzhalter werden serverseitig durch app_settings ersetzt
      if ((path === "/impressum" || path === "/datenschutz") && method === "GET") {
        const fname = path === "/impressum" ? "static/impressum.html" : "static/datenschutz.html";
        let html = await file(fname).text();
        // getAppSettings liefert Defaults aus lib/app-settings.ts wenn DB-Werte fehlen
        const settings = getAppSettings(db) as any;
        const PLACEHOLDER = '<span class="unset">⚠ in Einstellungen ausfuellen</span>';
        const fields = ["firma_name","firma_adresse","firma_url","firma_email","firma_telefon",
                        "firma_register","firma_ust_id","firma_vertreter","firma_verantwortlich"];
        for (const f of fields) {
          const v = String(settings[f] || "").trim();
          html = html.replace(new RegExp(`{{${f}}}`, "g"), v || PLACEHOLDER);
        }
        // dd-class fix damit die unset-Klasse greift (CSS macht sie sichtbar)
        html = html.replace(/<dd>(<span class="unset">[^<]+<\/span>)<\/dd>/g, '<dd class="unset">$1</dd>');
        return new Response(html, {
          headers: {
            "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": "public, max-age=300",
            "X-Content-Type-Options": "nosniff",
            "Referrer-Policy": "strict-origin-when-cross-origin",
          },
        });
      }

      // POST /api/public/leads — Anfrage aus Landing-Page (auth-frei, rate-limited)
      if (path === "/api/public/leads" && method === "POST") {
        if (!checkPublicLeadRate(ip)) {
          return err("Zu viele Anfragen. Bitte spaeter erneut versuchen.", 429, { code: "RATE_LIMITED" });
        }
        let body: any = {};
        try { body = await req.json(); } catch { return err("Invalid JSON", 400); }

        // Honeypot — Bots fuellen das versteckte 'website_url'-Feld
        if (body.website_url && String(body.website_url).trim() !== "") {
          // Stilles Erfolg an Bot zurueckgeben, intern droppen
          log.info("public_lead_honeypot_hit", { ip, ua });
          return json({ success: true, ticket: "ok" });
        }

        // Validation
        const leadType = body.lead_type === "partner" ? "partner" : "betreiber";
        const email = String(body.email || "").trim().toLowerCase();
        if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
          return err("Bitte gueltige E-Mail-Adresse angeben", 400, { code: "INVALID_EMAIL" });
        }
        const name = String(body.name || "").trim().slice(0, 120) || null;
        if (!name) return err("Bitte Namen angeben", 400, { code: "MISSING_NAME" });

        // Sanitize alle freien Felder + Laengen begrenzen
        const trunc = (s: any, n: number) => s == null ? null : String(s).trim().slice(0, n) || null;
        const interest = ["repowering","ankauf","beides","demo","partnerschaft"].includes(body.interest) ? body.interest : null;
        const firma     = trunc(body.firma, 200);
        const telefon   = trunc(body.telefon, 50);
        const plz       = trunc(body.plz, 10);
        const ort       = trunc(body.ort, 120);
        const strasse   = trunc(body.strasse, 200);
        const mastrRaw  = trunc(body.mastr_nummer, 30);
        const mastr     = mastrRaw ? mastrRaw.toUpperCase().replace(/[^A-Z0-9]/g, "") : null;
        const kwp       = body.anlagen_leistung_kwp != null && !isNaN(parseFloat(body.anlagen_leistung_kwp)) ? parseFloat(body.anlagen_leistung_kwp) : null;
        const baujahr   = body.inbetriebnahme_jahr != null && !isNaN(parseInt(body.inbetriebnahme_jahr)) ? parseInt(body.inbetriebnahme_jahr) : null;
        const nachricht = trunc(body.nachricht, 4000);
        const referrer  = trunc(req.headers.get("referer"), 500);

        // MaStR-Matching: ist die angegebene Nummer in unserer DB?
        let matchedAnlageId: number | null = null;
        if (mastr && (mastr.startsWith("SEE") || mastr.startsWith("EEG"))) {
          const m = db.prepare("SELECT id FROM anlagen WHERE mastr_nummer = ?").get(mastr) as any;
          if (m) matchedAnlageId = m.id;
        }

        const res = db.prepare(`
          INSERT INTO public_leads (
            lead_type, interest, name, firma, email, telefon,
            plz, ort, strasse, mastr_nummer, anlagen_leistung_kwp, inbetriebnahme_jahr,
            nachricht, ip, user_agent, referrer, matched_anlage_id
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(leadType, interest, name, firma, email, telefon,
              plz, ort, strasse, mastr, kwp, baujahr,
              nachricht, ip, ua, referrer, matchedAnlageId);
        const leadId = Number(res.lastInsertRowid);

        // Wenn MaStR-Match -> Notiz an Anlage haengen (sichtbar im Anlagen-Detail)
        if (matchedAnlageId) {
          try {
            const noteText = `📩 PUBLIC-LEAD #${leadId} (${leadType === "partner" ? "Partner" : "Anlagenbetreiber"})\n`
              + `${name}${firma ? " · " + firma : ""}\n`
              + `${email}${telefon ? " · " + telefon : ""}\n`
              + (interest ? `Interesse: ${interest}\n` : "")
              + (nachricht ? `\n${nachricht}` : "");
            db.prepare(`
              INSERT INTO notizen (anlage_id, betreiber_mastr, user_id, text, scope, created_at)
              VALUES (?, (SELECT betreiber_mastr FROM anlagen WHERE id = ?), NULL, ?, 'betreiber', CURRENT_TIMESTAMP)
            `).run(matchedAnlageId, matchedAnlageId, noteText);
          } catch (e) {
            log.error("public_lead_note_failed", { leadId, error: String(e) });
          }
        }

        // Notify Admins/Owner via In-App + Email + Telegram (best effort) — per-recipient localized
        try {
          const recipients = db.prepare(`
            SELECT id, pref_locale FROM users WHERE active = 1 AND (is_admin = 1 OR username = 'admin')
          `).all() as any[];
          for (const r of recipients) {
            const loc = r.pref_locale || "de-DE";
            const titleKey = leadType === "partner"
              ? "notif.lead_partner_title"
              : (matchedAnlageId ? "notif.lead_inquiry_title_match" : "notif.lead_inquiry_title");
            const bodyText = [
              firma && `${tt(loc, "notif.field.firma")}: ${firma}`,
              email && `${tt(loc, "notif.field.email")}: ${email}`,
              telefon && `${tt(loc, "notif.field.phone")}: ${telefon}`,
              (plz || ort) && `${tt(loc, "notif.field.location")}: ${[plz, ort].filter(Boolean).join(" ")}`,
              interest && `${tt(loc, "notif.field.interest")}: ${interest}`,
              nachricht && `\n${nachricht.slice(0, 300)}`,
            ].filter(Boolean).join("\n");
            void notify(db, {
              userId: r.id,
              type: "assignment",
              titleKey,
              titleArgs: { name },
              body: bodyText,
              anlageId: matchedAnlageId ?? undefined,
              url: matchedAnlageId ? `/?#anlage-${matchedAnlageId}` : `/?#leads`,
            }).catch(() => {});
          }
        } catch (e) {
          log.error("public_lead_notify_failed", { leadId, error: String(e) });
        }

        log.info("public_lead_created", { leadId, leadType, mastrMatch: !!matchedAnlageId, ip });
        try { fireEvent(db, "lead.created", {
          lead_id: leadId,
          lead_type: leadType,
          interest,
          name, firma, email, telefon,
          plz, ort, strasse,
          mastr_nummer: mastr,
          anlagen_leistung_kwp: kwp,
          inbetriebnahme_jahr: baujahr,
          matched_anlage_id: matchedAnlageId,
          ticket: `LEAD-${leadId}`,
        }); } catch (e) { console.error("webhook fireEvent:", e); }
        return json({ success: true, ticket: `LEAD-${leadId}` });
      }

      // POST /api/public/check — Repowering-Check-Formular (Zoho-Form Aequivalent)
      // Speichert in unserem CRM + benachrichtigt Admin + Owner + leitet asynchron an Zoho weiter (best effort).
      if (path === "/api/public/check" && method === "POST") {
        if (!checkPublicLeadRate(ip)) {
          return err("Zu viele Anfragen. Bitte spaeter erneut versuchen.", 429, { code: "RATE_LIMITED" });
        }
        let body: any = {};
        try { body = await req.json(); } catch { return err("Invalid JSON", 400); }
        if (body.website_url && String(body.website_url).trim() !== "") {
          log.info("public_check_honeypot_hit", { ip, ua });
          return json({ success: true, ticket: "ok" });
        }
        const trunc = (s: any, n: number) => s == null ? null : String(s).trim().slice(0, n) || null;
        const vorname  = trunc(body.vorname, 80);
        const nachname = trunc(body.nachname, 80);
        const email    = String(body.email || "").trim().toLowerCase();
        const telefon  = trunc(body.telefon, 50);
        if (!vorname || !nachname) return err("Bitte Vor- und Nachname angeben", 400, { code: "MISSING_NAME" });
        if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return err("Bitte gueltige E-Mail-Adresse angeben", 400, { code: "INVALID_EMAIL" });
        if (!telefon || telefon.length < 5) return err("Bitte Telefonnummer angeben", 400, { code: "MISSING_PHONE" });
        if (body.agb_accepted !== true) return err("Bitte AGB akzeptieren", 400, { code: "AGB_REQUIRED" });
        const fullName = `${vorname} ${nachname}`.trim();
        const firma    = trunc(body.firma, 200);
        const plz      = trunc(body.plz, 10);
        const ort      = trunc(body.ort, 120);
        const strasse  = trunc(body.strasse, 200);
        const inbetriebnahme = trunc(body.inbetriebnahme, 20);  // "YYYY-MM" oder "YYYY-MM-DD"
        const mastrRaw = trunc(body.mastr_nummer, 30);
        const mastr    = mastrRaw ? mastrRaw.toUpperCase().replace(/[^A-Z0-9]/g, "") : null;
        const kwp      = body.anlagen_leistung_kwp != null && !isNaN(parseFloat(body.anlagen_leistung_kwp)) ? parseFloat(body.anlagen_leistung_kwp) : null;
        const baujahr  = inbetriebnahme ? parseInt(inbetriebnahme.slice(0, 4)) : null;
        const nachricht = trunc(body.nachricht, 4000);
        const referrer = trunc(req.headers.get("referer"), 500);
        // MaStR-Match suchen
        let matchedAnlageId: number | null = null;
        let matchedOwnerId: number | null = null;
        if (mastr && (mastr.startsWith("SEE") || mastr.startsWith("EEG"))) {
          const m = db.prepare("SELECT id, owner_id FROM anlagen WHERE mastr_nummer = ?").get(mastr) as any;
          if (m) { matchedAnlageId = m.id; matchedOwnerId = m.owner_id || null; }
        }
        // Fallback-Match: Email-Suche bei Betreiber
        if (!matchedAnlageId && email) {
          const m = db.prepare(`
            SELECT a.id, a.owner_id FROM anlagen a
            LEFT JOIN betreiber b ON a.betreiber_mastr = b.mastr_nummer
            WHERE LOWER(b.email) = ? OR LOWER(a.kontakt_email) = ?
            ORDER BY a.nettonennleistung DESC LIMIT 1
          `).get(email, email) as any;
          if (m) { matchedAnlageId = m.id; matchedOwnerId = m.owner_id || null; }
        }
        // In public_leads speichern
        const res = db.prepare(`
          INSERT INTO public_leads (
            lead_type, interest, name, firma, email, telefon,
            plz, ort, strasse, mastr_nummer, anlagen_leistung_kwp, inbetriebnahme_jahr,
            nachricht, ip, user_agent, referrer, matched_anlage_id
          ) VALUES ('betreiber', 'repowering', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(fullName, firma, email, telefon, plz, ort, strasse, mastr, kwp, baujahr, nachricht, ip, ua, referrer, matchedAnlageId);
        const leadId = Number(res.lastInsertRowid);
        // Notiz an Anlage haengen wenn Match
        if (matchedAnlageId) {
          try {
            const noteText = `📩 REPOWERING-CHECK #${leadId}\n${fullName}${firma ? " · " + firma : ""}\n${email}${telefon ? " · " + telefon : ""}\n`
              + (kwp ? `Leistung: ${kwp} kWp\n` : "")
              + (inbetriebnahme ? `Inbetriebnahme: ${inbetriebnahme}\n` : "")
              + (strasse ? `Adresse: ${strasse}, ${plz || ""} ${ort || ""}\n` : "")
              + (nachricht ? `\n${nachricht}` : "");
            db.prepare(`
              INSERT INTO notizen (anlage_id, betreiber_mastr, user_id, text, scope, created_at)
              VALUES (?, (SELECT betreiber_mastr FROM anlagen WHERE id = ?), NULL, ?, 'betreiber', CURRENT_TIMESTAMP)
            `).run(matchedAnlageId, matchedAnlageId, noteText);
          } catch (e) { log.error("public_check_note_failed", { leadId, error: String(e) }); }
        }
        // Notify Owner (wenn vorhanden) + alle Admins — per-recipient localized
        try {
          const recipientIds = new Set<number>();
          if (matchedOwnerId) recipientIds.add(matchedOwnerId);
          const admins = db.prepare(`SELECT id FROM users WHERE active = 1 AND (is_admin = 1 OR username = 'admin')`).all() as any[];
          for (const a of admins) recipientIds.add(a.id);
          for (const userId of recipientIds) {
            const u = db.prepare(`SELECT pref_locale FROM users WHERE id = ?`).get(userId) as any;
            const loc = u?.pref_locale || "de-DE";
            const titleKey = matchedAnlageId ? "notif.check_request_title_match" : "notif.check_request_title";
            const bodyText = [
              firma && `${tt(loc, "notif.field.firma")}: ${firma}`,
              email && `${tt(loc, "notif.field.email")}: ${email}`,
              telefon && `${tt(loc, "notif.field.phone")}: ${telefon}`,
              (plz || ort) && `${tt(loc, "notif.field.location")}: ${[plz, ort].filter(Boolean).join(" ")}`,
              kwp && `${tt(loc, "notif.field.power")}: ${kwp} kWp`,
              inbetriebnahme && `${tt(loc, "notif.field.commissioning")}: ${inbetriebnahme}`,
              mastr && `${tt(loc, "notif.field.mastr")}: ${mastr}`,
              nachricht && `\n${nachricht.slice(0, 300)}`,
            ].filter(Boolean).join("\n");
            void notify(db, {
              userId,
              type: "assignment",
              titleKey,
              titleArgs: { name: fullName },
              body: bodyText,
              anlageId: matchedAnlageId ?? undefined,
              url: matchedAnlageId ? `/?#anlage-${matchedAnlageId}` : `/?#leads`,
            }).catch(() => {});
          }
        } catch (e) { log.error("public_check_notify_failed", { leadId, error: String(e) }); }
        // Zoho-Weiterleitung — synchron mit Status-Tracking + Setting-Toggle
        const zohoResult = await forwardToZoho({
          vorname, nachname, email, telefon, firma, strasse, plz, ort, inbetriebnahme, kwp
        }, db);
        db.prepare(`
          UPDATE public_leads
          SET zoho_status = ?, zoho_http_code = ?, zoho_response = ?, zoho_attempted_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).run(zohoResult.status, zohoResult.httpCode, zohoResult.body?.slice(0, 500) || null, leadId);
        // === Bestätigungs-Mail an Kunden ===
        // Best-Effort: schlaegt's fehl, ist der Lead trotzdem gesichert
        try {
          const settings: Record<string, string> = {};
          for (const r of db.prepare("SELECT key, value FROM app_settings").all() as any[]) settings[r.key] = r.value || "";
          const firmaName = settings.firma_name || "Repowering DE";
          const firmaUrl = settings.firma_url || "https://repowering-de.de";
          const firmaUrlDisplay = firmaUrl.replace(/^https?:\/\//, "");
          // Admin-SMTP (User id=1 oder username='admin')
          const adminUser = db.prepare(`
            SELECT smtp_host, smtp_port, smtp_secure, smtp_user, smtp_pass_enc, smtp_from_name, smtp_from_email, email, display_name, phone
            FROM users WHERE username = 'admin' OR is_admin = 1
            ORDER BY id ASC LIMIT 1
          `).get() as any;
          if (adminUser && adminUser.smtp_host) {
            const anredeKurz = vorname && nachname ? `Sehr geehrte/r Frau/Herr ${nachname}` : "Sehr geehrte Damen und Herren";
            const summary = [
              `<tr><td style="padding:6px 12px;color:#6b7280;font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:0.4px;">Kontakt</td><td style="padding:6px 12px;color:#111827;font-size:14px;">${vorname} ${nachname}${firma ? " · " + firma : ""}</td></tr>`,
              `<tr><td style="padding:6px 12px;color:#6b7280;font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:0.4px;">E-Mail</td><td style="padding:6px 12px;color:#111827;font-size:14px;">${email}</td></tr>`,
              `<tr><td style="padding:6px 12px;color:#6b7280;font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:0.4px;">Telefon</td><td style="padding:6px 12px;color:#111827;font-size:14px;">${telefon}</td></tr>`,
              (plz || ort) ? `<tr><td style="padding:6px 12px;color:#6b7280;font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:0.4px;">Standort</td><td style="padding:6px 12px;color:#111827;font-size:14px;">${[strasse, [plz, ort].filter(Boolean).join(" ")].filter(Boolean).join(", ")}</td></tr>` : "",
              kwp ? `<tr><td style="padding:6px 12px;color:#6b7280;font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:0.4px;">Leistung</td><td style="padding:6px 12px;color:#111827;font-size:14px;">${kwp.toLocaleString("de-DE")} kWp</td></tr>` : "",
              inbetriebnahme ? `<tr><td style="padding:6px 12px;color:#6b7280;font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:0.4px;">Inbetriebnahme</td><td style="padding:6px 12px;color:#111827;font-size:14px;">${inbetriebnahme}</td></tr>` : "",
              mastr ? `<tr><td style="padding:6px 12px;color:#6b7280;font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:0.4px;">MaStR-Nr.</td><td style="padding:6px 12px;color:#111827;font-size:14px;font-family:monospace;">${mastr}</td></tr>` : "",
            ].filter(Boolean).join("");
            const confirmHtml = `<!DOCTYPE html><html lang="de"><body style="margin:0;padding:0;background:#f1f3f8;font-family:Roboto,Arial,sans-serif;">
<table cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#f1f3f8;padding:24px 0;"><tr><td align="center"><table cellpadding="0" cellspacing="0" border="0" width="100%" style="max-width:640px;background:#fff;border-radius:14px;overflow:hidden;box-shadow:0 8px 32px rgba(0,0,0,0.08);">
  <tr><td style="background:linear-gradient(135deg,#232F84 0%,#1a2566 100%);padding:32px 36px;">
    <div style="color:#fff;font-size:22px;font-weight:800;letter-spacing:0.4px;">✓ Anfrage erhalten</div>
    <div style="color:#FDB913;font-size:12px;font-weight:600;letter-spacing:1.5px;text-transform:uppercase;margin-top:4px;">Ticket: CHECK-${leadId}</div>
  </td></tr>
  <tr><td style="background:linear-gradient(90deg,#FDB913 0%,#FDB913 60%,#88D1D1 100%);height:4px;"></td></tr>
  <tr><td style="padding:34px 36px 24px 36px;">
    <p style="margin:0 0 16px 0;font-size:16px;font-weight:600;color:#232F84;">${anredeKurz},</p>
    <p style="margin:0 0 14px 0;font-size:15px;line-height:1.65;color:#1f2937;">vielen Dank für Ihre Anfrage über unseren <strong>Repowering-Check</strong>. Wir haben Ihre Daten erhalten und werden sie sorgfältig prüfen.</p>
    <p style="margin:0 0 14px 0;font-size:15px;line-height:1.65;color:#1f2937;">Ein Spezialist aus unserem Team meldet sich <strong>innerhalb von maximal 10 Werktagen</strong> persönlich bei Ihnen zurück — entweder per Telefon oder per E-Mail mit einer ersten Einschätzung zu Ihrer Anlage.</p>
    <div style="background:#f8fafc;border-left:3px solid #FDB913;padding:14px 18px;margin:20px 0;border-radius:0 6px 6px 0;">
      <div style="font-size:11px;font-weight:700;color:#232F84;letter-spacing:0.5px;text-transform:uppercase;margin-bottom:8px;">Ihre Anfrage im Überblick</div>
      <table cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:0;">${summary}</table>
    </div>
    ${nachricht ? `<div style="margin:18px 0;padding:14px 18px;background:#fef3c7;border-radius:6px;"><div style="font-size:11px;font-weight:700;color:#92400e;letter-spacing:0.5px;text-transform:uppercase;margin-bottom:6px;">Ihre Nachricht</div><div style="font-size:14px;color:#1f2937;white-space:pre-wrap;">${nachricht.replace(/</g,"&lt;").replace(/>/g,"&gt;")}</div></div>` : ""}
    <p style="margin:24px 0 0 0;font-size:14px;line-height:1.6;color:#6b7280;">Sollten Sie zwischenzeitlich Fragen haben oder Daten ergänzen wollen, antworten Sie einfach auf diese E-Mail.</p>
    <p style="margin:20px 0 4px 0;font-size:15px;line-height:1.6;color:#1f2937;">Beste Grüße</p>
    <p style="margin:6px 0 0 0;font-size:17px;font-weight:700;color:#232F84;">${adminUser.smtp_from_name || adminUser.display_name || firmaName}</p>
    <p style="margin:2px 0 0 0;font-size:12px;font-weight:600;color:#c8930a;letter-spacing:0.4px;text-transform:uppercase;">Repowering-Spezialist</p>
  </td></tr>
  <tr><td style="background:linear-gradient(135deg,#232F84 0%,#1a2566 100%);padding:22px 36px;color:#fff;font-size:12px;">
    <table cellpadding="0" cellspacing="0" border="0" width="100%"><tr>
      <td style="color:rgba(255,255,255,0.85);font-size:11px;">
        <strong style="color:#fff;font-size:13px;">${firmaName}</strong><br>
        ${settings.firma_adresse || ""}<br>
        <a href="${firmaUrl}" style="color:#FDB913;text-decoration:none;">${firmaUrlDisplay}</a> · <a href="${firmaUrl}/datenschutz" style="color:rgba(255,255,255,0.6);text-decoration:none;">Datenschutz</a> · <a href="${firmaUrl}/impressum" style="color:rgba(255,255,255,0.6);text-decoration:none;">Impressum</a>
      </td>
    </tr></table>
  </td></tr>
</table></td></tr></table></body></html>`;
            const transport = buildTransport(adminUser);
            const mailOpts = applyTestModeOverride(settings.test_mode_email || null, {
              from: fromAddress(adminUser),
              to: email,
              subject: `Ihre Repowering-Check Anfrage CHECK-${leadId} ist eingegangen`,
              html: confirmHtml,
            });
            await transport.sendMail(mailOpts);
            log.info("public_check_confirmation_sent", { leadId, to: email, testMode: !!settings.test_mode_email });
          }
        } catch (e) {
          log.error("public_check_confirmation_failed", { leadId, error: String(e) });
        }
        log.info("public_check_created", { leadId, mastrMatch: !!matchedAnlageId, hasOwner: !!matchedOwnerId, zohoStatus: zohoResult.status, ip });
        try { fireEvent(db, "anfrage.received", {
          lead_id: leadId,
          ticket: `CHECK-${leadId}`,
          interest: typeof body.interest === "string" ? body.interest : null,
          name, firma, email, telefon,
          plz, ort, strasse,
          mastr_nummer: mastr,
          anlagen_leistung_kwp: kwp,
          inbetriebnahme_jahr: baujahr,
          matched_anlage_id: matchedAnlageId,
          matched_owner_id: matchedOwnerId,
          zoho_status: zohoResult.status,
        }); } catch (e) { console.error("webhook fireEvent:", e); }
        return json({ success: true, ticket: `CHECK-${leadId}`, zoho: zohoResult.status });
      }

      // GET /api/public/check-prefill?t=TOKEN — Anlage-Daten fuer Pre-fill (signed Token)
      if (path === "/api/public/check-prefill" && method === "GET") {
        const token = url.searchParams.get("t");
        if (!token) return err("Token fehlt", 400);
        const verified = verifyCheckToken(token);
        if (!verified) return err("Token ungueltig oder abgelaufen", 401, { code: "INVALID_TOKEN" });
        const a = db.prepare(`
          SELECT a.id, a.mastr_nummer, a.name, a.plz, a.ort, a.strasse, a.bundesland,
            a.nettonennleistung, a.inbetriebnahme, a.betreiber_name,
            b.email as kontakt_email, b.telefon as kontakt_telefon
          FROM anlagen a
          LEFT JOIN betreiber b ON a.betreiber_mastr = b.mastr_nummer
          WHERE a.id = ?
        `).get(verified.anlageId) as any;
        if (!a) return err("Anlage nicht gefunden", 404);
        // Vorname/Nachname aus betreiber_name splitten (Best-Effort, nur wenn Person)
        const isFirma = /\b(GmbH|AG|UG|GbR|KG|OHG|e\.?V\.?|e\.?G\.?|Co\.?|mbH|SE)\b/i.test(a.betreiber_name || "");
        let vorname = "", nachname = "", firma = "";
        if (a.betreiber_name) {
          if (isFirma) {
            firma = a.betreiber_name;
          } else {
            const parts = a.betreiber_name.trim().split(/\s+/);
            if (parts.length >= 2) { vorname = parts[0]; nachname = parts.slice(1).join(" "); }
            else { nachname = a.betreiber_name; }
          }
        }
        return json({
          vorname, nachname, firma,
          email: a.kontakt_email || "",
          telefon: a.kontakt_telefon || "",
          strasse: a.strasse || "",
          plz: a.plz || "", ort: a.ort || "",
          inbetriebnahme: a.inbetriebnahme || "",
          kwp: a.nettonennleistung ? Math.round(a.nettonennleistung) : "",
          mastr_nummer: a.mastr_nummer || "",
          anlage_name: a.name || a.mastr_nummer || "",
        });
      }

      // POST /api/admin/leads/:id/zoho-retry — Zoho-Forward erneut versuchen
      const zohoRetryMatch = path.match(/^\/api\/admin\/leads\/(\d+)\/zoho-retry$/);
      if (zohoRetryMatch && method === "POST") {
        const auth = requireUser(req); if ("response" in auth) return auth.response;
        if (!auth.user.is_admin && auth.user.username !== "admin") return err("Nur Admin", 403);
        const id = parseInt(zohoRetryMatch[1]);
        const lead = db.prepare("SELECT * FROM public_leads WHERE id = ?").get(id) as any;
        if (!lead) return err("Lead nicht gefunden", 404);
        // Name in Vor- und Nachname splitten (best effort)
        const parts = (lead.name || "").trim().split(/\s+/);
        const vorname = parts[0] || "";
        const nachname = parts.slice(1).join(" ") || parts[0] || "";
        const inbetriebnahme = lead.inbetriebnahme_jahr ? String(lead.inbetriebnahme_jahr) + "-01-01" : null;
        const result = await forwardToZoho({
          vorname, nachname,
          email: lead.email, telefon: lead.telefon || "",
          firma: lead.firma, strasse: lead.strasse,
          plz: lead.plz, ort: lead.ort,
          inbetriebnahme, kwp: lead.anlagen_leistung_kwp,
        }, db);
        db.prepare(`
          UPDATE public_leads
          SET zoho_status = ?, zoho_http_code = ?, zoho_response = ?, zoho_attempted_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).run(result.status, result.httpCode, result.body?.slice(0, 500) || null, id);
        return json({ success: true, ...result });
      }

      // GET /api/leads — Admin-Liste der Public-Leads
      if (path === "/api/leads" && method === "GET") {
        const auth = requireUser(req); if ("response" in auth) return auth.response;
        if (isViewer(auth.user)) return err("Nicht erlaubt", 403, { code: "VIEWER_NOT_ALLOWED" });
        const status = url.searchParams.get("status") || "";
        const limit  = Math.min(500, Math.max(1, parseInt(url.searchParams.get("limit") || "100")));
        const rows = db.prepare(`
          SELECT l.*,
            a.name AS matched_anlage_name,
            a.ort  AS matched_anlage_ort,
            a.nettonennleistung AS matched_anlage_kw,
            u.username AS handled_by_username,
            u.display_name AS handled_by_display_name
          FROM public_leads l
          LEFT JOIN anlagen a ON l.matched_anlage_id = a.id
          LEFT JOIN users u   ON l.handled_by_user_id = u.id
          WHERE (? = '' OR l.status = ?)
          ORDER BY l.created_at DESC
          LIMIT ?
        `).all(status, status, limit);
        return json(rows);
      }

      // PATCH /api/leads/:id — Status aendern, Notizen-Hinweis, oder Assignment
      const leadPatchMatch = path.match(/^\/api\/leads\/(\d+)$/);
      if (leadPatchMatch && method === "PATCH") {
        const auth = requireUser(req); if ("response" in auth) return auth.response;
        if (isViewer(auth.user)) return err("Nicht erlaubt", 403, { code: "VIEWER_NOT_ALLOWED" });
        const id = parseInt(leadPatchMatch[1]);
        const b = (await req.json()) as any;
        const fields: string[] = [];
        const vals: any[] = [];
        if (typeof b.status === "string" && ["neu","kontaktiert","konvertiert","spam","abgelehnt"].includes(b.status)) {
          fields.push("status = ?"); vals.push(b.status);
          fields.push("handled_at = CURRENT_TIMESTAMP");
          fields.push("handled_by_user_id = ?"); vals.push(auth.user.id);
        }
        if (b.assigned_user_id !== undefined) {
          fields.push("assigned_user_id = ?"); vals.push(b.assigned_user_id ? parseInt(b.assigned_user_id) : null);
        }
        if (fields.length === 0) return err("Keine gueltigen Aenderungen", 400);
        vals.push(id);
        db.prepare(`UPDATE public_leads SET ${fields.join(", ")} WHERE id = ?`).run(...vals);
        return json({ success: true });
      }

      // POST /api/leads/:id/link — Lead manuell mit einer Anlage verknuepfen + Notiz schreiben
      const leadLinkMatch = path.match(/^\/api\/leads\/(\d+)\/link$/);
      if (leadLinkMatch && method === "POST") {
        const auth = requireUser(req); if ("response" in auth) return auth.response;
        if (isViewer(auth.user)) return err("Nicht erlaubt", 403, { code: "VIEWER_NOT_ALLOWED" });
        const id = parseInt(leadLinkMatch[1]);
        const b = (await req.json()) as any;
        const anlageId = parseInt(b.anlage_id);
        if (!anlageId) return err("anlage_id fehlt", 400);

        const lead = db.prepare("SELECT * FROM public_leads WHERE id = ?").get(id) as any;
        if (!lead) return err("Lead nicht gefunden", 404);
        const anlage = db.prepare("SELECT id, betreiber_mastr FROM anlagen WHERE id = ?").get(anlageId) as any;
        if (!anlage) return err("Anlage nicht gefunden", 404);

        db.prepare(`
          UPDATE public_leads
          SET matched_anlage_id = ?, status = CASE WHEN status = 'neu' THEN 'kontaktiert' ELSE status END,
              handled_at = CURRENT_TIMESTAMP, handled_by_user_id = ?
          WHERE id = ?
        `).run(anlageId, auth.user.id, id);

        const noteText = `📩 PUBLIC-LEAD #${id} (${lead.lead_type === "partner" ? "Partner" : "Anlagenbetreiber"}) — manuell verknuepft von ${auth.user.display_name || auth.user.username}\n`
          + `${lead.name}${lead.firma ? " · " + lead.firma : ""}\n`
          + `${lead.email}${lead.telefon ? " · " + lead.telefon : ""}\n`
          + (lead.interest ? `Interesse: ${lead.interest}\n` : "")
          + (lead.nachricht ? `\n${lead.nachricht}` : "");
        try {
          db.prepare(`
            INSERT INTO notizen (anlage_id, betreiber_mastr, user_id, text, scope, created_at)
            VALUES (?, ?, ?, ?, 'betreiber', CURRENT_TIMESTAMP)
          `).run(anlageId, anlage.betreiber_mastr || null, auth.user.id, noteText);
        } catch (e) {
          log.error("public_lead_link_note_failed", { leadId: id, error: String(e) });
        }
        return json({ success: true, anlage_id: anlageId });
      }

      // GET /api/leads/search-anlagen?q= — Anlagen-Suche fuer Lead-Verknuepfung (lightweight)
      if (path === "/api/leads/search-anlagen" && method === "GET") {
        const auth = requireUser(req); if ("response" in auth) return auth.response;
        if (isViewer(auth.user)) return err("Nicht erlaubt", 403, { code: "VIEWER_NOT_ALLOWED" });
        const q = (url.searchParams.get("q") || "").trim().toLowerCase();
        if (q.length < 2) return json([]);
        const like = `%${q}%`;
        const rows = db.prepare(`
          SELECT id, mastr_nummer, name, betreiber_name, plz, ort, bundesland, nettonennleistung, inbetriebnahme
          FROM anlagen
          WHERE LOWER(name) LIKE ? OR LOWER(betreiber_name) LIKE ?
             OR plz LIKE ? OR LOWER(ort) LIKE ? OR LOWER(mastr_nummer) LIKE ?
          ORDER BY nettonennleistung DESC
          LIMIT 25
        `).all(like, like, like, like, like);
        return json(rows);
      }

      // GET /api/admin/backup-status — Liest /opt/mastr-solar/data/.backup-status.json
      // + zaehlt Backup-Files + meldet Alter des juengsten. Admin-only.
      // ===== ADMIN-SICHT auf User-Verlauf =====
      // Gleiche Semantik wie /api/me/activity, aber Admin kann beliebigen User abfragen.
      // Nur is_admin/admin. Audit-Eintrag bei jedem Lookup.
      const adminUserActivityMatch = path.match(/^\/api\/admin\/users\/(\d+)\/activity$/);
      if (adminUserActivityMatch && method === "GET") {
        const auth = requireAdmin(req); if ("response" in auth) return auth.response;
        const targetUid = parseInt(adminUserActivityMatch[1], 10);
        if (!targetUid || isNaN(targetUid)) return err("ungueltige user_id");
        const targetUser = db.prepare("SELECT id, username, display_name FROM users WHERE id = ?").get(targetUid) as any;
        if (!targetUser) return err("User nicht gefunden", 404);
        const kind = (url.searchParams.get("kind") || "all").toLowerCase();
        const typeFilter = url.searchParams.get("type") || "";
        const q = (url.searchParams.get("q") || "").trim();
        const from = url.searchParams.get("from") || "";
        const to = url.searchParams.get("to") || "";
        const limit = Math.min(200, Math.max(1, parseInt(url.searchParams.get("limit") || "50", 10) || 50));
        const offset = Math.max(0, parseInt(url.searchParams.get("offset") || "0", 10) || 0);
        const uid = targetUid;
        const rows: any[] = [];
        if (kind === "all" || kind === "activity") {
          const where: string[] = ["a.user_id = ?"]; const params: any[] = [uid];
          if (typeFilter) { where.push("a.type = ?"); params.push(typeFilter); }
          if (from) { where.push("a.created_at >= ?"); params.push(from); }
          if (to)   { where.push("a.created_at <= ?"); params.push(to); }
          if (q)    { where.push("(a.description LIKE ? OR an.mastr_nummer LIKE ? OR an.adresse LIKE ?)");
                     params.push("%"+q+"%","%"+q+"%","%"+q+"%"); }
          const r = db.prepare(`
            SELECT a.id, a.type, a.description, a.created_at, a.anlage_id,
                   an.mastr_nummer, an.adresse, an.eigentuemer_name
            FROM activities a LEFT JOIN anlagen an ON an.id = a.anlage_id
            WHERE ${where.join(" AND ")}
            ORDER BY a.created_at DESC LIMIT 500
          `).all(...params) as any[];
          for (const x of r) rows.push({
            id: "a" + x.id, kind: "activity", type: x.type, description: x.description || "",
            anlage_id: x.anlage_id,
            anlage_label: x.mastr_nummer ? `${x.eigentuemer_name || ""} (${x.mastr_nummer})`.trim() : null,
            anlage_adresse: x.adresse || null,
            target_user_id: null, target_user_name: null, from_user_id: null, from_user_name: null,
            created_at: x.created_at,
          });
        }
        if (kind === "all" || kind === "mention") {
          const where: string[] = ["n.from_user_id = ?", "n.type IN ('mention','comment')"]; const params: any[] = [uid];
          if (from) { where.push("n.created_at >= ?"); params.push(from); }
          if (to)   { where.push("n.created_at <= ?"); params.push(to); }
          if (q)    { where.push("(n.title LIKE ? OR n.body LIKE ? OR u.username LIKE ?)"); params.push("%"+q+"%","%"+q+"%","%"+q+"%"); }
          const r = db.prepare(`
            SELECT n.id, n.type, n.title, n.body, n.anlage_id, n.created_at,
                   n.user_id as target_user_id, u.username as target_username, u.display_name as target_display_name,
                   an.mastr_nummer, an.adresse, an.eigentuemer_name
            FROM notifications n
            LEFT JOIN users u ON u.id = n.user_id
            LEFT JOIN anlagen an ON an.id = n.anlage_id
            WHERE ${where.join(" AND ")}
            ORDER BY n.created_at DESC LIMIT 500
          `).all(...params) as any[];
          for (const x of r) rows.push({
            id: "m" + x.id, kind: "mention", type: x.type,
            description: x.body || x.title || "",
            anlage_id: x.anlage_id,
            anlage_label: x.mastr_nummer ? `${x.eigentuemer_name || ""} (${x.mastr_nummer})`.trim() : null,
            anlage_adresse: x.adresse || null,
            target_user_id: x.target_user_id,
            target_user_name: x.target_display_name || x.target_username || null,
            from_user_id: null, from_user_name: null,
            created_at: x.created_at,
          });
        }
        rows.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
        const total = rows.length;
        const page = rows.slice(offset, offset + limit);
        logAudit(db, auth.user.id, auth.user.username, "user_activity_viewed", "user", targetUid, `target=${targetUser.username}`);
        return json({
          items: page, total, limit, offset,
          target_user: { id: targetUser.id, username: targetUser.username, display_name: targetUser.display_name },
        });
      }

      // Migrations-Status (welche Schema-Migrationen wurden wann angewendet)
      if (path === "/api/admin/migrations" && method === "GET") {
        const auth = requireAdmin(req); if ("response" in auth) return auth.response;
        return json({ migrations: migrationStatus(db) });
      }

      if (path === "/api/admin/backup-status" && method === "GET") {
        const auth = requireUser(req); if ("response" in auth) return auth.response;
        if (auth.user.is_admin !== 1 && auth.user.username !== "admin") {
          return err("Nur Admin", 403, { code: "ADMIN_ONLY" });
        }
        const statusFile = process.env.BACKUP_STATUS_FILE || "/opt/mastr-solar/data/.backup-status.json";
        const backupDir = process.env.BACKUP_DIR || "/opt/mastr-solar/backups";
        let statusJson: any = null;
        try {
          const f = file(statusFile);
          if (await f.exists()) statusJson = JSON.parse(await f.text());
        } catch {}
        // File-Liste + Alter des juengsten
        let backupCount = 0, weeklyCount = 0, newestMtime = 0, totalBytes = 0;
        try {
          const fs = await import("node:fs/promises");
          const path_mod = await import("node:path");
          const entries = await fs.readdir(backupDir);
          for (const name of entries) {
            if (!name.startsWith("mastr-solar_") || !name.includes(".db.gz")) continue;
            const full = path_mod.join(backupDir, name);
            const st = await fs.stat(full);
            totalBytes += st.size;
            if (name.includes("_weekly")) weeklyCount++; else backupCount++;
            if (st.mtimeMs > newestMtime) newestMtime = st.mtimeMs;
          }
        } catch {}
        const ageHours = newestMtime ? Math.round((Date.now() - newestMtime) / 3_600_000) : null;
        const healthy = statusJson?.status === "ok" && ageHours !== null && ageHours < 30;
        return json({
          healthy,
          status: statusJson?.status || "unknown",
          message: statusJson?.message || (newestMtime ? "Status-Datei fehlt, aber Backups vorhanden" : "Keine Backups gefunden"),
          last_backup_iso: statusJson?.finished_at || (newestMtime ? new Date(newestMtime).toISOString() : null),
          last_backup_age_hours: ageHours,
          last_file: statusJson?.file || null,
          last_size_bytes: statusJson?.size_bytes || null,
          offsite: statusJson?.offsite || "not_configured",
          backup_count: backupCount,
          weekly_count: weeklyCount,
          total_bytes: totalBytes,
          retention_days: statusJson?.retention_days || null,
        });
      }

      // GET /api/leads/stats — Counter fuer Dashboard-Widget
      if (path === "/api/leads/stats" && method === "GET") {
        const auth = requireUser(req); if ("response" in auth) return auth.response;
        if (isViewer(auth.user)) return json({ neu: 0, gesamt: 0 });
        const row = db.prepare(`
          SELECT
            SUM(CASE WHEN status = 'neu' THEN 1 ELSE 0 END) AS neu,
            COUNT(*) AS gesamt
          FROM public_leads
        `).get() as any;
        return json({ neu: row?.neu || 0, gesamt: row?.gesamt || 0 });
      }

      // 404 — fuer Browser-Requests die schoene HTML-Seite, fuer API-Calls JSON
      const accept = req.headers.get("accept") || "";
      const isApi = path.startsWith("/api/") || accept.includes("application/json");
      if (isApi || method !== "GET") {
        return new Response("Not Found", { status: 404 });
      }
      try {
        let html = await file("static/404.html").text();
        const settings = getAppSettings(db) as any;
        html = html.replace(/{{firma_name}}/g, settings.firma_name || "Repowering DE");
        html = html.replace(/{{firma_email}}/g, settings.firma_email || "info@repowering-de.de");
        return new Response(html, {
          status: 404,
          headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" },
        });
      } catch {
        return new Response("Not Found", { status: 404 });
      }
      })();
    } catch (e: any) {
      caughtError = e;
      errorMessage = e?.message || String(e);
      stackTrace = e?.stack || null;
      log.error("request_failed", { method, path, error: errorMessage });
      resp = err(errorMessage || "Serverfehler", 500);
    }
    // Idempotency-Store: erfolgreiche/nicht-server-fehler Responses cachen
    if (idempotencyKey && !idempotencyHit && resp && idempotencyBody !== null && resp.status < 500 && resp.status !== 401 && resp.status !== 429) {
      try {
        const u = getUser(req);
        const tokenId = (u as any)?._api_token_id ?? null;
        const userId = u?.id ?? null;
        const cloneForStore = resp.clone();
        const bodyText = await cloneForStore.text();
        idempotencyStore(db, idempotencyKey, tokenId, userId, method, path, idempotencyBody, resp.status, bodyText);
      } catch (e) {
        log.warn("idempotency_store_failed", { error: String(e) });
      }
    }

    // P2-27: CORS-Header — bewusste Whitelist von Origins.
    // Default: kein CORS (eigene UI nutzt same-origin). Bei Bedarf hier Origins ergaenzen.
    // Fuer Token-based-API: Browser-Clients sind sowieso nicht ideal (Token im JS = Leak-Risiko),
    // daher konservativ. Wenn ein Partner einen Browser-Client betreiben will, hier hinzufuegen.
    const origin = req.headers.get("origin");
    const ALLOWED_ORIGINS = [
      "https://mastr-solar.51.195.86.119.nip.io",
    ];
    if (origin && ALLOWED_ORIGINS.includes(origin)) {
      const corsHeaders = new Headers(resp.headers);
      corsHeaders.set("Access-Control-Allow-Origin", origin);
      corsHeaders.set("Access-Control-Allow-Credentials", "true");
      corsHeaders.set("Access-Control-Allow-Headers", "Authorization, Content-Type");
      corsHeaders.set("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
      corsHeaders.set("Access-Control-Max-Age", "86400");
      corsHeaders.set("Vary", "Origin");
      resp = new Response(resp.body, { status: resp.status, headers: corsHeaders });
    }
    // OPTIONS-Preflight ohne Body
    if (method === "OPTIONS" && origin && ALLOWED_ORIGINS.includes(origin)) {
      resp = new Response(null, { status: 204, headers: resp.headers });
    }

    // === Audit-Logging: jeder /api/* + /docs/* Request wird festgehalten ===
    // /static, /favicon, leere Wurzelaufrufe ueberspringen, sonst floodet die DB.
    if (path.startsWith("/api/") || path.startsWith("/docs/")) {
      try {
        const u = getUser(req);
        const tokenId = (u as any)?._api_token_id ?? null;
        const authType: "token" | "cookie" | "public" | "none" =
          u && (u as any)._api_token ? "token" :
          u ? "cookie" :
          isPublic(path) ? "public" : "none";
        const cl = resp.headers.get("content-length");
        const responseSize = cl ? parseInt(cl) : null;
        // Bei Fehlerstatus den Response-Body als error_message capturen (max 500 Zeichen)
        let errMsg = errorMessage;
        if (!errMsg && resp.status >= 400) {
          try {
            const clone = resp.clone();
            const text = await clone.text();
            errMsg = text.slice(0, 500) || null;
          } catch {}
        }
        logApiRequest(db, {
          method, path,
          query: url.search ? url.search.slice(1) : null,
          status: resp.status,
          ip, userAgent: ua,
          durationMs: Date.now() - t0,
          responseSize: isNaN(responseSize as any) ? null : responseSize,
          errorMessage: errMsg,
          tokenId,
          userId: u?.id ?? null,
          authType,
          stack: stackTrace,
          requestBody: null, // Body lesen wuerde Stream konsumieren — bewusst ausgelassen
        });
      } catch (e) {
        console.error("[audit] log failed:", e);
      }
    }

    // API-Version-Header in jede /api/-Response setzen
    if (apiV && resp) {
      try {
        const newHeaders = new Headers(resp.headers);
        newHeaders.set("API-Version", apiV.version);
        if (apiV.warning) newHeaders.set("Warning", `299 - "${apiV.warning}"`);
        resp = new Response(resp.body, { status: resp.status, statusText: resp.statusText, headers: newHeaders });
      } catch {}
    }
    return resp;
}

console.log(`Server: http://localhost:${server.port}`);

// Token-Usage Batch-Flush (alle 30s) + Retention Cron (taeglich)
startTokenUsageFlush(db, 30_000);

// Retention (P2-26): resolved bugs > 90 Tage loeschen, request_log > 30 Tage loeschen
setInterval(() => {
  try {
    const cutoffLog = new Date(Date.now() - 30 * 86400_000).toISOString();
    const cutoffBugs = new Date(Date.now() - 90 * 86400_000).toISOString();
    const r1 = db.prepare("DELETE FROM api_request_log WHERE created_at < ?").run(cutoffLog);
    const r2 = db.prepare("DELETE FROM api_bug_log WHERE resolved_at IS NOT NULL AND resolved_at < ?").run(cutoffBugs);
    const r3 = cleanupIdempotency(db);
    if (r1.changes || r2.changes || r3) console.log(`[retention] cleared ${r1.changes} req-logs, ${r2.changes} resolved bugs, ${r3} idempotency entries`);
  } catch (e) { console.error("[retention] failed:", e); }
}, 24 * 3600_000);
