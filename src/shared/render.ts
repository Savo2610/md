// Markdown → HTML. Läuft im Worker (Ansicht wird auf dem Server gerendert)
// und im Browser (Vorschau beim Bearbeiten).
//
// Rohes HTML ist ausgeschaltet (html: false): <script>, <iframe> & Co. landen
// als sichtbarer Text auf der Seite. Alles, was trotzdem als HTML ausgegeben
// wird (Hinweisboxen, Einbettungen, Inhaltsverzeichnis), erzeugen die Regeln
// hier selbst und escapen jeden Nutzertext.
//
// Formeln, Mermaid und Syntax-Highlighting erzeugen nur Platzhalter. Die
// eigentliche Darstellung macht der Browser (client/enhance.ts) und lädt die
// schweren Bibliotheken nur, wenn ein Dokument sie braucht.

import MarkdownItCtor from 'markdown-it';
import type { Token, StateCore, StateInline, StateBlock } from 'markdown-it';

type MarkdownIt = InstanceType<typeof MarkdownItCtor>;
import footnote from 'markdown-it-footnote';
import mark from 'markdown-it-mark';
import sub from 'markdown-it-sub';
import sup from 'markdown-it-sup';
import ins from 'markdown-it-ins';
import abbr from 'markdown-it-abbr';
import deflist from 'markdown-it-deflist';
import { full as emoji } from 'markdown-it-emoji';
import container from 'markdown-it-container';
import anchor from 'markdown-it-anchor';
import frontMatter from 'markdown-it-front-matter';
import { titleOf, slugify } from './title';

export { titleOf, slugify };

export const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// ── Hinweisboxen wie bei HackMD: :::info, :::success, :::warning, :::danger,
//    :::spoiler Titel ────────────────────────────────────────────────────────

const BOXES: Record<string, string> = { info: 'Info', success: 'Erfolg', warning: 'Achtung', danger: 'Gefahr' };

function boxes(md: MarkdownIt) {
  for (const name of Object.keys(BOXES)) {
    md.use(container, name, {
      render(tokens: Token[], i: number) {
        return tokens[i].nesting === 1 ? `<div class="box box-${name}">\n` : '</div>\n';
      },
    });
  }
  md.use(container, 'spoiler', {
    validate: (params: string) => /^spoiler(\s|$)/.test(params.trim()),
    render(tokens: Token[], i: number) {
      if (tokens[i].nesting !== 1) return '</div></details>\n';
      const title = tokens[i].info.trim().replace(/^spoiler\s*/, '') || 'Mehr anzeigen';
      return `<details class="spoiler"><summary>${md.renderInline(title)}</summary><div>\n`;
    },
  });
}

// ── Formeln: $…$ und $$…$$ ──────────────────────────────────────────────────

function math(md: MarkdownIt) {
  md.inline.ruler.after('escape', 'math_inline', (state: StateInline, silent: boolean) => {
    const src = state.src;
    const start = state.pos;
    if (src[start] !== '$' || src[start + 1] === '$') return false;
    // Kein Leerzeichen direkt nach dem öffnenden $, damit "5 $ und 10 $" Text bleibt.
    if (/\s/.test(src[start + 1] || ' ')) return false;
    let end = start + 1;
    while ((end = src.indexOf('$', end)) !== -1) {
      if (src[end - 1] === '\\') { end++; continue; }
      break;
    }
    if (end === -1 || /\s/.test(src[end - 1]) || /\d/.test(src[end + 1] || '')) return false;
    if (!silent) {
      const t = state.push('math_inline', 'span', 0);
      t.content = src.slice(start + 1, end);
    }
    state.pos = end + 1;
    return true;
  });

  md.block.ruler.after('blockquote', 'math_block', (state: StateBlock, startLine: number, endLine: number, silent: boolean) => {
    const pos = state.bMarks[startLine] + state.tShift[startLine];
    const max = state.eMarks[startLine];
    const first = state.src.slice(pos, max);
    if (!first.startsWith('$$')) return false;
    if (silent) return true;
    let content: string;
    let next = startLine;
    const rest = first.slice(2);
    if (rest.trim().endsWith('$$') && rest.trim().length > 2) {
      content = rest.trim().slice(0, -2);
    } else {
      const lines = [rest];
      let found = false;
      while (++next < endLine) {
        const line = state.src.slice(state.bMarks[next] + state.tShift[next], state.eMarks[next]);
        if (line.trimEnd().endsWith('$$')) { lines.push(line.trimEnd().slice(0, -2)); found = true; break; }
        lines.push(line);
      }
      if (!found) return false;
      content = lines.join('\n');
    }
    state.line = next + 1;
    const t = state.push('math_block', 'div', 0);
    t.block = true;
    t.content = content.trim();
    t.map = [startLine, state.line];
    return true;
  }, { alt: ['paragraph', 'reference', 'blockquote', 'list'] });

  md.renderer.rules.math_inline = (tokens, i) => `<span class="math">${escapeHtml(tokens[i].content)}</span>`;
  md.renderer.rules.math_block = (tokens, i) => `<div class="math math-display">${escapeHtml(tokens[i].content)}</div>\n`;
}

