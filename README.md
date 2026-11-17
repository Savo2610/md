# md.veerka.mp

Markdown-Dokumente zum Teilen, Login optional. Ein Cloudflare Worker, ein
Durable Object pro Dokument, Bilder in R2.

- `md.veerka.mp` öffnet ein neues Dokument mit zufälliger, schwer erratbarer Adresse.
- `md.veerka.mp/irgendwas` öffnet das Dokument oder legt es beim ersten Tippen an.
- Bestehende Dokumente öffnen in der Ansicht. Bearbeitungsrechte gelten immer
  für ein einzelnes Dokument und werden im Browser gespeichert: wer es angelegt
  hat, wer den Bearbeiten-Link öffnet (startet direkt im Bearbeiten-Modus), oder
  wer im Dokument den 2FA-Code eingibt (⋯ → Mit Code freischalten).
- Adresse nachträglich ändern: Teilen → Stift neben dem Leselink. Bilder und Bearbeiten-Links
  bleiben gültig. War die alte Adresse zufällig erzeugt, leitet sie weiter;
  selbst gewählte Namen werden wieder frei (keine Alias-Ketten).
- Einfügen über `/` am Zeilenanfang oder nach einem Leerzeichen: alle Blöcke
  und Auszeichnungen, die der Renderer kann.
  Versteckt (nur beim Tippen): `/fett`, `/kursiv`, `/durchgestrichen`,
  `/code`, `/h4`.
- Einstellungen (klein unten im „md“-Menü): Hell/Dunkel/Automatisch
  (Cookie `md_theme`, der Server setzt `data-theme`), beim Öffnen Ansicht
  oder Bearbeiten (Standard: zuletzt benutzter Modus), Name beim
  gemeinsamen Schreiben, Rechtschreibprüfung.
- Tabellen (`src/client/table.ts`, Schrift und `/tabelle` in `table-ui.ts`):
  normale Markdown-Tabellen, im Editor in der Festbreitenschrift, damit die
  `|` untereinander stehen. Anlegen: `/tabelle` (Größe im Raster wählen),
  `/3x4`, Enter hinter `Name | Alter | Ort`, markierte Zeilen mit
  Tab/`;`/`,` → „Tabelle“ in der Auswahl-Leiste, oder Zellen aus
  Excel/Numbers/Sheets einfügen. Tab/Shift-Tab springen zwischen Zellen
  (Handy: ⇥ in der Leiste), Enter in die erste Zelle der nächsten Zeile
  (leere letzte Zeile: raus). Ausgerichtet wird, sobald der Cursor die
  Zelle wechselt (Tab/Enter, Pfeiltasten, Klick) oder die Tabelle verlässt; reine Zahlenspalten werden rechtsbündig. Ein Klick
  in die Füllung setzt den Cursor an den Zellinhalt (leer: links). ⌥↑/⌥↓
  verschieben Zeilen, ⌘↵/⌘⇧↵ fügen ein, ⌘⇧K oder ⌫ in leerer Zeile löschen.
- Tags: `#tag` im Text (ohne Leerzeichen; `# Titel` mit Leerzeichen bleibt
  Überschrift). Im Editor farbig mit Vorschlägen nach `#`. In der Ansicht
  ohne Konto ausgeblendet (Absätze nur aus Tags ganz), angemeldet dezent
  sichtbar; Antippen öffnet `/home` gefiltert auf diesen Tag. Mit Konto steht er bei diesem
  Dokument auf `/home` (filterbar) und folgt dem Text: weg aus dem Text, weg
  aus der Liste. Auf `/home` vergibt „#“ je Zeile weiter eigene Tags, auch für
  fremde Dokumente. Gleiche Regel in den Memos, dort sichtbar und anklickbar
  (`src/shared/tags.ts`).
- Rechnen im Text (`src/shared/calc.ts`, wie Apple Math Notes): Eine Zeile,
  die auf `=` endet, zeigt das Ergebnis farbig dahinter, im Editor, in der
  Ansicht und in den Memos. Im Text steht es nie. Variablen (`Miete = 1.250 €`),
  Prozent (`240 + 19 % =`, `19 % von 240 =`), Einheiten (`90 €/h * 7,5 h =`,
  `3 km in mi =`), Uhrzeiten und Daten (`14:30 + 2 h 45 min =`, `bis 24.12. =`),
  Währungen mit EZB-Kursen (`50 € in CHF =`, Route `/api/fx`). `Summe =`,
  `Durchschnitt =`, `Anzahl =`, `Min =`, `Max =` fassen die Zeilen darüber
  zusammen (letzte Zahl je Zeile, bis zur Leerzeile; eine Zwischensumme
  darüber läuft mit). In Tabellen rechnet eine Zelle `=` die Spalte darüber,
  die Art steht in der Zeile (`| Schnitt | = |`). Zahlen deutsch oder
  schweizerisch (`1.250,50`, `1'250.50`); Codeblöcke und Formeln bleiben außen vor.
