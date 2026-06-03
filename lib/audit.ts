import type { Database } from "bun:sqlite";
import { createHash } from "crypto";

export type AuditAction =
  | "login" | "logout" | "login_failed"
  | "anlage_view" | "anlage_edit" | "anlage_delete" | "anlage_export"
  | "csv_export" | "campaign_start" | "campaign_pause" | "campaign_delete"
  | "user_create" | "user_edit" | "user_delete" | "user_password_reset"
  | "settings_change" | "gdpr_export" | "2fa_enable" | "2fa_disable";

export function logAudit(db: Database, opts: {
  userId?: number | null;
  username?: string | null;
  action: AuditAction;
  entity?: string;
  entityId?: number;
  detail?: string;
  ip?: string | null;
}): void {
  try {
    const ipHash = opts.ip ? createHash("sha256").update(opts.ip).digest("hex").substring(0, 16) : null;
    db.prepare(`
      INSERT INTO audit_log (user_id, username, action, entity, entity_id, detail, ip_hash)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      opts.userId ?? null,
      opts.username ?? null,
      opts.action,
      opts.entity ?? null,
      opts.entityId ?? null,
      opts.detail ?? null,
      ipHash,
    );
  } catch (e) { console.error("audit:", e); }
}

/** GDPR-Export fuer eine Anlage: alle gespeicherten Daten als JSON. */
export function gdprExportAnlage(db: Database, anlageId: number): any {
  const a = db.prepare(`
    SELECT a.*, b.* FROM anlagen a
    LEFT JOIN betreiber b ON a.betreiber_mastr = b.mastr_nummer
    WHERE a.id = ?
  `).get(anlageId);
  if (!a) throw new Error("Anlage nicht gefunden");

  return {
    exported_at: new Date().toISOString(),
    anlage: a,
    notizen: db.prepare("SELECT n.*, u.username FROM notizen n LEFT JOIN users u ON n.user_id=u.id WHERE n.anlage_id=? ORDER BY n.created_at").all(anlageId),
    sent_emails: db.prepare("SELECT id, user_id, to_addr, subject, body_preview, status, sent_at, open_count, click_count FROM sent_emails WHERE anlage_id=? ORDER BY sent_at").all(anlageId),
    email_replies: db.prepare("SELECT id, from_addr, from_name, subject, body_text, received_at FROM email_replies WHERE anlage_id=? ORDER BY received_at").all(anlageId),
    calls: db.prepare("SELECT * FROM calls WHERE anlage_id=? ORDER BY started_at").all(anlageId),
    termine: db.prepare("SELECT * FROM termine WHERE anlage_id=? ORDER BY start_ts").all(anlageId),
    activities: db.prepare("SELECT a.*, u.username FROM activities a LEFT JOIN users u ON a.user_id=u.id WHERE a.anlage_id=? ORDER BY a.created_at").all(anlageId),
    audit_log: db.prepare("SELECT id, username, action, detail, created_at FROM audit_log WHERE entity='anlage' AND entity_id=? ORDER BY created_at").all(anlageId),
  };
}
