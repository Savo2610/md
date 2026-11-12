// Einstellungen (klein im Menü versteckt): Darstellung und Rechtschreibprüfung.
//
// Die Darstellung liegt in einem Cookie (md_theme), damit der Server die
// Seite gleich richtig ausliefert und nichts aufblitzt. Ohne Cookie folgt
// md dem System (hell/dunkel).

import { el, dialog, store } from './ui';
import { account } from './account';

export type Theme = 'auto' | 'light' | 'dark';

const COLORS = { light: '#ffffff', dark: '#1b1b1b' };

export function currentTheme(): Theme {
  const t = document.documentElement.dataset.theme;
  return t === 'light' || t === 'dark' ? t : 'auto';
}

export function applyTheme(t: Theme) {
  const root = document.documentElement;
  if (t === 'auto') delete root.dataset.theme;
  else root.dataset.theme = t;
  document.cookie = t === 'auto'
    ? 'md_theme=; Path=/; Max-Age=0; SameSite=Lax'
    : `md_theme=${t}; Path=/; Max-Age=31536000; SameSite=Lax`;
  const scheme = document.querySelector<HTMLMetaElement>('meta[name="color-scheme"]');
  if (scheme) scheme.content = t === 'auto' ? 'light dark' : t;
  for (const m of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) {
    const own = m.media.includes('dark') ? COLORS.dark : COLORS.light;
    m.content = t === 'auto' ? own : COLORS[t];
  }
}

export const spellcheckOn = () => store.get('md:spellcheck') !== '0';
/** Eigene Dokumente direkt zum Bearbeiten öffnen statt in der Ansicht. */
export const openInEdit = () => store.get('md:open') === 'edit';
/** Name beim gemeinsamen Schreiben: selbst gesetzt, sonst Vorname aus dem Konto. */
export const writerName = () => store.get('md:name') || (account.user?.name || '').split(' ')[0].slice(0, 30);

/** Umschalter aus mehreren Knöpfen (role=radiogroup). */
function segmented<T extends string>(label: string, options: [T, string][], get: () => T, set: (v: T) => void): HTMLElement {
  const seg = el('div', { class: 'seg', role: 'radiogroup', 'aria-label': label });
  const draw = () => {
    seg.replaceChildren();
    for (const [value, text] of options) {
      const b = el('button', { type: 'button', role: 'radio', 'aria-checked': String(get() === value) }, text);
      b.addEventListener('click', () => { set(value); draw(); });
      seg.append(b);
    }
  };
  draw();
  return seg;
}

export function settingsDialog() {
  const theme = segmented<Theme>('Darstellung', [['auto', 'Automatisch'], ['light', 'Hell'], ['dark', 'Dunkel']], currentTheme, applyTheme);
  const open = segmented<'view' | 'edit'>('Beim Öffnen', [['view', 'Ansicht'], ['edit', 'Bearbeiten']],
    () => (openInEdit() ? 'edit' : 'view'),
    v => (v === 'edit' ? store.set('md:open', 'edit') : store.del('md:open')));

  const name = el('input', { type: 'text', class: 'set-input', value: store.get('md:name') || '', placeholder: writerName() || 'Gast', maxlength: '30', 'aria-label': 'Dein Name' }) as HTMLInputElement;
  name.addEventListener('change', () => {
    const v = name.value.trim().slice(0, 30);
    if (v) store.set('md:name', v); else store.del('md:name');
    dispatchEvent(new CustomEvent('md:name'));
  });

  const spell = el('input', { type: 'checkbox', id: 'set-spell' }) as HTMLInputElement;
  spell.checked = spellcheckOn();
  spell.addEventListener('change', () => {
    store.set('md:spellcheck', spell.checked ? '1' : '0');
    dispatchEvent(new CustomEvent('md:spellcheck', { detail: spell.checked }));
  });

  dialog('Einstellungen', el('div', { class: 'settings' },
    el('div', { class: 'set-row' }, el('span', {}, 'Darstellung'), theme),
    el('div', { class: 'set-row' }, el('span', {}, 'Beim Öffnen', el('small', {}, 'Für Dokumente, die du bearbeiten darfst')), open),
    el('div', { class: 'set-row' }, el('span', {}, 'Dein Name', el('small', {}, 'Beim gemeinsamen Schreiben')), name),
    el('label', { class: 'set-row', for: 'set-spell' }, el('span', {}, 'Rechtschreibprüfung beim Schreiben'), spell),
  ));
}

/** Kleine Zeile unten im Menü: Einstellungen · Datenschutz. */
export function fineRow(): HTMLElement {
  const settings = el('button', { type: 'button' }, 'Einstellungen');
  settings.addEventListener('click', () => {
    settings.closest('dialog')?.close();
    settingsDialog();
  });
  return el('div', { class: 'menu-fine' }, settings, el('a', { href: '/datenschutz' }, 'Datenschutz'));
}
