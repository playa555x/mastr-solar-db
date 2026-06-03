# mastr-solar API — Guide d'intégration

> État : 2026-05-17
> URL de base en production : `https://mastr-solar.51.195.86.119.nip.io`
> Content-Type : `application/json; charset=utf-8` (sur tous les endpoints sauf l'export CSV, l'accept/decline ICS et les uploads multipart)

Cette documentation s'adresse aux développeurs qui souhaitent intégrer un système externe (CRM, ERP, Zapier/n8n, script personnalisé, outil BI, plateforme marketing) à mastr-solar. Elle décrit l'authentification, les conventions, tous les endpoints pertinents et les workflows typiques avec des exemples exécutables.

---

## 1. Démarrage rapide

> **Important :** les développeurs externes **ne peuvent pas s'auto-inscrire**. Les jetons sont délivrés exclusivement par l'**administrateur** mastr-solar selon un processus contrôlé. Tu reçois ton jeton par un canal sécurisé (e-mail chiffré, lien gestionnaire de mots de passe, remise en main propre) — pas via cette documentation.

```bash
# 1. Jeton reçu de l'administrateur ? Tu peux y aller :

curl -H "Authorization: Bearer msolar_xxxxxxxxxxxxxxxxxxxxxxxx" \
  "https://mastr-solar.51.195.86.119.nip.io/api/anlagen?limit=5&owner=me"
```

### Comment l'admin émet un jeton

Dans l'UI : **Paramètres → Accès API → « + Nouvelle clé API »**
1. Nom descriptif (p. ex. « Acme GmbH — pont n8n »)
2. Choisir un scope (`read` / `write` / `full`)
3. Date d'expiration optionnelle
4. Le jeton en clair est affiché **une seule fois** et remis au développeur par un canal sécurisé

### Supervision admin et transparence

Chaque jeton API apparaît dans *Paramètres → Accès API* avec :

