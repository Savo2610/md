// Memos: private Kurznotizen eines Kontos (/memos, /api/me/memos/…, /m/<datei>).
//
// Memos sind pro Konto privat: Es gibt keinen Zugriff darauf über Admin,
// API-Schlüssel oder die Übersicht. Inhalte und Koordinaten stehen nie in
// Adressen (die landen in den Logs).

import { render } from '../shared/render';
import { toFunk } from '../shared/funk';
import { titleOf } from '../shared/title';
import { randomId, randomToken } from './crypto';
import { currentUser, type User } from './auth';
import { FILE_NAME, MAX_FILE, MAX_MEMO, MEMO_ID, type Memo } from './account';
import { accountStub, docStub, registry, type Env } from './env';
import { ratesFor } from './fx';
import { fail, json, notFound, readJson } from './http';
import { serveFile } from './files';
import { accountBoot, MEMOS_APP, page, type MemoOut } from './pages';

type AccountStub = ReturnType<typeof accountStub>;

const memoOut = (m: Memo): MemoOut => ({ ...m, html: render(m.text).html });

/** Zeilenenden vereinheitlichen, Leerzeilen vorn und Leerraum hinten weg. */
const cleanText = (t: unknown) => (typeof t === 'string' ? t.replace(/\r\n?/g, '\n').replace(/^(\s*\n)+|\s+$/g, '') : '');

// ── Anhänge in R2 ───────────────────────────────────────────────────────────

/** R2-Schlüssel eines Memo-Anhangs: pro Konto ein eigener Ordner. */
const memoFileKey = (env: Env, sub: string, name: string) => `memos/${env.ACCOUNT.idFromName(`g:${sub}`).toString()}/${name}`;

export async function deleteMemoFiles(env: Env, sub: string, names: string[]) {
  if (names.length) await env.IMAGES.delete(names.map(n => memoFileKey(env, sub, n)));
}

/** Alle Anhänge eines Kontos (beim Löschen des Kontos). */
export async function deleteAllMemoFiles(env: Env, sub: string) {
  const prefix = memoFileKey(env, sub, '');
  let cursor: string | undefined;
  do {
    const list = await env.IMAGES.list({ prefix, cursor });
    if (list.objects.length) await env.IMAGES.delete(list.objects.map(o => o.key));
    cursor = list.truncated ? list.cursor : undefined;
  } while (cursor);
}

const EXT_OF_TYPE: Record<string, string> = {
  'image/webp': 'webp', 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/avif': 'avif', 'image/heic': 'heic',
  'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a', 'audio/aac': 'aac', 'audio/mpeg': 'mp3', 'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/wav': 'wav',
  'video/mp4': 'mp4', 'video/quicktime': 'mov', 'application/pdf': 'pdf', 'text/plain': 'txt',
};

/** Dateiendung aus dem Namen, sonst aus dem Typ. */
function extOf(name: string, type: string): string {
  const fromName = /\.([a-z0-9]{1,8})$/i.exec(name)?.[1]?.toLowerCase();
  return fromName || EXT_OF_TYPE[type] || 'bin';
}

/** GET /m/<datei>: Anhang ausliefern, nur an das eigene Konto. */
export async function memoFile(req: Request, env: Env, name: string): Promise<Response> {
  if (!FILE_NAME.test(name)) return notFound();
  const user = await currentUser(req, env);
  if (!user) return notFound();
  return (await serveFile(req, env.IMAGES, memoFileKey(env, user.sub, name), name, 'private, max-age=31536000, immutable')) ?? notFound();
}

// ── Seite ───────────────────────────────────────────────────────────────────

/**
 * Memos samt HTML. Verknüpfte Memos zeigen den aktuellen Stand ihres
 * Dokuments (das ist die Quelle); der Text im Memo wird nachgezogen. Ist das
 * Dokument weg oder im Papierkorb, bleibt das Memo mit seiner letzten Kopie
 * stehen und die Verknüpfung fällt weg.
 */
