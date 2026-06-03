/**
 * PDF-Angebot-Generator: erzeugt eine print-ready HTML-Seite (A4),
 * die der Browser via `window.print()` als PDF speichern kann.
 *
 * Bewusst KEIN puppeteer/chromium-Dependency (~300 MB) — der Server
 * liefert HTML, der Client macht den PDF-Export. Vorteile:
 *   - Null Server-Last, keine Headless-Chrome-Installation
 *   - User sieht die Vorschau und kann Daten korrigieren
 *   - Klassisch fuer B2B-Angebote (Print-Knopf direkt drueber)
 */
import type { Database } from "bun:sqlite";

interface QuoteInput {
  anlageId: number;
  user: { display_name?: string; username?: string; smtp_from_name?: string; signature_html?: string; email?: string };
  options?: {
    mehrertrag_pct?: number;
    repowering_capex_per_kwp?: number;
    strompreis_eur_kwh?: number;
    laufzeit_jahre?: number;
  };
}

export function buildQuoteHtml(db: Database, input: QuoteInput): string {
  const a = db.prepare(`
    SELECT a.*,
      b.email as betreiber_email, b.telefon as betreiber_telefon,
      b.strasse as betreiber_strasse, b.plz as betreiber_plz, b.ort as betreiber_ort,
      b.name as betreiber_name_full
    FROM anlagen a
    LEFT JOIN betreiber b ON a.betreiber_mastr = b.mastr_nummer
    WHERE a.id = ?
  `).get(input.anlageId) as any;
  if (!a) throw new Error("Anlage nicht gefunden");

  const opt = input.options || {};
  const mehrertragPct = opt.mehrertrag_pct ?? 25;
  const capexPerKwp = opt.repowering_capex_per_kwp ?? 650;
  const strompreis = opt.strompreis_eur_kwh ?? 0.08;
  const laufzeit = opt.laufzeit_jahre ?? 20;

  const leistung = Math.round(a.nettonennleistung || a.bruttoleistung || 0);
  const ertragVorher = leistung * 950; // 950 kWh/kWp/Jahr typisch DE
  const ertragNachher = ertragVorher * (1 + mehrertragPct / 100);
  const mehrertrag = ertragNachher - ertragVorher;
  const mehrEinnahmenJahr = mehrertrag * strompreis;
  const mehrEinnahmenLaufzeit = mehrEinnahmenJahr * laufzeit;
  const investition = leistung * capexPerKwp;
  const roiJahre = investition > 0 ? (investition / mehrEinnahmenJahr).toFixed(1) : "—";

  const fmt = (n: number) => n.toLocaleString("de-DE", { maximumFractionDigits: 0 });
  const fmt2 = (n: number) => n.toLocaleString("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const today = new Date().toLocaleDateString("de-DE");
  const senderName = input.user.smtp_from_name || input.user.display_name || input.user.username || "—";

  return `<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8">
<title>Repowering-Angebot ${a.name || a.mastr_nummer}</title>
<style>
  @page { size: A4; margin: 18mm 16mm 22mm 16mm; }
  body { font-family: -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; color: #0f172a; line-height: 1.5; font-size: 11pt; margin: 0; }
  h1 { font-size: 22pt; margin: 0 0 4mm 0; color: #0e7490; }
  h2 { font-size: 13pt; margin: 8mm 0 3mm 0; color: #0e7490; border-bottom: 1px solid #cbd5e1; padding-bottom: 1mm; }
  .meta { color: #64748b; font-size: 9pt; }
  table { width: 100%; border-collapse: collapse; margin: 3mm 0; }
  th, td { padding: 2mm 3mm; text-align: left; border-bottom: 1px solid #e2e8f0; vertical-align: top; }
  th { background: #f1f5f9; font-weight: 600; }
  .num { text-align: right; font-variant-numeric: tabular-nums; }
  .highlight { background: #ecfeff; padding: 4mm; border-left: 4px solid #06b6d4; margin: 4mm 0; }
  .highlight strong { color: #0e7490; font-size: 14pt; }
  .footer { margin-top: 10mm; color: #64748b; font-size: 9pt; padding-top: 4mm; border-top: 1px solid #e2e8f0; }
  .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 4mm; }
  .printbar { position: fixed; top: 0; left: 0; right: 0; padding: 8px; background: #0e7490; color: white; text-align: center; font-size: 11pt; }
  .printbar button { background: white; color: #0e7490; border: none; padding: 6px 18px; border-radius: 4px; font-weight: 600; cursor: pointer; margin-left: 12px; }
  @media print { .printbar { display: none; } body { padding: 0 !important; } }
  body.with-bar { padding-top: 50px; }
</style>
</head>
<body class="with-bar">
<div class="printbar">Drucken oder als PDF speichern: <button onclick="window.print()">📄 Drucken / PDF</button></div>

<h1>Repowering-Angebot</h1>
<div class="meta">
  Erstellt am ${today} &middot; Anlage: <strong>${esc(a.name || a.mastr_nummer)}</strong> &middot; MaStR: <code>${esc(a.mastr_nummer || "")}</code>
</div>

<h2>Anlagen-Daten</h2>
<table>
  <tr><th>Standort</th><td>${esc(a.strasse || "")} ${esc(a.hausnummer || "")}, ${esc(a.plz || "")} ${esc(a.ort || "")} (${esc(a.bundesland || "")})</td></tr>
  <tr><th>Betreiber</th><td>${esc(a.betreiber_name || a.betreiber_name_full || "")}</td></tr>
  <tr><th>Inbetriebnahme</th><td>${esc(a.inbetriebnahme || "—")}</td></tr>
  <tr><th>Aktuelle Leistung</th><td class="num"><strong>${fmt(leistung)} kWp</strong></td></tr>
  <tr><th>Anzahl Module</th><td class="num">${fmt(a.anzahl_module || 0)}</td></tr>
  <tr><th>EEG-Anlagenschluessel</th><td>${esc(a.eeg_anlagenschluessel || a.eeg_mastr_nummer || "—")}</td></tr>
  ${a.hat_speicher ? `<tr><th>Speicher</th><td>${fmt(a.speicher_kwh || 0)} kWh</td></tr>` : ""}
</table>

<h2>Repowering-Potenzial</h2>
<p>
  Eine Modernisierung Ihrer Bestandsanlage durch Tausch der Module gegen aktuelle Hochleistungs-Module
  (450–500 Wp pro Modul, ca. ${mehrertragPct} % hoeherer spezifischer Ertrag) sowie ggf. Wechselrichter-Upgrade
  ergibt nach unserer Kalkulation folgendes Bild:
</p>

<table>
  <thead><tr><th>Kennzahl</th><th class="num">Vor Repowering</th><th class="num">Nach Repowering</th></tr></thead>
  <tbody>
    <tr><td>Spezifischer Ertrag</td><td class="num">~ 950 kWh/kWp/a</td><td class="num">~ ${Math.round(950 * (1 + mehrertragPct/100))} kWh/kWp/a</td></tr>
    <tr><td>Jahresertrag</td><td class="num">${fmt(ertragVorher)} kWh</td><td class="num"><strong>${fmt(ertragNachher)} kWh</strong></td></tr>
    <tr><td>Mehrertrag pro Jahr</td><td class="num">—</td><td class="num"><strong>+ ${fmt(mehrertrag)} kWh</strong></td></tr>
    <tr><td>Erloese (bei ${fmt2(strompreis)} €/kWh)</td><td class="num">${fmt(ertragVorher * strompreis)} €</td><td class="num"><strong>${fmt(ertragNachher * strompreis)} €</strong></td></tr>
  </tbody>
</table>

<div class="highlight">
  <div>Mehreinnahmen pro Jahr: <strong>${fmt(mehrEinnahmenJahr)} €</strong></div>
  <div>Mehreinnahmen ueber ${laufzeit} Jahre: <strong>${fmt(mehrEinnahmenLaufzeit)} €</strong></div>
</div>

<h2>Investition &amp; Amortisation</h2>
<div class="grid2">
  <table>
    <tr><th>Investition (geschaetzt)</th><td class="num"><strong>${fmt(investition)} €</strong></td></tr>
    <tr><th>kWp-Preis</th><td class="num">${fmt(capexPerKwp)} €/kWp</td></tr>
    <tr><th>Laufzeit Kalkulation</th><td class="num">${laufzeit} Jahre</td></tr>
  </table>
  <table>
    <tr><th>Amortisation</th><td class="num"><strong>${roiJahre} Jahre</strong></td></tr>
    <tr><th>Netto-Gewinn ueber Laufzeit</th><td class="num">${fmt(mehrEinnahmenLaufzeit - investition)} €</td></tr>
    <tr><th>Annahme Strompreis</th><td class="num">${fmt2(strompreis)} €/kWh</td></tr>
  </table>
</div>

<p style="margin-top: 6mm; font-size: 10pt; color: #64748b;">
  Die hier ausgewiesenen Werte sind eine erste Indikation auf Basis oeffentlich verfuegbarer Markt-Daten.
  Eine verbindliche Kalkulation erfordert eine Vor-Ort-Begehung sowie technische Pruefung der Bestandsanlage.
</p>

<div class="footer">
  ${input.user.signature_html ? input.user.signature_html : `<strong>${esc(senderName)}</strong>${input.user.email ? `<br>${esc(input.user.email)}` : ""}`}
</div>

</body></html>`;
}

function esc(s: any): string {
  if (s == null) return "";
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));
}
