// Übersicht aller Dokumente (/admin). Zugang mit 2FA-Code.

import { $, el, toast, ask, adminToken, adminHeaders, isAdmin, setAdminToken, codeForm, unlock } from './ui';

interface DocSummary {
  id: string; title: string; snippet: string; created: number; updated: number;
  size: number; images: number; pinned: boolean; trashed: number;
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

  if (!isAdmin()) return login(main);
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
  const res = await fetch(`/api/admin/docs?q=${encodeURIComponent(q)}`, { headers: adminHeaders() });
  if (res.status === 401) { setAdminToken(null); return login(main); }
  const data: { docs: DocSummary[]; total: number; bytes: number } = await res.json();

  // Abmelden nur für den 2FA-Zugang; mit dem Google-Konto meldet man sich auf /home ab.
  const right = $('.bar-right')!;
  right.replaceChildren();
  if (adminToken()) {
    const logout = el('button', { type: 'button', class: 't' }, 'Abmelden');
    logout.addEventListener('click', () => { setAdminToken(null); login(main); right.replaceChildren(); });
    right.append(logout);
  }

  const search = el('input', { type: 'search', placeholder: 'Suchen …', value: q, class: 'search', 'aria-label': 'Suchen' }) as HTMLInputElement;
  let t: ReturnType<typeof setTimeout>;
  search.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => list(main, search.value), 250); });

  // Mehrere auswählen und auf einmal löschen.
  const picked = new Set<string>();
  const boxes: HTMLInputElement[] = [];
  const all = el('input', { type: 'checkbox', 'aria-label': 'Alle auswählen' }) as HTMLInputElement;
  const bulkCount = el('span', {});
  const bulkDel = el('button', { type: 'button', class: 't boxed danger-boxed' }, 'Löschen');
  const bulkNone = el('button', { type: 'button', class: 't' }, 'Auswahl aufheben');
  const bulk = el('div', { class: 'bulk' }, bulkCount, el('span', { class: 'bulk-actions' }, bulkNone, bulkDel));
  const sync = () => {
    bulk.hidden = !picked.size;
    bulkCount.textContent = `${picked.size} ausgewählt`;
    all.checked = !!boxes.length && picked.size === boxes.length;
    all.indeterminate = picked.size > 0 && picked.size < boxes.length;
  };
  all.addEventListener('change', () => {
    for (const b of boxes) { b.checked = all.checked; if (all.checked) picked.add(b.value); else picked.delete(b.value); }
    sync();
  });
  bulkNone.addEventListener('click', () => { all.checked = false; all.dispatchEvent(new Event('change')); });
  bulkDel.addEventListener('click', async () => {
    const ids = [...picked];
    if (!(await ask(`${ids.length === 1 ? '1 Dokument' : `${ids.length} Dokumente`} endgültig löschen?`, 'Mit allen Bildern. Das lässt sich nicht rückgängig machen.', 'Löschen'))) return;
    bulkDel.disabled = true;
    let ok = 0;
    for (let i = 0; i < ids.length; i += 6) {
      const res = await Promise.all(ids.slice(i, i + 6).map(id =>
        fetch(`/api/docs/${encodeURIComponent(id)}`, { method: 'DELETE', headers: adminHeaders() }).then(r => r.ok).catch(() => false)));
      ok += res.filter(Boolean).length;
    }
    toast(ok === ids.length ? `${ok} gelöscht.` : `${ok} von ${ids.length} gelöscht.`);
    list(main, q);
  });

  const table = el('table', { class: 'docs' });
  table.append(el('thead', {}, el('tr', {}, el('th', {}, el('label', { class: 'pick' }, all, 'Dokument')), el('th', {}, 'Geändert'), el('th', {}, 'Größe'), el('th', { title: 'Wird nicht automatisch gelöscht' }, 'Behalten'), el('th', {}, ''))));
  const tbody = el('tbody');
  for (const d of data.docs) {
    const pin = el('input', { type: 'checkbox', 'aria-label': 'Behalten' }) as HTMLInputElement;
    pin.checked = d.pinned;
    pin.addEventListener('change', async () => {
      const r = await fetch(`/api/docs/${encodeURIComponent(d.id)}/pin`, {
        method: 'POST', headers: { ...adminHeaders(), 'content-type': 'application/json' },
        body: JSON.stringify({ pinned: pin.checked }),
      });
      if (!r.ok) { pin.checked = !pin.checked; toast('Ging nicht.'); }
    });
    const box = el('input', { type: 'checkbox', value: d.id, 'aria-label': 'Auswählen' }) as HTMLInputElement;
    box.addEventListener('change', () => { if (box.checked) picked.add(d.id); else picked.delete(d.id); sync(); });
    boxes.push(box);
    const del = el('button', { type: 'button', class: 't danger' }, 'Löschen');
    del.addEventListener('click', async () => {
      if (!(await ask('Endgültig löschen?', `„${d.title || d.id}“ mit allen Bildern. Das lässt sich nicht rückgängig machen.`, 'Löschen'))) return;
      const r = await fetch(`/api/docs/${encodeURIComponent(d.id)}`, { method: 'DELETE', headers: adminHeaders() });
      if (r.ok) { row.remove(); toast('Gelöscht.'); } else toast('Löschen fehlgeschlagen.');
    });
    const status = el('div', { class: 'meta' }, `/${d.id}`);
    if (d.trashed) {
      const back = el('button', { type: 'button', class: 't boxed small' }, 'Wiederherstellen');
      back.addEventListener('click', async () => {
        const r = await fetch(`/api/docs/${encodeURIComponent(d.id)}/restore`, { method: 'POST', headers: adminHeaders() });
        if (r.ok) list(main, q); else toast('Ging nicht.');
      });
      status.append(el('span', { class: 'badge' }, 'Papierkorb'), back);
    }
    const row = el('tr', { class: d.trashed ? 'trashed' : '' },
      el('td', {},
        el('span', { class: 'pick' }, box, el('a', { href: `/${encodeURIComponent(d.id)}` }, d.title || d.id)),
        status,
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
    bulk,
    data.docs.length ? table : el('p', { class: 'hint' }, 'Keine Dokumente gefunden.'),
  );
  sync();
  if (q) { search.focus(); search.setSelectionRange(q.length, q.length); }
}