// ── Einbettungen: {%youtube ID %}, {%vimeo ID %} ───────────────────────────

function embeds(md: MarkdownIt) {
  md.inline.ruler.before('emphasis', 'embed', (state: StateInline, silent: boolean) => {
    const m = /^\{%\s*(youtube|vimeo)\s+([\w-]{4,32})\s*%\}/.exec(state.src.slice(state.pos));
    if (!m) return false;
    if (!silent) {
      const t = state.push('embed', 'div', 0);
      t.info = m[1];
      t.content = m[2];
    }
    state.pos += m[0].length;
    return true;
  });
  md.renderer.rules.embed = (tokens, i) => {
    const { info, content } = tokens[i];
    const src = info === 'youtube'
      ? `https://www.youtube-nocookie.com/embed/${content}`
      : `https://player.vimeo.com/video/${content}`;
    return `<span class="embed"><iframe src="${src}" loading="lazy" allowfullscreen allow="fullscreen; picture-in-picture" referrerpolicy="strict-origin-when-cross-origin"></iframe></span>`;
  };
}

// ── Aufgabenlisten: - [ ] und - [x] ─────────────────────────────────────────

function tasks(md: MarkdownIt) {
  md.core.ruler.after('inline', 'tasks', (state: StateCore) => {
    const tokens = state.tokens;
    for (let i = 2; i < tokens.length; i++) {
      const t = tokens[i];
      if (t.type !== 'inline' || tokens[i - 1].type !== 'paragraph_open' || tokens[i - 2].type !== 'list_item_open') continue;
      const m = /^\[([ xX])\][  ]/.exec(t.content);
      if (!m || !t.children?.length || t.children[0].type !== 'text') continue;
      const checked = m[1] !== ' ';
      t.children[0].content = t.children[0].content.slice(4);
      const box = new state.Token('html_inline', '', 0);
      const line = tokens[i - 2].map ? tokens[i - 2].map![0] : -1;
      box.content = `<input type="checkbox" class="task" data-line="${line}"${checked ? ' checked' : ''} disabled> `;
      t.children.unshift(box);
      tokens[i - 2].attrJoin('class', 'task-item');
      for (let j = i - 3; j >= 0; j--) {
        if (tokens[j].type === 'bullet_list_open' || tokens[j].type === 'ordered_list_open') {
          if (tokens[j].level === tokens[i - 2].level - 1) {
            if (!String(tokens[j].attrGet('class') || '').includes('task-list')) tokens[j].attrJoin('class', 'task-list');
            break;
          }
        }
      }
    }
  });
}

// ── Inhaltsverzeichnis: [toc] in eigener Zeile ──────────────────────────────

