// Ein Durable Object pro angemeldetem Konto (Name: "g:<Google-sub>").
//
// Merkt sich, welche Dokumente zu diesem Konto gehören: Titel, zuletzt
// geöffnet, Bearbeitungsschlüssel (falls vorhanden) und die eigenen Tags.
// Die Dokumente selbst liegen weiter in ihren Doc-Objekten; Tags sind
// persönlich und tauchen im Dokument nicht auf.

import { DurableObject } from 'cloudflare:workers';
import type { Env } from './env';

export interface AccountDoc {
  id: string;
  title: string;
  editKey: string | null;
  opened: number;
  tags: string[];
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
    `);
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

  remove(id: string) {
    this.sql.exec('DELETE FROM docs WHERE id = ?', id);
  }

  /** Dokument hat eine neue Adresse: Eintrag samt Tags mitnehmen. */
  rename(from: string, to: string) {
    const old = this.get(from);
    if (!old) return;
    this.sql.exec('DELETE FROM docs WHERE id = ?', from);
    const existing = this.get(to);
    this.write({ ...old, id: to, editKey: old.editKey || existing?.editKey || null, tags: old.tags.length ? old.tags : existing?.tags || [] });
  }

  /** Konto löschen: Liste und Profil weg (die Tabellen bleiben, das Objekt lebt weiter). */
  destroy() {
    this.sql.exec('DELETE FROM docs');
    this.sql.exec('DELETE FROM profile');
  }

  private write(d: AccountDoc) {
    this.sql.exec(
      `INSERT INTO docs (id, title, edit_key, opened, tags) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET title = excluded.title, edit_key = excluded.edit_key, opened = excluded.opened, tags = excluded.tags`,
      d.id, d.title, d.editKey, d.opened, JSON.stringify(d.tags),
    );
  }
}

function row(r: Record<string, SqlStorageValue>): AccountDoc {
  let tags: string[] = [];
  try { tags = JSON.parse(r.tags as string); } catch { /* leer */ }
  return { id: r.id as string, title: r.title as string, editKey: (r.edit_key as string) || null, opened: r.opened as number, tags };
}
