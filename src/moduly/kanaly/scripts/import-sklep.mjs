// ⚠️⚠️ BEZ SHEBANGA — ŚWIADOMIE. Git zamienia LF na CRLF przy wymeldowaniu na Windowsie,
// a esbuild (przez vitest) zdejmuje wiersz shebanga szukając znaku nowej linii — po CRLF
// zostaje samotny znak powrotu karetki i plik przestaje się parsować. Ten sam powód, co
// w import-apilo.mjs.
import { openOmsDb } from '../../../oms/db/db.ts';
import { createWooClient } from '../../../oms/woo/client.js';
import { createImportSklepu } from '../services/import-sklep.js';
import { sufitZApilo } from '../../../oms/db/historia-sprzedazy.js';
import { konfiguracjaHistorii } from '../historia.ts';
import { definicjeKanalow } from '../konfiguracja.ts';
import { kluczeKanalu } from '../../../integracje/klucze.js';
import { sprawdzTrybProby } from '../../../core/tryb.ts';
import { skonfigurowanyUrl } from '../../../core/konfiguracja-wartosci.ts';

// Jednorazowy import historii sprzedaży ze sklepu. Uruchomienie:
//
//   node src/moduly/kanaly/scripts/import-sklep.mjs --sklep polnoc --od 2025-01-01 --do 2025-12-31 --sonda
// Klucz sklepu i prefiks zmiennych pochodzą z jawnej definicji OMS_KANALY.
//
// NAJPIERW `--sonda` (nic nie zapisuje, mierzy), potem ten sam rozkaz bez `--sonda`.
//
// ⚠️ ŚWIADOMIE NIE MA PRZYCISKU W PANELU: operacja jednorazowa, dotyka liczb, z których
// właściciel czyta sprzedaż, i nie ma powodu leżeć w zasięgu przypadkowego kliknięcia.

const WZORZEC_DATY = /^\d{4}-\d{2}-\d{2}$/;

export function parsujArgumenty(argv) {
  const wez = (nazwa) => {
    const i = argv.indexOf(nazwa);
    return i >= 0 ? argv[i + 1] : null;
  };
  const sklep = wez('--sklep');
  const od = wez('--od');
  const doDnia = wez('--do');
  if (!doDnia) {
    throw new Error('Podaj --do RRRR-MM-DD. Domyślnego „do dziś" tu nie ma: górna granica'
      + ' importu to sufit chroniący przed podwójnym policzeniem ery Apilo.');
  }
  if (!sklep || !od) throw new Error('Podaj jawnie --sklep i --od RRRR-MM-DD.');
  for (const [nazwa, wartosc] of [['--od', od], ['--do', doDnia]]) {
    if (!WZORZEC_DATY.test(wartosc)) {
      throw new Error(`${nazwa}: data musi mieć postać RRRR-MM-DD, dostałem "${wartosc}"`);
    }
  }
  return { sklep, od, doDnia, sonda: argv.includes('--sonda') };
}

async function main() {
  const { sklep, od, doDnia, sonda } = parsujArgumenty(process.argv);
  const definicje = definicjeKanalow(process.env);
  sprawdzTrybProby(process.env, definicje.flatMap(d => kluczeKanalu(d.typ, d.prefiks).kluczeIntegracji));
  const definicja = definicje.find(d => d.klucz === sklep && d.typ === 'woo');
  if (!definicja) throw new Error(`Brak kanału Woo "${sklep}" w OMS_KANALY`);
  const prefiks = definicja.prefiks;
  const wymagane = n => { if (!process.env[n]?.trim()) throw new Error(`Brak wymaganej zmiennej: ${n}`); return process.env[n]; };
  const url = wymagane(`${prefiks}_URL`);
  skonfigurowanyUrl(url, `${prefiks}_URL`);
  const ck = wymagane(`${prefiks}_CK`);
  const cs = wymagane(`${prefiks}_CS`);
  const konfiguracja = konfiguracjaHistorii(process.env, sklep, prefiks);
  const db = openOmsDb(process.env.OMS_DB_PATH ?? '/data-oms/oms.sqlite');
  try {
  console.log(`Sufit z ery Apilo: ${sufitZApilo(db, konfiguracja.konta.get(sklep)) ?? 'BRAK — era Apilo pusta'}`);

  const klient = createWooClient({
    baseUrl: url.replace(/\/+$/, ''),
    ck,
    cs,
  });
  const imp = createImportSklepu({ db, sklep, klient, konfiguracja, log: (t) => console.log(t) });

  const start = Date.now();
  const w = await imp.przebieg({ od, doDnia, sonda });
  const sekund = Math.round((Date.now() - start) / 1000);

  console.log('');
  console.log(sonda ? '=== SONDA (nic nie zapisano) ===' : '=== IMPORT ===');
  console.log(`zapisanych: ${w.pobranych}, poza oknem: ${w.pominietych}, testowych: ${w.testowych}`);
  console.log(`stron: ${w.stron}, sklep zapowiadał: ${w.razem}, czas: ${sekund} s`);
  console.log(`statusy: ${JSON.stringify(w.statusy)}`);
  console.log(`waluty:  ${JSON.stringify(w.waluty)}`);
  console.log(`lata:    ${JSON.stringify(w.lata)}`);
  if (w.zatrzymany) {
    console.error('');
    console.error(`⚠️ PRZEBIEG ZATRZYMANY: ${w.powod}`);
    process.exitCode = 1;
  }
  } finally { db.close(); }
}

if (process.argv[1]?.endsWith('import-sklep.mjs')) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
