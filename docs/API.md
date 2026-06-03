# mastr-solar API — Integrationsleitfaden

> Stand: 2026-05-17
> Base-URL Produktion: `https://mastr-solar.51.195.86.119.nip.io`
> Content-Type: `application/json; charset=utf-8` (auf allen Endpoints ausser CSV-Export, ICS-Accept/Decline, Multipart-Uploads)

Diese Doku richtet sich an Entwickler, die ein Fremdsystem (CRM, ERP, Zapier/n8n, eigenes Skript, BI-Tool, Marketing-Plattform) an mastr-solar anbinden wollen. Sie beschreibt Authentifizierung, Konventionen, alle relevanten Endpoints und typische Workflows mit lauffähigen Beispielen.

---

## 1. Schnellstart

> **Wichtig:** Externe Entwickler können sich **nicht selbst registrieren**. Tokens werden ausschließlich vom mastr-solar-**Administrator** erstellt und kontrolliert ausgegeben. Du bekommst deinen Token also per sicherem Kanal (verschlüsselte Email, Password-Manager-Link, persönliche Übergabe) — nicht über diese Doku.

```bash
# 1. Token vom Administrator erhalten haben? Dann direkt los:

curl -H "Authorization: Bearer msolar_xxxxxxxxxxxxxxxxxxxxxxxx" \
  "https://mastr-solar.51.195.86.119.nip.io/api/anlagen?limit=5&owner=me"
```

### Wie der Admin einen Token ausgibt

