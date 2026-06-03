import type { Database } from "bun:sqlite";

export type ActivityType =
  | "status_change"
  | "owner_change"
  | "owner_auto_assign"
  | "note_added"
  | "note_deleted"
  | "email_sent"
  | "termin_created"
  | "comment_added"
  | "kontakt_updated";

export function logActivity(
  db: Database,
  anlageId: number,
  userId: number,
  type: ActivityType,
  description: string,
  metadata?: any,
  apiTokenId?: number | null,
): void {
  try {
    db.prepare(`
      INSERT INTO activities (anlage_id, user_id, type, description, metadata, api_token_id)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(anlageId, userId, type, description, metadata ? JSON.stringify(metadata) : null, apiTokenId || null);
  } catch (e) {
    console.error("Activity-Log-Fehler:", e);
  }
}

/**
 * Auto-Assign: setzt owner_id auf userId, wenn die Anlage noch keinen Owner hat.
 * Returns true wenn ein Owner gesetzt wurde, false wenn schon einer existierte.
 */
export function autoAssignOwner(db: Database, anlageId: number, userId: number): boolean {
  const cur = db.prepare("SELECT owner_id FROM anlagen WHERE id = ?").get(anlageId) as any;
  if (!cur) return false;
  if (cur.owner_id) return false;
  db.prepare("UPDATE anlagen SET owner_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(userId, anlageId);
  logActivity(db, anlageId, userId, "owner_auto_assign", `Automatisch zugewiesen`);
  return true;
}

/**
 * Auto-Assign auf Kunden-Ebene: setzt owner_id auf userId fuer ALLE Anlagen
 * des Betreibers, die noch keinen Owner haben.
 * Returns Anzahl der zugewiesenen Anlagen.
 */
export function autoAssignOwnerForBetreiber(db: Database, betreiberMastr: string, userId: number): number {
  const anlagen = db.prepare(
    "SELECT id FROM anlagen WHERE betreiber_mastr = ? AND owner_id IS NULL"
  ).all(betreiberMastr) as { id: number }[];
  let count = 0;
  for (const a of anlagen) {
    if (autoAssignOwner(db, a.id, userId)) count++;
  }
  return count;
}
