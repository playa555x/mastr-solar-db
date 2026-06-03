/**
 * PV-Wirtschaftlichkeit + Repowering-Schaetzungen.
 *
 * Quellen:
 * - EEG-Vergütungssätze: Bundesnetzagentur, BMWi EEG-Historie 2010-2026,
 *   https://www.bundesnetzagentur.de/DE/Fachthemen/ElektrizitaetundGas/ErneuerbareEnergien/EEG_Foerderung/
 * - Spezifischer Ertrag DE: Fraunhofer ISE Deutschland-Median ~ 950-1050 kWh/kWp/Jahr
 * - Aktuelle Modul-Leistung 2026: Tier-1-Module 600-650 Wp (Trina Solar, Jinko, JA Solar)
 *
 * Alle Werte sind Schaetzungen ohne Gewaehr und sollen nur eine
 * groessenordnungs-Indikation fuer Akquise-Gespraeche liefern.
 */

// Default — wird durch app_settings ueberschrieben falls vorhanden
export const MODUL_LEISTUNG_NEU_WP = 720; // 2026: Tier-1 (LONGi Hi-MO 9, Trina Vertex N)

// Aktueller EEG-Neuanlagen-Vergütungssatz fuer Repowering-Kapazität (Stand 2026)
const EEG_RATE_NEW_INSTALLATIONS_CT_PER_KWH = 6.5;

/**
 * Geschaetzte Modulflaeche (m²) abhaengig von der Wp-Klasse.
 * Quellen: Datenblaetter LONGi, Trina, JA Solar, Jinko 2014-2026.
 * Hoehere Wp = groessere Module (mehr Zellen/groessere Wafer).
 */
export function moduleAreaM2(wp: number): number {
  if (wp < 230) return 1.50;   // Sehr alt (Polykristallin 2010-)
  if (wp < 280) return 1.62;   // 60-cell typical 2012-2016
  if (wp < 340) return 1.65;
  if (wp < 400) return 1.85;   // 72-cell mono PERC 2018-
  if (wp < 460) return 2.00;
  if (wp < 520) return 2.15;   // Half-cut 144-cell 2020+
  if (wp < 580) return 2.40;
  if (wp < 640) return 2.70;   // N-Type TOPCon 2024+
  if (wp < 720) return 2.85;
  return 3.00;                  // Hochleistungs-Tier-1 2026
}

/**
 * Recherchierte spezifische Ertraege (kWh/kWp/Jahr) fuer Deutschland-Mitte,
 * monokristalline Standard-Module, freie Aufstellung ohne Verschattung.
 *
 * Quellen:
 * - PVGIS v5.2 (European Commission JRC) — Standort 51°N / 10°E (Frankfurt/Erfurt Mitte)
 *   https://re.jrc.ec.europa.eu/pvg_tools/en/
 * - Fraunhofer ISE "Photovoltaics Report 2024", Tab. spez. Energieertraege DE
 * - DGS Berechnungsempfehlung (Solarstromhandbuch 2023)
 *
 * Werte sind Mittelwerte. Norddeutschland: ca. -10%, Sueddeutschland: ca. +5%.
 * Stand: 2025 (Klimadaten 2010-2023).
 */
