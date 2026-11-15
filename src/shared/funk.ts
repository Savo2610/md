// Memo → Nachricht für funk.veerka.mp.
//
// funk zeigt schlichten Text (Adressen werden anklickbar) und Anhänge,
// kein Markdown. Darum: Auszeichnungen weg, Listen als Punkte, Links als
// „Text: Adresse“, #tags weg (die sind privat zum Sortieren). Bilder,
// Dateien und Sprachmemos (/m/<datei>) werden zu echten Anhängen.
// Liegt in shared/, damit der Browser dieselbe Vorschau zeigt, die der
// Server dann sendet.

const FILE_LINK = /!?\[([^\]]*)\]\(\/m\/([\w-]{6,40}\.[a-z0-9]{1,8})\)/g;
const TAG = /(^|[\s(])#[\p{L}\p{N}_-]*[\p{L}_-][\p{L}\p{N}_-]*/gu;

export interface FunkDraft {
  text: string;
  /** Anhänge in Reihenfolge: Dateiname in R2 (ohne /m/) und Anzeigename. */
  files: { file: string; name: string }[];
}

export function toFunk(src: string): FunkDraft {
  const files: FunkDraft['files'] = [];
  let text = src.replace(/\r\n?/g, '\n');

  // Anhänge herausziehen (Bilder, Dateien, Sprachmemos).
  text = text.replace(FILE_LINK, (all: string, label: string, file: string) => {
    if (!files.some(f => f.file === file)) {
      const ext = file.split('.').pop()!;
      const base = label.replace(/\s+\d+:\d\d$/, '').trim() || (all.startsWith('!') ? 'Bild' : 'Datei'); // „Sprachmemo 0:12“ → „Sprachmemo“
      const name = base.toLowerCase().endsWith(`.${ext}`) ? base : `${base}.${ext}`;
      files.push({ file, name });
    }
    return '';
  });

  const lines = text.split('\n').map(line => {
    let l = line;
    // Codeblock-Zäune weg, Inhalt bleibt.
    if (/^\s*(```|~~~)/.test(l)) return '';
    l = l.replace(/^(\s*)#{1,6}\s+/, '$1');                       // Überschrift
    l = l.replace(/^(\s*)[-*+]\s+\[[xX]\]\s+/, '$1☑ ');           // erledigte Aufgabe
    l = l.replace(/^(\s*)[-*+]\s+\[ \]\s+/, '$1☐ ');              // offene Aufgabe
    l = l.replace(/^(\s*)[-*+]\s+/, '$1• ');                      // Stichpunkt
    l = l.replace(/^(\s*)>\s?/, '$1');                            // Zitat
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(l)) return '';          // Trennlinie
    return l;
  });
  text = lines.join('\n');

  // Links: [Text](Adresse) → „Text: Adresse“, nur Adresse, wenn gleich.
  text = text.replace(/\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_, label: string, url: string) => {
    const l = label.trim();
    return !l || l === url ? url : `${l}: ${url}`;
  });
  text = text.replace(/<(https?:\/\/[^>\s]+)>/g, '$1');

  // Hervorhebungen.
  text = text
    .replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, '$2')
    // Durchgestrichen bleibt sichtbar durchgestrichen (sonst kehrt sich der Sinn um).
    .replace(/~~(?=\S)([\s\S]*?\S)~~/g, (_, t: string) => [...t].map(c => (c === '\n' ? c : c + '\u0336')).join(''))
    .replace(/==(?=\S)([\s\S]*?\S)==/g, '$1')
    .replace(/(^|[^\w*])\*(?=\S)([^*\n]*?\S)\*(?![\w*])/g, '$1$2')
    .replace(/(^|[^\w])_(?=\S)([^_\n]*?\S)_(?!\w)/g, '$1$2')
    .replace(/`([^`\n]+)`/g, '$1');

  // #tags weg, danach doppelte Leerzeichen und leere Zeilen aufräumen.
  text = text.replace(TAG, '$1');
  text = text
    .split('\n').map(l => l.replace(/[ \t]+$/, '').replace(/(\S) {2,}/g, '$1 ')).join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return { text, files };
}
