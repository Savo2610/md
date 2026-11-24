// md.veerka.mp – Markdown-Dokumente ohne Login.
//
// Adressen:
//   /                    neues Dokument mit zufälliger ID (Weiterleitung;
//                        /#board → neues Whiteboard, /#pack → neue Packliste,
//                        /#text=<Markdown> → neues Dokument mit diesem Text;
//                        der Browser behält das #…). Agenten statt Browser
//                        bekommen hier die Anleitung aus /llms.txt.
//   /llms.txt            Anleitung für KI-Agenten (agents.ts)
//   /<id>                Dokument ansehen; gibt es das noch nicht, öffnet
//                        sich der Editor und legt es beim ersten Tippen an
//   /<id>.md             reines Markdown (für Agenten, ?download=1 zum Speichern)
//   /home                Übersicht: zuletzt geöffnet, Konto, Papierkorb
//   /admin               Übersicht aller Dokumente (2FA-Code)
//   /memos               private Kurznotizen des Kontos (wie ein Chat mit sich selbst)
//   /pack                Packlisten-App: zuletzt benutzte Liste (bzw. eine neue)
//   /pack/<id>           Packliste (eigener Bereich, damit die installierte
//                        Packlisten-App nicht auch /memos übernimmt);
//                        /<id> einer Packliste leitet hierher weiter
//   /pack/new            neue Packliste mit zufälliger ID
//   /pack/umzug          Umzug aus der alten Packliste (packliste.ts)
//   /i/<id>/<datei>      Bilder aus R2
//   /m/<datei>           Memo-Anhang, nur fürs eigene Konto
//   /datenschutz         Datenschutzerklärung
//
// API (JSON, api.ts):
//   POST   /api/docs                 Agent legt Dokument an (Bearer API_KEY; ohne Schlüssel
//                                    zufällige Adresse, 200 000 Zeichen, 20 pro Tag und IP)
//   GET    /api/docs/<id>            Dokument als JSON
//   PUT    /api/docs/<id>            Inhalt ersetzen (Bearer API_KEY/Admin oder X-Edit-Key)
//   DELETE /api/docs/<id>            endgültig löschen (Admin; Ersteller nur aus dem Papierkorb)
//   POST   /api/docs/<id>/trash      in den Papierkorb (X-Owner-Key oder Admin)
//   POST   /api/docs/<id>/restore    aus dem Papierkorb holen (X-Owner-Key oder Admin)
//   POST   /api/docs/<id>/create     Browser legt Dokument an (Turnstile; { kind: 'board' | 'pack' })
//   POST   /api/docs/<id>/images     Bild hochladen (X-Edit-Key)
//   POST   /api/docs/<id>/pin        behalten ja/nein (Admin)
//   POST   /api/docs/<id>/rename     neue Adresse (X-Edit-Key); die alte leitet weiter
//   GET    /api/docs/<id>/title?url= Titel bzw. Bild für eingefügte Links (X-Edit-Key)
//   GET    /api/docs/<id>/ws         WebSocket fürs gemeinsame Bearbeiten
//   GET    /api/fx                   Wechselkurse fürs Rechnen im Text (EZB, pro 1 EUR)
//   POST   /api/unlock               2FA-Code → Bearbeitungsschlüssel für ein Dokument,
//                                    oder (ohne Dokument) Admin-Token für /admin
//   GET    /api/admin/docs           Übersicht (Admin)
//   POST   /api/admin/memos          Memos fürs Admin-Konto vorbereiten ({ memos: [{ text, created }] }),
//                                    sie wandern beim nächsten Öffnen von /memos hinein
//   GET    /api/pack/umzug           alte Packlisten des Kontos; POST zieht sie um
//
// Konto (optional, Google-Login, siehe auth.ts; Cookie md_session):
//   GET    /auth/login, /auth/callback, POST /auth/logout
//   GET    /api/me                   Konto und Dokumentliste
//   POST   /api/me/docs              Dokumente eintragen/aktualisieren ({ items })
//   PUT    /api/me/docs/<id>/tags    Tags setzen ({ tags })
//   DELETE /api/me/docs/<id>         aus der Liste nehmen (Dokument bleibt)
//   DELETE /api/me                   Konto samt Liste löschen
//
// Memos (memos.ts):
//   GET    /api/me/memos             Memos ({ memos })
//   POST   /api/me/memos             Memo anlegen ({ id, text, created? }, ID vom Browser)
//   PUT    /api/me/memos/<id>        Text ändern ({ text })
//   DELETE /api/me/memos/<id>        Memo löschen (samt Anhängen, die sonst nirgends vorkommen)
//   POST   /api/me/memos/files       Anhang hochladen (Rohdaten, Name in X-File-Name), liefert { url: /m/<datei> }
//   POST   /api/me/memos/geo         Ortsname zu Koordinaten ({ lat, lon }, OpenStreetMap Nominatim)
//   POST   /api/me/memos/<id>/funk   Memo auf funk.veerka.mp senden (nur Admin-Konto)
//   POST   /api/me/memos/<id>/doc    Memo als md-Dokument (verknüpft), liefert { doc, url }
//
// Weitere Domains: memos.veerka.mp → /memos, board.veerka.mp und wb.veerka.mp
// → neues Board, pack.veerka.mp → Packliste.

