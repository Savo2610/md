// Tabellen im Editor: Darstellung als Raster, Tabellen-Leiste und Größenwahl.
//
// Raster: Tabellenzeilen stehen in Mono-Schrift, | werden zu feinen
// senkrechten Linien, die Trennzeile zur Linie unter der Kopfzeile. Die
// Spalten werden beim Tippen sichtbar ausgerichtet (Lücken als Widgets), ohne
// dass sich der Text ändert; das Ausrichten im Text macht Tab/Enter
// (table.ts). Breite Tabellen werden kleiner gesetzt, damit sie in die Zeile
// passen. Steht der Cursor in der Trennzeile, erscheint sie als Text.
//
// Leiste: über der Tabelle, solange der Cursor darin steht (Handy: unten
// über der Tastatur statt der normalen Leiste).

import { EditorView, ViewPlugin, Decoration, WidgetType, type DecorationSet, type ViewUpdate } from '@codemirror/view';
import type { Extension, Range } from '@codemirror/state';
import { syntaxTree } from '@codemirror/language';
import {
  findTable, cellAt, insertRow, deleteRow, insertCol, deleteCol, moveRow, moveCol, alignCol, current,
  sortBy, sortState, emptyTable, edit, type Align, type Table, type Cell,
} from './table';

// ── Raster ──────────────────────────────────────────────────────────────────

/** Sichtbare Lücke von n Zeichen. */
class Gap extends WidgetType {
  constructor(readonly n: number) { super(); }
  eq(o: Gap) { return o.n === this.n; }
  toDOM() {
    const el = document.createElement('span');
    el.className = 'cm-tbl-gap';
    el.style.width = `${this.n}ch`;
    return el;
  }
}

/** Fehlende Zellen am Zeilenende: Lücken mit angedeuteten Trennstrichen. */
class Missing extends WidgetType {
  constructor(readonly close: boolean, readonly widths: number[]) { super(); }
  eq(o: Missing) { return o.close === this.close && o.widths.join() === this.widths.join(); }
  toDOM() {
    const el = document.createElement('span');
    el.className = 'cm-tbl-missing';
    const pipe = () => { const p = document.createElement('span'); p.className = 'cm-tbl-pipe'; p.textContent = '|'; el.append(p); };
    if (this.close) pipe();
    for (const w of this.widths) {
      const g = document.createElement('span');
      g.className = 'cm-tbl-gap';
      g.style.width = `${w}ch`;
      el.append(g);
      pipe();
    }
    return el;
  }
}

interface Seg { from: number; to: number; cs: number; ce: number; w: number }

const chars = (s: string) => [...s].length;

/**
 * folds: eingeklappte Link-Adressen ([Text]↗). Sie stehen im Text, sind aber
 * nur ein Zeichen breit zu sehen; die Breiten rechnen damit.
 */
