import type { Database } from "bun:sqlite";
import StreamZip from "node-stream-zip";
import sax from "sax";
import { Readable } from "stream";

const MIN_NETTO_KW = 100;
const SOLAR_KEYWORDS = ["solar", "photovoltaik", "pv"];
const BATCH_SIZE = 5000;

export interface ImportStats {
  anlagen_inserted: number;
  anlagen_updated: number;
  anlagen_skipped: number;
  betreiber_inserted: number;
  betreiber_updated: number;
  files_processed: string[];
}

// Bundesland-Codes von MaStR (XML-Werte) -> Klartext
const BUNDESLAND_MAP: Record<string, string> = {
  "1400": "Brandenburg", "1401": "Berlin", "1402": "Baden-Wuerttemberg",
  "1403": "Bayern", "1404": "Bremen", "1405": "Hessen", "1406": "Hamburg",
  "1407": "Mecklenburg-Vorpommern", "1408": "Niedersachsen",
  "1409": "Nordrhein-Westfalen", "1410": "Rheinland-Pfalz",
  "1411": "Schleswig-Holstein", "1412": "Saarland", "1413": "Sachsen",
  "1414": "Sachsen-Anhalt", "1415": "Thueringen",
};

// Energietraeger-Codes (2495 = Solare Strahlungsenergie / PV)
const ENERGIETRAEGER_MAP: Record<string, string> = {
  "2495": "Solare Strahlungsenergie",
  "2497": "Wind",
  "2493": "Biomasse",
  "2496": "Wasser",
  "2498": "Geothermie",
  "2957": "Speicher",
};

const LAGE_MAP: Record<string, string> = {
  "852": "Bauliche Anlagen (Hausdach, Gebaeude und Fassade)",
  "853": "Freiflaeche",
  "2961": "Stehendes Gewaesser",
  "2484": "Sonstige Bauliche Anlagen",
};

// HauptausrichtungSolar (XML-Feld <Hauptausrichtung>) — Himmelsrichtung der Module
const HAUPTAUSRICHTUNG_MAP: Record<string, string> = {
  "695": "Nord", "696": "Nord-Ost", "697": "Ost", "698": "Sued-Ost",
  "699": "Sued", "700": "Sued-West", "701": "West", "702": "Nord-West",
  "703": "Ost-West", "704": "Andere/Variabel", "705": "Senkrecht",
  // Legacy / Alternativcodes (fallback)
  "806": "Nord", "807": "Nord-Ost", "808": "Ost", "809": "Sued-Ost",
  "810": "Sued", "811": "Sued-West", "812": "West", "813": "Nord-West",
  "814": "Ost-West", "815": "Sued mit Nachfuehrung", "1916": "Senkrecht (Fassade)",
};
// HauptausrichtungNeigungswinkelSolar — Neigungswinkel-Klassen
// Codes basierend auf Verteilung in MaStR-Bulk-XML 2026 (810 ist mit 68% der Top-Code,
// das passt zu Standard-Dachschraege 20-40 Grad, nicht "Senkrecht").
const NEIGUNGSWINKEL_MAP: Record<string, string> = {
  "806": "< 20°",
  "807": "20° - 40°",
  "808": "40° - 60°",
  "809": "> 60°",
  "810": "20° - 40°",      // Standard-Dachschraege (frueher faelschlich "Senkrecht")
  "811": "Mit Nachfuehrung",
};

const SPANNUNG_MAP: Record<string, string> = {
  "2403": "Hoechstspannung", "2404": "Hochspannung",
  "2405": "Mittelspannung", "2406": "Niederspannung",
};

const EINSPEISUNGSART_MAP: Record<string, string> = {
  "689": "Volleinspeisung", "688": "Teileinspeisung",
};

const FOERDER_MAP: Record<string, string> = {
  "151": "EEG", "152": "Marktpraemie", "153": "Direktvermarktung",
};

const PERSONENART_MAP: Record<string, string> = {
  "1": "Natuerliche Person", "2": "Juristische Person",
};

const BETRIEBSSTATUS_MAP: Record<string, string> = {
  "31": "In Betrieb", "32": "In Planung", "35": "Endgueltig stillgelegt",
  "37": "Voruebergehend stillgelegt",
};

function mapVal(map: Record<string, string>, v: string | null | undefined): string | null {
  if (!v) return null;
  return map[v] || v;
}

