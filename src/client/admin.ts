// Übersicht aller Dokumente (/admin). Zugang mit 2FA-Code.

import { $, el, toast, adminToken, setAdminToken, codeForm, unlock } from './ui';

interface DocSummary {
  id: string; title: string; snippet: string; created: number; updated: number;
  size: number; images: number; pinned: boolean;
}

const fmtDate = (t: number) => new Date(t).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' });
const fmtSize = (b: number) => (b < 1024 ? `${b} B` : b < 1024 ** 2 ? `${(b / 1024).toFixed(0)} KB` : `${(b / 1024 ** 2).toFixed(1)} MB`);

export function start() {
  document.body.dataset.mode = 'admin';
  const app = $('#app')!;
  const bar = el('header', { id: 'bar' },
    el('div', { class: 'bar-left' }, el('a', { class: 'brand', href: '/', title: 'Neues Dokument' }, 'md'), el('span', { class: 'status' }, 'Übersicht')),
    el('nav', { class: 'bar-right' }),
  );
  document.body.prepend(bar);
  const main = el('div', { class: 'admin' });
  app.append(main);

  if (!adminToken()) return login(main);
  list(main);
}

function login(main: HTMLElement) {
  main.replaceChildren(
    el('h1', {}, 'Übersicht'),
    el('p', { class: 'hint' }, 'Code aus der Authenticator-App eingeben.'),
    codeForm(async code => {
      const r = await unlock(code);
      if (!r.ok) return r.error;
      list(main);
      return null;
    }),
  );
}

async function list(main: HTMLElement, q = '') {
  const res = await fetch(`/api/admin/docs?q=${encodeURIComponent(q)}`, { headers: { authorization: `Bearer ${adminToken()}` } });
  if (res.status === 401) { setAdminToken(null); return login(main); }
  const data: { docs: DocSummary[]; total: number; bytes: number } = await res.json();

  const right = $('.bar-right')!;
  const logout = el('button', { type: 'button', class: 't' }, 'Abmelden');
  logout.addEventListener('click', () => { setAdminToken(null); login(main); right.replaceChildren(); });
  right.replaceChildren(logout);

  const search = el('input', { type: 'search', placeholder: 'Suchen …', value: q, class: 'search', 'aria-label': 'Suchen' }) as HTMLInputElement;
  let t: ReturnType<typeof setTimeout>;
  search.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => list(main, search.value), 250); });

  const table = el('table', { class: 'docs' });
  table.append(el('thead', {}, el('tr', {}, el('th', {}, 'Dokument'), el('th', {}, 'Geändert'), el('th', {}, 'Größe'), el('th', { title: 'Wird nicht automatisch gelöscht' }, 'Behalten'), el('th', {}, ''))));
  const tbody = el('tbody');
  for (const d of data.docs) {
    const pin = el('input', { type: 'checkbox', 'aria-label': 'Behalten' }) as HTMLInputElement;
    pin.checked = d.pinned;
    pin.addEventListener('change', async () => {
      const r = await fetch(`/api/docs/${encodeURIComponent(d.id)}/pin`, {
        method: 'POST', headers: { authorization: `Bearer ${adminToken()}`, 'content-type': 'application/json' },
        body: JSON.stringify({ pinned: pin.checked }),
      });
      if (!r.ok) { pin.checked = !pin.checked; toast('Ging nicht.'); }
    });
    const del = el('button', { type: 'button', class: 't danger' }, 'Löschen');
    del.addEventListener('click', async () => {
      if (!confirm(`„${d.title || d.id}“ mit allen Bildern endgültig löschen?`)) return;
      const r = await fetch(`/api/docs/${encodeURIComponent(d.id)}`, { method: 'DELETE', headers: { authorization: `Bearer ${adminToken()}` } });
      if (r.ok) { row.remove(); toast('Gelöscht.'); } else toast('Löschen fehlgeschlagen.');
    });
    const row = el('tr', {},
      el('td', {},
        el('a', { href: `/${encodeURIComponent(d.id)}` }, d.title || d.id),
        el('div', { class: 'meta' }, `/${d.id}`),
        el('div', { class: 'snippet' }, d.snippet || '(leer)'),
      ),
      el('td', { class: 'nowrap' }, fmtDate(d.updated)),
      el('td', { class: 'nowrap' }, fmtSize(d.size + d.images)),
      el('td', {}, pin),
      el('td', {}, del),
    );
    tbody.append(row);
  }
  table.append(tbody);

  main.replaceChildren(
    el('div', { class: 'admin-head' }, el('h1', {}, 'Übersicht'), el('span', { class: 'hint' }, `${data.total} Dokumente · ${fmtSize(data.bytes)}`)),
    search,
    data.docs.length ? table : el('p', { class: 'hint' }, 'Keine Dokumente gefunden.'),
  );
  if (q) { search.focus(); search.setSelectionRange(q.length, q.length); }
}
