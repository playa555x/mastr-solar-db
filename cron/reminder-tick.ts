import { Database } from "bun:sqlite";
import { join, dirname } from "path";
import { existsSync, mkdirSync } from "fs";
import { initSchema } from "../lib/db-init";
import { initMasterKey } from "../lib/crypto";
import { findDueUnnotified, deliverReminder, markNotified } from "../lib/reminders";

const DB_PATH = process.env.DB_PATH || "mastr-solar.db";
const DATA_DIR = process.env.DATA_DIR || (DB_PATH === "mastr-solar.db" ? "./data" : dirname(DB_PATH));
const MASTER_KEY_PATH = process.env.MASTER_KEY_PATH || join(DATA_DIR, ".master.key");

if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

initMasterKey(MASTER_KEY_PATH);
const db = new Database(DB_PATH);
initSchema(db);

const start = Date.now();

try {
  // Wir nehmen die in-app-Spalte als Master-Trigger.
  // deliverReminder() ruft notify() auf (in-app + email + telegram je nach User-Settings) und
  // setzt alle 3 notified_*_at-Spalten, damit kein Re-Fire.
  const dueList = findDueUnnotified(db, "inapp", new Date().toISOString());
  console.log(`[${new Date().toISOString()}] Reminder-Tick: ${dueList.length} faellig`);

  let delivered = 0;
  let skipped = 0;
  for (const r of dueList) {
    if (!r.owner_user_id) {
      // Reminder ohne Owner: in-app fire-and-forget skip Email/TG, trotzdem markieren um Re-Fire zu verhindern
      markNotified(db, r.id, "inapp");
      markNotified(db, r.id, "email");
      markNotified(db, r.id, "telegram");
      skipped++;
      continue;
    }
    try {
      await deliverReminder(db, r);
      delivered++;
    } catch (e) {
      console.error(`[Reminder #${r.id}] Delivery-Fehler:`, e);
    }
  }

  console.log(`[${new Date().toISOString()}] Reminder-Tick fertig: ${delivered} zugestellt, ${skipped} skipped, ${Date.now() - start}ms`);
} catch (e) {
  console.error("Reminder-Tick-Fehler:", e);
  process.exitCode = 1;
} finally {
  db.close();
}
