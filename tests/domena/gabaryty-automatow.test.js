import { describe, expect, it } from 'vitest';
import {
  USLUGI_AUTOMATOW, odczytajAutomaty, propozycjaAutomatu, zmienAutomat, usunWyjatekAutomatu, zapiszAutomaty,
} from '../../src/domena/gabaryty-automatow.js';
import { odczytajSzablony, zmienSzablon, ustawDomyslnySzablon, zapiszSzablony } from '../../src/domena/szablony-paczek.js';
import { profilGabarytuAllegro } from '../../src/domena/gabaryty-allegro.js';

const ONE_BOX = '0b9bed2c-0bc1-4e1f-9694-29bb39ebb483';
const ORLEN = '09164667-daa5-42dc-8087-33d7485790ac';
const DHL_BOX = '0fe5b4af-9f09-443d-9d49-62331a20b5b2';
const KURIER_DPD = '03f26351-f683-4db2-8895-f2c599280e3c';

const zapisZ = (...czesci) => Object.assign({}, ...czesci);
const zapiszStan = (stan) => zapiszAutomaty(stan);
const ustaw = (stan, dane) => {
  const wynik = zmienAutomat(stan, dane);
  expect(wynik.bledy).toEqual([]);
  return wynik.stan;
};

describe('lista usług automatów Allegro', () => {
  it('to dokładnie usługi z profilem gabarytu, z nazwą z METODY_WZA', () => {
    expect(USLUGI_AUTOMATOW).toHaveLength(7);
    for (const u of USLUGI_AUTOMATOW) {
      expect(profilGabarytuAllegro(u.id)).not.toBeNull();
      expect(u.nazwa).toMatch(/^Allegro /);
      expect(u.dlugosc).toBe(profilGabarytuAllegro(u.id).dlugosc);
    }
    expect(USLUGI_AUTOMATOW.map((u) => u.id)).not.toContain(KURIER_DPD);
  });
});

describe('propozycja gabarytu i wagi — brak ustawienia = dzisiejsze zachowanie', () => {
  it('paczkomat: gabaryt A i waga domyślnego szablonu kuriera', () => {
    expect(propozycjaAutomatu({}, { rodzaj: 'paczkomat' })).toEqual({ gabaryt: 'A', waga: 1 });

    const szablony = ustawDomyslnySzablon(
      zmienSzablon(odczytajSzablony({}), { nazwa: 'Tuba', waga: '3,5', dlugosc: '90', szerokosc: '10', wysokosc: '10' }, 'tuba').stan,
      'tuba',
    ).stan;
    expect(propozycjaAutomatu(zapiszSzablony(szablony), { rodzaj: 'paczkomat' })).toEqual({ gabaryt: 'A', waga: 3.5 });
  });

  it('automat Allegro: S i 1 kg dla każdej usługi z profilem', () => {
    for (const { id } of USLUGI_AUTOMATOW) {
      expect(propozycjaAutomatu({}, { rodzaj: 'wza', deliveryMethodId: id })).toEqual({ gabaryt: 'S', waga: 1 });
    }
  });

  it('usługa bez profilu gabarytu i inne rodzaje nie dostają propozycji', () => {
    expect(propozycjaAutomatu({}, { rodzaj: 'wza', deliveryMethodId: KURIER_DPD })).toBeNull();
    expect(propozycjaAutomatu({}, { rodzaj: 'wza', deliveryMethodId: null })).toBeNull();
    expect(propozycjaAutomatu({}, { rodzaj: 'dpd' })).toBeNull();
  });

  it('uszkodzony zapis nie zmienia propozycji', () => {
    expect(propozycjaAutomatu({ 'paczka.automaty': '{zly' }, { rodzaj: 'paczkomat' })).toEqual({ gabaryt: 'A', waga: 1 });
    const zly = JSON.stringify({ version: 1, inpost: { gabaryt: 'Z', waga: 2 }, allegro: { gabaryt: 'S', waga: 25 },
      wyjatki: { [ORLEN]: { gabaryt: 'M', waga: 0 }, [KURIER_DPD]: { gabaryt: 'M', waga: 2 } } });
    expect(propozycjaAutomatu({ 'paczka.automaty': zly }, { rodzaj: 'paczkomat' })).toEqual({ gabaryt: 'A', waga: 1 });
    expect(propozycjaAutomatu({ 'paczka.automaty': zly }, { rodzaj: 'wza', deliveryMethodId: ORLEN })).toEqual({ gabaryt: 'S', waga: 1 });
    expect(odczytajAutomaty({ 'paczka.automaty': zly }).wyjatki).toEqual({});
  });
});

