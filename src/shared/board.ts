// Whiteboard: Datenmodell und Umwandlung in Markdown (Server und Browser).
//
// Ein Board ist ein Dokument mit `kind = board`. Statt Y.Text('md') hält das
// Yjs-Dokument:
//   items  Y.Map<id, Y.Map>  ein Element pro Eintrag (Felder siehe Item)
//   meta   Y.Map             title, timer, vote
//   votes  Y.Map<string, n>  `${Abstimmung}|${Element}|${Person}` → Punkte
//
// Der Markdown-Schnappschuss des Boards (für /<id>.md, Titel, Übersicht,
// Suche) entsteht hier: Bereiche werden Überschriften, Notizen darin Listen.

import * as Y from 'yjs';

export type ItemType = 'note' | 'frame' | 'shape' | 'text' | 'arrow' | 'stroke' | 'image';

export interface Item {
  id: string;
  t: ItemType;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Reihenfolge (höher liegt oben). Bereiche haben eine eigene Ebene. */
  z: number;
  /** Farbname (Notizen: yellow, orange …; Linien: fg, red …). */
  c?: string;
  text?: string;
  /** Form: rect, ellipse, diamond. */
  s?: string;
  /** Pfeil: Anfang/Ende als Punkt, optional an einem Element festgemacht. */
  fx?: number; fy?: number; tx?: number; ty?: number;
  from?: string; to?: string;
  /** Stift: Punkte relativ zu x/y, flach [x0, y0, x1, y1, …]. */
  pts?: number[];
  /** Bild: Adresse (/i/…). */
  src?: string;
}

export interface Timer { end: number; dur: number }
export interface Vote { id: string; per: number; active: boolean; show: boolean }

export const MAX_ITEMS = 5000;

export function readItem(id: string, m: Y.Map<unknown>): Item {
  return { id, ...(m.toJSON() as Omit<Item, 'id'>) };
}

export function allItems(doc: Y.Doc): Item[] {
  const out: Item[] = [];
  doc.getMap<Y.Map<unknown>>('items').forEach((m, id) => { if (m instanceof Y.Map) out.push(readItem(id, m)); });
  return out;
}

/** Stimmen je Element in der Abstimmung `voteId`. */
export function voteCounts(doc: Y.Doc, voteId: string): Map<string, number> {
  const counts = new Map<string, number>();
  doc.getMap<number>('votes').forEach((n, key) => {
    const [v, item] = key.split('|');
    if (v !== voteId || !n) return;
    counts.set(item, (counts.get(item) || 0) + n);
  });
  return counts;
}

const center = (it: Item) => ({ x: it.x + it.w / 2, y: it.y + it.h / 2 });
const inside = (p: { x: number; y: number }, f: Item) => p.x >= f.x && p.x <= f.x + f.w && p.y >= f.y && p.y <= f.y + f.h;

/** Lesereihenfolge: zeilenweise von oben nach unten, in der Zeile von links nach rechts. */
function readingOrder<T extends Item>(list: T[]): T[] {
  const sorted = [...list].sort((a, b) => a.y - b.y);
  const rows: T[][] = [];
  for (const it of sorted) {
    const row = rows[rows.length - 1];
    if (row && it.y < row[0].y + Math.min(row[0].h, it.h) / 2) row.push(it);
    else rows.push([it]);
  }
  return rows.flatMap(r => r.sort((a, b) => a.x - b.x));
}

const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();

function listItem(it: Item, votes: number): string | null {
  const suffix = votes ? ` · ${votes} ${votes === 1 ? 'Stimme' : 'Stimmen'}` : '';
  if (it.t === 'image') return it.src ? `- ![](${it.src})${suffix}` : null;
  const text = (it.text || '').trim();
  if (!text) return null;
  const [first, ...rest] = text.split('\n').map(l => l.trimEnd());
  return [`- ${first}${suffix}`, ...rest.filter(l => l.trim()).map(l => `  ${l}`)].join('\n');
}

export function boardMarkdown(doc: Y.Doc): string {
  const meta = doc.getMap<unknown>('meta');
  const title = oneLine(String(meta.get('title') || '')) || 'Board';
  const items = allItems(doc);
  const vote = meta.get('vote') as Vote | undefined;
  // Während einer Abstimmung bleiben die Stimmen verdeckt.
  const counts = vote && !vote.active && vote.show ? voteCounts(doc, vote.id) : new Map<string, number>();

  const frames = readingOrder(items.filter(i => i.t === 'frame'));
  const content = items.filter(i => i.t === 'note' || i.t === 'shape' || i.t === 'text' || i.t === 'image');
  const groups = new Map<Item | null, Item[]>();
  for (const it of content) {
    const c = center(it);
    // Kleinster Bereich, in dem die Mitte liegt.
    const home = frames.filter(f => inside(c, f)).sort((a, b) => a.w * a.h - b.w * b.h)[0] ?? null;
    if (!groups.has(home)) groups.set(home, []);
    groups.get(home)!.push(it);
  }

  const order = (list: Item[]) => {
    const r = readingOrder(list);
    return counts.size ? r.sort((a, b) => (counts.get(b.id) || 0) - (counts.get(a.id) || 0)) : r;
  };
  const block = (list: Item[]) => order(list).map(it => listItem(it, counts.get(it.id) || 0)).filter(Boolean).join('\n');

  const parts = [`# ${title}`];
  for (const f of frames) {
    const body = block(groups.get(f) || []);
    const name = oneLine(f.text || '') || 'Bereich';
    parts.push(body ? `## ${name}\n\n${body}` : `## ${name}`);
  }
  const loose = block(groups.get(null) || []);
  if (loose) parts.push(frames.length ? `## Weitere\n\n${loose}` : loose);

  const byId = new Map(items.map(i => [i.id, i]));
  const label = (id?: string) => {
    const it = id ? byId.get(id) : undefined;
    return it ? oneLine(it.text || '') : '';
  };
  const links = items
    .filter(i => i.t === 'arrow' && label(i.from) && label(i.to))
    .map(i => `- ${label(i.from)} → ${label(i.to)}`);
  if (links.length) parts.push(`## Verbindungen\n\n${links.join('\n')}`);

  return parts.join('\n\n') + '\n';
}