import { render } from '../shared/render';
import { tagsOf } from '../shared/tags';
import { randomId } from './crypto';
import { auth, currentUser } from './auth';
import { normalizeId } from './access';
import { api } from './api';
import { agentGuide, isAgent } from './agents';
import { accountStub, docStub, type Env } from './env';
import { serveFile } from './files';
import { ratesFor } from './fx';
import { decodeURIComponentSafe, fail, moved, notFound, redirect, text } from './http';
import { memoFile, memosPage } from './memos';
import { accountBoot, MD_APP, page, PACK_APP, privacyPage, rawMarkdown } from './pages';

export { Doc } from './doc';
export { Registry } from './registry';
export { Account } from './account';

/** Statische Dateien, die direkt aus public/ kommen. */
const STATIC_FILES = new Set(['/favicon.svg', '/sw.js', '/manifest.webmanifest', '/memos.webmanifest', '/pack.webmanifest', '/apple-touch-icon.png', '/memos-touch-icon.png', '/pack-touch-icon.png']);

const APP = '<main id="app"></main>';

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;

    // Die alte Memos-Instanz lag auf memos.veerka.mp.
    if (url.hostname === 'memos.veerka.mp') return redirect('https://md.veerka.mp/memos', 301);
    // Abkürzungen fürs Whiteboard: board.veerka.mp öffnet ein neues Board,
    // board.veerka.mp/retro das Board „retro“ (bzw. legt es als Board an).
    if (url.hostname === 'board.veerka.mp' || url.hostname === 'wb.veerka.mp') return redirect(`https://md.veerka.mp${path}#board`);
    // Dasselbe für Packlisten. Ohne Pfad: zuletzt benutzte Packliste (/pack).
    if (url.hostname === 'pack.veerka.mp') return redirect(path === '/' ? 'https://md.veerka.mp/pack' : `https://md.veerka.mp/pack${path}`);

    if (/^\/(assets|fonts|icons)\//.test(path) || STATIC_FILES.has(path)) return env.ASSETS.fetch(req);
    if (path === '/robots.txt') {
      // Keine Sperre: KI-Assistenten, die ein Nutzer einen Link lesen lässt
      // (Claude-User, ChatGPT-User …), halten sich an robots.txt. Aus
      // Suchmaschinen hält die Seiten der Header X-Robots-Tag: noindex fern.
      // Trainings-Crawler sperrt Cloudflare (verwaltete robots.txt davor).
      return text('# Dokumente sind per noindex von Suchmaschinen ausgenommen.\n# KI-Agenten: https://md.veerka.mp/llms.txt\n', 200, { 'cache-control': 'public, max-age=86400' });
    }
    if (path === '/llms.txt') return agentGuide(url.origin);
    if (path.startsWith('/auth/')) {
      try {
        return await auth(req, env, url);
      } catch (err) {
        console.error(err);
        return text('Anmeldung fehlgeschlagen.', 500);
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

    switch (path) {
      case '/': return isAgent(req) ? agentGuide(url.origin) : redirect(`/${randomId()}`);
      case '/home': return page(req, 'md', APP, { page: 'home', ...accountBoot(await currentUser(req, env), env) });
      case '/admin': return page(req, 'Übersicht', APP, { page: 'admin', admin: accountBoot(await currentUser(req, env), env).admin });
      case '/memos': return memosPage(req, env, ctx);
      case '/pack':
      case '/pack/umzug':
        return page(req, 'Packliste', APP, { page: path === '/pack' ? 'packstart' : 'umzug', ...accountBoot(await currentUser(req, env), env) }, 200, PACK_APP);
      case '/pack/new': return redirect(`/pack/${randomId()}`);
      case '/datenschutz': return privacyPage(req);
    }

    if (path.startsWith('/pack/')) {
      const seg = path.slice(6).replace(/\/+$/, '');
      const id = seg.includes('/') ? null : normalizeId(seg);
      if (!id) return notFound();
      if (!isCanonical(seg, id)) return redirect(`/pack/${encodeURIComponent(id)}${url.search}`, 301);
      return docPage(req, env, ctx, id, true);
    }
    if (path.startsWith('/m/')) return memoFile(req, env, path.slice(3));
    if (path.startsWith('/i/')) {
      const [, , doc, file] = path.split('/');
      const id = doc ? normalizeId(doc) : null;
      if (!id || !file || !/^[\w-]+\.\w+$/.test(file)) return notFound();
      return (await serveFile(req, env.IMAGES, `${id}/${file}`, file)) ?? notFound();
    }

    // /<id>.md → reines Markdown
    const mdMatch = /^\/([^/]+)\.md$/.exec(path);
    if (mdMatch) {
      const id = normalizeId(mdMatch[1]);
      if (!id) return notFound();
      const info = await docStub(env, id).info(true);
      if (info.movedTo) return moved(info.movedTo, '.md' + url.search);
      return rawMarkdown(info, id, url.searchParams.has('download'));
    }

    const seg = path.slice(1).replace(/\/+$/, '');
    if (seg.includes('/')) return notFound();
    const id = normalizeId(seg);
    if (!id) return text('Ungültige Adresse', 404);
    // Kanonische Schreibweise erzwingen (Großbuchstaben, Leerzeichen …).
    if (!isCanonical(seg, id)) return redirect(`/${encodeURIComponent(id)}${url.search}`, 301);
    return docPage(req, env, ctx, id);
  },
} satisfies ExportedHandler<Env>;

/** Steht die ID schon so in der Adresse, wie normalizeId() sie liefert? */
const isCanonical = (seg: string, id: string) => encodeURIComponent(id) === seg || decodeURIComponentSafe(seg) === id;

/**
 * Seite eines Dokuments, Boards oder einer Packliste. `asPack`: aufgerufen
 * als /pack/<id>. Packlisten gehören dorthin (eigener Bereich der
 * Packlisten-App), alles andere nach /<id>.
 */
async function docPage(req: Request, env: Env, ctx: ExecutionContext, id: string, asPack = false): Promise<Response> {
  const [info, user] = await Promise.all([docStub(env, id).info(true), currentUser(req, env)]);
  if (info.movedTo) return moved(info.movedTo, '');
  const search = new URL(req.url).search;
  if (asPack && info.exists && info.kind !== 'pack') return redirect(`/${encodeURIComponent(id)}${search}`);
  if (!asPack && info.kind === 'pack' && !info.trashed) return redirect(`/pack/${encodeURIComponent(id)}${search}`);
  const accept = req.headers.get('accept') || '';
  if (accept.includes('text/markdown') && !accept.includes('text/html')) return rawMarkdown(info, id, false);

  const common = { page: 'doc' as const, id, ...accountBoot(user, env) };
  if (!info.exists) {
    // Angemeldet braucht es keinen Spam-Schutz.
    const siteKey = user ? undefined : env.TURNSTILE_SITEKEY;
    if (asPack) return page(req, 'Packliste', APP, { ...common, exists: false, kind: 'pack', siteKey }, 200, PACK_APP);
    return page(req, 'Neues Dokument', APP, { ...common, exists: false, siteKey });
  }

  const acc = user ? accountStub(env, user.sub) : null;
  const entry = acc ? await acc.get(id) : null;
  // #tags aus dem Text und die Art in die eigene Dokumentliste übernehmen
  // (im Hintergrund, die Seite wartet nicht darauf).
  if (acc && entry && !info.trashed) {
    const textTags = tagsOf(info.markdown);
    const kind = info.kind && info.kind !== 'md' ? info.kind : '';
    const updates: Promise<unknown>[] = [];
    if (JSON.stringify(textTags) !== JSON.stringify(entry.textTags)) updates.push(acc.setTextTags(id, textTags));
    if (kind !== (entry.kind || '')) updates.push(acc.setKind(id, kind));
    if (updates.length) ctx.waitUntil(Promise.all(updates));
  }
  const keys = { editKey: entry?.editKey || undefined, ownerKey: entry?.ownerKey || undefined };

  if (info.trashed) {
    // Für alle weg. Der Ersteller holt sich den Inhalt im Browser mit seinem Schlüssel.
    return page(req, 'Gelöscht', APP, { ...common, exists: true, trashed: info.trashed, ownerKey: keys.ownerKey }, 410, asPack ? PACK_APP : MD_APP);
  }
  const title = info.title || id;
  if (info.kind === 'board' || info.kind === 'pack') {
    return page(req, title, APP, { ...common, exists: true, kind: info.kind, ...keys }, 200, info.kind === 'pack' ? PACK_APP : MD_APP);
  }
  await ratesFor([info.markdown]);
  const { html } = render(info.markdown);
  return page(req, title, `<main id="app"><article class="doc" id="view">${html}</article></main>`, { ...common, exists: true, ...keys });
}
