// Memos (/memos): kurze private Notizen im Konto, neueste oben.
//
// Oben die Eingabe (memo-editor.ts), darunter Tags zum Filtern und die Liste.
// Die Liste kommt fertig gerendert mit der Seite (boot.memos), Änderungen
// gehen an /api/me/memos. Ohne Verbindung Geschriebenes wartet im Browser
// (md:memos:outbox) und wird nachgeschickt. Löschen wartet ein paar Sekunden
// auf „Rückgängig“, bevor es an den Server geht.

import { $, el, store, toast, ask, dialog } from './ui';
import { toBroadcast } from '../shared/broadcast';
import { account, accountItems, avatar, type User } from './account';
import { fineRow } from './settings';
import { enhance } from './enhance';
import { memoEditor, type MemoEditor } from './memo-editor';
import { tagsOf, tagRe, withoutTags } from '../shared/tags';

interface Memo { id: string; text: string; created: number; updated: number; html?: string; pending?: boolean; doc?: string | null; docTitle?: string }
interface Boot { user?: User | null; login?: boolean; memos?: Memo[]; katexCss?: string; admin?: boolean }

const OUTBOX = 'md:memos:outbox';
const DRAFT = 'md:memos:draft';
const UNDO_MS = 6000;
const AUDIO = /^\/m\/[\w-]+\.(m4a|mp3|aac|webm|ogg|oga|opus|wav)$/;

const ICON = {
  search: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="4.5"/><path d="M10.5 10.5l3.5 3.5"/></svg>',
  pending: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="5.5"/><path d="M8 5v3l2 1.5"/></svg>',
  file: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M11.5 2.75H6a1.75 1.75 0 0 0-1.75 1.75v11A1.75 1.75 0 0 0 6 17.25h8a1.75 1.75 0 0 0 1.75-1.75V7z"/><path d="M11.5 2.75V7h4.25"/></svg>',
  place: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 17.5s5.5-5 5.5-9.25a5.5 5.5 0 0 0-11 0C4.5 12.5 10 17.5 10 17.5z"/><circle cx="10" cy="8.25" r="2"/></svg>',
  doc: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M9.5 2.5H4.75A1.25 1.25 0 0 0 3.5 3.75v8.5c0 .7.56 1.25 1.25 1.25h6.5c.7 0 1.25-.56 1.25-1.25V5.5z"/><path d="M9.5 2.5v3h3M5.75 8.5h4.5M5.75 10.75h3"/></svg>',
  play: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M7 4.8v10.4a.6.6 0 0 0 .9.5l8.2-5.2a.6.6 0 0 0 0-1L7.9 4.3a.6.6 0 0 0-.9.5z"/></svg>',
  pause: '<svg viewBox="0 0 20 20" aria-hidden="true"><rect x="5.5" y="4.5" width="3" height="11" rx="1"/><rect x="11.5" y="4.5" width="3" height="11" rx="1"/></svg>',
};

const outbox = {
  list(): Memo[] { try { return JSON.parse(store.get(OUTBOX) || '[]'); } catch { return []; } },
  save(list: Memo[]) { if (list.length) store.set(OUTBOX, JSON.stringify(list)); else store.del(OUTBOX); },
};

const newId = () => {
  const b = crypto.getRandomValues(new Uint8Array(12));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_');
};

function when(t: number): string {
  const d = new Date(t);
  const now = new Date();
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((day(now) - day(d)) / 86400_000);
  const hm = d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
  if (days === 0) return `Heute, ${hm}`;
  if (days === 1) return `Gestern, ${hm}`;
  if (days > 1 && days < 7) return `${d.toLocaleDateString('de-DE', { weekday: 'long' })}, ${hm}`;
  return d.toLocaleDateString('de-DE', { day: 'numeric', month: 'short', ...(d.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}) }) + `, ${hm}`;
}

