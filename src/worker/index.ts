// md.veerka.mp – Markdown-Dokumente ohne Login.
//
// Adressen:
//   /                    neues Dokument mit zufälliger ID (Weiterleitung)
//   /<id>                Dokument ansehen; gibt es das noch nicht, öffnet
//                        sich der Editor und legt es beim ersten Tippen an
//   /<id>.md             reines Markdown (für Agenten, ?download=1 zum Speichern)
//   /admin               Übersicht aller Dokumente (2FA-Code)
//   /memos               private Kurznotizen des Kontos (wie ein Chat mit sich selbst)
//   /i/<id>/<datei>      Bilder aus R2
//
// API (JSON):
//   POST   /api/docs                 Agent legt Dokument an (Bearer API_KEY)
//   GET    /api/docs/<id>            Dokument als JSON
//   PUT    /api/docs/<id>            Inhalt ersetzen (Bearer API_KEY/Admin oder X-Edit-Key)
//   DELETE /api/docs/<id>            endgültig löschen (Admin; Ersteller nur aus dem Papierkorb)
//   POST   /api/docs/<id>/trash      in den Papierkorb (X-Owner-Key oder Admin)
//   POST   /api/docs/<id>/restore    aus dem Papierkorb holen (X-Owner-Key oder Admin)
//   POST   /api/docs/<id>/create     Browser legt Dokument an (Turnstile)
//   POST   /api/docs/<id>/images     Bild hochladen (X-Edit-Key)
//   POST   /api/docs/<id>/pin        behalten ja/nein (Admin)
//   POST   /api/docs/<id>/rename     neue Adresse (X-Edit-Key); die alte leitet weiter
//   GET    /api/docs/<id>/title?url= Titel bzw. Bild für eingefügte Links (X-Edit-Key)
//   GET    /api/docs/<id>/ws         WebSocket fürs gemeinsame Bearbeiten
//   POST   /api/unlock               2FA-Code → Bearbeitungsschlüssel für ein Dokument,
//                                    oder (ohne Dokument) Admin-Token für /admin
//   GET    /api/admin/docs           Übersicht (Admin)
//   POST   /api/admin/memos          Memos fürs Admin-Konto vorbereiten ({ memos: [{ text, created }] }),
//                                    sie wandern beim nächsten Öffnen von /memos hinein
//
// Konto (optional, Google-Login, siehe auth.ts; Cookie md_session):
//   GET    /auth/login, /auth/callback, POST /auth/logout
//   GET    /api/me                   Konto und Dokumentliste
//   POST   /api/me/docs              Dokumente eintragen/aktualisieren ({ items })
//   PUT    /api/me/docs/<id>/tags    Tags setzen ({ tags })
//   DELETE /api/me/docs/<id>         aus der Liste nehmen (Dokument bleibt)
//   DELETE /api/me                   Konto samt Liste löschen
//   GET    /api/me/memos             Memos ({ memos })
//   POST   /api/me/memos             Memo anlegen ({ id, text, created? }, ID vom Browser)
//   PUT    /api/me/memos/<id>        Text ändern ({ text })
//   DELETE /api/me/memos/<id>        Memo löschen (samt Anhängen, die sonst nirgends vorkommen)
//   POST   /api/me/memos/files       Anhang hochladen (Rohdaten, Name in X-File-Name), liefert { url: /m/<datei> }
//   POST   /api/me/memos/geo         Ortsname zu Koordinaten ({ lat, lon }, OpenStreetMap Nominatim)
//
// Memos sind pro Konto privat: Es gibt keinen Zugriff darauf über Admin,
// API-Schlüssel oder die Übersicht. Inhalte und Koordinaten stehen nie in
// Adressen (die landen in den Logs).
//   GET    /m/<datei>                Anhang, nur fürs eigene Konto
//
// memos.veerka.mp leitet auf /memos um (früher eine eigene Memos-Instanz).

