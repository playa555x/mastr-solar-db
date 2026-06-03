import type { Database } from "bun:sqlite";

/**
 * Lead-Score-Gewichte (DEFAULT). Werden ueber app_settings (Key `lead_w_*`) ueberschrieben.
 * Aenderungen wirken sofort beim naechsten Rescore.
 */
export const DEFAULT_WEIGHTS = {
  lead_w_open: 1,
  lead_w_click: 5,
  lead_w_reply: 25,
  lead_w_call_reached: 10,
  lead_w_call_voicemail: 3,
  lead_w_sentiment_pos: 15,
  lead_w_sentiment_neg: -10,
  lead_w_status_interessiert: 30,
  lead_w_status_geantwortet: 20,
  lead_w_status_kontaktiert: 5,
  lead_w_status_nicht_interessiert: -50,
  lead_w_status_gewonnen: 100,
  lead_w_leistung_gt_100: 5,
  lead_w_leistung_gt_500: 5,
  lead_w_has_email: 5,
  lead_w_has_phone: 5,
};

export type LeadWeights = typeof DEFAULT_WEIGHTS;

let cachedWeights: LeadWeights | null = null;
let cacheLoadedAt = 0;

export function getLeadWeights(db: Database): LeadWeights {
  // 60s in-memory Cache (wird beim Settings-Save invalidiert via clearLeadWeightCache)
  if (cachedWeights && Date.now() - cacheLoadedAt < 60_000) return cachedWeights;
  const rows = db.prepare(`SELECT key, value FROM app_settings WHERE key LIKE 'lead_w_%'`).all() as any[];
  const w = { ...DEFAULT_WEIGHTS } as any;
  for (const r of rows) {
    if (r.key in DEFAULT_WEIGHTS) {
      const n = parseFloat(r.value);
      if (!isNaN(n)) w[r.key] = n;
    }
  }
  cachedWeights = w;
  cacheLoadedAt = Date.now();
  return w;
}

export function clearLeadWeightCache(): void { cachedWeights = null; }

export function computeScore(stats: {
  opens: number; clicks: number; replies: number;
  calls_reached: number; calls_voicemail: number;
  sentiment_pos: number; sentiment_neg: number;
  status: string | null;
  leistung_kwp: number | null;
  has_email: boolean; has_phone: boolean;
}, weights: LeadWeights = DEFAULT_WEIGHTS): number {
  const w = weights;
  let s = 0;
  s += (stats.opens || 0) * w.lead_w_open;
  s += (stats.clicks || 0) * w.lead_w_click;
  s += (stats.replies || 0) * w.lead_w_reply;
  s += (stats.calls_reached || 0) * w.lead_w_call_reached;
  s += (stats.calls_voicemail || 0) * w.lead_w_call_voicemail;
  s += (stats.sentiment_pos || 0) * w.lead_w_sentiment_pos;
  s += (stats.sentiment_neg || 0) * w.lead_w_sentiment_neg;
  switch (stats.status) {
    case "interessiert": s += w.lead_w_status_interessiert; break;
    case "geantwortet": s += w.lead_w_status_geantwortet; break;
    case "kontaktiert": s += w.lead_w_status_kontaktiert; break;
    case "nicht_interessiert": s += w.lead_w_status_nicht_interessiert; break;
    case "gewonnen": s += w.lead_w_status_gewonnen; break;
  }
  if ((stats.leistung_kwp || 0) > 100) s += w.lead_w_leistung_gt_100;
  if ((stats.leistung_kwp || 0) > 500) s += w.lead_w_leistung_gt_500;
  if (stats.has_email) s += w.lead_w_has_email;
  if (stats.has_phone) s += w.lead_w_has_phone;
  return Math.max(0, Math.min(200, Math.round(s)));
}

/** Score fuer eine einzelne Anlage neu berechnen + speichern. */
export function rescoreAnlage(db: Database, anlageId: number): number {
  const a = db.prepare(`
    SELECT id, status, nettonennleistung, kontakt_email, kontakt_telefon, lead_score
    FROM anlagen WHERE id = ?
  `).get(anlageId) as any;
  if (!a) return 0;

  const events = db.prepare(`
    SELECT
      SUM(CASE WHEN ee.event_type='open' THEN 1 ELSE 0 END) as opens,
      SUM(CASE WHEN ee.event_type='click' THEN 1 ELSE 0 END) as clicks
    FROM email_events ee
    JOIN sent_emails s ON ee.sent_email_id = s.id
    WHERE s.anlage_id = ?
  `).get(anlageId) as any;

  const replies = (db.prepare("SELECT COUNT(*) as c FROM email_replies WHERE anlage_id = ?").get(anlageId) as any).c;

  const callStats = db.prepare(`
    SELECT
      SUM(CASE WHEN outcome='reached' THEN 1 ELSE 0 END) as reached,
      SUM(CASE WHEN outcome='voicemail' THEN 1 ELSE 0 END) as voicemail,
      SUM(CASE WHEN ai_sentiment='positive' THEN 1 ELSE 0 END) as pos,
      SUM(CASE WHEN ai_sentiment='negative' THEN 1 ELSE 0 END) as neg
    FROM calls WHERE anlage_id = ?
  `).get(anlageId) as any;

  const weights = getLeadWeights(db);
  const newScore = computeScore({
    opens: events?.opens || 0,
    clicks: events?.clicks || 0,
    replies: replies || 0,
    calls_reached: callStats?.reached || 0,
    calls_voicemail: callStats?.voicemail || 0,
    sentiment_pos: callStats?.pos || 0,
    sentiment_neg: callStats?.neg || 0,
    status: a.status,
    leistung_kwp: a.nettonennleistung,
    has_email: !!a.kontakt_email,
    has_phone: !!a.kontakt_telefon,
  }, weights);

  if (newScore !== (a.lead_score || 0)) {
    db.prepare(`
      UPDATE anlagen SET lead_score = ?, lead_score_updated_at = CURRENT_TIMESTAMP WHERE id = ?
    `).run(newScore, anlageId);
    db.prepare(`
      INSERT INTO lead_score_log (anlage_id, old_score, new_score, reason)
      VALUES (?, ?, ?, ?)
    `).run(anlageId, a.lead_score || 0, newScore, "rescore");
  }
  return newScore;
}

/** Bulk-Rescore fuer alle Anlagen mit Aktivitaet (Performance: nur Anlagen mit Events/Calls/Replies/Notizen). */
export function rescoreAll(db: Database): { count: number; ms: number } {
  const t0 = Date.now();
  const ids = db.prepare(`
    SELECT DISTINCT a.id FROM anlagen a
    WHERE
      EXISTS (SELECT 1 FROM sent_emails s WHERE s.anlage_id = a.id) OR
      EXISTS (SELECT 1 FROM calls c WHERE c.anlage_id = a.id) OR
      EXISTS (SELECT 1 FROM email_replies r WHERE r.anlage_id = a.id) OR
      a.status != 'neu'
  `).all() as Array<{ id: number }>;

  for (const { id } of ids) {
    try { rescoreAnlage(db, id); } catch (e) { console.error(`score ${id}:`, e); }
  }
  return { count: ids.length, ms: Date.now() - t0 };
}
