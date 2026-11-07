// PRZ-152.G3a — stan płatności karty zamówienia (plan docs/plany/PRZ-152-G3-G9-platnosci.md, D1–D3).
// właściciel 04.11: „Status — usuń, a w jego miejsce przesuń status płatności bez daty, ale jeżeli jest
// opłacone, to na zielono. Nieopłacone na czerwono, pobranie na pomarańczowo.”
// Jeden przypadek na wiersz tabeli D2 oraz dwa błędy ze zrzutów (rozdz. 2.5 i 2.6). Dane zmyślone.
import { describe, expect, it } from 'vitest';
import { stanPlatnosciKarty, ruchyPlatnosci, kiedyRuchu, KLASA_TONU, STAN_KARTY } from '../../src/domena/stan-platnosci-karty.js';

// Zamówienie z WooCommerce „Pracowni Półcień”: 100,00 zł, kurier bez pobrania.
const zam = (nad = {}) => ({
  id: 152, numer: 'PC-152', sklep: 'polcien', kwota_brutto: '100.00', koszt_dostawy_brutto: '0.00',
  metoda_wysylki: 'dpd', pobranie: 0, kwota_pobrania: null, wysylka_reczna_json: null,
  pozycje: [], platnosci: [], ...nad,
});
const pobranie = (nad = {}) => zam({ pobranie: 1, kwota_pobrania: '100.00', metoda_platnosci: 'Za pobraniem', ...nad });
const wplata = (nad = {}) => ({ id: 7, kwota: '100.00', data: '2026-10-30T10:18:27', metoda: 'Przelew', zrodlo: 'reczna', ...nad });
const zwrot = (nad = {}) => ({ id: 3, kwota: '100.00', kwota_dostawy: null, pieniadze_oddane_at: '2026-11-03T09:00:00', ...nad });