export function tableGrid(folds: (view: EditorView) => DecorationSet | undefined): Extension {
  return ViewPlugin.fromClass(class {
    decorations: DecorationSet;
    constructor(view: EditorView) { this.decorations = this.build(view); }
    update(u: ViewUpdate) {
      if (u.docChanged || u.selectionSet || u.viewportChanged || u.focusChanged || syntaxTree(u.startState) !== syntaxTree(u.state)) {
        this.decorations = this.build(u.view);
      }
    }
    build(view: EditorView): DecorationSet {
      const { state } = view;
      const out: Range<Decoration>[] = [];
      const head = state.selection.main.head;
      const folded = folds(view);
      const seen = new Set<number>();
      const visible = (a: number, b: number) => {
        let n = chars(state.sliceDoc(a, b));
        folded?.between(a, b, (x, y) => { if (x >= a && y <= b) n -= chars(state.sliceDoc(x, y)) - 1; });
        return n;
      };
      for (const { from, to } of view.visibleRanges) {
        syntaxTree(state).iterate({
          from, to,
          enter: node => {
            if (node.name !== 'Table') return;
            if (seen.has(node.from)) return false;
            seen.add(node.from);
            // Zeilen mit den Positionen ihrer |.
            const lines: { from: number; to: number; pipes: number[]; delim: boolean }[] = [];
            for (let c = node.node.firstChild; c; c = c.nextSibling) {
              const line = state.doc.lineAt(c.from);
              if (c.name === 'TableDelimiter') {
                if (c.from !== line.from || c.to - c.from < 3) continue; // ein | der Zeile, nicht die Trennzeile
                const pipes = [...line.text.matchAll(/(?<!\\)\|/g)].map(m => line.from + m.index!);
                lines.push({ from: line.from, to: line.to, pipes, delim: true });
              } else if (c.name === 'TableHeader' || c.name === 'TableRow') {
                const pipes: number[] = [];
                for (let d = c.node.firstChild; d; d = d.nextSibling) if (d.name === 'TableDelimiter') pipes.push(d.from);
                lines.push({ from: line.from, to: line.to, pipes, delim: false });
              }
            }
            // Nur Tabellen, deren Zeilen mit | beginnen (wie md sie anlegt).
            if (lines.length < 2 || lines.some(l => l.pipes[0] !== l.from)) return false;
            // Zellen: Inhalt ohne Füll-Leerzeichen (je eins bleibt stehen),
            // den Rest blendet das Raster aus und richtet selbst aus.
            const segs: { segs: Seg[]; open: boolean }[] = lines.map(l => {
              const s: Seg[] = [];
              const add = (from: number, to: number) => {
                const text = state.sliceDoc(from, to);
                const lead = text.length - text.trimStart().length;
                const trail = text.length - text.trimEnd().length;
                const empty = !text.trim();
                const cs = empty ? from + Math.min(1, text.length) : from + lead;
                const ce = empty ? cs : to - trail;
                const w = visible(cs, ce) + (cs > from ? 1 : 0) + (to > ce ? 1 : 0);
                s.push({ from, to, cs, ce, w });
              };
              for (let i = 0; i + 1 < l.pipes.length; i++) add(l.pipes[i] + 1, l.pipes[i + 1]);
              const last = l.pipes[l.pipes.length - 1] + 1;
              const open = last < l.to && state.sliceDoc(last, l.to).trim() !== '';
              if (open) add(last, l.to);
              return { segs: s, open };
            });
            const delimIdx = lines.findIndex(l => l.delim);
            const cols = Math.max(...segs.map(s => s.segs.length));
            // Die Trennzeile zählt nicht mit: Sie wird ganz vom Raster gezeichnet.
            const widths = Array.from({ length: cols }, (_, j) => Math.max(3, ...segs.filter((_s, i) => i !== delimIdx).map(s => s.segs[j]?.w ?? 0)));
            const total = 1 + widths.reduce((a, w) => a + w + 1, 0);
            const aligns: Align[] = (segs[delimIdx]?.segs ?? []).map(s => {
              const t = state.sliceDoc(s.from, s.to).trim();
              const l = t.startsWith(':'), r = t.endsWith(':');
              return l && r ? 'center' : r ? 'right' : '';
            });
            const style = `--tbl-ch: ${total}`;
            /** Bereich ausblenden, an seiner Stelle eine Lücke von n Zeichen (oder nichts). */
            const fill = (from: number, to: number, n: number, side: 1 | -1) => {
              if (to > from) out.push(Decoration.replace(n > 0 ? { widget: new Gap(n) } : {}).range(from, to));
              else if (n > 0) out.push(Decoration.widget({ widget: new Gap(n), side }).range(from));
            };
            lines.forEach((l, i) => {
              const onLine = view.hasFocus && head >= l.from && head <= l.to;
              const kind = l.delim ? `cm-tbl-delim${onLine ? ' cm-tbl-raw' : ''}` : i === 0 ? 'cm-tbl-head' : 'cm-tbl-row';
              out.push(Decoration.line({ class: `cm-tbl ${kind}`, attributes: { style } }).range(l.from));
              for (const p of l.pipes) out.push(Decoration.mark({ class: 'cm-tbl-pipe' }).range(p, p + 1));
              const { segs: s, open } = segs[i];
              if (l.delim && onLine) return; // Trennzeile zum Bearbeiten: so, wie sie im Text steht
              s.forEach((seg, j) => {
                if (l.delim) { fill(seg.from, seg.to, widths[j], 1); return; }
                const gap = Math.max(0, widths[j] - seg.w);
                const a = aligns[j] ?? '';
                const leadGap = a === 'right' ? gap : a === 'center' ? Math.floor(gap / 2) : 0;
                const lead = Math.min(seg.from + 1, seg.cs);
                fill(lead, seg.cs, leadGap, 1);
                const trail = Math.min(seg.ce + 1, seg.to);
                fill(trail, seg.to, gap - leadGap, -1);
              });
              if (open || s.length < cols) {
                out.push(Decoration.widget({ widget: new Missing(open, widths.slice(s.length)), side: 1 }).range(l.to));
              }
            });
            return false;
          },
        });
      }
      return Decoration.set(out, true);
    }
  }, { decorations: v => v.decorations });
}

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

