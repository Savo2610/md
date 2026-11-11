// Kleine DOM-Helfer, Dialoge, Hinweise und die 2FA-Freischaltung.

export const $ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector<T>(sel);

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'value' && 'value' in node) (node as HTMLInputElement).value = v;
    else node.setAttribute(k, v);
  }
  node.append(...children);
  return node;
}

/** localStorage, das in privaten Fenstern o. ä. nicht wirft. */
export const store = {
  get(k: string): string | null { try { return localStorage.getItem(k); } catch { return null; } },
  set(k: string, v: string) { try { localStorage.setItem(k, v); } catch { /* egal */ } },
  del(k: string) { try { localStorage.removeItem(k); } catch { /* egal */ } },
};

// ── Zuletzt geöffnet ────────────────────────────────────────────────────────
// Liegt immer im Browser. Mit Konto ist das zugleich die Offline-Kopie der
// Dokumentliste im Konto: `dirty` heißt „noch nicht ans Konto geschickt“,
// entfernte IDs warten in md:removed (siehe account.ts).

export interface Recent { id: string; title: string; at: number; own: boolean; tags?: string[]; dirty?: boolean }
const RECENT = 'md:recent';
const REMOVED = 'md:removed';
const listeners: (() => void)[] = [];

export const recent = {
  list(): Recent[] {
    try { return JSON.parse(store.get(RECENT) || '[]'); } catch { return []; }
  },
  save(list: Recent[]) { store.set(RECENT, JSON.stringify(list.sort((a, b) => b.at - a.at).slice(0, 2000))); },
  /** Vorne einsortieren bzw. aktualisieren. */
  touch(id: string, title: string, own: boolean) {
    const list = recent.list();
    const old = list.find(r => r.id === id);
    recent.save([{ ...old, id, title: title || old?.title || '', at: Date.now(), own: own || !!old?.own, dirty: true }, ...list.filter(r => r.id !== id)]);
    recent.unremove(id);
    recent.changed();
  },
  remove(id: string) {
    recent.save(recent.list().filter(r => r.id !== id));
    recent.removed = [...recent.removed.filter(r => r !== id), id];
    recent.changed();
  },
  rename(from: string, to: string) {
    recent.save(recent.list().map(r => (r.id === from ? { ...r, id: to, dirty: true } : r)));
    recent.changed();
  },
  /** IDs, die aus der Liste genommen, aber dem Konto noch nicht gemeldet wurden. */
  get removed(): string[] {
    try { return JSON.parse(store.get(REMOVED) || '[]'); } catch { return []; }
  },
  set removed(ids: string[]) {
    if (ids.length) store.set(REMOVED, JSON.stringify(ids.slice(-500)));
    else store.del(REMOVED);
  },
  unremove(id: string) {
    const r = recent.removed;
    if (r.includes(id)) recent.removed = r.filter(x => x !== id);
  },
  onChange(fn: () => void) { listeners.push(fn); },
  changed() { for (const fn of listeners) fn(); },
};

export function ago(t: number): string {
  const s = (Date.now() - t) / 1000;
  if (s < 60) return 'gerade eben';
  if (s < 3600) return `vor ${Math.floor(s / 60)} Min.`;
  if (s < 86400) return `vor ${Math.floor(s / 3600)} Std.`;
  if (s < 86400 * 2) return 'gestern';
  if (s < 86400 * 30) return `vor ${Math.floor(s / 86400)} Tagen`;
  return new Date(t).toLocaleDateString('de-DE', { day: 'numeric', month: 'short', year: '2-digit' });
}

// ── Admin-Token nach 2FA ────────────────────────────────────────────────────

export function adminToken(): string | null {
  const raw = store.get('md:admin');
  if (!raw) return null;
  try {
    const { token, exp } = JSON.parse(raw);
    if (exp > Date.now()) return token;
  } catch { /* kaputt */ }
  store.del('md:admin');
  return null;
}

/** Mit dem Admin-Google-Konto angemeldet (Server sagt es in der Seite). */
let accountAdmin = false;
export function setAccountAdmin(v: boolean) { accountAdmin = v; }
export const isAdmin = () => !!adminToken() || accountAdmin;
/** Header für Admin-Anfragen: Token, falls vorhanden; sonst reicht das Cookie. */
export function adminHeaders(): Record<string, string> {
  const t = adminToken();
  return t ? { authorization: `Bearer ${t}` } : {};
}

