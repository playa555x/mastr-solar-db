// Extract-i18n: scannt static/index.html, sammelt alle deutschen UI-Strings,
// generiert static/locales/de.json (additiv — bestehende Keys werden bewahrt).
//
// Strategie:
//   - HTML-Text-Nodes zwischen >...< mit >= 2 Buchstaben (KEINE Templates, KEIN $t)
//   - Attribute: placeholder, title, alt, aria-label
//   - x-text="'literal'"  oder  x-text=`literal` Bindings
//
// Keys werden deterministisch generiert:
//   auto.<context>.<slug>   z.B. auto.nav.dashboard, auto.btn.speichern
//
// NICHT angerührt:  toast(...), confirm(...), JS-Strings, x-text mit Expressions
// (die werden in Phase 2b manuell ersetzt).
//
// Aufruf:  bun run scripts/extract-i18n.ts
//   --apply    HTML wird in-place geändert (statt nur de.json zu schreiben)
//   --dry      nur Stats ausgeben

import { readFileSync, writeFileSync, existsSync } from "fs";

const HTML_PATH = "static/index.html";
const DE_PATH = "static/locales/de.json";
const args = new Set(process.argv.slice(2));
const APPLY = args.has("--apply");
const DRY = args.has("--dry");

const html = readFileSync(HTML_PATH, "utf-8");
const existing = existsSync(DE_PATH) ? JSON.parse(readFileSync(DE_PATH, "utf-8")) : {};

// Bestehende reverse-lookup: text → key (damit dieselbe Phrase denselben Key bekommt)
const reverseMap = new Map<string, string>();
for (const [k, v] of Object.entries(existing)) {
  if (typeof v === "string" && !k.startsWith("_")) reverseMap.set(v, k);
}

function slug(s: string): string {
  return s.toLowerCase()
    .replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue").replace(/ß/g, "ss")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
}

let autoCounter = 0;
function makeKey(text: string, hint: string): string {
  if (reverseMap.has(text)) return reverseMap.get(text)!;
  const base = `auto.${hint}.${slug(text) || "x" + (++autoCounter)}`;
  let key = base;
  let n = 1;
  while (existing[key] && existing[key] !== text) { key = `${base}_${++n}`; }
  return key;
}

// Sammelt {original, key, hint, replaceWith}
type Hit = { original: string; key: string; replaceWith: string };
const hits: Hit[] = [];
const seen = new Set<string>();

// Heuristik: ist Text "deutsch UI" (mind. 1 Buchstabe, kein Code-Symbol, kein Template-Marker)
function isUIText(s: string): boolean {
  const t = s.trim();
  if (t.length < 2 || t.length > 200) return false;
  if (!/[A-Za-zÄÖÜäöüß]/.test(t)) return false;
  if (/^\s*[\$\{\<\>\@\#]/.test(t)) return false;
  if (t.includes("${") || t.includes("{{")) return false;
  if (/^(true|false|null|undefined|NaN|none|auto|fixed|flex|grid|block)$/i.test(t)) return false;
  if (/^[a-z\-_]+$/i.test(t) && t.length < 5) return false; // css classes etc.
  // Code-Strings ausschliessen: URLs, Endpoints, Domains, Paths
  if (/^\/api\//.test(t)) return false;
  if (/^https?:\/\//.test(t)) return false;
  if (/^[a-z]+\.[a-z]+\.[a-z]+/i.test(t) && t.length < 60) return false;
  if (/^localhost\b/i.test(t)) return false;
  if (/^\/[a-z\/\-:]+$/i.test(t)) return false;
  // Reine Symbol/Zahlen-Strings
  if (/^[\d\.\,\s\+\-\:%]+$/.test(t)) return false;
  if (/^[A-Z_]{3,}$/.test(t)) return false;
  if (t.length < 4 && /^[A-Za-z0-9]+$/.test(t)) return false;
  return true;
}

// ============================================================================
// 1) Text-Nodes zwischen > und <  — naive aber wirksame Regex
// ============================================================================
// Mehrfach-Match, keine HTML/Script-Tags drin
const textNodeRe = />([^<>{}\n\r]{2,200})</g;
let m: RegExpExecArray | null;
while ((m = textNodeRe.exec(html)) !== null) {
  const original = m[1].trim();
  if (!isUIText(original) || seen.has(original)) continue;
  // Skip wenn umgebener Tag <script> oder <style>
  const ctx = html.slice(Math.max(0, m.index - 200), m.index);
  if (/<(script|style)\b[^>]*>$/i.test(ctx)) continue;
  // Skip wenn umgebener Tag bereits x-text= hat (wird via Attribut behandelt)
  if (/x-text\s*=/.test(ctx.slice(-80))) continue;
  seen.add(original);
  const key = makeKey(original, "ui");
  hits.push({ original, key, replaceWith: `<span x-text="$t('${key}')">${original}</span>` });
}

// ============================================================================
// 2) Attribute: placeholder="..." title="..." aria-label="..." alt="..."
// ============================================================================
const attrRe = /\s(placeholder|title|aria-label|alt)="([^"]{2,200})"/g;
while ((m = attrRe.exec(html)) !== null) {
  const attr = m[1];
  const original = m[2];
  if (!isUIText(original)) continue;
  const dedupKey = `${attr}::${original}`;
  if (seen.has(dedupKey)) continue;
  seen.add(dedupKey);
  const key = makeKey(original, "attr");
  // Replacement: + zusaetzliches :attr="$t('key')"-Binding daneben
  // Wir patchen den Tag selbst nicht in dieser Stufe (zu invasiv); nur Key sammeln.
  hits.push({ original, key, replaceWith: "" }); // leeres replaceWith = nur fuer JSON
}

// ============================================================================
// JSON aktualisieren
// ============================================================================
const merged: Record<string, any> = { ...existing };
let added = 0;
for (const h of hits) {
  if (!merged[h.key]) { merged[h.key] = h.original; added++; }
}

console.log(`Gefunden: ${hits.length} Strings`);
console.log(`Neu in de.json: ${added}`);
console.log(`Total Keys in de.json: ${Object.keys(merged).filter(k => !k.startsWith("_")).length}`);

if (DRY) {
  console.log("--dry: keine Aenderungen geschrieben.");
  process.exit(0);
}

// JSON schreiben (sortiert nach Key, _meta zuerst)
const meta = merged._meta;
delete merged._meta;
const sortedKeys = Object.keys(merged).sort();
const out: Record<string, any> = { _meta: meta };
for (const k of sortedKeys) out[k] = merged[k];
writeFileSync(DE_PATH, JSON.stringify(out, null, 2) + "\n", "utf-8");
console.log("de.json geschrieben:", DE_PATH);

if (APPLY) {
  console.log("--apply: HTML-Ersetzung wird vorerst NICHT automatisch durchgefuehrt.");
  console.log("(zu hohes Risiko fuer Regressions — bitte manuell pro Sektion.)");
}
