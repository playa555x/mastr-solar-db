import { Database } from "bun:sqlite";
import { join, dirname } from "path";
import { existsSync, mkdirSync } from "fs";
import { initSchema } from "../lib/db-init";
import { initMasterKey } from "../lib/crypto";
import { tickBulk } from "../lib/bulk-runner";

const DB_PATH = process.env.DB_PATH || "mastr-solar.db";
const DATA_DIR = process.env.DATA_DIR || (DB_PATH === "mastr-solar.db" ? "./data" : dirname(DB_PATH));
const MASTER_KEY_PATH = process.env.MASTER_KEY_PATH || join(DATA_DIR, ".master.key");
const MAX_PER_TICK = parseInt(process.env.BULK_MAX_PER_TICK || "30", 10);

if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

initMasterKey(MASTER_KEY_PATH);
const db = new Database(DB_PATH);
initSchema(db);

const start = Date.now();
try {
  const stats = await tickBulk(db, { maxPerTick: MAX_PER_TICK });
  console.log(`[${new Date().toISOString()}] Bulk-Tick: processed=${stats.processed} sent=${stats.sent} failed=${stats.failed} (${Date.now()-start}ms)`);
} catch (e) {
  console.error("Bulk-Tick-Fehler:", e);
  process.exitCode = 1;
} finally {
  db.close();
}