const SPECIFIC_YIELD_DE_MID: Record<string, Record<string, number>> = {
  //                       | <20°  | 20-40°| 40-60°| >60°  | Senkr | Nachf.|
  "Sued":                  { "< 20°": 950, "20° - 40°": 1050, "40° - 60°": 1030, "> 60°": 920, "Senkrecht": 700, "Mit Nachfuehrung": 1200 },
  "Süd":                   { "< 20°": 950, "20° - 40°": 1050, "40° - 60°": 1030, "> 60°": 920, "Senkrecht": 700, "Mit Nachfuehrung": 1200 },
  "Sued-Ost":              { "< 20°": 920, "20° - 40°": 1010, "40° - 60°":  980, "> 60°": 870, "Senkrecht": 660 },
  "Süd-Ost":               { "< 20°": 920, "20° - 40°": 1010, "40° - 60°":  980, "> 60°": 870, "Senkrecht": 660 },
  "Sued-West":             { "< 20°": 920, "20° - 40°": 1010, "40° - 60°":  980, "> 60°": 870, "Senkrecht": 660 },
  "Süd-West":              { "< 20°": 920, "20° - 40°": 1010, "40° - 60°":  980, "> 60°": 870, "Senkrecht": 660 },
  "Ost":                   { "< 20°": 880, "20° - 40°":  920, "40° - 60°":  870, "> 60°": 750, "Senkrecht": 580 },
  "West":                  { "< 20°": 880, "20° - 40°":  920, "40° - 60°":  870, "> 60°": 750, "Senkrecht": 580 },
  "Nord-Ost":              { "< 20°": 820, "20° - 40°":  800, "40° - 60°":  720, "> 60°": 600, "Senkrecht": 450 },
  "Nord-West":             { "< 20°": 820, "20° - 40°":  800, "40° - 60°":  720, "> 60°": 600, "Senkrecht": 450 },
  "Nord":                  { "< 20°": 780, "20° - 40°":  650, "40° - 60°":  530, "> 60°": 420, "Senkrecht": 280 },
  "Ost-West":              { "< 20°": 920, "20° - 40°":  900, "40° - 60°":  850, "> 60°": 700, "Senkrecht": 540 },
  "Andere/Variabel":       { "< 20°": 880, "20° - 40°":  950, "40° - 60°":  920, "> 60°": 800, "Senkrecht": 600 },
  "Sued mit Nachfuehrung": { "< 20°":1100, "20° - 40°": 1200, "40° - 60°": 1180, "> 60°":1050, "Senkrecht": 800, "Mit Nachfuehrung": 1200 },
  "Süd mit Nachfuehrung":  { "< 20°":1100, "20° - 40°": 1200, "40° - 60°": 1180, "> 60°":1050, "Senkrecht": 800, "Mit Nachfuehrung": 1200 },
  "Senkrecht":             { "< 20°": 700, "20° - 40°":  700, "40° - 60°":  700, "> 60°": 700, "Senkrecht": 700 },
  "Senkrecht (Fassade)":   { "< 20°": 700, "20° - 40°":  700, "40° - 60°":  700, "> 60°": 700, "Senkrecht": 700 },
};

const DEFAULT_YIELD_FALLBACK_KWH_PER_KWP = 950;

/**
 * Liest den spezifischen Ertrag aus der recherchierten Tabelle.
 * Returns: { value: kWh/kWp/Jahr, basis: Quellen-Hinweis }
 */
export function lookupSpecificYield(
  orientation: string | null | undefined,
  tilt: string | null | undefined,
): { value: number; basis: string } {
  const orient = orientation || "Sued";
  const t = tilt || "20° - 40°";
  const row = SPECIFIC_YIELD_DE_MID[orient];
  if (row && row[t] != null) {
    return { value: row[t], basis: `PVGIS v5.2 DE-Mitte: ${orient} / ${t}` };
  }
  if (row) {
    const fallback = row["20° - 40°"] ?? Object.values(row)[0];
    return { value: fallback, basis: `${orient}, Neigung "${t}" unbekannt → angenommen 20-40°` };
  }
  return { value: DEFAULT_YIELD_FALLBACK_KWH_PER_KWP, basis: `Fallback: "${orient}" nicht in Tabelle` };
}

export interface YieldEstimate {
  specific_yield_kwh_per_kwp: number;
  annual_yield_kwh: number;
  orientation_label: string;
  tilt_label: string;
  factor: number;
}

/**
 * Schaetzt den Jahres-Ertrag einer Anlage in kWh.
 */
export interface YieldEstimateWithBasis extends YieldEstimate {
  basis: string;
}

export function estimateAnnualYield(
  nettoLeistungKw: number | null | undefined,
  ausrichtung: string | null | undefined,
  neigungswinkel: string | null | undefined,
  regionFactor: number = 1.0,   // 0.9 Nord, 1.0 Mitte, 1.05 Sued — optionaler regionaler Anpassung
): YieldEstimateWithBasis | null {
  if (!nettoLeistungKw || nettoLeistungKw <= 0) return null;
  const orientLabel = ausrichtung || "Sued";
  const tiltLabel = neigungswinkel || "20° - 40°";
  const { value: baseYield, basis } = lookupSpecificYield(orientLabel, tiltLabel);
  const specific = Math.round(baseYield * regionFactor);
  const annual = Math.round(nettoLeistungKw * specific);
  return {
    specific_yield_kwh_per_kwp: specific,
    annual_yield_kwh: annual,
    orientation_label: orientLabel,
    tilt_label: tiltLabel,
    factor: Math.round(regionFactor * 100) / 100,
    basis: regionFactor === 1.0 ? basis : `${basis} × ${regionFactor.toFixed(2)} Region-Faktor`,
  };
}

