// Startseite der App (/home): zuletzt geöffnete Dokumente und „Neues Dokument“.
// Die Liste liegt nur in diesem Browser bzw. in dieser installierten App.

import { $, el, recent, ago, toast } from './ui';

export function start() {
  document.body.dataset.mode = 'home';
  const app = $('#app')!;

  const bar = el('header', { id: 'bar' },
    el('div', { class: 'bar-left' }, el('span', { class: 'brand' }, 'md')),
    el('nav', { class: 'bar-right' }),
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
  const list = el('ul', { class: 'notes' });
  main.append(create, search, list);

  const render = () => {
    const q = search.value.trim().toLowerCase();
    const items = recent.list().filter(r => !q || (r.title || r.id).toLowerCase().includes(q) || r.id.includes(q));
    search.hidden = recent.list().length < 6;
    list.replaceChildren();
    if (!items.length) {
      list.append(el('li', { class: 'notes-empty' }, q
        ? 'Nichts gefunden.'
        : 'Noch keine Dokumente. Was du hier öffnest oder schreibst, erscheint in dieser Liste – nur auf diesem Gerät.'));
      return;
    }
    for (const r of items) {
      const remove = el('button', { type: 'button', class: 'note-remove', title: 'Aus der Liste entfernen', 'aria-label': 'Aus der Liste entfernen' }, '×');
      remove.addEventListener('click', e => {
        e.preventDefault();
        recent.remove(r.id);
        render();
      });
      list.append(el('li', {},
        el('a', { href: `/${encodeURIComponent(r.id)}`, class: 'note' },
          el('span', { class: 'note-title' }, r.title || r.id),
          el('span', { class: 'note-meta' }, `${ago(r.at)}${r.own ? ' · bearbeitbar' : ''}`),
        ),
        remove,
      ));
    }
  };
  search.addEventListener('input', render);
  addEventListener('pageshow', render);
  render();
}
