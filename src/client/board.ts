// Whiteboard: unendliche Fläche mit Notizen, Bereichen, Formen, Linien und
// Pfeilen (mit Wendepunkten), Text, Stift (druckempfindlich), Radierer,
// Laserpointer, Bildern und Videos. Gemeinsam über dasselbe Yjs/WebSocket wie die
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
//
// Stift-Modus (Apple Pencil o. ä.): schaltet sich beim ersten Stift-Strich
// ein. Dann zeichnet nur der Stift, Finger verschieben und zoomen, der
// Handballen stört nicht.

import * as Y from 'yjs';
import { Awareness } from 'y-protocols/awareness';
import { IndexeddbPersistence } from 'y-indexeddb';
import { getStroke } from 'perfect-freehand';
import { Provider } from './provider';
import { uploadImage } from './images';
import { el, store, menu, dialog } from './ui';
import { boardMarkdown, readItem, voteCounts, MAX_ITEMS, type Item, type Timer, type Vote } from '../shared/board';
import { videoOf, videoUrl, videoEmbed } from '../shared/video';
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

type Tool = 'select' | 'hand' | 'note' | 'frame' | 'shape' | 'line' | 'arrow' | 'text' | 'pen' | 'eraser' | 'laser';
interface Pt { x: number; y: number }
interface Box { x: number; y: number; w: number; h: number }

type Drag =
  | { kind: 'pan'; sx: number; sy: number; vx: number; vy: number; moved: boolean; tapId: string | null; tapPoly?: boolean }
  | { kind: 'move'; start: Pt; orig: Map<string, Item>; moved: boolean; clickId: string | null }
  | { kind: 'marquee'; start: Pt; base: Set<string> }
  | { kind: 'resize'; id: string; start: Pt; orig: Item }
  | { kind: 'create'; t: 'frame' | 'shape'; start: Pt; id: string | null }
  | { kind: 'arrow'; start: Pt; from: string | null; id: string | null; line: boolean }
  | { kind: 'end'; id: string; end: 'from' | 'to' }
  | { kind: 'wp'; id: string; i: number }
  | { kind: 'stroke'; pts: number[]; pr: number[] | null; node: HTMLElement; path: SVGPathElement }
  | { kind: 'erase'; last: Pt; doomed: Set<string> }
  | { kind: 'laser' };

/** Linie bzw. Pfeil, der gerade Punkt für Punkt gesetzt wird (Klick, Klick, …). */
interface Poly { id: string; fixed: Pt[] }

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
const VOTABLE = new Set(['note', 'shape', 'text', 'image', 'embed']);
const RESIZABLE = new Set(['note', 'frame', 'shape', 'image', 'text', 'embed']);
/** Seitenverhältnis bleibt beim Größerziehen. */
const KEEP_RATIO = new Set(['image', 'embed']);
/** Werkzeuge mit eigener Leiste für Farbe und Strich, solange nichts ausgewählt ist. */
const STYLED_TOOLS = new Set<Tool>(['shape', 'line', 'arrow', 'text', 'pen']);
/** Strichstärke 1–3 → Breite in px (Linien, Formen) bzw. Durchmesser (Stift, Marker). */
const LINE_W = [0, 1.25, 2, 4];
const PEN_W = [0, 2.5, 4.5, 9];
const MARKER_W = [0, 12, 20, 32];
/** Radierer: Radius in Bildschirm-px. */
const ERASER_R = 10;
const LASER_MS = 700;