export interface EegRateEstimate {
  cent_per_kwh: number;
  basis: string;           // Begruendung
  scheme: "EEG-feste-Verguetung" | "EEG-Marktpraemie" | "Ausschreibung" | "Direktvermarktung" | "post-EEG" | "Unbekannt";
  annual_revenue_eur: number;
}

/**
 * Schaetzt den EEG-Verguetungssatz basierend auf Inbetriebnahmedatum + Anlagengroesse.
 * Werte sind Mittelwerte fuer Freiflaeche/Dachanlagen, kombiniert.
 * Fuer Anlagen unter Ausschreibung (>750 kW seit 2017) wird der Gebotswert herangezogen,
 * sofern in der DB vorhanden (Parameter `zuschlagBetrag`).
 */
export function estimateEegRate(
  inbetriebnahmedatum: string | null | undefined,
  leistungKw: number | null | undefined,
  zuschlagBetrag: number | null | undefined,
  annualYieldKwh: number,
): EegRateEstimate | null {
  if (!leistungKw || leistungKw <= 0) return null;

  // 1. Wenn Zuschlagsbetrag (Ausschreibung) vorhanden -> der gilt
  if (zuschlagBetrag && zuschlagBetrag > 0 && zuschlagBetrag < 100) {
    return {
      cent_per_kwh: zuschlagBetrag,
      basis: `Zuschlagswert aus Ausschreibung: ${zuschlagBetrag.toFixed(2)} ct/kWh`,
      scheme: "Ausschreibung",
      annual_revenue_eur: Math.round((annualYieldKwh * zuschlagBetrag) / 100),
    };
  }

  if (!inbetriebnahmedatum) {
    return {
      cent_per_kwh: 0,
      basis: "Kein Inbetriebnahmedatum bekannt — keine Schaetzung moeglich",
      scheme: "Unbekannt",
      annual_revenue_eur: 0,
    };
  }

  const year = parseInt(inbetriebnahmedatum.substring(0, 4), 10);
  if (isNaN(year)) return null;

  // 20-Jahres-Bindung: Anlagen aelter als 20 J. sind aus EEG-Foerderung raus
  const ageYears = new Date().getFullYear() - year;
  if (ageYears > 20) {
    return {
      cent_per_kwh: 4.0,
      basis: `Anlage ${ageYears} Jahre alt — EEG-Foerderung beendet. Sonstige Direktvermarktung ~3-5 ct/kWh.`,
      scheme: "post-EEG",
      annual_revenue_eur: Math.round((annualYieldKwh * 4.0) / 100),
    };
  }

  // Vereinfachte Mittelwert-Saetze nach Jahr × Klasse
  // Quelle: Bundesnetzagentur EEG-Vergütungssätze Tabellen
  let rate: number;
  let basis: string;
  const big = leistungKw >= 1000; // ueber 1 MW
  const mid = leistungKw >= 100 && leistungKw < 1000;
  const small = leistungKw < 100;

  if (year <= 2009)      { rate = small ? 43.0 : mid ? 38.0 : 32.0; basis = `${year}: ${small?"<100kW":mid?"100kW-1MW":">1MW"} Festverguetung (sehr hoch, Bestandsschutz)`; }
  else if (year === 2010){ rate = small ? 34.0 : mid ? 29.0 : 25.0; basis = `${year}: Festverguetung`; }
  else if (year === 2011){ rate = small ? 28.0 : mid ? 23.0 : 19.5; basis = `${year}: Festverguetung`; }
  else if (year === 2012){ rate = small ? 19.5 : mid ? 16.5 : 13.5; basis = `${year}: Festverguetung (Maerz-Cap)`; }
  else if (year === 2013){ rate = small ? 15.5 : mid ? 13.5 : 11.0; basis = `${year}: Festverguetung`; }
  else if (year === 2014){ rate = small ? 13.0 : mid ? 11.5 : 9.5;  basis = `${year}: Marktpraemie`; }
  else if (year === 2015){ rate = small ? 12.0 : mid ? 10.5 : 8.7;  basis = `${year}: Marktpraemie`; }
  else if (year === 2016){ rate = small ? 12.0 : mid ? 10.4 : 8.5;  basis = `${year}: Marktpraemie`; }
  else if (year === 2017){ rate = small ? 11.5 : mid ? 10.0 : 8.0;  basis = `${year}: ab Q3 Ausschreibung >750kW`; }
  else if (year === 2018){ rate = small ? 11.0 : mid ? 9.0 : 7.5;   basis = `${year}: Marktpraemie / Ausschreibung`; }
  else if (year === 2019){ rate = small ? 10.5 : mid ? 8.5 : 7.0;   basis = `${year}: Marktpraemie / Ausschreibung`; }
  else if (year === 2020){ rate = small ? 9.0  : mid ? 7.5 : 6.5;   basis = `${year}: degressive Foerderung`; }
  else if (year === 2021){ rate = small ? 7.5  : mid ? 6.8 : 6.0;   basis = `${year}: degressive Foerderung`; }
  else if (year === 2022){ rate = small ? 7.0  : mid ? 6.4 : 5.8;   basis = `${year}: degressive Foerderung`; }
  else if (year === 2023){ rate = small ? 8.6  : mid ? 7.5 : 6.5;   basis = `${year}: ab Jul Saetze angehoben (EEG-Reform 2023)`; }
  else if (year === 2024){ rate = small ? 8.0  : mid ? 7.0 : 6.2;   basis = `${year}: leicht degressiv`; }
  else                   { rate = small ? 7.5  : mid ? 6.7 : 5.8;   basis = `${year}: aktuelle EEG-Saetze`; }

  return {
    cent_per_kwh: rate,
    basis,
    scheme: year >= 2014 ? "EEG-Marktpraemie" : "EEG-feste-Verguetung",
    annual_revenue_eur: Math.round((annualYieldKwh * rate) / 100),
  };
}