Im UI: **Settings → API-Zugang → „+ Neuen API-Schlüssel erstellen"**
1. Beschreibender Name (z.B. „Acme GmbH — n8n-Bridge")
2. Scope wählen (`read` / `write` / `full`)
3. Optional Ablaufdatum
4. Klartext-Token wird **einmalig** angezeigt und sicher an den Entwickler übergeben

### Admin-Kontrolle und Transparenz

Jeder API-Token erscheint in *Settings → API-Zugang* mit:

| Feld           | Bedeutung                                                                  |
|----------------|----------------------------------------------------------------------------|
| Name           | beschreibend, vom Admin vergeben — z.B. Kunde + System                     |
| Scope          | `read` / `write` / `full`                                                  |
| Prefix         | erste 14 Zeichen (zur Identifikation, Rest geheim)                          |
| Erstellt       | Datum + erstellender Admin                                                 |
| Zuletzt benutzt | Datum des letzten erfolgreichen Request                                   |
| **Letzte IP**  | IP des letzten Request — wichtig für Anomalie-Erkennung                    |
| Requests       | Gesamtzahl Aufrufe seit Erstellung                                         |
| Status         | `aktiv` oder `widerrufen` (inkl. wann + von wem widerrufen wurde)          |

**Widerruf:** Klick auf „widerrufen" im UI oder `DELETE /api/admin/api-tokens/:id`. Wirkung sofort — der nächste Request mit diesem Token liefert HTTP 401.

Erfolgreiche Antwort:

```json
{
  "data": [
    { "id": 1234, "mastr_nummer": "SEE918732...", "name": "Solarpark Nord", "nettonennleistung": 750.5, "status": "kontaktiert", "owner_id": 3, ... },
    ...
  ],
  "pagination": { "page": 1, "limit": 5, "total": 42, "pages": 9 }
}
```

---

## 2. Authentifizierung

mastr-solar akzeptiert zwei Auth-Verfahren. Externe Systeme nutzen **Verfahren A (API-Token)**.

### A. Bearer-Token (für Fremdsysteme)

Header: `Authorization: Bearer msolar_<token>`

- Token werden im UI von einem **Administrator** unter *Settings → API-Zugang* erstellt
- Format: `msolar_<43 Zeichen Base64URL>` (50 Zeichen total)
- Klartext wird **nur einmal** beim Erstellen angezeigt — danach nur noch SHA-256-Hash in der DB
- Token können widerrufen werden (sofortige Wirkung)
- Pro Token werden `request_count` und `last_used_at` protokolliert
- Tokens können ein Ablaufdatum bekommen (`expires_at`)

### B. Session-Cookie (für Browser-User)

Header: `Cookie: session=<token>`
Wird nach `POST /api/auth/login` automatisch gesetzt (`HttpOnly`, `Secure`, `SameSite=Lax`). Für Fremdsysteme nicht empfohlen.

### Fehlt der Token?

```http
HTTP/1.1 401 Unauthorized
Content-Type: application/json

{"error":"Nicht autorisiert","code":"UNAUTHORIZED","message":"Nicht autorisiert"}
```

### Token-Scope nicht ausreichend?

```http
HTTP/1.1 403 Forbidden

{"error":"Scope 'read' erlaubt diese HTTP-Methode nicht (POST)","code":"FORBIDDEN","message":"..."}
```

### Rate-Limit überschritten?

```http
HTTP/1.1 429 Too Many Requests
Retry-After: 1

{"error":"Rate limit: max 10 requests/second per token","code":"RATE_LIMITED","retry_after":1}
```

**Limits pro Token:** **10 Requests/Sekunde** und **600 Requests/Minute**. Beim Erreichen liefert der Server 429 mit `Retry-After`-Header.

---

## 3. Sichtbarkeits-Regel für API-Token (wichtig!)

> **API-Token-Clients sehen NUR Anlagen, die einem Mitarbeiter zugewiesen sind (`owner_id IS NOT NULL`).**

Damit Fremdsysteme nicht die komplette Marktstammdaten-Tabelle abziehen, sind die Lese-Endpoints für Token-Auth eingeschränkt:

| Endpoint                            | Sichtbarkeit für Token-Clients                                  |
|-------------------------------------|------------------------------------------------------------------|
| `GET /api/anlagen`                  | nur Anlagen mit `owner_id IS NOT NULL`                          |
| `GET /api/anlagen/:id`              | 404, wenn die Anlage keinen Eigentümer hat                      |
| `GET /api/anlagen/:id/related`      | nur bearbeitete Schwester-Anlagen                                |
| `GET /api/anlagen/:id/neighbors`    | nur bearbeitete Nachbar-Anlagen                                  |
| `GET /api/kunden`                   | nur Betreiber mit ≥ 1 bearbeiteten Anlage                       |
| `GET /api/kunden/:mastr`            | `anlagen[]` enthält nur bearbeitete; 404 falls keine             |
| `GET /api/map/markers`              | nur bearbeitete Anlagen                                          |

**Wie wird eine Anlage „bearbeitet"?** Sobald ein User in mastr-solar eine der folgenden Aktionen ausführt, wird er automatisch zum Eigentümer (`autoAssignOwner` / `autoAssignOwnerForBetreiber`):

- Notiz hinzufügen (Anlage oder Kunde)
- Status ändern (z.B. Kanban-Bewegung von "neu" zu "kontaktiert")
- Reminder/Wiedervorlage anlegen
- Anruf protokollieren
- Kommentar/E-Mail an die Anlage hängen

**Reines Betrachten ändert nichts.** Auch ein Browser-User, der eine Anlage nur anklickt aber nichts einträgt, wird NICHT zum Eigentümer. Damit kann die Eigentümer-Markierung als zuverlässiger „wurde aktiv bearbeitet"-Indikator dienen.

**Schreibend** ist der API-Client nicht eingeschränkt — wer eine `id` kennt, kann via `POST /api/anlagen/:id/notizen` oder `PUT /api/anlagen/:id { "status": "..." }` einen Datensatz claimen und ihn damit für sich (und für weitere Lese-Zugriffe) sichtbar machen. Das ist gewollt.

---

## 4. Scopes

| Scope    | Erlaubte HTTP-Methoden                       | Was geht                                                                          |
|----------|----------------------------------------------|------------------------------------------------------------------------------------|
| `read`   | `GET`, `HEAD`, `OPTIONS`                     | Lesen aller Daten ausser Admin-Bereich                                            |
| `write`  | `read` + `POST`, `PUT`, `PATCH`, `DELETE`    | Anlagen/Kunden/Reminders/Notizen/Termine ändern, **kein** Admin/User-Mgmt/Import  |
| `full`   | alles                                         | wie Admin: Token-Verwaltung, User-CRUD, MaStR-Import-Steuerung, Audit-Log         |

Admin-only-Präfixe (für `read`/`write` immer 403):

- `/api/admin/*`
- `/api/users` (List/Create/Update/Delete)
- `/api/import/*`
- `/api/audit-log`

---

## 5. Konventionen

| Thema           | Regel                                                                                                  |
|-----------------|--------------------------------------------------------------------------------------------------------|
| Encoding        | UTF-8, Request- und Response-Body                                                                       |
| Datum/Zeit      | ISO-8601 mit Zeitzone (`2026-05-17T08:30:00Z`). Reine Tage als `YYYY-MM-DD`.                            |
| Zeitzone        | Server speichert UTC. UI zeigt Europe/Berlin.                                                          |
| Float           | Punkt als Dezimal, keine Tausender-Trenner (`750.5` für 750,5 kWp)                                     |
| Boolean         | DB-Felder typ. `0`/`1`. JSON akzeptiert `true`/`false` und `0`/`1`.                                    |
| IDs             | Numerisch, monoton steigend (`anlage.id`, `user.id`, `reminder.id`).                                   |
| MaStR-Nummer    | String, alphanumerisch (`SEE918732FX91...`). Stabiler externer Schlüssel für Anlagen & Betreiber.       |
| Pagination      | `?page=1&limit=50` (offset-Modus) oder `?after=<id>&limit=50` (cursor-Modus, stabil bei wachsenden Listen). Max `limit=200`. |
| Sortierung      | `?sortBy=<field>&sortDir=asc|desc`. Erlaubte Felder pro Endpoint dokumentiert.                          |
| Leere Strings   | Werden im PUT meist als `null` interpretiert. Explizit `null` setzen wenn Feld geleert werden soll.     |
| Optimistic Lock | Nicht unterstützt. „Last-write wins" — bei kritischen Concurrent-Writes Owner-Schutz nutzen.            |

### Fehlerformat

Alle Fehler liefern JSON mit den Feldern `error`, `code` und `message`. Machine-lesbar via `code`.

```json
{
  "error": "betreiber_mastr fehlt",
  "code": "BAD_REQUEST",
  "message": "betreiber_mastr fehlt"
}
```

**HTTP-Statuscodes + Codes:**

| Status | Code              | Bedeutung                                                |
|--------|-------------------|----------------------------------------------------------|
| 400    | `BAD_REQUEST`     | Fehlende/ungültige Parameter                             |
| 401    | `UNAUTHORIZED`    | Nicht authentifiziert (Token fehlt/ungültig)             |
| 403    | `FORBIDDEN`       | Authentifiziert, aber keine Berechtigung                  |
| 403    | `ADMIN_NOT_API`   | API-Token versucht Admin-Endpoint zu erreichen           |
| 403    | `ADMIN_REQUIRED`  | Nur Admin (Cookie-Auth) zugelassen                       |
| 404    | `NOT_FOUND`       | Ressource nicht gefunden                                 |
| 409    | `IDEMPOTENCY_KEY_REUSE` | Gleicher Idempotency-Key mit anderem Body            |
| 422    | `VALIDATION_FAILED` | Schema-Validation gescheitert                          |
| 429    | `RATE_LIMITED`    | Rate-Limit überschritten (Login ODER Token)               |
| 500    | `INTERNAL_ERROR`  | Server-Fehler                                            |
| 503    | `SERVICE_UNAVAILABLE` | Service temporär nicht verfügbar                     |

---

### Globale Request-Header (optional)

| Header                  | Wirkt auf      | Zweck                                                                  |
|-------------------------|----------------|------------------------------------------------------------------------|
| `Authorization: Bearer` | alle           | API-Token-Auth (siehe Sektion 2)                                       |
| `Idempotency-Key`       | POST/PUT/PATCH | Duplikate vermeiden bei Retries (24h Cache pro Token+Key+Body-Hash)    |
| `Content-Type`          | Body-Requests  | Stets `application/json` (Ausnahme: Attachments via Multipart)         |

### Globale Query-Parameter (optional)

| Parameter   | Wirkt auf                  | Wirkung                                                              |
|-------------|----------------------------|----------------------------------------------------------------------|
| `?lang=en`  | alle Liste-Endpoints       | Liefert **zusätzliche** englische Feld-Aliase parallel zu deutschen   |
| `?after=N`  | `GET /api/anlagen`         | Cursor-Pagination: liefere IDs > N, sortiert nach `id ASC`            |

### Pagination-Modi

**Offset-Modus** (Default):
```json
{
  "data": [...],
  "pagination": { "mode": "offset", "page": 2, "limit": 50, "total": 1234, "pages": 25 }
}
```

**Cursor-Modus** (`?after=`):
```json
{
  "data": [...],
  "pagination": { "mode": "cursor", "limit": 50, "returned": 50, "next_cursor": 1234, "has_more": true }
}
```

**Wann was?** Page-Limit ist gut für UI-Listen ("Seite 5 von 25"). Cursor ist stabil für Bulk-Iteration ("alle Anlagen einmal durchlaufen") — keine Duplikate oder Lücken bei parallelen Inserts.

### Idempotency-Keys

POST/PUT/PATCH mit dem Header `Idempotency-Key: <uuid>` werden 24 h gecacht. Identischer Key + identischer Body liefert die gecachte Antwort (mit Header `X-Idempotent-Replay: true`), identischer Key + anderer Body wird mit `409 IDEMPOTENCY_KEY_REUSE` abgelehnt.

```bash
KEY=$(uuidgen)
curl -X POST -H "Authorization: Bearer ..." \
  -H "Idempotency-Key: $KEY" \
  -H "Content-Type: application/json" \
  -d '{"betreiber_mastr":"ABR...","due_at":"2026-05-25T09:00:00Z"}' \
  https://mastr-solar.51.195.86.119.nip.io/api/reminders
# Bei Netzwerkfehler einfach denselben Request mit gleichem Key wiederholen.
```

### Versionierung

Alle Endpoints sind erreichbar unter `/api/<pfad>` (aktuell) und `/api/v1/<pfad>` (Alias).
Vor breaking Changes wird `/api/v2/` parallel angeboten — bestehende Integrationen behalten min. 6 Monate `/api/v1/`.

---

## 6. Endpoint-Referenz

### 5.1 Auth & Profil

#### `POST /api/auth/login`
Browser-Login. Externe Systeme brauchen das **nicht** — sie nutzen API-Tokens. Liefert HttpOnly-Cookie.

Body: `{ "username": "...", "password": "...", "totp_code": "123456"? }`
Response: `{ "success": true }` + Cookie

Rate-Limit: 5 Versuche / Minute / IP.

#### `POST /api/auth/logout` · `GET /api/auth/me`
Logout invalidiert die Session. `/api/auth/me` liefert den aktuellen User.

#### `GET /api/me/profile`
Liefert die persönlichen Daten + Voreinstellungen des aufrufenden Users.

```json
{
  "id": 3, "username": "schmidt", "email": "schmidt@firma.de",
  "display_name": "Lars Schmidt", "color": "#06b6d4",
  "phone": "+49 …", "bio": "Vertrieb DACH",
  "is_admin": 0, "onboarding_done": 1, "totp_enabled": 1,
  "pref_default_tab": "dashboard",
  "pref_default_filter": null,
  "pref_reminder_snooze_min": 60,
  "pref_anlagen_sort": "lead_score_desc",
  "pref_map_marker_mode": "status",
  "pref_quiet_hours_start": "22:00",
  "pref_quiet_hours_end": "07:00",
  "pref_locale": "de-DE",
  "created_at": "2026-05-05 10:12:01"
}
```

#### `PUT /api/me/profile`
Whitelist: `display_name`, `email`, `color`, `phone`, `bio`, `pref_default_tab`, `pref_reminder_snooze_min`, `pref_anlagen_sort`, `pref_map_marker_mode`, `pref_quiet_hours_start`, `pref_quiet_hours_end`, `pref_locale`, `pref_default_filter`.
Validierung: Enums, HH:MM-Format für Quiet-Hours, Email-Regex, Snooze 5-10080 min.
Response: `{ "success": true }`.

#### `POST /api/me/password`
```json
{ "current_password": "alt", "new_password": "neu_mindestens_6" }
```
Bei Erfolg werden **alle anderen Sessions** des Users invalidiert (die aktuelle Cookie-Session bleibt).

---

### 5.2 Anlagen (PV-Anlagen)

Kern-Entität. Eine Anlage gehört genau einem Betreiber (`betreiber_mastr`). Sie kann einem User (`owner_id`) zugewiesen sein.

#### `GET /api/anlagen`
Listet Anlagen mit Filter + Pagination.

| Query              | Typ     | Beispiel              | Bedeutung                                                              |
|--------------------|---------|-----------------------|------------------------------------------------------------------------|
| `search`           | string  | `Schmidt`             | Volltext auf name, betreiber_name, ort, plz, email, telefon            |
| `bundesland`       | string  | `Bayern`              | Exakte Übereinstimmung                                                  |
| `status`           | string  | `neu`                 | `neu` / `kontaktiert` / `bearbeitet` / `interessiert` / `nicht_interessiert` / `abgeschlossen` |
| `mit_kontakt`      | string  | `ja` / `nein`         | filtert nach vorhandenem Kontakt (email oder telefon)                  |
| `leistung_min`     | number  | `100`                 | kWp Untergrenze                                                         |
| `leistung_max`     | number  | `5000`                | kWp Obergrenze                                                          |
| `datum_von`        | date    | `2010-01-01`          | Inbetriebnahme ab                                                       |
| `datum_bis`        | date    | `2020-12-31`          | Inbetriebnahme bis                                                      |
| `owner`            | string  | `me` / `42` / `unassigned` | Eigentümer (`me` = der aufrufende User)                              |
| `sortBy`           | enum    | `lead_score`          | `nettonennleistung` / `inbetriebnahme` / `name` / `ort` / `bundesland` / `lead_score` |
| `sortDir`          | string  | `desc`                | `asc` / `desc`                                                          |
| `page`             | int     | `1`                   | ab 1 (offset-Modus)                                                     |
| `limit`            | int     | `50`                  | 1–200, Default 50                                                       |
| `after`            | int     | `1234`                | Cursor-Modus: nur IDs > N, sortiert ASC. `next_cursor` in der Response. |
| `lang`             | string  | `en`                  | Englische Feld-Aliase parallel zu deutschen (additive)                  |

Response (gekürzt):

```json
{
  "data": [
    {
      "id": 1234,
      "mastr_nummer": "SEE918732FX9...",
      "name": "Solarpark Mustermann",
      "betreiber_name": "Mustermann GmbH",
      "betreiber_mastr": "ABR987654...",
      "strasse": "Hauptstr.", "hausnummer": "12",
      "plz": "82166", "ort": "Gräfelfing",
      "bundesland": "Bayern", "landkreis": "München", "gemeinde": "...",
      "breitengrad": 48.124, "laengengrad": 11.450,
      "bruttoleistung": 800.0, "nettonennleistung": 750.5,
      "anzahl_module": 1600,
      "inbetriebnahme": "2014-08-15",
      "energietraeger": "SolareStrahlungsenergie",
      "anlagentyp": "Freiflaeche",
      "hauptausrichtung": "Süd", "hauptausrichtung_neigungswinkel": "20° - 40°",
      "modulhersteller": null, "wechselrichterhersteller": null,
      "status": "neu", "lead_score": 78,
      "owner_id": 3, "owner_username": "schmidt", "owner_display_name": "Lars Schmidt", "owner_color": "#06b6d4",
      "kontakt_email": "info@mustermann.de", "kontakt_telefon": "+49 89 …", "kontakt_website": "...",
      "kontakt_strasse": "Hauptstr. 12", "kontakt_plz": "82166", "kontakt_ort": "Gräfelfing",
      "created_at": "...", "updated_at": "..."
    }
  ],
  "pagination": { "page": 1, "limit": 50, "total": 81832, "pages": 1637 }
}
```

#### `GET /api/anlagen/:id`
Liefert eine Anlage **plus** aggregierte Sub-Ressourcen, die im Anlage-Detail-Panel gebraucht werden:

```json
{
  "id": 1234, ... (alle Felder wie oben),
  "notizen_liste": [ { "id": 12, "text": "...", "scope": "anlage|betreiber", "user_id": 3, "created_at": "..." } ],
  "sent_emails":   [ { "id": 5, "subject": "...", "to_addr": "...", "sent_at": "..." } ],
  "termine":       [ { "id": 7, "title": "Vor-Ort-Termin", "start_ts": 1716000000000, ... } ],
  "activities":    [ { "type": "status_change", "description": "Status: neu → kontaktiert", "user_id": 3, "created_at": "..." } ],
  "messages":      [ /* Direkt-Kommentare */ ],
  "calls":         [ { "id": 4, "direction": "out", "started_at": "...", "duration_sec": 312 } ],
  "related_anlagen": [ /* andere Anlagen desselben Betreibers */ ],
  "reminders":     [ /* Wiedervorlagen */ ],
  "economics":     {
    "specific_yield_kwh_per_kwp": 980,
    "annual_kwh": 735490,
    "eeg_rate_ct_per_kwh": 11.5,
    "annual_revenue_eur": 84580,
    "repowering": { "new_module_wp": 720, "new_count": 1900, "new_kwp": 1368, "delta_kwh": 624800, "additional_revenue_eur": 71850 },
    "storage":    { "kwh": 750, "invest_eur": 487500, "recovered_kwh_per_year": 25025, "recovered_revenue_per_year_eur": 2878 }
  }
}
```

Query-Optionen:

- `?module_wp=720` — überschreibt für diese Antwort den globalen `repowering_module_wp` und liefert die Repowering-Kalkulation für diese Modulgröße.

#### `PUT /api/anlagen/:id`
Anlage aktualisieren. Whitelist:

`name`, `betreiber_name`, `strasse`, `hausnummer`, `plz`, `ort`, `bundesland`, `landkreis`, `gemeinde`, `breitengrad`, `laengengrad`, `bruttoleistung`, `nettonennleistung`, `anzahl_module`, `inbetriebnahme`, `energietraeger`, `anlagentyp`, `lage_einheit`, `hauptausrichtung`, `hauptausrichtung_neigungswinkel`, `modulhersteller`, `wechselrichterhersteller`, `wechselrichter_anzahl`

Zusätzlich akzeptiert:

- `status` — löst Activity-Log + `autoAssignOwner` aus
- `notizen` — Freitext-Notizfeld an der Anlage (deprecated; lieber `notizen_liste`)
- `owner_id` — nur durch aktuellen Owner oder Admin änderbar; bei `NULL`-Owner beliebig setzbar (Claim)

#### `POST /api/anlagen/:id/notizen`
Notiz an einer Anlage anlegen.
```json
{ "text": "Telefonat am 17.5. — Interesse vorhanden, Termin nächste Woche.", "scope": "anlage" | "betreiber" }
```
`scope=betreiber` schreibt eine Kunden-übergreifende Notiz, die bei allen Anlagen des Betreibers erscheint.
Auto: `autoAssignOwner` (falls Anlage ownerlos), `@mention`-Notifications.

#### `DELETE /api/notizen/:id`
Löscht eine Notiz.

#### `GET /api/anlagen/:id/related`
Andere Anlagen desselben Betreibers.

#### `GET /api/anlagen/:id/neighbors?radius=2`
Anlagen im Umkreis von `radius` km (Haversine). Default 1.

#### `POST /api/anlagen/:id/refine-location`
Sucht über OSM Overpass nach realen solar-getaggten Polygonen in der Nähe der Koordinaten und setzt `breitengrad`/`laengengrad` auf den Schwerpunkt der besten Übereinstimmung. Stellt zusätzlich `position_refined_at`, `position_refined_distance_m`, `position_osm_ref` ein.

#### `POST /api/anlagen/:id/email`
Versand einer E-Mail aus dem persönlichen SMTP-Konto des Aufrufers mit Mail-Tracking (Open-Pixel).
```json
{
  "to": "kunde@firma.de",
  "subject": "Repowering-Potenzial Ihrer Anlage",
  "body_html": "<p>Hallo …</p>",
  "template_id": 4?,           // optional: Template laden
  "attachment_ids": [12, 17]?, // optional
  "termin": { "start": "2026-06-01T10:00:00Z", "end": "2026-06-01T11:00:00Z", "title": "Vor-Ort" }? // optional ICS
}
```
Response enthält die `sent_email_id` zum späteren Status-Lookup.

#### `GET /api/anlagen/:id/quote`
PDF-Angebot (preliminary quote) als Download.

#### `GET /api/anlagen/:id/gdpr-export`
JSON-Export aller personenbezogenen Daten zur Anlage (Article 15 GDPR).

#### `POST /api/anlagen/:id/rescore`
Rechnet den Lead-Score einer Anlage neu.

#### `POST /api/anlagen/:id/geocode`
Geocoding einer einzelnen Anlage via Nominatim.

---

### 5.3 Kunden (Betreiber)

Ein Kunde = ein eindeutiger `betreiber_mastr`. Über die Marktstammdaten-Registriernummer eindeutig auflösbar.

#### `GET /api/kunden?q=<suche>&limit=500`
Aggregierte Kunden-Liste mit Anlagen-Anzahl, Gesamt-Leistung, offenen Reminders.

```json
[
  {
    "mastr_nummer": "ABR987654...",
    "name": "Mustermann GmbH",
    "email": "info@mustermann.de", "telefon": "+49 89 …",
    "betreiber_ort": "Gräfelfing", "betreiber_plz": "82166",
    "anlagen_count": 4,
    "gesamt_leistung_kw": 2840.5,
    "letzte_aktivitaet": "2026-05-15T13:24:00",
    "offene_reminders": 2
  }
]
```

#### `GET /api/kunden/:mastr`
Detail mit `betreiber`, `anlagen[]`, `notizen[]` (Kunden- und Anlagen-Notizen kombiniert), `reminders[]`, `calls[]`.

#### `POST /api/kunden/:mastr/notizen`
Kunden-Notiz schreiben (gilt für alle Anlagen des Betreibers).
```json
{ "text": "Geschäftsführer Hr. Mustermann ist Entscheider. Bevorzugt Anrufe vormittags." }
```
Auto: `autoAssignOwnerForBetreiber` claimt alle Anlagen, die noch keinen Owner haben.

#### `GET /api/betreiber/by-mastr/:mastr`
Roh-Daten des Betreibers (Stammdaten ohne Aggregation).

---

### 5.4 Reminders / Wiedervorlagen

Aufgaben mit Fälligkeitsdatum, immer an einem Kunden (`betreiber_mastr`) verankert. Werden alle 5 Minuten via systemd-Timer geprüft und via Email/Telegram zugestellt.

#### `GET /api/reminders?status=pending&betreiber_mastr=ABR...&limit=200`
- `status`: `pending` (Default) / `done` / `snoozed` / `all`

#### `GET /api/reminders/today`
Heute fällige Reminders.

#### `POST /api/reminders`
```json
{
  "betreiber_mastr": "ABR987654...",
  "due_at": "2026-05-20T09:00:00Z",
  "note": "Nachfassen wegen Angebot",
  "owner_user_id": 3  // optional; default = aufrufender User
}
```
Auto: `autoAssignOwnerForBetreiber`.

#### `PATCH /api/reminders/:id`
Update / Aktionen:
```json
{ "action": "done" }
{ "action": "snooze", "until": "2026-05-21T10:00:00Z" }
{ "due_at": "2026-05-25T08:00:00Z", "note": "neuer Text", "owner_user_id": 5 }
```

#### `DELETE /api/reminders/:id`
Löscht eine Wiedervorlage.

#### `GET /api/reminders/calendar?from=...&to=...`
FullCalendar-Eventformat (Range-Query).

---

### 5.5 Termine (Kalender)

#### `GET /api/termine?from=YYYY-MM-DD&to=YYYY-MM-DD`
Termine im Zeitraum. Liefert FullCalendar-kompatible Events inkl. RSVP-Status.

#### `POST /api/termine`
```json
{
  "anlage_id": 1234,
  "title": "Vor-Ort-Termin Solarpark Mustermann",
  "description": "Vermessung Dachfläche",
  "location": "Hauptstr. 12, 82166 Gräfelfing",
  "start_ts": "2026-06-01T10:00:00Z",
  "end_ts":   "2026-06-01T11:30:00Z",
  "attendee_email": "kunde@mustermann.de",
  "attendee_name":  "Hans Mustermann"
}
```
Versendet automatisch eine ICS-Einladung an `attendee_email`, falls SMTP konfiguriert.

#### `PUT/DELETE /api/termine/:id`
Bei Termin-Update werden ICS-Updates verschickt (Sequence-Counter automatisch).

#### `GET /api/termine/accept?token=...` / `GET /api/termine/decline?token=...`
Public-Endpoints für RSVP aus E-Mail (kein Auth erforderlich, Token ist pro Termin unique).

---

### 5.6 Anrufe (Calls)

Manuelles Logging von Telefonaten + optionaler AI-Zusammenfassung.

#### `GET /api/anlagen/:id/calls`
#### `POST /api/anlagen/:id/calls`
```json
{
  "direction": "out" | "in",
  "started_at": "2026-05-17T08:30:00Z",
  "duration_sec": 312,
  "outcome": "interessiert" | "kein_interesse" | "termin_vereinbart" | "rueckruf" | ...,
  "notes": "Hr. Mustermann zeigt Interesse an Repowering."
}
```

#### `PATCH /api/calls/:id` · `POST /api/calls/:id/summary`
Update bzw. AI-Zusammenfassung erzeugen (nutzt das konfigurierte AI-Provider-Setting des Aufrufers).

---

### 5.7 E-Mail-Workflow

Externe Systeme können die Mail-Engine von mastr-solar mitbenutzen.

| Methode              | Pfad                                | Zweck                                   |
|----------------------|-------------------------------------|------------------------------------------|
| GET/PUT/POST          | `/api/settings/smtp`                | SMTP-Konto + Signatur des Aufrufers      |
| `POST`                | `/api/settings/smtp/test`           | Test-Mail an eigene Adresse              |
| GET/PUT/POST          | `/api/settings/imap`                | IMAP-Inbox-Polling                       |
| `POST`                | `/api/settings/imap/poll-now`       | Sofort pollen                            |
| GET/POST              | `/api/email-templates`              | Template-CRUD                            |
| GET/POST              | `/api/attachments`                  | Multipart-Upload bis 10 MB               |
| `GET`                 | `/api/replies`                      | Eingehende Antworten matched zu Anlagen  |
| `GET`                 | `/api/sent-emails/:id/events`       | Mail-Tracking: opened, clicked, bounce   |

Versand → siehe `POST /api/anlagen/:id/email` (5.2).

---

### 5.8 Direkt-Kommentare & DMs

Team-interne Diskussion zu einer Anlage und Direktnachrichten zwischen Usern.

| Methode | Pfad                                | Zweck                                   |
|---------|-------------------------------------|------------------------------------------|
| GET/POST | `/api/anlagen/:id/comments`        | Kommentar-Thread (mit `@mention`)        |
| `DELETE` | `/api/comments/:id`                | Kommentar löschen                        |
| `GET`    | `/api/dm/threads`                  | Eigene DM-Threads                        |
| `GET/POST` | `/api/dm/:userId`                | Konversation mit einem User              |

---

### 5.9 Benachrichtigungen

#### `GET /api/notifications`
In-App-Liste der eigenen Notifications (mention, dm, assignment, reminder).

#### `POST /api/notifications/:id/read` · `POST /api/notifications/read-all`

#### `GET/PUT /api/settings/notifications`
Pro Typ (`mention`, `dm`, `assignment`, `reminder`) und Kanal (`email`, `telegram`) ein-/ausschaltbar.
Quiet-Hours kommen aus dem User-Profil (`pref_quiet_hours_start/end`).

---

### 5.10 Dashboard & Stats

#### `GET /api/dashboard`
Aggregierte Startseiten-Daten:

```json
{
  "quick_stats": { "total_anlagen": 81832, "my_open": 5, "due_today": 2, "unread_notifications": 0, "open_termine": 3 },
  "reminders_today": [...],
  "termine_today":   [...],
  "recent_notifications": [...],
  "recent_activities":    [...],
  "top_leads":            [...],
  "funnel":               [ { "status": "neu", "count": 81831 }, ... 6 Einträge ... ]
}
```

#### `GET /api/stats` · `GET /api/bundeslaender` · `GET /api/today`
Klassische Sammelstats; `/today` enthält fällige Reminders + heutige Termine.

#### `GET /api/reporting/kpis?from=YYYY-MM-DD&to=YYYY-MM-DD`
KPI-Reporting (Conversion, Pipeline-Wert, etc.).

#### `GET /api/map/markers?bbox=south,west,north,east`
Map-Marker für ein Bounding-Box-Viewport. Verwendet im Karten-Tab.

---

### 5.11 Kampagnen (Sequenced E-Mail)

| Methode | Pfad                                       | Zweck                                   |
|---------|--------------------------------------------|------------------------------------------|
| GET/POST | `/api/campaigns`                          | Liste + Erstellen                        |
| GET/PUT/DELETE | `/api/campaigns/:id`                | Details                                  |
| `POST`   | `/api/campaigns/:id/(start\|pause\|resume)` | Steuerung                               |
| `GET`    | `/api/campaigns/:id/recipients`          | Empfänger-Liste mit Status              |
| `GET`    | `/api/campaigns/:id/ab-stats`            | A/B-Auswertung                          |
| `POST`   | `/api/campaigns/preview`                 | Dry-Run einer Mail                       |

---

### 5.12 App-Settings (read) & Admin-Settings

#### `GET /api/app-settings`
Alle berechnungs-/sichtbarkeitsrelevanten globalen Settings (für jeden User lesbar).

```json
{
  "values": {
    "repowering_module_wp": 720,
    "region_factor": 1.0,
    "storage_ratio_kwh_per_kwp": 1.0,
    "storage_cost_eur_per_kwh": 650,
    "curtailment_pct": 4,
    "recovery_quote_pct": 85,
    "show_economics_card": 1,
    "show_repowering_card": 1,
    "show_storage_card": 0,
    "show_related_anlagen": 1,
    "show_reminders_in_anlage": 1,
    "show_satellite_map": 1
  },
  "meta": [ { "key": "repowering_module_wp", "label": "Modul-Leistung (Repowering)", "unit": "Wp", "min": 400, "max": 900, "step": 10, "help": "…", "category": "calculation", "type": "number" }, ... ]
}
```

#### `GET/PUT /api/admin/app-settings` *(Admin)*
Schreibt Settings (mit Validierung gegen `meta.min/max` und Enum für boolean).

---

### 5.13 Admin & User-Management

> Alle nur per `full`-Scope oder Admin-Cookie.

| Methode | Pfad                                    | Zweck                                          |
|---------|------------------------------------------|------------------------------------------------|
| GET/POST | `/api/users`                            | Liste, neuen User anlegen                      |
| PUT/DELETE | `/api/users/:id`                      | Stammdaten / Deaktivierung                     |
| `POST`   | `/api/users/:id/password`               | Passwort eines fremden Users setzen (Admin)    |
| GET/POST | `/api/admin/api-tokens`                 | Token-Liste, Token erstellen                   |
| `DELETE` | `/api/admin/api-tokens/:id`             | Token widerrufen                               |
| `GET`    | `/api/audit-log`                        | Login/Logout/CSV-Export/2FA-Events             |
| `GET`    | `/api/import/status` · `/api/import/log` | MaStR-XML-Import-Status                       |
| `POST`   | `/api/import/run`                        | Manueller Import-Trigger                       |
| `GET`    | `/api/enrich/status` · `/api/enrich/log` | Kontakt-Anreicherung                          |
| `POST`   | `/api/enrich/run`                        | Anreicherung starten                           |

#### Token erstellen via API (nur Admin / `full`-Scope)

> Nur für Admin-Workflows (z.B. automatisierte Token-Provisionierung). Endpoint erfordert Admin-Cookie oder Bearer-Token mit `full`-Scope. Externe Entwickler haben darauf **keinen** Zugriff.

```bash
curl -X POST https://mastr-solar.51.195.86.119.nip.io/api/admin/api-tokens \
  -H "Authorization: Bearer msolar_<full-token>" \
  -H "Content-Type: application/json" \
  -d '{"name":"n8n-bridge","scope":"write","expires_at":"2027-01-01"}'

# Response (token nur EINMAL!):
# { "id": 7, "name": "n8n-bridge", "token": "msolar_xxx...", "scope": "write", ... }
```

---

### 5.14 Sonstige

| Methode | Pfad                                    | Zweck                                          |
|---------|------------------------------------------|------------------------------------------------|
| `GET`   | `/api/2fa/status`                        | TOTP-Status des Aufrufers                      |
| `POST`  | `/api/2fa/enable-start` · `/enable-verify` · `/disable` | TOTP-Aktivierung                |
| GET/POST/DELETE | `/api/drafts`                    | Persönliche Entwürfe (frei nutzbarer Speicher) |
| GET/POST/DELETE | `/api/scripts`                   | Telefon-Scripts                                |
| `GET`   | `/api/onboarding/complete` · `/reset`    | UI-Onboarding                                  |
| `GET`   | `/api/export/csv` *(Admin)*              | CSV-Export aller Anlagen                       |

---

## 7. Typische Workflows

### A. Lead-Übernahme aus externem CRM

```text
1. CRM erkennt neue Photovoltaik-Anlage → ruft GET /api/anlagen?search=<mastr> auf
2. Wenn Match: PUT /api/anlagen/:id mit { "status": "kontaktiert", "owner_id": <user-id> }
3. POST /api/kunden/:mastr/notizen mit dem CRM-Notiztext
4. POST /api/reminders zum Nachfassen
```

### B. Tägliche Lead-Liste in eigenes BI-Tool

```bash
curl -H "Authorization: Bearer msolar_<read>" \
  "https://mastr-solar.../api/anlagen?owner=me&status=neu&sortBy=lead_score&sortDir=desc&limit=50"
```
Cron-Job, ETL, fertig.

### C. Reminder-Sync mit Outlook/Google Calendar

```text
1. Cron alle 15min: GET /api/reminders?status=pending&limit=500
2. Diff gegen letzte Synchronisation
3. Neue Reminders → CalDAV-Event anlegen, ID merken
4. status=done in mastr-solar → Outlook-Event entfernen
```

### D. Webhook-Ersatz: Polling auf Aktivitäten

mastr-solar bietet **aktuell keine Webhooks**. Bis dahin:

```bash
# Alle 60 Sekunden:
curl -H "Authorization: Bearer ..." \
  "https://.../api/anlagen?sortBy=lead_score&sortDir=desc&limit=200" \
  | jq '.data[] | select(.updated_at > "2026-05-17T00:00:00")'
```

Oder pro Anlage: `GET /api/anlagen/:id` → Feld `activities[]` enthält Action-Log mit Timestamps.

### E. Massen-Geocoding nach Bulk-Import eigener Daten

```bash
# 1. Admin-Trigger: leerlaufende Anlagen geocoden lassen
curl -X POST -H "Authorization: Bearer msolar_<full>" \
  https://.../api/geocode/batch

# 2. Status pro Anlage:
curl -H "Authorization: Bearer ..." https://.../api/anlagen/1234 \
  | jq '{ id, breitengrad, laengengrad, geocoded_at }'
```

### F. Repowering-Analyse für Datenexport

```bash
# Repowering-Daten mit individueller Modulgröße abrufen
for id in 100 200 300 400 500; do
  curl -s -H "Authorization: Bearer ..." \
    "https://.../api/anlagen/$id?module_wp=720" \
    | jq '.economics'
done
```

### G. Kunden-Übernahme mit Owner-Claim

```bash
# Erste schreibende Aktion eines Users im Kundenmenue claimt alle Anlagen des Betreibers.
curl -X POST -H "Authorization: Bearer msolar_<write>" \
  -H "Content-Type: application/json" \
  -d '{"text":"Erstkontakt via Messe Solar Hamburg 2026."}' \
  "https://.../api/kunden/ABR987654.../notizen"
# → autoAssignOwnerForBetreiber setzt owner_id = User des Tokens fuer alle Anlagen ohne Eigentuemer.
```

---

## 8. Datenmodell (Kurz)

```text
users (id, username, email, display_name, color, is_admin, pref_*)
   └─ owns ─→ anlagen.owner_id

betreiber (mastr_nummer PK, name, email, telefon, website, adresse)
   └─ 1:N ─→ anlagen.betreiber_mastr

anlagen (id PK, mastr_nummer, betreiber_mastr FK, ...PV-Stammdaten..., status, lead_score, owner_id, breitengrad, laengengrad)
   ├─ 1:N ─→ notizen (scope: anlage | betreiber)
   ├─ 1:N ─→ activities (audit-trail)
   ├─ 1:N ─→ termine
   ├─ 1:N ─→ calls
   ├─ 1:N ─→ sent_emails
   ├─ 1:N ─→ comments

reminders (id PK, betreiber_mastr FK, due_at, status, owner_user_id, created_by, note)

api_tokens (id PK, name, token_hash, scope, created_by, expires_at, revoked_at, request_count)

app_settings (key PK, value, updated_by, updated_at)   # global

notifications (id PK, user_id FK, type, title, body, read_at)
```

Beziehungen:

- **Kunde ≡ Betreiber:** Identität über `betreiber_mastr` (Marktstammdaten-Registriernummer).
- **Eine Anlage hat genau einen Eigentümer (`owner_id`)** im Sinne des Vertriebs-Workflows. Der Besitzer wird automatisch beim ersten Eintrag im Kundenmenü gesetzt und kann nur durch sich selbst oder einen Admin gewechselt werden.
- **Notizen können Anlagen- oder Betreiber-scoped sein** (`scope`-Feld).

---

## 9. Sicherheit & Operations

| Punkt                  | Details                                                                                  |
|------------------------|-------------------------------------------------------------------------------------------|
| Transport              | HTTPS (Let's Encrypt, automatische Renewal). HTTP redirected.                            |
| Login-Rate-Limit       | 5 Versuche/Minute/IP. Token-Auth ist nicht rate-limited (DoS-Schutz auf nginx-Ebene).    |
| Token-Speicherung      | Klartext nie persistiert, nur SHA-256-Hash. Bei Diebstahl: `DELETE /api/admin/api-tokens/:id`. |
| Token-Rotation         | Empfehlung: alle 90 Tage. `expires_at` setzen, neuen Token vor Ablauf generieren.        |
| Passwörter             | bcrypt cost 10. Min. 6 Zeichen. 2FA (TOTP) optional pro User.                            |
| GDPR                   | `GET /api/anlagen/:id/gdpr-export` für Datenauskunft. Logs werden 90 Tage aufbewahrt.    |
| Audit-Log              | Login, Logout, CSV-Export, 2FA-Änderungen, fehlgeschlagene Logins.                       |
| Backups                | tägliche SQLite-Snapshots in `/opt/mastr-solar/backups/` (server-seitig).                |

---

## 10. Beispiel-Clients

### Node.js / TypeScript

```ts
const BASE = "https://mastr-solar.51.195.86.119.nip.io";
const TOKEN = process.env.MSOLAR_TOKEN!;

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const r = await fetch(BASE + path, {
    ...init,
    headers: {
      "Authorization": `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });
  if (!r.ok) throw new Error(`${r.status} ${(await r.json()).error}`);
  return r.json();
}

