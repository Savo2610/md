// Optionales Konto (Google-Login). Ohne Anmeldung ändert sich nichts.
//
// Angemeldet gleicht der Browser seine Liste (ui.ts → recent) mit dem Konto
// ab: Neues und Geändertes wird hochgeschickt, danach gilt die Liste aus dem
// Konto, samt Bearbeitungsschlüsseln und Tags. Beim ersten Login auf einem
// Gerät wandert alles, was dort schon in der Liste steht, ins Konto.

import { el, store, recent, toast, docTags, type MenuItem, type Recent } from './ui';

export interface User { name: string; email: string; picture: string }

interface ServerDoc { id: string; title: string; editKey: string | null; opened: number; tags: string[]; textTags?: string[]; ownerKey: string | null; trashed: number }

let user: User | null = null;
let enabled = false;
let pushTimer: ReturnType<typeof setTimeout> | null = null;
let syncing: Promise<boolean> | null = null;

const IMPORTED = 'md:imported';
const LAST_SYNC = 'md:synced-at';

export const account = {
  get user() { return user; },
  /** Anmelden ist auf dem Server eingerichtet. */
  get enabled() { return enabled; },

  init(boot: { user?: User | null; login?: boolean }) {
    user = boot.user ?? null;
    enabled = !!boot.login;
    if (!user) return;
    // Beim ersten Login auf diesem Gerät: alles Vorhandene ins Konto.
    if (store.get(IMPORTED) !== user.email) {
      recent.save(recent.list().map(r => ({ ...r, dirty: true })));
      store.set(IMPORTED, user.email);
      store.del(LAST_SYNC);
    }
    recent.onChange(schedulePush);
  },

  login(next = location.pathname + location.search) {
    location.href = `/auth/login?next=${encodeURIComponent(next)}`;
  },

  async logout() {
    await push();
    await fetch('/auth/logout', { method: 'POST' }).catch(() => {});
    forgetLocal();
    location.reload();
  },

  async deleteAccount() {
    const res = await fetch('/api/me', { method: 'DELETE' });
    if (!res.ok) { toast('Löschen fehlgeschlagen.'); return; }
    forgetLocal();
    location.reload();
  },

  /**
   * Hochschicken, dann die Liste aus dem Konto übernehmen. Ohne `force`
   * höchstens einmal pro Minute (jede Seite ruft das beim Öffnen auf).
   * Gibt true zurück, wenn sich die Liste geändert haben kann.
   */
  sync(force = false): Promise<boolean> {
    if (!user || !navigator.onLine) return Promise.resolve(false);
    if (!force && Date.now() - Number(store.get(LAST_SYNC) || 0) < 60_000) return Promise.resolve(false);
    syncing ??= (async () => {
      try {
        if (!(await push())) return false;
        const res = await fetch('/api/me', { cache: 'no-store' });
        if (res.status === 401) { user = null; return false; }
        if (!res.ok) return false;
        const data = await res.json() as { docs: ServerDoc[] };
        adopt(data.docs);
        store.set(LAST_SYNC, String(Date.now()));
        return true;
      } catch {
        return false;
      } finally {
        syncing = null;
      }
    })();
    return syncing;
  },

  /** Alle Tags im Konto, die häufigsten zuerst. */
  allTags(): string[] {
    const count = new Map<string, number>();
    for (const r of recent.list()) for (const t of docTags(r)) count.set(t, (count.get(t) || 0) + 1);
    return [...count.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'de')).map(([t]) => t);
  },

  async setTags(id: string, tags: string[]): Promise<boolean> {
    if (!user) return false;
    if (!recent.list().some(r => r.id === id)) recent.touch(id, '', !!store.get(`md:key:${id}`));
    if (!(await push())) { toast('Offline: Tags lassen sich nur mit Verbindung ändern.'); return false; }
    const res = await fetch(`/api/me/docs/${encodeURIComponent(id)}/tags`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tags }),
    }).catch(() => null);
    if (!res?.ok) { toast('Tags speichern fehlgeschlagen.'); return false; }
    const doc = await res.json() as ServerDoc;
    recent.save(recent.list().map(r => (r.id === id ? { ...r, tags: doc.tags } : r)));
    return true;
  },
};

