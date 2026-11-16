// Packliste: Artikel nach Kategorien, abhaken mit kurzer Bedenkzeit,
// gemeinsam packen („Wer bringt was“). Gemeinsam über dasselbe
// Yjs/WebSocket wie Dokumente und Boards (Datenmodell in src/shared/pack.ts).
//
// Gerätewissen (nur im Browser, nie in der Liste):
//   md:pack:lists    Stand der eigenen Listen (Titel, Artikel) – daraus kommen
//                    Vorschläge beim Hinzufügen und „Aus Liste übernehmen“
//   md:pack:learned  selbst geänderte Kategorie bzw. Packmodus je Artikelname

import * as Y from 'yjs';
import { Awareness } from 'y-protocols/awareness';
import { IndexeddbPersistence } from 'y-indexeddb';
import { Provider } from './provider';
import { $, el, store, dialog, type MenuItem } from './ui';
import { account } from './account';
import {
  CATEGORIES, DICTIONARY, MAX_PACK_ITEMS, MAX_QTY, categoryLabel, claimKey, claimsByItem, guessCategory, guessMode,
  itemState, memberNames, normalize, packItems, packMarkdown, parseQuantity, validCategory,
  type ItemState, type PackItem, type PackMode,
} from '../shared/pack';
import type { EditorStatus, Peer } from './editor';

export interface PackOptions {
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

export interface PackHandle {
  markdown(): string;
  title(): string;
  setEditable(on: boolean): void;
  setName(name: string): void;
  reconnect(): void;
  /** Einträge für das ⋯-Menü (Wer bringt was, Zurücksetzen …). */
  menuItems(): MenuItem[];
}

const LOCAL = 'pack-local';
const GRACE_MS = 1000;
const LEAVE_MS = 260;
const PEER_COLORS = ['#1a8cff', '#e5484d', '#30a46c', '#f76b15', '#8e4ec6', '#d6409f', '#0797a0', '#a18072'];
const LISTS_KEY = 'md:pack:lists';
const LEARNED_KEY = 'md:pack:learned';

const rid = () => Math.random().toString(36).slice(2, 10);
const ICON = {
  check: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7"/></svg>',
  plus: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3.5v9M3.5 8h9"/></svg>',
  minus: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 8h9"/></svg>',
  chevron: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5.5 6.5L8 9l2.5-2.5"/></svg>',
};

// ── Gerätewissen ────────────────────────────────────────────────────────────

interface Snapshot { title: string; at: number; items: { name: string; qty: number; mode: PackMode; cat: string }[] }
interface Learned { cat: Record<string, string>; mode: Record<string, string> }

function readJson<T>(key: string, fallback: T): T {
  try { return { ...fallback, ...JSON.parse(store.get(key) || 'null') }; } catch { return fallback; }
}
const snapshots = () => readJson<Record<string, Snapshot>>(LISTS_KEY, {});
const learned = (): Learned => {
  const l = readJson<Learned>(LEARNED_KEY, { cat: {}, mode: {} });
  return { cat: l.cat || {}, mode: l.mode || {} };
};
function learn(name: string, field: 'cat' | 'mode', value: string) {
  const l = learned();
  l[field][normalize(name)] = value;
  store.set(LEARNED_KEY, JSON.stringify(l));
}

/** Ich: angemeldet über alle Geräte gleich (aus der E-Mail abgeleitet), sonst pro Browser. */
function memberId(): string {
  const email = account.user?.email;
  if (email) {
    let h = 0x811c9dc5;
    for (const ch of `pack:${email.toLowerCase()}`) h = Math.imul(h ^ ch.charCodeAt(0), 0x01000193) >>> 0;
    return `u${h.toString(36)}`;
  }
  let id = store.get('md:voter');
  if (!id) { id = rid() + rid(); store.set('md:voter', id); }
  return id;
}

// ── Hinweis mit Rückgängig ──────────────────────────────────────────────────

function undoToast(msg: string, undo: () => void) {
  $('#toast')?.classList.remove('show');
  $('.undo-toast')?.remove();
  const btn = el('button', { type: 'button' }, 'Rückgängig');
  const t = el('div', { class: 'undo-toast', role: 'status' }, el('span', {}, msg), btn);
  document.body.append(t);
  requestAnimationFrame(() => t.classList.add('show'));
  const timer = setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 300); }, 6000);
  btn.addEventListener('click', () => { clearTimeout(timer); t.remove(); undo(); });
}