describe('stanPlatnosciKarty — tabela D2', () => {
  it('opłacone przelewem → Opłacone, zielony', () => {
    const s = stanPlatnosciKarty(zam({ platnosci: [wplata()] }));
    expect(s).toMatchObject({ stan: 'oplacone', etykieta: 'Opłacone', ton: 'ok', klasa: 'znacznik--ok' });
    expect(s).toMatchObject({ kwotaGr: 10000, wplaconoGr: 10000, zwroconoGr: 0, saldoGr: 0 });
  });

  it('brak wpłaty → Nieopłacone, czerwony', () => {
    expect(stanPlatnosciKarty(zam())).toMatchObject({
      stan: STAN_KARTY.NIEOPLACONE, etykieta: 'Nieopłacone', klasa: 'znacznik--czerwony', saldoGr: -10000,
    });
  });

  it('wpłata częściowa → Nieopłacone', () => {
    const s = stanPlatnosciKarty(zam({ platnosci: [wplata({ kwota: '40.00' })] }));
    expect(s).toMatchObject({ stan: 'nieoplacone', wplaconoGr: 4000, saldoGr: -6000 });
  });

  it('pobranie bez wpłaty → Pobranie · czeka na kuriera, pomarańczowy, do pobrania = kwota', () => {
    expect(stanPlatnosciKarty(pobranie())).toMatchObject({
      stan: 'pobranie', etykieta: 'Pobranie · czeka na kuriera', klasa: 'znacznik--pomaranczowy', doPobraniaGr: 10000,
    });
  });

  it('pobranie rozliczone przez kuriera (wpłata ręczna „Za pobraniem” na całość) → Opłacone', () => {
    const s = stanPlatnosciKarty(pobranie({ platnosci: [wplata({ metoda: 'Za pobraniem', zrodlo: 'reczna' })] }));
    expect(s).toMatchObject({ stan: 'oplacone', klasa: 'znacznik--ok', wplaconoGr: 10000, doPobraniaGr: null });
  });

  it('pobranie włączone na karcie po przedpłacie online na całość → dalej pobranie, dopóki kurier nie rozliczy', () => {
    const z = zam({
      wysylka_reczna_json: JSON.stringify({ metoda: 'dpd', pobranie: 1, kwota_pobrania: '100.00' }),
      platnosci: [wplata({ zrodlo: 'sklep', metoda: 'Przelewy24' })],
    });
    const s = stanPlatnosciKarty(z);
    expect(s.stan).toBe('pobranie');
    // Przedpłata jest pieniędzmi — liczy się do „Wpłacono”, tylko nie zamyka pobrania.
    expect(s.wplaconoGr).toBe(10000);
    expect(s.pominieteWplaty).toEqual([]);
  });

  it('błąd (1): pobranie + wpłata „Za pobraniem · sklep” na całość (date_paid Woo) → pobranie, wpłata nieliczona', () => {
    const s = stanPlatnosciKarty(pobranie({ platnosci: [wplata({ id: 41, kwota: '276.90', zrodlo: 'sklep', metoda: 'Za pobraniem' })], kwota_brutto: '276.90', kwota_pobrania: '276.90' }));
    expect(s).toMatchObject({ stan: 'pobranie', klasa: 'znacznik--pomaranczowy', wplaconoGr: 0, saldoGr: -27690 });
    expect(s.pominieteWplaty).toEqual([41]);
  });

  it('błąd (1), pobranie włączone na karcie: wpłata sklepu z metodą „Za pobraniem” też nieliczona', () => {
    const z = zam({
      wysylka_reczna_json: JSON.stringify({ metoda: 'dpd', pobranie: 1, kwota_pobrania: '100.00' }),
      platnosci: [wplata({ id: 42, zrodlo: 'sklep', metoda: 'Za pobraniem' })],
    });
    expect(stanPlatnosciKarty(z)).toMatchObject({ stan: 'pobranie', wplaconoGr: 0, pominieteWplaty: [42] });
  });

  it('błąd (2): wpłata 51,80 i zwrot 51,80 z oddanymi pieniędzmi → Zwrócone w całości, saldo 0', () => {
    const s = stanPlatnosciKarty(
      zam({ kwota_brutto: '51.80', platnosci: [wplata({ kwota: '51.80', data: '2026-10-26T12:00:00' })] }),
      { zwroty: [zwrot({ kwota: '51.80' })] },
    );
    expect(s).toMatchObject({
      stan: 'zwrocone_calosc', etykieta: 'Zwrócone w całości', klasa: 'znacznik--szary',
      wplaconoGr: 5180, zwroconoGr: 5180, saldoGr: 0,
    });
  });

  it('zwrot z dostawą liczy kwotę razem z dostawą (kwotaZwrotuGrosze)', () => {
    const s = stanPlatnosciKarty(zam({ platnosci: [wplata()] }), { zwroty: [zwrot({ kwota: '85.00', kwota_dostawy: '15.00' })] });
    expect(s).toMatchObject({ stan: 'zwrocone_calosc', zwroconoGr: 10000 });
  });

  it('zwrot 30,00 z 100,00 → Zwrócone częściowo', () => {
    const s = stanPlatnosciKarty(zam({ platnosci: [wplata()] }), { zwroty: [zwrot({ kwota: '30.00' })] });
    expect(s).toMatchObject({ stan: 'zwrocone_czesciowo', etykieta: 'Zwrócone częściowo', klasa: 'znacznik--szary', zwroconoGr: 3000 });
  });

  it('zwrot bez oddanych pieniędzy nie zmienia stanu (Opłacone)', () => {
    const s = stanPlatnosciKarty(zam({ platnosci: [wplata()] }), { zwroty: [zwrot({ pieniadze_oddane_at: null })] });
    expect(s).toMatchObject({ stan: 'oplacone', zwroconoGr: 0 });
  });

  it('nadpłata → Nadpłata, zielony', () => {
    const s = stanPlatnosciKarty(zam({ platnosci: [wplata(), wplata({ id: 8, kwota: '5.00' })] }));
    expect(s).toMatchObject({ stan: 'nadplata', etykieta: 'Nadpłata', klasa: 'znacznik--ok', saldoGr: 500 });
  });

  it('pusta kwota zamówienia → Błąd wyceny, szary, z opisem z domeny; nie rzuca', () => {
    let s;
    expect(() => { s = stanPlatnosciKarty(zam({ kwota_brutto: '' })); }).not.toThrow();
    expect(s).toMatchObject({ stan: 'blad', etykieta: 'Błąd wyceny', klasa: 'znacznik--szary' });
    expect(String(s.opis ?? '').trim()).not.toBe('');
  });

  it('oddany zwrot bez kwoty → Błąd wyceny „Brak kwoty zwrotu”, nie zgaduje „opłacone”', () => {
    const s = stanPlatnosciKarty(zam({ platnosci: [wplata()] }), { zwroty: [zwrot({ kwota: null })] });
    expect(s).toMatchObject({ stan: 'blad', klasa: 'znacznik--szary', opis: 'Brak kwoty zwrotu' });
  });

  it('w okresie rozliczeniowym bez wpłaty → Rozliczenie zbiorcze', () => {
    expect(stanPlatnosciKarty(zam(), { wOkresie: true })).toMatchObject({
      stan: 'zbiorcze', etykieta: 'Rozliczenie zbiorcze', klasa: 'znacznik--szary',
    });
  });

  it('w okresie, ale opłacone w całości → Opłacone', () => {
    expect(stanPlatnosciKarty(zam({ platnosci: [wplata()] }), { wOkresie: true }).stan).toBe('oplacone');
  });

  it('nie rzuca na braku zamówienia', () => {
    expect(() => stanPlatnosciKarty(undefined)).not.toThrow();
    expect(stanPlatnosciKarty(undefined).klasa).toBe(KLASA_TONU.szary);
  });
});

