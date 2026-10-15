import { describe, it, expect } from 'vitest';
import {
  sumaWplatGrosze, dataPokryciaWplat, brakujacaKwotaGrosze, saldoWplat, parsujWplate,
  domyslnaKwotaWplaty,
} from '../../src/domena/platnosci.js';

const w = (kwota, data, nad = {}) => ({ kwota, data, zrodlo: 'reczna', utworzona_at: '2026-07-30T10:00:00', ...nad });

describe('suma wpłat', () => {
  it('sumuje wpłaty w groszach', () => {
    expect(sumaWplatGrosze([w('100.00', '2026-07-30'), w('112.90', '2026-07-31')])).toBe(21290);
  });

  it('brak wpłat to zero, nie błąd', () => {
    expect(sumaWplatGrosze([])).toBe(0);
    expect(sumaWplatGrosze(null)).toBe(0);
  });

  // ⚠️ TO JEST CALY POWOD, dla ktorego suma idzie przez grosze() z domain/suma-pozycji.js,
  // a nie przez zwykle dodawanie liczb. Na floatach 35.65 + 35.65 + 141.60 daje
  // 212.89999999999998, czyli MNIEJ niz 212.90 — panel oglosilby niedoplate na zamowieniu
  // oplaconym co do grosza i odmowilby uznania pieniedzy, ktore ma.
  it('trzy wpłaty domykające kwotę co do grosza sumują się DOKŁADNIE (pułapka floatów)', () => {
    const wplaty = [w('35.65', '2026-07-30'), w('35.65', '2026-07-31'), w('141.60', '2026-08-01')];
    expect(sumaWplatGrosze(wplaty)).toBe(21290);
    // Dowod, ze to nie jest test o niczym: to samo na floatach wychodzi PONIZEJ progu.
    expect(wplaty.reduce((a, p) => a + Number(p.kwota), 0) >= 212.90).toBe(false);
    expect(saldoWplat({ kwota_brutto: '212.90', platnosci: wplaty }).stan).toBe('pokryte');
    expect(dataPokryciaWplat(wplaty, '212.90')).toBe('2026-08-01');
  });

  it('pusta kwota wpłaty rzuca, zamiast dawać NaN', () => {
    expect(() => sumaWplatGrosze([w('', '2026-07-30')])).toThrow(/Brak kwoty/);
  });
});

describe('data pokrycia (wyliczone „opłacone")', () => {
  it('jedna wpłata na całość → data tej wpłaty', () => {
    expect(dataPokryciaWplat([w('212.90', '2026-07-30T08:00:00')], '212.90')).toBe('2026-07-30T08:00:00');
  });

  it('suma mniejsza od kwoty → null (zamówienie NIEOPŁACONE)', () => {
    expect(dataPokryciaWplat([w('200.00', '2026-07-30')], '212.90')).toBeNull();
  });

  // Sedno: nie „ostatnia wplata" i nie „pierwsza", tylko TA, ktora przekroczyla prog.
  it('kilka wpłat → data tej, która przekroczyła próg, nie ostatniej z listy', () => {
    const wplaty = [w('100.00', '2026-07-28'), w('112.90', '2026-07-29'), w('50.00', '2026-07-30')];
    expect(dataPokryciaWplat(wplaty, '212.90')).toBe('2026-07-29');
  });

  it('nadpłata też jest pokryciem', () => {
    expect(dataPokryciaWplat([w('300.00', '2026-07-30')], '212.90')).toBe('2026-07-30');
  });

  it('wpłata bez daty spada na czas zapisu, a nie na null', () => {
    expect(dataPokryciaWplat([w('212.90', null)], '212.90')).toBe('2026-07-30T10:00:00');
  });

  it('brak wpłat → null', () => {
    expect(dataPokryciaWplat([], '212.90')).toBeNull();
  });
});

describe('saldo wpłat', () => {
  it('suma mniejsza od kwoty → NIEDOPŁATA z kwotą braku', () => {
    const s = saldoWplat({ kwota_brutto: '212.90', platnosci: [w('150.00', '2026-07-30')] });
    expect(s.stan).toBe('niedoplata');
    expect(s.roznicaZl).toBe('62.90');
    expect(s.sumaZl).toBe('150.00');
    expect(s.kwotaZl).toBe('212.90');
  });

  // Nadplata NIE jest stanem do schowania: to pieniadze klienta.
  it('suma większa od kwoty → NADPŁATA z kwotą nadwyżki', () => {
    const s = saldoWplat({ kwota_brutto: '212.90', platnosci: [w('212.90', '2026-07-30'), w('50.00', '2026-07-31')] });
    expect(s.stan).toBe('nadplata');
    expect(s.roznicaZl).toBe('50.00');
  });

  it('równo → pokryte', () => {
    expect(saldoWplat({ kwota_brutto: '212.90', platnosci: [w('212.90', '2026-07-30')] }).stan).toBe('pokryte');
  });

  it('zero wpłat → niedopłata na całą kwotę', () => {
    const s = saldoWplat({ kwota_brutto: '212.90', platnosci: [] });
    expect(s.stan).toBe('niedoplata');
    expect(s.roznicaZl).toBe('212.90');
  });

  // Karta nie ma prawa sie wywalic, ale MA pokazac problem — nigdy ciche „wszystko gra".
  it('uszkodzona kwota → stan „blad", nie wyjątek i nie „pokryte"', () => {
    const s = saldoWplat({ kwota_brutto: 'abc', platnosci: [] });
    expect(s.stan).toBe('blad');
    expect(s.blad).toMatch(/nie jest liczbą/);
  });
});