- Klick auf „md“: neues Dokument und die zuletzt geöffneten (nur im Browser
  gespeichert, nichts auf dem Server).
- Mehrere Leute können gleichzeitig schreiben (Yjs über WebSockets).
- Whiteboards (`src/client/board.ts`, Datenmodell und Markdown in
  `src/shared/board.ts`): „Neues Board“ im „md“-Menü bzw. `/#board`, oder
  `board.veerka.mp` / `wb.veerka.mp` (leiten auf `md.veerka.mp/<pfad>#board`
  weiter). Ein Board
  ist ein Dokument mit `kind = board` (gleiche Links, Rechte, Papierkorb,
  Umbenennen). Notizen, Bereiche, Formen, Pfeile (hängen an Elementen), Text,
  Stift, Bilder (R2 wie im Editor). Doppelklick auf die Fläche: neue Notiz;
  Tab beim Schreiben: nächste Notiz daneben (Shift: darunter). Eingefügter
  Text wird zu einer Notiz pro Zeile. Kopfleiste: Titel, Timer für alle,
  Abstimmen mit Punkten (verdeckt bis „Abstimmung beenden“), farbige Punkte
  der anderen antippen = folgen, ⋯ → „Alle zu mir holen“. `/<id>.md` liefert
  das Board als Markdown (Bereiche → Überschriften, Notizen → Liste, nach
  Stimmen sortiert, Pfeile als „A → B“); ⋯ → „Als Dokument öffnen“ macht daraus
  ein md-Dokument. Kürzel: V H N F R A T P I, ⌘D, ⌘Z, ⇧1 (alles zeigen),
  Leertaste halten zum Verschieben.
- Packlisten (`src/client/pack.ts`, Datenmodell, Kategorien und Markdown in
  `src/shared/pack.ts`, übernommen aus packliste.veerka.mp): „Neue Packliste“
  im „md“-Menü bzw. `/#pack`, oder `pack.veerka.mp` (leitet auf
  `md.veerka.mp/<pfad>#pack` weiter). Ein Dokument mit `kind = pack` (gleiche
  Links, Rechte, Papierkorb, Umbenennen). Artikel landen per Wörterbuch in einer
  von sieben Kategorien, „3x Isomatte“ setzt die Menge. Abhaken = „ich habe es
  eingepackt“, mit 1 s Bedenkzeit, danach unter „Eingepackt“. Pro Artikel
  „Jede Person“ (erledigt, sobald ich es habe) oder „Einmal für alle“ (erledigt,
  wenn die Summe reicht; ＋ übernimmt eins). Wer den Bearbeiten-Link hat, packt
  mit; Name aus den Einstellungen bzw. „Wer bringt was“. Zurücksetzen nur für
  sich oder für alle, mit Rückgängig. Gerätewissen im Browser: geänderte
  Kategorie/Packmodus je Name (`md:pack:learned`) und der Stand der eigenen
  Listen (`md:pack:lists`) für Vorschläge und „Aus Liste übernehmen“.
  `/<id>.md` liefert die Liste als Aufgabenliste.
  Alle eigenen Packlisten liegen nebeneinander (`src/client/pack-pager.ts`):
  Reiter oben mit offenen Artikeln, Wischen bzw. ⌥←/→ wechselt ohne Neuladen
  (nur die sichtbare Liste ist verbunden, die anderen zeigen ihren letzten
  Stand aus diesem Browser). Reihenfolge in `md:pack:order`. ⋯ → Duplizieren
  (neue Liste hinter dem Original, Titel markiert), Aus Liste übernehmen (mit
  Auswahl), im Artikel „Auch auf“ für die anderen eigenen Listen. Im Board bzw.
  in der Packliste zeigt das „md“-Menü zuerst die anderen Boards bzw.
  Packlisten (Art steht in „Zuletzt geöffnet“ und im Konto, Spalte `kind`).
  `/pack` (bzw. `pack.veerka.mp` ohne Pfad, Start der installierbaren App
  „Packliste“, `public/pack.webmanifest`) öffnet die zuletzt benutzte Packliste.
- Umzug aus der alten Packliste (`/pack/umzug`, `src/worker/packliste.ts`): mit
  Google anmelden, md liest die Listen per Service-Account aus Firebase
  (Projekt packliste-71d90, Secret `FIREBASE_SERVICE_ACCOUNT`, nur Lesen) und legt
  sie als Packlisten an. Jede alte Liste hat eine feste md-Adresse (aus ihrer
  alten ID), ein zweiter Umzug bzw. ein anderes Mitglied einer geteilten Liste
  findet dieselbe wieder. Emoji vor den Titel, Haken nicht übernommen.
