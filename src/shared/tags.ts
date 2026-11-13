// #tags im Text – eine Regel für Dokumente und Memos.
//
//   #rezepte      Tag (direkt nach #, ohne Leerzeichen)
//   # Rezepte     Überschrift (mit Leerzeichen, wie in Markdown üblich)
//
// Ein Tag steht am Zeilenanfang oder nach Leerraum bzw. „(“, besteht aus
// Buchstaben, Ziffern, _ und - und enthält mindestens ein Nicht-Ziffer-Zeichen
// (#1 oder #2026 bleiben Text). Adressen wie https://x.de/#abschnitt zählen nicht.

export const TAG_SOURCE = '(^|[\\s(])#([\\p{L}\\p{N}_-]*[\\p{L}_-][\\p{L}\\p{N}_-]*)';
/** Neue RegExp je Aufruf (global, daher mit eigenem lastIndex). */
export const tagRe = () => new RegExp(TAG_SOURCE, 'gu');

const MAX_TAGS = 20;
const MAX_LEN = 30;

/** Alle #tags eines Texts, ohne Code, Link-Adressen und URLs; Groß/klein zählt als gleich. */
export function tagsOf(text: string): string[] {
  const clean = text.replace(/```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`|\]\([^)]*\)|https?:\/\/\S+/g, ' ');
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of clean.matchAll(tagRe())) {
    const tag = m[2].slice(0, MAX_LEN);
    if (seen.has(tag.toLowerCase())) continue;
    seen.add(tag.toLowerCase());
    out.push(tag);
    if (out.length >= MAX_TAGS) break;
  }
  return out;
}

/** Text ohne #tags (für Titel und Dateinamen). */
export const withoutTags = (text: string) => text.replace(tagRe(), '$1');
