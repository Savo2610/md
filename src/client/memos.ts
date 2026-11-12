// Memos (/memos): kurze private Notizen, wie ein Chat mit sich selbst.
//
// Neueste unten, Eingabe unten fest. Die Liste kommt fertig gerendert mit der
// Seite (boot.memos), Änderungen gehen an /api/me/memos. Ohne Verbindung
// Geschriebenes wartet im Browser (md:memos:outbox) und wird nachgeschickt,
// sobald es wieder geht. Bearbeiten und Löschen brauchen eine Verbindung.

import { $, el, menu, store, toast, ask } from './ui';
import { account, type User } from './account';
import { fineRow } from './settings';
import { enhance } from './enhance';

interface Memo { id: string; text: string; created: number; updated: number; html?: string; pending?: boolean }
interface Boot { user?: User | null; login?: boolean; memos?: Memo[]; katexCss?: string }

const OUTBOX = 'md:memos:outbox';
const ICONS = {
  send: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 16V4M5 9l5-5 5 5"/></svg>',
  search: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="4.5"/><path d="M10.5 10.5l3.5 3.5"/></svg>',
  pending: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="5.5"/><path d="M8 5v3l2 1.5"/></svg>',
};

const outbox = {
  list(): Memo[] { try { return JSON.parse(store.get(OUTBOX) || '[]'); } catch { return []; } },
  save(list: Memo[]) { if (list.length) store.set(OUTBOX, JSON.stringify(list)); else store.del(OUTBOX); },
};

const newId = () => {
  const b = crypto.getRandomValues(new Uint8Array(12));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_');
};

