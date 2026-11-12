// Markdown-Tabellen im Editor leichter bearbeiten, ohne zusätzliche Knöpfe:
//
//  - Tab / Shift-Tab springen zur nächsten bzw. vorigen Zelle; Tab in der
//    letzten Zelle legt eine neue Zeile an.
//  - Enter springt in dieselbe Spalte der nächsten Zeile (am Ende: neue
//    Zeile). Enter in einer leeren letzten Zeile verlässt die Tabelle.
//  - Bei jedem Sprung werden die Spalten im Text sauber ausgerichtet.
//  - Aus Excel, Numbers oder Google Sheets kopierte Zellen werden beim
//    Einfügen zur Markdown-Tabelle (tableFromClipboard).
//
// Gilt nur für Tabellen, deren Zeilen mit | beginnen (so legt md sie an).

import type { EditorView } from '@codemirror/view';
import type { EditorState } from '@codemirror/state';
import { syntaxTree } from '@codemirror/language';

type Align = '' | 'left' | 'center' | 'right';

interface Table {
  from: number; // Anfang der ersten Zeile
  to: number; // Ende der letzten Zeile
  firstLine: number;
  rows: string[][]; // ohne Trennzeile
  aligns: Align[];
}

const DELIM = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

/** Zellen einer Zeile, | innerhalb von \| bleibt Text. */
function cells(line: string): string[] {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  return s.split(/(?<!\\)\|/).map(c => c.trim());
}

/** Spalte, in der der Cursor steht (Anzahl der | davor). */
function columnAt(line: string, offset: number): number {
  const before = line.slice(0, offset);
  return Math.max(0, (before.match(/(?<!\\)\|/g) || []).length - 1);
}

function findTable(state: EditorState, pos: number): Table | null {
  const tree = syntaxTree(state);
  let node: ReturnType<typeof tree.resolveInner> | null = null;
  for (const side of [-1, 1] as const) {
    for (let n: ReturnType<typeof tree.resolveInner> | null = tree.resolveInner(pos, side); n; n = n.parent) {
      if (n.name === 'Table') { node = n; break; }
    }
    if (node) break;
  }
  if (!node) return null;
  const doc = state.doc;
  const first = doc.lineAt(node.from);
  let last = doc.lineAt(node.to);
  if (!last.text.trim() && last.number > first.number) last = doc.line(last.number - 1);
  const lines: string[] = [];
  for (let i = first.number; i <= last.number; i++) lines.push(doc.line(i).text);
  if (lines.length < 2 || !lines.every(l => l.trimStart().startsWith('|')) || !DELIM.test(lines[1])) return null;
  const aligns = cells(lines[1]).map((c): Align => {
    const l = c.startsWith(':'), r = c.endsWith(':');
    return l && r ? 'center' : r ? 'right' : l ? 'left' : '';
  });
  const rows = [lines[0], ...lines.slice(2)].map(cells);
  return { from: first.from, to: last.to, firstLine: first.number, rows, aligns };
}

const width = (s: string) => [...s].length;

function pad(s: string, w: number, align: Align): string {
  const gap = w - width(s);
  if (gap <= 0) return s;
  if (align === 'right') return ' '.repeat(gap) + s;
  if (align === 'center') return ' '.repeat(Math.floor(gap / 2)) + s + ' '.repeat(Math.ceil(gap / 2));
  return s + ' '.repeat(gap);
}

/**
 * Tabelle als ausgerichteter Text. Gibt außerdem für jede Zeile (ohne
 * Trennzeile) die Positionen der Zellinhalte zurück, um den Cursor zu setzen.
 */
