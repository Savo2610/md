// JSON-API unter /api/… (Übersicht der Routen in index.ts).

import { randomId, randomToken, signToken, verifyTotp } from './crypto';
import { MAX_CHARS, docKind } from './doc';
import { packUmzug } from './packliste';
import { accountStub, docStub, registry, type Env } from './env';
import { AGENT_PER_IP } from './registry';
import { clearSessionCookie, currentUser } from './auth';
import type { AccountDoc } from './account';
import { canEdit, isAdmin, isAdminUser, isOwner, normalizeId, turnstileOk } from './access';
import { fail, ip, json, origin, readJson, sameOrigin } from './http';
import { fxRates } from './fx';
import { linkPreview } from './link-preview';
import { deleteAllMemoFiles, memosApi, queueAdminMemos } from './memos';
import { accountBoot } from './pages';

const ADMIN_TTL = 12 * 3600;
const MAX_IMAGE = 6 * 1024 * 1024;
const IMAGE_TYPES: Record<string, string> = { 'image/webp': 'webp', 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/avif': 'avif' };
/** Höchstlänge für Dokumente von Agenten ohne API-Schlüssel. */
export const MAX_AGENT_CHARS = 200_000;
const BAD_ID = 'Ungültige Adresse. Erlaubt: Buchstaben, Ziffern, - und _ (max. 80).';

const docUrl = (req: Request, id: string) => `${origin(req)}/${encodeURIComponent(id)}`;

export async function api(req: Request, env: Env, url: URL, ctx: ExecutionContext): Promise<Response> {
  const parts = url.pathname.split('/').filter(Boolean).slice(1); // ohne "api"
  const method = req.method;

  if (parts[0] === 'unlock' && method === 'POST') return unlock(req, env);
  if (parts[0] === 'fx' && method === 'GET') {
    const rates = await fxRates();
    if (!rates) return fail(503, 'Keine Kurse.');
    return json({ rates }, 200, { 'cache-control': 'public, max-age=3600' });
  }
  if (parts[0] === 'me') return me(req, env, parts.slice(1), ctx);
  if (parts[0] === 'pack' && parts[1] === 'umzug' && !parts[2]) return packUmzug(req, env);
  if (parts[0] === 'admin') {
    if (!(await isAdmin(req, env))) return fail(401, 'Nicht freigeschaltet.');
    if (parts[1] === 'docs' && method === 'GET') return json(await registry(env).list(url.searchParams.get('q') || ''));
    if (parts[1] === 'memos' && method === 'POST') return queueAdminMemos(req, env);
    return fail(404, 'Unbekannt.');
  }
  if (parts[0] === 'docs') return docs(req, env, url, parts.slice(1));
  return fail(404, 'Unbekannt.');
}

// ── Dokumente: /api/docs/… ──────────────────────────────────────────────────

async function docs(req: Request, env: Env, url: URL, parts: string[]): Promise<Response> {
  const method = req.method;

  // POST /api/docs – Agent legt ein Dokument an. Mit API-Schlüssel ohne
  // Grenzen und mit Wunsch-Adresse; ohne (fremde Agenten, Anleitung in
  // /llms.txt) nur zufällige Adressen, kürzere Texte und ein Tageskontingent.
  if (!parts.length && method === 'POST') {
    const keyed = await isAdmin(req, env);
    if (!keyed && req.headers.get('authorization')) return fail(401, 'API key is wrong. Leave out the Authorization header to publish without a key.');
    const { markdown, id: wanted } = await readMarkdownBody(req);
    if (!keyed) {
      if (wanted) return fail(403, 'A custom id needs an API key. Leave out "id" to get a random address.');
      if (!markdown.trim()) return fail(400, 'Empty document. Send the Markdown as the request body.');
      if (markdown.length > MAX_AGENT_CHARS) return fail(413, `Too long: at most ${MAX_AGENT_CHARS} characters without an API key.`);
      const { success } = await env.CREATE_LIMIT.limit({ key: `agent:${ip(req)}` });
      if (!success || !(await registry(env).agentCreate(ip(req)))) return fail(429, `Daily limit reached (${AGENT_PER_IP} documents per day). Try again tomorrow.`);
    }
    if (markdown.length > MAX_CHARS) return fail(413, 'Text zu lang.');
    const id = wanted ? normalizeId(wanted) : randomId();
    if (!id) return fail(400, BAD_ID);
    const editKey = await docStub(env, id).create(id, markdown, undefined, 'md', undefined, !keyed);
    if (!editKey) return fail(409, 'Diese ID ist schon vergeben.');
    return json({ id, url: docUrl(req, id), editUrl: `${docUrl(req, id)}#edit=${editKey}`, raw: `${docUrl(req, id)}.md`, editKey }, 201);
  }

  const id = parts[0] ? normalizeId(parts[0]) : null;
  if (!id) return fail(400, 'Ungültige ID.');
  const stub = docStub(env, id);
  const action = parts[1];

  if (!action && method === 'GET') {
    const info = await stub.info(true);
    if (info.movedTo) return Response.redirect(`${origin(req)}/api/docs/${encodeURIComponent(info.movedTo)}`, 301);
    if (!info.exists) return fail(404, 'Dokument nicht gefunden.');
    if (info.trashed) {
      if (!(await isOwner(req, env, id))) return fail(410, 'Dokument wurde gelöscht.');
      const p = await stub.peek();
      return json({ id, title: p?.title || '', markdown: p?.markdown || '', trashed: info.trashed, url: docUrl(req, id) });
    }
    return json({ id, title: info.title, markdown: info.markdown, updated: info.updated, url: docUrl(req, id) });
  }

  if (!action && method === 'PUT') {
    if (!(await canEdit(req, env, id))) return fail(401, 'Keine Berechtigung.');
    const { markdown } = await readMarkdownBody(req);
    if (markdown.length > MAX_CHARS) return fail(413, 'Text zu lang.');
    const kind = (await stub.info()).kind;
    if (kind && kind !== 'md') return fail(409, kind === 'pack' ? 'Packlisten lassen sich nicht als Markdown ersetzen.' : 'Boards lassen sich nicht als Markdown ersetzen.');
    if (!(await stub.replace(markdown))) return fail(404, 'Dokument nicht gefunden.');
    return json({ id, url: docUrl(req, id) });
  }

  if (!action && method === 'DELETE') {
    // Admin jederzeit; der Ersteller nur, was schon im Papierkorb liegt.
    if (!(await isAdmin(req, env))) {
      if (!(await stub.checkOwner(req.headers.get('x-owner-key')))) return fail(401, 'Nicht freigeschaltet.');
      if (!(await stub.info()).trashed) return fail(409, 'Erst in den Papierkorb legen.');
    }
    await stub.destroy();
    const user = await currentUser(req, env);
    if (user) await accountStub(env, user.sub).remove(id);
    return json({ ok: true });
  }

  if (action === 'create' && method === 'POST') {
    const [admin, user, body] = await Promise.all([isAdmin(req, env), currentUser(req, env), readJson<{ token: string; kind: string }>(req)]);
    if (!admin) {
      const { success } = await env.CREATE_LIMIT.limit({ key: user ? `u:${user.sub}` : ip(req) });
      if (!success) return fail(429, 'Zu viele neue Dokumente. Bitte kurz warten.');
      // Angemeldet braucht es keinen Spam-Schutz.
      if (!user && !(await turnstileOk(env, body.token, ip(req)))) return fail(403, 'Spam-Schutz nicht bestanden. Bitte Seite neu laden.');
    }
    const kind = docKind(body.kind);
    const editKey = await stub.create(id, '', undefined, kind);
    if (!editKey) return fail(409, 'Dieses Dokument wurde gerade von jemand anderem angelegt.');
    const ownerKey = await stub.ownerKey();
    if (user) await accountStub(env, user.sub).upsert([{ id, editKey, ownerKey, opened: Date.now(), kind: kind === 'md' ? '' : kind }]);
    return json({ editKey, ownerKey }, 201);
  }

  if ((action === 'trash' || action === 'restore') && method === 'POST') {
    if (!(await isOwner(req, env, id))) return fail(401, 'Nur wer das Dokument angelegt hat, kann es löschen.');
    const user = await currentUser(req, env);
    if (action === 'trash') {
      const at = await stub.trash();
      if (!at) return fail(404, 'Dokument nicht gefunden.');
      if (user) await accountStub(env, user.sub).setTrashed(id, at);
      return json({ trashed: at });
    }
    if (!(await stub.restore())) return fail(404, 'Nicht im Papierkorb.');
    if (user) await accountStub(env, user.sub).setTrashed(id, 0);
    return json({ ok: true });
  }

  if (action === 'ws') {
    if (req.headers.get('upgrade') !== 'websocket') return fail(426, 'WebSocket erwartet.');
    const headers = new Headers({ Upgrade: 'websocket' });
    const key = url.searchParams.get('key');
    if (key) headers.set('X-Md-Key', key);
    return stub.fetch(new Request('https://doc/ws', { headers }));
  }

  if (action === 'images' && method === 'POST') {
    if (!(await canEdit(req, env, id))) return fail(401, 'Keine Berechtigung.');
    const { success } = await env.UPLOAD_LIMIT.limit({ key: ip(req) });
    if (!success) return fail(429, 'Zu viele Bilder auf einmal. Bitte kurz warten.');
    const type = (req.headers.get('content-type') || '').split(';')[0].trim();
    const ext = IMAGE_TYPES[type];
    if (!ext) return fail(415, 'Nur JPEG, PNG, WebP, GIF oder AVIF.');
    if (Number(req.headers.get('content-length')) > MAX_IMAGE) return fail(413, 'Bild zu groß (max. 6 MB).');
    const data = await req.arrayBuffer();
    if (data.byteLength > MAX_IMAGE) return fail(413, 'Bild zu groß (max. 6 MB).');
    const prefix = await stub.reserveImage(data.byteLength);
    if (!prefix) return fail(507, 'Speicher für Bilder in diesem Dokument ist voll (25 MB).');
    const file = `${randomToken(9)}.${ext}`;
    await env.IMAGES.put(`${prefix}/${file}`, data, { httpMetadata: { contentType: type, cacheControl: 'public, max-age=31536000, immutable' } });
    return json({ url: `/i/${encodeURIComponent(prefix)}/${file}` }, 201);
  }

  if (action === 'rename' && method === 'POST') {
    if (!(await canEdit(req, env, id))) return fail(401, 'Keine Berechtigung.');
    const body = await readJson<{ to: string }>(req);
    const to = typeof body.to === 'string' ? normalizeId(body.to) : null;
    if (!to) return fail(400, BAD_ID);
    if (to === id) return json({ id });
    const data = await stub.moveData();
    if (!data) return fail(404, 'Dokument nicht gefunden.');
    if (!(await docStub(env, to).create(to, '', data))) return fail(409, 'Diese Adresse ist schon vergeben.');
    await stub.moveTo(to);
    const user = await currentUser(req, env);
    if (user) await accountStub(env, user.sub).rename(id, to);
    return json({ id: to, url: docUrl(req, to) });
  }

  if (action === 'title' && method === 'GET') {
    if (!(await canEdit(req, env, id))) return fail(401, 'Keine Berechtigung.');
    const { success } = await env.UPLOAD_LIMIT.limit({ key: ip(req) });
    if (!success) return fail(429, 'Zu viele Anfragen.');
    return json(await linkPreview(url.searchParams.get('url') || ''));
  }

  if (action === 'pin' && method === 'POST') {
    if (!(await isAdmin(req, env))) return fail(401, 'Nicht freigeschaltet.');
    const body = await readJson<{ pinned: boolean }>(req);
    await stub.setPinned(!!body.pinned);
    return json({ ok: true });
  }

  return fail(404, 'Unbekannt.');
}

async function readMarkdownBody(req: Request): Promise<{ markdown: string; id?: string }> {
  if ((req.headers.get('content-type') || '').includes('application/json')) {
    const body = await readJson<{ markdown: string; content: string; id: string }>(req);
    return { markdown: String(body.markdown ?? body.content ?? ''), id: typeof body.id === 'string' ? body.id : undefined };
  }
  return { markdown: await req.text(), id: new URL(req.url).searchParams.get('id') || undefined };
}

// ── Konto: /api/me/… ────────────────────────────────────────────────────────

async function me(req: Request, env: Env, parts: string[], ctx: ExecutionContext): Promise<Response> {
  const user = await currentUser(req, env);
  if (!user) return fail(401, 'Nicht angemeldet.');
  if (!sameOrigin(req)) return fail(403, 'Fremde Herkunft.');
  const acc = accountStub(env, user.sub);

  if (!parts.length) {
    if (req.method === 'GET') return json({ user: accountBoot(user, env).user, docs: await acc.list() });
    if (req.method === 'DELETE') {
      await acc.destroy();
      await deleteAllMemoFiles(env, user.sub);
      return json({ ok: true }, 200, { 'set-cookie': clearSessionCookie(req) });
    }
  }
  if (parts[0] === 'memos') return memosApi(req, env, user, parts.slice(1), ctx);
  if (parts[0] !== 'docs') return fail(404, 'Unbekannt.');

  if (parts.length === 1 && req.method === 'POST') {
    const { items } = await readJson<{ items: Partial<AccountDoc>[] }>(req);
    if (!Array.isArray(items)) return fail(400, 'items fehlt.');
    const clean = items.map(it => ({ ...it, id: typeof it?.id === 'string' ? normalizeId(it.id) || '' : '' })).filter(it => it.id);
    return json({ docs: await acc.upsert(clean) });
  }

  const id = parts[1] ? normalizeId(parts[1]) : null;
  if (!id) return fail(400, 'Ungültige ID.');
  if (parts.length === 2 && req.method === 'DELETE') {
    await acc.remove(id);
    return json({ ok: true });
  }
  if (parts[2] === 'tags' && req.method === 'PUT') {
    const { tags } = await readJson<{ tags: string[] }>(req);
    const doc = await acc.setTags(id, tags);
    if (!doc) return fail(404, 'Nicht in deiner Liste.');
    return json(doc);
  }
  return fail(404, 'Unbekannt.');
}

// ── Freischalten mit 2FA-Code ───────────────────────────────────────────────

/**
 * POST /api/unlock { code, doc? }: mit Dokument nur dessen Schlüssel, ohne
 * Dokument ein Admin-Token für /admin.
 */
async function unlock(req: Request, env: Env): Promise<Response> {
  const body = await readJson<{ code: string; doc: string }>(req);
  const doc = typeof body.doc === 'string' ? body.doc : '';
  // Angemeldet mit dem Admin-Google-Konto: ein Dokument ohne Code freischalten.
  if (doc && !body.code && isAdminUser(await currentUser(req, env), env)) {
    if (!sameOrigin(req)) return fail(403, 'Fremde Herkunft.');
    return unlockDoc(req, env, doc);
  }
  if (!env.TOTP_SECRET || !env.SESSION_SECRET) return fail(503, '2FA ist auf dem Server nicht eingerichtet.');
  const reg = registry(env);
  const who = ip(req);
  if (!(await reg.unlockAllowed(who))) return fail(429, 'Zu viele Fehlversuche. Bitte in einer Stunde erneut probieren.');
  const match = await verifyTotp(env.TOTP_SECRET, body.code);
  if (!match) {
    await reg.recordFail(who);
    return fail(401, 'Code stimmt nicht.');
  }
  if (!(await reg.useCode(match.counter))) return fail(401, 'Dieser Code wurde schon benutzt. Bitte den nächsten abwarten.');

  if (doc) return unlockDoc(req, env, doc);
  const token = await signToken(env.SESSION_SECRET, ADMIN_TTL);
  return json({ token, expiresIn: ADMIN_TTL });
}

/** Bearbeitungs- und Besitzer-Schlüssel eines Dokuments (nach geprüftem Code bzw. Admin). */
async function unlockDoc(req: Request, env: Env, raw: string): Promise<Response> {
  const id = normalizeId(raw);
  if (!id) return fail(400, 'Ungültige ID.');
  const stub = docStub(env, id);
  const editKey = await stub.getEditKey();
  if (!editKey) return fail(404, 'Dokument nicht gefunden.');
  // Wer freischalten darf, darf das Dokument auch löschen (gilt so auch für alte Dokumente).
  const ownerKey = await stub.ensureOwnerKey();
  const user = await currentUser(req, env);
  if (user) await accountStub(env, user.sub).upsert([{ id, editKey, ownerKey, opened: Date.now() }]);
  return json({ editKey, ownerKey });
}
