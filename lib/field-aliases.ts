// P1-8 additive: English field-aliases for international integrators.
// Client opts in via `?lang=en` — die Antwort enthaelt dann zusaetzliche englische Keys
// PARALLEL zu den deutschen (kein breaking change).

const ANLAGE_EN: Record<string, string> = {
  mastr_nummer: "mastr_id",
  betreiber_mastr: "operator_id",
  betreiber_name: "operator_name",
  nettonennleistung: "net_power_kw",
  bruttoleistung: "gross_power_kw",
  anzahl_module: "module_count",
  inbetriebnahme: "commissioning_date",
  energietraeger: "energy_source",
  anlagentyp: "installation_type",
  bundesland: "state",
  landkreis: "district",
  gemeinde: "municipality",
  ort: "city",
  strasse: "street",
  hausnummer: "house_number",
  plz: "postal_code",
  breitengrad: "latitude",
  laengengrad: "longitude",
  hauptausrichtung: "main_orientation",
  hauptausrichtung_neigungswinkel: "tilt_angle",
  modulhersteller: "module_manufacturer",
  wechselrichterhersteller: "inverter_manufacturer",
  wechselrichter_anzahl: "inverter_count",
  kontakt_email: "contact_email",
  kontakt_telefon: "contact_phone",
  kontakt_website: "contact_website",
  lead_score: "lead_score",     // already english
  status: "status",
  owner_id: "owner_id",
};

const KUNDE_EN: Record<string, string> = {
  mastr_nummer: "mastr_id",
  betreiber_ort: "city",
  betreiber_plz: "postal_code",
  anlagen_count: "installation_count",
  gesamt_leistung_kw: "total_power_kw",
  letzte_aktivitaet: "last_activity",
  offene_reminders: "open_reminders",
  telefon: "phone",
};

const REMINDER_EN: Record<string, string> = {
  betreiber_mastr: "operator_id",
  betreiber_name: "operator_name",
  due_at: "due_at",
  note: "note",
  status: "status",
  owner_user_id: "owner_user_id",
  created_by: "created_by",
  snoozed_until: "snoozed_until",
};

const TERMIN_EN: Record<string, string> = {
  anlage_id: "installation_id",
  start_ts: "start_ts",
  end_ts: "end_ts",
  attendee_email: "attendee_email",
  attendee_name: "attendee_name",
  rsvp_status: "rsvp_status",
};

/**
 * Fuegt englische Aliase als ZUSAETZLICHE Felder hinzu (deutsche bleiben).
 * Kein Datenverlust — Clients koennen weiter deutsche oder neuerdings englische Keys nutzen.
 */
export function withEnglishAliases(obj: any, type: "anlage" | "kunde" | "reminder" | "termin"): any {
  if (!obj || typeof obj !== "object") return obj;
  const map = type === "anlage" ? ANLAGE_EN : type === "kunde" ? KUNDE_EN : type === "reminder" ? REMINDER_EN : TERMIN_EN;
  const out = { ...obj };
  for (const [de, en] of Object.entries(map)) {
    if (de in obj && !(en in obj)) out[en] = obj[de];
  }
  return out;
}

export function mapEnglish(arr: any[], type: "anlage" | "kunde" | "reminder" | "termin"): any[] {
  return arr.map((x) => withEnglishAliases(x, type));
}