export function formatTable(rows: string[][], aligns: Align[] = []): { text: string; spots: { from: number; to: number }[][] } {
  const cols = Math.max(1, ...rows.map(r => r.length), aligns.length);
  const full = rows.map(r => Array.from({ length: cols }, (_, i) => r[i] ?? ''));
  const al = Array.from({ length: cols }, (_, i) => aligns[i] ?? '');
  const widths = al.map((a, i) => Math.max(a === 'center' ? 5 : 3, ...full.map(r => width(r[i]))));
  const delim = '| ' + widths.map((w, i) => {
    const a = al[i];
    if (a === 'center') return ':' + '-'.repeat(w - 2) + ':';
    if (a === 'right') return '-'.repeat(w - 1) + ':';
    if (a === 'left') return ':' + '-'.repeat(w - 1);
    return '-'.repeat(w);
  }).join(' | ') + ' |';

  const out: string[] = [];
  const spots: { from: number; to: number }[][] = [];
  let offset = 0;
  const pushRow = (r: string[]) => {
    const rowSpots: { from: number; to: number }[] = [];
    let line = '|';
    r.forEach((c, i) => {
      const padded = pad(c, widths[i], al[i]);
      const lead = padded.length - padded.trimStart().length;
      const start = offset + line.length + 1 + (c ? lead : 0);
      rowSpots.push({ from: start, to: start + c.length });
      line += ' ' + padded + ' |';
    });
    spots.push(rowSpots);
    out.push(line);
    offset += line.length + 1;
  };
  pushRow(full[0]);
  out.push(delim);
  offset += delim.length + 1;
  for (const r of full.slice(1)) pushRow(r);
  return { text: out.join('\n'), spots };
}

type Move = 'next' | 'prev' | 'down';

function move(view: EditorView, dir: Move): boolean {
  const { state } = view;
  const head = state.selection.main.head;
  const t = findTable(state, head);
  if (!t) return false;
  const line = state.doc.lineAt(head);
  const lineIdx = line.number - t.firstLine;
  // Zeile im Array (Trennzeile zählt wie die Kopfzeile).
  let row = lineIdx <= 1 ? 0 : lineIdx - 1;
  const cols = Math.max(...t.rows.map(r => r.length), t.aligns.length);
  let col = lineIdx === 1 ? 0 : Math.min(columnAt(line.text, head - line.from), cols - 1);
  const rows = t.rows.map(r => Array.from({ length: cols }, (_, i) => r[i] ?? ''));
  const empty = () => Array.from({ length: cols }, () => '');
  let exit = false;

  if (dir === 'next') {
    col++;
    if (col >= cols) { col = 0; row++; if (row >= rows.length) rows.push(empty()); }
  } else if (dir === 'prev') {
    col--;
    if (col < 0) { if (row === 0) col = 0; else { row--; col = cols - 1; } }
  } else {
    const last = row === rows.length - 1;
    if (last && row > 0 && rows[row].every(c => !c)) { rows.pop(); exit = true; }
    else { row++; if (row >= rows.length) rows.push(empty()); }
  }

  const { text, spots } = formatTable(rows, t.aligns);
  if (exit) {
    const insert = text + '\n\n';
    view.dispatch({ changes: { from: t.from, to: t.to, insert }, selection: { anchor: t.from + insert.length }, scrollIntoView: true, userEvent: 'input' });
    return true;
  }
  const spot = spots[row][col];
  view.dispatch({
    changes: { from: t.from, to: t.to, insert: text },
    selection: { anchor: t.from + spot.to, head: t.from + spot.to },
    scrollIntoView: true,
    userEvent: 'input',
  });
  return true;
}

export const tableKeys = [
  { key: 'Tab', run: (v: EditorView) => move(v, 'next') },
  { key: 'Shift-Tab', run: (v: EditorView) => move(v, 'prev') },
  { key: 'Enter', run: (v: EditorView) => move(v, 'down') },
];

/**
 * Aus einem Tabellenprogramm kopierte Zellen (Tabs zwischen Spalten) als
 * Markdown-Tabelle; sonst null. Mit HTML-Tabelle in der Zwischenablage
 * (Excel, Sheets, Numbers) reicht eine Zeile, ohne mindestens zwei.
 */
export function tableFromClipboard(plain: string, html: string): string | null {
  if (!plain.includes('\t')) return null;
  const lines = plain.replace(/\r\n?/g, '\n').replace(/\n+$/, '').split('\n');
  const fromSheet = /<table[\s>]/i.test(html);
  if (!fromSheet && (lines.length < 2 || lines.some(l => /^\s/.test(l)))) return null;
  const rows = lines.map(l => l.split('\t').map(c => c.trim().replace(/\|/g, '\\|')));
  const cols = rows[0].length;
  if (cols < 2 || rows.some(r => r.length !== cols)) return null;
  // Nur eine Zeile: als Kopfzeile mit einer leeren Zeile darunter.
  if (rows.length === 1) rows.push(Array.from({ length: cols }, () => ''));
  return formatTable(rows).text;
}