export interface RepoweringEstimate {
  current_wp_per_module: number;
  new_wp_per_module: number;
  ratio: number;
  new_brutto_kw: number;
  capacity_gain_kw: number;
  annual_yield_new_kwh: number;
  annual_yield_gain_kwh: number;
  annual_revenue_gain_eur: number;
  current_module_area_m2: number;
  new_module_area_m2: number;
  total_module_area_m2: number;
  new_anzahl_module: number;
  mounting_fit_factor: number;
  note: string;
}

/**
 * Repowering-Potenzial: gleiche Modulanzahl, moderne Module.
 * Setzt voraus dass anzahl_module + bruttoleistung bekannt sind.
 * Mehr-Umsatz wird mit gleicher EEG-Rate wie Bestandsanlage gerechnet — das ist
 * eine OBERE Schaetzung; bei tatsaechlichem Repowering greifen ggf. andere
 * Foerderkonditionen (Ausschreibung, post-EEG).
 */
export interface RepoweringEstimate2 extends RepoweringEstimate {
  current_module_area_m2: number;
  new_module_area_m2: number;
  total_module_area_m2: number;
  new_anzahl_module: number;
  mounting_fit_factor: number;
}

/**
 * Flaechenbasiertes Repowering:
 * Annahme: die existierende Tragstruktur kann neue Module aufnehmen, aber nur
 * so viele wie auf die alte Modulflaeche passen (groessere neue Module = weniger Stueck).
 * fit_factor beruecksichtigt Verluste durch Mounting-Inkompatibilitaeten (Default 0.95).
 */
export function estimateRepowering(
  bruttoLeistungKw: number | null | undefined,
  anzahlModule: number | null | undefined,
  specificYieldKwhPerKwp: number,
  currentRateCentPerKwh: number,
  newModuleWp: number = MODUL_LEISTUNG_NEU_WP,
  fitFactor: number = 0.95,
): RepoweringEstimate2 | null {
  if (!bruttoLeistungKw || !anzahlModule || anzahlModule <= 0 || bruttoLeistungKw <= 0) return null;
  const currentWp = (bruttoLeistungKw * 1000) / anzahlModule;
  const currentAreaM2 = moduleAreaM2(currentWp);
  const newAreaM2 = moduleAreaM2(newModuleWp);
  const totalAreaM2 = anzahlModule * currentAreaM2;
  // Wieviele neue Module passen tatsaechlich auf die alte Flaeche (× fit_factor)
  const newAnzahlModule = Math.floor((totalAreaM2 * fitFactor) / newAreaM2);
  const newBruttoKw = (newAnzahlModule * newModuleWp) / 1000;
  const ratio = newBruttoKw / bruttoLeistungKw;
  const capacityGainKw = newBruttoKw - bruttoLeistungKw;
  const annualYieldNew = Math.round(newBruttoKw * specificYieldKwhPerKwp);
  const annualYieldGain = Math.round(capacityGainKw * specificYieldKwhPerKwp);
  const effectiveRate = currentRateCentPerKwh > 0 ? currentRateCentPerKwh : EEG_RATE_NEW_INSTALLATIONS_CT_PER_KWH;
  const annualRevenueGain = Math.round((annualYieldGain * effectiveRate) / 100);
  const efficiencyOld = (currentWp / currentAreaM2).toFixed(0);
  const efficiencyNew = (newModuleWp / newAreaM2).toFixed(0);
  return {
    current_wp_per_module: Math.round(currentWp),
    new_wp_per_module: newModuleWp,
    ratio: Math.round(ratio * 100) / 100,
    new_brutto_kw: Math.round(newBruttoKw * 10) / 10,
    capacity_gain_kw: Math.round(capacityGainKw * 10) / 10,
    annual_yield_new_kwh: annualYieldNew,
    annual_yield_gain_kwh: annualYieldGain,
    annual_revenue_gain_eur: annualRevenueGain,
    current_module_area_m2: currentAreaM2,
    new_module_area_m2: newAreaM2,
    total_module_area_m2: Math.round(totalAreaM2),
    new_anzahl_module: newAnzahlModule,
    mounting_fit_factor: fitFactor,
    note: `Flaechenmodell: ${anzahlModule.toLocaleString("de-DE")} alte Module à ${currentAreaM2}m² (${efficiencyOld} Wp/m²) → max. ${newAnzahlModule.toLocaleString("de-DE")} neue Module à ${newAreaM2}m² (${efficiencyNew} Wp/m²), inkl. ${Math.round(fitFactor*100)}% Mounting-Fit-Faktor. Mehr-Erlös @ ${effectiveRate.toFixed(1)} ct/kWh.`,
  };
}

