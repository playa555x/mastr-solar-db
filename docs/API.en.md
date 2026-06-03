# mastr-solar API — Integration Guide

> Status: 2026-05-17
> Production base URL: `https://mastr-solar.51.195.86.119.nip.io`
> Content-Type: `application/json; charset=utf-8` (on all endpoints except CSV export, ICS accept/decline, and multipart uploads)

This documentation targets developers who want to integrate an external system (CRM, ERP, Zapier/n8n, custom scripts, BI tools, marketing platforms) with mastr-solar. It describes authentication, conventions, every relevant endpoint and typical workflows with runnable examples.

---

## 1. Quickstart

> **Important:** External developers **cannot register themselves**. Tokens are exclusively issued by the mastr-solar **administrator** through a controlled process. You receive your token through a secure channel (encrypted email, password-manager link, in-person handover) — not through this documentation.

```bash
# 1. Once you've received a token from the administrator, you're good to go:

curl -H "Authorization: Bearer msolar_xxxxxxxxxxxxxxxxxxxxxxxx" \
  "https://mastr-solar.51.195.86.119.nip.io/api/anlagen?limit=5&owner=me"
```

### How the admin issues a token

In the UI: **Settings → API Access → "+ New API key"**
1. Descriptive name (e.g. "Acme GmbH — n8n bridge")
2. Pick a scope (`read` / `write` / `full`)
3. Optional expiry date
4. Plaintext token is shown **once** and handed over to the developer through a secure channel

### Admin oversight and transparency

Every API token appears in *Settings → API Access* with:

| Field          | Meaning                                                                    |
|----------------|----------------------------------------------------------------------------|
| Name           | descriptive, assigned by the admin — e.g. customer + system                |
| Scope          | `read` / `write` / `full`                                                  |
| Prefix         | first 14 characters (for identification, rest secret)                       |
| Created        | date + issuing admin                                                       |
| Last used      | timestamp of the last successful request                                   |
| **Last IP**    | IP of the most recent request — important for anomaly detection            |
| Requests       | total count since creation                                                 |
| Status         | `active` or `revoked` (with revocation date + responsible admin)           |

**Revoke:** click "revoke" in the UI or `DELETE /api/admin/api-tokens/:id`. Effective immediately — the next request with this token returns HTTP 401.

Successful response:

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

## 2. Authentication

mastr-solar supports two authentication methods. External systems use **Method A (API token)**.

### A. Bearer token (for external systems)

Header: `Authorization: Bearer msolar_<token>`

- Tokens are created in the UI by an **administrator** under *Settings → API Access*
- Format: `msolar_<43 chars base64url>` (50 chars total)
- Plaintext is shown **only once** at creation time — only the SHA-256 hash is stored in the database
- Tokens can be revoked (effective immediately)
- `request_count` and `last_used_at` are logged per token
- Tokens may have an expiration date (`expires_at`)

### B. Session cookie (for browser users)

Header: `Cookie: session=<token>`
Automatically set after `POST /api/auth/login` (`HttpOnly`, `Secure`, `SameSite=Lax`). Not recommended for external systems.

### Missing token?

```http
HTTP/1.1 401 Unauthorized
Content-Type: application/json

{"error":"Nicht autorisiert","code":"UNAUTHORIZED","message":"Nicht autorisiert"}
```

### Token scope insufficient?

```http
HTTP/1.1 403 Forbidden

{"error":"Scope 'read' erlaubt diese HTTP-Methode nicht (POST)","code":"FORBIDDEN","message":"..."}
```

### Rate limit exceeded?

```http
HTTP/1.1 429 Too Many Requests
Retry-After: 1

{"error":"Rate limit: max 10 requests/second per token","code":"RATE_LIMITED","retry_after":1}
```

**Per-token limits:** **10 requests/second** and **600 requests/minute**. Beyond that the server returns 429 with a `Retry-After` header.

---

## 3. Visibility rule for API tokens (important!)

> **API token clients can ONLY see installations that have been assigned to a staff member (`owner_id IS NOT NULL`).**

To prevent external systems from pulling the entire Marktstammdaten table, the read endpoints are restricted for token authentication:

| Endpoint                            | Visibility for token clients                                    |
|-------------------------------------|------------------------------------------------------------------|
| `GET /api/anlagen`                  | only installations with `owner_id IS NOT NULL`                  |
| `GET /api/anlagen/:id`              | 404 if the installation has no owner                            |
| `GET /api/anlagen/:id/related`      | only worked sibling installations                                |
| `GET /api/anlagen/:id/neighbors`    | only worked neighbour installations                              |
| `GET /api/kunden`                   | only customers with ≥ 1 worked installation                     |
| `GET /api/kunden/:mastr`            | `anlagen[]` only contains worked entries; 404 if none           |
| `GET /api/map/markers`              | only worked installations                                       |

