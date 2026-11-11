// md.veerka.mp – Markdown-Dokumente ohne Login.
//
// Adressen:
//   /                    neues Dokument mit zufälliger ID (Weiterleitung)
//   /<id>                Dokument ansehen; gibt es das noch nicht, öffnet
//                        sich der Editor und legt es beim ersten Tippen an
//   /<id>.md             reines Markdown (für Agenten, ?download=1 zum Speichern)
//   /admin               Übersicht aller Dokumente (2FA-Code)
//   /i/<id>/<datei>      Bilder aus R2
//
// API (JSON):
//   POST   /api/docs                 Agent legt Dokument an (Bearer API_KEY)
//   GET    /api/docs/<id>            Dokument als JSON
//   PUT    /api/docs/<id>            Inhalt ersetzen (Bearer API_KEY/Admin oder X-Edit-Key)
//   DELETE /api/docs/<id>            löschen (Bearer API_KEY/Admin)
//   POST   /api/docs/<id>/create     Browser legt Dokument an (Turnstile)
//   POST   /api/docs/<id>/images     Bild hochladen (X-Edit-Key)
//   POST   /api/docs/<id>/pin        behalten ja/nein (Admin)
//   POST   /api/docs/<id>/rename     neue Adresse (X-Edit-Key); die alte leitet weiter
//   GET    /api/docs/<id>/title?url= Titel bzw. Bild für eingefügte Links (X-Edit-Key)
//   GET    /api/docs/<id>/ws         WebSocket fürs gemeinsame Bearbeiten
//   POST   /api/unlock               2FA-Code → Bearbeitungsschlüssel für ein Dokument,
//                                    oder (ohne Dokument) Admin-Token für /admin
//   GET    /api/admin/docs           Übersicht (Admin)

import manifest from '../generated/manifest.json';
import { render, escapeHtml } from '../shared/render';
import { randomId, randomToken, signToken, verifyTotp, verifyToken, timingSafeEqual } from './crypto';
import { MAX_CHARS } from './doc';
import { docStub, registry, type Env } from './env';

export { Doc } from './doc';
export { Registry } from './registry';

const ADMIN_TTL = 12 * 3600;
const MAX_IMAGE = 6 * 1024 * 1024;
const RESERVED = new Set(['api', 'admin', 'i', 'assets', 'fonts', 'new', 'robots.txt', 'favicon.svg', 'favicon.ico']);
const IMAGE_TYPES: Record<string, string> = { 'image/webp': 'webp', 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/avif': 'avif' };

// ── Hilfen ──────────────────────────────────────────────────────────────────

const json = (data: unknown, status = 200, headers: HeadersInit = {}) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers } });
const fail = (status: number, error: string) => json({ error }, status);
const ip = (req: Request) => req.headers.get('cf-connecting-ip') || 'local';

/**
 * Normalisiert eine Dokument-ID aus der URL: klein, Leerzeichen → Bindestrich.
 * Erlaubt Buchstaben (auch Umlaute), Ziffern, - und _.
 */
export function normalizeId(raw: string): string | null {
  let s: string;
  try { s = decodeURIComponent(raw); } catch { return null; }
  s = s.normalize('NFC').trim().toLowerCase().replace(/\s+/g, '-');
  if (!/^[\p{L}\p{N}][\p{L}\p{N}_-]{0,79}$/u.test(s)) return null;
  if (RESERVED.has(s)) return null;
  return s;
}

/** Admin: Bearer-Token aus der 2FA-Freischaltung oder der API-Schlüssel. */
async function isAdmin(req: Request, env: Env): Promise<boolean> {
  const auth = req.headers.get('authorization') || '';
  const token = auth.replace(/^Bearer\s+/i, '');
  if (!token) return false;
  if (env.API_KEY && timingSafeEqual(token, env.API_KEY)) return true;
  return verifyToken(env.SESSION_SECRET, token);
}

async function canEdit(req: Request, env: Env, id: string): Promise<boolean> {
  if (await isAdmin(req, env)) return true;
  return docStub(env, id).checkKey(req.headers.get('x-edit-key'));
}

