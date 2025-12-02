# JL Kundenliste

Moderne Web-Anwendung zur Verwaltung und Analyse von Solaranlagen-Daten aus dem Marktstammdatenregister (MaStR).

## Live URL

🌐 **https://JL-Kundenliste.up.railway.app**

## Features

- 🔐 Passwortgeschützt (Passwort: 7715)
- 👥 Maximal 2 gleichzeitige Benutzer
- 📊 Moderne Dashboard-Ansicht mit Statistiken
- 🔍 Erweiterte Filter- und Suchfunktionen
- 📱 Vollständig responsive Design
- ⚡ Schnelle Performance mit Bun Runtime

## Technologie-Stack

- **Runtime**: Bun
- **Database**: SQLite
- **Frontend**: Alpine.js + Tailwind CSS
- **Design**: Glassmorphism mit Gradient-Effekten

## Deployment auf Railway

Diese App ist für Railway.app optimiert.

### Custom Domain Setup

Nach dem Deployment auf Railway:
1. Gehe zu deinem Project → Settings
2. Unter "Domains" klicke auf "Generate Domain"
3. Ändere die Domain zu: `JL-Kundenliste`
4. Die finale URL wird sein: `https://JL-Kundenliste.up.railway.app`

### Lokaler Start

```bash
bun install
bun server.ts
```

Die App läuft dann auf `http://localhost:8080`

## Datenschutz

- Session-Timeout: 30 Minuten
- IP-basierte Zugriffskontrolle
- Sichere Cookie-basierte Authentifizierung
