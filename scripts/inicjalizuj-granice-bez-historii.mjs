import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { wczytajRaporty } from '../src/moduly/raporty/konfiguracja.ts';
import { definicjeKanalow } from '../src/moduly/kanaly/konfiguracja.ts';
import { inicjalizujGraniceBezHistorii } from '../src/domena/sprzedaz-okresu.js';
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
/**
 * Jawna jednorazowa inicjalizacja: node --env-file=.env scripts/inicjalizuj-granice-bez-historii.mjs BAZA RAPORT RRRR-MM-DD
 * Dzień granicy musi poprzedzać pierwszą sprzedaż OMS. Kanały z historią wymagają osobnego pomiaru.
 * Istniejąca granica nigdy nie jest nadpisywana. Skrypt otwiera wyłącznie istniejącą bazę bez migracji.
 */
export function wykonaj(argv, env) {
  if (argv.length !== 3) throw new Error('Użycie: BAZA RAPORT RRRR-MM-DD');
  const [plik,kanal,dzien]=argv;
  if (!existsSync(plik)) throw new Error('Baza musi już istnieć');
  const {regulySprzedazy}=wczytajRaporty(env);
  // PRZ-062 (recenzja D8 r1, P2-1): granica w dniu <P>_OD kanału albo później po cichu i bez odwrotu wycina
  // z raportu zamówienia pobrane od OD — przed pierwszym przebiegiem pollera nic innego tego nie złapie.
  for (const d of definicjeKanalow(env)) {
    const od=String(env[`${d.prefiks}_OD`] ?? '').trim();
    if (d.raport===kanal && /^\d{4}-\d{2}-\d{2}$/.test(od) && dzien>=od)
      throw new Error(`Granica ${kanal} ${dzien} nie może być w dniu ${d.prefiks}_OD (${od}) ani później — zamówienia od OD zniknęłyby z raportu; użyj dnia przed OD`);
  }
  const db=new DatabaseSync(plik,{readOnly:false});
  try {inicjalizujGraniceBezHistorii(db,kanal,dzien,regulySprzedazy.klasyfikacja);}
  finally {db.close();}
}
if (process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
  try {wykonaj(process.argv.slice(2),process.env);process.stdout.write('Zapisano jawną granicę kanału bez historii.\n');}
  catch(e) {process.stderr.write(e.message+'\n');process.exitCode=1;}
}
