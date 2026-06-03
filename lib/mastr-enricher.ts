import type { Database } from "bun:sqlite";

const BASE_URL = "https://www.marktstammdatenregister.de";
const SCHNELLSUCHE_URL = `${BASE_URL}/MaStR/Schnellsuche/Schnellsuche`;
const DETAIL_URL = `${BASE_URL}`; // Path comes from Schnellsuche response
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36";

const RATE_LIMIT_MS = 600;        // ~1.5 req/s
const MAX_RETRIES = 3;
const RETRY_BASE_MS = 2000;
const TIMEOUT_MS = 20000;

export interface EnrichResult {
  mastr_nummer: string;
  email: string | null;
  telefon: string | null;
  fax: string | null;
  website: string | null;
  strasse: string | null;
  plz: string | null;
  ort: string | null;
  detail_id: number | null;
  status: "ok" | "not_found" | "no_data" | "error";
  error?: string;
}

export interface EnrichStats {
  total: number;
  processed: number;
  ok: number;
  not_found: number;
  no_data: number;
  error: number;
  with_email: number;
  with_phone: number;
}

async function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

async function fetchWithTimeout(url: string, timeoutMs = TIMEOUT_MS): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, {
      headers: {
        "User-Agent": UA,
        "Accept": "text/html,application/json,*/*",
      },
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(t);
  }
}

export async function resolveAbrToDetailId(abrNummer: string): Promise<number | null> {
  if (!abrNummer || !abrNummer.startsWith("ABR")) return null;
  const num = abrNummer.substring(3);
  const url = `${SCHNELLSUCHE_URL}?praefix=ABR&mastrNummerOrId=${encodeURIComponent(num)}`;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const res = await fetchWithTimeout(url);
      if (!res.ok) {
        if (res.status === 404) return null;
        if (res.status >= 500 && attempt < MAX_RETRIES - 1) {
          await sleep(RETRY_BASE_MS * (attempt + 1));
          continue;
        }
        return null;
      }
      const text = await res.text();
      // {"url":"/MaStR/Akteur/Marktakteur/DetailOeffentlich/1121568"}
      const m = text.match(/DetailOeffentlich\/(\d+)/);
      if (!m) return null;
      return parseInt(m[1], 10);
    } catch (e: any) {
      if (attempt < MAX_RETRIES - 1) {
        await sleep(RETRY_BASE_MS * (attempt + 1));
        continue;
      }
      throw e;
    }
  }
  return null;
}

function extractField(html: string, kind: "email" | "phone" | "fax" | "web"): string | null {
  // <tr class="detailstammdaten email"><td class="...label..."></td><td class="...value...">VALUE</td>
  const re = new RegExp(`<tr class="detailstammdaten ${kind}"[^>]*>[\\s\\S]*?<td class="display-template-value[^"]*"[^>]*>([^<]*)</td>`, "i");
  const m = html.match(re);
  if (!m) return null;
  const v = m[1].trim();
  if (!v || v === "-" || v === "&nbsp;") return null;
  return v;
}

function extractAddress(html: string): { strasse: string | null; plz: string | null; ort: string | null } {
  // Suche nach "address" Klasse oder strukturierten dt/dd / oder Strasse-Pattern
  const stra = html.match(/<tr class="detailstammdaten[^"]*address[^"]*"[^>]*>[\s\S]*?<td class="display-template-value[^"]*"[^>]*>([^<]*)</i);
  // Allgemeiner: nach span/td mit Adresse
  const result = { strasse: null as string | null, plz: null as string | null, ort: null as string | null };
  if (stra) {
    const full = stra[1].trim();
    // Format: "Lindenring 4 14641 Wustermark" oder mehrzeilig
    const adrMatch = full.match(/^(.+?)\s+(\d{5})\s+(.+)$/);
    if (adrMatch) {
      result.strasse = adrMatch[1].trim();
      result.plz = adrMatch[2];
      result.ort = adrMatch[3].trim();
    } else {
      result.strasse = full;
    }
  }
  return result;
}

export async function fetchDetailContacts(detailId: number): Promise<{
  email: string | null;
  telefon: string | null;
  fax: string | null;
  website: string | null;
  strasse: string | null;
  plz: string | null;
  ort: string | null;
}> {
  const url = `${BASE_URL}/MaStR/Akteur/Marktakteur/DetailOeffentlich/${detailId}`;
  const res = await fetchWithTimeout(url);
  if (!res.ok) {
    return { email: null, telefon: null, fax: null, website: null, strasse: null, plz: null, ort: null };
  }
  const html = await res.text();
  const email = extractField(html, "email");
  const telefon = extractField(html, "phone");
  const fax = extractField(html, "fax");
  const website = extractField(html, "web");
  const adr = extractAddress(html);
  return { email, telefon, fax, website, strasse: adr.strasse, plz: adr.plz, ort: adr.ort };
}

