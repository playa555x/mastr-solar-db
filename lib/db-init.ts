import type { Database } from "bun:sqlite";

export function initSchema(db: Database): void {
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA foreign_keys = ON");

  db.run(`
    CREATE TABLE IF NOT EXISTS anlagen (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mastr_nummer TEXT UNIQUE,
      einheit_id INTEGER,
      name TEXT,
      betreiber_name TEXT,
      betreiber_mastr TEXT,
      betreiber_id INTEGER,
      strasse TEXT, plz TEXT, ort TEXT, bundesland TEXT,
      landkreis TEXT, gemeinde TEXT,
      breitengrad REAL, laengengrad REAL,
      bruttoleistung REAL, nettonennleistung REAL,
      anzahl_module INTEGER, inbetriebnahme TEXT,
      energietraeger TEXT, anlagentyp TEXT, betriebsstatus TEXT,
      kontakt_telefon TEXT, kontakt_fax TEXT, kontakt_email TEXT,
      kontakt_website TEXT, kontakt_adresse TEXT,
      notizen TEXT, status TEXT DEFAULT 'neu',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS betreiber (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mastr_nummer TEXT UNIQUE, akteur_id INTEGER,
      name TEXT, rechtsform TEXT,
      strasse TEXT, plz TEXT, ort TEXT, bundesland TEXT, land TEXT,
      telefon TEXT, fax TEXT, email TEXT, website TEXT,
      handelsregister TEXT, umsatzsteuer_id TEXT, registrierungsdatum TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS notizen (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      anlage_id INTEGER, text TEXT,
      user_id INTEGER,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (anlage_id) REFERENCES anlagen(id)
    )
  `);
  // Add user_id column to notizen if it does not exist (idempotent)
  try {
    const cols = db.prepare("PRAGMA table_info(notizen)").all() as any[];
    if (!cols.find((c) => c.name === "user_id")) {
      db.run("ALTER TABLE notizen ADD COLUMN user_id INTEGER");
    }
  } catch {}

  // Idempotente Erweiterungen anlagen — fuer MaStR-Bulk-Import (vollstaendig)
  try {
    const cols = db.prepare("PRAGMA table_info(anlagen)").all() as any[];
    const has = (n: string) => cols.find((c) => c.name === n);
    const adds: Array<[string, string]> = [
      // Standort & Geo
      ["gemeindeschluessel", "TEXT"],
      ["hausnummer", "TEXT"],
      ["unternehmensgemeinde", "TEXT"],
      ["flurstuecke", "TEXT"],
      // Lage & Ausrichtung
      ["lage_einheit", "TEXT"],
      ["hauptausrichtung", "TEXT"],
      ["hauptausrichtung_neigungswinkel", "TEXT"],
      ["nebenausrichtung", "TEXT"],
      ["nebenausrichtung_neigungswinkel", "TEXT"],
      // Speicher & Kopplung
      ["hat_speicher", "INTEGER DEFAULT 0"],
      ["speicher_kwh", "REAL"],
      ["gekoppelte_einheit_mastr", "TEXT"],
      ["batteriespeicher_mastr", "TEXT"],
      // EEG / Foerderung
      ["eeg_anlage", "INTEGER DEFAULT 0"],
      ["eeg_mastr_nummer", "TEXT"],
      ["eeg_inbetriebnahmedatum", "TEXT"],
      ["eeg_anlagenschluessel", "TEXT"],
      ["installierte_leistung", "REAL"],
      ["registrierte_leistung", "REAL"],
      ["zuschlagsnummer", "TEXT"],
      ["zuschlag_kwh_betrag", "REAL"],
      ["foerderverfahren", "TEXT"],
      // Technik
      ["spannungsebene", "TEXT"],
      ["leistungsbegrenzung", "TEXT"],
      ["einspeisungsart", "TEXT"],
      ["volleinspeiser", "INTEGER DEFAULT 0"],
      ["fernsteuerbarkeit_nb", "INTEGER DEFAULT 0"],
      ["fernsteuerbarkeit_dv", "INTEGER DEFAULT 0"],
      ["fernsteuerbarkeit_dr", "INTEGER DEFAULT 0"],
      ["wechselrichter_leistung", "REAL"],
      ["wechselrichter_anzahl", "INTEGER"],
      ["nutzbare_speicherkapazitaet", "REAL"],
      ["modulhersteller", "TEXT"],
      ["wechselrichterhersteller", "TEXT"],
      // Status / Zeit
      ["registrierungsdatum", "TEXT"],
      ["geplantes_inbetriebnahmedatum", "TEXT"],
      ["datum_endgueltige_stilllegung", "TEXT"],
      ["datum_beginn_voruebergehende_stilllegung", "TEXT"],
      ["datum_wiederaufnahme_betrieb", "TEXT"],
      ["letzte_aenderung", "TEXT"],
      // Netz & Anschluss
      ["nb_betreiber_mastr", "TEXT"],
      ["anschluss_an_hoechst_oder_hochspannung", "INTEGER DEFAULT 0"],
      // Sonstiges / Meta
      ["weic", "TEXT"],
      ["weic_anzeigename", "TEXT"],
      ["bnetza_url", "TEXT"],
      ["raw_data", "TEXT"], // JSON-Dump aller XML-Felder fuer Zukunftssicherheit
      ["owner_id", "INTEGER"], // Lead-Owner aus users-Tabelle
      ["position_refined_at", "TEXT"], // Zeitstempel der OSM-Praezisierung der Koords
      ["position_refined_distance_m", "INTEGER"], // wie weit hat sich der Pin bewegt
      ["position_osm_ref", "TEXT"], // welches OSM-Objekt (way/123456)
      // JSON-Array der Felder die ein User manuell editiert hat (PUT /api/anlagen/:id).
      // Der Daily-Import respektiert diese Liste und überschreibt diese Felder NICHT mehr.
      // Beispielwert: ["betreiber_name","plz","nettonennleistung"]
      ["edited_fields", "TEXT DEFAULT '[]'"],
    ];
    for (const [col, type] of adds) {
      if (!has(col)) db.run(`ALTER TABLE anlagen ADD COLUMN ${col} ${type}`);
    }
  } catch (e) {
    console.error("Schema-Migration anlagen fehlgeschlagen:", e);
  }

  // betreiber-Tabelle: ergaenzte Felder
  try {
    const cols = db.prepare("PRAGMA table_info(betreiber)").all() as any[];
    const has = (n: string) => cols.find((c) => c.name === n);
    const adds: Array<[string, string]> = [
      ["personenart", "TEXT"],
      ["vorname", "TEXT"],
      ["nachname", "TEXT"],
      ["titel", "TEXT"],
      ["anrede", "TEXT"],
      ["hausnummer", "TEXT"],
      ["adresszusatz", "TEXT"],
      ["marktrolle", "TEXT"],
      ["raw_data", "TEXT"],
    ];
    for (const [col, type] of adds) {
      if (!has(col)) db.run(`ALTER TABLE betreiber ADD COLUMN ${col} ${type}`);
    }
  } catch (e) {
    console.error("Schema-Migration betreiber fehlgeschlagen:", e);
  }

  db.run(`
    CREATE TABLE IF NOT EXISTS import_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      started_at TEXT DEFAULT CURRENT_TIMESTAMP,
      finished_at TEXT,
      source TEXT,
      status TEXT,
      zip_url TEXT,
      zip_size_bytes INTEGER,
      anlagen_inserted INTEGER DEFAULT 0,
      anlagen_updated INTEGER DEFAULT 0,
      anlagen_skipped INTEGER DEFAULT 0,
      betreiber_inserted INTEGER DEFAULT 0,
      betreiber_updated INTEGER DEFAULT 0,
      error_message TEXT,
      duration_ms INTEGER
    )
  `);
  db.run("CREATE INDEX IF NOT EXISTS idx_import_log_started ON import_log(started_at DESC)");

  db.run(`
    CREATE TABLE IF NOT EXISTS enrich_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      started_at TEXT DEFAULT CURRENT_TIMESTAMP,
      finished_at TEXT,
      source TEXT,
      status TEXT,
      total INTEGER DEFAULT 0,
      processed INTEGER DEFAULT 0,
      ok INTEGER DEFAULT 0,
      not_found INTEGER DEFAULT 0,
      no_data INTEGER DEFAULT 0,
      error_count INTEGER DEFAULT 0,
      with_email INTEGER DEFAULT 0,
      with_phone INTEGER DEFAULT 0,
      error_message TEXT,
      duration_ms INTEGER
    )
  `);
  db.run("CREATE INDEX IF NOT EXISTS idx_enrich_log_started ON enrich_log(started_at DESC)");

  // ===== Owner-Index + Activity-Log =====
  db.run("CREATE INDEX IF NOT EXISTS idx_anlagen_owner ON anlagen(owner_id)");

  db.run(`
    CREATE TABLE IF NOT EXISTS activities (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      anlage_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      type TEXT NOT NULL,
      description TEXT,
      metadata TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (anlage_id) REFERENCES anlagen(id),
      FOREIGN KEY (user_id) REFERENCES users(id)
    )
  `);
  db.run("CREATE INDEX IF NOT EXISTS idx_activities_anlage ON activities(anlage_id, created_at DESC)");
  db.run("CREATE INDEX IF NOT EXISTS idx_activities_user ON activities(user_id, created_at DESC)");

  // ===== Messages (Comments + DMs) =====
  db.run(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      anlage_id INTEGER,
      from_user_id INTEGER NOT NULL,
      to_user_id INTEGER,
      text TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (anlage_id) REFERENCES anlagen(id),
      FOREIGN KEY (from_user_id) REFERENCES users(id),
      FOREIGN KEY (to_user_id) REFERENCES users(id)
    )
  `);
  db.run("CREATE INDEX IF NOT EXISTS idx_messages_anlage ON messages(anlage_id, created_at DESC)");
  db.run("CREATE INDEX IF NOT EXISTS idx_messages_dm ON messages(from_user_id, to_user_id, created_at DESC)");

  // ===== Notifications =====
  db.run(`
    CREATE TABLE IF NOT EXISTS notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      type TEXT NOT NULL,
      title TEXT,
      body TEXT,
      anlage_id INTEGER,
      message_id INTEGER,
      from_user_id INTEGER,
      read_at TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id)
    )
  `);
  db.run("CREATE INDEX IF NOT EXISTS idx_notifications_user_unread ON notifications(user_id, read_at, created_at DESC)");

  // Email drafts
  db.run(`
    CREATE TABLE IF NOT EXISTS email_drafts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      anlage_id INTEGER,
      to_addr TEXT, cc_addr TEXT, subject TEXT, body_html TEXT,
      attachment_ids TEXT,
      create_termin INTEGER DEFAULT 0,
      termin_title TEXT, termin_start TEXT, termin_end TEXT, termin_description TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id),
      FOREIGN KEY (anlage_id) REFERENCES anlagen(id)
    )
  `);
  db.run("CREATE INDEX IF NOT EXISTS idx_drafts_user ON email_drafts(user_id, updated_at DESC)");
  db.run("CREATE INDEX IF NOT EXISTS idx_drafts_anlage ON email_drafts(anlage_id, updated_at DESC)");

  // ===== Calls =====
  db.run(`
    CREATE TABLE IF NOT EXISTS calls (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      anlage_id INTEGER,
      betreiber_mastr TEXT,
      direction TEXT NOT NULL DEFAULT 'out',
      phone_number TEXT,
      contact_name TEXT,
      started_at TEXT DEFAULT CURRENT_TIMESTAMP,
      duration_seconds INTEGER,
      outcome TEXT,
      notes TEXT,
      ai_summary TEXT,
      ai_next_steps TEXT,
      ai_sentiment TEXT,
      status_before TEXT, status_after TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id),
      FOREIGN KEY (anlage_id) REFERENCES anlagen(id)
    )
  `);
  db.run("CREATE INDEX IF NOT EXISTS idx_calls_anlage ON calls(anlage_id, started_at DESC)");
  db.run("CREATE INDEX IF NOT EXISTS idx_calls_user ON calls(user_id, started_at DESC)");

  // ===== Call-Scripts =====
  db.run(`
    CREATE TABLE IF NOT EXISTS call_scripts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER REFERENCES users(id),
      name TEXT NOT NULL,
      applies_to_status TEXT,
      body_md TEXT,
      is_default INTEGER DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // ===== Email-Events (Tracking) =====
  db.run(`
    CREATE TABLE IF NOT EXISTS email_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sent_email_id INTEGER NOT NULL,
      event_type TEXT NOT NULL,
      url TEXT,
      ip_hash TEXT, ua_hash TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (sent_email_id) REFERENCES sent_emails(id)
    )
  `);
  db.run("CREATE INDEX IF NOT EXISTS idx_email_events ON email_events(sent_email_id, event_type, created_at DESC)");

  // Stelle sicher dass sent_emails existiert, BEVOR ALTER-Migration laeuft (fresh DB)
  db.run(`
    CREATE TABLE IF NOT EXISTS sent_emails (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      anlage_id INTEGER,
      to_addr TEXT, cc_addr TEXT, subject TEXT, body_preview TEXT,
      termin_id INTEGER, status TEXT, error TEXT,
      attachment_ids TEXT,
      sent_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // sent_emails Erweiterung (Tracking)
  try {
    const cols = db.prepare("PRAGMA table_info(sent_emails)").all() as any[];
    const has = (n: string) => cols.find((c) => c.name === n);
    const adds: Array<[string, string]> = [
      ["tracking_token", "TEXT"],
      ["open_count", "INTEGER DEFAULT 0"],
      ["click_count", "INTEGER DEFAULT 0"],
      ["first_open_at", "TEXT"],
      ["last_event_at", "TEXT"],
    ];
    for (const [col, type] of adds) {
      if (!has(col)) db.run(`ALTER TABLE sent_emails ADD COLUMN ${col} ${type}`);
    }
  } catch (e) { console.error("sent_emails-Migration:", e); }
  db.run("CREATE INDEX IF NOT EXISTS idx_sent_token ON sent_emails(tracking_token)");

  // ===== Campaigns =====
  db.run(`
    CREATE TABLE IF NOT EXISTS campaigns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      template_id INTEGER,
      filter_json TEXT,
      attachment_ids TEXT,
      per_day INTEGER DEFAULT 50,
      delay_minutes INTEGER DEFAULT 5,
      status TEXT DEFAULT 'draft',
      total_count INTEGER DEFAULT 0,
      sent_count INTEGER DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      started_at TEXT, finished_at TEXT,
      FOREIGN KEY (user_id) REFERENCES users(id)
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS campaign_recipients (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      campaign_id INTEGER NOT NULL,
      anlage_id INTEGER NOT NULL,
      to_addr TEXT NOT NULL,
      scheduled_for TEXT,
      sent_at TEXT,
      sent_email_id INTEGER,
      status TEXT DEFAULT 'pending',
      error TEXT,
      FOREIGN KEY (campaign_id) REFERENCES campaigns(id),
      FOREIGN KEY (anlage_id) REFERENCES anlagen(id)
    )
  `);
  db.run("CREATE INDEX IF NOT EXISTS idx_recipients_due ON campaign_recipients(status, scheduled_for)");
  db.run("CREATE INDEX IF NOT EXISTS idx_recipients_campaign ON campaign_recipients(campaign_id)");

  // Stelle sicher dass users existiert, BEVOR ALTER laeuft
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      email TEXT NOT NULL,
      display_name TEXT,
      password_hash TEXT NOT NULL,
      color TEXT DEFAULT '#3b82f6',
      smtp_host TEXT, smtp_port INTEGER, smtp_secure INTEGER DEFAULT 1,
      smtp_user TEXT,
      smtp_pass_enc TEXT,
      smtp_from_name TEXT, smtp_from_email TEXT,
      signature_html TEXT,
      active INTEGER DEFAULT 1,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // ===== Notification Settings (pro User) + Telegram-Config =====
  try {
    const cols = db.prepare("PRAGMA table_info(users)").all() as any[];
    const has = (n: string) => cols.find((c) => c.name === n);
    const adds: Array<[string, string]> = [
      ["notif_email_mention", "INTEGER DEFAULT 1"],
      ["notif_email_dm", "INTEGER DEFAULT 1"],
      ["notif_email_assignment", "INTEGER DEFAULT 1"],
      ["notif_email_reminder", "INTEGER DEFAULT 1"],
      ["notif_telegram_mention", "INTEGER DEFAULT 0"],
      ["notif_telegram_dm", "INTEGER DEFAULT 0"],
      ["notif_telegram_assignment", "INTEGER DEFAULT 0"],
      ["notif_telegram_reminder", "INTEGER DEFAULT 1"],
      ["telegram_chat_id", "TEXT"],
      ["telegram_bot_token_enc", "TEXT"],
      ["telegram_session_enc", "TEXT"],
      ["telegram_phone", "TEXT"],
      ["telegram_user_id", "INTEGER"],
      ["onboarding_done", "INTEGER DEFAULT 0"],
      ["anthropic_key_enc", "TEXT"],
      ["ai_provider", "TEXT DEFAULT 'anthropic'"],
      ["ollama_url", "TEXT"],
    ];
    for (const [col, type] of adds) {
      if (!has(col)) db.run(`ALTER TABLE users ADD COLUMN ${col} ${type}`);
    }
  } catch (e) {
    console.error("users notif-Spalten fehlgeschlagen:", e);
  }

  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      email TEXT NOT NULL,
      display_name TEXT,
      password_hash TEXT NOT NULL,
      color TEXT DEFAULT '#3b82f6',
      smtp_host TEXT, smtp_port INTEGER, smtp_secure INTEGER DEFAULT 1,
      smtp_user TEXT,
      smtp_pass_enc TEXT,
      smtp_from_name TEXT, smtp_from_email TEXT,
      signature_html TEXT,
      active INTEGER DEFAULT 1,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      ip TEXT, user_agent TEXT
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS email_templates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER REFERENCES users(id),
      name TEXT NOT NULL,
      subject TEXT, body_html TEXT,
      is_default INTEGER DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS attachments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER REFERENCES users(id),
      original_name TEXT NOT NULL,
      stored_path TEXT NOT NULL,
      mime_type TEXT, size_bytes INTEGER,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS sent_emails (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id),
      anlage_id INTEGER REFERENCES anlagen(id),
      to_addr TEXT, cc_addr TEXT, subject TEXT, body_preview TEXT,
      termin_id INTEGER, status TEXT, error TEXT,
      attachment_ids TEXT,
      sent_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS termine (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id),
      anlage_id INTEGER REFERENCES anlagen(id),
      uid TEXT UNIQUE NOT NULL,
      title TEXT NOT NULL,
      description TEXT, location TEXT,
      start_ts INTEGER NOT NULL, end_ts INTEGER NOT NULL,
      attendee_email TEXT, attendee_name TEXT,
      status TEXT DEFAULT 'confirmed',
      accept_token TEXT UNIQUE,
      rsvp_status TEXT,
      sequence INTEGER DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run("CREATE INDEX IF NOT EXISTS idx_anlagen_betreiber ON anlagen(betreiber_mastr)");
  db.run("CREATE INDEX IF NOT EXISTS idx_anlagen_bundesland ON anlagen(bundesland)");
  db.run("CREATE INDEX IF NOT EXISTS idx_anlagen_status ON anlagen(status)");
  db.run("CREATE INDEX IF NOT EXISTS idx_notizen_anlage ON notizen(anlage_id)");
  db.run("CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id)");
  db.run("CREATE INDEX IF NOT EXISTS idx_termine_range ON termine(start_ts, end_ts)");
  db.run("CREATE INDEX IF NOT EXISTS idx_termine_user ON termine(user_id)");

  // ===== Tier 1+2 Erweiterungen =====
  // anlagen: Lead-Score + Geocoding-Marker
  try {
    const cols = db.prepare("PRAGMA table_info(anlagen)").all() as any[];
    const has = (n: string) => cols.find((c) => c.name === n);
    const adds: Array<[string, string]> = [
      ["lead_score", "INTEGER DEFAULT 0"],
      ["lead_score_updated_at", "TEXT"],
      ["geocoded_at", "TEXT"],
      // Geocode-Praezision: address (Gebauede), street (Strasse), postcode (PLZ-Centroid), city (Stadt), failed
      ["geocode_precision", "TEXT"],
    ];
    for (const [col, type] of adds) {
      if (!has(col)) db.run(`ALTER TABLE anlagen ADD COLUMN ${col} ${type}`);
    }
  } catch (e) { console.error("anlagen Tier1+2 Migration:", e); }
  db.run("CREATE INDEX IF NOT EXISTS idx_anlagen_lead_score ON anlagen(lead_score DESC)");
  db.run("CREATE INDEX IF NOT EXISTS idx_anlagen_geo ON anlagen(breitengrad, laengengrad)");

  // users: IMAP + 2FA + is_admin
  try {
    const cols = db.prepare("PRAGMA table_info(users)").all() as any[];
    const has = (n: string) => cols.find((c) => c.name === n);
    const adds: Array<[string, string]> = [
      ["imap_host", "TEXT"],
      ["imap_port", "INTEGER DEFAULT 993"],
      ["imap_secure", "INTEGER DEFAULT 1"],
      ["imap_user", "TEXT"],
      ["imap_pass_enc", "TEXT"],
      ["imap_last_uid", "INTEGER DEFAULT 0"],
      ["imap_enabled", "INTEGER DEFAULT 0"],
      ["totp_secret_enc", "TEXT"],
      ["totp_enabled", "INTEGER DEFAULT 0"],
      ["is_admin", "INTEGER DEFAULT 0"],
      ["is_viewer", "INTEGER DEFAULT 0"],   // Read-only Rolle, nur Anlagen mit mind. 1 Call sichtbar (2026-05-17)
      // ===== Persoenliche Profil-Felder + Voreinstellungen (2026-05-16) =====
      ["phone", "TEXT"],
      ["bio", "TEXT"],
      ["pref_default_tab", "TEXT DEFAULT 'dashboard'"],
      ["pref_default_filter", "TEXT"],                       // JSON-String
      ["pref_reminder_snooze_min", "INTEGER DEFAULT 60"],
      ["pref_anlagen_sort", "TEXT DEFAULT 'lead_score_desc'"],
      ["pref_map_marker_mode", "TEXT DEFAULT 'status'"],     // status | lead_score | owner
      ["pref_quiet_hours_start", "TEXT"],                    // 'HH:MM'
      ["pref_quiet_hours_end", "TEXT"],                      // 'HH:MM'
      ["pref_locale", "TEXT DEFAULT 'de-DE'"],
    ];
    for (const [col, type] of adds) {
      if (!has(col)) db.run(`ALTER TABLE users ADD COLUMN ${col} ${type}`);
    }
    // Bootstrap: User mit username='admin' bekommt is_admin=1
    db.run("UPDATE users SET is_admin=1 WHERE username='admin' AND is_admin=0");
  } catch (e) { console.error("users Tier1+2 Migration:", e); }

  // campaigns: A/B-Test
  try {
    const cols = db.prepare("PRAGMA table_info(campaigns)").all() as any[];
    const has = (n: string) => cols.find((c) => c.name === n);
    const adds: Array<[string, string]> = [
      ["ab_template_b_id", "INTEGER"],
      ["ab_split_pct", "INTEGER DEFAULT 50"],
      ["ab_winner_template_id", "INTEGER"],
      ["ab_decided_at", "TEXT"],
    ];
    for (const [col, type] of adds) {
      if (!has(col)) db.run(`ALTER TABLE campaigns ADD COLUMN ${col} ${type}`);
    }
  } catch (e) { console.error("campaigns A/B Migration:", e); }

  // campaign_recipients: variant-tag fuer A/B
  try {
    const cols = db.prepare("PRAGMA table_info(campaign_recipients)").all() as any[];
    const has = (n: string) => cols.find((c) => c.name === n);
    if (!has("variant")) db.run("ALTER TABLE campaign_recipients ADD COLUMN variant TEXT");
    if (!has("template_id_used")) db.run("ALTER TABLE campaign_recipients ADD COLUMN template_id_used INTEGER");
  } catch (e) { console.error("campaign_recipients A/B Migration:", e); }

  // ===== Email-Replies (IMAP-Inbox) =====
  db.run(`
    CREATE TABLE IF NOT EXISTS email_replies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      sent_email_id INTEGER,
      anlage_id INTEGER,
      from_addr TEXT,
      from_name TEXT,
      subject TEXT,
      body_text TEXT,
      body_html TEXT,
      message_id TEXT,
      in_reply_to TEXT,
      uid INTEGER,
      received_at TEXT DEFAULT CURRENT_TIMESTAMP,
      read_at TEXT,
      FOREIGN KEY (user_id) REFERENCES users(id),
      FOREIGN KEY (sent_email_id) REFERENCES sent_emails(id),
      FOREIGN KEY (anlage_id) REFERENCES anlagen(id)
    )
  `);
  // Attachments aus eingehenden Mails — werden auf Platte gespeichert, hier nur Metadata
  db.run(`
    CREATE TABLE IF NOT EXISTS email_reply_attachments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      reply_id INTEGER NOT NULL,
      filename TEXT NOT NULL,
      content_type TEXT,
      size_bytes INTEGER,
      file_path TEXT NOT NULL,
      content_id TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (reply_id) REFERENCES email_replies(id) ON DELETE CASCADE
    )
  `);
  db.run("CREATE INDEX IF NOT EXISTS idx_reply_atts_reply ON email_reply_attachments(reply_id)");
  db.run("CREATE INDEX IF NOT EXISTS idx_replies_user_unread ON email_replies(user_id, read_at, received_at DESC)");
  db.run("CREATE INDEX IF NOT EXISTS idx_replies_anlage ON email_replies(anlage_id, received_at DESC)");
  db.run("CREATE INDEX IF NOT EXISTS idx_replies_msgid ON email_replies(message_id)");

  // ===== Audit-Log =====
  db.run(`
    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      username TEXT,
      action TEXT NOT NULL,
      entity TEXT,
      entity_id INTEGER,
      detail TEXT,
      ip_hash TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);
  db.run("CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at DESC)");
  db.run("CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_log(user_id, created_at DESC)");
  db.run("CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_log(entity, entity_id, created_at DESC)");

  // ===== Lead-Score-Log (Audit-Trail fuer Score-Aenderungen) =====
  db.run(`
    CREATE TABLE IF NOT EXISTS lead_score_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      anlage_id INTEGER NOT NULL,
      old_score INTEGER, new_score INTEGER,
      reason TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (anlage_id) REFERENCES anlagen(id)
    )
  `);
  db.run("CREATE INDEX IF NOT EXISTS idx_score_log_anlage ON lead_score_log(anlage_id, created_at DESC)");

  // ===== One-shot Remap: Ausrichtung/Neigungswinkel-Codes auf Klartext =====
  // Importer-Bug: rohe MaStR-Codes blieben in der DB stehen, weil das alte AUSRICHTUNG_MAP
  // die falschen Code-Bereiche abdeckte. Diese UPDATE-Statements remappen einmalig
  // alle Roh-Werte auf Klartext. Idempotent (nur Roh-Codes werden ersetzt).
  try {
    const remapHaupt = [
      ["695","Nord"],["696","Nord-Ost"],["697","Ost"],["698","Sued-Ost"],
      ["699","Sued"],["700","Sued-West"],["701","West"],["702","Nord-West"],
      ["703","Ost-West"],["704","Andere/Variabel"],["705","Senkrecht"],
    ];
    for (const [code, label] of remapHaupt) {
      db.prepare("UPDATE anlagen SET hauptausrichtung = ? WHERE hauptausrichtung = ?").run(label, code);
      db.prepare("UPDATE anlagen SET nebenausrichtung = ? WHERE nebenausrichtung = ?").run(label, code);
    }
    const remapNeigung = [
      ["806","< 20°"],["807","20° - 40°"],["808","40° - 60°"],["809","> 60°"],
      ["810","20° - 40°"],["811","Mit Nachfuehrung"],
    ];
    for (const [code, label] of remapNeigung) {
      db.prepare("UPDATE anlagen SET hauptausrichtung_neigungswinkel = ? WHERE hauptausrichtung_neigungswinkel = ?").run(label, code);
      db.prepare("UPDATE anlagen SET nebenausrichtung_neigungswinkel = ? WHERE nebenausrichtung_neigungswinkel = ?").run(label, code);
    }
    // Korrektur: bereits zu "Senkrecht" gemappt — auf "20° - 40°" (Standard) korrigieren
    db.prepare("UPDATE anlagen SET hauptausrichtung_neigungswinkel = '20° - 40°' WHERE hauptausrichtung_neigungswinkel = 'Senkrecht'").run();
    db.prepare("UPDATE anlagen SET nebenausrichtung_neigungswinkel = '20° - 40°' WHERE nebenausrichtung_neigungswinkel = 'Senkrecht'").run();
    // Lage_einheit fallback: aus anlagentyp ableiten wo lage_einheit NULL ist
    const remapLage = [
      ["852","Bauliche Anlagen (Hausdach, Gebaeude und Fassade)"],
      ["853","Freiflaeche"],
      ["2961","Stehendes Gewaesser"],
      ["2484","Sonstige Bauliche Anlagen"],
    ];
    for (const [code, label] of remapLage) {
      db.prepare("UPDATE anlagen SET lage_einheit = ? WHERE lage_einheit IS NULL AND anlagentyp = ?").run(label, code);
    }
  } catch (e) {
    console.error("Mapping-Remap fehlgeschlagen:", e);
  }

  // ===== App-Settings (org-weite Konfiguration, Key-Value) =====
  db.run(`
    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_by INTEGER REFERENCES users(id)
    )
  `);
  // Seed Defaults (idempotent, ueberschreibt NICHT existierende Werte)
  const seedSetting = (key: string, value: string) => {
    db.prepare("INSERT OR IGNORE INTO app_settings (key, value) VALUES (?, ?)").run(key, value);
  };
  seedSetting("repowering_module_wp", "720");                    // Tier-1 Modul-Leistung 2026
  seedSetting("region_factor", "1.0");                            // 1.0 = DE-Mitte (Basis PVGIS)
  seedSetting("storage_ratio_kwh_per_kwp", "1.0");                // 1 kWh Speicher pro 1 kW PV
  seedSetting("storage_cost_eur_per_kwh", "650");                 // LFP Gewerbespeicher 2026
  seedSetting("curtailment_pct", "4");                            // 4% Abregelung Gross-PV (BNetzA 2024)
  seedSetting("recovery_quote_pct", "85");                        // Speicher kompensiert 85% der Abregelung
  // Sichtbarkeits-Toggles (Default: alles AN ausser Speicher)
  seedSetting("show_economics_card", "1");
  seedSetting("show_repowering_card", "1");
  seedSetting("show_storage_card", "0");      // Default AUS auf User-Wunsch
  seedSetting("show_related_anlagen", "1");
  seedSetting("show_reminders_in_anlage", "1");
  seedSetting("show_satellite_map", "1");
  // Alte Setting-Keys aufraeumen (idempotent)
  db.prepare("DELETE FROM app_settings WHERE key IN ('self_consumption_without_storage_pct','self_consumption_with_storage_pct','grid_electricity_price_ct_per_kwh','pv_specific_yield_kwh_per_kwp')").run();

  // ===== App-Secrets — bcrypt-Hashes fuer geschuetzte Endpoints (z.B. /docs/API.md) =====
  // Wird NICHT ueber /api/admin/app-settings ausgelesen. Nur Server-intern.
  db.run(`
    CREATE TABLE IF NOT EXISTS app_secrets (
      key TEXT PRIMARY KEY,
      hash TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // ===== Activities: api_token_id-Spalte (P0-1, 2026-05-17) =====
  // Damit forensisch erkennbar ist, dass eine Activity via API ausgefuehrt wurde.
  try {
    const cols = db.prepare("PRAGMA table_info(activities)").all() as any[];
    if (!cols.find((c) => c.name === "api_token_id")) {
      db.run("ALTER TABLE activities ADD COLUMN api_token_id INTEGER");
    }
  } catch (e) { console.error("activities api_token_id Migration:", e); }

  // ===== Idempotency-Keys (P1-10) =====
  // Cache von Antworten zu (token_id, idempotency_key) — verhindert doppelte POSTs bei Client-Retries.
  db.run(`
    CREATE TABLE IF NOT EXISTS idempotency_log (
      key TEXT NOT NULL,
      token_id INTEGER,
      user_id INTEGER,
      method TEXT NOT NULL,
      path TEXT NOT NULL,
      request_hash TEXT NOT NULL,         -- SHA-256(method+path+body) — Schutz gegen Key-Reuse mit anderem Body
      status INTEGER NOT NULL,
      response_body TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (key, token_id, user_id)
    )
  `);
  db.run("CREATE INDEX IF NOT EXISTS idx_idemp_created ON idempotency_log(created_at)");

  // ===== API-Nutzungs-Verlauf (jeder /api/*-Aufruf wird hier geloggt) =====
  db.run(`
    CREATE TABLE IF NOT EXISTS api_request_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      token_id INTEGER,
      user_id INTEGER,
      auth_type TEXT,                  -- 'token' | 'cookie' | 'public' | 'none'
      method TEXT NOT NULL,
      path TEXT NOT NULL,
      query TEXT,
      status INTEGER NOT NULL,
      ip TEXT,
      user_agent TEXT,
      duration_ms INTEGER,
      response_size INTEGER,
      error_message TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);
  db.run("CREATE INDEX IF NOT EXISTS idx_api_req_log_created ON api_request_log(created_at DESC)");
  db.run("CREATE INDEX IF NOT EXISTS idx_api_req_log_token ON api_request_log(token_id)");
  db.run("CREATE INDEX IF NOT EXISTS idx_api_req_log_status ON api_request_log(status)");
  db.run("CREATE INDEX IF NOT EXISTS idx_api_req_log_path ON api_request_log(path)");

  // ===== Auto-Bug-Erfassung (jedes 5xx + Exception wird hier mit Stack + Kontext gespeichert) =====
  db.run(`
    CREATE TABLE IF NOT EXISTS api_bug_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      fingerprint TEXT NOT NULL,       -- Hash aus method+path+error-message → Pattern-Detection
      method TEXT NOT NULL,
      path TEXT NOT NULL,
      query TEXT,
      status INTEGER NOT NULL,
      token_id INTEGER,
      user_id INTEGER,
      ip TEXT,
      error_message TEXT,
      stack_trace TEXT,
      request_body TEXT,
      occurrence_count INTEGER DEFAULT 1,
      first_seen_at TEXT DEFAULT CURRENT_TIMESTAMP,
      last_seen_at TEXT DEFAULT CURRENT_TIMESTAMP,
      resolved_at TEXT,
      resolved_by INTEGER REFERENCES users(id),
      resolution_note TEXT,
      auto_fix_hint TEXT,              -- Vorgeschlagene Loesung wenn Pattern bekannt
      UNIQUE(fingerprint)
    )
  `);
  db.run("CREATE INDEX IF NOT EXISTS idx_bug_log_last_seen ON api_bug_log(last_seen_at DESC)");
  db.run("CREATE INDEX IF NOT EXISTS idx_bug_log_resolved ON api_bug_log(resolved_at)");
  db.run("CREATE INDEX IF NOT EXISTS idx_bug_log_count ON api_bug_log(occurrence_count DESC)");

  // ===== API-Tokens (admin-only Verwaltung) =====
  db.run(`
    CREATE TABLE IF NOT EXISTS api_tokens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      token_prefix TEXT NOT NULL,
      scope TEXT NOT NULL DEFAULT 'read',
      created_by INTEGER NOT NULL REFERENCES users(id),
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      expires_at TEXT,
      last_used_at TEXT,
      last_used_ip TEXT,
      request_count INTEGER DEFAULT 0,
      revoked_at TEXT,
      revoked_by INTEGER REFERENCES users(id)
    )
  `);
  db.run("CREATE INDEX IF NOT EXISTS idx_api_tokens_hash ON api_tokens(token_hash) WHERE revoked_at IS NULL");
  db.run("CREATE INDEX IF NOT EXISTS idx_api_tokens_created ON api_tokens(created_at DESC)");

  // ===== Reminders / Wiedervorlagen (kundenzentriert, team-weit sichtbar) =====
  db.run(`
    CREATE TABLE IF NOT EXISTS reminders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      betreiber_mastr TEXT NOT NULL,
      due_at TEXT NOT NULL,
      note TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      owner_user_id INTEGER REFERENCES users(id),
      created_by INTEGER REFERENCES users(id),
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      completed_at TEXT,
      completed_by INTEGER REFERENCES users(id),
      notified_inapp_at TEXT,
      notified_email_at TEXT,
      notified_telegram_at TEXT
    )
  `);
  db.run("CREATE INDEX IF NOT EXISTS idx_reminders_due ON reminders(due_at, status)");
  db.run("CREATE INDEX IF NOT EXISTS idx_reminders_betreiber ON reminders(betreiber_mastr, status)");
  db.run("CREATE INDEX IF NOT EXISTS idx_reminders_owner ON reminders(owner_user_id, status, due_at)");

  // ===== Notizen-Erweiterung: Kunden-Anker + Scope =====
  // Notizen koennen jetzt am Betreiber haengen (scope='betreiber', sichtbar bei allen Anlagen)
  // oder weiter anlage-spezifisch sein (scope='anlage'). anlage_id bleibt fuer Backwards-Compat.
  try {
    const cols = (db.prepare("PRAGMA table_info(notizen)").all() as any[]).map((c) => c.name);
    if (!cols.includes("betreiber_mastr")) {
      db.run("ALTER TABLE notizen ADD COLUMN betreiber_mastr TEXT");
    }
    if (!cols.includes("scope")) {
      db.run("ALTER TABLE notizen ADD COLUMN scope TEXT NOT NULL DEFAULT 'anlage'");
    }
  } catch {}
  db.run("CREATE INDEX IF NOT EXISTS idx_notizen_betreiber ON notizen(betreiber_mastr, created_at DESC)");

  // One-shot Backfill: bestehende Anlage-Notizen mit betreiber_mastr verknuepfen,
  // damit sie bei der "alle Anlagen des Kunden"-Ansicht ueberall mit auftauchen.
  // Idempotent: setzt nur, wo noch NULL.
  try {
    db.run(`
      UPDATE notizen
      SET betreiber_mastr = (
        SELECT a.betreiber_mastr FROM anlagen a WHERE a.id = notizen.anlage_id
      )
      WHERE betreiber_mastr IS NULL AND anlage_id IS NOT NULL
    `);
  } catch {}

  // ===== Public Leads (oeffentliche Landingpage /interesse) =====
  // Anfragen aus dem Web-Formular landen hier. Bei MaStR-Match wird zusaetzlich
  // eine Notiz an die Anlage geschrieben.
  db.run(`
    CREATE TABLE IF NOT EXISTS public_leads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      lead_type TEXT NOT NULL,              -- 'betreiber' | 'partner'
      interest TEXT,                         -- 'repowering' | 'ankauf' | 'beides' | 'demo' | 'partnerschaft'
      name TEXT,
      firma TEXT,
      email TEXT NOT NULL,
      telefon TEXT,
      plz TEXT,
      ort TEXT,
      strasse TEXT,
      mastr_nummer TEXT,
      anlagen_leistung_kwp REAL,
      inbetriebnahme_jahr INTEGER,
      nachricht TEXT,
      ip TEXT,
      user_agent TEXT,
      referrer TEXT,
      status TEXT DEFAULT 'neu',             -- neu | kontaktiert | konvertiert | spam | abgelehnt
      matched_anlage_id INTEGER,             -- gesetzt wenn MaStR-Nr passt
      converted_anlage_id INTEGER,           -- gesetzt wenn Lead in Anlage konvertiert
      assigned_user_id INTEGER,
      handled_at TEXT,
      handled_by_user_id INTEGER,
      FOREIGN KEY (matched_anlage_id)  REFERENCES anlagen(id) ON DELETE SET NULL,
      FOREIGN KEY (converted_anlage_id) REFERENCES anlagen(id) ON DELETE SET NULL,
      FOREIGN KEY (assigned_user_id)   REFERENCES users(id)    ON DELETE SET NULL,
      FOREIGN KEY (handled_by_user_id) REFERENCES users(id)    ON DELETE SET NULL
    )
  `);
  db.run(`CREATE INDEX IF NOT EXISTS idx_public_leads_status     ON public_leads(status)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_public_leads_created    ON public_leads(created_at DESC)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_public_leads_mastr      ON public_leads(mastr_nummer)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_public_leads_lead_type  ON public_leads(lead_type)`);
}

