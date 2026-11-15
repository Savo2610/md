// Markdown-Tabellen im Editor: Modell und alle Bearbeitungsschritte.
//
//  - Tab / Shift-Tab springen zur nächsten bzw. vorigen Zelle; Tab in der
//    letzten Zelle legt eine neue Zeile an.
//  - Enter springt in die erste Zelle der nächsten Zeile (am Ende: neue
//    Zeile). Enter in einer leeren letzten Zeile verlässt die Tabelle.
//  - Pfeiltasten wechseln am Rand einer Zelle in die Nachbarzelle, ↑/↓
//    bleiben in der Spalte. Ein Klick setzt den Cursor in den Inhalt der
//    Zelle (leer: links), nie in Füllung oder Trennzeile (tableCursor).
//    Enter hinter „Name | Alter | Ort“ macht daraus die Kopfzeile.
//  - ⌥↑/⌥↓ verschieben die Zeile, ⌘↵ / ⌘⇧↵ fügen darunter/darüber eine ein,
//    ⌘⇧K oder ⌫ in einer leeren Zeile löschen sie.
//  - Bei jedem Schritt werden die Spalten im Text sauber ausgerichtet; reine
//    Zahlenspalten werden rechtsbündig.
//  - Aus Excel, Numbers oder Google Sheets kopierte Zellen werden beim
//    Einfügen zur Markdown-Tabelle (tableFromClipboard), markierte Zeilen mit
//    Tab, ; oder , dazwischen über textToTable.
//
// Gilt nur für Tabellen, deren Zeilen mit | beginnen (so legt md sie an).
// Darstellung im Editor und die Tabellen-Leiste: table-ui.ts.

import type { EditorView } from '@codemirror/view';
import { EditorState, type Transaction, type TransactionSpec } from '@codemirror/state';
import { syntaxTree } from '@codemirror/language';

export type Align = '' | 'left' | 'center' | 'right';

export interface Table {
  from: number; // Anfang der ersten Zeile
  to: number; // Ende der letzten Zeile
  firstLine: number;
  rows: string[][]; // ohne Trennzeile, alle gleich lang
  aligns: Align[];
  cols: number;
}

/** Zelle: row 0 ist die Kopfzeile. */
export interface Cell { row: number; col: number }

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

export function findTable(state: EditorState, pos: number): Table | null {
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
  // Der Cursor steht in der Zeile direkt unter der Tabelle (z. B. nach Enter): nicht mehr drin.
  if (pos > last.to) return null;
  const lines: string[] = [];
  for (let i = first.number; i <= last.number; i++) lines.push(doc.line(i).text);
  if (lines.length < 2 || !lines.every(l => l.trimStart().startsWith('|')) || !DELIM.test(lines[1])) return null;
  const aligns = cells(lines[1]).map((c): Align => {
    const l = c.startsWith(':'), r = c.endsWith(':');
    return l && r ? 'center' : r ? 'right' : l ? 'left' : '';
  });
  const raw = [lines[0], ...lines.slice(2)].map(cells);
  const cols = Math.max(1, ...raw.map(r => r.length), aligns.length);
  const rows = raw.map(r => Array.from({ length: cols }, (_, i) => r[i] ?? ''));
  return { from: first.from, to: last.to, firstLine: first.number, rows, aligns: Array.from({ length: cols }, (_, i) => aligns[i] ?? ''), cols };
}

/** Zelle an der Position (Trennzeile zählt wie die Kopfzeile). */
export function cellAt(state: EditorState, t: Table, pos: number): Cell {
  const line = state.doc.lineAt(pos);
  const idx = line.number - t.firstLine;
  const row = idx <= 1 ? 0 : idx - 1;
  const col = Math.min(columnAt(line.text, pos - line.from), t.cols - 1);
  return { row, col };
}

const width = (s: string) => [...s].length;

function pad(s: string, w: number, align: Align): string {
  const gap = w - width(s);
  if (gap <= 0) return s;
  if (align === 'right') return ' '.repeat(gap) + s;
  if (align === 'center') return ' '.repeat(Math.floor(gap / 2)) + s + ' '.repeat(Math.ceil(gap / 2));
  return s + ' '.repeat(gap);
}

// ── Zahlen ──────────────────────────────────────────────────────────────────