function isPvSolar(et: string | null): boolean {
  if (!et) return false;
  const low = et.toLowerCase();
  return SOLAR_KEYWORDS.some((k) => low.includes(k)) || et === "2495";
}

function parseFloatSafe(v: string | null | undefined): number | null {
  if (!v) return null;
  const n = parseFloat(String(v).replace(",", "."));
  return isNaN(n) ? null : n;
}

function parseIntSafe(v: string | null | undefined): number | null {
  if (!v) return null;
  const n = parseInt(String(v), 10);
  return isNaN(n) ? null : n;
}

function parseBoolSafe(v: string | null | undefined): number {
  if (!v) return 0;
  const s = String(v).toLowerCase();
  return (s === "1" || s === "true" || s === "ja") ? 1 : 0;
}

// Felder die der Bulk-Import NIE ueberschreiben darf, weil sie vom Anreicherer
// (lib/mastr-enricher.ts) oder per UI manuell gepflegt werden. Wenn der MaStR-XML
// fuer diese Spalten NULL/leer liefert (= immer), wuerde das alle gepflegten Daten
// platt machen. Konsistent zum Enricher: COALESCE(NULLIF(excluded.x, ''), x).
const PROTECTED_ANLAGEN_COLS = new Set([
  "kontakt_telefon", "kontakt_fax", "kontakt_email", "kontakt_website", "kontakt_adresse",
  // Geocoder-Werte: XML kann sie liefern; wenn nicht, behalte den nachträglich geocodeten Wert.
  "breitengrad", "laengengrad",
]);

// User-editierbare Anlagen-Stammdaten (Quelle: server.ts PUT /api/anlagen/:id, editable-Whitelist).
// Eine Aenderung an einem dieser Felder via UI markiert das Feld in anlagen.edited_fields (JSON array).
// Der Import respektiert pro Anlage pro Feld die edited_fields-Liste und überschreibt geänderte Felder NICHT.
// Felder die NICHT in edited_fields stehen, bekommen den XML-Wert (frische MaStR-Daten).
const USER_EDITABLE_ANLAGEN_COLS = [
  "name", "betreiber_name",
  "strasse", "hausnummer", "plz", "ort", "bundesland", "landkreis", "gemeinde",
  "breitengrad", "laengengrad",
  "bruttoleistung", "nettonennleistung", "anzahl_module",
  "inbetriebnahme", "energietraeger", "anlagentyp",
  "lage_einheit", "hauptausrichtung", "hauptausrichtung_neigungswinkel",
  "modulhersteller", "wechselrichterhersteller", "wechselrichter_anzahl",
];
// Helper: SQL-Snippet das prueft ob ein Feldname in edited_fields (JSON-Array) steht.
// Trick: JSON-Array-Strings sehen aus wie `["name","plz"]` — instr findet `"name"` mit Quotes
// sicher (kein false-positive auf Substrings, da andere Feldnamen andere Quotes hätten).
function isEditedClause(col: string): string {
  return `instr(COALESCE(edited_fields, '[]'), '"${col}"') > 0`;
}
const PROTECTED_BETREIBER_COLS = new Set([
  "email", "telefon", "fax", "website",
]);

// Spalten die der Import gar nicht touchen darf (gehören CRM/UI/Cron, nie XML).
// Werden aus dem UPDATE-SET komplett weggelassen, damit `excluded.x = NULL` sie nicht
// auf NULL/0 setzt. INSERT bleibt unverändert (für neue Anlagen sind diese Felder leer).
const NEVER_OVERWRITE_ANLAGEN_COLS = [
  "status",                     // Lead-Status (neu/kontaktiert/...) — manuell gepflegt
  "notizen",                    // Freitext-Notizen am Anlagen-Record
  "owner_id",                   // Lead-Owner (Owner-Schutz, 2026-05-16) — NIE überschreiben
  "lead_score",                 // Score-Engine, lib/lead-score.ts
  "lead_score_updated_at",
  "geocoded_at",                // Geocoder-Lauf
  "position_refined_at",        // OSM-Praezisierung
];

