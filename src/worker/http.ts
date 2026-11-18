// Kleine Helfer für Antworten und Anfragen, die alle Teile des Workers nutzen.

export const json = (data: unknown, status = 200, headers: HeadersInit = {}) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers } });

export const fail = (status: number, error: string) => json({ error }, status);

export const text = (body: string, status = 200, headers: HeadersInit = {}) =>
  new Response(body, { status, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', ...headers } });

export const notFound = () => text('Nicht gefunden', 404);

export function redirect(location: string, status = 302, setCookies: string[] = []): Response {
  const headers = new Headers({ location, 'cache-control': 'no-store' });
  for (const c of setCookies) headers.append('set-cookie', c);
  return new Response(null, { status, headers });
}

/** Weiterleitung eines umbenannten Dokuments auf seine neue Adresse. */
export const moved = (to: string, suffix: string) => redirect(`/${encodeURIComponent(to)}${suffix}`, 301);

/** JSON-Body oder {} (kaputter oder fehlender Body zählt als leer). */
export async function readJson<T extends object>(req: Request): Promise<Partial<T>> {
  const data = await req.json<unknown>().catch(() => null);
  return data && typeof data === 'object' ? (data as Partial<T>) : {};
}

export const ip = (req: Request) => req.headers.get('cf-connecting-ip') || 'local';
export const origin = (req: Request) => new URL(req.url).origin;

/**
 * Ändernde Anfragen mit Cookie nur von dieser Seite aus (zusätzlich zu
 * SameSite=Lax). Ohne Origin-Header (z. B. curl) zählt die Anfrage als eigene.
 */
export function sameOrigin(req: Request): boolean {
  if (req.method === 'GET' || req.method === 'HEAD') return true;
  const from = req.headers.get('origin');
  return !from || from === origin(req);
}

export function decodeURIComponentSafe(s: string): string {
  try { return decodeURIComponent(s); } catch { return s; }
}
