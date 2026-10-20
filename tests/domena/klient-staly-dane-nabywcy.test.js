import { describe, it, expect } from 'vitest';

import { daneNabywcyNaKarcie } from '../../src/domena/klient-staly.js';

// Czysta reguła scalania „Uaktualnij dane stałego klienta” (PRZ-102.07). Drogę HTTP pokrywa
// tests/moduly/zamowienia/zapamietaj-klienta-umowa.test.js; tutaj gałęzie, do których trasa
// dziś nie dochodzi (pusty NIP — trasa znajduje istniejącego klienta właśnie po NIP-ie).

const KARTA = {
  id: 7, klucz: 'przykladowa', nazwa: 'Pracownia Przykładowa', nip: '1234500011',
  rozliczenie_zbiorcze: 1, prog_darmowej_dostawy_gr: 50000,
  faktura: { firma: 'Pracownia Przykładowa sp. z o.o.', nip: '1234500011', ulica: 'Stara 1' },
  wysylka: { telefon: '500000001' },
};

describe('daneNabywcyNaKarcie', () => {
  it('pusty NIP z zamówienia nie kasuje NIP-u z karty', () => {
    const wynik = daneNabywcyNaKarcie(KARTA, {
      nazwa: 'Inna', nip: null, faktura: { nip: null, ulica: '  ' }, wysylka: { telefon: '' },
    });
    expect(wynik.nip).toBe('1234500011');
    expect(wynik.faktura).toEqual(KARTA.faktura);
    expect(wynik.wysylka).toEqual(KARTA.wysylka);
  });

  it('nazwa z zamówienia trafia tylko na kartę bez nazwy', () => {
    expect(daneNabywcyNaKarcie({ ...KARTA, nazwa: ' ' }, { nazwa: 'Z zamówienia' }).nazwa).toBe('Z zamówienia');
    expect(daneNabywcyNaKarcie(KARTA, { nazwa: 'Z zamówienia' }).nazwa).toBe('Pracownia Przykładowa');
  });

  describe('adres jako całość', () => {
    const KARTA_Z_ADRESEM = {
      ...KARTA,
      faktura: { ...KARTA.faktura, kod: '00-001', miasto: 'Warszawa' },
      wysylka: { firma: 'Stary Odbiorca', ulica: 'Stara 1', kod: '00-001', miasto: 'Warszawa', telefon: '500000001' },
    };

    it('jedno niepuste pole adresu przenosi cały adres, także puste pola', () => {
      const wynik = daneNabywcyNaKarcie(KARTA_Z_ADRESEM, {
        faktura: { ulica: null, kod: null, miasto: 'Kraków' },
        wysylka: { firma: null, ulica: 'Nowa 5', kod: '', miasto: null },
      });
      expect(wynik.faktura).toMatchObject({ ulica: null, kod: null, miasto: 'Kraków', firma: 'Pracownia Przykładowa sp. z o.o.' });
      expect(wynik.wysylka).toEqual({ firma: null, ulica: 'Nowa 5', kod: null, miasto: null, telefon: '500000001' });
    });

    it('sama firma odbiorcy bez adresu niczego w adresie nie zmienia', () => {
      const wynik = daneNabywcyNaKarcie(KARTA_Z_ADRESEM, {
        wysylka: { firma: 'Nowy Odbiorca', ulica: ' ', kod: null, miasto: '' },
      });
      expect(wynik.wysylka).toEqual(KARTA_Z_ADRESEM.wysylka);
    });
  });

  it('pól spoza danych nabywcy nie bierze z zamówienia', () => {
    const wynik = daneNabywcyNaKarcie(KARTA, { nazwa: 'X', nip: '1234500011', rozliczenie_zbiorcze: 0, klucz: 'inny' });
    expect(wynik).toMatchObject({ id: 7, klucz: 'przykladowa', rozliczenie_zbiorcze: 1, prog_darmowej_dostawy_gr: 50000 });
  });
});