function buildUpdateClause(
  cols: string[],
  protectedCols: Set<string>,
  extraSkip: string[] = [],
  // applyUserEditableProtection nur fuer anlagen-Tabelle aktivieren (nutzt edited_fields-Spalte).
  // Fuer betreiber/andere Tabellen ohne edited_fields-Spalte: false.
  applyUserEditableProtection = false,
): string {
  const userEditable = applyUserEditableProtection ? new Set(USER_EDITABLE_ANLAGEN_COLS) : new Set<string>();
  return cols
    .filter((c) => c !== "mastr_nummer" && !extraSkip.includes(c))
    .map((c) => {
      // Priorität: 1) user hat das Feld editiert → KEEP OWN VALUE
      //            2) PROTECTED (COALESCE) — XML fuellt nur wenn leer
      //            3) Standard: XML wins
      if (userEditable.has(c)) {
        if (protectedCols.has(c)) {
          // breitengrad/laengengrad: editierbar + protected (Geocoder-Fallback)
          return `${c} = CASE WHEN ${isEditedClause(c)} THEN ${c} ELSE COALESCE(NULLIF(excluded.${c}, ''), ${c}) END`;
        }
        return `${c} = CASE WHEN ${isEditedClause(c)} THEN ${c} ELSE excluded.${c} END`;
      }
      if (protectedCols.has(c)) {
        return `${c} = COALESCE(NULLIF(excluded.${c}, ''), ${c})`;
      }
      return `${c} = excluded.${c}`;
    })
    .join(",\n      ");
}

// Test-Hook fuer Regression-Tests (z.B. scripts/test-importer-owner-preservation.ts).
// Nicht fuer Produktiv-Code verwenden.
export const _testHooks = {
  buildAnlageRow,
  upsertOne(db: Database, xmlRow: Record<string, string>) {
    const stmts = ensureUpsertStmts(db);
    const row = buildAnlageRow(xmlRow);
    if (!row) throw new Error("buildAnlageRow lieferte null");
    // Fehlende Cols mit null auffuellen — exakt wie der echte Importer es bindet.
    const bind: Record<string, any> = {};
    for (const c of stmts.anlagenCols) bind[`$${c}`] = row[c] ?? null;
    stmts.insertAnlage.run(bind);
  },
};

function ensureUpsertStmts(db: Database) {
  // Hole aktuelle Spalten der anlagen-Tabelle dynamisch
  const anlagenCols = (db.prepare("PRAGMA table_info(anlagen)").all() as any[])
    .map((c) => c.name)
    .filter((c) => c !== "id" && c !== "created_at");

  // Spalten ohne updated_at (managed manuell)
  const updateableCols = anlagenCols.filter((c) => c !== "updated_at");

  const placeholders = updateableCols.map((c) => `$${c}`).join(", ");
  // anlagen-Upsert nutzt edited_fields-basierten Schutz (4. Parameter true)
  const updateClause = buildUpdateClause(updateableCols, PROTECTED_ANLAGEN_COLS, NEVER_OVERWRITE_ANLAGEN_COLS, true);

  const insertAnlage = db.prepare(`
    INSERT INTO anlagen (${updateableCols.join(", ")}, updated_at)
    VALUES (${placeholders}, CURRENT_TIMESTAMP)
    ON CONFLICT(mastr_nummer) DO UPDATE SET
      ${updateClause},
      updated_at = CURRENT_TIMESTAMP
  `);

  const betreiberCols = (db.prepare("PRAGMA table_info(betreiber)").all() as any[])
    .map((c) => c.name)
    .filter((c) => c !== "id" && c !== "created_at" && c !== "updated_at");
  const betreiberPlaceholders = betreiberCols.map((c) => `$${c}`).join(", ");
  const betreiberUpdateClause = buildUpdateClause(betreiberCols, PROTECTED_BETREIBER_COLS);

  const insertBetreiber = db.prepare(`
    INSERT INTO betreiber (${betreiberCols.join(", ")}, updated_at)
    VALUES (${betreiberPlaceholders}, CURRENT_TIMESTAMP)
    ON CONFLICT(mastr_nummer) DO UPDATE SET
      ${betreiberUpdateClause},
      updated_at = CURRENT_TIMESTAMP
  `);

  return { insertAnlage, insertBetreiber, anlagenCols: updateableCols, betreiberCols };
}

function getCount(db: Database, table: string): number {
  return (db.prepare(`SELECT COUNT(*) as c FROM ${table}`).get() as any).c;
}