async function turnstileOk(env: Env, token: unknown, remoteip: string): Promise<boolean> {
  if (!env.TURNSTILE_SECRET) return true;
  if (typeof token !== 'string' || !token) return false;
  const body = new FormData();
  body.append('secret', env.TURNSTILE_SECRET);
  body.append('response', token);
  body.append('remoteip', remoteip);
  const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body });
  const data = await res.json<{ success: boolean }>();
  return !!data.success;
}

const origin = (req: Request) => new URL(req.url).origin;
const docUrl = (req: Request, id: string) => `${origin(req)}/${encodeURIComponent(id)}`;

// ── Seiten ──────────────────────────────────────────────────────────────────

const CSP = [
  "default-src 'self'",
  "script-src 'self' https://challenges.cloudflare.com",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' https: data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  'frame-src https://www.youtube-nocookie.com https://player.vimeo.com https://challenges.cloudflare.com',
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
].join('; ');

interface Boot {
  page: 'doc' | 'admin';
  id?: string;
  exists?: boolean;
  siteKey?: string;
  katexCss?: string;
}

function page(title: string, body: string, boot: Boot, status = 200): Response {
  const html = `<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex, nofollow">
<meta name="color-scheme" content="light dark">
<meta name="theme-color" content="#ffffff" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#1b1b1b" media="(prefers-color-scheme: dark)">
<title>${escapeHtml(title)}</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="preload" href="/fonts/iAWriterQuattroS-Regular.woff2" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="${manifest.css}">
<script type="module" src="${manifest.js}"></script>
</head>
<body>
<script id="boot" type="application/json">${JSON.stringify({ ...boot, katexCss: manifest.katexCss }).replace(/</g, '\\u003c')}</script>
${body}
</body>
</html>`;
  return new Response(html, {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'content-security-policy': CSP,
      'x-robots-tag': 'noindex, nofollow',
      'referrer-policy': 'strict-origin-when-cross-origin',
      'x-content-type-options': 'nosniff',
    },
  });
}

async function docPage(req: Request, env: Env, id: string): Promise<Response> {
  const info = await docStub(env, id).info(true);
  if (info.movedTo) return moved(info.movedTo, '');
  const wantsMarkdown = /text\/markdown/.test(req.headers.get('accept') || '') && !/text\/html/.test(req.headers.get('accept') || '');
  if (wantsMarkdown) return rawMarkdown(info, id, false);

  if (!info.exists) {
    return page('Neues Dokument', `<main id="app"></main>`, { page: 'doc', id, exists: false, siteKey: env.TURNSTILE_SITEKEY }, 200);
  }
  const { html } = render(info.markdown);
  const title = info.title || id;
  return page(title, `<main id="app"><article class="doc" id="view">${html}</article></main>`, { page: 'doc', id, exists: true });
}

function rawMarkdown(info: { exists: boolean; markdown: string }, id: string, download: boolean): Response {
  if (!info.exists) return new Response('Dokument nicht gefunden.\n', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } });
  const headers: Record<string, string> = {
    'content-type': 'text/markdown; charset=utf-8',
    'cache-control': 'no-store',
    'x-robots-tag': 'noindex, nofollow',
    'x-content-type-options': 'nosniff',
  };
  if (download) headers['content-disposition'] = `attachment; filename*=UTF-8''${encodeURIComponent(id)}.md`;
  return new Response(info.markdown, { headers });
}

// ── API ─────────────────────────────────────────────────────────────────────

