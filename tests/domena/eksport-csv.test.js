import { describe, it, expect } from 'vitest';

import { csvSprzedazy, nazwaPlikuSprzedazy } from '../../src/domena/eksport-csv.js';

const wiersz = (dodatki = {}) => ({
  dzien: '2026-06-10',
  kanal: 'SZKICOWNIA_PL',
  numer: 'WO1',
  zrodlo: 'historia',
  bruttoGrosze: 24600,
  nettoGrosze: 20000,
  faktura: false,
  oplacone: true,
  email: 'k@klient.pl',
  ...dodatki,
});

const linie = (csv) => csv.split('\r\n');

describe('CSV sprzedaży', () => {
  it('oddaje nagłówek i wiersz: średnik, kwoty po polsku, źródło po ludzku', () => {
    const csv = csvSprzedazy([wiersz()]);
    expect(linie(csv)[0]).toBe('Dzień;Kanał;Numer;Źródło;Brutto;Netto;Faktura;Opłacone');
    expect(linie(csv)[1]).toBe('2026-06-10;SZKICOWNIA_PL;WO1;Apilo;246,00;200,00;nie;tak');
  });

  // Numer zamowienia przychodzi ze sklepu i z Apilo — czyli spoza naszej kontroli. Srednik
  // w polu rozjechalby wszystkie kolumny na prawo od niego, i to CICHO: plik otworzy sie
  // normalnie, tylko kwoty wyladuja w zlych kolumnach.
  it('pole ze srednikiem albo cudzyslowem jedzie w cudzyslowach (RFC 4180)', () => {
    const csv = csvSprzedazy([wiersz({ numer: 'A;B "C"' })]);
    expect(csv).toContain('"A;B ""C"""');
  });

  // ⚠️ Test dopisany PO implementacji (odstepstwo od TDD odnotowane w commicie) — jego moc
  // dowodzi weryfikacja mutacyjna, nie kolejnosc pisania.
  it('domyslnie NIE wynosi adresow klientow, a z klient=1 dokłada kolumnę', () => {
    expect(csvSprzedazy([wiersz()])).not.toContain('k@klient.pl');
    const zKlientem = csvSprzedazy([wiersz()], { zKlientem: true });
    expect(linie(zKlientem)[0]).toBe('Dzień;Kanał;Numer;Źródło;Brutto;Netto;Faktura;Opłacone;E-mail');
    expect(linie(zKlientem)[1]).toContain('k@klient.pl');
  });
});

describe('nazwa pliku', () => {
  it('niesie zakres, żeby dwa eksporty nie nadpisały się w Pobranych', () => {
    expect(nazwaPlikuSprzedazy('2026-06-01', '2026-06-30')).toBe('sprzedaz-2026-06-01_2026-06-30.csv');
  });
});
