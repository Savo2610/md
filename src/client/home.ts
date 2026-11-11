// Übersicht (/home), zugleich Startseite der App.
//
// Ohne Konto: die zuletzt geöffneten Dokumente, nur in diesem Browser.
// Mit Konto: alle Dokumente des Kontos auf jedem Gerät, mit eigenen Tags
// zum Filtern. So lässt sich md wie ein Notizbuch benutzen.

import { $, el, recent, ago, toast, store, menu, type Recent } from './ui';
import { account, accountItems, avatar } from './account';
import { tagChips, tagDialog } from './tags';

const TAG_FILTER = 'md:tag';
const UNTAGGED = '\u0000ohne';

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
  const foot = el('div', { class: 'home-foot' });
  main.append(create, search, tagBar, list, foot);

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
      b.addEventListener('click', () => menu('right', [
        ...accountItems(),
        ['Konto löschen …', () => {
          if (confirm('Konto löschen? Deine Dokumentliste und Tags verschwinden. Die Dokumente selbst bleiben unter ihren Adressen erhalten.')) account.deleteAccount();
        }],
      ]));
      right.append(b);
    } else if (account.enabled) {
      const b = el('button', { type: 'button', class: 't', title: 'Mit Google anmelden' }, 'Anmelden');
      b.addEventListener('click', () => account.login('/home'));
      right.append(b);
    }
  }

  // ── Liste ─────────────────────────────────────────────────────────────────

  function render() {
    const all = recent.list();
    const tags = account.user ? account.allTags() : [];
    if (filter && filter !== UNTAGGED && !tags.includes(filter)) filter = '';

    tagBar.replaceChildren();
    tagBar.hidden = !tags.length;
    const chip = (label: string, value: string) => {
      const b = el('button', { type: 'button', class: `tag${filter === value ? ' on' : ''}`, 'aria-pressed': String(filter === value) }, label);
      b.addEventListener('click', () => setFilter(value));
      tagBar.append(b);
    };
    for (const t of tags) chip(t, t);
    if (tags.length && all.some(r => !r.tags?.length)) chip('ohne Tag', UNTAGGED);

    const q = search.value.trim().toLowerCase();
    const matches = (r: Recent) => !q
      || (r.title || r.id).toLowerCase().includes(q)
      || r.id.includes(q)
      || (r.tags || []).some(t => t.toLowerCase().includes(q));
    const inFilter = (r: Recent) => !filter || (filter === UNTAGGED ? !r.tags?.length : (r.tags || []).includes(filter));
    const items = all.filter(r => matches(r) && inFilter(r));
    search.hidden = all.length < 6;

    list.replaceChildren();
    if (!items.length) {
      list.append(el('li', { class: 'notes-empty' }, q || filter
        ? 'Nichts gefunden.'
        : account.user
          ? 'Noch keine Dokumente. Was du anlegst oder öffnest, erscheint hier – auf allen Geräten, auf denen du angemeldet bist.'
          : 'Noch keine Dokumente. Was du hier öffnest oder schreibst, erscheint in dieser Liste – nur auf diesem Gerät.'));
    }
    for (const r of items) {
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

    foot.replaceChildren();
    if (!account.user && account.enabled) {
      const b = el('button', { type: 'button', class: 'link' }, 'Mit Google anmelden');
      b.addEventListener('click', () => account.login('/home'));
      foot.append(el('p', { class: 'hint' }, b, ', um deine Dokumente auf allen Geräten zu haben und mit Tags zu ordnen.'));
    }
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
