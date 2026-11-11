// Prüft die API gegen einen laufenden Server (lokal: npm run dev).
//   node tools/test-api.mjs [http://localhost:8790]
// Liest API_KEY und TOTP_SECRET aus .dev.vars.
//
// Gegen die Live-Seite (ohne 2FA-Teil, API-Schlüssel aus ~/.config/md/api-key):
//   MD_API_KEY=$(cat ~/.config/md/api-key) node tools/test-api.mjs https://md.veerka.mp

import { readFileSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import * as Y from 'yjs';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import * as sync from 'y-protocols/sync';

const BASE = process.argv[2] || 'http://localhost:8790';
const vars = Object.fromEntries(readFileSync('.dev.vars', 'utf8').split('\n').filter(l => /^\w+=/.test(l)).map(l => l.split(/=(.*)/s).slice(0, 2)));
const LIVE = !!process.env.MD_API_KEY;
const API = { authorization: `Bearer ${process.env.MD_API_KEY || vars.API_KEY}` };

let failed = 0;
const ok = (cond, msg) => { console.log(`${cond ? '✓' : '✗'} ${msg}`); if (!cond) failed++; };

function totp(secret, offset = 0) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0, value = 0; const out = [];
  for (const ch of secret.toUpperCase().replace(/[=\s-]/g, '')) {
    value = (value << 5) | alphabet.indexOf(ch); bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 0xff); bits -= 8; }
  }
  const counter = Math.floor(Date.now() / 30000) + offset;
  const msg = Buffer.alloc(8); msg.writeBigUInt64BE(BigInt(counter));
  const sig = createHmac('sha1', Buffer.from(out)).update(msg).digest();
  const o = sig[sig.length - 1] & 15;
  return String((sig.readUInt32BE(o) & 0x7fffffff) % 1e6).padStart(6, '0');
}

const j = r => r.json();

// ── Agenten-API ─────────────────────────────────────────────────────────────
const id = `api-test-${Date.now().toString(36)}`;
let r = await fetch(`${BASE}/api/docs`, { method: 'POST', headers: { ...API, 'content-type': 'application/json' }, body: JSON.stringify({ id, markdown: '# Von der API\n\nHallo.' }) });
let d = await j(r);
ok(r.status === 201 && d.url.endsWith(id) && d.editUrl.includes('#edit='), 'POST /api/docs legt Dokument an');
const editKey = d.editUrl.split('#edit=')[1];

