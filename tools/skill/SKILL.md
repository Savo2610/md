---
name: md-docs
description: Markdown-Dokumente auf md.veerka.mp anlegen, lesen und aktualisieren. Verwenden, wenn Julian sagt "leg dazu ein Doc an", "stell das auf md", "teil das als Link", oder einen Link zu md.veerka.mp schickt, der gelesen werden soll.
---

# md.veerka.mp

Markdown-Dokumente ohne Login. Jedes Dokument hat eine Adresse `https://md.veerka.mp/<id>`.

## Lesen

Ein Link auf md.veerka.mp lässt sich direkt als Markdown abrufen, ohne Schlüssel:

```bash
curl -s https://md.veerka.mp/<id>.md
```

## Anlegen

Der API-Schlüssel liegt in `~/.config/md/api-key`. Wie alle Dokumente verschwinden sie nach 12 Monaten ohne Aufruf, außer Julian setzt sie in md.veerka.mp/admin auf „Behalten“.

```bash
curl -s https://md.veerka.mp/api/docs \
  -H "Authorization: Bearer $(cat ~/.config/md/api-key)" \
  -H "Content-Type: text/markdown" \
  --data-binary @datei.md
```

Optional mit eigener Adresse: `https://md.veerka.mp/api/docs?id=meine-anleitung` (Kleinbuchstaben, Ziffern, `-`, `_`; 409, wenn vergeben). Ohne `id` gibt es eine zufällige, schwer erratbare Adresse. Das ist der Normalfall für private Inhalte.

Antwort: `{"id", "url", "editUrl", "raw"}`. Julian bekommt `url` zum Teilen. `editUrl` nur nennen, wenn er bearbeiten will, denn wer den Link hat, kann ändern.

## Aktualisieren

```bash
curl -s -X PUT https://md.veerka.mp/api/docs/<id> \
  -H "Authorization: Bearer $(cat ~/.config/md/api-key)" \
  -H "Content-Type: text/markdown" \
  --data-binary @datei.md
```

Ersetzt den ganzen Inhalt. Wer das Dokument gerade offen hat, sieht die Änderung sofort.

## Was das Markdown kann

Wie HackMD: GitHub-Markdown (Tabellen, Aufgaben `- [ ]`), Hinweisboxen `:::info` / `:::success` / `:::warning` / `:::danger`, aufklappbar `:::spoiler Titel`, Formeln `$…$` und `$$…$$`, Mermaid-Diagramme (```` ```mermaid ````), `[toc]`, Fußnoten, `==markiert==`, `{%youtube ID %}`. Rohes HTML wird nicht gerendert. Der Titel kommt aus der ersten Überschrift oder `title:` im Front Matter.
