// Ein Durable Object pro angemeldetem Konto (Name: "g:<Google-sub>").
//
// Merkt sich, welche Dokumente zu diesem Konto gehören: Titel, zuletzt
// geöffnet, Bearbeitungsschlüssel (falls vorhanden) und die eigenen Tags.
// Die Dokumente selbst liegen weiter in ihren Doc-Objekten; Tags sind
// persönlich und tauchen im Dokument nicht auf.
//
// Dazu die Memos (/memos): kurze private Notizen, nur für dieses Konto, samt
// Anhängen (Bilder, Dateien, Sprachmemos). Die Anhänge liegen in R2 unter
// memos/<ID dieses Objekts>/<datei>; hier steht nur, welche es gibt und wie
// groß sie sind. Im Text eines Memos stehen sie als /m/<datei>.

import { DurableObject } from 'cloudflare:workers';
import type { Env } from './env';

export interface AccountDoc {
  id: string;
  title: string;
  editKey: string | null;
  opened: number;
  tags: string[];
  /** Besitzer-Schlüssel: dieses Konto hat das Dokument angelegt. */
  ownerKey: string | null;
  /** Im Papierkorb seit (ms), sonst 0. */
  trashed: number;
}

export interface Memo {
  id: string;
  text: string;
  created: number;
  updated: number;
}

export interface Profile {
  sub: string;
  email: string;
  name: string;
  picture: string;
}

const MAX_DOCS = 5000;
const MAX_TAGS = 20;
const MAX_TAG_LEN = 30;
export const MAX_MEMO = 20_000;
const MAX_MEMOS = 50_000;
/** Anhänge: höchstens so groß pro Datei bzw. zusammen pro Konto. */
export const MAX_FILE = 50 * 1024 * 1024;
const MAX_FILES_TOTAL = 2 * 1024 * 1024 * 1024;
/** Hochgeladen, aber nie in ein Memo übernommen: nach einem Tag weg. */
const ORPHAN_AFTER = 24 * 3600_000;
export const FILE_NAME = /^[\w-]{6,40}\.[a-z0-9]{1,8}$/;
const FILE_REF = /\/m\/([\w-]{6,40}\.[a-z0-9]{1,8})/g;
const refsIn = (text: string) => new Set([...text.matchAll(FILE_REF)].map(m => m[1]));
/** Memo-IDs kommen vom Browser (damit Offline-Senden und Rückgängig nichts doppelt anlegen). */
export const MEMO_ID = /^[\w-]{8,40}$/;

/** Tags säubern: getrimmt, ohne #, ohne Doppelte (Groß/klein egal), begrenzt. */
export function cleanTags(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const t of raw) {
    if (typeof t !== 'string') continue;
    const tag = t.replace(/^#+/, '').replace(/[\s,]+/g, ' ').trim().slice(0, MAX_TAG_LEN);
    if (!tag || seen.has(tag.toLowerCase())) continue;
    seen.add(tag.toLowerCase());
    out.push(tag);
    if (out.length >= MAX_TAGS) break;
  }
  return out;
}

