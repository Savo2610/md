// Einstieg im Browser. Die Ansicht kommt fertig gerendert vom Server; hier
// kommen Kopfleiste, Modi (Ansicht / Bearbeiten / Beides), Teilen,
// Umbenennen und Freischalten dazu. Der Editor wird erst beim Bearbeiten
// nachgeladen.

import { enhance } from './enhance';
import type { EditorHandle, EditorStatus } from './editor';
import type { DocKind } from './ui';
import type { BoardHandle } from './board';
import type { PackHandle } from './pack';
import { titleOf, slugify } from '../shared/title';
import { $, el, dialog, toast, store, adminHeaders, isAdmin, setAccountAdmin, unlockDialog, unlock, recent, menu, ask, ownerKey, ownerHeaders, trashDaysLeft, docHref, type MenuItem } from './ui';
import { tagsOf } from '../shared/tags';
import { account, type User } from './account';
import { spellcheckOn, startMode, rememberMode, writerName } from './settings';
import { openAsNew, takePending, dropZone, fileToMarkdown } from './importer';
import { toolMenu, NEW } from './nav';

export interface Boot {
  page: 'doc' | 'admin' | 'home' | 'memos' | 'packstart' | 'umzug';
  build?: string;
  id?: string;
  kind?: 'board' | 'pack';
  exists?: boolean;
  siteKey?: string;
  katexCss?: string;
  user?: User | null;
  login?: boolean;
  editKey?: string;
  admin?: boolean;
  ownerKey?: string;
  trashed?: number;
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
  pen: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M10.5 3l2.5 2.5L6 12.5l-3 .5.5-3z"/></svg>',
  qr: '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="2.5" y="2.5" width="4" height="4" rx=".6"/><rect x="9.5" y="2.5" width="4" height="4" rx=".6"/><rect x="2.5" y="9.5" width="4" height="4" rx=".6"/><path d="M9.5 9.5h1.5v1.5M13.5 9.5v.01M9.5 13.5h.01M12 12v1.5h1.5"/></svg>',
};

/** Laufende Seite eines Dokuments; destroy() räumt sie ab (Wechsel zwischen Packlisten ohne Neuladen). */
export interface DocSession { destroy(): void }