// ── Leiste ──────────────────────────────────────────────────────────────────

const svg = (body: string) => `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true">${body}</svg>`;
const ALIGN_ICON: Record<'left' | 'center' | 'right', string> = {
  left: svg('<path d="M2.5 4h11M2.5 8h7M2.5 12h9"/>'),
  center: svg('<path d="M2.5 4h11M4.5 8h7M3.5 12h9"/>'),
  right: svg('<path d="M2.5 4h11M6.5 8h7M4.5 12h9"/>'),
};
const SORT_ICON = {
  up: svg('<path d="M4.5 2.5v11M2 11l2.5 2.5L7 11M9.5 4h4M9.5 8h3M9.5 12h2"/>'),
  down: svg('<path d="M4.5 2.5v11M2 11l2.5 2.5L7 11M9.5 4h2M9.5 8h3M9.5 12h4"/>'),
};

interface Tool {
  label: string;
  title: string;
  run: (v: EditorView) => unknown;
  off?: (t: Table, c: Cell) => boolean;
  on?: (t: Table, c: Cell) => boolean;
  html?: (t: Table, c: Cell) => string;
}

type Item = Tool | 'sep' | { group: string };

const nextCell = (v: EditorView) => edit(v, (t, c) => {
  const last = c.col >= t.cols - 1;
  const rows = t.rows.map(r => [...r]);
  const row = last ? c.row + 1 : c.row;
  if (row >= rows.length) rows.push(Array.from({ length: t.cols }, () => ''));
  return { rows, aligns: [...t.aligns], cell: { row, col: last ? 0 : c.col + 1 } };
});

function items(mobile: boolean): Item[] {
  const align = (a: 'left' | 'center' | 'right', title: string): Tool => ({
    label: '', title, run: v => alignCol(v, a), on: (t, c) => current(t, c.col) === a, html: () => ALIGN_ICON[a],
  });
  return [
    ...(mobile ? [{ label: '⇥', title: 'Nächste Zelle', run: nextCell } as Tool, 'sep' as const] : []),
    { group: 'Zeile' },
    { label: '+', title: 'Zeile darunter (⌘↵)', run: v => insertRow(v) },
    { label: '−', title: 'Zeile löschen (⌘⇧K)', run: deleteRow, off: (_t, c) => c.row === 0 },
    { label: '↑', title: 'Zeile nach oben (⌥↑)', run: v => moveRow(v, -1), off: (_t, c) => c.row <= 1 },
    { label: '↓', title: 'Zeile nach unten (⌥↓)', run: v => moveRow(v, 1), off: (t, c) => c.row === 0 || c.row >= t.rows.length - 1 },
    'sep',
    { group: 'Spalte' },
    { label: '+', title: 'Spalte rechts davon', run: v => insertCol(v) },
    { label: '−', title: 'Spalte löschen', run: deleteCol, off: t => t.cols < 2 },
    { label: '←', title: 'Spalte nach links', run: v => moveCol(v, -1), off: (_t, c) => c.col === 0 },
    { label: '→', title: 'Spalte nach rechts', run: v => moveCol(v, 1), off: (t, c) => c.col >= t.cols - 1 },
    'sep',
    align('left', 'Linksbündig'),
    align('center', 'Zentriert'),
    align('right', 'Rechtsbündig'),
    'sep',
    {
      label: '', title: 'Nach dieser Spalte sortieren', run: sortBy,
      off: t => t.rows.length < 3,
      on: (t, c) => sortState(t, c.col) !== 0,
      html: (t, c) => sortState(t, c.col) === -1 ? SORT_ICON.down : SORT_ICON.up,
    },
  ];
}

