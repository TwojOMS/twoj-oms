import { describe, it, expect } from 'vitest';
import {
  kluczOkresu, okresPrzyjmujeZamowienia, opisOdmowy, stanFakturyOkresu, STAN,
} from '../../src/domena/okres-rozliczeniowy.js';

describe('kluczOkresu', () => {
  // ⚠️ ZNACZNIKI DOBIERANE POD CZAS WARSZAWSKI, NIE POD UTC. Pierwsza wersja tych testow
  // brala '2026-07-31T22:15Z' i '2026-07-31T23:59Z' — a to w Polsce jest juz 1 sierpnia
  // (00:15 i 01:59), czyli SIERPIEN. Testy przechodzily wylacznie dlatego, ze kod tez liczyl
  // w UTC. 20:00Z to 22:00 czasu polskiego — lipiec bez zadnej watpliwosci.
  it('bierze rok i miesiac z daty zlozenia', () => {
    expect(kluczOkresu('2026-07-15T22:15:00.000Z')).toEqual({ rok: 2026, miesiac: 7 });
  });

  it('zamowienie z 31 lipca zostaje w lipcu, choc wyjdzie w sierpniu', () => {
    expect(kluczOkresu('2026-07-31T20:00:00.000Z')).toEqual({ rok: 2026, miesiac: 7 });
  });

  // ⚠️ PUŁAPKA, KTORA KOSZTUJE FAKTURE (recenzja 2026-08-01). Zamowienie przyjete przez
  // telefon 1 sierpnia o 01:30 czasu polskiego dostaje znacznik '2026-07-31T23:30:00Z',
  // bo kontener chodzi z TZ=UTC. Liczone w UTC wpadaloby do LIPCA: albo po cichu na lipcowa
  // fakture zbiorcza (lipiec otwarty), albo — czesciej, bo lipiec zamyka sie wlasnie
  // na przelomie — na odmowe zapisu przy zamowieniu, ktore dla operatora jest sierpniowe.
  // Miesiac rozliczeniowy jest pojeciem handlowym i liczy sie tak, jak widzi go czlowiek
  // w Polsce, a nie serwer w UTC.
  it('noc z 31 lipca na 1 sierpnia czasu POLSKIEGO to juz sierpien', () => {
    expect(kluczOkresu('2026-07-31T23:30:00.000Z')).toEqual({ rok: 2026, miesiac: 8 });
  });

  // Zima, przesuniecie tylko +1 h — regula ta sama, granica gdzie indziej. 23:30Z to
  // 00:30 czasu polskiego 1 stycznia, czyli STYCZEN NASTEPNEGO ROKU (zmienia sie tez rok).
  it('sylwester po polnocy czasu polskiego to juz nowy rok (zima, +1 h)', () => {
    expect(kluczOkresu('2026-12-31T23:30:00.000Z')).toEqual({ rok: 2027, miesiac: 1 });
    expect(kluczOkresu('2026-12-31T22:30:00.000Z')).toEqual({ rok: 2026, miesiac: 12 });
  });

  it('sam dzien tez dziala (bez czesci czasowej)', () => {
    expect(kluczOkresu('2026-01-01')).toEqual({ rok: 2026, miesiac: 1 });
  });

  it('nieczytelna data to blad, a nie ciche NaN', () => {
    expect(() => kluczOkresu('wczoraj')).toThrow(/data/i);
    expect(() => kluczOkresu(null)).toThrow(/data/i);
  });

  it('kalendarzowo niepoprawna data (przewinieta przez V8) to blad, a nie cichy inny miesiac', () => {
    expect(() => kluczOkresu('2026-02-30')).toThrow(/data/i);
    expect(() => kluczOkresu('2026-04-31')).toThrow(/data/i);
  });

  it('poprawne przypadki graniczne przechodza: koniec lutego i przestepny 29 lutego', () => {
    expect(kluczOkresu('2026-02-28')).toEqual({ rok: 2026, miesiac: 2 });
    expect(kluczOkresu('2028-02-29')).toEqual({ rok: 2028, miesiac: 2 });
  });

  it('data ze znacznikiem czasu i jawna strefa inna niz Z nie jest odrzucana (regresja)', () => {
    // '2027-01-01T02:00:00+05:00' to legalnie 2026-12-31T21:00Z, czyli 22:00 czasu
    // polskiego 31 grudnia — przeliczenie na Warszawe cofa date o miesiac. To zaskakujace,
    // wiec przybijamy je testem na konkretny wynik zamiast tylko sprawdzac brak wyjatku.
    expect(kluczOkresu('2027-01-01T02:00:00+05:00')).toEqual({ rok: 2026, miesiac: 12 });
  });

  it('znacznik czasu z kalendarzowo niepoprawna data jest lapany (regresja — najczestszy ksztalt wejscia)', () => {
    expect(() => kluczOkresu('2026-02-30T00:00:00.000Z')).toThrow(/data/i);
    expect(() => kluczOkresu('2026-04-31T12:00:00Z')).toThrow(/data/i);
    expect(() => kluczOkresu('2026-02-30T10:00:00')).toThrow(/data/i);
  });
});

