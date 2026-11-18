// Wer darf was: Dokument-Adressen prüfen, Admin, Ersteller, Bearbeiten,
// Spam-Schutz beim Anlegen.

import { timingSafeEqual, verifyToken } from './crypto';
import { currentUser, type User } from './auth';
import { docStub, type Env } from './env';
import { sameOrigin } from './http';

/**
 * Adressen, die keine Dokumente sein können (eigene Seiten und Ordner).
 * Dateinamen mit Punkt (sw.js, favicon.svg …) schließt schon die Regel in
 * normalizeId() aus.
 */
const RESERVED = new Set(['api', 'auth', 'admin', 'home', 'memos', 'pack', 'datenschutz', 'i', 'assets', 'fonts', 'icons', 'new']);

/**
 * Normalisiert eine Dokument-ID aus der URL: klein, Leerzeichen → Bindestrich.
 * Erlaubt Buchstaben (auch Umlaute), Ziffern, - und _ (max. 80 Zeichen).
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
export function isAdminUser(user: User | null, env: Env): boolean {
  return !!user?.email && !!env.ADMIN_EMAIL && user.email.toLowerCase() === env.ADMIN_EMAIL.trim().toLowerCase();
}

/**
 * Admin: Bearer-Token aus der 2FA-Freischaltung, der API-Schlüssel oder das
 * Admin-Google-Konto (Cookie, dann nur von dieser Seite aus).
 */
export async function isAdmin(req: Request, env: Env): Promise<boolean> {
  const token = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (token) {
    if (env.API_KEY && timingSafeEqual(token, env.API_KEY)) return true;
    return verifyToken(env.SESSION_SECRET, token);
  }
  if (!sameOrigin(req)) return false;
  return isAdminUser(await currentUser(req, env), env);
}

/** Ersteller (X-Owner-Key) oder Admin. */
export async function isOwner(req: Request, env: Env, id: string): Promise<boolean> {
  if (await isAdmin(req, env)) return true;
  return docStub(env, id).checkOwner(req.headers.get('x-owner-key'));
}

/** Bearbeitungsschlüssel (X-Edit-Key) oder Admin. */
export async function canEdit(req: Request, env: Env, id: string): Promise<boolean> {
  if (await isAdmin(req, env)) return true;
  return docStub(env, id).checkKey(req.headers.get('x-edit-key'));
}

/** Cloudflare Turnstile. Ohne TURNSTILE_SECRET (lokal) immer bestanden. */
export async function turnstileOk(env: Env, token: unknown, remoteip: string): Promise<boolean> {
  if (!env.TURNSTILE_SECRET) return true;
  if (typeof token !== 'string' || !token) return false;
  const body = new FormData();
  body.append('secret', env.TURNSTILE_SECRET);
  body.append('response', token);
  body.append('remoteip', remoteip);
  try {
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body });
    const data = await res.json<{ success?: boolean }>();
    return data.success === true;
  } catch (err) {
    console.error('Turnstile', err);
    return false;
  }
}
