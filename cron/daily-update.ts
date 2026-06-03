import { Database } from "bun:sqlite";
import { join, dirname } from "path";
import { existsSync, mkdirSync } from "fs";
import { initSchema } from "../lib/db-init";
import { initMasterKey } from "../lib/crypto";
import { downloadMastrZip, cleanupZip } from "../lib/mastr-zip-downloader";
import { importMastrZip } from "../lib/mastr-importer";

const DB_PATH = process.env.DB_PATH || "mastr-solar.db";
const DATA_DIR = process.env.DATA_DIR || (DB_PATH === "mastr-solar.db" ? "./data" : dirname(DB_PATH));
const MASTER_KEY_PATH = process.env.MASTER_KEY_PATH || join(DATA_DIR, ".master.key");
const SOURCE = process.env.IMPORT_SOURCE || "daily";
// ZIP-Downloads liegen NICHT in /tmp (tmpfs, oft zu klein fuer 2-3 GB MaStR-ZIP),
// sondern auf der echten Disk in DATA_DIR/import-tmp/. Override via $IMPORT_TMP_DIR.
const IMPORT_TMP_DIR = process.env.IMPORT_TMP_DIR || join(DATA_DIR, "import-tmp");

if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
if (!existsSync(IMPORT_TMP_DIR)) mkdirSync(IMPORT_TMP_DIR, { recursive: true });

initMasterKey(MASTER_KEY_PATH);
const db = new Database(DB_PATH);
// WAL-Modus + busy_timeout: Importer und HTTP-Server teilen sich die DB. Ohne diese
// Pragmas knallt der Import mit "SQLITE_BUSY: database is locked" sobald der Server
// gleichzeitig schreibt (Notes, Status-Changes etc.). 60s Wartezeit reicht weit.
db.prepare("PRAGMA journal_mode = WAL").run();
db.prepare("PRAGMA busy_timeout = 60000").run();
db.prepare("PRAGMA synchronous = NORMAL").run();
initSchema(db);

const startedAt = Date.now();

// Startup-Cleanup: Frühere Läufe die hart starben (OOM, SIGKILL, oder finalize() crashte
// selbst mit SQLITE_BUSY) hinterlassen eine ewig "running"-markierte Zeile.
// Beim Start dieses Jobs als "abandoned" abschliessen, damit das Dashboard sauber bleibt.
// Nur Zeilen die ALT genug sind (>30 min), damit wir keinen evtl. parallel laufenden
// Job versehentlich als failed markieren.
const cleaned = db.prepare(`
  UPDATE import_log
  SET status = 'failed',
      finished_at = CURRENT_TIMESTAMP,
      error_message = COALESCE(error_message, 'Abgebrochen - vorheriger Lauf hinterliess stale running-Zeile')
  WHERE status = 'running'
    AND finished_at IS NULL
    AND started_at < datetime('now', '-30 minutes')
`).run();
if (cleaned.changes > 0) {
  console.log(`Startup-Cleanup: ${cleaned.changes} alte "running"-Zeile(n) als failed markiert`);
}

const logRow = db.prepare(`
  INSERT INTO import_log (source, status) VALUES (?, 'running')
`).run(SOURCE);
const logId = logRow.lastInsertRowid as number;

function finalize(status: "success" | "failed", extra: Record<string, any>) {
  const fields = ["status = ?", "finished_at = CURRENT_TIMESTAMP", "duration_ms = ?"];
  const vals: any[] = [status, Date.now() - startedAt];
  for (const [k, v] of Object.entries(extra)) {
    fields.push(`${k} = ?`);
    vals.push(v);
  }
  vals.push(logId);
  db.prepare(`UPDATE import_log SET ${fields.join(", ")} WHERE id = ?`).run(...vals);
}

let zipPath: string | null = null;

try {
  console.log(`[${new Date().toISOString()}] Import gestartet (source=${SOURCE})`);
  console.log(`DB: ${DB_PATH}`);

  console.log(`Lade ZIP von marktstammdatenregister.de nach ${IMPORT_TMP_DIR} ...`);
  const dl = await downloadMastrZip({
    destDir: IMPORT_TMP_DIR,
    onProgress: (recv, total) => {
      const pct = total ? ((recv / total) * 100).toFixed(1) : "?";
      const mb = (recv / 1024 / 1024).toFixed(0);
      console.log(`  ZIP: ${mb} MB (${pct}%)`);
    },
  });
  zipPath = dl.path;
  console.log(`ZIP geladen: ${dl.path} (${(dl.sizeBytes / 1024 / 1024).toFixed(0)} MB)`);

  db.prepare("UPDATE import_log SET zip_url = ?, zip_size_bytes = ? WHERE id = ?")
    .run(dl.url, dl.sizeBytes, logId);

  console.log("Streamt XML und importiert ...");
  const stats = await importMastrZip(db, zipPath, (msg) => {
    console.log(`  ${msg}`);
  });

  console.log(`Fertig: anlagen+${stats.anlagen_inserted} skipped=${stats.anlagen_skipped} betreiber+${stats.betreiber_inserted}`);
  console.log(`Dateien: ${stats.files_processed.join(", ")}`);

  finalize("success", {
    anlagen_inserted: stats.anlagen_inserted,
    anlagen_updated: stats.anlagen_updated,
    anlagen_skipped: stats.anlagen_skipped,
    betreiber_inserted: stats.betreiber_inserted,
    betreiber_updated: stats.betreiber_updated,
  });

  console.log(`[${new Date().toISOString()}] Import abgeschlossen in ${(Date.now() - startedAt) / 1000}s`);
} catch (e: any) {
  console.error(`[${new Date().toISOString()}] Import-Fehler:`, e);
  finalize("failed", { error_message: (e?.message || String(e)).substring(0, 1000) });
  process.exitCode = 1;
} finally {
  if (zipPath) cleanupZip(zipPath);
  db.close();
}
