import { describe, expect, it } from 'vitest';
import { MODULY_KURIEROW } from '../../src/domena/moduly-kurierow.ts';
import { kurierzyDoWyboru, powodOdmowyZamiennika } from '../../src/domena/kurier-nadania.js';

const metody = Object.values(MODULY_KURIEROW).flatMap((k) => k.metody.map((m) => m.klucz));

function sprawdzRownowaznosc(rejestr, umowyPobrania) {
  for (const metoda of metody) {
    const z = { sklep: 'allegro_polcien', metoda_wysylki: metoda, pobranie: 1 };
    const lista = kurierzyDoWyboru(z, 2, { rejestr, umowyPobrania, pobranieNaTejPaczce: true });
    // WZA_DO_WYBORU przedstawia metodę Allegro wspólnym kluczem wyboru „wza”.
    const klucz = rejestr.allegro_wza.metody.some((m) => m.klucz === metoda) ? 'wza' : metoda;
    expect(lista.some((k) => k.klucz === klucz), metoda)
      .toBe(powodOdmowyZamiennika(z, metoda, { rejestr, umowyPobrania }) === null);
  }
}

describe.each([[], ['inpost']].map((umowyPobrania) => ({ umowyPobrania })))('zamiennik, umowy: $umowyPobrania', ({ umowyPobrania }) => {
  it('wszystkie metody rejestru i WzA: lista wyboru zgadza się z barierą usługi', () => {
    sprawdzRownowaznosc(MODULY_KURIEROW, umowyPobrania);
  });

  it.each(['dpd', 'inpost'])('respektuje brak obsługi pobrania na dosyłce także dla %s', (kurier) => {
    // Dziś obaj własni kurierzy mają tę zdolność. Wariant rejestru wykrywa
    // usunięcie filtra pobranieNaDosylce, którego obecne dane nie ujawnią.
    const opis = MODULY_KURIEROW[kurier];
    const rejestr = { ...MODULY_KURIEROW, [kurier]: {
      ...opis, umiejetnosci: { ...opis.umiejetnosci, pobranieNaDosylce: false },
    } };
    sprawdzRownowaznosc(rejestr, umowyPobrania);
  });
});
