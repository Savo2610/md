// Registry: genau eine Instanz ("main").
//
//  - Übersicht aller Dokumente für die Admin-Seite (Titel, Anfang des Texts,
//    Größe, Zeitstempel). Die Dokumente selbst liegen in ihren Doc-Objekten;
//    hier steht nur, was man zum Aufräumen braucht.
//  - Schutz der 2FA-Freischaltung: Fehlversuche pro IP und insgesamt, und
//    bereits benutzte Codes (jeder Code gilt nur einmal).
//  - Memos, die der Admin per API vorbereitet hat (Umzug aus einer anderen
//    App). Sie wandern beim nächsten Öffnen von /memos ins Admin-Konto.
//  - Tageskontingent für Dokumente, die Agenten ohne API-Schlüssel anlegen.

import { DurableObject } from 'cloudflare:workers';
import type { Env } from './env';

export interface DocSummary {
  id: string;
  title: string;
  snippet: string;
  created: number;
  updated: number;
  size: number;
  images: number;
  pinned: boolean;
  /** Im Papierkorb seit (ms), sonst 0. */
  trashed: number;
  /** Von einem Agenten ohne API-Schlüssel angelegt. */
  agent?: boolean;
}

const HOUR = 3600_000;
const MAX_FAILS_PER_IP = 5;
const MAX_FAILS_TOTAL = 30;
/** Anlegen ohne API-Schlüssel: pro IP und insgesamt in 24 Stunden. */
export const AGENT_PER_IP = 20;
const AGENT_TOTAL = 300;

export class Registry extends DurableObject<Env> {
  sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS docs (
        id TEXT PRIMARY KEY, title TEXT, snippet TEXT,
        created INTEGER, updated INTEGER, size INTEGER, images INTEGER, pinned INTEGER
      );
      CREATE INDEX IF NOT EXISTS docs_updated ON docs(updated);
      CREATE TABLE IF NOT EXISTS fails (ip TEXT, at INTEGER);
      CREATE TABLE IF NOT EXISTS used_codes (counter INTEGER PRIMARY KEY, expires INTEGER);
      CREATE TABLE IF NOT EXISTS memo_import (id TEXT PRIMARY KEY, text TEXT NOT NULL, created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS agent_creates (ip TEXT, at INTEGER);
    `);
    // Spalte kam später dazu (Papierkorb).
    try { this.sql.exec('ALTER TABLE docs ADD COLUMN trashed INTEGER NOT NULL DEFAULT 0'); } catch { /* gibt es schon */ }
    try { this.sql.exec('ALTER TABLE docs ADD COLUMN agent INTEGER NOT NULL DEFAULT 0'); } catch { /* gibt es schon */ }
  }

  upsert(d: DocSummary) {
    this.sql.exec(
      `INSERT INTO docs (id, title, snippet, created, updated, size, images, pinned, trashed, agent) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET title = excluded.title, snippet = excluded.snippet, updated = excluded.updated,
         size = excluded.size, images = excluded.images, pinned = excluded.pinned, trashed = excluded.trashed, agent = excluded.agent`,
      d.id, d.title, d.snippet, d.created, d.updated, d.size, d.images, d.pinned ? 1 : 0, d.trashed || 0, d.agent ? 1 : 0,
    );
  }

  remove(id: string) {
    this.sql.exec('DELETE FROM docs WHERE id = ?', id);
  }

  list(query = '', limit = 200): { docs: DocSummary[]; total: number; bytes: number } {
    const q = `%${query.toLowerCase()}%`;
    const rows = this.sql.exec(
      `SELECT * FROM docs WHERE ? = '%%' OR lower(id) LIKE ? OR lower(title) LIKE ? OR lower(snippet) LIKE ?
       ORDER BY updated DESC LIMIT ?`,
      q, q, q, q, limit,
    ).toArray();
    const agg = this.sql.exec('SELECT COUNT(*) AS n, COALESCE(SUM(size), 0) + COALESCE(SUM(images), 0) AS b FROM docs').one();
    return {
      docs: rows.map(r => ({
        id: r.id as string, title: r.title as string, snippet: r.snippet as string,
        created: r.created as number, updated: r.updated as number,
        size: r.size as number, images: r.images as number, pinned: !!r.pinned,
        trashed: (r.trashed as number) || 0, agent: !!r.agent,
      })),
      total: agg.n as number,
      bytes: agg.b as number,
    };
  }

  // ── 2FA-Schutz ────────────────────────────────────────────────────────────

  /** Darf diese IP gerade einen Code probieren? */
  unlockAllowed(ip: string): boolean {
    const since = Date.now() - HOUR;
    this.sql.exec('DELETE FROM fails WHERE at < ?', since);
    const mine = this.sql.exec('SELECT COUNT(*) AS n FROM fails WHERE ip = ?', ip).one().n as number;
    const all = this.sql.exec('SELECT COUNT(*) AS n FROM fails').one().n as number;
    return mine < MAX_FAILS_PER_IP && all < MAX_FAILS_TOTAL;
  }

  recordFail(ip: string) {
    this.sql.exec('INSERT INTO fails (ip, at) VALUES (?, ?)', ip, Date.now());
  }

  /** Markiert ein Zeitfenster als verbraucht. false, wenn es schon benutzt wurde. */
  useCode(counter: number): boolean {
    this.sql.exec('DELETE FROM used_codes WHERE expires < ?', Date.now());
    const hit = this.sql.exec('SELECT 1 FROM used_codes WHERE counter = ?', counter).toArray();
    if (hit.length) return false;
    this.sql.exec('INSERT INTO used_codes (counter, expires) VALUES (?, ?)', counter, Date.now() + 3 * 60_000);
    return true;
  }

  // ── Agenten ohne API-Schlüssel ────────────────────────────────────────────

  /** Bucht ein Dokument aus dem Tageskontingent. false, wenn es aufgebraucht ist. */
  agentCreate(ip: string): boolean {
    this.sql.exec('DELETE FROM agent_creates WHERE at < ?', Date.now() - 24 * HOUR);
    const mine = this.sql.exec('SELECT COUNT(*) AS n FROM agent_creates WHERE ip = ?', ip).one().n as number;
    const all = this.sql.exec('SELECT COUNT(*) AS n FROM agent_creates').one().n as number;
    if (mine >= AGENT_PER_IP || all >= AGENT_TOTAL) return false;
    this.sql.exec('INSERT INTO agent_creates (ip, at) VALUES (?, ?)', ip, Date.now());
    return true;
  }

  // ── Memos-Umzug ───────────────────────────────────────────────────────────

  queueMemos(items: { id: string; text: string; created: number }[]): number {
    for (const m of items) {
      this.sql.exec('INSERT INTO memo_import (id, text, created) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET text = excluded.text, created = excluded.created', m.id, m.text, m.created);
    }
    return this.sql.exec('SELECT COUNT(*) AS n FROM memo_import').one().n as number;
  }

  /** Vorbereitete Memos; erst nach dem Übernehmen mit doneMemos() wegräumen. */
  pendingMemos(): { id: string; text: string; created: number }[] {
    return this.sql.exec('SELECT * FROM memo_import ORDER BY created').toArray()
      .map(r => ({ id: r.id as string, text: r.text as string, created: r.created as number }));
  }

  doneMemos(ids: string[]) {
    for (const id of ids) this.sql.exec('DELETE FROM memo_import WHERE id = ?', id);
  }
}
