import { it, expect, beforeEach, afterEach } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { dopiszKlienta } from '../../../src/oms/db/klienci.js';
import { pobierzZamowienie, dodajPozycjeReczna } from '../../../src/oms/db/zamowienia.js';
import { przeliczKwoteRecznego } from '../../../src/oms/db/zamowienia-reczne.js';
import { zalozZamowienieReczne } from '../../../src/moduly/zamowienia/services/zamowienie-reczne.js';
import { pozycjeDokumentu, sprawdzSumeDokumentu } from '../../../src/domena/pozycje-faktury.js';
import { pozycjeOkresu, sprawdzSumeOkresu } from '../../../src/moduly/faktury/services/faktura-okresu.js';
import { STAWKA_VAT } from '../../../src/domena/vat.js';

// Jak warunki dostawy klienta (próg, opłata obsługi) wychodzą na FAKTURZE.
// Bez sieci: budujemy tylko pozycje dokumentu, tak jak robi to wystawianie (pozycjeDokumentu / pozycjeOkresu)
// i przepuszczamy je przez barierę arytmetyczną. Kwoty w groszach.

let db;
const nip = '1234500011';
beforeEach(() => {
  db = openOmsDb(':memory:');
  dopiszKlienta(db, { klucz: 'polcien', nazwa: 'Pracownia Półcień', nip, aktywny: 1,
    b2b: 1, rabat_procent: 0, chce_fakture: 1, metoda_wysylki: 'dpd', platnosc: 'przelew',
    koszt_dostawy_brutto: '19.00', rozliczenie_zbiorcze: 0,
    prog_darmowej_dostawy_gr: 50000, oplata_obslugi_gr: 400 });
});
afterEach(() => db.close());

function zamow(cena, inne = {}) {
  const { id } = zalozZamowienieReczne({ db, znacznik: '2026-11-13T10:00:00Z', naliczajOplate: true, okresId: null,
    dane: { nip, klient: {}, dostawa: {}, metoda_wysylki: 'dpd', koszt_dostawy_brutto: '19.00',
      pozycje: [{ nazwa: 'Lampa', ilosc: 1, cena_brutto: cena, cena_katalogowa: cena, brutto_linii: cena }], ...inne } });
  return pobierzZamowienie(db, id);
}
const suma = (uslugi) => uslugi.reduce((s, p) => s + p.gross_price, 0);
const nazwy = (uslugi) => uslugi.map((p) => p.name);
const dokument = (z) => {
  const uslugi = pozycjeDokumentu(z, { stawkaDomyslna: STAWKA_VAT });
  expect(() => sprawdzSumeDokumentu(uslugi, z)).not.toThrow();
  return uslugi;
};

it('1. faktura pojedyncza: towar 600 zł (próg 500) → koszt 0.00, brak pozycji dostawy, suma 60000 gr', () => {
  const z = zamow('600.00');
  expect(z.koszt_dostawy_brutto).toBe('0.00');
  const u = dokument(z);
  expect(nazwy(u)).toEqual(['Lampa']);
  expect(suma(u)).toBe(60000);
});

it('2. faktura pojedyncza: towar 400 zł → pozycja Dostawa 1900 gr, suma 41900 gr', () => {
  const u = dokument(zamow('400.00'));
  expect(u).toEqual([
    { name: 'Lampa', quantity: 1, gross_price: 40000, tax_symbol: STAWKA_VAT },
    { name: 'Dostawa', quantity: 1, gross_price: 1900, tax_symbol: STAWKA_VAT },
  ]);
  expect(suma(u)).toBe(41900);
});

it('3. etykieta klienta + obsługa 4 zł: „Obsługa zamówienia” 400 gr (VAT 23), bez dostawy, suma 10400 gr', () => {
  const z = zamow('100.00', { etykietaKlienta: true });
  const u = dokument(z);
  expect(nazwy(u)).toEqual(['Lampa', 'Obsługa zamówienia']);
  expect(u[1]).toEqual({ name: 'Obsługa zamówienia', quantity: 1, gross_price: 400, tax_symbol: '23' });
  expect(nazwy(u)).not.toContain('Dostawa');
  expect(suma(u)).toBe(10400);
});

it('4. faktura okresu: dwa zamówienia z obsługą → dwie pozycje obsługi po 400 gr, suma 20800 gr, bez kurierskiej', () => {
  const a = zamow('100.00', { etykietaKlienta: true });
  const b = zamow('100.00', { etykietaKlienta: true });
  const u = pozycjeOkresu([a, b], { stawkaDomyslna: STAWKA_VAT });
  expect(() => sprawdzSumeOkresu(u, [a, b])).not.toThrow();
  expect(nazwy(u)).toEqual(['Lampa', 'Obsługa zamówienia', 'Lampa', 'Obsługa zamówienia']);
  expect(u.filter((p) => p.name === 'Obsługa zamówienia').map((p) => p.gross_price)).toEqual([400, 400]);
  expect(nazwy(u)).not.toContain('Usługa kurierska');
  expect(nazwy(u)).not.toContain('Dostawa');
  expect(suma(u)).toBe(20800);
});

it('5. stare zamówienie z pozycją „Usługa kurierska” 19 zł: na fakturze okresu raz, suma 11900 gr', () => {
  const z0 = zamow('100.00', { koszt_dostawy_brutto: '0.00' });
  dodajPozycjeReczna(db, z0.id, { nazwa: 'Usługa kurierska', ilosc: 1, cena_brutto: '19.00', brutto_linii: '19.00' });
  przeliczKwoteRecznego(db, z0.id);
  const z = pobierzZamowienie(db, z0.id);
  expect(z.koszt_dostawy_brutto).toBe('0.00');
  const u = pozycjeOkresu([z], { stawkaDomyslna: STAWKA_VAT });
  expect(() => sprawdzSumeOkresu(u, [z])).not.toThrow();
  expect(u.filter((p) => p.name === 'Usługa kurierska')).toEqual([
    { name: 'Usługa kurierska', quantity: 1, gross_price: 1900, tax_symbol: '23' },
  ]);
  expect(nazwy(u)).not.toContain('Dostawa');
  expect(suma(u)).toBe(11900);
});
