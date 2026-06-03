import { Database } from "bun:sqlite";
import { join, dirname } from "path";
import { existsSync, mkdirSync, readFileSync, unlinkSync } from "fs";
import { initSchema } from "../lib/db-init";
import { initMasterKey } from "../lib/crypto";
import { enrichBatch } from "../lib/mastr-enricher";

const DB_PATH = process.env.DB_PATH || "mastr-solar.db";
const DATA_DIR = process.env.DATA_DIR || (DB_PATH === "mastr-solar.db" ? "./data" : dirname(DB_PATH));
const MASTER_KEY_PATH = process.env.MASTER_KEY_PATH || join(DATA_DIR, ".master.key");

// Args aus JSON-File (geschrieben vom server.ts vor systemctl start) > ENV > Defaults
const ARGS_FILE = join(DATA_DIR, "enrich-args.json");
let fileArgs: { limit?: number; rate_ms?: number; concurrency?: number; bundesland?: string | null } = {};
if (existsSync(ARGS_FILE)) {
  try {
    fileArgs = JSON.parse(readFileSync(ARGS_FILE, "utf8"));
    console.log(`Args aus File: ${JSON.stringify(fileArgs)}`);
    try { unlinkSync(ARGS_FILE); } catch {}
  } catch (e) {
    console.error("ARGS_FILE-Parse-Fehler:", e);
  }
}

const LIMIT = fileArgs.limit ?? parseInt(process.env.ENRICH_LIMIT || "5000", 10);
const RATE_MS = fileArgs.rate_ms ?? parseInt(process.env.ENRICH_RATE_MS || "600", 10);
const CONCURRENCY = fileArgs.concurrency ?? parseInt(process.env.ENRICH_CONCURRENCY || "5", 10);
const BUNDESLAND = fileArgs.bundesland ?? process.env.ENRICH_BUNDESLAND ?? null;
const SOURCE = process.env.ENRICH_SOURCE || "manual";

if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

initMasterKey(MASTER_KEY_PATH);
const db = new Database(DB_PATH);
initSchema(db);

// Stelle sicher dass enrich_log existiert
db.run(`
  CREATE TABLE IF NOT EXISTS enrich_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at TEXT DEFAULT CURRENT_TIMESTAMP,
    finished_at TEXT,
    source TEXT,
    status TEXT,
    total INTEGER DEFAULT 0,
    processed INTEGER DEFAULT 0,
    ok INTEGER DEFAULT 0,
    not_found INTEGER DEFAULT 0,
    no_data INTEGER DEFAULT 0,
    error_count INTEGER DEFAULT 0,
    with_email INTEGER DEFAULT 0,
    with_phone INTEGER DEFAULT 0,
    error_message TEXT,
    duration_ms INTEGER
  )
`);

const startedAt = Date.now();
const ins = db.prepare(`INSERT INTO enrich_log (source, status) VALUES (?, 'running')`).run(SOURCE);
const logId = ins.lastInsertRowid as number;

function update(extra: Record<string, any>) {
  const fields = Object.keys(extra).map((k) => `${k} = ?`).join(", ");
  const values = [...Object.values(extra), logId];
  db.prepare(`UPDATE enrich_log SET ${fields} WHERE id = ?`).run(...values);
}

let lastUpdate = 0;

try {
  console.log(`[${new Date().toISOString()}] Anreicherung gestartet (limit=${LIMIT}, rate=${RATE_MS}ms, concurrency=${CONCURRENCY}, bundesland=${BUNDESLAND || "alle"})`);

  const stats = await enrichBatch(db, {
    limit: LIMIT,
    rateLimitMs: RATE_MS,
    concurrency: CONCURRENCY,
    bundesland: BUNDESLAND,
    onlyMissing: true,
    onProgress: (s, current) => {
      const now = Date.now();
      // Live-Update der DB-Stats alle 5 Sekunden
      if (now - lastUpdate > 5000) {
        update({
          total: s.total,
          processed: s.processed,
          ok: s.ok,
          not_found: s.not_found,
          no_data: s.no_data,
          error_count: s.error,
          with_email: s.with_email,
          with_phone: s.with_phone,
        });
        lastUpdate = now;
        const pct = s.total ? ((s.processed / s.total) * 100).toFixed(1) : "0";
        console.log(`  ${s.processed}/${s.total} (${pct}%) ok=${s.ok} email=${s.with_email} tel=${s.with_phone} err=${s.error}`);
      }
    },
  });

  update({
    status: "success",
    finished_at: new Date().toISOString().replace("T", " ").substring(0, 19),
    duration_ms: Date.now() - startedAt,
    total: stats.total,
    processed: stats.processed,
    ok: stats.ok,
    not_found: stats.not_found,
    no_data: stats.no_data,
    error_count: stats.error,
    with_email: stats.with_email,
    with_phone: stats.with_phone,
  });

  console.log(`[${new Date().toISOString()}] Fertig: ${stats.ok} OK, ${stats.with_email} mit Email, ${stats.with_phone} mit Tel, ${stats.error} Fehler in ${(Date.now() - startedAt) / 1000}s`);
} catch (e: any) {
  console.error(`[${new Date().toISOString()}] Fehler:`, e);
  update({
    status: "failed",
    finished_at: new Date().toISOString().replace("T", " ").substring(0, 19),
    duration_ms: Date.now() - startedAt,
    error_message: (e?.message || String(e)).substring(0, 1000),
  });
  process.exitCode = 1;
} finally {
  db.close();
}