async function api(req: Request, env: Env, url: URL, ctx: ExecutionContext): Promise<Response> {
  const parts = url.pathname.split('/').filter(Boolean).slice(1); // ohne "api"
  const method = req.method;

  if (parts[0] === 'unlock' && method === 'POST') return unlock(req, env);

  if (parts[0] === 'admin' && parts[1] === 'docs' && method === 'GET') {
    if (!(await isAdmin(req, env))) return fail(401, 'Nicht freigeschaltet.');
    return json(await registry(env).list(url.searchParams.get('q') || ''));
  }

  if (parts[0] !== 'docs') return fail(404, 'Unbekannt.');

  // POST /api/docs – Agent legt ein Dokument an.
  if (parts.length === 1 && method === 'POST') {
    if (!(await isAdmin(req, env))) return fail(401, 'API-Schlüssel fehlt oder ist falsch.');
    const { markdown, id: wanted } = await readMarkdownBody(req);
    const id = wanted ? normalizeId(wanted) : randomId();
    if (!id) return fail(400, 'Ungültige ID. Erlaubt: Buchstaben, Ziffern, - und _ (max. 80).');
    const editKey = await docStub(env, id).create(id, markdown);
    if (!editKey) return fail(409, 'Diese ID ist schon vergeben.');
    return json({ id, url: docUrl(req, id), editUrl: `${docUrl(req, id)}#edit=${editKey}`, raw: `${docUrl(req, id)}.md` }, 201);
  }

  const id = parts[1] ? normalizeId(parts[1]) : null;
  if (!id) return fail(400, 'Ungültige ID.');
  const stub = docStub(env, id);
  const action = parts[2];

  if (!action) {
    if (method === 'GET') {
      const info = await stub.info(true);
      if (info.movedTo) return Response.redirect(`${origin(req)}/api/docs/${encodeURIComponent(info.movedTo)}`, 301);
      if (!info.exists) return fail(404, 'Dokument nicht gefunden.');
      return json({ id, title: info.title, markdown: info.markdown, updated: info.updated, url: docUrl(req, id) });
    }
    if (method === 'PUT') {
      if (!(await canEdit(req, env, id))) return fail(401, 'Keine Berechtigung.');
      const { markdown } = await readMarkdownBody(req);
      if (markdown.length > MAX_CHARS) return fail(413, 'Text zu lang.');
      if (!(await stub.replace(markdown))) return fail(404, 'Dokument nicht gefunden.');
      return json({ id, url: docUrl(req, id) });
    }
    if (method === 'DELETE') {
      if (!(await isAdmin(req, env))) return fail(401, 'Nicht freigeschaltet.');
      await stub.destroy();
      return json({ ok: true });
    }
  }

  if (action === 'create' && method === 'POST') {
    const admin = await isAdmin(req, env);
    if (!admin) {
      const { success } = await env.CREATE_LIMIT.limit({ key: ip(req) });
      if (!success) return fail(429, 'Zu viele neue Dokumente. Bitte kurz warten.');
      const body = await req.json<{ token?: string }>().catch(() => ({} as { token?: string }));
      if (!(await turnstileOk(env, body.token, ip(req)))) return fail(403, 'Spam-Schutz nicht bestanden. Bitte Seite neu laden.');
    }
    const editKey = await stub.create(id);
    if (!editKey) return fail(409, 'Dieses Dokument wurde gerade von jemand anderem angelegt.');
    return json({ editKey }, 201);
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
    const body = await req.json<{ to?: string }>().catch(() => ({} as { to?: string }));
    const to = body.to ? normalizeId(body.to) : null;
    if (!to) return fail(400, 'Ungültige Adresse. Erlaubt: Buchstaben, Ziffern, - und _ (max. 80).');
    if (to === id) return json({ id });
    const data = await stub.moveData();
    if (!data) return fail(404, 'Dokument nicht gefunden.');
    if (!(await docStub(env, to).create(to, '', data))) return fail(409, 'Diese Adresse ist schon vergeben.');
    await stub.moveTo(to);
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
    const body = await req.json<{ pinned?: boolean }>().catch(() => ({} as { pinned?: boolean }));
    await stub.setPinned(!!body.pinned);
    return json({ ok: true });
  }

  return fail(404, 'Unbekannt.');
}

/**
 * Vorschau für eingefügte Links: Seitentitel (og:title, sonst <title>).
 * Ist die Adresse selbst ein Bild, oder ein geteiltes Google-Fotos-Bild,
 * kommt zusätzlich `image` zurück – der Editor macht dann ![](bild) daraus.
 * Nur http(s), keine IP-Adressen, höchstens 4 Sekunden und 256 KB.
 */
