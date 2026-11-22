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

export type DocKind = 'board' | 'pack';
export interface Recent { id: string; title: string; at: number; own: boolean; tags?: string[]; textTags?: string[]; dirty?: boolean; trashed?: number; kind?: DocKind }

/** Alle Tags eines Dokuments: eigene (Dialog) und #tags aus dem Text, ohne Doppelte. */
/**
 * Bildschirmtastatur geht zu, das Feld behält aber den Fokus (Android: die
 * Zurück-Taste schließt nur die Tastatur). `cb` läuft dann, z. B. um das
 * Feld zu verlassen und Vorschläge zu schließen. Liefert eine Abmeldung.
 */
export function onKeyboardClose(cb: () => void): () => void {
  const vv = window.visualViewport;
  if (!vv) return () => {};
  let full = vv.height;
  let width = vv.width;
  let open = false;
  const update = () => {
    // Gedreht oder gezoomt: neu messen.
    if (Math.abs(vv.width - width) > 1) { width = vv.width; full = vv.height; open = false; return; }
    full = Math.max(full, vv.height);
    const kb = full - vv.height;
    if (kb > 150) open = true;
    else if (open && kb < 80) { open = false; cb(); }
  };
  vv.addEventListener('resize', update);
  return () => vv.removeEventListener('resize', update);
}

/** Adresse eines Dokuments: Packlisten liegen im eigenen Bereich /pack/ (eigene App). */
export const docHref = (id: string, kind?: DocKind) => `${kind === 'pack' ? '/pack/' : '/'}${encodeURIComponent(id)}`;

/** Angezeigter Name: unbenannte Boards heißen nicht alle „Board“, sondern nach ihrer Adresse. */
export const recentTitle = (r: Recent) => (r.kind === 'board' && r.title === 'Board' ? '' : r.title) || r.id;

/** Kleines Zeichen für die Art (Dokument bzw. Board) vor dem Titel in Listen. */
export function kindIcon(kind?: DocKind): SVGSVGElement {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('class', 'kind-icon');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(ns, 'path');
  // Board: Fläche mit zwei Notizen; Packliste: Häkchen; Dokument: Blatt mit Zeilen.
  path.setAttribute('d', kind === 'board'
    ? 'M2.5 2.5h11v11h-11z M5 5h3v3H5z M9.5 8.5h2v2.5h-2z'
    : kind === 'pack'
      ? 'M2.5 4.5l1.5 1.5 2.5-2.5 M8.5 5h5 M2.5 10.5l1.5 1.5 2.5-2.5 M8.5 11h5'
      : 'M3.5 1.5h6l3 3v10h-9z M6 7h4.5 M6 9.5h4.5 M6 12h3');
  svg.append(path);
  return svg;
}

export function docTags(r: Recent): string[] {
  const out: string[] = [];
  for (const t of [...(r.tags || []), ...(r.textTags || [])]) if (!out.some(x => x.toLowerCase() === t.toLowerCase())) out.push(t);
  return out;
}
const RECENT = 'md:recent';
const REMOVED = 'md:removed';
const listeners: (() => void)[] = [];

export const recent = {
  list(): Recent[] {
    try { return JSON.parse(store.get(RECENT) || '[]'); } catch { return []; }
  },
  save(list: Recent[]) { store.set(RECENT, JSON.stringify(list.sort((a, b) => b.at - a.at).slice(0, 2000))); },
  /** Vorne einsortieren bzw. aktualisieren. */
  /** `textTags`: #tags aus dem aktuellen Text (nur mitgeben, wenn bekannt). `kind`: Board bzw. Packliste. */
  touch(id: string, title: string, own: boolean, textTags?: string[], kind?: DocKind) {
    const list = recent.list();
    const old = list.find(r => r.id === id);
    recent.save([{ ...old, id, title: title || old?.title || '', at: Date.now(), own: own || !!old?.own, ...(textTags ? { textTags } : {}), ...(kind ? { kind } : {}), trashed: undefined, dirty: true }, ...list.filter(r => r.id !== id)]);
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
  /** Papierkorb-Stand merken (at = 0: wiederhergestellt). */
  markTrashed(id: string, at: number, title = '') {
    const list = recent.list();
    if (!list.some(r => r.id === id)) list.push({ id, title: '', at: Date.now(), own: true });
    recent.save(list.map(r => (r.id === id ? { ...r, title: title || r.title, trashed: at || undefined, dirty: true } : r)));
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

// ── Papierkorb ──────────────────────────────────────────────────────────────

export const TRASH_DAYS = 30;
/** Ganze Tage, bis ein Dokument aus dem Papierkorb endgültig verschwindet. */
export const trashDaysLeft = (at: number) => Math.max(0, Math.ceil((at + TRASH_DAYS * 86400_000 - Date.now()) / 86400_000));
/** Besitzer-Schlüssel: wer das Dokument angelegt hat, darf es löschen. */
export const ownerKey = (id: string) => store.get(`md:owner:${id}`);
export const ownerHeaders = (id: string): Record<string, string> => {
  const k = ownerKey(id);
  return k ? { 'x-owner-key': k } : {};
};

/** Rückfrage als eigener Dialog (kein confirm(), das hält Erweiterungen und Tests an). */
export function ask(title: string, text: string, ok: string, danger = true): Promise<boolean> {
  return new Promise(resolve => {
    const yes = el('button', { type: 'button', class: danger ? 't boxed danger-boxed' : 't boxed' }, ok);
    const no = el('button', { type: 'button', class: 't' }, 'Abbrechen');
    const d = dialog('', el('div', { class: 'ask' }, el('h2', {}, title), el('p', { class: 'hint' }, text), el('div', { class: 'ask-row' }, no, yes)));
    yes.addEventListener('click', () => { resolve(true); d.close(); });
    no.addEventListener('click', () => { resolve(false); d.close(); });
    d.addEventListener('close', () => resolve(false));
    setTimeout(() => yes.focus(), 30);
  });
}

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
/** Eintrag: Element oder [Text, Aktion, Klasse] (z. B. 'danger' für Löschen). */
export type MenuItem = HTMLElement | [string, () => void, string?];
export function menu(side: 'left' | 'right', items: MenuItem[]): HTMLDialogElement {
  const list = el('div', { class: 'menu' });
  const d = dialog('', list, { menu: side });
  for (const item of items) {
    if (item instanceof HTMLElement) { list.append(item); continue; }
    const [label, run, cls] = item;
    const b = el('button', { type: 'button', class: cls || '' }, label);
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
  if (doc && data.ownerKey) store.set(`md:owner:${doc}`, data.ownerKey);
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
