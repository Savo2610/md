// 2FA-Codes (TOTP) und signierte Admin-Token, alles über WebCrypto.
// Übernommen aus file-uploader/src/crypto.js.

const enc = new TextEncoder();

export function b64urlEncode(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function b64urlDecode(str: string): Uint8Array {
  const s = str.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(s + '='.repeat((4 - (s.length % 4)) % 4));
  return Uint8Array.from(bin, c => c.charCodeAt(0));
}

/**
 * Zufällige ID aus Kleinbuchstaben und Ziffern. 10 Zeichen = 36^10 ≈ 3,7 · 10^15
 * Möglichkeiten (≈ 52 Bit). Selbst bei 10.000 Dokumenten und 1000 Versuchen pro
 * Sekunde bräuchte Raten im Schnitt über 10 Jahre – und so viele Anfragen
 * würden lange vorher am Tageskontingent scheitern.
 */
export function randomId(length = 10): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const out: string[] = [];
  // 252 = 7 · 36: Werte darüber verwerfen, sonst wären die ersten Zeichen häufiger.
  while (out.length < length) {
    for (const b of crypto.getRandomValues(new Uint8Array(length * 2))) {
      if (b < 252 && out.length < length) out.push(alphabet[b % 36]);
    }
  }
  const id = out.join('');
  // Immer Buchstaben und Ziffern gemischt, damit isRandomId() sie sicher erkennt.
  return /\d/.test(id) && /[a-z]/.test(id) ? id : randomId(length);
}

/** Sieht aus wie eine von randomId() erzeugte Adresse (10 Zeichen, Buchstaben und Ziffern gemischt). */
export function isRandomId(id: string): boolean {
  return /^[a-z0-9]{10}$/.test(id) && /\d/.test(id) && /[a-z]/.test(id);
}

export function randomToken(bytes = 24): string {
  return b64urlEncode(crypto.getRandomValues(new Uint8Array(bytes)));
}

/** Vergleich in konstanter Zeit, damit die Laufzeit nichts über den Schlüssel verrät. */
export function timingSafeEqual(a: unknown, b: unknown): boolean {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ── TOTP (RFC 6238) ─────────────────────────────────────────────────────────

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Decode(input: string): Uint8Array {
  const clean = input.toUpperCase().replace(/[=\s-]/g, '');
  let bits = 0, value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = BASE32.indexOf(ch);
    if (idx === -1) throw new Error('Ungültiges Zeichen im Base32-Secret');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 0xff); bits -= 8; }
  }
  return new Uint8Array(out);
}

async function hotp(secret: Uint8Array, counter: number): Promise<string> {
  const key = await crypto.subtle.importKey('raw', secret, { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  const msg = new ArrayBuffer(8);
  const view = new DataView(msg);
  view.setUint32(0, Math.floor(counter / 2 ** 32));
  view.setUint32(4, counter >>> 0);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, msg));
  const offset = sig[sig.length - 1] & 0x0f;
  const bin = ((sig[offset] & 0x7f) << 24) | (sig[offset + 1] << 16) | (sig[offset + 2] << 8) | sig[offset + 3];
  return String(bin % 1_000_000).padStart(6, '0');
}

/**
 * Prüft einen 6-stelligen Code. Erlaubt ein Zeitfenster davor und danach
 * (leicht falsch gehende Handy-Uhr). Gibt das getroffene Fenster zurück, das
 * in die Wiederverwendungssperre eingeht.
 */
export async function verifyTotp(secretBase32: string, code: unknown): Promise<{ counter: number } | null> {
  const c = String(code ?? '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(c)) return null;
  const secret = base32Decode(secretBase32);
  const counter = Math.floor(Date.now() / 1000 / 30);
  for (let drift = -1; drift <= 1; drift++) {
    if (timingSafeEqual(await hotp(secret, counter + drift), c)) return { counter: counter + drift };
  }
  return null;
}

// ── Signierte Token ─────────────────────────────────────────────────────────
// Admin-Token nach dem 2FA-Code, Sitzungs-Cookie nach dem Google-Login und der
// kurzlebige Zustand während des Logins. Der Server merkt sich nichts; die
// Signatur belegt, dass es von uns kommt. `role` trennt die Arten, damit ein
// Sitzungs-Cookie nie als Admin-Token durchgeht.

async function hmacKey(secret: string) {
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
}

export async function signToken(secret: string, ttlSeconds: number, data: Record<string, unknown> = { role: 'admin' }): Promise<string> {
  const payload = b64urlEncode(enc.encode(JSON.stringify({ ...data, exp: Math.floor(Date.now() / 1000) + ttlSeconds })));
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(payload)));
  return `${payload}.${b64urlEncode(sig)}`;
}

/** Inhalt eines gültigen, nicht abgelaufenen Tokens der Art `role`, sonst null. */
export async function readToken<T = Record<string, unknown>>(secret: string | undefined, token: string | null | undefined, role: string): Promise<T | null> {
  if (!secret || !token || !token.includes('.')) return null;
  const [payload, sig] = token.split('.', 2);
  const expected = new Uint8Array(await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(payload)));
  if (!timingSafeEqual(b64urlEncode(expected), sig)) return null;
  try {
    const data = JSON.parse(new TextDecoder().decode(b64urlDecode(payload)));
    return data?.role === role && typeof data.exp === 'number' && data.exp > Date.now() / 1000 ? data : null;
  } catch {
    return null;
  }
}

export async function verifyToken(secret: string | undefined, token: string | null | undefined): Promise<boolean> {
  return !!(await readToken(secret, token, 'admin'));
}

/** PKCE: code_challenge = base64url(SHA-256(verifier)). */
export async function sha256b64url(input: string): Promise<string> {
  return b64urlEncode(new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(input))));
}
