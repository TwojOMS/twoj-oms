import { it, expect } from 'vitest';
import { bramkaZapisu } from '../../../src/moduly/magazyn/services/oferty-wspolne.js';

it.each([
  ['ilość obserwowanej', 'ilosc', 'obserwowana', 1, 1, true],
  ['treść obserwowanej', undefined, 'obserwowana', 1, 1, false],
  ['jawny zakres treści', 'tresc', 'obserwowana', 1, 1, false],
  ['bez flagi', 'ilosc', 'obserwowana', 0, 1, false],
  ['zarządzana bez flagi', 'ilosc', 'zarzadzana', 0, 1, true],
  ['jak dotąd zarządzana', undefined, 'zarzadzana', 0, 1, true],
  ['wstrzymane', 'ilosc', 'obserwowana', 1, 0, false],
  ['inny tryb', 'ilosc', 'do_wyslania', 1, 1, false],
])('%s', (_, zakres, tryb, ilosc_z_oms, czynne, wolno) => {
  const wynik = bramkaZapisu({
    konto: { klucz: 'polcien' },
    klucze: ['polcien'],
    ustawienia: { czynne },
    oferta: { kanal: 'polcien', tryb, ilosc_z_oms },
    zakres,
  });
  expect(wynik.wolno).toBe(wolno);
  if (!czynne) expect(wynik.powod).toBe('oferty wstrzymane');
});

it.each(['obce-konto', 'tylko-odczyt', 'obca-oferta', 'brak-oferty'])(
  'zakres ilości zachowuje blokadę %s',
  (blokada) => {
    expect(
      bramkaZapisu({
        konto: { klucz: 'polcien', tylkoOdczyt: () => blokada === 'tylko-odczyt' },
        klucze: blokada === 'obce-konto' ? [] : ['polcien'],
        ustawienia: { czynne: 1 },
        zakres: 'ilosc',
        oferta:
          blokada === 'brak-oferty'
            ? null
            : { kanal: blokada === 'obca-oferta' ? 'inne' : 'polcien', tryb: 'obserwowana', ilosc_z_oms: 1 },
      }).wolno,
    ).toBe(false);
  },
);

// Wyrocznia spisana z reguły: obserwowana przepuszcza wyłącznie zakres, którego flagę OMS przejął.
const FLAGA_ZAKRESU = { ilosc: 'ilosc_z_oms', cena: 'cena_z_oms', status: 'status_z_oms' };
function oczekiwane({ tryb, flagi, zakres, czynne, tylkoOdczyt }) {
  if (!czynne || tylkoOdczyt) return false;
  if (tryb === 'zarzadzana') return true;
  return tryb === 'obserwowana' && Boolean(FLAGA_ZAKRESU[zakres]) && flagi[FLAGA_ZAKRESU[zakres]] === 1;
}

const TRYBY = ['zarzadzana', 'obserwowana', 'do_wyslania'];
const ZAKRESY = [null, undefined, 'tresc', 'ilosc', 'cena', 'status'];
const ZESTAWY_FLAG = [0, 1, 2, 3, 4, 5, 6, 7].map((b) => ({
  ilosc_z_oms: b & 1 ? 1 : 0,
  cena_z_oms: b & 2 ? 1 : 0,
  status_z_oms: b & 4 ? 1 : 0,
}));
const MACIERZ = TRYBY.flatMap((tryb) =>
  ZESTAWY_FLAG.flatMap((flagi) =>
    ZAKRESY.flatMap((zakres) =>
      [0, 1].flatMap((czynne) => [false, true].map((tylkoOdczyt) => ({ tryb, flagi, zakres, czynne, tylkoOdczyt }))),
    ),
  ),
);

it(`macierz tryb × flagi × zakres × czynne × tylko odczyt (${MACIERZ.length} przypadków)`, () => {
  const rozjazdy = MACIERZ.filter((p) => {
    const wynik = bramkaZapisu({
      konto: { klucz: 'polcien', tylkoOdczyt: () => p.tylkoOdczyt },
      klucze: ['polcien'],
      kanal: 'Allegro',
      ustawienia: { czynne: p.czynne },
      oferta: { kanal: 'polcien', tryb: p.tryb, ...p.flagi },
      zakres: p.zakres,
    });
    return wynik.wolno !== oczekiwane(p);
  });
  expect(rozjazdy).toEqual([]);
  // Obserwowana przechodzi tylko w trzech parach zakres + własna flaga.
  const przepuszczone = MACIERZ.filter((p) => p.tryb === 'obserwowana' && oczekiwane(p));
  expect(new Set(przepuszczone.map((p) => p.zakres))).toEqual(new Set(['ilosc', 'cena', 'status']));
});

it.each([
  ['cena przy samej fladze ceny', 'cena', { cena_z_oms: 1 }, true],
  ['status przy samej fladze statusu', 'status', { status_z_oms: 1 }, true],
  ['PATCH treści przy fladze ceny', null, { cena_z_oms: 1 }, false],
  ['PATCH treści przy fladze statusu', null, { status_z_oms: 1 }, false],
  ['treść przy obu flagach', 'tresc', { cena_z_oms: 1, status_z_oms: 1 }, false],
  ['ilość przy fladze ceny', 'ilosc', { cena_z_oms: 1 }, false],
  ['status przy fladze ceny', 'status', { cena_z_oms: 1 }, false],
  ['cena przy fladze statusu', 'cena', { status_z_oms: 1 }, false],
  ['cena przy fladze ilości', 'cena', { ilosc_z_oms: 1 }, false],
  ['flaga jako tekst „1” z bazy', 'cena', { cena_z_oms: '1' }, true],
])('obserwowana: %s', (_, zakres, flagi, wolno) => {
  const wynik = bramkaZapisu({
    konto: { klucz: 'polcien' },
    klucze: ['polcien'],
    ustawienia: { czynne: 1 },
    oferta: { kanal: 'polcien', tryb: 'obserwowana', ...flagi },
    zakres,
  });
  expect(wynik.wolno).toBe(wolno);
  if (!wolno) expect(wynik.powod).toBe('oferta nie jest zarządzana przez OMS');
});

it.each(['cena', 'status'])('wstrzymane oferty konta zatrzymują też zakres %s', (zakres) => {
  const wynik = bramkaZapisu({
    konto: { klucz: 'polcien' },
    klucze: ['polcien'],
    ustawienia: { czynne: 0 },
    oferta: { kanal: 'polcien', tryb: 'obserwowana', cena_z_oms: 1, status_z_oms: 1 },
    zakres,
  });
  expect(wynik).toEqual({ wolno: false, powod: 'oferty wstrzymane' });
});
