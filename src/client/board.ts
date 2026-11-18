// Whiteboard: unendliche Fläche mit Notizen, Bereichen, Formen, Pfeilen,
// Text, Stift und Bildern. Gemeinsam über dasselbe Yjs/WebSocket wie die
// Dokumente (Datenmodell in src/shared/board.ts).
//
// Darstellung: DOM in einer Ebene mit CSS-Transformation (Verschieben und
// Zoomen), keine Canvas – so gibt es Schrift, Textbearbeitung und Auswahl
// vom Browser. Bereiche liegen in einer eigenen Ebene unter allem anderen.
// Rahmen, Griffe, Cursor der anderen und die Leiste zur Auswahl liegen in
// Bildschirmkoordinaten darüber und bleiben beim Zoomen gleich groß.
//
// Workshop: Abstimmen mit Punkten (verdeckt bis zum Ende), gemeinsamer
// Timer, anderen folgen bzw. alle zu sich holen (über Awareness).

import * as Y from 'yjs';
import { Awareness } from 'y-protocols/awareness';
import { IndexeddbPersistence } from 'y-indexeddb';
import { Provider } from './provider';
import { uploadImage } from './images';
import { el, store, menu } from './ui';
import { boardMarkdown, readItem, voteCounts, MAX_ITEMS, type Item, type Timer, type Vote } from '../shared/board';
import type { EditorStatus, Peer } from './editor';

export interface BoardOptions {
  id: string;
  parent: HTMLElement;
  exists: boolean;
  editable: boolean;
  name: string;
  wsUrl(): string;
  auth(): Record<string, string>;
  ensureCreated(): Promise<boolean>;
  onStatus(s: EditorStatus): void;
  onTitle(t: string): void;
  onNotice(n: { type: string; edit?: boolean; to?: string }): void;
  toast(msg: string): void;
}

export interface BoardHandle {
  /** Titel-Feld für die Kopfleiste. */
  titleInput: HTMLInputElement;
  /** Timer und Abstimmen für die Kopfleiste. */
  controls: HTMLElement;
  markdown(): string;
  title(): string;
  setEditable(on: boolean): void;
  setName(name: string): void;
  follow(client: number): void;
  summon(): void;
  peerCount(): number;
  reconnect(): void;
  /** Anderswo angelegt (z. B. beim Kopieren des Bearbeiten-Links): verbinden. */
  markCreated(): void;
  /** Druckdialog mit dem ganzen Board auf einer Seite. */
  print(): void;
}

type Tool = 'select' | 'hand' | 'note' | 'frame' | 'shape' | 'arrow' | 'text' | 'pen';
interface Pt { x: number; y: number }
interface Box { x: number; y: number; w: number; h: number }

type Drag =
  | { kind: 'pan'; sx: number; sy: number; vx: number; vy: number; moved: boolean; tapId: string | null }
  | { kind: 'move'; start: Pt; orig: Map<string, Item>; moved: boolean; clickId: string | null }
  | { kind: 'marquee'; start: Pt; base: Set<string> }
  | { kind: 'resize'; id: string; start: Pt; orig: Item }
  | { kind: 'create'; t: 'frame' | 'shape'; start: Pt; id: string | null }
  | { kind: 'arrow'; start: Pt; from: string | null; id: string | null }
  | { kind: 'end'; id: string; end: 'from' | 'to' }
  | { kind: 'stroke'; pts: number[]; node: HTMLElement; path: SVGPathElement };

const LOCAL = 'board-local';
const SVGNS = 'http://www.w3.org/2000/svg';
const NOTE_COLORS = ['yellow', 'orange', 'pink', 'purple', 'blue', 'green', 'gray'];
const INK_COLORS = ['fg', 'red', 'orange', 'green', 'blue', 'purple'];
const COLOR_NAMES: Record<string, string> = {
  yellow: 'Gelb', orange: 'Orange', pink: 'Rosa', purple: 'Lila', blue: 'Blau', green: 'Grün', gray: 'Grau', fg: 'Schwarz', red: 'Rot',
};
const PEER_COLORS = ['#1a8cff', '#e5484d', '#30a46c', '#f76b15', '#8e4ec6', '#d6409f', '#0797a0', '#a18072'];
const NOTE = 150;
const MIN_Z = 0.1;
const MAX_Z = 4;
const TEXTUAL = new Set(['note', 'shape', 'text', 'frame']);
const VOTABLE = new Set(['note', 'shape', 'text', 'image']);
const RESIZABLE = new Set(['note', 'frame', 'shape', 'image', 'text']);

const svgIcon = (d: string) => `<svg viewBox="0 0 20 20" aria-hidden="true">${d}</svg>`;
const ICON = {
  select: svgIcon('<path d="M5 3.5l10 6-4.5 1.2L8.6 15z"/>'),
  hand: svgIcon('<path d="M7 10V5a1.2 1.2 0 0 1 2.4 0v4M9.4 9V3.8a1.2 1.2 0 0 1 2.4 0V9M11.8 9V4.8a1.2 1.2 0 0 1 2.4 0V11c0 3.3-2 5.5-5 5.5-2.3 0-3.5-1.2-4.6-3.2L3 10.6a1.2 1.2 0 0 1 2-1.2L7 12"/>'),
  note: svgIcon('<path d="M4 4h12v8l-4 4H4z"/><path d="M16 12h-4v4"/>'),
  frame: svgIcon('<path d="M3 6.5h14M3 13.5h14M6.5 3v14M13.5 3v14"/>'),
  shape: svgIcon('<rect x="3" y="3" width="8.5" height="8.5" rx="1"/><circle cx="12.5" cy="12.5" r="4.5"/>'),
  arrow: svgIcon('<path d="M4 16L16 4M9 4h7v7"/>'),
  text: svgIcon('<path d="M4.5 5V3.8h11V5M10 3.8v12.4M7.8 16.2h4.4"/>'),
  pen: svgIcon('<path d="M3.5 16.5c2-.3 3-1 4-2l8-8a1.8 1.8 0 0 0-2.5-2.5l-8 8c-1 1-1.7 2-2 4z"/>'),
  image: svgIcon('<rect x="3" y="4" width="14" height="12" rx="1.5"/><circle cx="7.5" cy="8.3" r="1.3"/><path d="M3.5 14.5l4-4 3 3 2-2 4 3.5"/>'),
  undo: svgIcon('<path d="M7.5 5L4 8.5 7.5 12"/><path d="M4 8.5h7.5a4 4 0 0 1 0 8H9"/>'),
  redo: svgIcon('<path d="M12.5 5L16 8.5 12.5 12"/><path d="M16 8.5H8.5a4 4 0 0 0 0 8H11"/>'),
  rename: svgIcon('<path d="M4 16l.8-3.6L13 4.2l2.8 2.8-8.2 8.2z"/><path d="M11.2 6l2.8 2.8"/>'),
  dup: svgIcon('<rect x="7" y="7" width="9.5" height="9.5" rx="1.5"/><path d="M13 7V4.5A1 1 0 0 0 12 3.5H4.5a1 1 0 0 0-1 1V12a1 1 0 0 0 1 1H7"/>'),
  front: svgIcon('<rect x="7" y="7" width="9.5" height="9.5" rx="1.5" class="fill"/><path d="M13 5V3.5H3.5V13H5"/>'),
  back: svgIcon('<rect x="3.5" y="3.5" width="9.5" height="9.5" rx="1.5" class="fill"/><path d="M15 7h1.5v9.5H7V15"/>'),
  trash: svgIcon('<path d="M4 6h12M8 6V4h4v2M5.5 6l.8 10.5h7.4L14.5 6"/>'),
  rect: svgIcon('<rect x="3.5" y="5" width="13" height="10" rx="1"/>'),
  ellipse: svgIcon('<ellipse cx="10" cy="10" rx="6.5" ry="5"/>'),
  diamond: svgIcon('<path d="M10 3.5l6.5 6.5-6.5 6.5L3.5 10z"/>'),
};

const TOOLS: [Tool | 'image', string, string][] = [
  ['select', 'Auswählen', 'V'],
  ['hand', 'Verschieben', 'H'],
  ['note', 'Notiz', 'N'],
  ['frame', 'Bereich', 'F'],
  ['shape', 'Form', 'R'],
  ['arrow', 'Pfeil', 'A'],
  ['text', 'Text', 'T'],
  ['pen', 'Stift', 'P'],
  ['image', 'Bild', 'I'],
];

const rid = () => Math.random().toString(36).slice(2, 10);
const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
const round = (v: number) => Math.round(v * 10) / 10;
const center = (b: Box): Pt => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });
const contains = (b: Box, p: Pt) => p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h;
const overlaps = (a: Box, b: Box) => a.x <= b.x + b.w && a.x + a.w >= b.x && a.y <= b.y + b.h && a.y + a.h >= b.y;
const within = (inner: Box, outer: Box) => inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.w <= outer.x + outer.w && inner.y + inner.h <= outer.y + outer.h;
const rectOf = (a: Pt, b: Pt): Box => ({ x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) });

