// Titel eines Dokuments. Eigene Datei, damit die Kopfleiste ihn ohne
// markdown-it bestimmen kann. #tags gehören nicht zum Titel.

import { withoutTags } from './tags';

/** Titel: front matter `title:`, sonst erste Überschrift, sonst erste Zeile. */
export function titleOf(src: string, fm?: string): string {
  if (fm === undefined) {
    const m = /^---\n([\s\S]*?)\n---/.exec(src);
    fm = m ? m[1] : '';
  }
  const t = /^title:\s*(.+)$/m.exec(fm);
  if (t) return clean(t[1].replace(/^["']|["']$/g, ''));
  const body = src.replace(/^---\n[\s\S]*?\n---\n?/, '');
  const h = /^#{1,6}\s+(.+?)\s*#*\s*$/m.exec(body);
  if (h) return clean(h[1]);
  const line = body.split('\n').find(l => l.trim());
  return line ? clean(line) : '';
}

function clean(s: string): string {
  return withoutTags(s)
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_`~=#>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

/** Aus Text eine Adresse machen: klein, Bindestriche, nur Buchstaben/Ziffern. */
export function slugify(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .normalize('NFC')
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}
