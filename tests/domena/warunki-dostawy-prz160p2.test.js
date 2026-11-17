import { it, expect } from 'vitest';
import { warunkiDostawy, umowaZbiorcza } from '../../src/domena/klient-zbiorczy.js';
import { opisKlienta } from '../../src/domena/klient-staly.js';

it('warunki dostawy są niezależne od okresu i rozróżniają null oraz zero', () => {
  expect(warunkiDostawy({ rozliczenie_zbiorcze: 0, koszt_dostawy_brutto: '19.00',
    prog_darmowej_dostawy_gr: null, oplata_obslugi_gr: 0 }))
    .toEqual({ progGr: null, obslugaGr: 0, kosztDostawy: '19.00' });
  expect(warunkiDostawy(null)).toBeNull();
});
it('okres nie wymaga kwot dostawy', () => {
  expect(umowaZbiorcza({ rozliczenie_zbiorcze: 1, klucz: 'polcien', nazwa: 'Pracownia Półcień', nip: '1234500011' }))
    .toEqual({ klucz: 'polcien', nazwa: 'Pracownia Półcień', nip: '1234500011' });
});
it('opis pokazuje obie niezależne usługi', () => {
  expect(opisKlienta({ nazwa: 'Półcień', aktywny: 1, prog_darmowej_dostawy_gr: 50000, oplata_obslugi_gr: 400 }))
    .toContain('darmowa dostawa od 500.00 zł · obsługa 4.00 zł przy własnej etykiecie');
});