function startDoc(boot: Boot, host?: HTMLElement): DocSession {
  const id = boot.id!;
  const ac = new AbortController();
  const sig = { signal: ac.signal };
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
  if (boot.ownerKey && !ownerKey(id)) store.set(`md:owner:${id}`, boot.ownerKey);

  let editKey = store.get(keyName);
  const canEdit = () => !exists || !!editKey;

  // Whiteboard: vom Server (kind) oder neu über /#board.
  const isBoard = boot.kind === 'board' || (!exists && location.hash === '#board');
  if (location.hash === '#board') history.replaceState(null, '', location.pathname + location.search);
  if (isBoard) document.body.classList.add('is-board');
  // Packliste: vom Server (kind) oder neu über /#pack.
  const isPack = !isBoard && (boot.kind === 'pack' || (!exists && location.hash === '#pack'));
  if (location.hash === '#pack') history.replaceState(null, '', location.pathname + location.search);
  if (isPack) document.body.classList.add('is-pack');
  /** Board oder Packliste: eigene Oberfläche statt Editor und Ansicht. */
  const isApp = isBoard || isPack;
  const kindHere: DocKind | undefined = isBoard ? 'board' : isPack ? 'pack' : undefined;
  // Neues Dokument mit Text aus dem Link: /#text=<Markdown, URL-kodiert>
  // (für Chat-Agenten, die nur Links ausgeben können, siehe /llms.txt).
  const textHash = /^#text=([\s\S]*)$/.exec(location.hash);
  let linked = '';
  if (textHash) {
    history.replaceState(null, '', location.pathname + location.search);
    try { linked = decodeURIComponent(textHash[1]); } catch { linked = textHash[1]; }
  }

  const app = $('#app')!;
  const article: HTMLElement = $<HTMLElement>('#view') ?? (isApp ? el('article', { class: 'doc', id: 'view' }) : app.appendChild(el('article', { class: 'doc', id: 'view' })));
  const workspace = el('div', { class: 'workspace' });
  const editorPane = el('div', { class: 'pane-editor' });
  const previewPane = el('div', { class: 'pane-preview' });
  const preview = el('article', { class: 'doc' });
  previewPane.append(preview);
  workspace.append(editorPane, previewPane);
  const boardHost = el('div', { class: 'board-host' });
  const packHost = host ?? el('div', { class: 'pack-host' });
  if (!host) app.append(isBoard ? boardHost : isPack ? packHost : workspace);

  /** #tags in der gerenderten Ansicht (vom Server). */
  const viewTags = () => [...article.querySelectorAll<HTMLElement>('.doc-tag')].map(s => s.dataset.tag || '').filter(Boolean)
    .filter((t, i, all) => all.findIndex(x => x.toLowerCase() === t.toLowerCase()) === i);
  if (exists) recent.touch(id, document.title === id || (isBoard && document.title === 'Board') ? '' : document.title, !!editKey, isApp ? undefined : viewTags(), kindHere);
  // Angemeldet: #tags im Text sichtbar; Antippen zeigt alle eigenen Dokumente
  // mit diesem Tag (Übersicht, gefiltert). Ohne Konto bleiben sie unsichtbar.
  if (account.user) document.body.classList.add('tags-visible');
  article.addEventListener('click', e => {
    const t = (e.target as HTMLElement).closest<HTMLElement>('.doc-tag');
    if (!t || !account.user) return;
    store.set('md:tag', t.dataset.tag || '');
    location.href = '/home';
  });


  // ── Kopfleiste ────────────────────────────────────────────────────────────

  const bar = el('header', { id: 'bar' });
  const left = el('div', { class: 'bar-left' });
  const right = el('nav', { class: 'bar-right' });
  // In der installierten App führt „md“ zurück zur Übersicht, im Browser
  // öffnet es das kleine Menü mit „Neues Dokument“ und den letzten Dokumenten.
  // Board und Packliste haben auch als App das Menü (dort fehlt sonst der Weg zu den anderen).
  const brandIsLink = standalone && !isApp;
  const brand = brandIsLink
    ? el('a', { class: 'brand', href: '/home', title: 'Alle Dokumente' }, '‹ md')
    : el('button', { type: 'button', class: 'brand', title: 'Menü', 'aria-haspopup': 'dialog' }, 'md');
  if (!brandIsLink) brand.addEventListener('click', openRecent);
  const status = el('span', { class: 'status', role: 'status' });
  const peers = el('span', { class: 'peers' });
  left.append(brand, status, peers);
  bar.append(left, right);
  document.body.prepend(bar);

  // Darf man bearbeiten: zuletzt benutzter Modus bzw. wie in den Einstellungen.
  let mode: Mode = isApp ? (canEdit() ? 'edit' : 'view') : !exists || startInEdit ? 'edit' : editKey ? startMode() : 'view';
  let spellcheck = spellcheckOn();
  // Umgeschaltet in den Einstellungen.
  addEventListener('md:spellcheck', e => { spellcheck = (e as CustomEvent<boolean>).detail; editor?.setSpellcheck(spellcheck); }, sig);
  addEventListener('md:name', () => { editor?.setName(writerName()); board?.setName(writerName()); pack?.setName(writerName()); }, sig);
  let editor: EditorHandle | null = null;
  let board: BoardHandle | null = null;
  let pack: PackHandle | null = null;
  /** Titel für Umbenennen, Papierkorb und „Zuletzt geöffnet“. */
  const currentTitle = () => (board ? board.title() : pack ? pack.title() : editor ? titleOf(editor.text()) : document.title);
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
  }, sig);

  function renderBar() {
    right.replaceChildren();
    if (isBoard) {
      if (board) {
        if (!board.titleInput.isConnected) status.before(board.titleInput);
        right.append(board.controls);
      }
      if (!compactQuery.matches) right.append(el('span', { class: 'sep', 'aria-hidden': 'true' }), button('Teilen', 'Links zum Teilen', share));
      right.append(button('⋯', 'Mehr', more, 't more'));
      renderStatus();
      return;
    }
    if (isPack) {
      if (!compactQuery.matches) right.append(button('Teilen', 'Links zum Teilen', share));
      right.append(button('⋯', 'Mehr', more, 't more'));
      renderStatus();
      return;
    }
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
        ['split', 'Beides', 'Editor und Vorschau nebeneinander'],
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
    const list = (mode !== 'view' || isApp) && s?.status === 'online' ? s.peers : [];
    for (const p of list.slice(0, 5)) {
      const dot = isBoard && board && p.id !== undefined
        ? el('button', { type: 'button', class: 'peer', title: `${p.name} folgen`, 'aria-label': `${p.name} folgen` })
        : el('span', { class: 'peer', title: `${p.name} bearbeitet gerade` });
      dot.style.background = p.color;
      if (dot instanceof HTMLButtonElement) dot.addEventListener('click', () => board!.follow(p.id!));
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
        name: writerName(),
        spellcheck,
        wsUrl: () => {
          const u = new URL(`/api/docs/${encodeURIComponent(id)}/ws`, location.href);
          u.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
          if (editKey) u.searchParams.set('key', editKey);
          return u.toString();
        },
        auth: (): Record<string, string> => (editKey ? { 'x-edit-key': editKey } : {}),
        tags: () => account.allTags(),
        ensureCreated: create,
        onStatus: s => { lastStatus = s; renderStatus(); },
        onNotice: n => {
          if (n.type === 'hello' && n.edit === false && mode !== 'view') {
            // Schlüssel passt nicht (mehr): zurück in die Ansicht.
            store.del(keyName);
            editKey = null;
            toast('Keine Berechtigung zum Bearbeiten. Mit dem Bearbeiten-Link oder dem Code freischalten.');
            setMode('view', false);
          } else if (n.type === 'limit') {
            toast('Das Dokument hat die Maximalgröße erreicht.');
          } else if (n.type === 'moved' && n.to) {
            followMove(n.to);
          } else if (n.type === 'trashed' && !trashedHere) {
            // Jemand anderes hat das Dokument gelöscht: neu laden zeigt „gelöscht“ bzw. den Papierkorb.
            location.reload();
          }
        },
        onTyping: startTyping,
        toast,
      });
      return h;
    });
    editor = await editorLoading;
    if (exists) editor.markCreated();
    return editor;
  }

  async function loadBoard(): Promise<BoardHandle> {
    const m = await import('./board');
    board = m.mountBoard({
      id,
      parent: boardHost,
      exists,
      editable: mode !== 'view',
      name: writerName(),
      wsUrl: () => {
        const u = new URL(`/api/docs/${encodeURIComponent(id)}/ws`, location.href);
        u.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
        if (editKey) u.searchParams.set('key', editKey);
        return u.toString();
      },
      auth: (): Record<string, string> => (editKey ? { 'x-edit-key': editKey } : {}),
      ensureCreated: create,
      onStatus: s => { lastStatus = s; renderStatus(); },
      onTitle: t => { document.title = t || 'Board'; },
      onNotice: n => {
        if (n.type === 'hello' && n.edit === false && mode !== 'view') {
          store.del(keyName);
          editKey = null;
          toast('Keine Berechtigung zum Bearbeiten. Mit dem Bearbeiten-Link oder dem Code freischalten.');
          setMode('view', false);
        } else if (n.type === 'limit') {
          toast('Das Board hat die Maximalgröße erreicht.');
        } else if (n.type === 'moved' && n.to) {
          followMove(n.to);
        } else if (n.type === 'trashed' && !trashedHere) {
          location.reload();
        }
      },
      toast,
    });
    renderBar();
    return board;
  }

  async function loadPack(): Promise<PackHandle> {
    const m = await import('./pack');
    pack = m.mountPack({
      id,
      parent: packHost,
      exists,
      editable: mode !== 'view',
      name: writerName(),
      wsUrl: () => {
        const u = new URL(`/api/docs/${encodeURIComponent(id)}/ws`, location.href);
        u.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
        if (editKey) u.searchParams.set('key', editKey);
        return u.toString();
      },
      auth: (): Record<string, string> => (editKey ? { 'x-edit-key': editKey } : {}),
      ensureCreated: create,
      onStatus: s => { lastStatus = s; renderStatus(); },
      onTitle: t => { document.title = t || 'Packliste'; },
      onNotice: n => {
        if (n.type === 'hello' && n.edit === false && mode !== 'view') {
          store.del(keyName);
          editKey = null;
          toast('Keine Berechtigung zum Bearbeiten. Mit dem Bearbeiten-Link oder dem Code freischalten.');
          setMode('view', false);
        } else if (n.type === 'limit') {
          toast('Die Packliste hat die Maximalgröße erreicht.');
        } else if (n.type === 'moved' && n.to) {
          followMove(n.to);
        } else if (n.type === 'trashed' && !trashedHere) {
          location.reload();
        }
      },
      toast,
    });
    renderBar();
    return pack;
  }

  async function setMode(next: Mode, remember = true) {
    if (next !== 'view' && !canEdit()) return;
    if (isApp) {
      mode = next === 'view' ? 'view' : 'edit';
      document.body.dataset.mode = mode;
      board?.setEditable(mode !== 'view');
      pack?.setEditable(mode !== 'view');
      renderBar();
      return;
    }
    if (remember && exists) rememberMode(next);
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
        if (exists) recent.touch(id, r.title, true, tagsOf(editor.text()));
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

  let creating: Promise<boolean> | null = null;

  /** Legt das Dokument an (nur einmal, auch bei gleichzeitigen Aufrufen). */
  function create(): Promise<boolean> {
    if (exists) return Promise.resolve(true);
    creating ??= createNow().then(ok => {
      if (!ok) creating = null;
      return ok;
    });
    return creating;
  }

  async function createNow(): Promise<boolean> {
    const token = turnstile ? await turnstile.token().catch(() => '') : '';
    const res = await fetch(`/api/docs/${encodeURIComponent(id)}/create`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(isBoard ? { token, kind: 'board' } : isPack ? { token, kind: 'pack' } : { token }),
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
    if (data.ownerKey) store.set(`md:owner:${id}`, data.ownerKey);
    exists = true;
    editor?.markCreated();
    board?.markCreated();
    pack?.markCreated();
    recent.touch(id, '', true, undefined, kindHere);
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
    const own = ownerKey(id);
    if (own) { store.set(`md:owner:${to}`, own); store.del(`md:owner:${id}`); }
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

  /** Adresse ändern direkt in der Zeile „Zum Lesen“ im Teilen-Fenster. */
  function renameForm(cancel: () => void): HTMLElement {
    const isRandom = /^[a-z0-9]{10}$/.test(id) && /\d/.test(id) && /[a-z]/.test(id);
    // Vorschlag: aus dem Titel (erste Überschrift bzw. erste Zeile) des Dokuments.
    const title = currentTitle();
    const full = title === id || title === 'Neues Dokument' || title === 'Board' || title === 'Packliste' ? '' : slugify(title);
    const suggestion = full.length <= 60 ? full : full.slice(0, 60).replace(/-[^-]*$/, '');
    const input = el('input', { type: 'text', value: isRandom && suggestion ? suggestion : id, placeholder: 'meine-anleitung', spellcheck: 'false', autocapitalize: 'off', 'aria-label': 'Neue Adresse' }) as HTMLInputElement;
    const save = el('button', { type: 'submit', class: 't boxed' }, 'Ändern');
    const back = button('Abbrechen', 'Abbrechen', cancel, 't');
    const err = el('p', { class: 'error' });
    const form = el('form', { class: 'field-row' },
      el('label', {}, 'Adresse'),
      el('div', { class: 'field-line' }, el('div', { class: 'addr' }, el('span', { class: 'prefix' }, `${location.host}/`), input), save, back),
      el('p', { class: 'hint' }, `Buchstaben, Ziffern und Bindestriche. ${exists ? (isRandom ? 'Die bisherige Adresse leitet weiter.' : 'Die bisherige Adresse wird wieder frei; alte Links funktionieren dann nicht mehr.') : ''}`),
      err,
    );
    input.addEventListener('keydown', e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancel(); } });
    form.addEventListener('submit', async e => {
      e.preventDefault();
      const to = input.value.trim().toLowerCase().replace(/\s+/g, '-');
      if (!to || to === id) { cancel(); return; }
      save.disabled = true;
      const problem = await rename(to);
      save.disabled = false;
      err.textContent = problem || '';
    });
    setTimeout(() => { input.focus(); input.select(); }, 30);
    return form;
  }

  // ── Teilen: Links und eigener Name ────────────────────────────────────────

  function share() {
    const base = `${location.origin}${docHref(id, kindHere)}`;
    const body = el('div', { class: 'sheet' });

    const editHref = () => `${base}#edit=${editKey}`;
    // Noch nicht angelegt: Der Bearbeiten-Link entsteht erst beim Kopieren
    // bzw. beim QR-Code, damit bloßes Öffnen von „Teilen“ nichts anlegt.
    let pendingHint: HTMLElement | null = null;
    const editLink = async (input: HTMLInputElement): Promise<string> => {
      if (!editKey && !(await create())) throw new Error('nicht angelegt');
      input.value = editHref();
      pendingHint?.remove();
      return input.value;
    };

    const rows: [string, string, string][] = [['Zum Lesen', base, 'Öffnet die Ansicht. Bearbeiten ist damit nicht möglich.']];
    if (editKey || canEdit()) rows.push(['Zum Bearbeiten', editKey ? editHref() : '', 'Wer diesen Link hat, kann das Dokument ändern.']);
    if (exists) rows.push(['Als Markdown', `${base}.md`, 'Reiner Text, z. B. für KI-Assistenten.']);
    rows.forEach(([label, url, hint], i) => {
      const lazy = !url;
      const input = el('input', { type: 'text', readonly: '', value: url, 'aria-label': label }) as HTMLInputElement;
      if (lazy) input.placeholder = `${base.replace(/^https?:\/\//, '')}#edit=…`;
      input.addEventListener('focus', () => input.select());
      const copy = button('Kopieren', 'In die Zwischenablage', async () => {
        const done = lazy && !input.value ? await copyLater(() => editLink(input)) : await navigator.clipboard.writeText(input.value).then(() => true, () => false);
        if (!done) { input.select(); return; }
        copy.textContent = 'Kopiert';
        setTimeout(() => (copy.textContent = 'Kopieren'), 1500);
      }, 't boxed');
      const line = el('div', { class: 'field-line' }, input);
      const row = el('div', { class: 'field-row' }, el('label', {}, label), line, el('p', { class: 'hint' }, hint));
      // Symbole im grauen Feld (Stift, QR-Code), damit alle Linkfelder gleich breit bleiben.
      const icons: HTMLElement[] = [];
      // QR-Code: klappt bei Bedarf unter der Zeile auf.
      const qrBtn = label === 'Als Markdown' ? null : el('button', { type: 'button', class: 't icon', title: 'QR-Code', 'aria-label': `QR-Code: ${label}`, 'aria-expanded': 'false' });
      if (qrBtn) {
        qrBtn.innerHTML = ICONS.qr;
        let box: HTMLElement | null = null;
        qrBtn.addEventListener('click', async () => {
          if (box) { box.remove(); box = null; qrBtn.setAttribute('aria-expanded', 'false'); return; }
          const target = input.value || (await editLink(input).catch(() => ''));
          if (!target) return;
          const { qrSvg } = await import('./qr');
          box = qrCard(qrSvg(target), `${id}${label === 'Zum Bearbeiten' ? '-bearbeiten' : ''}`, label === 'Zum Bearbeiten');
          line.after(box);
          qrBtn.setAttribute('aria-expanded', 'true');
        });
      }
      // Erste Zeile: kleiner Stift zum Ändern der Adresse (nur mit Bearbeitungsrecht).
      if (i === 0 && canEdit()) {
        const pen = el('button', { type: 'button', class: 't icon', title: 'Adresse ändern', 'aria-label': 'Adresse ändern' });
        pen.innerHTML = ICONS.pen;
        pen.addEventListener('click', () => {
          const form = renameForm(() => { form.replaceWith(row); pen.focus(); });
          row.replaceWith(form);
        });
        icons.push(pen);
      }
      if (qrBtn) icons.push(qrBtn);
      if (icons.length) {
        input.style.paddingRight = `${8 + icons.length * 30}px`;
        line.replaceChildren(el('div', { class: 'field-pen' }, input, el('div', { class: 'field-icons' }, ...icons)));
      }
      line.append(copy);
      body.append(row);
    });
    if (!exists) body.append(pendingHint = el('p', { class: 'hint' }, isBoard ? 'Das Board wird angelegt, sobald du etwas daraufsetzt oder den Bearbeiten-Link holst.' : isPack ? 'Die Packliste wird angelegt, sobald du etwas einträgst oder den Bearbeiten-Link holst.' : 'Das Dokument wird angelegt, sobald du etwas schreibst oder den Bearbeiten-Link holst.'));
    dialog('Teilen', body);
  }

  /**
   * Kopiert einen Text, der erst noch entsteht (Anlegen übers Netz). Safari
   * erlaubt die Zwischenablage nur direkt im Klick, darum ein ClipboardItem
   * mit Promise; sonst nach dem Warten ganz normal.
   */
  async function copyLater(make: () => Promise<string>): Promise<boolean> {
    const text = make();
    text.catch(() => {});
    if (typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
      try {
        await navigator.clipboard.write([new ClipboardItem({ 'text/plain': text.then(t => new Blob([t], { type: 'text/plain' })) })]);
        return true;
      } catch { /* unten noch einmal ohne ClipboardItem */ }
    }
    const t = await text.catch(() => '');
    return !!t && navigator.clipboard.writeText(t).then(() => true, () => false);
  }

  /** Aufgeklappter QR-Code: dunkel auf weiß (das lesen alle Kameras), als Bild sicherbar. */
  function qrCard(svg: string, name: string, editing: boolean): HTMLElement {
    const pic = el('div', { class: 'qr-pic' });
    pic.innerHTML = svg;
    const save = el('button', { type: 'button', class: 'qr-save' }, 'Als Bild sichern');
    save.addEventListener('click', async () => {
      // SVG → PNG (1024 px), damit es sich überall verschicken lässt.
      const img = new Image();
      img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
      await img.decode();
      const c = document.createElement('canvas');
      c.width = c.height = 1024;
      const g = c.getContext('2d')!;
      g.imageSmoothingEnabled = false;
      g.drawImage(img, 0, 0, 1024, 1024);
      const blob = await new Promise<Blob | null>(r => c.toBlob(r, 'image/png'));
      if (!blob) return;
      const a = el('a', { href: URL.createObjectURL(blob), download: `qr-${name}.png` });
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    });
    const note = editing ? el('span', { class: 'qr-warn' }, 'Wer ihn scannt, kann bearbeiten.') : el('span', {});
    return el('div', { class: 'qr-card' }, pic, el('div', { class: 'qr-foot' }, note, save));
  }

  // ── Menüs ─────────────────────────────────────────────────────────────────

  function openRecent() {
    menu('left', toolMenu(kindHere ?? 'md', id));
  }

  function more() {
    fetchedMd = null; fetchingMd = null; // jedes Mal frisch, andere schreiben vielleicht mit
    prefetchMarkdown();
    const items: MenuItem[] = [];
    if (compactQuery.matches) items.push(['Teilen', share]);
    items.push(['Als Markdown teilen', shareMarkdown]);
    // Handy als App: bei Dokumenten führt „‹ md“ zur Übersicht, Neues deshalb auch hier.
    if (compactQuery.matches && brandIsLink) items.push(NEW.md);
    if (isBoard && board && mode !== 'view' && board.peerCount()) items.push(['Alle zu mir holen', () => board!.summon()]);
    if (pack) items.push(...pack.menuItems());
    if (isPack) {
      // Kein Herunterladen/Drucken: „Als Markdown teilen“ und /<id>.md reichen.
    } else if (isBoard) {
      items.push(['Als Dokument öffnen', () => { if (board) openAsNew(new File([board.markdown()], `${board.title() || 'Board'}.md`, { type: 'text/markdown' })); }]);
      items.push(['Drucken (.pdf)', () => board?.print()]);
    } else {
      items.push(['Herunterladen (.md)', () => { if (exists) location.href = `/${encodeURIComponent(id)}.md?download=1`; else toast('Noch leer.'); }]);
      items.push(['Drucken (.pdf)', printDoc]);
    }
    const unlocked = (key: string | null) => {
      if (!key) return;
      editKey = key;
      store.set(keyName, key);
      recent.touch(id, document.title, true, undefined, kindHere);
      enableTasks();
      if (isApp) { setMode('edit', false); board?.reconnect(); pack?.reconnect(); }
      renderBar();
      toast('Freigeschaltet. Du kannst dieses Dokument jetzt bearbeiten.');
    };
    // Mit dem Admin-Konto angemeldet: ohne Code, nur kurz bestätigen.
    if (exists && !editKey && boot.admin) items.push(['Freischalten', async () => {
      if (!(await ask('Dokument freischalten?', 'Du kannst es danach bearbeiten und löschen.', 'Freischalten', false))) return;
      const r = await unlock('', id);
      if (r.ok) unlocked(r.editKey); else toast(r.error);
    }]);
    else if (exists && !editKey) items.push(['Mit Code freischalten', () => unlockDialog(id, unlocked)]);
    if (exists && (ownerKey(id) || isAdmin())) items.push(['Löschen', trashDoc, 'danger']);
    menu('right', items);
  }

  // ── Kopieren und Drucken ──────────────────────────────────────────────────

  // In der Ansicht ohne Editor: Markdown schon beim Öffnen des Menüs holen,
  // damit der Klick es sofort hat (Safari kopiert nur direkt im Klick).
  let fetchedMd: string | null = null;
  let fetchingMd: Promise<string> | null = null;
  function prefetchMarkdown() {
    if (editor || !exists || fetchingMd) return;
    fetchingMd = fetch(`/${encodeURIComponent(id)}.md`, { cache: 'no-store' })
      .then(r => { if (!r.ok) throw new Error(); return r.text(); })
      .then(t => (fetchedMd = t), e => { fetchingMd = null; throw e; });
    fetchingMd.catch(() => {});
  }

  async function copyMarkdown() {
    const local = editor?.text() ?? board?.markdown() ?? pack?.markdown() ?? fetchedMd ?? undefined;
    if (!exists && !local) { toast('Noch leer.'); return; }
    try {
      if (local !== undefined) {
        await navigator.clipboard.writeText(local).catch(() => { if (!copyFallback(local)) throw new Error(); });
      } else {
        prefetchMarkdown();
        const text = fetchingMd!;
        // Safari erlaubt das Schreiben nach einem fetch nur über ein ClipboardItem mit Promise.
        try {
          await navigator.clipboard.write([new ClipboardItem({ 'text/plain': text.then(t => new Blob([t], { type: 'text/plain' })) })]);
        } catch {
          const t = await text;
          await navigator.clipboard.writeText(t).catch(() => { if (!copyFallback(t)) throw new Error(); });
        }
      }
      toast('Markdown kopiert.');
    } catch {
      toast('Kopieren ging nicht.');
    }
  }

  /** Handy: Teilen-Dialog des Systems mit dem Markdown; sonst in die Zwischenablage. */
  async function shareMarkdown() {
    const local = editor?.text() ?? board?.markdown() ?? pack?.markdown() ?? fetchedMd ?? undefined;
    const phone = compactQuery.matches || matchMedia('(pointer: coarse)').matches;
    if (phone && navigator.share && local !== undefined) {
      if (!exists && !local) { toast('Noch leer.'); return; }
      try {
        await navigator.share({ title: currentTitle() || undefined, text: local });
        return;
      } catch (e) {
        if ((e as DOMException)?.name === 'AbortError') return;
      }
    }
    copyMarkdown();
  }

  /** Ohne Clipboard-API (oder verweigert): klassisch über ein unsichtbares Textfeld. */
  function copyFallback(text: string): boolean {
    const ta = el('textarea', { readonly: '', style: 'position:fixed;opacity:0;top:0;left:0' }) as HTMLTextAreaElement;
    ta.value = text;
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  }

  /** Drucken bzw. „Als PDF sichern“ im Druckdialog. Gedruckt wird immer die Ansicht. */
  async function printDoc() {
    if (!exists && !editor?.text()) { toast('Noch leer.'); return; }
    if (editor && mode !== 'view') {
      const { render } = await import('./editor');
      const r = render(editor.text());
      article.innerHTML = r.html;
      document.title = r.title || id;
      enableTasks();
      await enhance(article, boot.katexCss);
    }
    // KaTeX-Stil und Schriften abwarten, sonst fehlen sie im PDF.
    const css = boot.katexCss && article.querySelector('.math') ? document.querySelector<HTMLLinkElement>(`link[href="${boot.katexCss}"]`) : null;
    if (css && !css.sheet) await new Promise(r => { css.addEventListener('load', r, { once: true }); setTimeout(r, 2000); });
    await document.fonts.ready;
    print();
  }

  // Auf Papier immer hell (auch bei ⌘P).
  let themeBeforePrint: string | null = null;
  addEventListener('beforeprint', () => {
    themeBeforePrint = document.documentElement.getAttribute('data-theme');
    document.documentElement.setAttribute('data-theme', 'light');
  }, sig);
  addEventListener('afterprint', () => {
    if (themeBeforePrint) document.documentElement.setAttribute('data-theme', themeBeforePrint);
    else document.documentElement.removeAttribute('data-theme');
  }, sig);

  /** In den Papierkorb (nur Ersteller oder Admin). */
  let trashedHere = false;
  async function trashDoc() {
    const what = isPack ? 'Packliste' : isBoard ? 'Board' : 'Dokument';
    if (!(await ask(`${what} löschen?`, `${isPack ? 'Sie' : 'Es'} ist sofort für alle weg. 30 Tage lang kannst du ${isPack ? 'sie' : 'es'} auf der Übersicht im Papierkorb wiederherstellen.`, 'Löschen'))) return;
    // Vorher setzen: Der Server schließt gleich die Verbindung, das soll hier kein Neuladen auslösen.
    trashedHere = true;
    const res = await fetch(`/api/docs/${encodeURIComponent(id)}/trash`, { method: 'POST', headers: { ...ownerHeaders(id), ...adminHeaders() } });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { trashedHere = false; toast(data.error || 'Löschen fehlgeschlagen.'); return; }
    recent.markTrashed(id, data.trashed, currentTitle());
    // Ohne Zurück zum gelöschten weiter: Packliste → die anderen Packlisten
    // (bzw. eine neue, wenn es keine mehr gibt), Board → alle Boards,
    // Dokument → gleich weiterschreiben in einem neuen.
    location.replace(isPack ? '/pack' : isBoard ? '/home?art=board' : '/');
  }

  // ── Tastatur, Leiste beim Schreiben ausblenden ────────────────────────────

  addEventListener('keydown', e => {
    if (isApp) return;
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === 'e') {
      e.preventDefault();
      setMode(mode === 'view' ? 'edit' : 'view');
    } else if (mod && e.key.toLowerCase() === 'p' && mode !== 'view') {
      // Beim Bearbeiten: den aktuellen Stand als Ansicht drucken, nicht den Editor.
      e.preventDefault();
      printDoc();
    } else if (mode === 'view' && !mod && !e.altKey && e.key === 'e' && !(e.target instanceof HTMLInputElement) && !document.querySelector('dialog[open]')) {
      if (canEdit()) { e.preventDefault(); setMode('edit'); }
    }
  }, sig);

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
  }, { passive: true, ...sig });

  // Titel in „Zuletzt geöffnet“ aktuell halten.
  addEventListener('pagehide', () => {
    if (editor && exists && !trashedHere) recent.touch(id, titleOf(editor.text()), true, tagsOf(editor.text()));
    if (board && exists && !trashedHere) recent.touch(id, board.title(), !!editKey, tagsOf(board.markdown()), 'board');
    if (pack && exists && !trashedHere) recent.touch(id, pack.title() || 'Packliste', !!editKey, undefined, 'pack');
  }, sig);

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
  if (isBoard) {
    loadBoard();
  } else if (isPack) {
    loadPack();
  } else if (exists) {
    enableTasks();
    enhance(article, boot.katexCss);
    if (editKey && !navigator.onLine) showLocalCopy();
  }
  if (mode !== 'view' && !isApp) {
    const target = mode;
    mode = 'view';
    setMode(target, false);
  }

  // „Datei öffnen …“: Inhalt landet im neuen, leeren Dokument (legt es dabei an).
  const imported = exists || isApp ? null : takePending();
  if (imported) {
    loadEditor().then(async ed => {
      await ed.whenLocal();
      if (ed.text()) return;
      ed.view.dispatch({ changes: { from: 0, insert: imported }, userEvent: 'input.paste' });
      toast('Importiert. Die Adresse kannst du unter „Teilen“ ändern.');
    });
  } else if (linked.trim() && !exists && !isApp) {
    // Text aus dem Link: anlegen und gleich fertig gesetzt zeigen.
    loadEditor().then(async ed => {
      await ed.whenLocal();
      if (ed.text()) return;
      ed.view.dispatch({ changes: { from: 0, insert: linked }, userEvent: 'input.paste' });
      if (await create()) setMode('view', false);
    });
  }

  // Datei auf die Seite ziehen: in der Ansicht als neues Dokument, beim
  // Bearbeiten an der Cursorstelle (Ziehen direkt in den Text regelt der Editor).
  dropZone(file => {
    if (mode !== 'view' && editor) fileToMarkdown(file).then(md => editor!.insertBlock(md), () => toast('Die Datei ließ sich nicht lesen.'));
    else openAsNew(file);
  }, () => !isApp, ac.signal);

  return {
    destroy() {
      if (pack && exists && !trashedHere) recent.touch(id, pack.title() || 'Packliste', !!editKey, undefined, 'pack');
      ac.abort();
      pack?.destroy();
      pack = null;
      turnstile?.remove();
      bar.remove();
      document.querySelectorAll('dialog').forEach(d => d.close());
    },
  };
}

