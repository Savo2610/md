// Tabellen im Editor: Darstellung als Raster, Tabellen-Leiste und Größenwahl.
//
// Raster: Tabellenzeilen stehen in der Textschrift, | werden zu feinen
// senkrechten Linien, die Trennzeile zur Linie unter der Kopfzeile. Die
// Spalten werden beim Tippen sichtbar ausgerichtet, ohne dass sich der Text
// ändert: Füll-Leerzeichen sind ausgeblendet, an ihrer Stelle stehen Lücken
// (Widgets) mit berechneter Breite. Das Ausrichten im Text macht Tab/Enter
// (table.ts). Breite Tabellen werden kleiner gesetzt, damit sie passen.
//
// Breiten: Zelltext wird per Canvas in der Editorschrift vermessen (in em,
// zwischengespeichert pro Text), ohne Layout im Dokument. Zellen mit
// Auszeichnung (fett, Code, Links …) sehen im Editor anders aus als ihr
// Rohtext; sie werden nach dem Zeichnen einmal im DOM nachgemessen.
//
// Leiste: über der Tabelle, solange der Cursor darin steht (Handy: unten
// über der Tastatur statt der normalen Leiste).

import { EditorView, ViewPlugin, Decoration, WidgetType, type DecorationSet, type ViewUpdate } from '@codemirror/view';
import { StateEffect, type Extension, type Range } from '@codemirror/state';
import { syntaxTree } from '@codemirror/language';
import {
  findTable, cellAt, insertRow, deleteRow, insertCol, deleteCol, moveRow, moveCol, alignCol, current,
  sortBy, sortState, emptyTable, edit, notePointer, cellSlot, type Align, type Table, type Cell,
} from './table';

// ── Breiten ─────────────────────────────────────────────────────────────────

/** Innenabstand links und rechts einer Zelle, Mindestbreite des Inhalts (em). */
const PAD = 0.8;
const MIN = 1.2;

const em = (n: number) => `${Math.max(0, Math.round(n * 1000) / 1000)}em`;

let ctx: CanvasRenderingContext2D | null = null;
let family = '';
const widthCache = new Map<string, number>();
/** Im DOM nachgemessene Breiten (Zellen mit Auszeichnung), gleicher Schlüssel. */
const measured = new Map<string, number>();

/** Breite von text in em der Editorschrift (fett für die Kopfzeile). */
function textWidth(text: string, bold: boolean): number {
  const key = (bold ? 'b' : 'r') + text;
  const hit = measured.get(key) ?? widthCache.get(key);
  if (hit !== undefined) return hit;
  ctx ??= document.createElement('canvas').getContext('2d');
  if (!ctx) return text.length * 0.55;
  ctx.font = `${bold ? 700 : 400} 100px ${family}`;
  const w = ctx.measureText(text).width / 100;
  // Erst zwischenspeichern, wenn die Schrift geladen ist (sonst Ersatzschrift).
  if (document.fonts.check(`${bold ? 700 : 400} 16px ${family}`)) widthCache.set(key, w);
  return w;
}

/** Neu aufbauen (Schrift geladen, Zellen nachgemessen). */
const remeasure = StateEffect.define<null>();

// ── Raster ──────────────────────────────────────────────────────────────────

/** Sichtbare Lücke (Breite in em). */
class Gap extends WidgetType {
  constructor(readonly w: string) { super(); }
  eq(o: Gap) { return o.w === this.w; }
  toDOM() {
    const el = document.createElement('span');
    el.className = 'cm-tbl-gap';
    el.style.width = this.w;
    return el;
  }
}

/** Fehlende Zellen am Zeilenende: Lücken mit angedeuteten Trennstrichen. */
class Missing extends WidgetType {
  constructor(readonly close: boolean, readonly widths: string[]) { super(); }
  eq(o: Missing) { return o.close === this.close && o.widths.join() === this.widths.join(); }
  toDOM() {
    const el = document.createElement('span');
    el.className = 'cm-tbl-missing';
    const pipe = () => { const p = document.createElement('span'); p.className = 'cm-tbl-pipe'; p.textContent = '|'; el.append(p); };
    if (this.close) pipe();
    for (const w of this.widths) {
      const g = document.createElement('span');
      g.className = 'cm-tbl-gap';
      g.style.width = w;
      el.append(g);
      pipe();
    }
    return el;
  }
}

interface Seg { from: number; to: number; cs: number; ce: number; w: number }

/** Zelle, deren Aussehen vom Rohtext abweicht: nach dem Zeichnen nachmessen. */
interface Check { cs: number; ce: number; key: string; w: number }