export function seedDefaultTemplates(db: Database): void {
  const count = (db.prepare("SELECT COUNT(*) as c FROM email_templates WHERE user_id IS NULL").get() as any).c;
  if (count > 0) return;

  const insert = db.prepare(`
    INSERT INTO email_templates (user_id, name, subject, body_html, is_default)
    VALUES (NULL, ?, ?, ?, ?)
  `);

  insert.run(
    "Erstkontakt",
    "Anfrage zu Ihrer PV-Anlage in {{ort}}",
    `<p>Sehr geehrte Damen und Herren,</p>
<p>wir haben Ihre PV-Anlage <strong>{{anlagenname}}</strong> in {{ort}} mit einer Leistung von {{leistung}} kWp im Marktstammdatenregister gefunden.</p>
<p>Wir wuerden Ihnen gerne eine unverbindliche Einschaetzung zu Optimierungsmoeglichkeiten und einer moeglichen Erweiterung Ihrer Anlage zukommen lassen.</p>
<p>Bei Interesse melden Sie sich gerne bei uns.</p>
<p>Mit freundlichen Gruessen<br>{{absender_name}}</p>`,
    1
  );

  insert.run(
    "Angebot mit Terminvorschlag",
    "Angebot fuer Ihre PV-Anlage {{anlagenname}}",
    `<p>Sehr geehrte Damen und Herren,</p>
<p>vielen Dank fuer Ihr Interesse. Wir moechten Ihnen ein Angebot fuer Ihre PV-Anlage <strong>{{anlagenname}}</strong> ({{leistung}} kWp) in {{ort}} unterbreiten.</p>
<p>Wir schlagen Ihnen folgenden Gespraechstermin vor:</p>
<p><strong>{{termin}}</strong></p>
<p>Im Anhang finden Sie unser Angebot sowie eine Kalendereinladung. Bitte bestaetigen Sie den Termin durch Klick auf den Link in der Einladung.</p>
<p>Mit freundlichen Gruessen<br>{{absender_name}}</p>`,
    1
  );

  insert.run(
    "Nachfass",
    "Nochmals bzgl. Ihrer PV-Anlage in {{ort}}",
    `<p>Sehr geehrte Damen und Herren,</p>
<p>am {{datum}} haben wir Ihnen eine E-Mail bezueglich Ihrer PV-Anlage <strong>{{anlagenname}}</strong> in {{ort}} geschickt.</p>
<p>Da wir bisher keine Rueckmeldung erhalten haben, moechten wir uns gerne nochmals bei Ihnen melden. Sollten Sie an einem unverbindlichen Gespraech interessiert sein, freuen wir uns auf Ihre Antwort.</p>
<p>Mit freundlichen Gruessen<br>{{absender_name}}</p>`,
    1
  );

  console.log("Standard-Templates angelegt (3 globale)");
}