// ============== SPEICHER (ABREGELUNGS-VERMEIDUNG) ==============
//
// Modell fuer Gewerbe-/Freiflaechen-PV (Volleinspeisung):
// Bei Netzueberlast (EinsMan/EisMan) oder negativen Spot-Preisen wird die Anlage
// vom Netzbetreiber abgeregelt — die Energie geht verloren ohne Verguetung.
//
// Stand 2024/2025 (Bundesnetzagentur, ENTSO-E):
// - EinsMan-Abregelung gross-PV in DE: 2-5% der Jahresproduktion
// - Negative Strompreise 2024: 460 Stunden (5.3% der Jahresstunden), Trend stark steigend
// - Fuer EEG-Anlagen mit EinsMan-Vertrag teilweise Entschaedigung (98%),
//   aber bei marktgetriebener Abschaltung (negative Preise) keine.
//
// Speicher faengt die sonst verlorene Energie auf und speist sie spaeter ein,
// wenn die Anlage wieder ans Netz darf und Preise positiv sind.
//
// Quellen:
// - BNetzA Monitoringbericht EinsMan 2023/2024
// - Agora Energiewende, "Negative Strompreise 2024"
// - Studie Fraunhofer IEE "Wirtschaftlichkeit Gewerbespeicher" 2023

export interface StorageEstimate {
  storage_capacity_kwh: number;
  storage_investment_eur: number;
  curtailment_pct: number;                  // Anteil Jahresproduktion durch Abregelung verloren
  lost_kwh_without_storage: number;          // sonst verlorene Energie pro Jahr
  recovered_kwh_with_storage: number;        // davon vom Speicher gerettet
  recovery_quote_pct: number;                // wieviel % der Verluste werden kompensiert
  eeg_rate_ct_per_kwh: number;               // mit der die geretteten kWh vermarktet werden
  annual_savings_eur: number;
  payback_years: number | null;
  note: string;
}

/**
 * Wirtschaftlichkeit eines Speichers fuer eine Volleinspeisungs-Anlage.
 * Cash-Effekt: zurueckgewonnene Abregelungs-Energie × EEG-Satz (oder aktueller Spotpreis).
 */