export function start(boot: Boot) {
  document.body.dataset.mode = 'memos';
  const app = $('#app')!;

  // ── Kopfleiste ────────────────────────────────────────────────────────────

  const brand = el('button', { type: 'button', class: 'brand', title: 'Menü', 'aria-haspopup': 'dialog' }, 'md');
  brand.addEventListener('click', () => popover(brand, [
    ['Alle Dokumente', () => (location.href = '/home')],
    ['Neues Dokument', () => (location.href = '/')],
    fineRow(),
  ], 'left'));
  const right = el('nav', { class: 'bar-right' });
  const bar = el('header', { id: 'bar' }, el('div', { class: 'bar-left' }, brand, el('span', { class: 'bar-title' }, 'Memos')), right);
  document.body.prepend(bar);

  const page = el('div', { class: 'memos' });
  app.append(page);

  if (!boot.user) {
    page.append(el('div', { class: 'memos-login' },
      el('p', {}, 'Memos sind private Notizen in deinem Konto: Gedanken, Listen, Fotos, Sprachmemos, Orte.'),
    ));
    if (account.enabled) {
      const b = el('button', { type: 'button', class: 't boxed' }, 'Mit Google anmelden');
      b.addEventListener('click', () => account.login('/memos'));
      page.lastElementChild!.append(b);
    }
    return;
  }

  // ── Daten ─────────────────────────────────────────────────────────────────

  let memos: Memo[] = boot.memos || [];
  /** Gelöscht, aber noch mit „Rückgängig“ (id → Timer). */
  const deleting = new Map<string, ReturnType<typeof setTimeout>>();
  let editingId: string | null = null;
  let filter = '';

  const all = (): Memo[] => {
    const known = new Set(memos.map(m => m.id));
    const waiting = outbox.list().filter(m => !known.has(m.id)).map(m => ({ ...m, pending: true }));
    return [...memos, ...waiting].filter(m => !deleting.has(m.id)).sort((a, b) => b.created - a.created);
  };
  const allTags = (): string[] => {
    const count = new Map<string, number>();
    for (const m of all()) for (const t of tagsOf(m.text)) count.set(t, (count.get(t) || 0) + 1);
    return [...count.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'de')).map(([t]) => t);
  };

  // ── Gerüst ────────────────────────────────────────────────────────────────

  const composer = el('div', { class: 'composer' });
  const tagBar = el('div', { class: 'tag-bar', role: 'toolbar', 'aria-label': 'Nach Tag filtern' });
  const list = el('div', { class: 'memo-list' });
  page.append(composer, tagBar, list);

  const editor = memoEditor(composer, {
    doc: store.get(DRAFT) || '',
    placeholder: 'Was willst du nicht vergessen?',
    tags: allTags,
    onChange: text => { if (text.trim()) store.set(DRAFT, text); else store.del(DRAFT); },
    onSubmit: async text => {
      create(text);
      store.del(DRAFT);
      return true;
    },
  });

  const search = el('input', { type: 'search', class: 'memos-search', placeholder: 'Suchen …', 'aria-label': 'Memos durchsuchen', hidden: '' }) as HTMLInputElement;
  const searchBtn = el('button', { type: 'button', class: 't icon', title: 'Suchen', 'aria-label': 'Suchen' });
  searchBtn.innerHTML = ICON.search;
  searchBtn.addEventListener('click', () => {
    search.hidden = !search.hidden;
    bar.classList.toggle('searching', !search.hidden);
    if (search.hidden) { search.value = ''; render(); } else search.focus();
  });
  search.addEventListener('input', () => render());
  search.addEventListener('keydown', e => { if (e.key === 'Escape') searchBtn.click(); });
  right.append(search, searchBtn, accountButton(boot.user));

  // ── Anzeige ───────────────────────────────────────────────────────────────

  function render() {
    const tags = allTags();
    if (filter && !tags.includes(filter)) filter = '';
    tagBar.replaceChildren();
    tagBar.hidden = !tags.length;
    for (const t of tags) {
      const b = el('button', { type: 'button', class: `tag${filter === t ? ' on' : ''}`, 'aria-pressed': String(filter === t) }, `#${t}`);
      b.addEventListener('click', () => { filter = filter === t ? '' : t; render(); });
      tagBar.append(b);
    }

    const q = search.value.trim().toLowerCase();
    const items = all().filter(m => (!q || m.text.toLowerCase().includes(q)) && (!filter || tagsOf(m.text).includes(filter)));
    // Ein offener Editor bleibt stehen, der Rest wird neu gebaut.
    const open = editingId ? list.querySelector<HTMLElement>(`[data-id="${CSS.escape(editingId)}"]`) : null;
    list.replaceChildren();
    if (!items.length) {
      list.append(el('p', { class: 'memos-empty' }, q || filter ? 'Nichts gefunden.' : 'Noch keine Memos.'));
      return;
    }
    for (const m of items) list.append(m.id === editingId && open ? open : memoNode(m));
    enhance(list, boot.katexCss);
  }

  function memoNode(m: Memo): HTMLElement {
    const body = el('div', { class: 'memo-text doc' });
    if (m.html) body.innerHTML = m.html;
    else body.append(el('p', { class: 'memo-plain' }, m.text));
    decorate(body, m);

    const head = el('div', { class: 'memo-head' });
    if (m.pending) {
      const p = el('span', { class: 'memo-pending', title: 'Wartet auf Verbindung' });
      p.innerHTML = ICON.pending;
      head.append(p);
    }
    head.append(el('time', { datetime: new Date(m.created).toISOString(), title: new Date(m.created).toLocaleString('de-DE') }, when(m.created)));
    // Verknüpftes Dokument: kleiner Verweis oben; das Dokument ist die Quelle.
    if (m.doc) {
      const link = el('a', { href: `/${encodeURIComponent(m.doc)}`, class: 'memo-doc', title: `Dokument: ${m.docTitle || m.doc}` });
      link.innerHTML = ICON.doc;
      link.append('Dokument');
      head.append(link);
    }
    const more = el('button', { type: 'button', class: 'memo-more', title: 'Mehr', 'aria-label': 'Mehr', 'aria-haspopup': 'menu' }, '⋯');
    more.addEventListener('click', () => popover(more, [
      m.doc
        ? ['Dokument öffnen', () => (location.href = `/${encodeURIComponent(m.doc!)}`)]
        : ['Bearbeiten', () => startEdit(m)],
      ['Kopieren', () => navigator.clipboard.writeText(m.text).then(() => toast('Kopiert.'), () => toast('Kopieren ging nicht.'))],
      ...(!m.doc && !m.pending ? [['Als Dokument öffnen', () => toDoc(m)] as [string, () => void]] : []),
      // Nur das Admin-Konto: öffentlich auf broadcast.veerka.mp stellen.
      ...(boot.admin && !m.pending ? [['Auf Broadcast senden', () => sendToBroadcast(m)] as [string, () => void]] : []),
      ['Löschen', () => remove(m), 'danger'],
    ]));
    head.append(more);
    return el('article', { class: `memo${m.pending ? ' pending' : ''}`, 'data-id': m.id }, head, body);
  }

  /** Anhänge, Orte, Tags und Aufgaben im gerenderten Memo. */
  function decorate(body: HTMLElement, m: Memo) {
    for (const a of [...body.querySelectorAll<HTMLAnchorElement>('a[href]')]) {
      const href = a.getAttribute('href') || '';
      if (AUDIO.test(href)) { a.replaceWith(audioPlayer(href, a.textContent || '')); continue; }
      if (href.startsWith('/m/')) {
        a.classList.add('att', 'att-file');
        a.target = '_blank';
        const i = el('span', { class: 'att-icon' }); i.innerHTML = ICON.file;
        a.prepend(i);
        continue;
      }
      // Ort (ältere Memos verweisen noch auf Apple Karten).
      if (href.startsWith('https://www.google.com/maps/search/?api=1&query=') || href.startsWith('https://maps.apple.com/?ll=')) {
        a.classList.add('att', 'att-place');
        const i = el('span', { class: 'att-icon' }); i.innerHTML = ICON.place;
        a.prepend(i);
      }
      if (a.origin !== location.origin) { a.target = '_blank'; a.rel = 'noopener'; }
    }
    for (const img of body.querySelectorAll<HTMLImageElement>('img')) {
      img.loading = 'lazy';
      if (img.getAttribute('src')?.startsWith('/m/') && !img.closest('a')) {
        img.addEventListener('click', () => window.open(img.src, '_blank'));
        img.classList.add('zoomable');
      }
    }
    // Bild allein in einem Absatz: ohne Abstände drumherum.
    for (const p of body.querySelectorAll('p')) if (p.children.length && [...p.childNodes].every(n => (n as HTMLElement).tagName === 'IMG' || (n.nodeType === 3 && !n.textContent!.trim()) || (n as HTMLElement).tagName === 'BR')) p.classList.add('memo-images');
    tagify(body);
    for (const box of body.querySelectorAll<HTMLInputElement>('input.task')) {
      if (m.pending) continue;
      box.disabled = false;
      box.addEventListener('change', () => toggleTask(m.id, Number(box.dataset.line), box));
    }
  }

  /** #tags werden zu Knöpfen, die nach diesem Tag filtern. */
  function tagify(root: HTMLElement) {
    const tagButton = (tag: string) => {
      const b = el('button', { type: 'button', class: 'memo-tag' }, `#${tag}`);
      b.addEventListener('click', () => { filter = filter === tag ? '' : tag; render(); scrollTo({ top: 0, behavior: 'smooth' }); });
      return b;
    };
    // Vom Server gerendert: <span class="doc-tag">.
    for (const span of root.querySelectorAll<HTMLElement>('.doc-tag')) span.replaceWith(tagButton(span.dataset.tag || span.textContent!.slice(1)));
    // Noch nicht gesendete Memos sind reiner Text.
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: n => (n.parentElement?.closest('a, code, pre, button') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
    });
    const nodes: Text[] = [];
    while (walker.nextNode()) if (/#/.test(walker.currentNode.textContent || '')) nodes.push(walker.currentNode as Text);
    for (const node of nodes) {
      const text = node.textContent || '';
      const frag = document.createDocumentFragment();
      let last = 0;
      for (const m of text.matchAll(tagRe())) {
        const start = m.index! + m[1].length;
        frag.append(text.slice(last, start));
        frag.append(tagButton(m[2]));
        last = start + 1 + m[2].length;
      }
      if (!last) continue;
      frag.append(text.slice(last));
      node.replaceWith(frag);
    }
  }

  // ── Server ────────────────────────────────────────────────────────────────

  const api = (path: string, method: string, body?: unknown, keepalive = false): Promise<Response> =>
    fetch(`/api/me/memos${path}`, { method, keepalive, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });

  const upsertLocal = (m: Memo) => { memos = [...memos.filter(x => x.id !== m.id), m]; };

  async function post(m: Memo): Promise<boolean> {
    try {
      const res = await api('', 'POST', { id: m.id, text: m.text, created: m.created });
      if (!res.ok) {
        // Abgelehnt (zu lang o. ä.): nicht ewig weiter versuchen.
        if (res.status >= 400 && res.status < 500) {
          outbox.save(outbox.list().filter(x => x.id !== m.id));
          toast((await res.json().catch(() => ({}))).error || 'Memo wurde abgelehnt.');
          return true;
        }
        return false;
      }
      upsertLocal(await res.json());
      outbox.save(outbox.list().filter(x => x.id !== m.id));
      return true;
    } catch {
      return false;
    }
  }

  let flushing = false;
  async function flush() {
    if (flushing) return;
    flushing = true;
    let changed = false;
    for (const m of outbox.list()) {
      if (!(await post(m))) break;
      changed = true;
    }
    flushing = false;
    if (changed) render();
  }

  async function create(text: string) {
    const m: Memo = { id: newId(), text, created: Date.now(), updated: Date.now() };
    outbox.save([...outbox.list(), m]);
    if (filter && !tagsOf(text).includes(filter)) filter = '';
    render();
    if (await post(m)) render();
    else toast('Offline: Das Memo wird gesendet, sobald wieder Verbindung besteht.');
  }

  // ── Bearbeiten ────────────────────────────────────────────────────────────

  let inline: MemoEditor | null = null;

  function startEdit(m: Memo) {
    if (m.pending) { toast('Dieses Memo wartet noch auf Verbindung.'); return; }
    if (inline) stopEdit();
    const node = list.querySelector<HTMLElement>(`[data-id="${CSS.escape(m.id)}"]`);
    if (!node) return;
    editingId = m.id;
    node.classList.add('editing');
    const body = node.querySelector('.memo-text')!;
    const slot = el('div', { class: 'memo-edit' });
    body.replaceWith(slot);
    inline = memoEditor(slot, {
      doc: m.text,
      submitLabel: 'Sichern',
      tags: allTags,
      onCancel: stopEdit,
      onSubmit: async text => {
        if (text === m.text) { stopEdit(); return false; }
        try {
          const res = await api(`/${m.id}`, 'PUT', { text });
          if (!res.ok) { toast((await res.json().catch(() => ({}))).error || 'Sichern ging nicht.'); return false; }
          upsertLocal(await res.json());
          stopEdit();
        } catch {
          toast('Offline: Bearbeiten geht nur mit Verbindung.');
        }
        return false;
      },
    });
    inline.focus();
    node.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  function stopEdit() {
    inline?.destroy();
    inline = null;
    editingId = null;
    render();
  }

  async function toggleTask(id: string, line: number, box: HTMLInputElement) {
    const m = memos.find(x => x.id === id);
    const lines = m?.text.split('\n') || [];
    const src = lines[line];
    if (!m || src === undefined || !/\[[ xX]\]/.test(src)) { box.checked = !box.checked; return; }
    lines[line] = src.replace(/\[([ xX])\]/, (_, c: string) => (c === ' ' ? '[x]' : '[ ]'));
    try {
      const res = await api(`/${m.id}`, 'PUT', { text: lines.join('\n') });
      if (!res.ok) throw new Error();
      upsertLocal(await res.json());
      render();
    } catch {
      box.checked = !box.checked;
      toast('Offline: Abhaken geht nur mit Verbindung.');
    }
  }

  // ── Als Dokument ──────────────────────────────────────────────────────────

  /** md-Dokument aus dem Memo machen (verknüpft) und dorthin wechseln. */
  async function toDoc(m: Memo) {
    if (!navigator.onLine) { toast('Offline: geht nur mit Verbindung.'); return; }
    try {
      const res = await api(`/${m.id}/doc`, 'POST');
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Dokument konnte nicht angelegt werden.');
      if (data.editKey) store.set(`md:key:${data.doc}`, data.editKey);
      if (data.ownerKey) store.set(`md:owner:${data.doc}`, data.ownerKey);
      // Direkt im Bearbeiten-Modus öffnen (wie main.ts es für neue Dokumente kennt).
      try { sessionStorage.setItem('md:open-edit', data.doc); } catch { /* egal */ }
      location.href = data.url;
    } catch (err) {
      toast((err as Error).message);
    }
  }

  // ── Löschen (mit Rückgängig) ──────────────────────────────────────────────

  const finishDelete = (id: string, keepalive = false) => {
    clearTimeout(deleting.get(id));
    deleting.delete(id);
    memos = memos.filter(x => x.id !== id);
    api(`/${id}`, 'DELETE', undefined, keepalive).catch(() => {});
  };

  async function remove(m: Memo) {
    if (m.pending) {
      if (!(await ask('Memo verwerfen?', 'Es wurde noch nicht gesendet.', 'Verwerfen'))) return;
      outbox.save(outbox.list().filter(x => x.id !== m.id));
      render();
      return;
    }
    if (!navigator.onLine) { toast('Offline: Löschen geht nur mit Verbindung.'); return; }
    if (editingId === m.id) stopEdit();
    deleting.set(m.id, setTimeout(() => finishDelete(m.id), UNDO_MS));
    render();
    undoToast(m.doc ? 'Memo gelöscht, das Dokument bleibt.' : 'Memo gelöscht.', () => {
      clearTimeout(deleting.get(m.id));
      deleting.delete(m.id);
      render();
    });
  }
  // Seite wird verlassen: angefangene Löschungen sofort abschicken.
  addEventListener('pagehide', () => { for (const id of [...deleting.keys()]) finishDelete(id, true); });

  // ── Abgleich ──────────────────────────────────────────────────────────────

  let lastFetch = Date.now();
  async function refresh() {
    if (Date.now() - lastFetch < 5000) return;
    lastFetch = Date.now();
    await flush();
    try {
      const res = await fetch('/api/me/memos');
      if (res.status === 401) { location.reload(); return; }
      if (!res.ok) return;
      memos = (await res.json()).memos;
      render();
    } catch { /* offline: bleibt, wie es ist */ }
  }
  addEventListener('online', () => { lastFetch = 0; refresh(); });
  addEventListener('focus', refresh);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
  addEventListener('pageshow', e => { if ((e as PageTransitionEvent).persisted) { lastFetch = 0; refresh(); } });

  render();
  flush();
  // Am Rechner gleich losschreiben; am Handy nicht die Tastatur aufreißen.
  if (!matchMedia('(pointer: coarse)').matches) editor.focus();
}

