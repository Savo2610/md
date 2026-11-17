// Packliste: Datenmodell, Kategorien, Mengen-Erkennung und Markdown
// (Server und Browser). Übernommen aus der Packliste-App (packliste.veerka.mp).
//
// Eine Packliste ist ein Dokument mit `kind = pack`. Das Yjs-Dokument hält:
//   meta     Y.Map             title
//   items    Y.Map<id, Y.Map>  name, qty (Bedarf), mode, cat, at (angelegt)
//   claims   Y.Map<string, n>  `${Artikel}|${Person}` → eingepackte Menge
//   members  Y.Map<id, name>   wer schon mal auf der Liste war
//
// Abhaken heißt „ich habe das eingepackt“. Jede Person schreibt nur ihre
// eigenen Schlüssel in `claims`, dadurch gibt es beim Abhaken keine
// Konflikte. Zwei Packmodi:
//   persoenlich  jeder braucht sein eigenes; erledigt, sobald *ich* es habe
//   gemeinsam    die Gruppe braucht `qty` Stück; erledigt, wenn die Summe reicht

import * as Y from 'yjs';

export type PackMode = 'persoenlich' | 'gemeinsam';

export interface PackItem {
  id: string;
  name: string;
  qty: number;
  mode: PackMode;
  cat: string;
  at: number;
}

export interface Claim { member: string; name: string; qty: number }

export interface ItemState {
  need: number;
  mine: number;
  total: number;
  remaining: number;
  by: Claim[];
  done: boolean;
}

export const MAX_PACK_ITEMS = 2000;
export const MAX_QTY = 99;

// ── Kategorien ──────────────────────────────────────────────────────────────

export const CATEGORIES: { id: string; label: string }[] = [
  { id: 'kleidung', label: 'Kleidung & Schuhe' },
  { id: 'hygiene', label: 'Hygiene & Gesundheit' },
  { id: 'technik', label: 'Technik' },
  { id: 'dokumente', label: 'Dokumente & Geld' },
  { id: 'ausruestung', label: 'Ausrüstung' },
  { id: 'kueche', label: 'Küche & Proviant' },
  { id: 'sonstiges', label: 'Sonstiges' },
];
export const DEFAULT_CATEGORY = 'sonstiges';
const CATEGORY_IDS = new Set(CATEGORIES.map(c => c.id));
export const categoryLabel = (id: string) => CATEGORIES.find(c => c.id === id)?.label || 'Sonstiges';
export const validCategory = (id: unknown): string => (typeof id === 'string' && CATEGORY_IDS.has(id) ? id : DEFAULT_CATEGORY);

