// Gemeinsame CodeMirror-Teile für den Dokument-Editor und die Memos:
// Markdown-Hervorhebung wie bei iA Writer (Zeichen blass, Text normal) und
// die Tastenkürzel zum Formatieren.

import { EditorView, keymap, MatchDecorator, Decoration, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from '@codemirror/view';
import type { CompletionContext } from '@codemirror/autocomplete';
import { EditorSelection, StateEffect, StateField, RangeSetBuilder, type EditorState, type Extension, type Text } from '@codemirror/state';
import { calc, calcNeedsRates } from '../shared/calc';
import { loadRates } from './rates';
import { insertNewlineContinueMarkup } from '@codemirror/lang-markdown';
import { HighlightStyle } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';

export const highlight = HighlightStyle.define([
  { tag: t.heading, fontWeight: '700' },
  { tag: t.strong, fontWeight: '700' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.strikethrough, textDecoration: 'line-through' },
  { tag: [t.processingInstruction, t.meta, t.contentSeparator, t.labelName], color: 'var(--markup)' },
  // Nur die Adresse in () ist blass, der Linktext bleibt normaler Text.
  { tag: t.url, color: 'var(--markup)' },
  { tag: t.monospace, fontFamily: 'var(--mono)', fontSize: '0.92em' },
  { tag: t.quote, color: 'var(--fg-soft)' },
  // Code in Codeblöcken, zurückhaltend
  { tag: [t.keyword, t.operatorKeyword], color: 'var(--code-kw)' },
  { tag: [t.string, t.special(t.string)], color: 'var(--code-str)' },
  { tag: [t.comment, t.lineComment, t.blockComment], color: 'var(--markup)', fontStyle: 'italic' },
  { tag: [t.number, t.bool, t.null], color: 'var(--code-num)' },
]);

// ── Formatieren ─────────────────────────────────────────────────────────────

export function wrap(view: EditorView, open: string, close = open): boolean {
  const { state } = view;
  view.dispatch(state.changeByRange(range => {
    const before = state.sliceDoc(range.from - open.length, range.from);
    const after = state.sliceDoc(range.to, range.to + close.length);
    if (before === open && after === close) {
      return {
        changes: [{ from: range.from - open.length, to: range.from }, { from: range.to, to: range.to + close.length }],
        range: EditorSelection.range(range.from - open.length, range.to - open.length),
      };
    }
    const text = state.sliceDoc(range.from, range.to);
    if (text.length >= open.length + close.length && text.startsWith(open) && text.endsWith(close)) {
      return {
        changes: { from: range.from, to: range.to, insert: text.slice(open.length, text.length - close.length) },
        range: EditorSelection.range(range.from, range.to - open.length - close.length),
      };
    }
    return {
      changes: [{ from: range.from, insert: open }, { from: range.to, insert: close }],
      range: EditorSelection.range(range.from + open.length, range.to + open.length),
    };
  }), { userEvent: 'input', scrollIntoView: true });
  view.focus();
  return true;
}

export function link(view: EditorView): boolean {
  const { state } = view;
  view.dispatch(state.changeByRange(range => {
    const text = state.sliceDoc(range.from, range.to);
    if (/^https?:\/\/\S+$/.test(text)) {
      return { changes: { from: range.from, to: range.to, insert: `[](${text})` }, range: EditorSelection.cursor(range.from + 1) };
    }
    const insert = `[${text}]()`;
    return { changes: { from: range.from, to: range.to, insert }, range: EditorSelection.cursor(range.from + insert.length - 1) };
  }), { userEvent: 'input' });
  view.focus();
  return true;
}

const PREFIX_RE = /^(\s*)(#{1,6} |> |- \[[ xX]\] |[-*+] |\d+\. )?/;

/** Setzt oder entfernt ein Zeilenpräfix (Liste, Zitat …) für alle markierten Zeilen. */
export function linePrefix(view: EditorView, prefix: string): boolean {
  const { state } = view;
  const lines = new Set<number>();
  for (const r of state.selection.ranges) {
    for (let l = state.doc.lineAt(r.from).number; l <= state.doc.lineAt(r.to).number; l++) lines.add(l);
  }
  const changes = [];
  let n = 1;
  for (const num of [...lines].sort((a, b) => a - b)) {
    const line = state.doc.line(num);
    const m = PREFIX_RE.exec(line.text)!;
    const current = m[2] || '';
    const want = prefix === '1. ' ? `${n++}. ` : prefix;
    const same = prefix === '1. ' ? /^\d+\. $/.test(current) : current === prefix;
    changes.push({ from: line.from + m[1].length, to: line.from + m[1].length + current.length, insert: same ? '' : want });
  }
  // Cursor hinter ein neu gesetztes Präfix (z. B. „- [ ] “), nicht davor.
  const set = state.changes(changes);
  view.dispatch({ changes: set, selection: state.selection.map(set, 1), userEvent: 'input' });
  view.focus();
  return true;
}

/**
 * Listen laufen auch weiter, wenn der Zeilenumbruch als Texteingabe kommt
 * statt als Enter-Taste (iPhone mit Wortvorschlägen, Diktat). Die Taste
 * selbst erledigt die Markdown-Tastenbelegung.
 */
export const continueListsOnInput = EditorView.inputHandler.of((view, from, to, text) => {
  if (!text.endsWith('\n') || text.slice(0, -1).includes('\n')) return false;
  const sel = view.state.selection.main;
  if (!sel.empty && (sel.from !== from || sel.to !== to)) return false;
  const line = view.state.doc.lineAt(from);
  if (!/^\s*([-*+]|\d+[.)]|>)(\s|$)/.test(line.text)) return false;
  const before = text.slice(0, -1);
  // Wort aus der Vorschlagsleiste zuerst übernehmen, dann wie Enter.
  view.dispatch({ changes: { from, to, insert: before }, selection: { anchor: from + before.length }, userEvent: 'input.type' });
  if (!insertNewlineContinueMarkup(view)) {
    const at = view.state.selection.main.head;
    view.dispatch({ changes: { from: at, insert: '\n' }, selection: { anchor: at + 1 }, userEvent: 'input.type' });
  }
  return true;
});

// ── #tags ───────────────────────────────────────────────────────────────────

const tagDecorator = new MatchDecorator({
  // Wie TAG_SOURCE, nur ohne das Zeichen davor im Treffer.
  regexp: new RegExp(`(?<=^|[\\s(])#[\\p{L}\\p{N}_-]*[\\p{L}_-][\\p{L}\\p{N}_-]*`, 'gu'),
  decoration: Decoration.mark({ class: 'cm-tag' }),
});

/** #tags im Editor farbig (Klasse cm-tag), wie später in der Ansicht. */
export const tagHighlight = ViewPlugin.fromClass(class {
  decorations: DecorationSet;
  constructor(view: EditorView) { this.decorations = tagDecorator.createDeco(view); }
  update(u: ViewUpdate) { this.decorations = tagDecorator.updateDeco(u, this.decorations); }
}, { decorations: v => v.decorations });

/** Vervollständigung nach # mit vorhandenen Tags (nur am Wortanfang). */
export function tagCompletion(tags: () => string[]) {
  return (ctx: CompletionContext) => {
    const m = ctx.matchBefore(/#[\p{L}\p{N}_-]*/u);
    if (!m) return null;
    const before = m.from > 0 ? ctx.state.sliceDoc(m.from - 1, m.from) : '';
    if (before && !/[\s(]/.test(before)) return null;
    const word = m.text.slice(1).toLowerCase();
    const options = tags().filter(t => t.toLowerCase().startsWith(word) && t.toLowerCase() !== word).map(t => ({ label: `#${t}` }));
    if (!options.length) return null;
    return { from: m.from, options, validFor: /^#[\p{L}\p{N}_-]*$/u };
  };
}

// ── Rechnen: Ergebnis hinter dem = (shared/calc.ts) ────────────────────────

class CalcResult extends WidgetType {
  constructor(readonly text: string) { super(); }
  eq(o: CalcResult) { return o.text === this.text; }
  toDOM() {
    const s = document.createElement('span');
    s.className = 'cm-calc';
    s.textContent = this.text;
    return s;
  }
}

const recalc = StateEffect.define<null>();

/** Ergebnisse nach Stelle im Dokument (hinter dem =). */
const calcField = StateField.define<Map<number, string>>({
  create: state => results(state.doc),
  update: (v, tr) => tr.docChanged || tr.effects.some(e => e.is(recalc)) ? results(tr.state.doc) : v,
  provide: f => EditorView.decorations.from(f, m => {
    const b = new RangeSetBuilder<Decoration>();
    for (const [pos, text] of m) b.add(pos, pos, Decoration.widget({ widget: new CalcResult(text), side: 1 }));
    return b.finish();
  }),
});

function results(doc: Text): Map<number, string> {
  const m = new Map<number, string>();
  const hits = calc(doc.toString()).sort((x, y) => x.line - y.line || x.at - y.at);
  for (const h of hits) if (h.line < doc.lines) m.set(doc.line(h.line + 1).from + h.at, h.text);
  return m;
}

/** Ergebnis, das hinter pos steht (für die Spaltenbreiten im Tabellenraster). */
export const calcAt = (state: EditorState, pos: number) => state.field(calcField, false)?.get(pos);

/** Ergebnisse haben sich geändert (auch ohne Textänderung, z. B. Kurse geladen). */
export const calcChanged = (u: ViewUpdate) => u.startState.field(calcField, false) !== u.state.field(calcField, false);

/** Lädt die Wechselkurse, sobald eine Rechnung sie braucht, und rechnet dann neu. */
const ratesLoader = ViewPlugin.fromClass(class {
  constructor(view: EditorView) { this.check(view); }
  update(u: ViewUpdate) { if (u.docChanged) this.check(u.view); }
  check(view: EditorView) {
    if (calcNeedsRates()) loadRates().then(got => { if (got && view.dom.isConnected) view.dispatch({ effects: recalc.of(null) }); });
  }
});

/** Zeilen auf = zeigen ihr Ergebnis, ohne dass es im Text steht. */
export const calcResults: Extension = [calcField, ratesLoader];

export function cycleHeading(view: EditorView): boolean {
  const line = view.state.doc.lineAt(view.state.selection.main.head);
  const m = /^(#{1,6}) /.exec(line.text);
  const level = m ? m[1].length : 0;
  const next = level >= 3 ? '' : '#'.repeat(level + 1) + ' ';
  view.dispatch({ changes: { from: line.from, to: line.from + (m ? m[0].length : 0), insert: next }, userEvent: 'input' });
  view.focus();
  return true;
}

export const formatKeys = keymap.of([
  { key: 'Mod-b', run: v => wrap(v, '**') },
  { key: 'Mod-i', run: v => wrap(v, '*') },
  { key: 'Mod-k', run: link },
  { key: 'Mod-Shift-x', run: v => wrap(v, '~~') },
  { key: 'Mod-Shift-c', run: v => wrap(v, '`') },
  { key: 'Mod-Shift-h', run: v => wrap(v, '==') },
  { key: 'Mod-Alt-1', run: v => setHeading(v, 1) },
  { key: 'Mod-Alt-2', run: v => setHeading(v, 2) },
  { key: 'Mod-Alt-3', run: v => setHeading(v, 3) },
  { key: 'Mod-Shift-8', run: v => linePrefix(v, '- ') },
  { key: 'Mod-Shift-7', run: v => linePrefix(v, '1. ') },
  { key: 'Mod-Shift-9', run: v => linePrefix(v, '- [ ] ') },
]);

export function setHeading(view: EditorView, level: number): boolean {
  return linePrefix(view, '#'.repeat(level) + ' ');
}
