// Einstieg im Browser. Die Ansicht kommt fertig gerendert vom Server; hier
// kommen Kopfleiste, Modi (Ansicht / Bearbeiten / Geteilt), Teilen,
// Umbenennen und Freischalten dazu. Der Editor wird erst beim Bearbeiten
// nachgeladen.

import { enhance } from './enhance';
import type { EditorHandle, EditorStatus } from './editor';
import { titleOf, slugify } from '../shared/title';
import { $, el, dialog, toast, store, adminHeaders, isAdmin, setAccountAdmin, unlockDialog, recent, ago, menu, type MenuItem } from './ui';
import { account, accountItems, type User } from './account';

interface Boot {
  page: 'doc' | 'admin' | 'home';
  build?: string;
  id?: string;
  exists?: boolean;
  siteKey?: string;
  katexCss?: string;
  user?: User | null;
  login?: boolean;
  editKey?: string;
  admin?: boolean;
}

const boot: Boot = JSON.parse($('#boot')!.textContent || '{}');
account.init(boot);
setAccountAdmin(!!boot.admin);

/** Als App vom Homescreen gestartet (nicht im Browser-Tab). */
const standalone = matchMedia('(display-mode: standalone)').matches || (navigator as unknown as { standalone?: boolean }).standalone === true;
/** Schmaler Bildschirm: kompakte Leiste mit Bearbeiten/Fertig und Menü als Blatt. */
const compactQuery = matchMedia('(max-width: 600px)');
if (standalone) document.documentElement.classList.add('standalone');

type Mode = 'view' | 'edit' | 'split';

const ICONS = {
  saved: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7"/></svg>',
  saving: '<svg viewBox="0 0 16 16" aria-hidden="true" class="spin"><path d="M8 2.5a5.5 5.5 0 1 1-5.5 5.5"/></svg>',
  offline: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 12.5h7a3 3 0 0 0 .4-6 4 4 0 0 0-7.6 1A2.5 2.5 0 0 0 4.5 12.5zM2.5 2.5l11 11"/></svg>',
};

