// PRZ-145.01 (plan PRZ-137, Etap 5, E5-D1 i E5-D2): niedopłata liczona z kwoty zamówienia
// i jeden odczyt kwoty pobrania. Dane zmyślone („Pracownia Półcień").
import { describe, expect, it } from 'vitest';
import { niedoplataPobrania } from '../../src/domena/platnosci.js';
import { odczytajKwotePobrania, parsujNadpisanieKwotyPobrania } from '../../src/domena/pobranie-nadania.js';

const wplata = (kwota) => ({ kwota, zrodlo: 'reczna', metoda: 'Przelew', data: '2026-11-04' });
const zamowienie = ({ brutto = '212.90', k = '50.00', wplaty = [] } = {}) => ({
  id: 1, numer: 'PC-145', sklep: 'polcien', metoda_wysylki: 'dpd', pobranie: 1,
  kwota_pobrania: k, kwota_brutto: brutto, platnosci: wplaty.map(wplata),
});

describe('PRZ-145.01 (1) niedoplataPobrania — kwota zamówienia minus wpłaty', () => {
  it('brutto 212.90, K 50.00, P 50.00 → 162.90 z podstawy „zamowienie”', () => {
    expect(niedoplataPobrania(zamowienie({ wplaty: ['50.00'] }))).toEqual({
      niedoplataGr: 16290, przedplatyGr: 5000, podstawaGr: 21290, podstawa: 'zamowienie',
    });
  });

  it.each([[''], ['0'], [null]])('brutto %j, K 150.00, P 50.00 → 100.00 z podstawy „pobranie”', (brutto) => {
    expect(niedoplataPobrania(zamowienie({ brutto, k: '150.00', wplaty: ['50.00'] }))).toEqual({
      niedoplataGr: 10000, przedplatyGr: 5000, podstawaGr: 15000, podstawa: 'pobranie',
    });
  });

  it('nadpłata (P 250.00 przy brutto 212.90) → niedopłata 0, nie ujemna', () => {
    expect(niedoplataPobrania(zamowienie({ wplaty: ['250.00'] }))).toMatchObject({ niedoplataGr: 0, podstawa: 'zamowienie' });
  });

  it('brutto „abc” → {blad} z czytelnym zdaniem, bez wyjątku', () => {
    const w = niedoplataPobrania(zamowienie({ brutto: 'abc', k: '150.00', wplaty: ['50.00'] }));
    expect(w).toEqual({
      blad: 'Kwota zamówienia jest nieczytelna („abc”) — panel nie policzy niedopłaty. Sprawdź zamówienie w sklepie albo popraw je na karcie.',
    });
  });

  it('brutto puste i K „abc” → {blad} z tekstem (b)', () => {
    const w = niedoplataPobrania(zamowienie({ brutto: '', k: 'abc', wplaty: ['50.00'] }));
    expect(w.blad).toContain('Kwota pobrania na zamówieniu jest nieczytelna („abc”) — popraw ją w „Szczegółach zamówienia” na karcie.');
    expect(w.blad).not.toContain('Kwota nie jest liczbą');
  });

  it('brutto i K puste → null (dawna odmowa „Brak kwoty pobrania i kwoty zamówienia”)', () => {
    expect(niedoplataPobrania(zamowienie({ brutto: '', k: null, wplaty: ['50.00'] }))).toBeNull();
  });

  it('wpłaty z drugiego argumentu wygrywają nad z.platnosci', () => {
    expect(niedoplataPobrania(zamowienie({ wplaty: ['50.00'] }), [wplata('100.00')])).toMatchObject({ niedoplataGr: 11290 });
  });
});

describe('PRZ-145.01 (2) odczytajKwotePobrania — jeden odczyt kwoty', () => {
  it.each(['0.005', '12.345', '1e2', '104.', '0x10', '', '   ', '0', '0.00', '-5', 'abc', null, undefined])('%j → {blad}', (surowa) => {
    const w = odczytajKwotePobrania(surowa);
    expect(w.blad).toBeTruthy();
    expect(w.kwota).toBeUndefined();
    expect(w.blad).not.toContain('Panel niczego nie nadał');
  });

  it('„212.900” (Woo z trzema miejscami) przechodzi: kwota bez zmian, 21290 gr', () => {
    expect(odczytajKwotePobrania('212.900')).toEqual({ kwota: '212.900', groszeKwoty: 21290 });
  });

  it('„12,5” → kwota z kropką i 1250 gr', () => {
    expect(odczytajKwotePobrania('12,5')).toEqual({ kwota: '12.5', groszeKwoty: 1250 });
  });

  it('liczba 212.9 (nie napis) też przechodzi', () => {
    expect(odczytajKwotePobrania(212.9)).toEqual({ kwota: '212.9', groszeKwoty: 21290 });
  });

  it('parser ekranu odrzuca „0.005” (dziś przechodził)', () => {
    const w = parsujNadpisanieKwotyPobrania({ kwota_pobrania: '0.005' }, { pobranie: true, kolejnosc: 1 });
    expect(w.kwotaPobrania).toBeUndefined();
    expect(w.blad).toContain('Panel niczego nie nadał.');
  });
});