export async function enrichMarktakteur(abrNummer: string): Promise<EnrichResult> {
  try {
    const detailId = await resolveAbrToDetailId(abrNummer);
    if (!detailId) {
      return { mastr_nummer: abrNummer, email: null, telefon: null, fax: null, website: null, strasse: null, plz: null, ort: null, detail_id: null, status: "not_found" };
    }
    const data = await fetchDetailContacts(detailId);
    const hasAny = data.email || data.telefon || data.fax || data.website;
    return {
      mastr_nummer: abrNummer,
      detail_id: detailId,
      email: data.email,
      telefon: data.telefon,
      fax: data.fax,
      website: data.website,
      strasse: data.strasse,
      plz: data.plz,
      ort: data.ort,
      status: hasAny ? "ok" : "no_data",
    };
  } catch (e: any) {
    return { mastr_nummer: abrNummer, email: null, telefon: null, fax: null, website: null, strasse: null, plz: null, ort: null, detail_id: null, status: "error", error: e?.message || String(e) };
  }
}

export async function enrichBatch(
  db: Database,
  opts: {
    limit?: number;
    onProgress?: (stats: EnrichStats, current: EnrichResult) => void;
    rateLimitMs?: number;
    onlyMissing?: boolean;
    concurrency?: number;
    bundesland?: string | null;
  } = {},
): Promise<EnrichStats> {
  const limit = opts.limit ?? 999999;
  const rateMs = opts.rateLimitMs ?? RATE_LIMIT_MS;
  const onlyMissing = opts.onlyMissing !== false;
  const concurrency = Math.max(1, Math.min(20, opts.concurrency ?? 5));
  const bundesland = opts.bundesland || null;

  const where: string[] = ["a.betreiber_mastr LIKE 'ABR%'"];
  const params: any[] = [];
  if (onlyMissing) {
    where.push("(b.email IS NULL OR b.email = '')");
    where.push("(b.telefon IS NULL OR b.telefon = '')");
  }
  if (bundesland) {
    where.push("a.bundesland = ?");
    params.push(bundesland);
  }
  params.push(limit);

  const sql = `
    SELECT DISTINCT a.betreiber_mastr as abr
    FROM anlagen a
    LEFT JOIN betreiber b ON b.mastr_nummer = a.betreiber_mastr
    WHERE ${where.join(" AND ")}
    LIMIT ?
  `;

  const rows = db.prepare(sql).all(...params) as { abr: string }[];

  const stats: EnrichStats = {
    total: rows.length,
    processed: 0,
    ok: 0,
    not_found: 0,
    no_data: 0,
    error: 0,
    with_email: 0,
    with_phone: 0,
  };

  const upsert = db.prepare(`
    INSERT INTO betreiber (mastr_nummer, email, telefon, fax, website, strasse, plz, ort, updated_at)
    VALUES ($mastr_nummer, $email, $telefon, $fax, $website, $strasse, $plz, $ort, CURRENT_TIMESTAMP)
    ON CONFLICT(mastr_nummer) DO UPDATE SET
      email = COALESCE(NULLIF(excluded.email, ''), email),
      telefon = COALESCE(NULLIF(excluded.telefon, ''), telefon),
      fax = COALESCE(NULLIF(excluded.fax, ''), fax),
      website = COALESCE(NULLIF(excluded.website, ''), website),
      strasse = COALESCE(NULLIF(excluded.strasse, ''), strasse),
      plz = COALESCE(NULLIF(excluded.plz, ''), plz),
      ort = COALESCE(NULLIF(excluded.ort, ''), ort),
      updated_at = CURRENT_TIMESTAMP
  `);

  // Worker-Pool: N parallele Worker konsumieren aus einer Index-Queue
  let nextIndex = 0;
  const handleResult = (result: EnrichResult) => {
    stats.processed++;
    if (result.status === "ok") {
      stats.ok++;
      if (result.email) stats.with_email++;
      if (result.telefon) stats.with_phone++;
      try {
        upsert.run({
          $mastr_nummer: result.mastr_nummer,
          $email: result.email,
          $telefon: result.telefon,
          $fax: result.fax,
          $website: result.website,
          $strasse: result.strasse,
          $plz: result.plz,
          $ort: result.ort,
        });
      } catch (e) {
        console.error("UPSERT-Fehler:", e);
      }
    } else if (result.status === "not_found") {
      stats.not_found++;
    } else if (result.status === "no_data") {
      stats.no_data++;
    } else {
      stats.error++;
    }
    opts.onProgress?.(stats, result);
  };

  async function worker(): Promise<void> {
    while (true) {
      const myIdx = nextIndex++;
      if (myIdx >= rows.length) return;
      const result = await enrichMarktakteur(rows[myIdx].abr);
      handleResult(result);
      // Pro-Worker-Throttle (verhindert Burst innerhalb eines Workers)
      if (rateMs > 0) await sleep(rateMs);
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  return stats;
}
