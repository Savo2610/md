// Packlisten nebeneinander: Reiter oben, darunter eine Fläche zum Wischen
// (CSS scroll-snap, eine Seite pro Liste). Live verbunden ist immer nur die
// sichtbare Liste; die anderen zeigen ihren letzten Stand aus diesem Browser
// (md:pack:lists), damit beim Wischen schon etwas zu sehen ist. Ist eine
// andere Liste eingerastet, wird die bisherige abgebaut, die neue verbunden
// und die Adresse gewechselt – ohne die Seite neu zu laden.
//
// Reihenfolge der Reiter: md:pack:order (dieser Browser), neue hinten,
// Duplikate direkt hinter ihrem Original.

import type { Boot, DocSession } from './main';
import { $, el, store, recent } from './ui';
import { snapshots, type Snapshot } from './pack';
import { CATEGORIES, validCategory } from '../shared/pack';

const ORDER = 'md:pack:order';
const PLUS = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3.5v9M3.5 8h9"/></svg>';

export function startPager(boot: Boot, start: (b: Boot, host: HTMLElement) => DocSession) {
  const app = $('#app')!;
  document.body.classList.add('is-pack', 'pk-paged');
  const tabs = el('nav', { class: 'pk-tabs', 'aria-label': 'Packlisten', role: 'tablist' });
  const track = el('div', { class: 'pk-track' });
  app.append(tabs, track);

  const first = boot.id!;
  /** Noch nicht angelegte neue Liste (verschwindet wieder, wenn sie leer bleibt). */
  let fresh = boot.exists ? '' : first;

  let copyAfter = '';
  try {
    const c = JSON.parse(sessionStorage.getItem('md:pack:copy') || 'null');
    if (c?.id === first) copyAfter = String(c.after || '');
  } catch { /* nichts */ }

  const mine = () => recent.list().filter(r => r.kind === 'pack' && !r.trashed);
  let order: string[] = [];
  try { order = JSON.parse(store.get(ORDER) || '[]'); } catch { /* neu */ }
  {
    const known = mine().sort((a, b) => a.at - b.at).map(r => r.id);
    const set = new Set(known);
    order = order.filter(id => set.has(id) || id === first);
    for (const id of known) if (!order.includes(id)) order.push(id);
    if (!order.includes(first)) {
      const i = copyAfter ? order.indexOf(copyAfter) : -1;
      if (i >= 0) order.splice(i + 1, 0, first); else order.push(first);
    }
  }
  const saveOrder = () => store.set(ORDER, JSON.stringify(order.filter(id => id !== fresh)));
  saveOrder();

  const live = new Map<string, { title: string; open: number }>();
  const titleOf = (id: string) => live.get(id)?.title || snapshots()[id]?.title || mine().find(r => r.id === id)?.title || 'Packliste';
  const openOf = (id: string): number | undefined => live.get(id)?.open ?? snapshots()[id]?.open;

  const panels = new Map<string, HTMLElement>();
  for (const id of order) {
    const p = el('section', { class: 'pk-panel', 'data-id': id, role: 'tabpanel' });
    panels.set(id, p);
    track.append(p);
  }

  // ── Reiter ────────────────────────────────────────────────────────────────

  let visible = first;
  function renderTabs() {
    tabs.replaceChildren();
    for (const id of order) {
      const n = openOf(id);
      const t = el('button', { type: 'button', role: 'tab', class: 'pk-tab', 'aria-selected': String(id === visible), 'data-id': id },
        el('span', { class: 'pk-tab-title' }, titleOf(id)));
      if (n) t.append(el('span', { class: 'pk-tab-n' }, String(n)));
      t.addEventListener('click', () => scrollToId(id, true));
      tabs.append(t);
    }
    const add = el('button', { type: 'button', class: 'pk-tab pk-tab-new', title: 'Neue Packliste', 'aria-label': 'Neue Packliste' });
    add.innerHTML = PLUS;
    add.addEventListener('click', () => { location.href = '/#pack'; });
    tabs.append(add);
    tabs.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  function markVisible(id: string) {
    if (id === visible) return;
    visible = id;
    for (const t of tabs.querySelectorAll<HTMLElement>('.pk-tab[data-id]')) t.setAttribute('aria-selected', String(t.dataset.id === id));
    tabs.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
  }

  // ── Vorschau der nicht verbundenen Listen ─────────────────────────────────

  function preview(id: string) {
    const p = panels.get(id);
    if (!p) return;
    p.replaceChildren(previewDom(titleOf(id), snapshots()[id], store.get(`md:pack:done:${id}`) !== '0', !!store.get(`md:key:${id}`)));
  }

  // ── Wischen ───────────────────────────────────────────────────────────────

  const indexAt = () => Math.round(track.scrollLeft / Math.max(1, track.clientWidth));
  function scrollToId(id: string, smooth: boolean) {
    const i = order.indexOf(id);
    if (i < 0) return;
    track.scrollTo({ left: i * track.clientWidth, behavior: smooth ? 'smooth' : 'instant' });
  }

  let settleTimer: ReturnType<typeof setTimeout> | null = null;
  let frame = 0;
  track.addEventListener('scroll', () => {
    if (!frame) frame = requestAnimationFrame(() => { frame = 0; const id = order[indexAt()]; if (id) markVisible(id); });
    if (settleTimer) clearTimeout(settleTimer);
    settleTimer = setTimeout(settle, 160);
  }, { passive: true });
  track.addEventListener('scrollend', () => { if (settleTimer) clearTimeout(settleTimer); settle(); });

  function settle() {
    settleTimer = null;
    const id = order[indexAt()];
    if (id && id !== current) switchTo(id, true);
  }

  // ── Wechsel ───────────────────────────────────────────────────────────────

  let current = first;
  let session = start(boot, panels.get(first)!);

  function switchTo(id: string, push: boolean) {
    const prev = current;
    session.destroy();
    current = id;
    const p = panels.get(id)!;
    document.title = titleOf(id);
    if (fresh && recent.list().some(r => r.id === fresh)) fresh = '';
    session = start({
      ...boot, id, kind: 'pack', exists: id !== fresh,
      editKey: undefined, ownerKey: undefined, trashed: undefined,
      siteKey: id === fresh ? boot.siteKey : undefined,
    }, p);
    if (push) history.pushState({ pack: id }, '', `/${encodeURIComponent(id)}`);
    if (navigator.onLine && 'caches' in window) caches.open('md-pages').then(c => c.add(new Request(location.pathname, { cache: 'no-store' }))).catch(() => {});

    // Leer gebliebene neue Liste: wieder weg.
    if (prev === fresh && !recent.list().some(r => r.id === prev)) {
      panels.get(prev)?.remove();
      panels.delete(prev);
      order = order.filter(x => x !== prev);
      fresh = '';
      scrollToId(id, false);
    } else {
      preview(prev);
    }
    visible = '';
    markVisible(id);
    renderTabs();
  }

  // Stand der sichtbaren Liste: Reiter nachziehen, Vorschau durch die echte ersetzen.
  addEventListener('md:pack', e => {
    const d = (e as CustomEvent<{ id: string; title: string; open: number }>).detail;
    live.set(d.id, { title: d.title, open: d.open });
    const t = tabs.querySelector<HTMLElement>(`.pk-tab[data-id="${CSS.escape(d.id)}"]`);
    if (t) {
      t.querySelector('.pk-tab-title')!.textContent = d.title || 'Packliste';
      t.querySelector('.pk-tab-n')?.remove();
      if (d.open) t.append(el('span', { class: 'pk-tab-n' }, String(d.open)));
    }
    if (d.id === current) panels.get(d.id)?.querySelector(':scope > .pk-preview')?.remove();
    else preview(d.id);
  });

  addEventListener('popstate', () => {
    const id = decodeURIComponent(location.pathname.slice(1));
    if (!panels.has(id)) { location.reload(); return; }
    if (id !== current) switchTo(id, false);
    scrollToId(id, false);
  });

  addEventListener('resize', () => scrollToId(current, false));

  // Pfeiltasten mit ⌥ (bzw. Alt): vorige/nächste Liste.
  addEventListener('keydown', e => {
    if (!e.altKey || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') || document.querySelector('dialog[open]')) return;
    const i = order.indexOf(current) + (e.key === 'ArrowLeft' ? -1 : 1);
    if (i < 0 || i >= order.length) return;
    e.preventDefault();
    scrollToId(order[i], true);
  });

  for (const id of order) if (id !== first) preview(id);
  renderTabs();
  scrollToId(first, false);
  requestAnimationFrame(() => scrollToId(first, false));
}

/** Statische Fassung einer Liste in denselben Klassen wie die echte. */
function previewDom(title: string, snap: Snapshot | undefined, doneOpen: boolean, editable: boolean): HTMLElement {
  const items = snap?.items || [];
  const open = items.filter(i => !i.done);
  const done = items.filter(i => i.done);
  const summary = items.length ? (open.length ? `${open.length} offen · ${done.length} von ${items.length} eingepackt` : `Alles eingepackt · ${items.length}`) : '';
  const root = el('div', { class: 'pack pk-preview', 'aria-hidden': 'true' },
    el('header', { class: 'pk-head' }, el('div', { class: 'pk-title' }, title), el('p', { class: 'pk-summary' }, summary)));
  if (editable) root.append(el('div', { class: 'pk-add' }, el('div', { class: 'pk-add-input pk-fake' }, 'Hinzufügen …')));
  const lists = el('div', { class: 'pk-lists' });
  const row = (i: (typeof items)[number]) => {
    const li = el('li', { class: `pk-row${i.done ? ' done' : ''}` }, el('span', { class: 'pk-check', 'aria-pressed': String(!!i.done) }), el('span', { class: 'pk-name' }, i.name));
    li.firstElementChild!.innerHTML = '<svg viewBox="0 0 16 16"><path d="M3.5 8.5l3 3 6-7"/></svg>';
    if (i.qty > 1) li.lastElementChild!.append(el('span', { class: 'pk-qty' }, `${i.qty}×`));
    return li;
  };
  for (const c of CATEGORIES) {
    const rows = open.filter(i => validCategory(i.cat) === c.id);
    if (!rows.length) continue;
    lists.append(el('section', { class: 'pk-cat' }, el('h2', {}, c.label), el('ul', { class: 'pk-rows' }, ...rows.map(row))));
  }
  if (done.length) {
    const sec = el('section', { class: `pk-done${doneOpen ? '' : ' closed'}` },
      el('div', { class: 'pk-done-head' }, el('span', { class: 'pk-done-toggle' }, `Eingepackt · ${done.length}`)));
    if (doneOpen) sec.append(el('ul', { class: 'pk-rows' }, ...done.map(row)));
    lists.append(sec);
  }
  root.append(lists);
  return root;
}