describe('propozycja z ustawienia', () => {
  it('paczkomat bierze gabaryt i wagę z ustawienia, już niezależnie od szablonu kuriera', () => {
    const stan = ustaw(odczytajAutomaty({}), { cel: 'paczkomat', gabaryt: 'b', waga: '2,5' });
    const szablon = zapiszSzablony(zmienSzablon(odczytajSzablony({}),
      { id: 'domyslna', nazwa: 'Paczka domyślna', waga: '9', dlugosc: '110', szerokosc: '75', wysokosc: '1' }).stan);

    expect(propozycjaAutomatu(zapisZ(szablon, zapiszStan(stan)), { rodzaj: 'paczkomat' })).toEqual({ gabaryt: 'B', waga: 2.5 });
  });

  it('ustawienie „wszystkie” obowiązuje każdą usługę automatu, także One Box', () => {
    const zapis = zapiszStan(ustaw(odczytajAutomaty({}), { cel: 'allegro', gabaryt: 'M', waga: '4' }));
    for (const { id } of USLUGI_AUTOMATOW) {
      expect(propozycjaAutomatu(zapis, { rodzaj: 'wza', deliveryMethodId: id })).toEqual({ gabaryt: 'M', waga: 4 });
    }
  });

  it('wyjątek usługi wygrywa z „wszystkie”, pozostałe usługi zostają przy „wszystkie”', () => {
    let stan = ustaw(odczytajAutomaty({}), { cel: 'allegro', gabaryt: 'M', waga: '4' });
    stan = ustaw(stan, { cel: ORLEN, gabaryt: 'L', waga: '12' });
    const zapis = zapiszStan(stan);

    expect(propozycjaAutomatu(zapis, { rodzaj: 'wza', deliveryMethodId: ORLEN })).toEqual({ gabaryt: 'L', waga: 12 });
    expect(propozycjaAutomatu(zapis, { rodzaj: 'wza', deliveryMethodId: DHL_BOX })).toEqual({ gabaryt: 'M', waga: 4 });
  });

  it('wyjątek bez „wszystkie” wygrywa z dzisiejszym S i 1 kg', () => {
    const zapis = zapiszStan(ustaw(odczytajAutomaty({}), { cel: ONE_BOX, gabaryt: 'L', waga: '7' }));
    expect(propozycjaAutomatu(zapis, { rodzaj: 'wza', deliveryMethodId: ONE_BOX })).toEqual({ gabaryt: 'L', waga: 7 });
    expect(propozycjaAutomatu(zapis, { rodzaj: 'wza', deliveryMethodId: ORLEN })).toEqual({ gabaryt: 'S', waga: 1 });
  });

  it('„jak wszystkie” usuwa wyjątek i usługa wraca do ustawienia „wszystkie”', () => {
    let stan = ustaw(odczytajAutomaty({}), { cel: 'allegro', gabaryt: 'M', waga: '4' });
    stan = ustaw(stan, { cel: ORLEN, gabaryt: 'L', waga: '12' });
    const wynik = usunWyjatekAutomatu(stan, ORLEN);
    expect(wynik.bledy).toEqual([]);

    expect(propozycjaAutomatu(zapiszStan(wynik.stan), { rodzaj: 'wza', deliveryMethodId: ORLEN })).toEqual({ gabaryt: 'M', waga: 4 });
    expect(usunWyjatekAutomatu(wynik.stan, ORLEN).bledy).toHaveLength(1);
  });

  it('zapis to jeden klucz tekstowy, który odczyt odtwarza', () => {
    let stan = ustaw(odczytajAutomaty({}), { cel: 'paczkomat', gabaryt: 'C', waga: '5' });
    stan = ustaw(stan, { cel: DHL_BOX, gabaryt: 'M', waga: '3' });
    const zapis = zapiszStan(stan);

    expect(Object.keys(zapis)).toEqual(['paczka.automaty']);
    expect(typeof zapis['paczka.automaty']).toBe('string');
    expect(odczytajAutomaty(zapis)).toEqual(stan);
  });
});

describe('walidacja ustawienia', () => {
  it('waga automatu Allegro większa od zera i najwyżej 20 kg', () => {
    const start = odczytajAutomaty({});
    expect(zmienAutomat(start, { cel: 'allegro', gabaryt: 'S', waga: '20' }).bledy).toEqual([]);
    expect(zmienAutomat(start, { cel: 'allegro', gabaryt: 'S', waga: '20,1' }).bledy[0]).toMatch(/20 kg/);
    expect(zmienAutomat(start, { cel: 'allegro', gabaryt: 'S', waga: '0' }).bledy).toHaveLength(1);
    expect(zmienAutomat(start, { cel: ORLEN, gabaryt: 'S', waga: '21' }).bledy[0]).toMatch(/20 kg/);
  });

  it('odmawia złego gabarytu, nieznanej usługi i nieznanego celu', () => {
    const start = odczytajAutomaty({});
    expect(zmienAutomat(start, { cel: 'allegro', gabaryt: 'XL', waga: '1' }).bledy).toHaveLength(1);
    expect(zmienAutomat(start, { cel: 'paczkomat', gabaryt: 'D', waga: '1' }).bledy).toHaveLength(1);
    expect(zmienAutomat(start, { cel: 'paczkomat', gabaryt: 'A', waga: '-1' }).bledy).toHaveLength(1);
    expect(zmienAutomat(start, { cel: KURIER_DPD, gabaryt: 'S', waga: '1' }).bledy).toHaveLength(1);
    expect(zmienAutomat(start, { cel: 'cos', gabaryt: 'S', waga: '1' }).bledy).toHaveLength(1);
    expect(usunWyjatekAutomatu(start, KURIER_DPD).bledy).toHaveLength(1);
  });
});