// PRZ-152.G9a1 — lista ruchów płatności i data ruchu (plan D4, D5). Dane zmyślone.
describe('ruchyPlatnosci — D5', () => {
  const teraz = new Date('2026-11-05T10:00:00Z');
  const ruchy = (nad = {}) => ruchyPlatnosci({ wplaty: [], zwroty: [], pominieteWplaty: [], teraz, ...nad });

  it('wpłata, zwrot, wpłata — rosnąco po dacie, zwrot po dacie oddania pieniędzy', () => {
    const lista = ruchy({
      wplaty: [wplata({ id: 9, kwota: '30.00', data: '2026-11-02T08:00:00' }), wplata({ id: 7, kwota: '70.00', data: '2026-10-30T10:18:00' })],
      zwroty: [zwrot({ id: 3, kwota: '20.00', data: '2026-10-01T00:00:00', pieniadze_oddane_at: '2026-11-03T09:00:00' })],
    });
    expect(lista.map((r) => `${r.rodzaj}:${r.id}`)).toEqual(['wplata:7', 'wplata:9', 'zwrot:3']);
    const l2 = ruchy({
      wplaty: [wplata({ id: 7, data: '2026-10-30T10:00:00' }), wplata({ id: 9, data: '2026-11-04T10:00:00' })],
      zwroty: [zwrot({ id: 3, pieniadze_oddane_at: '2026-11-02T09:00:00' })],
    });
    expect(l2.map((r) => `${r.rodzaj}:${r.id}`)).toEqual(['wplata:7', 'zwrot:3', 'wplata:9']);
  });

  it('przy równej dacie wpłata przed zwrotem', () => {
    const lista = ruchy({
      wplaty: [wplata({ id: 7, data: '2026-11-03T09:00:00' })],
      zwroty: [zwrot({ id: 1, pieniadze_oddane_at: '2026-11-03T09:00:00' })],
    });
    expect(lista.map((r) => r.rodzaj)).toEqual(['wplata', 'zwrot']);
  });

  it('zwrot ma znak „−”, rodzaj „zwrot” i kwotę w groszach', () => {
    const [r] = ruchy({ zwroty: [zwrot({ kwota: '51.80', kwota_dostawy: '10.00' })] });
    expect(r).toMatchObject({ rodzaj: 'zwrot', znak: '−', kwotaGr: 6180, opis: 'Zwrot', id: 3 });
  });

  it('wpłata: znak „+”, opis z metodą, ręczna usuwalna i liczona', () => {
    const [r] = ruchy({ wplaty: [wplata({ id: 7, kwota: '40.00', metoda: 'blik', uwaga: 'telefon' })] });
    expect(r).toMatchObject({
      rodzaj: 'wplata', znak: '+', kwotaGr: 4000, opis: 'Wpłata · BLIK', zrodlo: 'reczna',
      uwaga: 'telefon', id: 7, usuwalna: true, liczona: true,
    });
  });

  it('wpłata ze sklepu: dopisek „ze sklepu”, nieusuwalna', () => {
    const [r] = ruchy({ wplaty: [wplata({ zrodlo: 'sklep', metoda: 'Przelewy24' })] });
    expect(r).toMatchObject({ opis: 'Wpłata · Przelewy24 · ze sklepu', usuwalna: false, liczona: true });
  });

  it('wpłata Allegro ze sklepu: krótki opis bez nawiasu, mieści się w 1 linii (PRZ-154.E4.3)', () => {
    const [r] = ruchy({ wplaty: [wplata({ zrodlo: 'sklep', metoda: 'allegro' })] });
    expect(r.opis).toBe('Wpłata · Allegro · ze sklepu');
  });

  it('nieznana metoda → surowa nazwa', () => {
    const [r] = ruchy({ wplaty: [wplata({ metoda: 'Bon Półcień' })] });
    expect(r.opis).toBe('Wpłata · Bon Półcień');
  });

  it('wpłata nieliczona (data zapłaty ze sklepu przy pobraniu) → liczona:false i opis wyjaśniający', () => {
    const [r] = ruchy({ wplaty: [wplata({ id: 5, zrodlo: 'sklep', metoda: 'Za pobraniem' })], pominieteWplaty: [5] });
    expect(r).toMatchObject({
      id: 5, liczona: false, opis: 'Data zapłaty ze sklepu przy pobraniu — nie jest wpłatą', usuwalna: false,
    });
  });

  it('zwrot bez oddania pieniędzy → „pieniądze do oddania”, liczy się po dacie zwrotu', () => {
    const [r] = ruchy({ zwroty: [zwrot({ pieniadze_oddane_at: null, data: '2026-11-01T12:00:00' })] });
    expect(r).toMatchObject({ rodzaj: 'zwrot', opis: 'Zwrot · pieniądze do oddania', oddany: false });
    expect(r.kiedy).toBe(kiedyRuchu('2026-11-01T12:00:00', teraz));
  });

  it('wpłata scalona niesie numer zamówienia', () => {
    const [r] = ruchy({ wplaty: [wplata({ zZamowienia: 'PC-153', zamowienie_id: 8 })] });
    expect(r).toMatchObject({ zZamowienia: 'PC-153', zamowienieId: 8 });
  });

  it('zepsuta kwota zwrotu nie rzuca', () => {
    const lista = ruchy({ zwroty: [zwrot({ kwota: 'abc' })] });
    expect(lista).toHaveLength(1);
    expect(lista[0].kwotaGr).toBeNull();
  });

  it('brak danych → pusta lista', () => {
    expect(ruchyPlatnosci({})).toEqual([]);
  });
});

