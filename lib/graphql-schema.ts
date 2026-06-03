// GraphQL Schema + Root-Resolver.
// Endpoint: POST /graphql  Body: { query, variables?, operationName? }
// Authentifizierung: gleicher Mechanismus wie REST (Session-Cookie ODER Bearer-Token).
//
// Implementiert ein bewusst kleines Set an Queries/Mutations als praktische Ergänzung
// zu REST — kein Versuch, alle 80 Endpoints zu spiegeln.

import { buildSchema, graphql, type GraphQLSchema } from "graphql";
import type { Database } from "bun:sqlite";

export const SDL = `
"""Eine PV-Anlage."""
type Anlage {
  id: Int!
  mastr_nummer: String!
  name: String
  betreiber_name: String
  ort: String
  plz: String
  bundesland: String
  status: String
  nettonennleistung: Float
  inbetriebnahme: String
  owner_id: Int
  owner: User
  notes_count: Int
}

"""Ein User (Mitarbeiter, Admin, Viewer)."""
type User {
  id: Int!
  username: String!
  display_name: String
  email: String
  is_admin: Boolean
  is_viewer: Boolean
  active: Boolean
  pref_locale: String
}

"""Ein Kunde — Aggregation aller Anlagen eines Betreibers."""
type Kunde {
  mastr_nummer: String!
  name: String
  ort: String
  anlagen_count: Int!
  gesamt_leistung_kw: Float
  letzte_aktivitaet: String
}

"""Activity-Eintrag (eigene Aktion oder ausgehende Mention)."""
type Activity {
  id: String!
  kind: String!
  type: String!
  description: String
  anlage_id: Int
  anlage_label: String
  target_user_name: String
  from_user_name: String
  created_at: String!
}

type Query {
  """Mein eigenes Profil."""
  me: User

  """Anlage by id or MaStR-Nummer."""
  anlage(id: Int, mastr_nummer: String): Anlage

  """Anlagen-Liste mit optionalen Filtern."""
  anlagen(
    limit: Int = 50
    offset: Int = 0
    status: String
    bundesland: String
    owner_id: Int
    search: String
  ): [Anlage!]!

  """Kunden-Liste."""
  kunden(limit: Int = 100, owner_id: Int, search: String): [Kunde!]!

  """Eigener Aktivitäts-Verlauf der letzten N Einträge."""
  my_activity(limit: Int = 50, kind: String = "all"): [Activity!]!

  """User-Liste (nur aktive)."""
  users: [User!]!
}

type Mutation {
  """Anlage-Status setzen."""
  setAnlageStatus(id: Int!, status: String!): Anlage

  """Notiz an Anlage anhängen (scope=anlage)."""
  addNotiz(anlage_id: Int!, text: String!): Boolean
}
`;

export const schema: GraphQLSchema = buildSchema(SDL);

interface Context {
  db: Database;
  userId: number;
  isAdmin: boolean;
  isViewer: boolean;
}

function mapAnlage(row: any): any {
  if (!row) return null;
  return {
    id: row.id,
    mastr_nummer: row.mastr_nummer,
    name: row.name,
    betreiber_name: row.betreiber_name,
    ort: row.ort,
    plz: row.plz,
    bundesland: row.bundesland,
    status: row.status,
    nettonennleistung: row.nettonennleistung,
    inbetriebnahme: row.inbetriebnahme,
    owner_id: row.owner_id,
    notes_count: row.notes_count ?? null,
  };
}

function mapUser(row: any): any {
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    display_name: row.display_name,
    email: row.email,
    is_admin: row.is_admin === 1,
    is_viewer: row.is_viewer === 1,
    active: row.active === 1,
    pref_locale: row.pref_locale,
  };
}