export function mountPack(o: PackOptions): PackHandle {
  // ── Daten ─────────────────────────────────────────────────────────────────

  const ydoc = new Y.Doc();
  const meta = ydoc.getMap<unknown>('meta');
  const items = ydoc.getMap<Y.Map<unknown>>('items');
  const claims = ydoc.getMap<number>('claims');
  const members = ydoc.getMap<string>('members');
  const awareness = new Awareness(ydoc);
  const myColor = PEER_COLORS[Math.floor(Math.random() * PEER_COLORS.length)];
  const me = memberId();
  let myName = o.name || '';
  awareness.setLocalStateField('user', { name: myName || 'Gast', color: myColor });

  let canEdit = o.editable;
  let created = o.exists;
  let creating: Promise<boolean> | null = null;
  let peers: Peer[] = [];
  let pending = false;

  const local = new IndexeddbPersistence(`md:${o.id}`, ydoc);
  const dropLocal = () => { local.clearData().catch(() => {}); };
  const provider = new Provider(ydoc, awareness, o.wsUrl, {
    status: s => { if (s === 'gone') dropLocal(); report(); },
    synced: () => { report(); join(); },
    notice: n => {
      if (n.type === 'moved' || (n.type === 'hello' && n.edit === false)) dropLocal();
      o.onNotice(n);
    },
    pending: p => { pending = p; report(); },
  });
  const report = () => o.onStatus({ status: provider.status, pending, peers, synced: provider.synced });

  // Neue Liste: beim ersten Eintrag anlegen, dann verbinden.
  ydoc.on('update', (_u: Uint8Array, origin: unknown) => {
    if (created || origin === provider || origin === local) return;
    creating ??= o.ensureCreated().then(ok => {
      if (ok) { created = true; provider.connect(); }
      else creating = null;
      return ok;
    });
  });
  if (created) provider.connect();

  /** Eigene Änderung; trägt mich dabei als Mitglied ein. */
  const tx = (fn: () => void) => ydoc.transact(() => {
    if (members.get(me) !== (myName || '')) members.set(me, myName || '');
    fn();
  }, LOCAL);

  /** Wer die Liste bearbeiten darf, steht bei „Wer bringt was“, auch ohne Haken. */
  function join() {
    if (!created || !canEdit || !provider.synced) return;
    if (members.get(me) !== (myName || '')) ydoc.transact(() => members.set(me, myName || ''), LOCAL);
  }

  awareness.on('change', () => {
    const states = awareness.getStates() as Map<number, { user?: { name?: string; color?: string } }>;
    peers = [...states.entries()]
      .filter(([client, st]) => client !== ydoc.clientID && st.user)
      .map(([client, st]) => ({ name: String(st.user!.name || 'Gast'), color: String(st.user!.color || '#888'), id: client }));
    report();
  });

  // ── Aufbau ────────────────────────────────────────────────────────────────

  const root = el('div', { class: 'pack' });
  const titleInput = el('input', { type: 'text', class: 'pk-title', placeholder: 'Packliste', 'aria-label': 'Titel', maxlength: '120', spellcheck: 'false' }) as HTMLInputElement;
  const summary = el('p', { class: 'pk-summary' });
  const addInput = el('input', { type: 'text', class: 'pk-add-input', placeholder: 'Hinzufügen …', 'aria-label': 'Artikel hinzufügen', autocomplete: 'off', enterkeyhint: 'done', spellcheck: 'false' }) as HTMLInputElement;
  const suggestBox = el('div', { class: 'pk-suggest', role: 'listbox', hidden: '' });
  const addForm = el('form', { class: 'pk-add' }, addInput, suggestBox);
  const listBox = el('div', { class: 'pk-lists' });
  const empty = el('div', { class: 'pk-empty', hidden: '' });
  root.append(el('header', { class: 'pk-head' }, titleInput, summary), addForm, empty, listBox);
  o.parent.append(root);

  // Titel
  const title = () => String(meta.get('title') || '').trim();
  function syncTitle() {
    const t = String(meta.get('title') || '');
    if (document.activeElement !== titleInput && titleInput.value !== t) titleInput.value = t;
    o.onTitle(t.trim());
  }
  titleInput.addEventListener('input', () => tx(() => meta.set('title', titleInput.value.slice(0, 120))));
  titleInput.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); addInput.focus(); } });
  meta.observe(syncTitle);

  // ── Darstellung ───────────────────────────────────────────────────────────

  /** Gerade abgehakt: bleibt kurz durchgestrichen stehen, dann rutscht es nach unten. */
  const grace = new Map<string, { phase: 'grace' | 'leaving'; timer: ReturnType<typeof setTimeout> }>();
  let flashId: string | null = null;
  let doneOpen = store.get(`md:pack:done:${o.id}`) !== '0';

  function snapshot(): { list: PackItem[]; states: Map<string, ItemState>; names: Map<string, string> } {
    const list = packItems(ydoc);
    const byItem = claimsByItem(ydoc);
    const names = memberNames(ydoc);
    if (myName) names.set(me, myName);
    const states = new Map<string, ItemState>();
    for (const it of list) states.set(it.id, itemState(it, byItem.get(it.id), names, me));
    return { list, states, names };
  }

  /** Mehr als eine Person auf der Liste: dann Namen an den Artikeln zeigen. */
  const together = (names: Map<string, string>) => [...names.keys()].some(id => id !== me);

  function render() {
    const { list, states, names } = snapshot();
    const group = together(names);
    const open = list.filter(it => !states.get(it.id)!.done || grace.has(it.id));
    const done = list.filter(it => states.get(it.id)!.done && !grace.has(it.id));

    const doneCount = list.length - list.filter(it => !states.get(it.id)!.done).length;
    summary.textContent = list.length ? (doneCount === list.length ? `Alles eingepackt · ${list.length}` : `${list.length - doneCount} offen · ${doneCount} von ${list.length} eingepackt`) : '';

    listBox.replaceChildren();
    for (const c of CATEGORIES) {
      const rows = open.filter(it => it.cat === c.id);
      if (!rows.length) continue;
      const ul = el('ul', { class: 'pk-rows' });
      for (const it of rows) ul.append(row(it, states.get(it.id)!, group, names));
      listBox.append(el('section', { class: 'pk-cat', 'data-cat': c.id }, el('h2', {}, c.label), ul));
    }
    if (done.length) {
      const toggle = el('button', { type: 'button', class: 'pk-done-toggle', 'aria-expanded': String(doneOpen) }, `Eingepackt · ${done.length}`);
      toggle.insertAdjacentHTML('beforeend', ICON.chevron);
      toggle.addEventListener('click', () => {
        doneOpen = !doneOpen;
        store.set(`md:pack:done:${o.id}`, doneOpen ? '1' : '0');
        render();
      });
      const head = el('div', { class: 'pk-done-head' }, toggle);
      if (canEdit) {
        const reset = el('button', { type: 'button', class: 't' }, 'Zurücksetzen');
        reset.addEventListener('click', () => resetList(reset));
        head.append(reset);
      }
      const section = el('section', { class: `pk-done${doneOpen ? '' : ' closed'}` }, head);
      if (doneOpen) {
        const ul = el('ul', { class: 'pk-rows' });
        const sorted = [...done].sort((a, b) => CATEGORIES.findIndex(c => c.id === a.cat) - CATEGORIES.findIndex(c => c.id === b.cat));
        for (const it of sorted) ul.append(row(it, states.get(it.id)!, group, names));
        section.append(ul);
      }
      listBox.append(section);
    }

    empty.hidden = list.length > 0;
    if (!list.length) {
      empty.replaceChildren();
      const others = otherLists();
      if (canEdit && others.length) {
        const b = el('button', { type: 'button', class: 't boxed' }, 'Aus einer anderen Liste übernehmen');
        b.addEventListener('click', copyFromList);
        empty.append(b);
      }
    }
    root.classList.toggle('is-readonly', !canEdit);
    saveSnapshot();
  }

  function row(it: PackItem, st: ItemState, group: boolean, names: Map<string, string>): HTMLElement {
    const g = grace.get(it.id);
    const li = el('li', { class: 'pk-row', 'data-id': it.id });
    if (st.done) li.classList.add('done');
    if (g) li.classList.add(g.phase);
    if (flashId === it.id) li.classList.add('flash');

    const check = el('button', { type: 'button', class: 'pk-check', 'aria-pressed': String(st.done), 'aria-label': `${it.name} ${st.done ? 'nicht mehr eingepackt' : 'eingepackt'}` });
    check.innerHTML = ICON.check;
    if (!canEdit) check.disabled = true;
    check.addEventListener('click', () => toggle(it.id));

    const name = el(canEdit ? 'button' : 'span', { class: 'pk-name', ...(canEdit ? { type: 'button' } : {}) }, it.name);
    if (it.qty > 1) name.append(el('span', { class: 'pk-qty' }, `${it.qty}×`));
    if (canEdit) name.addEventListener('click', () => editItem(it.id));
    li.append(check, name);

    // Rechts: wer hat es (nur zu mehreren), bei gemeinsamen Artikeln die Menge.
    const side = el('span', { class: 'pk-side' });
    if (it.mode === 'gemeinsam') {
      if (group) {
        const who = st.by.map(b => (b.qty > 1 && it.qty > 1 ? `${b.name} ${b.qty}` : b.name));
        if (who.length) side.append(el('span', { class: 'pk-who' }, who.join(', ')));
      }
      if (it.qty > 1 && !st.done) side.append(el('span', { class: 'pk-count' }, `${st.total}/${it.qty}`));
      if (canEdit && it.qty > 1 && st.remaining > 0 && !g) {
        const plus = el('button', { type: 'button', class: 'pk-plus', title: 'Eins davon übernehmen', 'aria-label': `Eins von ${it.name} übernehmen` });
        plus.innerHTML = ICON.plus;
        plus.addEventListener('click', () => setClaim(it.id, st.mine + 1));
        side.append(plus);
      }
      li.dataset.mode = 'gemeinsam';
    } else if (group) {
      const others = st.by.filter(b => b.member !== me).map(b => b.name);
      if (others.length) side.append(el('span', { class: 'pk-who', title: `Schon eingepackt: ${others.join(', ')}` }, others.join(', ')));
    }
    if (side.childNodes.length) li.append(side);
    void names;
    return li;
  }

  // ── Abhaken ───────────────────────────────────────────────────────────────

  function setClaim(itemId: string, qty: number) {
    tx(() => {
      const key = claimKey(itemId, me);
      if (qty > 0) claims.set(key, Math.min(qty, MAX_QTY));
      else if (claims.has(key)) claims.delete(key);
    });
  }

  /**
   * Solange etwas offen ist, übernimmt ein Tipp den ganzen Rest. Ist alles
   * gedeckt, gibt er den eigenen Anteil frei. Haben nur andere gedeckt,
   * passiert nichts – sonst packt man über den Bedarf hinaus ein.
   */
  function toggle(itemId: string) {
    if (!canEdit) return;
    const m = items.get(itemId);
    if (!m) return;
    const g = grace.get(itemId);
    const { states } = snapshot();
    const st = states.get(itemId)!;
    const it = packItems(ydoc).find(i => i.id === itemId)!;
    if (g) {
      // Noch in der Bedenkzeit: zurücknehmen.
      clearTimeout(g.timer);
      grace.delete(itemId);
      setClaim(itemId, 0);
      return;
    }
    if (!st.done) {
      setClaim(itemId, it.mode === 'gemeinsam' ? st.mine + st.remaining : 1);
      const timer = setTimeout(() => {
        const cur = grace.get(itemId);
        if (!cur) return;
        cur.phase = 'leaving';
        $(`.pk-row[data-id="${itemId}"]`, listBox)?.classList.add('leaving');
        cur.timer = setTimeout(() => { grace.delete(itemId); render(); }, LEAVE_MS);
      }, GRACE_MS);
      grace.set(itemId, { phase: 'grace', timer });
      render();
      return;
    }
    if (st.mine > 0) { setClaim(itemId, 0); return; }
    const by = st.by.map(b => b.name).join(', ');
    o.toast(by ? `Schon eingepackt von ${by}.` : 'Schon eingepackt.');
  }

  // ── Hinzufügen ────────────────────────────────────────────────────────────

  interface Suggestion { name: string; cat: string; mode?: PackMode; qty?: number; onList: boolean; own: boolean }
  let suggestions: Suggestion[] = [];
  let active = -1;

  /** Artikel aus meinen anderen Listen (häufigste zuerst). */
  function pool(): Map<string, { name: string; cat: string; mode: PackMode; qty: number; n: number }> {
    const out = new Map<string, { name: string; cat: string; mode: PackMode; qty: number; n: number }>();
    for (const [id, s] of Object.entries(snapshots())) {
      if (id === o.id) continue;
      for (const it of s.items || []) {
        const k = normalize(it.name);
        if (!k) continue;
        const cur = out.get(k);
        if (cur) cur.n++;
        else out.set(k, { name: it.name, cat: validCategory(it.cat), mode: it.mode === 'gemeinsam' ? 'gemeinsam' : 'persoenlich', qty: it.qty || 1, n: 1 });
      }
    }
    return out;
  }

  function computeSuggestions(): Suggestion[] {
    const { name } = parseQuantity(addInput.value);
    const q = normalize(name);
    const onList = new Set(packItems(ydoc).map(i => normalize(i.name)));
    const own = [...pool().entries()].sort((a, b) => b[1].n - a[1].n || a[1].name.localeCompare(b[1].name, 'de'));
    if (!q) {
      return own.filter(([k]) => !onList.has(k)).slice(0, 8)
        .map(([, p]) => ({ name: p.name, cat: p.cat, mode: p.mode, qty: p.qty, onList: false, own: true }));
    }
    const score = (k: string) => (k === q ? 0 : k.startsWith(q) ? 1 : k.split(' ').some(w => w.startsWith(q)) ? 2 : k.includes(q) ? 3 : -1);
    const seen = new Set<string>();
    const out: (Suggestion & { s: number })[] = [];
    for (const [k, p] of own) {
      const s = score(k);
      if (s < 0) continue;
      seen.add(k);
      out.push({ name: p.name, cat: p.cat, mode: p.mode, qty: p.qty, onList: onList.has(k), own: true, s });
    }
    for (const d of DICTIONARY) {
      const k = normalize(d.name);
      if (seen.has(k)) continue;
      const s = score(k);
      if (s < 0) continue;
      seen.add(k);
      out.push({ name: d.name, cat: d.cat, onList: onList.has(k), own: false, s: s + 0.5 });
    }
    // Eigene vor Wörterbuch bei gleicher Güte, schon Vorhandene ans Ende.
    return out.sort((a, b) => Number(a.onList) - Number(b.onList) || a.s - b.s || a.name.length - b.name.length).slice(0, 7);
  }

  function renderSuggestions() {
    if (!canEdit || document.activeElement !== addInput) { suggestBox.hidden = true; return; }
    suggestions = computeSuggestions();
    const typed = parseQuantity(addInput.value).name.trim();
    if (active >= suggestions.length) active = suggestions.length - 1;
    suggestBox.replaceChildren();
    suggestions.forEach((s, i) => {
      const b = el('button', { type: 'button', role: 'option', class: `pk-sug${i === active ? ' active' : ''}${s.onList ? ' on-list' : ''}`, 'aria-selected': String(i === active), tabindex: '-1' },
        el('span', { class: 'pk-sug-name' }, s.name),
        el('span', { class: 'pk-sug-meta' }, s.onList ? 'schon drauf' : categoryLabel(s.cat)));
      b.addEventListener('pointerdown', e => e.preventDefault());
      b.addEventListener('click', () => pick(s));
      suggestBox.append(b);
    });
    if (!suggestions.length && !typed) { suggestBox.hidden = true; return; }
    if (typed && !suggestions.some(s => normalize(s.name) === normalize(typed))) {
      const cat = guessCategory(typed, learned().cat);
      const b = el('button', { type: 'button', role: 'option', class: `pk-sug pk-sug-new${active === suggestions.length ? ' active' : ''}`, tabindex: '-1' },
        el('span', { class: 'pk-sug-name' }, `„${typed}“ hinzufügen`),
        el('span', { class: 'pk-sug-meta' }, categoryLabel(cat)));
      b.addEventListener('pointerdown', e => e.preventDefault());
      b.addEventListener('click', () => submitTyped());
      suggestBox.append(b);
    }
    suggestBox.hidden = !suggestBox.childNodes.length;
  }

  function pick(s: Suggestion) {
    const { qty, explicit } = parseQuantity(addInput.value);
    addItem(s.name, { qty: explicit ? qty : s.qty, cat: s.cat, mode: s.mode });
    addInput.value = '';
    active = -1;
    renderSuggestions();
  }

  function submitTyped() {
    const { qty, name, explicit } = parseQuantity(addInput.value);
    if (!name.trim()) return;
    // Genau so im eigenen Bestand: dessen Kategorie und Modus übernehmen.
    const p = pool().get(normalize(name));
    addItem(p?.name || name.trim(), { qty: explicit ? qty : p?.qty, cat: p?.cat, mode: p?.mode });
    addInput.value = '';
    active = -1;
    renderSuggestions();
  }

  addForm.addEventListener('submit', e => {
    e.preventDefault();
    const extra = suggestions.length; // „… hinzufügen“ steht hinter den Vorschlägen
    if (active >= 0 && active < extra) pick(suggestions[active]);
    else submitTyped();
  });
  addInput.addEventListener('input', () => { active = parseQuantity(addInput.value).name.trim() ? 0 : -1; renderSuggestions(); });
  addInput.addEventListener('focus', renderSuggestions);
  addInput.addEventListener('blur', () => { suggestBox.hidden = true; });
  addInput.addEventListener('keydown', e => {
    const count = suggestBox.querySelectorAll('.pk-sug').length;
    if (e.key === 'ArrowDown' && count) { e.preventDefault(); active = (active + 1) % count; renderSuggestions(); }
    else if (e.key === 'ArrowUp' && count) { e.preventDefault(); active = active <= 0 ? count - 1 : active - 1; renderSuggestions(); }
    else if (e.key === 'Escape') { if (addInput.value) { addInput.value = ''; active = -1; renderSuggestions(); } else addInput.blur(); }
  });

  function addItem(rawName: string, opts: { qty?: number; cat?: string; mode?: PackMode } = {}) {
    const name = rawName.trim().slice(0, 120);
    if (!name || !canEdit) return;
    const k = normalize(name);
    const existing = packItems(ydoc).find(i => normalize(i.name) === k);
    if (existing) {
      if (opts.qty && opts.qty !== existing.qty) tx(() => items.get(existing.id)?.set('qty', opts.qty!));
      flash(existing.id);
      o.toast(opts.qty && opts.qty !== existing.qty ? `${existing.name}: Menge ${opts.qty}.` : `${existing.name} steht schon drauf.`);
      return;
    }
    if (items.size >= MAX_PACK_ITEMS) { o.toast('Die Liste ist voll.'); return; }
    const l = learned();
    const cat = l.cat[k] ? validCategory(l.cat[k]) : opts.cat ? validCategory(opts.cat) : guessCategory(name, l.cat);
    const mode = (l.mode[k] as PackMode) || opts.mode || guessMode(name, cat, l.mode);
    const id = rid();
    tx(() => {
      const m = new Y.Map<unknown>();
      m.set('name', name);
      m.set('qty', Math.max(1, Math.min(MAX_QTY, opts.qty || 1)));
      m.set('mode', mode);
      m.set('cat', cat);
      m.set('at', Date.now());
      items.set(id, m);
    });
    flash(id);
  }

  function flash(id: string) {
    flashId = id;
    render();
    const n = $(`.pk-row[data-id="${id}"]`, listBox);
    n?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    setTimeout(() => {
      if (flashId !== id) return;
      flashId = null;
      $(`.pk-row[data-id="${id}"]`, listBox)?.classList.remove('flash');
    }, 1200);
  }

  // ── Artikel bearbeiten ────────────────────────────────────────────────────

  function editItem(itemId: string) {
    const m = items.get(itemId);
    if (!m || !canEdit) return;
    const it = () => { const cur = items.get(itemId); return cur ? packItems(ydoc).find(i => i.id === itemId) || null : null; };
    const start = it()!;

    const name = el('input', { type: 'text', class: 'pk-field', value: start.name, maxlength: '120', 'aria-label': 'Name', spellcheck: 'false' }) as HTMLInputElement;
    const saveName = () => {
      const v = name.value.trim().slice(0, 120);
      const cur = it();
      if (!cur || !v || v === cur.name) return;
      tx(() => items.get(itemId)?.set('name', v));
    };
    name.addEventListener('change', saveName);

    const qtyOut = el('output', { class: 'pk-qty-out' }, String(start.qty));
    const step = (d: number) => {
      const cur = it();
      if (!cur) return;
      const q = Math.max(1, Math.min(MAX_QTY, cur.qty + d));
      tx(() => items.get(itemId)?.set('qty', q));
      qtyOut.textContent = String(q);
    };
    const minus = el('button', { type: 'button', class: 'pk-step', 'aria-label': 'Weniger' });
    minus.innerHTML = ICON.minus;
    minus.addEventListener('click', () => step(-1));
    const plus = el('button', { type: 'button', class: 'pk-step', 'aria-label': 'Mehr' });
    plus.innerHTML = ICON.plus;
    plus.addEventListener('click', () => step(1));

    const modeSeg = el('div', { class: 'seg', role: 'radiogroup', 'aria-label': 'Wer braucht das' });
    const drawMode = () => {
      modeSeg.replaceChildren();
      const cur = it()?.mode || start.mode;
      for (const [value, text] of [['persoenlich', 'Jede Person'], ['gemeinsam', 'Einmal für alle']] as [PackMode, string][]) {
        const b = el('button', { type: 'button', role: 'radio', 'aria-checked': String(cur === value) }, text);
        b.addEventListener('click', () => {
          tx(() => items.get(itemId)?.set('mode', value));
          learn(it()?.name || start.name, 'mode', value);
          drawMode();
        });
        modeSeg.append(b);
      }
    };
    drawMode();

    const cat = el('select', { class: 'pk-field', 'aria-label': 'Kategorie' }) as HTMLSelectElement;
    for (const c of CATEGORIES) cat.append(el('option', { value: c.id }, c.label));
    cat.value = start.cat;
    cat.addEventListener('change', () => {
      tx(() => items.get(itemId)?.set('cat', cat.value));
      learn(it()?.name || start.name, 'cat', cat.value);
    });

    const remove = el('button', { type: 'button', class: 't danger-boxed boxed' }, 'Von der Liste nehmen');
    const done = el('button', { type: 'button', class: 't boxed' }, 'Fertig');

    const body = el('div', { class: 'pk-edit' },
      el('label', { class: 'pk-edit-row' }, el('span', {}, 'Name'), name),
      el('div', { class: 'pk-edit-row' }, el('span', {}, 'Menge'), el('div', { class: 'pk-stepper' }, minus, qtyOut, plus)),
      el('div', { class: 'pk-edit-row' }, el('span', {}, 'Braucht'), modeSeg),
      el('label', { class: 'pk-edit-row' }, el('span', {}, 'Kategorie'), cat),
      el('div', { class: 'ask-row pk-edit-foot' }, remove, done),
    );
    const d = dialog('', body);
    d.classList.add('pk-dialog');
    d.addEventListener('close', saveName);
    done.addEventListener('click', () => d.close());
    name.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); d.close(); } });
    remove.addEventListener('click', () => { d.close(); removeItem(itemId); });
  }

  function removeItem(itemId: string) {
    const m = items.get(itemId);
    if (!m) return;
    const fields = m.toJSON();
    const own: [string, number][] = [];
    claims.forEach((n, key) => { if (key.startsWith(`${itemId}|`)) own.push([key, n]); });
    tx(() => {
      items.delete(itemId);
      for (const [key] of own) claims.delete(key);
    });
    undoToast(`${String(fields.name || 'Artikel')} entfernt.`, () => tx(() => {
      const back = new Y.Map<unknown>();
      for (const [k, v] of Object.entries(fields)) back.set(k, v);
      items.set(itemId, back);
      for (const [key, n] of own) claims.set(key, n);
    }));
  }

  // ── Zurücksetzen ──────────────────────────────────────────────────────────

  function resetList(anchor?: HTMLElement) {
    const all: [string, number][] = [];
    claims.forEach((n, key) => all.push([key, n]));
    const mine = all.filter(([key]) => key.endsWith(`|${me}`));
    const others = all.length - mine.length;
    const run = (which: [string, number][], msg: string) => {
      if (!which.length) { o.toast('Nichts zum Zurücksetzen.'); return; }
      tx(() => { for (const [key] of which) claims.delete(key); });
      undoToast(msg, () => tx(() => { for (const [key, n] of which) claims.set(key, n); }));
    };
    if (!others) { run(mine, 'Alles wieder offen.'); return; }
    const b1 = el('button', { type: 'button', class: 't boxed' }, 'Nur meine');
    const b2 = el('button', { type: 'button', class: 't boxed danger-boxed' }, 'Für alle');
    const d = dialog('', el('div', { class: 'ask' }, el('h2', {}, 'Zurücksetzen'), el('div', { class: 'ask-row' }, b1, b2)));
    b1.addEventListener('click', () => { d.close(); run(mine, 'Deine Haken sind wieder offen.'); });
    b2.addEventListener('click', () => { d.close(); run(all, 'Alles wieder offen.'); });
    void anchor;
  }

  // ── Wer bringt was ────────────────────────────────────────────────────────

  function whoBringsWhat() {
    const { list, states, names } = snapshot();
    const ids = [...new Set([me, ...names.keys()])];
    const body = el('div', { class: 'pk-who-dlg' });

    for (const id of ids) {
      const isMe = id === me;
      const mineList = list.filter(it => states.get(it.id)!.by.some(b => b.member === id));
      const head = el('div', { class: 'pk-person-head' });
      if (isMe) {
        const input = el('input', { type: 'text', class: 'pk-field pk-myname', value: myName, placeholder: 'Dein Name', maxlength: '30', 'aria-label': 'Dein Name' }) as HTMLInputElement;
        input.addEventListener('change', () => {
          const v = input.value.trim().slice(0, 30);
          if (v) store.set('md:name', v); else store.del('md:name');
          dispatchEvent(new CustomEvent('md:name'));
        });
        head.append(input, el('span', { class: 'pk-person-count' }, 'du'));
      } else {
        head.append(el('span', { class: 'pk-person-name' }, names.get(id) || 'Jemand'));
      }
      const ul = el('ul', { class: 'pk-person-items' });
      for (const it of mineList) {
        const q = states.get(it.id)!.by.find(b => b.member === id)!.qty;
        ul.append(el('li', {}, q > 1 ? `${q}× ${it.name}` : it.name));
      }
      if (!mineList.length) ul.append(el('li', { class: 'muted' }, 'noch nichts'));
      body.append(el('section', { class: 'pk-person' }, head, ul));
    }

    const open = list.filter(it => !states.get(it.id)!.done);
    if (open.length) {
      const ul = el('ul', { class: 'pk-person-items' });
      for (const it of open) {
        const st = states.get(it.id)!;
        let note = '';
        if (it.mode === 'gemeinsam') note = it.qty > 1 ? `noch ${st.remaining} von ${it.qty}` : '';
        else {
          const missing = ids.filter(id => !st.by.some(b => b.member === id)).map(id => (id === me ? 'dir' : names.get(id) || 'Jemand'));
          note = missing.length ? `fehlt bei ${missing.join(', ')}` : '';
        }
        ul.append(el('li', {}, it.name, note ? el('span', { class: 'muted' }, ` · ${note}`) : ''));
      }
      body.append(el('section', { class: 'pk-person pk-open' }, el('div', { class: 'pk-person-head' }, el('span', { class: 'pk-person-name' }, 'Offen')), ul));
    }
    dialog('Wer bringt was', body).classList.add('pk-dialog');
  }

  // ── Eigene Listen: merken und übernehmen ──────────────────────────────────

  let snapTimer: ReturnType<typeof setTimeout> | null = null;
  function saveSnapshot() {
    if (!created || !canEdit) return;
    if (snapTimer) clearTimeout(snapTimer);
    snapTimer = setTimeout(() => {
      const all = snapshots();
      const list = packItems(ydoc);
      if (!list.length && !all[o.id]) return;
      all[o.id] = { title: title(), at: Date.now(), items: list.map(i => ({ name: i.name, qty: i.qty, mode: i.mode, cat: i.cat })) };
      // Höchstens 60 Listen merken, die ältesten fallen raus.
      const keep = Object.entries(all).sort((a, b) => b[1].at - a[1].at).slice(0, 60);
      store.set(LISTS_KEY, JSON.stringify(Object.fromEntries(keep)));
    }, 600);
  }

  const otherLists = () => Object.entries(snapshots()).filter(([id, s]) => id !== o.id && s.items?.length).sort((a, b) => b[1].at - a[1].at);

  function copyFromList() {
    const lists = otherLists();
    if (!lists.length) { o.toast('Noch keine anderen Packlisten auf diesem Gerät.'); return; }
    const box = el('div', { class: 'menu' });
    const d = dialog('Aus Liste übernehmen', box);
    d.classList.add('pk-dialog');
    for (const [id, s] of lists) {
      const onList = new Set(packItems(ydoc).map(i => normalize(i.name)));
      const fresh = s.items.filter(i => !onList.has(normalize(i.name)));
      const b = el('button', { type: 'button', class: 'pk-pick' },
        el('span', { class: 'recent-title' }, s.title || id),
        el('span', { class: 'recent-meta' }, fresh.length ? `${fresh.length} neu von ${s.items.length}` : 'alles schon drauf'));
      if (!fresh.length) b.disabled = true;
      b.addEventListener('click', () => {
        d.close();
        const before = new Set(items.keys());
        tx(() => {
          let at = Date.now();
          for (const i of fresh) {
            if (items.size >= MAX_PACK_ITEMS) break;
            const m = new Y.Map<unknown>();
            m.set('name', i.name); m.set('qty', i.qty || 1); m.set('mode', i.mode); m.set('cat', validCategory(i.cat)); m.set('at', at++);
            items.set(rid(), m);
          }
        });
        const added = [...items.keys()].filter(k => !before.has(k));
        undoToast(`${added.length} übernommen.`, () => tx(() => { for (const k of added) items.delete(k); }));
      });
      box.append(b);
    }
  }

  // ── Als Text teilen ───────────────────────────────────────────────────────

  async function shareText() {
    const text = packMarkdown(ydoc);
    try {
      if (navigator.share) { await navigator.share({ title: title() || 'Packliste', text }); return; }
    } catch (e) {
      if ((e as DOMException)?.name === 'AbortError') return;
    }
    try { await navigator.clipboard.writeText(text); o.toast('Liste kopiert.'); }
    catch { o.toast('Kopieren ging nicht.'); }
  }

  // ── Änderungen ────────────────────────────────────────────────────────────

  let frame = 0;
  const schedule = () => {
    if (frame) return;
    frame = requestAnimationFrame(() => { frame = 0; render(); if (!suggestBox.hidden) renderSuggestions(); });
  };
  items.observeDeep(schedule);
  claims.observe(schedule);
  members.observe(schedule);
  local.whenSynced.then(() => { syncTitle(); render(); });

  function setEditable(on: boolean) {
    canEdit = on;
    titleInput.readOnly = !on;
    addForm.hidden = !on;
    render();
    join();
  }

  setEditable(canEdit);
  syncTitle();
  if (canEdit && !o.exists) requestAnimationFrame(() => titleInput.focus());

  return {
    markdown: () => packMarkdown(ydoc),
    title,
    setEditable,
    setName(name: string) {
      myName = name || '';
      awareness.setLocalStateField('user', { name: myName || 'Gast', color: myColor });
      if (created && canEdit && members.has(me)) ydoc.transact(() => members.set(me, myName), LOCAL);
      render();
    },
    reconnect() {
      if (!created) return;
      provider.disconnect();
      provider.connect();
    },
    menuItems() {
      const out: MenuItem[] = [];
      const { names } = snapshot();
      if (items.size && together(names)) out.push(['Wer bringt was', whoBringsWhat]);
      if (canEdit && otherLists().length) out.push(['Aus Liste übernehmen …', copyFromList]);
      if (canEdit && claims.size) out.push(['Zurücksetzen', () => resetList()]);
      if (items.size) out.push(['Als Text teilen', shareText]);
      return out;
    },
  };
}
