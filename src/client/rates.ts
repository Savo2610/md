// Wechselkurse für das Rechnen im Text. Kommen vom Worker (EZB-Tageskurse)
// und liegen einen Tag im Browser, damit es offline weiter rechnet.

import { setRates, hasRates } from '../shared/calc';

const KEY = 'md_fx';
let loading: Promise<boolean> | null = null;

try {
  const saved = JSON.parse(localStorage.getItem(KEY) || 'null');
  if (saved?.rates) setRates(saved.rates);
} catch { /* kein Speicher */ }

/** Lädt die Kurse (einmal pro Tag). true, wenn sie neu dazugekommen sind. */
export function loadRates(): Promise<boolean> {
  if (loading) return loading;
  let fresh = false;
  try { fresh = Date.now() - (JSON.parse(localStorage.getItem(KEY) || 'null')?.at || 0) < 86400000; } catch { /* egal */ }
  if (fresh && hasRates()) return Promise.resolve(false);
  const had = hasRates();
  loading = fetch('/api/fx').then(r => (r.ok ? r.json() : null)).then((data: { rates?: Record<string, number> } | null) => {
    if (!data?.rates) return false;
    setRates(data.rates);
    try { localStorage.setItem(KEY, JSON.stringify({ at: Date.now(), rates: data.rates })); } catch { /* voll */ }
    return !had;
  }).catch(() => false);
  return loading;
}