/** Rundes Profilbild oben rechts: wer angemeldet ist, Abmelden. */
function accountButton(u: User): HTMLElement {
  const b = el('button', { type: 'button', class: 't avatar-btn', title: u.email || u.name, 'aria-label': 'Konto', 'aria-haspopup': 'menu' }, avatar(u));
  b.addEventListener('click', () => popover(b, [...accountItems(), ['Alle Dokumente', () => (location.href = '/home')]]));
  return b;
}

/**
 * Vorschau und Bestätigung, dann senden. broadcast zeigt schlichten Text,
 * darum genau die Fassung zeigen, die dort ankommt.
 */
function sendToBroadcast(m: { id: string; text: string }) {
  const draft = toBroadcast(m.text);
  const body = el('div', { class: 'bc' });
  if (draft.text) body.append(el('div', { class: 'bc-preview' }, draft.text));
  if (draft.files.length) body.append(el('p', { class: 'bc-files' }, `${draft.files.length === 1 ? 'Anhang' : `${draft.files.length} Anhänge`}: ${draft.files.map(f => f.name).join(', ')}`));
  body.append(el('p', { class: 'hint' }, 'Ersetzt die Nachricht, die dort gerade steht. Jeder mit der Adresse kann sie lesen, nach 7 Tagen ist sie wieder weg. #tags werden nicht mitgeschickt.'));
  const send = el('button', { type: 'button', class: 't boxed' }, 'Senden');
  const cancel = el('button', { type: 'button', class: 't' }, 'Abbrechen');
  body.append(el('div', { class: 'ask-row' }, cancel, send));
  const d = dialog('Auf broadcast.veerka.mp senden', body);
  cancel.addEventListener('click', () => d.close());
  send.addEventListener('click', async () => {
    send.disabled = true;
    send.textContent = 'Wird gesendet …';
    try {
      const res = await fetch(`/api/me/memos/${encodeURIComponent(m.id)}/broadcast`, { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Senden ging nicht.');
      d.close();
      linkToast('Auf Sendung.', 'Ansehen', 'https://broadcast.veerka.mp');
    } catch (err) {
      send.disabled = false;
      send.textContent = 'Senden';
      toast(navigator.onLine ? (err as Error).message : 'Offline: Senden geht nur mit Verbindung.');
    }
  });
  setTimeout(() => send.focus(), 30);
}

/** Hinweis unten mit Link (z. B. „Ansehen“). */
function linkToast(msg: string, label: string, href: string) {
  $('#toast')?.classList.remove('show');
  $('.undo-toast')?.remove();
  const a = el('a', { href, target: '_blank', rel: 'noopener' }, label);
  const t = el('div', { class: 'undo-toast', role: 'status' }, el('span', {}, msg), a);
  document.body.append(t);
  requestAnimationFrame(() => t.classList.add('show'));
  setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 300); }, 6000);
}

