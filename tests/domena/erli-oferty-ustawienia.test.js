import { expect, it } from 'vitest';
import { brakiUstawienOfert } from '../../src/domena/erli-oferty-ustawienia.js';

it('wymienia brakujące domyślne dane oferty, także dla nowego konta', () => {
  expect(brakiUstawienOfert(null)).toEqual(['stała liczba sztuk', 'czas wysyłki', 'cennik dostaw', 'stawka VAT']);
  expect(brakiUstawienOfert({ stalaIlosc: null, czasWysylkiDni: 0, cennikDostaw: 'demo', stawkaVat: 'zw' })).toEqual([
    'stała liczba sztuk',
  ]);
  expect(
    brakiUstawienOfert({ stalaIlosc: 3, czasWysylkiDni: 0, cennikDostaw: 'demo', stawkaVat: '0', czynne: false }),
  ).toEqual([]);
});