async function streamXmlFile(
  zip: any,
  entryName: string,
  onElement: (record: Record<string, string>) => void,
): Promise<void> {
  const stream: Readable = await zip.stream(entryName);
  const parser = sax.createStream(true, { trim: true, normalize: true });

  let currentTag = "";
  let currentRecord: Record<string, string> | null = null;
  let textBuffer = "";

  parser.on("opentag", (node: any) => {
    if (currentRecord !== null) {
      currentTag = node.name;
      textBuffer = "";
    } else {
      // Top-Level: alles direkt unter dem Wurzelelement = neuer Record
      if (
        node.name !== "AnlagenSolar" &&
        node.name !== "Marktakteure" &&
        node.name !== "EinheitenSolar" &&
        !node.name.startsWith("?")
      ) {
        currentRecord = {};
        currentTag = "__root__";
      }
    }
  });

  parser.on("text", (text: string) => {
    if (currentRecord !== null && currentTag && currentTag !== "__root__") {
      textBuffer += text;
    }
  });

  parser.on("cdata", (text: string) => {
    if (currentRecord !== null && currentTag && currentTag !== "__root__") {
      textBuffer += text;
    }
  });

  parser.on("closetag", (name: string) => {
    if (currentRecord === null) return;
    if (currentTag === name && currentTag !== "__root__") {
      currentRecord[name] = textBuffer.trim();
      textBuffer = "";
      currentTag = "";
    } else {
      onElement(currentRecord);
      currentRecord = null;
      currentTag = "";
      textBuffer = "";
    }
  });

  return new Promise<void>((resolve, reject) => {
    parser.on("error", () => {
      try {
        (parser as any)._parser.error = null;
        (parser as any)._parser.resume();
      } catch {}
    });
    parser.on("end", () => resolve());
    stream.on("error", reject);
    stream.pipe(parser as any);
  });
}

