import { describe, expect, it } from 'vitest';
import { podzielDoNadania } from '../../src/domena/masowe.js';

const zamowienie = (zmiany = {}) => ({
  id: 1, numer: 'PC-143', sklep: 'allegro_polcien',
  metoda_wysylki: 'allegro_dpd', anulowane: 0, pobranie: 1,
  kwota_pobrania: '150.00', przesylki: [], platnosci: [], ...zmiany,
});

describe('PRZ-143.04: pobranie w nadaniu hurtem tylko na paczce nr 1', () => {
  it.each([
    ['', 'częściowo opłacone, brak kwoty pobrania — nadaj z karty'],
    ['   ', 'częściowo opłacone, brak kwoty pobrania — nadaj z karty'],
    ['abc', 'kwota pobrania jest niepoprawna — popraw ją na karcie zamówienia („abc”)'],
  ])('PRZ-144.01: pomija WzA z przedpłatą i kwotą „%s”, bez wyjątku', (kwota, powod) => {
    const poprawne = zamowienie({ id: 2, numer: 'PC-144' });
    const wynik = podzielDoNadania([
      zamowienie({ kwota_pobrania: kwota, platnosci: [{ kwota: '50.00', zrodlo: 'reczna', metoda: 'Przelew' }] }),
      poprawne,
    ]);
    expect(wynik.pominiete).toEqual([{ id: 1, numer: 'PC-143', powod }]);
    expect(wynik.doNadania.map((z) => z.id)).toEqual([2]);
  });

  it('pomija WzA z przedpłatą 50.00 i bez kwoty pobrania, bez przerywania reszty hurtu', () => {
    const poprawne = zamowienie({ id: 2, numer: 'PC-144' });
    const wynik = podzielDoNadania([
      zamowienie({
        kwota_pobrania: null,
        platnosci: [{ kwota: '50.00', zrodlo: 'reczna', metoda: 'Przelew' }],
      }),
      poprawne,
    ]);

    expect(wynik.pominiete).toEqual([{
      id: 1, numer: 'PC-143',
      powod: 'częściowo opłacone, brak kwoty pobrania — nadaj z karty',
    }]);
    expect(wynik.doNadania).toEqual([{
      ...poprawne, metodaUzyta: 'allegro_dpd', rodzajFormularza: 'wza',
    }]);
    expect(wynik.uwagi.map((uwaga) => uwaga.id)).toEqual([2]);
  });

  it('pomija dosyłkę za pobraniem, gdy paczka nr 1 jest już nadana', () => {
    const wynik = podzielDoNadania([
      zamowienie({ przesylki: [{ kolejnosc: 1, status: 'nadana' }] }),
    ]);

    expect(wynik.doNadania).toEqual([]);
    expect(wynik.pominiete).toEqual([{
      id: 1, numer: 'PC-143',
      powod: 'ma już nadaną paczkę — dosyłkę nadaj z karty zamówienia',
    }]);
    expect(wynik.uwagi).toEqual([]);
  });

  it('dopuszcza paczkę nr 1 za pobraniem po jedynej nieudanej próbie nadania', () => {
    const z = zamowienie({ przesylki: [{ kolejnosc: 1, status: 'blad' }] });
    const wynik = podzielDoNadania([z]);

    expect(wynik.pominiete).toEqual([]);
    expect(wynik.doNadania).toEqual([{
      ...z, metodaUzyta: 'allegro_dpd', rodzajFormularza: 'wza',
    }]);
    expect(wynik.uwagi).toEqual([{
      id: 1, numer: 'PC-143',
      tresc: 'za pobraniem — kwotę pobrania poda Allegro (w zamówieniu 150.00 zł)',
    }]);
  });
});

// PRZ-145.01 (plan PRZ-137, E5-D5): powody hurtu liczone z niedopłaty (kwota zamówienia minus
// wpłaty). Hurt dalej nigdy nie nadaje zamówienia z przedpłatą. Sklepowe DPD „Pracowni Półcień”.
const dpd = (zmiany = {}) => ({
  id: 1, numer: 'PC-145', sklep: 'polcien', metoda_wysylki: 'dpd', anulowane: 0, pobranie: 1,
  kwota_pobrania: '50.00', kwota_brutto: '212.90', przesylki: [], platnosci: [], ...zmiany,
});
const wplaty = (...kwoty) => kwoty.map((kwota) => ({ kwota, zrodlo: 'reczna', metoda: 'Przelew', data: '2026-11-04' }));
const powod = (z) => {
  const wynik = podzielDoNadania([z, dpd({ id: 2, numer: 'PC-146', kwota_pobrania: '212.90' })]);
  expect(wynik.doNadania.map((x) => x.id)).toEqual([2]);
  return wynik.pominiete.find((p) => p.id === 1)?.powod;
};

describe('PRZ-145.01 (8) hurt: powody z niedopłaty', () => {
  it('K 50.00, P 50.00, brutto 212.90 → „różni się od niedopłaty 162.90 zł”', () => {
    expect(powod(dpd({ platnosci: wplaty('50.00') }))).toBe('kwota pobrania 50.00 zł różni się od niedopłaty 162.90 zł — nadaj z karty');
  });
  it('K 162.90, P 50.00 → „częściowo opłacone — nadaj z karty”', () => {
    expect(powod(dpd({ kwota_pobrania: '162.90', platnosci: wplaty('50.00') }))).toBe('częściowo opłacone — nadaj z karty');
  });
  it('P 212.90 → „opłacone — wyłącz pobranie”', () => {
    expect(powod(dpd({ kwota_pobrania: '212.90', platnosci: wplaty('212.90') }))).toBe('opłacone — wyłącz pobranie');
  });
  it('brutto „abc”, P 50.00 → powód „kwota zamówienia jest nieczytelna”, bez wyjątku', () => {
    expect(powod(dpd({ kwota_pobrania: '150.00', kwota_brutto: 'abc', platnosci: wplaty('50.00') })))
      .toBe('kwota zamówienia jest nieczytelna („abc”) — panel nie policzy niedopłaty. Sprawdź zamówienie w sklepie albo popraw je na karcie');
  });
  it.each(['0.00', '0'])('P = 0, K „%s” → pominięte (tekst przypięty przez t2:161, bez dopisku z planu)', (k) => {
    expect(powod(dpd({ kwota_pobrania: k }))).toBe(`kwota pobrania jest niepoprawna — popraw ją na karcie zamówienia („${k}”)`);
  });
  it('P = 0, K „0.005” → pominięte', () => {
    expect(powod(dpd({ kwota_pobrania: '0.005' }))).toBe('kwota pobrania jest niepoprawna — popraw ją na karcie zamówienia („0.005”)');
  });
});
