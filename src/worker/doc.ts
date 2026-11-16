// Ein Durable Object pro Dokument.
//
// Speicher (SQLite im Objekt):
//   meta     Schlüssel/Wert: id, created, updated, accessed, editKey, ownerKey,
//            pinned, imageBytes, markdown (letzter Stand als Text), title,
//            flushedSeq, trashed (Zeitpunkt, wenn im Papierkorb),
//            kind ('board' für Whiteboards, sonst leer: Markdown)
//
// Whiteboards (src/shared/board.ts) liegen im selben Objekt, nur mit anderen
// Yjs-Typen. Der Schnappschuss `markdown` ist dann aus dem Board erzeugt,
// damit Titel, Übersicht und /<id>.md wie bei Dokumenten funktionieren.
//
// Papierkorb: Wer das Dokument angelegt hat (ownerKey), kann es löschen. Es
// ist dann sofort für alle weg, bleibt aber TRASH_DAYS lang erhalten und
// lässt sich wiederherstellen; danach löscht der Alarm es samt Bildern.
//   updates  Yjs-Änderungen, eine Zeile pro Nachricht. Werden regelmäßig zu
//            einer einzigen Zeile zusammengefasst.
//
// Solange niemand ein Dokument anlegt, wird nichts gespeichert: Wer nur eine
// URL aufruft, erzeugt keine Daten. Die Tabellen entstehen erst in create().
//
// Gemeinsames Bearbeiten läuft über WebSockets mit dem y-websocket-Protokoll
// (Sync + Awareness). Die Sockets nutzen die Hibernation-API: Ist es still,
// wird das Objekt aus dem Speicher geräumt und kostet nichts, die
// Verbindungen bleiben trotzdem offen.

import { DurableObject } from 'cloudflare:workers';
import * as Y from 'yjs';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import * as syncProtocol from 'y-protocols/sync';
import { titleOf } from '../shared/render';
import { boardMarkdown, MAX_ITEMS } from '../shared/board';
import { isRandomId, randomToken, timingSafeEqual } from './crypto';
import { registry, type Env } from './env';

export const MSG_SYNC = 0;
export const MSG_AWARENESS = 1;
export const MSG_QUERY_AWARENESS = 3;
export const MSG_NOTICE = 9;

const DAY = 24 * 3600_000;
/** Nicht angepinnte Dokumente verschwinden nach so langer Zeit ohne Aufruf. */
export const EXPIRE_AFTER = 365 * DAY;
/** So lange bleibt ein gelöschtes Dokument im Papierkorb. */
export const TRASH_FOR = 30 * DAY;
const FLUSH_DELAY = 4000;
const COMPACT_AFTER = 200;
export const MAX_CHARS = 1_000_000;
const MAX_MESSAGE = 4 * 1024 * 1024;
export const MAX_IMAGE_BYTES = 25 * 1024 * 1024;

interface Attachment {
  edit: boolean;
  /** Awareness-Client-IDs dieses Sockets → letzte Uhr. Zum Aufräumen beim Schließen. */
  aw: Record<string, number>;
}

export type DocKind = 'md' | 'board';

export interface DocInfo {
  exists: boolean;
  kind?: DocKind;
  markdown: string;
  title: string;
  updated: number;
  pinned: boolean;
  movedTo?: string;
  /** Im Papierkorb seit (ms). Dann sind markdown und title leer. */
  trashed?: number;
}

export interface MoveData {
  markdown: string;
  editKey: string;
  ownerKey: string | null;
  created: number;
  pinned: boolean;
  imageBytes: number;
  imgPrefix: string;
  kind?: DocKind;
  /** Boards: kompletter Yjs-Stand (Markdown wäre verlustbehaftet). */
  state?: Uint8Array;
}

const bytes = (u: Uint8Array) => u.slice().buffer;

