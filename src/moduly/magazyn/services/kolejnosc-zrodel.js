import { zapiszUstawienia } from '../../../oms/db/ustawienia.js';
import { MODUL_ALLEGRO } from '../../../domena/modul-allegro.ts';

const KLUCZ = 'magazyn.kolejnosc_zrodel';
// Powiązanie z bazą izoluje instancje OMS (w tym testy). Dostawca czyta bieżącą konfigurację,
// więc nowe połączenie z Ustawień pojawia się bez restartu i bez kopiowania konfiguracji kanałów.
const konfiguracje = new WeakMap();
export function skonfigurujZrodla(db, konfiguracja) {
  konfiguracje.set(db, konfiguracja);
}

export function polaczeniaZrodel(db) {
  const config = konfiguracje.get(db)?.() ?? {};
  const nazwa = klucz => config.definicje?.find(d => d.klucz === klucz)?.etykieta || klucz;
  return [
    ...Object.keys(config.sklepy ?? {}).map(k => ({ klucz: `woo:${k}`, nazwa: nazwa(k) })),
    ...Object.keys(config.kanaly ?? {}).filter(k => !config.definicje?.find(d => d.klucz === k)?.typ
      || config.definicje.find(d => d.klucz === k).typ === MODUL_ALLEGRO.typ)
      .map(k => ({ klucz: `allegro:${k}`, nazwa: nazwa(k) })),
  ];
}

export function kolejnoscZrodel(db) {
  const domyslna = polaczeniaZrodel(db).map(p => p.klucz);
  const wiersz = db.prepare('SELECT wartosc FROM ustawienia WHERE klucz = ?').get(KLUCZ);
  let zapisana;
  try { zapisana = JSON.parse(wiersz?.wartosc ?? 'null'); } catch { zapisana = null; }
  if (!Array.isArray(zapisana)) return domyslna;
  return [...new Set([...zapisana.filter(k => domyslna.includes(k)), ...domyslna])];
}

export function zapiszKolejnoscZrodel(db, kolejnosc) {
  const znane = new Set(polaczeniaZrodel(db).map(p => p.klucz));
  if (!Array.isArray(kolejnosc) || kolejnosc.some(k => typeof k !== 'string' || !znane.has(k))
      || new Set(kolejnosc).size !== kolejnosc.length) {
    throw new Error('Kolejność musi zawierać znane, niepowtarzające się klucze połączeń.');
  }
  zapiszUstawienia(db, { [KLUCZ]: JSON.stringify(kolejnosc) });
}