const UNIT = /\s?(?:%|‰|€|\$|£|¥|CHF|EUR|USD|Fr\.?|k|Mio\.?|Mrd\.?|h|min|s|ms|kg|g|km|m|cm|mm|l|ml|°C?|x)$/i;

/** Betrag, Prozent, 1.234,56 €, -3, +5 … → Zahl; sonst null. */
export function numberOf(cell: string): number | null {
  let s = cell.replace(/\*\*|__|`/g, '').trim().replace(/^[−–]/, '-');
  s = s.replace(/^([-+]?)\s?(?:€|\$|£|¥|CHF|EUR|USD|Fr\.)\s?/i, '$1').replace(UNIT, '').trim();
  if (!/^[-+]?\d[\d.,' ’]*$/.test(s) || /[.,' ’]$/.test(s)) return null;
  s = s.replace(/[' ’]/g, '');
  const lastDot = s.lastIndexOf('.'), lastComma = s.lastIndexOf(',');
  if (lastDot >= 0 && lastComma >= 0) {
    // Das hintere Zeichen trennt die Nachkommastellen.
    s = lastComma > lastDot ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  } else if (lastComma >= 0) {
    // 1,5 ist eine Dezimalzahl, 1,234,567 hat Tausender.
    s = /^[-+]?\d{1,3}(,\d{3}){2,}$/.test(s) ? s.replace(/,/g, '') : s.replace(/,/g, '.');
  } else if ((s.match(/\./g) || []).length > 1) {
    s = s.replace(/\./g, '');
  } else if (/^[-+]?\d{1,3}\.\d{3}$/.test(s)) {
    s = s.replace('.', ''); // 1.234 auf Deutsch
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** Spalten ohne eigene Ausrichtung, in denen nur Zahlen stehen: rechtsbündig. */
function autoAlign(rows: string[][], aligns: Align[]): Align[] {
  return aligns.map((a, i) => {
    if (a) return a;
    const body = rows.slice(1).map(r => r[i] ?? '').filter(c => c.trim());
    return body.length && body.every(c => numberOf(c) !== null) ? 'right' : '';
  });
}

// ── Text ────────────────────────────────────────────────────────────────────

/**
 * Tabelle als ausgerichteter Text. Gibt außerdem für jede Zeile (ohne
 * Trennzeile) die Positionen der Zellinhalte zurück, um den Cursor zu setzen.
 */
export function formatTable(rows: string[][], aligns: Align[] = []): { text: string; spots: { from: number; to: number }[][] } {
  const cols = Math.max(1, ...rows.map(r => r.length), aligns.length);
  const full = rows.map(r => Array.from({ length: cols }, (_, i) => r[i] ?? ''));
  const al = autoAlign(full, Array.from({ length: cols }, (_, i) => aligns[i] ?? ''));
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

/** Leere Tabelle mit cols Spalten und rows Zeilen (die Kopfzeile mitgezählt). */
export function emptyTable(cols: number, rows: number): string {
  return formatTable(Array.from({ length: Math.max(2, rows) }, () => Array.from({ length: cols }, () => ''))).text;
}

// ── Bearbeiten ──────────────────────────────────────────────────────────────

interface Result { rows: string[][]; aligns: Align[]; cell: Cell; atStart?: boolean }

/** Tabelle neu schreiben und den Cursor in die Zelle setzen. */
function commit(view: EditorView, t: Table, r: Result) {
  const { text, spots } = formatTable(r.rows, r.aligns);
  const row = Math.max(0, Math.min(r.cell.row, spots.length - 1));
  const spot = spots[row][Math.max(0, Math.min(r.cell.col, spots[row].length - 1))];
  const at = t.from + (r.atStart ? spot.from : spot.to);
  view.dispatch({
    changes: { from: t.from, to: t.to, insert: text },
    selection: { anchor: at },
    scrollIntoView: true,
    userEvent: 'input',
  });
}

/** Schritt an der Cursorposition; false außerhalb einer Tabelle. */
export function edit(view: EditorView, fn: (t: Table, c: Cell) => Result | null | void): boolean {
  const head = view.state.selection.main.head;
  const t = findTable(view.state, head);
  if (!t) return false;
  const r = fn(t, cellAt(view.state, t, head));
  if (r) commit(view, t, r);
  return true;
}

const blank = (n: number) => Array.from({ length: n }, () => '');
const copy = (t: Table) => ({ rows: t.rows.map(r => [...r]), aligns: [...t.aligns] });

type Move = 'next' | 'prev' | 'down';

function move(view: EditorView, dir: Move): boolean {
  const head = view.state.selection.main.head;
  const t = findTable(view.state, head);
  if (!t) return dir === 'down' ? headerToTable(view) : false;
  let { row, col } = cellAt(view.state, t, head);
  if (view.state.doc.lineAt(head).number - t.firstLine === 1) col = 0;
  const { rows, aligns } = copy(t);

  if (dir === 'next') {
    col++;
    if (col >= t.cols) { col = 0; row++; if (row >= rows.length) rows.push(blank(t.cols)); }
  } else if (dir === 'prev') {
    col--;
    if (col < 0) { if (row === 0) col = 0; else { row--; col = t.cols - 1; } }
  } else {
    const last = row === rows.length - 1;
    if (last && row > 0 && rows[row].every(c => !c)) {
      rows.pop();
      const insert = formatTable(rows, aligns).text + '\n\n';
      view.dispatch({ changes: { from: t.from, to: t.to, insert }, selection: { anchor: t.from + insert.length }, scrollIntoView: true, userEvent: 'input' });
      return true;
    }
    row++;
    col = 0;
    if (row >= rows.length) rows.push(blank(t.cols));
  }
  commit(view, t, { rows, aligns, cell: { row, col } });
  return true;
}

/** Zeile einfügen, darunter oder darüber (über der Kopfzeile geht nicht). */
export const insertRow = (view: EditorView, above = false) => edit(view, (t, c) => {
  const { rows, aligns } = copy(t);
  const at = above ? Math.max(1, c.row) : c.row + 1;
  rows.splice(at, 0, blank(t.cols));
  return { rows, aligns, cell: { row: at, col: 0 } };
});

export const deleteRow = (view: EditorView) => edit(view, (t, c) => {
  if (c.row === 0) return null;
  const { rows, aligns } = copy(t);
  rows.splice(c.row, 1);
  return { rows, aligns, cell: { row: Math.min(c.row, rows.length - 1), col: c.col } };
});

export const insertCol = (view: EditorView, left = false) => edit(view, (t, c) => {
  const { rows, aligns } = copy(t);
  const at = left ? c.col : c.col + 1;
  rows.forEach(r => r.splice(at, 0, ''));
  aligns.splice(at, 0, '');
  return { rows, aligns, cell: { row: c.row, col: at } };
});

export const deleteCol = (view: EditorView) => edit(view, (t, c) => {
  if (t.cols < 2) return null;
  const { rows, aligns } = copy(t);
  rows.forEach(r => r.splice(c.col, 1));
  aligns.splice(c.col, 1);
  return { rows, aligns, cell: { row: c.row, col: Math.min(c.col, t.cols - 2) } };
});

/** Zeile nach oben/unten verschieben (nur unter der Kopfzeile). */
export const moveRow = (view: EditorView, by: -1 | 1) => edit(view, (t, c) => {
  const to = c.row + by;
  if (c.row === 0 || to < 1 || to >= t.rows.length) return null;
  const { rows, aligns } = copy(t);
  [rows[c.row], rows[to]] = [rows[to], rows[c.row]];
  return { rows, aligns, cell: { row: to, col: c.col } };
});

export const moveCol = (view: EditorView, by: -1 | 1) => edit(view, (t, c) => {
  const to = c.col + by;
  if (to < 0 || to >= t.cols) return null;
  const { rows, aligns } = copy(t);
  rows.forEach(r => { [r[c.col], r[to]] = [r[to], r[c.col]]; });
  [aligns[c.col], aligns[to]] = [aligns[to], aligns[c.col]];
  return { rows, aligns, cell: { row: c.row, col: to } };
});

/** Ausrichtung der Spalte. */
export const alignCol = (view: EditorView, a: Align) => edit(view, (t, c) => {
  const { rows, aligns } = copy(t);
  aligns[c.col] = a;
  // Links ist ohnehin Standard, außer bei Zahlenspalten.
  if (a === 'left' && !autoAlign(rows, aligns.map((x, i) => i === c.col ? '' : x))[c.col]) aligns[c.col] = '';
  return { rows, aligns, cell: c };
});

/** Wie die Spalte tatsächlich ausgerichtet ist (auch automatisch). */
export function current(t: Table, col: number): Align {
  return autoAlign(t.rows, t.aligns)[col] || 'left';
}

const collator = new Intl.Collator('de', { numeric: true, sensitivity: 'base' });

function compare(a: string, b: string): number {
  const x = numberOf(a), y = numberOf(b);
  if (x !== null && y !== null) return x - y;
  return collator.compare(a, b);
}

/** Zeilen nach der Spalte, leere immer ans Ende. */
function sorted(body: string[][], col: number, dir: 1 | -1): string[][] {
  return [...body].sort((a, b) => {
    const ea = !a[col].trim(), eb = !b[col].trim();
    if (ea || eb) return Number(ea) - Number(eb);
    return dir * compare(a[col], b[col]);
  });
}

/** Sortierrichtung der Spalte: 1 aufsteigend, -1 absteigend, 0 unsortiert. */
export function sortState(t: Table, col: number): 1 | -1 | 0 {
  const body = t.rows.slice(1);
  if (body.filter(r => r[col].trim()).length < 2) return 0;
  const same = (x: string[][]) => x.every((r, i) => r === body[i]);
  return same(sorted(body, col, 1)) ? 1 : same(sorted(body, col, -1)) ? -1 : 0;
}

/** Zeilen nach der Spalte sortieren: aufsteigend, ist sie es schon, absteigend. */
export const sortBy = (view: EditorView) => edit(view, (t, c) => {
  const { rows, aligns } = copy(t);
  const body = rows.slice(1);
  const all = [rows[0], ...sorted(body, c.col, sortState(t, c.col) === 1 ? -1 : 1)];
  // Cursor bleibt in der Zeile, die er vorher hatte.
  return { rows: all, aligns, cell: { row: c.row === 0 ? 0 : all.indexOf(rows[c.row]), col: c.col } };
});

/** ⌫ am Anfang einer leeren Zeile: Zeile weg, Cursor ans Ende der Zeile darüber. */
function backspace(view: EditorView): boolean {
  const sel = view.state.selection.main;
  if (!sel.empty) return false;
  const t = findTable(view.state, sel.head);
  if (!t) return false;
  const c = cellAt(view.state, t, sel.head);
  if (c.row === 0 || c.col !== 0 || t.rows[c.row].some(x => x)) return false;
  const { rows, aligns } = copy(t);
  rows.splice(c.row, 1);
  commit(view, t, { rows, aligns, cell: { row: c.row - 1, col: t.cols - 1 } });
  return true;
}

// ── Cursor in Zellen ────────────────────────────────────────────────────────
// Im Raster sind Füll-Leerzeichen ausgeblendet. Der Cursor gehört deshalb
// immer in den Inhalt einer Zelle (leere Zelle: ganz links), nie in die
// Füllung, an ein | oder in die Trennzeile.

interface Slot { from: number; to: number; cs: number; ce: number }

/** Zellen einer Tabellenzeile mit Inhaltsbereich (cs–ce). */
function slots(text: string, from: number): Slot[] {
  const pipes = [...text.matchAll(/(?<!\\)\|/g)].map(m => m.index!);
  const out: Slot[] = [];
  const add = (a: number, b: number) => {
    const t = text.slice(a, b);
    const lead = t.length - t.trimStart().length;
    const empty = !t.trim();
    const cs = from + a + (empty ? Math.min(1, t.length) : lead);
    const ce = empty ? cs : from + b - (t.length - t.trimEnd().length);
    out.push({ from: from + a, to: from + b, cs, ce });
  };
  for (let i = 0; i + 1 < pipes.length; i++) add(pipes[i] + 1, pipes[i + 1]);
  const last = pipes.length ? pipes[pipes.length - 1] + 1 : 0;
  if (text.slice(last).trim()) add(last, text.length);
  return out;
}

/** Zeile im Dokument zu Tabellenzeile row (0 = Kopfzeile). */
const lineOf = (t: Table, row: number) => row === 0 ? t.firstLine : t.firstLine + row + 1;

function slotsOf(state: EditorState, t: Table, row: number): Slot[] {
  const line = state.doc.line(lineOf(t, row));
  return slots(line.text, line.from);
}

/** Zelle (Index) an einer Position der Zeile. */
function slotAt(s: Slot[], pos: number): number {
  for (let i = 0; i < s.length; i++) if (pos <= s[i].to) return i;
  return s.length - 1;
}

const clampTo = (s: Slot, pos: number) => Math.max(s.cs, Math.min(s.ce, pos));

type Dir = 'left' | 'right' | 'up' | 'down';

/** Pfeiltasten: am Rand einer Zelle in die Nachbarzelle, hoch/runter in derselben Spalte. */
function arrow(view: EditorView, dir: Dir): boolean {
  const { state } = view;
  const sel = state.selection.main;
  if (!sel.empty || state.selection.ranges.length > 1) return false;
  const t = findTable(state, sel.head);
  if (!t) return false;
  const line = state.doc.lineAt(sel.head);
  const idx = line.number - t.firstLine;
  if (idx === 1) return false; // Trennzeile: regelt der Filter unten
  const row = idx === 0 ? 0 : idx - 1;
  const here = slots(line.text, line.from);
  if (!here.length) return false;
  const k = slotAt(here, sel.head);
  const cur = here[k];
  let to: number | null = null;
  if (dir === 'left') {
    if (sel.head > cur.cs) return false;
    if (k > 0) to = here[k - 1].ce;
    else if (row > 0) { const s = slotsOf(state, t, row - 1); to = s[s.length - 1]?.ce ?? null; }
  } else if (dir === 'right') {
    if (sel.head < cur.ce) return false;
    if (k < here.length - 1) to = here[k + 1].cs;
    else if (row < t.rows.length - 1) to = slotsOf(state, t, row + 1)[0]?.cs ?? null;
  } else {
    const next = row + (dir === 'up' ? -1 : 1);
    if (next < 0 || next >= t.rows.length) return false; // raus aus der Tabelle wie gewohnt
    const s = slotsOf(state, t, next);
    const target = s[Math.min(k, s.length - 1)];
    if (target) to = Math.min(target.ce, target.cs + Math.max(0, sel.head - cur.cs));
  }
  if (to === null) return false;
  view.dispatch({ selection: { anchor: to }, scrollIntoView: true, userEvent: 'select' });
  return true;
}

/**
 * Klicks und Cursorbewegungen in einer Tabelle: Landet der Cursor in der
 * Füllung, an einem | oder in der Trennzeile, rückt er in den Inhalt der
 * Zelle (leere Zelle: links). Tippen bleibt unberührt.
 */
export const tableCursor = EditorState.transactionFilter.of((tr: Transaction): Transaction | readonly (Transaction | TransactionSpec)[] => {
  if (tr.docChanged || !tr.selection || !tr.isUserEvent('select')) return tr;
  const sel = tr.selection;
  if (sel.ranges.length > 1 || !sel.main.empty) return tr;
  const state = tr.state;
  const head = sel.main.head;
  const t = findTable(state, head);
  if (!t) return tr;
  let line = state.doc.lineAt(head);
  let k: number | null = null;
  if (line.number - t.firstLine === 1) {
    // Trennzeile: von unten kommend in die Kopfzeile, sonst in die erste Zeile darunter.
    k = slotAt(slots(line.text, line.from), head);
    const old = tr.startState.selection.main.head;
    const row = old > line.to || t.rows.length < 2 ? 0 : 1;
    line = state.doc.line(lineOf(t, row));
  }
  const s = slots(line.text, line.from);
  if (!s.length) return tr;
  const i = k ?? slotAt(s, head);
  const slot = s[Math.min(i, s.length - 1)];
  const to = k !== null ? slot.cs : clampTo(slot, head);
  if (to === head) return tr;
  return [tr, { selection: { anchor: to }, sequential: true }];
});

// ── Neue Tabellen aus Text ──────────────────────────────────────────────────

/** Unmaskierte | außerhalb von `Code`. */
function pipes(line: string): number {
  return (line.replace(/`[^`]*`/g, '').match(/(?<!\\)\|/g) || []).length;
}

