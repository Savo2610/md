// HTML → Markdown, für eingefügten Rich Text (Webseiten, Google Docs, Mail,
// die eigene Ansicht) und für importierte .html-Dateien. Wird erst beim
// ersten Gebrauch nachgeladen.

import TurndownService from 'turndown';

export function htmlToMarkdown(html: string, opts: { base?: string; whole?: boolean } = {}): string {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  // Ganze Seite (Datei): nur der Inhalt, ohne Navigation und Fußzeile.
  const root = opts.whole ? (doc.querySelector('article, main, [role="main"]') ?? doc.body) : doc.body;
  clean(root as HTMLElement, opts.base);
  return tidy(service().turndown(root as HTMLElement));
}

// ── Aufräumen vor dem Umwandeln ─────────────────────────────────────────────

function clean(root: HTMLElement, base?: string) {
  const doc = root.ownerDocument;
  // KaTeX (z. B. aus der eigenen Ansicht): zurück zum Quelltext.
  for (const k of root.querySelectorAll<HTMLElement>('.katex')) {
    const tex = k.querySelector('annotation[encoding="application/x-tex"]')?.textContent?.trim();
    if (!tex) continue;
    const display = k.closest('.katex-display, .math-display');
    (display ?? k).replaceWith(raw(doc, display ? `$$\n${tex}\n$$` : `$${tex}$`, !!display));
  }

  for (const n of root.querySelectorAll('script, style, noscript, template, head, meta, link, title, button, select, textarea, svg, canvas, form, o\\:p, .anchor, .header-anchor')) n.remove();

  // Google Docs packt alles in <b style="font-weight:normal">.
  for (const b of root.querySelectorAll<HTMLElement>('b[id^="docs-internal-guid"], b[style*="font-weight:normal"], b[style*="font-weight: normal"]')) unwrap(b);

  // Fett/kursiv/durchgestrichen nur als Stil (Google Docs, Word, Mail).
  for (const s of root.querySelectorAll<HTMLElement>('span[style]')) {
    const st = s.getAttribute('style') || '';
    let tag = '';
    if (/font-weight:\s*(bold|[6-9]00)/i.test(st)) tag = 'strong';
    if (/font-style:\s*italic/i.test(st)) tag = tag ? 'strong-em' : 'em';
    if (/text-decoration[^;]*line-through/i.test(st)) tag = 'del';
    if (!tag || !s.textContent?.trim()) continue;
    let inner: HTMLElement = doc.createElement(tag === 'strong-em' ? 'strong' : tag);
    const outer = inner;
    if (tag === 'strong-em') { const em = doc.createElement('em'); inner.append(em); inner = em; }
    inner.append(...s.childNodes);
    s.replaceWith(outer);
  }

  // Aufgaben: Kästchen → [ ] / [x]
  for (const box of root.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')) {
    box.replaceWith(raw(doc, box.checked || box.hasAttribute('checked') ? '[x] ' : '[ ] '));
  }
  for (const i of root.querySelectorAll('input')) i.remove();

  // Links: Google-Weiterleitungen auflösen, relative nur mit Basis behalten.
  for (const a of root.querySelectorAll<HTMLAnchorElement>('a[href]')) {
    const href = absolute(a.getAttribute('href') || '', base);
    if (href === null) { a.removeAttribute('href'); continue; }
    try {
      const u = new URL(href);
      if (/(^|\.)google\.[a-z.]+$/.test(u.hostname) && u.pathname === '/url' && u.searchParams.get('q')) {
        a.setAttribute('href', u.searchParams.get('q')!);
        continue;
      }
    } catch { /* #anker o. ä. */ }
    a.setAttribute('href', href);
  }

  // Bilder: nur echte Adressen (eingebettete data:-Bilder wären riesig).
  for (const img of root.querySelectorAll<HTMLImageElement>('img')) {
    const src = absolute(img.getAttribute('src') || '', base);
    if (!src || !/^https?:/i.test(src)) img.remove();
    else img.setAttribute('src', src);
  }
}

/** Stück Markdown, das unverändert durchgeht (mit Text drin, sonst gilt es Turndown als leer). */
function raw(doc: Document, md: string, block = false): HTMLElement {
  const e = doc.createElement(block ? 'div' : 'span');
  e.dataset.md = md;
  e.textContent = md;
  return e;
}

function unwrap(n: Element) {
  n.replaceWith(...n.childNodes);
}

/** Adresse absolut machen; null, wenn sie relativ ist und es keine Basis gibt. */
function absolute(href: string, base?: string): string | null {
  if (!href || /^(javascript|vbscript):/i.test(href)) return null;
  if (/^[a-z][\w+.-]*:/i.test(href) || href.startsWith('#')) return href;
  if (href.startsWith('//')) return 'https:' + href;
  if (!base) return null;
  try { return new URL(href, base).href; } catch { return null; }
}

// ── Turndown mit den Erweiterungen des Renderers ────────────────────────────

let td: TurndownService | null = null;