r = await fetch(`${BASE}/api/docs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"markdown":"x"}' });
ok(r.status === 401, 'POST /api/docs ohne Schlüssel → 401');

r = await fetch(`${BASE}/api/docs`, { method: 'POST', headers: { ...API, 'content-type': 'application/json' }, body: JSON.stringify({ id, markdown: 'x' }) });
ok(r.status === 409, 'Gleiche ID nochmal → 409');

r = await fetch(`${BASE}/${id}.md`);
ok(r.headers.get('content-type').startsWith('text/markdown') && (await r.text()).startsWith('# Von der API'), 'GET /<id>.md liefert Markdown');

r = await fetch(`${BASE}/${id}`, { headers: { accept: 'text/markdown' } });
ok((await r.text()).startsWith('# Von der API'), 'Accept: text/markdown liefert Markdown');

r = await fetch(`${BASE}/${id}`);
let html = await r.text();
ok(html.includes('<h1 id="von-der-api"') && html.includes('<title>Von der API</title>'), 'HTML-Ansicht ist serverseitig gerendert');
ok(r.headers.get('x-robots-tag')?.includes('noindex'), 'noindex gesetzt');

r = await fetch(`${BASE}/api/docs/${id}`, { method: 'PUT', headers: { 'x-edit-key': editKey, 'content-type': 'text/markdown' }, body: '# Neu\n\n<script>alert(1)</script>' });
ok(r.ok, 'PUT mit Bearbeitungsschlüssel');
r = await fetch(`${BASE}/${id}`);
html = await r.text();
ok(html.includes('&lt;script&gt;') && !html.includes('<script>alert'), 'Rohes HTML wird escaped');

r = await fetch(`${BASE}/api/docs/${id}`, { method: 'PUT', headers: { 'x-edit-key': 'falsch', 'content-type': 'text/markdown' }, body: 'hack' });
ok(r.status === 401, 'PUT mit falschem Schlüssel → 401');

// ── WebSocket: ohne Schlüssel nur lesen ─────────────────────────────────────
async function wsSession(key, change) {
  const url = `${BASE.replace('http', 'ws')}/api/docs/${id}/ws${key ? `?key=${key}` : ''}`;
  const ws = new WebSocket(url); ws.binaryType = 'arraybuffer';
  const doc = new Y.Doc();
  let hello;
  await new Promise((resolve, reject) => {
    ws.onerror = reject;
    ws.onmessage = ev => {
      const dec = decoding.createDecoder(new Uint8Array(ev.data));
      const type = decoding.readVarUint(dec);
      if (type === 9) hello ??= JSON.parse(decoding.readVarString(dec));
      if (type === 0) {
        const enc = encoding.createEncoder(); encoding.writeVarUint(enc, 0);
        const sub = sync.readSyncMessage(dec, enc, doc, 'remote');
        if (encoding.length(enc) > 1) ws.send(encoding.toUint8Array(enc));
        if (sub === 1) resolve();
      }
    };
    ws.onopen = () => { const enc = encoding.createEncoder(); encoding.writeVarUint(enc, 0); sync.writeSyncStep1(enc, doc); ws.send(encoding.toUint8Array(enc)); };
  });
  if (change) {
    doc.on('update', (u, origin) => {
      if (origin === 'remote') return;
      const enc = encoding.createEncoder(); encoding.writeVarUint(enc, 0); sync.writeUpdate(enc, u); ws.send(encoding.toUint8Array(enc));
    });
    doc.getText('md').insert(0, change);
    await new Promise(r => setTimeout(r, 300));
  }
  const text = doc.getText('md').toString();
  ws.close();
  return { text, hello };
}

let s = await wsSession(null, 'EINDRINGLING ');
ok(s.hello?.edit === false && s.text.includes('# Neu'), 'WebSocket ohne Schlüssel: nur lesen');
r = await fetch(`${BASE}/${id}.md`);
ok(!(await r.text()).includes('EINDRINGLING'), 'Änderung ohne Schlüssel wird verworfen');

s = await wsSession(editKey, 'Hallo ');
ok(s.hello?.edit === true, 'WebSocket mit Schlüssel: bearbeiten');
r = await fetch(`${BASE}/${id}.md`);
ok((await r.text()).startsWith('Hallo # Neu'), 'Änderung mit Schlüssel kommt an');

// ── 2FA ─────────────────────────────────────────────────────────────────────
if (LIVE) console.log('– 2FA-Teil übersprungen (Live)');
r = LIVE ? { status: 401 } : await fetch(`${BASE}/api/unlock`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"code":"000000"}' });
ok(r.status === 401 || r.status === 429, 'Falscher Code → abgelehnt');

// Jeder Code gilt nur einmal: zwei verschiedene Zeitfenster benutzen.
const codes = [-1, 0, 1].map(off => totp(vars.TOTP_SECRET, off));
async function unlockWith(doc) {
  while (codes.length) {
    const res = await fetch(`${BASE}/api/unlock`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: codes.shift(), doc }) });
    if (res.ok) return res.json();
  }
  return {};
}
d = LIVE ? { editKey } : await unlockWith(id);
ok(d.editKey === editKey && !d.token, 'Code im Dokument → nur dessen Bearbeitungsschlüssel, kein Admin-Token');
d = LIVE ? {} : await unlockWith(undefined);
const admin = LIVE ? process.env.MD_API_KEY : d.token;
ok(!!admin, 'Code ohne Dokument → Admin-Token');

r = await fetch(`${BASE}/api/admin/docs`, { headers: { authorization: `Bearer ${admin}` } });
d = await j(r);
ok(r.ok && d.docs.some(x => x.id === id && !x.pinned), 'Admin-Übersicht listet das Dokument (nicht automatisch behalten)');

// ── Umbenennen ──────────────────────────────────────────────────────────────
const id2 = `${id}-neu`;
r = await fetch(`${BASE}/api/docs/${id}/rename`, { method: 'POST', headers: { 'x-edit-key': 'falsch', 'content-type': 'application/json' }, body: JSON.stringify({ to: id2 }) });
ok(r.status === 401, 'Umbenennen ohne Schlüssel → 401');
r = await fetch(`${BASE}/api/docs/${id}/rename`, { method: 'POST', headers: { 'x-edit-key': editKey, 'content-type': 'application/json' }, body: JSON.stringify({ to: id2.toUpperCase() }) });
d = await j(r);
ok(r.ok && d.id === id2, 'Umbenennen mit Schlüssel');
r = await fetch(`${BASE}/${id}.md`, { redirect: 'manual' });
ok(r.status === 404, 'Selbst gewählte alte Adresse wird frei (keine Weiterleitung)');
r = await fetch(`${BASE}/${id2}.md`);
ok((await r.text()).startsWith('Hallo # Neu'), 'Inhalt unter neuer Adresse');
r = await fetch(`${BASE}/api/docs/${id2}`, { method: 'PUT', headers: { 'x-edit-key': editKey, 'content-type': 'text/markdown' }, body: '# Umgezogen' });
ok(r.ok, 'Bearbeitungsschlüssel gilt weiter');
// Zufällige Adresse → leitet nach dem Umbenennen weiter.
r = await fetch(`${BASE}/api/docs`, { method: 'POST', headers: { ...API, 'content-type': 'text/markdown' }, body: '# Zufall' });
d = await j(r);
const rnd = d.id, rndKey = d.editUrl.split('#edit=')[1];
ok(/^[a-z0-9]{10}$/.test(rnd), 'API ohne ID → zufällige 10-stellige Adresse');
const rnd2 = `${id}-aus-zufall`;
r = await fetch(`${BASE}/api/docs/${rnd}/rename`, { method: 'POST', headers: { 'x-edit-key': rndKey, 'content-type': 'application/json' }, body: JSON.stringify({ to: rnd2 }) });
ok(r.ok, 'Zufällige Adresse umbenennen');
r = await fetch(`${BASE}/${rnd}`, { redirect: 'manual' });
ok(r.status === 301 && r.headers.get('location') === `/${rnd2}`, 'Zufällige alte Adresse leitet weiter');
r = await fetch(`${BASE}/api/docs/${rnd}/rename`, { method: 'POST', headers: { 'x-edit-key': rndKey, 'content-type': 'application/json' }, body: JSON.stringify({ to: 'irgendwas' }) });
ok(r.status === 401, 'Weiterleitung lässt sich nicht nochmal umbenennen');
await fetch(`${BASE}/api/docs/${rnd2}`, { method: 'DELETE', headers: API });
await fetch(`${BASE}/api/docs/${rnd}`, { method: 'DELETE', headers: API });
r = await fetch(`${BASE}/api/docs`, { method: 'POST', headers: { ...API, 'content-type': 'text/markdown' }, body: 'x' });
const other = (await j(r)).id;
r = await fetch(`${BASE}/api/docs/${id2}/rename`, { method: 'POST', headers: { 'x-edit-key': editKey, 'content-type': 'application/json' }, body: JSON.stringify({ to: other }) });
ok(r.status === 409, 'Belegte Adresse → 409');
await fetch(`${BASE}/api/docs/${other}`, { method: 'DELETE', headers: API });
r = await fetch(`${BASE}/api/admin/docs`, { headers: { authorization: `Bearer ${admin}` } });
d = await j(r);
ok(d.docs.some(x => x.id === id2) && !d.docs.some(x => x.id === id), 'Übersicht zeigt nur die neue Adresse');

r = await fetch(`${BASE}/api/admin/docs`);
ok(r.status === 401, 'Admin-Übersicht ohne Token → 401');

// ── Löschen ─────────────────────────────────────────────────────────────────
r = await fetch(`${BASE}/api/docs/${id2}`, { method: 'DELETE', headers: { authorization: `Bearer ${admin}` } });
ok(r.ok, 'DELETE mit Admin-Token');
r = await fetch(`${BASE}/${id2}.md`);
ok(r.status === 404, 'Gelöschtes Dokument ist weg');
r = await fetch(`${BASE}/api/admin/docs`, { headers: { authorization: `Bearer ${admin}` } });
ok(!(await j(r)).docs.some(x => x.id === id2), 'Und aus der Übersicht verschwunden');
await fetch(`${BASE}/api/docs/${id}`, { method: 'DELETE', headers: API });

// ── Sonstiges ───────────────────────────────────────────────────────────────
r = await fetch(`${BASE}/Gro%C3%9Fe%20K%C3%BCche`, { redirect: 'manual' });
ok(r.status === 301 && r.headers.get('location') === `/${encodeURIComponent('große-küche')}`, 'Adresse wird normalisiert (Kleinbuchstaben, Bindestriche)');
r = await fetch(`${BASE}/`, { redirect: 'manual' });
ok(r.status === 302 && /^\/[a-z0-9]{10}$/.test(r.headers.get('location')), 'Startseite leitet auf zufällige ID um');
r = await fetch(`${BASE}/robots.txt`);
ok(!/^Disallow: \/\s*$/m.test((await r.text()).split('END Cloudflare Managed Content').pop()), 'robots.txt sperrt KI-Assistenten nicht');

// ── Konto (nur lokal mit DEV_LOGIN=1) ───────────────────────────────────────
if (!LIVE && vars.DEV_LOGIN === '1') {
  r = await fetch(`${BASE}/api/me`);
  ok(r.status === 401, 'GET /api/me ohne Anmeldung → 401');
  r = await fetch(`${BASE}/auth/login?next=//evil.example`, { redirect: 'manual' });
  ok(r.status === 302 && r.headers.get('location') === '/home', 'Login leitet nur auf eigene Pfade zurück');
  const session = (r.headers.get('set-cookie') || '').match(/md_session=([^;]+)/)?.[1];
  ok(!!session, 'Testlogin setzt Sitzungs-Cookie');
  const C = { cookie: `md_session=${session}` };

  r = await fetch(`${BASE}/api/admin/docs`, { headers: { authorization: `Bearer ${session}` } });
  ok(r.status === 401, 'Sitzungs-Cookie gilt nicht als Admin-Token');
  r = await fetch(`${BASE}/api/me`, { headers: { cookie: `md_session=${admin}` } });
  ok(r.status === 401, 'Admin-Token gilt nicht als Sitzung');
  if (vars.ADMIN_EMAIL === 'test@localhost') {
    r = await fetch(`${BASE}/api/admin/docs`, { headers: C });
    ok(r.status === 200, 'Admin-Konto (ADMIN_EMAIL) kommt ohne Code in die Übersicht');
    r = await fetch(`${BASE}/api/docs/${id}/pin`, { method: 'POST', headers: { ...C, 'content-type': 'application/json', origin: 'https://evil.example' }, body: '{"pinned":true}' });
    ok(r.status === 401, 'Admin per Cookie: fremde Herkunft abgelehnt');
    r = await fetch(`${BASE}/admin`, { headers: C });
    ok((await r.text()).includes('"admin":true'), '/admin weiß, dass das Konto Admin ist');
  }

  const own = `konto-test-${Date.now().toString(36)}`;
  r = await fetch(`${BASE}/api/docs/${own}/create`, { method: 'POST', headers: { ...C, 'content-type': 'application/json' }, body: '{}' });
  d = await j(r);
  ok(r.status === 201 && d.editKey, 'Angemeldet: Anlegen ohne Turnstile');
  const ownKey = d.editKey;
  r = await fetch(`${BASE}/api/me`, { headers: C });
  d = await j(r);
  ok(d.user?.name === 'Testkonto' && !('sub' in d.user), '/api/me liefert Konto ohne Google-ID');
  ok(d.docs.some(x => x.id === own && x.editKey === ownKey), 'Neues Dokument steht samt Schlüssel im Konto');

  r = await fetch(`${BASE}/${own}`, { headers: C });
  ok((await r.text()).includes(`"editKey":"${ownKey}"`), 'Dokumentseite bringt den Schlüssel aus dem Konto mit');
  r = await fetch(`${BASE}/${own}`);
  ok(!(await r.text()).includes(ownKey), 'Ohne Anmeldung kein Schlüssel in der Seite');

  r = await fetch(`${BASE}/api/me/docs/${own}/tags`, { method: 'PUT', headers: { ...C, 'content-type': 'application/json' }, body: JSON.stringify({ tags: ['#Rezepte', 'rezepte', ' Reise  2026 ', ''] }) });
  d = await j(r);
  ok(JSON.stringify(d.tags) === '["Rezepte","Reise 2026"]', 'Tags werden gesäubert (ohne #, ohne Doppelte)');
  r = await fetch(`${BASE}/api/me/docs/${own}/tags`, { method: 'PUT', headers: { ...C, 'content-type': 'application/json', origin: 'https://evil.example' }, body: '{"tags":["x"]}' });
  ok(r.status === 403, 'Konto-API lehnt fremde Herkunft ab');

  r = await fetch(`${BASE}/api/me/docs`, { method: 'POST', headers: { ...C, 'content-type': 'application/json' }, body: JSON.stringify({ items: [{ id: 'Fremdes Doc', title: 'Alt', opened: 1 }, { id: '../x' }] }) });
  d = await j(r);
  ok(d.docs.some(x => x.id === 'fremdes-doc' && x.editKey === null) && !d.docs.some(x => x.id.includes('/')), 'Liste übernimmt Einträge, normalisiert IDs');

  r = await fetch(`${BASE}/api/docs/${own}/rename`, { method: 'POST', headers: { ...C, 'content-type': 'application/json', 'x-edit-key': ownKey }, body: JSON.stringify({ to: `${own}-neu` }) });
  r = await fetch(`${BASE}/api/me`, { headers: C });
  d = await j(r);
  const moved = d.docs.find(x => x.id === `${own}-neu`);
  ok(moved && moved.tags.length === 2 && !d.docs.some(x => x.id === own), 'Umbenennen nimmt Eintrag samt Tags mit');

  r = await fetch(`${BASE}/api/me/docs/fremdes-doc`, { method: 'DELETE', headers: C });
  r = await fetch(`${BASE}/api/me`, { headers: C });
  ok(!(await j(r)).docs.some(x => x.id === 'fremdes-doc'), 'Eintrag lässt sich aus der Liste nehmen');

  r = await fetch(`${BASE}/api/me`, { method: 'DELETE', headers: C });
  ok(r.ok && /md_session=;/.test(r.headers.get('set-cookie') || ''), 'Konto löschen räumt das Cookie weg');
  r = await fetch(`${BASE}/api/me`, { headers: C });
  ok(r.ok && (await j(r)).docs.length === 0, 'Gelöschtes Konto ist leer');
  await fetch(`${BASE}/api/docs/${own}-neu`, { method: 'DELETE', headers: API });
}

console.log(failed ? `\n${failed} fehlgeschlagen` : '\nAlles grün');
process.exit(failed ? 1 : 0);
