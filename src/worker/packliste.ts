// Umzug aus der alten Packliste-App (packliste.veerka.mp, Firebase-Projekt
// packliste-71d90) in md-Packlisten.
//
// md liest dafür mit einem Service-Account (nur Lesen) direkt aus Firebase:
//   1. Firebase-Konto zum angemeldeten Google-Konto finden (Google-ID, sonst E-Mail)
//   2. spaces/<uid>: eigene Listen, Artikel-Pool, Verknüpfungen, Verweise auf
//      geteilte Listen
//   3. lists/<id>: geteilte Listen (nur, wenn man Mitglied ist)
//
// Jede alte Liste bekommt eine feste md-Adresse, abgeleitet aus ihrer alten
// ID. Deshalb legt ein zweiter Umzug (anderes Gerät, anderes Mitglied einer
// geteilten Liste) nichts doppelt an, sondern findet dieselbe Liste wieder.
// Haken werden nicht übernommen.
//
// Secret FIREBASE_SERVICE_ACCOUNT: JSON-Schlüssel des Service-Accounts
// (Rollen „Cloud Datastore Viewer“ und „Firebase Authentication Viewer“).

import * as Y from 'yjs';
import { guessCategory, guessMode, MAX_PACK_ITEMS, MAX_QTY, type PackMode } from '../shared/pack';
import { b64urlEncode } from './crypto';
import { currentUser } from './auth';
import { accountStub, docStub, type Env } from './env';
import { fail, json, readJson } from './http';

interface ServiceAccount { project_id: string; client_email: string; private_key: string }

interface OldItem { name: string; qty: number; mode: PackMode }
interface OldList { key: string; title: string; shared: boolean; items: OldItem[] }

// ── Zugang ──────────────────────────────────────────────────────────────────

let cached: { token: string; exp: number; email: string } | null = null;

function account(raw: string | undefined): ServiceAccount | null {
  if (!raw) return null;
  try {
    const sa = JSON.parse(raw) as ServiceAccount;
    return sa.project_id && sa.client_email && sa.private_key ? sa : null;
  } catch { return null; }
}

const packlisteEnabled = (raw: string | undefined) => !!account(raw);

const b64urlText = (s: string) => b64urlEncode(new TextEncoder().encode(s));

async function accessToken(sa: ServiceAccount): Promise<string> {
  if (cached && cached.email === sa.client_email && cached.exp > Date.now() + 60_000) return cached.token;
  const der = Uint8Array.from(atob(sa.private_key.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '')), c => c.charCodeAt(0));
  const key = await crypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${b64urlText(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${b64urlText(JSON.stringify({
    iss: sa.client_email, scope: 'https://www.googleapis.com/auth/cloud-platform',
    aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600,
  }))}`;
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(unsigned));
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${b64urlEncode(new Uint8Array(sig))}` }),
  });
  if (!res.ok) throw new Error(`Firebase-Zugang abgelehnt (${res.status})`);
  const data = await res.json<{ access_token: string; expires_in: number }>();
  cached = { token: data.access_token, exp: Date.now() + data.expires_in * 1000, email: sa.client_email };
  return data.access_token;
}

/** Firebase-Konto zum Google-Konto: erst über die Google-ID, sonst über die (bestätigte) E-Mail. */
async function firebaseUid(sa: ServiceAccount, token: string, sub: string, email: string): Promise<string | null> {
  const url = `https://identitytoolkit.googleapis.com/v1/projects/${sa.project_id}/accounts:lookup`;
  const ask = async (body: object) => {
    const res = await fetch(url, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    if (!res.ok) throw new Error(`Firebase-Konten nicht lesbar (${res.status})`);
    const data = await res.json<{ users?: { localId: string }[] }>();
    return data.users?.[0]?.localId || null;
  };
  return (await ask({ federatedUserId: [{ providerId: 'google.com', rawId: sub }] })) || (email ? ask({ email: [email] }) : null);
}

// ── Firestore (REST, typisierte Werte) ──────────────────────────────────────

type FsValue = Record<string, unknown>;
function decode(v: FsValue | undefined): unknown {
  if (!v) return undefined;
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return Number(v.doubleValue);
  if ('booleanValue' in v) return v.booleanValue;
  if ('nullValue' in v) return null;
  if ('timestampValue' in v) return Date.parse(String(v.timestampValue));
  if ('arrayValue' in v) return ((v.arrayValue as { values?: FsValue[] }).values || []).map(decode);
  if ('mapValue' in v) return fields((v.mapValue as { fields?: Record<string, FsValue> }).fields);
  return undefined;
}
function fields(f: Record<string, FsValue> | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(f || {})) out[k] = decode(v);
  return out;
}

