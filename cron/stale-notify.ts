/**
 * Daily Pipeline-Stale-Notification
 * Laeuft taeglich um 08:00 via mastr-solar-stale.timer.
 *
 * Logik: pro Owner mit ueberfaelligen Anlagen → 1 in-app + email + telegram Notification.
 * Email-Body fasst die Top 8 ueberfaelligen Anlagen zusammen.
 */
import { Database } from "bun:sqlite";
import { join } from "path";
import { initMasterKey } from "../lib/crypto";
import { notify } from "../lib/notifications";

const DB_PATH = process.env.DB_PATH || "/opt/mastr-solar/data/mastr-solar.db";
const DATA_DIR = process.env.DATA_DIR || "/opt/mastr-solar/data";
const MASTER_KEY_PATH = process.env.MASTER_KEY_PATH || join(DATA_DIR, ".master.key");
initMasterKey(MASTER_KEY_PATH);

const DEFAULT_SLA: Record<string, number> = {
  neu: 7,
  kontaktiert: 14,
  nicht_erreicht: 10,
  terminiert: 30,
  interessiert: 21,
  abgeschlossen: 60,
};

async function main() {
  const db = new Database(DB_PATH, { readwrite: true });
  // SLA-Map aus app_settings (Override pro Status moeglich)
  const slaMap = { ...DEFAULT_SLA };
  for (const r of db.prepare(`SELECT key, value FROM app_settings WHERE key LIKE 'sla_%_tage'`).all() as any[]) {
    const m = r.key.match(/^sla_(.+)_tage$/);
    if (m && !isNaN(parseInt(r.value))) slaMap[m[1]] = parseInt(r.value);
  }
  const checkable = Object.entries(slaMap).filter(([_, d]) => d > 0);
  if (checkable.length === 0) { console.log("Keine SLAs konfiguriert"); return; }
  const caseSql = checkable.map(([s, d]) => `WHEN a.status = '${s}' THEN ${d}`).join(" ");
  const statusList = checkable.map(([s]) => `'${s}'`).join(",");

  // Nur ZUGEWIESENE Anlagen (owner_id IS NOT NULL) zaehlen als Pipeline-Stau.
  // Unzugewiesene MaStR-Defaults sollten via "Heute"-Tab/Anlagen-Liste angepackt werden.
  const stale = db.prepare(`
    SELECT a.owner_id, a.id, a.mastr_nummer, a.name, a.ort, a.bundesland, a.status,
      a.lead_score, a.nettonennleistung,
      CAST(JULIANDAY('now') - JULIANDAY(a.status_changed_at) AS INTEGER) as days_in_status,
      CASE ${caseSql} ELSE 9999 END as sla_days,
      CAST(JULIANDAY('now') - JULIANDAY(a.status_changed_at) AS INTEGER) -
        (CASE ${caseSql} ELSE 9999 END) as overdue_days
    FROM anlagen a
    WHERE a.status IN (${statusList})
      AND a.status_changed_at IS NOT NULL
      AND a.owner_id IS NOT NULL
      AND CAST(JULIANDAY('now') - JULIANDAY(a.status_changed_at) AS INTEGER) >
          (CASE ${caseSql} ELSE 9999 END)
    ORDER BY a.owner_id, overdue_days DESC
  `).all() as any[];

  if (stale.length === 0) { console.log("Keine ueberfaelligen Anlagen"); return; }

  // Group by owner — unzugewiesene (owner_id IS NULL) gehen an alle Admins
  const byOwner = new Map<number | null, any[]>();
  for (const a of stale) {
    const key = a.owner_id == null ? null : a.owner_id;
    if (!byOwner.has(key)) byOwner.set(key, []);
    byOwner.get(key)!.push(a);
  }

  // Admin-Liste fuer unzugewiesene Anlagen
  const admins = db.prepare(`SELECT id FROM users WHERE active = 1 AND (is_admin = 1 OR username = 'admin')`).all() as any[];

  let totalNotified = 0;
  const sendToUser = async (userId: number, anlagen: any[], unassigned: boolean) => {
    const top8 = anlagen.slice(0, 8);
    // Anlagen-Liste ist sprachneutral (Namen/Orte sind Eigenwerte). Wir bauen sie raw und übergeben sie als Arg.
    const lines = top8.map(a =>
      `${a.overdue_days >= 30 ? "🚨" : a.overdue_days >= 14 ? "⚠️" : "🔸"} ${a.name || a.mastr_nummer} (${a.ort||""}) · ${a.status} · ${a.days_in_status}/${a.sla_days}d (+${a.overdue_days})`
    );
    const linesText = lines.join("\n");
    const more = anlagen.length > 8 ? anlagen.length - 8 : 0;
    const titleKey = unassigned
      ? (anlagen.length === 1 ? "notif.stale_unassigned_title_singular" : "notif.stale_unassigned_title_plural")
      : (anlagen.length === 1 ? "notif.stale_owner_title_singular" : "notif.stale_owner_title_plural");
    const bodyKey = unassigned ? "notif.stale_unassigned_body" : "notif.stale_owner_body";
    try {
      await notify(db, {
        userId,
        type: "assignment",
        titleKey,
        titleArgs: { count: anlagen.length },
        bodyKey,
        bodyArgs: { lines: linesText, more, more_suffix: more > 0 ? `\n\n+ ${more}` : "" },
        url: "/?#dashboard",
      });
      totalNotified++;
      console.log(`User ${userId}: ${anlagen.length} Anlagen → Notification verschickt (${unassigned ? "unassigned" : "owner"})`);
    } catch (e) {
      console.error(`User ${userId}: Notification fehlgeschlagen`, e);
    }
  };

  for (const [ownerKey, anlagen] of byOwner) {
    if (ownerKey == null) continue; // sollte nach SQL-Filter nicht mehr vorkommen
    await sendToUser(ownerKey, anlagen, false);
  }
  console.log(`Fertig: ${totalNotified} Notifications verschickt.`);
  db.close();
}

main().catch(e => { console.error(e); process.exit(1); });