- Als App installierbar (PWA): Start auf `/home` mit den zuletzt geöffneten
  Dokumenten, kompakte Leiste mit „Bearbeiten/Fertig“, Menüs als Blatt von
  unten. Offline: Seiten und Editor kommen aus dem Service Worker
  (`public/sw.js`, Liste vom Build in `/assets/precache.json`), Dokumente mit
  Bearbeitungsrecht liegen in IndexedDB und werden beim Verbinden nachgereicht.
  Neue Dokumente gehen nur online (Turnstile).
- Optional mit Google anmelden (`/home` oben rechts oder Menü hinter „md“):
  Die Dokumentliste samt Bearbeitungsrechten liegt dann im Konto und ist auf
  jedem Gerät da; beim ersten Login wandert die Liste aus dem Browser hinein.
  Dazu eigene Tags pro Dokument (nur für einen selbst sichtbar), Filter nach
  Tag auf `/home`. Abmelden nimmt Liste und Schlüssel vom Gerät. Angemeldet
  entfällt der Turnstile-Check beim Anlegen. Ohne `GOOGLE_CLIENT_ID` ist
  Anmelden ausgeblendet.
- Löschen (⋯ → Löschen …) darf nur, wer das Dokument angelegt hat
  (Besitzer-Schlüssel im Browser bzw. im Konto; bei alten Dokumenten nach dem
  2FA-Code) oder der Admin. Es landet 30 Tage im Papierkorb: für alle sofort
  weg (410), Adresse bleibt belegt, auf `/home` unter „Papierkorb“
  wiederherstellen oder endgültig löschen. Danach löscht der Alarm des
  Dokuments es samt Bildern.
- `md.veerka.mp/<id>.md` liefert das reine Markdown (für KI-Agenten, Download).
- ⋯-Menü: „Markdown kopieren“, „Herunterladen (.md)“, „Drucken (.pdf)“
  (Druckdialog des Browsers, immer hell, gedruckt wird die Ansicht; ⌘P beim
  Bearbeiten druckt den aktuellen Stand).
- Import (`src/client/importer.ts`, `html2md.ts`): „Datei öffnen …“ im
  „md“-Menü bzw. auf `/home` oder Datei auf die Seite ziehen legt ein neues
  Dokument an; in den Editor gezogene oder eingefügte Dateien landen an der
  Cursorstelle. `.md`/`.txt` unverändert, `.html` wird zu Markdown. Ebenso
  eingefügter Rich Text (Webseiten, Google Docs, Mail, die eigene Ansicht inkl.
  Formeln); ⌘⇧V fügt ohne Umwandlung ein.
- `md.veerka.mp/memos`: Memos, private Kurznotizen im Konto, neueste oben
  (`src/client/memos.ts`). Eingabe oben (`memo-editor.ts`): CodeMirror mit
  Markdown-Hervorhebung wie iA Writer (gemeinsam mit dem Editor in
  `cmkit.ts`), Listen laufen mit Enter weiter, ⌘/Strg+Enter sichert. Leiste:
  Bild/Datei (auch Einfügen/Ziehen), Sprachmemo (MediaRecorder), Standort
  (Ortsname über OpenStreetMap Nominatim, Link auf Google Maps), Aufgabe.
  Anhänge stehen als Markdown-Link `/m/<datei>` im Text und werden in der
  Ansicht zu Player, Datei- bzw. Ortskarte. `#tags` im Text: farbig, oben als
  Filter, Vervollständigung nach `#`. Pro Memo (⋯, Menü direkt am Knopf):
  Bearbeiten (im Memo), Kopieren, Löschen (6 s Rückgängig, erst dann geht es
  an den Server). Suche oben rechts. Offline Geschriebenes wartet im Browser.
  Eigenes App-Manifest (`public/memos.webmanifest`, Icons `memos-*`).
  Daten im Account-Objekt (Tabellen `memos`, `memo_files`), Anhänge in R2
  unter `memos/<Account-ID>/` (max. 50 MB pro Datei, 2 GB pro Konto),
  ausgeliefert nur ans eigene Konto, mit Range. Anhänge, die kein Memo mehr
  nutzt, werden gelöscht; nie abgeschickte nach einem Tag.
  Nur Admin-Konto: ⋯ → **Auf Funk senden** stellt das Memo auf
  funk.veerka.mp (Vorschau vorher; Text über `src/shared/funk.ts`
  zu schlichtem Text, Anhänge als Datenstrom). Läuft über das Service Binding
  `FUNK` auf den Eingang `Sender` des funk-Workers, ohne öffentliche
  Adresse und ohne Passwort. (Bis November 2026 hieß funk „broadcast“.)
  ⋯ → **Als Dokument öffnen** macht aus dem Memo ein md-Dokument (zufällige
  Adresse, Anhänge werden zu Bildern des Dokuments, steht samt Schlüsseln in
  der Dokumentliste) und öffnet es zum Bearbeiten. Beide bleiben verknüpft:
  das Dokument ist die Quelle, das Memo zeigt dessen aktuellen Stand (Text wird
  beim Laden nachgezogen, Abhaken im Memo schreibt ins Dokument). Ist das
  Dokument weg, bleibt das Memo mit dem letzten Stand.
  Teilen-Dialog der Dokumente: QR-Code neben Lese- und Bearbeiten-Link
  (`src/client/qr.ts`, aus funk übernommen), als PNG sicherbar.
  `memos.veerka.mp` leitet hierher um. Umzug von Memos: `POST /api/admin/memos`
  (API-Schlüssel) mit `{ "memos": [{ "text", "created" }] }`, beim nächsten
  Öffnen von `/memos` mit dem Admin-Konto landen sie dort.
