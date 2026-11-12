// Übersicht (/home), zugleich Startseite der App.
//
// Ohne Konto: die zuletzt geöffneten Dokumente, nur in diesem Browser.
// Mit Konto: alle Dokumente des Kontos auf jedem Gerät, mit eigenen Tags
// zum Filtern. So lässt sich md wie ein Notizbuch benutzen.

import { $, el, recent, ago, toast, store, menu, isAdmin, ask, adminHeaders, ownerHeaders, trashDaysLeft, type MenuItem, type Recent } from './ui';
import { account, accountItems, avatar } from './account';
import { tagChips, tagDialog } from './tags';

const TAG_FILTER = 'md:tag';
const UNTAGGED = '\u0000ohne';
const TRASH = '\u0000papierkorb';

export function start() {
  document.body.dataset.mode = 'home';
  const app = $('#app')!;

  const right = el('nav', { class: 'bar-right' });
  const bar = el('header', { id: 'bar' },
    el('div', { class: 'bar-left' }, el('span', { class: 'brand' }, 'md')),
    right,
  );
  document.body.prepend(bar);

  const main = el('div', { class: 'home' });
  app.append(main);

  const create = el('a', { href: '/', class: 'home-new' }, 'Neues Dokument');
  create.addEventListener('click', e => {
    if (!navigator.onLine) {
      e.preventDefault();
      toast('Offline: Neue Dokumente gehen nur mit Verbindung. Vorhandene kannst du weiter bearbeiten.');
    }
  });

  const search = el('input', { type: 'search', class: 'search', placeholder: 'Suchen …', 'aria-label': 'Suchen' }) as HTMLInputElement;
  const tagBar = el('div', { class: 'tag-bar', role: 'toolbar', 'aria-label': 'Nach Tag filtern' });
  const list = el('ul', { class: 'notes' });
  main.append(create, search, tagBar, list);

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
        items.push(['Konto löschen', () => {
          if (confirm('Konto löschen? Deine Dokumentliste und Tags verschwinden. Die Dokumente selbst bleiben unter ihren Adressen erhalten.')) account.deleteAccount();
        }]);
        items.push(el('a', { href: '/datenschutz', class: 'menu-fine' }, 'Datenschutz'));
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
    if (tags.length && all.some(r => !r.tags?.length)) chip('ohne Tag', UNTAGGED);
    if (trashed.length) chip('Papierkorb', TRASH);
    const inTrash = filter === TRASH;

    const q = search.value.trim().toLowerCase();
    const matches = (r: Recent) => !q
      || (r.title || r.id).toLowerCase().includes(q)
      || r.id.includes(q)
      || (r.tags || []).some(t => t.toLowerCase().includes(q));
    const inFilter = (r: Recent) => !filter || (filter === UNTAGGED ? !r.tags?.length : (r.tags || []).includes(filter));
    const items = inTrash ? trashed.filter(matches) : all.filter(r => matches(r) && inFilter(r));
    search.hidden = all.length < 6;

    list.replaceChildren();
    if (!items.length) {
      list.append(el('li', { class: 'notes-empty' }, q || filter ? 'Nichts gefunden.' : 'Noch keine Dokumente.'));
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
      const chips = tagChips(r.tags, setFilter);
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