async function getDoc(sa: ServiceAccount, token: string, path: string): Promise<Record<string, unknown> | null> {
  const res = await fetch(`https://firestore.googleapis.com/v1/projects/${sa.project_id}/databases/(default)/documents/${path}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Firestore nicht lesbar (${res.status})`);
  return fields((await res.json<{ fields?: Record<string, FsValue> }>()).fields);
}

// ── Umwandeln ───────────────────────────────────────────────────────────────

type Rec = Record<string, unknown>;
const obj = (v: unknown): Rec => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : {});
const alive = (r: Rec) => !r.deletedAt;
const qtyOf = (v: unknown) => Math.max(1, Math.min(MAX_QTY, Math.round(Number(v)) || 1));
const modeOf = (v: unknown, name: string): PackMode => (v === 'gemeinsam' || v === 'persoenlich' ? v : guessMode(name, guessCategory(name)));
const titleOf = (name: unknown, emoji: unknown) => [String(emoji || '').trim(), String(name || '').trim() || 'Packliste'].filter(Boolean).join(' ').slice(0, 120);

/** Alle Listen, die zum Google-Konto gehören (eigene und geteilte), alphabetisch. */
async function oldLists(raw: string | undefined, sub: string, email: string): Promise<OldList[] | null> {
  const sa = account(raw);
  if (!sa) throw new Error('Firebase ist nicht eingerichtet.');
  const token = await accessToken(sa);
  const uid = await firebaseUid(sa, token, sub, email);
  if (!uid) return null;
  const space = await getDoc(sa, token, `spaces/${encodeURIComponent(uid)}`) || {};
  const out: OldList[] = [];

  // Eigene Listen: Artikel-Pool + Verknüpfungen.
  const pool = obj(space.items);
  const links = obj(space.itemLists);
  for (const [listId, l] of Object.entries(obj(space.lists))) {
    const list = obj(l);
    if (!alive(list)) continue;
    const items: OldItem[] = [];
    for (const [itemId, byList] of Object.entries(links)) {
      const e = obj(obj(byList)[listId]);
      const item = obj(pool[itemId]);
      const name = String(item.name || '').trim();
      if (!Object.keys(e).length || !alive(e) || !alive(item) || !name) continue;
      items.push({ name, qty: qtyOf(e.qty), mode: modeOf(e.mode, name) });
    }
    out.push({ key: listId, title: titleOf(list.name, list.emoji), shared: false, items });
  }

  // Geteilte Listen: eigenes Dokument, nur als Mitglied.
  for (const [listId, ref] of Object.entries(obj(space.sharedLists))) {
    if (!alive(obj(ref))) continue;
    const list = await getDoc(sa, token, `lists/${encodeURIComponent(listId)}`);
    if (!list || !alive(list) || !obj(list.members)[uid]) continue;
    const items: OldItem[] = [];
    for (const it of Object.values(obj(list.items))) {
      const item = obj(it);
      const name = String(item.name || '').trim();
      if (!alive(item) || !name) continue;
      items.push({ name, qty: qtyOf(item.qty), mode: modeOf(item.mode, name) });
    }
    out.push({ key: listId, title: titleOf(list.name, list.emoji), shared: true, items });
  }

  for (const l of out) {
    // Doppelte Namen (kam in der alten App bei Sync-Konflikten vor) zusammenlegen.
    const seen = new Set<string>();
    l.items = l.items.filter(i => { const k = i.name.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, MAX_PACK_ITEMS);
  }
  return out.sort((a, b) => a.title.replace(/^\P{L}+/u, '').localeCompare(b.title.replace(/^\P{L}+/u, ''), 'de'));
}

/** Feste md-Adresse für eine alte Liste (sieht aus wie eine zufällige). */
async function packIdFor(oldKey: string): Promise<string> {
  for (let n = 0; ; n++) {
    const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`packliste:${oldKey}:${n}`)));
    const id = [...hash.slice(0, 10)].map(b => 'abcdefghijklmnopqrstuvwxyz0123456789'[b % 36]).join('');
    if (/\d/.test(id) && /[a-z]/.test(id)) return id;
  }
}