function service(): TurndownService {
  if (td) return td;
  td = new TurndownService({
    headingStyle: 'atx',
    hr: '---',
    bulletListMarker: '-',
    codeBlockStyle: 'fenced',
    emDelimiter: '*',
    strongDelimiter: '**',
    linkStyle: 'inlined',
  });
  td.escape = escapeText;

  // Vorbereitete Rohstücke (Formeln, Aufgaben-Kästchen) unverändert übernehmen.
  td.addRule('raw', {
    filter: n => n instanceof HTMLElement && n.dataset.md !== undefined,
    replacement: (_c, n) => {
      const raw = (n as HTMLElement).dataset.md!;
      return n.nodeName === 'DIV' ? `\n\n${raw}\n\n` : raw;
    },
  });

  // Codeblöcke, auch <pre> ohne <code> (z. B. GitHub); Sprache aus der Klasse.
  td.addRule('pre', {
    filter: 'pre',
    replacement: (_c, n) => {
      const el = n as HTMLElement;
      const classes = [el.className, el.querySelector('code')?.className || '', el.parentElement?.className || ''].join(' ');
      const lang = /(?:language|lang|highlight-source)-([\w+#-]+)/.exec(classes)?.[1] || '';
      const text = (el.textContent || '').replace(/\n$/, '');
      const fence = /```/.test(text) ? '~~~~' : '```';
      return `\n\n${fence}${lang}\n${text}\n${fence}\n\n`;
    },
  });

  // Listen kompakt: „- Punkt“ statt „-   Punkt“, ohne Leerzeilen durch <li><p> (Google Docs).
  td.addRule('listItem', {
    filter: 'li',
    replacement: (content, node) => {
      const parent = node.parentNode as HTMLElement;
      let prefix = '- ';
      if (parent?.nodeName === 'OL') {
        const start = Number(parent.getAttribute('start') || 1);
        prefix = `${start + Array.prototype.indexOf.call(parent.children, node)}. `;
      }
      content = content.replace(/^\n+/, '').replace(/\n+$/, '\n').replace(/\n(?!\n|$)/gm, '\n' + ' '.repeat(prefix.length));
      return prefix + content + (node.nextSibling && !/\n$/.test(content) ? '\n' : '');
    },
  });

  const wrap = (name: string, filter: TurndownService.Filter, mark: string) =>
    td!.addRule(name, { filter, replacement: c => (c.trim() ? `${mark}${c}${mark}` : c) });
  wrap('del', n => /^(DEL|S|STRIKE)$/.test(n.nodeName), '~~');
  wrap('mark', 'mark', '==');
  wrap('ins', 'ins', '++');
  wrap('sub', 'sub', '~');
  wrap('sup', 'sup', '^');

  // Tabellen → GFM; die erste Zeile wird zur Kopfzeile.
  td.addRule('tableSection', { filter: ['thead', 'tbody', 'tfoot'], replacement: c => c });
  td.addRule('tableCell', {
    filter: ['th', 'td'],
    replacement: c => ` ${c.replace(/\s*\n+\s*/g, ' ').replace(/\|/g, '\\|').trim()} |`,
  });
  td.addRule('tableRow', {
    filter: 'tr',
    replacement: (c, n) => {
      const row = n as HTMLTableRowElement;
      const table = row.closest('table');
      const cols = Math.max(...[...(table?.rows || [])].map(r => r.cells.length), 1);
      const pad = ' |'.repeat(Math.max(0, cols - row.cells.length));
      let out = `|${c}${pad}\n`;
      if (table?.rows[0] === row) out += `|${' --- |'.repeat(cols)}\n`;
      return out;
    },
  });
  td.addRule('table', { filter: 'table', replacement: c => `\n\n${c.trim()}\n\n` });

  // Eingebettete Videos wie im Editor: {%youtube id %}
  td.addRule('video', {
    filter: 'iframe',
    replacement: (_c, n) => {
      const src = (n as HTMLIFrameElement).getAttribute('src') || '';
      const yt = /youtube(?:-nocookie)?\.com\/embed\/([\w-]{6,})/.exec(src);
      if (yt) return `\n\n{%youtube ${yt[1]} %}\n\n`;
      const vi = /player\.vimeo\.com\/video\/(\d+)/.exec(src);
      return vi ? `\n\n{%vimeo ${vi[1]} %}\n\n` : '';
    },
  });

  return td;
}

/**
 * Sparsamer als Turndowns Standard: nur, was sonst wirklich anders gerendert
 * würde. snake_case, Gleichungen mit * und Klammern bleiben lesbar.
 */
function escapeText(s: string): string {
  return s
    .replace(/`/g, '\\`')
    .replace(/(^|\s)\*(?=\S)|(\S)\*(?=\s|$)/g, (m) => m.replace('*', '\\*'))
    .replace(/(^|[^\w\\])_|_(?=[^\w]|$)/g, m => m.replace('_', '\\_'))
    .replace(/^(\s*)(#{1,6}(?=\s)|>|[-+](?=\s))/gm, '$1\\$2')
    .replace(/^(\s*)(\d+)\.(?=\s)/gm, '$1$2\\.');
}

function tidy(md: string): string {
  return md
    .replace(/ /g, ' ')
    .replace(/^(\s*(?:-|\d+\.) \[[ x]\]) {2,}/gm, '$1 ')
    .replace(/[ \t]+$/gm, m => (m === '  ' ? m : ''))
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