// ── Sprachmemo abspielen ─────────────────────────────────────────────────────

function audioPlayer(src: string, label: string): HTMLElement {
  const audio = el('audio', { preload: 'metadata', src }) as HTMLAudioElement;
  const play = el('button', { type: 'button', class: 'aud-play', 'aria-label': 'Abspielen' });
  play.innerHTML = ICON.play;
  const fill = el('span', { class: 'aud-fill' });
  const track = el('span', { class: 'aud-track' }, fill);
  const fromLabel = /(\d+):(\d\d)\s*$/.exec(label);
  let total = fromLabel ? Number(fromLabel[1]) * 60 + Number(fromLabel[2]) : 0;
  const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  const time = el('span', { class: 'aud-time' }, total ? fmt(total) : '');
  const name = label.replace(/\s*\d+:\d\d\s*$/, '').trim();
  const box = el('span', { class: 'att att-audio' }, play, el('span', { class: 'aud-main' }, el('span', { class: 'aud-name' }, name || 'Audio'), track), time, audio);

  const duration = () => (Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : total);
  audio.addEventListener('loadedmetadata', () => { if (Number.isFinite(audio.duration)) { total = audio.duration; time.textContent = fmt(total); } });
  audio.addEventListener('timeupdate', () => {
    const d = duration();
    fill.style.width = d ? `${Math.min(100, (audio.currentTime / d) * 100)}%` : '0';
    time.textContent = fmt(audio.paused && !audio.currentTime ? d : audio.currentTime);
  });
  audio.addEventListener('play', () => {
    play.innerHTML = ICON.pause; play.setAttribute('aria-label', 'Pause'); box.classList.add('playing');
    // Immer nur eine Aufnahme gleichzeitig.
    for (const other of document.querySelectorAll('audio')) if (other !== audio) other.pause();
  });
  audio.addEventListener('pause', () => { play.innerHTML = ICON.play; play.setAttribute('aria-label', 'Abspielen'); box.classList.remove('playing'); });
  audio.addEventListener('ended', () => { audio.currentTime = 0; fill.style.width = '0'; time.textContent = fmt(duration()); });
  play.addEventListener('click', () => (audio.paused ? audio.play().catch(() => toast('Abspielen ging nicht.')) : audio.pause()));
  track.addEventListener('click', e => {
    const d = duration();
    if (!d) return;
    const r = track.getBoundingClientRect();
    audio.currentTime = Math.max(0, Math.min(d, ((e.clientX - r.left) / r.width) * d));
    if (audio.paused) audio.play().catch(() => {});
  });
  return box;
}

