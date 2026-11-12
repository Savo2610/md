// Eingabe für Memos: CodeMirror mit Markdown-Hervorhebung wie bei iA Writer
// (Zeichen blass, Überschriften fett, Listen laufen mit Enter weiter), dazu
// eine Leiste für Anhänge, Sprachmemo, Standort und Aufgaben.
// ⌘/Strg+Enter schickt ab, Enter macht nur eine neue Zeile.

import { EditorView, keymap, placeholder, drawSelection, MatchDecorator, Decoration, ViewPlugin, type DecorationSet, type ViewUpdate } from '@codemirror/view';
import { EditorState, Prec } from '@codemirror/state';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { syntaxHighlighting, indentUnit } from '@codemirror/language';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { autocompletion, completionKeymap, type CompletionContext } from '@codemirror/autocomplete';
import { highlight, formatKeys, linePrefix, continueListsOnInput } from './cmkit';
import { prepareImage } from './images';
import { el, toast } from './ui';

export interface MemoEditorOptions {
  doc?: string;
  placeholder?: string;
  /** Text des Knopfs zum Abschicken (Standard: Pfeil). */
  submitLabel?: string;
  onSubmit: (text: string) => Promise<boolean> | boolean;
  onCancel?: () => void;
  onChange?: (text: string) => void;
  /** Bekannte Tags für die Vervollständigung nach #. */
  tags: () => string[];
}

export interface MemoEditor {
  root: HTMLElement;
  view: EditorView;
  text(): string;
  set(text: string): void;
  focus(): void;
  destroy(): void;
}

