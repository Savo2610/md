// Übersicht (/home), zugleich Startseite der App.
//
// Ohne Konto: die zuletzt geöffneten Dokumente, nur in diesem Browser.
// Mit Konto: alle Dokumente des Kontos auf jedem Gerät, mit eigenen Tags
// zum Filtern. So lässt sich md wie ein Notizbuch benutzen.

import { $, el, recent, ago, toast, store, menu, isAdmin, ask, adminHeaders, ownerHeaders, trashDaysLeft, docTags, type MenuItem, type Recent } from './ui';
import { account, accountItems, avatar } from './account';
import { tagChips, tagDialog } from './tags';
import { toolMenu } from './nav';
import { openAsNew, dropZone } from './importer';

const TAG_FILTER = 'md:tag';
const UNTAGGED = '\u0000ohne';
const TRASH = '\u0000papierkorb';

export function start() {
  document.body.dataset.mode = 'home';
  const app = $('#app')!;

  const right = el('nav', { class: 'bar-right' });
  // „md“ oben links: Einstellungen und Datenschutz, klein wie auf den Dokumentseiten.
  const brand = el('button', { type: 'button', class: 'brand', title: 'Menü', 'aria-haspopup': 'dialog' }, 'md');
  brand.addEventListener('click', () => menu('left', toolMenu('home')));
  dropZone(file => openAsNew(file));
  const bar = el('header', { id: 'bar' },
    el('div', { class: 'bar-left' }, brand),
    right,
  );
  document.body.prepend(bar);

  const main = el('div', { class: 'home' });
  app.append(main);

  // Neu anlegen: alle drei Arten direkt hier (Startseite der App).
  const create = el('div', { class: 'home-new-row' });
  for (const [label, href] of [['Dokument', '/'], ['Board', '/#board'], ['Packliste', '/#pack']]) {
    const a = el('a', { href, class: 'home-new' }, label);
    a.addEventListener('click', e => {
      if (!navigator.onLine) {
        e.preventDefault();
        toast('Offline: Neues geht nur mit Verbindung. Vorhandenes kannst du weiter bearbeiten.');
      }
    });
    create.append(a);
  }

  // Nach Art filtern (?art=md|board|pack), z. B. „Alle Boards“ aus dem Menü.
  type Art = '' | 'md' | 'board' | 'pack';
  const ARTS: [Art, string][] = [['', 'Alle'], ['md', 'Dokumente'], ['board', 'Boards'], ['pack', 'Packlisten']];
  const fromUrl = new URLSearchParams(location.search).get('art');
  let art: Art = ARTS.some(([a]) => a === fromUrl) ? fromUrl as Art : '';
  const artBar = el('nav', { class: 'art-bar', role: 'tablist', 'aria-label': 'Art' });
  const setArt = (a: Art) => {
    art = a;
    const u = new URL(location.href);
    if (a) u.searchParams.set('art', a); else u.searchParams.delete('art');
    history.replaceState(null, '', u);
    render();
  };

  const search = el('input', { type: 'search', class: 'search', placeholder: 'Suchen …', 'aria-label': 'Suchen' }) as HTMLInputElement;
  const tagBar = el('div', { class: 'tag-bar', role: 'toolbar', 'aria-label': 'Nach Tag filtern' });
  const list = el('ul', { class: 'notes' });
  main.append(create, artBar, search, tagBar, list);

  let filter = store.get(TAG_FILTER) || '';
  const setFilter = (t: string) => {
    filter = filter === t ? '' : t;
    if (filter) store.set(TAG_FILTER, filter); else store.del(TAG_FILTER);
    render();
  };

  // ── Kopfleiste: Anmelden bzw. Konto ───────────────────────────────────────

  function renderBar() {
    right.replaceChildren();
    const u = account.user;
    if (u) {
      const b = el('button', { type: 'button', class: 't avatar-btn', title: u.email || u.name, 'aria-label': 'Konto' }, avatar(u));
      b.addEventListener('click', () => {
        const items: MenuItem[] = [...accountItems()];
        if (isAdmin()) items.push(['Verwaltung (alle Dokumente)', () => (location.href = '/admin')]);
        items.push(['Konto löschen', async () => {
          if (await ask('Konto löschen?', 'Deine Dokumentliste, Tags und Memos verschwinden. Die Dokumente selbst bleiben unter ihren Adressen erhalten.', 'Konto löschen')) account.deleteAccount();
        }, 'danger']);
        menu('right', items);
      });
      right.append(b);
    } else if (account.enabled) {
      const b = el('button', { type: 'button', class: 't', title: 'Mit Google anmelden' }, 'Anmelden');
      b.addEventListener('click', () => account.login('/home'));
      right.append(b);
    }
  }

  // ── Liste ─────────────────────────────────────────────────────────────────

  function render() {
    // Abgelaufenes aus dem Papierkorb ist auf dem Server schon weg.
    for (const r of recent.list()) if (r.trashed && !trashDaysLeft(r.trashed)) recent.remove(r.id);
    const everything = recent.list();
    const all = everything.filter(r => !r.trashed);
    const trashed = everything.filter(r => r.trashed);
    const tags = account.user ? account.allTags() : [];
    if (filter === TRASH ? !trashed.length : filter && filter !== UNTAGGED && !tags.includes(filter)) filter = '';

    tagBar.replaceChildren();
    tagBar.hidden = !tags.length && !trashed.length;
    const chip = (label: string, value: string) => {
      const b = el('button', { type: 'button', class: `tag${filter === value ? ' on' : ''}`, 'aria-pressed': String(filter === value) }, label);
      b.addEventListener('click', () => setFilter(value));
      tagBar.append(b);
    };
    for (const t of tags) chip(t, t);
    if (tags.length && all.some(r => !docTags(r).length)) chip('ohne Tag', UNTAGGED);
    if (trashed.length) chip('Papierkorb', TRASH);
    const inTrash = filter === TRASH;

    const q = search.value.trim().toLowerCase();
    const matches = (r: Recent) => !q
      || (r.title || r.id).toLowerCase().includes(q)
      || r.id.includes(q)
      || docTags(r).some(t => t.toLowerCase().includes(q));
    const inFilter = (r: Recent) => !filter || (filter === UNTAGGED ? !docTags(r).length : docTags(r).some(t => t.toLowerCase() === filter.toLowerCase()));
    // Art: nur anbieten, wenn es mehr als eine gibt.
    const kinds = new Set(all.map(r => r.kind || 'md'));
    artBar.replaceChildren();
    artBar.hidden = kinds.size < 2 && !art;
    for (const [a, label] of ARTS) {
      if (a && !kinds.has(a) && art !== a) continue;
      const b = el('button', { type: 'button', role: 'tab', class: 'art', 'aria-selected': String(art === a) }, label);
      b.addEventListener('click', () => setArt(a));
      artBar.append(b);
    }
    const inArt = (r: Recent) => !art || (r.kind || 'md') === art;
    const items = inTrash ? trashed.filter(matches) : all.filter(r => matches(r) && inFilter(r) && inArt(r));
    search.hidden = all.length < 6;

    list.replaceChildren();
    if (!items.length) {
      list.append(el('li', { class: 'notes-empty' }, q || filter ? 'Nichts gefunden.' : art === 'board' ? 'Noch keine Boards.' : art === 'pack' ? 'Noch keine Packlisten.' : 'Noch keine Dokumente.'));
    }
    for (const r of items) {
      if (inTrash) { list.append(trashRow(r)); continue; }
      const actions = el('div', { class: 'note-actions' });
      if (account.user) {
        const tag = el('button', { type: 'button', class: 'note-btn', title: 'Tags', 'aria-label': 'Tags bearbeiten' }, '#');
        tag.addEventListener('click', e => {
          e.preventDefault();
          tagDialog(r.id, r.title, r.tags || [], () => render());
        });
        actions.append(tag);
      }
      const remove = el('button', { type: 'button', class: 'note-btn note-remove', title: 'Aus der Liste entfernen', 'aria-label': 'Aus der Liste entfernen' }, '×');
      remove.addEventListener('click', e => {
        e.preventDefault();
        recent.remove(r.id);
        render();
      });
      actions.append(remove);

      const meta = el('span', { class: 'note-meta' }, `${ago(r.at)}${r.own ? ' · bearbeitbar' : ''}`);
      const chips = tagChips(docTags(r), setFilter);
      if (chips) meta.append(chips);
      list.append(el('li', {},
        el('a', { href: `/${encodeURIComponent(r.id)}`, class: 'note' },
          el('span', { class: 'note-title' }, r.title || r.id),
          meta,
        ),
        actions,
      ));
    }

  }

  /** Eintrag im Papierkorb: Wiederherstellen oder endgültig löschen. */
  function trashRow(r: Recent): HTMLElement {
    const days = trashDaysLeft(r.trashed!);
    const headers = { ...ownerHeaders(r.id), ...adminHeaders() };
    const restore = el('button', { type: 'button', class: 'note-btn note-text' }, 'Wiederherstellen');
    restore.addEventListener('click', async e => {
      e.preventDefault();
      const res = await fetch(`/api/docs/${encodeURIComponent(r.id)}/restore`, { method: 'POST', headers });
      if (!res.ok && res.status !== 404) { toast((await res.json().catch(() => ({}))).error || 'Ging nicht.'); return; }
      recent.markTrashed(r.id, 0);
      render();
    });
    const purge = el('button', { type: 'button', class: 'note-btn note-remove', title: 'Endgültig löschen', 'aria-label': 'Endgültig löschen' }, '×');
    purge.addEventListener('click', async e => {
      e.preventDefault();
      if (!(await ask('Endgültig löschen?', `„${r.title || r.id}“ und alle Bilder darin verschwinden sofort. Das lässt sich nicht rückgängig machen.`, 'Endgültig löschen'))) return;
      const res = await fetch(`/api/docs/${encodeURIComponent(r.id)}`, { method: 'DELETE', headers });
      if (!res.ok && res.status !== 404) { toast((await res.json().catch(() => ({}))).error || 'Löschen fehlgeschlagen.'); return; }
      recent.remove(r.id);
      store.del(`md:key:${r.id}`);
      store.del(`md:owner:${r.id}`);
      render();
    });
    return el('li', { class: 'trashed' },
      el('a', { href: `/${encodeURIComponent(r.id)}`, class: 'note' },
        el('span', { class: 'note-title' }, r.title || r.id),
        el('span', { class: 'note-meta' }, days === 1 ? 'wird morgen endgültig gelöscht' : `noch ${days} Tage`),
      ),
      el('div', { class: 'note-actions' }, restore, purge),
    );
  }

  search.addEventListener('input', render);
  addEventListener('pageshow', () => {
    render();
    account.sync().then(changed => changed && render());
  });
  renderBar();
  render();
  account.sync(true).then(changed => changed && render());
}