function buildAnlageRow(e: Record<string, string>): Record<string, any> | null {
  const mastr = e.EinheitMastrNummer || e.MaStRNummer;
  if (!mastr) return null;

  const netto = parseFloatSafe(e.Nettonennleistung);
  const energietraeger = mapVal(ENERGIETRAEGER_MAP, e.Energietraeger);

  if (!netto || netto < MIN_NETTO_KW) return null;
  if (!isPvSolar(energietraeger)) return null;

  return {
    mastr_nummer: mastr,
    einheit_id: parseIntSafe(e.EinheitMastrId) ?? null,
    name: e.NameStromerzeugungseinheit || e.AnlagenbetreiberName || null,
    betreiber_name: e.AnlagenbetreiberName || null,
    betreiber_mastr: e.AnlagenbetreiberMastrNummer || null,
    betreiber_id: parseIntSafe(e.AnlagenbetreiberMastrId) ?? null,
    // Standort
    strasse: e.Strasse || null,
    hausnummer: e.Hausnummer || null,
    plz: e.Postleitzahl || null,
    ort: e.Ort || null,
    bundesland: mapVal(BUNDESLAND_MAP, e.Bundesland),
    landkreis: e.Landkreis || null,
    gemeinde: e.Gemeinde || null,
    gemeindeschluessel: e.Gemeindeschluessel || null,
    breitengrad: parseFloatSafe(e.Breitengrad),
    laengengrad: parseFloatSafe(e.Laengengrad),
    flurstuecke: e.Flurstuecke || null,
    unternehmensgemeinde: e.UnternehmensgemeindeName || null,
    // Leistung
    bruttoleistung: parseFloatSafe(e.Bruttoleistung),
    nettonennleistung: netto,
    installierte_leistung: parseFloatSafe(e.InstallierteLeistung),
    registrierte_leistung: parseFloatSafe(e.RegistrierteLeistung),
    anzahl_module: parseIntSafe(e.AnzahlModule),
    // Datum
    inbetriebnahme: e.Inbetriebnahmedatum || null,
    geplantes_inbetriebnahmedatum: e.GeplantesInbetriebsnahmedatum || null,
    datum_endgueltige_stilllegung: e.DatumEndgueltigeStilllegung || null,
    datum_beginn_voruebergehende_stilllegung: e.DatumBeginnVoruebergehendeStilllegung || null,
    datum_wiederaufnahme_betrieb: e.DatumWiederaufnahmeBetrieb || null,
    registrierungsdatum: e.Registrierungsdatum || null,
    letzte_aenderung: e.DatumLetzteAktualisierung || null,
    // Typ / Lage
    energietraeger,
    anlagentyp: e.Lage || null,
    betriebsstatus: mapVal(BETRIEBSSTATUS_MAP, e.EinheitBetriebsstatus),
    lage_einheit: mapVal(LAGE_MAP, e.Lage),
    hauptausrichtung: mapVal(HAUPTAUSRICHTUNG_MAP, e.Hauptausrichtung),
    hauptausrichtung_neigungswinkel: mapVal(NEIGUNGSWINKEL_MAP, e.HauptausrichtungNeigungswinkel),
    nebenausrichtung: mapVal(HAUPTAUSRICHTUNG_MAP, e.Nebenausrichtung),
    nebenausrichtung_neigungswinkel: mapVal(NEIGUNGSWINKEL_MAP, e.NebenausrichtungNeigungswinkel),
    // Speicher
    hat_speicher: (e.GekoppelteEinheit || e.Batteriespeicher) ? 1 : 0,
    speicher_kwh: parseFloatSafe(e.NutzbareSpeicherkapazitaet),
    nutzbare_speicherkapazitaet: parseFloatSafe(e.NutzbareSpeicherkapazitaet),
    gekoppelte_einheit_mastr: e.GekoppelteEinheit || null,
    batteriespeicher_mastr: e.Batteriespeicher || null,
    // EEG
    eeg_anlage: e.EegMastrNummer ? 1 : 0,
    eeg_mastr_nummer: e.EegMastrNummer || null,
    eeg_inbetriebnahmedatum: e.EegInbetriebnahmedatum || null,
    eeg_anlagenschluessel: e.EegAnlagenschluessel || null,
    zuschlagsnummer: e.Zuschlagsnummer || null,
    zuschlag_kwh_betrag: parseFloatSafe(e.AnzulegenderWert) ?? parseFloatSafe(e.ZuschlagsfaehigesGebot),
    foerderverfahren: mapVal(FOERDER_MAP, e.Foerderverfahren),
    // Technik
    spannungsebene: mapVal(SPANNUNG_MAP, e.Spannungsebene),
    leistungsbegrenzung: e.Leistungsbegrenzung || null,
    einspeisungsart: mapVal(EINSPEISUNGSART_MAP, e.Einspeisungsart),
    volleinspeiser: parseBoolSafe(e.Volleinspeisung),
    fernsteuerbarkeit_nb: parseBoolSafe(e.FernsteuerbarkeitNb),
    fernsteuerbarkeit_dv: parseBoolSafe(e.FernsteuerbarkeitDv),
    fernsteuerbarkeit_dr: parseBoolSafe(e.FernsteuerbarkeitDr),
    wechselrichter_leistung: parseFloatSafe(e.WechselrichterLeistung),
    wechselrichter_anzahl: parseIntSafe(e.AnzahlWechselrichter),
    modulhersteller: e.Modulhersteller || null,
    wechselrichterhersteller: e.Wechselrichterhersteller || null,
    // Netz
    nb_betreiber_mastr: e.AnschlussAnNetzbetreiberMastrNummer || e.NetzbetreiberMastrNummer || null,
    anschluss_an_hoechst_oder_hochspannung: parseBoolSafe(e.AnschlussAnHoechstOderHochSpannung),
    // Sonstiges
    weic: e.Weic || null,
    weic_anzeigename: e.WeicAnzeigename || null,
    bnetza_url: `https://www.marktstammdatenregister.de/MaStR/Einheit/Detail/IndexOeffentlich/${mastr.replace(/^SEE/, "")}`,
    // Kontakt-Felder bleiben (werden vom Anreicherungs-Layer befuellt)
    kontakt_telefon: null,
    kontakt_fax: null,
    kontakt_email: null,
    kontakt_website: null,
    kontakt_adresse: null,
    notizen: null,
    status: "neu",
    // Raw-Backup
    raw_data: JSON.stringify(e),
  };
}

function buildBetreiberRow(e: Record<string, string>): Record<string, any> | null {
  const mastr = e.MastrNummer || e.MarktakteurMastrNummer;
  if (!mastr) return null;

  const personenart = mapVal(PERSONENART_MAP, e.Personenart);
  const name = e.Firmenname || `${e.Vorname || ""} ${e.Nachname || ""}`.trim() || null;
  if (!name) return null;

  return {
    mastr_nummer: mastr,
    akteur_id: parseIntSafe(e.MarktakteurMastrId) ?? null,
    name,
    rechtsform: e.Rechtsform || null,
    personenart,
    vorname: e.Vorname || null,
    nachname: e.Nachname || null,
    titel: e.Titel || null,
    anrede: e.Anrede || null,
    strasse: e.Strasse || null,
    hausnummer: e.Hausnummer || null,
    adresszusatz: e.Adresszusatz || null,
    plz: e.Postleitzahl || null,
    ort: e.Ort || null,
    bundesland: mapVal(BUNDESLAND_MAP, e.Bundesland),
    land: e.Land || null,
    telefon: null,
    fax: null,
    email: null,
    website: null,
    handelsregister: e.Handelsregister || e.RegisterEintrag || null,
    umsatzsteuer_id: e.UmsatzsteuerId || null,
    registrierungsdatum: e.DatumRegistrierung || null,
    marktrolle: e.MarktrollenIDs || e.MarktRolle || null,
    raw_data: JSON.stringify(e),
  };
}