**How does an installation become "worked"?** As soon as a user in mastr-solar performs one of the following actions, they automatically become the owner (`autoAssignOwner` / `autoAssignOwnerForBetreiber`):

- Add a note (per-installation or per-customer)
- Change status (e.g. kanban move from "neu" to "kontaktiert")
- Create a reminder
- Log a phone call
- Add a comment/email to the installation

**Pure viewing changes nothing.** Even a browser user who just clicks on an installation without entering anything does NOT become the owner. The owner flag therefore acts as a reliable "was actively worked on" indicator.

**Write operations are not restricted** — anyone with a valid `id` can claim a record via `POST /api/anlagen/:id/notizen` or `PUT /api/anlagen/:id { "status": "..." }`, making it visible for subsequent read access. This is intentional.

---

## 4. Scopes

| Scope    | Allowed HTTP methods                          | What it can do                                                                       |
|----------|-----------------------------------------------|---------------------------------------------------------------------------------------|
| `read`   | `GET`, `HEAD`, `OPTIONS`                      | Read all data outside the admin area                                                  |
| `write`  | `read` + `POST`, `PUT`, `PATCH`, `DELETE`     | Create/update installations, customers, reminders, notes — **no** admin/user mgmt/import |
| `full`   | everything                                    | Like admin: token mgmt, user CRUD, MaStR import control, audit log                    |

Admin-only path prefixes (always 403 for `read`/`write`):

- `/api/admin/*`
- `/api/users` (list/create/update/delete)
- `/api/import/*`
- `/api/audit-log`

---

## 5. Conventions

| Topic           | Rule                                                                                                   |
|-----------------|---------------------------------------------------------------------------------------------------------|
| Encoding        | UTF-8 for request and response body                                                                     |
| Date/time       | ISO-8601 with timezone (`2026-05-17T08:30:00Z`). Plain dates as `YYYY-MM-DD`.                           |
| Timezone        | Server stores UTC. UI displays Europe/Berlin.                                                           |
| Float           | Dot as decimal separator, no thousands separator (`750.5` for 750.5 kWp)                                |
| Boolean         | DB fields are typically `0`/`1`. JSON accepts both `true`/`false` and `0`/`1`.                          |
| IDs             | Numeric, monotonically increasing (`anlage.id`, `user.id`, `reminder.id`).                              |
| MaStR number    | String, alphanumeric (`SEE918732FX91...`). Stable external key for installations and operators.         |
| Pagination      | `?page=1&limit=50` (offset mode) or `?after=<id>&limit=50` (cursor mode, stable on growing lists). Max `limit=200`. |
| Sorting         | `?sortBy=<field>&sortDir=asc|desc`. Allowed fields documented per endpoint.                              |
| Empty strings   | Mostly interpreted as `null` in PUT. Set `null` explicitly when clearing a field.                       |
| Optimistic lock | Not supported. "Last write wins" — for critical concurrent writes rely on the owner protection.         |

### Error format

All errors return JSON with `error`, `code` and `message`. Use `code` for machine-readable handling.

```json
{
  "error": "betreiber_mastr fehlt",
  "code": "BAD_REQUEST",
  "message": "betreiber_mastr fehlt"
}
```

**HTTP status codes + codes:**

| Status | Code                    | Meaning                                                |
|--------|-------------------------|--------------------------------------------------------|
| 400    | `BAD_REQUEST`           | Missing/invalid parameter                              |
| 401    | `UNAUTHORIZED`          | Not authenticated (token missing/invalid)              |
| 403    | `FORBIDDEN`             | Authenticated, but no permission                       |
| 403    | `ADMIN_NOT_API`         | API token tried to reach an admin endpoint             |
| 403    | `ADMIN_REQUIRED`        | Admin (cookie auth) required                           |
| 404    | `NOT_FOUND`             | Resource not found                                     |
| 409    | `IDEMPOTENCY_KEY_REUSE` | Same idempotency key used with different body          |
| 422    | `VALIDATION_FAILED`     | Schema validation failed                               |
| 429    | `RATE_LIMITED`          | Rate limit exceeded (login OR token)                   |
| 500    | `INTERNAL_ERROR`        | Server error                                           |
| 503    | `SERVICE_UNAVAILABLE`   | Service temporarily unavailable                        |

---

### Global request headers (optional)

| Header                  | Applies to       | Purpose                                                              |
|-------------------------|------------------|----------------------------------------------------------------------|
| `Authorization: Bearer` | all              | API token auth (see section 2)                                       |
| `Idempotency-Key`       | POST/PUT/PATCH   | Avoid duplicates on retry (24h cache keyed by token+key+body hash)   |
| `Content-Type`          | body requests    | Always `application/json` (except multipart attachments)             |