import manifest from '../generated/manifest.json';
import { render, escapeHtml } from '../shared/render';
import { randomId, randomToken, signToken, verifyTotp, verifyToken, timingSafeEqual } from './crypto';
import { MAX_CHARS } from './doc';
import { accountStub, docStub, registry, type Env } from './env';
import { auth, clearSessionCookie, currentUser, type User } from './auth';
import { FILE_NAME, MAX_FILE, MAX_MEMO, MEMO_ID, type AccountDoc, type Memo } from './account';

export { Doc } from './doc';
export { Registry } from './registry';
export { Account } from './account';

const ADMIN_TTL = 12 * 3600;
const MAX_IMAGE = 6 * 1024 * 1024;
const RESERVED = new Set(['api', 'auth', 'admin', 'home', 'memos', 'datenschutz', 'i', 'assets', 'fonts', 'icons', 'new', 'robots.txt', 'favicon.svg', 'favicon.ico', 'sw.js', 'manifest.webmanifest', 'apple-touch-icon.png']);
/** Statische Dateien, die direkt aus public/ kommen. */
const STATIC_FILES = new Set(['/favicon.svg', '/sw.js', '/manifest.webmanifest', '/memos.webmanifest', '/apple-touch-icon.png', '/memos-touch-icon.png']);
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

/** Angemeldetes Google-Konto mit der E-Mail aus ADMIN_EMAIL (Secret). */
function isAdminUser(user: User | null, env: Env): boolean {
  return !!user?.email && !!env.ADMIN_EMAIL && user.email.toLowerCase() === env.ADMIN_EMAIL.trim().toLowerCase();
}

/**
 * Admin: Bearer-Token aus der 2FA-Freischaltung, der API-Schlüssel oder das
 * Admin-Google-Konto (Cookie). Beim Cookie zusätzlich: Änderungen nur von
 * dieser Seite aus (SameSite=Lax hält fremde POSTs ohnehin fern).
 */
async function isAdmin(req: Request, env: Env): Promise<boolean> {
  const auth = req.headers.get('authorization') || '';
  const token = auth.replace(/^Bearer\s+/i, '');
  if (token) {
    if (env.API_KEY && timingSafeEqual(token, env.API_KEY)) return true;
    return verifyToken(env.SESSION_SECRET, token);
  }
  const from = req.headers.get('origin');
  if (req.method !== 'GET' && from && from !== origin(req)) return false;
  return isAdminUser(await currentUser(req, env), env);
}

/** Ersteller (X-Owner-Key) oder Admin. */
async function isOwner(req: Request, env: Env, id: string): Promise<boolean> {
  if (await isAdmin(req, env)) return true;
  return docStub(env, id).checkOwner(req.headers.get('x-owner-key'));
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
  page: 'doc' | 'admin' | 'home' | 'memos';
  id?: string;
  exists?: boolean;
  siteKey?: string;
  katexCss?: string;
  /** Angemeldetes Konto (ohne Google-ID). */
  user?: { name: string; email: string; picture: string } | null;
  /** Anmelden ist auf dem Server eingerichtet. */
  login?: boolean;
  /** Bearbeitungsschlüssel aus dem Konto (neues Gerät). */
  editKey?: string;
  /** Angemeldet mit dem Admin-Konto: /admin ohne 2FA-Code. */
  admin?: boolean;
  /** Besitzer-Schlüssel aus dem Konto. */
  ownerKey?: string;
  /** Im Papierkorb seit (ms). */
  trashed?: number;
  /** Memos des Kontos (nur auf /memos). */
  memos?: MemoOut[];
}

type MemoOut = Memo & { html: string };
const memoOut = (m: Memo): MemoOut => ({ ...m, html: render(m.text).html });

/** Eigene App auf dem Homescreen: /memos hat ein eigenes Manifest und Icon. */
interface AppHead { manifest: string; title: string; icon: string }
const MD_APP: AppHead = { manifest: '/manifest.webmanifest', title: 'md', icon: '/apple-touch-icon.png' };
const MEMOS_APP: AppHead = { manifest: '/memos.webmanifest', title: 'Memos', icon: '/memos-touch-icon.png' };

