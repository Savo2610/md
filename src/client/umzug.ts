// /pack: zuletzt benutzte Packliste öffnen (Start der installierten App,
// pack.veerka.mp ohne Pfad). /pack/umzug: Listen aus der alten Packliste
// übernehmen (der Server liest sie aus Firebase, siehe worker/packliste.ts).
//
// Nach dem Umzug merkt sich der Browser das (md:pack:umgezogen). Danach führt
// /pack/umzug direkt zu den Listen. Kommt man aus der alten App
// (packliste.veerka.mp hängt ?von=packliste an), zeigt die Seite stattdessen
// nur noch „neue App installieren, alte löschen“.

import { el, store, recent, toast } from './ui';
import { account } from './account';

const LISTS_KEY = 'md:pack:lists';
const ORDER_KEY = 'md:pack:order';
const MOVED_KEY = 'md:pack:umgezogen';

/** Als installierte App gestartet (dann gibt es nichts mehr zu installieren). */
const standalone = () => matchMedia('(display-mode: standalone)').matches || (navigator as unknown as { standalone?: boolean }).standalone === true;

// Chrome bietet das Installieren über dieses Ereignis an; aufheben für den Knopf.
interface InstallPrompt extends Event { prompt(): Promise<void>; userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }> }
let installPrompt: InstallPrompt | null = null;
const promptListeners: (() => void)[] = [];
addEventListener('beforeinstallprompt', e => {
  e.preventDefault();
  installPrompt = e as InstallPrompt;
  for (const fn of promptListeners) fn();
});

interface Boot { user?: { name: string; email: string } | null; login?: boolean }

export async function startPackStart() {
  // Angemeldet auf einem neuen Gerät: erst die Liste aus dem Konto holen.
  if (account.user) await Promise.race([account.sync(true), new Promise(r => setTimeout(r, 2500))]);
  const last = recent.list().filter(r => r.kind === 'pack' && !r.trashed).sort((a, b) => b.at - a.at)[0];
  location.replace(last ? `/${encodeURIComponent(last.id)}` : '/#pack');
}

interface Found { id: string; title: string; count: number; shared: boolean; moved: boolean }
interface Moved { id: string; editKey: string; ownerKey: string | null; title: string; created: boolean; items: { name: string; qty: number; mode: string; cat: string }[] }

