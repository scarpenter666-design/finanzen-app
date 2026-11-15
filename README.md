# Meine Finanzen

Einnahmen, Ausgaben und Fixkosten im Blick. Installierbare Web-App (PWA), gebaut mit dem `zimmermannki-pwa-template`.

- Die Daten liegen nur auf dem Gerät, verschlüsselt mit deinem Passwort.
- **Es gibt keine Hintertür.** Passwort weg heißt Daten weg. Mach regelmäßig ein Backup (**Mehr** → **Backup exportieren**) und schreib dir das Backup-Passwort auf.
- Backups der früheren App (Dateien mit `fin_…`) lassen sich einspielen. Der alte PIN wird dabei nicht übernommen.

## Lokal starten

Terminal im Ordner öffnen:

| System | Befehl |
|---|---|
| Windows | `py -m http.server 8000` |
| macOS, Linux | `python3 -m http.server 8000` |

Dann `http://localhost:8000` öffnen.

## Veröffentlichen

1. Repo auf GitHub: **Settings** → **Pages** → **Source:** `GitHub Actions`.
2. Pushen. Unter **Actions** muss **Deploy** grün werden.
3. Eigene Subdomain `finanzen.zimmermannki.de`: Anleitung in `docs/eigene-subdomain.md`.

In `manifest.webmanifest` steht `"id": "/"`. Das passt nur zur eigenen Subdomain. Ohne Subdomain (Adresse `…github.io/finanzen-app/`) erscheint beim Deploy eine gelbe Warnung, und die `id` müsste `/finanzen-app/` heißen. **Vor der ersten echten Nutzung entscheiden und danach nie mehr ändern.**

## Aufbau

Wie im Template. App-spezifisch sind `js/app.js`, `css/app.css`, `index.html`, `app.config.js`, `manifest.webmanifest`, `icons/` und `vendor/chart.umd.js` (Chart.js 4.4.1, MIT-Lizenz).

Regeln und Hintergründe: `docs/UEBERGABE.md` im Template-Repo.