| Champ          | Signification                                                              |
|----------------|----------------------------------------------------------------------------|
| Nom            | descriptif, donné par l'admin — p. ex. client + système                    |
| Scope          | `read` / `write` / `full`                                                  |
| Préfixe        | 14 premiers caractères (pour l'identification, le reste est secret)         |
| Créé           | date + admin émetteur                                                      |
| Dernier usage  | horodatage de la dernière requête réussie                                  |
| **Dernière IP** | IP de la requête la plus récente — important pour la détection d'anomalies|
| Requêtes       | total depuis la création                                                   |
| Statut         | `actif` ou `révoqué` (avec date de révocation + admin responsable)         |

**Révocation :** clic « révoquer » dans l'UI ou `DELETE /api/admin/api-tokens/:id`. Effet immédiat — la requête suivante avec ce jeton renvoie HTTP 401.

Réponse réussie :

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

## 2. Authentification

mastr-solar accepte deux méthodes d'authentification. Les systèmes externes utilisent la **méthode A (jeton API)**.

### A. Jeton Bearer (pour les systèmes externes)

En-tête : `Authorization: Bearer msolar_<token>`

- Les jetons sont créés dans l'UI par un **administrateur** dans *Paramètres → Accès API*
- Format : `msolar_<43 caractères base64url>` (50 caractères au total)
- Le texte en clair n'est affiché **qu'une seule fois** à la création — ensuite seul le hash SHA-256 est conservé en base
- Les jetons peuvent être révoqués (effet immédiat)
- `request_count` et `last_used_at` sont journalisés par jeton
- Les jetons peuvent avoir une date d'expiration (`expires_at`)

### B. Cookie de session (pour les utilisateurs navigateur)

En-tête : `Cookie: session=<token>`
Posé automatiquement après `POST /api/auth/login` (`HttpOnly`, `Secure`, `SameSite=Lax`). Non recommandé pour les systèmes externes.

### Jeton manquant ?

```http
HTTP/1.1 401 Unauthorized
Content-Type: application/json

{"error":"Nicht autorisiert","code":"UNAUTHORIZED","message":"Nicht autorisiert"}
```

### Scope insuffisant ?

```http
HTTP/1.1 403 Forbidden

{"error":"Scope 'read' erlaubt diese HTTP-Methode nicht (POST)","code":"FORBIDDEN","message":"..."}
```

### Limite de débit dépassée ?

```http
HTTP/1.1 429 Too Many Requests
Retry-After: 1

{"error":"Rate limit: max 10 requests/second per token","code":"RATE_LIMITED","retry_after":1}
```

**Limites par jeton :** **10 requêtes/seconde** et **600 requêtes/minute**. Au-delà, le serveur répond 429 avec en-tête `Retry-After`.

---

## 3. Règle de visibilité pour les jetons API (important !)

> **Les clients à jeton API ne voient QUE les installations attribuées à un collaborateur (`owner_id IS NOT NULL`).**

Afin d'empêcher les systèmes externes d'aspirer la totalité du registre Marktstammdaten, les endpoints de lecture sont restreints pour l'authentification par jeton :

| Endpoint                            | Visibilité pour les clients à jeton                              |
|-------------------------------------|------------------------------------------------------------------|
| `GET /api/anlagen`                  | uniquement les installations avec `owner_id IS NOT NULL`        |
| `GET /api/anlagen/:id`              | 404 si l'installation n'a pas de propriétaire                   |
| `GET /api/anlagen/:id/related`      | uniquement les installations sœurs déjà traitées                |
| `GET /api/anlagen/:id/neighbors`    | uniquement les installations voisines déjà traitées             |
| `GET /api/kunden`                   | uniquement les clients ayant ≥ 1 installation traitée           |
| `GET /api/kunden/:mastr`            | `anlagen[]` ne contient que les éléments traités ; 404 si aucun |
| `GET /api/map/markers`              | uniquement les installations traitées                            |

**Comment une installation devient-elle « traitée » ?** Dès qu'un utilisateur de mastr-solar effectue l'une des actions suivantes, il devient automatiquement propriétaire (`autoAssignOwner` / `autoAssignOwnerForBetreiber`) :

- Ajouter une note (sur l'installation ou sur le client)
- Changer le statut (p. ex. déplacement Kanban de « neu » vers « kontaktiert »)
- Créer un rappel
- Journaliser un appel
- Ajouter un commentaire/e-mail à l'installation

**La simple consultation ne change rien.** Même un utilisateur navigateur qui clique sur une installation sans rien saisir NE devient PAS propriétaire. L'indicateur de propriété sert donc de signal fiable « activement traité ».

**Les opérations d'écriture ne sont pas restreintes** — quiconque connaît un `id` valide peut s'approprier un enregistrement via `POST /api/anlagen/:id/notizen` ou `PUT /api/anlagen/:id { "status": "..." }`, le rendant ainsi visible pour les lectures suivantes. C'est intentionnel.

---

## 4. Scopes

| Scope    | Méthodes HTTP autorisées                       | Ce qu'il peut faire                                                                  |
|----------|------------------------------------------------|---------------------------------------------------------------------------------------|
| `read`   | `GET`, `HEAD`, `OPTIONS`                       | Lecture de toutes les données hors zone admin                                         |
| `write`  | `read` + `POST`, `PUT`, `PATCH`, `DELETE`      | Créer/modifier installations, clients, rappels, notes — **pas** d'admin/users/import |
| `full`   | tout                                            | Comme admin : gestion des jetons, CRUD users, contrôle de l'import MaStR, audit log  |

Préfixes réservés à l'admin (toujours 403 pour `read`/`write`) :

- `/api/admin/*`
- `/api/users` (list/create/update/delete)
- `/api/import/*`
- `/api/audit-log`

---

## 5. Conventions

| Sujet              | Règle                                                                                                   |
|--------------------|----------------------------------------------------------------------------------------------------------|
| Encodage           | UTF-8 pour les corps de requête et de réponse                                                            |
| Date/heure         | ISO-8601 avec fuseau (`2026-05-17T08:30:00Z`). Dates simples au format `YYYY-MM-DD`.                     |
| Fuseau horaire     | Le serveur stocke en UTC. L'UI affiche en Europe/Berlin.                                                 |
| Flottants          | Point décimal, pas de séparateur de milliers (`750.5` pour 750,5 kWp)                                    |
| Booléens           | Champs DB typiquement `0`/`1`. JSON accepte `true`/`false` et `0`/`1`.                                   |
| IDs                | Numériques, croissants (`anlage.id`, `user.id`, `reminder.id`).                                          |
| Numéro MaStR       | Chaîne alphanumérique (`SEE918732FX91...`). Clé externe stable pour installations et exploitants.        |
| Pagination         | `?page=1&limit=50` (mode offset) ou `?after=<id>&limit=50` (mode curseur, stable sur listes croissantes). Max `limit=200`. |
| Tri                | `?sortBy=<champ>&sortDir=asc|desc`. Champs autorisés documentés par endpoint.                            |
| Chaînes vides      | Souvent interprétées comme `null` en PUT. Mettez explicitement `null` pour vider un champ.                |
| Verrou optimiste   | Non supporté. « Last write wins » — pour les écritures concurrentes critiques, utiliser la protection d'owner. |

### Format d'erreur

Toutes les erreurs retournent du JSON avec `error`, `code` et `message`. Utiliser `code` pour le traitement machine.

```json
{
  "error": "betreiber_mastr fehlt",
  "code": "BAD_REQUEST",
  "message": "betreiber_mastr fehlt"
}
```

**Codes HTTP + codes :**

| Statut | Code                    | Signification                                          |
|--------|-------------------------|--------------------------------------------------------|
| 400    | `BAD_REQUEST`           | Paramètre manquant/invalide                            |
| 401    | `UNAUTHORIZED`          | Non authentifié (jeton manquant/invalide)              |
| 403    | `FORBIDDEN`             | Authentifié, mais sans autorisation                    |
| 403    | `ADMIN_NOT_API`         | Jeton API tente d'atteindre un endpoint admin          |
| 403    | `ADMIN_REQUIRED`        | Admin (cookie auth) requis                             |
| 404    | `NOT_FOUND`             | Ressource introuvable                                  |
| 409    | `IDEMPOTENCY_KEY_REUSE` | Même clé idempotency avec body différent               |
| 422    | `VALIDATION_FAILED`     | Validation de schéma échouée                           |
| 429    | `RATE_LIMITED`          | Limite dépassée (login OU jeton)                       |
| 500    | `INTERNAL_ERROR`        | Erreur serveur                                         |
| 503    | `SERVICE_UNAVAILABLE`   | Service temporairement indisponible                    |

---

### En-têtes de requête globaux (optionnels)

| En-tête                 | S'applique à     | Objet                                                                  |
|-------------------------|------------------|------------------------------------------------------------------------|
| `Authorization: Bearer` | tous             | Auth par jeton API (section 2)                                         |
| `Idempotency-Key`       | POST/PUT/PATCH   | Éviter les doublons sur retry (cache 24h par token+key+body hash)      |
| `Content-Type`          | requêtes avec body | Toujours `application/json` (sauf uploads multipart)                  |

### Paramètres query globaux (optionnels)

| Paramètre   | S'applique à            | Effet                                                                 |
|-------------|-------------------------|-----------------------------------------------------------------------|
| `?lang=en`  | tous les endpoints liste | Ajoute des alias de champs anglais **en plus** des clés allemandes    |
| `?after=N`  | `GET /api/anlagen`      | Pagination par curseur : IDs > N, triés `id ASC`                       |

### Modes de pagination

**Mode offset** (par défaut) :
```json
{
  "data": [...],
  "pagination": { "mode": "offset", "page": 2, "limit": 50, "total": 1234, "pages": 25 }
}
```

**Mode curseur** (`?after=`) :
```json
{
  "data": [...],
  "pagination": { "mode": "cursor", "limit": 50, "returned": 50, "next_cursor": 1234, "has_more": true }
}
```

**Quand utiliser quoi ?** Page+limit pour les listes UI (« page 5 sur 25 »). Curseur pour itération bulk stable — pas de doublons ni de lacunes sur inserts concurrents.

### Clés d'idempotence

POST/PUT/PATCH avec l'en-tête `Idempotency-Key: <uuid>` sont mis en cache 24 h. Même clé + même body → réponse cachée (en-tête `X-Idempotent-Replay: true`), même clé + body différent → `409 IDEMPOTENCY_KEY_REUSE`.

```bash
KEY=$(uuidgen)
curl -X POST -H "Authorization: Bearer ..." \
  -H "Idempotency-Key: $KEY" \
  -H "Content-Type: application/json" \
  -d '{"betreiber_mastr":"ABR...","due_at":"2026-05-25T09:00:00Z"}' \
  https://mastr-solar.51.195.86.119.nip.io/api/reminders
# En cas d'erreur réseau, retry avec la même clé.
```

### Versionnage

Chaque endpoint est accessible sur `/api/<path>` (courant) et `/api/v1/<path>` (alias).
Avant tout breaking change, `/api/v2/` sera proposé en parallèle — les intégrations existantes gardent `/api/v1/` pendant au moins 6 mois.

---

## 6. Référence des endpoints

### 6.1 Auth & profil

#### `POST /api/auth/login`
Login navigateur. Les systèmes externes n'en ont **pas** besoin — ils utilisent les jetons API. Retourne un cookie HttpOnly.

Body : `{ "username": "...", "password": "...", "totp_code": "123456"? }`
Réponse : `{ "success": true }` + cookie

Rate limit : 5 tentatives / minute / IP.

#### `POST /api/auth/logout` · `GET /api/auth/me`
Logout invalide la session. `/api/auth/me` retourne l'utilisateur courant.

#### `GET /api/me/profile`
Retourne les données personnelles et préférences de l'utilisateur appelant.

```json
{
  "id": 3, "username": "schmidt", "email": "schmidt@firma.de",
  "display_name": "Lars Schmidt", "color": "#06b6d4",
  "phone": "+49 …", "bio": "Commercial DACH",
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
Whitelist : `display_name`, `email`, `color`, `phone`, `bio`, `pref_default_tab`, `pref_reminder_snooze_min`, `pref_anlagen_sort`, `pref_map_marker_mode`, `pref_quiet_hours_start`, `pref_quiet_hours_end`, `pref_locale`, `pref_default_filter`.
Validation : enums, format HH:MM pour les heures calmes, regex e-mail, snooze 5–10080 min.
Réponse : `{ "success": true }`.

#### `POST /api/me/password`
```json
{ "current_password": "ancien", "new_password": "nouveau_min_6_caracteres" }
```
En cas de succès, **toutes les autres sessions** de l'utilisateur sont invalidées (la session cookie courante est conservée).

---

### 6.2 Installations (centrales PV)

Entité centrale. Une installation appartient à exactement un exploitant (`betreiber_mastr`). Elle peut être attribuée à un utilisateur (`owner_id`).

#### `GET /api/anlagen`
Liste des installations avec filtre + pagination.

| Query              | Type    | Exemple               | Signification                                                          |
|--------------------|---------|-----------------------|------------------------------------------------------------------------|
| `search`           | string  | `Schmidt`             | Recherche plein texte sur name, betreiber_name, ort, plz, email, telefon |
| `bundesland`       | string  | `Bayern`              | Correspondance exacte                                                  |
| `status`           | string  | `neu`                 | `neu` / `kontaktiert` / `bearbeitet` / `interessiert` / `nicht_interessiert` / `abgeschlossen` |
| `mit_kontakt`      | string  | `ja` / `nein`         | Filtre par présence de contact (email ou téléphone)                    |
| `leistung_min`     | number  | `100`                 | Borne inférieure kWp                                                   |
| `leistung_max`     | number  | `5000`                | Borne supérieure kWp                                                   |
| `datum_von`        | date    | `2010-01-01`          | Mise en service à partir de                                            |
| `datum_bis`        | date    | `2020-12-31`          | Mise en service jusqu'à                                                |
| `owner`            | string  | `me` / `42` / `unassigned` | Propriétaire (`me` = l'utilisateur appelant)                       |
| `sortBy`           | enum    | `lead_score`          | `nettonennleistung` / `inbetriebnahme` / `name` / `ort` / `bundesland` / `lead_score` |
| `sortDir`          | string  | `desc`                | `asc` / `desc`                                                         |
| `page`             | int     | `1`                   | à partir de 1                                                          |
| `limit`            | int     | `50`                  | 1–200, défaut 50                                                       |
| `after`            | int     | `1234`                | Pagination par curseur (alternative à `page`) — voir section 5         |
| `lang`             | string  | `en`                  | Ajoute des alias en anglais aux clés (`name`/`city`/...)               |

Réponse (abrégée) :

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

> **Note (clients à jeton) :** la réponse ne contient que les installations avec `owner_id IS NOT NULL`. Voir section 3.

#### `GET /api/anlagen/:id`
Retourne une installation **plus** les sous-ressources agrégées nécessaires au panneau de détail :

```json
{
  "id": 1234, ... (tous les champs comme ci-dessus),
  "notizen_liste": [ { "id": 12, "text": "...", "scope": "anlage|betreiber", "user_id": 3, "created_at": "..." } ],
  "sent_emails":   [ { "id": 5, "subject": "...", "to_addr": "...", "sent_at": "..." } ],
  "termine":       [ { "id": 7, "title": "RDV sur site", "start_ts": 1716000000000, ... } ],
  "activities":    [ { "type": "status_change", "description": "Status: neu → kontaktiert", "user_id": 3, "created_at": "..." } ],
  "messages":      [ /* commentaires directs */ ],
  "calls":         [ { "id": 4, "direction": "out", "started_at": "...", "duration_sec": 312 } ],
  "related_anlagen": [ /* autres installations du même exploitant */ ],
  "reminders":     [ /* rappels */ ],
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

Options de requête :

- `?module_wp=720` — remplace le `repowering_module_wp` global pour cette réponse et calcule le repowering pour cette taille de module.

#### `PUT /api/anlagen/:id`
Mettre à jour une installation. Whitelist :

`name`, `betreiber_name`, `strasse`, `hausnummer`, `plz`, `ort`, `bundesland`, `landkreis`, `gemeinde`, `breitengrad`, `laengengrad`, `bruttoleistung`, `nettonennleistung`, `anzahl_module`, `inbetriebnahme`, `energietraeger`, `anlagentyp`, `lage_einheit`, `hauptausrichtung`, `hauptausrichtung_neigungswinkel`, `modulhersteller`, `wechselrichterhersteller`, `wechselrichter_anzahl`

Aussi accepté :

- `status` — déclenche une entrée dans le journal d'activité + `autoAssignOwner`
- `notizen` — champ libre de note sur l'installation (déprécié ; préférer `notizen_liste`)
- `owner_id` — modifiable uniquement par le propriétaire actuel ou un admin ; si propriétaire `NULL`, n'importe qui peut le poser (claim)

#### `POST /api/anlagen/:id/notizen`
Créer une note sur une installation.
```json
{ "text": "Appel téléphonique du 17 mai — intéressé, RDV la semaine prochaine.", "scope": "anlage" | "betreiber" }
```
`scope=betreiber` écrit une note client globale qui apparaît pour toutes les installations de l'exploitant.
Auto : `autoAssignOwner` (si l'installation n'a pas de propriétaire), notifications `@mention`.

#### `DELETE /api/notizen/:id`
Supprime une note.

#### `GET /api/anlagen/:id/related`
Autres installations du même exploitant.

#### `GET /api/anlagen/:id/neighbors?radius=2`
Installations dans un rayon de `radius` km (Haversine). Défaut 1.

#### `POST /api/anlagen/:id/refine-location`
Recherche dans OSM Overpass les polygones réellement étiquetés solaire autour des coordonnées et positionne `breitengrad`/`laengengrad` au centroïde de la meilleure correspondance. Renseigne aussi `position_refined_at`, `position_refined_distance_m`, `position_osm_ref`.

#### `POST /api/anlagen/:id/email`
Envoi d'un e-mail depuis le compte SMTP personnel de l'appelant avec suivi (pixel d'ouverture).
```json
{
  "to": "kunde@firma.de",
  "subject": "Potentiel de repowering de votre installation",
  "body_html": "<p>Bonjour …</p>",
  "template_id": 4?,           // optionnel : charger un template
  "attachment_ids": [12, 17]?, // optionnel
  "termin": { "start": "2026-06-01T10:00:00Z", "end": "2026-06-01T11:00:00Z", "title": "Sur site" }? // ICS optionnel
}
```
La réponse contient `sent_email_id` pour consulter le statut ultérieurement.

#### `GET /api/anlagen/:id/quote`
PDF (devis préliminaire) en téléchargement.

#### `GET /api/anlagen/:id/gdpr-export`
Export JSON de toutes les données personnelles liées à une installation (article 15 RGPD).

#### `POST /api/anlagen/:id/rescore`
Recalcule le lead score d'une installation.

#### `POST /api/anlagen/:id/geocode`
Géocodage d'une installation via Nominatim.

---

### 6.3 Clients (exploitants)

Un client = un `betreiber_mastr` unique. Résolu de manière unique via le numéro de registre Marktstammdaten.

#### `GET /api/kunden?q=<recherche>&limit=500`
Liste agrégée des clients avec nombre d'installations, puissance totale, rappels ouverts.

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
Détail avec `betreiber`, `anlagen[]`, `notizen[]` (notes client et installation combinées), `reminders[]`, `calls[]`.

#### `POST /api/kunden/:mastr/notizen`
Écrire une note client (s'applique à toutes les installations de l'exploitant).
```json
{ "text": "Le dirigeant M. Mustermann est décideur. Préfère les appels le matin." }
```
Auto : `autoAssignOwnerForBetreiber` s'approprie toutes les installations sans propriétaire.

#### `GET /api/betreiber/by-mastr/:mastr`
Données brutes de l'exploitant (master data sans agrégation).

#### `PUT /api/betreiber/by-mastr/:mastr`
Mettre à jour les coordonnées de l'exploitant. Whitelist : `name`, `email`, `telefon`, `fax`, `website`, `strasse`, `hausnummer`, `plz`, `ort`, `land`, `rechtsform`.

---

### 6.4 Rappels (Reminders)

Tâches avec date d'échéance, toujours ancrées à un client (`betreiber_mastr`). Contrôlées toutes les 5 minutes par un timer systemd et distribuées par e-mail/Telegram.

#### `GET /api/reminders?status=pending&betreiber_mastr=ABR...&limit=200`
- `status` : `pending` (défaut) / `done` / `snoozed` / `all`

#### `GET /api/reminders/today`
Rappels dus aujourd'hui.

#### `POST /api/reminders`
```json
{
  "betreiber_mastr": "ABR987654...",
  "due_at": "2026-05-20T09:00:00Z",
  "note": "Relancer suite à l'offre",
  "owner_user_id": 3  // optionnel ; défaut = utilisateur appelant
}
```
Auto : `autoAssignOwnerForBetreiber`.

#### `PATCH /api/reminders/:id`
Mise à jour / actions :
```json
{ "action": "done" }
{ "action": "snooze", "until": "2026-05-21T10:00:00Z" }
{ "due_at": "2026-05-25T08:00:00Z", "note": "nouveau texte", "owner_user_id": 5 }
```

#### `DELETE /api/reminders/:id`
Supprime un rappel.

#### `GET /api/reminders/calendar?from=...&to=...`
Format d'événement FullCalendar (requête de plage).

---

### 6.5 Rendez-vous (calendrier)

#### `GET /api/termine?from=YYYY-MM-DD&to=YYYY-MM-DD`
Rendez-vous dans la plage. Retourne des événements compatibles FullCalendar incluant le statut RSVP.

#### `POST /api/termine`
```json
{
  "anlage_id": 1234,
  "title": "RDV sur site Solar Park Mustermann",
  "description": "Relevé de toiture",
  "location": "Hauptstr. 12, 82166 Gräfelfing",
  "start_ts": "2026-06-01T10:00:00Z",
  "end_ts":   "2026-06-01T11:30:00Z",
  "attendee_email": "kunde@mustermann.de",
  "attendee_name":  "Hans Mustermann"
}
```
Envoie automatiquement une invitation ICS à `attendee_email` si SMTP est configuré.

#### `PUT/DELETE /api/termine/:id`
Lors d'une mise à jour des mises à jour ICS sont envoyées (compteur de séquence automatique).

#### `GET /api/termine/accept?token=...` / `GET /api/termine/decline?token=...`
Endpoints publics pour RSVP depuis e-mail (sans auth, jeton unique par rendez-vous).

---

### 6.6 Appels

Journalisation manuelle des appels + résumé IA optionnel.

#### `GET /api/anlagen/:id/calls`
#### `POST /api/anlagen/:id/calls`
```json
{
  "direction": "out" | "in",
  "started_at": "2026-05-17T08:30:00Z",
  "duration_sec": 312,
  "outcome": "interessiert" | "kein_interesse" | "termin_vereinbart" | "rueckruf" | ...,
  "notes": "M. Mustermann est intéressé par le repowering."
}
```

#### `PATCH /api/calls/:id` · `POST /api/calls/:id/summary`
Mise à jour ou génération d'un résumé IA (utilise le provider IA configuré de l'appelant).

---

### 6.7 Workflow e-mail

Les systèmes externes peuvent réutiliser le moteur mail de mastr-solar.

| Méthode              | Path                                | Objet                                    |
|----------------------|-------------------------------------|------------------------------------------|
| GET/PUT/POST         | `/api/settings/smtp`                | Compte SMTP + signature de l'appelant    |
| `POST`               | `/api/settings/smtp/test`           | E-mail de test à sa propre adresse       |
| GET/PUT/POST         | `/api/settings/imap`                | Polling boîte de réception IMAP          |
| `POST`               | `/api/settings/imap/poll-now`       | Poller immédiatement                     |
| GET/POST             | `/api/email-templates`              | CRUD des templates                       |
| GET/POST             | `/api/attachments`                  | Upload multipart jusqu'à 10 Mo           |
| `GET`                | `/api/replies`                      | Réponses entrantes appariées             |
| `GET`                | `/api/sent-emails/:id/events`       | Tracking : opened, clicked, bounce       |

Envoi → voir `POST /api/anlagen/:id/email` (6.2).

---

### 6.8 Commentaires directs & DMs

Discussion interne sur une installation et messages directs entre utilisateurs.

| Méthode  | Path                                | Objet                                    |
|----------|-------------------------------------|------------------------------------------|
| GET/POST | `/api/anlagen/:id/comments`         | Fil de commentaires (avec `@mention`)    |
| `DELETE` | `/api/comments/:id`                 | Supprimer un commentaire                 |
| `GET`    | `/api/dm/threads`                   | Ses propres fils DM                      |
| `GET/POST` | `/api/dm/:userId`                 | Conversation avec un utilisateur précis  |

---

### 6.9 Notifications

#### `GET /api/notifications`
Liste in-app de ses notifications (mention, dm, assignment, reminder).

#### `POST /api/notifications/:id/read` · `POST /api/notifications/read-all`

#### `GET/PUT /api/settings/notifications`
Activable par type (`mention`, `dm`, `assignment`, `reminder`) et canal (`email`, `telegram`).
Les heures calmes proviennent du profil utilisateur (`pref_quiet_hours_start/end`).

---

### 6.10 Dashboard & stats

#### `GET /api/dashboard`
Données agrégées de la page d'accueil :

```json
{
  "quick_stats": { "total_anlagen": 81832, "my_open": 5, "due_today": 2, "unread_notifications": 0, "open_termine": 3 },
  "reminders_today": [...],
  "termine_today":   [...],
  "recent_notifications": [...],
  "recent_activities":    [...],
  "top_leads":            [...],
  "funnel":               [ { "status": "neu", "count": 81831 }, ... 6 entrées ... ]
}
```

#### `GET /api/stats` · `GET /api/bundeslaender` · `GET /api/today`
Stats agrégées classiques ; `/today` contient rappels dus + rendez-vous du jour.

#### `GET /api/reporting/kpis?from=YYYY-MM-DD&to=YYYY-MM-DD`
Reporting KPI (conversion, valeur du pipeline, etc.).

#### `GET /api/map/markers?bbox=south,west,north,east`
Marqueurs cartographiques pour une bounding box. Utilisé par l'onglet carte.

---

### 6.11 Campagnes (e-mail séquencé)

| Méthode  | Path                                       | Objet                                    |
|----------|--------------------------------------------|------------------------------------------|
| GET/POST | `/api/campaigns`                           | Liste + création                         |
| GET/PUT/DELETE | `/api/campaigns/:id`                 | Détails                                  |
| `POST`   | `/api/campaigns/:id/(start\|pause\|resume)` | Contrôle                                |
| `GET`    | `/api/campaigns/:id/recipients`            | Liste des destinataires + statut         |
| `GET`    | `/api/campaigns/:id/ab-stats`              | Évaluation A/B                           |
| `POST`   | `/api/campaigns/preview`                   | Dry-run d'un mail                        |

---

### 6.12 App settings (lecture) & paramètres admin

#### `GET /api/app-settings`
Tous les paramètres globaux pertinents calcul/visibilité (lisibles par tous les utilisateurs).

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
  "meta": [ { "key": "repowering_module_wp", "label": "Puissance module (repowering)", "unit": "Wp", "min": 400, "max": 900, "step": 10, "help": "…", "category": "calculation", "type": "number" }, ... ]
}
```

#### `GET/PUT /api/admin/app-settings` *(admin)*
Écrit les paramètres (avec validation contre `meta.min/max` et énum pour boolean).

---

### 6.13 Administration & gestion des utilisateurs

> Tous limités au scope `full` ou cookie admin.

| Méthode  | Path                                     | Objet                                            |
|----------|------------------------------------------|--------------------------------------------------|
| GET/POST | `/api/users`                             | Liste, créer un nouvel utilisateur               |
| PUT/DELETE | `/api/users/:id`                       | Master data / désactivation                      |
| `POST`   | `/api/users/:id/password`                | Définir le mot de passe d'un autre utilisateur (admin) |
| GET/POST | `/api/admin/api-tokens`                  | Liste de jetons, création de jeton               |
| `DELETE` | `/api/admin/api-tokens/:id`              | Révocation                                       |
| `GET`    | `/api/audit-log`                         | Login/logout/CSV-export/changements 2FA          |
| `GET`    | `/api/import/status` · `/api/import/log` | Statut de l'import MaStR XML                     |
| `POST`   | `/api/import/run`                        | Déclenchement manuel d'import                    |
| `GET`    | `/api/enrich/status` · `/api/enrich/log` | Enrichissement des contacts                      |
| `POST`   | `/api/enrich/run`                        | Démarrer l'enrichissement                        |

#### Créer un jeton via l'API (admin / scope `full` uniquement)

> Réservé aux workflows admin (p. ex. provisionnement automatisé). L'endpoint exige un cookie admin ou un jeton Bearer avec scope `full`. Les développeurs externes n'y ont **pas** accès.

```bash
curl -X POST https://mastr-solar.51.195.86.119.nip.io/api/admin/api-tokens \
  -H "Authorization: Bearer msolar_<full-token>" \
  -H "Content-Type: application/json" \
  -d '{"name":"n8n-bridge","scope":"write","expires_at":"2027-01-01"}'

# Réponse (jeton affiché UNE SEULE FOIS !) :
# { "id": 7, "name": "n8n-bridge", "token": "msolar_xxx...", "scope": "write", ... }
```

---

### 6.14 Divers

| Méthode | Path                                     | Objet                                            |
|---------|------------------------------------------|--------------------------------------------------|
| `GET`   | `/api/2fa/status`                        | Statut TOTP de l'appelant                        |
| `POST`  | `/api/2fa/enable-start` · `/enable-verify` · `/disable` | Activation TOTP                |
| GET/POST/DELETE | `/api/drafts`                    | Brouillons personnels (stockage libre)           |
| GET/POST/DELETE | `/api/scripts`                   | Scripts d'appel                                  |
| `GET`   | `/api/onboarding/complete` · `/reset`    | Onboarding UI                                    |
| `GET`   | `/api/export/csv` *(admin)*              | Export CSV de toutes les installations           |

---

## 7. Workflows typiques

### A. Reprise de lead depuis un CRM externe

```text
1. Le CRM détecte une nouvelle installation PV → appelle GET /api/anlagen?search=<mastr>
2. Si match : PUT /api/anlagen/:id avec { "status": "kontaktiert", "owner_id": <user-id> }
3. POST /api/kunden/:mastr/notizen avec le texte de note du CRM
4. POST /api/reminders pour la relance
```

### B. Liste quotidienne de leads dans son propre outil BI

```bash
curl -H "Authorization: Bearer msolar_<read>" \
  "https://mastr-solar.../api/anlagen?owner=me&status=neu&sortBy=lead_score&sortDir=desc&limit=50"
```
Cron, ETL, terminé.

### C. Sync rappels avec Outlook/Google Calendar

```text
1. Cron toutes les 15 min : GET /api/reminders?status=pending&limit=500
2. Diff avec la dernière sync
3. Nouveaux rappels → créer événement CaldDAV, mémoriser l'ID
4. status=done dans mastr-solar → supprimer l'événement Outlook
```

### D. Substitut webhook : polling sur activité

mastr-solar **n'a actuellement pas de webhooks**. En attendant :

```bash
# Toutes les 60 secondes :
curl -H "Authorization: Bearer ..." \
  "https://.../api/anlagen?sortBy=lead_score&sortDir=desc&limit=200" \
  | jq '.data[] | select(.updated_at > "2026-05-17T00:00:00")'
```

Ou par installation : `GET /api/anlagen/:id` → le champ `activities[]` contient le journal des actions avec horodatage.

### E. Géocodage en masse après un bulk import propre

```bash
# 1. Trigger admin : géocoder les installations sans coordonnées
curl -X POST -H "Authorization: Bearer msolar_<full>" \
  https://.../api/geocode/batch

# 2. Statut par installation :
curl -H "Authorization: Bearer ..." https://.../api/anlagen/1234 \
  | jq '{ id, breitengrad, laengengrad, geocoded_at }'
```

### F. Analyse de repowering pour export de données

```bash
# Récupérer les données de repowering avec taille de module personnalisée
for id in 100 200 300 400 500; do
  curl -s -H "Authorization: Bearer ..." \
    "https://.../api/anlagen/$id?module_wp=720" \
    | jq '.economics'
done
```

### G. Reprise client avec claim de propriétaire

```bash
# La première action d'écriture d'un utilisateur dans le menu client s'approprie toutes les installations.
curl -X POST -H "Authorization: Bearer msolar_<write>" \
  -H "Content-Type: application/json" \
  -d '{"text":"Premier contact au salon Solar Hambourg 2026."}' \
  "https://.../api/kunden/ABR987654.../notizen"
# → autoAssignOwnerForBetreiber pose owner_id = utilisateur du jeton pour toutes les installations sans propriétaire.
```

---

## 8. Modèle de données (bref)

```text
users (id, username, email, display_name, color, is_admin, pref_*)
   └─ owns ─→ anlagen.owner_id

betreiber (mastr_nummer PK, name, email, telefon, website, adresse)
   └─ 1:N ─→ anlagen.betreiber_mastr

anlagen (id PK, mastr_nummer, betreiber_mastr FK, ...master data PV..., status, lead_score, owner_id, breitengrad, laengengrad)
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

Relations :

- **Client ≡ exploitant :** identité via `betreiber_mastr` (numéro de registre Marktstammdaten).
- **Une installation a exactement un propriétaire (`owner_id`)** au sens du workflow commercial. Le propriétaire est posé automatiquement à la première action d'écriture dans le menu client et n'est modifiable que par lui-même ou par un admin.
- **Les notes peuvent avoir un scope installation ou client** (champ `scope`).

---

## 9. Sécurité & exploitation

| Sujet                  | Détails                                                                                  |
|------------------------|-------------------------------------------------------------------------------------------|
| Transport              | HTTPS (Let's Encrypt, renouvellement auto). HTTP redirigé.                                |
| Login rate limit       | 5 tentatives/minute/IP. L'auth jeton n'a pas de rate limit (protection DoS au niveau nginx). |
| Stockage des jetons    | Texte en clair jamais persisté, seulement le hash SHA-256. Vol → `DELETE /api/admin/api-tokens/:id`. |
| Rotation des jetons    | Recommandé : tous les 90 jours. Poser `expires_at`, créer le nouveau jeton avant échéance.|
| Mots de passe          | bcrypt cost 10. Min 6 caractères. 2FA (TOTP) optionnelle par utilisateur.                 |
| RGPD                   | `GET /api/anlagen/:id/gdpr-export` pour la communication des données personnelles. Logs conservés 90 jours. |
| Audit log              | Login, logout, export CSV, changements 2FA, tentatives échouées.                          |
| Backups                | Snapshots SQLite quotidiens dans `/opt/mastr-solar/backups/` (côté serveur).              |

---

## 10. Exemples de clients

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
console.log(`${open.pagination.total} leads ouverts`);
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
print(f"{leads['pagination']['total']} leads ouverts")

api("POST", "/api/reminders", json={
    "betreiber_mastr": "ABR987654...",
    "due_at": "2026-05-25T09:00:00Z",
    "note": "Relancer — proposition de repowering envoyée le 17 mai."
})
```

### n8n / Zapier

- Node HTTP avec en-tête `Authorization: Bearer msolar_…`
- Endpoint par ex. `GET /api/anlagen?owner=me&status=neu`
- Schedule trigger toutes les X minutes
- Mapper la sortie via un set-node, puis envoyer à CRM/Sheet/Slack

---

## 11. Changelog

| Date        | Changement                                                                               |
|-------------|-------------------------------------------------------------------------------------------|
| 2026-05-17  | **Vague d'ajouts :** codes d'erreur structurés, `Retry-After` sur 429, paramètre `?lang=en` pour alias anglais, pagination par curseur `?after=`, clés d'idempotence, alias de version `/api/v1/`, `/api/healthz` + `/api/metrics`, OpenAPI 3.1 sur `/docs/openapi.yaml` |
| 2026-05-17  | Les clients à jeton API ne voient que `owner_id IS NOT NULL` (voir section 3)             |
| 2026-05-17  | Traductions anglaise + française (`/docs/API.en.md`, `/docs/API.fr.md`)                   |
| 2026-05-17  | Première publication de ce guide d'intégration                                            |
| 2026-05-16  | `/api/me/profile` + `/api/me/password` + 9 nouvelles préférences                          |
| 2026-05-16  | Protection du propriétaire : `PUT /api/anlagen/:id { owner_id }` 403 sauf owner/admin     |
| 2026-05-16  | `autoAssignOwnerForBetreiber` sur POST note client et POST reminder                       |
| 2026-05-15  | Reminders + API client + scopes de notes                                                  |
| 2026-05-15  | API app settings (calcul + visibilité)                                                    |
| 2026-05-15  | Système de jetons API (read/write/full)                                                   |

---

## 12. Roadmap (informatif)

Voir [`/docs/ROADMAP.md`](./ROADMAP.md) pour la liste exhaustive des éléments **délibérément non faits** (avec justification et déclencheurs de réévaluation) ainsi que les ADRs (Architecture Decision Records) sous-jacents.

Synthèse rapide (état au 2026-05-17) :

- **Webhooks** — sortie. Pour l'instant : polling (voir workflow D, section 7).
- **GraphQL** — sortie. La pagination par curseur + `?lang=en` couvrent les besoins actuels.
- **OAuth2** — sortie. Les jetons Bearer sont suffisants pour le périmètre actuel mono-tenant.
- **Réécriture DE→EN** — sortie. Les alias anglais via `?lang=en` sont additifs et stables.
- **Migration Postgres** — sortie. SQLite + WAL suffit largement (< 1 GB, < 100 RPS).

---

## 13. Santé & observabilité

Tous les endpoints suivants sont **publics** (sans auth), à l'usage des load-balancers, des sondes Prometheus et des dashboards de statut. Ils sont conçus pour être appelés fréquemment.

| Endpoint            | Objet                                                  | Format              |
|---------------------|--------------------------------------------------------|---------------------|
| `GET /api/health`   | Liveness : le process répond-il ?                      | `{"ok":true}`       |
| `GET /api/healthz`  | Readiness : DB joignable + migrations OK ?             | `{"ok":true,"db":"ok","migrations":"ok"}` |
| `GET /api/metrics`  | Métriques Prometheus (exposition format)               | `text/plain`        |

**Métriques exposées** (sélection) :

- `mastr_api_requests_total{method,path,status}` — compteur de requêtes API
- `mastr_api_request_duration_seconds_bucket{method,path,le}` — histogramme de latence
- `mastr_api_bugs_open` — nombre de bugs API non résolus (cf. section admin)
- `mastr_db_size_bytes` — taille du fichier SQLite
- `mastr_active_tokens` — jetons API actifs (non révoqués, non expirés)
- `process_resident_memory_bytes`, `process_cpu_seconds_total` — métriques runtime

Exemple de scrape config Prometheus :

```yaml
scrape_configs:
  - job_name: mastr-solar
    metrics_path: /api/metrics
    scheme: https
    static_configs:
      - targets: ['mastr-solar.51.195.86.119.nip.io']
```

---

## 14. Support

- Bugs / problèmes : envoyer une note dans l'UI à `@admin`
- Incidents prod : oncall@mastr-solar (interne)
- Statut API : `GET /api/health` (HTTP 200 + `{"ok":true}` si tout tourne)
