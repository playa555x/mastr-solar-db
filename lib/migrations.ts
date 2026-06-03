// Lineares Migrations-System.
// Jede Migration hat eine eindeutige ID (string) und eine Up-Funktion.
// Angewendete IDs werden in `schema_migrations` gespeichert. Beim Start wird
// jede unangewendete Migration in Reihenfolge ausgeführt — idempotent.
//
// Neue Migrations: am ENDE der `MIGRATIONS`-Array anfügen, NIE bestehende ändern.
//
// Die existierenden `ensure*`-Funktionen aus lib/ werden hier zentral aufgerufen,
// damit der Schema-Stand reproduzierbar dokumentiert ist (Single-Source-of-Truth).
// Sie sind selbst idempotent, also kein Risiko bei Re-Run.

import type { Database } from "bun:sqlite";
import { ensureWebhookTables } from "./webhooks";
import { ensurePasswordResetTable } from "./password-reset";
import { ensureIdempotencyTtlColumn } from "./idempotency";
import { ensureIpWhitelistColumn, ensureSandboxColumn } from "./integration-auth";
import { ensureTelegramOffsetColumn } from "./telegram-commands";
import { ensureSignatureColumns } from "./signatures";
import { ensureTranslationsTable } from "./translator";

export interface Migration {
  id: string;
  name: string;
  up: (db: Database) => void;
}

function ensureSchemaTable(db: Database): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);
}

// Reihenfolge ist verbindlich. Neue Migrations IMMER am Ende einfügen.
export const MIGRATIONS: Migration[] = [
  {
    id: "2026-05-17_translations_cache",
    name: "Übersetzungs-Cache-Tabelle",
    up: (db) => ensureTranslationsTable(db),
  },
  {
    id: "2026-06-02_webhooks",
    name: "Outgoing-Webhooks (webhooks + webhook_deliveries)",
    up: (db) => ensureWebhookTables(db),
  },
  {
    id: "2026-06-02_password_resets",
    name: "Self-Service-Passwort-Reset (password_resets)",
    up: (db) => ensurePasswordResetTable(db),
  },
  {
    id: "2026-06-02_idempotency_ttl",
    name: "api_tokens.idempotency_ttl_minutes",
    up: (db) => ensureIdempotencyTtlColumn(db),
  },
  {
    id: "2026-06-02_ip_whitelist",
    name: "api_tokens.ip_whitelist",
    up: (db) => ensureIpWhitelistColumn(db),
  },
  {
    id: "2026-06-02_signatures_i18n",
    name: "users.signature_html_en + signature_html_fr",
    up: (db) => ensureSignatureColumns(db),
  },
  {
    id: "2026-06-03_sandbox_tokens",
    name: "api_tokens.is_sandbox (Sandbox-Token mit Write-NoOp)",
    up: (db) => ensureSandboxColumn(db),
  },
  {
    id: "2026-06-03_telegram_offset",
    name: "users.telegram_last_update_id (Bot-Command-Cursor)",
    up: (db) => ensureTelegramOffsetColumn(db),
  },
];

/**
 * Wendet alle noch nicht angewendeten Migrationen an.
 * Liefert die IDs der frisch angewendeten Migrationen.
 */
export function runMigrations(db: Database): string[] {
  ensureSchemaTable(db);
  const applied = new Set(
    (db.prepare("SELECT id FROM schema_migrations").all() as any[]).map((r) => r.id),
  );
  const fresh: string[] = [];
  for (const m of MIGRATIONS) {
    if (applied.has(m.id)) continue;
    try {
      m.up(db);
      db.prepare("INSERT INTO schema_migrations (id, name) VALUES (?, ?)").run(m.id, m.name);
      fresh.push(m.id);
      console.log(`[migrations] ✓ applied: ${m.id} (${m.name})`);
    } catch (e) {
      console.error(`[migrations] ✗ FAILED: ${m.id}`, e);
      throw e;
    }
  }
  return fresh;
}

/**
 * Diagnostik: liefert applied/pending pro Migration.
 */
export function migrationStatus(db: Database): { id: string; name: string; applied: boolean; applied_at: string | null }[] {
  ensureSchemaTable(db);
  const applied = new Map<string, string>();
  for (const r of db.prepare("SELECT id, applied_at FROM schema_migrations").all() as any[]) {
    applied.set(r.id, r.applied_at);
  }
  return MIGRATIONS.map((m) => ({
    id: m.id,
    name: m.name,
    applied: applied.has(m.id),
    applied_at: applied.get(m.id) || null,
  }));
}
