import { describe, it, expect } from 'vitest';
import { daneZestawienia } from '../../src/domena/zestawienie-zamowien.js';
import { daneSpecyfikacji } from '../../src/domena/specyfikacja.js';
import { UWAGA_Z_KARTY } from '../../src/domena/z-panelu/oms-order.js';

// „Zestawienie zamówień" (PRZ-084) — wewnetrzny wydruk jak „order-shipping" z Apilo. Dane
// osobowe w pelni (decyzja właściciela 15.10), kwoty WYLACZNIE ze specyfikacji, adres efektywny.
// Dane w fixture zmyslone.

const z = (n = {}) => ({
  id: 1,
  sklep: 'pro',
  zrodlo_id: 28313,
  numer: 'WO-1',
  utworzone_at: '2026-10-14T21:41:52',
  klient: { first_name: 'Zofia', last_name: 'Zmyślona', email: 'halina@przyklad.test', phone: '600100200' },
  dostawa: {
    first_name: 'Zofia', last_name: 'Zmyślona', address_1: 'Leśna 7', city: 'Bździszewo', postcode: '99-999', country: 'PL',
  },
  metoda_wysylki: 'dpd',
  kwota_brutto: '223.90',
  koszt_dostawy_brutto: '0.00',
  chce_fakture: 0,
  uwagi: 'Proszę zapakować na prezent',
  pozycje: [
    { nazwa: 'Półkola zestaw 3szt', sku: 'PK-3', ilosc: 1, cena_brutto: '199.00', brutto_linii: '199.00' },
    { nazwa: 'Choinka 3', sku: null, ilosc: 1, cena_brutto: '24.90', brutto_linii: '24.90' },
  ],
  ...n,
});

describe('daneZestawienia', () => {
  it('naglowek: numer, kanal, numer w kanale, data z godzina, faktura', () => {
    const d = daneZestawienia(z(), { kanal: 'Sklep' });
    expect(d).toMatchObject({ numer: 'WO-1', kanal: 'Sklep', numerWKanale: '28313', fakturaWybrana: false });
    expect(d.dataZamowienia).toMatch(/^2026-10-14 21:41/);
  });

  it('dane wysylki w pelni: imie, ulica, kod z miastem, kraj, telefon, e-mail', () => {
    expect(daneZestawienia(z()).wysylka).toEqual([
      'Zofia Zmyślona', 'Leśna 7', '99-999 Bździszewo', 'PL', '600100200', 'halina@przyklad.test',
    ]);
  });

  it('paczkomat stoi w danych wysylki, a reczna poprawka adresu wygrywa ze sklepem', () => {
    const d = daneZestawienia(z({
      punkt_odbioru: 'CHJ03M',
      dostawa_reczna_json: JSON.stringify({ ulica: 'Poprawiona 1', phone: '700800900' }),
    }));
    expect(d.wysylka).toContain('Paczkomat CHJ03M');
    expect(d.wysylka).toContain('Poprawiona 1');
    expect(d.wysylka).toContain('700800900');
    expect(d.wysylka).not.toContain('Leśna 7');
  });

  it('pozycje z cenami, wysylka jako ostatni wiersz takze przy 0,00, kwota = specyfikacja', () => {
    const d = daneZestawienia(z());
    const s = daneSpecyfikacji(z(), { sprzedawca: null });
    expect(d.pozycje.map((p) => p.nazwa)).toEqual(['Półkola zestaw 3szt', 'Choinka 3', s.dostawa]);
    expect(d.pozycje[0]).toMatchObject({ sku: 'PK-3', ilosc: 1, cenaZl: '199.00', wartoscZl: s.pozycje[0].wartoscZl });
    expect(d.pozycje[2]).toMatchObject({ ilosc: 1, wartoscZl: s.dostawaZl });
    expect(d.razemZl).toBe(s.razemZl);
  });

  it('koszt dostawy niezerowy trafia do wiersza wysylki', () => {
    const d = daneZestawienia(z({ koszt_dostawy_brutto: '10.95', kwota_brutto: '234.85' }));
    expect(d.pozycje.at(-1).wartoscZl).toBe(daneSpecyfikacji(z({ koszt_dostawy_brutto: '10.95' }), { sprzedawca: null }).dostawaZl);
    expect(Number(d.pozycje.at(-1).wartoscZl.replace(',', '.'))).toBeCloseTo(10.95);
  });

  it('uwagi klienta tak, znacznik karty panelu indywidualnego nie', () => {
    expect(daneZestawienia(z()).uwagiKlienta).toBe('Proszę zapakować na prezent');
    expect(daneZestawienia(z({ uwagi: `${UWAGA_Z_KARTY} abc https://x` })).uwagiKlienta).toBeNull();
  });
});
