import { describe, it, expect } from 'vitest';
import { domyslnyRozmiarWiersza, paczkaWiersza, polaWiersza } from '../../src/domena/nadanie-hurtem.js';

// PRZ-070 (właściciel 14.10.2026): rozmiar paczki w nadaniu hurtem wybierany w wierszu podglądu —
// szablony DPD z Ustawień, A/B/C przy paczkomacie, S/M/L przy automatach Allegro.
const ONE_BOX = '0b9bed2c-0bc1-4e1f-9694-29bb39ebb483';
const ORLEN = '09164667-daa5-42dc-8087-33d7485790ac';
const DPD_AD = '03f26351-f683-4db2-8895-f2c599280e3c';
const szablony = {
  domyslnyId: 'duza',
  szablony: [
    { id: 'duza', nazwa: 'Duża', waga: 3, dlugosc: 110, szerokosc: 75, wysokosc: 1 },
    { id: 'mala', nazwa: 'Mała', waga: 0.5, dlugosc: 30, szerokosc: 20, wysokosc: 10 },
  ],
};

describe('PRZ-070: rozmiar wiersza w nadaniu hurtem', () => {
  it('domyślne: DPD → szablon domyślny, paczkomat → A, One Box → S i 1 kg, ORLEN → S i waga szablonu', () => {
    expect(domyslnyRozmiarWiersza({ rodzaj: 'dpd', szablony })).toEqual({ pole: 'szablon', szablon: 'duza' });
    expect(domyslnyRozmiarWiersza({ rodzaj: 'paczkomat', szablony })).toEqual({ pole: 'gabaryt', gabaryt: 'A', waga: 3 });
    expect(domyslnyRozmiarWiersza({ rodzaj: 'wza', deliveryMethodId: ONE_BOX, szablony }))
      .toEqual({ pole: 'gabarytAllegro', gabaryt: 'S', waga: 1, gabaryty: ['S', 'M', 'L'] });
    expect(domyslnyRozmiarWiersza({ rodzaj: 'wza', deliveryMethodId: ORLEN, szablony }))
      .toEqual({ pole: 'gabarytAllegro', gabaryt: 'S', waga: 3, gabaryty: ['S', 'M', 'L'] });
    expect(domyslnyRozmiarWiersza({ rodzaj: 'wza', deliveryMethodId: DPD_AD, szablony })).toEqual({ pole: 'szablon', szablon: 'duza' });
  });

  it('propozycja wagi automatu nie przekracza limitu 20 kg', () => {
    const ciezkie = { domyslnyId: 'x', szablony: [{ id: 'x', nazwa: 'X', waga: 25, dlugosc: 1, szerokosc: 1, wysokosc: 1 }] };
    expect(domyslnyRozmiarWiersza({ rodzaj: 'wza', deliveryMethodId: ORLEN, szablony: ciezkie }).waga).toBe(20);
  });

  it('DPD: wybrany szablon daje jego wymiary; brak pola = szablon domyślny (stary formularz)', () => {
    expect(paczkaWiersza({ rodzaj: 'dpd', pola: { szablon: 'mala' }, szablony }))
      .toEqual({ paczka: { waga: 0.5, dlugosc: 30, szerokosc: 20, wysokosc: 10 } });
    expect(paczkaWiersza({ rodzaj: 'dpd', pola: {}, szablony }))
      .toEqual({ paczka: { waga: 3, dlugosc: 110, szerokosc: 75, wysokosc: 1 } });
  });

  it('szablon, którego już nie ma, to odmowa wiersza — nie cichy powrót do domyślnego', () => {
    expect(paczkaWiersza({ rodzaj: 'dpd', pola: { szablon: 'skasowany' }, szablony }))
      .toEqual({ blad: 'Szablon paczki zmienił się — odśwież podgląd nadania.' });
  });

  it('WzA bez profilu gabarytu: szablon + oczekiwana usługa', () => {
    expect(paczkaWiersza({ rodzaj: 'wza', deliveryMethodId: DPD_AD, pola: { szablon: 'mala' }, szablony }))
      .toEqual({ paczka: { waga: 0.5, dlugosc: 30, szerokosc: 20, wysokosc: 10, oczekiwanyDeliveryMethodId: DPD_AD } });
  });

  it('paczkomat: gabaryt z wiersza, waga z szablonu domyślnego; brak gabarytu = odmowa', () => {
    expect(paczkaWiersza({ rodzaj: 'paczkomat', pola: { gabaryt: 'b' }, szablony })).toEqual({ paczka: { waga: 3, gabaryt: 'B' } });
    expect(paczkaWiersza({ rodzaj: 'paczkomat', pola: {}, szablony }).blad).toMatch(/gabaryt paczkomatu/);
  });

  it('automat Allegro: S/M/L i waga z wiersza, parser karty (limit 20 kg)', () => {
    const { paczka } = paczkaWiersza({ rodzaj: 'wza', deliveryMethodId: ONE_BOX, pola: { gabaryt: 'M', waga: '1,5' }, szablony });
    expect(paczka).toEqual({
      waga: 1.5, dlugosc: 64, szerokosc: 38, wysokosc: 19, gabaryt: 'M', oczekiwanyDeliveryMethodId: ONE_BOX,
    });
    expect(paczkaWiersza({ rodzaj: 'wza', deliveryMethodId: ONE_BOX, pola: { waga: '1' }, szablony }).blad).toBe('Wybierz gabaryt S, M albo L.');
    expect(paczkaWiersza({ rodzaj: 'wza', deliveryMethodId: ONE_BOX, pola: { gabaryt: 'S', waga: '21' }, szablony }).blad).toMatch(/20 kg/);
  });

  it('pola wiersza czytane po identyfikatorze zamówienia — nie z sąsiedniego wiersza', () => {
    const body = {
      szablon_7: 'mala', gabaryt_7: 'C', waga_7: '2', szablon_8: 'duza',
    };
    expect(polaWiersza(body, 7)).toEqual({ szablon: 'mala', gabaryt: 'C', waga: '2' });
    expect(polaWiersza(body, 8)).toEqual({ szablon: 'duza', gabaryt: undefined, waga: undefined });
  });
});