export function setAdminToken(token: string | null, ttlSeconds = 0) {
  if (!token) store.del('md:admin');
  else store.set('md:admin', JSON.stringify({ token, exp: Date.now() + ttlSeconds * 1000 - 60_000 }));
}

// ── Dialog ──────────────────────────────────────────────────────────────────

export function dialog(title: string, body: Node, opts: { menu?: 'left' | 'right' } = {}): HTMLDialogElement {
  const d = el('dialog', { class: opts.menu ? `dlg dlg-menu dlg-${opts.menu}` : 'dlg' });
  if (title) {
    const head = el('div', { class: 'dlg-head' }, el('h2', {}, title));
    const close = el('button', { type: 'button', class: 't', 'aria-label': 'Schließen' }, 'Schließen');
    close.addEventListener('click', () => d.close());
    head.append(close);
    d.append(head);
  }
  d.append(body);
  d.addEventListener('close', () => d.remove());
  // Klick auf den abgedunkelten Hintergrund schließt (nicht auf den Rand des Dialogs).
  d.addEventListener('click', e => {
    if (e.target !== d) return;
    const r = d.getBoundingClientRect();
    if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) d.close();
  });
  document.body.append(d);
  d.showModal();
  return d;
}

/** Kleines Menü an der Kopfleiste (links bzw. rechts), auf dem Handy als Blatt. */
export type MenuItem = HTMLElement | [string, () => void];
export function menu(side: 'left' | 'right', items: MenuItem[]): HTMLDialogElement {
  const list = el('div', { class: 'menu' });
  const d = dialog('', list, { menu: side });
  for (const item of items) {
    if (item instanceof HTMLElement) { list.append(item); continue; }
    const [label, run] = item;
    const b = el('button', { type: 'button' }, label);
    b.addEventListener('click', () => { d.close(); run(); });
    list.append(b);
  }
  return d;
}

// ── Hinweis unten ───────────────────────────────────────────────────────────

let toastTimer: ReturnType<typeof setTimeout> | null = null;
export function toast(msg: string) {
  let t = $('#toast');
  if (!t) { t = el('div', { id: 'toast', role: 'status' }); document.body.append(t); }
  t.textContent = msg;
  t.classList.add('show');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t!.classList.remove('show'), 3500);
}

// ── 2FA-Code eingeben ───────────────────────────────────────────────────────

export function codeForm(onSubmit: (code: string) => Promise<string | null>): HTMLFormElement {
  const input = el('input', {
    type: 'text', inputmode: 'numeric', autocomplete: 'one-time-code', pattern: '[0-9]{6}', maxlength: '6',
    placeholder: '000000', class: 'code', 'aria-label': '6-stelliger Code',
  }) as HTMLInputElement;
  const submit = el('button', { type: 'submit', class: 'primary' }, 'Freischalten');
  const err = el('p', { class: 'error', role: 'alert' });
  const form = el('form', { class: 'codeform' }, el('div', { class: 'row' }, input, submit), err);
  input.addEventListener('input', () => {
    input.value = input.value.replace(/\D/g, '').slice(0, 6);
    if (input.value.length === 6) form.requestSubmit();
  });
  form.addEventListener('submit', async e => {
    e.preventDefault();
    if (input.value.length !== 6) return;
    submit.disabled = true;
    err.textContent = '';
    const problem = await onSubmit(input.value);
    submit.disabled = false;
    if (problem) { err.textContent = problem; input.select(); }
  });
  setTimeout(() => input.focus(), 30);
  return form;
}

export async function unlock(code: string, doc?: string): Promise<{ ok: true; editKey: string | null } | { ok: false; error: string }> {
  const res = await fetch('/api/unlock', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code, doc }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return { ok: false, error: data.error || 'Freischalten fehlgeschlagen.' };
  if (data.token) setAdminToken(data.token, data.expiresIn);
  return { ok: true, editKey: data.editKey ?? null };
}

export function unlockDialog(docId: string, done: (editKey: string | null) => void) {
  const body = el('div', {});
  const d = dialog('Mit Code freischalten', body);
  body.append(codeForm(async code => {
    const r = await unlock(code, docId);
    if (!r.ok) return r.error;
    d.close();
    done(r.editKey);
    return null;
  }));
}
