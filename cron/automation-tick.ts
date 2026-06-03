/**
 * Automation-Worker — laeuft hourly.
 * 3 Trigger-Types:
 *   - status_stale: Status seit X Tagen unveraendert
 *   - no_reply: Mail vor X Tagen versandt, keine Antwort
 *   - email_opened_n_times: Mail wurde N× geoeffnet aber nicht beantwortet
 *
 * 3 Action-Types:
 *   - send_email: Template senden
 *   - set_status: Status setzen
 *   - notify_owner: in-app + email Notification an Owner
 *   - create_reminder: Wiedervorlage anlegen
 */
import { Database } from "bun:sqlite";
import { join } from "path";
import { initMasterKey } from "../lib/crypto";
import { notify } from "../lib/notifications";
import { buildTransport, buildTransportWithFallback, fromAddress, renderTemplate, applyTestModeOverride } from "../lib/mailer";
import { createReminder } from "../lib/reminders";
import { detectAnrede } from "../lib/anrede";

const DB_PATH = process.env.DB_PATH || "/opt/mastr-solar/data/mastr-solar.db";
const DATA_DIR = process.env.DATA_DIR || "/opt/mastr-solar/data";
initMasterKey(process.env.MASTER_KEY_PATH || join(DATA_DIR, ".master.key"));

async function main() {
  const db = new Database(DB_PATH, { readwrite: true });
  const t0 = Date.now();

  // Active Automations laden
  const autos = db.prepare(`SELECT * FROM automations WHERE is_active = 1`).all() as any[];
  if (autos.length === 0) { console.log("Keine aktiven Automations"); return; }

  // Settings einmal laden (test_mode_email)
  const settings: Record<string, string> = {};
  for (const r of db.prepare(`SELECT key, value FROM app_settings`).all() as any[]) settings[r.key] = r.value || "";
  const testModeEmail = settings.test_mode_email || null;

  let totalFired = 0;
  for (const auto of autos) {
    try {
      const trigger = JSON.parse(auto.trigger_config);
      const action = JSON.parse(auto.action_config);
      const candidates = findCandidates(db, auto.trigger_type, trigger, auto.id);
      for (const cand of candidates) {
        try {
          await executeAction(db, auto, action, cand, settings, testModeEmail);
          db.prepare(`INSERT INTO automation_log (automation_id, anlage_id, success, detail) VALUES (?, ?, 1, ?)`)
            .run(auto.id, cand.id, `Ausgefuehrt: ${auto.action_type}`);
          totalFired++;
        } catch (e: any) {
          db.prepare(`INSERT INTO automation_log (automation_id, anlage_id, success, detail) VALUES (?, ?, 0, ?)`)
            .run(auto.id, cand.id, String(e?.message || e).slice(0, 500));
          console.error(`Automation ${auto.id} on Anlage ${cand.id}: ${e?.message}`);
        }
      }
      db.prepare(`UPDATE automations SET last_run_at = CURRENT_TIMESTAMP, total_fired = total_fired + ? WHERE id = ?`)
        .run(candidates.length, auto.id);
    } catch (e: any) {
      console.error(`Automation ${auto.id} (${auto.name}) failed: ${e?.message}`);
    }
  }
  console.log(`Fertig: ${totalFired} Aktionen ausgefuehrt in ${Date.now() - t0}ms.`);
  db.close();
}

function findCandidates(db: Database, triggerType: string, cfg: any, automationId: number): any[] {
  // Anti-Spam: pro Anlage darf eine Automation nur 1× innerhalb cooldown_days laufen
  const cooldownDays = cfg.cooldown_days || 30;
  if (triggerType === "status_stale") {
    const status = cfg.status || "kontaktiert";
    const days = parseInt(cfg.days || 14);
    return db.prepare(`
      SELECT a.id, a.name, a.mastr_nummer, a.ort, a.status, a.nettonennleistung, a.owner_id, a.kontakt_email, a.kontakt_telefon, a.betreiber_name, a.betreiber_mastr
      FROM anlagen a
      WHERE a.status = ?
        AND a.owner_id IS NOT NULL
        AND CAST(JULIANDAY('now') - JULIANDAY(a.status_changed_at) AS INTEGER) >= ?
        AND a.id NOT IN (
          SELECT anlage_id FROM automation_log
          WHERE automation_id = ?
            AND fired_at > datetime('now', ?)
            AND anlage_id IS NOT NULL
        )
      LIMIT 50
    `).all(status, days, automationId, `-${cooldownDays} days`) as any[];
  }
  if (triggerType === "no_reply") {
    const days = parseInt(cfg.days || 7);
    return db.prepare(`
      SELECT DISTINCT a.id, a.name, a.mastr_nummer, a.ort, a.status, a.nettonennleistung, a.owner_id, a.kontakt_email, a.kontakt_telefon, a.betreiber_name, a.betreiber_mastr
      FROM anlagen a JOIN sent_emails s ON s.anlage_id = a.id
      WHERE a.owner_id IS NOT NULL
        AND s.status = 'sent'
        AND CAST(JULIANDAY('now') - JULIANDAY(s.sent_at) AS INTEGER) >= ?
        AND NOT EXISTS (SELECT 1 FROM email_replies r WHERE r.anlage_id = a.id AND r.received_at > s.sent_at)
        AND a.id NOT IN (
          SELECT anlage_id FROM automation_log
          WHERE automation_id = ? AND fired_at > datetime('now', ?) AND anlage_id IS NOT NULL
        )
      LIMIT 50
    `).all(days, automationId, `-${cooldownDays} days`) as any[];
  }
  if (triggerType === "email_opened_n_times") {
    const minOpens = parseInt(cfg.min_opens || 3);
    return db.prepare(`
      SELECT DISTINCT a.id, a.name, a.mastr_nummer, a.ort, a.status, a.nettonennleistung, a.owner_id, a.kontakt_email, a.kontakt_telefon, a.betreiber_name, a.betreiber_mastr,
        (SELECT COUNT(*) FROM email_events ee JOIN sent_emails s2 ON ee.sent_email_id = s2.id WHERE s2.anlage_id = a.id AND ee.event_type='open') as opens
      FROM anlagen a
      WHERE a.owner_id IS NOT NULL
        AND a.id NOT IN (
          SELECT anlage_id FROM automation_log
          WHERE automation_id = ? AND fired_at > datetime('now', ?) AND anlage_id IS NOT NULL
        )
        AND (SELECT COUNT(*) FROM email_events ee JOIN sent_emails s2 ON ee.sent_email_id = s2.id WHERE s2.anlage_id = a.id AND ee.event_type='open') >= ?
      LIMIT 50
    `).all(automationId, `-${cooldownDays} days`, minOpens) as any[];
  }
  return [];
}