describe('kiedyRuchu — D4 (decyzja właściciela 05.11: „4.11”)', () => {
  const teraz = new Date('2026-11-05T10:00:00Z');
  it('sama data → sam dzień D.M, bez „00:00”', () => {
    expect(kiedyRuchu('2026-08-01', teraz)).toBe('1.8');
  });
  it('data z godziną → „D.M GG:MM”', () => {
    expect(kiedyRuchu('2026-08-01T13:38:00', teraz)).toBe('1.8 13:38');
    expect(kiedyRuchu('2026-10-15 09:05:00', teraz)).toBe('15.10 09:05');
  });
  it('dziś i wczoraj też bez słów „dziś”/„wczoraj”', () => {
    expect(kiedyRuchu('2026-11-05T09:00:00Z', teraz)).toBe('5.11 10:00');
    expect(kiedyRuchu('2026-11-04T12:38:00Z', teraz)).toBe('4.11 13:38');
  });
  it('inny rok → „D.M.RRRR GG:MM”', () => {
    expect(kiedyRuchu('2025-12-30T18:00:00', teraz)).toBe('30.12.2025 18:00');
    expect(kiedyRuchu('2025-03-04', teraz)).toBe('4.3.2025');
  });
  it('północ w Warszawie przy zmianie czasu (25.10.2026)', () => {
    // 22:30 UTC 24.10 = 00:30 CEST 25.10; 23:30 UTC 24.10 jeszcze CEST (01:30), a 00:30 UTC 25.10 → 01:30 CET.
    expect(kiedyRuchu('2026-10-24T22:30:00Z', teraz)).toBe('25.10 00:30');
    expect(kiedyRuchu('2026-10-24T21:59:00Z', teraz)).toBe('24.10 23:59');
    expect(kiedyRuchu('2026-10-25T23:30:00Z', teraz)).toBe('26.10 00:30');
  });
  it('rok liczony w Warszawie: sylwester 23:30 UTC to już nowy rok', () => {
    expect(kiedyRuchu('2026-12-31T23:30:00Z', new Date('2026-12-31T10:00:00Z'))).toBe('1.1.2027 00:30');
  });
  it('pusta / nieparsowalna wartość → pusty napis', () => {
    expect(kiedyRuchu(null, teraz)).toBe('');
    expect(kiedyRuchu('', teraz)).toBe('');
    expect(kiedyRuchu('nie data', teraz)).toBe('');
  });
});
