// Menü hinter „md“: überall gleich aufgebaut, aber passend zum Werkzeug.
//
//   1. Was man hier tun kann (Neues Dokument, Alle Dokumente …)
//   2. Zuletzt geöffnet – nur von derselben Art (nicht bei Packlisten: die
//      stehen alle als Reiter oben)
//   3. Die anderen Werkzeuge (Dokumente, Boards, Packlisten, Memos);
//      Packlisten und Memos zeigen sich gegenseitig zuerst (beides eigene Apps).
//      Neu angelegt werden sie dort, nicht von außen (das braucht man selten).
//   4. Konto, Einstellungen
//
// Die Übersicht (/home) filtert über ?art=md|board nach Art; Packlisten stehen dort nicht.

import { el, recent, ago, docTags, docHref, toast, recentTitle, type MenuItem, type Recent } from './ui';
import { accountItems } from './account';
import { fineRow } from './settings';
import { openAsNew } from './importer';

export type Tool = 'md' | 'board' | 'pack' | 'memos' | 'home';

const kindOf = (r: Recent): 'md' | 'board' | 'pack' => r.kind || 'md';

/** Neue Seite nur mit Verbindung (Spam-Schutz und Anlegen gehen über den Server). */
function go(href: string, needsNet = false) {
  if (needsNet && !navigator.onLine) { toast('Offline: Neues geht nur mit Verbindung.'); return; }
  location.href = href;
}

export const NEW: Record<'md' | 'board' | 'pack', [string, () => void]> = {
  md: ['Neues Dokument', () => go('/', true)],
  board: ['Neues Board', () => go('/#board', true)],
  pack: ['Neue Packliste', () => go('/pack/new', true)],
};

const TOOLS: [Tool, string, string][] = [
  ['md', 'Dokumente', '/home?art=md'],
  ['board', 'Boards', '/home?art=board'],
  ['pack', 'Packlisten', '/pack'],
  ['memos', 'Memos', '/memos'],
];

function recentRow(r: Recent): HTMLElement {
  const tags = docTags(r);
  return el('a', { href: docHref(r.id, r.kind), class: 'recent' },
    el('span', { class: 'recent-title' }, recentTitle(r)),
    el('span', { class: 'recent-meta' }, `${ago(r.at)}${r.own ? ' · bearbeitbar' : ''}${tags.length ? ' · ' + tags.join(', ') : ''}`),
  );
}

/** Einträge fürs „md“-Menü. `current`: das gerade offene Dokument (nicht in der Liste). */
export function toolMenu(here: Tool, current = ''): MenuItem[] {
  const items: MenuItem[] = [];

  if (here === 'md') items.push(NEW.md, ['Datei öffnen …', () => openAsNew()], ['Alle Dokumente', () => go('/home?art=md')]);
  else if (here === 'board') items.push(NEW.board, ['Alle Boards', () => go('/home?art=board')]);
  else if (here === 'pack') items.push(NEW.pack);
  else if (here === 'home') items.push(NEW.md, NEW.board, ['Datei öffnen …', () => openAsNew()]);

  if (here === 'md' || here === 'board') {
    const same = recent.list().filter(r => kindOf(r) === here && r.id !== current && !r.trashed).slice(0, 5);
    if (same.length) {
      items.push(el('div', { class: 'menu-label' }, 'Zuletzt geöffnet'));
      for (const r of same) items.push(recentRow(r));
    }
  }

  // In der Übersicht sind Dokumente und Boards Filter auf der Seite selbst.
  const sibling: Tool | '' = here === 'pack' ? 'memos' : here === 'memos' ? 'pack' : '';
  const others = TOOLS.filter(([t]) => t !== here && !(here === 'home' && (t === 'md' || t === 'board')))
    .sort((a, b) => Number(b[0] === sibling) - Number(a[0] === sibling));
  items.push(el('div', { class: 'menu-label' }, here === 'home' ? 'Werkzeuge' : 'Weitere'));
  for (const [, label, href] of others) items.push([label, () => go(href)]);

  if (here !== 'home') items.push(...accountItems()); // dort oben rechts
  items.push(fineRow());
  return items;
}