### Global query parameters (optional)

| Parameter   | Applies to              | Effect                                                                |
|-------------|-------------------------|-----------------------------------------------------------------------|
| `?lang=en`  | all list endpoints      | Adds **additional** English field aliases alongside German keys        |
| `?after=N`  | `GET /api/anlagen`      | Cursor pagination: return IDs > N, ordered `id ASC`                    |

### Pagination modes

**Offset mode** (default):
```json
{
  "data": [...],
  "pagination": { "mode": "offset", "page": 2, "limit": 50, "total": 1234, "pages": 25 }
}
```

**Cursor mode** (`?after=`):
```json
{
  "data": [...],
  "pagination": { "mode": "cursor", "limit": 50, "returned": 50, "next_cursor": 1234, "has_more": true }
}
```

**When to use which?** Page+limit is good for UI lists ("page 5 of 25"). Cursor is stable for bulk iteration ("walk all installations once") — no duplicates or gaps on concurrent inserts.

### Idempotency keys

POST/PUT/PATCH with header `Idempotency-Key: <uuid>` are cached for 24h. Same key + same body returns the cached response (with header `X-Idempotent-Replay: true`), same key + different body returns `409 IDEMPOTENCY_KEY_REUSE`.

```bash
KEY=$(uuidgen)
curl -X POST -H "Authorization: Bearer ..." \
  -H "Idempotency-Key: $KEY" \
  -H "Content-Type: application/json" \
  -d '{"betreiber_mastr":"ABR...","due_at":"2026-05-25T09:00:00Z"}' \
  https://mastr-solar.51.195.86.119.nip.io/api/reminders
# On network failure simply retry with the same key.
```

### Versioning

Every endpoint is reachable at `/api/<path>` (current) and `/api/v1/<path>` (alias).
Before breaking changes `/api/v2/` will be offered in parallel — existing integrations keep `/api/v1/` for at least 6 months.

---

## 6. Endpoint reference

### 6.1 Auth & profile

#### `POST /api/auth/login`
Browser login. External systems do **not** need this — they use API tokens. Returns an HttpOnly cookie.

Body: `{ "username": "...", "password": "...", "totp_code": "123456"? }`
Response: `{ "success": true }` + cookie

Rate limit: 5 attempts / minute / IP.

#### `POST /api/auth/logout` · `GET /api/auth/me`
Logout invalidates the session. `/api/auth/me` returns the current user.

#### `GET /api/me/profile`
Returns the personal data + preferences of the calling user.

