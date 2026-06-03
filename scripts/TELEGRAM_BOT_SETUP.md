# Telegram-Bot-Setup

Schritt-für-Schritt-Anleitung, einen Telegram-Bot anzubinden, über den
ein Mitarbeiter aus Telegram heraus Anlagen-Aktionen ausführen kann.

## 1. Bestehenden Bot wählen

Es gibt bereits einen Pool eigener Bots. Wähle einen davon:

- **Nicht verwenden:** Bots mit Personen-/Frauennamen (Lilly etc.) — die
  sind für andere Use-Cases reserviert.
- **Empfohlen:** ein neutral benannter Bot (z. B. `solar_*_bot`, `crm_*_bot`).
- Bei BotFather (`@BotFather` → `/mybots`) den gewünschten Bot anklicken
  → **API Token** → kopieren.

Falls doch ein neuer Bot nötig wäre: `/newbot` bei BotFather, Username
neutral wählen (auf `bot` enden, kein Personen-/Frauenname).

Sicherheitshinweis: das Token niemals teilen. Mit dem Token hat jeder
vollen Zugriff auf den Bot.

## 2. Token im CRM hinterlegen

1. Im CRM einloggen → **Profil → Telegram-Settings → Bot-Token**
2. Token einfügen, **Speichern**
3. **Test** klicken → erwartete Antwort: `{ ok: true, bot: { username: "…" } }`
   - Bei `ok=false`: Token prüfen (BotFather erneut konsultieren)

## 3. Chat verbinden (eigene chat_id lernen)

Der Bot weiß noch nicht, mit welchem Chat er sprechen soll. Erstkontakt:

1. In Telegram den eigenen Bot per Username öffnen (`@solar_db_…_bot`)
2. `/start` senden
3. Der nächste Poll-Lauf (alle 30 s) erkennt den Erstkontakt und
   speichert die `chat_id` automatisch in der Datenbank.
4. Bot antwortet mit der Befehlsliste — Setup ist fertig.

Notfalls manuell auslösen (Admin): `POST /api/settings/telegram-bot/poll-now`.

## 4. systemd-Service auf der VPS

Beide Files liegen in `scripts/`. Auf der VPS deployen:

```bash
sudo cp /opt/mastr-solar/app/scripts/mastr-solar-telegram.service /etc/systemd/system/
sudo cp /opt/mastr-solar/app/scripts/mastr-solar-telegram.timer   /etc/systemd/system/

sudo systemctl daemon-reload
sudo systemctl enable --now mastr-solar-telegram.timer
```

Status prüfen:

```bash
systemctl status mastr-solar-telegram.timer
systemctl status mastr-solar-telegram.service
journalctl -u mastr-solar-telegram.service -n 20 --no-pager
```

Timer-Konfiguration:
- `OnBootSec=30s` — erstes Polling 30 s nach Boot
- `OnUnitActiveSec=30s` — alle 30 s erneut
- `RandomizedDelaySec=5` — kleine Jitter, vermeidet exakte Sekundengrenzen

Ein Lauf dauert je nach Anzahl konfigurierter Bot-User ~0,5–2 s.

## 5. Verfügbare Befehle

Sobald die `chat_id` gespeichert ist, akzeptiert der Bot folgende Commands:

| Command | Beschreibung | Beispiel |
|---|---|---|
| `/help` | Befehlsübersicht | `/help` |
| `/me` | Eigene Account-Info (Username, Rolle, E-Mail) | `/me` |
| `/find <suchbegriff>` | Anlagen suchen, max. 5 Treffer | `/find Mustermann` |
| `/status <mastr> <status>` | Anlagen-Status setzen | `/status SEE945123 kontaktiert` |
| `/note <mastr> <text>` | Notiz an Anlage anhängen | `/note SEE945123 Termin nächste Woche` |

Erlaubte Status: `neu`, `kontaktiert`, `nicht_erreicht`, `terminiert`,
`interessiert`, `nicht_interessiert`, `abgeschlossen`, `verloren`, `spam`.

Notizen erscheinen mit Präfix `📱 [Telegram]` und werden mit `source: telegram`
markiert (sichtbar im Activity-Log).

## 6. Berechtigungen

- **Viewer-Accounts** können den Bot NICHT für Schreib-Commands nutzen
  (Bot antwortet mit „Viewer-Accounts dürfen keine Schreib-Commands ausführen").
- **Mitarbeiter & Admin** können alle Commands ausführen — Aktionen
  werden mit ihrer User-ID geloggt.
- Jeder User hat einen eigenen Bot. Es gibt keinen geteilten Bot.

## 7. Fehlersuche

| Symptom | Mögliche Ursache | Fix |
|---|---|---|
| `getMe` antwortet `Unauthorized` | Token falsch / Bot gelöscht | Bei BotFather neuen Token holen |
| Erstkontakt führt zu „nicht autorisiert" | `chat_id` bereits gesetzt, andere Telegram-Person schreibt | Andere Person bittet User, sie nicht zu nutzen — oder Admin setzt `telegram_chat_id = NULL` und Polling lernt neu |
| Befehle werden nicht ausgeführt | Timer nicht aktiv | `systemctl status mastr-solar-telegram.timer` prüfen |
| Bot antwortet doppelt | Mehrere Service-Instanzen | `systemctl stop` auf allen außer einer |
| Long-Poll-Konflikt (`409 Conflict`) | Anderer Prozess pollt parallel | Nur EINE Polling-Instanz pro Bot-Token |

## 8. Sicherheitsbetrachtung

- Bot-Token werden in `users.telegram_bot_token_enc` **AES-verschlüsselt** gespeichert
  (Master-Key in `.master.key`, niemals committen).
- Nachrichten nur aus der gespeicherten `chat_id` werden verarbeitet.
- Erstkontakt-Check unterscheidet `/start` (autorisiert das Senden des
  ersten anonymen Senders als Owner) von beliebigem Text (lehnt ab).
- Audit-Trail: jeder ausgeführte Befehl erzeugt einen Activity-Eintrag
  mit `metadata.source = "telegram"`.

## 9. Migration ohne Restart

Die `users.telegram_last_update_id` Spalte wird durch `ensureTelegramOffsetColumn()`
beim nächsten Server-Start angelegt. Falls die App schon läuft, einmaliger Trigger:

```bash
bun -e '
import { Database } from "bun:sqlite";
import { runMigrations } from "./lib/migrations";
const db = new Database(process.env.DB_PATH || "mastr-solar.db");
const fresh = runMigrations(db);
console.log("Applied:", fresh);
db.close();
'
```