function toc(md: MarkdownIt) {
  md.core.ruler.push('toc', (state: StateCore) => {
    const tokens = state.tokens;
    const heads: { level: number; id: string; html: string }[] = [];
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      if (t.type === 'heading_open' && Number(t.tag[1]) <= 3) {
        const inline = tokens[i + 1];
        const text = (inline.children || []).filter(c => c.type === 'text' || c.type === 'code_inline').map(c => c.content).join('').trim();
        heads.push({ level: Number(t.tag[1]), id: String(t.attrGet('id') || ''), html: escapeHtml(text) });
      }
    }
    for (let i = 1; i < tokens.length - 1; i++) {
      if (tokens[i].type === 'inline' && /^\[toc\]$/i.test(tokens[i].content.trim()) && tokens[i - 1].type === 'paragraph_open') {
        if (!heads.length) continue;
        const min = Math.min(...heads.map(h => h.level));
        let html = '<nav class="toc">';
        for (const h of heads) {
          html += `<a class="toc-${h.level - min + 1}" href="#${encodeURIComponent(h.id)}">${h.html}</a>`;
        }
        html += '</nav>\n';
        const tok = new state.Token('html_block', '', 0);
        tok.content = html;
        tokens.splice(i - 1, 3, tok);
      }
    }
  });
}

// ── Codeblöcke, Mermaid, externe Links ──────────────────────────────────────

function fences(md: MarkdownIt) {
  md.renderer.rules.fence = (tokens, i) => {
    const t = tokens[i];
    const lang = (t.info || '').trim().split(/\s+/)[0].toLowerCase();
    const line = t.attrGet('data-line');
    const at = line ? ` data-line="${line}"` : '';
    if (lang === 'mermaid') return `<pre class="mermaid"${at}>${escapeHtml(t.content)}</pre>\n`;
    const cls = lang ? ` class="language-${escapeHtml(lang)}"` : '';
    return `<pre${at}><code${cls}>${escapeHtml(t.content)}</code></pre>\n`;
  };
  const defaultLink = md.renderer.rules.link_open || ((tokens, i, opts, _env, self) => self.renderToken(tokens, i, opts));
  md.renderer.rules.link_open = (tokens, i, opts, env, self) => {
    const href = String(tokens[i].attrGet('href') || '');
    if (/^https?:\/\//i.test(href)) {
      tokens[i].attrSet('target', '_blank');
      tokens[i].attrSet('rel', 'noopener noreferrer');
    }
    return defaultLink(tokens, i, opts, env, self);
  };
  // Bilder: lazy laden, damit lange Anleitungen schnell erscheinen.
  const defaultImage = md.renderer.rules.image!;
  md.renderer.rules.image = (tokens, i, opts, env, self) => {
    tokens[i].attrSet('loading', 'lazy');
    return defaultImage(tokens, i, opts, env, self);
  };
}

// ── Zusammenbauen ───────────────────────────────────────────────────────────

let instance: MarkdownIt | null = null;
let currentFrontMatter = '';

function renderer(): MarkdownIt {
  if (instance) return instance;
  const md = new MarkdownItCtor({ html: false, linkify: true, breaks: true, typographer: false });
  md.use(frontMatter, (fm: string) => { currentFrontMatter = fm; });
  md.use(footnote).use(mark).use(sub).use(sup).use(ins).use(abbr).use(deflist).use(emoji);
  md.use(math).use(embeds).use(boxes).use(tasks).use(fences);
  md.use(anchor, {
    slugify,
    permalink: anchor.permalink.linkInsideHeader({ symbol: '#', placement: 'before', class: 'anchor', ariaHidden: true }),
  });
  md.use(toc);
  // Nur für die Vorschau im Editor: Zeilennummer der Quelle an jedem Block,
  // damit die Vorschau beim Scrollen an der richtigen Stelle steht.
  md.core.ruler.push('source_lines', (state: StateCore) => {
    if (!state.env?.lines) return;
    for (const t of state.tokens) {
      if (t.block && t.map && t.nesting !== -1 && t.type !== 'inline') t.attrSet('data-line', String(t.map[0]));
    }
  });
  instance = md;
  return md;
}

export interface Rendered {
  html: string;
  title: string;
}

export function render(src: string, opts: { lines?: boolean } = {}): Rendered {
  currentFrontMatter = '';
  const html = renderer().render(src, { lines: !!opts.lines });
  return { html, title: titleOf(src, currentFrontMatter) };
}