```json
{
  "id": 3, "username": "schmidt", "email": "schmidt@firma.de",
  "display_name": "Lars Schmidt", "color": "#06b6d4",
  "phone": "+49 …", "bio": "Sales DACH",
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
Validation: enums, HH:MM format for quiet hours, email regex, snooze 5–10080 min.
Response: `{ "success": true }`.

#### `POST /api/me/password`
```json
{ "current_password": "old", "new_password": "new_min_6_chars" }
```
On success, **all other sessions** of the user are invalidated (the current cookie session remains).

---

### 6.2 Installations (PV plants)

Core entity. An installation belongs to exactly one operator (`betreiber_mastr`). It can be assigned to a user (`owner_id`).

#### `GET /api/anlagen`
Lists installations with filter + pagination.

| Query              | Type    | Example               | Meaning                                                                |
|--------------------|---------|-----------------------|------------------------------------------------------------------------|
| `search`           | string  | `Schmidt`             | Full text across name, betreiber_name, ort, plz, email, telefon        |
| `bundesland`       | string  | `Bayern`              | Exact match                                                            |
| `status`           | string  | `neu`                 | `neu` / `kontaktiert` / `bearbeitet` / `interessiert` / `nicht_interessiert` / `abgeschlossen` |
| `mit_kontakt`      | string  | `ja` / `nein`         | Filters for available contact (email or phone)                         |
| `leistung_min`     | number  | `100`                 | kWp lower bound                                                        |
| `leistung_max`     | number  | `5000`                | kWp upper bound                                                        |
| `datum_von`        | date    | `2010-01-01`          | Commissioning from                                                     |
| `datum_bis`        | date    | `2020-12-31`          | Commissioning to                                                       |
| `owner`            | string  | `me` / `42` / `unassigned` | Owner (`me` = the calling user)                                    |
| `sortBy`           | enum    | `lead_score`          | `nettonennleistung` / `inbetriebnahme` / `name` / `ort` / `bundesland` / `lead_score` |
| `sortDir`          | string  | `desc`                | `asc` / `desc`                                                         |
| `page`             | int     | `1`                   | starting at 1 (offset mode)                                            |
| `limit`            | int     | `50`                  | 1–200, default 50                                                      |
| `after`            | int     | `1234`                | Cursor mode: IDs > N, ordered ASC. `next_cursor` in response.          |
| `lang`             | string  | `en`                  | English field aliases alongside German keys (additive)                  |

Response (abbreviated):

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

> **Note (token clients):** the response only contains installations with `owner_id IS NOT NULL`. See section 3.

#### `GET /api/anlagen/:id`
Returns an installation **plus** aggregated sub-resources needed by the detail panel:

```json
{
  "id": 1234, ... (all fields as above),
  "notizen_liste": [ { "id": 12, "text": "...", "scope": "anlage|betreiber", "user_id": 3, "created_at": "..." } ],
  "sent_emails":   [ { "id": 5, "subject": "...", "to_addr": "...", "sent_at": "..." } ],
  "termine":       [ { "id": 7, "title": "On-site appointment", "start_ts": 1716000000000, ... } ],
  "activities":    [ { "type": "status_change", "description": "Status: neu → kontaktiert", "user_id": 3, "created_at": "..." } ],
  "messages":      [ /* direct comments */ ],
  "calls":         [ { "id": 4, "direction": "out", "started_at": "...", "duration_sec": 312 } ],
  "related_anlagen": [ /* other installations of the same operator */ ],
  "reminders":     [ /* reminders */ ],
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

Query options:

- `?module_wp=720` — overrides the global `repowering_module_wp` for this response and returns the repowering calculation for that module size.

#### `PUT /api/anlagen/:id`
Update installation. Whitelist:

`name`, `betreiber_name`, `strasse`, `hausnummer`, `plz`, `ort`, `bundesland`, `landkreis`, `gemeinde`, `breitengrad`, `laengengrad`, `bruttoleistung`, `nettonennleistung`, `anzahl_module`, `inbetriebnahme`, `energietraeger`, `anlagentyp`, `lage_einheit`, `hauptausrichtung`, `hauptausrichtung_neigungswinkel`, `modulhersteller`, `wechselrichterhersteller`, `wechselrichter_anzahl`

Also accepted:

- `status` — triggers an activity log entry + `autoAssignOwner`
- `notizen` — free-text note field on the installation (deprecated; prefer `notizen_liste`)
- `owner_id` — only changeable by the current owner or an admin; with `NULL` owner anyone can set it (claim)

#### `POST /api/anlagen/:id/notizen`
Create a note on an installation.
```json
{ "text": "Phone call on May 17 — interested, appointment next week.", "scope": "anlage" | "betreiber" }
```
`scope=betreiber` writes a customer-wide note that shows up for all installations of the operator.
Auto: `autoAssignOwner` (if the installation has no owner), `@mention` notifications.

#### `DELETE /api/notizen/:id`
Deletes a note.

#### `GET /api/anlagen/:id/related`
Other installations of the same operator.

#### `GET /api/anlagen/:id/neighbors?radius=2`
Installations within `radius` km (Haversine). Default 1.

#### `POST /api/anlagen/:id/refine-location`
Searches OSM Overpass for real solar-tagged polygons near the coordinates and sets `breitengrad`/`laengengrad` to the centroid of the best match. Also stores `position_refined_at`, `position_refined_distance_m`, `position_osm_ref`.

#### `POST /api/anlagen/:id/email`
Send an email from the calling user's personal SMTP account with mail tracking (open pixel).
```json
{
  "to": "kunde@firma.de",
  "subject": "Repowering potential of your installation",
  "body_html": "<p>Hello …</p>",
  "template_id": 4?,           // optional: load template
  "attachment_ids": [12, 17]?, // optional
  "termin": { "start": "2026-06-01T10:00:00Z", "end": "2026-06-01T11:00:00Z", "title": "On-site" }? // optional ICS
}
```
Response includes `sent_email_id` for later status lookup.

#### `GET /api/anlagen/:id/quote`
PDF (preliminary quote) as download.

#### `GET /api/anlagen/:id/gdpr-export`
JSON export of all personal data for an installation (Article 15 GDPR).

#### `POST /api/anlagen/:id/rescore`
Recomputes the lead score of an installation.

#### `POST /api/anlagen/:id/geocode`
Geocoding a single installation via Nominatim.

---

### 6.3 Customers (operators)

One customer = one unique `betreiber_mastr`. Uniquely resolved via the Marktstammdaten registration number.

#### `GET /api/kunden?q=<query>&limit=500`
Aggregated customer list with installation count, total power, open reminders.

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
Detail with `betreiber`, `anlagen[]`, `notizen[]` (customer- and installation-notes combined), `reminders[]`, `calls[]`.

#### `POST /api/kunden/:mastr/notizen`
Write a customer note (applies to all installations of the operator).
```json
{ "text": "Managing Director Mr. Mustermann is the decision maker. Prefers calls in the morning." }
```
Auto: `autoAssignOwnerForBetreiber` claims all installations that have no owner yet.

#### `GET /api/betreiber/by-mastr/:mastr`
Raw operator data (master data without aggregation).

#### `PUT /api/betreiber/by-mastr/:mastr`
Update operator contact data. Whitelist: `name`, `email`, `telefon`, `fax`, `website`, `strasse`, `hausnummer`, `plz`, `ort`, `land`, `rechtsform`.

---

### 6.4 Reminders

Tasks with a due date, always anchored to a customer (`betreiber_mastr`). Checked every 5 minutes by a systemd timer and delivered via email/Telegram.

#### `GET /api/reminders?status=pending&betreiber_mastr=ABR...&limit=200`
- `status`: `pending` (default) / `done` / `snoozed` / `all`

#### `GET /api/reminders/today`
Reminders due today.

#### `POST /api/reminders`
```json
{
  "betreiber_mastr": "ABR987654...",
  "due_at": "2026-05-20T09:00:00Z",
  "note": "Follow up regarding offer",
  "owner_user_id": 3  // optional; default = calling user
}
```
Auto: `autoAssignOwnerForBetreiber`.

#### `PATCH /api/reminders/:id`
Update / actions:
```json
{ "action": "done" }
{ "action": "snooze", "until": "2026-05-21T10:00:00Z" }
{ "due_at": "2026-05-25T08:00:00Z", "note": "new text", "owner_user_id": 5 }
```

#### `DELETE /api/reminders/:id`
Deletes a reminder.

#### `GET /api/reminders/calendar?from=...&to=...`
FullCalendar event format (range query).

---

### 6.5 Appointments (calendar)

#### `GET /api/termine?from=YYYY-MM-DD&to=YYYY-MM-DD`
Appointments in the range. Returns FullCalendar-compatible events including RSVP status.

#### `POST /api/termine`
```json
{
  "anlage_id": 1234,
  "title": "On-site appointment Solar Park Mustermann",
  "description": "Roof surface survey",
  "location": "Hauptstr. 12, 82166 Gräfelfing",
  "start_ts": "2026-06-01T10:00:00Z",
  "end_ts":   "2026-06-01T11:30:00Z",
  "attendee_email": "kunde@mustermann.de",
  "attendee_name":  "Hans Mustermann"
}
```
Automatically sends an ICS invitation to `attendee_email` if SMTP is configured.

#### `PUT/DELETE /api/termine/:id`
On appointment update ICS updates are sent (sequence counter automatic).

#### `GET /api/termine/accept?token=...` / `GET /api/termine/decline?token=...`
Public RSVP endpoints for email links (no auth required, token is unique per appointment).

---

### 6.6 Calls

Manual call logging + optional AI summary.

#### `GET /api/anlagen/:id/calls`
#### `POST /api/anlagen/:id/calls`
```json
{
  "direction": "out" | "in",
  "started_at": "2026-05-17T08:30:00Z",
  "duration_sec": 312,
  "outcome": "interessiert" | "kein_interesse" | "termin_vereinbart" | "rueckruf" | ...,
  "notes": "Mr. Mustermann is interested in repowering."
}
```

#### `PATCH /api/calls/:id` · `POST /api/calls/:id/summary`
Update or generate AI summary (uses the configured AI provider setting of the caller).

---

### 6.7 Email workflow

External systems can reuse the mastr-solar mail engine.

| Method               | Path                                | Purpose                                  |
|----------------------|-------------------------------------|------------------------------------------|
| GET/PUT/POST         | `/api/settings/smtp`                | SMTP account + signature of the caller   |
| `POST`               | `/api/settings/smtp/test`           | Test mail to own address                 |
| GET/PUT/POST         | `/api/settings/imap`                | IMAP inbox polling                       |
| `POST`               | `/api/settings/imap/poll-now`       | Poll immediately                         |
| GET/POST             | `/api/email-templates`              | Template CRUD                            |
| GET/POST             | `/api/attachments`                  | Multipart upload up to 10 MB             |
| `GET`                | `/api/replies`                      | Inbound replies matched to installations |
| `GET`                | `/api/sent-emails/:id/events`       | Mail tracking: opened, clicked, bounce   |

Sending → see `POST /api/anlagen/:id/email` (6.2).

---

### 6.8 Direct comments & DMs

Internal team discussion about an installation and direct messages between users.

| Method  | Path                                | Purpose                                  |
|---------|-------------------------------------|------------------------------------------|
| GET/POST | `/api/anlagen/:id/comments`        | Comment thread (with `@mention`)         |
| `DELETE` | `/api/comments/:id`                | Delete comment                           |
| `GET`    | `/api/dm/threads`                  | Own DM threads                           |
| `GET/POST` | `/api/dm/:userId`                | Conversation with a specific user        |

---

### 6.9 Notifications

#### `GET /api/notifications`
In-app list of own notifications (mention, dm, assignment, reminder).

#### `POST /api/notifications/:id/read` · `POST /api/notifications/read-all`

#### `GET/PUT /api/settings/notifications`
Per type (`mention`, `dm`, `assignment`, `reminder`) and channel (`email`, `telegram`) toggleable.
Quiet hours come from the user profile (`pref_quiet_hours_start/end`).

---

### 6.10 Dashboard & stats

#### `GET /api/dashboard`
Aggregated home page data:

```json
{
  "quick_stats": { "total_anlagen": 81832, "my_open": 5, "due_today": 2, "unread_notifications": 0, "open_termine": 3 },
  "reminders_today": [...],
  "termine_today":   [...],
  "recent_notifications": [...],
  "recent_activities":    [...],
  "top_leads":            [...],
  "funnel":               [ { "status": "neu", "count": 81831 }, ... 6 entries ... ]
}
```

#### `GET /api/stats` · `GET /api/bundeslaender` · `GET /api/today`
Classic aggregate stats; `/today` contains due reminders + today's appointments.

#### `GET /api/reporting/kpis?from=YYYY-MM-DD&to=YYYY-MM-DD`
KPI reporting (conversion, pipeline value, etc.).

#### `GET /api/map/markers?bbox=south,west,north,east`
Map markers for a bounding box viewport. Used by the map tab.

---

### 6.11 Campaigns (sequenced email)

| Method  | Path                                       | Purpose                                  |
|---------|--------------------------------------------|------------------------------------------|
| GET/POST | `/api/campaigns`                          | List + create                            |
| GET/PUT/DELETE | `/api/campaigns/:id`                | Details                                  |
| `POST`   | `/api/campaigns/:id/(start\|pause\|resume)` | Control                                 |
| `GET`    | `/api/campaigns/:id/recipients`          | Recipient list with status              |
| `GET`    | `/api/campaigns/:id/ab-stats`            | A/B evaluation                          |
| `POST`   | `/api/campaigns/preview`                 | Dry run of a mail                        |

---

### 6.12 App settings (read) & admin settings

#### `GET /api/app-settings`
All calculation/visibility-relevant global settings (readable by every user).

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
  "meta": [ { "key": "repowering_module_wp", "label": "Module power (repowering)", "unit": "Wp", "min": 400, "max": 900, "step": 10, "help": "…", "category": "calculation", "type": "number" }, ... ]
}
```

#### `GET/PUT /api/admin/app-settings` *(admin)*
Writes settings (with validation against `meta.min/max` and enum for boolean).

---

### 6.13 Admin & user management

> All restricted to `full` scope or admin cookie.

| Method   | Path                                    | Purpose                                          |
|----------|------------------------------------------|--------------------------------------------------|
| GET/POST | `/api/users`                             | List, create new user                            |
| PUT/DELETE | `/api/users/:id`                       | Master data / deactivation                       |
| `POST`   | `/api/users/:id/password`                | Set the password of another user (admin)         |
| GET/POST | `/api/admin/api-tokens`                  | Token list, create token                         |
| `DELETE` | `/api/admin/api-tokens/:id`              | Revoke token                                     |
| `GET`    | `/api/audit-log`                         | Login/logout/CSV export/2FA events               |
| `GET`    | `/api/import/status` · `/api/import/log` | MaStR XML import status                          |
| `POST`   | `/api/import/run`                        | Manual import trigger                            |
| `GET`    | `/api/enrich/status` · `/api/enrich/log` | Contact enrichment                               |
| `POST`   | `/api/enrich/run`                        | Start enrichment                                 |

#### Create a token via API (admin / `full` scope only)

> Only for admin workflows (e.g. automated token provisioning). The endpoint requires an admin cookie or a Bearer token with `full` scope. External developers do **not** have access to it.

```bash
curl -X POST https://mastr-solar.51.195.86.119.nip.io/api/admin/api-tokens \
  -H "Authorization: Bearer msolar_<full-token>" \
  -H "Content-Type: application/json" \
  -d '{"name":"n8n-bridge","scope":"write","expires_at":"2027-01-01"}'