function startDoc(boot: Boot) {
  const id = boot.id!;
  let exists = !!boot.exists;
  const keyName = `md:key:${id}`;
  const OPEN_EDIT = 'md:open-edit';

  // Bearbeiten-Link: #edit=<schlüssel> merken, aus der Adresszeile nehmen und
  // direkt im Bearbeiten-Modus öffnen.
  let startInEdit = false;
  const hash = /^#edit=([\w-]+)$/.exec(location.hash);
  if (hash) {
    store.set(keyName, hash[1]);
    history.replaceState(null, '', location.pathname + location.search);
    startInEdit = true;
  }
  try {
    if (sessionStorage.getItem(OPEN_EDIT) === id) { startInEdit = true; sessionStorage.removeItem(OPEN_EDIT); }
  } catch { /* egal */ }
  // Angemeldet: Schlüssel aus dem Konto (z. B. auf einem neuen Gerät).
  if (boot.editKey && !store.get(keyName)) store.set(keyName, boot.editKey);

  let editKey = store.get(keyName);
  const canEdit = () => !exists || !!editKey;

  const app = $('#app')!;
  const article: HTMLElement = $<HTMLElement>('#view') ?? app.appendChild(el('article', { class: 'doc', id: 'view' }));
  const workspace = el('div', { class: 'workspace' });
  const editorPane = el('div', { class: 'pane-editor' });
  const previewPane = el('div', { class: 'pane-preview' });
  const preview = el('article', { class: 'doc' });
  previewPane.append(preview);
  workspace.append(editorPane, previewPane);
  app.append(workspace);

  if (exists) recent.touch(id, document.title === id ? '' : document.title, !!editKey);

  // ── Kopfleiste ────────────────────────────────────────────────────────────

  const bar = el('header', { id: 'bar' });
  const left = el('div', { class: 'bar-left' });
  const right = el('nav', { class: 'bar-right' });
  // In der installierten App führt „md“ zurück zur Übersicht, im Browser
  // öffnet es das kleine Menü mit „Neues Dokument“ und den letzten Dokumenten.
  const brand = standalone
    ? el('a', { class: 'brand', href: '/home', title: 'Alle Dokumente' }, '‹ md')
    : el('button', { type: 'button', class: 'brand', title: 'Neues Dokument und zuletzt geöffnete', 'aria-haspopup': 'dialog' }, 'md');
  if (!standalone) brand.addEventListener('click', openRecent);
  const status = el('span', { class: 'status', role: 'status' });
  const peers = el('span', { class: 'peers' });
  left.append(brand, status, peers);
  bar.append(left, right);
  document.body.prepend(bar);

  let mode: Mode = exists && !startInEdit ? 'view' : 'edit';
  let spellcheck = store.get('md:spellcheck') !== '0';
  let editor: EditorHandle | null = null;
  let editorLoading: Promise<EditorHandle> | null = null;
  let lastStatus: EditorStatus | null = null;

  const button = (label: string, title: string, onClick: () => void, cls = 't') => {
    const b = el('button', { type: 'button', class: cls, title }, label);
    b.addEventListener('click', onClick);
    return b;
  };

  compactQuery.addEventListener('change', () => {
    if (compactQuery.matches && mode === 'split') setMode('edit');
    else renderBar();
  });

  function renderBar() {
    right.replaceChildren();
    if (compactQuery.matches) {
      // Handy: ein Knopf wie in Notizen-Apps, alles andere im Menü.
      if (canEdit()) {
        right.append(mode === 'view'
          ? button('Bearbeiten', 'Bearbeiten', () => setMode('edit'), 't strong')
          : button('Fertig', 'Fertig – zur Ansicht', () => setMode('view'), 't strong'));
      }
      right.append(button('⋯', 'Mehr', more, 't more'));
      renderStatus();
      return;
    }
    if (canEdit()) {
      // Umschalter: immer an derselben Stelle, der aktive Modus ist unterstrichen.
      const sw = el('div', { class: 'switch', role: 'tablist', 'aria-label': 'Modus' });
      const modes: [Mode, string, string][] = [
        ['view', 'Ansicht', 'Ansicht (⌘E)'],
        ['edit', 'Bearbeiten', 'Bearbeiten (⌘E)'],
        ['split', 'Geteilt', 'Editor und Vorschau nebeneinander'],
      ];
      for (const [m, label, title] of modes) {
        const b = el('button', { type: 'button', role: 'tab', title, 'aria-selected': String(mode === m), class: m === 'split' ? 'wide-only' : '' }, label);
        b.addEventListener('click', () => setMode(m));
        sw.append(b);
      }
      right.append(sw, el('span', { class: 'sep', 'aria-hidden': 'true' }));
    }
    right.append(button('Teilen', 'Links zum Teilen', share));
    right.append(button('⋯', 'Mehr', more, 't more'));
    renderStatus();
  }

  function renderStatus() {
    const s = lastStatus;
    let icon = '', title = '', state = '';
    if (mode !== 'view' && exists && s) {
      if (s.status === 'offline') { icon = ICONS.offline; title = 'Offline – auf diesem Gerät gespeichert, wird nachgereicht, sobald die Verbindung wieder da ist'; state = 'offline'; }
      else if (s.status === 'connecting' || !s.synced) { icon = ICONS.saving; title = 'Verbinde …'; state = 'busy'; }
      else if (s.pending) { icon = ICONS.saving; title = 'Speichert …'; state = 'busy'; }
      else if (s.status === 'online') { icon = ICONS.saved; title = 'Alles gespeichert'; state = 'saved'; }
    }
    status.innerHTML = icon;
    status.title = title;
    status.setAttribute('aria-label', title);
    status.dataset.state = state;

    peers.replaceChildren();
    const list = mode !== 'view' && s?.status === 'online' ? s.peers : [];
    for (const p of list.slice(0, 5)) {
      const dot = el('span', { class: 'peer', title: `${p.name} bearbeitet gerade` });
      dot.style.background = p.color;
      peers.append(dot);
    }
    if (list.length > 5) peers.append(el('span', { class: 'peer-more' }, `+${list.length - 5}`));
    peers.title = list.length ? `Gerade dabei: ${list.map(p => p.name).join(', ')}` : '';
  }

  // ── Modi ──────────────────────────────────────────────────────────────────

  async function loadEditor(): Promise<EditorHandle> {
    editorLoading ??= import('./editor').then(m => {
      const h = m.mountEditor({
        id,
        parent: editorPane,
        preview,
        katexCss: boot.katexCss,
        exists,
        name: store.get('md:name') || firstName(),
        spellcheck,
        wsUrl: () => {
          const u = new URL(`/api/docs/${encodeURIComponent(id)}/ws`, location.href);
          u.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
          if (editKey) u.searchParams.set('key', editKey);
          return u.toString();
        },
        auth: (): Record<string, string> => (editKey ? { 'x-edit-key': editKey } : {}),
        ensureCreated: create,
        onStatus: s => { lastStatus = s; renderStatus(); },
        onNotice: n => {
          if (n.type === 'hello' && n.edit === false && mode !== 'view') {
            // Schlüssel passt nicht (mehr): zurück in die Ansicht.
            store.del(keyName);
            editKey = null;
            toast('Keine Berechtigung zum Bearbeiten. Mit dem Bearbeiten-Link oder dem Code freischalten.');
            setMode('view');
          } else if (n.type === 'limit') {
            toast('Das Dokument hat die Maximalgröße erreicht.');
          } else if (n.type === 'moved' && n.to) {
            followMove(n.to);
          }
        },
        onTyping: startTyping,
        toast,
      });
      return h;
    });
    editor = await editorLoading;
    return editor;
  }

  async function setMode(next: Mode) {
    if (next !== 'view' && !canEdit()) return;
    if (next === 'split' && matchMedia('(max-width: 520px)').matches) next = 'edit';
    const prev = mode;
    mode = next;
    document.body.dataset.mode = mode;
    renderBar();
    if (mode === 'view') {
      document.body.classList.remove('typing');
      if (editor && prev !== 'view') {
        const { render } = await import('./editor');
        const r = render(editor.text());
        article.innerHTML = r.html;
        document.title = r.title || id;
        if (exists) recent.touch(id, r.title, true);
        enableTasks();
        enhance(article, boot.katexCss);
      }
      editor?.setPreview(false);
      scrollTo(0, 0);
      return;
    }
    const ed = await loadEditor();
    ed.setPreview(mode === 'split');
    if (prev === 'view' || !prev) requestAnimationFrame(() => ed.focus());
  }

  // ── Anlegen (beim ersten Tippen) ──────────────────────────────────────────

  const turnstile = boot.siteKey && !exists ? loadTurnstile(boot.siteKey) : null;

  async function create(): Promise<boolean> {
    const token = turnstile ? await turnstile.token().catch(() => '') : '';
    const res = await fetch(`/api/docs/${encodeURIComponent(id)}/create`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      toast(data.error || 'Anlegen fehlgeschlagen.');
      if (res.status === 409) setTimeout(() => location.reload(), 1500);
      turnstile?.reset();
      return false;
    }
    editKey = data.editKey;
    store.set(keyName, editKey!);
    exists = true;
    recent.touch(id, '', true);
    turnstile?.remove();
    renderBar();
    cachePage();
    return true;
  }

  // ── Umbenennen ────────────────────────────────────────────────────────────

  /** Umbenannt (hier oder von jemand anderem): mit Schlüssel zur neuen Adresse. */
  function followMove(to: string) {
    if (editKey) {
      store.set(`md:key:${to}`, editKey);
      store.del(keyName);
      try { sessionStorage.setItem(OPEN_EDIT, to); } catch { /* egal */ }
    }
    recent.rename(id, to);
    location.replace(`/${encodeURIComponent(to)}`);
  }

  async function rename(to: string): Promise<string | null> {
    if (!exists) {
      // Noch nichts angelegt: einfach unter der neuen Adresse anfangen.
      location.replace(`/${encodeURIComponent(to)}`);
      return null;
    }
    const res = await fetch(`/api/docs/${encodeURIComponent(id)}/rename`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-edit-key': editKey || '' },
      body: JSON.stringify({ to }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return data.error || 'Umbenennen fehlgeschlagen.';
    if (data.id !== id) {
      followMove(data.id);
      // Aus der Ansicht heraus umbenannt: auch dort weitermachen.
      if (mode === 'view') { try { sessionStorage.removeItem(OPEN_EDIT); } catch { /* egal */ } }
    }
    return null;
  }

  function renameDialog() {
    const isRandom = /^[a-z0-9]{10}$/.test(id) && /\d/.test(id) && /[a-z]/.test(id);
    // Vorschlag: aus dem Titel (erste Überschrift bzw. erste Zeile) des Dokuments.
    const title = editor ? titleOf(editor.text()) : document.title;
    const full = title === id || title === 'Neues Dokument' ? '' : slugify(title);
    const suggestion = full.length <= 60 ? full : full.slice(0, 60).replace(/-[^-]*$/, '');
    const input = el('input', { type: 'text', value: isRandom ? suggestion : id, placeholder: 'meine-anleitung', spellcheck: 'false', autocapitalize: 'off', 'aria-label': 'Neue Adresse' }) as HTMLInputElement;
    const save = el('button', { type: 'submit', class: 't boxed' }, 'Ändern');
    const err = el('p', { class: 'error' });
    const form = el('form', { class: 'sheet' },
      el('div', { class: 'field-row' },
        el('div', { class: 'field-line' }, el('div', { class: 'addr' }, el('span', { class: 'prefix' }, `${location.host}/`), input), save),
        el('p', { class: 'hint' }, `Buchstaben, Ziffern und Bindestriche. ${exists ? (isRandom ? 'Die bisherige Adresse leitet weiter.' : 'Die bisherige Adresse wird wieder frei; alte Links funktionieren dann nicht mehr.') : ''}`),
        err,
      ),
    );
    form.addEventListener('submit', async e => {
      e.preventDefault();
      const to = input.value.trim().toLowerCase().replace(/\s+/g, '-');
      if (!to || to === id) return;
      save.disabled = true;
      const problem = await rename(to);
      save.disabled = false;
      err.textContent = problem || '';
    });
    dialog('Adresse ändern', form);
    setTimeout(() => { input.focus(); input.select(); }, 30);
  }

  // ── Teilen: Links und eigener Name ────────────────────────────────────────

  function share() {
    const base = `${location.origin}/${encodeURIComponent(id)}`;
    const body = el('div', { class: 'sheet' });

    const rows: [string, string, string][] = [['Zum Lesen', base, 'Öffnet die Ansicht. Bearbeiten ist damit nicht möglich.']];
    if (editKey) rows.push(['Zum Bearbeiten', `${base}#edit=${editKey}`, 'Wer diesen Link hat, kann das Dokument ändern.']);
    if (exists) rows.push(['Als Markdown', `${base}.md`, 'Reiner Text, z. B. für KI-Assistenten.']);
    for (const [label, url, hint] of rows) {
      const input = el('input', { type: 'text', readonly: '', value: url, 'aria-label': label }) as HTMLInputElement;
      input.addEventListener('focus', () => input.select());
      const copy = button('Kopieren', 'In die Zwischenablage', async () => {
        await navigator.clipboard.writeText(url).catch(() => input.select());
        copy.textContent = 'Kopiert';
        setTimeout(() => (copy.textContent = 'Kopieren'), 1500);
      }, 't boxed');
      body.append(el('div', { class: 'field-row' }, el('label', {}, label), el('div', { class: 'field-line' }, input, copy), el('p', { class: 'hint' }, hint)));
    }
    if (!exists) body.append(el('p', { class: 'hint' }, 'Das Dokument wird angelegt, sobald du etwas schreibst.'));

    if (canEdit()) {
      const name = el('input', { type: 'text', value: store.get('md:name') || firstName(), placeholder: 'Gast', maxlength: '30', 'aria-label': 'Dein Name' }) as HTMLInputElement;
      name.addEventListener('change', () => {
        const v = name.value.trim().slice(0, 30);
        store.set('md:name', v);
        editor?.setName(v);
      });
      body.append(el('div', { class: 'name-row' }, el('label', {}, 'Dein Name beim gemeinsamen Schreiben'), name));
    }
    dialog('Teilen', body);
  }

  // ── Menüs ─────────────────────────────────────────────────────────────────

  function openRecent() {
    const items: MenuItem[] = [['Neues Dokument', () => (location.href = '/')]];
    const list = recent.list().filter(r => r.id !== id);
    if (list.length) items.push(el('div', { class: 'menu-label' }, 'Zuletzt geöffnet'));
    for (const r of list.slice(0, 5)) {
      items.push(el('a', { href: `/${encodeURIComponent(r.id)}`, class: 'recent' },
        el('span', { class: 'recent-title' }, r.title || r.id),
        el('span', { class: 'recent-meta' }, `${ago(r.at)}${r.own ? ' · bearbeitbar' : ''}${r.tags?.length ? ' · ' + r.tags.join(', ') : ''}`),
      ));
    }
    if (list.length || account.user) items.push(el('a', { href: '/home', class: 'recent all' }, el('span', { class: 'recent-title' }, 'Alle Dokumente …')));
    items.push(...accountItems());
    items.push(el('a', { href: '/datenschutz', class: 'menu-fine' }, 'Datenschutz'));
    menu('left', items);
  }

  function more() {
    const items: [string, () => void][] = [];
    if (compactQuery.matches) {
      items.push(['Teilen', share]);
      items.push(['Neues Dokument', () => { if (navigator.onLine) location.href = '/'; else toast('Offline: Neue Dokumente gehen nur mit Verbindung.'); }]);
    }
    items.push(['Herunterladen (.md)', () => { if (exists) location.href = `/${encodeURIComponent(id)}.md?download=1`; else toast('Noch leer.'); }]);
    if (canEdit()) items.push(['Adresse ändern', renameDialog]);
    if (account.user && exists) items.push(['Tags …', () => {
      const r = recent.list().find(x => x.id === id);
      import('./tags').then(m => m.tagDialog(id, document.title, r?.tags || [], tags => toast(tags.length ? `Tags: ${tags.join(', ')}` : 'Keine Tags.')));
    }]);
    if (mode !== 'view') items.push([spellcheck ? 'Rechtschreibprüfung aus' : 'Rechtschreibprüfung an', () => {
      spellcheck = !spellcheck;
      store.set('md:spellcheck', spellcheck ? '1' : '0');
      editor?.setSpellcheck(spellcheck);
    }]);
    if (exists && !editKey) items.push(['Mit Code freischalten', () => unlockDialog(id, key => {
      if (!key) return;
      editKey = key;
      store.set(keyName, key);
      recent.touch(id, document.title, true);
      enableTasks();
      renderBar();
      toast('Freigeschaltet. Du kannst dieses Dokument jetzt bearbeiten.');
    })]);
    if (isAdmin()) {
      items.push(['Verwaltung (alle Dokumente)', () => (location.href = '/admin')]);
      if (exists) items.push(['Dokument löschen', del]);
    }
    menu('right', items);
  }

  async function del() {
    if (!confirm('Dieses Dokument mit allen Bildern endgültig löschen? Das lässt sich nicht rückgängig machen.')) return;
    const res = await fetch(`/api/docs/${encodeURIComponent(id)}`, { method: 'DELETE', headers: adminHeaders() });
    if (res.ok) { store.del(keyName); recent.remove(id); location.href = '/admin'; }
    else toast((await res.json().catch(() => ({}))).error || 'Löschen fehlgeschlagen.');
  }

  // ── Tastatur, Leiste beim Schreiben ausblenden ────────────────────────────

  addEventListener('keydown', e => {
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === 'e') {
      e.preventDefault();
      setMode(mode === 'view' ? 'edit' : 'view');
    } else if (mode === 'view' && !mod && !e.altKey && e.key === 'e' && !(e.target instanceof HTMLInputElement) && !document.querySelector('dialog[open]')) {
      if (canEdit()) { e.preventDefault(); setMode('edit'); }
    }
  });

  // Beim Tippen blendet sich die Leiste aus. Sie kommt zurück, sobald die
  // Maus ein Stück bewegt wird oder darüber schwebt, und bleibt klickbar.
  let typingFrom: { x: number; y: number } | null = null;
  function startTyping() {
    document.body.classList.add('typing');
    typingFrom = null;
  }
  addEventListener('mousemove', e => {
    if (!document.body.classList.contains('typing')) return;
    if (!typingFrom) { typingFrom = { x: e.clientX, y: e.clientY }; return; }
    if (Math.hypot(e.clientX - typingFrom.x, e.clientY - typingFrom.y) > 20) document.body.classList.remove('typing');
  }, { passive: true });

  // Titel in „Zuletzt geöffnet“ aktuell halten.
  addEventListener('pagehide', () => {
    if (editor && exists) recent.touch(id, titleOf(editor.text()), true);
  });

  // Aufgaben in der Ansicht abhaken, wenn man bearbeiten darf.
  function enableTasks() {
    if (!editKey) return;
    for (const box of article.querySelectorAll<HTMLInputElement>('input.task')) box.disabled = false;
  }
  article.addEventListener('click', async e => {
    const box = e.target as HTMLInputElement;
    if (!(box instanceof HTMLInputElement) || !box.classList.contains('task') || !editKey || !exists) return;
    const line = Number(box.dataset.line);
    if (line < 0) return;
    const ed = await loadEditor();
    await ed.whenSynced();
    const doc = ed.view.state.doc;
    if (line + 1 > doc.lines) return;
    const l = doc.line(line + 1);
    const m = /^(\s*(?:[-*+]|\d+\.)\s+\[)([ xX])\]/.exec(l.text);
    if (!m) return;
    ed.view.dispatch({ changes: { from: l.from + m[1].length, to: l.from + m[1].length + 1, insert: m[2] === ' ' ? 'x' : ' ' } });
  });

  /** Diese Seite für offline merken (nachdem sie angelegt wurde). */
  function cachePage() {
    if (!('caches' in window)) return;
    caches.open('md-pages').then(c => c.add(new Request(location.pathname, { cache: 'no-store' }))).catch(() => {});
  }

  /** Offline: die Ansicht aus der lokalen Kopie zeigen, die neuer sein kann als die gespeicherte Seite. */
  async function showLocalCopy() {
    const ed = await loadEditor();
    await ed.whenLocal();
    const text = ed.text();
    if (!text || mode !== 'view') return;
    const { render } = await import('./editor');
    article.innerHTML = render(text).html;
    enableTasks();
    enhance(article, boot.katexCss);
  }

  document.body.dataset.mode = mode;
  renderBar();
  account.sync();
  if (exists) {
    enableTasks();
    enhance(article, boot.katexCss);
    if (editKey && !navigator.onLine) showLocalCopy();
  }
  if (mode !== 'view') {
    mode = 'view';
    setMode('edit');
  }
}

/** Vorname aus dem Konto als Vorgabe für den Namen beim gemeinsamen Schreiben. */
function firstName(): string {
  return (account.user?.name || '').split(' ')[0].slice(0, 30);
}

// ── Turnstile (unsichtbar, nur auf neuen Dokumenten) ────────────────────────

interface TurnstileApi {
  render(el: HTMLElement, opts: object): string;
  reset(id: string): void;
  remove(id: string): void;
}

function loadTurnstile(siteKey: string) {
  const box = el('div', { class: 'turnstile' });
  document.body.append(box);
  let widget: string | null = null;
  let resolveToken: ((t: string) => void) | null = null;
  let current: string | null = null;
  const ready = new Promise<TurnstileApi>(resolve => {
    (window as unknown as Record<string, unknown>).onTurnstileLoad = () => resolve((window as unknown as { turnstile: TurnstileApi }).turnstile);
    const s = document.createElement('script');
    s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit&onload=onTurnstileLoad';
    s.async = true;
    document.head.append(s);
  });
  ready.then(ts => {
    widget = ts.render(box, {
      sitekey: siteKey,
      appearance: 'interaction-only',
      callback: (t: string) => { current = t; resolveToken?.(t); },
      // Nur wenn Cloudflare unsicher ist, erscheint ein Kasten zum Bestätigen.
      'before-interactive-callback': () => toast('Kurz unten rechts bestätigen, dann wird das Dokument gespeichert.'),
      'expired-callback': () => { current = null; },
    });
  });
  return {
    async token(): Promise<string> {
      if (current) return current;
      return Promise.race([
        new Promise<string>(r => (resolveToken = r)),
        new Promise<string>((_, rej) => setTimeout(() => rej(new Error('timeout')), 30_000)),
      ]);
    },
    reset() { current = null; ready.then(ts => widget && ts.reset(widget)); },
    remove() { ready.then(ts => { if (widget) ts.remove(widget); box.remove(); }); },
  };
}

// ── Start (am Ende, damit alle Konstanten oben schon stehen) ─────────────────

if (boot.page === 'admin') {
  import('./admin').then(m => m.start());
} else if (boot.page === 'home') {
  import('./home').then(m => m.start());
} else {
  startDoc(boot);
}

// Offline-Fähigkeit und Installation als App. Jeder Build registriert eine
// neue Fassung (?v=…), die die Dateien des alten Builds wegräumt.
if ('serviceWorker' in navigator && boot.build) {
  addEventListener('load', () => {
    navigator.serviceWorker.register(`/sw.js?v=${boot.build}`).catch(() => { /* ohne geht es auch */ });
  });
}