export async function importMastrZip(
  db: Database,
  zipPath: string,
  onProgress?: (msg: string, stats: Partial<ImportStats>) => void,
): Promise<ImportStats> {
  const stats: ImportStats = {
    anlagen_inserted: 0,
    anlagen_updated: 0,
    anlagen_skipped: 0,
    betreiber_inserted: 0,
    betreiber_updated: 0,
    files_processed: [],
  };

  const zip = new (StreamZip as any).async({ file: zipPath, storeEntries: true });
  const entries = await zip.entries();
  const entryNames = Object.keys(entries);

  const solarFiles = entryNames.filter((n) => /EinheitenSolar.*\.xml$/i.test(n));
  const akteurFiles = entryNames.filter((n) => /Marktakteure.*\.xml$/i.test(n));

  if (solarFiles.length === 0) {
    await zip.close();
    throw new Error("Keine EinheitenSolar*.xml im ZIP gefunden");
  }

  const { insertAnlage, insertBetreiber, anlagenCols, betreiberCols } = ensureUpsertStmts(db);
  const anlagenBefore = getCount(db, "anlagen");
  const betreiberBefore = getCount(db, "betreiber");

  // ============ ANLAGEN ============
  for (const fname of solarFiles) {
    onProgress?.(`Verarbeite ${fname}`, stats);
    let pendingAnlagen: Record<string, any>[] = [];

    const flushBatch = () => {
      if (pendingAnlagen.length === 0) return;
      const tx = db.transaction((rows: Record<string, any>[]) => {
        for (const r of rows) {
          // Build params-object dynamisch aus anlagenCols
          const params: Record<string, any> = {};
          for (const col of anlagenCols) {
            params[`$${col}`] = r[col] ?? null;
          }
          insertAnlage.run(params);
        }
      });
      tx(pendingAnlagen);
      stats.anlagen_inserted += pendingAnlagen.length;
      pendingAnlagen = [];
      onProgress?.(`Anlagen: ${stats.anlagen_inserted}`, stats);
    };

    await streamXmlFile(zip, fname, (e) => {
      const row = buildAnlageRow(e);
      if (!row) {
        stats.anlagen_skipped++;
        return;
      }
      pendingAnlagen.push(row);
      if (pendingAnlagen.length >= BATCH_SIZE) flushBatch();
    });

    flushBatch();
    stats.files_processed.push(fname);
  }

  // ============ MARKTAKTEURE ============
  for (const fname of akteurFiles) {
    onProgress?.(`Verarbeite ${fname}`, stats);
    let pendingBetreiber: Record<string, any>[] = [];

    const flushBetreiber = () => {
      if (pendingBetreiber.length === 0) return;
      const tx = db.transaction((rows: Record<string, any>[]) => {
        for (const r of rows) {
          const params: Record<string, any> = {};
          for (const col of betreiberCols) {
            params[`$${col}`] = r[col] ?? null;
          }
          insertBetreiber.run(params);
        }
      });
      tx(pendingBetreiber);
      stats.betreiber_inserted += pendingBetreiber.length;
      pendingBetreiber = [];
      onProgress?.(`Betreiber: ${stats.betreiber_inserted}`, stats);
    };

    await streamXmlFile(zip, fname, (e) => {
      const row = buildBetreiberRow(e);
      if (!row) return;
      pendingBetreiber.push(row);
      if (pendingBetreiber.length >= BATCH_SIZE) flushBetreiber();
    });

    flushBetreiber();
    stats.files_processed.push(fname);
  }

  await zip.close();

  const anlagenAfter = getCount(db, "anlagen");
  const betreiberAfter = getCount(db, "betreiber");
  stats.anlagen_inserted = anlagenAfter - anlagenBefore;
  stats.betreiber_inserted = betreiberAfter - betreiberBefore;

  return stats;
}
