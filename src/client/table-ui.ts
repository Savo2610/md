// Tabellen im Editor: Festbreitenschrift für Tabellenzeilen und /tabelle.
//
// Tabellen bleiben normaler Markdown-Text. Ihre Zeilen stehen in der
// Festbreitenschrift, damit die von table.ts ausgerichteten | untereinander
// stehen (in der Textschrift sind Buchstaben unterschiedlich breit).

import { EditorView, ViewPlugin, Decoration, type DecorationSet, type ViewUpdate } from '@codemirror/view';
import type { Extension, Range } from '@codemirror/state';
import { syntaxTree } from '@codemirror/language';
import { emptyTable } from './table';

// ── Festbreitenschrift ──────────────────────────────────────────────────────

const tableLine = Decoration.line({ class: 'cm-tbl' });

function lines(view: EditorView): DecorationSet {
  const { state } = view;
  const out: Range<Decoration>[] = [];
  let last = -1;
  for (const { from, to } of view.visibleRanges) {
    syntaxTree(state).iterate({
      from, to,
      enter: node => {
        if (node.name !== 'Table') return;
        const a = state.doc.lineAt(node.from).number, b = state.doc.lineAt(node.to).number;
        for (let n = Math.max(a, last + 1); n <= b; n++) {
          const line = state.doc.line(n);
          if (line.text.trimStart().startsWith('|')) out.push(tableLine.range(line.from));
          last = n;
        }
        return false;
      },
    });
  }
  return Decoration.set(out);
}

export const tableFont: Extension = ViewPlugin.fromClass(class {
  decorations: DecorationSet;
  constructor(view: EditorView) { this.decorations = lines(view); }
  update(u: ViewUpdate) {
    if (u.docChanged || u.viewportChanged || syntaxTree(u.startState) !== syntaxTree(u.state)) this.decorations = lines(u.view);
  }
}, { decorations: v => v.decorations });

// ── Neue Tabelle ────────────────────────────────────────────────────────────

/** Leere Tabelle an der Cursorstelle, als eigener Block; Cursor in die erste Zelle. */
export function insertTable(view: EditorView, cols: number, rows: number) {
  const { state } = view;
  const pos = state.selection.main.head;
  const line = state.doc.lineAt(pos);
  const prev = line.number > 1 ? state.doc.line(line.number - 1).text.trim() : '';
  const next = line.number < state.doc.lines ? state.doc.line(line.number + 1).text.trim() : '';
  // Direkt unter einem Absatz würde dessen letzte Zeile zur Kopfzeile: Leerzeile davor.
  const before = state.sliceDoc(line.from, pos).trim() ? '\n\n' : prev ? '\n' : '';
  const after = state.sliceDoc(pos, line.to).trim() ? '\n\n' : next ? '\n' : '';
  const insert = before + emptyTable(cols, rows) + after;
  view.dispatch({ changes: { from: pos, insert }, selection: { anchor: pos + before.length + 2 }, scrollIntoView: true, userEvent: 'input' });
  view.focus();
}

let closePicker: (() => void) | null = null;

/** /tabelle: Größe im Raster wählen (Maus, Finger oder Pfeiltasten + Enter). */
export function pickTableSize(view: EditorView) {
  closePicker?.();
  const coarse = matchMedia('(pointer: coarse)').matches;
  const MAX = coarse ? 6 : 8;
  let cols = 3, rows = 3;
  const el = document.createElement('div');
  el.className = 'tablepick';
  const grid = document.createElement('div');
  grid.className = 'tp-grid';
  grid.style.gridTemplateColumns = `repeat(${MAX}, auto)`;
  const size = document.createElement('div');
  size.className = 'tp-size';
  const boxes: HTMLSpanElement[] = [];
  for (let r = 1; r <= MAX; r++) {
    for (let c = 1; c <= MAX; c++) {
      const b = document.createElement('span');
      b.dataset.c = String(c);
      b.dataset.r = String(r);
      boxes.push(b);
      grid.append(b);
    }
  }
  el.append(grid, size);
  const paint = () => {
    for (const b of boxes) {
      const c = Number(b.dataset.c), r = Number(b.dataset.r);
      b.classList.toggle('on', c <= cols && r <= rows);
      b.classList.toggle('head', r === 1);
    }
    size.textContent = `${cols} × ${rows}`;
  };
  const done = (ok: boolean) => {
    close();
    if (ok) insertTable(view, cols, rows);
    else view.focus();
  };
  const at = (e: PointerEvent) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('span[data-c]');
    if (!b) return false;
    cols = Number(b.dataset.c);
    rows = Math.max(2, Number(b.dataset.r));
    paint();
    return true;
  };
  grid.addEventListener('pointermove', at);
  grid.addEventListener('pointerdown', e => { e.preventDefault(); at(e); });
  grid.addEventListener('pointerup', e => { if (at(e)) done(true); });
  const key = (e: KeyboardEvent) => {
    const k = e.key;
    if (k === 'ArrowRight') cols = Math.min(MAX, cols + 1);
    else if (k === 'ArrowLeft') cols = Math.max(1, cols - 1);
    else if (k === 'ArrowDown') rows = Math.min(MAX, rows + 1);
    else if (k === 'ArrowUp') rows = Math.max(2, rows - 1);
    else if (k === 'Enter' || k === 'Tab') { e.preventDefault(); e.stopPropagation(); done(true); return; }
    else if (k === 'Escape') { e.preventDefault(); e.stopPropagation(); done(false); return; }
    else { close(); return; }
    e.preventDefault();
    e.stopPropagation();
    paint();
  };
  const outside = (e: PointerEvent) => { if (!el.contains(e.target as Node)) close(); };
  const close = () => {
    el.remove();
    document.removeEventListener('keydown', key, true);
    document.removeEventListener('pointerdown', outside, true);
    closePicker = null;
  };
  closePicker = close;
  paint();
  document.body.append(el);
  const pos = view.coordsAtPos(view.state.selection.main.head);
  const rect = el.getBoundingClientRect();
  const left = Math.max(8, Math.min(window.innerWidth - rect.width - 8, (pos?.left ?? 40) - 10));
  let top = (pos?.bottom ?? 80) + 6;
  if (top + rect.height > (window.visualViewport?.height ?? window.innerHeight) - 8) top = (pos?.top ?? 80) - rect.height - 6;
  el.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
  document.addEventListener('keydown', key, true);
  document.addEventListener('pointerdown', outside, true);
}
