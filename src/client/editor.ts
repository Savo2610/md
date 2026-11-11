// Der Editor: CodeMirror 6 + Yjs. Wird erst geladen, wenn jemand bearbeitet,
// damit die reine Ansicht schnell bleibt.

import { EditorView, keymap, drawSelection, placeholder, ViewPlugin, Decoration, WidgetType, type DecorationSet, type ViewUpdate, dropCursor } from '@codemirror/view';
import { EditorState, EditorSelection, Compartment, RangeSetBuilder, type Extension } from '@codemirror/state';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { languages } from '@codemirror/language-data';
import { syntaxHighlighting, HighlightStyle, indentUnit, syntaxTree } from '@codemirror/language';
import { defaultKeymap, indentWithTab } from '@codemirror/commands';
import { search, searchKeymap } from '@codemirror/search';
import { autocompletion, completionKeymap, startCompletion, type CompletionContext, type Completion } from '@codemirror/autocomplete';
import { tags as t } from '@lezer/highlight';
import * as Y from 'yjs';
import { Awareness } from 'y-protocols/awareness';
import { IndexeddbPersistence } from 'y-indexeddb';
import { yCollab, yUndoManagerKeymap } from 'y-codemirror.next';
import { Provider, type Status } from './provider';
import { uploadImage } from './images';
import { render } from '../shared/render';
import { enhance } from './enhance';

export { render };

export interface EditorOptions {
  id: string;
  parent: HTMLElement;
  preview: HTMLElement;
  katexCss?: string;
  wsUrl: () => string;
  auth: () => Record<string, string>;
  /** Wird vor der ersten eigenen Änderung aufgerufen, wenn das Dokument noch nicht existiert. */
  ensureCreated: () => Promise<boolean>;
  exists: boolean;
  name: string;
  spellcheck: boolean;
  onStatus: (s: EditorStatus) => void;
  onNotice: (n: { type: string; edit?: boolean; to?: string }) => void;
  onTyping: () => void;
  toast: (msg: string) => void;
}

export interface Peer { name: string; color: string }

export interface EditorStatus { status: Status; pending: boolean; synced: boolean; peers: Peer[] }

export interface EditorHandle {
  view: EditorView;
  text(): string;
  setPreview(on: boolean): void;
  setName(name: string): void;
  setSpellcheck(on: boolean): void;
  connect(): void;
  /** Wartet, bis die lokale Kopie (IndexedDB) geladen ist. */
  whenLocal(): Promise<void>;
  /** Wartet, bis der Stand vom Server da ist (verbindet bei Bedarf). */
  whenSynced(): Promise<void>;
  focus(): void;
  destroy(): void;
}

// ── Aussehen ────────────────────────────────────────────────────────────────

// ── Rechtschreibprüfung nur für Text ────────────────────────────────────────
// Die Prüfung macht der Browser. Damit Adressen, Code und Formeln keine roten
// Wellen bekommen, tragen diese Stellen spellcheck="false".

const NO_SPELL_NODES = new Set(['URL', 'Autolink', 'InlineCode', 'FencedCode', 'CodeBlock', 'HTMLTag', 'HTMLBlock', 'LinkLabel', 'Comment', 'CommentBlock']);
const NO_SPELL_PATTERNS = [
  /(?:https?:\/\/)?\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}\b(?:\/[^\s)\]]*)?/gi, // md.veerka.mp, https://…
  /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, // E-Mail
  /\$\$[\s\S]*?\$\$|\$[^\s$](?:[^$\n]*[^\s$])?\$/g, // Formeln
  /\{%[^%\n]*%\}/g, // {%youtube … %}
  /^---\n[\s\S]*?\n---$/gm, // Front Matter
];
const noSpell = Decoration.mark({ attributes: { spellcheck: 'false', autocorrect: 'off' } });

const spellExclusions = ViewPlugin.fromClass(class {
  decorations: DecorationSet;
  constructor(view: EditorView) { this.decorations = this.build(view); }
  update(u: ViewUpdate) {
    if (u.docChanged || u.viewportChanged || syntaxTree(u.startState) !== syntaxTree(u.state)) this.decorations = this.build(u.view);
  }
  build(view: EditorView): DecorationSet {
    const ranges: [number, number][] = [];
    for (const { from, to } of view.visibleRanges) {
      syntaxTree(view.state).iterate({
        from, to,
        enter: node => {
          if (!NO_SPELL_NODES.has(node.name)) return;
          ranges.push([node.from, node.to]);
          return false;
        },
      });
      const text = view.state.sliceDoc(from, to);
      for (const re of NO_SPELL_PATTERNS) {
        re.lastIndex = 0;
        for (const m of text.matchAll(re)) ranges.push([from + m.index!, from + m.index! + m[0].length]);
      }
    }
    ranges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const b = new RangeSetBuilder<Decoration>();
    let cur: [number, number] | null = null;
    for (const r of ranges) {
      if (r[1] <= r[0]) continue;
      if (cur && r[0] <= cur[1]) { cur[1] = Math.max(cur[1], r[1]); continue; }
      if (cur) b.add(cur[0], cur[1], noSpell);
      cur = [r[0], r[1]];
    }
    if (cur) b.add(cur[0], cur[1], noSpell);
    return b.finish();
  }
}, { decorations: v => v.decorations });