// ── Menü direkt am Knopf ─────────────────────────────────────────────────────

type Item = HTMLElement | [string, () => void, string?];

function popover(anchor: HTMLElement, items: Item[], align: 'left' | 'right' = 'right') {
  const menuBox = el('div', { class: 'menu' });
  const d = el('dialog', { class: 'pop' }, menuBox);
  for (const item of items) {
    if (item instanceof HTMLElement) { menuBox.append(item); continue; }
    const [label, run, cls] = item;
    const b = el('button', { type: 'button', class: cls || '' }, label);
    b.addEventListener('click', () => { d.close(); run(); });
    menuBox.append(b);
  }
  d.addEventListener('close', () => d.remove());
  d.addEventListener('click', e => {
    if (e.target !== d) return;
    const r = d.getBoundingClientRect();
    if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) d.close();
  });
  document.body.append(d);
  d.showModal();
  const a = anchor.getBoundingClientRect();
  const w = d.offsetWidth, h = d.offsetHeight;
  let top = a.bottom + 4;
  if (top + h > innerHeight - 8) top = Math.max(8, a.top - h - 4);
  const left = align === 'right' ? a.right - w : a.left;
  d.style.top = `${top}px`;
  d.style.left = `${Math.max(8, Math.min(innerWidth - w - 8, left))}px`;
}

/** Hinweis unten mit „Rückgängig“. */
function undoToast(msg: string, undo: () => void) {
  $('#toast')?.classList.remove('show');
  $('.undo-toast')?.remove();
  const btn = el('button', { type: 'button' }, 'Rückgängig');
  const t = el('div', { class: 'undo-toast', role: 'status' }, el('span', {}, msg), btn);
  document.body.append(t);
  requestAnimationFrame(() => t.classList.add('show'));
  const timer = setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 300); }, UNDO_MS - 300);
  btn.addEventListener('click', () => { clearTimeout(timer); t.remove(); undo(); });
}