# Response (token shown ONCE!):
# { "id": 7, "name": "n8n-bridge", "token": "msolar_xxx...", "scope": "write", ... }
```

---

### 6.14 Misc

| Method  | Path                                    | Purpose                                          |
|---------|------------------------------------------|--------------------------------------------------|
| `GET`   | `/api/2fa/status`                        | TOTP status of the caller                        |
| `POST`  | `/api/2fa/enable-start` · `/enable-verify` · `/disable` | TOTP activation                  |
| GET/POST/DELETE | `/api/drafts`                    | Personal drafts (free-form storage)              |
| GET/POST/DELETE | `/api/scripts`                   | Phone scripts                                    |
| `GET`   | `/api/onboarding/complete` · `/reset`    | UI onboarding                                    |
| `GET`   | `/api/export/csv` *(admin)*              | CSV export of all installations                  |

---

## 7. Typical workflows

### A. Lead handover from external CRM

```text
1. CRM detects a new photovoltaic installation → calls GET /api/anlagen?search=<mastr>
2. If match: PUT /api/anlagen/:id with { "status": "kontaktiert", "owner_id": <user-id> }
3. POST /api/kunden/:mastr/notizen with the CRM note text
4. POST /api/reminders for follow-up
```

### B. Daily lead list into your own BI tool

```bash
curl -H "Authorization: Bearer msolar_<read>" \
  "https://mastr-solar.../api/anlagen?owner=me&status=neu&sortBy=lead_score&sortDir=desc&limit=50"
