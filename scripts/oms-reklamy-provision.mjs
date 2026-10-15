import { pathToFileURL } from 'node:url';
import { openOmsDb } from '../src/oms/db/db.ts';
import { polaczenia, zapiszPolaczenie } from '../src/oms/db/reklamy.js';

// Jednorazowe powiązanie już istniejących sekretów środowiskowych z lustrem reklam.
// Parametry to identyfikatory kont i kanałów, nigdy token ani zawartość klucza.
export function provisionReklam(db, args, env = process.env) {
  const wynik = [];
  for (const arg of args) {
    const match = /^--(ga4|meta)=([^:]+)(?::([^:]+))?$/.exec(arg);
    if (!match) throw new Error('Oczekiwano --ga4=ID:kanal lub --meta=ID[:kanal].');
    const [, typ, kontoId, kanal = null] = match;
    if (typ === 'ga4' && (!env.GA4_KLUCZ || !kanal)) throw new Error('GA4 wymaga istniejącego klucza i kanału OMS.');
    if (typ === 'meta' && (!env.META_TOKEN || !String(env.META_KONTA ?? '').split(',').includes(kontoId))) {
      throw new Error('Konto Meta musi należeć do skonfigurowanej listy kont.');
    }
    const zapisane = polaczenia(db).find((p) => p.typ === typ && p.kontoId === kontoId);
    if (zapisane) {
      if (zapisane.kanal !== kanal) throw new Error('Połączenie istnieje z innym kanałem OMS.');
      wynik.push({ typ, kontoId, id: zapisane.id, stan: 'istnieje' });
      continue;
    }
    const p = zapiszPolaczenie(db, { typ, kontoId, kanal, strefa: 'Europe/Warsaw',
      sekretRef: `legacy-${typ}` });
    wynik.push({ typ, kontoId, id: p.id, stan: 'dodano' });
  }
  return wynik;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const db = openOmsDb(process.env.OMS_DB_PATH || '/data-oms/oms.sqlite');
  try {
    const wynik = provisionReklam(db, process.argv.slice(2));
    for (const w of wynik) process.stdout.write(`${w.typ} ${w.kontoId} #${w.id}: ${w.stan}\n`);
  } finally {
    db.close();
  }
}