const open = await api<{ data: any[]; pagination: any }>(
  "/api/anlagen?owner=me&status=neu&limit=20"
);
console.log(`${open.pagination.total} offene Leads`);
```

### Python

```python
import os, requests
BASE  = "https://mastr-solar.51.195.86.119.nip.io"
TOKEN = os.environ["MSOLAR_TOKEN"]
session = requests.Session()
session.headers["Authorization"] = f"Bearer {TOKEN}"

def api(method, path, **kw):
    r = session.request(method, BASE + path, **kw)
    r.raise_for_status()
    return r.json()

leads = api("GET", "/api/anlagen", params={"owner":"me","status":"neu","limit":20})
print(f"{leads['pagination']['total']} offene Leads")

api("POST", "/api/reminders", json={
    "betreiber_mastr": "ABR987654...",
    "due_at": "2026-05-25T09:00:00Z",
    "note": "Nachfassen — Repowering-Vorschlag verschickt am 17.5."
})
```

### n8n / Zapier

- HTTP-Request-Node mit Header `Authorization: Bearer msolar_…`
- Endpoint z.B. `GET /api/anlagen?owner=me&status=neu`
- Schedule-Trigger alle X Minuten
- Output via Set-Node mappen, dann an CRM/Sheet/Slack senden

---

## 11. Changelog

| Datum       | Änderung                                                                                  |
|-------------|--------------------------------------------------------------------------------------------|
| 2026-05-17  | **Erweiterungs-Welle:** /api/v1/ Alias · /api/healthz · /api/metrics · Idempotency-Key Header · Cursor-Pagination `?after=` · Englische Feld-Aliase `?lang=en` · strukturierte Error-Codes (`code`, `message`) · Token-Rate-Limit (10/s, 600/min) mit 429+Retry-After · Stack-Trace-Redaction · Owner-Filter härter (siehe ROADMAP.md) |
| 2026-05-17  | API-Token-Clients sehen nur noch Anlagen mit `owner_id IS NOT NULL` (siehe Sektion 3)     |
| 2026-05-17  | Englische + französische Übersetzung der Doku (`/docs/API.en.md`, `/docs/API.fr.md`)      |
| 2026-05-17  | Erstveröffentlichung dieser Integrationsdoku                                              |
| 2026-05-16  | `/api/me/profile` + `/api/me/password` + 9 neue Preferences-Felder                        |
| 2026-05-16  | Owner-Schutz: `PUT /api/anlagen/:id { owner_id }` 403 für Nicht-Owner/Nicht-Admin         |
| 2026-05-16  | `autoAssignOwnerForBetreiber` bei Kunden-Notiz und Reminder-POST                          |
| 2026-05-15  | Reminders + Kunden-API + Notizen-Scope                                                    |
| 2026-05-15  | App-Settings-API (calculation + visibility)                                                |
| 2026-05-15  | API-Token-System (read/write/full)                                                         |

---

## 12. Roadmap (informativ)

Vollständige Roadmap mit bewussten Nicht-Entscheidungen + ADRs siehe [ROADMAP.md](ROADMAP.md).

**Kurz:**
- ✅ OpenAPI 3.1 Spec — verfügbar unter `/docs/openapi.yaml`
- ⛔ GraphQL, OAuth2, Webhooks, DE→EN Rewrite, Postgres-Migration: **bewusst nicht jetzt** (siehe ROADMAP.md für Trigger)
- 🔄 Mögliche Erweiterungen on-demand: Swagger-UI · Postman-Collection · Per-Token Sichtbarkeits-Scoping · Tagesreport-Email · Hot-Backup S3

---

## 13. Health & Observability (public, ohne Auth)

| Endpoint              | Zweck                                       | Format                                  |
|-----------------------|---------------------------------------------|-----------------------------------------|
| `GET /api/health`     | Liveness — minimal, schnell                 | JSON: `{"ok":true,"time":"..."}`        |
| `GET /api/healthz`    | Readiness — DB-Check, Memory, Counts         | JSON: `{"status":"healthy","checks":{"db":"ok","anlagen_count":81832,"open_bugs":0,"memory_rss_mb":87},"time":"..."}` (503 wenn degraded) |
| `GET /api/metrics`    | Prometheus Text-Exposition (0.0.4)          | `text/plain` — Counter + Gauges         |

**Metrics-Auswahl:**
- `mastr_api_requests_total{class="ok|client_err|server_err"}` (Counter, letzte Stunde)
- `mastr_api_open_bugs` (Gauge)
- `mastr_api_active_tokens` (Gauge)
- `mastr_anlagen_total` (Gauge: 81 832)
- `mastr_anlagen_owned` (Gauge: aktuell bearbeitete)
- `mastr_reminders_pending` (Gauge)
- `mastr_memory_rss_bytes` (Gauge)

Einbindung in Prometheus:
```yaml
scrape_configs:
  - job_name: mastr-solar
    scrape_interval: 60s
    static_configs:
      - targets: ['mastr-solar.51.195.86.119.nip.io']
    scheme: https
    metrics_path: /api/metrics
```

---

## 14. Support

- Issues / Bugs: per Notiz im UI an `@admin`
- Production-Incidents: oncall@mastr-solar (intern)
- API-Status: `GET /api/health` (HTTP 200 + `{"ok":true}` wenn alles läuft)