export function rootValue(ctx: Context) {
  return {
    me: () => {
      const u = ctx.db.prepare("SELECT * FROM users WHERE id = ?").get(ctx.userId);
      return mapUser(u);
    },
    anlage: ({ id, mastr_nummer }: any) => {
      const row = mastr_nummer
        ? ctx.db.prepare("SELECT * FROM anlagen WHERE mastr_nummer = ?").get(mastr_nummer)
        : ctx.db.prepare("SELECT * FROM anlagen WHERE id = ?").get(id);
      return mapAnlage(row);
    },
    anlagen: (args: any) => {
      const where: string[] = []; const params: any[] = [];
      if (args.status)     { where.push("status = ?"); params.push(args.status); }
      if (args.bundesland) { where.push("bundesland = ?"); params.push(args.bundesland); }
      if (args.owner_id)   { where.push("owner_id = ?"); params.push(args.owner_id); }
      if (args.search)     { where.push("(LOWER(COALESCE(name,'')) LIKE ? OR LOWER(COALESCE(betreiber_name,'')) LIKE ? OR LOWER(COALESCE(ort,'')) LIKE ?)"); const s = `%${String(args.search).toLowerCase()}%`; params.push(s, s, s); }
      const wc = where.length ? `WHERE ${where.join(" AND ")}` : "";
      const lim = Math.min(200, Math.max(1, args.limit ?? 50));
      const off = Math.max(0, args.offset ?? 0);
      const rows = ctx.db.prepare(`SELECT * FROM anlagen ${wc} ORDER BY nettonennleistung DESC LIMIT ? OFFSET ?`).all(...params, lim, off) as any[];
      return rows.map(mapAnlage);
    },
    kunden: (args: any) => {
      const lim = Math.min(500, Math.max(1, args.limit ?? 100));
      const where: string[] = []; const params: any[] = [];
      if (args.owner_id) { where.push("EXISTS (SELECT 1 FROM anlagen ao WHERE ao.betreiber_mastr = a.betreiber_mastr AND ao.owner_id = ?)"); params.push(args.owner_id); }
      if (args.search)   { where.push("LOWER(COALESCE(MAX(a.betreiber_name), '')) LIKE ?"); /* COALESCE in GROUP BY tricky — placeholder */ params.push(`%${String(args.search).toLowerCase()}%`); }
      const baseWhere = "WHERE a.betreiber_mastr IS NOT NULL AND a.betreiber_mastr != ''" + (where.length ? " AND " + where.filter((w) => !w.startsWith("LOWER(COALESCE(MAX")).join(" AND ") : "");
      // search wird via HAVING gefiltert
      const havingClause = args.search ? "HAVING LOWER(COALESCE(name, '')) LIKE ?" : "";
      const sqlParams: any[] = where.length && !args.search ? [params[0]] : (args.search && args.owner_id ? [params[0], params[1]] : args.search ? [params[0]] : []);
      const rows = ctx.db.prepare(`
        SELECT a.betreiber_mastr as mastr_nummer,
          COALESCE(MAX(a.betreiber_name), '') as name,
          MAX(a.ort) as ort,
          COUNT(*) as anlagen_count,
          ROUND(SUM(COALESCE(a.nettonennleistung, 0)), 2) as gesamt_leistung_kw,
          MAX(a.updated_at) as letzte_aktivitaet
        FROM anlagen a
        ${baseWhere}
        GROUP BY a.betreiber_mastr
        ${havingClause}
        ORDER BY anlagen_count DESC LIMIT ?
      `).all(...sqlParams, lim) as any[];
      return rows;
    },
    my_activity: (args: any) => {
      const lim = Math.min(200, Math.max(1, args.limit ?? 50));
      const kind = (args.kind || "all").toLowerCase();
      const rows: any[] = [];
      if (kind === "all" || kind === "activity") {
        const r = ctx.db.prepare(`
          SELECT a.id, a.type, a.description, a.created_at, a.anlage_id, an.mastr_nummer, an.adresse, an.eigentuemer_name
          FROM activities a LEFT JOIN anlagen an ON an.id = a.anlage_id
          WHERE a.user_id = ?
          ORDER BY a.created_at DESC LIMIT ?
        `).all(ctx.userId, lim) as any[];
        for (const x of r) rows.push({
          id: "a" + x.id, kind: "activity", type: x.type, description: x.description || "",
          anlage_id: x.anlage_id,
          anlage_label: x.mastr_nummer ? `${x.eigentuemer_name || ""} (${x.mastr_nummer})`.trim() : null,
          target_user_name: null, from_user_name: null, created_at: x.created_at,
        });
      }
      if (kind === "all" || kind === "mention") {
        const r = ctx.db.prepare(`
          SELECT n.id, n.type, n.body, n.title, n.created_at, n.anlage_id, u.username as tu, u.display_name as tud, an.mastr_nummer, an.eigentuemer_name
          FROM notifications n
          LEFT JOIN users u ON u.id = n.user_id
          LEFT JOIN anlagen an ON an.id = n.anlage_id
          WHERE n.from_user_id = ? AND n.type IN ('mention','comment')
          ORDER BY n.created_at DESC LIMIT ?
        `).all(ctx.userId, lim) as any[];
        for (const x of r) rows.push({
          id: "m" + x.id, kind: "mention", type: x.type,
          description: x.body || x.title || "",
          anlage_id: x.anlage_id,
          anlage_label: x.mastr_nummer ? `${x.eigentuemer_name || ""} (${x.mastr_nummer})`.trim() : null,
          target_user_name: x.tud || x.tu || null,
          from_user_name: null,
          created_at: x.created_at,
        });
      }
      rows.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
      return rows.slice(0, lim);
    },
    users: () => {
      const r = ctx.db.prepare("SELECT * FROM users WHERE active = 1 ORDER BY username").all() as any[];
      return r.map(mapUser);
    },
    setAnlageStatus: ({ id, status }: any) => {
      if (ctx.isViewer) throw new Error("Viewer dürfen nicht schreiben");
      const a = ctx.db.prepare("SELECT id, status FROM anlagen WHERE id = ?").get(id) as any;
      if (!a) throw new Error("Anlage nicht gefunden");
      ctx.db.prepare("UPDATE anlagen SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(status, id);
      const updated = ctx.db.prepare("SELECT * FROM anlagen WHERE id = ?").get(id);
      return mapAnlage(updated);
    },
    addNotiz: ({ anlage_id, text }: any) => {
      if (ctx.isViewer) throw new Error("Viewer dürfen nicht schreiben");
      const a = ctx.db.prepare("SELECT id, betreiber_mastr FROM anlagen WHERE id = ?").get(anlage_id) as any;
      if (!a) throw new Error("Anlage nicht gefunden");
      ctx.db.prepare(`
        INSERT INTO notizen (anlage_id, betreiber_mastr, scope, text, user_id, created_at)
        VALUES (?, ?, 'anlage', ?, ?, CURRENT_TIMESTAMP)
      `).run(a.id, a.betreiber_mastr, text, ctx.userId);
      return true;
    },
  };
}

export async function runGraphQL(query: string, variables: any, ctx: Context): Promise<any> {
  return graphql({
    schema,
    source: query,
    rootValue: rootValue(ctx),
    variableValues: variables || undefined,
  });
}
