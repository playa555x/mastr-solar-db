import type { Database } from "bun:sqlite";
import { buildTransport, buildTransportWithFallback, fromAddress, renderTemplate, applyTestModeOverride } from "./mailer";
import { generateTrackingToken, injectTracking } from "./email-tracker";
import { detectAnrede } from "./anrede";
import * as crypto from "crypto";
function signCheckTokenLib(anlageId: number, ttlSeconds = 60 * 60 * 24 * 90): string {
  const expiry = Math.floor(Date.now() / 1000) + ttlSeconds;
  const payload = `${anlageId}|${expiry}`;
  const secret = process.env.CHECK_TOKEN_SECRET || process.env.SESSION_SECRET || "repowering-default-secret-change-me";
  const hmac = crypto.createHash("sha256").update(payload + "|" + secret).digest("hex").slice(0, 16);
  return Buffer.from(`${payload}|${hmac}`).toString("base64url");
}

const BASE_URL = process.env.PUBLIC_BASE_URL || "http://51.195.86.119:8080";

interface SendOpts {
  baseUrl?: string;
  maxPerTick?: number;
}

/**
 * Verarbeitet alle faelligen campaign_recipients.
 * Pro Lauf wird hoechstens maxPerTick versandt (default 30).
 */
export async function tickBulk(db: Database, opts: SendOpts = {}): Promise<{ processed: number; sent: number; failed: number }> {
  const baseUrl = opts.baseUrl || BASE_URL;
  const maxPerTick = opts.maxPerTick ?? 30;
  const stats = { processed: 0, sent: 0, failed: 0 };

  // Hole faellige recipients (status=pending, scheduled_for <= jetzt)
  const due = db.prepare(`
    SELECT r.id, r.campaign_id, r.anlage_id, r.to_addr, r.variant, r.template_id_used,
      c.user_id, c.template_id, c.attachment_ids, c.name as campaign_name,
      c.ab_template_b_id, c.ab_winner_template_id
    FROM campaign_recipients r
    JOIN campaigns c ON r.campaign_id = c.id
    WHERE r.status = 'pending'
      AND c.status = 'active'
      AND (r.scheduled_for IS NULL OR r.scheduled_for <= datetime('now'))
    ORDER BY r.scheduled_for
    LIMIT ?
  `).all(maxPerTick) as any[];

  if (due.length === 0) return stats;

  // Group by user (each user has own SMTP)
  const byUser = new Map<number, any[]>();
  for (const r of due) {
    if (!byUser.has(r.user_id)) byUser.set(r.user_id, []);
    byUser.get(r.user_id)!.push(r);
  }

  for (const [userId, rows] of byUser) {
    const user = db.prepare(`
      SELECT id, email, display_name, username,
        smtp_host, smtp_port, smtp_secure, smtp_user, smtp_pass_enc,
        smtp_from_name, smtp_from_email,
        signature_html, signature_html_en, signature_html_fr,
        pref_locale
      FROM users WHERE id = ?
    `).get(userId) as any;
    if (!user || !user.smtp_host || !user.smtp_pass_enc) {
      // SMTP nicht konfiguriert - mark all as failed
      for (const r of rows) {
        db.prepare("UPDATE campaign_recipients SET status='failed', error=? WHERE id=?").run("SMTP nicht konfiguriert", r.id);
        stats.failed++; stats.processed++;
      }
      continue;
    }

    // Smart-Transport: Admin-Fallback wenn User keine eigene SMTP hat
    let transport, effectiveFrom: string, replyTo: string | null;
    try {
      const t = buildTransportWithFallback(db, user);
      transport = t.transport;
      effectiveFrom = t.effectiveFrom;
      replyTo = t.replyTo;
    } catch (e: any) {
      for (const r of rows) {
        db.prepare("UPDATE campaign_recipients SET status='failed', error=? WHERE id=?").run(e.message, r.id);
        stats.failed++; stats.processed++;
      }
      continue;
    }

    // Settings einmal pro User-Batch laden — incl. test_mode_email + firma_*
    const settings: Record<string, string> = {};
    for (const s of db.prepare("SELECT key, value FROM app_settings").all() as any[]) settings[s.key] = s.value || "";
    const testModeEmail = settings.test_mode_email || null;

    for (const r of rows) {
      stats.processed++;
      try {
        const tplId = r.ab_winner_template_id || r.template_id_used || r.template_id;
        const tpl = tplId ? db.prepare("SELECT * FROM email_templates WHERE id = ?").get(tplId) as any : null;
        if (!tpl) throw new Error("Template fehlt");
        const anlage = db.prepare("SELECT * FROM anlagen WHERE id = ?").get(r.anlage_id) as any;
        if (!anlage) throw new Error("Anlage fehlt");

        const anredeInfo = detectAnrede(anlage.betreiber_name);
        const fmt = (n: number) => n.toLocaleString("de-DE");
        const leistungNum = anlage.nettonennleistung ? Math.round(anlage.nettonennleistung) : 0;
        const firmaUrl = settings.firma_url || "https://repowering-de.de";
        // Vollstaendige Vars synchron mit dem Single-Send-Endpunkt
        const vars = {
          anlagenname: anlage.name || anlage.mastr_nummer || "",
          ort: anlage.ort || "",
          plz: anlage.plz || "",
          leistung: leistungNum ? fmt(leistungNum) : "",
          leistung_neu_kwp: leistungNum ? fmt(Math.round(leistungNum * 2.5)) : "",
          marktwert_eur: leistungNum ? fmt(Math.round(leistungNum * 250)) : "",
          marktwert_eur_low: leistungNum ? fmt(Math.round(leistungNum * 180)) : "",
          marktwert_eur_high: leistungNum ? fmt(Math.round(leistungNum * 320)) : "",
          leistung_x25: leistungNum ? fmt(Math.round(leistungNum * 250)) : "",
          leistung_x30: leistungNum ? fmt(Math.round(leistungNum * 320)) : "",
          jahres_ertrag_kwh: leistungNum ? fmt(Math.round(leistungNum * 950)) : "",
          jahres_ertrag_neu_kwh: leistungNum ? fmt(Math.round(leistungNum * 2.5 * 950)) : "",
          betreiber: anlage.betreiber_name || "",
          anrede: anredeInfo.anrede,
          anrede_kurz: anredeInfo.anrede_kurz,
          gender: anredeInfo.gender,
          vorname: anredeInfo.vorname,
          nachname: anredeInfo.nachname,
          datum: new Date().toLocaleDateString("de-DE"),
          jahr: new Date().getFullYear().toString(),
          termin: "",
          absender_name: user.smtp_from_name || user.display_name || user.username || "",
          absender_email: user.smtp_from_email || user.email || "",
          absender_position: user.bio || "Repowering-Spezialist",
          absender_tel: user.phone || "",
          firma_name: settings.firma_name || "Repowering DE",
          firma_adresse: settings.firma_adresse || "",
          firma_url: firmaUrl,
          firma_url_display: firmaUrl.replace(/^https?:\/\//, ""),
          firma_register: settings.firma_register || "",
          check_url: `${firmaUrl}/check`,
          check_url_prefilled: `${firmaUrl}/check?t=${signCheckTokenLib(anlage.id)}`,
          modul_wp_neu: settings.repowering_module_wp || "720",
          modul_wp_alt: settings.modul_wp_alt || "230",
          preheader: "",
          cta_label: "Kostenlose Analyse anfordern →",
          cta_url: `${firmaUrl}/check?t=${signCheckTokenLib(anlage.id)}`,
        };
        const subject = renderTemplate(tpl.subject || "", vars);
        // Signatur in Sender-Locale (Anlage-Empfänger hat keine pref_locale in DB)
        const { pickSignature } = await import("./signatures");
        const sig = pickSignature(user, user.pref_locale || "de");
        let bodyHtml = renderTemplate(tpl.body_html || "", vars) + (sig ? `<br><br>${sig}` : "");
        const trackingToken = generateTrackingToken();
        bodyHtml = injectTracking(bodyHtml, trackingToken, baseUrl);

        // Attachments
        const attIds: number[] = r.attachment_ids ? JSON.parse(r.attachment_ids) : [];
        const attachments: any[] = [];
        if (attIds.length > 0) {
          const placeholders = attIds.map(() => "?").join(",");
          const atts = db.prepare(`
            SELECT original_name, stored_path, mime_type
            FROM attachments
            WHERE id IN (${placeholders}) AND (user_id IS NULL OR user_id = ?)
          `).all(...attIds, userId) as any[];
          for (const a of atts) attachments.push({ filename: a.original_name, path: a.stored_path, contentType: a.mime_type });
        }

        // TEST-MODE: alle Empfaenger werden auf testModeEmail umgeleitet, Original im Subject sichtbar
        const mailOpts: any = applyTestModeOverride(testModeEmail, {
          from: effectiveFrom,  // bei Fallback: Admin-Adresse mit User-Display-Name
          to: r.to_addr,
          subject,
          html: bodyHtml,
          attachments,
        });
        if (replyTo) mailOpts.replyTo = replyTo;
        const info = await transport.sendMail(mailOpts);

        const insertSent = db.prepare(`
          INSERT INTO sent_emails (user_id, anlage_id, to_addr, subject, body_preview, status, attachment_ids, tracking_token)
          VALUES (?, ?, ?, ?, ?, 'sent', ?, ?)
        `).run(userId, r.anlage_id, r.to_addr, subject, bodyHtml.substring(0, 500), JSON.stringify(attIds), trackingToken);

        db.prepare(`
          UPDATE campaign_recipients SET status='sent', sent_at=CURRENT_TIMESTAMP, sent_email_id=? WHERE id=?
        `).run(insertSent.lastInsertRowid, r.id);

        // Mark Anlage als kontaktiert wenn neu
        if (anlage.status === "neu") {
          db.prepare("UPDATE anlagen SET status='kontaktiert', updated_at=CURRENT_TIMESTAMP WHERE id=?").run(r.anlage_id);
        }
        // Auto-Assign Owner wenn keiner
        if (!anlage.owner_id) {
          db.prepare("UPDATE anlagen SET owner_id=?, updated_at=CURRENT_TIMESTAMP WHERE id=?").run(userId, r.anlage_id);
        }

        // Campaign-Counter
        db.prepare("UPDATE campaigns SET sent_count = sent_count + 1 WHERE id = ?").run(r.campaign_id);
        stats.sent++;
      } catch (e: any) {
        db.prepare("UPDATE campaign_recipients SET status='failed', error=? WHERE id=?").run((e.message || String(e)).substring(0, 500), r.id);
        stats.failed++;
      }
    }
  }

  // A/B Auto-Winner: nach 24h, wenn beide Varianten >= 30 Mails versandt -> hoehere Open-Rate gewinnt
  try {
    const candidates = db.prepare(`
      SELECT id, template_id, ab_template_b_id, started_at
      FROM campaigns
      WHERE status='active'
        AND ab_template_b_id IS NOT NULL
        AND ab_winner_template_id IS NULL
        AND started_at IS NOT NULL
        AND datetime(started_at) <= datetime('now', '-24 hours')
    `).all() as any[];
    for (const c of candidates) {
      const stats = db.prepare(`
        SELECT r.template_id_used as tpl,
          COUNT(*) as sent,
          SUM(CASE WHEN s.open_count > 0 THEN 1 ELSE 0 END) as opened
        FROM campaign_recipients r
        LEFT JOIN sent_emails s ON r.sent_email_id = s.id
        WHERE r.campaign_id = ? AND r.status='sent'
        GROUP BY r.template_id_used
      `).all(c.id) as any[];
      if (stats.length < 2) continue;
      let bestTpl = null, bestRate = -1;
      let totalSent = 0;
      for (const s of stats) {
        totalSent += s.sent;
        const rate = s.sent > 0 ? s.opened / s.sent : 0;
        if (s.sent >= 30 && rate > bestRate) { bestRate = rate; bestTpl = s.tpl; }
      }
      if (bestTpl !== null && totalSent >= 60) {
        db.prepare("UPDATE campaigns SET ab_winner_template_id = ?, ab_decided_at = CURRENT_TIMESTAMP WHERE id = ?")
          .run(bestTpl, c.id);
        console.log(`[ab-test] Campaign ${c.id}: winner=${bestTpl} rate=${(bestRate*100).toFixed(1)}%`);
      }
    }
  } catch (e) { console.error("ab-winner check:", e); }

  // Campaigns die fertig sind -> status='done'
  db.run(`
    UPDATE campaigns SET status='done', finished_at=CURRENT_TIMESTAMP
    WHERE status='active'
      AND id NOT IN (SELECT campaign_id FROM campaign_recipients WHERE status='pending')
  `);

  return stats;
}
