// Hochgeladene Dateien aus R2 ausliefern (Bilder der Dokumente unter /i/,
// Memo-Anhänge unter /m/).
//
// Die Dateien liegen auf derselben Domain wie die App. Damit eine
// hochgeladene HTML- oder SVG-Datei nie als Seite mit Zugriff auf die App
// läuft, zeigt der Browser nur harmlose Typen direkt an; alles andere kommt
// als Download. Dazu eine CSP ohne Skripte.

/** Diese Typen darf der Browser direkt anzeigen. Kein SVG, kein HTML. */
const INLINE_TYPES = /^(image\/(jpeg|png|webp|gif|avif)|audio\/[\w.+-]+|video\/(mp4|webm|quicktime)|application\/pdf|text\/plain)$/;

// `sandbox` sperrt Chromes PDF-Ansicht aus, bei PDFs reicht der Rest.
const FILE_CSP = "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'";

/**
 * R2-Objekt als Antwort, mit Range (Audio/Video) und If-None-Match.
 * `cache` überschreibt die Cache-Control aus den Metadaten.
 */
export async function serveFile(req: Request, bucket: R2Bucket, key: string, name: string, cache?: string): Promise<Response | null> {
  const ranged = req.headers.has('range');
  const obj = await bucket.get(key, { range: ranged ? req.headers : undefined, onlyIf: req.headers });
  if (!obj) return null;

  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set('etag', obj.httpEtag);
  headers.set('accept-ranges', 'bytes');
  headers.set('x-content-type-options', 'nosniff');
  if (cache) headers.set('cache-control', cache);
  const type = (headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (INLINE_TYPES.test(type)) {
    headers.set('content-security-policy', type === 'application/pdf' ? FILE_CSP : `${FILE_CSP}; sandbox`);
  } else {
    headers.set('content-type', 'application/octet-stream');
    headers.set('content-disposition', `attachment; filename="${name}"`);
    headers.set('content-security-policy', `${FILE_CSP}; sandbox`);
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
