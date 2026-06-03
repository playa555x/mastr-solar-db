import type { Database } from "bun:sqlite";

/**
 * App-Settings — strikt typisierte Defaults + frei konfigurierbare Werte.
 * Kategorien: calculation | visibility | firma | system | sla
 */
export interface AppSettings {
  // Berechnung
  repowering_module_wp: number;
  region_factor: number;
  storage_ratio_kwh_per_kwp: number;
  storage_cost_eur_per_kwh: number;
  curtailment_pct: number;
  recovery_quote_pct: number;
  modul_wp_alt: number;
  // Sichtbarkeits-Flags (1=anzeigen, 0=ausblenden)
  show_economics_card: number;
  show_repowering_card: number;
  show_storage_card: number;
  show_related_anlagen: number;
  show_reminders_in_anlage: number;
  show_satellite_map: number;
  // Firma — Impressum/Datenschutz/E-Mail-Variablen
  firma_name: string;
  firma_adresse: string;
  firma_url: string;
  firma_email: string;
  firma_telefon: string;
  firma_register: string;
  firma_ust_id: string;
  firma_vertreter: string;
  firma_verantwortlich: string;
  // System
  test_mode_email: string;
  zoho_forward_enabled: number;
  // SLA (Tage)
  sla_neu_tage: number;
  sla_kontaktiert_tage: number;
  sla_nicht_erreicht_tage: number;
  sla_terminiert_tage: number;
  sla_interessiert_tage: number;
  sla_abgeschlossen_tage: number;
  // Lead-Score-Gewichte (auto-rescore nach Aenderung empfohlen)
  lead_w_open: number;
  lead_w_click: number;
  lead_w_reply: number;
  lead_w_call_reached: number;
  lead_w_call_voicemail: number;
  lead_w_sentiment_pos: number;
  lead_w_sentiment_neg: number;
  lead_w_status_interessiert: number;
  lead_w_status_geantwortet: number;
  lead_w_status_kontaktiert: number;
  lead_w_status_nicht_interessiert: number;
  lead_w_status_gewonnen: number;
  lead_w_leistung_gt_100: number;
  lead_w_leistung_gt_500: number;
  lead_w_has_email: number;
  lead_w_has_phone: number;
}