export function startUmzug(boot: Boot) {
  const fromOldApp = new URLSearchParams(location.search).has('von');
  // Schon umgezogen: aus der alten App nur noch der Hinweis zur neuen App, sonst direkt zu den Listen.
  if (store.get(MOVED_KEY) && (!fromOldApp || standalone())) { location.replace('/pack'); return; }

  document.body.dataset.mode = 'view';
  document.body.prepend(el('header', { id: 'bar' },
    el('div', { class: 'bar-left' }, el('a', { class: 'brand', href: '/pack' }, 'md')),
    el('nav', { class: 'bar-right' }),
  ));
  const main = el('div', { class: 'umzug' });
  document.querySelector('#app')!.append(main);
  const head = el('h1', {}, 'Packliste umziehen');
  const body = el('div', { class: 'umzug-body' });
  main.append(head, body);

  const button = (label: string, run: () => void, cls = 't boxed') => {
    const b = el('button', { type: 'button', class: cls }, label);
    b.addEventListener('click', run);
    return b;
  };

  if (store.get(MOVED_KEY)) { done(0, ''); return; }

  if (!boot.user) {
    body.append(
      el('p', { class: 'umzug-meta' }, 'Mit dem Google-Konto der alten Packliste anmelden.'),
      boot.login ? button('Mit Google anmelden', () => account.login(`/pack/umzug${location.search}`), 't boxed strong') : el('p', { class: 'umzug-meta' }, 'Anmelden ist hier nicht eingerichtet.'),
    );
    return;
  }

  body.append(el('p', { class: 'umzug-meta' }, 'Suche Listen …'));
  load();

  async function load() {
    const res = await fetch('/api/pack/umzug', { cache: 'no-store' }).catch(() => null);
    const data = await res?.json().catch(() => null) as { found?: boolean; lists?: Found[]; error?: string } | null;
    body.replaceChildren();
    if (!res?.ok || !data) {
      body.append(el('p', { class: 'umzug-meta' }, data?.error || 'Keine Verbindung.'), button('Nochmal', () => { body.replaceChildren(el('p', { class: 'umzug-meta' }, 'Suche Listen …')); load(); }));
      return;
    }
    if (!data.found || !data.lists?.length) {
      body.append(
        el('p', { class: 'umzug-meta' }, `Zu ${account.user?.email || 'diesem Konto'} gibt es keine Listen in der alten Packliste.`),
        button('Anderes Google-Konto', async () => { await fetch('/auth/logout', { method: 'POST' }).catch(() => {}); account.login(`/pack/umzug${location.search}`); }),
      );
      return;
    }
    const lists = data.lists;
    // Alles schon umgezogen (anderes Gerät): Schlüssel still holen, nichts mehr zeigen.
    if (lists.every(l => l.moved)) {
      body.replaceChildren(el('p', { class: 'umzug-meta' }, 'Öffne Listen …'));
      run(null);
      return;
    }
    const ul = el('ul', { class: 'umzug-lists' });
    for (const l of lists) {
      const meta = [`${l.count} Artikel`, l.shared ? 'geteilt' : '', l.moved ? 'schon umgezogen' : ''].filter(Boolean).join(' · ');
      ul.append(el('li', {}, el('span', { class: 'umzug-title' }, l.title), el('span', { class: 'umzug-meta' }, meta)));
    }
    const fresh = lists.filter(l => !l.moved).length;
    const go = button(fresh ? `${lists.length === 1 ? 'Liste' : `${lists.length} Listen`} übernehmen` : 'Öffnen', () => run(go), 't boxed strong');
    body.append(ul, el('div', { class: 'umzug-foot' }, go));
  }

  async function run(go: HTMLButtonElement | null) {
    if (go) { go.disabled = true; go.textContent = 'Übernehme …'; }
    const res = await fetch('/api/pack/umzug', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).catch(() => null);
    const data = await res?.json().catch(() => null) as { lists?: Moved[]; error?: string } | null;
    if (!res?.ok || !data?.lists) {
      if (go) { go.disabled = false; go.textContent = 'Nochmal'; }
      toast(data?.error || 'Ging nicht. Keine Verbindung?');
      return;
    }
    remember(data.lists);
    store.set(MOVED_KEY, '1');
    const first = data.lists[0]?.id || '';
    // Als neue App gestartet: gleich zu den Listen. Sonst erst die App anbieten.
    if (standalone() || (!go && !fromOldApp)) { location.replace(first ? `/${encodeURIComponent(first)}` : '/pack'); return; }
    done(go ? data.lists.length : 0, first);
  }

  /** Fertig: neue App installieren, alte löschen, weiter zu den Listen. */
  function done(count: number, first: string) {
    head.textContent = count ? 'Umgezogen' : 'Neue Packliste-App';
    body.replaceChildren();
    if (count) body.append(el('p', { class: 'umzug-meta' }, `${count === 1 ? 'Eine Liste' : `${count} Listen`} übernommen.`));

    const steps = el('ol', { class: 'umzug-steps' });
    const install = el('li', {});
    const drawInstall = () => {
      install.replaceChildren();
      if (installPrompt) {
        install.append(button('Als App installieren', async () => {
          const p = installPrompt!;
          installPrompt = null;
          await p.prompt();
          const { outcome } = await p.userChoice;
          drawInstall();
          if (outcome === 'accepted') install.replaceChildren(el('span', {}, 'Neue App installiert'));
        }, 't boxed strong'));
        return;
      }
      const ua = navigator.userAgent;
      if (/iPhone|iPad|iPod/.test(ua)) {
        install.append(el('span', {}, 'Neue App: Teilen ', el('span', { class: 'umzug-key' }, '↑'), ' → „Zum Home-Bildschirm“'));
      } else if (/Android/.test(ua)) {
        // Aus der alten App heraus öffnet Chrome nur ein eingebettetes Fenster; dort gibt es kein Installieren.
        const url = new URL('/pack/umzug?von=packliste', location.href);
        const intent = `intent://${url.host}${url.pathname}${url.search}#Intent;scheme=https;package=com.android.chrome;end`;
        install.append(
          el('span', {}, 'Neue App: in Chrome ', el('span', { class: 'umzug-key' }, '⋮'), ' → „App installieren“'),
          el('a', { class: 't boxed umzug-open', href: intent }, 'In Chrome öffnen'),
        );
      } else {
        install.append(el('span', {}, 'Neue App: im Browser-Menü „Installieren“ bzw. „Zum Startbildschirm“'));
      }
    };
    drawInstall();
    promptListeners.push(drawInstall);
    addEventListener('appinstalled', () => install.replaceChildren(el('span', {}, 'Neue App installiert')));
    steps.append(install, el('li', {}, 'Alte Packliste-App vom Startbildschirm löschen'));
    body.append(steps, el('div', { class: 'umzug-foot' },
      el('a', { class: 't boxed', href: first ? `/${encodeURIComponent(first)}` : '/pack' }, 'Zu den Listen')));
  }
}

/** Schlüssel, „Zuletzt geöffnet“, Reiter-Reihenfolge und Vorschau für die übernommenen Listen. */
function remember(lists: Moved[]) {
  let snaps: Record<string, unknown> = {};
  try { snaps = JSON.parse(store.get(LISTS_KEY) || '{}') || {}; } catch { /* neu */ }
  let order: string[] = [];
  try { order = JSON.parse(store.get(ORDER_KEY) || '[]'); } catch { /* neu */ }
  // Rückwärts, damit die erste Liste in „Zuletzt geöffnet“ oben steht.
  for (const l of [...lists].reverse()) {
    store.set(`md:key:${l.id}`, l.editKey);
    if (l.ownerKey) store.set(`md:owner:${l.id}`, l.ownerKey);
    recent.touch(l.id, l.title, true, undefined, 'pack');
    if (l.created) {
      snaps[l.id] = { title: l.title, at: Date.now(), open: l.items.length, items: l.items.map(i => ({ ...i, done: false })) };
    }
  }
  for (const l of lists) if (!order.includes(l.id)) order.push(l.id);
  store.set(LISTS_KEY, JSON.stringify(snaps));
  store.set(ORDER_KEY, JSON.stringify(order));
}