```
Cron job, ETL, done.

### C. Reminder sync with Outlook/Google Calendar

```text
1. Cron every 15 min: GET /api/reminders?status=pending&limit=500
2. Diff against last sync
3. New reminders → create CalDAV event, store ID
4. status=done in mastr-solar → remove Outlook event
```

### D. Webhook replacement: polling on activity

mastr-solar **currently has no webhooks**. Until then:

```bash
# Every 60 seconds:
curl -H "Authorization: Bearer ..." \
  "https://.../api/anlagen?sortBy=lead_score&sortDir=desc&limit=200" \
  | jq '.data[] | select(.updated_at > "2026-05-17T00:00:00")'
```

Or per installation: `GET /api/anlagen/:id` → field `activities[]` contains the action log with timestamps.

### E. Bulk geocoding after your own bulk import

```bash
# 1. Admin trigger: geocode installations that lack coordinates
curl -X POST -H "Authorization: Bearer msolar_<full>" \
  https://.../api/geocode/batch

# 2. Status per installation:
curl -H "Authorization: Bearer ..." https://.../api/anlagen/1234 \
  | jq '{ id, breitengrad, laengengrad, geocoded_at }'
```

### F. Repowering analysis for data export

```bash
# Fetch repowering data with custom module size
for id in 100 200 300 400 500; do
  curl -s -H "Authorization: Bearer ..." \
    "https://.../api/anlagen/$id?module_wp=720" \
    | jq '.economics'
