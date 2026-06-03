import type { Database } from "bun:sqlite";

const NOMINATIM = process.env.NOMINATIM_URL || "https://nominatim.openstreetmap.org";
// Photon API — Komoots Open-Source Geocoder. Wir nutzen den oeffentlichen Endpunkt fuer
// die Faelle wo Nominatim versagt (typo-tolerant, lenient bei abweichenden Schreibweisen).
// Bei sehr hoher Last sollte ein lokaler Photon-Docker aufgesetzt werden — der hier
// genutzte Public-Service ist Komoots "fair use" Policy unterworfen.
const PHOTON_URL = process.env.PHOTON_URL || "https://photon.komoot.io";
const USER_AGENT = "mastr-solar-db/2.1 (kontakt: ekbcassa@gmail.com)";
const RATE_LIMIT_MS = 1100; // 1 req/sec hard limit fuer Nominatim
const PHOTON_RATE_LIMIT_MS = 1100; // selbe Hoeflichkeit fuer Photon-Public-API

let lastReq = 0;
async function rateLimit() {
  const wait = RATE_LIMIT_MS - (Date.now() - lastReq);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastReq = Date.now();
}

let lastPhoton = 0;
async function photonRateLimit() {
  const wait = PHOTON_RATE_LIMIT_MS - (Date.now() - lastPhoton);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastPhoton = Date.now();
}

// Bundesland-Bboxes fuer Sanity-Check der Geocoder-Treffer
const BUNDESLAND_BBOX: Record<string, [number, number, number, number]> = {
  "Bayern": [47.2, 50.6, 8.9, 13.9],
  "Baden-Wuerttemberg": [47.5, 49.8, 7.5, 10.6],
  "Berlin": [52.3, 52.7, 13.0, 13.8],
  "Brandenburg": [51.3, 53.6, 11.2, 14.8],
  "Bremen": [53.0, 53.7, 8.4, 9.1],
  "Hamburg": [53.3, 53.8, 8.4, 10.4],
  "Hessen": [49.3, 51.7, 7.7, 10.3],
  "Mecklenburg-Vorpommern": [53.1, 54.7, 10.5, 14.5],
  "Niedersachsen": [51.3, 53.9, 6.6, 11.6],
  "Nordrhein-Westfalen": [50.3, 52.6, 5.8, 9.5],
  "Rheinland-Pfalz": [48.9, 51.0, 6.1, 8.6],
  "Saarland": [49.1, 49.7, 6.3, 7.5],
  "Sachsen": [50.1, 51.7, 11.8, 15.1],
  "Sachsen-Anhalt": [50.9, 53.1, 10.5, 13.2],
  "Schleswig-Holstein": [53.3, 55.1, 7.8, 11.4],
  "Thueringen": [50.2, 51.7, 9.8, 12.7],
};

function inBox(lat: number, lng: number, box: [number, number, number, number]): boolean {
  return lat >= box[0] && lat <= box[1] && lng >= box[2] && lng <= box[3];
}