const ITEM_DB: Record<string, string[]> = {
  kleidung: [
    'T-Shirt', 'Longsleeve', 'Hemd', 'Bluse', 'Pullover', 'Hoodie', 'Fleecejacke',
    'Jacke', 'Regenjacke', 'Softshelljacke', 'Winterjacke', 'Daunenjacke', 'Mantel',
    'Jeans', 'Hose', 'Jogginghose', 'Kurze Hose', 'Rock', 'Kleid', 'Skihose',
    'Unterwäsche', 'Socken', 'Wandersocken', 'Skisocken', 'Thermounterwäsche',
    'Funktionsunterwäsche', 'BH', 'Schlafanzug', 'Badehose', 'Bikini', 'Badeanzug',
    'Mütze', 'Cap', 'Stirnband', 'Schal', 'Buff', 'Handschuhe', 'Gürtel',
    'Sonnenbrille', 'Regenponcho', 'Kostüm', 'Bandana',
    'Sneaker', 'Turnschuhe', 'Wanderschuhe', 'Wanderstiefel', 'Winterschuhe',
    'Gummistiefel', 'Sandalen', 'Flip-Flops', 'Badelatschen', 'Hausschuhe',
    'Laufschuhe', 'Skischuhe', 'Snowboardboots', 'Schuhbeutel',
  ],
  hygiene: [
    'Zahnbürste', 'Zahnpasta', 'Zahnseide', 'Mundwasser', 'Duschgel', 'Shampoo',
    'Conditioner', 'Seife', 'Deo', 'Rasierer', 'Rasierschaum', 'Handtuch',
    'Mikrofaserhandtuch', 'Badetuch', 'Waschlappen', 'Haarbürste', 'Kamm',
    'Haargummi', 'Föhn', 'Nagelschere', 'Nagelfeile', 'Pinzette', 'Wattestäbchen',
    'Taschentücher', 'Feuchttücher', 'Toilettenpapier', 'Sonnencreme', 'After Sun',
    'Lippenpflege', 'Bodylotion', 'Handcreme', 'Make-up', 'Abschminktücher',
    'Parfum', 'Kulturbeutel', 'Desinfektionsmittel', 'Tampons', 'Binden',
    'Trockenshampoo', 'Wäschebeutel', 'Waschmittel',
    'Medikamente', 'Schmerztabletten', 'Ibuprofen', 'Paracetamol', 'Pflaster',
    'Blasenpflaster', 'Mullbinde', 'Verband', 'Wundsalbe', 'Erste-Hilfe-Set',
    'Mückenspray', 'Zeckenzange', 'Reisetabletten', 'Durchfalltabletten',
    'Elektrolyte', 'Allergietabletten', 'Nasenspray', 'Halstabletten',
    'Fieberthermometer', 'Kontaktlinsen', 'Kontaktlinsenflüssigkeit', 'Brille',
    'Ersatzbrille', 'Ohrstöpsel', 'Schlafmaske', 'Kondome', 'Pille', 'Vitamine',
  ],
  technik: [
    'Handy', 'Ladekabel', 'Ladegerät', 'Powerbank', 'Kopfhörer', 'Bluetooth-Box',
    'Kamera', 'GoPro', 'Speicherkarte', 'Ersatzakku', 'Batterien', 'Reiseadapter',
    'Mehrfachstecker', 'Verlängerungskabel', 'Laptop', 'Tablet', 'E-Reader',
    'Stirnlampe', 'Taschenlampe', 'Smartwatch', 'Stativ', 'USB-Stick', 'Nackenkissen',
  ],
  dokumente: [
    'Personalausweis', 'Reisepass', 'Führerschein', 'Visum', 'Impfpass', 'Ticket',
    'Flugticket', 'Bahnticket', 'Festivalticket', 'Bordkarte', 'Buchungsbestätigung',
    'Krankenkassenkarte', 'Auslandskrankenversicherung', 'Bargeld', 'Kreditkarte',
    'EC-Karte', 'Geldbeutel', 'Notfallkontakte', 'Reiseunterlagen', 'Skipass',
    'Fahrzeugpapiere', 'Grüne Versicherungskarte',
  ],
  ausruestung: [
    'Zelt', 'Heringe', 'Gummihammer', 'Abspannseile', 'Schlafsack', 'Isomatte',
    'Luftmatratze', 'Luftpumpe', 'Kopfkissen', 'Campingstuhl', 'Klapptisch',
    'Pavillon', 'Gaskocher', 'Gaskartusche', 'Feuerzeug', 'Streichhölzer',
    'Taschenmesser', 'Multitool', 'Seil', 'Spanngurte', 'Plane', 'Wäscheleine',
    'Kühlbox', 'Kühlakkus', 'Müllsäcke', 'Rucksack', 'Tagesrucksack', 'Koffer',
    'Reisetasche', 'Packsack', 'Regenschirm', 'Klappspaten', 'Bollerwagen',
    'Ski', 'Skistöcke', 'Skihelm', 'Skibrille', 'Snowboard', 'Protektoren',
    'Rückenprotektor', 'Skiwachs', 'Fahrrad', 'Fahrradhelm', 'Fahrradschloss',
    'Schwimmbrille', 'Surfbrett', 'Neoprenanzug', 'Schnorchel', 'Taucherbrille',
    'Flossen', 'Wanderstöcke', 'Klettergurt', 'Kletterschuhe', 'Yogamatte',
    'Strandtuch',
  ],
  kueche: [
    'Besteck', 'Teller', 'Becher', 'Tasse', 'Trinkflasche', 'Thermoskanne',
    'Dosenöffner', 'Flaschenöffner', 'Korkenzieher', 'Geschirrtuch', 'Spülmittel',
    'Spülschwamm', 'Schneidebrett', 'Topf', 'Pfanne', 'Alufolie', 'Frischhaltefolie',
    'Gefrierbeutel', 'Kaffee', 'Tee', 'Zucker', 'Salz', 'Pfeffer', 'Öl', 'Nudeln',
    'Konserven', 'Snacks', 'Müsliriegel', 'Wasser', 'Getränke', 'Brotdose',
  ],
  sonstiges: [
    'Buch', 'Zeitschrift', 'Kartenspiel', 'Spielkarten', 'UNO', 'Würfel',
    'Brettspiel', 'Notizbuch', 'Kugelschreiber', 'Tagebuch', 'Frisbee', 'Fußball',
    'Federball', 'Glitzer', 'Fahne', 'Lichterkette', 'Malbuch',
  ],
};