const svgIcon = (d: string) => `<svg viewBox="0 0 20 20" aria-hidden="true">${d}</svg>`;
const ICON = {
  select: svgIcon('<path d="M5 3.5l10 6-4.5 1.2L8.6 15z"/>'),
  hand: svgIcon('<path d="M7 10V5a1.2 1.2 0 0 1 2.4 0v4M9.4 9V3.8a1.2 1.2 0 0 1 2.4 0V9M11.8 9V4.8a1.2 1.2 0 0 1 2.4 0V11c0 3.3-2 5.5-5 5.5-2.3 0-3.5-1.2-4.6-3.2L3 10.6a1.2 1.2 0 0 1 2-1.2L7 12"/>'),
  note: svgIcon('<path d="M4 4h12v8l-4 4H4z"/><path d="M16 12h-4v4"/>'),
  frame: svgIcon('<path d="M3 6.5h14M3 13.5h14M6.5 3v14M13.5 3v14"/>'),
  shape: svgIcon('<rect x="3" y="3" width="8.5" height="8.5" rx="1"/><circle cx="12.5" cy="12.5" r="4.5"/>'),
  arrow: svgIcon('<path d="M4 16L16 4M9 4h7v7"/>'),
  text: svgIcon('<path d="M4.5 5V3.8h11V5M10 3.8v12.4M7.8 16.2h4.4"/>'),
  line: svgIcon('<path d="M3.5 15.5l5-7 4 4 4-8"/>'),
  pen: svgIcon('<path d="M3.5 16.5c2-.3 3-1 4-2l8-8a1.8 1.8 0 0 0-2.5-2.5l-8 8c-1 1-1.7 2-2 4z"/>'),
  eraser: svgIcon('<path d="M8 16.5h8.5M11.5 4.2l4.3 4.3a1.3 1.3 0 0 1 0 1.8L9.6 16.5H6.4l-2.6-2.6a1.3 1.3 0 0 1 0-1.8l5.9-7.9a1.3 1.3 0 0 1 1.8 0zM6.7 8.6l5.7 5.7"/>'),
  laser: svgIcon('<circle cx="13" cy="7" r="2.6"/><path d="M3.5 16.5l7.3-7.3M13 2v1.3M13 10.7V12M18 7h-1.3M9.3 7H8M16.5 3.5l-.9.9M10.4 9.6l-.9.9M16.5 10.5l-.9-.9"/>'),
  insert: svgIcon('<rect x="3" y="3" width="14" height="14" rx="2"/><path d="M10 6.5v7M6.5 10h7"/>'),
  image: svgIcon('<rect x="3" y="4" width="14" height="12" rx="1.5"/><circle cx="7.5" cy="8.3" r="1.3"/><path d="M3.5 14.5l4-4 3 3 2-2 4 3.5"/>'),
  camera: svgIcon('<path d="M3 7.2A1.7 1.7 0 0 1 4.7 5.5h1.8L8 3.5h4l1.5 2h1.8A1.7 1.7 0 0 1 17 7.2v7.1a1.7 1.7 0 0 1-1.7 1.7H4.7A1.7 1.7 0 0 1 3 14.3z"/><circle cx="10" cy="10.5" r="3"/>'),
  video: svgIcon('<rect x="2.5" y="4.5" width="15" height="11" rx="2.5"/><path d="M8.5 7.6v4.8l4-2.4z" class="fill"/>'),
  penmode: svgIcon('<path d="M9.5 16.5c1.6-.3 2.5-.9 3.3-1.7l4-4a1.6 1.6 0 0 0-2.2-2.2l-4 4c-.8.8-1.4 1.7-1.7 3.3z"/><path d="M6 12.5V5.2a1 1 0 0 1 2 0V10M8 9.5V3.8a1 1 0 0 1 2 0V8.6M4 9.4a1 1 0 0 1 2 0v3.6c0 2 .8 3.5 2.3 3.5"/>'),
  check: svgIcon('<path d="M4.5 10.5l3.5 3.5 7.5-8"/>'),
  style: svgIcon('<path d="M3.5 5h13" stroke-width="1"/><path d="M3.5 10h13" stroke-width="2"/><path d="M3.5 15.5h13" stroke-width="3.2"/>'),
  w1: svgIcon('<path d="M4 10h12" stroke-width="1"/>'),
  w2: svgIcon('<path d="M4 10h12" stroke-width="2.2"/>'),
  w3: svgIcon('<path d="M4 10h12" stroke-width="4"/>'),
  solid: svgIcon('<path d="M3.5 10h13"/>'),
  dash: svgIcon('<path d="M3.5 10h3M8.5 10h3M13.5 10h3"/>'),
  dot: svgIcon('<path d="M4 10h.01M7 10h.01M10 10h.01M13 10h.01M16 10h.01" stroke-width="2.2"/>'),
  hdNone: svgIcon('<path d="M3.5 10h13"/>'),
  hdEnd: svgIcon('<path d="M3.5 10h13M12.5 6l4 4-4 4"/>'),
  external: svgIcon('<path d="M11 3.5h5.5V9M16.5 3.5L9 11M14 11.5v4a1 1 0 0 1-1 1H4.5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h4"/>'),
  stop: svgIcon('<rect x="5" y="5" width="10" height="10" rx="1.5" class="fill"/>'),
  hdBoth: svgIcon('<path d="M3.5 10h13M12.5 6l4 4-4 4M7.5 6l-4 4 4 4"/>'),
  sharp: svgIcon('<path d="M3.5 15l5-9 3 8 5-8"/>'),
  curve: svgIcon('<path d="M3.5 15c2-9 4-9 5.5-4.5S13 14 16.5 6"/>'),
  pencil: svgIcon('<path d="M3.5 16.5c2-.3 3-1 4-2l8-8a1.8 1.8 0 0 0-2.5-2.5l-8 8c-1 1-1.7 2-2 4z"/>'),
  marker: svgIcon('<path d="M5 15l2.5-6.5 4.5 4.5zM7.5 8.5l5-5 4 4-5 5M3.5 17h6" /><path d="M5 15l2.5-6.5 4.5 4.5z" class="fill"/>'),
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

const TOOLS: [Tool | 'insert', string, string][] = [
  ['select', 'Auswählen', 'V'],
  ['hand', 'Verschieben', 'H'],
  ['note', 'Notiz', 'N'],
  ['frame', 'Bereich', 'F'],
  ['shape', 'Form', 'R'],
  ['line', 'Linie', 'L'],
  ['arrow', 'Pfeil', 'A'],
  ['text', 'Text', 'T'],
  ['pen', 'Stift', 'P'],
  ['eraser', 'Radierer', 'E'],
  ['laser', 'Laserpointer', 'K'],
  ['insert', 'Einfügen', 'I'],
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

/** Mittellinie eines Strichs (zum Treffen und Hervorheben). */
function strokePath(pts: number[]): string {
  if (pts.length < 4) return `M${pts[0]} ${pts[1]}l.01 0`;
  let d = `M${pts[0]} ${pts[1]}`;
  for (let i = 2; i < pts.length - 2; i += 2) {
    d += `Q${pts[i]} ${pts[i + 1]} ${round((pts[i] + pts[i + 2]) / 2)} ${round((pts[i + 1] + pts[i + 3]) / 2)}`;
  }
  return d + `L${pts[pts.length - 2]} ${pts[pts.length - 1]}`;
}

/** Umriss aus perfect-freehand → SVG-Pfad (geglättet). */
function outlinePath(outline: number[][]): string {
  const n = outline.length;
  if (n < 2) return '';
  const r = (v: number) => Math.round(v * 100) / 100;
  let d = `M${r(outline[0][0])} ${r(outline[0][1])}Q`;
  for (let i = 0; i < n; i++) {
    const [x0, y0] = outline[i];
    const [x1, y1] = outline[(i + 1) % n];
    d += `${r(x0)} ${r(y0)} ${r((x0 + x1) / 2)} ${r((y0 + y1) / 2)} `;
  }
  return d + 'Z';
}

/** Freihand-Strich als gefüllte Fläche: mit Stiftdruck, sonst aus dem Tempo. */
function inkPath(pts: number[], pr: number[] | null | undefined, sw: number, marker: boolean, done: boolean): string {
  const input: number[][] = [];
  for (let i = 0; i < pts.length; i += 2) input.push(pr ? [pts[i], pts[i + 1], pr[i / 2] ?? 0.5] : [pts[i], pts[i + 1]]);
  if (input.length === 1) input.push([input[0][0] + 0.01, input[0][1], input[0][2] ?? 0.5]);
  const outline = getStroke(input, marker
    ? { size: MARKER_W[sw] || MARKER_W[2], thinning: 0, smoothing: 0.6, streamline: 0.45, simulatePressure: false, last: done }
    : { size: PEN_W[sw] || PEN_W[2], thinning: pr ? 0.65 : 0.5, smoothing: 0.6, streamline: pr ? 0.35 : 0.5, simulatePressure: !pr, last: done,
      start: { taper: false, cap: true }, end: { taper: false, cap: true } });
  return outlinePath(outline);
}

/** Catmull-Rom → kubische Bézier-Stücke durch alle Punkte. */
function curveSegments(p: Pt[]): [Pt, Pt, Pt, Pt][] {
  const out: [Pt, Pt, Pt, Pt][] = [];
  for (let i = 0; i < p.length - 1; i++) {
    const p0 = p[i - 1] || p[i], p1 = p[i], p2 = p[i + 1], p3 = p[i + 2] || p2;
    out.push([p1, { x: p1.x + (p2.x - p0.x) / 6, y: p1.y + (p2.y - p0.y) / 6 }, { x: p2.x - (p3.x - p1.x) / 6, y: p2.y - (p3.y - p1.y) / 6 }, p2]);
  }
  return out;
}
const bezierAt = ([a, b, c, d]: [Pt, Pt, Pt, Pt], t: number): Pt => {
  const u = 1 - t;
  return {
    x: u * u * u * a.x + 3 * u * u * t * b.x + 3 * u * t * t * c.x + t * t * t * d.x,
    y: u * u * u * a.y + 3 * u * u * t * b.y + 3 * u * t * t * c.y + t * t * t * d.y,
  };
};

/** Abstand Punkt–Strecke. */
function segDist(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len = dx * dx + dy * dy;
  const t = len ? clamp(((p.x - a.x) * dx + (p.y - a.y) * dy) / len, 0, 1) : 0;
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** Winkel auf 15°-Schritte einrasten (mit Shift). */
function snapAngle(from: Pt, to: Pt): Pt {
  const len = Math.hypot(to.x - from.x, to.y - from.y);
  const step = Math.PI / 12;
  const ang = Math.round(Math.atan2(to.y - from.y, to.x - from.x) / step) * step;
  return { x: from.x + Math.cos(ang) * len, y: from.y + Math.sin(ang) * len };
}

const pairs = (flat: number[] | undefined): Pt[] => {
  const out: Pt[] = [];
  if (flat) for (let i = 0; i + 1 < flat.length; i += 2) out.push({ x: flat[i], y: flat[i + 1] });
  return out;
};
const flat = (list: Pt[]): number[] => list.flatMap(p => [round(p.x), round(p.y)]);

/** Pfeil/Linie um dx/dy verschieben (Enden und Wendepunkte). */
function shiftArrow(it: Item, dx: number, dy: number): Partial<Item> {
  return {
    fx: round((it.fx ?? 0) + dx), fy: round((it.fy ?? 0) + dy), tx: round((it.tx ?? 0) + dx), ty: round((it.ty ?? 0) + dy),
    wp: it.wp?.length ? it.wp.map((v, i) => round(v + (i % 2 ? dy : dx))) : undefined,
  };
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
  const wpLayer = el('div', { class: 'b-wps' });
  const ctxBar = el('div', { class: 'b-ctx', role: 'toolbar', 'aria-label': 'Auswahl' });
  const styleBar = el('div', { class: 'b-ctx b-ctx-sub', role: 'toolbar', 'aria-label': 'Strich' });
  overlay.append(selBox, handle, endA, endB, wpLayer, marquee, cursors, ctxBar, styleBar);
  const tools = el('div', { class: 'b-tools', role: 'toolbar', 'aria-label': 'Werkzeuge' });
  const zoomBar = el('div', { class: 'b-zoom' });
  const followBar = el('div', { class: 'b-follow' });
  root.append(world, overlay, tools, zoomBar, followBar);
  o.parent.append(root);

  const fileInput = el('input', { type: 'file', accept: 'image/*', multiple: '' }) as HTMLInputElement;
  const cameraInput = el('input', { type: 'file', accept: 'image/*', capture: 'environment' }) as HTMLInputElement;
  for (const input of [fileInput, cameraInput]) {
    input.addEventListener('change', () => {
      const files = [...(input.files || [])];
      input.value = '';
      placeImages(files, viewCenter());
    });
  }

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
    } else if (it.t === 'embed') {
      node.append(el('div', { class: 'b-embed-box' }), el('div', { class: 'b-votes' }));
    } else if (it.t === 'arrow' || it.t === 'stroke') {
      const s = svg('svg', { class: 'b-svg' });
      s.append(svg('path', { class: 'hit' }), svg('path', { class: 'line' }));
      if (it.t === 'arrow') s.append(svg('path', { class: 'head' }));
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
      const { w, h } = it;
      const key = `${kind}|${w}|${h}|${it.sw}|${it.ds}`;
      if (s.dataset.k !== key) {
        s.dataset.k = key;
        s.setAttribute('viewBox', `0 0 ${w} ${h}`);
        const sw = LINE_W[it.sw || 2] || 2;
        const shape = kind === 'ellipse'
          ? svg('ellipse', { cx: String(w / 2), cy: String(h / 2), rx: String(w / 2), ry: String(h / 2) })
          : kind === 'diamond'
            ? svg('path', { d: `M${w / 2} 0L${w} ${h / 2}L${w / 2} ${h}L0 ${h / 2}Z` })
            : svg('rect', { x: '0', y: '0', width: String(w), height: String(h), rx: '2' });
        shape.setAttribute('stroke-width', String(sw));
        if (it.ds) shape.setAttribute('stroke-dasharray', it.ds === 'dash' ? `${sw * 4 + 2} ${sw * 3 + 3}` : `0 ${sw * 2.5 + 2}`);
        s.replaceChildren(shape);
      }
    }
    if (it.t === 'image') {
      const img = node.querySelector('img')!;
      if (it.src && img.getAttribute('src') !== it.src) img.src = it.src;
    }
    if (it.t === 'stroke') {
      const key = `${it.pts?.length}|${it.sw}|${it.hl}|${it.pts?.[0]}|${it.pts?.[it.pts.length - 1]}`;
      if (node.dataset.k !== key) {
        node.dataset.k = key;
        const pts = it.pts?.length ? it.pts : [0, 0];
        node.querySelector('.hit')!.setAttribute('d', strokePath(pts));
        node.querySelector('.line')!.setAttribute('d', inkPath(pts, it.pr, it.sw || 2, !!it.hl, true));
      }
      node.classList.toggle('is-marker', !!it.hl);
    }
    if (it.t === 'arrow') drawArrow(node, it);
    if (it.t === 'embed') drawEmbed(node, it);
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

  function drawArrow(node: HTMLElement, it: Item) {
    const p = arrowPoints(it);
    const w = LINE_W[it.sw || 2] || 2;
    const r = (q: Pt) => `${round(q.x)} ${round(q.y)}`;
    let body: string;
    // Richtung an den Enden (für die Spitzen).
    let endFrom: Pt, startFrom: Pt;
    if (it.cv && p.length > 2) {
      const segs = curveSegments(p);
      body = `M${r(p[0])}` + segs.map(([, c1, c2, e]) => `C${r(c1)} ${r(c2)} ${r(e)}`).join('');
      endFrom = segs[segs.length - 1][2];
      startFrom = segs[0][1];
      if (Math.hypot(endFrom.x - p[p.length - 1].x, endFrom.y - p[p.length - 1].y) < 0.5) endFrom = p[p.length - 2];
      if (Math.hypot(startFrom.x - p[0].x, startFrom.y - p[0].y) < 0.5) startFrom = p[1];
    } else {
      body = `M${r(p[0])}` + p.slice(1).map(q => `L${r(q)}`).join('');
      endFrom = p[p.length - 2];
      startFrom = p[1];
    }
    const headAt = (tip: Pt, from: Pt) => {
      const len = Math.hypot(tip.x - from.x, tip.y - from.y);
      if (len < 0.5) return '';
      const ang = Math.atan2(tip.y - from.y, tip.x - from.x);
      const size = Math.min(10 + w * 2, len * 0.8);
      const h1 = { x: tip.x - size * Math.cos(ang - 0.45), y: tip.y - size * Math.sin(ang - 0.45) };
      const h2 = { x: tip.x - size * Math.cos(ang + 0.45), y: tip.y - size * Math.sin(ang + 0.45) };
      return `M${r(h1)}L${r(tip)}L${r(h2)}`;
    };
    const heads = (it.hd === 'none' ? '' : headAt(p[p.length - 1], endFrom)) + (it.hd === 'both' ? headAt(p[0], startFrom) : '');
    const line = node.querySelector('.line')!, head = node.querySelector('.head')!;
    line.setAttribute('d', body);
    head.setAttribute('d', heads);
    node.querySelector('.hit')!.setAttribute('d', body);
    node.style.setProperty('--sw', `${w}px`);
    line.setAttribute('stroke-dasharray', it.ds === 'dash' ? `${round(w * 4 + 2)} ${round(w * 3 + 3)}` : it.ds === 'dot' ? `0 ${round(w * 2.5 + 2)}` : '');
  }

  // ── Videos ────────────────────────────────────────────────────────────────

  /** Läuft (Player geladen); `liveEmbed` nimmt gerade Klicks an. */
  const playing = new Set<string>();
  let liveEmbed: string | null = null;

  function drawEmbed(node: HTMLElement, it: Item) {
    const v = it.src ? videoOf(it.src) : null;
    const box = node.querySelector<HTMLElement>('.b-embed-box')!;
    node.classList.toggle('is-live', liveEmbed === it.id);
    if (!v) { box.replaceChildren(); return; }
    const key = `${playing.has(it.id) ? 'play' : 'thumb'}|${v.kind}|${v.id}|${v.start || 0}`;
    if (box.dataset.k === key) return;
    box.dataset.k = key;
    if (playing.has(it.id)) {
      box.replaceChildren(el('iframe', {
        src: videoEmbed(v, true), allow: 'autoplay; fullscreen; picture-in-picture; encrypted-media',
        allowfullscreen: '', referrerpolicy: 'strict-origin-when-cross-origin', title: v.kind === 'youtube' ? 'YouTube' : 'Vimeo',
      }));
      return;
    }
    const play = el('button', { type: 'button', class: 'b-play', 'data-play': '', 'aria-label': 'Abspielen', title: 'Abspielen' });
    play.innerHTML = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M7 4.5v11l9-5.5z"/></svg>';
    const thumb = el('img', { alt: '', draggable: 'false', class: 'b-thumb' }) as HTMLImageElement;
    if (v.kind === 'youtube') thumb.src = `https://i.ytimg.com/vi/${v.id}/hqdefault.jpg`;
    else thumb.hidden = true;
    box.replaceChildren(thumb, el('span', { class: 'b-embed-kind' }, v.kind === 'youtube' ? 'YouTube' : 'Vimeo'), play);
  }

  function stopEmbed(id: string) {
    playing.delete(id);
    if (liveEmbed === id) liveEmbed = null;
    draw(id);
    renderCtx();
  }

  function playEmbed(id: string) {
    playing.add(id);
    liveEmbed = id;
    draw(id);
    renderCtx();
  }

  function releaseEmbed() {
    if (!liveEmbed) return;
    const id = liveEmbed;
    liveEmbed = null;
    if (cache.has(id)) draw(id);
  }

  /** Anfang, Wendepunkte, Ende – Enden an festgemachten Elementen auf deren Rand. */
  function arrowPoints(it: Item): Pt[] {
    const fromIt = it.from ? cache.get(it.from) : undefined;
    const toIt = it.to ? cache.get(it.to) : undefined;
    const fromBox = fromIt && fromIt.t !== 'arrow' ? bounds(fromIt) : null;
    const toBox = toIt && toIt.t !== 'arrow' ? bounds(toIt) : null;
    const mids = pairs(it.wp);
    let a: Pt = fromBox ? center(fromBox) : { x: it.fx ?? 0, y: it.fy ?? 0 };
    let b: Pt = toBox ? center(toBox) : { x: it.tx ?? 0, y: it.ty ?? 0 };
    if (fromBox) a = clipToBox(fromBox, mids[0] ?? b);
    if (toBox) b = clipToBox(toBox, mids[mids.length - 1] ?? a);
    return [a, ...mids, b];
  }

  function arrowEnds(it: Item): [Pt, Pt] {
    const p = arrowPoints(it);
    return [p[0], p[p.length - 1]];
  }

  function bounds(it: Item): Box {
    if (it.t === 'arrow') return union(arrowPoints(it).map(q => ({ x: q.x, y: q.y, w: 0, h: 0 })))!;
    if (it.t === 'text') {
      const h = nodes.get(it.id)?.offsetHeight;
      return { x: it.x, y: it.y, w: it.w, h: h || it.h };
    }
    return { x: it.x, y: it.y, w: it.w, h: it.h };
  }

  // ── Auswahl und Overlay ───────────────────────────────────────────────────

  let selected = new Set<string>();
  let drag: Drag | null = null;
  let poly: Poly | null = null;

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
    const lineEdit = arrowOnly && canEdit && !poly;
    show(selBox, !!box && !arrowOnly && !editing);
    show(handle, !!single && canEdit && RESIZABLE.has(single.t) && !editing && drag?.kind !== 'move');
    show(endA, lineEdit);
    show(endB, lineEdit);
    if (box) {
      const a = toScreen(box), z = view.z;
      Object.assign(selBox.style, { transform: `translate(${a.x - 4}px, ${a.y - 4}px)`, width: `${box.w * z + 8}px`, height: `${box.h * z + 8}px` });
      handle.style.transform = `translate(${a.x + box.w * z - 2}px, ${a.y + box.h * z - 2}px)`;
    }
    if (lineEdit) {
      const [p1, p2] = arrowEnds(single!).map(toScreen);
      endA.style.transform = `translate(${p1.x - 6}px, ${p1.y - 6}px)`;
      endB.style.transform = `translate(${p2.x - 6}px, ${p2.y - 6}px)`;
    }
    paintWaypoints(lineEdit && drag?.kind !== 'move' ? single : null);
    // Leiste zur Auswahl: über dem Rahmen, sonst darunter. Ohne Auswahl: Stil des Werkzeugs über den Werkzeugen.
    const toolMode = !box && STYLED_TOOLS.has(tool);
    const ctxOn = canEdit && !editing && ctxBar.childElementCount > 0 && !voteActive() && (box ? !drag : toolMode && (!drag || drag.kind === 'pan'));
    show(ctxBar, ctxOn);
    show(styleBar, ctxOn && styleOpen && styleBar.childElementCount > 0);
    if (ctxOn) {
      const w = ctxBar.offsetWidth, h = ctxBar.offsetHeight;
      let top: number, left: number;
      if (box) {
        const a = toScreen(box), b = toScreen({ x: box.x + box.w, y: box.y + box.h });
        top = a.y - h - 14;
        if (top < 8) top = b.y + 14;
        top = clamp(top, 8, root.clientHeight - h - 76);
        left = clamp((a.x + b.x) / 2 - w / 2, 8, root.clientWidth - w - 8);
      } else {
        const tr = tools.getBoundingClientRect(), rr = root.getBoundingClientRect();
        top = tr.top - rr.top - h - 8;
        left = clamp(tr.left - rr.left + tr.width / 2 - w / 2, 8, root.clientWidth - w - 8);
      }
      ctxBar.style.transform = `translate(${left}px, ${top}px)`;
      if (styleOpen && styleBar.childElementCount) {
        const sw = styleBar.offsetWidth, sh = styleBar.offsetHeight;
        let st = top - sh - 6;
        if (st < 8) st = top + h + 6;
        styleBar.style.transform = `translate(${clamp(left + w - sw, 8, root.clientWidth - sw - 8)}px, ${st}px)`;
      }
    }
    paintCursors();
  }

  // Griffe für Wendepunkte (ziehen, doppelt tippen entfernt) und dazwischen (ziehen fügt einen ein).
  const wpPool: HTMLElement[] = [];
  const midPool: HTMLElement[] = [];
  function placeHandles(pool: HTMLElement[], cls: string, kind: string, list: { p: Pt; i: number }[]) {
    while (pool.length < list.length) {
      const n = el('div', { class: `b-handle ${cls}`, 'data-handle': kind });
      wpLayer.append(n);
      pool.push(n);
    }
    pool.forEach((n, j) => {
      const h = list[j];
      n.style.display = h ? '' : 'none';
      if (!h) return;
      n.dataset.i = String(h.i);
      const s = toScreen(h.p);
      n.style.transform = `translate(${s.x}px, ${s.y}px)`;
    });
  }
  function paintWaypoints(it: Item | null) {
    const pts = it ? arrowPoints(it) : [];
    const wps = pts.slice(1, -1).map((p, i) => ({ p, i }));
    const mids: { p: Pt; i: number }[] = [];
    if (it) {
      const segs = it.cv && pts.length > 2 ? curveSegments(pts) : null;
      for (let k = 0; k < pts.length - 1; k++) {
        const a = toScreen(pts[k]), b = toScreen(pts[k + 1]);
        if (Math.hypot(b.x - a.x, b.y - a.y) < 40) continue;
        mids.push({ p: segs ? bezierAt(segs[k], 0.5) : { x: (pts[k].x + pts[k + 1].x) / 2, y: (pts[k].y + pts[k + 1].y) / 2 }, i: k });
      }
    }
    placeHandles(wpPool, 'b-wp', 'wp', wps);
    placeHandles(midPool, 'b-mid', 'mid', mids);
  }

  // ── Leiste zur Auswahl ────────────────────────────────────────────────────

  let lastNote = store.get('md:board:note') || 'yellow';
  let lastInk = store.get('md:board:ink') || 'fg';
  let lastWidth = Number(store.get('md:board:sw')) || 2;
  let lastDash = (store.get('md:board:ds') || undefined) as Item['ds'];
  let lastCurve = store.get('md:board:cv') === '1';
  let lastMarker = store.get('md:board:hl') === '1';
  let styleOpen = false;

  type StyleKey = 'sw' | 'ds' | 'hd' | 'cv' | 'hl';
  interface StyleOpt { v: string | number | undefined; icon: string; title: string }
  const STYLE: Record<StyleKey, StyleOpt[]> = {
    hl: [{ v: undefined, icon: ICON.pencil, title: 'Stift' }, { v: 1, icon: ICON.marker, title: 'Textmarker' }],
    sw: [{ v: 1, icon: ICON.w1, title: 'Dünn' }, { v: undefined, icon: ICON.w2, title: 'Mittel' }, { v: 3, icon: ICON.w3, title: 'Dick' }],
    ds: [{ v: undefined, icon: ICON.solid, title: 'Durchgezogen' }, { v: 'dash', icon: ICON.dash, title: 'Gestrichelt' }, { v: 'dot', icon: ICON.dot, title: 'Gepunktet' }],
    hd: [{ v: 'none', icon: ICON.hdNone, title: 'Ohne Spitze' }, { v: undefined, icon: ICON.hdEnd, title: 'Spitze am Ende' }, { v: 'both', icon: ICON.hdBoth, title: 'Spitzen an beiden Enden' }],
    cv: [{ v: undefined, icon: ICON.sharp, title: 'Ecken' }, { v: 1, icon: ICON.curve, title: 'Kurve' }],
  };
  const STYLE_KEYS: Record<string, StyleKey[]> = {
    stroke: ['hl', 'sw'], arrow: ['sw', 'ds', 'hd', 'cv'], shape: ['sw', 'ds'],
    pen: ['hl', 'sw'], line: ['sw', 'ds', 'cv'], 'tool-arrow': ['sw', 'ds', 'cv'], 'tool-shape': ['sw', 'ds'],
  };
  const defaults = (): Partial<Item> => ({ sw: lastWidth === 2 ? undefined : lastWidth, ds: lastDash, cv: lastCurve ? 1 : undefined, hl: lastMarker ? 1 : undefined });

  function setDefault(key: StyleKey, v: StyleOpt['v']) {
    if (key === 'sw') { lastWidth = (v as number) || 2; store.set('md:board:sw', String(lastWidth)); }
    if (key === 'ds') { lastDash = v as Item['ds']; store.set('md:board:ds', (v as string) || ''); }
    if (key === 'cv') { lastCurve = !!v; store.set('md:board:cv', v ? '1' : '0'); }
    if (key === 'hl') { lastMarker = !!v; store.set('md:board:hl', v ? '1' : '0'); }
  }

  function ctxButton(icon: string, title: string, run: () => void, pressed?: boolean): HTMLButtonElement {
    const b = el('button', { type: 'button', title, 'aria-label': title });
    b.innerHTML = icon;
    if (pressed !== undefined) b.setAttribute('aria-pressed', String(pressed));
    b.addEventListener('click', run);
    return b;
  }

  /** Knöpfe für Strichstärke, Strichart usw. – für Elemente oder (ohne) für neue. */
  function styleGroups(keys: StyleKey[], targets: Item[]): HTMLElement[] {
    return keys.map(key => {
      const fits = targets.filter(t => STYLE_KEYS[t.t]?.includes(key));
      const cur = new Set<unknown>(targets.length ? fits.map(t => t[key]) : [defaults()[key]]);
      return el('div', { class: 'b-ctx-group' }, ...STYLE[key].map(opt => ctxButton(opt.icon, opt.title, () => {
        if (fits.length) patchMany(fits.map(t => [t.id, { [key]: opt.v }]));
        if (key !== 'hd') setDefault(key, opt.v);
        renderCtx();
        paintOverlay();
      }, cur.size === 1 && cur.has(opt.v))));
    });
  }

  function renderCtx() {
    ctxBar.replaceChildren();
    styleBar.replaceChildren();
    if (!canEdit) return;
    let list = [...selected].map(id => cache.get(id)).filter((i): i is Item => !!i);
    const group = (...kids: HTMLElement[]) => ctxBar.append(el('div', { class: 'b-ctx-group' }, ...kids));
    const swatches = (colors: string[], targets: Item[], fallback: string, ink: boolean) => {
      const current = new Set(targets.length ? targets.map(t => t.c || fallback) : [ink ? lastInk : lastNote]);
      return colors.map(c => {
        const b = el('button', { type: 'button', class: `b-sw${ink ? ' ink' : ''}`, 'data-c': c, title: COLOR_NAMES[c], 'aria-label': COLOR_NAMES[c], 'aria-pressed': String(current.size === 1 && current.has(c)) });
        b.addEventListener('click', () => {
          patchMany(targets.map(t => [t.id, { c }]));
          if (ink) { lastInk = c; store.set('md:board:ink', c); } else { lastNote = c; store.set('md:board:note', c); }
          if (!targets.length) { renderCtx(); paintOverlay(); }
        });
        return b;
      });
    };
    const styleToggle = (keys: StyleKey[], targets: Item[]) => {
      if (!keys.length) return;
      group(ctxButton(ICON.style, 'Strich', () => { styleOpen = !styleOpen; renderCtx(); paintOverlay(); }, styleOpen));
      styleBar.append(...styleGroups(keys, targets));
    };

    // Ohne Auswahl: Farbe und Strich für das gewählte Werkzeug (bzw. die Linie, die gerade entsteht).
    if (!list.length) {
      if (!STYLED_TOOLS.has(tool)) return;
      const live = poly ? cache.get(poly.id) : undefined;
      if (live) list = [live];
      group(...swatches(INK_COLORS, list, 'fg', true));
      const keys = live ? STYLE_KEYS.arrow : STYLE_KEYS[tool === 'arrow' || tool === 'shape' ? `tool-${tool}` : tool] || [];
      if (tool === 'pen') ctxBar.append(...styleGroups(keys, list));
      else styleToggle(keys, list);
      if (live) group(ctxButton(ICON.check, 'Fertig (↵)', () => finishPoly()));
      return;
    }

    const notes = list.filter(i => i.t === 'note');
    const inked = list.filter(i => i.t === 'shape' || i.t === 'arrow' || i.t === 'stroke' || i.t === 'text');
    const shapes = list.filter(i => i.t === 'shape');
    if (notes.length) group(...swatches(NOTE_COLORS, notes, 'yellow', false));
    if (inked.length) group(...swatches(INK_COLORS, inked, 'fg', true));
    if (shapes.length) {
      const cur = new Set(shapes.map(s => s.s || 'rect'));
      group(...(['rect', 'ellipse', 'diamond'] as const).map(s =>
        ctxButton(ICON[s], { rect: 'Rechteck', ellipse: 'Ellipse', diamond: 'Raute' }[s], () => patchMany(shapes.map(t => [t.id, { s }])), cur.size === 1 && cur.has(s))));
    }
    const keys = (Object.keys(STYLE) as StyleKey[]).filter(k => list.some(i => STYLE_KEYS[i.t]?.includes(k)));
    styleToggle(keys, list);
    if (list.length === 1 && list[0].t === 'frame') group(ctxButton(ICON.rename, 'Umbenennen (↵)', () => startEdit(list[0].id)));
    if (list.length === 1 && list[0].t === 'embed') {
      const it = list[0];
      const v = it.src ? videoOf(it.src) : null;
      const kids: HTMLElement[] = [];
      if (v) kids.push(ctxButton(ICON.external, v.kind === 'youtube' ? 'Auf YouTube öffnen' : 'Auf Vimeo öffnen', () => window.open(videoUrl(v), '_blank', 'noopener')));
      if (playing.has(it.id)) kids.push(ctxButton(ICON.stop, 'Video beenden', () => stopEmbed(it.id)));
      if (kids.length) group(...kids);
    }
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
    b.addEventListener('click', () => (t === 'insert' ? insertMenu(b) : setTool(t)));
    if (t !== 'insert') toolButtons.set(t, b);
    tools.append(b);
    if (t === 'hand' || t === 'laser' || t === 'insert') tools.append(el('span', { class: `b-sep${t === 'laser' ? ' b-sep-laser' : ''}`, 'aria-hidden': 'true' }));
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
    closePop();
    if (poly && t !== 'select') finishPoly();
    tool = t;
    styleOpen = false;
    for (const [k, b] of toolButtons) b.setAttribute('aria-pressed', String(k === t));
    root.dataset.tool = t;
    if (t !== 'select' && t !== 'hand') select([]);
    else { renderCtx(); paintOverlay(); }
    if (t !== 'eraser') eraserRing.style.display = 'none';
  }

  // ── Einfügen: Bild, Foto, Video ───────────────────────────────────────────

  let pop: HTMLElement | null = null;
  function closePop() { pop?.remove(); pop = null; }
  const touchDevice = navigator.maxTouchPoints > 0;

  function insertMenu(anchor: HTMLElement) {
    if (pop) { closePop(); return; }
    if (!canEdit) return;
    const entries: [string, string, () => void][] = [[ICON.image, 'Bild', pickImage]];
    if (touchDevice) entries.push([ICON.camera, 'Foto aufnehmen', () => cameraInput.click()]);
    entries.push([ICON.video, 'Video', askVideo]);
    pop = el('div', { class: 'b-pop', role: 'menu' });
    for (const [icon, label, run] of entries) {
      const b = el('button', { type: 'button', role: 'menuitem' });
      b.innerHTML = icon;
      b.append(el('span', {}, label));
      b.addEventListener('click', () => { closePop(); run(); });
      pop.append(b);
    }
    root.append(pop);
    const ar = anchor.getBoundingClientRect(), rr = root.getBoundingClientRect();
    pop.style.left = `${clamp(ar.left - rr.left + ar.width / 2 - pop.offsetWidth / 2, 8, root.clientWidth - pop.offsetWidth - 8)}px`;
    pop.style.top = `${ar.top - rr.top - pop.offsetHeight - 8}px`;
  }

  function pickImage() {
    if (!canEdit) return;
    fileInput.click();
  }

  function askVideo() {
    const input = el('input', { type: 'url', placeholder: 'YouTube- oder Vimeo-Link', 'aria-label': 'Link', autocomplete: 'off', inputmode: 'url', required: '' }) as HTMLInputElement;
    const ok = el('button', { type: 'submit', class: 't boxed' }, 'Einbetten');
    const form = el('form', { class: 'sheet' }, el('div', { class: 'field-line' }, input, ok));
    const d = dialog('Video einbetten', form);
    input.addEventListener('input', () => input.setCustomValidity(''));
    form.addEventListener('submit', e => {
      e.preventDefault();
      const v = videoOf(input.value);
      if (!v) { input.setCustomValidity('Kein YouTube- oder Vimeo-Link'); input.reportValidity(); return; }
      d.close();
      placeVideo(input.value, viewCenter());
    });
    setTimeout(() => input.focus(), 30);
  }

  function placeVideo(url: string, at: Pt): boolean {
    const v = videoOf(url);
    if (!v || !canEdit) return false;
    const w = 480, h = 270;
    const id = addItem({ t: 'embed', x: round(at.x - w / 2), y: round(at.y - h / 2), w, h, z: topZ(false), src: videoUrl(v) });
    flushNow();
    if (id) { setTool('select'); select([id]); }
    return true;
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
          Object.assign(copy, shiftArrow(it, dx, dy));
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

  /** Finger auf der Fläche (für Zwei-Finger-Zoom). Stift und Maus zählen nicht. */
  const pointers = new Map<number, Pt>();
  let pinch: { d: number; mid: Pt; z: number; x: number; y: number } | null = null;
  /** Zeiger, dem der laufende Zug gehört (andere Finger, Handballen: egal). */
  let owner: { id: number; pen: boolean } | null = null;
  /** Wann der Stift zuletzt abgehoben wurde bzw. ein Finger aufgesetzt hat. */
  let penUpAt = -1e9;
  let touchAt = -1e9;
  /** So lange nach dem Abheben des Stifts gelten Berührungen als Handballen. */
  const PALM_MS = 500;
  let lastTap = { t: 0, x: 0, y: 0, id: '' };
  let spaceDown = false;
  let lastPointer: Pt | null = null;
  let hoverTarget: string | null = null;

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

  /** Stil für neue Linien/Pfeile aus den zuletzt gewählten Einstellungen. */
  const lineStyle = (line: boolean): Partial<Item> => ({
    c: lastInk, hd: line ? 'none' : undefined, sw: lastWidth === 2 ? undefined : lastWidth, ds: lastDash, cv: lastCurve ? 1 : undefined,
  });

  // Linie/Pfeil Punkt für Punkt: Klick setzt einen Wendepunkt, Klick auf den
  // letzten Punkt (bzw. Doppelklick, ↵, Esc, ✓) beendet, Klick auf ein
  // Element macht das Ende dort fest.

  function startPoly(start: Pt, from: string | null, line: boolean) {
    const id = addItem({ t: 'arrow', x: 0, y: 0, w: 0, h: 0, z: topZ(false), fx: round(start.x), fy: round(start.y), tx: round(start.x), ty: round(start.y), from: from || undefined, ...lineStyle(line) });
    if (!id) return;
    poly = { id, fixed: [start] };
    flushNow();
    renderCtx();
    paintOverlay();
  }

  function polyAim(p: Pt, shift: boolean): Pt {
    const last = poly!.fixed[poly!.fixed.length - 1];
    return shift ? snapAngle(last, p) : p;
  }

  function polyPreview(p: Pt, shift: boolean) {
    if (!poly) return;
    const it = cache.get(poly.id);
    if (!it) { poly = null; return; }
    const q = polyAim(p, shift);
    const to = connectableAt(q, it.from);
    setHover(to);
    patch(poly.id, { tx: round(q.x), ty: round(q.y), to: to || undefined });
  }

  function polyClick(p: Pt, shift: boolean) {
    if (!poly) return;
    const it = cache.get(poly.id);
    if (!it) { poly = null; return; }
    const last = poly.fixed[poly.fixed.length - 1];
    const q = polyAim(p, shift);
    if (Math.hypot(q.x - last.x, q.y - last.y) * view.z < 10) { finishPoly(); return; }
    const to = connectableAt(q, it.from);
    if (to) {
      patch(poly.id, { wp: poly.fixed.length > 1 ? flat(poly.fixed.slice(1)) : undefined, tx: round(q.x), ty: round(q.y), to });
      poly.fixed.push(q);
      finishPoly(true);
      return;
    }
    poly.fixed.push(q);
    patch(poly.id, { wp: flat(poly.fixed.slice(1)), tx: round(q.x), ty: round(q.y), to: undefined });
  }

  function finishPoly(attached = false) {
    if (!poly) return;
    const { id, fixed } = poly;
    poly = null;
    setHover(null);
    flushNow();
    const it = cache.get(id);
    if (it && !attached) {
      if (fixed.length < 2) tx(() => items.delete(id));
      else {
        const end = fixed[fixed.length - 1];
        patch(id, { wp: fixed.length > 2 ? flat(fixed.slice(1, -1)) : undefined, tx: round(end.x), ty: round(end.y), to: undefined });
      }
    }
    undo.stopCapturing();
    setTool('select');
    flushNow();
    if (cache.has(id)) select([id]);
  }

  // ── Radierer ──────────────────────────────────────────────────────────────

  /** Radiert entlang a→b: Striche werden zerschnitten, alles andere ganz entfernt (beim Loslassen). */
  function eraseAlong(a: Pt, b: Pt, d: Extract<Drag, { kind: 'erase' }>) {
    const r = ERASER_R / view.z;
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    const n = Math.max(1, Math.ceil(len / (r / 2)));
    const samples: Pt[] = [];
    for (let i = 0; i <= n; i++) samples.push({ x: a.x + (b.x - a.x) * (i / n), y: a.y + (b.y - a.y) * (i / n) });
    const reach = rectOf(a, b);
    const cuts: [Item, { pts: number[]; pr: number[] | null }[]][] = [];
    for (const it of cache.values()) {
      if (it.t === 'frame' || d.doomed.has(it.id)) continue;
      const half = it.t === 'stroke' ? (it.hl ? MARKER_W : PEN_W)[it.sw || 2] / 2 : it.t === 'arrow' ? (LINE_W[it.sw || 2] || 2) / 2 : 0;
      const bx = bounds(it);
      const pad = r + half;
      if (!overlaps({ x: bx.x - pad, y: bx.y - pad, w: bx.w + pad * 2, h: bx.h + pad * 2 }, reach)) continue;
      if (it.t === 'stroke') {
        const runs = cutStroke(it, samples, r + half);
        if (runs) cuts.push([it, runs]);
      } else if (hitsWhole(it, samples, pad)) {
        d.doomed.add(it.id);
        nodes.get(it.id)?.classList.add('is-doomed');
      }
    }
    if (!cuts.length) return;
    tx(() => {
      for (const [it, runs] of cuts) {
        items.delete(it.id);
        for (const run of runs) {
          let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
          for (let i = 0; i < run.pts.length; i += 2) { x1 = Math.min(x1, run.pts[i]); x2 = Math.max(x2, run.pts[i]); y1 = Math.min(y1, run.pts[i + 1]); y2 = Math.max(y2, run.pts[i + 1]); }
          const fields: Omit<Item, 'id'> = {
            t: 'stroke', x: round(x1), y: round(y1), w: Math.max(1, round(x2 - x1)), h: Math.max(1, round(y2 - y1)), z: it.z, c: it.c,
            pts: run.pts.map((v, i) => round(v - (i % 2 ? y1 : x1))), pr: run.pr || undefined, sw: it.sw, hl: it.hl,
          };
          const m = new Y.Map<unknown>();
          for (const [k, v] of Object.entries(fields)) if (v !== undefined) m.set(k, v);
          items.set(rid(), m);
        }
      }
    });
    flushNow();
  }

  /** Strich ohne die Punkte im Radius: übrige Stücke (absolut), null = nicht getroffen. */
  function cutStroke(it: Item, samples: Pt[], rr: number): { pts: number[]; pr: number[] | null }[] | null {
    const src = it.pts || [];
    const pr = it.pr?.length ? it.pr : null;
    const P: Pt[] = [];
    for (let i = 0; i + 1 < src.length; i += 2) P.push({ x: it.x + src[i], y: it.y + src[i + 1] });
    if (!P.length) return null;
    const near = (q: Pt) => samples.some(s => Math.hypot(s.x - q.x, s.y - q.y) <= rr);
    const segNear = (a: Pt, b: Pt) => samples.some(s => segDist(s, a, b) <= rr * 1.5);
    if (P.length === 1 ? !near(P[0]) : !P.some((q, i) => i < P.length - 1 && segNear(q, P[i + 1]))) return null;
    // Getroffene Stücke fein unterteilen, damit der Schnitt dem Radierer folgt.
    const dense: Pt[] = [], dpr: number[] = [];
    const step = Math.max(rr / 3, 0.5);
    for (let i = 0; i < P.length; i++) {
      dense.push(P[i]); dpr.push(pr?.[i] ?? 0.5);
      const nb = P[i + 1];
      if (!nb) continue;
      const len = Math.hypot(nb.x - P[i].x, nb.y - P[i].y);
      if (len <= step || !segNear(P[i], nb)) continue;
      const k = Math.ceil(len / step);
      for (let j = 1; j < k; j++) {
        dense.push({ x: P[i].x + (nb.x - P[i].x) * (j / k), y: P[i].y + (nb.y - P[i].y) * (j / k) });
        dpr.push((pr?.[i] ?? 0.5) + ((pr?.[i + 1] ?? 0.5) - (pr?.[i] ?? 0.5)) * (j / k));
      }
    }
    const runs: { pts: number[]; pr: number[] | null }[] = [];
    let cur: { pts: number[]; pr: number[] | null } | null = null;
    let removed = false;
    dense.forEach((q, i) => {
      if (near(q)) { removed = true; if (cur && cur.pts.length >= 4) runs.push(cur); cur = null; return; }
      cur ??= { pts: [], pr: pr ? [] : null };
      cur.pts.push(round(q.x), round(q.y));
      cur.pr?.push(Math.round(dpr[i] * 100) / 100);
    });
    if (cur && (cur as { pts: number[] }).pts.length >= 4) runs.push(cur);
    return removed ? runs : null;
  }

  function hitsWhole(it: Item, samples: Pt[], pad: number): boolean {
    if (it.t === 'arrow') {
      let p = arrowPoints(it);
      if (it.cv && p.length > 2) p = [p[0], ...curveSegments(p).flatMap(seg => [0.25, 0.5, 0.75, 1].map(t => bezierAt(seg, t)))];
      return samples.some(s => p.some((q, i) => i < p.length - 1 && segDist(s, q, p[i + 1]) <= pad));
    }
    const b = bounds(it);
    return samples.some(s => contains({ x: b.x - pad, y: b.y - pad, w: b.w + pad * 2, h: b.h + pad * 2 }, s));
  }

  function endErase(d: Extract<Drag, { kind: 'erase' }>, commit: boolean) {
    for (const id of d.doomed) nodes.get(id)?.classList.remove('is-doomed');
    if (commit && d.doomed.size) {
      const ids = new Set([...d.doomed].filter(id => cache.has(id)));
      for (const it of cache.values()) if (it.t === 'arrow' && ((it.from && ids.has(it.from)) || (it.to && ids.has(it.to)))) ids.add(it.id);
      tx(() => { for (const id of ids) items.delete(id); });
      select([...selected].filter(id => !ids.has(id)));
    }
    undo.stopCapturing();
  }

  // ── Spuren: Laserpointer (auch von anderen) und Radierer ──────────────────

  interface Trail { pts: { x: number; y: number; t: number }[]; path: SVGPathElement; ms: number; size: number }
  const trailSvg = svg('svg', { class: 'b-trails' });
  overlay.prepend(trailSvg);
  const trails = new Map<string, Trail>();
  let trailReq = 0;

  function trail(key: string, cls: string, ms: number, size: number): Trail {
    let t = trails.get(key);
    if (!t) {
      t = { pts: [], path: svg('path', { class: cls }) as SVGPathElement, ms, size };
      trailSvg.append(t.path);
      trails.set(key, t);
    }
    return t;
  }

  function trailPush(key: string, cls: string, p: Pt, ms: number, size: number) {
    trail(key, cls, ms, size).pts.push({ x: p.x, y: p.y, t: performance.now() });
    if (!trailReq) trailReq = requestAnimationFrame(paintTrails);
  }

  function paintTrails() {
    trailReq = 0;
    const now = performance.now();
    let alive = false;
    for (const [key, t] of trails) {
      t.pts = t.pts.filter(q => now - q.t < t.ms);
      if (!t.pts.length) { t.path.remove(); trails.delete(key); continue; }
      alive = true;
      const input = t.pts.map(q => { const s = toScreen(q); return [s.x, s.y, 1 - (now - q.t) / t.ms]; });
      if (input.length === 1) input.push([input[0][0] + 0.01, input[0][1], input[0][2]]);
      t.path.setAttribute('d', outlinePath(getStroke(input, { size: t.size, thinning: 0.9, smoothing: 0.5, streamline: 0.4, simulatePressure: false, start: { taper: false, cap: true }, end: { cap: true } })));
    }
    if (alive) trailReq = requestAnimationFrame(paintTrails);
  }

  let laserSent = 0;
  function sendLaser(force = false) {
    const now = performance.now();
    if (!force && now - laserSent < 40) return;
    laserSent = now;
    const t = trails.get('laser');
    publish('laser', t ? t.pts.flatMap(q => [round(q.x), round(q.y), Math.round(now - q.t)]) : null);
  }

  // Eigener Kreis um den Radierer.
  const eraserRing = el('div', { class: 'b-eraser' });
  overlay.append(eraserRing);
  function placeRing(sp: Pt | null) {
    const on = !!sp && tool === 'eraser' && canEdit;
    eraserRing.style.display = on ? 'block' : 'none';
    if (on) eraserRing.style.transform = `translate(${sp!.x - ERASER_R}px, ${sp!.y - ERASER_R}px)`;
  }

  // ── Stift-Modus ───────────────────────────────────────────────────────────

  const PEN_KEY = 'md:board:pen';
  let penMode = store.get(PEN_KEY) === '1';
  const penBtn = ctxButton(ICON.penmode, 'Nur der Stift zeichnet', () => setPenMode(!penMode));
  penBtn.classList.add('b-penmode');
  const penSep = el('span', { class: 'b-sep', 'aria-hidden': 'true' });
  tools.append(penSep, penBtn);
  function setPenMode(on: boolean, auto = false) {
    penMode = on;
    if (!auto || store.get(PEN_KEY) === null) store.set(PEN_KEY, on ? '1' : '0');
    syncPenBtn();
    if (auto) o.toast('Stift-Modus: Finger verschieben, der Stift zeichnet.');
  }
  function syncPenBtn() {
    const seen = store.get(PEN_KEY) !== null;
    penBtn.hidden = penSep.hidden = !seen;
    penBtn.setAttribute('aria-pressed', String(penMode));
  }
  syncPenBtn();

  // ── Zeiger: Ereignisse ────────────────────────────────────────────────────

  const startPan = (sp: Pt, tapId: string | null) => {
    drag = { kind: 'pan', sx: sp.x, sy: sp.y, vx: view.x, vy: view.y, moved: false, tapId };
    root.classList.add('is-panning');
  };

  function activateEmbed(id: string) {
    if (playing.has(id)) { liveEmbed = id; draw(id); } else playEmbed(id);
  }

  root.addEventListener('pointerdown', e => {
    const target = e.target as HTMLElement;
    if (target.closest('.b-tools, .b-zoom, .b-ctx, .b-follow, .b-pop')) return;
    if (editing && target.closest('.is-editing')) return;
    if (editing) endEdit();
    if (liveEmbed && itemIdAt(target) !== liveEmbed) releaseEmbed();
    closePop();
    if (e.button === 2) return;
    const touch = e.pointerType === 'touch';
    const pen = e.pointerType === 'pen';
    // Erster Strich mit Apple Pencil o. ä.: Stift-Modus an (außer schon bewusst aus).
    if (pen && !penMode && store.get(PEN_KEY) === null) setPenMode(true, true);
    // Handballen beim Zeichnen mit dem Stift (und kurz nach dem Abheben): ignorieren.
    if (touch && penMode && (owner?.pen || performance.now() - penUpAt < PALM_MS)) { e.preventDefault(); return; }
    // Der Stift hat Vorrang vor allem, was Finger bzw. Handballen gerade tun.
    if (pen && (pinch || (owner && !owner.pen))) dropTouches();
    // Neuer Stift-Kontakt, bevor der alte sauber beendet war: alten abschließen.
    if (pen && owner?.pen && owner.id !== e.pointerId) endPointer({ pointerId: owner.id, type: 'pointerup', pointerType: 'pen', target: root, clientX: e.clientX, clientY: e.clientY, shiftKey: false } as unknown as PointerEvent);
    // Fokus steuern wir selbst (sonst nimmt das Board ihn einer gerade geöffneten Notiz weg).
    e.preventDefault();
    viewed = true;
    root.focus({ preventScroll: true });
    const sp = local2(e.clientX, e.clientY);
    try { root.setPointerCapture(e.pointerId); } catch { /* egal */ }

    if (touch) {
      touchAt = performance.now();
      pointers.set(e.pointerId, sp);
      if (pointers.size === 2) {
        // Zwei Finger: Zoomen und Verschieben. Was der erste Finger begonnen hat, fällt weg.
        if (drag?.kind === 'stroke') drag.node.remove();
        if (drag?.kind === 'erase') endErase(drag, false);
        drag = null;
        owner = null;
        const [a, b] = [...pointers.values()];
        pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, z: view.z, x: view.x, y: view.y };
        marquee.style.display = 'none';
        placeRing(null);
        return;
      }
      if (pointers.size > 2) return;
    }
    if (drag && owner && owner.id !== e.pointerId) return;
    owner = { id: e.pointerId, pen };

    const p = toWorld(sp);
    const handleKind = target.closest<HTMLElement>('[data-handle]')?.dataset.handle;
    const handleIndex = Number(target.closest<HTMLElement>('[data-handle]')?.dataset.i);
    const hitId = itemIdAt(target);
    const hit = hitId ? cache.get(hitId) : undefined;

    // Doppelt tippen/klicken: Text bearbeiten oder neue Notiz.
    const now = performance.now();
    const double = now - lastTap.t < 380 && Math.hypot(sp.x - lastTap.x, sp.y - lastTap.y) < 14 && (hitId || '') === lastTap.id;
    lastTap = { t: now, x: sp.x, y: sp.y, id: hitId || '' };

    if (e.button === 1 || spaceDown || tool === 'hand' || !canEdit) { startPan(sp, hitId); return; }

    // Stift-Modus: Finger verschieben nur (Tippen wählt aus, doppelt tippen bearbeitet).
    if (touch && penMode) {
      if (hitId && target.closest('[data-play]')) { select([hitId]); activateEmbed(hitId); owner = null; return; }
      if (double && hit && TEXTUAL.has(hit.t)) { owner = null; startEdit(hitId!, false); return; }
      if (double && hit?.t === 'embed') { owner = null; activateEmbed(hit.id); return; }
      startPan(sp, hitId);
      return;
    }

    // Finger: Ziehen verschiebt, Tippen setzt den nächsten Punkt.
    if (poly && touch) { startPan(sp, null); if (drag?.kind === 'pan') drag.tapPoly = true; return; }
    if (poly) { polyClick(p, e.shiftKey); owner = null; return; }

    // Seitentaste am Stift (Radier-Ende): radieren, egal welches Werkzeug.
    if ((pen && e.buttons & 32) || tool === 'eraser') {
      drag = { kind: 'erase', last: p, doomed: new Set() };
      undo.stopCapturing();
      eraseAlong(p, p, drag);
      placeRing(sp);
      trailPush('erase', 'b-trail-erase', p, 200, ERASER_R * 2);
      return;
    }
    if (tool === 'laser') {
      drag = { kind: 'laser' };
      trailPush('laser', 'b-trail-laser', p, LASER_MS, 7);
      sendLaser(true);
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
    if ((handleKind === 'wp' || handleKind === 'mid') && selected.size === 1 && Number.isFinite(handleIndex)) {
      const id = [...selected][0];
      const it = cache.get(id);
      if (!it) return;
      const wp = [...(it.wp || [])];
      undo.stopCapturing();
      if (handleKind === 'wp' && double) {
        // Doppelt auf einen Wendepunkt: entfernen.
        wp.splice(handleIndex * 2, 2);
        patch(id, { wp: wp.length ? wp : undefined });
        owner = null;
        return;
      }
      if (handleKind === 'mid') {
        wp.splice(handleIndex * 2, 0, round(p.x), round(p.y));
        patch(id, { wp });
        flushNow();
      }
      drag = { kind: 'wp', id, i: handleIndex };
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
    if (tool === 'arrow' || tool === 'line') {
      drag = { kind: 'arrow', start: p, from: connectableAt(p), id: null, line: tool === 'line' };
      undo.stopCapturing();
      return;
    }
    if (tool === 'pen') {
      const node = el('div', { class: `b-item b-stroke is-drawing${lastMarker ? ' is-marker' : ''}`, 'data-c': lastInk });
      node.style.zIndex = String(topZ(false));
      const s = svg('svg', { class: 'b-svg' });
      const path = svg('path', { class: 'line' }) as SVGPathElement;
      s.append(path);
      node.append(s);
      itemLayer.append(node);
      drag = { kind: 'stroke', pts: [round(p.x), round(p.y)], pr: pen ? [Math.round(Math.max(0.05, e.pressure) * 100) / 100] : null, node, path };
      path.setAttribute('d', inkPath(drag.pts, drag.pr, lastWidth, lastMarker, false));
      return;
    }

    // Auswählen
    if (hitId && voteActive() && VOTABLE.has(hit?.t || '')) {
      const dot = target.closest<HTMLElement>('.b-dot');
      castVote(hitId, dot ? -1 : 1);
      owner = null;
      return;
    }
    if (hitId && target.closest('[data-play]')) { select([hitId]); activateEmbed(hitId); owner = null; return; }
    if (hitId) {
      if (double && TEXTUAL.has(hit?.t || '')) { owner = null; startEdit(hitId, false); return; }
      if (double && hit?.t === 'embed') { owner = null; activateEmbed(hitId); return; }
      let clickId: string | null = null;
      if (e.shiftKey) {
        const next = new Set(selected);
        if (next.has(hitId)) next.delete(hitId); else next.add(hitId);
        select(next);
        if (!next.has(hitId)) { owner = null; return; }
      } else if (!selected.has(hitId)) select([hitId]);
      else clickId = hitId;
      drag = { kind: 'move', start: p, orig: moveSet(), moved: false, clickId };
      return;
    }
    if (double) {
      owner = null;
      const id = addNote(p);
      if (id) startEdit(id);
      return;
    }
    if (touch) { startPan(sp, null); return; }
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

  /** Alle Zwischenpunkte des Ereignisses (Apple Pencil liefert mehr als ein pointermove). */
  const samplesOf = (e: PointerEvent): PointerEvent[] => {
    const list = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [];
    return list.length ? list : [e];
  };

  root.addEventListener('pointermove', e => {
    const sp = local2(e.clientX, e.clientY);
    if (pointers.has(e.pointerId)) pointers.set(e.pointerId, sp);
    lastPointer = toWorld(sp);
    if (e.pointerType !== 'touch') {
      publish('cursor', { x: round(lastPointer.x), y: round(lastPointer.y) });
      if (!drag || owner?.id === e.pointerId) placeRing(sp);
    }

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
    // Linie Punkt für Punkt: Vorschau folgt Maus bzw. schwebendem Stift.
    if (poly && !drag && e.pointerType !== 'touch') { polyPreview(lastPointer, e.shiftKey); return; }
    if (!drag || (owner && owner.id !== e.pointerId)) return;
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
          if (it.t === 'arrow') changes.push([it.id, shiftArrow(it, dx, dy)]);
          else changes.push([it.id, { x: round(it.x + dx), y: round(it.y + dy) }]);
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
        if (KEEP_RATIO.has(it.t) || (e.shiftKey && it.t !== 'text')) {
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
            : addItem({ t: 'shape', x: round(r.x), y: round(r.y), w: round(r.w), h: round(r.h), z: topZ(false), s: 'rect', c: lastInk, sw: lastWidth === 2 ? undefined : lastWidth, ds: lastDash, text: '' });
        } else patch(drag.id, { x: round(r.x), y: round(r.y), w: round(Math.max(r.w, 8)), h: round(Math.max(r.h, 8)) });
        break;
      }
      case 'arrow': {
        const q = e.shiftKey ? snapAngle(drag.start, p) : p;
        const to = connectableAt(q, drag.from || undefined);
        setHover(to);
        if (!drag.id) {
          if (Math.hypot((q.x - drag.start.x) * view.z, (q.y - drag.start.y) * view.z) < 6) return;
          drag.id = addItem({ t: 'arrow', x: 0, y: 0, w: 0, h: 0, z: topZ(false), fx: round(drag.start.x), fy: round(drag.start.y), tx: round(q.x), ty: round(q.y), from: drag.from || undefined, to: to || undefined, ...lineStyle(drag.line) });
        } else patch(drag.id, { tx: round(q.x), ty: round(q.y), to: to || undefined });
        break;
      }
      case 'end': {
        const it = cache.get(drag.id);
        if (!it) return;
        const other = drag.end === 'from' ? it.to : it.from;
        const pts = arrowPoints(it);
        const anchor = drag.end === 'from' ? pts[1] : pts[pts.length - 2];
        const q = e.shiftKey && anchor ? snapAngle(anchor, p) : p;
        const hit = connectableAt(q, other);
        setHover(hit);
        patch(drag.id, drag.end === 'from'
          ? { fx: round(q.x), fy: round(q.y), from: hit || undefined }
          : { tx: round(q.x), ty: round(q.y), to: hit || undefined });
        break;
      }
      case 'wp': {
        const it = cache.get(drag.id);
        if (!it?.wp) return;
        const pts = arrowPoints(it);
        const q = e.shiftKey ? snapAngle(pts[drag.i], p) : p;
        const wp = [...it.wp];
        wp[drag.i * 2] = round(q.x);
        wp[drag.i * 2 + 1] = round(q.y);
        patch(drag.id, { wp });
        break;
      }
      case 'stroke': {
        const { pts, pr } = drag;
        let added = false;
        for (const ev of samplesOf(e)) {
          const q = toWorld(local2(ev.clientX, ev.clientY));
          const lx = pts[pts.length - 2], ly = pts[pts.length - 1];
          if (Math.hypot(q.x - lx, q.y - ly) * view.z < 1.2) continue;
          pts.push(round(q.x), round(q.y));
          pr?.push(Math.round(Math.max(0.05, ev.pressure) * 100) / 100);
          added = true;
        }
        if (added) drag.path.setAttribute('d', inkPath(pts, pr, lastWidth, lastMarker, false));
        break;
      }
      case 'erase': {
        for (const ev of samplesOf(e)) {
          const q = toWorld(local2(ev.clientX, ev.clientY));
          eraseAlong(drag.last, q, drag);
          drag.last = q;
          trailPush('erase', 'b-trail-erase', q, 200, ERASER_R * 2);
        }
        placeRing(sp);
        break;
      }
      case 'laser': {
        for (const ev of samplesOf(e)) trailPush('laser', 'b-trail-laser', toWorld(local2(ev.clientX, ev.clientY)), LASER_MS, 7);
        sendLaser();
        break;
      }
    }
    if (drag && drag.kind !== 'pan' && drag.kind !== 'marquee' && drag.kind !== 'laser' && drag.kind !== 'erase') paintOverlay();
  });

  /** Finger/Handballen fallen weg; ein gerade erst begonnenes Verschieben bzw. Zoomen wird zurückgenommen. */
  function dropTouches() {
    const recent = performance.now() - touchAt < 800;
    if (pinch && recent) view = { z: pinch.z, x: pinch.x, y: pinch.y };
    else if (drag?.kind === 'pan' && recent) { view.x = drag.vx; view.y = drag.vy; }
    if (recent) applyView();
    pointers.clear();
    pinch = null;
    drag = null;
    owner = null;
    root.classList.remove('is-panning');
  }

  function endPointer(e: PointerEvent) {
    if (e.pointerType === 'pen') penUpAt = performance.now();
    pointers.delete(e.pointerId);
    if (pinch) { if (pointers.size < 2) pinch = null; drag = null; owner = null; return; }
    if (owner && owner.id !== e.pointerId) return;
    owner = null;
    const d = drag;
    drag = null;
    root.classList.remove('is-panning');
    marquee.style.display = 'none';
    setHover(null);
    if (e.pointerType === 'touch') placeRing(null);
    if (!d) return;
    if (d.kind === 'pan' && !d.moved && e.type === 'pointerup') {
      // Tippen ohne Bewegen: auswählen bzw. Auswahl aufheben.
      if (d.tapId && voteActive() && VOTABLE.has(cache.get(d.tapId)?.t || '') && canEdit) castVote(d.tapId, (e.target as Element).closest?.('.b-dot') ? -1 : 1);
      else if (d.tapPoly) polyClick(toWorld(local2(e.clientX, e.clientY)), false);
      else select(d.tapId && canEdit ? [d.tapId] : []);
    }
    if (d.kind === 'move' && !d.moved && d.clickId && !e.shiftKey) {
      // Schon gewählt und nochmal angeklickt: Bereich umbenennen, Video bedienen.
      const t = cache.get(d.clickId)?.t;
      if (selected.size === 1 && t === 'frame') startEdit(d.clickId);
      else if (selected.size === 1 && t === 'embed') activateEmbed(d.clickId);
      else select([d.clickId]);
    }
    if (d.kind === 'create') {
      let id = d.id;
      if (!id) {
        const w = d.t === 'frame' ? 640 : 180, h = d.t === 'frame' ? 420 : 120;
        id = d.t === 'frame'
          ? addItem({ t: 'frame', x: round(d.start.x - w / 2), y: round(d.start.y - h / 2), w, h, z: topZ(true), text: '' })
          : addItem({ t: 'shape', x: round(d.start.x - w / 2), y: round(d.start.y - h / 2), w, h, z: topZ(false), s: 'rect', c: lastInk, sw: lastWidth === 2 ? undefined : lastWidth, ds: lastDash, text: '' });
      }
      setTool('select');
      flushNow();
      if (id && d.t === 'frame') startEdit(id);
      else if (id) select([id]);
    }
    if (d.kind === 'arrow') {
      if (d.id) {
        setTool('select');
        flushNow();
        select([d.id]);
      } else if (e.type === 'pointerup') startPoly(d.start, d.from, d.line);
    }
    if (d.kind === 'stroke') {
      d.node.remove();
      const pts = d.pts;
      if (pts.length < 2) return;
      let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
      for (let i = 0; i < pts.length; i += 2) { x1 = Math.min(x1, pts[i]); x2 = Math.max(x2, pts[i]); y1 = Math.min(y1, pts[i + 1]); y2 = Math.max(y2, pts[i + 1]); }
      const rel = pts.map((v, i) => round(v - (i % 2 ? y1 : x1)));
      addItem({
        t: 'stroke', x: x1, y: y1, w: Math.max(1, round(x2 - x1)), h: Math.max(1, round(y2 - y1)), z: topZ(false), c: lastInk, pts: rel,
        pr: d.pr || undefined, sw: lastWidth === 2 ? undefined : lastWidth, hl: lastMarker ? 1 : undefined,
      });
    }
    if (d.kind === 'erase') endErase(d, e.type === 'pointerup');
    if (d.kind === 'laser') {
      sendLaser(true);
      // Danach nichts mehr mitschicken (sonst sähe, wer neu dazukommt, eine alte Spur).
      setTimeout(() => { if (drag?.kind !== 'laser') publish('laser', null); }, LASER_MS);
    }
    if (d.kind === 'resize' || d.kind === 'move' || d.kind === 'end' || d.kind === 'wp') undo.stopCapturing();
    paintOverlay();
  }
  root.addEventListener('pointerup', endPointer);
  root.addEventListener('pointercancel', endPointer);
  // Zeiger verloren, ohne dass pointerup kam (Safari): wie Loslassen behandeln.
  root.addEventListener('lostpointercapture', e => { if (owner?.id === e.pointerId) endPointer(e); });

  // Safari auf dem iPad: Stift-Berührungen lösen sonst eigene Gesten aus
  // (Doppeltippen, Scribble, Lupe). Die brechen den Strich ab, schlucken die
  // nächsten und verschieben den Fokus (z. B. auf ⋯ oben rechts). Wie in
  // tldraw/Excalidraw: Touch-Ereignisse des Stifts auf der Fläche abfangen.
  // Finger bleiben unberührt (Bearbeiten von Notizen braucht die Tastatur).
  const UI = '.b-tools, .b-zoom, .b-ctx, .b-follow, .b-pop, .is-editing, [data-play], input, textarea, button';
  const stylusGuard = (e: TouchEvent) => {
    const t = [...e.changedTouches].find(x => (x as Touch & { touchType?: string }).touchType === 'stylus');
    if (!t || (e.target as Element | null)?.closest?.(UI)) return;
    if (e.cancelable) e.preventDefault();
  };
  for (const type of ['touchstart', 'touchmove', 'touchend'] as const) root.addEventListener(type, stylusGuard, { passive: false });

  root.addEventListener('pointerleave', e => {
    if (e.pointerType !== 'touch' && !drag) { publish('cursor', null); placeRing(null); }
  });

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
    if (poly && (e.key === 'Escape' || e.key === 'Enter')) { e.preventDefault(); finishPoly(); return; }
    if (e.key === 'Escape') { closePop(); releaseEmbed(); if (following !== null) stopFollow(); select([]); setTool('select'); return; }
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
        ? [it.id, shiftArrow(it, dx, dy)]
        : [it.id, { x: it.x + dx, y: it.y + dy }])));
      return;
    }
    const shortcut = TOOLS.find(([, , k]) => k.toLowerCase() === key);
    if (shortcut && !e.altKey) {
      e.preventDefault();
      if (shortcut[0] === 'insert') pickImage(); else setTool(shortcut[0]);
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
      const b = union(list.map(i => (i.t === 'arrow'
        ? union([{ x: i.fx ?? 0, y: i.fy ?? 0 }, { x: i.tx ?? 0, y: i.ty ?? 0 }, ...pairs(i.wp)].map(q => ({ ...q, w: 0, h: 0 })))!
        : { x: i.x, y: i.y, w: i.w, h: i.h }))) || { x: 0, y: 0, w: 0, h: 0 };
      const ids = insertCopies(list, round(at.x - (b.x + b.w / 2)), round(at.y - (b.y + b.h / 2)));
      flushNow();
      select(ids);
      return;
    }
    const plain = e.clipboardData.getData('text/plain');
    if (placeVideo(plain, at)) return;
    pasteText(plain, at);
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
    const types = [...(e.dataTransfer?.types || [])];
    if (types.includes('Files') || types.includes('text/uri-list')) { e.preventDefault(); e.stopPropagation(); }
  });
  root.addEventListener('drop', e => {
    const files = [...(e.dataTransfer?.files || [])];
    const at = toWorld(local2(e.clientX, e.clientY));
    if (!files.length) {
      // Video-Link aus einem anderen Fenster hereingezogen.
      const url = (e.dataTransfer?.getData('text/uri-list') || '').split('\n').find(l => l && !l.startsWith('#'))?.trim();
      if (url && placeVideo(url, at)) { e.preventDefault(); e.stopPropagation(); }
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    placeImages(files, at);
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

  interface PeerState { user?: { name?: string; color?: string }; cursor?: Pt | null; sel?: string[]; view?: Box; summon?: number; laser?: number[] | null }
  const laserSeen = new Map<number, string>();
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
      // Laserpointer der anderen: Punkte mit Alter, hier nachgezeichnet.
      const key = st.laser ? st.laser.join(',') : '';
      if (key && laserSeen.get(client) !== key) {
        laserSeen.set(client, key);
        const t = trail(`laser-${client}`, 'b-trail-laser', LASER_MS, 7);
        const now = performance.now();
        t.pts = [];
        for (let i = 0; i + 2 < st.laser!.length; i += 3) t.pts.push({ x: st.laser![i], y: st.laser![i + 1], t: now - st.laser![i + 2] });
        if (!trailReq) trailReq = requestAnimationFrame(paintTrails);
      }
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

  setTool('select');
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
