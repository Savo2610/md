// Tags eines Dokuments bearbeiten (nur mit Konto). Tags sind persönlich:
// Sie liegen im Konto, nicht im Dokument.

import { el, dialog, recent } from './ui';
import { account } from './account';

/** Öffnet den Dialog. `done` bekommt die gespeicherten Tags. */
export function tagDialog(id: string, title: string, current: string[], done: (tags: string[]) => void) {
  let tags = [...current];
  const chosen = el('div', { class: 'tag-list' });
  const offer = el('div', { class: 'tag-list' });
  const input = el('input', { type: 'text', placeholder: 'Neuer Tag …', maxlength: '30', 'aria-label': 'Neuer Tag', autocapitalize: 'off', enterkeyhint: 'done' }) as HTMLInputElement;
  const save = el('button', { type: 'submit', class: 't boxed' }, 'Fertig');
  const offerWrap = el('div', { class: 'field-row' }, el('label', {}, 'Vorhandene Tags'), offer);

  const has = (t: string) => tags.some(x => x.toLowerCase() === t.toLowerCase());
  const add = (raw: string) => {
    for (const part of raw.split(',')) {
      const t = part.replace(/^#+/, '').replace(/\s+/g, ' ').trim().slice(0, 30);
      if (t && !has(t) && tags.length < 20) tags.push(t);
    }
    draw();
  };
  const draw = () => {
    chosen.replaceChildren();
    if (!tags.length) chosen.append(el('span', { class: 'hint' }, 'Noch keine Tags.'));
    for (const t of tags) {
      const b = el('button', { type: 'button', class: 'tag on', title: `„${t}“ entfernen` }, t, el('span', { class: 'tag-x', 'aria-hidden': 'true' }, '×'));
      b.addEventListener('click', () => { tags = tags.filter(x => x !== t); draw(); });
      chosen.append(b);
    }
    offer.replaceChildren();
    const q = input.value.trim().toLowerCase();
    const rest = account.allTags().filter(t => !has(t) && (!q || t.toLowerCase().includes(q)));
    for (const t of rest.slice(0, 30)) {
      const b = el('button', { type: 'button', class: 'tag' }, `+ ${t}`);
      b.addEventListener('click', () => { add(t); input.value = ''; draw(); input.focus(); });
      offer.append(b);
    }
    offerWrap.hidden = !rest.length;
  };

  // #tags aus dem Text: stehen dabei, ändern lassen sie sich nur im Text.
  const fromText = (recent.list().find(r => r.id === id)?.textTags || []).filter(t => !has(t));
  const textRow = fromText.length ? el('p', { class: 'hint' }, `Aus dem Text: ${fromText.map(t => `#${t}`).join(' ')}`) : '';
  const form = el('form', { class: 'sheet tag-form' },
    el('p', { class: 'hint tag-doc' }, title || id),
    el('div', { class: 'field-row' }, chosen, textRow),
    el('div', { class: 'field-row' }, el('div', { class: 'field-line' }, input, save)),
    offerWrap,
  );
  input.addEventListener('input', draw);
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter' && input.value.trim()) { e.preventDefault(); add(input.value); input.value = ''; draw(); }
    else if (e.key === 'Backspace' && !input.value && tags.length) { tags.pop(); draw(); }
  });
  const d = dialog('Tags', form);
  form.addEventListener('submit', async e => {
    e.preventDefault();
    if (input.value.trim()) { add(input.value); input.value = ''; }
    save.disabled = true;
    const ok = await account.setTags(id, tags);
    save.disabled = false;
    if (!ok) return;
    d.close();
    done(tags);
  });
  draw();
  setTimeout(() => input.focus(), 30);
}

/** Kleine, anklickbare Tag-Marken für Listen. */
export function tagChips(tags: string[] | undefined, onPick?: (t: string) => void): HTMLElement | null {
  if (!tags?.length) return null;
  const box = el('span', { class: 'note-tags' });
  for (const t of tags) {
    const chip = el('span', { class: 'tag small', role: onPick ? 'button' : 'none' }, t);
    if (onPick) chip.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); onPick(t); });
    box.append(chip);
  }
  return box;
}