async function linkPreview(raw: string): Promise<{ title: string; image?: string }> {
  const none = { title: '' };
  let target: URL;
  try { target = new URL(raw); } catch { return none; }
  if (!/^https?:$/.test(target.protocol)) return none;
  if (/^[\d.]+$|^\[|^localhost$/i.test(target.hostname) || !target.hostname.includes('.')) return none;
  try {
    const res = await fetch(target.toString(), {
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; md-link-preview)', accept: 'text/html,image/*;q=0.9', 'accept-language': 'de,en;q=0.8' },
      redirect: 'follow',
      signal: AbortSignal.timeout(4000),
    });
    const type = res.headers.get('content-type') || '';
    if (res.ok && type.startsWith('image/')) {
      res.body?.cancel().catch(() => {});
      return { title: '', image: target.toString() };
    }
    if (!res.ok || !type.includes('html') || !res.body) return none;
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let html = '';
    while (html.length < 256 * 1024) {
      const { done, value } = await reader.read();
      if (done) break;
      html += dec.decode(value, { stream: true });
      if (/<body/i.test(html)) break;
    }
    reader.cancel().catch(() => {});
    const meta = (prop: string) =>
      (new RegExp(`<meta[^>]+property=["']${prop}["'][^>]*content=["']([^"']*)["']`, 'i').exec(html)
        || new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*property=["']${prop}["']`, 'i').exec(html))?.[1] || '';
    const t = meta('og:title') || /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] || '';
    const title = decodeEntities(t).replace(/\s+/g, ' ').trim().slice(0, 140);

    // Google Fotos: geteilte Links (photos.app.goo.gl → photos.google.com/share/…)
    // zeigen das Bild als og:image auf lh3.googleusercontent.com. Die Größe
    // steht am Ende (=w600-h315-…); für scharfe Bilder auf 2400 px stellen.
    const finalHost = new URL(res.url || target.toString()).hostname;
    if (/(^|\.)photos\.(app\.goo\.gl|google\.com)$/.test(finalHost) || /(^|\.)photos\.app\.goo\.gl$/.test(target.hostname)) {
      const img = decodeEntities(meta('og:image'));
      if (/^https:\/\/lh\d\.googleusercontent\.com\//.test(img)) {
        return { title: title.replace(/ ?[-–·] ?Google (Fotos|Photos)$/i, ''), image: img.replace(/=[^/=]*$/, '') + '=w2400' };
      }
    }
    return { title };
  } catch {
    return none;
  }
}

function decodeEntities(s: string): string {
  const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', auml: 'ä', ouml: 'ö', uuml: 'ü', Auml: 'Ä', Ouml: 'Ö', Uuml: 'Ü', szlig: 'ß' };
  return s.replace(/&(#x[\da-f]+|#\d+|\w+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const n = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
    }
    return named[e] ?? m;
  });
}

async function readMarkdownBody(req: Request): Promise<{ markdown: string; id?: string }> {
  const type = req.headers.get('content-type') || '';
  if (type.includes('application/json')) {
    const body = await req.json<{ markdown?: string; content?: string; id?: string }>().catch(() => ({} as Record<string, string>));
    return { markdown: String(body.markdown ?? body.content ?? ''), id: body.id };
  }
  return { markdown: await req.text(), id: new URL(req.url).searchParams.get('id') || undefined };
}

async function unlock(req: Request, env: Env): Promise<Response> {
  if (!env.TOTP_SECRET || !env.SESSION_SECRET) return fail(503, '2FA ist auf dem Server nicht eingerichtet.');
  const reg = registry(env);
  const who = ip(req);
  if (!(await reg.unlockAllowed(who))) return fail(429, 'Zu viele Fehlversuche. Bitte in einer Stunde erneut probieren.');
  const body = await req.json<{ code?: string; doc?: string }>().catch(() => ({} as { code?: string; doc?: string }));
  const match = await verifyTotp(env.TOTP_SECRET, body.code);
  if (!match) {
    await reg.recordFail(who);
    return fail(401, 'Code stimmt nicht.');
  }
  if (!(await reg.useCode(match.counter))) return fail(401, 'Dieser Code wurde schon benutzt. Bitte den nächsten abwarten.');

  // Mit Dokument: nur dieses eine Dokument freischalten, kein Admin-Zugang.
  const id = body.doc ? normalizeId(body.doc) : null;
  if (id) {
    const editKey = await docStub(env, id).getEditKey();
    if (!editKey) return fail(404, 'Dokument nicht gefunden.');
    return json({ editKey });
  }
  const token = await signToken(env.SESSION_SECRET, ADMIN_TTL);
  return json({ token, expiresIn: ADMIN_TTL });
}

// ── Einstieg ────────────────────────────────────────────────────────────────

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;

    if (path.startsWith('/assets/') || path.startsWith('/fonts/') || path === '/favicon.svg') {
      return env.ASSETS.fetch(req);
    }
    if (path === '/robots.txt') {
      // Keine Sperre: KI-Assistenten, die ein Nutzer einen Link lesen lässt
      // (Claude-User, ChatGPT-User …), halten sich an robots.txt. Aus
      // Suchmaschinen hält die Seiten der Header X-Robots-Tag: noindex fern.
      // Trainings-Crawler sperrt Cloudflare (verwaltete robots.txt davor).
      return new Response('# Dokumente sind per noindex von Suchmaschinen ausgenommen.\n', { headers: { 'content-type': 'text/plain' } });
    }
    if (path.startsWith('/api/')) {
      try {
        return await api(req, env, url, ctx);
      } catch (err) {
        console.error(err);
        return fail(500, 'Interner Fehler.');
      }
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return fail(405, 'Methode nicht erlaubt.');

    if (path === '/') {
      return new Response(null, { status: 302, headers: { location: `/${randomId()}`, 'cache-control': 'no-store' } });
    }
    if (path === '/admin') {
      return page('Übersicht', '<main id="app"></main>', { page: 'admin' });
    }
    if (path.startsWith('/i/')) {
      const [, , doc, file] = path.split('/');
      const id = doc ? normalizeId(doc) : null;
      if (!id || !file || !/^[\w-]+\.\w+$/.test(file)) return new Response('Nicht gefunden', { status: 404 });
      const obj = await env.IMAGES.get(`${id}/${file}`);
      if (!obj) return new Response('Nicht gefunden', { status: 404 });
      const headers = new Headers();
      obj.writeHttpMetadata(headers);
      headers.set('etag', obj.httpEtag);
      headers.set('x-content-type-options', 'nosniff');
      return new Response(obj.body, { headers });
    }

    // /<id>.md → reines Markdown
    const mdMatch = /^\/([^/]+)\.md$/.exec(path);
    if (mdMatch) {
      const id = normalizeId(mdMatch[1]);
      if (!id) return new Response('Nicht gefunden', { status: 404 });
      const info = await docStub(env, id).info(true);
      if (info.movedTo) return moved(info.movedTo, '.md' + url.search);
      return rawMarkdown(info, id, url.searchParams.has('download'));
    }

    const seg = path.slice(1).replace(/\/+$/, '');
    if (seg.includes('/')) return new Response('Nicht gefunden', { status: 404 });
    const id = normalizeId(seg);
    if (!id) return new Response('Ungültige Adresse', { status: 404 });
    // Kanonische Schreibweise erzwingen (Großbuchstaben, Leerzeichen …).
    if (encodeURIComponent(id) !== seg && decodeURIComponentSafe(seg) !== id) {
      return new Response(null, { status: 301, headers: { location: `/${encodeURIComponent(id)}${url.search}` } });
    }
    return docPage(req, env, id);
  },
} satisfies ExportedHandler<Env>;

function moved(to: string, suffix: string): Response {
  return new Response(null, { status: 301, headers: { location: `/${encodeURIComponent(to)}${suffix}`, 'cache-control': 'no-store' } });
}

function decodeURIComponentSafe(s: string) {
  try { return decodeURIComponent(s); } catch { return s; }
}
