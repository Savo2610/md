// WebSocket-Verbindung zum Dokument (y-websocket-Protokoll).
// Bündelt eigene Änderungen kurz (150 ms), damit nicht jeder Tastendruck
// eine eigene Nachricht und eine eigene Datenbankzeile wird.

import * as Y from 'yjs';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import * as syncProtocol from 'y-protocols/sync';
import * as awarenessProtocol from 'y-protocols/awareness';

const MSG_SYNC = 0;
const MSG_AWARENESS = 1;
const MSG_QUERY_AWARENESS = 3;
const MSG_NOTICE = 9;

export type Status = 'connecting' | 'online' | 'offline' | 'gone';

export interface ProviderEvents {
  status(s: Status): void;
  synced(): void;
  notice(n: { type: string; edit?: boolean; to?: string }): void;
  pending(p: boolean): void;
}

export class Provider {
  ws: WebSocket | null = null;
  status: Status = 'offline';
  synced = false;
  private pending: Uint8Array[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private retry = 0;
  /** Bis connect() aufgerufen wird, nicht verbinden (Dokument existiert evtl. noch nicht). */
  private stopped = true;

  constructor(
    readonly doc: Y.Doc,
    readonly awareness: awarenessProtocol.Awareness,
    private url: () => string,
    private on: ProviderEvents,
  ) {
    doc.on('update', (update: Uint8Array, origin: unknown) => {
      if (origin === this) return;
      this.pending.push(update);
      this.on.pending(true);
      if (!this.timer) this.timer = setTimeout(() => this.flush(), 150);
    });
    awareness.on('update', ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
      if (origin !== 'local') return;
      const changed = added.concat(updated, removed);
      this.send(MSG_AWARENESS, enc => encoding.writeVarUint8Array(enc, awarenessProtocol.encodeAwarenessUpdate(awareness, changed)));
    });
    window.addEventListener('pagehide', () => {
      awarenessProtocol.removeAwarenessStates(awareness, [doc.clientID], 'local');
      this.flush();
    });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && this.status === 'offline' && !this.stopped) this.connect();
    });
  }

  connect() {
    this.stopped = false;
    if (this.ws && this.ws.readyState <= 1) return;
    this.setStatus('connecting');
    const ws = new WebSocket(this.url());
    ws.binaryType = 'arraybuffer';
    this.ws = ws;

    ws.onopen = () => {
      this.retry = 0;
      this.setStatus('online');
      this.send(MSG_SYNC, enc => syncProtocol.writeSyncStep1(enc, this.doc));
      if (this.awareness.getLocalState()) {
        this.send(MSG_AWARENESS, enc =>
          encoding.writeVarUint8Array(enc, awarenessProtocol.encodeAwarenessUpdate(this.awareness, [this.doc.clientID])));
      }
    };

    ws.onmessage = ev => {
      const dec = decoding.createDecoder(new Uint8Array(ev.data as ArrayBuffer));
      const type = decoding.readVarUint(dec);
      if (type === MSG_SYNC) {
        const enc = encoding.createEncoder();
        encoding.writeVarUint(enc, MSG_SYNC);
        const sub = syncProtocol.readSyncMessage(dec, enc, this.doc, this);
        if (encoding.length(enc) > 1) ws.send(encoding.toUint8Array(enc));
        if (sub === syncProtocol.messageYjsSyncStep2 && !this.synced) {
          this.synced = true;
          // Was offline aufgelaufen ist, ging meist schon mit Sync-Schritt 2
          // raus. Doppelt schicken schadet bei Yjs nicht, verlieren schon.
          this.flush();
          this.on.pending(false);
          this.on.synced();
        }
      } else if (type === MSG_AWARENESS) {
        awarenessProtocol.applyAwarenessUpdate(this.awareness, decoding.readVarUint8Array(dec), this);
      } else if (type === MSG_QUERY_AWARENESS) {
        if (this.awareness.getLocalState()) {
          this.send(MSG_AWARENESS, enc =>
            encoding.writeVarUint8Array(enc, awarenessProtocol.encodeAwarenessUpdate(this.awareness, [this.doc.clientID])));
        }
      } else if (type === MSG_NOTICE) {
        try { this.on.notice(JSON.parse(decoding.readVarString(dec))); } catch { /* ignorieren */ }
      }
    };

    ws.onclose = ev => {
      this.ws = null;
      this.synced = false;
      // Cursor der anderen entfernen, die kommen beim Wiederverbinden neu.
      const others = [...this.awareness.getStates().keys()].filter(id => id !== this.doc.clientID);
      awarenessProtocol.removeAwarenessStates(this.awareness, others, this);
      if (ev.code === 4404) { this.setStatus('gone'); return; }
      if (ev.code === 4301) { this.setStatus('gone'); this.on.notice({ type: 'moved', to: ev.reason }); return; }
      this.setStatus('offline');
      if (this.stopped) return;
      const delay = Math.min(30_000, 500 * 2 ** this.retry++);
      setTimeout(() => { if (!this.stopped && document.visibilityState === 'visible') this.connect(); }, delay);
    };
  }

  disconnect() {
    this.stopped = true;
    this.flush();
    this.ws?.close();
  }

  private flush() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (!this.pending.length || !this.ws || this.ws.readyState !== 1 || !this.synced) return;
    const update = Y.mergeUpdates(this.pending);
    this.pending = [];
    this.send(MSG_SYNC, enc => syncProtocol.writeUpdate(enc, update));
    this.on.pending(false);
  }

  private send(type: number, write: (enc: encoding.Encoder) => void) {
    if (!this.ws || this.ws.readyState !== 1) return;
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, type);
    write(enc);
    this.ws.send(encoding.toUint8Array(enc));
  }

  private setStatus(s: Status) {
    this.status = s;
    this.on.status(s);
  }
}
