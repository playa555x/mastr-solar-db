import { Database } from "bun:sqlite";
import { file } from "bun";

const db = new Database("mastr-solar.db");
const PASSWORD = "7715";

// Track active IPs with timestamps
const activeIPs = new Map<string, number>();
const MAX_CONCURRENT_IPS = 2;
const SESSION_TIMEOUT = 30 * 60 * 1000; // 30 minutes

// Clean up expired sessions
function cleanupExpiredSessions() {
  const now = Date.now();
  for (const [ip, timestamp] of activeIPs.entries()) {
    if (now - timestamp > SESSION_TIMEOUT) {
      activeIPs.delete(ip);
    }
  }
}

// Check if IP is allowed
function checkIPLimit(ip: string): boolean {
  cleanupExpiredSessions();

  // If IP already has a session, allow it
  if (activeIPs.has(ip)) {
    activeIPs.set(ip, Date.now()); // Update timestamp
    return true;
  }

  // Check if we're at the limit
  if (activeIPs.size >= MAX_CONCURRENT_IPS) {
    return false;
  }

  return true;
}

// Get client IP
function getClientIP(req: Request): string {
  return req.headers.get("x-forwarded-for")?.split(",")[0].trim() ||
         req.headers.get("x-real-ip") ||
         "unknown";
}

// Check password in session cookie
function checkAuth(req: Request): boolean {
  const cookie = req.headers.get("Cookie");
  if (!cookie) return false;
  return cookie.includes("auth=7715");
}