function union(boxes: Box[]): Box | null {
  if (!boxes.length) return null;
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  for (const b of boxes) { x1 = Math.min(x1, b.x); y1 = Math.min(y1, b.y); x2 = Math.max(x2, b.x + b.w); y2 = Math.max(y2, b.y + b.h); }
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

/** Punkt auf dem Rand von `box` in Richtung `toward` (etwas Abstand). */
function clipToBox(box: Box, toward: Pt): Pt {
  const c = center(box);
  const dx = toward.x - c.x, dy = toward.y - c.y;
  if (!dx && !dy) return c;
  const hw = box.w / 2 + 6, hh = box.h / 2 + 6;
  const t = Math.min(dx ? hw / Math.abs(dx) : Infinity, dy ? hh / Math.abs(dy) : Infinity);
  if (t >= 1) return c;
  return { x: c.x + dx * t, y: c.y + dy * t };
}

function strokePath(pts: number[]): string {
  if (pts.length < 4) return `M${pts[0]} ${pts[1]}l.01 0`;
  let d = `M${pts[0]} ${pts[1]}`;
  for (let i = 2; i < pts.length - 2; i += 2) {
    d += `Q${pts[i]} ${pts[i + 1]} ${round((pts[i] + pts[i + 2]) / 2)} ${round((pts[i + 1] + pts[i + 3]) / 2)}`;
  }
  return d + `L${pts[pts.length - 2]} ${pts[pts.length - 1]}`;
}

function svg(tag: string, attrs: Record<string, string> = {}): SVGElement {
  const n = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  return n;
}

function editable(node: HTMLElement, on: boolean) {
  if (!on) { node.removeAttribute('contenteditable'); return; }
  node.setAttribute('contenteditable', 'plaintext-only');
  if (node.contentEditable !== 'plaintext-only') node.setAttribute('contenteditable', 'true');
}

/** Kurzer Ton, wenn der Timer abläuft. */
function chime() {
  try {
    const ctx = new AudioContext();
    [0, 0.22].forEach((at, i) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.frequency.value = i ? 1046 : 784;
      g.gain.setValueAtTime(0.0001, ctx.currentTime + at);
      g.gain.exponentialRampToValueAtTime(0.18, ctx.currentTime + at + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + at + 0.35);
      o.connect(g).connect(ctx.destination);
      o.start(ctx.currentTime + at);
      o.stop(ctx.currentTime + at + 0.4);
    });
    setTimeout(() => ctx.close(), 1200);
  } catch { /* ohne Ton */ }
}