const MARKUP = /[*_`~=[\]$<>^\\!]/;

/**
 * folds: eingeklappte Link-Adressen ([Text]↗). Sie stehen im Text, sind aber
 * nur als ↗ zu sehen; die Breiten rechnen damit.
 */
export function tableGrid(folds: (view: EditorView) => DecorationSet | undefined): Extension {
  return ViewPlugin.fromClass(class {
    decorations: DecorationSet;
    checks: Check[] = [];
    constructor(readonly view: EditorView) {
      family = getComputedStyle(view.contentDOM).fontFamily;
      this.decorations = this.build(view);
      this.check();
      document.fonts.ready.then(() => {
        widthCache.clear();
        measured.clear();
        if (view.dom.isConnected) view.dispatch({ effects: remeasure.of(null) });
      });
    }
    update(u: ViewUpdate) {
      if (u.docChanged || u.selectionSet || u.viewportChanged || u.focusChanged || syntaxTree(u.startState) !== syntaxTree(u.state)
        || u.transactions.some(tr => tr.effects.some(e => e.is(remeasure)))) {
        this.decorations = this.build(u.view);
        this.check();
      }
    }
    /** Zellen mit Auszeichnung so messen, wie sie im Editor erscheinen. */
    check() {
      if (!this.checks.length) return;
      const checks = this.checks;
      this.view.requestMeasure({
        key: this,
        read: view => {
          let changed = false;
          const sizes = new Map<Element, number>();
          for (const c of checks) {
            if (c.ce > view.state.doc.length || c.ce < view.viewport.from || c.cs > view.viewport.to) continue;
            try {
              const a = view.domAtPos(c.cs), b = view.domAtPos(c.ce);
              const line = (a.node.nodeType === 1 ? a.node as Element : a.node.parentElement)?.closest('.cm-line');
              if (!line) continue;
              let px = sizes.get(line);
              if (px === undefined) { px = parseFloat(getComputedStyle(line).fontSize); sizes.set(line, px); }
              const r = document.createRange();
              r.setStart(a.node, a.offset);
              r.setEnd(b.node, b.offset);
              const w = r.getBoundingClientRect().width / px;
              if (w > 0 && Math.abs(w - c.w) > 0.02) { measured.set(c.key, w); changed = true; }
            } catch { /* Stelle gerade nicht im DOM */ }
          }
          return changed;
        },
        write: (changed, view) => {
          if (changed) queueMicrotask(() => { if (view.dom.isConnected) view.dispatch({ effects: remeasure.of(null) }); });
        },
      });
    }
    build(view: EditorView): DecorationSet {
      const { state } = view;
      const out: Range<Decoration>[] = [];
      const folded = folds(view);
      const seen = new Set<number>();
      this.checks = [];
      /** Zellinhalt so, wie er zu sehen ist: eingeklappte Adressen als ↗. */
      const shown = (a: number, b: number) => {
        let text = '', at = a, fold = false;
        folded?.between(a, b, (x, y) => {
          if (x < a || y > b) return;
          text += state.sliceDoc(at, x) + '↗';
          at = y;
          fold = true;
        });
        return { text: text + state.sliceDoc(at, b), fold };
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
                lines.push({ from: line.from, to: line.to, pipes: [], delim: true });
              } else if (c.name === 'TableHeader' || c.name === 'TableRow') {
                const pipes: number[] = [];
                for (let d = c.node.firstChild; d; d = d.nextSibling) if (d.name === 'TableDelimiter') pipes.push(d.from);
                lines.push({ from: line.from, to: line.to, pipes, delim: false });
              }
            }
            // Nur Tabellen, deren Zeilen mit | beginnen (wie md sie anlegt).
            if (lines.length < 2 || lines.some(l => !l.delim && l.pipes[0] !== l.from)) return false;
            // Zellen: Inhalt ohne Füll-Leerzeichen; das Raster richtet selbst aus.
            const segs: { segs: Seg[]; open: boolean }[] = lines.map((l, i) => {
              const s: Seg[] = [];
              if (l.delim) return { segs: s, open: false };
              const bold = i === 0;
              const add = (from: number, to: number) => {
                const text = state.sliceDoc(from, to);
                const empty = !text.trim();
                const cs = empty ? from + Math.min(1, text.length) : from + text.length - text.trimStart().length;
                const ce = empty ? cs : to - (text.length - text.trimEnd().length);
                let w = 0;
                if (!empty) {
                  const v = shown(cs, ce);
                  const key = (bold ? 'b' : 'r') + v.text;
                  w = textWidth(v.text, bold);
                  if ((v.fold || MARKUP.test(v.text)) && !measured.has(key) && ce >= view.viewport.from && cs <= view.viewport.to) this.checks.push({ cs, ce, key, w });
                }
                s.push({ from, to, cs, ce, w });
              };
              for (let k = 0; k + 1 < l.pipes.length; k++) add(l.pipes[k] + 1, l.pipes[k + 1]);
              const last = l.pipes[l.pipes.length - 1] + 1;
              const open = last < l.to && state.sliceDoc(last, l.to).trim() !== '';
              if (open) add(last, l.to);
              return { segs: s, open };
            });
            const delim = lines.find(l => l.delim);
            const cols = Math.max(...segs.map(s => s.segs.length));
            const widths = Array.from({ length: cols }, (_, j) => Math.max(MIN, ...segs.map(s => s.segs[j]?.w ?? 0)));
            const total = widths.reduce((a, w) => a + w + 2 * PAD, 0);
            const aligns: Align[] = delim
              ? state.sliceDoc(delim.from, delim.to).replace(/^\s*\|/, '').replace(/\|\s*$/, '').split(/(?<!\\)\|/).map(c => {
                const t = c.trim();
                const l = t.startsWith(':'), r = t.endsWith(':');
                return l && r ? 'center' : r ? 'right' : '';
              })
              : [];
            const style = `--tbl-n: ${Math.round(total * 1000) / 1000}; --tbl-p: ${cols + 1}`;
            /** Bereich ausblenden, an seiner Stelle eine Lücke (oder nichts). */
            const fill = (from: number, to: number, w: number, side: 1 | -1) => {
              if (to > from) out.push(Decoration.replace(w > 0 ? { widget: new Gap(em(w)) } : {}).range(from, to));
              else if (w > 0) out.push(Decoration.widget({ widget: new Gap(em(w)), side }).range(from));
            };
            // Breiten aus allen Zeilen, Dekorationen nur für die gezeichneten.
            const { from: vFrom, to: vTo } = view.viewport;
            lines.forEach((l, i) => {
              if (l.to < vFrom || l.from > vTo) return;
              const kind = l.delim ? 'cm-tbl-delim' : i === 0 ? 'cm-tbl-head' : 'cm-tbl-row';
              out.push(Decoration.line({ class: `cm-tbl ${kind}`, attributes: { style } }).range(l.from));
              if (l.delim) {
                if (l.to > l.from) out.push(Decoration.replace({}).range(l.from, l.to));
                return;
              }
              for (const p of l.pipes) out.push(Decoration.mark({ class: 'cm-tbl-pipe' }).range(p, p + 1));
              const { segs: s, open } = segs[i];
              s.forEach((seg, j) => {
                const gap = Math.max(0, widths[j] - seg.w);
                const a = aligns[j] ?? '';
                const lead = PAD + (a === 'right' ? gap : a === 'center' ? gap / 2 : 0);
                // Lücke vor dem Inhalt, Cursor am Inhaltsanfang dahinter; danach umgekehrt.
                fill(seg.from, seg.cs, lead, -1);
                fill(seg.ce, seg.to, widths[j] + 2 * PAD - seg.w - lead, 1);
              });
              if (open || s.length < cols) {
                out.push(Decoration.widget({ widget: new Missing(open, widths.slice(s.length).map(w => em(w + 2 * PAD))), side: 1 }).range(l.to));
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

/** Beim Klick in eine Tabellenzeile: Spalte aus der Lage der | merken (siehe tableCursor). */
export const tablePointer = EditorView.domEventHandlers({
  pointerdown(e, view) {
    if (e.button !== 0 || e.shiftKey || e.metaKey || e.ctrlKey || e.altKey) return false;
    const lineEl = (e.target as Element | null)?.closest?.('.cm-line.cm-tbl');
    if (!lineEl || !view.contentDOM.contains(lineEl)) return false;
    const line = view.state.doc.lineAt(view.posAtDOM(lineEl, 0));
    const xs = [...lineEl.querySelectorAll('.cm-tbl-pipe')]
      .map(p => p.getBoundingClientRect())
      .filter(r => e.clientY >= r.top - 1 && e.clientY <= r.bottom + 1)
      .map(r => (r.left + r.right) / 2);
    if (xs.length < 2) return false;
    const col = Math.max(0, xs.filter(x => x < e.clientX).length - 1);
    // Ziel im Inhalt: links davon an den Anfang, rechts davon ans Ende, sonst die Stelle.
    const slot = cellSlot(view.state, line.number, col);
    if (!slot) return false;
    let target = slot.cs;
    if (slot.ce > slot.cs) {
      try {
        const a = view.domAtPos(slot.cs), b = view.domAtPos(slot.ce);
        const r = document.createRange();
        r.setStart(a.node, a.offset);
        r.setEnd(b.node, b.offset);
        const box = r.getBoundingClientRect();
        if (e.clientX >= box.right) target = slot.ce;
        else if (e.clientX > box.left) {
          const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
          target = pos === null ? slot.ce : Math.max(slot.cs, Math.min(slot.ce, pos));
        }
      } catch { target = slot.ce; }
    }
    notePointer(line.number, col, e.pointerType === 'touch', target);
    return false;
  },
});

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
      // Oberkante der ersten Zeile (nicht der Schrift), damit der Rahmen frei bleibt.
      const start = view.coordsAtPos(t.from);
      const tableTop = view.lineBlockAt(t.from).top + view.documentTop;
      const tableBottom = view.lineBlockAt(t.to).bottom + view.documentTop;
      const box = view.scrollDOM.getBoundingClientRect();
      if (!start) return this.show(false);
      const rect = this.el.getBoundingClientRect();
      const minTop = Math.max(box.top, 56) + 4;
      let top = tableTop - rect.height - 10;
      if (top < minTop) {
        // Tabelle oben weggescrollt: Leiste am oberen Rand, solange noch genug von ihr zu sehen ist.
        if (tableBottom < minTop + rect.height + 24) return this.show(false);
        top = minTop;
      }
      const left = Math.max(box.left + 8, Math.min(box.right - rect.width - 8, start.left - 4));
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
