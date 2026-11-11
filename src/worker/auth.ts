// Optionaler Login mit Google (OpenID Connect, Authorization Code + PKCE).
//
//   GET  /auth/login?next=/pfad   → Google; danach zurück nach `next`
//   GET  /auth/callback           ← Google; setzt das Sitzungs-Cookie
//   POST /auth/logout             Cookie löschen
//
// Die Sitzung ist ein signiertes Cookie (HttpOnly, 180 Tage) mit Google-ID,
// Name, E-Mail und Bild. Der Server speichert dafür nichts. Das ID-Token
// kommt direkt vom Token-Endpunkt über TLS; laut OpenID-Spezifikation reicht
// dann die Prüfung von Aussteller, Empfänger, Ablauf und Nonce, ohne die
// Signatur über Googles Schlüssel zu prüfen.
//
// Lokal ohne Google-Zugang: DEV_LOGIN=1 in .dev.vars meldet sofort als
// Testkonto an. Nie als Variable in Produktion setzen.

import { b64urlDecode, randomToken, readToken, sha256b64url, signToken } from './crypto';
import { accountStub, type Env } from './env';

export interface User {
  sub: string;
  email: string;
  name: string;
  picture: string;
}

const SESSION_COOKIE = 'md_session';
const OAUTH_COOKIE = 'md_oauth';
const SESSION_TTL = 180 * 24 * 3600;
const OAUTH_TTL = 10 * 60;