export function mountBoard(o: BoardOptions): BoardHandle {
  // ── Daten ─────────────────────────────────────────────────────────────────

  const ydoc = new Y.Doc();
  const items = ydoc.getMap<Y.Map<unknown>>('items');
  const meta = ydoc.getMap<unknown>('meta');
  const votes = ydoc.getMap<number>('votes');
  const undo = new Y.UndoManager(items, { trackedOrigins: new Set([LOCAL]), captureTimeout: 400 });
  const awareness = new Awareness(ydoc);
  const myColor = PEER_COLORS[Math.floor(Math.random() * PEER_COLORS.length)];
  let myName = o.name || 'Gast';
  awareness.setLocalStateField('user', { name: myName, color: myColor });
  let voter = store.get('md:voter');
  if (!voter) { voter = rid() + rid(); store.set('md:voter', voter); }

  let canEdit = o.editable;
  let created = o.exists;
  let creating: Promise<boolean> | null = null;
  let peers: Peer[] = [];
  let pending = false;

  const local = new IndexeddbPersistence(`md:${o.id}`, ydoc);
  const dropLocal = () => { local.clearData().catch(() => {}); };

  const provider = new Provider(ydoc, awareness, o.wsUrl, {
    status: s => { if (s === 'gone') dropLocal(); report(); },
    synced: () => { report(); firstView(); },
    notice: n => {
      if (n.type === 'moved' || (n.type === 'hello' && n.edit === false)) dropLocal();
      o.onNotice(n);
    },
    pending: p => { pending = p; report(); },
  });
  const report = () => o.onStatus({ status: provider.status, pending, peers, synced: provider.synced });
  local.whenSynced.then(() => firstView());

  // Neues Board: beim ersten Eintrag anlegen, dann verbinden.
  ydoc.on('update', (_u: Uint8Array, origin: unknown) => {
    if (created || origin === provider || origin === local) return;
    creating ??= o.ensureCreated().then(ok => {
      if (ok && !created) { created = true; provider.connect(); }
      else creating = null;
      return ok;
    });
  });
  if (created) provider.connect();

  const tx = (fn: () => void) => ydoc.transact(fn, LOCAL);

  function addItem(fields: Omit<Item, 'id'>): string {
    if (items.size >= MAX_ITEMS) { o.toast('Das Board ist voll.'); return ''; }
    const id = rid();
    tx(() => {
      const m = new Y.Map<unknown>();
      for (const [k, v] of Object.entries(fields)) if (v !== undefined) m.set(k, v);
      items.set(id, m);
    });
    return id;
  }

  /** Mehrere Änderungen in einem Schritt (eine Yjs-Transaktion). */
  function patchMany(changes: [string, Partial<Item>][]) {
    tx(() => {
      for (const [id, fields] of changes) {
        const m = items.get(id);
        if (!m) continue;
        for (const [k, v] of Object.entries(fields)) {
          if (v === undefined || v === null) { if (m.has(k)) m.delete(k); }
          else if (m.get(k) !== v) m.set(k, v);
        }
      }
    });
  }
  const patch = (id: string, fields: Partial<Item>) => patchMany([[id, fields]]);

  // ── Aufbau ────────────────────────────────────────────────────────────────

  const root = el('div', { class: 'board', tabindex: '-1' });
  const world = el('div', { class: 'b-world' });
  const frameLayer = el('div', { class: 'b-layer' });
  const itemLayer = el('div', { class: 'b-layer' });
  world.append(frameLayer, itemLayer);
  const overlay = el('div', { class: 'b-overlay' });
  const selBox = el('div', { class: 'b-selbox' });
  const handle = el('div', { class: 'b-handle', 'data-handle': 'resize' });
  const endA = el('div', { class: 'b-handle b-end', 'data-handle': 'from' });
  const endB = el('div', { class: 'b-handle b-end', 'data-handle': 'to' });
  const marquee = el('div', { class: 'b-marquee' });
  const cursors = el('div', { class: 'b-cursors' });
  const ctxBar = el('div', { class: 'b-ctx', role: 'toolbar', 'aria-label': 'Auswahl' });
  overlay.append(selBox, handle, endA, endB, marquee, cursors, ctxBar);
  const tools = el('div', { class: 'b-tools', role: 'toolbar', 'aria-label': 'Werkzeuge' });
  const zoomBar = el('div', { class: 'b-zoom' });
  const followBar = el('div', { class: 'b-follow' });
  root.append(world, overlay, tools, zoomBar, followBar);
  o.parent.append(root);

  const fileInput = el('input', { type: 'file', accept: 'image/*', multiple: '' }) as HTMLInputElement;
  fileInput.addEventListener('change', () => {
    const files = [...(fileInput.files || [])];
    fileInput.value = '';
    placeImages(files, viewCenter());
  });

  // ── Ansicht (Verschieben, Zoomen) ─────────────────────────────────────────

  const viewKey = `md:view:${o.id}`;
  let view = { x: 0, y: 0, z: 1 };
  let haveView = false;
  try {
    const saved = JSON.parse(store.get(viewKey) || 'null');
    if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.z)) { view = saved; haveView = true; }
  } catch { /* neu */ }
  if (!haveView) { view.x = root.clientWidth / 2 || innerWidth / 2; view.y = root.clientHeight / 2 || innerHeight / 2; }

  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  function applyView(manual = true) {
    if (manual && following !== null) stopFollow();
    world.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.z})`;
    let g = 24 * view.z;
    while (g < 12) g *= 4;
    root.style.setProperty('--gs', `${g}px`);
    root.style.setProperty('--gx', `${view.x}px`);
    root.style.setProperty('--gy', `${view.y}px`);
    root.style.setProperty('--z', String(view.z));
    zoomLabel.textContent = `${Math.round(view.z * 100)} %`;
    const w = root.clientWidth, h = root.clientHeight;
    publish('view', { x: round((w / 2 - view.x) / view.z), y: round((h / 2 - view.y) / view.z), w: round(w / view.z), h: round(h / view.z) });
    paintOverlay();
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => store.set(viewKey, JSON.stringify(view)), 400);
  }

  const local2 = (cx: number, cy: number): Pt => {
    const r = root.getBoundingClientRect();
    return { x: cx - r.left, y: cy - r.top };
  };
  const toWorld = (p: Pt): Pt => ({ x: (p.x - view.x) / view.z, y: (p.y - view.y) / view.z });
  const toScreen = (p: Pt): Pt => ({ x: p.x * view.z + view.x, y: p.y * view.z + view.y });
  const viewCenter = () => toWorld({ x: root.clientWidth / 2, y: root.clientHeight / 2 });

  function zoomAt(z: number, at: Pt = { x: root.clientWidth / 2, y: root.clientHeight / 2 }) {
    z = clamp(z, MIN_Z, MAX_Z);
    const k = z / view.z;
    view.x = at.x - (at.x - view.x) * k;
    view.y = at.y - (at.y - view.y) * k;
    view.z = z;
    applyView();
  }

  function fitTo(b: Box | null, manual = true) {
    const w = root.clientWidth, h = root.clientHeight;
    if (!b) { view = { x: w / 2, y: h / 2, z: 1 }; applyView(manual); return; }
    const pad = 80;
    const z = clamp(Math.min((w - pad * 2) / Math.max(b.w, 1), (h - pad * 2) / Math.max(b.h, 1), 1), MIN_Z, MAX_Z);
    view = { z, x: w / 2 - (b.x + b.w / 2) * z, y: h / 2 - (b.y + b.h / 2) * z };
    applyView(manual);
  }
  const fitAll = () => fitTo(union([...cache.values()].map(bounds)));

  /** Beim ersten Laden: alles zeigen (sofern nichts gemerkt ist). */
  let viewed = haveView;
  function firstView() {
    flushNow();
    if (viewed || !cache.size) return;
    viewed = true;
    fitTo(union([...cache.values()].map(bounds)), false);
  }

  // ── Drucken ───────────────────────────────────────────────────────────────

  // Auch bei ⌘P: das ganze Board auf eine A4-Seite (quer oder hoch, je nach Form).
  let printing: { view: typeof view; page: HTMLStyleElement } | null = null;
  addEventListener('beforeprint', () => {
    if (printing || !root.isConnected) return;
    flushNow();
    if (editing) endEdit();
    select([]);
    const b = union([...cache.values()].map(bounds));
    const landscape = !b || b.w >= b.h;
    const mm = 96 / 25.4;
    const W = Math.floor((landscape ? 277 : 190) * mm), H = Math.floor((landscape ? 190 : 277) * mm);
    const page = el('style', {}, `@page { size: A4 ${landscape ? 'landscape' : 'portrait'}; margin: 10mm; }`) as HTMLStyleElement;
    document.head.append(page);
    printing = { view: { ...view }, page };
    root.classList.add('is-printing');
    root.style.width = `${W}px`;
    root.style.height = `${H}px`;
    if (b) {
      // Rand oben auch für die Titel der Bereiche.
      const pad = 28;
      const z = Math.min((W - pad * 2) / Math.max(b.w, 1), (H - pad * 2) / Math.max(b.h, 1), 2);
      view = { z, x: W / 2 - (b.x + b.w / 2) * z, y: H / 2 - (b.y + b.h / 2) * z };
    }
    world.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.z})`;
    root.style.setProperty('--z', String(view.z));
  });
  addEventListener('afterprint', () => {
    if (!printing) return;
    printing.page.remove();
    view = printing.view;
    printing = null;
    root.classList.remove('is-printing');
    root.style.removeProperty('width');
    root.style.removeProperty('height');
    applyView(false);
  });

  // ── Zeichnen ──────────────────────────────────────────────────────────────

  const cache = new Map<string, Item>();
  const nodes = new Map<string, HTMLElement>();
  const dirty = new Set<string>();
  let frameReq = 0;

  items.observeDeep(events => {
    for (const ev of events) {
      if (ev.target === items) for (const k of ev.changes.keys.keys()) dirty.add(k);
      else if (typeof ev.path[0] === 'string') dirty.add(ev.path[0]);
    }
    schedule();
  });
  votes.observe(() => { for (const [id, it] of cache) if (VOTABLE.has(it.t)) dirty.add(id); schedule(); });
  meta.observe(ev => {
    if (ev.keysChanged.has('title')) syncTitle();
    if (ev.keysChanged.has('vote')) { for (const [id, it] of cache) if (VOTABLE.has(it.t)) dirty.add(id); schedule(); renderControls(); }
    if (ev.keysChanged.has('timer')) renderControls();
  });

  function schedule() {
    if (!frameReq) frameReq = requestAnimationFrame(flushNow);
  }

  function flushNow() {
    if (frameReq) cancelAnimationFrame(frameReq);
    frameReq = 0;
    if (!dirty.size) return;
    let selChanged = false;
    for (const id of dirty) {
      const m = items.get(id);
      if (m instanceof Y.Map) cache.set(id, readItem(id, m));
      else { cache.delete(id); if (selected.delete(id)) selChanged = true; }
    }
    for (const id of dirty) draw(id);
    // Pfeile hängen an anderen Elementen.
    for (const it of cache.values()) if (it.t === 'arrow' && !dirty.has(it.id)) draw(it.id);
    const touchedSel = [...dirty].some(id => selected.has(id));
    dirty.clear();
    if (selChanged || touchedSel) renderCtx();
    paintOverlay();
  }

  function draw(id: string) {
    const it = cache.get(id);
    let node = nodes.get(id);
    if (!it) { node?.remove(); nodes.delete(id); return; }
    if (node && node.dataset.t !== it.t) { node.remove(); node = undefined; }
    if (!node) {
      node = create(it);
      nodes.set(id, node);
      (it.t === 'frame' ? frameLayer : itemLayer).append(node);
      if (selected.has(id)) node.classList.add('is-sel');
    }
    update(node, it);
  }

  function create(it: Item): HTMLElement {
    const node = el('div', { class: `b-item b-${it.t === 'text' ? 'label' : it.t}`, 'data-id': it.id, 'data-t': it.t });
    if (it.t === 'note' || it.t === 'shape') {
      if (it.t === 'shape') node.append(svg('svg', { class: 'b-shape-svg', preserveAspectRatio: 'none' }));
      node.append(el('div', { class: 'b-wrap' }, el('div', { class: 'b-text' })), el('div', { class: 'b-votes' }));
    } else if (it.t === 'text') {
      node.append(el('div', { class: 'b-text' }), el('div', { class: 'b-votes' }));
    } else if (it.t === 'frame') {
      node.append(el('div', { class: 'b-frame-title' }, el('div', { class: 'b-text' })));
    } else if (it.t === 'image') {
      node.append(el('img', { alt: '', draggable: 'false' }), el('div', { class: 'b-votes' }));
    } else if (it.t === 'arrow' || it.t === 'stroke') {
      const s = svg('svg', { class: 'b-svg' });
      s.append(svg('path', { class: 'hit' }), svg('path', { class: 'line' }));
      node.append(s);
    }
    return node;
  }

  function update(node: HTMLElement, it: Item) {
    node.style.zIndex = String(Math.round(it.z || 0));
    if (it.t !== 'arrow') {
      node.style.left = `${it.x}px`;
      node.style.top = `${it.y}px`;
      if (it.t !== 'stroke') {
        node.style.width = `${it.w}px`;
        if (it.t !== 'text') node.style.height = `${it.h}px`;
      }
    }
    node.dataset.c = it.c || (it.t === 'note' ? 'yellow' : 'fg');
    const text = node.querySelector<HTMLElement>('.b-text');
    const isEditing = editing?.id === it.id;
    if (text && !isEditing && text.textContent !== (it.text || '')) text.textContent = it.text || '';

    if (it.t === 'note' || it.t === 'shape') fit(node, it);
    if (it.t === 'shape') {
      const s = node.querySelector('svg')!;
      const kind = it.s || 'rect';
      if (s.dataset.s !== kind) {
        s.dataset.s = kind;
        s.setAttribute('viewBox', '0 0 100 100');
        s.replaceChildren(kind === 'ellipse'
          ? svg('ellipse', { cx: '50', cy: '50', rx: '50', ry: '50', 'vector-effect': 'non-scaling-stroke' })
          : kind === 'diamond'
            ? svg('path', { d: 'M50 0L100 50L50 100L0 50Z', 'vector-effect': 'non-scaling-stroke' })
            : svg('rect', { x: '0', y: '0', width: '100', height: '100', rx: '2', 'vector-effect': 'non-scaling-stroke' }));
      }
    }
    if (it.t === 'image') {
      const img = node.querySelector('img')!;
      if (it.src && img.getAttribute('src') !== it.src) img.src = it.src;
    }
    if (it.t === 'stroke') {
      const d = strokePath(it.pts || [0, 0]);
      for (const p of node.querySelectorAll('path')) p.setAttribute('d', d);
    }
    if (it.t === 'arrow') {
      const [a, b] = arrowEnds(it);
      const ang = Math.atan2(b.y - a.y, b.x - a.x);
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      const head = Math.min(14, len / 2);
      const h1 = { x: b.x - head * Math.cos(ang - 0.45), y: b.y - head * Math.sin(ang - 0.45) };
      const h2 = { x: b.x - head * Math.cos(ang + 0.45), y: b.y - head * Math.sin(ang + 0.45) };
      const r = (p: Pt) => `${round(p.x)} ${round(p.y)}`;
      const [line, hit] = [node.querySelector('.line')!, node.querySelector('.hit')!];
      line.setAttribute('d', `M${r(a)}L${r(b)}M${r(h1)}L${r(b)}L${r(h2)}`);
      hit.setAttribute('d', `M${r(a)}L${r(b)}`);
    }
    if (VOTABLE.has(it.t)) drawVotes(node, it);
  }

  /** Schrift in Notizen und Formen so groß, dass der Text hineinpasst. */
  function fit(node: HTMLElement, it: Item) {
    const wrap = node.querySelector<HTMLElement>('.b-wrap')!;
    const text = wrap.firstElementChild as HTMLElement;
    const key = `${text.textContent}|${it.w}|${it.h}`;
    if (wrap.dataset.fit === key) return;
    wrap.dataset.fit = key;
    const room = it.h - 24;
    let size = Math.round(clamp(Math.min(it.w, it.h) / 6.5, 12, 40));
    text.style.fontSize = `${size}px`;
    while (size > 8 && (text.offsetHeight > room || text.scrollWidth > wrap.clientWidth)) {
      size -= size > 16 ? 2 : 1;
      text.style.fontSize = `${size}px`;
    }
  }

  function arrowEnds(it: Item): [Pt, Pt] {
    const fromIt = it.from ? cache.get(it.from) : undefined;
    const toIt = it.to ? cache.get(it.to) : undefined;
    const fromBox = fromIt && fromIt.t !== 'arrow' ? bounds(fromIt) : null;
    const toBox = toIt && toIt.t !== 'arrow' ? bounds(toIt) : null;
    let a: Pt = fromBox ? center(fromBox) : { x: it.fx ?? 0, y: it.fy ?? 0 };
    let b: Pt = toBox ? center(toBox) : { x: it.tx ?? 0, y: it.ty ?? 0 };
    if (fromBox) a = clipToBox(fromBox, b);
    if (toBox) b = clipToBox(toBox, a);
    return [a, b];
  }

  function bounds(it: Item): Box {
    if (it.t === 'arrow') { const [a, b] = arrowEnds(it); return rectOf(a, b); }
    if (it.t === 'text') {
      const h = nodes.get(it.id)?.offsetHeight;
      return { x: it.x, y: it.y, w: it.w, h: h || it.h };
    }
    return { x: it.x, y: it.y, w: it.w, h: it.h };
  }

  // ── Auswahl und Overlay ───────────────────────────────────────────────────

  let selected = new Set<string>();
  let drag: Drag | null = null;

  function select(ids: Iterable<string>) {
    for (const id of selected) nodes.get(id)?.classList.remove('is-sel');
    selected = new Set([...ids].filter(id => cache.has(id)));
    for (const id of selected) nodes.get(id)?.classList.add('is-sel');
    publish('sel', [...selected]);
    renderCtx();
    paintOverlay();
  }

  function paintOverlay() {
    const list = [...selected].map(id => cache.get(id)).filter((i): i is Item => !!i);
    const single = list.length === 1 ? list[0] : null;
    const box = union(list.map(bounds));
    const show = (n: HTMLElement, on: boolean) => { n.style.display = on ? '' : 'none'; };
    const arrowOnly = !!single && single.t === 'arrow';
    show(selBox, !!box && !arrowOnly && !editing);
    show(handle, !!single && canEdit && RESIZABLE.has(single.t) && !editing && drag?.kind !== 'move');
    show(endA, arrowOnly && canEdit);
    show(endB, arrowOnly && canEdit);
    if (box) {
      const a = toScreen(box), z = view.z;
      Object.assign(selBox.style, { transform: `translate(${a.x - 4}px, ${a.y - 4}px)`, width: `${box.w * z + 8}px`, height: `${box.h * z + 8}px` });
      handle.style.transform = `translate(${a.x + box.w * z - 2}px, ${a.y + box.h * z - 2}px)`;
    }
    if (arrowOnly) {
      const [p1, p2] = arrowEnds(single!).map(toScreen);
      endA.style.transform = `translate(${p1.x - 6}px, ${p1.y - 6}px)`;
      endB.style.transform = `translate(${p2.x - 6}px, ${p2.y - 6}px)`;
    }
    // Leiste zur Auswahl: über dem Rahmen, sonst darunter.
    const ctxOn = !!box && canEdit && !drag && !editing && ctxBar.childElementCount > 0 && !voteActive();
    show(ctxBar, ctxOn);
    if (ctxOn && box) {
      const a = toScreen(box), b = toScreen({ x: box.x + box.w, y: box.y + box.h });
      const w = ctxBar.offsetWidth, h = ctxBar.offsetHeight;
      let top = a.y - h - 14;
      if (top < 8) top = b.y + 14;
      top = clamp(top, 8, root.clientHeight - h - 76);
      const left = clamp((a.x + b.x) / 2 - w / 2, 8, root.clientWidth - w - 8);
      ctxBar.style.transform = `translate(${left}px, ${top}px)`;
    }
    paintCursors();
  }

  // ── Leiste zur Auswahl ────────────────────────────────────────────────────

  let lastNote = store.get('md:board:note') || 'yellow';
  let lastInk = store.get('md:board:ink') || 'fg';

  function ctxButton(icon: string, title: string, run: () => void, pressed?: boolean): HTMLButtonElement {
    const b = el('button', { type: 'button', title, 'aria-label': title });
    b.innerHTML = icon;
    if (pressed !== undefined) b.setAttribute('aria-pressed', String(pressed));
    b.addEventListener('click', run);
    return b;
  }

  function renderCtx() {
    ctxBar.replaceChildren();
    const list = [...selected].map(id => cache.get(id)).filter((i): i is Item => !!i);
    if (!list.length || !canEdit) return;
    const notes = list.filter(i => i.t === 'note');
    const inked = list.filter(i => i.t === 'shape' || i.t === 'arrow' || i.t === 'stroke' || i.t === 'text');
    const shapes = list.filter(i => i.t === 'shape');
    const group = (...kids: HTMLElement[]) => ctxBar.append(el('div', { class: 'b-ctx-group' }, ...kids));
    const swatches = (colors: string[], targets: Item[], fallback: string, ink: boolean) => {
      const current = new Set(targets.map(t => t.c || fallback));
      return colors.map(c => {
        const b = el('button', { type: 'button', class: `b-sw${ink ? ' ink' : ''}`, 'data-c': c, title: COLOR_NAMES[c], 'aria-label': COLOR_NAMES[c], 'aria-pressed': String(current.size === 1 && current.has(c)) });
        b.addEventListener('click', () => {
          patchMany(targets.map(t => [t.id, { c }]));
          if (ink) { lastInk = c; store.set('md:board:ink', c); } else { lastNote = c; store.set('md:board:note', c); }
        });
        return b;
      });
    };
    if (notes.length) group(...swatches(NOTE_COLORS, notes, 'yellow', false));
    if (inked.length) group(...swatches(INK_COLORS, inked, 'fg', true));
    if (shapes.length) {
      const cur = new Set(shapes.map(s => s.s || 'rect'));
      group(...(['rect', 'ellipse', 'diamond'] as const).map(s =>
        ctxButton(ICON[s], { rect: 'Rechteck', ellipse: 'Ellipse', diamond: 'Raute' }[s], () => patchMany(shapes.map(t => [t.id, { s }])), cur.size === 1 && cur.has(s))));
    }
    if (list.length === 1 && list[0].t === 'frame') group(ctxButton(ICON.rename, 'Umbenennen (↵)', () => startEdit(list[0].id)));
    group(
      ctxButton(ICON.dup, 'Duplizieren (⌘D)', duplicate),
      ctxButton(ICON.front, 'Nach vorne', () => restack(true)),
      ctxButton(ICON.back, 'Nach hinten', () => restack(false)),
      ctxButton(ICON.trash, 'Löschen (⌫)', removeSelected),
    );
  }

  // ── Werkzeuge ─────────────────────────────────────────────────────────────

  let tool: Tool = 'select';
  const toolButtons = new Map<string, HTMLButtonElement>();
  for (const [t, label, key] of TOOLS) {
    const b = el('button', { type: 'button', title: `${label} (${key})`, 'aria-label': label, 'data-tool': t });
    b.innerHTML = ICON[t];
    b.addEventListener('click', () => (t === 'image' ? pickImage() : setTool(t)));
    toolButtons.set(t, b);
    tools.append(b);
    if (t === 'hand' || t === 'image') tools.append(el('span', { class: 'b-sep', 'aria-hidden': 'true' }));
  }
  const undoBtn = ctxButton(ICON.undo, 'Rückgängig (⌘Z)', () => undo.undo());
  const redoBtn = ctxButton(ICON.redo, 'Wiederholen (⇧⌘Z)', () => undo.redo());
  tools.append(undoBtn, redoBtn);
  const syncUndo = () => { undoBtn.disabled = !undo.canUndo(); redoBtn.disabled = !undo.canRedo(); };
  undo.on('stack-item-added', syncUndo);
  undo.on('stack-item-popped', syncUndo);
  undo.on('stack-cleared', syncUndo);
  syncUndo();

  const zoomOut = ctxButton(svgIcon('<path d="M5 10h10"/>'), 'Verkleinern (⌘−)', () => zoomAt(view.z / 1.25));
  const zoomLabel = el('button', { type: 'button', class: 'b-zoom-label', title: 'Alles zeigen (⇧1)' }, '100 %');
  zoomLabel.addEventListener('click', fitAll);
  const zoomIn = ctxButton(svgIcon('<path d="M5 10h10M10 5v10"/>'), 'Vergrößern (⌘+)', () => zoomAt(view.z * 1.25));
  zoomBar.append(zoomOut, zoomLabel, zoomIn);

  function setTool(t: Tool) {
    tool = t;
    for (const [k, b] of toolButtons) b.setAttribute('aria-pressed', String(k === t));
    root.dataset.tool = t;
    if (t !== 'select' && t !== 'hand') select([]);
  }
  setTool('select');

  function pickImage() {
    if (!canEdit) return;
    fileInput.click();
  }

  // ── Anlegen, Ändern, Löschen ──────────────────────────────────────────────

  function topZ(frame: boolean): number {
    let z = 0;
    for (const it of cache.values()) if ((it.t === 'frame') === frame) z = Math.max(z, it.z || 0);
    return z + 1;
  }

  function addNote(at: Pt, c = lastNote): string {
    return addItem({ t: 'note', x: round(at.x - NOTE / 2), y: round(at.y - NOTE / 2), w: NOTE, h: NOTE, z: topZ(false), c, text: '' });
  }

  function removeSelected() {
    if (!selected.size) return;
    const ids = new Set(selected);
    for (const it of cache.values()) if (it.t === 'arrow' && ((it.from && ids.has(it.from)) || (it.to && ids.has(it.to)))) ids.add(it.id);
    tx(() => { for (const id of ids) items.delete(id); });
    select([]);
  }

  function restack(front: boolean) {
    const list = [...selected].map(id => cache.get(id)!).filter(Boolean).sort((a, b) => (a.z || 0) - (b.z || 0));
    const changes: [string, Partial<Item>][] = [];
    for (const frame of [true, false]) {
      const part = list.filter(i => (i.t === 'frame') === frame);
      if (!part.length) continue;
      if (front) { let z = topZ(frame); for (const it of part) changes.push([it.id, { z: z++ }]); }
      else {
        let low = Infinity;
        for (const it of cache.values()) if ((it.t === 'frame') === frame) low = Math.min(low, it.z || 0);
        let z = low - part.length;
        for (const it of part) changes.push([it.id, { z: z++ }]);
      }
    }
    patchMany(changes);
  }

  /** Kopie der Auswahl als freie Daten (Pfeile zu nicht ausgewählten Elementen werden lose). */
  function snapshot(ids: Iterable<string>): Item[] {
    const set = new Set(ids);
    return [...set].map(id => cache.get(id)).filter((i): i is Item => !!i).map(it => {
      if (it.t !== 'arrow') return { ...it };
      const [a, b] = arrowEnds(it);
      const copy = { ...it, fx: round(a.x), fy: round(a.y), tx: round(b.x), ty: round(b.y) };
      if (!it.from || !set.has(it.from)) delete copy.from;
      if (!it.to || !set.has(it.to)) delete copy.to;
      return copy;
    });
  }

  /** Eingefügt bzw. dupliziert: neue IDs, verschoben um dx/dy. */
  function insertCopies(list: Item[], dx: number, dy: number): string[] {
    if (items.size + list.length > MAX_ITEMS) { o.toast('Das Board ist voll.'); return []; }
    const ids = new Map(list.map(it => [it.id, rid()]));
    let zf = topZ(true), zi = topZ(false);
    const sorted = [...list].sort((a, b) => (a.z || 0) - (b.z || 0));
    tx(() => {
      for (const it of sorted) {
        const { id, ...rest } = it;
        const copy: Omit<Item, 'id'> = { ...rest, x: round(it.x + dx), y: round(it.y + dy), z: it.t === 'frame' ? zf++ : zi++ };
        if (it.t === 'arrow') {
          Object.assign(copy, { fx: round((it.fx ?? 0) + dx), fy: round((it.fy ?? 0) + dy), tx: round((it.tx ?? 0) + dx), ty: round((it.ty ?? 0) + dy) });
          copy.from = it.from ? ids.get(it.from) : undefined;
          copy.to = it.to ? ids.get(it.to) : undefined;
        }
        const m = new Y.Map<unknown>();
        for (const [k, v] of Object.entries(copy)) if (v !== undefined) m.set(k, v);
        items.set(ids.get(id)!, m);
      }
    });
    return [...ids.values()];
  }

  function duplicate() {
    if (!selected.size) return;
    const ids = insertCopies(snapshot(selected), 24, 24);
    flushNow();
    select(ids);
  }

  // ── Text bearbeiten ───────────────────────────────────────────────────────

  let editing: { id: string; node: HTMLElement; text: HTMLElement } | null = null;

  function startEdit(id: string, selectAll = true) {
    if (!canEdit) return;
    flushNow();
    const it = cache.get(id);
    const node = nodes.get(id);
    const text = node?.querySelector<HTMLElement>('.b-text');
    if (!it || !node || !text || !TEXTUAL.has(it.t)) return;
    if (editing) endEdit();
    select([id]);
    editing = { id, node, text };
    node.classList.add('is-editing');
    editable(text, true);
    text.focus({ preventScroll: true });
    const range = document.createRange();
    range.selectNodeContents(text);
    if (!selectAll) range.collapse(false);
    const sel = getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
    paintOverlay();
  }

  function endEdit() {
    if (!editing) return;
    const { id, node, text } = editing;
    editing = null;
    editable(text, false);
    node.classList.remove('is-editing');
    getSelection()?.removeAllRanges();
    const it = cache.get(id);
    if (it?.t === 'text' && !(it.text || '').trim()) {
      tx(() => items.delete(id));
      select([]);
    } else if (it) draw(id);
    root.focus({ preventScroll: true });
    paintOverlay();
  }

  root.addEventListener('input', e => {
    if (!editing || e.target !== editing.text) return;
    const value = editing.text.innerText.replace(/\n$/, '');
    const it = cache.get(editing.id);
    const fields: Partial<Item> = { text: value };
    if (it?.t === 'text') fields.h = editing.node.offsetHeight;
    patch(editing.id, fields);
  });

  root.addEventListener('keydown', e => {
    if (!editing || e.target !== editing.text) return;
    if (e.key === 'Escape' || (e.key === 'Enter' && (e.metaKey || e.ctrlKey))) {
      e.preventDefault();
      const id = editing.id;
      endEdit();
      select([id]);
    } else if (e.key === 'Tab' && cache.get(editing.id)?.t === 'note') {
      // Nächste Notiz daneben (bzw. darunter mit Shift).
      e.preventDefault();
      const it = cache.get(editing.id)!;
      endEdit();
      const at = e.shiftKey ? { x: it.x + it.w / 2, y: it.y + it.h * 1.5 + 20 } : { x: it.x + it.w * 1.5 + 20, y: it.y + it.h / 2 };
      const id = addItem({ t: 'note', x: round(at.x - it.w / 2), y: round(at.y - it.h / 2), w: it.w, h: it.h, z: topZ(false), c: it.c, text: '' });
      if (id) startEdit(id);
    }
    e.stopPropagation();
  });

  root.addEventListener('focusout', e => {
    if (editing && e.target === editing.text) setTimeout(() => { if (editing && document.activeElement !== editing.text) endEdit(); }, 0);
  });

  // ── Zeiger ────────────────────────────────────────────────────────────────

  const pointers = new Map<number, Pt>();
  let pinch: { d: number; mid: Pt; z: number; x: number; y: number } | null = null;
  let lastTap = { t: 0, x: 0, y: 0, id: '' };
  let spaceDown = false;
  let lastPointer: Pt | null = null;
  let hoverTarget: string | null = null;
  /** Mit Apple Pencil o. ä. gezeichnet: Finger zeichnen dann nicht (Handballen). */
  let penUsed = false;

  const itemIdAt = (target: EventTarget | null): string | null => {
    const n = (target as Element | null)?.closest?.('[data-id]') as HTMLElement | null;
    return n?.dataset.id || null;
  };

  /** Oberstes Element unter einem Punkt (für Pfeil-Enden), Bereiche zuletzt. */
  function connectableAt(p: Pt, except?: string): string | null {
    let best: Item | null = null;
    for (const it of cache.values()) {
      if (it.id === except || it.t === 'arrow' || it.t === 'stroke' || !contains(bounds(it), p)) continue;
      const rank = (i: Item) => (i.t === 'frame' ? -1e9 : 0) + (i.z || 0);
      if (!best || rank(it) > rank(best)) best = it;
    }
    return best?.id || null;
  }

  function setHover(id: string | null) {
    if (hoverTarget === id) return;
    if (hoverTarget) nodes.get(hoverTarget)?.classList.remove('is-target');
    hoverTarget = id;
    if (id) nodes.get(id)?.classList.add('is-target');
  }

  root.addEventListener('pointerdown', e => {
    const target = e.target as HTMLElement;
    if (target.closest('.b-tools, .b-zoom, .b-ctx, .b-follow')) return;
    if (editing && target.closest('.is-editing')) return;
    if (editing) endEdit();
    if (e.button === 2) return;
    // Fokus steuern wir selbst (sonst nimmt das Board ihn einer gerade geöffneten Notiz weg).
    e.preventDefault();
    viewed = true;
    root.focus({ preventScroll: true });
    const sp = local2(e.clientX, e.clientY);
    pointers.set(e.pointerId, sp);
    try { root.setPointerCapture(e.pointerId); } catch { /* egal */ }

    if (pointers.size === 2) {
      // Zwei Finger: Zoomen und Verschieben. Was der erste Finger begonnen hat, fällt weg.
      if (drag?.kind === 'stroke') drag.node.remove();
      drag = null;
      const [a, b] = [...pointers.values()];
      pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, z: view.z, x: view.x, y: view.y };
      marquee.style.display = 'none';
      return;
    }
    if (pointers.size > 2) return;

    const p = toWorld(sp);
    const handleKind = target.closest<HTMLElement>('[data-handle]')?.dataset.handle;
    const hitId = itemIdAt(target);
    const touch = e.pointerType === 'touch';

    // Doppelt tippen/klicken: Text bearbeiten oder neue Notiz.
    const now = performance.now();
    const double = now - lastTap.t < 380 && Math.hypot(sp.x - lastTap.x, sp.y - lastTap.y) < 14 && (hitId || '') === lastTap.id;
    lastTap = { t: now, x: sp.x, y: sp.y, id: hitId || '' };

    if (e.button === 1 || spaceDown || tool === 'hand' || !canEdit) {
      drag = { kind: 'pan', sx: sp.x, sy: sp.y, vx: view.x, vy: view.y, moved: false, tapId: hitId };
      root.classList.add('is-panning');
      return;
    }

    if (handleKind === 'resize' && selected.size === 1) {
      const id = [...selected][0];
      drag = { kind: 'resize', id, start: p, orig: { ...cache.get(id)!, h: bounds(cache.get(id)!).h } };
      undo.stopCapturing();
      return;
    }
    if ((handleKind === 'from' || handleKind === 'to') && selected.size === 1) {
      drag = { kind: 'end', id: [...selected][0], end: handleKind };
      undo.stopCapturing();
      return;
    }

    if (tool === 'note') {
      const id = addNote(p);
      setTool('select');
      if (id) startEdit(id);
      return;
    }
    if (tool === 'text') {
      const id = addItem({ t: 'text', x: round(p.x), y: round(p.y - 16), w: 280, h: 40, z: topZ(false), c: lastInk, text: '' });
      setTool('select');
      if (id) startEdit(id);
      return;
    }
    if (tool === 'frame' || tool === 'shape') {
      drag = { kind: 'create', t: tool, start: p, id: null };
      undo.stopCapturing();
      return;
    }
    if (tool === 'arrow') {
      drag = { kind: 'arrow', start: p, from: connectableAt(p), id: null };
      undo.stopCapturing();
      return;
    }
    if (tool === 'pen') {
      if (touch && penUsed) {
        // Mit Stift gezeichnet: Finger verschiebt nur (Handballen).
        drag = { kind: 'pan', sx: sp.x, sy: sp.y, vx: view.x, vy: view.y, moved: false, tapId: null };
        return;
      }
      if (e.pointerType === 'pen') penUsed = true;
      const node = el('div', { class: 'b-item b-stroke is-drawing', 'data-c': lastInk });
      node.style.zIndex = String(topZ(false));
      const s = svg('svg', { class: 'b-svg' });
      const path = svg('path', { class: 'line' }) as SVGPathElement;
      s.append(path);
      node.append(s);
      itemLayer.append(node);
      drag = { kind: 'stroke', pts: [round(p.x), round(p.y)], node, path };
      path.setAttribute('d', strokePath(drag.pts));
      return;
    }

    // Auswählen
    if (hitId && voteActive() && VOTABLE.has(cache.get(hitId)?.t || '')) {
      const dot = target.closest<HTMLElement>('.b-dot');
      castVote(hitId, dot ? -1 : 1);
      return;
    }
    if (hitId) {
      if (double && TEXTUAL.has(cache.get(hitId)?.t || '')) { startEdit(hitId, false); return; }
      let clickId: string | null = null;
      if (e.shiftKey) {
        const next = new Set(selected);
        if (next.has(hitId)) next.delete(hitId); else next.add(hitId);
        select(next);
        if (!next.has(hitId)) return;
      } else if (!selected.has(hitId)) select([hitId]);
      else clickId = hitId;
      drag = { kind: 'move', start: p, orig: moveSet(), moved: false, clickId };
      return;
    }
    if (double) {
      const id = addNote(p);
      if (id) startEdit(id);
      return;
    }
    if (touch) {
      drag = { kind: 'pan', sx: sp.x, sy: sp.y, vx: view.x, vy: view.y, moved: false, tapId: null };
      return;
    }
    drag = { kind: 'marquee', start: p, base: e.shiftKey ? new Set(selected) : new Set() };
    if (!e.shiftKey) select([]);
  });

  /** Was beim Verschieben mitgeht: Auswahl, dazu der Inhalt ausgewählter Bereiche. */
  function moveSet(): Map<string, Item> {
    const out = new Map<string, Item>();
    for (const id of selected) { const it = cache.get(id); if (it) out.set(id, { ...it }); }
    for (const f of [...out.values()].filter(i => i.t === 'frame')) {
      for (const it of cache.values()) {
        if (out.has(it.id)) continue;
        const b = bounds(it);
        if (it.t === 'frame' ? within(b, f) : contains(f, center(b))) out.set(it.id, { ...it });
      }
    }
    undo.stopCapturing();
    return out;
  }

  root.addEventListener('pointermove', e => {
    const sp = local2(e.clientX, e.clientY);
    if (pointers.has(e.pointerId)) pointers.set(e.pointerId, sp);
    lastPointer = toWorld(sp);
    if (e.pointerType !== 'touch') publish('cursor', { x: round(lastPointer.x), y: round(lastPointer.y) });

    if (pinch && pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const z = clamp(pinch.z * (d / pinch.d), MIN_Z, MAX_Z);
      const k = z / pinch.z;
      view = { z, x: mid.x - (pinch.mid.x - pinch.x) * k, y: mid.y - (pinch.mid.y - pinch.y) * k };
      applyView();
      return;
    }
    if (!drag) return;
    const p = toWorld(sp);

    switch (drag.kind) {
      case 'pan': {
        if (Math.hypot(sp.x - drag.sx, sp.y - drag.sy) > 4) drag.moved = true;
        view.x = drag.vx + sp.x - drag.sx;
        view.y = drag.vy + sp.y - drag.sy;
        applyView();
        break;
      }
      case 'move': {
        const dx = p.x - drag.start.x, dy = p.y - drag.start.y;
        if (!drag.moved && Math.hypot(dx * view.z, dy * view.z) < 3) return;
        drag.moved = true;
        const changes: [string, Partial<Item>][] = [];
        for (const it of drag.orig.values()) {
          if (it.t === 'arrow') {
            changes.push([it.id, { fx: round((it.fx ?? 0) + dx), fy: round((it.fy ?? 0) + dy), tx: round((it.tx ?? 0) + dx), ty: round((it.ty ?? 0) + dy) }]);
          } else changes.push([it.id, { x: round(it.x + dx), y: round(it.y + dy) }]);
        }
        patchMany(changes);
        break;
      }
      case 'marquee': {
        const r = rectOf(drag.start, p);
        const a = toScreen(r);
        Object.assign(marquee.style, { display: 'block', transform: `translate(${a.x}px, ${a.y}px)`, width: `${r.w * view.z}px`, height: `${r.h * view.z}px` });
        const hit = new Set(drag.base);
        for (const it of cache.values()) {
          const b = bounds(it);
          if (it.t === 'frame' ? within(b, r) : overlaps(b, r)) hit.add(it.id);
        }
        select(hit);
        break;
      }
      case 'resize': {
        const it = drag.orig;
        let w = Math.max(it.t === 'text' ? 40 : 24, it.w + p.x - drag.start.x);
        let h = Math.max(24, it.h + p.y - drag.start.y);
        if (it.t === 'image' || (e.shiftKey && it.t !== 'text')) {
          const ratio = it.w / it.h;
          if (w / h > ratio) h = w / ratio; else w = h * ratio;
        }
        patch(it.id, it.t === 'text' ? { w: round(w) } : { w: round(w), h: round(h) });
        break;
      }
      case 'create': {
        const r = rectOf(drag.start, p);
        if (!drag.id) {
          if (Math.hypot(r.w * view.z, r.h * view.z) < 6) return;
          drag.id = drag.t === 'frame'
            ? addItem({ t: 'frame', x: round(r.x), y: round(r.y), w: round(r.w), h: round(r.h), z: topZ(true), text: '' })
            : addItem({ t: 'shape', x: round(r.x), y: round(r.y), w: round(r.w), h: round(r.h), z: topZ(false), s: 'rect', c: lastInk, text: '' });
        } else patch(drag.id, { x: round(r.x), y: round(r.y), w: round(Math.max(r.w, 8)), h: round(Math.max(r.h, 8)) });
        break;
      }
      case 'arrow': {
        const to = connectableAt(p, drag.from || undefined);
        setHover(to);
        if (!drag.id) {
          if (Math.hypot((p.x - drag.start.x) * view.z, (p.y - drag.start.y) * view.z) < 6) return;
          drag.id = addItem({ t: 'arrow', x: 0, y: 0, w: 0, h: 0, z: topZ(false), c: lastInk, fx: round(drag.start.x), fy: round(drag.start.y), tx: round(p.x), ty: round(p.y), from: drag.from || undefined, to: to || undefined });
        } else patch(drag.id, { tx: round(p.x), ty: round(p.y), to: to || undefined });
        break;
      }
      case 'end': {
        const it = cache.get(drag.id);
        if (!it) return;
        const other = drag.end === 'from' ? it.to : it.from;
        const hit = connectableAt(p, other);
        setHover(hit);
        patch(drag.id, drag.end === 'from'
          ? { fx: round(p.x), fy: round(p.y), from: hit || undefined }
          : { tx: round(p.x), ty: round(p.y), to: hit || undefined });
        break;
      }
      case 'stroke': {
        const pts = drag.pts;
        const lx = pts[pts.length - 2], ly = pts[pts.length - 1];
        if (Math.hypot(p.x - lx, p.y - ly) * view.z < 2) return;
        pts.push(round(p.x), round(p.y));
        drag.path.setAttribute('d', strokePath(pts));
        break;
      }
    }
    if (drag && drag.kind !== 'pan' && drag.kind !== 'marquee') paintOverlay();
  });

  function endPointer(e: PointerEvent) {
    pointers.delete(e.pointerId);
    if (pinch) { if (pointers.size < 2) pinch = null; drag = null; return; }
    const d = drag;
    drag = null;
    root.classList.remove('is-panning');
    marquee.style.display = 'none';
    setHover(null);
    if (!d) return;
    if (d.kind === 'pan' && !d.moved && e.type === 'pointerup') {
      // Tippen ohne Bewegen: auswählen bzw. Auswahl aufheben.
      if (d.tapId && voteActive() && VOTABLE.has(cache.get(d.tapId)?.t || '') && canEdit) castVote(d.tapId, (e.target as Element).closest?.('.b-dot') ? -1 : 1);
      else select(d.tapId && canEdit ? [d.tapId] : []);
    }
    if (d.kind === 'move' && !d.moved && d.clickId && !e.shiftKey) {
      // Titel eines schon gewählten Bereichs angeklickt: umbenennen.
      if (selected.size === 1 && cache.get(d.clickId)?.t === 'frame') startEdit(d.clickId);
      else select([d.clickId]);
    }
    if (d.kind === 'create') {
      let id = d.id;
      if (!id) {
        const w = d.t === 'frame' ? 640 : 180, h = d.t === 'frame' ? 420 : 120;
        id = d.t === 'frame'
          ? addItem({ t: 'frame', x: round(d.start.x - w / 2), y: round(d.start.y - h / 2), w, h, z: topZ(true), text: '' })
          : addItem({ t: 'shape', x: round(d.start.x - w / 2), y: round(d.start.y - h / 2), w, h, z: topZ(false), s: 'rect', c: lastInk, text: '' });
      }
      setTool('select');
      flushNow();
      if (id && d.t === 'frame') startEdit(id);
      else if (id) select([id]);
    }
    if (d.kind === 'arrow') {
      setTool('select');
      flushNow();
      if (d.id) select([d.id]);
    }
    if (d.kind === 'stroke') {
      d.node.remove();
      const pts = d.pts;
      if (pts.length < 2) return;
      let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
      for (let i = 0; i < pts.length; i += 2) { x1 = Math.min(x1, pts[i]); x2 = Math.max(x2, pts[i]); y1 = Math.min(y1, pts[i + 1]); y2 = Math.max(y2, pts[i + 1]); }
      const rel = pts.map((v, i) => round(v - (i % 2 ? y1 : x1)));
      addItem({ t: 'stroke', x: x1, y: y1, w: Math.max(1, round(x2 - x1)), h: Math.max(1, round(y2 - y1)), z: topZ(false), c: lastInk, pts: rel });
    }
    if (d.kind === 'resize' || d.kind === 'move' || d.kind === 'end') undo.stopCapturing();
    paintOverlay();
  }
  root.addEventListener('pointerup', endPointer);
  root.addEventListener('pointercancel', endPointer);
  root.addEventListener('pointerleave', e => { if (e.pointerType !== 'touch' && !drag) publish('cursor', null); });

  root.addEventListener('wheel', e => {
    e.preventDefault();
    viewed = true;
    const unit = e.deltaMode === 1 ? 16 : 1;
    if (e.ctrlKey || e.metaKey) zoomAt(view.z * Math.exp(-e.deltaY * unit * 0.01), local2(e.clientX, e.clientY));
    else {
      view.x -= (e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX) * unit;
      view.y -= (e.shiftKey && !e.deltaX ? 0 : e.deltaY) * unit;
      applyView();
    }
  }, { passive: false });

  // Safari: Zwei-Finger-Zoom auf dem Trackpad kommt als gesture*-Ereignis.
  let gestureZ = 1;
  root.addEventListener('gesturestart', e => { e.preventDefault(); gestureZ = view.z; });
  root.addEventListener('gesturechange', e => {
    e.preventDefault();
    const g = e as unknown as { scale: number; clientX: number; clientY: number };
    if (pointers.size < 2) zoomAt(gestureZ * g.scale, local2(g.clientX, g.clientY));
  });

  // ── Tastatur, Zwischenablage ──────────────────────────────────────────────

  const typingElsewhere = (e: Event) => {
    const t = e.target as HTMLElement | null;
    return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable) || !!document.querySelector('dialog[open]');
  };

  addEventListener('keydown', e => {
    if (editing || typingElsewhere(e)) return;
    const mod = e.metaKey || e.ctrlKey;
    const key = e.key.toLowerCase();
    if (e.key === ' ' && !spaceDown) { spaceDown = true; root.classList.add('is-space'); e.preventDefault(); return; }
    if (mod && (key === '=' || key === '+')) { e.preventDefault(); zoomAt(view.z * 1.25); return; }
    if (mod && key === '-') { e.preventDefault(); zoomAt(view.z / 1.25); return; }
    if (mod && key === '0') { e.preventDefault(); zoomAt(1); return; }
    if (e.shiftKey && (e.code === 'Digit1')) { e.preventDefault(); fitAll(); return; }
    if (e.key === 'Escape') { if (following !== null) stopFollow(); select([]); setTool('select'); return; }
    if (!canEdit) return;
    if (mod && key === 'z') { e.preventDefault(); if (e.shiftKey) undo.redo(); else undo.undo(); return; }
    if (mod && key === 'y') { e.preventDefault(); undo.redo(); return; }
    if (mod && key === 'a') { e.preventDefault(); select(cache.keys()); return; }
    if (mod && key === 'd') { e.preventDefault(); duplicate(); return; }
    if (mod) return;
    if (e.key === 'Backspace' || e.key === 'Delete') { e.preventDefault(); removeSelected(); return; }
    if (e.key === 'Enter' && selected.size === 1) {
      const id = [...selected][0];
      if (TEXTUAL.has(cache.get(id)?.t || '')) { e.preventDefault(); startEdit(id, false); }
      return;
    }
    if (e.key.startsWith('Arrow') && selected.size) {
      e.preventDefault();
      const step = e.shiftKey ? 10 : 1;
      const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
      const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
      const orig = moveSet();
      patchMany([...orig.values()].map(it => (it.t === 'arrow'
        ? [it.id, { fx: (it.fx ?? 0) + dx, fy: (it.fy ?? 0) + dy, tx: (it.tx ?? 0) + dx, ty: (it.ty ?? 0) + dy }]
        : [it.id, { x: it.x + dx, y: it.y + dy }])));
      return;
    }
    const shortcut = TOOLS.find(([, , k]) => k.toLowerCase() === key);
    if (shortcut && !e.altKey) {
      e.preventDefault();
      if (shortcut[0] === 'image') pickImage(); else setTool(shortcut[0]);
    }
  });
  addEventListener('keyup', e => {
    if (e.key === ' ') { spaceDown = false; root.classList.remove('is-space'); }
  });
  addEventListener('blur', () => { spaceDown = false; root.classList.remove('is-space'); });

  const CLIP = 'data-md-board';
  let memoryClip: Item[] | null = null;

  function writeClip(e: ClipboardEvent): boolean {
    if (!selected.size || !e.clipboardData) return false;
    const list = snapshot(selected);
    memoryClip = list;
    const plain = list.filter(i => i.text?.trim()).sort((a, b) => a.y - b.y || a.x - b.x).map(i => i.text!.trim()).join('\n');
    const json = JSON.stringify(list).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
    const esc = plain.replace(/&/g, '&amp;').replace(/</g, '&lt;');
    e.clipboardData.setData('text/plain', plain);
    e.clipboardData.setData('text/html', `<div ${CLIP}="${json}">${esc.replace(/\n/g, '<br>')}</div>`);
    e.preventDefault();
    return true;
  }

  addEventListener('copy', e => { if (!editing && !typingElsewhere(e)) writeClip(e); });
  addEventListener('cut', e => { if (!editing && !typingElsewhere(e) && canEdit && writeClip(e)) removeSelected(); });
  addEventListener('paste', e => {
    if (editing || typingElsewhere(e) || !canEdit || !e.clipboardData) return;
    const files = [...e.clipboardData.files].filter(f => f.type.startsWith('image/'));
    const at = lastPointer && contains({ x: -view.x / view.z, y: -view.y / view.z, w: root.clientWidth / view.z, h: root.clientHeight / view.z }, lastPointer) ? lastPointer : viewCenter();
    if (files.length) { e.preventDefault(); placeImages(files, at); return; }
    const html = e.clipboardData.getData('text/html');
    let list: Item[] | null = null;
    const m = new RegExp(`${CLIP}="([^"]*)"`).exec(html);
    if (m) {
      try { list = JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&amp;/g, '&')); } catch { list = null; }
    } else if (memoryClip && e.clipboardData.getData('text/plain') === memoryClip.filter(i => i.text?.trim()).sort((a, b) => a.y - b.y || a.x - b.x).map(i => i.text!.trim()).join('\n') && memoryClip.length) {
      list = memoryClip;
    }
    e.preventDefault();
    if (list?.length) {
      const b = union(list.map(i => (i.t === 'arrow' ? rectOf({ x: i.fx ?? 0, y: i.fy ?? 0 }, { x: i.tx ?? 0, y: i.ty ?? 0 }) : { x: i.x, y: i.y, w: i.w, h: i.h }))) || { x: 0, y: 0, w: 0, h: 0 };
      const ids = insertCopies(list, round(at.x - (b.x + b.w / 2)), round(at.y - (b.y + b.h / 2)));
      flushNow();
      select(ids);
      return;
    }
    pasteText(e.clipboardData.getData('text/plain'), at);
  });

  /** Eingefügter Text: jede Zeile eine Notiz, im Raster. */
  function pasteText(raw: string, at: Pt) {
    const lines = raw.split(/\r?\n/).map(l => l.replace(/^\s*(?:[-*+•]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/, '').trim()).filter(Boolean).slice(0, 100);
    if (!lines.length) return;
    const cols = Math.ceil(Math.sqrt(lines.length));
    const gap = 20, step = NOTE + gap;
    const rows = Math.ceil(lines.length / cols);
    const x0 = at.x - (cols * step - gap) / 2, y0 = at.y - (rows * step - gap) / 2;
    let z = topZ(false);
    const ids: string[] = [];
    tx(() => {
      lines.forEach((text, i) => {
        const id = rid();
        const m = new Y.Map<unknown>();
        const fields: Omit<Item, 'id'> = { t: 'note', x: round(x0 + (i % cols) * step), y: round(y0 + Math.floor(i / cols) * step), w: NOTE, h: NOTE, z: z++, c: lastNote, text };
        for (const [k, v] of Object.entries(fields)) m.set(k, v);
        items.set(id, m);
        ids.push(id);
      });
    });
    flushNow();
    select(ids);
  }

  // ── Bilder ────────────────────────────────────────────────────────────────

  async function placeImages(files: File[], at: Pt) {
    const images = files.filter(f => f.type.startsWith('image/'));
    if (!images.length || !canEdit) return;
    if (!created && !(await (creating ?? o.ensureCreated()))) return;
    created = true;
    if (provider.status === 'offline' && !provider.ws) provider.connect();
    let x = at.x;
    const ids: string[] = [];
    for (const file of images) {
      try {
        const size = await createImageBitmap(file, { imageOrientation: 'from-image' })
          .then(b => { const s = { w: b.width, h: b.height }; b.close(); return s; }, () => ({ w: 400, h: 300 }));
        const url = await uploadImage(o.id, file, o.auth());
        const nw = size.w || 400, nh = size.h || 300;
        const scale = Math.min(1, 480 / Math.max(nw, nh));
        const w = round(nw * scale), h = round(nh * scale);
        const id = addItem({ t: 'image', x: round(x - w / 2), y: round(at.y - h / 2), w, h, z: topZ(false), src: url });
        if (id) ids.push(id);
        x += w + 24;
      } catch (err) {
        o.toast((err as Error).message);
      }
    }
    flushNow();
    if (ids.length) select(ids);
  }

  root.addEventListener('dragover', e => {
    if ([...(e.dataTransfer?.types || [])].includes('Files')) { e.preventDefault(); e.stopPropagation(); }
  });
  root.addEventListener('drop', e => {
    const files = [...(e.dataTransfer?.files || [])];
    if (!files.length) return;
    e.preventDefault();
    e.stopPropagation();
    placeImages(files, toWorld(local2(e.clientX, e.clientY)));
  });

  // ── Abstimmen ─────────────────────────────────────────────────────────────

  const currentVote = () => meta.get('vote') as Vote | undefined;
  const voteActive = () => !!currentVote()?.active;

  function myVotes(): Map<string, number> {
    const v = currentVote();
    const out = new Map<string, number>();
    if (!v) return out;
    votes.forEach((n, key) => {
      const [vid, item, who] = key.split('|');
      if (vid === v.id && who === voter && n > 0 && cache.has(item)) out.set(item, n);
    });
    return out;
  }
  const votesLeft = () => {
    const v = currentVote();
    if (!v) return 0;
    let used = 0;
    for (const n of myVotes().values()) used += n;
    return Math.max(0, v.per - used);
  };

  function castVote(item: string, delta: number) {
    const v = currentVote();
    if (!v?.active || !canEdit) return;
    const key = `${v.id}|${item}|${voter}`;
    const cur = votes.get(key) || 0;
    if (delta > 0 && votesLeft() <= 0) { o.toast('Keine Stimmen mehr übrig.'); return; }
    const next = Math.max(0, cur + delta);
    ydoc.transact(() => { if (next) votes.set(key, next); else votes.delete(key); }, 'vote');
    renderControls();
  }

  let counts = new Map<string, number>();
  function drawVotes(node: HTMLElement, it: Item) {
    const box = node.querySelector<HTMLElement>('.b-votes');
    if (!box) return;
    const v = currentVote();
    box.replaceChildren();
    if (!v) return;
    if (v.active) {
      const mine = votes.get(`${v.id}|${it.id}|${voter}`) || 0;
      for (let i = 0; i < Math.min(mine, 12); i++) {
        const dot = el('span', { class: 'b-dot', title: 'Stimme zurücknehmen' });
        dot.style.background = myColor;
        box.append(dot);
      }
    } else if (v.show) {
      const n = counts.get(it.id) || 0;
      if (n) box.append(el('span', { class: 'b-count', title: `${n} ${n === 1 ? 'Stimme' : 'Stimmen'}` }, String(n)));
    }
  }
  const refreshCounts = () => { const v = currentVote(); counts = v && v.show && !v.active ? voteCounts(ydoc, v.id) : new Map(); };
  votes.observe(refreshCounts);
  meta.observe(refreshCounts);

  function startVote(per: number) {
    meta.set('vote', { id: rid(), per, active: true, show: false } satisfies Vote);
    select([]);
  }

  // ── Timer ─────────────────────────────────────────────────────────────────

  const currentTimer = () => meta.get('timer') as Timer | null | undefined;
  let timerTick: ReturnType<typeof setInterval> | null = null;
  let wasRunning = false;

  function timerText(t: Timer): string {
    const left = Math.max(0, Math.ceil((t.end - Date.now()) / 1000));
    return `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
  }

  function tickTimer() {
    const t = currentTimer();
    if (!t) { timerBtn.textContent = 'Timer'; timerBtn.dataset.state = ''; wasRunning = false; stopTick(); return; }
    const left = t.end - Date.now();
    if (left > 0) {
      timerBtn.textContent = timerText(t);
      timerBtn.dataset.state = 'running';
      wasRunning = true;
    } else {
      if (wasRunning) { chime(); o.toast('Die Zeit ist um.'); }
      wasRunning = false;
      timerBtn.textContent = left > -60_000 ? '0:00' : 'Timer';
      timerBtn.dataset.state = left > -60_000 ? 'done' : '';
      if (left <= -60_000) stopTick();
    }
  }
  const stopTick = () => { if (timerTick) { clearInterval(timerTick); timerTick = null; } };

  function startTimer(min: number) {
    meta.set('timer', { end: Date.now() + min * 60_000, dur: min * 60_000 } satisfies Timer);
  }

  // ── Kopfleiste: Titel, Timer, Abstimmen ───────────────────────────────────

  const titleInput = el('input', { type: 'text', class: 'board-title', placeholder: 'Board', 'aria-label': 'Titel', spellcheck: 'false', maxlength: '120' }) as HTMLInputElement;
  const sizeTitle = () => { titleInput.size = Math.max(5, Math.min(40, (titleInput.value || titleInput.placeholder).length + 1)); };
  function syncTitle() {
    const t = String(meta.get('title') || '');
    if (document.activeElement !== titleInput && titleInput.value !== t) titleInput.value = t;
    sizeTitle();
    o.onTitle(t);
  }
  titleInput.addEventListener('input', () => { if (canEdit) meta.set('title', titleInput.value); sizeTitle(); });
  titleInput.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === 'Escape') { e.preventDefault(); titleInput.blur(); root.focus(); } });
  sizeTitle();

  const controls = el('div', { class: 'board-controls' });
  const timerBtn = el('button', { type: 'button', class: 't b-timer', title: 'Timer für alle' }, 'Timer');
  const voteBtn = el('button', { type: 'button', class: 't b-vote', title: 'Abstimmen mit Punkten' }, 'Abstimmen');
  controls.append(timerBtn, voteBtn);

  timerBtn.addEventListener('click', () => {
    if (!canEdit) return;
    const t = currentTimer();
    const running = !!t && t.end > Date.now();
    menu('right', running
      ? [['+1 Minute', () => meta.set('timer', { ...t!, end: t!.end + 60_000 })], ['Timer stoppen', () => meta.set('timer', null)]]
      : [1, 3, 5, 10, 15].map(m => [`${m} ${m === 1 ? 'Minute' : 'Minuten'}`, () => startTimer(m)] as [string, () => void]));
  });

  voteBtn.addEventListener('click', () => {
    if (!canEdit) return;
    const v = currentVote();
    const fresh = [3, 5, 10].map(n => [`${v ? 'Neu: ' : ''}${n} Stimmen pro Person`, () => startVote(n)] as [string, () => void]);
    if (v?.active) menu('right', [['Abstimmung beenden', () => meta.set('vote', { ...v, active: false, show: true })]]);
    else if (v?.show) menu('right', [['Ergebnis ausblenden', () => meta.set('vote', { ...v, show: false })], ...fresh]);
    else menu('right', fresh);
  });

  function renderControls() {
    const v = currentVote();
    root.classList.toggle('is-voting', !!v?.active && canEdit);
    if (v?.active) { voteBtn.textContent = `Noch ${votesLeft()} ${votesLeft() === 1 ? 'Stimme' : 'Stimmen'}`; voteBtn.dataset.state = 'running'; }
    else if (v?.show) { voteBtn.textContent = 'Ergebnis'; voteBtn.dataset.state = ''; }
    else { voteBtn.textContent = 'Abstimmen'; voteBtn.dataset.state = ''; }
    voteBtn.hidden = !canEdit && !v?.active && !v?.show;
    timerBtn.hidden = !canEdit && !currentTimer();
    if (currentTimer() && !timerTick) timerTick = setInterval(tickTimer, 250);
    tickTimer();
    paintOverlay();
  }
  votes.observe(() => renderControls());

  // ── Anwesenheit: Cursor, Folgen, alle holen ───────────────────────────────

  let awPending: Record<string, unknown> = {};
  let awTimer: ReturnType<typeof setTimeout> | null = null;
  function publish(field: string, value: unknown) {
    awPending[field] = value;
    if (awTimer) return;
    awTimer = setTimeout(() => {
      awTimer = null;
      awareness.setLocalState({ ...(awareness.getLocalState() || {}), ...awPending });
      awPending = {};
    }, 50);
  }

  interface PeerState { user?: { name?: string; color?: string }; cursor?: Pt | null; sel?: string[]; view?: Box; summon?: number }
  const cursorNodes = new Map<number, HTMLElement>();
  const peerSel = new Map<string, string>();
  const loadedAt = Date.now();
  const seenSummon = new Map<number, number>();
  let following: number | null = null;

  awareness.on('change', () => {
    const states = awareness.getStates() as Map<number, PeerState>;
    peers = [...states.entries()]
      .filter(([client, st]) => client !== ydoc.clientID && st.user)
      .map(([client, st]) => ({ name: String(st.user!.name || 'Gast'), color: String(st.user!.color || '#888'), id: client }));
    report();

    // Auswahl der anderen
    for (const id of peerSel.keys()) nodes.get(id)?.classList.remove('peer-sel');
    peerSel.clear();
    for (const [client, st] of states) {
      if (client === ydoc.clientID) continue;
      for (const id of st.sel || []) peerSel.set(id, st.user?.color || '#888');
      // Jemand holt alle zu sich.
      if (st.summon && st.summon > loadedAt && st.summon !== seenSummon.get(client)) {
        seenSummon.set(client, st.summon);
        if (Date.now() - st.summon < 15_000) { follow(client); o.toast(`${st.user?.name || 'Gast'} holt alle zu sich.`); }
      }
    }
    for (const [id, color] of peerSel) {
      const n = nodes.get(id);
      if (n) { n.classList.add('peer-sel'); n.style.setProperty('--pc', color); }
    }
    if (following !== null) {
      if (!states.has(following)) stopFollow();
      else applyFollow();
    }
    paintCursors();
  });

  function paintCursors() {
    const states = awareness.getStates() as Map<number, PeerState>;
    const seen = new Set<number>();
    for (const [client, st] of states) {
      if (client === ydoc.clientID || !st.cursor || !st.user) continue;
      seen.add(client);
      let n = cursorNodes.get(client);
      if (!n) {
        n = el('div', { class: 'b-cursor' });
        n.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 1.5l11 6.2-4.6 1.1L6.3 13z"/></svg><span></span>';
        cursorNodes.set(client, n);
        cursors.append(n);
      }
      n.style.setProperty('--pc', st.user.color || '#888');
      n.querySelector('span')!.textContent = st.user.name || 'Gast';
      const p = toScreen(st.cursor);
      n.style.transform = `translate(${p.x}px, ${p.y}px)`;
      n.hidden = p.x < -20 || p.y < -20 || p.x > root.clientWidth + 20 || p.y > root.clientHeight + 20;
    }
    for (const [client, n] of cursorNodes) if (!seen.has(client)) { n.remove(); cursorNodes.delete(client); }
  }

  function follow(client: number) {
    if (client === ydoc.clientID) return;
    following = client;
    const st = (awareness.getStates() as Map<number, PeerState>).get(client);
    const color = st?.user?.color || '#888';
    root.classList.add('is-following');
    root.style.setProperty('--fc', color);
    const stop = el('button', { type: 'button' }, 'Beenden');
    stop.addEventListener('click', stopFollow);
    followBar.replaceChildren(el('span', {}, `Du folgst ${st?.user?.name || 'Gast'}`), stop);
    applyFollow();
  }

  function stopFollow() {
    following = null;
    root.classList.remove('is-following');
    followBar.replaceChildren();
  }

  function applyFollow() {
    if (following === null) return;
    const v = (awareness.getStates() as Map<number, PeerState>).get(following)?.view;
    if (!v) return;
    const w = root.clientWidth, h = root.clientHeight;
    const z = clamp(Math.min(w / v.w, h / v.h), MIN_Z, MAX_Z);
    view = { z, x: w / 2 - v.x * z, y: h / 2 - v.y * z };
    applyView(false);
  }

  addEventListener('resize', () => { applyView(false); applyFollow(); });

  // ── Start ─────────────────────────────────────────────────────────────────

  function setEditable(on: boolean) {
    canEdit = on;
    root.classList.toggle('is-readonly', !on);
    titleInput.readOnly = !on;
    if (!on) { endEdit(); select([]); setTool('select'); }
    renderCtx();
    renderControls();
  }

  setEditable(canEdit);
  applyView(false);
  syncTitle();
  requestAnimationFrame(() => root.focus({ preventScroll: true }));

  return {
    titleInput,
    controls,
    markdown: () => boardMarkdown(ydoc),
    title: () => String(meta.get('title') || '').trim(),
    setEditable,
    setName(name: string) {
      myName = name || 'Gast';
      awareness.setLocalStateField('user', { name: myName, color: myColor });
    },
    follow,
    summon() {
      publish('summon', Date.now());
      o.toast('Alle folgen dir jetzt.');
    },
    peerCount: () => peers.length,
    /** Anderswo angelegt (Teilen → Bearbeiten-Link): jetzt verbinden. */
    markCreated() {
      if (created) return;
      created = true;
      creating = Promise.resolve(true);
      provider.connect();
    },
    reconnect() {
      if (!created) return;
      provider.disconnect();
      provider.connect();
    },
    async print() {
      flushNow();
      if (!cache.size) { o.toast('Noch leer.'); return; }
      await Promise.all([...root.querySelectorAll('img')].map(i => i.decode().catch(() => {})));
      await document.fonts.ready;
      window.print();
    },
  };
}
