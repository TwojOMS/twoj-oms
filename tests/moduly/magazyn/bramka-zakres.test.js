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