async function linkedMemos(env: Env, acc: AccountStub, list: Memo[]): Promise<MemoOut[]> {
  await ratesFor(list.map(m => m.text));
  return Promise.all(list.map(async m => {
    if (!m.doc) return memoOut(m);
    let doc = m.doc;
    let info = await docStub(env, doc).info(true);
    if (info.movedTo) { doc = info.movedTo; info = await docStub(env, doc).info(true); }
    if (!info.exists || info.trashed) {
      await acc.setMemoDoc(m.id, null);
      return memoOut({ ...m, doc: null });
    }
    if (doc !== m.doc) await acc.setMemoDoc(m.id, doc);
    if (info.markdown !== m.text && info.markdown.trim()) await acc.syncMemoText(m.id, info.markdown, info.updated || Date.now());
    const text = info.markdown.trim() ? info.markdown : m.text;
    return { ...m, doc, text, html: render(text).html, docTitle: info.title || doc };
  }));
}

/** GET /memos */
export async function memosPage(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const user = await currentUser(req, env);
  const common = { page: 'memos' as const, ...accountBoot(user, env) };
  if (!user) return page(req, 'Memos', '<main id="app"></main>', common, 200, MEMOS_APP);
  const acc = accountStub(env, user.sub);
  if (common.admin) {
    // Umzug: vom Admin per API vorbereitete Memos übernehmen.
    const reg = registry(env);
    const pending = await reg.pendingMemos();
    if (pending.length) await reg.doneMemos(await acc.addMemos(pending));
  }
  const memos = await linkedMemos(env, acc, await acc.memos());
  // Nie abgeschickte Anhänge wegräumen.
  ctx.waitUntil(acc.sweepFiles().then(names => deleteMemoFiles(env, user.sub, names)).catch(() => {}));
  return page(req, 'Memos', '<main id="app"></main>', { ...common, memos }, 200, MEMOS_APP);
}

/** POST /api/admin/memos: Memos fürs Admin-Konto vorbereiten (Umzug). */
export async function queueAdminMemos(req: Request, env: Env): Promise<Response> {
  if (!env.ADMIN_EMAIL) return fail(503, 'ADMIN_EMAIL fehlt.');
  const body = await readJson<{ memos: { id?: string; text?: string; created?: number }[] }>(req);
  if (!Array.isArray(body.memos)) return fail(400, 'memos fehlt.');
  const items = body.memos
    .filter(m => typeof m?.text === 'string' && m.text.trim() && m.text.length <= MAX_MEMO && Number(m.created) > 0)
    .map(m => ({ id: typeof m.id === 'string' && MEMO_ID.test(m.id) ? m.id : randomToken(12), text: m.text!, created: Math.floor(Number(m.created)) }));
  return json({ queued: await registry(env).queueMemos(items) });
}

// ── API: /api/me/memos/… ────────────────────────────────────────────────────

export async function memosApi(req: Request, env: Env, user: User, parts: string[], ctx: ExecutionContext): Promise<Response> {
  const acc = accountStub(env, user.sub);
  const method = req.method;

  if (!parts.length) {
    if (method === 'GET') return json({ memos: await linkedMemos(env, acc, await acc.memos()) });
    if (method === 'POST') {
      const b = await readJson<{ id: string; text: string; created: number }>(req);
      const text = cleanText(b.text);
      if (typeof b.id !== 'string' || !MEMO_ID.test(b.id)) return fail(400, 'Ungültige ID.');
      if (!text) return fail(400, 'Leeres Memo.');
      if (text.length > MAX_MEMO) return fail(413, 'Memo zu lang.');
      const m = await acc.addMemo(b.id, text, typeof b.created === 'number' ? b.created : undefined);
      if (!m) return fail(507, 'Zu viele Memos.');
      return json(memoOut(m), 201);
    }
  }

  if (parts.length === 1 && parts[0] === 'files' && method === 'POST') return uploadFile(req, env, user, acc);
  if (parts.length === 1 && parts[0] === 'geo' && method === 'POST') return geo(req, env, user);

  const id = parts[0];
  if (!MEMO_ID.test(id || '')) return fail(404, 'Unbekannt.');
  if (parts.length === 2 && method === 'POST') {
    if (parts[1] === 'funk') return funkMemo(env, user, acc, id);
    if (parts[1] === 'doc') return memoToDoc(env, user, acc, id, ctx);
  }
  if (parts.length !== 1) return fail(404, 'Unbekannt.');

  if (method === 'PUT') {
    const text = cleanText((await readJson<{ text: string }>(req)).text);
    if (!text) return fail(400, 'Leeres Memo.');
    if (text.length > MAX_MEMO) return fail(413, 'Memo zu lang.');
    const { memo, orphans } = await acc.editMemo(id, text);
    ctx.waitUntil(deleteMemoFiles(env, user.sub, orphans));
    if (!memo) return fail(404, 'Memo nicht gefunden.');
    // Verknüpft (z. B. Aufgabe abgehakt): ins Dokument schreiben, das ist die Quelle.
    if (memo.doc) {
      if (!(await docStub(env, memo.doc).replace(text))) await acc.setMemoDoc(id, null);
      const [out] = await linkedMemos(env, acc, [memo]);
      return json(out);
    }
    return json(memoOut(memo));
  }
  if (method === 'DELETE') {
    ctx.waitUntil(deleteMemoFiles(env, user.sub, await acc.deleteMemo(id)));
    return json({ ok: true });
  }
  return fail(405, 'Methode nicht erlaubt.');
}