export function bootstrapAdmin(db: Database): void {
  const count = (db.prepare("SELECT COUNT(*) as c FROM users").get() as any).c;
  if (count > 0) return;

  const username = process.env.ADMIN_USER;
  const password = process.env.ADMIN_PASS;
  const email = process.env.ADMIN_EMAIL || `${username || "admin"}@local`;

  if (!username || !password) {
    console.warn("");
    console.warn("ACHTUNG: Keine User in DB und ADMIN_USER/ADMIN_PASS nicht gesetzt.");
    console.warn("Setze ENV-Variablen ADMIN_USER und ADMIN_PASS, dann Server neu starten.");
    console.warn("Beispiel: ADMIN_USER=admin ADMIN_PASS=geheim123 bun server.ts");
    console.warn("");
    return;
  }

  const hash = Bun.password.hashSync(password, { algorithm: "bcrypt", cost: 10 });
  db.prepare(`
    INSERT INTO users (username, email, display_name, password_hash, color, active)
    VALUES (?, ?, ?, ?, '#3b82f6', 1)
  `).run(username, email, username, hash);

  console.log("");
  console.log(`Admin-User '${username}' angelegt. Login mit ADMIN_PASS-Wert.`);
  console.log("WICHTIG: ADMIN_PASS aus systemd-Unit entfernen nach erstem Login!");
  console.log("");
}