done
```

### G. Customer handover with owner claim

```bash
# A user's first write action in the customer menu claims all installations of the operator.
curl -X POST -H "Authorization: Bearer msolar_<write>" \
  -H "Content-Type: application/json" \
  -d '{"text":"First contact at Solar Hamburg fair 2026."}' \
  "https://.../api/kunden/ABR987654.../notizen"
# → autoAssignOwnerForBetreiber sets owner_id = token user for all installations without owner.
```

---

## 8. Data model (brief)

```text
users (id, username, email, display_name, color, is_admin, pref_*)
   └─ owns ─→ anlagen.owner_id

betreiber (mastr_nummer PK, name, email, telefon, website, address)
   └─ 1:N ─→ anlagen.betreiber_mastr

anlagen (id PK, mastr_nummer, betreiber_mastr FK, ...PV master data..., status, lead_score, owner_id, breitengrad, laengengrad)
   ├─ 1:N ─→ notizen (scope: anlage | betreiber)
   ├─ 1:N ─→ activities (audit trail)
   ├─ 1:N ─→ termine
   ├─ 1:N ─→ calls
   ├─ 1:N ─→ sent_emails
   ├─ 1:N ─→ comments

reminders (id PK, betreiber_mastr FK, due_at, status, owner_user_id, created_by, note)

api_tokens (id PK, name, token_hash, scope, created_by, expires_at, revoked_at, request_count)

app_settings (key PK, value, updated_by, updated_at)   # global

