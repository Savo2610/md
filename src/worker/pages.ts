// HTML-Gerüst der Seiten (serverseitig), Sicherheits-Header, reines Markdown
// und die Datenschutzseite.

import manifest from '../generated/manifest.json';
import { escapeHtml } from '../shared/render';
import { isAdminUser } from './access';
import type { Memo } from './account';
import type { User } from './auth';
import type { Env } from './env';

const CSP = [
  "default-src 'self'",
  "script-src 'self' https://challenges.cloudflare.com",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' https: data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  'frame-src https://www.youtube-nocookie.com https://player.vimeo.com https://challenges.cloudflare.com',
  "frame-ancestors 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
].join('; ');

/** Für jede HTML-Seite. */
const SECURITY_HEADERS = {
  'content-security-policy': CSP,
  'x-robots-tag': 'noindex, nofollow',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'x-content-type-options': 'nosniff',
  'strict-transport-security': 'max-age=31536000',
};

export type MemoOut = Memo & { html: string; docTitle?: string };

/** Startdaten für den Browser (als JSON in <script id="boot">). */
export interface Boot {
  page: 'doc' | 'admin' | 'home' | 'memos' | 'packstart' | 'umzug';
  id?: string;
  /** Whiteboard bzw. Packliste statt Markdown. */
  kind?: 'board' | 'pack';
  exists?: boolean;
  siteKey?: string;
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

/** Konto-Teil der Startdaten: wer angemeldet ist (ohne Google-ID), ob Anmelden geht, ob Admin. */
export function accountBoot(user: User | null, env: Env): Pick<Boot, 'user' | 'login' | 'admin'> {
  return {
    user: user ? { name: user.name, email: user.email, picture: user.picture } : null,
    login: !!env.GOOGLE_CLIENT_ID || env.DEV_LOGIN === '1',
    admin: isAdminUser(user, env),
  };
}

/** Eigene App auf dem Homescreen: Memos und Packliste haben eigenes Manifest und Icon. */
export interface AppHead { manifest: string; title: string; icon: string }
export const MD_APP: AppHead = { manifest: '/manifest.webmanifest', title: 'md', icon: '/apple-touch-icon.png' };
export const MEMOS_APP: AppHead = { manifest: '/memos.webmanifest', title: 'Memos', icon: '/memos-touch-icon.png' };
export const PACK_APP: AppHead = { manifest: '/pack.webmanifest', title: 'Packliste', icon: '/pack-touch-icon.png' };

type Theme = 'light' | 'dark' | '';

/** Fest gewählte Darstellung aus den Einstellungen (Cookie md_theme), sonst ''. */
function themeOf(req: Request): Theme {
  const m = /(?:^|;\s*)md_theme=(light|dark)(?:;|$)/.exec(req.headers.get('cookie') || '');
  return m ? (m[1] as Theme) : '';
}

/** <html>-Tag und Farb-Metas passend zur Darstellung. */
function themeHead(theme: Theme): { html: string; metas: string } {
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

/** Eine App-Seite: Gerüst, Startdaten, Skript und Stil aus dem Build. */
export function page(req: Request, title: string, body: string, boot: Boot, status = 200, app: AppHead = MD_APP): Response {
  const th = themeHead(themeOf(req));
  const exists = boot.page !== 'doc' || boot.exists ? '1' : '0';
  const bootJson = JSON.stringify({ ...boot, katexCss: manifest.katexCss, build: manifest.js.replace(/^.*-|\.js$/g, '') }).replace(/</g, '\\u003c');
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
<script id="boot" type="application/json">${bootJson}</script>
${body}
</body>
</html>`;
  return new Response(html, {
    status,
    headers: {
      ...SECURITY_HEADERS,
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      // Für den Service Worker: leere „neues Dokument“-Seiten nicht speichern.
      'x-md-exists': exists,
    },
  });
}

/** /<id>.md: reines Markdown (für Agenten, mit `download` als Datei). */
export function rawMarkdown(info: { exists: boolean; markdown: string; trashed?: number }, id: string, download: boolean): Response {
  const plain = { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' };
  if (info.trashed) return new Response('Dokument wurde gelöscht.\n', { status: 410, headers: plain });
  if (!info.exists) return new Response('Dokument nicht gefunden.\n', { status: 404, headers: plain });
  const headers: Record<string, string> = {
    'content-type': 'text/markdown; charset=utf-8',
    'cache-control': 'no-store',
    'x-robots-tag': 'noindex, nofollow',
    'x-content-type-options': 'nosniff',
  };
  if (download) headers['content-disposition'] = `attachment; filename*=UTF-8''${encodeURIComponent(id)}.md`;
  return new Response(info.markdown, { headers });
}

/** Datenschutzerklärung (verlangt Google für den Login). Ohne Skript, nur Text. */
export function privacyPage(req: Request): Response {
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
  return new Response(html, { headers: { ...SECURITY_HEADERS, 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' } });
}
