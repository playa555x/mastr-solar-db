import { Database } from "bun:sqlite";
import { join, dirname } from "path";
import { existsSync, mkdirSync } from "fs";
import { initSchema } from "../lib/db-init";
import { initMasterKey } from "../lib/crypto";
import { tickImapAll } from "../lib/imap-poller";

const DB_PATH = process.env.DB_PATH || "mastr-solar.db";
const DATA_DIR = process.env.DATA_DIR || (DB_PATH === "mastr-solar.db" ? "./data" : dirname(DB_PATH));
const MASTER_KEY_PATH = process.env.MASTER_KEY_PATH || join(DATA_DIR, ".master.key");

if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

initMasterKey(MASTER_KEY_PATH);
const db = new Database(DB_PATH);
initSchema(db);

const start = Date.now();
try {
  await tickImapAll(db, { maxFetchPerUser: 50 });
  console.log(`[${new Date().toISOString()}] IMAP-Tick fertig (${Date.now() - start}ms)`);
} catch (e) {
  console.error("IMAP-Tick-Fehler:", e);
  process.exitCode = 1;
} finally {
  db.close();
}
