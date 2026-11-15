// Rechnen im Text, ähnlich Apple Math Notes. Läuft im Editor (Ergebnis grau
// hinter dem =), in der Ansicht (Worker und Browser) und in den Memos.
//
//   120 + 45 * 2 =            → 210
//   Miete = 1.250 €           (Variable, danach: Miete * 12 =)
//   240 + 19 % =  ·  19 % von 240 =
//   90 €/h * 7,5 h =  ·  3 km in mi =  ·  50 € in CHF =
//   14:30 + 2 h 45 min =  ·  heute + 30 Tage =  ·  bis 24.12. =
//   Summe =                   (unter einer Liste: alle Beträge darüber)
//   | Summe | = |             (in Tabellen: die Spalte darüber)
//
// Das Ergebnis steht nie im Text, nur in der Darstellung. Zeilen, die sich
// nicht vollständig berechnen lassen, bleiben unberührt.

export interface CalcHit {
  /** Zeile (ab 0) im Quelltext. */
  line: number;
  /** Position in der Zeile direkt hinter dem =. */
  at: number;
  text: string;
  /** Tabellenzelle (ab 0, ohne führendes |). */
  cell?: number;
}

// ── Wechselkurse (EZB, pro 1 EUR) ───────────────────────────────────────────

const CODES = ['EUR', 'USD', 'JPY', 'BGN', 'CZK', 'DKK', 'GBP', 'HUF', 'PLN', 'RON', 'SEK', 'CHF', 'ISK', 'NOK', 'TRY', 'AUD', 'BRL', 'CAD', 'CNY', 'HKD', 'IDR', 'ILS', 'INR', 'KRW', 'MXN', 'MYR', 'NZD', 'PHP', 'SGD', 'THB', 'ZAR'];
const SYMBOL_CUR: Record<string, string> = { '€': 'EUR', '$': 'USD', '£': 'GBP', '¥': 'JPY' };
const WORD_CUR: Record<string, string> = { euro: 'EUR', euros: 'EUR', dollar: 'USD', franken: 'CHF', fr: 'CHF', chf: 'CHF', eur: 'EUR', usd: 'USD' };
const CUR_SHOW: Record<string, string> = { EUR: '€', USD: '$', GBP: '£', JPY: '¥' };

let rates: Record<string, number> | null = null;
let missingRates = false;

export function setRates(r: Record<string, number> | null) { rates = r ? { ...r, EUR: 1 } : null; }
export const hasRates = () => !!rates;
/** Hat die letzte Rechnung Kurse gebraucht, die noch fehlen? */
export const calcNeedsRates = () => missingRates;

