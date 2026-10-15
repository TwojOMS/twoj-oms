import { describe, it, expect } from 'vitest';
import {
  uslugaInpost, czySmart, USLUGA_SKLEP, USLUGA_ALLEGRO, USLUGA_ALLEGRO_SMART,
} from '../../src/domena/usluga-inpost.js';

// ⚠️⚠️ TEN PLIK POWSTAL Z PRAWDZIWEJ POMYLKI, KTORA KOSZTOWALA PIENIADZE (2026-08-07).
// Panel wysylal `inpost_locker_standard` NA SZTYWNO, wiec pierwsze nadanie paczkomatu
// z Allegro poszlo na taryfie standardowej zamiast allegrowej (przesylka 6000000001,
// zam. 1126) i wlasciciel musial ja anulowac.
//
// Wartosci zmierzone na zywym koncie (organizacja 13235 ma SZESC uslug, nie jedna),
// a regula „smart czy nie" — potwierdzona dwustronnie: zamowienie z `delivery.smart: true`
// i paczkomatem TYCS01M ma po stronie InPostu przesylke `inpost_locker_allegro_smart`
// z `target_point: TYCS01M`.

const allegro = (smart, nad = {}) => ({
  sklep: 'allegro_szkicownia',
  metoda_wysylki: 'allegro_paczkomat',
  surowe_json: JSON.stringify({ delivery: { smart, pickupPoint: { id: 'MALK01APP' } } }),
  ...nad,
});

describe('czySmart', () => {
  it('czyta delivery.smart z surowego zamówienia', () => {
    expect(czySmart(allegro(true))).toBe(true);
    expect(czySmart(allegro(false))).toBe(false);
  });

  // ⚠️ WYLACZNIE `true` znaczy Smart. `"true"`, `1` i cokolwiek innego to NIE jest potwierdzenie
  // — a od tego zalezy taryfa, wiec „prawie prawda" ma tu byc traktowana jak nieprawda.
  it('tylko dosłowne true — nie „true”, nie 1', () => {
    expect(czySmart(allegro('true'))).toBe(false);
    expect(czySmart(allegro(1))).toBe(false);
  });

  // ⚠️ NIGDY NIE RZUCA: to leci na sciezce NADANIA, wiec uszkodzony JSON ma dac bezpieczna
  // odpowiedz, a nie polozyc wywolanie kuriera.
  it('uszkodzone albo brakujące dane to false, nie wyjątek', () => {
    expect(czySmart({ surowe_json: '{niepoprawny' })).toBe(false);
    expect(czySmart({ surowe_json: null })).toBe(false);
    expect(czySmart({})).toBe(false);
    expect(czySmart(null)).toBe(false);
    expect(czySmart({ surowe_json: '{"delivery":null}' })).toBe(false);
  });
});

describe('usługa ShipX dla przesyłki', () => {
  it('zamówienie ze sklepu jedzie jak dotąd — standard', () => {
    expect(uslugaInpost({ sklep: 'szkicownia', metoda_wysylki: 'inpost_paczkomat' })).toBe(USLUGA_SKLEP);
    expect(uslugaInpost({ sklep: 'pro' })).toBe(USLUGA_SKLEP);
    expect(uslugaInpost({ sklep: 'reczne' })).toBe(USLUGA_SKLEP);
  });

  it('Allegro ze Smart! kupującego → taryfa allegro_smart', () => {
    expect(uslugaInpost(allegro(true))).toBe(USLUGA_ALLEGRO_SMART);
  });

  it('Allegro bez Smart! → taryfa allegro zwykła', () => {
    expect(uslugaInpost(allegro(false))).toBe(USLUGA_ALLEGRO);
  });

  // ⚠️ ROZSTRZYGA KANAL, NIE METODA. Metoda jest edytowalna z karty, wiec taryfa kluczowana
  // metoda mialaby furtke: jedno klikniecie przestawiajace metode zmienialoby rozliczenie
  // z InPostem. Kolumna `sklep` jest trwala — ustawia ja poller kanalu.
  it('przestawienie METODY na karcie NIE zmienia taryfy', () => {
    expect(uslugaInpost(allegro(true, { metoda_wysylki: 'inpost_paczkomat' }))).toBe(USLUGA_ALLEGRO_SMART);
    expect(uslugaInpost({ sklep: 'szkicownia', metoda_wysylki: 'allegro_paczkomat' })).toBe(USLUGA_SKLEP);
  });

  // Zamówienie allegrowe, którego surowych danych panel nie ma (stary wiersz, uszkodzony
  // zapis) — taryfa allegrowa ZWYKŁA. To wariant bez zniżki, więc bezpieczniejszy niż
  // zadeklarowanie Smart!, którego kupujący mógł nie mieć.
  it('Allegro bez surowych danych → taryfa allegro zwykła, nie standard', () => {
    expect(uslugaInpost({ sklep: 'allegro_amarka', surowe_json: null })).toBe(USLUGA_ALLEGRO);
  });
});
