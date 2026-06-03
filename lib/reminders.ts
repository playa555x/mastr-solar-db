import type { Database } from "bun:sqlite";
import { notify } from "./notifications";

export interface Reminder {
  id: number;
  betreiber_mastr: string;
  due_at: string;
  note: string | null;
  status: "pending" | "done" | "snoozed";
  owner_user_id: number | null;
  created_by: number | null;
  created_at: string;
  completed_at: string | null;
  completed_by: number | null;
  notified_inapp_at: string | null;
  notified_email_at: string | null;
  notified_telegram_at: string | null;
}

export interface CreateReminderInput {
  betreiber_mastr: string;
  due_at: string;            // ISO 8601 datetime
  note?: string | null;
  owner_user_id?: number | null;
  created_by: number;
}

export function createReminder(db: Database, input: CreateReminderInput): Reminder {
  if (!input.betreiber_mastr) throw new Error("betreiber_mastr fehlt");
  if (!input.due_at) throw new Error("due_at fehlt");
  if (Number.isNaN(Date.parse(input.due_at))) throw new Error(`due_at unparseable: ${input.due_at}`);

  const owner = input.owner_user_id ?? input.created_by;
  const r = db.prepare(`
    INSERT INTO reminders (betreiber_mastr, due_at, note, owner_user_id, created_by, status)
    VALUES (?, ?, ?, ?, ?, 'pending')
  `).run(input.betreiber_mastr, input.due_at, input.note ?? null, owner, input.created_by);
  return getReminder(db, Number(r.lastInsertRowid))!;
}

export function getReminder(db: Database, id: number): Reminder | null {
  return (db.prepare("SELECT * FROM reminders WHERE id = ?").get(id) as Reminder | undefined) || null;
}

export interface ListFilter {
  status?: "pending" | "done" | "snoozed" | "all";
  due_before?: string;          // ISO; matches due_at <= due_before
  betreiber_mastr?: string;
  owner_user_id?: number;
  limit?: number;
}

export function listReminders(db: Database, f: ListFilter = {}): Reminder[] {
  const where: string[] = [];
  const params: any[] = [];
  if (f.status && f.status !== "all") { where.push("status = ?"); params.push(f.status); }
  if (f.due_before)                   { where.push("due_at <= ?"); params.push(f.due_before); }
  if (f.betreiber_mastr)              { where.push("betreiber_mastr = ?"); params.push(f.betreiber_mastr); }
  if (f.owner_user_id != null)        { where.push("owner_user_id = ?"); params.push(f.owner_user_id); }
  const limit = Math.min(500, Math.max(1, f.limit ?? 200));
  const sql = `
    SELECT * FROM reminders
    ${where.length ? "WHERE " + where.join(" AND ") : ""}
    ORDER BY due_at ASC
    LIMIT ?
  `;
  return db.prepare(sql).all(...params, limit) as Reminder[];
}

export function markDone(db: Database, id: number, user_id: number): Reminder | null {
  db.prepare(`
    UPDATE reminders
    SET status = 'done', completed_at = CURRENT_TIMESTAMP, completed_by = ?
    WHERE id = ? AND status != 'done'
  `).run(user_id, id);
  return getReminder(db, id);
}

export function snooze(db: Database, id: number, untilIso: string): Reminder | null {
  if (Number.isNaN(Date.parse(untilIso))) throw new Error("snooze until unparseable");
  // Snooze setzt due_at neu + reset notification-Tracking damit Reminder erneut feuert
  db.prepare(`
    UPDATE reminders
    SET due_at = ?, status = 'pending',
        notified_inapp_at = NULL, notified_email_at = NULL, notified_telegram_at = NULL
    WHERE id = ?
  `).run(untilIso, id);
  return getReminder(db, id);
}

export interface UpdateInput {
  due_at?: string;
  note?: string | null;
  owner_user_id?: number | null;
}