const spellAttrs = (on: boolean) => EditorView.contentAttributes.of({
  spellcheck: on ? 'true' : 'false',
  autocorrect: on ? 'on' : 'off',
  autocapitalize: 'sentences',
  'aria-label': 'Dokument',
});

const highlight = HighlightStyle.define([
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

const theme = EditorView.theme({
  '&': { height: '100%', backgroundColor: 'transparent', color: 'var(--fg)' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: 'var(--font)', lineHeight: '1.7', overflowX: 'hidden' },
  '.cm-content': {
    maxWidth: 'var(--measure)', margin: '0 auto', padding: 'var(--editor-top) var(--gutter) 45vh',
    caretColor: 'var(--caret)',
  },
  '.cm-line': { padding: '0' },
  '.cm-cursor, .cm-dropCursor': { borderLeft: '2px solid var(--caret)', marginLeft: '-1px' },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
    backgroundColor: 'var(--selection) !important',
  },
  '.cm-placeholder': { color: 'var(--faint)' },
  '.cm-tooltip': { border: '1px solid var(--line)', backgroundColor: 'var(--bg)', borderRadius: '4px', boxShadow: 'var(--shadow)' },
  '.cm-tooltip-autocomplete > ul': { fontFamily: 'var(--font)', maxHeight: '18em' },
  '.cm-tooltip-autocomplete > ul > li': { padding: '4px 10px !important', lineHeight: '1.5' },
  '.cm-tooltip-autocomplete > ul > li[aria-selected]': { backgroundColor: 'var(--soft)', color: 'var(--fg)' },
  '.cm-completionDetail': { color: 'var(--muted)', fontStyle: 'normal', fontFamily: 'var(--mono)', fontSize: '.8em', marginLeft: '1em' },
  '.cm-completionLabel': {},
  '.cm-completionIcon': { display: 'none' },
  '.cm-panels': { backgroundColor: 'var(--bg)', color: 'var(--fg)' },
  '.cm-panels.cm-panels-bottom': { borderTop: '1px solid var(--line)' },
  '.cm-searchMatch': { backgroundColor: 'var(--mark)' },
  '.cm-ySelectionInfo': { fontFamily: 'var(--font)', fontSize: '11px', padding: '1px 4px', borderRadius: '3px', opacity: '1', top: '-1.4em' },
});

// ── Formatieren ─────────────────────────────────────────────────────────────

function wrap(view: EditorView, open: string, close = open): boolean {
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

function link(view: EditorView): boolean {
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
function linePrefix(view: EditorView, prefix: string): boolean {
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

function cycleHeading(view: EditorView): boolean {
  const line = view.state.doc.lineAt(view.state.selection.main.head);
  const m = /^(#{1,6}) /.exec(line.text);
  const level = m ? m[1].length : 0;
  const next = level >= 3 ? '' : '#'.repeat(level + 1) + ' ';
  view.dispatch({ changes: { from: line.from, to: line.from + (m ? m[0].length : 0), insert: next }, userEvent: 'input' });
  view.focus();
  return true;
}

const formatKeys = keymap.of([
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

function setHeading(view: EditorView, level: number): boolean {
  return linePrefix(view, '#'.repeat(level) + ' ');
}

// ── Slash-Menü ──────────────────────────────────────────────────────────────

interface Slash {
  name: string;
  /** Suchbegriffe, deutsch und englisch, durch Leerzeichen getrennt. */
  key: string;
  hint: string;
  snippet?: string;
  inline?: boolean;
  /** Nur bei passender Suche zeigen (Programmiersprachen, Diagrammtypen). */
  hidden?: boolean;
  run?: (view: EditorView) => void;
}

const fence = (lang: string, body = '‸') => '```' + lang + '\n' + body + '\n```';

/** Codeblöcke für einzelne Sprachen: /python, /js, /bash … */
const LANGUAGES: [string, string, string][] = [
  ['Python', 'python', 'python py'],
  ['JavaScript', 'javascript', 'javascript js node'],
  ['TypeScript', 'typescript', 'typescript ts'],
  ['HTML', 'html', 'html web'],
  ['CSS', 'css', 'css style'],
  ['SCSS', 'scss', 'scss sass'],
  ['JSON', 'json', 'json'],
  ['YAML', 'yaml', 'yaml yml'],
  ['XML', 'xml', 'xml'],
  ['Bash / Terminal', 'bash', 'bash shell sh zsh terminal konsole kommandozeile'],
  ['PowerShell', 'powershell', 'powershell ps1 windows'],
  ['SQL', 'sql', 'sql datenbank database'],
  ['Java', 'java', 'java'],
  ['Kotlin', 'kotlin', 'kotlin kt'],
  ['C', 'c', 'c'],
  ['C++', 'cpp', 'c++ cpp'],
  ['C#', 'csharp', 'c# csharp cs dotnet'],
  ['Go', 'go', 'go golang'],
  ['Rust', 'rust', 'rust rs'],
  ['PHP', 'php', 'php'],
  ['Ruby', 'ruby', 'ruby rb'],
  ['Swift', 'swift', 'swift ios'],
  ['Lua', 'lua', 'lua'],
  ['R', 'r', 'r statistik statistics'],
  ['Markdown', 'markdown', 'markdown md'],
  ['Diff', 'diff', 'diff patch'],
  ['Dockerfile', 'dockerfile', 'dockerfile docker'],
  ['Makefile', 'makefile', 'makefile make'],
  ['Ini / TOML', 'ini', 'ini toml config konfiguration'],
  ['Text (ohne Farben)', 'text', 'text plain plaintext'],
];

/** Mermaid-Vorlagen: /sequenz, /gantt, /pie … */
const DIAGRAMS: [string, string, string][] = [
  ['Flussdiagramm', 'flussdiagramm ablauf flowchart flow graph', 'flowchart TD\n  A[Start] --> B{Frage?}\n  B -- Ja --> C[Weiter]\n  B -- Nein --> D[Ende]‸'],
  ['Sequenzdiagramm', 'sequenzdiagramm ablauf sequence', 'sequenceDiagram\n  Alice->>Bob: Hallo Bob!\n  Bob-->>Alice: Hallo Alice!‸'],
  ['Gantt / Zeitplan', 'gantt zeitplan projektplan timeline schedule', 'gantt\n  title Projekt\n  dateFormat YYYY-MM-DD\n  section Planung\n  Idee     :a1, 2026-01-01, 7d\n  Umsetzen :after a1, 14d‸'],
  ['Kreisdiagramm', 'kreisdiagramm torte pie chart', 'pie title Aufteilung\n  "A" : 40\n  "B" : 35\n  "C" : 25‸'],
  ['Mindmap', 'mindmap gedanken brainstorming', 'mindmap\n  root((Thema))\n    Idee 1\n    Idee 2\n      Detail‸'],
  ['Klassendiagramm', 'klassendiagramm uml class', 'classDiagram\n  class Tier {\n    +name\n    +essen()\n  }\n  Tier <|-- Hund‸'],
  ['Zustandsdiagramm', 'zustandsdiagramm state', 'stateDiagram-v2\n  [*] --> Aus\n  Aus --> An: einschalten\n  An --> Aus: ausschalten‸'],
  ['Zeitstrahl', 'zeitstrahl chronik timeline geschichte history', 'timeline\n  title Verlauf\n  2024 : Start\n  2025 : Ausbau\n  2026 : Fertig‸'],
  ['ER-Diagramm', 'er entity datenbank database', 'erDiagram\n  KUNDE ||--o{ BESTELLUNG : gibt\n  BESTELLUNG ||--|{ POSTEN : enthält‸'],
];

function slashItems(pickImage: () => void): Slash[] {
  return [
    { name: 'Überschrift 1', key: 'h1 überschrift titel heading title header', hint: '#', snippet: '# ‸' },
    { name: 'Überschrift 2', key: 'h2 überschrift heading header', hint: '##', snippet: '## ‸' },
    { name: 'Überschrift 3', key: 'h3 überschrift heading header', hint: '###', snippet: '### ‸' },
    { name: 'Liste', key: 'liste aufzählung list bullet', hint: '-', snippet: '- ‸' },
    { name: 'Nummerierte Liste', key: 'nummeriert liste numbered ordered list', hint: '1.', snippet: '1. ‸' },
    { name: 'Aufgabe', key: 'aufgabe todo checkbox task check', hint: '- [ ]', snippet: '- [ ] ‸' },
    { name: 'Zitat', key: 'zitat quote citation', hint: '>', snippet: '> ‸' },
    { name: 'Link', key: 'link url verweis', hint: '[](…)', snippet: '[‸](https://)', inline: true },
    { name: 'Tabelle', key: 'tabelle table', hint: '| |', snippet: '| Spalte | Spalte |\n| ------ | ------ |\n| ‸ | |' },
    { name: 'Codeblock', key: 'code codeblock snippet programm', hint: '```', snippet: fence('') },
    { name: 'Info', key: 'info box hinweis note callout', hint: ':::info', snippet: ':::info\n‸\n:::' },
    { name: 'Achtung', key: 'achtung warnung warning caution', hint: ':::warning', snippet: ':::warning\n‸\n:::' },
    { name: 'Erfolg', key: 'erfolg tipp success tip', hint: ':::success', snippet: ':::success\n‸\n:::' },
    { name: 'Gefahr', key: 'gefahr danger error fehler', hint: ':::danger', snippet: ':::danger\n‸\n:::' },
    { name: 'Aufklappbar', key: 'aufklappbar spoiler details collapse toggle accordion', hint: ':::spoiler', snippet: ':::spoiler Mehr anzeigen\n‸\n:::' },
    { name: 'Bild hochladen', key: 'bild foto image picture photo upload hochladen', hint: 'Datei', run: pickImage },
    { name: 'Bild per Link', key: 'bild link url image picture photo extern adresse', hint: '![](…)', snippet: '![](‸)' },
    { name: 'Formel', key: 'formel mathe latex math equation block', hint: '$$', snippet: '$$\n‸\n$$' },
    { name: 'Formel im Text', key: 'formel mathe latex math inline text', hint: '$…$', snippet: '$‸$', inline: true },
    { name: 'Diagramm', key: 'diagramm mermaid chart diagram graph', hint: 'mermaid', snippet: fence('mermaid', DIAGRAMS[0][2]) },
    { name: 'YouTube', key: 'youtube video', hint: '{%youtube %}', snippet: '{%youtube ‸ %}' },
    { name: 'Vimeo', key: 'vimeo video', hint: '{%vimeo %}', snippet: '{%vimeo ‸ %}' },
    { name: 'Inhaltsverzeichnis', key: 'inhaltsverzeichnis toc contents inhalt', hint: '[toc]', snippet: '[toc]\n‸' },
    { name: 'Fußnote', key: 'fußnote footnote anmerkung', hint: '[^1]', inline: true, run: footnote },
    { name: 'Trennlinie', key: 'trennlinie linie hr divider separator line', hint: '---', snippet: '---\n‸' },
    { name: 'Markiert', key: 'markiert hervorheben highlight mark', hint: '==…==', snippet: '==‸==', inline: true },
    { name: 'Unterstrichen', key: 'unterstrichen underline insert', hint: '++…++', snippet: '++‸++', inline: true },
    { name: 'Hochgestellt', key: 'hochgestellt hoch superscript sup exponent', hint: '^…^', snippet: '^‸^', inline: true },
    { name: 'Tiefgestellt', key: 'tiefgestellt tief subscript sub index', hint: '~…~', snippet: '~‸~', inline: true },
    ...LANGUAGES.map(([name, lang, key]): Slash => ({ name: `Code: ${name}`, key: `${key} code`, hint: '```' + lang, snippet: fence(lang), hidden: true })),
    ...DIAGRAMS.map(([name, key, body]): Slash => ({ name: `Diagramm: ${name}`, key: `${key} diagramm mermaid diagram`, hint: 'mermaid', snippet: fence('mermaid', body), hidden: true })),
  ];
}

/** Klein, ohne Akzente: „Überschrift“ findet man auch mit /uberschrift. */
const fold = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

/** Nummer an der Cursorstelle, Fußnotentext am Ende des Dokuments. */
function footnote(view: EditorView) {
  const doc = view.state.doc.toString();
  const used = [...doc.matchAll(/\[\^(\d+)\]/g)].map(m => Number(m[1]));
  const n = used.length ? Math.max(...used) + 1 : 1;
  const pos = view.state.selection.main.head;
  const tail = `${doc.endsWith('\n') ? '' : '\n'}\n[^${n}]: `;
  view.dispatch({
    changes: [{ from: pos, insert: `[^${n}]` }, { from: doc.length, insert: tail }],
    selection: { anchor: doc.length + `[^${n}]`.length + tail.length },
    scrollIntoView: true,
    userEvent: 'input',
  });
}

function insertSnippet(view: EditorView, from: number, to: number, snippet: string) {
  const cursor = snippet.indexOf('‸');
  const text = snippet.replace('‸', '');
  view.dispatch({
    changes: { from, to, insert: text },
    selection: { anchor: from + (cursor === -1 ? text.length : cursor) },
    userEvent: 'input',
  });
}

function slashSource(items: Slash[]) {
  return (ctx: CompletionContext) => {
    const line = ctx.state.doc.lineAt(ctx.pos);
    const before = line.text.slice(0, ctx.pos - line.from);
    // Am Zeilenanfang (auch nach "- " oder "> ") oder nach einem Leerzeichen.
    const m = /(^|\s)\/([\p{L}\d+#-]*)$/u.exec(before);
    if (!m) return null;
    const from = line.from + m.index + m[1].length;
    const midLine = before.slice(0, from - line.from).replace(/^\s*(?:[-*+] |> )?/, '').trim() !== '';
    const q = fold(m[2]);
    // Rang: 3 = Suchbegriff genau, 2 = Name/Begriff fängt so an, 1 = kommt vor.
    const score = (it: Slash) => {
      if (!q) return it.hidden ? -1 : 1;
      const words = fold(it.key).split(' ').concat(fold(it.name).split(/[^\p{L}\d+#]+/u));
      if (words.includes(q)) return 3;
      if (words.some(w => w.startsWith(q))) return 2;
      if (!it.hidden && (fold(it.key).includes(q) || fold(it.name).includes(q))) return 1;
      return -1;
    };
    const ranked = items
      .map((it, i) => ({ it, i, s: score(it) }))
      .filter(x => x.s >= 0 && (!x.it.hidden || q.length >= 1))
      .sort((a, b) => b.s - a.s || a.i - b.i);
    return {
      from,
      filter: false,
      options: ranked.map(({ it }): Completion => ({
        label: it.name,
        detail: it.hint,
        apply: (view, _c, f, to) => {
          if (it.run) { view.dispatch({ changes: { from: f, to }, userEvent: 'input' }); it.run(view); }
          // Blöcke mitten im Satz: in eine eigene Zeile setzen.
          else insertSnippet(view, f, to, midLine && !it.inline ? '\n\n' + it.snippet! : it.snippet!);
        },
      })),
    };
  };
}

// ── Link-Adressen einklappen ────────────────────────────────────────────────
// [Text](https://lange-adresse) erscheint als [Text]↗, solange der Cursor
// nicht im Link steht. Im Dokument bleibt es normales Markdown.

class LinkFold extends WidgetType {
  constructor(readonly url: string, readonly pos: number) { super(); }
  eq(other: LinkFold) { return other.url === this.url && other.pos === this.pos; }
  toDOM(view: EditorView) {
    const el = document.createElement('span');
    el.className = 'cm-linkfold';
    el.textContent = '↗';
    el.title = this.url;
    el.setAttribute('aria-label', `Link: ${this.url}`);
    el.addEventListener('mousedown', e => {
      e.preventDefault();
      view.dispatch({ selection: { anchor: this.pos } });
      view.focus();
    });
    return el;
  }
  ignoreEvent() { return false; }
}

const linkFolding = ViewPlugin.fromClass(class {
  decorations: DecorationSet;
  constructor(view: EditorView) { this.decorations = this.build(view); }
  update(u: ViewUpdate) {
    if (u.docChanged || u.selectionSet || u.viewportChanged || u.focusChanged || syntaxTree(u.startState) !== syntaxTree(u.state)) {
      this.decorations = this.build(u.view);
    }
  }
  build(view: EditorView): DecorationSet {
    const b = new RangeSetBuilder<Decoration>();
    const sel = view.state.selection.ranges;
    for (const { from, to } of view.visibleRanges) {
      syntaxTree(view.state).iterate({
        from, to,
        enter: node => {
          if (node.name !== 'Link' && node.name !== 'Image') return;
          const marks: { from: number; to: number }[] = [];
          let urlNode: { from: number; to: number } | null = null;
          for (let c = node.node.firstChild; c; c = c.nextSibling) {
            if (c.name === 'LinkMark') marks.push({ from: c.from, to: c.to });
            else if (c.name === 'URL') urlNode = { from: c.from, to: c.to };
          }
          // Erwartet: [ ] ( … ) – sonst (Referenz-Links, leere Adresse) nichts tun.
          if (!urlNode || marks.length < 4) return false;
          const open = marks[marks.length - 2], close = marks[marks.length - 1];
          if (view.state.sliceDoc(open.from, open.to) !== '(' || view.state.sliceDoc(close.from, close.to) !== ')') return false;
          if (view.state.doc.lineAt(open.from).number !== view.state.doc.lineAt(close.to).number) return false;
          const touched = sel.some(r => r.to >= node.from && r.from <= node.to);
          if (touched) return false;
          const url = view.state.sliceDoc(urlNode.from, urlNode.to);
          b.add(open.from, close.to, Decoration.replace({ widget: new LinkFold(url, urlNode.from) }));
          return false;
        },
      });
    }
    return b.finish();
  }
}, { decorations: v => v.decorations });

// ── Links einfügen ──────────────────────────────────────────────────────────

const URL_ONLY = /^https?:\/\/[^\s<>"]+$/i;
const IMAGE_URL = /\.(?:jpe?g|png|gif|webp|avif|svg)(?:[?#][^\s]*)?$/i;

/** Linktext darf keine eckigen Klammern enthalten, die das Markdown brechen. */
const escapeLabel = (t: string) => t.replace(/([\\[\]])/g, '\\$1');

/** YouTube- oder Vimeo-Adresse → { kind, id }, sonst null. */
export function videoOf(raw: string): { kind: 'youtube' | 'vimeo'; id: string } | null {
  let u: URL;
  try { u = new URL(raw); } catch { return null; }
  const host = u.hostname.replace(/^(www|m|music)\./, '');
  if (host === 'youtu.be') {
    const id = u.pathname.slice(1).split('/')[0];
    return /^[\w-]{11}$/.test(id) ? { kind: 'youtube', id } : null;
  }
  if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    const v = u.searchParams.get('v');
    if (v && /^[\w-]{11}$/.test(v)) return { kind: 'youtube', id: v };
    const m = /^\/(?:shorts|embed|live|v)\/([\w-]{11})/.exec(u.pathname);
    return m ? { kind: 'youtube', id: m[1] } : null;
  }
  if (host === 'vimeo.com' || host === 'player.vimeo.com') {
    const m = /^\/(?:video\/)?(\d{5,})/.exec(u.pathname);
    return m ? { kind: 'vimeo', id: m[1] } : null;
  }
  return null;
}

function domainOf(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; }
}

/** Steht die Position in Code oder schon in einer Link-Adresse? Dann normal einfügen. */
function inCodeOrUrl(state: EditorState, pos: number): boolean {
  // Offener Inline-Code (`… ohne schließendes `) ist für den Parser noch kein Code.
  const line = state.doc.lineAt(pos);
  if ((state.sliceDoc(line.from, pos).match(/`/g) || []).length % 2 === 1) return true;
  for (let n: ReturnType<ReturnType<typeof syntaxTree>['resolveInner']> | null = syntaxTree(state).resolveInner(pos, -1); n; n = n.parent) {
    if (['URL', 'InlineCode', 'FencedCode', 'CodeBlock', 'Autolink', 'LinkLabel'].includes(n.name)) return true;
  }
  return false;
}

// ── Auswahl-Leiste ──────────────────────────────────────────────────────────

function selectionToolbar(): Extension {
  return ViewPlugin.fromClass(class {
    el: HTMLDivElement;
    pointerDown = false;
    frame = 0;
    constructor(readonly view: EditorView) {
      this.el = document.createElement('div');
      this.el.className = 'seltools';
      this.el.setAttribute('role', 'toolbar');
      const buttons: [string, string, (v: EditorView) => boolean][] = [
        ['B', 'Fett (⌘B)', v => wrap(v, '**')],
        ['I', 'Kursiv (⌘I)', v => wrap(v, '*')],
        ['S', 'Durchgestrichen', v => wrap(v, '~~')],
        ['H', 'Überschrift', cycleHeading],
        ['==', 'Markieren', v => wrap(v, '==')],
        ['`', 'Code', v => wrap(v, '`')],
        ['Link', 'Link (⌘K)', link],
      ];
      for (const [label, title, run] of buttons) {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = label;
        b.title = title;
        b.className = `sel-${label === '==' ? 'mark' : label.toLowerCase()}`;
        b.addEventListener('mousedown', e => e.preventDefault());
        b.addEventListener('click', () => run(this.view));
        this.el.append(b);
      }
      document.body.append(this.el);
      view.contentDOM.addEventListener('pointerdown', this.down);
      document.addEventListener('pointerup', this.up);
    }
    down = () => { this.pointerDown = true; this.hide(); };
    up = () => { if (this.pointerDown) { this.pointerDown = false; this.schedule(); } };
    update(u: ViewUpdate) {
      if (u.selectionSet || u.focusChanged || u.geometryChanged || u.docChanged) this.schedule();
    }
    schedule() {
      cancelAnimationFrame(this.frame);
      this.frame = requestAnimationFrame(() => this.position());
    }
    hide() { this.el.classList.remove('show'); }
    position() {
      const { view } = this;
      const sel = view.state.selection.main;
      if (sel.empty || this.pointerDown || !view.hasFocus || matchMedia('(pointer: coarse)').matches) return this.hide();
      const start = view.coordsAtPos(sel.from);
      const end = view.coordsAtPos(sel.to);
      if (!start || !end) return this.hide();
      const rect = this.el.getBoundingClientRect();
      const left = Math.max(8, Math.min(window.innerWidth - rect.width - 8, (start.left + (start.top === end.top ? end.left : start.left)) / 2 - rect.width / 2));
      let top = start.top - rect.height - 8;
      if (top < 56) top = end.bottom + 8;
      this.el.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
      this.el.classList.add('show');
    }
    destroy() {
      this.el.remove();
      this.view.contentDOM.removeEventListener('pointerdown', this.down);
      document.removeEventListener('pointerup', this.up);
    }
  });
}

// ── Handy-Leiste über der Tastatur ──────────────────────────────────────────

function mobileToolbar(view: EditorView, pickImage: () => void): () => void {
  if (!matchMedia('(pointer: coarse)').matches) return () => {};
  const bar = document.createElement('div');
  bar.className = 'mobiletools';
  const buttons: [string, string, () => void][] = [
    ['/', 'Einfügen', () => { const pos = view.state.selection.main.head; view.dispatch({ changes: { from: pos, insert: '/' }, selection: { anchor: pos + 1 } }); startCompletion(view); }],
    ['H', 'Überschrift', () => cycleHeading(view)],
    ['B', 'Fett', () => wrap(view, '**')],
    ['I', 'Kursiv', () => wrap(view, '*')],
    ['–', 'Liste', () => linePrefix(view, '- ')],
    ['☐', 'Aufgabe', () => linePrefix(view, '- [ ] ')],
    ['Link', 'Link', () => link(view)],
    ['Bild', 'Bild', pickImage],
  ];
  for (const [label, title, run] of buttons) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.setAttribute('aria-label', title);
    b.addEventListener('pointerdown', e => e.preventDefault());
    b.addEventListener('click', run);
    bar.append(b);
  }
  document.body.append(bar);
  const vv = window.visualViewport;
  const place = () => {
    if (!vv) return;
    bar.style.transform = `translateY(${-(window.innerHeight - vv.height - vv.offsetTop)}px)`;
  };
  vv?.addEventListener('resize', place);
  vv?.addEventListener('scroll', place);
  const onFocus = () => { bar.classList.toggle('show', view.hasFocus); place(); };
  view.contentDOM.addEventListener('focus', onFocus);
  view.contentDOM.addEventListener('blur', () => setTimeout(onFocus, 100));
  return () => bar.remove();
}

// ── Zusammenbauen ───────────────────────────────────────────────────────────

const COLORS = ['#1a8cff', '#e5484d', '#30a46c', '#f76b15', '#8e4ec6', '#d6409f', '#0797a0', '#a18072'];

export function mountEditor(o: EditorOptions): EditorHandle {
  const ydoc = new Y.Doc();
  const ytext = ydoc.getText('md');
  const awareness = new Awareness(ydoc);
  const color = COLORS[Math.floor(Math.random() * COLORS.length)];
  awareness.setLocalStateField('user', { name: o.name || 'Gast', color, colorLight: color + '33' });
  const undoManager = new Y.UndoManager(ytext);

  let created = o.exists;
  let creating: Promise<boolean> | null = null;
  let peers: Peer[] = [];
  let pending = false;

  // Lokale Kopie im Browser (IndexedDB): Das Dokument öffnet auch offline,
  // und was ohne Netz geschrieben wird, geht beim nächsten Verbinden raus.
  const local = new IndexeddbPersistence(`md:${o.id}`, ydoc);
  const dropLocal = () => { local.clearData().catch(() => {}); };

  let syncWaiters: (() => void)[] = [];
  const provider = new Provider(ydoc, awareness, o.wsUrl, {
    status: s => { if (s === 'gone') dropLocal(); report(); },
    synced: () => { report(); view.dispatch({}); syncWaiters.forEach(f => f()); syncWaiters = []; },
    notice: n => {
      // Umgezogen oder kein Bearbeitungsrecht: die lokale Kopie gehört hier nicht mehr hin.
      if (n.type === 'moved' || (n.type === 'hello' && n.edit === false)) dropLocal();
      o.onNotice(n);
    },
    pending: p => { pending = p; report(); },
  });
  const report = () => o.onStatus({ status: provider.status, pending, peers, synced: provider.synced });
  awareness.on('change', () => {
    peers = [...awareness.getStates().entries()]
      .filter(([client, st]) => client !== ydoc.clientID && st.user)
      .map(([, st]) => ({ name: String(st.user.name || 'Gast'), color: String(st.user.color || '#888') }));
    report();
  });

  // Neues Dokument: erst beim ersten Tastendruck anlegen, dann verbinden.
  ydoc.on('update', (_u: Uint8Array, origin: unknown) => {
    if (created || origin === provider) return;
    creating ??= o.ensureCreated().then(ok => {
      if (ok) { created = true; provider.connect(); }
      else creating = null;
      return ok;
    });
  });

  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = 'image/*';
  fileInput.multiple = true;
  fileInput.addEventListener('change', () => {
    if (fileInput.files) insertImages([...fileInput.files], view.state.selection.main.head);
    fileInput.value = '';
  });
  const pickImage = () => fileInput.click();

  async function insertImages(files: File[], pos: number) {
    const images = files.filter(f => f.type.startsWith('image/'));
    if (!images.length) return;
    if (!created && !(await (creating ?? o.ensureCreated()))) return;
    created = true;
    for (const file of images) {
      const marker = `![Bild wird hochgeladen … ${Math.random().toString(36).slice(2, 8)}]()`;
      const line = view.state.doc.lineAt(Math.min(pos, view.state.doc.length));
      const insert = (line.text.trim() ? '\n' : '') + marker + '\n';
      view.dispatch({ changes: { from: pos, insert }, userEvent: 'input' });
      pos += insert.length;
      try {
        const url = await uploadImage(o.id, file, o.auth());
        const name = file.name.replace(/\.[^.]+$/, '').replace(/[[\]]/g, '');
        replaceText(marker, `![${/^image$|^IMG_|^\d+$/.test(name) ? '' : name}](${url})`);
      } catch (err) {
        replaceText(marker, '');
        o.toast((err as Error).message);
      }
    }
  }

  /**
   * Eingefügte Adresse:
   *  - über markiertem Text → [Text](url), Cursor dahinter
   *  - Bilddatei (.jpg, .png …) → ![](url)
   *  - sonst [Domain](url); der Server holt dann den Seitentitel. Ist die
   *    Adresse ein Bild oder ein geteiltes Google-Fotos-Bild, wird daraus
   *    ![](bild-url). Ersetzt wird nur, wenn den Link niemand geändert hat.
   */
  function pasteLink(url: string) {
    const { state } = view;
    const sel = state.selection.main;
    const selected = state.sliceDoc(sel.from, sel.to);
    if (inCodeOrUrl(state, sel.from) || (sel.empty && /\]\($/.test(state.sliceDoc(sel.from - 2, sel.from)))) {
      view.dispatch(state.replaceSelection(url), { userEvent: 'input.paste' });
      return;
    }
    const put = (insert: string) =>
      view.dispatch({ changes: { from: sel.from, to: sel.to, insert }, selection: { anchor: sel.from + insert.length }, userEvent: 'input.paste' });
    if (!sel.empty && !selected.includes('\n') && !URL_ONLY.test(selected.trim())) {
      put(`[${escapeLabel(selected)}](${url})`);
      return;
    }
    if (IMAGE_URL.test(url)) {
      put(`![](${url})`);
      return;
    }
    // YouTube/Vimeo: einbetten. Steht der Cursor schon in {%youtube … %},
    // nur die ID einsetzen; sonst die ganze Einbettung in eigener Zeile.
    const video = videoOf(url);
    if (video) {
      const line = state.doc.lineAt(sel.from);
      const before = state.sliceDoc(line.from, sel.from);
      const after = state.sliceDoc(sel.to, line.to);
      if (/\{%\s*(youtube|vimeo)\s+$/.test(before)) {
        put(video.id + (/^\s*%\}/.test(after) ? '' : ' %}'));
        return;
      }
      const embed = `{%${video.kind} ${video.id} %}`;
      // Eigene Zeile davor und danach, Cursor landet in der Zeile nach dem Video.
      put((before.trim() ? '\n\n' : '') + embed + (after.trim() ? '\n\n' : '\n'));
      return;
    }
    const placeholder = escapeLabel(domainOf(url));
    const insert = `[${placeholder}](${url})`;
    put(insert);
    fetchPreview(url).then(({ title, image }) => {
      if (image) replaceText(insert, `![${escapeLabel(title)}](${image})`);
      else if (title && title !== placeholder) replaceText(insert, `[${escapeLabel(title)}](${url})`);
    });
  }

  async function fetchPreview(url: string): Promise<{ title: string; image: string }> {
    const none = { title: '', image: '' };
    // Ein neues Dokument wird gerade durch das Einfügen angelegt – abwarten.
    if (!created) await (creating ?? Promise.resolve(false));
    if (!created) return none;
    try {
      const res = await fetch(`/api/docs/${encodeURIComponent(o.id)}/title?url=${encodeURIComponent(url)}`, { headers: o.auth() });
      if (!res.ok) return none;
      const data = await res.json();
      return { title: String(data.title || ''), image: String(data.image || '') };
    } catch {
      return none;
    }
  }

  function replaceText(find: string, insert: string) {
    const idx = view.state.doc.toString().indexOf(find);
    if (idx === -1) return;
    view.dispatch({ changes: { from: idx, to: idx + find.length, insert } });
  }


  let previewTimer: ReturnType<typeof setTimeout> | null = null;
  let previewOn = false;
  const updatePreview = () => {
    if (!previewOn) return;
    o.preview.innerHTML = render(ytext.toString()).html;
    enhance(o.preview, o.katexCss);
  };

  const spellComp = new Compartment();
  const view = new EditorView({
    parent: o.parent,
    state: EditorState.create({
      doc: ytext.toString(),
      extensions: [
        keymap.of([...completionKeymap]),
        formatKeys,
        keymap.of([...yUndoManagerKeymap, ...searchKeymap, indentWithTab, ...defaultKeymap]),
        drawSelection(),
        dropCursor(),
        EditorView.lineWrapping,
        indentUnit.of('  '),
        EditorState.tabSize.of(2),
        // pasteURLAsLink aus: Einfügen von Adressen regelt pasteLink() (Cursor
        // landet hinter dem Link, ohne Markierung kommt der Seitentitel).
        markdown({ base: markdownLanguage, codeLanguages: languages, addKeymap: true, pasteURLAsLink: false }),
        syntaxHighlighting(highlight),
        theme,
        search({ top: false }),
        autocompletion({ override: [slashSource(slashItems(pickImage))], icons: false, activateOnTyping: true }),
        placeholder(o.exists ? '' : 'Einfach losschreiben. Mit / am Zeilenanfang fügst du Tabellen, Boxen, Bilder und mehr ein.'),
        spellComp.of(spellAttrs(o.spellcheck)),
        spellExclusions,
        linkFolding,
        yCollab(ytext, awareness, { undoManager }),
        selectionToolbar(),
        EditorView.domEventHandlers({
          paste(e, v) {
            const files = [...(e.clipboardData?.files || [])];
            if (files.some(f => f.type.startsWith('image/'))) {
              e.preventDefault();
              insertImages(files, v.state.selection.main.head);
              return true;
            }
            const text = (e.clipboardData?.getData('text/plain') || '').trim();
            if (!URL_ONLY.test(text)) return false;
            e.preventDefault();
            pasteLink(text);
            return true;
          },
          drop(e, v) {
            const files = [...(e.dataTransfer?.files || [])];
            if (!files.some(f => f.type.startsWith('image/'))) return false;
            e.preventDefault();
            const pos = v.posAtCoords({ x: e.clientX, y: e.clientY }) ?? v.state.selection.main.head;
            insertImages(files, pos);
            return true;
          },
        }),
        EditorView.updateListener.of(u => {
          if (!u.docChanged) return;
          if (u.transactions.some(tr => tr.isUserEvent('input') || tr.isUserEvent('delete'))) o.onTyping();
          if (previewOn) {
            if (previewTimer) clearTimeout(previewTimer);
            previewTimer = setTimeout(updatePreview, 150);
          }
        }),
      ],
    }),
  });

  // Vorschau mitscrollen (ungefähr, nach Anteil).
  view.scrollDOM.addEventListener('scroll', () => {
    if (!previewOn) return;
    const s = view.scrollDOM;
    const ratio = s.scrollTop / Math.max(1, s.scrollHeight - s.clientHeight);
    const p = o.preview.parentElement!;
    p.scrollTop = ratio * (p.scrollHeight - p.clientHeight);
  }, { passive: true });

  const removeMobile = mobileToolbar(view, pickImage);

  if (o.exists) provider.connect();

  return {
    view,
    text: () => ytext.toString(),
    setPreview(on) { previewOn = on; if (on) updatePreview(); },
    setSpellcheck(on) {
      view.dispatch({ effects: spellComp.reconfigure(spellAttrs(on)) });
    },
    setName(name) {
      awareness.setLocalStateField('user', { name: name || 'Gast', color, colorLight: color + '33' });
    },
    connect: () => provider.connect(),
    whenLocal: () => local.whenSynced.then(() => undefined),
    whenSynced() {
      if (provider.synced) return Promise.resolve();
      provider.connect();
      return new Promise(resolve => syncWaiters.push(resolve));
    },
    focus: () => view.focus(),
    destroy() {
      provider.disconnect();
      local.destroy().catch(() => {});
      removeMobile();
      view.destroy();
      ydoc.destroy();
    },
  };
}