notifications (id PK, user_id FK, type, title, body, read_at)
```

Relationships:

- **Customer ≡ operator:** identity via `betreiber_mastr` (Marktstammdaten registration number).
- **One installation has exactly one owner (`owner_id`)** in the sales workflow sense. The owner is automatically set on the user's first write action in the customer menu and can only be changed by the owner themselves or by an admin.
- **Notes can be installation- or customer-scoped** (`scope` field).

---

## 9. Security & operations

| Topic                  | Details                                                                                  |
|------------------------|-------------------------------------------------------------------------------------------|
| Transport              | HTTPS (Let's Encrypt, auto-renewal). HTTP redirected.                                     |
| Login rate limit       | 5 attempts/minute/IP. Token auth is not rate-limited (DoS protection at nginx level).     |
| Token storage          | Plaintext never persisted, only SHA-256 hash. On theft: `DELETE /api/admin/api-tokens/:id`. |
| Token rotation         | Recommendation: every 90 days. Set `expires_at`, create a new token before expiry.        |
| Passwords              | bcrypt cost 10. Min. 6 chars. 2FA (TOTP) optional per user.                               |
| GDPR                   | `GET /api/anlagen/:id/gdpr-export` for data subject access. Logs kept for 90 days.        |
| Audit log              | Login, logout, CSV export, 2FA changes, failed logins.                                    |
| Backups                | Daily SQLite snapshots in `/opt/mastr-solar/backups/` (server-side).                      |

---

## 10. Example clients

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
console.log(`${open.pagination.total} open leads`);
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
print(f"{leads['pagination']['total']} open leads")

api("POST", "/api/reminders", json={
    "betreiber_mastr": "ABR987654...",
    "due_at": "2026-05-25T09:00:00Z",
    "note": "Follow up — repowering proposal sent on May 17."
})
```

### n8n / Zapier

- HTTP request node with header `Authorization: Bearer msolar_…`
- Endpoint e.g. `GET /api/anlagen?owner=me&status=neu`
- Schedule trigger every X minutes
- Map output via set node, then send to CRM/sheet/Slack

---

## 11. Changelog

| Date        | Change                                                                                   |
|-------------|-------------------------------------------------------------------------------------------|
| 2026-05-17  | **Wave of additions:** /api/v1/ alias · /api/healthz · /api/metrics · Idempotency-Key header · Cursor pagination `?after=` · English field aliases `?lang=en` · structured error codes (`code`, `message`) · token rate-limit (10/s, 600/min) with 429+Retry-After · stack-trace redaction · stricter owner filter (see ROADMAP.md) |
| 2026-05-17  | API token clients see only installations with `owner_id IS NOT NULL` (see section 3)     |
| 2026-05-17  | English + French translations (`/docs/API.en.md`, `/docs/API.fr.md`)                     |
| 2026-05-17  | First release of this integration guide                                                  |
| 2026-05-16  | `/api/me/profile` + `/api/me/password` + 9 new preference fields                         |
| 2026-05-16  | Owner protection: `PUT /api/anlagen/:id { owner_id }` 403 for non-owner/non-admin        |
| 2026-05-16  | `autoAssignOwnerForBetreiber` on customer-note and reminder POST                         |
| 2026-05-15  | Reminders + customer API + note scopes                                                   |
| 2026-05-15  | App settings API (calculation + visibility)                                              |
| 2026-05-15  | API token system (read/write/full)                                                       |

---

## 12. Roadmap (informational)

Full roadmap with explicit non-decisions + ADRs: see [ROADMAP.md](ROADMAP.md).

**Short:**
- ✅ OpenAPI 3.1 spec — available at `/docs/openapi.yaml`
- ⛔ GraphQL, OAuth2, webhooks, DE→EN rewrite, Postgres migration: **deliberately not now** (see ROADMAP.md for triggers)
- 🔄 On-demand extensions: Swagger UI · Postman collection · per-token visibility scoping · daily report email · hot-backup to S3

---

## 13. Health & observability (public, no auth)

| Endpoint              | Purpose                                     | Format                                  |
|-----------------------|---------------------------------------------|-----------------------------------------|
| `GET /api/health`     | Liveness — minimal, fast                    | JSON: `{"ok":true,"time":"..."}`        |
| `GET /api/healthz`    | Readiness — DB check, memory, counts        | JSON: `{"status":"healthy","checks":{"db":"ok",...},"time":"..."}` (503 if degraded) |
| `GET /api/metrics`    | Prometheus text exposition (0.0.4)          | `text/plain` — counters + gauges        |

**Selected metrics:**
- `mastr_api_requests_total{class="ok|client_err|server_err"}` (counter, last hour)
- `mastr_api_open_bugs` (gauge)
- `mastr_api_active_tokens` (gauge)
- `mastr_anlagen_total` (gauge: 81 832)
- `mastr_anlagen_owned` (gauge: currently worked)
- `mastr_reminders_pending` (gauge)
- `mastr_memory_rss_bytes` (gauge)

Prometheus scrape config:
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

- Issues / bugs: send a note inside the UI to `@admin`
- Production incidents: oncall@mastr-solar (internal)
- API status: `GET /api/health` (HTTP 200 + `{"ok":true}` when everything runs)
