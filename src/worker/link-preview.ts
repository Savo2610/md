// Vorschau für eingefügte Links: Seitentitel (og:title, sonst <title>).
// Ist die Adresse selbst ein Bild oder ein geteiltes Google-Fotos-Bild,
// kommt zusätzlich `image` zurück – der Editor macht dann ![](bild) daraus.
// Nur http(s) auf öffentliche Namen, höchstens 4 Sekunden und 256 KB.

const MAX_HTML = 256 * 1024;

/** Keine IP-Adressen und keine lokalen Namen. */
function publicHost(host: string): boolean {
  if (/^[\d.]+$|^\[|:/.test(host) || !host.includes('.')) return false;
  return !/(^|\.)(localhost|local|internal|lan|home\.arpa)$/i.test(host);
}

export async function linkPreview(raw: string): Promise<{ title: string; image?: string }> {
  const none = { title: '' };
  let target: URL;
  try { target = new URL(raw); } catch { return none; }
  if (!/^https?:$/.test(target.protocol) || !publicHost(target.hostname)) return none;
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
    if (!res.ok || !type.includes('html') || !res.body) {
      res.body?.cancel().catch(() => {});
      return none;
    }
    const html = await readHead(res.body);
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

/** HTML bis zum <body> (dort stehen Titel und Metas), höchstens MAX_HTML. */
async function readHead(body: ReadableStream<Uint8Array>): Promise<string> {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let html = '';
  while (html.length < MAX_HTML) {
    const { done, value } = await reader.read();
    if (done) break;
    html += dec.decode(value, { stream: true });
    if (/<body/i.test(html)) break;
  }
  reader.cancel().catch(() => {});
  return html;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', auml: 'ä', ouml: 'ö', uuml: 'ü', Auml: 'Ä', Ouml: 'Ö', Uuml: 'Ü', szlig: 'ß' };

function decodeEntities(s: string): string {
  return s.replace(/&(#x[\da-f]+|#\d+|\w+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const n = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[e] ?? m;
  });
}
