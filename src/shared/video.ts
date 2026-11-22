// YouTube- und Vimeo-Adressen erkennen (Editor und Whiteboard).

export interface Video { kind: 'youtube' | 'vimeo'; id: string; start?: number }

/** Startzeit aus t=1m30s, t=90, start=90 → Sekunden. */
function seconds(raw: string | null): number | undefined {
  if (!raw) return undefined;
  if (/^\d+$/.test(raw)) return Number(raw) || undefined;
  const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(raw);
  if (!m || !m[0]) return undefined;
  return (Number(m[1] || 0) * 3600 + Number(m[2] || 0) * 60 + Number(m[3] || 0)) || undefined;
}

/** YouTube- oder Vimeo-Adresse → { kind, id }, sonst null. */
export function videoOf(raw: string): Video | null {
  let u: URL;
  try { u = new URL(raw.trim()); } catch { return null; }
  const host = u.hostname.replace(/^(www|m|music)\./, '');
  const start = seconds(u.searchParams.get('t') || u.searchParams.get('start'));
  const out = (kind: Video['kind'], id: string): Video => (start ? { kind, id, start } : { kind, id });
  if (host === 'youtu.be') {
    const id = u.pathname.slice(1).split('/')[0];
    return /^[\w-]{11}$/.test(id) ? out('youtube', id) : null;
  }
  if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    const v = u.searchParams.get('v');
    if (v && /^[\w-]{11}$/.test(v)) return out('youtube', v);
    const m = /^\/(?:shorts|embed|live|v)\/([\w-]{11})/.exec(u.pathname);
    return m ? out('youtube', m[1]) : null;
  }
  if (host === 'vimeo.com' || host === 'player.vimeo.com') {
    const m = /^\/(?:video\/)?(\d{5,})/.exec(u.pathname);
    return m ? out('vimeo', m[1]) : null;
  }
  return null;
}

/** Normale Adresse zum Ansehen (für Markdown und Links). */
export function videoUrl(v: Video): string {
  return v.kind === 'youtube'
    ? `https://www.youtube.com/watch?v=${v.id}${v.start ? `&t=${v.start}` : ''}`
    : `https://vimeo.com/${v.id}${v.start ? `#t=${v.start}s` : ''}`;
}

/** Adresse für den eingebetteten Player. */
export function videoEmbed(v: Video, autoplay = false): string {
  const q = new URLSearchParams();
  if (autoplay) q.set('autoplay', '1');
  if (v.kind === 'youtube') {
    if (v.start) q.set('start', String(v.start));
    q.set('playsinline', '1');
    q.set('rel', '0');
    return `https://www.youtube-nocookie.com/embed/${v.id}?${q}`;
  }
  return `https://player.vimeo.com/video/${v.id}?${q}${v.start ? `#t=${v.start}s` : ''}`;
}