export function start(boot: Boot) {
  document.body.dataset.mode = 'memos';
  const app = $('#app')!;
  app.classList.add('memos-app');

  // ── Kopfleiste ────────────────────────────────────────────────────────────

  const brand = el('button', { type: 'button', class: 'brand', title: 'Menü', 'aria-haspopup': 'dialog' }, 'md');
  brand.addEventListener('click', () => menu('left', [
    ['Alle Dokumente', () => (location.href = '/home')],
    ['Neues Dokument', () => (location.href = '/')],
    fineRow(),
  ]));
  const right = el('nav', { class: 'bar-right' });
  const bar = el('header', { id: 'bar' }, el('div', { class: 'bar-left' }, brand, el('span', { class: 'bar-title' }, 'Memos')), right);
  app.append(bar);

  if (!boot.user) {
    const box = el('div', { class: 'memos-login' },
      el('p', {}, 'Memos sind private Notizen in deinem Konto, wie ein Chat mit dir selbst.'),
    );
    if (account.enabled) {
      const b = el('button', { type: 'button', class: 't boxed' }, 'Mit Google anmelden');
      b.addEventListener('click', () => account.login('/memos'));
      box.append(b);
    } else {
      box.append(el('p', { class: 'hint' }, 'Anmelden ist auf diesem Server nicht eingerichtet.'));
    }
    app.append(box);
    return;
  }

  // ── Gerüst ────────────────────────────────────────────────────────────────

  const scroller = el('div', { class: 'memos-scroll' });
  const list = el('div', { class: 'memos-list', role: 'log', 'aria-live': 'polite' });
  scroller.append(list);

  const input = el('textarea', { class: 'composer-input', rows: '1', placeholder: 'Memo …', 'aria-label': 'Neues Memo', enterkeyhint: 'enter' }) as HTMLTextAreaElement;
  const send = el('button', { type: 'submit', class: 'composer-send', title: 'Senden', 'aria-label': 'Senden' });
  send.innerHTML = ICONS.send;
  const editNote = el('div', { class: 'composer-edit', hidden: '' });
  const form = el('form', { class: 'composer' }, editNote, el('div', { class: 'composer-row' }, input, send));
  app.append(scroller, form);

  const search = el('input', { type: 'search', class: 'memos-search', placeholder: 'Suchen …', 'aria-label': 'Memos durchsuchen', hidden: '' }) as HTMLInputElement;
  const searchBtn = el('button', { type: 'button', class: 't icon', title: 'Suchen', 'aria-label': 'Suchen' });
  searchBtn.innerHTML = ICONS.search;
  searchBtn.addEventListener('click', () => {
    search.hidden = !search.hidden;
    bar.classList.toggle('searching', !search.hidden);
    if (search.hidden) { search.value = ''; render(true); } else search.focus();
  });
  search.addEventListener('input', () => render(true));
  search.addEventListener('keydown', e => { if (e.key === 'Escape') searchBtn.click(); });
  right.append(search, searchBtn);

  // ── Daten ─────────────────────────────────────────────────────────────────

  let memos: Memo[] = boot.memos || [];
  let editing: Memo | null = null;

  const all = (): Memo[] => {
    const known = new Set(memos.map(m => m.id));
    const waiting = outbox.list().filter(m => !known.has(m.id)).map(m => ({ ...m, pending: true }));
    return [...memos, ...waiting].sort((a, b) => a.created - b.created);
  };

  // ── Anzeige ───────────────────────────────────────────────────────────────

  const atBottom = () => scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 80;
  const toBottom = () => { scroller.scrollTop = scroller.scrollHeight; };

  function dayLabel(t: number): string {
    const d = new Date(t);
    const today = new Date();
    const start = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
    const days = Math.round((start(today) - start(d)) / 86400_000);
    if (days === 0) return 'Heute';
    if (days === 1) return 'Gestern';
    const opts: Intl.DateTimeFormatOptions = days < 7
      ? { weekday: 'long' }
      : { weekday: 'short', day: 'numeric', month: 'long', ...(d.getFullYear() !== today.getFullYear() ? { year: 'numeric' } : {}) };
    return d.toLocaleDateString('de-DE', opts);
  }
  const time = (t: number) => new Date(t).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });

  function render(keepScroll = false) {
    const stick = !keepScroll || atBottom();
    const q = search.value.trim().toLowerCase();
    const items = all().filter(m => !q || m.text.toLowerCase().includes(q));
    list.replaceChildren();
    if (!items.length) {
      list.append(el('p', { class: 'memos-empty' }, q ? 'Nichts gefunden.' : 'Noch keine Memos. Schreib unten etwas, das du nicht vergessen willst.'));
      return;
    }
    let lastDay = '';
    for (const m of items) {
      const day = dayLabel(m.created);
      if (day !== lastDay) { list.append(el('div', { class: 'memo-day' }, day)); lastDay = day; }
      list.append(memoNode(m));
    }
    enhance(list, boot.katexCss);
    if (stick) toBottom();
  }

  function memoNode(m: Memo): HTMLElement {
    const body = el('div', { class: 'memo-text doc' });
    if (m.html) body.innerHTML = m.html;
    else body.append(el('p', { class: 'memo-plain' }, m.text));
    for (const a of body.querySelectorAll<HTMLAnchorElement>('a[href]')) {
      if (a.origin !== location.origin) { a.target = '_blank'; a.rel = 'noopener'; }
    }
    // Aufgaben (- [ ]) lassen sich direkt abhaken.
    for (const box of body.querySelectorAll<HTMLInputElement>('input.task')) {
      if (m.pending) continue;
      box.disabled = false;
      box.addEventListener('change', () => toggleTask(m, Number(box.dataset.line), box));
    }
    const meta = el('div', { class: 'memo-meta' });
    if (m.pending) {
      const p = el('span', { class: 'memo-pending', title: 'Wartet auf Verbindung' });
      p.innerHTML = ICONS.pending;
      meta.append(p);
    }
    meta.append(el('time', { datetime: new Date(m.created).toISOString(), title: new Date(m.created).toLocaleString('de-DE') }, time(m.created)));
    const more = el('button', { type: 'button', class: 'memo-more', title: 'Mehr', 'aria-label': 'Mehr' }, '⋯');
    more.addEventListener('click', () => actions(m));
    meta.append(more);
    return el('article', { class: `memo${m.pending ? ' pending' : ''}${editing?.id === m.id ? ' editing' : ''}`, 'data-id': m.id }, body, meta);
  }

  function actions(m: Memo) {
    menu('right', [
      ['Bearbeiten', () => startEdit(m)],
      ['Kopieren', () => {
        navigator.clipboard.writeText(m.text).then(() => toast('Kopiert.'), () => toast('Kopieren ging nicht.'));
      }],
      ['Löschen', () => remove(m), 'danger'],
    ]);
  }

  // ── Schreiben ─────────────────────────────────────────────────────────────

  const api = async (path: string, method: string, body?: unknown): Promise<Response> =>
    fetch(`/api/me/memos${path}`, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });

  function upsertLocal(m: Memo) {
    memos = [...memos.filter(x => x.id !== m.id), m];
  }

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
    if (changed) render(true);
  }

  async function submit() {
    const text = input.value.replace(/\s+$/, '').replace(/^(\s*\n)+/, '');
    if (!text) return;
    if (editing) { await saveEdit(text); return; }
    const m: Memo = { id: newId(), text, created: Date.now(), updated: Date.now() };
    outbox.save([...outbox.list(), m]);
    input.value = '';
    grow();
    render();
    if (await post(m)) render();
    else toast('Offline: Das Memo wird gesendet, sobald wieder Verbindung besteht.');
  }

  function startEdit(m: Memo) {
    if (m.pending) { toast('Dieses Memo wartet noch auf Verbindung.'); return; }
    editing = m;
    input.value = m.text;
    editNote.replaceChildren(el('span', {}, 'Memo bearbeiten'));
    const cancel = el('button', { type: 'button', class: 't' }, 'Abbrechen');
    cancel.addEventListener('click', stopEdit);
    editNote.append(cancel);
    editNote.hidden = false;
    form.classList.add('is-editing');
    grow();
    render(true);
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
    list.querySelector(`[data-id="${CSS.escape(m.id)}"]`)?.scrollIntoView({ block: 'nearest' });
  }

  function stopEdit() {
    editing = null;
    input.value = '';
    editNote.hidden = true;
    form.classList.remove('is-editing');
    grow();
    render(true);
  }

  async function saveEdit(text: string) {
    const m = editing!;
    if (text === m.text) { stopEdit(); return; }
    try {
      const res = await api(`/${m.id}`, 'PUT', { text });
      if (!res.ok) { toast((await res.json().catch(() => ({}))).error || 'Speichern ging nicht.'); return; }
      upsertLocal(await res.json());
      stopEdit();
    } catch {
      toast('Offline: Bearbeiten geht nur mit Verbindung.');
    }
  }

  async function toggleTask(memo: Memo, line: number, box: HTMLInputElement) {
    const m = memos.find(x => x.id === memo.id) || memo;
    const lines = m.text.split('\n');
    const src = lines[line];
    if (src === undefined || !/\[[ xX]\]/.test(src)) { box.checked = !box.checked; return; }
    lines[line] = src.replace(/\[([ xX])\]/, (_, c: string) => (c === ' ' ? '[x]' : '[ ]'));
    const text = lines.join('\n');
    try {
      const res = await api(`/${m.id}`, 'PUT', { text });
      if (!res.ok) throw new Error();
      upsertLocal(await res.json());
      render(true);
    } catch {
      box.checked = !box.checked;
      toast('Offline: Abhaken geht nur mit Verbindung.');
    }
  }

  async function remove(m: Memo) {
    if (m.pending) {
      if (!(await ask('Memo verwerfen?', 'Es wurde noch nicht gesendet.', 'Verwerfen'))) return;
      outbox.save(outbox.list().filter(x => x.id !== m.id));
      render(true);
      return;
    }
    try {
      const res = await api(`/${m.id}`, 'DELETE');
      if (!res.ok) throw new Error();
    } catch {
      toast('Offline: Löschen geht nur mit Verbindung.');
      return;
    }
    memos = memos.filter(x => x.id !== m.id);
    if (editing?.id === m.id) stopEdit();
    render(true);
    undoToast('Memo gelöscht.', async () => {
      // Gleiche ID und Zeit: steht danach wieder an seinem Platz.
      const res = await api('', 'POST', { id: m.id, text: m.text, created: m.created }).catch(() => null);
      if (!res?.ok) { toast('Wiederherstellen ging nicht.'); return; }
      upsertLocal(await res.json());
      render(true);
    });
  }

  // ── Eingabe ───────────────────────────────────────────────────────────────

  function grow() {
    input.style.height = 'auto';
    const border = input.offsetHeight - input.clientHeight;
    input.style.height = `${Math.min(input.scrollHeight + border, Math.round(app.clientHeight * 0.45))}px`;
    send.toggleAttribute('disabled', !input.value.trim());
  }
  input.addEventListener('input', grow);
  // Am Rechner schickt Enter ab (Umschalt+Enter: neue Zeile), am Handy macht
  // Enter eine neue Zeile und der Pfeil schickt ab. ⌘/Strg+Enter geht immer.
  const touch = matchMedia('(pointer: coarse)');
  input.addEventListener('keydown', e => {
    if (e.key === 'Escape' && editing) { e.preventDefault(); stopEdit(); return; }
    if (e.key !== 'Enter' || e.isComposing) return;
    if (e.metaKey || e.ctrlKey || (!touch.matches && !e.shiftKey)) {
      e.preventDefault();
      submit();
    }
  });
  form.addEventListener('submit', e => { e.preventDefault(); submit(); input.focus(); });
  // Auf dem Handy den Fokus im Textfeld lassen (sonst klappt die Tastatur weg).
  send.addEventListener('pointerdown', e => { if (document.activeElement === input) e.preventDefault(); });

  // Bildschirmtastatur: Die App ist so hoch wie der sichtbare Bereich, damit
  // die Eingabe über der Tastatur bleibt (iOS verkleinert das Fenster nicht).
  const vv = window.visualViewport;
  if (vv) {
    const fit = () => {
      const stick = atBottom();
      document.documentElement.style.setProperty('--vvh', `${vv.height}px`);
      // Tastatur offen: unten kein Abstand für den Home-Balken.
      document.documentElement.classList.toggle('keyboard', innerHeight - vv.height > 120);
      app.style.transform = vv.offsetTop ? `translateY(${vv.offsetTop}px)` : '';
      if (stick) toBottom();
    };
    vv.addEventListener('resize', fit);
    vv.addEventListener('scroll', fit);
    fit();
  }

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
      render(true);
    } catch { /* offline: bleibt, wie es ist */ }
  }
  addEventListener('online', () => { lastFetch = 0; refresh(); });
  addEventListener('focus', refresh);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
  addEventListener('pageshow', e => { if ((e as PageTransitionEvent).persisted) { lastFetch = 0; refresh(); } });

  // Hinweise unten über der Eingabe zeigen.
  new ResizeObserver(() => document.documentElement.style.setProperty('--composer-h', `${form.offsetHeight}px`)).observe(form);

  grow();
  render();
  flush();
  // Am Rechner gleich losschreiben können; am Handy nicht die Tastatur aufreißen.
  if (!touch.matches) input.focus();
}

/** Hinweis unten mit „Rückgängig“. */
function undoToast(msg: string, undo: () => void) {
  $('#toast')?.classList.remove('show');
  const old = $('.undo-toast');
  old?.remove();
  const btn = el('button', { type: 'button' }, 'Rückgängig');
  const t = el('div', { class: 'undo-toast', role: 'status' }, el('span', {}, msg), btn);
  document.body.append(t);
  requestAnimationFrame(() => t.classList.add('show'));
  const timer = setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 300); }, 6000);
  btn.addEventListener('click', () => { clearTimeout(timer); t.remove(); undo(); });
}