const loginEnabled = (env: Env) => !!env.GOOGLE_CLIENT_ID || env.DEV_LOGIN === '1';
const publicUser = (u: User | null) => (u ? { name: u.name, email: u.email, picture: u.picture } : null);

/** Fest gewählte Darstellung aus den Einstellungen (Cookie md_theme), sonst ''. */
function themeOf(req: Request): 'light' | 'dark' | '' {
  const m = /(?:^|;\s*)md_theme=(light|dark)(?:;|$)/.exec(req.headers.get('cookie') || '');
  return m ? (m[1] as 'light' | 'dark') : '';
}

/** <html>-Tag und Farb-Metas passend zur Darstellung. */
function themeHead(theme: 'light' | 'dark' | ''): { html: string; metas: string } {
  if (!theme) {
    return {
      html: '<html lang="de">',
      metas: `<meta name="color-scheme" content="light dark">
<meta name="theme-color" content="#ffffff" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#1b1b1b" media="(prefers-color-scheme: dark)">`,
    };
  }
  const color = theme === 'dark' ? '#1b1b1b' : '#ffffff';
  return {
    html: `<html lang="de" data-theme="${theme}">`,
    metas: `<meta name="color-scheme" content="${theme}">
<meta name="theme-color" content="${color}" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="${color}" media="(prefers-color-scheme: dark)">`,
  };
}