async function executeAction(db: Database, auto: any, action: any, anlage: any, settings: Record<string,string>, testModeEmail: string | null) {
  if (action.type === "set_status") {
    const newStatus = action.status;
    db.prepare(`UPDATE anlagen SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(newStatus, anlage.id);
    console.log(`Automation ${auto.name}: Anlage ${anlage.id} status -> ${newStatus}`);
    return;
  }
  if (action.type === "create_reminder") {
    const days = parseInt(action.days || 7);
    const note = action.note || `Auto-Wiedervorlage durch Automation "${auto.name}"`;
    const dueAt = new Date(Date.now() + days * 24 * 3600 * 1000).toISOString();
    if (anlage.betreiber_mastr) {
      createReminder(db, {
        betreiber_mastr: anlage.betreiber_mastr,
        due_at: dueAt,
        note,
        owner_user_id: anlage.owner_id,
        created_by: 1, // System
      });
    }
    return;
  }
  if (action.type === "notify_owner") {
    if (!anlage.owner_id) return;
    await notify(db, {
      userId: anlage.owner_id,
      type: "assignment",
      titleKey: "notif.automation_title",
      titleArgs: { rule: auto.name },
      bodyKey: "notif.automation_body",
      bodyArgs: {
        anlage: anlage.name || anlage.mastr_nummer,
        ort: anlage.ort || "",
        message: action.message || "",
      },
      anlageId: anlage.id,
      url: `/?#anlage-${anlage.id}`,
    });
    return;
  }
  if (action.type === "send_email") {
    if (!anlage.kontakt_email) throw new Error("Anlage hat keine Email");
    const tplId = action.template_id;
    const tpl = db.prepare(`SELECT * FROM email_templates WHERE id = ?`).get(tplId) as any;
    if (!tpl) throw new Error(`Template ${tplId} fehlt`);
    const ownerUser = db.prepare(`SELECT * FROM users WHERE id = ?`).get(anlage.owner_id) as any;
    if (!ownerUser) throw new Error("Anlagen-Owner nicht gefunden");
    const anredeInfo = detectAnrede(anlage.betreiber_name);
    const leistung = anlage.nettonennleistung ? Math.round(anlage.nettonennleistung) : 0;
    const fmt = (n: number) => n.toLocaleString("de-DE");
    const firmaUrl = settings.firma_url || "https://repowering-de.de";
    const vars = {
      anlagenname: anlage.name || anlage.mastr_nummer || "",
      ort: anlage.ort || "",
      leistung: leistung ? fmt(leistung) : "",
      betreiber: anlage.betreiber_name || "",
      anrede: anredeInfo.anrede,
      vorname: anredeInfo.vorname,
      nachname: anredeInfo.nachname,
      datum: new Date().toLocaleDateString("de-DE"),
      jahr: new Date().getFullYear().toString(),
      absender_name: ownerUser.smtp_from_name || ownerUser.display_name || ownerUser.username,
      absender_email: ownerUser.smtp_from_email || ownerUser.email,
      absender_position: ownerUser.bio || "",
      absender_tel: ownerUser.phone || "",
      firma_name: settings.firma_name || "Repowering DE",
      firma_url: firmaUrl,
      firma_url_display: firmaUrl.replace(/^https?:\/\//, ""),
      check_url: firmaUrl + "/check",
    };
    const subject = renderTemplate(tpl.subject || "", vars);
    const body = renderTemplate(tpl.body_html || "", vars);
    // Smart-Transport: eigene SMTP wenn vorhanden, sonst Admin-Fallback
    const { transport, effectiveFrom, replyTo } = buildTransportWithFallback(db, ownerUser);
    const mailOpts: any = applyTestModeOverride(testModeEmail, {
      from: effectiveFrom,
      to: anlage.kontakt_email,
      subject: `🤖 ${subject}`,
      html: body,
    });
    if (replyTo) mailOpts.replyTo = replyTo;
    await transport.sendMail(mailOpts);
    // Log in sent_emails
    db.prepare(`INSERT INTO sent_emails (user_id, anlage_id, to_addr, subject, body_preview, status) VALUES (?, ?, ?, ?, ?, 'sent')`)
      .run(ownerUser.id, anlage.id, anlage.kontakt_email, subject, body.slice(0, 500));
    return;
  }
  throw new Error(`Unbekannter Action-Type: ${action.type}`);
}

main().catch(e => { console.error(e); process.exit(1); });