async function nominatimQuery(params: URLSearchParams): Promise<{ lat: number; lng: number } | null> {
  await rateLimit();
  try {
    const res = await fetch(`${NOMINATIM}/search?${params}`, {
      headers: { "User-Agent": USER_AGENT, "Accept": "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const data = await res.json() as any[];
    if (!data.length) return null;
    const lat = parseFloat(data[0].lat); const lng = parseFloat(data[0].lon);
    if (isNaN(lat) || isNaN(lng)) return null;
    return { lat, lng };
  } catch (e) { return null; }
}

/**
 * Photon-Geocoder (Komoot). Wird als Fallback gerufen wenn Nominatim nichts liefert.
 * Macht typo-tolerantes Matching, versteht Strassennamen-Varianten besser.
 * Bewertet das Ergebnis mit der "extent"-Praezision falls vorhanden.
 */
async function photonQuery(query: string, opts: { bias_lat?: number; bias_lng?: number; lang?: string } = {}): Promise<{ lat: number; lng: number; type?: string } | null> {
  await photonRateLimit();
  try {
    const params = new URLSearchParams({ q: query, limit: "1", lang: opts.lang || "de" });
    // Lokalitaets-Bias auf die ungefaehre PLZ-Position fuer bessere Treffer
    if (opts.bias_lat != null && opts.bias_lng != null) {
      params.set("lat", String(opts.bias_lat));
      params.set("lon", String(opts.bias_lng));
      params.set("location_bias_scale", "0.3");
    }
    const res = await fetch(`${PHOTON_URL}/api?${params}`, {
      headers: { "User-Agent": USER_AGENT, "Accept": "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const data = await res.json() as any;
    const feature = data.features?.[0];
    if (!feature?.geometry?.coordinates) return null;
    const [lng, lat] = feature.geometry.coordinates;
    if (isNaN(lat) || isNaN(lng)) return null;
    return { lat, lng, type: feature.properties?.type };
  } catch { return null; }
}

export type GeocodeResult = { lat: number; lng: number; precision: "address" | "street" | "postcode" | "city" | "photon_address" | "photon_street" };

export async function geocodeAddress(addr: { strasse?: string; hausnummer?: string; plz?: string; ort?: string; bundesland?: string }): Promise<GeocodeResult | null> {
  const expectedBox = addr.bundesland ? BUNDESLAND_BBOX[addr.bundesland] : null;

  // Try 1 (BESTE): structured Adresse mit Strasse+Hausnummer -> Gebauede-genaue Position
  if (addr.strasse && addr.plz) {
    const params = new URLSearchParams({ format: "json", limit: "1", addressdetails: "0", countrycodes: "de" });
    const streetPart = addr.hausnummer ? `${addr.hausnummer} ${addr.strasse}` : addr.strasse;
    params.set("street", streetPart);
    params.set("postalcode", addr.plz);
    if (addr.ort) params.set("city", addr.ort);
    const result = await nominatimQuery(params);
    if (result && (!expectedBox || inBox(result.lat, result.lng, expectedBox))) {
      return { ...result, precision: addr.hausnummer ? "address" : "street" };
    }
  }

  // Try 2: free-text mit Strasse + PLZ + Ort
  if (addr.strasse && (addr.plz || addr.ort)) {
    const q = [
      addr.hausnummer ? `${addr.strasse} ${addr.hausnummer}` : addr.strasse,
      addr.plz, addr.ort, "Deutschland",
    ].filter(Boolean).join(", ");
    const params = new URLSearchParams({ format: "json", limit: "1", addressdetails: "0", countrycodes: "de", q });
    const result = await nominatimQuery(params);
    if (result && (!expectedBox || inBox(result.lat, result.lng, expectedBox))) {
      return { ...result, precision: addr.hausnummer ? "address" : "street" };
    }
  }

  // Try 3: PLZ + Stadt + Bundesland (Fallback wenn Strasse fehlt oder nicht gefunden)
  if (addr.plz || addr.ort) {
    const params = new URLSearchParams({ format: "json", limit: "5", addressdetails: "0", countrycodes: "de" });
    if (addr.plz) params.set("postalcode", addr.plz);
    if (addr.ort) params.set("city", addr.ort);
    if (addr.bundesland) params.set("state", addr.bundesland.replace(/Wuerttemberg/, "Württemberg").replace(/Thueringen/, "Thüringen"));
    const result = await nominatimQuery(params);
    if (result && (!expectedBox || inBox(result.lat, result.lng, expectedBox))) {
      return { ...result, precision: addr.plz ? "postcode" : "city" };
    }
  }

  // Try 4: nur PLZ + Bundesland (Nominatim)
  if (addr.plz) {
    const params = new URLSearchParams({ format: "json", limit: "5", addressdetails: "0", countrycodes: "de" });
    params.set("postalcode", addr.plz);
    if (addr.bundesland) params.set("state", addr.bundesland.replace(/Wuerttemberg/, "Württemberg").replace(/Thueringen/, "Thüringen"));
    const result = await nominatimQuery(params);
    if (result && (!expectedBox || inBox(result.lat, result.lng, expectedBox))) {
      return { ...result, precision: "postcode" };
    }
  }

  // Try 5+6 — Photon-Fallback fuer typo-tolerantes Matching wenn Nominatim versagt
  if (addr.strasse && addr.plz) {
    const streetPart = addr.hausnummer ? `${addr.strasse} ${addr.hausnummer}` : addr.strasse;
    const q = `${streetPart}, ${addr.plz} ${addr.ort || ""}`.trim();
    const result = await photonQuery(q);
    if (result && (!expectedBox || inBox(result.lat, result.lng, expectedBox))) {
      // Photon liefert oft house/street type -> als address/street klassifizieren
      const isHouse = result.type === "house" || addr.hausnummer;
      return { lat: result.lat, lng: result.lng, precision: isHouse ? "photon_address" : "photon_street" };
    }
  }

  return null;
}

/**
 * Geocode batch — verarbeitet Anlagen mit Strassenangabe um sie aus den ungenauen
 * MaStR-PLZ-Centroiden auf adressgenau zu heben.
 *
 * Strategie:
 *   1. PRIO: noch nicht geocodet UND Strasse+Hausnummer vorhanden -> Adress-genaue Position
 *   2. Anlagen ohne lat/lng UND mit PLZ -> mindestens PLZ-Centroid setzen
 * Vorhandene `position_refined_at` (OSM-Overpass) wird NICHT ueberschrieben — die ist genauer.
 */
export async function geocodeBatch(db: Database, opts: { limit?: number } = {}): Promise<{ processed: number; ok: number; fail: number; precision_counts: Record<string, number> }> {
  const limit = opts.limit ?? 50;
  // Priorisierung:
  //   1. Anlagen mit Strasse+Hausnummer die noch nie geocodet wurden (geocoded_at IS NULL)
  //   2. Anlagen ohne GPS ueberhaupt
  // Refined (Overpass) Anlagen NIE ueberschreiben.
  const rows = db.prepare(`
    SELECT a.id, a.strasse, a.hausnummer, a.plz, a.ort, a.bundesland,
      (CASE WHEN a.strasse IS NOT NULL AND a.strasse != '' THEN 1 ELSE 0 END) AS has_street
    FROM anlagen a
    WHERE a.position_refined_at IS NULL
      AND a.geocoded_at IS NULL
      AND (a.plz IS NOT NULL OR a.ort IS NOT NULL)
    ORDER BY has_street DESC, a.nettonennleistung DESC NULLS LAST
    LIMIT ?
  `).all(limit) as any[];

  const upd = db.prepare(`UPDATE anlagen SET breitengrad=?, laengengrad=?, geocoded_at=CURRENT_TIMESTAMP, geocode_precision=? WHERE id=?`);
  const updFail = db.prepare(`UPDATE anlagen SET geocoded_at=CURRENT_TIMESTAMP, geocode_precision='failed' WHERE id=?`);

  let ok = 0, fail = 0;
  const precision_counts: Record<string, number> = {};
  for (const r of rows) {
    try {
      const result = await geocodeAddress(r);
      if (result) {
        upd.run(result.lat, result.lng, result.precision, r.id);
        ok++;
        precision_counts[result.precision] = (precision_counts[result.precision] || 0) + 1;
      } else {
        updFail.run(r.id);
        fail++;
      }
    } catch (e) { fail++; }
  }
  return { processed: rows.length, ok, fail, precision_counts };
}