describe('brakująca kwota', () => {
  it('liczy różnicę w groszach', () => {
    expect(brakujacaKwotaGrosze({ kwota_brutto: '212.90', platnosci: [w('100.00', '2026-07-30')] })).toBe(11290);
  });

  it('przy pokryciu schodzi do zera albo poniżej', () => {
    expect(brakujacaKwotaGrosze({ kwota_brutto: '212.90', platnosci: [w('300.00', '2026-07-30')] })).toBe(-8710);
  });
});

describe('parsowanie formularza wpłaty', () => {
  it('kwota wymagana — brak kwoty to odmowa dla operatora', () => {
    expect(() => parsujWplate({ kwota: '' })).toThrow(/Podaj kwotę wpłaty/);
    try { parsujWplate({}); } catch (e) { expect(e.dlaOperatora).toBe(true); }
    expect.assertions(2);
  });

  it('kwota nieliczbowa → odmowa z treścią', () => {
    expect(() => parsujWplate({ kwota: 'sto złotych' })).toThrow(/nie jest liczbą/);
  });

  // Przecinek dziesietny to to, co czlowiek w Polsce naprawde wpisuje. Pole wagi na ekranie
  // nadania juz go przyjmuje — odrzucanie go przy pieniadzach byloby niespojnoscia w obrebie
  // jednego panelu, a komunikat „podaj kwote" po podaniu kwoty jest myloncy do bolu.
  it('przecinek dziesiętny czytany jak kropka', () => {
    expect(parsujWplate({ kwota: '212,90', metoda: 'Przelew' }).kwota).toBe('212.90');
    expect(parsujWplate({ kwota: ' 61,50 ', metoda: 'Przelew' }).kwota).toBe('61.50');
    // Kontrola: kropka dziala jak dotad.
    expect(parsujWplate({ kwota: '212.90', metoda: 'Przelew' }).kwota).toBe('212.90');
  });

  it('zero i kwota ujemna → odmowa', () => {
    expect(() => parsujWplate({ kwota: '0' })).toThrow(/większa od zera/);
    expect(() => parsujWplate({ kwota: '-50.00' })).toThrow(/większa od zera/);
  });

  // ⚠️ METODA PRZESTALA BYC OPCJONALNA (audyt 22.08.2026): 11 produkcyjnych wplat bez
  // metody na 3194,56 zl — uzgodnienie z wyciagiem zaczynalo sie od zgadywania.
  it('data i uwaga są opcjonalne, metoda już NIE', () => {
    const p = parsujWplate({ kwota: '61.50', metoda: 'Przelew' }, '2026-07-30T12:00:00Z');
    expect(p).toEqual({ kwota: '61.50', data: '2026-07-30T12:00:00Z', metoda: 'Przelew', uwaga: null });
    expect(() => parsujWplate({ kwota: '61.50' }, '2026-07-30T12:00:00Z')).toThrow(/metod/i);
  });

  // ⚠️ DATA WSTECZNA DOSTAJE GODZINE ZERO (od 07.08.2026). Do tej pory szla do bazy golym
  // napisem `2026-08-01` — a `oplacone_at` czyta sie z niej jako znacznik czasu, wiec dzien
  // bez godziny byl polowicznym zapisem, ktory dzialal przez przypadek. Godziny przeoczonego
  // przelewu nie znamy, wiec jej nie zmyslamy — stad polnoc, a nie „teraz".
  it('przepisuje podaną datę (z godziną zero), metodę i uwagę', () => {
    const p = parsujWplate(
      { kwota: '61.5', data: '2026-08-01', metoda: 'BLIK', uwaga: 'dopłata za szablon' },
      '2026-08-07T10:30:00.000Z',
    );
    expect(p).toEqual({
      kwota: '61.50', data: '2026-08-01T00:00:00', metoda: 'BLIK', uwaga: 'dopłata za szablon',
    });
  });
});