/** Synonyme und umgangssprachliche Schreibweisen → Kategorie. */
const ALIASES: Record<string, string> = {
  tshirt: 'kleidung', shirt: 'kleidung', pulli: 'kleidung', sweater: 'kleidung',
  klamotten: 'kleidung', wechselklamotten: 'kleidung', unterhose: 'kleidung',
  boxershorts: 'kleidung', slip: 'kleidung', strumpfhose: 'kleidung', shorts: 'kleidung',
  pyjama: 'kleidung', schlafshirt: 'kleidung', muetze: 'kleidung', kappe: 'kleidung',
  regenhose: 'kleidung', matschhose: 'kleidung', trikot: 'kleidung',
  schuhe: 'kleidung', stiefel: 'kleidung', flipflops: 'kleidung', badeschlappen: 'kleidung',
  sonnenmilch: 'hygiene', sonnenschutz: 'hygiene', labello: 'hygiene',
  zahnbuerste: 'hygiene', klopapier: 'hygiene', duschzeug: 'hygiene',
  spuelung: 'hygiene', creme: 'hygiene', schminke: 'hygiene', rasierklingen: 'hygiene',
  menstruationstasse: 'hygiene', hygieneartikel: 'hygiene', nagelknipser: 'hygiene',
  tabletten: 'hygiene', aspirin: 'hygiene', autan: 'hygiene', mueckenschutz: 'hygiene',
  insektenspray: 'hygiene', apotheke: 'hygiene', verbandszeug: 'hygiene',
  ohropax: 'hygiene', schlafbrille: 'hygiene',
  smartphone: 'technik', telefon: 'technik', netzteil: 'technik', akku: 'technik',
  kabel: 'technik', adapter: 'technik', steckdosenadapter: 'technik',
  ohrhoerer: 'technik', airpods: 'technik', kindle: 'technik',
  drohne: 'technik', kabeltrommel: 'technik',
  ausweis: 'dokumente', pass: 'dokumente', tickets: 'dokumente', geld: 'dokumente',
  portemonnaie: 'dokumente', brieftasche: 'dokumente', versicherungskarte: 'dokumente',
  fuehrerschein: 'dokumente', bankkarte: 'dokumente',
  hering: 'ausruestung', zeltstangen: 'ausruestung', schlafmatte: 'ausruestung',
  campingstuehle: 'ausruestung', kuehltasche: 'ausruestung', muellbeutel: 'ausruestung',
  klappstuhl: 'ausruestung', pumpe: 'ausruestung', karabiner: 'ausruestung',
  skier: 'ausruestung', helm: 'ausruestung', badekappe: 'ausruestung',
  besteckset: 'kueche', geschirr: 'kueche', proviant: 'kueche', essen: 'kueche',
  bier: 'kueche', wasserflasche: 'kueche', kaffeepulver: 'kueche', gewuerze: 'kueche',
  buecher: 'sonstiges', spiele: 'sonstiges', badminton: 'sonstiges',
  musikbox: 'technik', lautsprecher: 'technik',
  // Ergänzt beim Umzug aus der alten Packliste (dort nur von Hand einsortiert).
  regencape: 'kleidung', fleece: 'kleidung', badelatsche: 'kleidung', badelatschen: 'kleidung',
  medikit: 'hygiene', gehoerschutz: 'hygiene', waschzeug: 'hygiene', rasierzeug: 'hygiene',
  fingernaegel: 'hygiene', nagelset: 'hygiene',
  ipad: 'technik', iphone: 'technik', powercube: 'technik', ventilator: 'technik', handventilator: 'technik',
  gas: 'ausruestung', sportbeutel: 'ausruestung', bettwaesche: 'ausruestung', faszienrolle: 'ausruestung',
  messer: 'kueche', bialetti: 'kueche', espressokocher: 'kueche', kuechenrolle: 'kueche', schwamm: 'kueche',
  spueli: 'kueche', spueltab: 'kueche', spueltabs: 'kueche', spuelschuessel: 'kueche', dosenfutter: 'kueche',
  minutenterrine: 'kueche', lebensmittel: 'kueche', brottueten: 'kueche', 'zip beutel': 'kueche', ziplock: 'kueche',
};