// ── Gelöschtes Dokument (Papierkorb) ────────────────────────────────────────

function startTrashed(boot: Boot) {
  const id = boot.id!;
  if (boot.ownerKey && !ownerKey(id)) store.set(`md:owner:${id}`, boot.ownerKey);
  document.body.dataset.mode = 'view';
  document.body.prepend(el('header', { id: 'bar' },
    el('div', { class: 'bar-left' }, el('a', { class: 'brand', href: '/home', title: 'Alle Dokumente' }, standalone ? '‹ md' : 'md')),
    el('nav', { class: 'bar-right' }),
  ));
  const app = $('#app')!;
  if (!ownerKey(id) && !isAdmin()) {
    app.append(el('div', { class: 'gone' }, el('p', {}, 'Dieses Dokument wurde gelöscht.'), el('a', { href: '/home' }, 'Zur Übersicht')));
    if (recent.list().some(r => r.id === id)) recent.remove(id);
    return;
  }
  // Liste auf diesem Gerät nachziehen (z. B. auf einem anderen Gerät gelöscht).
  if (recent.list().find(r => r.id === id)?.trashed !== boot.trashed) recent.markTrashed(id, boot.trashed!);
  const banner = el('div', { class: 'trash-banner' });
  const article = el('article', { class: 'doc' });
  app.append(banner, article);
  const restore = el('button', { type: 'button', class: 't boxed' }, 'Wiederherstellen');
  restore.addEventListener('click', async () => {
    restore.disabled = true;
    const res = await fetch(`/api/docs/${encodeURIComponent(id)}/restore`, { method: 'POST', headers: { ...ownerHeaders(id), ...adminHeaders() } });
    if (!res.ok) { restore.disabled = false; toast((await res.json().catch(() => ({}))).error || 'Ging nicht.'); return; }
    recent.markTrashed(id, 0);
    location.reload();
  });
  const days = trashDaysLeft(boot.trashed!);
  banner.append(el('span', {}, `Im Papierkorb · wird ${days === 1 ? 'morgen' : `in ${days} Tagen`} endgültig gelöscht`), restore);
  fetch(`/api/docs/${encodeURIComponent(id)}`, { headers: { ...ownerHeaders(id), ...adminHeaders() } })
    .then(r => r.json())
    .then(async (data: { markdown?: string; title?: string }) => {
      const { render } = await import('./editor');
      const r = render(data.markdown || '');
      article.innerHTML = r.html;
      document.title = r.title || id;
      enhance(article, boot.katexCss);
    })
    .catch(() => toast('Inhalt konnte nicht geladen werden.'));
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
} else if (boot.page === 'memos') {
  import('./memos').then(m => m.start(boot));
} else if (boot.page === 'packstart') {
  import('./umzug').then(m => m.startPackStart());
} else if (boot.page === 'umzug') {
  import('./umzug').then(m => m.startUmzug(boot));
} else if (boot.trashed) {
  startTrashed(boot);
} else if (!boot.exists && location.hash === '#pack') {
  // Alte Adresse /<id>#pack für eine neue Liste: in den Bereich der Packlisten-App.
  location.replace(`/pack/${encodeURIComponent(boot.id!)}`);
} else if (boot.kind === 'pack') {
  // Packlisten: alle eigenen nebeneinander, Wechsel per Reiter oder Wischen.
  import('./pack-pager').then(m => m.startPager(boot, (b, host) => startDoc(b, host)));
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
