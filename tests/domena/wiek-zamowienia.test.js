import { describe, it, expect } from 'vitest';
import { wiekZamowienia, czyEkspres } from '../../src/domena/wiek-zamowienia.js';

// Wiersz jak z listaZamowien: fakty, ktorych zegar uzywa. Daty bez strefy = czas sklepu
// (Warszawa), daty z `Z` = nasze znaczniki UTC — obie skale musza dzialac.
const zam = (nad = {}) => ({
  sklep: 'szkicownia', utworzone_at: '2026-08-18T10:00:00', oplacone_at: '2026-08-18T10:00:00',
  pobranie: 0, b2b: 0, indywidualne: 0, anulowane: 0, anulowane_recznie: null,
  wyslane_at: null, pozycje: [{ nazwa: 'Szablon malarski' }], ...nad,
});

describe('czyEkspres', () => {
  it('łapie fragmenty „ekspres” i „priorytetowa” bez względu na wielkość liter', () => {
    expect(czyEkspres([{ nazwa: 'Realizacja ekspresowa' }])).toBe(true);
    expect(czyEkspres([{ nazwa: 'Wysyłka PRIORYTETOWA' }])).toBe(true);
    expect(czyEkspres([{ nazwa: 'Szablon malarski' }])).toBe(false);
    expect(czyEkspres([])).toBe(false);
    expect(czyEkspres(undefined)).toBe(false);
  });
});

describe('wiek i zegar — typ krótki (sklep szkicownia)', () => {
  it('opłacone wtorek → środa „wysyłka: dziś”, w terminie', () => {
    const w = wiekZamowienia(zam(), '2026-08-19T09:00:00Z');
    expect(w.poTerminie).toBe(false);
    expect(w.opis).toBe('wysyłka: dziś');
    expect(w.wiek).toBe('1 dzień');
  });
  it('opłacone wtorek → czwartek po terminie o 1 dzień rob.', () => {
    const w = wiekZamowienia(zam(), '2026-08-20T09:00:00Z');
    expect(w.poTerminie).toBe(true);
    expect(w.opis).toBe('po terminie o 1 dzień rob.');
  });
  it('opłacone piątek po 12 → sobota „wysyłka: pn 24.08”; wtorek po terminie', () => {
    const start = { utworzone_at: '2026-08-21T14:00:00', oplacone_at: '2026-08-21T14:00:00' };
    expect(wiekZamowienia(zam(start), '2026-08-22T10:00:00Z').opis).toBe('wysyłka: pn 24.08');
    expect(wiekZamowienia(zam(start), '2026-08-25T10:00:00Z').poTerminie).toBe(true);
  });
});

describe('Allegro — odcięcie 12:00 w czasie polskim', () => {
  const allegro = (nad = {}) => zam({ sklep: 'allegro_szkicownia', ...nad });
  it('opłacone pn 11:59 czasu PL → „wysyłka: dziś · opłacone przed 12:00”; wtorek po terminie', () => {
    const start = { oplacone_at: '2026-08-17T11:59:00', utworzone_at: '2026-08-17T11:50:00' };
    const w = wiekZamowienia(allegro(start), '2026-08-17T14:00:00Z');
    expect(w.opis).toBe('wysyłka: dziś · opłacone przed 12:00');
    expect(w.poTerminie).toBe(false);
    expect(wiekZamowienia(allegro(start), '2026-08-18T09:00:00Z').poTerminie).toBe(true);
  });
  // ⚠️ Dopisek 12:00 stoi WYŁĄCZNIE przy starcie PRZED odcięciem (prośba właściciela 23.08):
  // tam tłumaczy, czemu paczka ma wyjechać jeszcze dziś. Przy „jutro" nie tłumaczy niczego,
  // czego termin już nie mówi — więc go nie ma, i to jest cała różnica między tymi gałęziami.
  it('równo 12:00 to już PO odcięciu — samo „wysyłka: jutro", bez dopisku', () => {
    const w = wiekZamowienia(allegro({ oplacone_at: '2026-08-17T12:00:00' }), '2026-08-17T14:00:00Z');
    expect(w.opis).toBe('wysyłka: jutro');
  });
  it('znacznik UTC: 09:59Z latem = 11:59 PL → przed odcięciem (i 10:00Z = 12:00 PL → po)', () => {
    expect(wiekZamowienia(allegro({ oplacone_at: '2026-08-17T09:59:00Z' }), '2026-08-17T14:00:00Z')
      .opis).toBe('wysyłka: dziś · opłacone przed 12:00');
    expect(wiekZamowienia(allegro({ oplacone_at: '2026-08-17T10:00:00Z' }), '2026-08-17T14:00:00Z')
      .opis).toBe('wysyłka: jutro');
  });
  it('znacznik UTC zimą: 10:59Z = 11:59 PL → przed odcięciem (i 11:00Z = 12:00 PL → po)', () => {
    // 2026-01-12 to poniedziałek; zimą Warszawa = UTC+1, więc granica 12:00 PL = 11:00Z.
    // Razem z letnim przypadkiem wyżej ten test przypina cutoff do STREFY, nie do stałego
    // przesunięcia — mutacja czytająca godzinę z surowego napisu ginie w obu porach roku.
    expect(wiekZamowienia(allegro({ oplacone_at: '2026-01-12T10:59:00Z' }), '2026-01-12T14:00:00Z')
      .opis).toBe('wysyłka: dziś · opłacone przed 12:00');
    expect(wiekZamowienia(allegro({ oplacone_at: '2026-01-12T11:00:00Z' }), '2026-01-12T14:00:00Z')
      .opis).toBe('wysyłka: jutro');
  });
  it('start w sobotę → bez dopisku 12:00, wysyłka pn; wtorek po terminie', () => {
    const start = { oplacone_at: '2026-08-22T09:00:00', utworzone_at: '2026-08-22T09:00:00' };
    expect(wiekZamowienia(allegro(start), '2026-08-22T10:00:00Z').opis).toBe('wysyłka: pn 24.08');
    expect(wiekZamowienia(allegro(start), '2026-08-25T09:00:00Z').poTerminie).toBe(true);
  });
});