/**
 * Anhang hochladen: Rohdaten im Body, Originalname im Header X-File-Name
 * (nicht in der Adresse, die landet in den Logs).
 */
async function uploadFile(req: Request, env: Env, user: User, acc: AccountStub): Promise<Response> {
  const { success } = await env.UPLOAD_LIMIT.limit({ key: `u:${user.sub}` });
  if (!success) return fail(429, 'Zu viele Dateien auf einmal. Bitte kurz warten.');
  const size = Number(req.headers.get('content-length'));
  if (!size || !req.body) return fail(411, 'Größe fehlt.');
  if (size > MAX_FILE) return fail(413, 'Datei zu groß (max. 50 MB).');
  const rawType = (req.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  const type = /^[\w.+-]+\/[\w.+-]+$/.test(rawType) ? rawType : 'application/octet-stream';
  let original = '';
  try { original = decodeURIComponent(req.headers.get('x-file-name') || '').slice(0, 200); } catch { /* ohne Namen */ }
  const name = `${randomToken(12)}.${extOf(original, type)}`;
  if (!(await acc.reserveFile(name, size, type))) return fail(507, 'Speicher für Anhänge ist voll.');
  await env.IMAGES.put(memoFileKey(env, user.sub, name), req.body, { httpMetadata: { contentType: type } });
  return json({ url: `/m/${name}`, name, size, type }, 201);
}

/**
 * Ortsname zu Koordinaten (OpenStreetMap). Nur Lage und Sprache gehen raus,
 * kein Konto. Koordinaten im Body, damit sie nicht in den Logs stehen.
 */
async function geo(req: Request, env: Env, user: User): Promise<Response> {
  const b = await readJson<{ lat: unknown; lon: unknown }>(req);
  const lat = Number(b.lat), lon = Number(b.lon);
  if (!(Math.abs(lat) <= 90 && Math.abs(lon) <= 180)) return fail(400, 'Ungültige Koordinaten.');
  const { success } = await env.UPLOAD_LIMIT.limit({ key: `u:${user.sub}` });
  if (!success) return json({ name: '' });
  return json({ name: await placeName(lat, lon) });
}

async function placeName(lat: number, lon: number): Promise<string> {
  try {
    const res = await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=18&addressdetails=1&accept-language=de&lat=${lat}&lon=${lon}`, {
      headers: { 'user-agent': 'md.veerka.mp-memos/1.0 (https://md.veerka.mp)' },
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) return '';
    const d = await res.json<{ name?: string; display_name?: string; address?: Record<string, string> }>();
    const a = d.address || {};
    const road = a.road || a.pedestrian || a.footway || a.path || a.square || '';
    const street = [road, a.house_number].filter(Boolean).join(' ');
    const place = a.village || a.town || a.city || a.municipality || a.hamlet || a.suburb || '';
    const poi = d.name && d.name !== road ? d.name : '';
    const name = [poi, street, place].filter(Boolean).join(', ');
    return (name || (d.display_name || '').split(',').slice(0, 2).join(',')).slice(0, 120);
  } catch {
    return '';
  }
}

/**
 * Memo öffentlich auf funk.veerka.mp stellen: ersetzt die Nachricht, die
 * dort steht, und verschwindet dort nach 7 Tagen. Nur das Admin-Konto.
 * Text als schlichter Text (shared/funk.ts), Anhänge als Datenstrom.
 */
async function funkMemo(env: Env, user: User, acc: AccountStub, id: string): Promise<Response> {
  if (!accountBoot(user, env).admin) return fail(403, 'Nur für das Admin-Konto.');
  if (!env.FUNK) return fail(503, 'funk ist nicht verbunden.');
  const memo = await acc.getMemo(id);
  if (!memo) return fail(404, 'Memo nicht gefunden.');
  const draft = toFunk(memo.text);
  const files: { name: string; type: string; size: number; body: ReadableStream }[] = [];
  for (const f of draft.files.slice(0, 20)) {
    const obj = await env.IMAGES.get(memoFileKey(env, user.sub, f.file));
    if (!obj) continue;
    files.push({ name: f.name, type: obj.httpMetadata?.contentType || 'application/octet-stream', size: obj.size, body: obj.body });
  }
  if (!draft.text && !files.length) return fail(400, 'Nichts zu senden.');
  try {
    return json(await env.FUNK.publish({ text: draft.text, files }));
  } catch (err) {
    console.error('funk', err);
    return fail(502, (err as Error)?.message || 'funk hat nicht angenommen.');
  }
}

/**
 * Aus einem Memo ein md-Dokument machen und beide verknüpfen. Das Dokument
 * bekommt eine zufällige Adresse (Memos sind privat, ein Dokument liest jeder
 * mit Link), landet samt Schlüsseln in der Dokumentliste des Kontos, und die
 * Anhänge werden zu Bildern des Dokuments kopiert (/m/… → /i/…). Danach ist
 * das Dokument die Quelle; das Memo zeigt dessen Inhalt.
 */
async function memoToDoc(env: Env, user: User, acc: AccountStub, id: string, ctx: ExecutionContext): Promise<Response> {
  const memo = await acc.getMemo(id);
  if (!memo) return fail(404, 'Memo nicht gefunden.');
  if (memo.doc) {
    const info = await docStub(env, memo.doc).info();
    if (info.exists && !info.trashed) return json({ doc: memo.doc, url: `/${encodeURIComponent(memo.doc)}` });
  }
  const { success } = await env.CREATE_LIMIT.limit({ key: `u:${user.sub}` });
  if (!success) return fail(429, 'Zu viele neue Dokumente. Bitte kurz warten.');

  let docId = '', stub: ReturnType<typeof docStub> | null = null, editKey: string | null = null;
  for (let i = 0; i < 5 && !editKey; i++) {
    docId = randomId();
    stub = docStub(env, docId);
    editKey = await stub.create(docId, memo.text);
  }
  if (!stub || !editKey) return fail(500, 'Dokument konnte nicht angelegt werden.');

  // Anhänge mitnehmen: im Dokument müssen sie für alle mit Link lesbar sein.
  let text = memo.text;
  const files = [...new Set([...memo.text.matchAll(/\/m\/([\w-]{6,40}\.[a-z0-9]{1,8})/g)].map(m => m[1]))];
  for (const file of files) {
    const obj = await env.IMAGES.get(memoFileKey(env, user.sub, file));
    if (!obj) continue;
    const prefix = await stub.reserveImage(obj.size);
    if (!prefix) break; // Bilderspeicher des Dokuments voll: Rest bleibt verlinkt (dann nur für dich sichtbar)
    await env.IMAGES.put(`${prefix}/${file}`, obj.body, { httpMetadata: obj.httpMetadata });
    text = text.split(`/m/${file}`).join(`/i/${encodeURIComponent(prefix)}/${file}`);
  }
  if (text !== memo.text) await stub.replace(text);

  const ownerKey = await stub.ownerKey();
  await acc.upsert([{ id: docId, editKey, ownerKey, opened: Date.now(), title: titleOf(text) }]);
  await acc.setMemoDoc(id, docId);
  // Memo-Text auf den Stand des Dokuments; nicht mehr gebrauchte Memo-Anhänge weg.
  const { orphans } = await acc.editMemo(id, text);
  ctx.waitUntil(deleteMemoFiles(env, user.sub, orphans));
  return json({ doc: docId, url: `/${encodeURIComponent(docId)}`, editKey, ownerKey }, 201);
}
