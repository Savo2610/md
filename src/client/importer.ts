// Dateien importieren: .md/.txt so wie sie sind, .html wird zu Markdown.
// Als neues Dokument („Datei öffnen …“, Datei auf die Seite ziehen) oder im
// Editor an der Cursorstelle (Datei in den Text ziehen oder einfügen).

import { toast } from './ui';

const PENDING = 'md:import';
const MAX_CHARS = 1_000_000;
const ACCEPT = '.md,.markdown,.mdown,.mkd,.txt,.text,.html,.htm,text/markdown,text/plain,text/html';

const isHtml = (f: File) => /\.x?html?$/i.test(f.name) || f.type === 'text/html';
export const isTextFile = (f: File) =>
  /\.(md|markdown|mdown|mkd|txt|text|x?html?)$/i.test(f.name) || /^text\/(markdown|x-markdown|plain|html)$/.test(f.type);

/** Lohnt sich die Umwandlung beim Einfügen? Nur bei echter Auszeichnung, nicht bei bunten <span>s aus Code-Editoren. */
export function looksRich(html: string): boolean {
  return /<(h[1-6]|strong|em|b|i|a\s[^>]*href|ul|ol|blockquote|pre|img|table|del|s|strike|mark|sup|sub|hr)\b/i.test(html)
    || /font-weight:\s*(bold|[6-9]00)|font-style:\s*italic/i.test(html);
}

/** Inhalt der Datei als Markdown. */
export async function fileToMarkdown(file: File): Promise<string> {
  const text = (await file.text()).replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  if (!isHtml(file)) return text;
  const { htmlToMarkdown } = await import('./html2md');
  return htmlToMarkdown(text, { whole: true });
}

/** Dateiauswahl öffnen; null, wenn abgebrochen. */
export function pickFile(): Promise<File | null> {
  return new Promise(resolve => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = ACCEPT;
    input.addEventListener('change', () => resolve(input.files?.[0] ?? null), { once: true });
    input.addEventListener('cancel', () => resolve(null), { once: true });
    input.click();
  });
}

/** Datei als neues Dokument öffnen: Inhalt merken, neue Adresse holen, dort einsetzen. */
export async function openAsNew(file?: File | null) {
  file ??= await pickFile();
  if (!file) return;
  if (!isTextFile(file)) { toast('Nur Markdown-, Text- und HTML-Dateien.'); return; }
  if (!navigator.onLine) { toast('Offline: Neue Dokumente gehen nur mit Verbindung.'); return; }
  let md: string;
  try {
    md = await fileToMarkdown(file);
  } catch {
    toast('Die Datei ließ sich nicht lesen.');
    return;
  }
  if (!md.trim()) { toast('Die Datei ist leer.'); return; }
  if (md.length > MAX_CHARS) { toast('Zu groß: höchstens 1 Mio. Zeichen pro Dokument.'); return; }
  try {
    sessionStorage.setItem(PENDING, md);
  } catch {
    toast('Die Datei ist zu groß für den Import.');
    return;
  }
  location.href = '/';
}

/** Wartender Import für das gerade geöffnete (neue) Dokument. */
export function takePending(): string | null {
  try {
    const md = sessionStorage.getItem(PENDING);
    if (md !== null) sessionStorage.removeItem(PENDING);
    return md;
  } catch {
    return null;
  }
}

/** Beim Ziehen einer Datei über die Seite: Hinweis einblenden. */
export function dropZone(onFile: (f: File) => void, active: () => boolean = () => true, signal?: AbortSignal) {
  let depth = 0;
  const hasFiles = (e: DragEvent) => [...(e.dataTransfer?.types || [])].includes('Files');
  const off = () => { depth = 0; document.body.classList.remove('drop-target'); };
  addEventListener('dragenter', e => {
    if (!hasFiles(e) || !active()) return;
    depth++;
    document.body.classList.add('drop-target');
  }, { signal });
  addEventListener('dragleave', () => { if (--depth <= 0) off(); }, { signal });
  addEventListener('dragover', e => { if (hasFiles(e) && active()) e.preventDefault(); }, { signal });
  addEventListener('drop', e => {
    off();
    if (e.defaultPrevented || !active()) return;
    const files = [...(e.dataTransfer?.files || [])];
    if (!files.length) return;
    // Sonst öffnet der Browser die Datei selbst und die Seite ist weg.
    e.preventDefault();
    const file = files.find(isTextFile);
    if (file) onFile(file);
    else toast('Nur Markdown-, Text- und HTML-Dateien.');
  }, { signal });
}
