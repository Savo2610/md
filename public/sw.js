// Service Worker für md.veerka.mp: die App startet und arbeitet auch offline.
//
//  - Grundgerüst (JS, CSS, Schriften, Icons) wird beim Installieren vorab
//    gespeichert. Die Liste erzeugt der Build (/assets/precache.json).
//  - Dateien unter /assets, /fonts, /icons haben einen Hash im Namen und
//    ändern sich nie: aus dem Speicher, sonst aus dem Netz (und merken).
//  - Seiten: erst das Netz, damit man den neuesten Stand sieht; ohne Netz
//    die zuletzt gespeicherte Fassung, notfalls die Übersicht (/home).
//  - Bilder unter /i/ ändern sich nie: aus dem Speicher.
//  - /api/ und /auth/ (Anmelden) gehen immer ans Netz.
//
// Registriert wird /sw.js?v=<build>. Jeder Deploy installiert dadurch einen
// neuen Worker, der die Dateien des alten Builds wegräumt.

const VERSION = new URL(self.location.href).searchParams.get('v') || 'dev';
const STATIC = `md-static-${VERSION}`;
const PAGES = 'md-pages';
const IMAGES = 'md-images';

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(STATIC);
    try {
      const res = await fetch('/assets/precache.json', { cache: 'no-store' });
      const files = await res.json();
      await cache.addAll(files);
    } catch {
      // Ohne Liste lernt der Speicher eben beim Benutzen.
    }
    try {
      const pages = await caches.open(PAGES);
      await pages.add(new Request('/home', { cache: 'no-store' }));
    } catch { /* offline installiert */ }
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key.startsWith('md-static-') && key !== STATIC) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/auth/') || url.pathname === '/sw.js') return;

  if (/^\/(assets|fonts|icons)\//.test(url.pathname) || ['/favicon.svg', '/manifest.webmanifest', '/apple-touch-icon.png'].includes(url.pathname)) {
    event.respondWith(cacheFirst(req, STATIC));
    return;
  }
  if (url.pathname.startsWith('/i/')) {
    event.respondWith(cacheFirst(req, IMAGES));
    return;
  }
  if (req.mode === 'navigate' || url.pathname.endsWith('.md')) {
    event.respondWith(networkFirst(req));
  }
});

async function cacheFirst(req, name) {
  const hit = await caches.match(req, { ignoreSearch: true });
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok) (await caches.open(name)).put(req, res.clone());
  return res;
}

async function networkFirst(req) {
  const cache = await caches.open(PAGES);
  // „/“ legt jedes Mal ein neues Dokument an – das nicht speichern.
  const key = new URL(req.url).pathname === '/' ? null : req;
  try {
    const res = await fetch(req);
    // Nur echte Seiten merken (keine Weiterleitungen, keine Fehler).
    // Seiten für noch nicht angelegte Dokumente nicht merken: offline
    // würden sie sonst ein neues Dokument anlegen wollen.
    if (key && res.ok && !res.redirected && res.headers.get('x-md-exists') !== '0') cache.put(key, res.clone());
    return res;
  } catch {
    const hit = key && (await cache.match(key, { ignoreSearch: true }));
    if (hit) return hit;
    const home = await cache.match('/home');
    if (home) return home;
    return new Response('Offline – diese Seite wurde noch nie geöffnet.', { status: 503, headers: { 'content-type': 'text/plain; charset=utf-8' } });
  }
}