/** EZB-Tageskurse (XML) → { USD: 1.08, … } */
export function parseEcb(xml: string): Record<string, number> {
  const out: Record<string, number> = { EUR: 1 };
  for (const m of xml.matchAll(/currency=['"]([A-Z]{3})['"]\s+rate=['"]([\d.]+)['"]/g)) out[m[1]] = Number(m[2]);
  return out;
}

function convert(n: number, from: string, to: string): number {
  if (from === to) return n;
  if (!rates) { missingRates = true; throw new Error('rates'); }
  const a = rates[from], b = rates[to];
  if (!a || !b) throw new Error('cur');
  return n / a * b;
}

// ── Einheiten ───────────────────────────────────────────────────────────────

type Dims = Record<string, number>;

interface Disp { label: string; f: number; d: Dims; one?: string }

interface Q {
  /** Wert in Grundeinheiten (m, kg, s …; Währung: in `cur`). */
  n: number;
  d: Dims;
  cur?: string;
  pct?: boolean;
  kind?: 'clock' | 'date';
  unit?: Disp;
}

const L = { L: 1 }, M = { M: 1 }, T = { T: 1 }, A = { L: 2 }, V = { L: 3 };
const E = { M: 1, L: 2, T: -2 }, P = { M: 1, L: 2, T: -3 }, B = { B: 1 };

const UNIT_LIST: [string[], number, Dims, string, string?][] = [
  [['mm'], 1e-3, L, 'mm'], [['cm'], 1e-2, L, 'cm'], [['dm'], 0.1, L, 'dm'],
  [['m', 'meter'], 1, L, 'm'], [['km', 'kilometer'], 1e3, L, 'km'],
  [['mi', 'meile', 'meilen', 'mile', 'miles'], 1609.344, L, 'mi'],
  [['ft', 'fuß', 'fuss', 'feet', 'foot'], 0.3048, L, 'ft'], [['zoll', 'inch', 'inches'], 0.0254, L, 'Zoll'],
  [['mg'], 1e-6, M, 'mg'], [['g', 'gramm'], 1e-3, M, 'g'], [['kg', 'kilo', 'kilogramm'], 1, M, 'kg'],
  [['t', 'tonne', 'tonnen'], 1e3, M, 't'], [['lb', 'lbs'], 0.45359237, M, 'lb'], [['oz', 'unze', 'unzen'], 0.028349523125, M, 'oz'],
  [['ml'], 1e-6, V, 'ml'], [['cl'], 1e-5, V, 'cl'], [['dl'], 1e-4, V, 'dl'], [['l', 'liter'], 1e-3, V, 'l'],
  [['m³', 'm3', 'kubikmeter'], 1, V, 'm³'], [['gal', 'gallone', 'gallonen', 'gallon', 'gallons'], 0.003785411784, V, 'gal'],
  [['cm²', 'cm2'], 1e-4, A, 'cm²'], [['m²', 'm2', 'qm'], 1, A, 'm²'], [['km²', 'km2'], 1e6, A, 'km²'], [['ha', 'hektar'], 1e4, A, 'ha'],
  [['ms'], 1e-3, T, 'ms'], [['s', 'sek', 'sec', 'sekunde', 'sekunden'], 1, T, 's'],
  [['min', 'minute', 'minuten'], 60, T, 'min'], [['h', 'std', 'stunde', 'stunden', 'hour', 'hours'], 3600, T, 'h'],
  [['d', 'tag', 'tage', 'tagen', 'day', 'days'], 86400, T, 'Tage', 'Tag'],
  [['woche', 'wochen', 'week', 'weeks'], 604800, T, 'Wochen', 'Woche'],
  [['monat', 'monate', 'monaten', 'month', 'months'], 2629746, T, 'Monate', 'Monat'],
  [['jahr', 'jahre', 'jahren', 'year', 'years'], 31556952, T, 'Jahre', 'Jahr'],
  [['j', 'joule'], 1, E, 'J'], [['kj'], 1e3, E, 'kJ'], [['kcal'], 4184, E, 'kcal'],
  [['wh'], 3600, E, 'Wh'], [['kwh'], 3.6e6, E, 'kWh'], [['mwh'], 3.6e9, E, 'MWh'],
  [['w', 'watt'], 1, P, 'W'], [['kw'], 1e3, P, 'kW'],
  [['byte', 'bytes'], 1, B, 'B'], [['kb'], 1e3, B, 'KB'], [['mb'], 1e6, B, 'MB'], [['gb'], 1e9, B, 'GB'], [['tb'], 1e12, B, 'TB'],
];
const UNITS = new Map<string, Disp>();
for (const [names, f, d, label, one] of UNIT_LIST) for (const n of names) UNITS.set(n, { label, f, d, one });

/** Ohne Einheit: Tausend, Millionen … */
const SCALES: Record<string, number> = { k: 1e3, tsd: 1e3, tausend: 1e3, mio: 1e6, million: 1e6, millionen: 1e6, mrd: 1e9, milliarde: 1e9, milliarden: 1e9 };

const BASE: [Dims, string][] = [[L, 'm'], [M, 'kg'], [T, 's'], [A, 'm²'], [V, 'l'], [E, 'kWh'], [P, 'W'], [B, 'B']];

const dimsEq = (a: Dims, b: Dims) => {
  const ka = Object.keys(a), kb = Object.keys(b);
  return ka.length === kb.length && ka.every(k => a[k] === b[k]);
};
const plain = (q: Q) => !Object.keys(q.d).length;
function dimsMul(a: Dims, b: Dims, sign: number): Dims {
  const out: Dims = { ...a };
  for (const k in b) {
    const v = (out[k] || 0) + sign * b[k];
    if (v) out[k] = v; else delete out[k];
  }
  return out;
}
const isTime = (q: Q) => dimsEq(q.d, T);

// ── Zahlen ──────────────────────────────────────────────────────────────────

/** 1.250,50 · 1'250.50 · 2,5 · 2.5 · 1.250 (= 1250) */
function parseNumber(raw: string): number {
  let s = raw.replace(/['’]/g, '');
  const swiss = s !== raw;
  const dots = (s.match(/\./g) || []).length, commas = (s.match(/,/g) || []).length;
  if (swiss) s = s.replace(/,/g, '');
  else if (dots && commas) {
    s = s.lastIndexOf(',') > s.lastIndexOf('.') ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  } else if (commas) {
    s = commas === 1 ? s.replace(',', '.') : s.replace(/,/g, '');
  } else if (dots && /^\d{1,3}(\.\d{3})+$/.test(s)) {
    s = s.replace(/\./g, '');
  } else if (dots > 1) return NaN;
  return Number(s);
}

let locale = 'de-DE';

function fmt(n: number, maxFrac: number, minFrac = 0): string {
  if (!isFinite(n)) throw new Error('inf');
  const r = Number(n.toPrecision(12));
  const abs = Math.abs(r);
  if (abs >= 1e15 || (abs > 0 && abs < 1e-6)) {
    const [m, e] = r.toExponential(6).split('e');
    return `${fmt(Number(m), 6)} × 10^${Number(e)}`;
  }
  return new Intl.NumberFormat(locale, { maximumFractionDigits: maxFrac, minimumFractionDigits: minFrac }).format(r === 0 ? 0 : r);
}

const DAYS = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];
const pad = (n: number) => String(n).padStart(2, '0');

function duration(sec: number): string {
  const neg = sec < 0;
  let s = Math.round(Math.abs(sec));
  const h = Math.floor(s / 3600); s -= h * 3600;
  const m = Math.floor(s / 60); s -= m * 60;
  const parts = [];
  if (h) parts.push(`${fmt(h, 0)} h`);
  if (m || (!h && !s)) parts.push(`${m} min`);
  if (s) parts.push(`${s} s`);
  return (neg ? '−' : '') + parts.join(' ');
}

function show(q: Q, seen: Disp[]): string {
  if (q.kind === 'clock') {
    const s = ((Math.round(q.n / 60) * 60) % 86400 + 86400) % 86400;
    return `${pad(Math.floor(s / 3600))}:${pad(Math.floor(s / 60) % 60)}`;
  }
  if (q.kind === 'date') {
    const d = new Date(Math.round(q.n / 86400) * 86400000);
    return `${DAYS[d.getUTCDay()]}, ${pad(d.getUTCDate())}.${pad(d.getUTCMonth() + 1)}.${d.getUTCFullYear()}`;
  }
  if (q.pct) return `${fmt(q.n * 100, 4)} %`;
  if (plain(q)) return fmt(q.n, 10);
  if (q.cur && dimsEq(q.d, { '¤': 1 })) {
    const v = Math.round(q.n * 100) / 100;
    return `${fmt(v, Number.isInteger(v) ? 0 : 2, Number.isInteger(v) ? 0 : 2)} ${CUR_SHOW[q.cur] || q.cur}`;
  }
  const u = (q.unit && dimsEq(q.unit.d, q.d) ? q.unit : null) || pickSeen(q.d, seen) || baseUnit(q.d);
  if (!u) throw new Error('unit');
  if (isTime(q) && (u.label === 'h' || u.label === 'min')) return duration(q.n);
  const v = q.n / u.f;
  const label = u.d['¤'] && q.cur ? u.label.replace(/^[^/·]+/, CUR_SHOW[q.cur] || q.cur) : u.label;
  if (u.d['¤']) return `${fmt(v, 2)} ${label}`;
  return `${fmt(v, Math.abs(v) >= 1 ? 2 : 4)} ${u.one && Math.abs(v) === 1 ? u.one : label}`;
}

const pickSeen = (d: Dims, seen: Disp[]) => seen.find(s => dimsEq(s.d, d));
function baseUnit(d: Dims): Disp | undefined {
  const b = BASE.find(([bd]) => dimsEq(bd, d));
  return b ? UNITS.get(b[1] === 'l' ? 'l' : b[1].toLowerCase()) || UNITS.get(b[1]) : undefined;
}

// ── Lexer ───────────────────────────────────────────────────────────────────

type Tok =
  | { t: 'num'; v: number; s: number; e: number }
  | { t: 'clock' | 'date'; v: number; s: number; e: number; noYear?: boolean }
  | { t: 'op'; v: string; s: number; e: number }
  | { t: 'cur'; v: string; s: number; e: number }
  | { t: 'var'; v: string; s: number; e: number }
  | { t: 'word'; v: string; s: number; e: number }
  | { t: 'unit'; v: Disp; s: number; e: number }
  | { t: 'scale'; v: number; s: number; e: number }
  | { t: 'fn' | 'kw' | 'const'; v: string; s: number; e: number }
  | { t: 'other'; v: string; s: number; e: number };

const OPS: Record<string, string> = { '+': '+', '-': '-', '−': '-', '–': '-', '*': '*', '×': '*', '·': '*', '/': '/', '÷': '/', ':': '/', '^': '^', '(': '(', ')': ')', ';': ';', ',': ';', '%': '%', '²': '²', '³': '³', '√': '√' };
const FNS = new Set(['sqrt', 'wurzel', 'round', 'runden', 'rund', 'floor', 'abrunden', 'ceil', 'aufrunden', 'abs', 'betrag', 'min', 'max', 'sin', 'cos', 'tan', 'ln', 'log', 'exp']);
const KW: Record<string, string> = {
  mal: '*', plus: '+', minus: '-', durch: '/', geteilt: '/', x: '*', pro: '/', je: '/',
  von: 'von', of: 'von', in: 'in', als: 'in', to: 'in', bis: 'bis', seit: 'seit', heute: 'heute', today: 'heute', jetzt: 'jetzt', now: 'jetzt',
};
const CONSTS: Record<string, number> = { pi: Math.PI, 'π': Math.PI };

function todayDays(): number {
  const d = new Date();
  return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86400000;
}

function lex(src: string, vars: Map<string, Q>): Tok[] {
  const out: Tok[] = [];
  const names = [...vars.keys()].sort((a, b) => b.length - a.length);
  const low = src.toLowerCase();
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    const rest = src.slice(i);
    let m: RegExpExecArray | null;
    if ((m = /^([01]?\d|2[0-3]):([0-5]\d)(?![\d:])/.exec(rest))) {
      out.push({ t: 'clock', v: Number(m[1]) * 3600 + Number(m[2]) * 60, s: i, e: i + m[0].length });
      i += m[0].length; continue;
    }
    if ((m = /^(\d{1,2})\.(\d{1,2})\.(\d{4}|\d{2})?(?!\d)/.exec(rest)) && Number(m[1]) >= 1 && Number(m[1]) <= 31 && Number(m[2]) >= 1 && Number(m[2]) <= 12) {
      const y = m[3] ? (m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3])) : new Date().getFullYear();
      out.push({ t: 'date', v: Date.UTC(y, Number(m[2]) - 1, Number(m[1])) / 1000, s: i, e: i + m[0].length, noYear: !m[3] });
      i += m[0].length; continue;
    }
    if ((m = /^\d(?:[\d'’.,]*\d)?/.exec(rest))) {
      out.push({ t: 'num', v: parseNumber(m[0]), s: i, e: i + m[0].length });
      i += m[0].length; continue;
    }
    if (SYMBOL_CUR[c]) { out.push({ t: 'cur', v: SYMBOL_CUR[c], s: i, e: i + 1 }); i++; continue; }
    // „Einkauf: 2 + 3 =“ – Doppelpunkt nach einem Wort ist Text, kein Geteilt.
    if (c === ':' && i > 0 && /[\p{L}]/u.test(src[i - 1])) { out.push({ t: 'other', v: c, s: i, e: i + 1 }); i++; continue; }
    if (OPS[c]) { out.push({ t: 'op', v: OPS[c], s: i, e: i + 1 }); i++; continue; }
    if (/[\p{L}_π]/u.test(c)) {
      const before = i ? src[i - 1] : ' ';
      const name = /[\p{L}\p{N}_]/u.test(before) ? undefined : names.find(n => low.startsWith(n, i) && !/[\p{L}\p{N}_]/u.test(src[i + n.length] || ' '));
      if (name) { out.push({ t: 'var', v: name, s: i, e: i + name.length }); i += name.length; continue; }
      m = /^[\p{L}_π][\p{L}\p{N}_²³]*/u.exec(rest)!;
      out.push({ t: 'word', v: m[0], s: i, e: i + m[0].length });
      i += m[0].length; continue;
    }
    out.push({ t: 'other', v: c, s: i, e: i + 1 });
    i++;
  }
  return classify(out);
}

const valueEnd = (t: Tok | undefined) => !!t && (t.t === 'num' || t.t === 'cur' || t.t === 'unit' || t.t === 'scale' || t.t === 'var' || t.t === 'clock' || t.t === 'date' || t.t === 'const' || (t.t === 'op' && (t.v === ')' || t.v === '%' || t.v === '²' || t.v === '³')));
const unitSpot = (t: Tok | undefined) => !!t && (valueEnd(t) && t.t !== 'var' && t.t !== 'const' || (t.t === 'op' && t.v === '/') || (t.t === 'kw' && (t.v === 'in' || t.v === '/')));

/** Wörter einordnen: Einheit, Währung, Funktion, Schlüsselwort oder Text. */
function classify(toks: Tok[]): Tok[] {
  const out: Tok[] = [];
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.t !== 'word') { out.push(t); continue; }
    const w = t.v, lw = w.toLowerCase();
    const prev = out[out.length - 1];
    const next = toks[i + 1];
    if (/^[A-Z]{3}$/.test(w) && CODES.includes(w)) { out.push({ ...t, t: 'cur', v: w }); continue; }
    if (WORD_CUR[lw] && (unitSpot(prev) || next?.t === 'num')) { out.push({ ...t, t: 'cur', v: WORD_CUR[lw] }); continue; }
    if (FNS.has(lw) && next?.t === 'op' && next.v === '(') { out.push({ ...t, t: 'fn', v: lw }); continue; }
    if (CONSTS[lw] !== undefined) { out.push({ ...t, t: 'const', v: lw }); continue; }
    if (SCALES[lw] && prev?.t === 'num') { out.push({ ...t, t: 'scale', v: SCALES[lw] }); continue; }
    const kw = KW[lw];
    if (kw === 'in') {
      const n = toks[i + 1];
      const nl = n?.t === 'word' ? n.v.toLowerCase() : '';
      if (n && (n.t === 'cur' || (n.t === 'word' && (UNITS.has(nl) || WORD_CUR[nl] || CODES.includes(n.v)))) && valueEnd(prev)) { out.push({ ...t, t: 'kw', v: 'in' }); continue; }
    } else if (kw === '*' && lw === 'x') {
      if (valueEnd(prev) && next && (next.t === 'num' || next.t === 'cur' || next.t === 'var')) { out.push({ ...t, t: 'op', v: '*' }); continue; }
    } else if (kw && kw.length === 1) {
      if (valueEnd(prev) || kw === '-') { out.push({ ...t, t: 'op', v: kw }); continue; }
    } else if (kw) { out.push({ ...t, t: 'kw', v: kw }); continue; }
    if (UNITS.has(w) || UNITS.has(lw)) {
      if (unitSpot(prev)) { out.push({ ...t, t: 'unit', v: (UNITS.get(w) || UNITS.get(lw))! }); continue; }
    }
    out.push(t);
  }
  return out;
}

// ── Rechnen ─────────────────────────────────────────────────────────────────

const num = (n: number): Q => ({ n, d: {} });
function fail(why = 'syntax'): never { throw new Error(why); }

function curOf(q: Q) { return q.d['¤'] ? q.cur : undefined; }

function addQ(a: Q, b: Q, sign: number): Q {
  if (b.pct && !a.pct) return { ...a, n: a.n * (1 + sign * b.n) };
  if (a.kind || b.kind) {
    if (a.kind && b.kind) {
      if (sign > 0 || a.kind !== b.kind) fail('kind');
      let n = a.n - b.n;
      if (a.kind === 'clock' && n < 0) n += 86400;
      return { n, d: T, unit: a.kind === 'date' ? UNITS.get('tage') : UNITS.get('h') };
    }
    if (b.kind) { if (sign < 0) fail('kind'); [a, b] = [b, a]; }
    if (!isTime(b)) fail('kind');
    if (a.kind === 'date') {
      const lbl = b.unit?.label;
      const k = b.unit ? b.n / b.unit.f : 0;
      if ((lbl === 'Monate' || lbl === 'Jahre') && Number.isInteger(Math.round(k * 1e9) / 1e9)) {
        const d = new Date(a.n * 1000);
        const months = Math.round(k) * (lbl === 'Jahre' ? 12 : 1) * sign;
        d.setUTCMonth(d.getUTCMonth() + months);
        return { n: d.getTime() / 1000, d: {}, kind: 'date' };
      }
      return { n: Math.round((a.n + sign * b.n) / 86400) * 86400, d: {}, kind: 'date' };
    }
    return { n: a.n + sign * b.n, d: {}, kind: 'clock' };
  }
  // Zahl ohne Einheit neben einer mit: gleiche Einheit annehmen (5 € + 3 = 8 €).
  if (plain(a) && !plain(b) && !a.pct) a = { ...b, n: a.n * (b.unit && !b.cur ? b.unit.f : 1) };
  if (plain(b) && !plain(a) && !b.pct) b = { ...a, n: b.n * (a.unit && !a.cur ? a.unit.f : 1) };
  if (!dimsEq(a.d, b.d)) fail('dims');
  let bn = b.n;
  const ca = curOf(a), cb = curOf(b);
  if (ca && cb && ca !== cb) bn = convert(bn, cb, ca);
  return { ...a, n: a.n + sign * bn, unit: a.unit || b.unit, pct: a.pct && b.pct };
}

function compose(a: Q, b: Q, sign: number, d: Dims, seen: Disp[]): Disp | undefined {
  if (!Object.keys(d).length) return undefined;
  const s = pickSeen(d, seen);
  if (s) return s;
  const den = b.unit && (b.unit.one || b.unit.label);
  if (!a.unit) return sign > 0 ? b.unit : b.unit && { label: `1/${den}`, f: 1 / b.unit.f, d };
  if (!b.unit) return a.unit;
  const label = sign > 0 ? (a.unit.label === b.unit.label ? `${a.unit.label}²` : `${a.unit.label}·${b.unit.label}`) : `${a.unit.label}/${den}`;
  return { label, f: sign > 0 ? a.unit.f * b.unit.f : a.unit.f / b.unit.f, d };
}

function mulQ(a: Q, b: Q, sign: number, seen: Disp[]): Q {
  if (a.kind || b.kind) fail('kind');
  if (plain(b) && !b.unit) return { ...a, n: sign > 0 ? a.n * b.n : a.n / b.n, pct: !!a.pct && !b.pct };
  if (plain(a) && !a.unit && sign > 0) return { ...b, n: a.n * b.n, pct: false };
  let bn = b.n;
  const ca = curOf(a), cb = curOf(b);
  if (ca && cb) {
    if (sign > 0) fail('cur');
    if (ca !== cb) bn = convert(bn, cb, ca);
  }
  const d = dimsMul(a.d, b.d, sign);
  return { n: sign > 0 ? a.n * bn : a.n / bn, d, cur: d['¤'] ? ca || cb : undefined, unit: compose(a, b, sign, d, seen) };
}

function powQ(a: Q, b: Q): Q {
  if (!plain(b) || b.kind || a.kind) fail('pow');
  if (plain(a)) return num(Math.pow(a.n, b.n));
  if (!Number.isInteger(b.n) || a.d['¤']) fail('pow');
  const d: Dims = {};
  for (const k in a.d) d[k] = a.d[k] * b.n;
  return { n: Math.pow(a.n, b.n), d, unit: a.unit && { label: `${a.unit.label}${b.n === 2 ? '²' : b.n === 3 ? '³' : '^' + b.n}`, f: Math.pow(a.unit.f, b.n), d } };
}

function unitQ(u: Disp, seen: Disp[]): Q {
  if (!seen.includes(u)) seen.push(u);
  return { n: u.f, d: u.d, unit: u };
}
function curQ(code: string, seen: Disp[]): Q {
  const u: Disp = { label: CUR_SHOW[code] || code, f: 1, d: { '¤': 1 } };
  if (!seen.some(s => s.d['¤'] === 1 && Object.keys(s.d).length === 1)) seen.push(u);
  return { n: 1, d: u.d, cur: code, unit: u };
}

function compare(a: Q, b: Q): number {
  return addQ(a, b, -1).n;
}

class Parser {
  i = 0;
  values = 0;
  seen: Disp[] = [];
  target: Disp | null = null;
  targetCur: string | null = null;
  constructor(private toks: Tok[], private vars: Map<string, Q>) {}

  peek() { return this.toks[this.i]; }
  isOp(v: string) { const t = this.peek(); return !!t && t.t === 'op' && t.v === v; }
  isKw(v: string) { const t = this.peek(); return !!t && t.t === 'kw' && t.v === v; }
  eat(v: string) { if (!this.isOp(v)) fail(); this.i++; }

  statement(): Q {
    const q = this.sum();
    if (this.isKw('in')) {
      this.i++;
      this.unitTarget();
    }
    if (this.i < this.toks.length) fail('rest');
    if (!this.values) fail('empty');
    return q;
  }

  unitTarget() {
    const t = this.peek();
    if (t?.t === 'cur') { this.i++; this.targetCur = t.v; return; }
    const w = t?.t === 'word' || t?.t === 'unit' ? t : null;
    if (!w) fail();
    this.i++;
    let u: Disp | undefined = w.t === 'unit' ? w.v : UNITS.get(w.v) || UNITS.get(w.v.toLowerCase());
    if (!u && w.t === 'word') { const c = WORD_CUR[w.v.toLowerCase()]; if (c) { this.targetCur = c; return; } }
    if (!u) fail();
    while (this.isOp('/') || this.isOp('²') || this.isOp('³')) {
      const op = (this.peek() as { v: string }).v;
      this.i++;
      if (op !== '/') { const k = op === '²' ? 2 : 3; const d: Dims = {}; for (const x in u!.d) d[x] = u!.d[x] * k; u = { label: u!.label + op, f: Math.pow(u!.f, k), d }; continue; }
      const n = this.peek();
      const v = n?.t === 'unit' ? n.v : n?.t === 'word' ? UNITS.get(n.v.toLowerCase()) : undefined;
      if (!v) fail();
      this.i++;
      u = { label: `${u!.label}/${v!.label}`, f: u!.f / v!.f, d: dimsMul(u!.d, v!.d, -1) };
    }
    this.target = u!;
  }

  sum(): Q {
    let a = this.prod();
    while (this.isOp('+') || this.isOp('-')) {
      const sign = this.isOp('+') ? 1 : -1;
      this.i++;
      a = addQ(a, this.prod(), sign);
    }
    return a;
  }

  startsValue(): boolean {
    const t = this.peek();
    if (!t) return false;
    return t.t === 'num' || t.t === 'var' || t.t === 'cur' || t.t === 'fn' || t.t === 'const' || t.t === 'clock' || t.t === 'date' || (t.t === 'kw' && (t.v === 'heute' || t.v === 'jetzt' || t.v === 'bis' || t.v === 'seit')) || (t.t === 'op' && (t.v === '(' || t.v === '√'));
  }

  prod(): Q {
    let a = this.unary();
    for (;;) {
      if (this.isOp('*') || this.isOp('/')) {
        const sign = this.isOp('*') ? 1 : -1;
        this.i++;
        a = mulQ(a, this.unary(), sign, this.seen);
      } else if (this.isKw('von')) {
        this.i++;
        const b = this.unary();
        a = mulQ({ ...a, pct: false }, b, 1, this.seen);
      } else if (this.startsValue()) {
        const b = this.unary();
        // 2 h 45 min, 1 m 20 cm: gleiche Größe ohne Zeichen dazwischen → addieren.
        if (!plain(a) && !plain(b) && dimsEq(a.d, b.d) && !a.kind && !b.kind) a = addQ(a, b, 1);
        else a = mulQ(a, b, 1, this.seen);
      } else return a;
    }
  }

  unary(): Q {
    if (this.isOp('-')) { this.i++; const q = this.unary(); return { ...q, n: -q.n }; }
    if (this.isOp('+')) { this.i++; return this.unary(); }
    return this.pow();
  }

  pow(): Q {
    const a = this.postfix();
    if (this.isOp('^')) { this.i++; return powQ(a, this.unary()); }
    return a;
  }

  postfix(): Q {
    let a = this.primary();
    for (;;) {
      const t = this.peek();
      if (!t) return a;
      if (t.t === 'op' && t.v === '%') { this.i++; a = { ...a, n: a.n / 100, pct: true }; continue; }
      if (t.t === 'op' && (t.v === '²' || t.v === '³')) { this.i++; a = powQ(a, num(t.v === '²' ? 2 : 3)); continue; }
      if (t.t === 'scale') { this.i++; a = { ...a, n: a.n * t.v }; continue; }
      if (t.t === 'unit') { this.i++; a = mulQ(a, unitQ(t.v, this.seen), 1, this.seen); continue; }
      if (t.t === 'cur' && !a.d['¤']) { this.i++; a = mulQ(a, curQ(t.v, this.seen), 1, this.seen); continue; }
      return a;
    }
  }

  primary(): Q {
    const t = this.peek();
    if (!t) return fail();
    this.i++;
    switch (t.t) {
      case 'num': this.values++; return num(t.v);
      case 'var': this.values++; return { ...this.vars.get(t.v)! };
      case 'const': this.values++; return num(CONSTS[t.v]);
      case 'clock': this.values++; return { n: t.v, d: {}, kind: 'clock' };
      case 'date': this.values++; return { n: t.v, d: {}, kind: 'date' };
      case 'unit': return unitQ(t.v, this.seen);
      case 'cur': {
        // € 50, CHF 20 — sonst 1 Einheit der Währung (für €/h).
        if (this.startsValue() && (this.peek()!.t === 'num' || this.peek()!.t === 'var')) return mulQ(this.postfix(), curQ(t.v, this.seen), 1, this.seen);
        return curQ(t.v, this.seen);
      }
      case 'kw':
        if (t.v === 'heute') { this.values++; return { n: todayDays() * 86400, d: {}, kind: 'date' }; }
        if (t.v === 'jetzt') { const d = new Date(); this.values++; return { n: d.getHours() * 3600 + d.getMinutes() * 60, d: {}, kind: 'clock' }; }
        if (t.v === 'bis' || t.v === 'seit') {
          const nx = this.peek();
          const q = this.postfix();
          if (q.kind !== 'date') fail();
          const today = todayDays() * 86400;
          let target = q.n;
          if (t.v === 'bis' && nx?.t === 'date' && nx.noYear && target < today) {
            const d = new Date(target * 1000); d.setUTCFullYear(d.getUTCFullYear() + 1); target = d.getTime() / 1000;
          }
          return { n: t.v === 'bis' ? target - today : today - target, d: T, unit: UNITS.get('tage') };
        }
        return fail();
      case 'fn': return this.call(t.v);
      case 'op':
        if (t.v === '(') { const q = this.sum(); this.eat(')'); return q; }
        if (t.v === '√') return this.fn('sqrt', [this.postfix()]);
        return fail();
      default: return fail();
    }
  }

  call(name: string): Q {
    this.eat('(');
    const args = [this.sum()];
    while (this.isOp(';')) { this.i++; args.push(this.sum()); }
    this.eat(')');
    return this.fn(name, args);
  }

  fn(name: string, args: Q[]): Q {
    const [a, b] = args;
    const map1 = (f: (x: number) => number): Q => {
      if (args.length !== 1 || a.kind) fail('args');
      if (plain(a)) return { ...a, n: f(a.n) };
      const uf = a.unit?.f || 1;
      return { ...a, n: f(a.n / uf) * uf };
    };
    switch (name) {
      case 'sqrt': case 'wurzel':
        if (!plain(a)) { const d: Dims = {}; for (const k in a.d) { if (a.d[k] % 2) fail(); d[k] = a.d[k] / 2; } return { n: Math.sqrt(a.n), d, unit: pickSeen(d, this.seen) }; }
        return num(Math.sqrt(a.n));
      case 'round': case 'runden': case 'rund': {
        const p = b ? Math.pow(10, b.n) : 1;
        if (args.length > 2) fail();
        const uf = plain(a) ? 1 : a.unit?.f || 1;
        return { ...a, n: Math.round(a.n / uf * p) / p * uf };
      }
      case 'floor': case 'abrunden': return map1(Math.floor);
      case 'ceil': case 'aufrunden': return map1(Math.ceil);
      case 'abs': case 'betrag': return map1(Math.abs);
      case 'min': case 'max': return args.reduce((x, y) => ((compare(x, y) < 0) === (name === 'min') ? x : y));
      case 'sin': case 'cos': case 'tan': case 'ln': case 'log': case 'exp': {
        if (args.length !== 1 || !plain(a)) fail();
        const f = ({ sin: Math.sin, cos: Math.cos, tan: Math.tan, ln: Math.log, log: Math.log10, exp: Math.exp } as Record<string, (x: number) => number>)[name];
        return num(f(a.n));
      }
    }
    return fail();
  }
}

function evaluate(src: string, vars: Map<string, Q>, strict: boolean): { q: Q; text: string } | null {
  try {
    let toks = lex(src, vars);
    if (strict) {
      if (toks.some(t => t.t === 'word' || t.t === 'other')) return null;
    } else toks = toks.filter(t => t.t !== 'word' && t.t !== 'other');
    if (!toks.length) return null;
    const p = new Parser(toks, vars);
    let q = p.statement();
    if (p.targetCur) {
      const from = curOf(q);
      if (!from || !dimsEq(q.d, { '¤': 1 })) return null;
      q = { ...q, n: convert(q.n, from, p.targetCur), cur: p.targetCur };
    } else if (p.target) {
      if (!dimsEq(p.target.d, q.d)) return null;
      q = { ...q, unit: p.target };
    }
    const text = show(q, p.seen);
    return { q: { ...q, unit: q.unit || (plain(q) ? undefined : (pickSeen(q.d, p.seen))) }, text };
  } catch {
    return null;
  }
}

/** Wert einer Zeile ohne = für Summen: die letzte Zahl samt Einheit („Brot 2,50 €“). */
function lineValue(src: string, vars: Map<string, Q>): Q | null {
  // „3 * 150 € = 450 €“: zählt der Wert hinter dem letzten =.
  const eq = src.lastIndexOf('=');
  if (eq >= 0 && src.slice(eq + 1).trim()) src = src.slice(eq + 1);
  const toks = lex(src, vars).filter(t => t.t !== 'word' && t.t !== 'other');
  const explicit = toks.some((t, k) => t.t === 'op' && /^[+\-*/]$/.test(t.v) && k > 0 && valueEnd(toks[k - 1]));
  if (explicit) return evaluate(src, vars, false)?.q || null;
  let k = -1;
  for (let j = toks.length - 1; j >= 0; j--) if (toks[j].t === 'num' || toks[j].t === 'var') { k = j; break; }
  if (k < 0) return null;
  let from = k, to = k + 1;
  if (k > 0 && toks[k - 1].t === 'cur') from = k - 1;
  while (to < toks.length && (toks[to].t === 'unit' || toks[to].t === 'cur' || toks[to].t === 'scale' || (toks[to].t === 'op' && (toks[to].v === '²' || toks[to].v === '³')))) to++;
  if (to < toks.length && toks[to].t === 'op' && toks[to].v === '%') return null;
  const neg = from > 0 && toks[from - 1].t === 'op' && toks[from - 1].v === '-' && toks[from - 1].e === toks[from].s && (from < 2 || !valueEnd(toks[from - 2]));
  try {
    const p = new Parser(toks.slice(from, to), vars);
    const q = p.statement();
    if (q.kind) return null;
    return neg ? { ...q, n: -q.n } : q;
  } catch { return null; }
}

// ── Zusammenfassen: Summe =, Durchschnitt = … ───────────────────────────────

type Agg = 'sum' | 'avg' | 'count' | 'min' | 'max';
const AGG: Record<string, Agg> = {
  summe: 'sum', gesamt: 'sum', total: 'sum', sum: 'sum', zwischensumme: 'sum', insgesamt: 'sum', subtotal: 'sum',
  durchschnitt: 'avg', schnitt: 'avg', mittel: 'avg', mittelwert: 'avg', average: 'avg', avg: 'avg', ø: 'avg',
  anzahl: 'count', count: 'count', min: 'min', minimum: 'min', max: 'max', maximum: 'max',
};
/** „Summe“, „Summe Lebensmittel:“ – ein Schlüsselwort, danach nur Text. */
function aggOf(text: string): Agg | null {
  const m = /^\s*\**([\p{L}ø]+)\**([^\d+\-*/×÷^()=%]*)$/u.exec(text);
  if (!m) return null;
  return AGG[m[1].toLowerCase()] || null;
}

function aggregate(kind: Agg, items: (Q | null)[], count: number): Q | null {
  if (kind === 'count') return num(count);
  // Zahlen ohne Einheit zählen in der Einheit der anderen (Spalte „Betrag“ mit 450 € und 120).
  let vals = items.filter((q): q is Q => !!q && !q.kind);
  if (vals.some(q => q.pct) && vals.some(q => !q.pct)) vals = vals.filter(q => !q.pct);
  if (!vals.length) return null;
  try {
    if (kind === 'min' || kind === 'max') return vals.reduce((x, y) => ((compare(x, y) < 0) === (kind === 'min') ? x : y));
    let s = vals[0];
    for (const v of vals.slice(1)) s = addQ(s, v, 1);
    return kind === 'avg' ? { ...s, n: s.n / vals.length } : s;
  } catch { return null; }
}

// ── Dokument ────────────────────────────────────────────────────────────────

interface Line {
  kind: 'skip' | 'blank' | 'heading' | 'text' | 'table';
  raw: string;
  /** Text ohne Listen-, Zitat- und Überschriftszeichen. */
  body: string;
  off: number;
  value?: Q | null;
  agg?: Agg;
  done?: boolean;
}

const PREFIX = /^(\s*(?:>\s?)*\s*(?:[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+)?(?:#{1,6}\s+)?)/;

function maskCode(s: string): string {
  return s.replace(/`[^`]*`/g, m => ' '.repeat(m.length)).replace(/\$[^$\s][^$]*\$/g, m => ' '.repeat(m.length));
}

/** Endet die Zeile auf ein einzelnes = ? Liefert dessen Index. */
function trailingEq(s: string): number {
  const t = s.trimEnd();
  if (!t.endsWith('=')) return -1;
  const before = t[t.length - 2];
  if (before && /[=<>!≠:]/.test(before)) return -1;
  return t.length - 1;
}

const ASSIGN = /^\s*([\p{L}_][\p{L}\p{N}_]*(?: [\p{L}_][\p{L}\p{N}_]*){0,3})\s*=(?!=)\s*(.+)$/u;

function splitCells(raw: string): { text: string; s: number }[] {
  const cells: { text: string; s: number }[] = [];
  let start = 0, i = 0;
  const lead = /^\s*\|/.exec(raw);
  if (lead) start = i = lead[0].length;
  for (; i <= raw.length; i++) {
    if (i === raw.length || (raw[i] === '|' && raw[i - 1] !== '\\')) {
      cells.push({ text: raw.slice(start, i), s: start });
      start = i + 1;
    }
  }
  if (cells.length && !cells[cells.length - 1].text.trim()) cells.pop();
  return cells;
}
const DELIM = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

export function calc(src: string): CalcHit[] {
  missingRates = false;
  if (!src.includes('=')) return [];
  locale = /\d['’]\d{3}/.test(src) ? 'de-CH' : 'de-DE';
  const raws = src.split('\n');
  const lines: Line[] = [];
  let fence: string | null = null, mathBlock = false;
  for (let i = 0; i < raws.length; i++) {
    const raw = raws[i];
    const tr = raw.trim();
    if (i === 0 && tr === '---') {
      let j = 1;
      while (j < raws.length && raws[j].trim() !== '---') j++;
      if (j < raws.length) { for (let k = 0; k <= j; k++) lines.push({ kind: 'skip', raw: raws[k], body: '', off: 0 }); i = j; continue; }
    }
    const fm = /^\s*(?:>\s?)*\s*(`{3,}|~{3,})/.exec(raw);
    if (fence) { lines.push({ kind: 'skip', raw, body: '', off: 0 }); if (fm && fm[1][0] === fence[0] && fm[1].length >= fence.length) fence = null; continue; }
    if (fm) { fence = fm[1]; lines.push({ kind: 'skip', raw, body: '', off: 0 }); continue; }
    if (mathBlock) { lines.push({ kind: 'skip', raw, body: '', off: 0 }); if (tr.endsWith('$$')) mathBlock = false; continue; }
    if (tr.startsWith('$$')) { mathBlock = !(tr.length > 2 && tr.endsWith('$$') && tr.length >= 4); lines.push({ kind: 'skip', raw, body: '', off: 0 }); continue; }
    if (!tr || /^(?:>\s?)*$/.test(tr)) { lines.push({ kind: 'blank', raw, body: '', off: 0 }); continue; }
    const quote = /^\s*(?:>\s?)*/.exec(raw)![0];
    if (raw.slice(quote.length).trimStart().startsWith('|')) { lines.push({ kind: 'table', raw, body: '', off: quote.length }); continue; }
    const pre = PREFIX.exec(raw)![0];
    lines.push({ kind: /#{1,6}\s/.test(pre) ? 'heading' : 'text', raw, body: maskCode(raw.slice(pre.length)), off: pre.length });
  }

  const vars = new Map<string, Q>();
  const hits: CalcHit[] = [];
  const valueAt = (l: Line): Q | null => {
    if (l.value === undefined) l.value = lineValue(l.body, vars);
    return l.value;
  };

  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.kind === 'table') {
      let j = i;
      while (j + 1 < lines.length && lines[j + 1].kind === 'table') j++;
      table(lines, i, j, vars, hits);
      i = j;
      continue;
    }
    if (l.kind !== 'text' && l.kind !== 'heading') continue;
    if (!l.body.includes('=')) continue;
    const eq = trailingEq(l.body);
    if (eq >= 0) {
      const body = l.body.slice(0, eq);
      if (body.includes('==')) continue;
      const at = l.off + eq + 1;
      const agg = aggOf(body);
      if (agg) {
        const items: (Q | null)[] = [];
        let count = 0;
        let k = i - 1;
        while (k >= 0 && lines[k].kind === 'blank') k--;
        for (; k >= 0; k--) {
          const p = lines[k];
          if (p.kind !== 'text') break;
          if (p.agg) {
            // Zwischensumme darüber: Summe läuft weiter, Schnitt & Co. überspringen sie.
            if (p.agg === 'sum' && agg === 'sum') { items.push(p.value ?? null); count++; break; }
            continue;
          }
          const v = valueAt(p);
          if (v || p.body.trim()) count++;
          items.push(v);
        }
        const q = aggregate(agg, items.reverse(), count);
        l.agg = agg;
        l.value = q;
        if (q) { const r = evalShow(q); if (r) hits.push({ line: i, at, text: r }); }
        continue;
      }
      const a = ASSIGN.exec(body);
      const r = a ? evaluate(a[2], vars, false) : evaluate(body, vars, false);
      if (!r) { l.value = null; continue; }
      if (a) vars.set(a[1].toLowerCase(), r.q);
      l.value = r.q;
      hits.push({ line: i, at, text: r.text });
      continue;
    }
    const a = ASSIGN.exec(l.body);
    if (a) {
      // „Miete = 1.250 € pro Monat“: Miete * 12 soll Euro ergeben, nicht Euro pro Monat.
      // Stunden, Tage & Co. bleiben echte Einheiten (95 € pro h).
      const r = evaluate(a[2].replace(/\s+(?:pro|je)\s+(?:monat|jahr|woche|person|kopf|stück|stk)\s*$/iu, ''), vars, true) || evaluate(a[2], vars, true);
      if (r) { vars.set(a[1].toLowerCase(), r.q); l.value = r.q; }
    }
  }
  return hits;
}

function evalShow(q: Q): string | null {
  try { return show(q, q.unit ? [q.unit] : []); } catch { return null; }
}

function table(lines: Line[], from: number, to: number, vars: Map<string, Q>, hits: CalcHit[]) {
  if (to - from < 2 || !DELIM.test(lines[from + 1].raw.slice(lines[from + 1].off))) return;
  if (!lines.slice(from + 2, to + 1).some(l => l.raw.includes('='))) return;
  const rows: { cells: { text: string; s: number }[]; line: number }[] = [];
  for (let i = from + 2; i <= to; i++) rows.push({ cells: splitCells(lines[i].raw.slice(lines[i].off)).map(c => ({ ...c, s: c.s + lines[i].off })), line: i });
  type Cell = { value: Q | null; agg?: Agg };
  const grid: Cell[][] = rows.map(() => []);
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r];
    let rowAgg: Agg | undefined; // Art der Zusammenfassung für leere „=“-Zellen, einmal pro Zeile
    for (let c = 0; c < row.cells.length; c++) {
      const cell = row.cells[c];
      const text = maskCode(cell.text);
      const eq = trailingEq(text);
      if (eq < 0) { grid[r][c] = { value: lineValue(text, vars) }; continue; }
      const at = cell.s + eq + 1;
      const body = text.slice(0, eq);
      let agg: Agg | null = body.trim() ? aggOf(body) : null;
      if (!body.trim()) agg = rowAgg ??= row.cells.map(x => aggOf(x.text.trim())).find(Boolean) || 'sum';
      if (agg) {
        const items: (Q | null)[] = [];
        let count = 0;
        for (let k = r - 1; k >= 0; k--) {
          const g = grid[k][c];
          if (!g) continue;
          if (g.agg) { if (g.agg === 'sum' && agg === 'sum') { items.push(g.value); count++; break; } continue; }
          items.push(g.value);
          if (g.value || rows[k].cells[c]?.text.trim()) count++;
        }
        const q = aggregate(agg, items.reverse(), count);
        grid[r][c] = { value: q, agg };
        const s = q && evalShow(q);
        if (s) hits.push({ line: row.line, at, text: s, cell: c });
        continue;
      }
      const res = evaluate(body, vars, false);
      grid[r][c] = { value: res?.q || null };
      if (res) hits.push({ line: row.line, at, text: res.text, cell: c });
    }
  }
}