export class Doc extends DurableObject<Env> {
  sql: SqlStorage;
  ydoc: Y.Doc | null = null;
  flushPending = false;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
  }

  // ── Grundlagen ────────────────────────────────────────────────────────────

  exists(): boolean {
    return this.sql.exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'meta'").toArray().length > 0;
  }

  private get(k: string): string | null {
    const r = this.sql.exec('SELECT v FROM meta WHERE k = ?', k).toArray();
    return r.length ? (r[0].v as string) : null;
  }

  private set(k: string, v: string | number) {
    this.sql.exec('INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v', k, String(v));
  }

  private num(k: string): number {
    return Number(this.get(k) || 0);
  }

  private maxSeq(): number {
    return (this.sql.exec('SELECT COALESCE(MAX(id), 0) AS m FROM updates').one().m as number) || 0;
  }

  private load(): Y.Doc {
    if (this.ydoc) return this.ydoc;
    const doc = new Y.Doc({ gc: true });
    const rows = this.sql.exec('SELECT data FROM updates ORDER BY id').toArray();
    if (rows.length) {
      Y.applyUpdate(doc, Y.mergeUpdates(rows.map(r => new Uint8Array(r.data as ArrayBuffer))));
    }
    doc.on('update', (update: Uint8Array, origin: unknown) => this.onUpdate(update, origin));
    this.ydoc = doc;
    return doc;
  }

  private text(): Y.Text {
    return this.load().getText('md');
  }

  private kind(): DocKind {
    return this.get('kind') === 'board' ? 'board' : 'md';
  }

  /** Text bzw. aus dem Board erzeugtes Markdown. */
  private current(doc: Y.Doc): string {
    return this.kind() === 'board' ? boardMarkdown(doc) : doc.getText('md').toString();
  }

  /** Aktueller Text, ohne das Yjs-Dokument zu laden, wenn der Schnappschuss aktuell ist. */
  private markdown(): string {
    if (this.ydoc || this.maxSeq() !== this.num('flushedSeq')) return this.current(this.load());
    return this.get('markdown') || '';
  }

  /** Existiert, ist nicht umgezogen und nicht im Papierkorb. */
  live(): boolean {
    return this.exists() && !this.get('movedTo') && !this.get('trashed');
  }

  /** Existiert und ist nicht umgezogen (auch im Papierkorb). */
  private present(): boolean {
    return this.exists() && !this.get('movedTo');
  }

  /** Präfix der Bilder in R2. Bleibt beim Umbenennen gleich, damit Bild-Links weiter stimmen. */
  private imagePrefix(): string {
    return this.get('imgPrefix') || this.get('id')!;
  }

  // ── Öffentliche Methoden (RPC aus dem Worker) ─────────────────────────────

  async info(touch = false): Promise<DocInfo> {
    const none = { exists: false, markdown: '', title: '', updated: 0, pinned: false };
    if (!this.exists()) return none;
    if (touch) await this.touch();
    const movedTo = this.get('movedTo');
    if (movedTo) return { ...none, movedTo };
    const trashed = this.num('trashed');
    if (trashed) return { ...none, exists: true, trashed };
    const markdown = this.markdown();
    return {
      exists: true,
      kind: this.kind(),
      markdown,
      title: titleOf(markdown),
      updated: this.num('updated'),
      pinned: this.get('pinned') === '1',
    };
  }

  /**
   * Legt das Dokument an. `from` übernimmt Schlüssel, Bilder und Metadaten
   * eines umbenannten Dokuments.
   */
  async create(id: string, initial = '', from?: MoveData, kind: DocKind = 'md'): Promise<string | null> {
    if (this.exists()) return null;
    this.sql.exec(`
      CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT);
      CREATE TABLE updates (id INTEGER PRIMARY KEY AUTOINCREMENT, data BLOB);
    `);
    const now = Date.now();
    const editKey = from?.editKey ?? randomToken(18);
    const ownerKey = from ? from.ownerKey : randomToken(18);
    const meta = {
      id, created: from?.created ?? now, updated: now, accessed: now, editKey, ...(ownerKey ? { ownerKey } : {}),
      pinned: from?.pinned ? 1 : 0, imageBytes: from?.imageBytes ?? 0, imgPrefix: from?.imgPrefix ?? id,
      flushedSeq: 0, markdown: '',
      ...((from?.kind ?? kind) === 'board' ? { kind: 'board' } : {}),
    };
    for (const [k, v] of Object.entries(meta)) this.set(k, v);
    if (from?.state) Y.applyUpdate(this.load(), from.state);
    else if (this.kind() === 'md' && (from?.markdown || initial)) this.text().insert(0, (from?.markdown ?? initial).slice(0, MAX_CHARS));
    await this.flush(true);
    await this.scheduleAlarm();
    return editKey;
  }

  /** Besitzer-Schlüssel (nur direkt nach create() an den Ersteller). */
  ownerKey(): string | null {
    return this.present() ? this.get('ownerKey') : null;
  }

  /** Ist das der Schlüssel des Erstellers? Gilt auch im Papierkorb. */
  checkOwner(key: string | null): boolean {
    const own = this.present() ? this.get('ownerKey') : null;
    return !!key && !!own && timingSafeEqual(key, own);
  }

  /** Nur nach geprüfter 2FA: Besitzer-Schlüssel, bei alten Dokumenten neu angelegt. */
  ensureOwnerKey(): string | null {
    if (!this.live()) return null;
    let key = this.get('ownerKey');
    if (!key) { key = randomToken(18); this.set('ownerKey', key); }
    return key;
  }

  // ── Papierkorb ────────────────────────────────────────────────────────────

  /** Inhalt auch im Papierkorb (nur nach geprüftem Besitzer bzw. Admin). */
  peek(): { markdown: string; title: string; trashed: number } | null {
    if (!this.present()) return null;
    const markdown = this.markdown();
    return { markdown, title: titleOf(markdown), trashed: this.num('trashed') };
  }

  async trash(): Promise<number | null> {
    if (!this.live()) return null;
    await this.flush(true);
    const at = Date.now();
    this.set('trashed', at);
    this.ydoc?.destroy();
    this.ydoc = null;
    for (const ws of this.ctx.getWebSockets()) {
      try { ws.close(4410, 'Im Papierkorb'); } catch { /* schon zu */ }
    }
    await this.report();
    await this.scheduleAlarm();
    return at;
  }

  async restore(): Promise<boolean> {
    if (!this.present() || !this.get('trashed')) return false;
    this.sql.exec("DELETE FROM meta WHERE k = 'trashed'");
    this.set('accessed', Date.now());
    await this.report();
    await this.scheduleAlarm();
    return true;
  }

  checkKey(key: string | null): boolean {
    return !!key && this.live() && timingSafeEqual(key, this.get('editKey'));
  }

  /** Nur nach geprüfter 2FA aufrufen. Schaltet genau dieses Dokument frei. */
  getEditKey(): string | null {
    return this.live() ? this.get('editKey') : null;
  }

  async setPinned(pinned: boolean) {
    if (!this.live()) return;
    this.set('pinned', pinned ? 1 : 0);
    await this.report();
    await this.scheduleAlarm();
  }

  async replace(markdown: string): Promise<boolean> {
    if (!this.live() || this.kind() === 'board') return false;
    const t = this.text();
    this.load().transact(() => {
      t.delete(0, t.length);
      t.insert(0, markdown.slice(0, MAX_CHARS));
    }, 'api');
    await this.flush(true);
    return true;
  }

  /** Bucht Speicher für ein Bild und gibt den R2-Präfix zurück; null, wenn voll. */
  async reserveImage(size: number): Promise<string | null> {
    if (!this.live()) return null;
    const used = this.num('imageBytes');
    if (used + size > MAX_IMAGE_BYTES) return null;
    this.set('imageBytes', used + size);
    this.scheduleFlush();
    return this.imagePrefix();
  }

  // ── Umbenennen ────────────────────────────────────────────────────────────

  /** Alles, was das neue Dokument braucht. */
  moveData(): MoveData | null {
    if (!this.live()) return null;
    return {
      markdown: this.markdown(),
      editKey: this.get('editKey')!,
      ownerKey: this.get('ownerKey'),
      created: this.num('created'),
      pinned: this.get('pinned') === '1',
      imageBytes: this.num('imageBytes'),
      imgPrefix: this.imagePrefix(),
      kind: this.kind(),
      ...(this.kind() === 'board' ? { state: Y.encodeStateAsUpdate(this.load()) } : {}),
    };
  }

  /**
   * Nach dem Umbenennen. War die alte Adresse zufällig erzeugt, wird sie zur
   * Weiterleitung, damit schon geteilte Links weiter funktionieren (nach
   * 12 Monaten ohne Aufruf verschwindet auch die). Selbst gewählte Namen
   * werden einfach wieder frei – so lassen sich keine Alias-Ketten anlegen.
   * Die Bilder gehören in beiden Fällen jetzt dem neuen Dokument.
   */
  async moveTo(to: string) {
    if (!this.live()) return;
    const id = this.get('id')!;
    this.ydoc?.destroy();
    this.ydoc = null;
    this.flushPending = false;
    for (const ws of this.ctx.getWebSockets()) {
      try { ws.close(4301, to); } catch { /* schon zu */ }
    }
    await registry(this.env).remove(id);
    if (!isRandomId(id)) {
      await this.ctx.storage.deleteAlarm();
      await this.ctx.storage.deleteAll();
      return;
    }
    this.sql.exec('DELETE FROM updates');
    this.sql.exec("DELETE FROM meta WHERE k NOT IN ('id', 'created', 'accessed')");
    this.set('movedTo', to);
    this.set('accessed', Date.now());
    await this.scheduleAlarm();
  }

  async destroy(): Promise<void> {
    const live = this.present();
    const id = this.exists() ? this.get('id') : null;
    const prefix = live ? this.imagePrefix() : null;
    for (const ws of this.ctx.getWebSockets()) {
      try { ws.close(4404, 'Dokument gelöscht'); } catch { /* schon zu */ }
    }
    if (prefix) {
      let cursor: string | undefined;
      do {
        const list = await this.env.IMAGES.list({ prefix: `${prefix}/`, cursor });
        if (list.objects.length) await this.env.IMAGES.delete(list.objects.map(o => o.key));
        cursor = list.truncated ? list.cursor : undefined;
      } while (cursor);
    }
    if (id && live) await registry(this.env).remove(id);
    this.ydoc?.destroy();
    this.ydoc = null;
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }

  // ── Speichern, Zusammenfassen, Ablauf ─────────────────────────────────────

  private onUpdate(update: Uint8Array, origin: unknown) {
    this.sql.exec('INSERT INTO updates (data) VALUES (?)', bytes(update));
    const msg = encoding.createEncoder();
    encoding.writeVarUint(msg, MSG_SYNC);
    syncProtocol.writeUpdate(msg, update);
    this.broadcast(encoding.toUint8Array(msg), origin);
    this.scheduleFlush();
  }

  private scheduleFlush() {
    if (this.flushPending) return;
    this.flushPending = true;
    this.ctx.storage.setAlarm(Date.now() + FLUSH_DELAY);
  }

  /** Schreibt Text-Schnappschuss und Übersicht, fasst Updates zusammen. */
  private async flush(force = false) {
    if (!this.live()) return;
    const seq = this.maxSeq();
    if (!force && seq === this.num('flushedSeq') && !this.flushPending) return;
    this.flushPending = false;
    const doc = this.load();
    const markdown = this.current(doc);
    let flushed = seq;
    const count = this.sql.exec('SELECT COUNT(*) AS n FROM updates').one().n as number;
    if (count > COMPACT_AFTER) {
      const merged = Y.encodeStateAsUpdate(doc);
      this.sql.exec('DELETE FROM updates');
      this.sql.exec('INSERT INTO updates (data) VALUES (?)', bytes(merged));
      flushed = this.maxSeq();
    }
    if (markdown !== this.get('markdown')) {
      this.set('markdown', markdown);
      this.set('updated', Date.now());
    }
    this.set('flushedSeq', flushed);
    await this.report(markdown);
  }

  private async report(markdown = this.markdown()) {
    const body = markdown.replace(/^---\n[\s\S]*?\n---\n?/, '');
    await registry(this.env).upsert({
      id: this.get('id')!,
      title: titleOf(markdown),
      snippet: body.replace(/\s+/g, ' ').trim().slice(0, 240),
      created: this.num('created'),
      updated: this.num('updated'),
      size: new TextEncoder().encode(markdown).length,
      images: this.num('imageBytes'),
      pinned: this.get('pinned') === '1',
      trashed: this.num('trashed'),
    });
  }

  /** Merkt sich den letzten Aufruf (höchstens einmal am Tag ein Schreibzugriff). */
  private async touch() {
    if (Date.now() - this.num('accessed') < DAY) return;
    this.set('accessed', Date.now());
    if (!this.flushPending) await this.scheduleAlarm();
  }

  private async scheduleAlarm() {
    if (this.flushPending) return;
    const trashed = this.num('trashed');
    if (trashed) { await this.ctx.storage.setAlarm(trashed + TRASH_FOR); return; }
    if (this.get('pinned') === '1') await this.ctx.storage.deleteAlarm();
    else await this.ctx.storage.setAlarm(this.num('accessed') + EXPIRE_AFTER);
  }

  async alarm() {
    if (!this.exists()) return;
    const trashed = this.num('trashed');
    if (trashed) {
      if (Date.now() >= trashed + TRASH_FOR) await this.destroy();
      else await this.scheduleAlarm();
      return;
    }
    if (this.get('pinned') !== '1' && Date.now() - this.num('accessed') >= EXPIRE_AFTER) {
      // Löscht auch Weiterleitungen umbenannter Dokumente (ohne deren Bilder).
      await this.destroy();
      return;
    }
    this.flushPending = true;
    await this.flush();
    await this.scheduleAlarm();
  }

  // ── WebSockets ────────────────────────────────────────────────────────────

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade') !== 'websocket') return new Response('Erwartet WebSocket', { status: 426 });
    if (!this.exists()) return new Response('Nicht gefunden', { status: 404 });

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    const movedTo = this.get('movedTo');
    if (movedTo || this.get('trashed')) {
      server.accept();
      if (movedTo) server.close(4301, movedTo);
      else server.close(4410, 'Im Papierkorb');
      return new Response(null, { status: 101, webSocket: client });
    }

    const edit = this.checkKey(request.headers.get('X-Md-Key'));
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ edit, aw: {} } satisfies Attachment);

    // Zuerst: Rolle mitteilen, dann Sync-Schritt 1 (der Client schickt, was uns fehlt).
    server.send(notice({ type: 'hello', edit }));
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MSG_SYNC);
    syncProtocol.writeSyncStep1(enc, this.load());
    server.send(encoding.toUint8Array(enc));

    // Die anderen sollen ihre Cursor neu senden, damit der Neue sie sieht.
    const q = encoding.createEncoder();
    encoding.writeVarUint(q, MSG_QUERY_AWARENESS);
    this.broadcast(encoding.toUint8Array(q), server);

    await this.touch();
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: ArrayBuffer | string) {
    if (typeof message === 'string') return;
    if (message.byteLength > MAX_MESSAGE) { ws.close(1009, 'Nachricht zu groß'); return; }
    const att = ws.deserializeAttachment() as Attachment;
    const data = new Uint8Array(message);
    const dec = decoding.createDecoder(data);
    const type = decoding.readVarUint(dec);

    if (type === MSG_SYNC) {
      const sub = decoding.readVarUint(dec);
      if (sub === syncProtocol.messageYjsSyncStep1) {
        const sv = decoding.readVarUint8Array(dec);
        const enc = encoding.createEncoder();
        encoding.writeVarUint(enc, MSG_SYNC);
        syncProtocol.writeSyncStep2(enc, this.load(), sv);
        ws.send(encoding.toUint8Array(enc));
      } else {
        const update = decoding.readVarUint8Array(dec);
        if (!att.edit) { ws.send(notice({ type: 'readonly' })); return; }
        if (this.full()) { ws.send(notice({ type: 'limit' })); return; }
        Y.applyUpdate(this.load(), update, ws);
      }
      return;
    }

    if (type === MSG_AWARENESS) {
      // Nur mitschreiben, welche Client-IDs zu diesem Socket gehören, und weiterreichen.
      try {
        const inner = decoding.createDecoder(decoding.readVarUint8Array(dec));
        const n = decoding.readVarUint(inner);
        for (let i = 0; i < n; i++) {
          const id = decoding.readVarUint(inner);
          const clock = decoding.readVarUint(inner);
          const state = decoding.readVarString(inner);
          if (state === 'null') delete att.aw[id];
          else att.aw[id] = clock;
        }
        ws.serializeAttachment(att);
      } catch { return; }
      this.broadcast(data, ws);
      return;
    }

    if (type === MSG_QUERY_AWARENESS) this.broadcast(data, ws);
  }

  /** Maximalgröße erreicht: Text zu lang bzw. zu viele Elemente auf dem Board. */
  private full(): boolean {
    if (this.kind() === 'board') return this.load().getMap('items').size > MAX_ITEMS;
    return this.text().length > MAX_CHARS;
  }

  async webSocketClose(ws: WebSocket, code: number) {
    this.dropAwareness(ws);
    try { ws.close(code === 1005 ? 1000 : code, 'bye'); } catch { /* schon zu */ }
  }

  async webSocketError(ws: WebSocket) {
    this.dropAwareness(ws);
  }

  /** Meldet den anderen, dass die Cursor dieses Sockets weg sind. */
  private dropAwareness(ws: WebSocket) {
    const att = ws.deserializeAttachment() as Attachment | null;
    const ids = Object.entries(att?.aw || {});
    if (!ids.length) return;
    const inner = encoding.createEncoder();
    encoding.writeVarUint(inner, ids.length);
    for (const [id, clock] of ids) {
      encoding.writeVarUint(inner, Number(id));
      encoding.writeVarUint(inner, clock + 1);
      encoding.writeVarString(inner, 'null');
    }
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MSG_AWARENESS);
    encoding.writeVarUint8Array(enc, encoding.toUint8Array(inner));
    this.broadcast(encoding.toUint8Array(enc), ws);
  }

  private broadcast(data: Uint8Array, except?: unknown) {
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === except) continue;
      try { ws.send(data); } catch { /* Verbindung schon weg */ }
    }
  }
}

function notice(payload: object): Uint8Array {
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, MSG_NOTICE);
  encoding.writeVarString(enc, JSON.stringify(payload));
  return encoding.toUint8Array(enc);
}