describe('okresPrzyjmujeZamowienia', () => {
  it('otwarty przyjmuje', () => {
    expect(okresPrzyjmujeZamowienia(STAN.OTWARTY)).toBe(true);
  });

  it('zamkniety i zafakturowany nie przyjmuja', () => {
    expect(okresPrzyjmujeZamowienia(STAN.ZAMKNIETY)).toBe(false);
    expect(okresPrzyjmujeZamowienia(STAN.ZAFAKTUROWANY)).toBe(false);
  });

  it('nieznany stan traktujemy jako zamkniety', () => {
    expect(okresPrzyjmujeZamowienia('cokolwiek')).toBe(false);
  });
});

describe('opisOdmowy', () => {
  it('mowi, ktory miesiac i co zrobic', () => {
    expect(opisOdmowy(2026, 7)).toMatch(/lipiec 2026/i);
  });
});

// `stanFaktury` z domain/faktura-stan.js czyta PUSTY `ksef_status` jako „wystawiona" — dla
// wiersza w tabeli `faktury` slusznie, bo tamten wiersz powstaje dopiero przy wystawianiu.
// Okres istnieje od pierwszego zamowienia miesiaca, wiec bez tej oslony swiezy okres
// udawalby zafakturowany i panel NIGDY nie wystawilby faktury zbiorczej.
describe('stanFakturyOkresu', () => {
  it('swiezy okres nie ma faktury', () => {
    expect(stanFakturyOkresu({ id: 1, stan: STAN.OTWARTY, ksef_status: null, infakt_uuid: null })).toBe('brak');
  });

  it('goly wiersz bez ani jednej kolumny faktury tez nie ma faktury', () => {
    expect(stanFakturyOkresu({ id: 1, stan: STAN.OTWARTY })).toBe('brak');
  });

  it('brak okresu to brak faktury', () => {
    expect(stanFakturyOkresu(null)).toBe('brak');
    expect(stanFakturyOkresu(undefined)).toBe('brak');
  });

  it('rezerwacja swiezsza od progu to trwajace wystawianie', () => {
    const teraz = Date.parse('2026-08-01T12:00:00.000Z');
    const okres = { ksef_status: 'w_toku', utworzona_at: '2026-08-01T11:59:00.000Z' };
    expect(stanFakturyOkresu(okres, teraz)).toBe('w_toku');
  });

  it('rezerwacja starsza od progu to sierota', () => {
    const teraz = Date.parse('2026-08-01T12:00:00.000Z');
    const okres = { ksef_status: 'w_toku', utworzona_at: '2026-08-01T11:00:00.000Z' };
    expect(stanFakturyOkresu(okres, teraz)).toBe('zawieszona');
  });

  it('okres z UUID-em i pustym ksef_status jest wystawiony', () => {
    expect(stanFakturyOkresu({ infakt_uuid: 'u-1', numer: 'FV/1/2026', ksef_status: null })).toBe('wystawiona');
  });

  it('do wyjasnienia zostaje do wyjasnienia', () => {
    expect(stanFakturyOkresu({ ksef_status: 'do_wyjasnienia', blad_opis: 'bum' })).toBe('do_wyjasnienia');
  });

  // ⚠️ REGRESJA Z RECENZJI 2026-08-01. Warunek o samych kolumnach faktury czytal okres
  // zafakturowany dokumentem BEZ uuid-a i BEZ numeru (odpowiedz inFaktu z nieczytelnym
  // cialem) jako „brak" — czyli kasowal blokade i przepuszczal drugie wystawienie. `stan`
  // jest w tym jednym przypadku JEDYNYM sladem, ze faktura juz poszla.
  it('okres zafakturowany z pustymi kolumnami faktury NIE jest „brak"', () => {
    const okres = { stan: STAN.ZAFAKTUROWANY, ksef_status: null, infakt_uuid: null, numer: null };
    expect(stanFakturyOkresu(okres)).not.toBe('brak');
    expect(stanFakturyOkresu(okres)).toBe('wystawiona');
  });

  // ...a okres zamkniety (nie zafakturowany) z pustymi kolumnami dalej jest „brak" — inaczej
  // zamkniecie miesiaca samo w sobie blokowaloby wystawienie faktury za ten miesiac.
  it('okres zamkniety bez kolumn faktury dalej nie ma faktury', () => {
    expect(stanFakturyOkresu({ stan: STAN.ZAMKNIETY, ksef_status: null, infakt_uuid: null })).toBe('brak');
  });
});