export function tableBar(): Extension {
  return ViewPlugin.fromClass(class {
    el: HTMLDivElement;
    tools: { tool: Tool; b: HTMLButtonElement }[] = [];
    mobile = matchMedia('(pointer: coarse)').matches;
    frame = 0;
    shown = false;
    constructor(readonly view: EditorView) {
      this.el = document.createElement('div');
      this.el.className = `tablebar${this.mobile ? ' mobile' : ''}`;
      this.el.setAttribute('role', 'toolbar');
      this.el.setAttribute('aria-label', 'Tabelle');
      for (const it of items(this.mobile)) {
        if (it === 'sep') {
          const s = document.createElement('span');
          s.className = 'tb-sep';
          this.el.append(s);
        } else if ('group' in it) {
          const s = document.createElement('span');
          s.className = 'tb-group';
          s.textContent = it.group;
          this.el.append(s);
        } else {
          const b = document.createElement('button');
          b.type = 'button';
          b.title = it.title;
          b.setAttribute('aria-label', it.title);
          if (it.label) b.textContent = it.label;
          b.addEventListener(this.mobile ? 'pointerdown' : 'mousedown', e => e.preventDefault());
          b.addEventListener('click', () => { it.run(this.view); this.view.focus(); });
          this.tools.push({ tool: it, b });
          this.el.append(b);
        }
      }
      document.body.append(this.el);
      if (this.mobile) {
        window.visualViewport?.addEventListener('resize', this.schedule);
        window.visualViewport?.addEventListener('scroll', this.schedule);
      }
      window.addEventListener('scroll', this.schedule, true);
    }
    update(u: ViewUpdate) {
      if (u.selectionSet || u.focusChanged || u.geometryChanged || u.docChanged || u.viewportChanged) this.schedule();
    }
    schedule = () => {
      cancelAnimationFrame(this.frame);
      this.frame = requestAnimationFrame(() => this.place());
    };
    show(on: boolean) {
      if (on === this.shown) return;
      this.shown = on;
      this.el.classList.toggle('show', on);
      if (this.mobile) document.body.classList.toggle('in-table', on);
    }
    place() {
      const { view } = this;
      const sel = view.state.selection.main;
      const t = view.hasFocus && (sel.empty || this.mobile) ? findTable(view.state, sel.head) : null;
      if (!t) return this.show(false);
      const c = cellAt(view.state, t, sel.head);
      for (const { tool, b } of this.tools) {
        b.disabled = tool.off?.(t, c) ?? false;
        b.classList.toggle('on', tool.on?.(t, c) ?? false);
        if (tool.html) {
          const h = tool.html(t, c);
          if (b.dataset.icon !== h) { b.innerHTML = h; b.dataset.icon = h; }
        }
      }
      if (this.mobile) {
        const vv = window.visualViewport;
        if (vv) this.el.style.transform = `translateY(${-(window.innerHeight - vv.height - vv.offsetTop)}px)`;
        return this.show(true);
      }
      // Über der Tabelle; ist ihr Anfang weggescrollt, oben am Rand, solange sie zu sehen ist.
      const start = view.coordsAtPos(t.from);
      const end = view.coordsAtPos(t.to);
      const box = view.scrollDOM.getBoundingClientRect();
      if (!start || !end) return this.show(false);
      const rect = this.el.getBoundingClientRect();
      const minTop = Math.max(box.top, 56) + 4;
      let top = start.top - rect.height - 6;
      if (top < minTop) top = minTop;
      if (top + rect.height > end.bottom - 4 && start.top - rect.height - 6 < minTop) {
        // Tabelle fast ganz weggescrollt: Leiste würde nur noch stören.
        if (end.bottom < minTop + rect.height + 20) return this.show(false);
      }
      const left = Math.max(box.left + 8, Math.min(box.right - rect.width - 8, start.left));
      this.el.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
      this.show(true);
    }
    destroy() {
      cancelAnimationFrame(this.frame);
      this.el.remove();
      document.body.classList.remove('in-table');
      window.visualViewport?.removeEventListener('resize', this.schedule);
      window.visualViewport?.removeEventListener('scroll', this.schedule);
      window.removeEventListener('scroll', this.schedule, true);
      closePicker?.();
    }
  });
}