- `md.veerka.mp/admin`: alle Dokumente, Löschen, „Behalten“ (2FA-Code oder
  angemeldet mit dem Google-Konto aus dem Secret `ADMIN_EMAIL`).

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
`SESSION_SECRET`, `API_KEY`, `TURNSTILE_SECRET`, `ADMIN_EMAIL`. Lokal ist `TOTP_SECRET` ein
eigenes Test-Secret. `DEV_LOGIN=1` meldet lokal ohne Google als „Testkonto“
an (nie in Produktion setzen); die Konto-Tests in `npm test` brauchen das.

## Google-Login einrichten

1. [Google Cloud Console](https://console.cloud.google.com/apis/credentials) →
   Anmeldedaten → OAuth-Client-ID → Webanwendung.
   Autorisierte Weiterleitungs-URI: `https://md.veerka.mp/auth/callback`.
2. OAuth-Zustimmungsbildschirm: Status „In Produktion“ (für `openid email
   profile` ist keine Prüfung nötig; im Testmodus kommen nur Testnutzer rein).
3. Client-ID in `wrangler.jsonc` unter `vars.GOOGLE_CLIENT_ID`, das Secret per
   `npx wrangler secret put GOOGLE_CLIENT_SECRET`.

## Deploy

Jeder Push auf `main` wird von Cloudflare Workers Builds gebaut und geht live
(Build command `npm run build`, Deploy command `npx wrangler deploy`).

Von Hand: `npm run deploy`. Secrets setzen: `npx wrangler secret put <NAME>`.
Live-Test ohne 2FA-Teil:
`MD_API_KEY=$(cat ~/.config/md/api-key) node tools/test-api.mjs https://md.veerka.mp`

## Aufbau

| Datei | Inhalt |
| --- | --- |
| `src/worker/index.ts` | Routing, Seiten (serverseitig gerendert), API, 2FA |
| `src/worker/doc.ts` | Durable Object pro Dokument: Yjs-Updates in SQLite, WebSockets, Ablauf |
| `src/worker/registry.ts` | Übersicht aller Dokumente, Fehlversuche, verbrauchte Codes |
| `src/worker/auth.ts` | Google-Login (OIDC + PKCE), Sitzungs-Cookie |
| `src/worker/account.ts` | Durable Object pro Konto: Dokumentliste, Schlüssel, Tags, Memos |
| `src/shared/render.ts` | Markdown → HTML (Server und Browser), HackMD-Erweiterungen |
| `src/client/main.ts` | Kopfleiste, Modi, Teilen, Umbenennen, Zuletzt geöffnet, Freischalten |
| `src/client/editor.ts` | CodeMirror + Yjs, Slash-Menü, Auswahl-Leiste, Handy-Leiste, Bilder |
| `src/client/board.ts` | Whiteboard: Fläche, Werkzeuge, Abstimmen, Timer, Folgen |
| `src/shared/board.ts` | Board-Datenmodell, Board → Markdown (Server und Browser) |
| `src/client/table.ts` | Tabellen: Tab/Enter, Ausrichten, Einfügen aus Tabellenprogrammen |
| `src/client/settings.ts` | Einstellungen (Darstellung, Öffnen, Name, Rechtschreibung) |
| `src/client/home.ts` | Übersicht (`/home`): Liste, Suche, Tag-Filter, Konto |
| `src/client/memos.ts` | Memos (`/memos`): Liste, Tags, Anhänge anzeigen, Bearbeiten/Löschen, Offline-Warteschlange |
| `src/client/memo-editor.ts` | Memo-Eingabe: CodeMirror, Anhänge, Sprachmemo, Standort |
| `src/client/cmkit.ts` | Gemeinsame CodeMirror-Teile (Hervorhebung, Formatier-Kürzel) |
| `src/client/account.ts` | Abgleich der Liste mit dem Konto, Anmelden/Abmelden |
| `src/client/tags.ts` | Tags bearbeiten |
| `public/sw.js` | Service Worker (offline) |
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
