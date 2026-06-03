// Telegram-Command-Listener — pollt alle 30s über alle User mit konfiguriertem Bot.
// Aufruf: systemd-timer / cron / `bun cron/telegram-listen.ts` (manuell).
//
// Idempotent — letzte verarbeitete update_id pro User persistiert.

import { Database } from "bun:sqlite";
import { join, dirname } from "path";
import { existsSync, mkdirSync } from "fs";
import { initSchema } from "../lib/db-init";
import { initMasterKey } from "../lib/crypto";
import { pollAllConfiguredUsers, ensureTelegramOffsetColumn } from "../lib/telegram-commands";

const DB_PATH = process.env.DB_PATH || "mastr-solar.db";
const DATA_DIR = process.env.DATA_DIR || (DB_PATH === "mastr-solar.db" ? "./data" : dirname(DB_PATH));
const MASTER_KEY_PATH = process.env.MASTER_KEY_PATH || join(DATA_DIR, ".master.key");

if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
initMasterKey(MASTER_KEY_PATH);
const db = new Database(DB_PATH);
initSchema(db);
ensureTelegramOffsetColumn(db);

const start = Date.now();
try {
  const r = await pollAllConfiguredUsers(db);
  console.log(`[${new Date().toISOString()}] telegram-listen: ${r.users_scanned} users, ${r.commands_processed} commands processed in ${Date.now() - start}ms`);
} catch (e) {
  console.error("telegram-listen failed:", e);
  process.exitCode = 1;
} finally {
  db.close();
}