function page(req: Request, title: string, body: string, boot: Boot, status = 200, app: AppHead = MD_APP): Response {
  const th = themeHead(themeOf(req));
  const exists = boot.page !== 'doc' || boot.exists ? '1' : '0';
  const html = `<!doctype html>
${th.html}
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex, nofollow">
${th.metas}
<title>${escapeHtml(title)}</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="icon" href="/icons/favicon-32.png" type="image/png" sizes="32x32">
<link rel="apple-touch-icon" href="${app.icon}">
<link rel="manifest" href="${app.manifest}">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="${app.title}">
<meta name="apple-mobile-web-app-status-bar-style" content="default">
<link rel="preload" href="/fonts/iAWriterQuattroS-Regular.woff2" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="${manifest.css}">
<script type="module" src="${manifest.js}"></script>
</head>
<body>
<script id="boot" type="application/json">${JSON.stringify({ ...boot, katexCss: manifest.katexCss, build: manifest.js.replace(/^.*-|\.js$/g, '') }).replace(/</g, '\\u003c')}</script>
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
      // Für den Service Worker: leere „neues Dokument“-Seiten nicht speichern.
      'x-md-exists': exists,
    },
  });
}

async function docPage(req: Request, env: Env, id: string): Promise<Response> {
  const info = await docStub(env, id).info(true);
  if (info.movedTo) return moved(info.movedTo, '');
  const wantsMarkdown = /text\/markdown/.test(req.headers.get('accept') || '') && !/text\/html/.test(req.headers.get('accept') || '');
  if (wantsMarkdown) return rawMarkdown(info, id, false);

  const user = await currentUser(req, env);
  const common = { page: 'doc' as const, id, user: publicUser(user), login: loginEnabled(env), admin: isAdminUser(user, env) };
  if (!info.exists) {
    // Angemeldet braucht es keinen Spam-Schutz.
    return page(req, 'Neues Dokument', `<main id="app"></main>`, { ...common, exists: false, siteKey: user ? undefined : env.TURNSTILE_SITEKEY }, 200);
  }
  const entry = user ? await accountStub(env, user.sub).get(id) : null;
  const editKey = entry?.editKey || undefined;
  const ownerKey = entry?.ownerKey || undefined;
  if (info.trashed) {
    // Für alle weg. Der Ersteller holt sich den Inhalt im Browser mit seinem Schlüssel.
    return page(req, 'Gelöscht', '<main id="app"></main>', { ...common, exists: true, trashed: info.trashed, ownerKey }, 410);
  }
  const { html } = render(info.markdown);
  const title = info.title || id;
  return page(req, title, `<main id="app"><article class="doc" id="view">${html}</article></main>`, { ...common, exists: true, editKey, ownerKey });
}

async function memosPage(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const user = await currentUser(req, env);
  const common = { page: 'memos' as const, user: publicUser(user), login: loginEnabled(env), admin: isAdminUser(user, env) };
  if (!user) return page(req, 'Memos', '<main id="app"></main>', common, 200, MEMOS_APP);
  const acc = accountStub(env, user.sub);
  if (common.admin) {
    // Umzug: vom Admin per API vorbereitete Memos übernehmen.
    const reg = registry(env);
    const pending = await reg.pendingMemos();
    if (pending.length) await reg.doneMemos(await acc.addMemos(pending));
  }
  const memos = (await acc.memos()).map(memoOut);
  // Nie abgeschickte Anhänge wegräumen.
  ctx.waitUntil(acc.sweepFiles().then(names => deleteMemoFiles(env, user.sub, names)).catch(() => {}));
  return page(req, 'Memos', '<main id="app"></main>', { ...common, memos }, 200, MEMOS_APP);
}

function rawMarkdown(info: { exists: boolean; markdown: string; trashed?: number }, id: string, download: boolean): Response {
  if (info.trashed) return new Response('Dokument wurde gelöscht.\n', { status: 410, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } });
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
  if (parts[0] === 'me') return me(req, env, parts.slice(1), url, ctx);

  if (parts[0] === 'admin' && parts[1] === 'docs' && method === 'GET') {
    if (!(await isAdmin(req, env))) return fail(401, 'Nicht freigeschaltet.');
    return json(await registry(env).list(url.searchParams.get('q') || ''));
  }

  if (parts[0] === 'admin' && parts[1] === 'memos' && method === 'POST') {
    if (!(await isAdmin(req, env))) return fail(401, 'Nicht freigeschaltet.');
    if (!env.ADMIN_EMAIL) return fail(503, 'ADMIN_EMAIL fehlt.');
    const body = await req.json<{ memos?: { id?: string; text?: string; created?: number }[] }>().catch(() => ({} as { memos?: [] }));
    if (!Array.isArray(body.memos)) return fail(400, 'memos fehlt.');
    const items = body.memos
      .filter(m => typeof m?.text === 'string' && m.text.trim() && m.text.length <= MAX_MEMO && Number(m.created) > 0)
      .map(m => ({ id: typeof m.id === 'string' && MEMO_ID.test(m.id) ? m.id : randomToken(12), text: m.text!, created: Math.floor(Number(m.created)) }));
    return json({ queued: await registry(env).queueMemos(items) });
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
      if (info.trashed) {
        if (!(await isOwner(req, env, id))) return fail(410, 'Dokument wurde gelöscht.');
        const p = await stub.peek();
        return json({ id, title: p?.title || '', markdown: p?.markdown || '', trashed: info.trashed, url: docUrl(req, id) });
      }
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
  }

  if (action === 'create' && method === 'POST') {
    const admin = await isAdmin(req, env);
    const user = await currentUser(req, env);
    if (!admin) {
      const { success } = await env.CREATE_LIMIT.limit({ key: user ? `u:${user.sub}` : ip(req) });
      if (!success) return fail(429, 'Zu viele neue Dokumente. Bitte kurz warten.');
      const body = await req.json<{ token?: string }>().catch(() => ({} as { token?: string }));
      if (!user && !(await turnstileOk(env, body.token, ip(req)))) return fail(403, 'Spam-Schutz nicht bestanden. Bitte Seite neu laden.');
    }
    const editKey = await stub.create(id);
    if (!editKey) return fail(409, 'Dieses Dokument wurde gerade von jemand anderem angelegt.');
    const ownerKey = await stub.ownerKey();
    if (user) await accountStub(env, user.sub).upsert([{ id, editKey, ownerKey, opened: Date.now() }]);
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

// ── Konto ───────────────────────────────────────────────────────────────────

async function me(req: Request, env: Env, parts: string[], url: URL, ctx: ExecutionContext): Promise<Response> {
  const user = await currentUser(req, env);
  if (!user) return fail(401, 'Nicht angemeldet.');
  // Nur von dieser Seite aus (zusätzlich zu SameSite=Lax beim Cookie).
  const from = req.headers.get('origin');
  if (req.method !== 'GET' && from && from !== origin(req)) return fail(403, 'Fremde Herkunft.');
  const acc = accountStub(env, user.sub);
  const body = async <T>() => (await req.json<T>().catch(() => ({}))) as Partial<T>;

  if (!parts.length) {
    if (req.method === 'GET') return json({ user: publicUser(user), docs: await acc.list() });
    if (req.method === 'DELETE') {
      await acc.destroy();
      // Memo-Anhänge des Kontos in R2.
      const prefix = memoFileKey(env, user.sub, '');
      let cursor: string | undefined;
      do {
        const list = await env.IMAGES.list({ prefix, cursor });
        if (list.objects.length) await env.IMAGES.delete(list.objects.map(o => o.key));
        cursor = list.truncated ? list.cursor : undefined;
      } while (cursor);
      return json({ ok: true }, 200, { 'set-cookie': clearSessionCookie(req) });
    }
  }
  if (parts[0] === 'memos') return memos(req, env, user, acc, parts.slice(1), url, ctx);
  if (parts[0] !== 'docs') return fail(404, 'Unbekannt.');

  if (parts.length === 1 && req.method === 'POST') {
    const { items } = await body<{ items: Partial<AccountDoc>[] }>();
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
    const { tags } = await body<{ tags: string[] }>();
    const doc = await acc.setTags(id, tags);
    if (!doc) return fail(404, 'Nicht in deiner Liste.');
    return json(doc);
  }
  return fail(404, 'Unbekannt.');
}

type Body = { id?: unknown; text?: unknown; created?: unknown };

/** R2-Schlüssel eines Memo-Anhangs: pro Konto ein eigener Ordner. */
const memoFileKey = (env: Env, sub: string, name: string) => `memos/${env.ACCOUNT.idFromName(`g:${sub}`).toString()}/${name}`;

const deleteMemoFiles = async (env: Env, sub: string, names: string[]) => {
  if (names.length) await env.IMAGES.delete(names.map(n => memoFileKey(env, sub, n)));
};

/** Dateiendung aus dem Namen, sonst aus dem Typ. */
const EXT_OF_TYPE: Record<string, string> = {
  'image/webp': 'webp', 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/avif': 'avif', 'image/heic': 'heic',
  'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a', 'audio/aac': 'aac', 'audio/mpeg': 'mp3', 'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/wav': 'wav',
  'video/mp4': 'mp4', 'video/quicktime': 'mov', 'application/pdf': 'pdf', 'text/plain': 'txt',
};
function extOf(name: string, type: string): string {
  const fromName = /\.([a-z0-9]{1,8})$/i.exec(name)?.[1]?.toLowerCase();
  return fromName || EXT_OF_TYPE[type] || 'bin';
}
/** Im Browser anzeigen statt herunterladen (alles andere als Download, auch SVG und HTML). */
const INLINE_TYPES = /^(image\/(jpeg|png|webp|gif|avif)|audio\/[\w.+-]+|video\/(mp4|webm|quicktime)|application\/pdf|text\/plain)$/;

async function memos(req: Request, env: Env, user: User, acc: ReturnType<typeof accountStub>, parts: string[], url: URL, ctx: ExecutionContext): Promise<Response> {
  const body = async () => (await req.json<Body>().catch(() => ({}))) as Body;
  // Zeilenenden vereinheitlichen, Leerzeilen vorn und Leerraum hinten weg.
  const cleanText = (t: unknown) => (typeof t === 'string' ? t.replace(/\r\n?/g, '\n').replace(/^(\s*\n)+|\s+$/g, '') : '');

  if (!parts.length) {
    if (req.method === 'GET') return json({ memos: (await acc.memos()).map(memoOut) });
    if (req.method === 'POST') {
      const b = await body();
      const text = cleanText(b.text);
      if (typeof b.id !== 'string' || !MEMO_ID.test(b.id)) return fail(400, 'Ungültige ID.');
      if (!text) return fail(400, 'Leeres Memo.');
      if (text.length > MAX_MEMO) return fail(413, 'Memo zu lang.');
      const m = await acc.addMemo(b.id, text, typeof b.created === 'number' ? b.created : undefined);
      if (!m) return fail(507, 'Zu viele Memos.');
      return json(memoOut(m), 201);
    }
  }

  // Anhang hochladen: Rohdaten im Body, Originalname im Header X-File-Name
  // (nicht in der Adresse, die landet in den Logs).
  if (parts[0] === 'files' && parts.length === 1 && req.method === 'POST') {
    const { success } = await env.UPLOAD_LIMIT.limit({ key: `u:${user.sub}` });
    if (!success) return fail(429, 'Zu viele Dateien auf einmal. Bitte kurz warten.');
    const size = Number(req.headers.get('content-length'));
    if (!size || !req.body) return fail(411, 'Größe fehlt.');
    if (size > MAX_FILE) return fail(413, 'Datei zu groß (max. 50 MB).');
    const rawType = (req.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    const type = /^[\w.+-]+\/[\w.+-]+$/.test(rawType) ? rawType : 'application/octet-stream';
    let original = '';
    try { original = decodeURIComponent(req.headers.get('x-file-name') || '').slice(0, 200); } catch { /* egal */ }
    const name = `${randomToken(12)}.${extOf(original, type)}`;
    if (!(await acc.reserveFile(name, size, type))) return fail(507, 'Speicher für Anhänge ist voll.');
    await env.IMAGES.put(memoFileKey(env, user.sub, name), req.body, { httpMetadata: { contentType: type } });
    return json({ url: `/m/${name}`, name, size, type }, 201);
  }

  // Ortsname zu Koordinaten (OpenStreetMap). Nur Lage und Sprache gehen raus,
  // kein Konto. Koordinaten im Body, damit sie nicht in den Logs stehen.
  if (parts[0] === 'geo' && parts.length === 1 && req.method === 'POST') {
    const b = await req.json<{ lat?: unknown; lon?: unknown }>().catch(() => ({} as { lat?: unknown; lon?: unknown }));
    const lat = Number(b.lat), lon = Number(b.lon);
    if (!(Math.abs(lat) <= 90 && Math.abs(lon) <= 180)) return fail(400, 'Ungültige Koordinaten.');
    const { success } = await env.UPLOAD_LIMIT.limit({ key: `u:${user.sub}` });
    if (!success) return json({ name: '' });
    return json({ name: await placeName(lat, lon) });
  }

  const id = parts[0];
  if (parts.length !== 1 || !MEMO_ID.test(id)) return fail(404, 'Unbekannt.');
  if (req.method === 'PUT') {
    const text = cleanText((await body()).text);
    if (!text) return fail(400, 'Leeres Memo.');
    if (text.length > MAX_MEMO) return fail(413, 'Memo zu lang.');
    const { memo, orphans } = await acc.editMemo(id, text);
    ctx.waitUntil(deleteMemoFiles(env, user.sub, orphans));
    return memo ? json(memoOut(memo)) : fail(404, 'Memo nicht gefunden.');
  }
  if (req.method === 'DELETE') {
    ctx.waitUntil(deleteMemoFiles(env, user.sub, await acc.deleteMemo(id)));
    return json({ ok: true });
  }
  return fail(405, 'Methode nicht erlaubt.');
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

/** Memo-Anhang ausliefern: nur an das eigene Konto, mit Range für Audio/Video. */
async function memoFile(req: Request, env: Env, name: string): Promise<Response> {
  const notFound = () => new Response('Nicht gefunden', { status: 404, headers: { 'cache-control': 'no-store' } });
  if (!FILE_NAME.test(name)) return notFound();
  const user = await currentUser(req, env);
  if (!user) return notFound();
  const key = memoFileKey(env, user.sub, name);
  const ranged = req.headers.has('range');
  const obj = await env.IMAGES.get(key, { range: ranged ? req.headers : undefined, onlyIf: req.headers });
  if (!obj) return notFound();
  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set('etag', obj.httpEtag);
  headers.set('accept-ranges', 'bytes');
  headers.set('cache-control', 'private, max-age=31536000, immutable');
  headers.set('x-content-type-options', 'nosniff');
  const type = headers.get('content-type') || '';
  if (!INLINE_TYPES.test(type)) {
    headers.set('content-type', 'application/octet-stream');
    headers.set('content-disposition', `attachment; filename="${name}"`);
  }
  if (!('body' in obj)) return new Response(null, { status: 304, headers });
  if (ranged && obj.range) {
    const r = obj.range as { offset?: number; length?: number; suffix?: number };
    const offset = r.suffix !== undefined ? obj.size - r.suffix : r.offset ?? 0;
    const length = r.length ?? obj.size - offset;
    headers.set('content-range', `bytes ${offset}-${offset + length - 1}/${obj.size}`);
    headers.set('content-length', String(length));
    return new Response(obj.body, { status: 206, headers });
  }
  return new Response(obj.body, { headers });
}

async function unlock(req: Request, env: Env): Promise<Response> {
  const body = await req.json<{ code?: string; doc?: string }>().catch(() => ({} as { code?: string; doc?: string }));
  // Angemeldet mit dem Admin-Google-Konto: ein Dokument ohne Code freischalten.
  if (body.doc && !body.code && isAdminUser(await currentUser(req, env), env)) {
    const from = req.headers.get('origin');
    if (from && from !== origin(req)) return fail(403, 'Fremde Herkunft.');
    return unlockDoc(req, env, body.doc);
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

  // Mit Dokument: nur dieses eine Dokument freischalten, kein Admin-Zugang.
  if (body.doc) return unlockDoc(req, env, body.doc);
  const token = await signToken(env.SESSION_SECRET, ADMIN_TTL);
  return json({ token, expiresIn: ADMIN_TTL });
}

/** Bearbeitungs- und Besitzer-Schlüssel eines Dokuments (nach geprüftem Code bzw. Admin). */
async function unlockDoc(req: Request, env: Env, raw: string): Promise<Response> {
  const id = normalizeId(raw);
  if (!id) return fail(400, 'Ungültige ID.');
  const editKey = await docStub(env, id).getEditKey();
  if (!editKey) return fail(404, 'Dokument nicht gefunden.');
  // Wer freischalten darf, darf das Dokument auch löschen (gilt so auch für alte Dokumente).
  const ownerKey = await docStub(env, id).ensureOwnerKey();
  const user = await currentUser(req, env);
  if (user) await accountStub(env, user.sub).upsert([{ id, editKey, ownerKey, opened: Date.now() }]);
  return json({ editKey, ownerKey });
}

// ── Einstieg ────────────────────────────────────────────────────────────────

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;

    // Die alte Memos-Instanz lag auf memos.veerka.mp.
    if (url.hostname === 'memos.veerka.mp') {
      return new Response(null, { status: 301, headers: { location: 'https://md.veerka.mp/memos' } });
    }

    if (/^\/(assets|fonts|icons)\//.test(path) || STATIC_FILES.has(path)) {
      return env.ASSETS.fetch(req);
    }
    if (path === '/robots.txt') {
      // Keine Sperre: KI-Assistenten, die ein Nutzer einen Link lesen lässt
      // (Claude-User, ChatGPT-User …), halten sich an robots.txt. Aus
      // Suchmaschinen hält die Seiten der Header X-Robots-Tag: noindex fern.
      // Trainings-Crawler sperrt Cloudflare (verwaltete robots.txt davor).
      return new Response('# Dokumente sind per noindex von Suchmaschinen ausgenommen.\n', { headers: { 'content-type': 'text/plain' } });
    }
    if (path.startsWith('/auth/')) {
      try {
        return await auth(req, env, url);
      } catch (err) {
        console.error(err);
        return new Response('Anmeldung fehlgeschlagen.', { status: 500 });
      }
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
    if (path === '/home') {
      const user = await currentUser(req, env);
      return page(req, 'md', '<main id="app"></main>', { page: 'home', user: publicUser(user), login: loginEnabled(env), admin: isAdminUser(user, env) });
    }
    if (path === '/admin') {
      const user = await currentUser(req, env);
      return page(req, 'Übersicht', '<main id="app"></main>', { page: 'admin', admin: isAdminUser(user, env) });
    }
    if (path === '/memos') return memosPage(req, env, ctx);
    if (path.startsWith('/m/')) return memoFile(req, env, path.slice(3));
    if (path === '/datenschutz') return privacyPage(req);
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

/** Datenschutzerklärung (verlangt Google für den Login). Ohne Skript, nur Text. */
function privacyPage(req: Request): Response {
  const th = themeHead(themeOf(req));
  const html = `<!doctype html>
${th.html}
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${th.metas}
<title>Datenschutz – md</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="${manifest.css}">
</head>
<body>
<main><article class="doc">
<h1>Datenschutz</h1>
<p>md.veerka.mp ist ein privat betriebener Markdown-Editor. Hier steht, welche Daten dabei anfallen.</p>
<h2>Dokumente</h2>
<p>Was du schreibst, wird gespeichert, damit es unter seiner Adresse abrufbar ist. Wer die Adresse kennt, kann ein Dokument lesen; bearbeiten kann nur, wer den Bearbeiten-Link hat. Dokumente, die 12 Monate niemand geöffnet hat, werden samt Bildern gelöscht. Suchmaschinen sind ausgesperrt.</p>
<h2>Ohne Anmeldung</h2>
<p>Die Liste „zuletzt geöffnet“ und die Bearbeitungsrechte liegen nur in deinem Browser. Beim Anlegen eines Dokuments prüft Cloudflare Turnstile, ob ein Mensch schreibt. Die IP-Adresse wird kurzzeitig für eine Begrenzung der Anfragen verwendet und nicht dauerhaft gespeichert.</p>
<h2>Mit Google anmelden (optional)</h2>
<p>Meldest du dich an, erhält md von Google deine Google-Konto-ID, deinen Namen, deine E-Mail-Adresse und dein Profilbild. Damit wird ein Konto angelegt, in dem deine Dokumentliste, die Bearbeitungsrechte, deine Tags und deine Memos liegen. Memos und ihre Anhänge (Bilder, Dateien, Sprachmemos) sind nur für dein Konto abrufbar; es gibt keine Ansicht, in der andere sie sehen, auch nicht der Betreiber. Gespeichert sind sie bei Cloudflare (dort verschlüsselt abgelegt, aber nicht Ende-zu-Ende verschlüsselt). Fügst du einem Memo deinen Standort hinzu, gehen die Koordinaten einmal an OpenStreetMap (Nominatim), um den Ortsnamen zu finden. Name, E-Mail und Bild stehen in einem Sitzungs-Cookie in deinem Browser. Es gibt keine Werbung, kein Tracking und keine Weitergabe an Dritte. Unter „Konto löschen“ (Übersicht, oben rechts) kannst du Konto, Liste, Tags und Memos jederzeit löschen; die Dokumente selbst bleiben unter ihren Adressen bestehen.</p>
<h2>Hosting</h2>
<p>Die Seite läuft bei Cloudflare (Workers, Speicher in Durable Objects und R2). Cloudflare verarbeitet dabei technisch notwendige Verbindungsdaten.</p>
<h2>Kontakt</h2>
<p>Fragen und Löschwünsche: <a href="mailto:datenschutz@veerka.mp">datenschutz@veerka.mp</a></p>
<p><a href="/home">Zur Übersicht</a></p>
</article></main>
</body>
</html>`;
  return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache', 'content-security-policy': CSP } });
}

function moved(to: string, suffix: string): Response {
  return new Response(null, { status: 301, headers: { location: `/${encodeURIComponent(to)}${suffix}`, 'cache-control': 'no-store' } });
}

function decodeURIComponentSafe(s: string) {
  try { return decodeURIComponent(s); } catch { return s; }
}