describe('ekspres i indywidualne', () => {
  it('ekspres: 2 dni rob., zapis zużycia „od wpłaty 1/2 dni rob.”', () => {
    const w = wiekZamowienia(zam({ pozycje: [{ nazwa: 'Realizacja ekspresowa' }] }), '2026-08-19T09:00:00Z');
    expect(w.typ).toBe('ekspres');
    expect(w.opis).toBe('od wpłaty 1/2 dni rob.');
    expect(w.poTerminie).toBe(false);
  });
  it('ekspres po terminie: wtorek + 3 dni rob. → piątek', () => {
    const w = wiekZamowienia(zam({ pozycje: [{ nazwa: 'Realizacja ekspresowa' }] }), '2026-08-21T09:00:00Z');
    expect(w.poTerminie).toBe(true);
    expect(w.opis).toBe('po terminie o 1 dzień rob.');
  });
  it('indywidualne: 7 dni rob., w terminie po 3', () => {
    const w = wiekZamowienia(zam({ indywidualne: 1 }), '2026-08-21T09:00:00Z');
    expect(w.typ).toBe('indywidualne');
    expect(w.opis).toBe('od wpłaty 3/7 dni rob.');
  });
  it('ekspres bije indywidualne', () => {
    const w = wiekZamowienia(zam({ indywidualne: 1, pozycje: [{ nazwa: 'Realizacja ekspresowa' }] }),
      '2026-08-19T09:00:00Z');
    expect(w.typ).toBe('ekspres');
  });
});

describe('start zegara', () => {
  it('pobranie bez wpłaty liczy od złożenia', () => {
    const w = wiekZamowienia(zam({ pobranie: 1, oplacone_at: null }), '2026-08-19T09:00:00Z');
    expect(w.opis).toBe('wysyłka: dziś');
  });
  it('B2B bez wpłaty liczy od złożenia', () => {
    const w = wiekZamowienia(zam({ b2b: 1, oplacone_at: null }), '2026-08-20T09:00:00Z');
    expect(w.poTerminie).toBe(true);
  });
  it('pobranie Allegro: dopisek mówi „złożone”, nie „opłacone”', () => {
    const w = wiekZamowienia(zam({ sklep: 'allegro_szkicownia', pobranie: 1, oplacone_at: null,
      utworzone_at: '2026-08-17T09:00:00' }), '2026-08-17T14:00:00Z');
    expect(w.opis).toBe('wysyłka: dziś · złożone przed 12:00');
  });
  it('nieopłacona przedpłata: zegar nie biegnie, zero koloru', () => {
    const w = wiekZamowienia(zam({ oplacone_at: null }), '2026-08-25T09:00:00Z');
    expect(w.poTerminie).toBe(false);
    expect(w.opis).toBe('czeka na wpłatę');
    expect(w.wiek).toBe('7 dni');
  });
});

describe('gaśnięcie zegara', () => {
  it('wysłane → null (nawet dawno spóźnione)', () => {
    expect(wiekZamowienia(zam({ wyslane_at: '2026-08-19T10:00:00Z' }), '2026-08-25T09:00:00Z')).toBeNull();
  });
  it('anulowane sklepowo i ręcznie → null', () => {
    expect(wiekZamowienia(zam({ anulowane: 1 }), '2026-08-19T09:00:00Z')).toBeNull();
    expect(wiekZamowienia(zam({ anulowane_recznie: 1 }), '2026-08-19T09:00:00Z')).toBeNull();
  });
});

describe('odporność na śmieciowe daty', () => {
  // FIX blokujący z recenzji gałęzi: „śmieciowa" (niepusta, ale niesparsowalna) data w
  // `oplacone_at`/`utworzone_at` ma dać zegar bez opisu, NIGDY wyjątek — jeden uszkodzony
  // wiersz nie ma prawa położyć całej listy ani akcji masowych (patrz guard w domenie
  // zaraz po `dzienStartu`).
  it('data-śmieć (typ krótki) → opis pusty, brak koloru, bez wyjątku', () => {
    const w = wiekZamowienia(zam({ oplacone_at: '0000-00-00T00:00:00Z' }), '2026-08-19T09:00:00Z');
    expect(w.opis).toBe('');
    expect(w.poTerminie).toBe(false);
  });
  it('data-śmieć (Allegro) też nie rzuca', () => {
    expect(() => wiekZamowienia(
      zam({ sklep: 'allegro_szkicownia', oplacone_at: '0000-00-00T00:00:00Z' }),
      '2026-08-19T09:00:00Z',
    )).not.toThrow();
  });
});

describe('wiek kalendarzowy', () => {
  it('dziś → „dziś”, wczoraj → „1 dzień”, 5 dni → „5 dni”', () => {
    expect(wiekZamowienia(zam({ utworzone_at: '2026-08-19T08:00:00' }), '2026-08-19T09:00:00Z').wiek).toBe('dziś');
    expect(wiekZamowienia(zam(), '2026-08-19T09:00:00Z').wiek).toBe('1 dzień');
    expect(wiekZamowienia(zam(), '2026-08-23T09:00:00Z').wiek).toBe('5 dni');
  });
});
