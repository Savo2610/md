# md.veerka.mp

Markdown-Dokumente zum Teilen, ohne Login. Ein Cloudflare Worker, ein Durable
Object pro Dokument, Bilder in R2.

- `md.veerka.mp` öffnet ein neues Dokument mit zufälliger, schwer erratbarer Adresse.
- `md.veerka.mp/irgendwas` öffnet das Dokument oder legt es beim ersten Tippen an.
- Bestehende Dokumente öffnen in der Ansicht. Bearbeitungsrechte gelten immer
  für ein einzelnes Dokument und werden im Browser gespeichert: wer es angelegt
  hat, wer den Bearbeiten-Link öffnet (startet direkt im Bearbeiten-Modus), oder
  wer im Dokument den 2FA-Code eingibt (⋯ → Mit Code freischalten).
- Adresse nachträglich ändern: ⋯ → Adresse ändern. Bilder und Bearbeiten-Links
  bleiben gültig. War die alte Adresse zufällig erzeugt, leitet sie weiter;
  selbst gewählte Namen werden wieder frei (keine Alias-Ketten).
- Einfügen über `/` am Zeilenanfang oder nach einem Leerzeichen: alle Blöcke
  und Auszeichnungen, die der Renderer kann.
- Klick auf „md“: neues Dokument und die zuletzt geöffneten (nur im Browser
  gespeichert, nichts auf dem Server).
- Mehrere Leute können gleichzeitig schreiben (Yjs über WebSockets).
- `md.veerka.mp/<id>.md` liefert das reine Markdown (für KI-Agenten, Download).
- `md.veerka.mp/admin`: alle Dokumente, Löschen, „Behalten“ (2FA-Code).

## Aufräumen und Spam

- Wer nur eine URL aufruft, legt nichts an. Erst die erste Eingabe erzeugt das
  Dokument, abgesichert mit unsichtbarem Turnstile und einem Rate-Limit pro IP.
- Rohes HTML wird nicht gerendert, Suchmaschinen sind ausgesperrt (`noindex`,
  `robots.txt`).
- Dokumente, die 12 Monate niemand geöffnet hat, verschwinden samt Bildern.
  Ausgenommen ist nur, was in der Übersicht (`/admin`) auf „Behalten“ steht.
- Zufällige Adressen haben 10 Zeichen (36^10 ≈ 3,7 · 10^15 Möglichkeiten).
- Grenzen: 1 Mio. Zeichen pro Dokument, Bilder max. 6 MB (werden im Browser auf
  1920 px / WebP verkleinert), 25 MB Bilder pro Dokument.

## Entwickeln

```bash
npm install
npm run dev        # http://localhost:8790 (Client-Build im Watch-Modus + wrangler dev)
npm test           # API-Tests gegen den laufenden Dev-Server
npm run typecheck
```

Lokale Secrets stehen in `.dev.vars` (nicht im Git): `TOTP_SECRET`,
`SESSION_SECRET`, `API_KEY`, `TURNSTILE_SECRET`. Lokal ist `TOTP_SECRET` ein
eigenes Test-Secret.

## Deploy

Jeder Push auf `main` geht über GitHub Actions live
(`.github/workflows/deploy.yml`: Typprüfung, Build, `wrangler deploy`).
Das Repo-Secret `CLOUDFLARE_API_TOKEN` stammt aus dem Cloudflare-Dashboard
(Workers → md → Settings → Builds → „API token for external CI/CD“) und darf
nur diesen Worker deployen.

Von Hand: `npm run deploy`. Secrets setzen: `npx wrangler secret put <NAME>`.
Live-Test ohne 2FA-Teil:
`MD_API_KEY=$(cat ~/.config/md/api-key) node tools/test-api.mjs https://md.veerka.mp`

## Aufbau

| Datei | Inhalt |
| --- | --- |
| `src/worker/index.ts` | Routing, Seiten (serverseitig gerendert), API, 2FA |
| `src/worker/doc.ts` | Durable Object pro Dokument: Yjs-Updates in SQLite, WebSockets, Ablauf |
| `src/worker/registry.ts` | Übersicht aller Dokumente, Fehlversuche, verbrauchte Codes |
| `src/shared/render.ts` | Markdown → HTML (Server und Browser), HackMD-Erweiterungen |
| `src/client/main.ts` | Kopfleiste, Modi, Teilen, Umbenennen, Zuletzt geöffnet, Freischalten |
| `src/client/editor.ts` | CodeMirror + Yjs, Slash-Menü, Auswahl-Leiste, Handy-Leiste, Bilder |
| `src/client/enhance.ts` | KaTeX, Mermaid, Highlighting – nur geladen, wenn gebraucht |
| `tools/skill/SKILL.md` | Claude-Code-Skill zum Anlegen/Lesen (nach `~/.claude/skills/md-docs/`) |

Schriften: iA Writer Quattro und Mono (SIL Open Font License, `public/fonts`).

## API für Agenten

```bash
# anlegen (Bearer API_KEY), optional ?id=wunsch-adresse
curl https://md.veerka.mp/api/docs -H "Authorization: Bearer $KEY" \
  -H "Content-Type: text/markdown" --data-binary @text.md
# lesen
curl https://md.veerka.mp/<id>.md
# ersetzen
curl -X PUT https://md.veerka.mp/api/docs/<id> -H "Authorization: Bearer $KEY" \
  -H "Content-Type: text/markdown" --data-binary @text.md
```