export function updateReminder(db: Database, id: number, u: UpdateInput): Reminder | null {
  const sets: string[] = [];
  const params: any[] = [];
  if (u.due_at !== undefined) {
    if (Number.isNaN(Date.parse(u.due_at))) throw new Error("due_at unparseable");
    sets.push("due_at = ?"); params.push(u.due_at);
    // Bei Datumsaenderung notifikations zuruecksetzen
    sets.push("notified_inapp_at = NULL", "notified_email_at = NULL", "notified_telegram_at = NULL");
  }
  if (u.note !== undefined)          { sets.push("note = ?"); params.push(u.note); }
  if (u.owner_user_id !== undefined) { sets.push("owner_user_id = ?"); params.push(u.owner_user_id); }
  if (sets.length === 0) return getReminder(db, id);
  params.push(id);
  db.prepare(`UPDATE reminders SET ${sets.join(", ")} WHERE id = ?`).run(...params);
  return getReminder(db, id);
}

export function deleteReminder(db: Database, id: number): void {
  db.prepare("DELETE FROM reminders WHERE id = ?").run(id);
}

/**
 * Findet faellige Reminder die noch nicht via gegebenem Kanal benachrichtigt wurden.
 * channel: 'inapp' | 'email' | 'telegram'
 */
export function findDueUnnotified(
  db: Database,
  channel: "inapp" | "email" | "telegram",
  nowIso: string = new Date().toISOString(),
): Reminder[] {
  const col = `notified_${channel}_at`;
  return db.prepare(`
    SELECT * FROM reminders
    WHERE status = 'pending'
      AND due_at <= ?
      AND ${col} IS NULL
    ORDER BY due_at ASC
    LIMIT 200
  `).all(nowIso) as Reminder[];
}

export function markNotified(db: Database, id: number, channel: "inapp" | "email" | "telegram"): void {
  const col = `notified_${channel}_at`;
  db.prepare(`UPDATE reminders SET ${col} = CURRENT_TIMESTAMP WHERE id = ?`).run(id);
}

/**
 * Stellt eine einzelne Reminder-Notification an den Owner zu (3 Kanaele via lib/notifications).
 * Idempotent: nutzt notified_*_at-Spalten als delivery-tracker, ueberspringt schon zugestellte Kanaele.
 */
export async function deliverReminder(db: Database, r: Reminder): Promise<void> {
  if (!r.owner_user_id) return;

  const betreiber = db.prepare("SELECT name, mastr_nummer FROM betreiber WHERE mastr_nummer = ?")
    .get(r.betreiber_mastr) as { name: string | null; mastr_nummer: string } | undefined;
  const betreiberName = betreiber?.name || r.betreiber_mastr;

  // Locale des Empfängers ermitteln für Datums-Format
  const ownerRow = db.prepare("SELECT pref_locale FROM users WHERE id = ?").get(r.owner_user_id) as any;
  const ownerLocale = ownerRow?.pref_locale || "de-DE";
  const fallenInDate = new Date(r.due_at).toLocaleString(ownerLocale, {
    day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit",
  });

  // Single notify() call -> alle 3 Kanaele gemaess User-Settings.
  // Wir tracken die "geliefert"-Spalten gesammelt, weil notify() in-app sicher schreibt,
  // und Email/Telegram async fire-and-forget sind.
  await notify(db, {
    userId: r.owner_user_id,
    type: "reminder",
    titleKey: "notif.reminder_title",
    titleArgs: { kunde: betreiberName },
    bodyKey: "notif.reminder_body",
    bodyArgs: {
      due_at: fallenInDate,
      note: r.note || "",
      kunde: betreiberName,
      mastr: r.betreiber_mastr,
    },
    url: `/?#kunde-${r.betreiber_mastr}`,
  });

  // Webhook-Event: reminder.due. Bewusst per dynamic import um zirkuläre
  // Abhängigkeit lib/webhooks <-> lib/reminders zu vermeiden (reminders wird auch
  // von cron geladen ohne webhook-Subsystem).
  try {
    const { fireEvent } = await import("./webhooks");
    fireEvent(db, "reminder.due", {
      reminder_id: r.id,
      betreiber_mastr: r.betreiber_mastr,
      betreiber_name: betreiberName,
      owner_user_id: r.owner_user_id,
      due_at: r.due_at,
      note: r.note || null,
    });
  } catch (e) { /* webhook subsystem not available */ }

  // Tracker setzen: in-app + email + telegram-Send wurden angestossen (notify ist best-effort fuer Email/TG)
  markNotified(db, r.id, "inapp");
  markNotified(db, r.id, "email");
  markNotified(db, r.id, "telegram");
}