/** Yjs-Stand einer neuen Packliste (wie src/shared/pack.ts). */
function packState(list: OldList): Uint8Array {
  const doc = new Y.Doc();
  doc.transact(() => {
    doc.getMap('meta').set('title', list.title);
    const items = doc.getMap<Y.Map<unknown>>('items');
    let at = Date.now();
    for (const it of list.items) {
      const m = new Y.Map<unknown>();
      const cat = guessCategory(it.name);
      m.set('name', it.name);
      m.set('qty', it.qty);
      m.set('mode', it.mode);
      m.set('cat', cat);
      m.set('at', at++);
      items.set(Math.random().toString(36).slice(2, 10), m);
    }
  });
  const state = Y.encodeStateAsUpdate(doc);
  doc.destroy();
  return state;
}

// ── Route ───────────────────────────────────────────────────────────────────

/**
 * /api/pack/umzug: GET zeigt, was es in der alten Packliste gibt; POST legt
 * die Listen an bzw. findet schon umgezogene wieder (feste Adresse je alter
 * Liste) und trägt sie ins Konto ein. Body: { only?: string[] } (md-Adressen).
 */
export async function packUmzug(req: Request, env: Env): Promise<Response> {
  const user = await currentUser(req, env);
  if (!user) return fail(401, 'Bitte mit Google anmelden.');
  if (!packlisteEnabled(env.FIREBASE_SERVICE_ACCOUNT)) return fail(503, 'Der Umzug ist noch nicht eingerichtet.');
  if (req.method !== 'GET' && req.method !== 'POST') return fail(405, 'Methode nicht erlaubt.');
  let lists;
  try {
    lists = await oldLists(env.FIREBASE_SERVICE_ACCOUNT, user.sub, user.email);
  } catch (err) {
    console.error(err);
    return fail(502, 'Die alte Packliste ist gerade nicht erreichbar.');
  }
  if (!lists) return json({ found: false, lists: [] });
  const withIds = await Promise.all(lists.map(async l => ({ ...l, id: await packIdFor(l.key) })));

  if (req.method === 'GET') {
    const out = await Promise.all(withIds.map(async l => {
      const info = await docStub(env, l.id).info();
      return { id: l.id, title: l.title, count: l.items.length, shared: l.shared, moved: info.exists || !!info.movedTo };
    }));
    return json({ found: true, lists: out });
  }

  const { success } = await env.CREATE_LIMIT.limit({ key: `u:${user.sub}` });
  if (!success) return fail(429, 'Zu viele Versuche. Bitte kurz warten.');
  const body = await readJson<{ only: unknown }>(req);
  const only = Array.isArray(body.only) ? new Set(body.only.map(String)) : null;
  const results: { id: string; editKey: string; ownerKey: string | null; title: string; created: boolean; items: { name: string; qty: number; mode: string; cat: string }[] }[] = [];
  for (const l of withIds) {
    if (only && !only.has(l.id)) continue;
    let id = l.id;
    let stub = docStub(env, id);
    let info = await stub.info();
    if (info.movedTo) { id = info.movedTo; stub = docStub(env, id); info = await stub.info(); }
    if (info.trashed) continue;
    let editKey: string | null = null;
    let ownerKey: string | null = null;
    let created = false;
    if (!info.exists) {
      editKey = await stub.create(id, '', undefined, 'pack', packState(l));
      if (editKey) { ownerKey = await stub.ownerKey(); created = true; }
    }
    editKey ??= await stub.getEditKey();
    if (!editKey) continue;
    results.push({
      id, editKey, ownerKey, created,
      title: created ? l.title : info.title || l.title,
      items: created ? l.items.map(i => ({ ...i, cat: guessCategory(i.name) })) : [],
    });
  }
  if (results.length) await accountStub(env, user.sub).upsert(results.map(r => ({ id: r.id, editKey: r.editKey, ownerKey: r.ownerKey, opened: Date.now(), kind: 'pack', title: r.title })));
  return json({ lists: results });
}
