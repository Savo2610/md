// Gemeinsame CodeMirror-Teile für den Dokument-Editor und die Memos:
// Markdown-Hervorhebung wie bei iA Writer (Zeichen blass, Text normal) und
// die Tastenkürzel zum Formatieren.

import { EditorView, keymap } from '@codemirror/view';
import { EditorSelection } from '@codemirror/state';
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
  view.dispatch({ changes, userEvent: 'input' });
  view.focus();
  return true;
}

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