/**
 * Enter hinter einer Zeile wie „Name | Alter | Ort“ (oder „| Name | Alter |“):
 * daraus wird die Kopfzeile, darunter Trennzeile und eine leere Zeile.
 */
function headerToTable(view: EditorView): boolean {
  const { state } = view;
  const sel = state.selection.main;
  if (!sel.empty) return false;
  const line = state.doc.lineAt(sel.head);
  if (sel.head !== line.to) return false;
  const text = line.text;
  if (/^\s*([-*+] |\d+[.)] |> |#{1,6} )/.test(text) || /^\s{4}/.test(text)) return false;
  // „| A | B“ oder „A | B | C“; bei nur einem | („A | B“) nur kurze Stichworte, keine Sätze.
  const n = pipes(text);
  const short = (c: string) => c.length <= 24 && c.split(/\s+/).length <= 3;
  if (n < 1 || (n === 1 && !(cells(text).every(short)))) return false;
  // Nicht in Code, Formeln oder einer bestehenden Tabelle.
  for (let nd: ReturnType<ReturnType<typeof syntaxTree>['resolveInner']> | null = syntaxTree(state).resolveInner(sel.head, -1); nd; nd = nd.parent) {
    if (['FencedCode', 'CodeBlock', 'Table', 'HTMLBlock', 'CommentBlock'].includes(nd.name)) return false;
  }
  const head = cells(text);
  if (head.length < 2 || head.every(c => !c)) return false;
  const rows = [head, blank(head.length)];
  const { text: table, spots } = formatTable(rows);
  const before = line.number > 1 && state.doc.line(line.number - 1).text.trim() ? '\n' : '';
  view.dispatch({
    changes: { from: line.from, to: line.to, insert: before + table },
    selection: { anchor: line.from + before.length + spots[1][0].to },
    scrollIntoView: true,
    userEvent: 'input',
  });
  return true;
}

/** CSV-Zeile mit "…"-Feldern. */
function splitQuoted(line: string, sep: string): string[] {
  const out: string[] = [];
  let cur = '', quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"' && !cur.trim()) { quoted = true; cur = ''; }
    else if (ch === sep) { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out.map(c => c.trim());
}

/**
 * Markierte Zeilen mit Tab, ; , oder | dazwischen als Tabelle (erste Zeile
 * wird Kopfzeile); sonst null. Alle Zeilen brauchen gleich viele Spalten.
 */
export function textToTable(text: string): string | null {
  const lines = text.replace(/\r\n?/g, '\n').split('\n').map(l => l.trim()).filter(Boolean);
  if (lines.length < 2) return null;
  for (const sep of ['\t', ';', '|', ',']) {
    const rows = lines.map(l => sep === '|' ? cells(l) : splitQuoted(l, sep));
    const cols = rows[0].length;
    if (cols < 2 || rows.some(r => r.length !== cols)) continue;
    return formatTable(rows.map(r => r.map(c => c.replace(/(?<!\\)\|/g, '\\|')))).text;
  }
  return null;
}

/** Ist die Markierung als Tabelle umwandelbar? */
export function convertible(state: EditorState): boolean {
  const sel = state.selection.main;
  if (sel.empty || !state.sliceDoc(sel.from, sel.to).includes('\n')) return false;
  if (findTable(state, sel.from)) return false;
  return textToTable(state.sliceDoc(state.doc.lineAt(sel.from).from, state.doc.lineAt(sel.to).to)) !== null;
}

/** Markierte Zeilen in eine Tabelle umwandeln. */
export function convertSelection(view: EditorView): boolean {
  const { state } = view;
  const sel = state.selection.main;
  const from = state.doc.lineAt(sel.from).from, to = state.doc.lineAt(sel.to).to;
  const table = textToTable(state.sliceDoc(from, to));
  if (!table) return false;
  view.dispatch({ changes: { from, to, insert: table }, selection: { anchor: from + table.indexOf(' ') + 1 }, scrollIntoView: true, userEvent: 'input' });
  view.focus();
  return true;
}

export const tableKeys = [
  { key: 'Tab', run: (v: EditorView) => move(v, 'next') },
  { key: 'Shift-Tab', run: (v: EditorView) => move(v, 'prev') },
  { key: 'Enter', run: (v: EditorView) => move(v, 'down') },
  { key: 'Alt-ArrowUp', run: (v: EditorView) => moveRow(v, -1) },
  { key: 'Alt-ArrowDown', run: (v: EditorView) => moveRow(v, 1) },
  { key: 'Mod-Enter', run: (v: EditorView) => insertRow(v) },
  { key: 'Shift-Mod-Enter', run: (v: EditorView) => insertRow(v, true) },
  { key: 'Shift-Mod-k', run: deleteRow },
  { key: 'Backspace', run: backspace },
  { key: 'ArrowLeft', run: (v: EditorView) => arrow(v, 'left') },
  { key: 'ArrowRight', run: (v: EditorView) => arrow(v, 'right') },
  { key: 'ArrowUp', run: (v: EditorView) => arrow(v, 'up') },
  { key: 'ArrowDown', run: (v: EditorView) => arrow(v, 'down') },
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