const server = Bun.serve({
  port: process.env.PORT || 8080,
  async fetch(req) {
    const url = new URL(req.url);

    const clientIP = getClientIP(req);

    // Login endpoint
    if (url.pathname === "/api/login" && req.method === "POST") {
      const body = await req.json() as any;

      if (body.password === PASSWORD) {
        // Check IP limit
        if (!checkIPLimit(clientIP)) {
          return new Response(JSON.stringify({
            error: "Maximale Anzahl gleichzeitiger Benutzer erreicht (2). Bitte versuchen Sie es später erneut."
          }), {
            status: 429,
            headers: { "Content-Type": "application/json" }
          });
        }

        // Add IP to active sessions
        activeIPs.set(clientIP, Date.now());

        return new Response(JSON.stringify({ success: true }), {
          headers: {
            "Content-Type": "application/json",
            "Set-Cookie": "auth=7715; Path=/; HttpOnly; Max-Age=1800" // 30 minutes
          }
        });
      }
      return new Response(JSON.stringify({ error: "Falsches Passwort" }), {
        status: 401,
        headers: { "Content-Type": "application/json" }
      });
    }

    // Check auth for all other routes except login page
    if (url.pathname !== "/" && !checkAuth(req)) {
      return new Response(JSON.stringify({ error: "Nicht autorisiert" }), {
        status: 401,
        headers: { "Content-Type": "application/json" }
      });
    }

    // Update activity timestamp for authenticated users
    if (checkAuth(req) && activeIPs.has(clientIP)) {
      activeIPs.set(clientIP, Date.now());
    }

    // Serve static HTML (login page or main app)
    if (url.pathname === "/") {
      const htmlFile = file("static/index.html");
      return new Response(htmlFile, {
        headers: { "Content-Type": "text/html; charset=utf-8" }
      });
    }

    // API: Stats
    if (url.pathname === "/api/stats") {
      // Anlagen-Statistiken
      const anlagenStats = db.prepare(`
        SELECT
          COUNT(*) as total,
          SUM(nettonennleistung) as gesamtleistung
        FROM anlagen
      `).get() as any;

      // Status-Verteilung
      const byStatus = db.prepare(`
        SELECT status, COUNT(*) as count
        FROM anlagen
        GROUP BY status
      `).all() as any[];

      return new Response(JSON.stringify({
        total: anlagenStats.total || 0,
        gesamtleistung: anlagenStats.gesamtleistung || 0,
        byStatus
      }), {
        headers: { "Content-Type": "application/json" }
      });
    }

    // API: Anlagen Liste mit Betreiber-Kontaktdaten
    if (url.pathname === "/api/anlagen" && req.method === "GET") {
      const search = url.searchParams.get("search") || "";
      const bundesland = url.searchParams.get("bundesland") || "";
      const status = url.searchParams.get("status") || "";
      const mit_kontakt = url.searchParams.get("mit_kontakt") || "";
      const leistung_min = url.searchParams.get("leistung_min") || "";
      const leistung_max = url.searchParams.get("leistung_max") || "";
      const datum_von = url.searchParams.get("datum_von") || "";
      const datum_bis = url.searchParams.get("datum_bis") || "";
      const sortBy = url.searchParams.get("sortBy") || "nettonennleistung";
      const sortDir = url.searchParams.get("sortDir") || "desc";
      const page = parseInt(url.searchParams.get("page") || "1");
      const limit = parseInt(url.searchParams.get("limit") || "50");
      const offset = (page - 1) * limit;

      let whereConditions = [];
      let params: any[] = [];

      if (search) {
        whereConditions.push(`(
          a.name LIKE ? OR
          a.betreiber_name LIKE ? OR
          a.ort LIKE ? OR
          a.plz LIKE ? OR
          b.email LIKE ? OR
          b.telefon LIKE ?
        )`);
        const searchPattern = `%${search}%`;
        params.push(searchPattern, searchPattern, searchPattern, searchPattern, searchPattern, searchPattern);
      }

      if (bundesland) {
        whereConditions.push("a.bundesland = ?");
        params.push(bundesland);
      }

      if (status) {
        whereConditions.push("a.status = ?");
        params.push(status);
      }

      if (mit_kontakt === "ja") {
        whereConditions.push("(b.email IS NOT NULL OR b.telefon IS NOT NULL)");
      } else if (mit_kontakt === "nein") {
        whereConditions.push("(b.email IS NULL AND b.telefon IS NULL)");
      }

      if (leistung_min) {
        whereConditions.push("a.nettonennleistung >= ?");
        params.push(parseFloat(leistung_min));
      }

      if (leistung_max) {
        whereConditions.push("a.nettonennleistung <= ?");
        params.push(parseFloat(leistung_max));
      }

      if (datum_von) {
        whereConditions.push("a.inbetriebnahme >= ?");
        params.push(datum_von);
      }

      if (datum_bis) {
        whereConditions.push("a.inbetriebnahme <= ?");
        params.push(datum_bis);
      }

      const whereClause = whereConditions.length > 0 ? `WHERE ${whereConditions.join(" AND ")}` : "";

      // Count query
      const countQuery = `
        SELECT COUNT(*) as total
        FROM anlagen a
        LEFT JOIN betreiber b ON a.betreiber_mastr = b.mastr_nummer
        ${whereClause}
      `;
      const countResult = db.prepare(countQuery).get(...params) as any;
      const total = countResult.total;

      // Data query
      const dataQuery = `
        SELECT
          a.*,
          b.email as kontakt_email,
          b.telefon as kontakt_telefon,
          b.website as kontakt_website,
          b.strasse as kontakt_strasse,
          b.plz as kontakt_plz,
          b.ort as kontakt_ort
        FROM anlagen a
        LEFT JOIN betreiber b ON a.betreiber_mastr = b.mastr_nummer
        ${whereClause}
        ORDER BY a.${sortBy} ${sortDir.toUpperCase()}
        LIMIT ? OFFSET ?
      `;
      params.push(limit, offset);
      const data = db.prepare(dataQuery).all(...params) as any[];

      return new Response(JSON.stringify({
        data,
        pagination: {
          page,
          limit,
          total,
          pages: Math.ceil(total / limit)
        }
      }), {
        headers: { "Content-Type": "application/json" }
      });
    }

    // API: Einzelne Anlage mit Details
    if (url.pathname.startsWith("/api/anlagen/") && req.method === "GET") {
      const id = url.pathname.split("/")[3];

      const anlage = db.prepare(`
        SELECT
          a.*,
          b.email as kontakt_email,
          b.telefon as kontakt_telefon,
          b.website as kontakt_website,
          b.strasse as kontakt_strasse,
          b.plz as kontakt_plz,
          b.ort as kontakt_ort
        FROM anlagen a
        LEFT JOIN betreiber b ON a.betreiber_mastr = b.mastr_nummer
        WHERE a.id = ?
      `).get(id) as any;

      if (!anlage) {
        return new Response(JSON.stringify({ error: "Not found" }), {
          status: 404,
          headers: { "Content-Type": "application/json" }
        });
      }

      // Lade Notizen
      const notizen = db.prepare(`
        SELECT * FROM notizen WHERE anlage_id = ? ORDER BY created_at DESC
      `).all(id) as any[];

      return new Response(JSON.stringify({
        ...anlage,
        notizen_liste: notizen
      }), {
        headers: { "Content-Type": "application/json" }
      });
    }

    // API: Anlage aktualisieren (Status, Notizen)
    if (url.pathname.startsWith("/api/anlagen/") && req.method === "PUT") {
      const id = url.pathname.split("/")[3];
      const body = await req.json() as any;

      if (body.status) {
        db.prepare(`
          UPDATE anlagen SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
        `).run(body.status, id);
      }

      if (body.notizen !== undefined) {
        db.prepare(`
          UPDATE anlagen SET notizen = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
        `).run(body.notizen, id);
      }

      return new Response(JSON.stringify({ success: true }), {
        headers: { "Content-Type": "application/json" }
      });
    }

    // API: Notiz hinzufügen
    if (url.pathname.match(/\/api\/anlagen\/\d+\/notizen/) && req.method === "POST") {
      const id = url.pathname.split("/")[3];
      const body = await req.json() as any;

      db.prepare(`
        INSERT INTO notizen (anlage_id, text, created_at) VALUES (?, ?, CURRENT_TIMESTAMP)
      `).run(id, body.text);

      return new Response(JSON.stringify({ success: true }), {
        headers: { "Content-Type": "application/json" }
      });
    }

    // API: Notiz löschen
    if (url.pathname.startsWith("/api/notizen/") && req.method === "DELETE") {
      const notizId = url.pathname.split("/")[3];

      db.prepare(`DELETE FROM notizen WHERE id = ?`).run(notizId);

      return new Response(JSON.stringify({ success: true }), {
        headers: { "Content-Type": "application/json" }
      });
    }

    // API: CSV Export
    if (url.pathname === "/api/export/csv") {
      const anlagen = db.prepare(`
        SELECT
          a.name,
          a.betreiber_name,
          a.betreiber_mastr,
          a.mastr_nummer,
          a.strasse,
          a.plz,
          a.ort,
          a.bundesland,
          a.nettonennleistung,
          a.bruttoleistung,
          a.inbetriebnahme,
          a.energietraeger,
          a.status,
          b.email,
          b.telefon,
          b.website
        FROM anlagen a
        LEFT JOIN betreiber b ON a.betreiber_mastr = b.mastr_nummer
        ORDER BY a.nettonennleistung DESC
      `).all() as any[];

      let csv = "Name;Betreiber;Betreiber ABR;MaStR-Nr;Straße;PLZ;Ort;Bundesland;Leistung (kW);Bruttoleistung (kWp);Inbetriebnahme;Energieträger;Status;Email;Telefon;Website\n";

      anlagen.forEach((a) => {
        csv += `${a.name || ""};${a.betreiber_name};${a.betreiber_mastr};${a.mastr_nummer};${a.strasse || ""};${a.plz || ""};${a.ort};${a.bundesland};${a.nettonennleistung};${a.bruttoleistung || ""};${a.inbetriebnahme};${a.energietraeger};${a.status || "neu"};${a.email || ""};${a.telefon || ""};${a.website || ""}\n`;
      });

      return new Response(csv, {
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": "attachment; filename=mastr-solar-anlagen.csv"
        }
      });
    }

    return new Response("Not Found", { status: 404 });
  },
});

console.log(`🚀 Server läuft auf http://localhost:${server.port}`);
console.log(`📊 Öffne http://localhost:${server.port} im Browser`);
