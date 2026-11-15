// Wechselkurse fürs Rechnen im Text: EZB-Tageskurse (pro 1 EUR), im Isolate
// und über den Cloudflare-Cache zwischengespeichert. Fehlt die EZB, rechnet
// die Ansicht einfach ohne Umrechnung.

import { parseEcb, setRates, hasRates } from '../shared/calc';

const ECB = 'https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml';
const TTL = 6 * 3600 * 1000;

let rates: Record<string, number> | null = null;
let at = 0;
let pending: Promise<Record<string, number> | null> | null = null;

export function fxRates(): Promise<Record<string, number> | null> {
  if (rates && Date.now() - at < TTL) return Promise.resolve(rates);
  if (pending) return pending;
  pending = fetch(ECB, { cf: { cacheTtl: 21600, cacheEverything: true } })
    .then(r => (r.ok ? r.text() : Promise.reject(new Error(String(r.status)))))
    .then(xml => {
      const parsed = parseEcb(xml);
      if (Object.keys(parsed).length < 5) throw new Error('Kurse unlesbar');
      rates = parsed;
      at = Date.now();
      setRates(rates);
      return rates;
    })
    .catch(err => { console.error('EZB-Kurse', err); return rates; })
    .finally(() => { pending = null; });
  return pending;
}

const CURRENCY = /[€$£¥]|\b(?:EUR|USD|CHF|GBP|JPY|Euro|Dollar|Franken)\b/;

/** Vor dem Rendern: Kurse holen, wenn ein Text auf = endende Zeilen mit Währungen hat (max. 1,5 s). */
export async function ratesFor(texts: string[]): Promise<void> {
  if (hasRates() && Date.now() - at < TTL) return;
  if (!texts.some(t => t.includes('=') && CURRENCY.test(t))) return;
  await Promise.race([fxRates(), new Promise(r => setTimeout(r, 1500))]);
}