const ICON = {
  attach: '<svg viewBox="0 0 20 20"><path d="M15.5 9.5l-5.6 5.6a3.5 3.5 0 0 1-5-5l6.4-6.4a2.3 2.3 0 0 1 3.3 3.3l-6.3 6.3a1.1 1.1 0 0 1-1.6-1.6l5.6-5.6"/></svg>',
  mic: '<svg viewBox="0 0 20 20"><rect x="7.25" y="2.75" width="5.5" height="9.5" rx="2.75"/><path d="M4.5 9.5a5.5 5.5 0 0 0 11 0M10 15v2.5"/></svg>',
  place: '<svg viewBox="0 0 20 20"><path d="M10 17.5s5.5-5 5.5-9.25a5.5 5.5 0 0 0-11 0C4.5 12.5 10 17.5 10 17.5z"/><circle cx="10" cy="8.25" r="2"/></svg>',
  task: '<svg viewBox="0 0 20 20"><rect x="3.5" y="3.5" width="13" height="13" rx="3"/><path d="M7 10.2l2 2 4-4.4"/></svg>',
  send: '<svg viewBox="0 0 20 20"><path d="M10 15.5V4.5M5.5 9l4.5-4.5L14.5 9"/></svg>',
};
const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
const TAG_RE = /(^|[\s(])#([\p{L}\p{N}_-]*[\p{L}_-][\p{L}\p{N}_-]*)/gu;

// #tags im Text farbig, wie später in der Ansicht.
const tagDecorator = new MatchDecorator({
  regexp: /(?<=^|[\s(])#[\p{L}\p{N}_-]*[\p{L}_-][\p{L}\p{N}_-]*/gu,
  decoration: Decoration.mark({ class: 'cm-tag' }),
});
const tagMarks = ViewPlugin.fromClass(class {
  decorations: DecorationSet;
  constructor(view: EditorView) { this.decorations = tagDecorator.createDeco(view); }
  update(u: ViewUpdate) { this.decorations = tagDecorator.updateDeco(u, this.decorations); }
}, { decorations: v => v.decorations });

const theme = EditorView.theme({
  '&': { backgroundColor: 'transparent', color: 'var(--fg)' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: 'var(--font)', lineHeight: '1.6', overflow: 'visible' },
  '.cm-content': { padding: '0', caretColor: 'var(--caret)', minHeight: '1.6em' },
  '.cm-line': { padding: '0' },
  '.cm-cursor, .cm-dropCursor': { borderLeft: '2px solid var(--caret)', marginLeft: '-1px' },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
    backgroundColor: 'var(--selection) !important',
  },
  '.cm-placeholder': { color: 'var(--faint)' },
  '.cm-tag': { color: 'var(--accent)' },
  '.cm-tooltip': { border: '1px solid var(--line)', backgroundColor: 'var(--bg)', borderRadius: '6px', boxShadow: 'var(--shadow)' },
  '.cm-tooltip-autocomplete > ul': { fontFamily: 'var(--font)', maxHeight: '14em' },
  '.cm-tooltip-autocomplete > ul > li': { padding: '4px 10px !important', lineHeight: '1.5' },
  '.cm-tooltip-autocomplete > ul > li[aria-selected]': { backgroundColor: 'var(--soft)', color: 'var(--fg)' },
  '.cm-completionIcon': { display: 'none' },
});

/** Alle #tags eines Memos (ohne Code und Adressen). */
export function tagsOf(text: string): string[] {
  const clean = text.replace(/```[\s\S]*?```|`[^`\n]*`|\]\([^)]*\)|https?:\/\/\S+/g, ' ');
  return [...new Set([...clean.matchAll(TAG_RE)].map(m => m[2]))];
}

const fmtDuration = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const escapeLabel = (t: string) => t.replace(/([\\[\]])/g, '\\$1');

/** Datei hochladen (Bilder vorher verkleinert). Liefert die Adresse /m/<datei>. */
export async function uploadFile(file: Blob, name: string): Promise<string> {
  let blob = file;
  if (/^image\/(jpeg|png|webp|avif|heic|heif)$/.test(file.type)) {
    try {
      blob = await prepareImage(file as File);
      if (blob.type === 'image/webp') name = name.replace(/\.\w+$/, '') + '.webp';
    } catch { /* Original hochladen */ }
  }
  const res = await fetch('/api/me/memos/files', {
    method: 'POST',
    headers: { 'content-type': blob.type || 'application/octet-stream', 'x-file-name': encodeURIComponent(name) },
    body: blob,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Hochladen fehlgeschlagen.');
  return data.url;
}

export function memoEditor(parent: HTMLElement, o: MemoEditorOptions): MemoEditor {
  const root = el('div', { class: 'me' });
  const box = el('div', { class: 'me-text' });
  const tools = el('div', { class: 'me-tools' });
  root.append(box, tools);
  parent.append(root);

  let busy = 0;
  const setBusy = (d: number) => { busy += d; root.classList.toggle('uploading', busy > 0); updateSend(); };

  const tagSource = (ctx: CompletionContext) => {
    const m = ctx.matchBefore(/#[\p{L}\p{N}_-]*/u);
    if (!m) return null;
    const before = m.from > 0 ? ctx.state.sliceDoc(m.from - 1, m.from) : '';
    if (before && !/[\s(]/.test(before)) return null;
    const word = m.text.slice(1).toLowerCase();
    const options = o.tags().filter(t => t.toLowerCase().startsWith(word) && t.toLowerCase() !== word).map(t => ({ label: `#${t}` }));
    if (!options.length) return null;
    return { from: m.from, options, validFor: /^#[\p{L}\p{N}_-]*$/u };
  };

  const submit = async () => {
    if (busy) { toast('Anhang wird noch hochgeladen …'); return true; }
    const text = view.state.doc.toString().replace(/\s+$/, '');
    if (!text.trim()) return true;
    if (await o.onSubmit(text)) set('');
    return true;
  };

  const view = new EditorView({
    parent: box,
    state: EditorState.create({
      doc: o.doc || '',
      extensions: [
        Prec.highest(keymap.of([
          { key: 'Mod-Enter', run: () => { submit(); return true; } },
          { key: 'Escape', run: () => { if (!o.onCancel) return false; o.onCancel(); return true; } },
        ])),
        keymap.of(completionKeymap),
        formatKeys,
        keymap.of([...historyKeymap, indentWithTab, ...defaultKeymap]),
        history(),
        drawSelection(),
        EditorView.lineWrapping,
        indentUnit.of('  '),
        EditorState.tabSize.of(2),
        markdown({ base: markdownLanguage, addKeymap: true, pasteURLAsLink: false }),
        continueListsOnInput,
        syntaxHighlighting(highlight),
        tagMarks,
        autocompletion({ override: [tagSource], icons: false }),
        placeholder(o.placeholder || ''),
        EditorView.contentAttributes.of({ autocapitalize: 'sentences', 'aria-label': 'Memo' }),
        theme,
        EditorView.updateListener.of(u => {
          if (!u.docChanged) return;
          updateSend();
          o.onChange?.(u.state.doc.toString());
        }),
        EditorView.domEventHandlers({
          paste(e) {
            const files = [...(e.clipboardData?.files || [])];
            if (!files.length) return false;
            e.preventDefault();
            for (const f of files) attach(f);
            return true;
          },
          drop(e) {
            const files = [...(e.dataTransfer?.files || [])];
            if (!files.length) return false;
            e.preventDefault();
            for (const f of files) attach(f);
            return true;
          },
        }),
      ],
    }),
  });

  function set(text: string) {
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text }, selection: { anchor: text.length } });
  }

  /** Markdown als eigene Zeile an der Cursorstelle einsetzen. */
  function insertBlock(md: string) {
    const { state } = view;
    const pos = state.selection.main.head;
    const line = state.doc.lineAt(pos);
    const at = line.text.trim() ? line.to : line.from;
    const insert = (line.text.trim() ? '\n' : '') + md;
    view.dispatch({ changes: { from: at, to: line.text.trim() ? at : line.to, insert }, selection: { anchor: at + insert.length }, scrollIntoView: true, userEvent: 'input' });
  }

  async function attach(file: File) {
    setBusy(1);
    try {
      const name = file.name || 'Datei';
      const url = await uploadFile(file, name);
      insertBlock(file.type.startsWith('image/') ? `![](${url})` : `[${escapeLabel(name)}](${url})`);
    } catch (err) {
      toast(navigator.onLine ? (err as Error).message : 'Offline: Anhänge gehen nur mit Verbindung.');
    } finally {
      setBusy(-1);
    }
  }

  // ── Leiste ────────────────────────────────────────────────────────────────

  const tool = (icon: string, title: string, run: () => void) => {
    const b = el('button', { type: 'button', class: 'me-tool', title, 'aria-label': title });
    b.innerHTML = icon;
    // Fokus im Editor lassen (Handy: Tastatur bleibt offen).
    b.addEventListener('pointerdown', e => e.preventDefault());
    b.addEventListener('click', run);
    return b;
  };

  const picker = el('input', { type: 'file', multiple: '', hidden: '' }) as HTMLInputElement;
  picker.addEventListener('change', () => { for (const f of picker.files || []) attach(f); picker.value = ''; });
  root.append(picker);

  const send = el('button', { type: 'button', class: o.submitLabel ? 'me-send me-send-text' : 'me-send', title: `Sichern (${isMac ? '⌘' : 'Strg'}+Enter)` });
  if (o.submitLabel) send.textContent = o.submitLabel; else { send.innerHTML = ICON.send; send.setAttribute('aria-label', 'Sichern'); }
  send.addEventListener('pointerdown', e => e.preventDefault());
  send.addEventListener('click', () => submit());
  function updateSend() { send.toggleAttribute('disabled', !!busy || !view?.state.doc.toString().trim()); }

  const left = el('div', { class: 'me-left' },
    tool(ICON.attach, 'Bild oder Datei anhängen', () => picker.click()),
    tool(ICON.mic, 'Sprachmemo aufnehmen', () => record()),
    tool(ICON.place, 'Standort einfügen', () => place()),
    tool(ICON.task, 'Aufgabe', () => linePrefix(view, '- [ ] ')),
  );
  const right = el('div', { class: 'me-right' });
  right.append(el('span', { class: 'me-hint' }, isMac ? '⌘↵' : 'Strg+↵'));
  if (o.onCancel) {
    const cancel = el('button', { type: 'button', class: 't' }, 'Abbrechen');
    cancel.addEventListener('click', () => o.onCancel!());
    right.append(cancel);
  }
  right.append(send);
  tools.append(left, right);
  updateSend();

  // ── Standort ──────────────────────────────────────────────────────────────

  function place() {
    if (!navigator.geolocation) { toast('Standort ist hier nicht verfügbar.'); return; }
    setBusy(1);
    navigator.geolocation.getCurrentPosition(async pos => {
      const lat = pos.coords.latitude.toFixed(5), lon = pos.coords.longitude.toFixed(5);
      let name = '';
      try {
        const res = await fetch('/api/me/memos/geo', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ lat, lon }) });
        if (res.ok) name = (await res.json()).name || '';
      } catch { /* offline: nur Koordinaten */ }
      const label = name || `${lat}, ${lon}`;
      insertBlock(`[${escapeLabel(label)}](https://maps.apple.com/?ll=${lat},${lon}&q=${encodeURIComponent(name || 'Standort')})`);
      setBusy(-1);
    }, err => {
      setBusy(-1);
      toast(err.code === err.PERMISSION_DENIED ? 'Zugriff auf den Standort ist nicht erlaubt.' : 'Standort nicht gefunden.');
    }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 60_000 });
  }

  // ── Sprachmemo ────────────────────────────────────────────────────────────

  async function record() {
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') { toast('Aufnehmen geht in diesem Browser nicht.'); return; }
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      toast('Zugriff aufs Mikrofon ist nicht erlaubt.');
      return;
    }
    const mime = ['audio/mp4;codecs=mp4a.40.2', 'audio/mp4', 'audio/webm;codecs=opus', 'audio/webm'].find(t => MediaRecorder.isTypeSupported(t));
    const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    const chunks: Blob[] = [];
    rec.addEventListener('dataavailable', e => { if (e.data.size) chunks.push(e.data); });
    const started = Date.now();
    let keep = true;

    const clock = el('span', { class: 'me-rec-time' }, '0:00');
    const cancel = el('button', { type: 'button', class: 't' }, 'Verwerfen');
    const done = el('button', { type: 'button', class: 'me-send me-send-text' }, 'Fertig');
    const bar = el('div', { class: 'me-rec' }, el('span', { class: 'me-rec-dot' }), clock, el('span', { class: 'me-rec-label' }, 'Aufnahme'), el('div', { class: 'me-right' }, cancel, done));
    tools.replaceWith(bar);
    const tick = setInterval(() => {
      const s = (Date.now() - started) / 1000;
      clock.textContent = fmtDuration(s);
      if (s >= 15 * 60) rec.stop();
    }, 250);

    const finished = new Promise<void>(resolve => rec.addEventListener('stop', () => resolve()));
    cancel.addEventListener('click', () => { keep = false; rec.stop(); });
    done.addEventListener('click', () => rec.stop());
    rec.start(1000);
    await finished;
    clearInterval(tick);
    for (const t of stream.getTracks()) t.stop();
    bar.replaceWith(tools);
    if (!keep || !chunks.length) return;

    const seconds = (Date.now() - started) / 1000;
    const type = (rec.mimeType || mime || 'audio/webm').split(';')[0];
    const ext = type === 'audio/mp4' ? 'm4a' : type.split('/')[1] || 'webm';
    setBusy(1);
    try {
      const url = await uploadFile(new Blob(chunks, { type }), `Sprachmemo.${ext}`);
      insertBlock(`[Sprachmemo ${fmtDuration(seconds)}](${url})`);
    } catch (err) {
      toast((err as Error).message);
    } finally {
      setBusy(-1);
    }
  }

  return {
    root,
    view,
    text: () => view.state.doc.toString(),
    set,
    focus: () => view.focus(),
    destroy: () => { view.destroy(); root.remove(); },
  };
}