// ——— DATA I DOMYŚLNA KWOTA WPŁATY (2026-08-07) ————————————————————————————————————
//
// Prośba właściciela: „przy ręcznym dodawaniu płatności powinny być dwa pola, jedno z datą,
// drugie z kwotą […] domyślnie powinna być ustawiona data dzisiejsza i cała kwota, bo tak
// jest najczęściej".
//
// ⚠️ POLE DATY ISTNIALO, ale było gołym okienkiem tekstowym bez etykiety, w rzędzie czterech
// identycznych — i NIC GO NIE WALIDOWAŁO: co człowiek wpisał, lądowało w bazie znak w znak.
// A z tej daty wylicza się `oplacone_at`, czyli odpowiedź na pytanie „kiedy klient zapłacił".
// „5 sierpnia" albo „05.08.2026" zapisywało się bez mrugnięcia i nie dawało się potem
// sformatować (`fmtDataCzas` oddaje wtedy pusty string), więc data znikała z karty.
describe('data wpłaty', () => {
  const teraz = '2026-08-07T10:30:00.000Z';

  it('brak daty dalej bierze bieżący czas — wpłata bez daty dawałaby „opłacone nigdy”', () => {
    expect(parsujWplate({ kwota: '10', metoda: 'Przelew' }, teraz).data).toBe(teraz);
  });

  // ⚠️ DATA DZISIEJSZA DOSTAJE PEŁNY ZNACZNIK CZASU, a nie północ. Zamówienie złożone dziś
  // o 10:33 z wpłatą „dziś 00:00" twierdziłoby, że pieniądze przyszły PRZED zamówieniem.
  it('dzisiejsza data bierze bieżącą godzinę, nie północ', () => {
    expect(parsujWplate({ kwota: '10', data: '2026-08-07', metoda: 'Przelew' }, teraz).data).toBe(teraz);
  });

  // ⚠️ DATA WSTECZNA DOSTAJE PÓŁNOC — i to jest uczciwe: godziny przeoczonego przelewu
  // nie znamy, więc jej nie zmyślamy. Ta sama zasada, co przy podłodze pollera
  // („data dostaje godzinę zero, bo sklep pyta o moment, nie o dzień").
  it('data wsteczna dostaje godzinę zero', () => {
    expect(parsujWplate({ kwota: '10', data: '2026-08-01', metoda: 'Przelew' }, teraz).data).toBe('2026-08-01T00:00:00');
  });

  // ⚠️ TO JEST CAŁA POPRAWKA: bylejaka wartość ma dostać ODMOWĘ, a nie wylądować w bazie.
  it('data, której nie da się odczytać, to odmowa — nie cichy zapis', () => {
    expect(() => parsujWplate({ kwota: '10', data: '05.08.2026' }, teraz)).toThrow(/RRRR-MM-DD/);
    expect(() => parsujWplate({ kwota: '10', data: '5 sierpnia' }, teraz)).toThrow(/RRRR-MM-DD/);
    expect(() => parsujWplate({ kwota: '10', data: '2026-8-1' }, teraz)).toThrow(/RRRR-MM-DD/);
  });

  // „2026-02-31" przechodzi wzorzec, a Date cicho przesuwa je na 3 marca — czyli wpłata
  // wyladowalaby w innym dniu, niż człowiek wskazał. Ta sama pułapka co przy `SHOP_*_OD`.
  it('data, której nie ma w kalendarzu, też jest odmową', () => {
    expect(() => parsujWplate({ kwota: '10', data: '2026-02-31' }, teraz)).toThrow(/nie jest istniejącą datą/);
  });

  // Data z przyszłości to prawie zawsze literówka w roku, a wpłata „z przyszłości" psuje
  // `oplacone_at` w sposób, którego nikt nie zauważy.
  it('data z przyszłości jest odmową', () => {
    expect(() => parsujWplate({ kwota: '10', data: '2027-01-01' }, teraz)).toThrow(/przyszłości/);
  });
});

// ⚠️ DOMYŚLNA KWOTA TO BRAKUJĄCA CZĘŚĆ, nie kwota zamówienia. Przy dopłacie po wpłacie
// częściowej podstawienie pełnej kwoty znaczyłoby nadpłatę wpisaną jednym kliknięciem.
describe('domyślna kwota wpłaty w formularzu', () => {
  const zam = (kwota, wplaty = []) => ({
    sklep: 'pro', kwota_brutto: kwota, pozycje: [], platnosci: wplaty,
  });

  it('bez wpłat proponuje całą kwotę zamówienia', () => {
    expect(domyslnaKwotaWplaty(zam('212.90'))).toBe('212.90');
  });

  it('po wpłacie częściowej proponuje BRAKUJĄCĄ resztę', () => {
    expect(domyslnaKwotaWplaty(zam('212.90', [{ kwota: '100.00' }]))).toBe('112.90');
  });

  // Nie ma czego dopłacać — pole zostaje puste, żeby nie zapraszać do nadpłaty.
  it('przy pokrytej kwocie nie proponuje nic', () => {
    expect(domyslnaKwotaWplaty(zam('212.90', [{ kwota: '212.90' }]))).toBe('');
  });

  it('przy nadpłacie też nie proponuje nic', () => {
    expect(domyslnaKwotaWplaty(zam('212.90', [{ kwota: '300.00' }]))).toBe('');
  });
});