export function estimateStorageImpact(
  annualYieldKwh: number,
  newBruttoKw: number,
  eegRateCentPerKwh: number,
  settings: {
    storage_ratio_kwh_per_kwp: number;
    storage_cost_eur_per_kwh: number;
    curtailment_pct: number;                // % Jahresproduktion abgeregelt (typisch 3-5)
    recovery_quote_pct: number;             // % der Abregelung die Speicher abfangen kann
  },
): StorageEstimate | null {
  if (!annualYieldKwh || annualYieldKwh <= 0 || !newBruttoKw || newBruttoKw <= 0) return null;
  const capacity = Math.round(newBruttoKw * settings.storage_ratio_kwh_per_kwp * 10) / 10;
  const investment = Math.round(capacity * settings.storage_cost_eur_per_kwh);
  const lostKwh = Math.round(annualYieldKwh * (settings.curtailment_pct / 100));
  const recoveredKwh = Math.round(lostKwh * (settings.recovery_quote_pct / 100));
  // Wenn Bestandsanlage post-EEG (rate=0), fallback auf aktuellen Neuanlagen-EEG-Satz
  const effectiveRate = eegRateCentPerKwh > 0 ? eegRateCentPerKwh : EEG_RATE_NEW_INSTALLATIONS_CT_PER_KWH;
  const annualSavings = Math.round((recoveredKwh * effectiveRate) / 100);
  const paybackYears = annualSavings > 0 ? Math.round((investment / annualSavings) * 10) / 10 : null;
  return {
    storage_capacity_kwh: capacity,
    storage_investment_eur: investment,
    curtailment_pct: settings.curtailment_pct,
    lost_kwh_without_storage: lostKwh,
    recovered_kwh_with_storage: recoveredKwh,
    recovery_quote_pct: settings.recovery_quote_pct,
    eeg_rate_ct_per_kwh: effectiveRate,
    annual_savings_eur: annualSavings,
    payback_years: paybackYears,
    note: paybackYears
      ? `Payback: ~${paybackYears} J. · ${capacity.toLocaleString("de-DE")} kWh Speicher faengt ${recoveredKwh.toLocaleString("de-DE")} kWh/Jahr ab (Abregelung)`
      : `Bei diesem EEG-Satz lohnt sich der Speicher fuer reine Abregelungs-Vermeidung nicht — anderen Use-Case pruefen (Peak-Shaving, Direktvermarktung)`,
  };
}

export interface PvEconomics {
  yield: YieldEstimate | null;
  eeg: EegRateEstimate | null;
  repowering: RepoweringEstimate | null;
  storage: StorageEstimate | null;
}

export interface EconomicsConfig {
  repowering_module_wp: number;
  region_factor: number;                 // 0.90 Nord, 1.00 Mitte, 1.05 Sued (Default 1.0)
  storage_ratio_kwh_per_kwp: number;
  storage_cost_eur_per_kwh: number;
  curtailment_pct: number;               // typisch 3-5 % bei Gross-PV mit EinsMan
  recovery_quote_pct: number;            // 80-95 % bei richtig dimensioniertem Speicher
}

/**
 * Komplette Wirtschaftlichkeits-Analyse fuer eine Anlage (Server-side).
 * Settings-Werte koennen org-weit ueber app_settings konfiguriert werden.
 */
export function computeEconomics(
  a: {
    nettonennleistung?: number | null;
    bruttoleistung?: number | null;
    anzahl_module?: number | null;
    hauptausrichtung?: string | null;
    hauptausrichtung_neigungswinkel?: string | null;
    inbetriebnahme?: string | null;
    zuschlag_kwh_betrag?: number | null;
  },
  config?: Partial<EconomicsConfig>,
): PvEconomics {
  const cfg: EconomicsConfig = {
    repowering_module_wp: config?.repowering_module_wp ?? MODUL_LEISTUNG_NEU_WP,
    region_factor: config?.region_factor ?? 1.0,
    storage_ratio_kwh_per_kwp: config?.storage_ratio_kwh_per_kwp ?? 1.0,
    storage_cost_eur_per_kwh: config?.storage_cost_eur_per_kwh ?? 650,
    curtailment_pct: config?.curtailment_pct ?? 4,
    recovery_quote_pct: config?.recovery_quote_pct ?? 85,
  };
  const y = estimateAnnualYield(a.nettonennleistung, a.hauptausrichtung, a.hauptausrichtung_neigungswinkel, cfg.region_factor);
  const eeg = y ? estimateEegRate(a.inbetriebnahme, a.nettonennleistung, a.zuschlag_kwh_betrag, y.annual_yield_kwh) : null;
  const repowering = y && eeg ? estimateRepowering(a.bruttoleistung, a.anzahl_module, y.specific_yield_kwh_per_kwp, eeg.cent_per_kwh, cfg.repowering_module_wp) : null;
  const baseKw = repowering?.new_brutto_kw || a.bruttoleistung || a.nettonennleistung || 0;
  const yieldForStorage = repowering?.annual_yield_new_kwh || y?.annual_yield_kwh || 0;
  const eegForStorage = eeg?.cent_per_kwh || 0;
  const storage = yieldForStorage > 0 ? estimateStorageImpact(yieldForStorage, baseKw, eegForStorage, cfg) : null;
  return { yield: y, eeg, repowering, storage };
}