/** Endungen, falls kein direkter Treffer. */
const SUFFIX_RULES: [RegExp, string][] = [
  [/(jacke|hose|shirt|pullover|pulli|socken|muetze|hemd|kleid|rock|mantel|weste|anzug|handschuh|schuh|stiefel|sandale|latschen|boots)/, 'kleidung'],
  [/(creme|lotion|shampoo|seife|buerste|tuecher|handtuch|pflege|tablette|pflaster|salbe|medikament|verband|tropfen)/, 'hygiene'],
  [/(kabel|lader|ladung|akku|elektro|adapter|stecker|lampe|batterie)/, 'technik'],
  [/(pass|ausweis|ticket|schein|urkunde|dokument)/, 'dokumente'],
  [/(zelt|sack|matte|kocher|seil|rucksack|tasche|koffer|ski|board|helm|gurt|schlaeger)/, 'ausruestung'],
  [/(flasche|becher|teller|besteck|topf|pfanne|essen|snack|getraenk|spuel|terrine)/, 'kueche'],
];

/** Umlaute falten, Kleinschreibung, Sonderzeichen weg. */
export function normalize(str = ''): string {
  return str.toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

const KEYWORDS = new Map<string, string>();
for (const [cat, names] of Object.entries(ITEM_DB)) for (const n of names) KEYWORDS.set(normalize(n), cat);
for (const [k, cat] of Object.entries(ALIASES)) KEYWORDS.set(normalize(k), cat);
// Längste zuerst, damit „kurze hose“ vor „hose“ greift.
const KEYS_BY_LENGTH = [...KEYWORDS.keys()].sort((a, b) => b.length - a.length);
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Kategorie zu einem Artikelnamen. `learned` sind Zuordnungen, die man auf
 * diesem Gerät selbst geändert hat; sie schlagen das Wörterbuch.
 */
export function guessCategory(raw: string, learned: Record<string, string> | null = null): string {
  const n = normalize(raw);
  if (!n) return DEFAULT_CATEGORY;
  if (learned) {
    if (CATEGORY_IDS.has(learned[n])) return learned[n];
    for (const [key, cat] of Object.entries(learned)) if (key.length >= 4 && n.includes(key) && CATEGORY_IDS.has(cat)) return cat;
  }
  if (KEYWORDS.has(n)) return KEYWORDS.get(n)!;
  for (const key of KEYS_BY_LENGTH) {
    if (key.length < 4) continue;
    if (new RegExp(`(^| )${escapeRe(key)}( |$)`).test(n)) return KEYWORDS.get(key)!;
  }
  const compact = n.replace(/ /g, '');
  for (const key of KEYS_BY_LENGTH) {
    if (key.length < 5) continue;
    if (compact.includes(key.replace(/ /g, ''))) return KEYWORDS.get(key)!;
  }
  for (const [re, cat] of SUFFIX_RULES) if (re.test(compact)) return cat;
  return DEFAULT_CATEGORY;
}

/** Wörterbuch als Vorschlagsliste beim Hinzufügen. */
export const DICTIONARY: { name: string; cat: string }[] = Object.entries(ITEM_DB).flatMap(([cat, names]) => names.map(name => ({ name, cat })));

// ── Packmodus ───────────────────────────────────────────────────────────────

const SHARED_ITEMS = [
  'Zelt', 'Pavillon', 'Heringe', 'Gummihammer', 'Abspannseile', 'Plane',
  'Gaskocher', 'Gaskartusche', 'Kühlbox', 'Kühlakkus', 'Klapptisch',
  'Bollerwagen', 'Müllsäcke', 'Wäscheleine', 'Spanngurte', 'Seil',
  'Luftpumpe', 'Klappspaten', 'Feuerzeug', 'Streichhölzer', 'Erste-Hilfe-Set',
  'Bluetooth-Box', 'Musikbox', 'Lautsprecher', 'Mehrfachstecker',
  'Verlängerungskabel', 'Kabeltrommel', 'Lichterkette', 'Stativ',
  'Brettspiel', 'Kartenspiel', 'Spielkarten', 'UNO', 'Würfel',
  'Frisbee', 'Fußball', 'Federball', 'Fahne', 'Glitzer',
];
const PERSONAL_ITEMS = ['Trinkflasche', 'Thermoskanne', 'Brotdose', 'Tasse', 'Becher', 'Teller', 'Besteck'];
const MODE_BY_NAME = new Map<string, PackMode>();
for (const n of SHARED_ITEMS) MODE_BY_NAME.set(normalize(n), 'gemeinsam');
for (const n of PERSONAL_ITEMS) MODE_BY_NAME.set(normalize(n), 'persoenlich');

/** Packmodus raten: gelernt → Name → Kategorie (nur Küche ist gemeinsam) → persönlich. */
export function guessMode(raw: string, cat: string, learned: Record<string, string> | null = null): PackMode {
  const n = normalize(raw);
  if (!n) return 'persoenlich';
  const l = learned?.[n];
  if (l === 'gemeinsam' || l === 'persoenlich') return l;
  if (MODE_BY_NAME.has(n)) return MODE_BY_NAME.get(n)!;
  for (const [key, mode] of MODE_BY_NAME) if (key.length >= 4 && new RegExp(`(^| )${escapeRe(key)}( |$)`).test(n)) return mode;
  return cat === 'kueche' ? 'gemeinsam' : 'persoenlich';
}

// ── Mengen-Erkennung ────────────────────────────────────────────────────────

/**
 * „3 Isomatte“, „3x Isomatte“, „Isomatte x3“ → Menge 3, Name „Isomatte“.
 * Nur, wenn ein sinnvoller Name übrig bleibt („2er Steckdose“ bleibt heil).
 */
export function parseQuantity(input = ''): { qty: number; name: string; explicit: boolean } {
  const s = input.trim().replace(/\s+/g, ' ');
  if (!s) return { qty: 1, name: '', explicit: false };
  const fine = (q: number, n: string) => Number.isFinite(q) && q >= 1 && q <= MAX_QTY && n.length >= 2 && /[a-zäöüß]/i.test(n);
  let m = /^(\d{1,2})\s*(?:[x×*]\s*|\s)(.+)$/i.exec(s);
  if (m && fine(+m[1], m[2].trim())) return { qty: +m[1], name: m[2].trim(), explicit: true };
  m = /^(.+?)\s+(?:x\s*(\d{1,2})|(\d{1,2})\s*[x×])$/i.exec(s);
  if (m && fine(+(m[2] || m[3]), m[1].trim())) return { qty: +(m[2] || m[3]), name: m[1].trim(), explicit: true };
  return { qty: 1, name: s, explicit: false };
}

// ── Lesen ───────────────────────────────────────────────────────────────────

export function readPackItem(id: string, m: Y.Map<unknown>): PackItem {
  const qty = Math.round(Number(m.get('qty')));
  return {
    id,
    name: String(m.get('name') || ''),
    qty: Number.isFinite(qty) && qty >= 1 ? Math.min(qty, MAX_QTY) : 1,
    mode: m.get('mode') === 'gemeinsam' ? 'gemeinsam' : 'persoenlich',
    cat: validCategory(m.get('cat')),
    at: Number(m.get('at')) || 0,
  };
}

export function packItems(doc: Y.Doc): PackItem[] {
  const out: PackItem[] = [];
  doc.getMap<Y.Map<unknown>>('items').forEach((m, id) => { if (m instanceof Y.Map) out.push(readPackItem(id, m)); });
  return out.sort((a, b) => a.at - b.at || a.name.localeCompare(b.name, 'de'));
}

export const claimKey = (item: string, member: string) => `${item}|${member}`;

/** Wer hat wie viel von jedem Artikel eingepackt (nur Einträge > 0). */
export function claimsByItem(doc: Y.Doc): Map<string, Map<string, number>> {
  const out = new Map<string, Map<string, number>>();
  doc.getMap<number>('claims').forEach((n, key) => {
    const i = key.indexOf('|');
    if (i < 0 || !(Number(n) > 0)) return;
    const item = key.slice(0, i), member = key.slice(i + 1);
    if (!out.has(item)) out.set(item, new Map());
    out.get(item)!.set(member, Math.round(Number(n)));
  });
  return out;
}

export function memberNames(doc: Y.Doc): Map<string, string> {
  const out = new Map<string, string>();
  doc.getMap<string>('members').forEach((name, id) => out.set(id, String(name || '') || 'Jemand'));
  return out;
}

/** Stand eines Artikels aus Sicht von `me`. */
export function itemState(item: PackItem, claims: Map<string, number> | undefined, names: Map<string, string>, me: string): ItemState {
  const by: Claim[] = [];
  let total = 0;
  for (const [member, qty] of claims || []) {
    if (qty <= 0) continue;
    total += qty;
    by.push({ member, name: names.get(member) || 'Jemand', qty });
  }
  by.sort((a, b) => (a.member === me ? -1 : b.member === me ? 1 : b.qty - a.qty));
  const mine = claims?.get(me) || 0;
  const need = item.qty;
  const done = item.mode === 'gemeinsam' ? total >= need : mine >= 1;
  return { need, mine, total, remaining: Math.max(0, need - total), by, done };
}

// ── Markdown (für /<id>.md, Titel, Übersicht, Kopieren) ─────────────────────

/**
 * Als Aufgabenliste, gruppiert nach Kategorien. Abgehakt heißt hier:
 * persönliche Artikel hat irgendwer eingepackt, gemeinsame sind gedeckt.
 */
export function packMarkdown(doc: Y.Doc): string {
  const title = String(doc.getMap('meta').get('title') || '').trim() || 'Packliste';
  const items = packItems(doc);
  const claims = claimsByItem(doc);
  const names = memberNames(doc);
  const lines = [`# ${title}`];
  for (const c of CATEGORIES) {
    const list = items.filter(i => i.cat === c.id);
    if (!list.length) continue;
    lines.push('', `## ${c.label}`, '');
    for (const it of list) {
      const by = [...(claims.get(it.id) || [])].filter(([, n]) => n > 0);
      const total = by.reduce((s, [, n]) => s + n, 0);
      const done = it.mode === 'gemeinsam' ? total >= it.qty : total > 0;
      const qty = it.qty > 1 ? ` (${it.qty}×)` : '';
      const who = by.length && names.size > 1 ? ` – ${by.map(([m, n]) => (n > 1 ? `${names.get(m) || 'Jemand'} ${n}×` : names.get(m) || 'Jemand')).join(', ')}` : '';
      lines.push(`- [${done ? 'x' : ' '}] ${it.name.replace(/[\r\n]+/g, ' ')}${qty}${who}`);
    }
  }
  return lines.join('\n') + '\n';
}