export class Account extends DurableObject<Env> {
  sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS profile (k TEXT PRIMARY KEY, v TEXT);
      CREATE TABLE IF NOT EXISTS docs (
        id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT '', edit_key TEXT,
        opened INTEGER NOT NULL DEFAULT 0, tags TEXT NOT NULL DEFAULT '[]'
      );
      CREATE TABLE IF NOT EXISTS memos (
        id TEXT PRIMARY KEY, text TEXT NOT NULL, created INTEGER NOT NULL, updated INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS memos_created ON memos(created);
      CREATE TABLE IF NOT EXISTS memo_files (
        name TEXT PRIMARY KEY, size INTEGER NOT NULL, type TEXT NOT NULL, created INTEGER NOT NULL
      );
    `);
    // Spalten kamen später dazu (Papierkorb).
    for (const col of ['owner_key TEXT', 'trashed INTEGER NOT NULL DEFAULT 0']) {
      try { this.sql.exec(`ALTER TABLE docs ADD COLUMN ${col}`); } catch { /* gibt es schon */ }
    }
  }

  setProfile(p: Profile) {
    for (const [k, v] of Object.entries({ ...p, seen: Date.now() })) {
      this.sql.exec('INSERT INTO profile (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v', k, String(v));
    }
    if (!this.sql.exec("SELECT 1 FROM profile WHERE k = 'created'").toArray().length) {
      this.sql.exec("INSERT INTO profile (k, v) VALUES ('created', ?)", String(Date.now()));
    }
  }

  list(): AccountDoc[] {
    return this.sql.exec('SELECT * FROM docs ORDER BY opened DESC').toArray().map(row);
  }

  get(id: string): AccountDoc | null {
    const r = this.sql.exec('SELECT * FROM docs WHERE id = ?', id).toArray();
    return r.length ? row(r[0]) : null;
  }

  /**
   * Dokumente eintragen oder aktualisieren. Titel und Zeitpunkt gewinnen,
   * wenn sie neuer sind; ein Schlüssel wird nie durch „keinen“ ersetzt.
   * Tags werden nur gesetzt, wenn sie mitkommen (Übernahme beim ersten Login).
   */
  upsert(items: Partial<AccountDoc>[]): AccountDoc[] {
    let count = this.sql.exec('SELECT COUNT(*) AS n FROM docs').one().n as number;
    for (const it of items.slice(0, MAX_DOCS)) {
      if (typeof it.id !== 'string' || !it.id) continue;
      const old = this.get(it.id);
      if (!old && count >= MAX_DOCS) continue;
      const opened = Math.min(Number(it.opened) || 0, Date.now() + 60_000);
      const newer = !old || opened >= old.opened;
      const next: AccountDoc = {
        id: it.id,
        title: typeof it.title === 'string' && it.title && (newer || !old?.title) ? it.title.slice(0, 200) : old?.title || '',
        editKey: typeof it.editKey === 'string' && it.editKey ? it.editKey.slice(0, 100) : old?.editKey ?? null,
        opened: Math.max(opened, old?.opened || 0),
        tags: it.tags !== undefined && !old?.tags.length ? cleanTags(it.tags) : old?.tags || [],
        ownerKey: typeof it.ownerKey === 'string' && it.ownerKey ? it.ownerKey.slice(0, 100) : old?.ownerKey ?? null,
        trashed: typeof it.trashed === 'number' && newer ? Math.max(0, it.trashed) : old?.trashed || 0,
      };
      this.write(next);
      if (!old) count++;
    }
    return this.list();
  }

  setTags(id: string, tags: unknown): AccountDoc | null {
    const old = this.get(id);
    if (!old) return null;
    const next = { ...old, tags: cleanTags(tags) };
    this.write(next);
    return next;
  }

  /** Papierkorb-Stand eines eigenen Dokuments (vom Server beim Löschen/Wiederherstellen). */
  setTrashed(id: string, at: number) {
    this.sql.exec('UPDATE docs SET trashed = ? WHERE id = ?', at, id);
  }

  remove(id: string) {
    this.sql.exec('DELETE FROM docs WHERE id = ?', id);
  }

  /** Dokument hat eine neue Adresse: Eintrag samt Tags mitnehmen. */
  rename(from: string, to: string) {
    const old = this.get(from);
    if (!old) return;
    this.sql.exec('DELETE FROM docs WHERE id = ?', from);
    const existing = this.get(to);
    this.write({ ...old, id: to, editKey: old.editKey || existing?.editKey || null, ownerKey: old.ownerKey || existing?.ownerKey || null, tags: old.tags.length ? old.tags : existing?.tags || [] });
  }

  // ── Memos ───────────────────────────────────────────────────────────────

  /** Alle Memos, neueste zuerst. */
  memos(): Memo[] {
    return this.sql.exec('SELECT * FROM memos ORDER BY created DESC, id DESC').toArray().map(memoRow);
  }

  /**
   * Memo anlegen. Gibt es die ID schon, bleibt alles, wie es ist (doppelt
   * gesendet). `created` darf aus dem Browser kommen (offline geschrieben,
   * Rückgängig nach dem Löschen), aber nicht in der Zukunft liegen.
   */
  addMemo(id: string, text: string, created?: number): Memo | null {
    const old = this.memo(id);
    if (old) return old;
    if ((this.sql.exec('SELECT COUNT(*) AS n FROM memos').one().n as number) >= MAX_MEMOS) return null;
    const now = Date.now();
    const at = Number.isFinite(created) && created! > 0 ? Math.min(Math.floor(created!), now) : now;
    this.sql.exec('INSERT INTO memos (id, text, created, updated) VALUES (?, ?, ?, ?)', id, text, at, Math.max(at, now));
    return this.memo(id);
  }

  /** Mehrere auf einmal (Umzug aus einer anderen App). Liefert die übernommenen IDs. */
  addMemos(items: { id: string; text: string; created: number }[]): string[] {
    return items.filter(m => this.addMemo(m.id, m.text, m.created)).map(m => m.id);
  }

  /** Liefert das Memo und Anhänge, die danach nirgends mehr vorkommen (in R2 löschen). */
  editMemo(id: string, text: string): { memo: Memo | null; orphans: string[] } {
    const old = this.memo(id);
    if (!old) return { memo: null, orphans: [] };
    this.sql.exec('UPDATE memos SET text = ?, updated = ? WHERE id = ?', text, Date.now(), id);
    const kept = refsIn(text);
    return { memo: this.memo(id), orphans: this.dropUnused([...refsIn(old.text)].filter(f => !kept.has(f))) };
  }

  /** Löscht das Memo; liefert die Anhänge, die nur dort vorkamen. */
  deleteMemo(id: string): string[] {
    const old = this.memo(id);
    if (!old) return [];
    this.sql.exec('DELETE FROM memos WHERE id = ?', id);
    return this.dropUnused([...refsIn(old.text)]);
  }

  // ── Anhänge ─────────────────────────────────────────────────────────────

  /** Platz für einen Anhang eintragen. false, wenn das Konto voll ist. */
  reserveFile(name: string, size: number, type: string): boolean {
    const used = this.sql.exec('SELECT COALESCE(SUM(size), 0) AS b FROM memo_files').one().b as number;
    if (used + size > MAX_FILES_TOTAL) return false;
    this.sql.exec('INSERT INTO memo_files (name, size, type, created) VALUES (?, ?, ?, ?)', name, size, type, Date.now());
    return true;
  }

  hasFile(name: string): boolean {
    return this.sql.exec('SELECT 1 FROM memo_files WHERE name = ?', name).toArray().length > 0;
  }

  /**
   * Aufräumen: Anhänge, die vor über einem Tag hochgeladen, aber nie
   * abgeschickt wurden. Liefert die Namen (in R2 löschen).
   */
  sweepFiles(): string[] {
    const old = this.sql.exec('SELECT name FROM memo_files WHERE created < ?', Date.now() - ORPHAN_AFTER).toArray().map(r => r.name as string);
    return this.dropUnused(old);
  }

  private dropUnused(names: string[]): string[] {
    const gone: string[] = [];
    for (const name of names) {
      const used = this.sql.exec("SELECT 1 FROM memos WHERE instr(text, ?) > 0 LIMIT 1", `/m/${name}`).toArray().length > 0;
      if (used) continue;
      this.sql.exec('DELETE FROM memo_files WHERE name = ?', name);
      gone.push(name);
    }
    return gone;
  }

  getMemo(id: string): Memo | null {
    return this.memo(id);
  }

  private memo(id: string): Memo | null {
    const r = this.sql.exec('SELECT * FROM memos WHERE id = ?', id).toArray();
    return r.length ? memoRow(r[0]) : null;
  }

  /** Konto löschen: Liste, Memos und Profil weg (die Tabellen bleiben, das Objekt lebt weiter). */
  destroy() {
    this.sql.exec('DELETE FROM memos');
    this.sql.exec('DELETE FROM memo_files');
    this.sql.exec('DELETE FROM docs');
    this.sql.exec('DELETE FROM profile');
  }

  private write(d: AccountDoc) {
    this.sql.exec(
      `INSERT INTO docs (id, title, edit_key, opened, tags, owner_key, trashed) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET title = excluded.title, edit_key = excluded.edit_key, opened = excluded.opened,
         tags = excluded.tags, owner_key = excluded.owner_key, trashed = excluded.trashed`,
      d.id, d.title, d.editKey, d.opened, JSON.stringify(d.tags), d.ownerKey, d.trashed || 0,
    );
  }
}

function memoRow(r: Record<string, SqlStorageValue>): Memo {
  return { id: r.id as string, text: r.text as string, created: r.created as number, updated: r.updated as number };
}

function row(r: Record<string, SqlStorageValue>): AccountDoc {
  let tags: string[] = [];
  try { tags = JSON.parse(r.tags as string); } catch { /* leer */ }
  return {
    id: r.id as string, title: r.title as string, editKey: (r.edit_key as string) || null, opened: r.opened as number, tags,
    ownerKey: (r.owner_key as string) || null, trashed: (r.trashed as number) || 0,
  };
}
