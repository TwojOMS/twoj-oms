import { describe, it, expect } from 'vitest';
import { domyslnyRozmiarWiersza, paczkaWiersza } from '../../src/domena/nadanie-hurtem.js';
import { USLUGI_AUTOMATOW, propozycjaAutomatu, zmienAutomat, zapiszAutomaty, odczytajAutomaty } from '../../src/domena/gabaryty-automatow.js';
import { odczytajSzablony, zmienSzablon, ustawDomyslnySzablon, zapiszSzablony } from '../../src/domena/szablony-paczek.js';

// PRZ-152.G11c: hurt bierze propozycję gabarytu i wagi paczkomatu / automatu Allegro z JEDNEGO
// miejsca (`propozycjaAutomatu`, ustawienie „Paczkomaty i automaty”), tego samego co karta.
const ONE_BOX = '0b9bed2c-0bc1-4e1f-9694-29bb39ebb483';
const ORLEN = '09164667-daa5-42dc-8087-33d7485790ac';
const DHL_BOX = '0fe5b4af-9f09-443d-9d49-62331a20b5b2';

const zapisSzablonow = () => {
  let stan = odczytajSzablony({});
  stan = zmienSzablon(stan, { nazwa: 'Duża', waga: '3', dlugosc: '110', szerokosc: '75', wysokosc: '1' }, 'duza').stan;
  return zapiszSzablony(ustawDomyslnySzablon(stan, 'duza').stan);
};

const ustaw = (stan, dane) => {
  const w = zmienAutomat(stan, dane);
  expect(w.bledy).toEqual([]);
  return w.stan;
};

const zUstawieniem = () => {
  let stan = odczytajAutomaty({});
  stan = ustaw(stan, { cel: 'paczkomat', gabaryt: 'C', waga: '7' });
  stan = ustaw(stan, { cel: 'allegro', gabaryt: 'M', waga: '4' });
  stan = ustaw(stan, { cel: ORLEN, gabaryt: 'L', waga: '12' });
  return { ...zapisSzablonow(), ...zapiszAutomaty(stan) };
};

describe('PRZ-152.G11c: hurt — gabaryt i waga z ustawienia', () => {
  it('brak ustawienia: paczkomat A i waga szablonu domyślnego, automaty S i 1 kg', () => {
    const ustawienia = zapisSzablonow();
    const szablony = odczytajSzablony(ustawienia);
    expect(domyslnyRozmiarWiersza({ rodzaj: 'paczkomat', szablony, ustawienia }))
      .toEqual({ pole: 'gabaryt', gabaryt: 'A', waga: 3 });
    for (const id of [ONE_BOX, ORLEN]) {
      expect(domyslnyRozmiarWiersza({ rodzaj: 'wza', deliveryMethodId: id, szablony, ustawienia }))
        .toEqual({ pole: 'gabarytAllegro', gabaryt: 'S', waga: 1, gabaryty: ['S', 'M', 'L'] });
    }
  });

  it('ustawienie: paczkomat C/7 kg, automaty M/4 kg, wyjątek usługi (ORLEN L/12 kg) wygrywa', () => {
    const ustawienia = zUstawieniem();
    const szablony = odczytajSzablony(ustawienia);
    expect(domyslnyRozmiarWiersza({ rodzaj: 'paczkomat', szablony, ustawienia }))
      .toEqual({ pole: 'gabaryt', gabaryt: 'C', waga: 7 });
    expect(domyslnyRozmiarWiersza({ rodzaj: 'wza', deliveryMethodId: DHL_BOX, szablony, ustawienia }))
      .toEqual({ pole: 'gabarytAllegro', gabaryt: 'M', waga: 4, gabaryty: ['S', 'M', 'L'] });
    expect(domyslnyRozmiarWiersza({ rodzaj: 'wza', deliveryMethodId: ORLEN, szablony, ustawienia }))
      .toEqual({ pole: 'gabarytAllegro', gabaryt: 'L', waga: 12, gabaryty: ['S', 'M', 'L'] });
    // DPD nadal z szablonu kuriera — ustawienie automatów go nie dotyczy.
    expect(domyslnyRozmiarWiersza({ rodzaj: 'dpd', szablony, ustawienia })).toEqual({ pole: 'szablon', szablon: 'duza' });
  });

  it('zatwierdzenie paczkomatu: waga z ustawienia (nie z szablonu), gabaryt z wiersza wygrywa', () => {
    const ustawienia = zUstawieniem();
    const szablony = odczytajSzablony(ustawienia);
    expect(paczkaWiersza({ rodzaj: 'paczkomat', pola: { gabaryt: 'B' }, szablony, ustawienia }))
      .toEqual({ paczka: { waga: 7, gabaryt: 'B' } });
    // „Brak pola” przy paczkomacie dalej jest odmową — gabarytu nie zgadujemy.
    expect(paczkaWiersza({ rodzaj: 'paczkomat', pola: {}, szablony, ustawienia }).blad).toMatch(/gabaryt paczkomatu/);
  });

  it('hurt podaje DOKŁADNIE propozycję z gabaryty-automatow.js dla każdej usługi', () => {
    for (const ustawienia of [zapisSzablonow(), zUstawieniem()]) {
      const szablony = odczytajSzablony(ustawienia);
      const { gabaryt, waga } = domyslnyRozmiarWiersza({ rodzaj: 'paczkomat', szablony, ustawienia });
      expect({ gabaryt, waga }).toEqual(propozycjaAutomatu(ustawienia, { rodzaj: 'paczkomat' }));
      for (const { id } of USLUGI_AUTOMATOW) {
        const r = domyslnyRozmiarWiersza({ rodzaj: 'wza', deliveryMethodId: id, szablony, ustawienia });
        expect({ gabaryt: r.gabaryt, waga: r.waga }).toEqual(propozycjaAutomatu(ustawienia, { rodzaj: 'wza', deliveryMethodId: id }));
      }
    }
  });
});
