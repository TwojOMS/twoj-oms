import { definicjeKanalowHistoryczne } from '../pomoc/kanaly-historyczne-fixture.js';
import { describe, expect, it } from 'vitest';
import {
  adresKartyZamowienia,
  adresPowrotuDoWiersza,
  kluczPozycjiListy,
} from '../../src/domena/adres-karty-zamowienia.js';

describe('adres karty zamówienia', () => {
  it('koduje kanoniczny powrót i dokłada dozwolony stan przed kotwicą', () => {
    expect(adresKartyZamowienia('12/3', {
      powrot: '/?status=w_realizacji&szukaj=Jan%20Kowalski',
      stan: 'wysylka',
      kotwica: 'wysylka',
    }, definicjeKanalowHistoryczne)).toBe('/zamowienia/12%2F3?powrot=%2F%3Fstatus%3Dw_realizacji%26szukaj%3DJan%2520Kowalski&edytuj=wysylka#wysylka');
  });

  it('odrzuca nieznany stan i nie pozwala wstrzyknąć własnej kotwicy', () => {
    expect(adresKartyZamowienia(17, { powrot: '/', stan: 'admin', kotwica: '#x?y' }, definicjeKanalowHistoryczne))
      .toBe('/zamowienia/17');
  });

  it('zewnętrzny, tablicowy i niekanoniczny powrót zastępuje gołą listą', () => {
    for (const powrot of ['https://obcy.example/', '//obcy.example/', '/faktury', ['/?status=nowe']]) {
      expect(adresKartyZamowienia(8, { powrot }, definicjeKanalowHistoryczne)).toBe('/zamowienia/8');
    }
  });

  it('powrót do listy kończy się stabilną kotwicą wiersza', () => {
    expect(adresPowrotuDoWiersza('/?status=nowe', 123, definicjeKanalowHistoryczne))
      .toBe('/?status=nowe#zamowienie-123');
    expect(adresPowrotuDoWiersza('javascript:alert(1)', 123, definicjeKanalowHistoryczne))
      .toBe('/#zamowienie-123');
  });

  it('serwer tworzy osobny klucz SHA-256 bez ujawnienia frazy wyszukiwania', () => {
    const klucz = kluczPozycjiListy('/?status=nowe&szukaj=Jan%20Kowalski', definicjeKanalowHistoryczne);
    expect(klucz).toMatch(/^oms:pozycja-listy:v1:[a-f0-9]{64}$/);
    expect(klucz).not.toContain('Jan');
    expect(klucz).not.toContain('Kowalski');
    expect(kluczPozycjiListy('/?status=wyslane', definicjeKanalowHistoryczne)).not.toBe(klucz);
  });
});