/** Einträge fürs Menü: angemeldet Konto und Abmelden, sonst „Anmelden“. */
export function accountItems(): MenuItem[] {
  if (!enabled) return [];
  if (!user) {
    return [
      el('div', { class: 'menu-label' }, 'Konto'),
      ['Mit Google anmelden', () => account.login()],
    ];
  }
  return [
    el('div', { class: 'menu-label' }, user.email || user.name),
    ['Abmelden', () => account.logout()],
  ];
}

/** Rundes Bild bzw. Anfangsbuchstabe für die Kopfleiste. */
export function avatar(u: User): HTMLElement {
  const box = el('span', { class: 'avatar', 'aria-hidden': 'true' }, (u.name || u.email || '?').trim().charAt(0).toUpperCase());
  if (u.picture) {
    const img = el('img', { src: u.picture, alt: '', referrerpolicy: 'no-referrer' }) as HTMLImageElement;
    img.addEventListener('error', () => img.remove());
    box.append(img);
  }
  return box;
}

function schedulePush() {
  if (pushTimer) clearTimeout(pushTimer);
  pushTimer = setTimeout(() => { pushTimer = null; push(); }, 800);
}

/** Geänderte Einträge und Entfernungen ans Konto. true, wenn nichts mehr offen ist. */
async function push(): Promise<boolean> {
  if (!user) return false;
  if (pushTimer) { clearTimeout(pushTimer); pushTimer = null; }
  const dirty = recent.list().filter(r => r.dirty);
  const removed = recent.removed;
  if (!dirty.length && !removed.length) return true;
  if (!navigator.onLine) return false;
  try {
    for (const id of removed) {
      const res = await fetch(`/api/me/docs/${encodeURIComponent(id)}`, { method: 'DELETE' });
      if (!res.ok && res.status !== 404) return false;
      recent.removed = recent.removed.filter(x => x !== id);
    }
    if (dirty.length) {
      const items = dirty.map(r => ({ id: r.id, title: r.title, opened: r.at, editKey: store.get(`md:key:${r.id}`) || undefined, ownerKey: store.get(`md:owner:${r.id}`) || undefined, trashed: r.trashed || 0, ...(r.textTags ? { textTags: r.textTags } : {}) }));
      const res = await fetch('/api/me/docs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ items }),
      });
      if (!res.ok) return false;
      // Nur die Flags der hochgeschickten Stände löschen; was inzwischen
      // erneut geändert wurde, bleibt markiert.
      const sent = new Map(dirty.map(r => [r.id, r.at]));
      recent.save(recent.list().map(r => (r.dirty && sent.get(r.id) === r.at ? { ...r, dirty: false } : r)));
    }
    return true;
  } catch {
    return false;
  }
}

/** Liste aus dem Konto übernehmen; lokal Ungesendetes bleibt obenauf. */
function adopt(docs: ServerDoc[]) {
  const local = new Map(recent.list().map(r => [r.id, r]));
  const removed = new Set(recent.removed);
  const next: Recent[] = [];
  for (const d of docs) {
    if (removed.has(d.id)) continue;
    if (d.editKey && !store.get(`md:key:${d.id}`)) store.set(`md:key:${d.id}`, d.editKey);
    if (d.ownerKey && !store.get(`md:owner:${d.id}`)) store.set(`md:owner:${d.id}`, d.ownerKey);
    const mine = local.get(d.id);
    if (mine?.dirty) { next.push(mine); local.delete(d.id); continue; }
    next.push({ id: d.id, title: d.title || mine?.title || '', at: Math.max(d.opened, mine?.at || 0), own: !!d.editKey || !!mine?.own, tags: d.tags, textTags: d.textTags || [], trashed: d.trashed || undefined });
    local.delete(d.id);
  }
  for (const r of local.values()) if (r.dirty) next.push(r);
  recent.save(next);
}

/** Abmelden: Liste und Schlüssel von diesem Gerät nehmen (im Konto bleibt alles). */
function forgetLocal() {
  try {
    for (const k of Object.keys(localStorage)) {
      if (k.startsWith('md:key:') || k.startsWith('md:owner:') || ['md:recent', 'md:removed', 'md:memos:outbox', 'md:memos:draft', IMPORTED, LAST_SYNC].includes(k)) localStorage.removeItem(k);
    }
  } catch { /* egal */ }
  // Gespeicherte Memos-Seite (Service Worker) gehört zum Konto.
  self.caches?.open('md-pages').then(c => c.delete('/memos')).catch(() => {});
}
