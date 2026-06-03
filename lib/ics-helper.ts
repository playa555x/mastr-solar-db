import { createEvent, type EventAttributes } from "ics";

export interface TerminInput {
  uid: string;
  title: string;
  description?: string | null;
  location?: string | null;
  start_ts: number;
  end_ts: number;
  attendee_email?: string | null;
  attendee_name?: string | null;
  organizer_email: string;
  organizer_name?: string;
  sequence?: number;
  status?: string;
  acceptUrl?: string;
}

function tsToArray(ts: number): [number, number, number, number, number] {
  const d = new Date(ts);
  return [d.getFullYear(), d.getMonth() + 1, d.getDate(), d.getHours(), d.getMinutes()];
}

export function generateICS(t: TerminInput): string {
  const event: EventAttributes = {
    uid: t.uid,
    start: tsToArray(t.start_ts),
    end: tsToArray(t.end_ts),
    title: t.title,
    description: (t.description || "") + (t.acceptUrl ? `\n\nBestaetigen: ${t.acceptUrl}` : ""),
    location: t.location || "",
    organizer: { name: t.organizer_name || "Solar DB", email: t.organizer_email },
    attendees: t.attendee_email ? [{
      name: t.attendee_name || t.attendee_email,
      email: t.attendee_email,
      rsvp: true,
    }] : [],
    status: (t.status === "cancelled" ? "CANCELLED" : "CONFIRMED") as any,
    sequence: t.sequence || 0,
    method: "REQUEST",
    productId: "mastr-solar-db",
  };
  const { error, value } = createEvent(event);
  if (error) throw error;
  return value || "";
}