function cookies(req: Request): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (req.headers.get('cookie') || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

function cookie(req: Request, name: string, value: string, maxAge: number): string {
  const secure = new URL(req.url).protocol === 'https:' ? '; Secure' : '';
  return `${name}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${secure}`;
}

export const clearSessionCookie = (req: Request) => cookie(req, SESSION_COOKIE, '', 0);

/** Angemeldetes Konto aus dem Cookie, sonst null. */
export async function currentUser(req: Request, env: Env): Promise<User | null> {
  const token = cookies(req)[SESSION_COOKIE];
  if (!token) return null;
  const data = await readToken<User & { role: string }>(env.SESSION_SECRET, token, 'user');
  if (!data || typeof data.sub !== 'string') return null;
  return { sub: data.sub, email: data.email || '', name: data.name || '', picture: data.picture || '' };
}

/** Nur Pfade auf dieser Seite, keine fremden Adressen (//evil.com, /\evil.com). */
function safeNext(raw: string | null): string {
  if (!raw || !raw.startsWith('/') || raw.startsWith('//') || raw.startsWith('/\\') || raw.startsWith('/auth/')) return '/home';
  return raw.slice(0, 500);
}

const redirect = (location: string, setCookies: string[] = []) => {
  const headers = new Headers({ location, 'cache-control': 'no-store' });
  for (const c of setCookies) headers.append('set-cookie', c);
  return new Response(null, { status: 302, headers });
};

const errorPage = (msg: string, status = 400) =>
  new Response(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Anmeldung</title>
<body style="font:16px/1.6 system-ui;max-width:32rem;margin:15vh auto;padding:0 20px">
<p>${msg}</p><p><a href="/home">Zurück</a></p></body>`, { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });

async function startSession(req: Request, env: Env, user: User, next: string): Promise<Response> {
  if (!env.SESSION_SECRET) return errorPage('Auf dem Server fehlt SESSION_SECRET.', 503);
  await accountStub(env, user.sub).setProfile(user);
  const token = await signToken(env.SESSION_SECRET, SESSION_TTL, { role: 'user', ...user });
  return redirect(next, [cookie(req, SESSION_COOKIE, token, SESSION_TTL), cookie(req, OAUTH_COOKIE, '', 0)]);
}

export async function auth(req: Request, env: Env, url: URL): Promise<Response> {
  const action = url.pathname.slice('/auth/'.length);

  if (action === 'logout') {
    if (req.method !== 'POST') return new Response('Methode nicht erlaubt', { status: 405 });
    return new Response(JSON.stringify({ ok: true }), {
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'set-cookie': clearSessionCookie(req) },
    });
  }

  if (action === 'login') {
    const next = safeNext(url.searchParams.get('next'));
    // DEV_LOGIN steht nur in .dev.vars. (wrangler dev schreibt die Adresse
    // auf die Route um, der Hostname taugt hier also nicht als Prüfung.)
    if (env.DEV_LOGIN === '1') {
      return startSession(req, env, { sub: 'dev', email: 'test@localhost', name: 'Testkonto', picture: '' }, next);
    }
    if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET || !env.SESSION_SECRET) {
      return errorPage('Die Anmeldung ist auf dem Server noch nicht eingerichtet.', 503);
    }
    const state = randomToken(18);
    const nonce = randomToken(18);
    const verifier = randomToken(48);
    const pending = await signToken(env.SESSION_SECRET, OAUTH_TTL, { role: 'oauth', state, nonce, verifier, next });
    const google = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    google.search = new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      redirect_uri: `${url.origin}/auth/callback`,
      response_type: 'code',
      scope: 'openid email profile',
      state,
      nonce,
      code_challenge: await sha256b64url(verifier),
      code_challenge_method: 'S256',
      prompt: 'select_account',
    }).toString();
    return redirect(google.toString(), [cookie(req, OAUTH_COOKIE, pending, OAUTH_TTL)]);
  }

  if (action === 'callback') {
    const pending = await readToken<{ state: string; nonce: string; verifier: string; next: string }>(env.SESSION_SECRET, cookies(req)[OAUTH_COOKIE], 'oauth');
    if (url.searchParams.get('error')) return redirect(pending?.next || '/home', [cookie(req, OAUTH_COOKIE, '', 0)]);
    if (!pending || pending.state !== url.searchParams.get('state')) {
      return errorPage('Die Anmeldung ist abgelaufen oder wurde in einem anderen Fenster begonnen. Bitte noch einmal versuchen.');
    }
    const code = url.searchParams.get('code');
    if (!code || !env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) return errorPage('Anmeldung fehlgeschlagen.');
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: env.GOOGLE_CLIENT_ID,
        client_secret: env.GOOGLE_CLIENT_SECRET,
        redirect_uri: `${url.origin}/auth/callback`,
        grant_type: 'authorization_code',
        code_verifier: pending.verifier,
      }),
    });
    const data = await res.json<{ id_token?: string; error?: string }>().catch(() => ({} as { id_token?: string }));
    if (!res.ok || !data.id_token) {
      console.error('Google token', res.status, JSON.stringify(data));
      return errorPage('Google hat die Anmeldung nicht bestätigt. Bitte noch einmal versuchen.', 502);
    }
    let claims: Record<string, unknown>;
    try { claims = JSON.parse(new TextDecoder().decode(b64urlDecode(data.id_token.split('.')[1]))); } catch { return errorPage('Anmeldung fehlgeschlagen.', 502); }
    const now = Date.now() / 1000;
    const valid = (claims.iss === 'https://accounts.google.com' || claims.iss === 'accounts.google.com')
      && claims.aud === env.GOOGLE_CLIENT_ID
      && typeof claims.exp === 'number' && claims.exp > now
      && claims.nonce === pending.nonce
      && typeof claims.sub === 'string';
    if (!valid) return errorPage('Anmeldung fehlgeschlagen (Token ungültig).', 502);
    return startSession(req, env, {
      sub: claims.sub as string,
      // Nur bestätigte Adressen: daran hängt der Admin-Zugang (ADMIN_EMAIL).
      email: claims.email_verified === true ? String(claims.email || '') : '',
      name: String(claims.name || claims.given_name || claims.email || ''),
      picture: typeof claims.picture === 'string' && claims.picture.startsWith('https://') ? claims.picture : '',
    }, pending.next);
  }

  return new Response('Nicht gefunden', { status: 404 });
}