const DEFAULTS: AppSettings = {
  repowering_module_wp: 720,
  region_factor: 1.0,
  storage_ratio_kwh_per_kwp: 1.0,
  storage_cost_eur_per_kwh: 650,
  curtailment_pct: 4,
  recovery_quote_pct: 85,
  modul_wp_alt: 230,
  show_economics_card: 1,
  show_repowering_card: 1,
  show_storage_card: 0,
  show_related_anlagen: 1,
  show_reminders_in_anlage: 1,
  show_satellite_map: 1,
  firma_name: "Repowering DE",
  firma_adresse: "",
  firma_url: "https://repowering-de.de",
  firma_email: "",
  firma_telefon: "",
  firma_register: "",
  firma_ust_id: "",
  firma_vertreter: "",
  firma_verantwortlich: "",
  test_mode_email: "",
  zoho_forward_enabled: 1,
  sla_neu_tage: 7,
  sla_kontaktiert_tage: 14,
  sla_nicht_erreicht_tage: 10,
  sla_terminiert_tage: 30,
  sla_interessiert_tage: 21,
  sla_abgeschlossen_tage: 60,
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

export interface SettingMeta {
  key: keyof AppSettings;
  label: string;
  type: "number" | "boolean" | "text" | "email" | "textarea";
  unit?: string;
  help: string;
  min?: number;
  max?: number;
  step?: number;
  placeholder?: string;
  category: "calculation" | "visibility" | "firma" | "system" | "sla";
  /** i18n-Keys — wenn gesetzt, resolved API-Endpoint in User-Locale. Fallback: label/help/unit literal. */
  labelKey?: string;
  helpKey?: string;
  unitKey?: string;
}

/** Lokalisierte Kopie der Meta-Liste für einen bestimmten Locale. */
export function localizeSettingsMeta(
  metas: readonly SettingMeta[],
  resolve: (key: string, fallback: string) => string,
): SettingMeta[] {
  return metas.map((m) => ({
    ...m,
    label: m.labelKey ? resolve(m.labelKey, m.label) : m.label,
    help: m.helpKey ? resolve(m.helpKey, m.help) : m.help,
    unit: m.unitKey ? resolve(m.unitKey, m.unit || "") : m.unit,
  }));
}

const TEXT_KEYS = new Set<string>([
  "firma_name","firma_adresse","firma_url","firma_email","firma_telefon",
  "firma_register","firma_ust_id","firma_vertreter","firma_verantwortlich","test_mode_email",
]);

export const SETTINGS_META: SettingMeta[] = [
  // ---- Firma (Impressum/Datenschutz/E-Mail-Templates) ----
  { key: "firma_name", category: "firma", type: "text", label: "Firmenname", help: "Name wie er auf Impressum, in E-Mail-Templates und im Dashboard auftaucht.", placeholder: "z.B. Repowering DE GmbH", labelKey: "appset.firma_name.label", helpKey: "appset.firma_name.help" },
  { key: "firma_adresse", category: "firma", type: "textarea", label: "Anschrift", help: "Strasse + PLZ + Ort. Wird in Impressum + E-Mail-Footer eingesetzt.", placeholder: "Musterstrasse 1, 12345 Musterstadt", labelKey: "appset.firma_adresse.label", helpKey: "appset.firma_adresse.help" },
  { key: "firma_url", category: "firma", type: "text", label: "Webseite", help: "Vollstaendige URL inkl. https://", placeholder: "https://repowering-de.de", labelKey: "appset.firma_url.label", helpKey: "appset.firma_url.help" },
  { key: "firma_email", category: "firma", type: "email", label: "Kontakt-E-Mail", help: "Standard-Kontakt-Mail (Impressum, Datenschutz-Anfragen).", placeholder: "kontakt@repowering-de.de", labelKey: "appset.firma_email.label", helpKey: "appset.firma_email.help" },
  { key: "firma_telefon", category: "firma", type: "text", label: "Telefon", help: "Hauptnummer fuer Impressum + E-Mail-Footer.", placeholder: "+49 30 1234567", labelKey: "appset.firma_telefon.label", helpKey: "appset.firma_telefon.help" },
  { key: "firma_register", category: "firma", type: "text", label: "Handelsregister", help: "Amtsgericht + HRB-Nr.", placeholder: "Amtsgericht Berlin HRB 12345", labelKey: "appset.firma_register.label", helpKey: "appset.firma_register.help" },
  { key: "firma_ust_id", category: "firma", type: "text", label: "Umsatzsteuer-ID", help: "USt-ID nach §27a UStG.", placeholder: "DE123456789", labelKey: "appset.firma_ust_id.label", helpKey: "appset.firma_ust_id.help" },
  { key: "firma_vertreter", category: "firma", type: "text", label: "Vertretungsberechtigt", help: "Geschaeftsfuehrer/Vorstand.", placeholder: "Max Mustermann", labelKey: "appset.firma_vertreter.label", helpKey: "appset.firma_vertreter.help" },
  { key: "firma_verantwortlich", category: "firma", type: "text", label: "Verantwortlich fuer Inhalt", help: "Verantwortlich nach §18 Abs. 2 MStV. Meist gleicher Name wie Vertreter.", placeholder: "Max Mustermann", labelKey: "appset.firma_verantwortlich.label", helpKey: "appset.firma_verantwortlich.help" },
  // ---- System (Test-Mode + Zoho) ----
  { key: "test_mode_email", category: "system", type: "email", label: "TEST-MODUS E-Mail-Empfaenger", help: "Wenn gesetzt: ALLE ausgehenden Mails (Single + Bulk + Bestaetigungen) werden zu dieser Adresse umgeleitet. Original-Empfaenger im Betreff sichtbar. LEER lassen = normaler Versand.", placeholder: "emir@emiroil.de", labelKey: "appset.test_mode_email.label", helpKey: "appset.test_mode_email.help" },
  { key: "zoho_forward_enabled", category: "system", type: "boolean", label: "Zoho-Form Weiterleitung aktiv", help: "Wenn AN: Anfragen ueber /check werden zusaetzlich an die Zoho-Form weitergeleitet. Waehrend Tests AUSSCHALTEN um echte Zoho-Inbox nicht zu verschmutzen.", labelKey: "appset.zoho_forward.label", helpKey: "appset.zoho_forward.help" },
  // ---- Lead-Score-Gewichte (Akquise-Prioritaet) ----
  { key: "lead_w_open", category: "calculation", type: "number", label: "Mail geoeffnet", unit: "Punkte/Open", help: "Wieviele Score-Punkte pro Open eines Tracking-Pixels.", min: 0, max: 50, step: 1, labelKey: "appset.lead_w_open.label", helpKey: "appset.lead_w_open.help", unitKey: "appset.unit.points_per_open" },
  { key: "lead_w_click", category: "calculation", type: "number", label: "Link geklickt", unit: "Punkte/Klick", help: "Hoeher als Open weil staerkeres Signal.", min: 0, max: 50, step: 1, labelKey: "appset.lead_w_click.label", helpKey: "appset.lead_w_click.help", unitKey: "appset.unit.points_per_click" },
  { key: "lead_w_reply", category: "calculation", type: "number", label: "Email-Antwort eingegangen", unit: "Punkte", help: "Bestes Signal — Kunde hat sich aktiv gemeldet.", min: 0, max: 100, step: 1, labelKey: "appset.lead_w_reply.label", helpKey: "appset.lead_w_reply.help", unitKey: "appset.unit.points" },
  { key: "lead_w_call_reached", category: "calculation", type: "number", label: "Anruf erfolgreich (erreicht)", unit: "Punkte", help: "Erreichte Person am Telefon.", min: 0, max: 50, step: 1, labelKey: "appset.lead_w_call_reached.label", helpKey: "appset.lead_w_call_reached.help", unitKey: "appset.unit.points" },
  { key: "lead_w_call_voicemail", category: "calculation", type: "number", label: "Anruf auf Mailbox", unit: "Punkte", help: "Mailbox-Treffer = halbes Signal.", min: 0, max: 30, step: 1, labelKey: "appset.lead_w_call_voicemail.label", helpKey: "appset.lead_w_call_voicemail.help", unitKey: "appset.unit.points" },
  { key: "lead_w_sentiment_pos", category: "calculation", type: "number", label: "AI: positives Gespraech", unit: "Punkte", help: "AI-Bewertung des Anrufs positiv.", min: 0, max: 50, step: 1, labelKey: "appset.lead_w_sentiment_pos.label", helpKey: "appset.lead_w_sentiment_pos.help", unitKey: "appset.unit.points" },
  { key: "lead_w_sentiment_neg", category: "calculation", type: "number", label: "AI: negatives Gespraech", unit: "Punkte", help: "Negativ → Score senken. Standard -10.", min: -100, max: 0, step: 1, labelKey: "appset.lead_w_sentiment_neg.label", helpKey: "appset.lead_w_sentiment_neg.help", unitKey: "appset.unit.points" },
  { key: "lead_w_status_kontaktiert", category: "calculation", type: "number", label: "Status: Kontaktiert", unit: "Punkte", help: "Bonus wenn schon kontaktiert.", min: 0, max: 50, step: 1, labelKey: "appset.lead_w_status_kontaktiert.label", helpKey: "appset.lead_w_status_kontaktiert.help", unitKey: "appset.unit.points" },
  { key: "lead_w_status_geantwortet", category: "calculation", type: "number", label: "Status: Geantwortet", unit: "Punkte", help: "Bonus wenn Kunde geantwortet hat.", min: 0, max: 80, step: 1, labelKey: "appset.lead_w_status_geantwortet.label", helpKey: "appset.lead_w_status_geantwortet.help", unitKey: "appset.unit.points" },
  { key: "lead_w_status_interessiert", category: "calculation", type: "number", label: "Status: Interessiert", unit: "Punkte", help: "Bonus wenn als interessiert markiert.", min: 0, max: 100, step: 1, labelKey: "appset.lead_w_status_interessiert.label", helpKey: "appset.lead_w_status_interessiert.help", unitKey: "appset.unit.points" },
  { key: "lead_w_status_gewonnen", category: "calculation", type: "number", label: "Status: Gewonnen", unit: "Punkte", help: "Bonus wenn gewonnen (max. Score).", min: 0, max: 200, step: 5, labelKey: "appset.lead_w_status_gewonnen.label", helpKey: "appset.lead_w_status_gewonnen.help", unitKey: "appset.unit.points" },
  { key: "lead_w_status_nicht_interessiert", category: "calculation", type: "number", label: "Status: Nicht interessiert", unit: "Punkte (negativ)", help: "Stark negativ um Lead zu deprioritisieren.", min: -200, max: 0, step: 5, labelKey: "appset.lead_w_status_nicht_interessiert.label", helpKey: "appset.lead_w_status_nicht_interessiert.help", unitKey: "appset.unit.points_neg" },
  { key: "lead_w_leistung_gt_100", category: "calculation", type: "number", label: "Anlage > 100 kWp", unit: "Punkte Bonus", help: "Grosse Anlagen sind als Akquise-Lead mehr wert.", min: 0, max: 30, step: 1, labelKey: "appset.lead_w_leistung_gt_100.label", helpKey: "appset.lead_w_leistung_gt_100.help", unitKey: "appset.unit.points_bonus" },
  { key: "lead_w_leistung_gt_500", category: "calculation", type: "number", label: "Anlage > 500 kWp (zusaetzlich)", unit: "Punkte Bonus", help: "Sehr grosse Anlagen extra-prioritaer.", min: 0, max: 30, step: 1, labelKey: "appset.lead_w_leistung_gt_500.label", helpKey: "appset.lead_w_leistung_gt_500.help", unitKey: "appset.unit.points_bonus" },
  { key: "lead_w_has_email", category: "calculation", type: "number", label: "Email-Adresse vorhanden", unit: "Punkte Bonus", help: "Kontaktbar = mehr wert.", min: 0, max: 30, step: 1, labelKey: "appset.lead_w_has_email.label", helpKey: "appset.lead_w_has_email.help", unitKey: "appset.unit.points_bonus" },
  { key: "lead_w_has_phone", category: "calculation", type: "number", label: "Telefonnummer vorhanden", unit: "Punkte Bonus", help: "Anruf moeglich = mehr wert.", min: 0, max: 30, step: 1, labelKey: "appset.lead_w_has_phone.label", helpKey: "appset.lead_w_has_phone.help", unitKey: "appset.unit.points_bonus" },
  // ---- SLA-Konfiguration (Pipeline-Stale-Detection) ----
  { key: "sla_neu_tage", category: "sla", type: "number", label: "Status 'Neu' max. Liegezeit", unit: "Tage", help: "Wenn eine Anlage laenger als X Tage in 'Neu' liegt: Pipeline-Stau-Warnung. 0 = keine Warnung.", min: 0, max: 365, step: 1, labelKey: "appset.sla_neu.label", helpKey: "appset.sla_neu.help", unitKey: "appset.unit.days" },
  { key: "sla_kontaktiert_tage", category: "sla", type: "number", label: "Status 'Kontaktiert' max.", unit: "Tage", help: "Antwort sollte innerhalb dieser Tage kommen.", min: 0, max: 365, step: 1, labelKey: "appset.sla_kontaktiert.label", helpKey: "appset.sla_kontaktiert.help", unitKey: "appset.unit.days" },
  { key: "sla_nicht_erreicht_tage", category: "sla", type: "number", label: "Status 'Nicht erreicht' max.", unit: "Tage", help: "Zweiter Versuch faellig nach X Tagen.", min: 0, max: 365, step: 1, labelKey: "appset.sla_nicht_erreicht.label", helpKey: "appset.sla_nicht_erreicht.help", unitKey: "appset.unit.days" },
  { key: "sla_terminiert_tage", category: "sla", type: "number", label: "Status 'Terminiert' max.", unit: "Tage", help: "Termin sollte spaetestens nach X Tagen sein.", min: 0, max: 365, step: 1, labelKey: "appset.sla_terminiert.label", helpKey: "appset.sla_terminiert.help", unitKey: "appset.unit.days" },
  { key: "sla_interessiert_tage", category: "sla", type: "number", label: "Status 'Interessiert' max.", unit: "Tage", help: "Angebot sollte innerhalb X Tagen rausgehen.", min: 0, max: 365, step: 1, labelKey: "appset.sla_interessiert.label", helpKey: "appset.sla_interessiert.help", unitKey: "appset.unit.days" },
  { key: "sla_abgeschlossen_tage", category: "sla", type: "number", label: "Status 'Abgeschlossen' max.", unit: "Tage", help: "Final-Phase: Abschluss sollte in X Tagen kommen.", min: 0, max: 365, step: 1, labelKey: "appset.sla_abgeschlossen.label", helpKey: "appset.sla_abgeschlossen.help", unitKey: "appset.unit.days" },
  // ---- Berechnungs-Annahmen ----
  { key: "repowering_module_wp", category: "calculation", type: "number", label: "Modul-Leistung (Repowering)", unit: "Wp", help: "Tier-1 Hochleistungsmodul 2026. Aktuell typisch 700-750 Wp.", min: 400, max: 900, step: 10, labelKey: "appset.repowering_module_wp.label", helpKey: "appset.repowering_module_wp.help" },
  { key: "region_factor", category: "calculation", type: "number", label: "Region-Faktor", unit: "× (1.0 = DE-Mitte)", help: "Anpassung auf den Standort: 0.90 Norddeutschland (z.B. Hamburg), 1.00 Mitte (Frankfurt), 1.05 Sueden (Muenchen). Basis sind PVGIS-Daten fuer DE-Mitte.", min: 0.85, max: 1.10, step: 0.01, labelKey: "appset.region_factor.label", helpKey: "appset.region_factor.help", unitKey: "appset.unit.region_factor" },
  { key: "storage_ratio_kwh_per_kwp", category: "calculation", type: "number", label: "Speicher pro kW PV", unit: "kWh/kWp", help: "Speichergroesse relativ zur PV-Leistung. Fuer reine Abregelungs-Pufferung: 0.5-1.0.", min: 0.1, max: 3, step: 0.1, labelKey: "appset.storage_ratio.label", helpKey: "appset.storage_ratio.help" },
  { key: "storage_cost_eur_per_kwh", category: "calculation", type: "number", label: "Speicher-Investkosten", unit: "EUR/kWh", help: "Marktpreis schluesselfertige Gewerbe-Speicher (LFP) 2026: 500-800 EUR/kWh.", min: 200, max: 1500, step: 50, labelKey: "appset.storage_cost.label", helpKey: "appset.storage_cost.help" },
  { key: "curtailment_pct", category: "calculation", type: "number", label: "Abregelungsanteil", unit: "% der Jahresproduktion", help: "BNetzA-Monitoring 2024: 2-5% bei Gross-PV mit EinsMan-Vertrag.", min: 0, max: 20, step: 0.5, labelKey: "appset.curtailment.label", helpKey: "appset.curtailment.help", unitKey: "appset.unit.pct_annual" },
  { key: "recovery_quote_pct", category: "calculation", type: "number", label: "Speicher-Rueckgewinnungsquote", unit: "% der Abregelung", help: "Typisch 70-95% bei richtiger Dimensionierung.", min: 0, max: 100, step: 5, labelKey: "appset.recovery.label", helpKey: "appset.recovery.help", unitKey: "appset.unit.pct_curtailed" },
  { key: "modul_wp_alt", category: "calculation", type: "number", label: "Alt-Modul-Leistung (E-Mail-Templates)", unit: "Wp", help: "Wp-Zahl der Alt-Module 2009-2014 fuer Repowering-Vergleichsrechnung in Templates. Standard 220-250 Wp.", min: 150, max: 350, step: 5, labelKey: "appset.modul_wp_alt.label", helpKey: "appset.modul_wp_alt.help" },
  // ---- Sichtbarkeits-Toggles ----
  { key: "show_economics_card", category: "visibility", type: "boolean", label: "Wirtschaftlichkeits-Karte", help: "Jahres-Produktion + EEG-Vergütung im Anlage-Detail anzeigen.", labelKey: "appset.show_economics.label", helpKey: "appset.show_economics.help" },
  { key: "show_repowering_card", category: "visibility", type: "boolean", label: "Repowering-Karte", help: "Repowering-Potenzial im Anlage-Detail anzeigen.", labelKey: "appset.show_repowering.label", helpKey: "appset.show_repowering.help" },
  { key: "show_storage_card", category: "visibility", type: "boolean", label: "Speicher-Karte", help: "Speicher-Wirtschaftlichkeit anzeigen.", labelKey: "appset.show_storage.label", helpKey: "appset.show_storage.help" },
  { key: "show_related_anlagen", category: "visibility", type: "boolean", label: "\"Weitere Anlagen dieses Kunden\"", help: "Section mit anderen Anlagen desselben Kunden im Anlage-Detail.", labelKey: "appset.show_related.label", helpKey: "appset.show_related.help" },
  { key: "show_reminders_in_anlage", category: "visibility", type: "boolean", label: "Wiedervorlagen-Bereich im Anlage-Detail", help: "Wiedervorlagen-Quick-Picker im Anlage-Detail anzeigen.", labelKey: "appset.show_reminders.label", helpKey: "appset.show_reminders.help" },
  { key: "show_satellite_map", category: "visibility", type: "boolean", label: "Satelliten-Karte", help: "Satelliten-Bild der Anlage anzeigen.", labelKey: "appset.show_satellite.label", helpKey: "appset.show_satellite.help" },
];

export function getAppSettings(db: Database): AppSettings {
  const rows = db.prepare("SELECT key, value FROM app_settings").all() as { key: string; value: string }[];
  const map = new Map(rows.map((r) => [r.key, r.value]));
  const result: any = { ...DEFAULTS };
  for (const k of Object.keys(DEFAULTS)) {
    const v = map.get(k);
    if (v === undefined) continue;
    if (TEXT_KEYS.has(k)) {
      result[k] = v;
    } else {
      const num = parseFloat(v);
      if (!isNaN(num)) result[k] = num;
    }
  }
  return result;
}

export function updateAppSetting(db: Database, key: keyof AppSettings, value: number | string, userId: number): void {
  const meta = SETTINGS_META.find((m) => m.key === key);
  if (!meta) throw new Error(`Unbekannter Setting-Key: ${key}`);
  if (meta.type === "boolean") {
    const n = Number(value);
    if (n !== 0 && n !== 1) throw new Error(`${meta.label}: Boolean (0 oder 1)`);
    db.prepare(`
      INSERT INTO app_settings (key, value, updated_by, updated_at)
      VALUES (?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = CURRENT_TIMESTAMP
    `).run(key, String(n), userId);
    return;
  }
  if (meta.type === "number") {
    const n = parseFloat(String(value));
    if (isNaN(n)) throw new Error(`${meta.label}: Zahl erwartet`);
    if (meta.min != null && n < meta.min) throw new Error(`${meta.label}: Wert ${n} < ${meta.min}`);
    if (meta.max != null && n > meta.max) throw new Error(`${meta.label}: Wert ${n} > ${meta.max}`);
    db.prepare(`
      INSERT INTO app_settings (key, value, updated_by, updated_at)
      VALUES (?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = CURRENT_TIMESTAMP
    `).run(key, String(n), userId);
    return;
  }
  // text / email / textarea
  const s = String(value || "").trim().slice(0, 2000);
  if (meta.type === "email" && s && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) {
    throw new Error(`${meta.label}: Ungueltige E-Mail-Adresse`);
  }
  db.prepare(`
    INSERT INTO app_settings (key, value, updated_by, updated_at)
    VALUES (?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = CURRENT_TIMESTAMP
  `).run(key, s, userId);
}
