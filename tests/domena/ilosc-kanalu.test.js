import { describe, it, expect } from 'vitest';
import { iloscDlaKanalu, skokIlosci, ocenRozjazdu, wolnoPodniesc, zeroMasowe,
  propozycjaOtwarcia, skrotZatwierdzenia, kluczKomendyIlosci, kolejnoscWysylek,
  PROBLEMY_ILOSCI, liczySieDoZeraMasowego, potwierdzenieZerWazne } from '../../src/domena/ilosc-kanalu.js';

const migawka = (stan = 7) => ({ wlaczone: true, przelaczenieId: 4,
  zatwierdzenie: { przelaczenieId: 4 }, znane: new Set([1]),
  stany: new Map([[1, { stan }]]), otwarcia: new Map([[1, { ilosc: 0, zrodlo: 'reczne' }]]),
  policzonoAt: '2026-11-14T10:05:00Z' });
const poller = { ostatniPrzebiegAt: '2026-11-14T10:04:00Z', ostatniBlad: null };
const odczyt = { ilosc: 4, odczytanoAt: '2026-11-14T10:00:00Z' };
const podwyzka = (zmiany = {}) => ({ cel: 5, odczyt: 4, poprzedniOdczyt: odczyt,
  poller, policzonoAt: '2026-11-14T10:05:00Z', pollerMs: 120000, ...zmiany });
const rozjazd = (zmiany = {}) => ({ wyslanaIlosc: 8, odczyt: 6, cel: 6,
  wyjasnienie: { sprzedaneOd: 2, anulowaneOd: 0 },
  odczytanoAt: '2026-11-14T10:00:00Z', poller: null, pollerMs: 120000,
  policzonoAt: '2026-11-14T10:05:00Z', ...zmiany });

describe('ilość dla kanału D47', () => {
  it.each([
    ['stała przy wyłączonych', { wlaczone: false }, {}, 5, null, 'stala'],
    ['obserwowana przy wyłączonych', { wlaczone: false }, { tryb: 'obserwowana', iloscZOms: true }, null, 'stany-wylaczone', null],
    ['brak stałej', { wlaczone: false }, { stalaIlosc: null }, null, 'brak-stalej', null],
    ['bez zatwierdzenia', { zatwierdzenie: null }, {}, null, 'stany-niezatwierdzone', null],
    ['stare zatwierdzenie', { zatwierdzenie: { przelaczenieId: 3 } }, {}, null, 'stany-niezatwierdzone', null],
    ['nieznana karta', { znane: new Set() }, {}, null, 'brak-stanu', null],
    ['otwarcie zero', { stany: new Map([[1, { stan: 0 }]]) }, {}, 0, null, 'stan'],
    ['bufor', {}, { bufor: 2 }, 5, null, 'stan'],
    ['bufor ponad stan', { stany: new Map([[1, { stan: 1 }]]) }, { bufor: 3 }, 0, null, 'stan'],
    ['ujemny stan', { stany: new Map([[1, { stan: -2 }]]) }, {}, 0, null, 'stan'],
    ['karta znana bez wpisu w stanach', { stany: new Map() }, {}, null, 'brak-stanu', null],
    ['obserwowana bez flagi', {}, { tryb: 'obserwowana', iloscZOms: false }, null, null, null],
  ])('%s', (_, m, opcje, ilosc, powod, zrodlo) => {
    expect(iloscDlaKanalu({ migawka: { ...migawka(), ...m }, kartaId: 1,
      tryb: 'zarzadzana', stalaIlosc: 5, bufor: 0, ...opcje })).toEqual({ ilosc, powod, zrodlo });
  });
});

describe('skok D53', () => {
  it.each([
    ['sprzedaż wyjaśnia', 3, 7, 5, null], ['bez wyjaśnienia', 3, 0, 5, 'skok'],
    ['granica progu', 5, 0, 5, null], ['zmiana bufora', 10, 0, 5, null],
  ])('%s', (_, stan, wyjasnioneKarty, prog, kod) => {
    expect(skokIlosci({ stan, stanKartyWyslany: 10, wyjasnioneKarty, prog,
      cel: 0, wyslanaIlosc: 10 })?.kod ?? null).toBe(kod);
  });
  it('pierwsza wysyłka nie ma punktu odniesienia', () => {
    expect(skokIlosci({ stan: 50, stanKartyWyslany: null })).toBeNull();
  });
});

describe('podwyżki D64', () => {
  it.each([
    ['pierwszy odczyt', { poprzedniOdczyt: null }, false, 'karencja'],
    ['poller przed odczytem', { poller: { ...poller, ostatniPrzebiegAt: '2026-11-14T09:59:00Z' } }, false, 'karencja'],
    ['migawka przed pollerem', { policzonoAt: '2026-11-14T10:03:00Z' }, false, 'karencja'],
    ['migawka równocześnie z pollerem', { policzonoAt: poller.ostatniPrzebiegAt }, false, 'karencja'],
    ['puls dokładnie po interwale', { poller: { ...poller, ostatniPrzebiegAt: '2026-11-14T10:02:00Z' } }, true, null],
    ['odczyt się zmienił', { poprzedniOdczyt: { ...odczyt, ilosc: 3 } }, false, 'karencja'],
    ['awaria', { poller: { ...poller, ostatniBlad: 'awaria' } }, false, 'karencja'],
    ['brak pollera', { poller: null }, false, 'brak-pollera'],
    ['komplet', {}, true, null],
    ['pominięcie', { poller: { ...poller, ostatniBlad: 'pominięto', ostatniBladRodzaj: 'pominiecie' } }, true, null],
    ['obniżka bez pollera', { cel: 3, poller: null, poprzedniOdczyt: null }, true, null],
    ['brak odczytu undefined', { odczyt: undefined, poprzedniOdczyt: { ...odczyt, ilosc: undefined } }, false, 'karencja'],
    ['brak odczytu null', { odczyt: null, poprzedniOdczyt: { ...odczyt, ilosc: null } }, false, 'karencja'],
    ['brak odczytu, cel 0', { odczyt: undefined, cel: 0, poller: null }, false, 'karencja'],
    ['ujemny odczyt', { odczyt: -2, cel: 0, poprzedniOdczyt: { ...odczyt, ilosc: -2 } }, true, null],
  ])('%s', (_, zmiany, wolno, powod) => expect(wolnoPodniesc(podwyzka(zmiany))).toEqual({ wolno, powod }));
});

describe('rozjazd D54', () => {
  it.each([
    ['sprzedane dwie', {}, true, null, true],
    ['spadek w karencji', { odczyt: 4, cel: 3 }, false, 'karencja', true],
    ['podwyżka w karencji', { odczyt: 4, cel: 5 }, false, 'karencja', false],
    ['rozjazd w górę', { odczyt: 9, cel: 6 }, false, 'rozjazd-gora', true],
    ['anulowanie', { odczyt: 9, wyjasnienie: { sprzedaneOd: 2, anulowaneOd: 1 } }, true, null, true],
    ['Woo opłacone po T', { kanal: 'woo', odczyt: 6, wyjasnienie: { sprzedaneOd: 2, anulowaneOd: 0 } }, true, null, true],
    ['Woo on-hold do failed', { kanal: 'woo', odczyt: 9, wyjasnienie: { sprzedaneOd: 0, anulowaneOd: 1 } }, true, null, true],
  ])('%s', (_, zmiany, zgodny, kod, wolnoWyslac) => {
    const wynik = ocenRozjazdu(rozjazd(zmiany));
    expect(wynik.zgodny).toBe(zgodny);
    expect(wynik.problem?.kod ?? null).toBe(kod);
    expect(wynik.wolnoWyslac).toBe(wolnoWyslac);
  });
  it.each([undefined, '2026-11-14T07:00:00Z'])('cisza 3 h, kursor %s: karencję kończy puls', kursor => {
    const wynik = ocenRozjazdu(rozjazd({ odczyt: 4, cel: 3, alarmOd: '2026-11-14T07:00:00Z',
      poller: { ...poller, zsynchronizowane_do: kursor } }));
    expect(wynik.problem).toMatchObject({ kod: 'rozjazd-dol', wstrzymuje: true, cel: 3, odczyt: 4,
      od: '2026-11-14T07:00:00Z', zakres: { min: 6, max: 8 } });
    expect(wynik.wolnoWyslac).toBe(false);
  });
  it('karencja liczy się od alarmu, nie od czasu odczytu', () => {
    const wynik = ocenRozjazdu(rozjazd({ odczyt: 4, cel: 3, alarmOd: '2026-11-14T07:00:00Z',
      odczytanoAt: '2026-11-14T10:03:00Z', poller }));
    expect(wynik.problem.kod).toBe('rozjazd-dol');
  });
  it.each([undefined, null])('brak odczytu %s: odmowa, bez bazy', brak => {
    expect(ocenRozjazdu(rozjazd({ odczyt: brak, cel: null }))).toMatchObject({
      zgodny: false, wolnoWyslac: false, baza: null });
    expect(ocenRozjazdu(rozjazd({ odczyt: brak, cel: 3 }))).toMatchObject({
      zgodny: false, wolnoWyslac: false, baza: null });
  });
  it('data bez strefy jest czytana jako UTC', () => {
    const wynik = ocenRozjazdu(rozjazd({ odczyt: 4, cel: 3, alarmOd: '2026-11-14 07:00:00', poller,
      policzonoAt: '2026-11-14 10:05:00' }));
    expect(wynik.problem.kod).toBe('rozjazd-dol');
  });
  it.each([{ cel: 4 }, { wartosc: 4 }])('zapis w toku %j odbudowuje bazę', wToku => {
    expect(ocenRozjazdu(rozjazd({ odczyt: 4, wToku }))).toMatchObject({ zgodny: true,
      baza: { wyslanaIlosc: 4, iloscWyslanaAt: '2026-11-14T10:00:00Z' } });
  });
  it('odczyt celu przesuwa bazę, brak poprzedniej wysyłki nie alarmuje', () => {
    expect(ocenRozjazdu(rozjazd()).baza?.wyslanaIlosc).toBe(6);
    expect(ocenRozjazdu(rozjazd({ wyslanaIlosc: null })).problem).toBeNull();
  });
});

it.each([[3, 5, true], [2, 3, false], [12, 30, false], [3, 6, true], [0, 0, false]])(
  'zero masowe %i / %i', (zera, liczba, wynik) => {
    const oferty = Array.from({ length: liczba }, (_, i) => ({ cel: i < zera ? 0 : 2, odczyt: 5 }));
    expect(zeroMasowe(oferty)).toBe(wynik);
  });

// „Wyślij zera” ważne tylko w przełączeniu stanów, w którym je kliknięto.
describe('potwierdzenie zer E4.30p', () => {
  const zPotwierdzeniem = przelaczenieId => ({ wyslanePola: { zeraPotwierdzone: { login: 'operator', at: '2026-11-14T12:00:30Z',
    ...(przelaczenieId === undefined ? {} : { przelaczenieId }) } } });
  it.each([
    ['to samo przełączenie', 4, migawka(), false],
    ['inne przełączenie', 3, migawka(), true],
    ['flaga bez przelaczenieId (sprzed E4.30p)', undefined, migawka(), true],
    ['przelaczenieId null', null, { ...migawka(), przelaczenieId: null }, true],
    ['stany wyłączone (migawka bez przelaczenieId)', 4, { wlaczone: false, przelaczenieId: null }, true],
    ['brak migawki', 4, null, true],
  ])('%s → liczy się do zera masowego: %s', (_opis, id, m, liczy) => {
    expect(liczySieDoZeraMasowego(zPotwierdzeniem(id), m)).toBe(liczy);
    expect(potwierdzenieZerWazne(zPotwierdzeniem(id), m)).toBe(!liczy);
  });
  it('oferta bez potwierdzenia zawsze się liczy', () => {
    expect(liczySieDoZeraMasowego({ wyslanePola: {} }, migawka())).toBe(true);
    expect(liczySieDoZeraMasowego(null, migawka())).toBe(true);
  });
});

describe('otwarcie D56', () => {
  const granica = '2026-11-14T10:00:00Z';
  const woo = { kanal: 'woo', manage_stock: true, odczyt: 4, odczytanoAt: '2026-11-14T10:20:00Z' };
  it('bierze minimum i pokazuje różnicę Woo', () => {
    const wynik = propozycjaOtwarcia({ granica, kanaly: [woo, { kanal: 'allegro', odczyt: 490 }, { kanal: 'erli', odczyt: 3 }] });
    expect(wynik.ilosc).toBe(3);
    expect(wynik.kanaly[0]).toMatchObject({ wartosc: 4, roznica: true });
  });
  it.each([['processing', 5], ['on-hold', 5], ['pending', 4], ['failed', 4], ['cancelled', 4]])(
    'Woo %s od granicy', (status, wynik) => {
      expect(propozycjaOtwarcia({ granica, kanaly: [{ ...woo, zamowienia: [
        { ilosc: 1, status, zlozonoAt: '2026-11-14T10:10:00Z' },
        { ilosc: 20, status: 'processing', zlozonoAt: '2026-11-14T09:59:00Z' },
        { ilosc: 30, status: 'processing', zlozonoAt: '2026-11-14T10:21:00Z' },
      ] }] }).ilosc).toBe(wynik);
    });
  it('pomija Woo bez stanów, parent i błędny odczyt', () => {
    expect(propozycjaOtwarcia({ granica, kanaly: [{ ...woo, manage_stock: false },
      { ...woo, manage_stock: 'parent' }, { kanal: 'erli', odczyt: null }] }).ilosc).toBeNull();
  });
  it('sprzedaż marketplace dolicza bez anulowań', () => {
    expect(propozycjaOtwarcia({ granica, kanaly: [{ ...woo, kanal: 'erli', zamowienia: [
      { ilosc: 2, zlozonoAt: '2026-11-14T10:10:00Z' },
      { ilosc: 3, anulowane: true, zlozonoAt: '2026-11-14T10:10:00Z' },
    ] }] }).ilosc).toBe(6);
  });
});

describe('skrót zatwierdzenia D51', () => {
  const dane = () => ({ oferty: [{ id: 1, karta_id: 1, tryb: 'zarzadzana' }], migawka: migawka(),
    maxRuchId: 5, bufory: [{ konto: 'polcien', bufor: 0 }], zamowienia: [] });
  it('pomija zamówienia i zmienny stan, uwzględnia nowy ruch', () => {
    const d = dane();
    expect(skrotZatwierdzenia({ ...d, zamowienia: [{ id: 2 }], migawka: { ...d.migawka, stany: new Map() } })).toBe(skrotZatwierdzenia(d));
    expect(skrotZatwierdzenia({ ...d, maxRuchId: 6 })).not.toBe(skrotZatwierdzenia(d));
  });
  it.each(['oferty', 'znane', 'otwarcia', 'bufory'])('zmiana %s unieważnia podpis', pole => {
    const d = dane(); const zmiana = dane();
    if (pole === 'oferty') zmiana.oferty = [];
    if (pole === 'znane') zmiana.migawka.znane = new Set([1, 2]);
    if (pole === 'otwarcia') zmiana.migawka.otwarcia.set(1, { ilosc: 1, zrodlo: 'reczne' });
    if (pole === 'bufory') zmiana.bufory[0].bufor = 1;
    expect(skrotZatwierdzenia(zmiana)).not.toBe(skrotZatwierdzenia(d));
  });
  it('kolejność zbiorów nie zmienia podpisu', () => {
    const a = dane(); const b = dane();
    a.migawka.znane = new Set([2, 1]); b.migawka.znane = new Set([1, 2]);
    expect(skrotZatwierdzenia(a)).toBe(skrotZatwierdzenia(b));
  });
});

it('D57: obniżki przed podwyżkami, stabilna kolejność kont, bez mutacji wejścia', () => {
  const a = { konto: 'a', cel: 3, odczyt: 1 }; const b = { konto: 'a', cel: 3, odczyt: 5 };
  const c = { konto: 'b', cel: 1, odczyt: 2 }; const wejscie = [c, a, b];
  expect(kluczKomendyIlosci(b)).toBe('ilosc:3:obnizka');
  expect(kluczKomendyIlosci(a)).toBe('ilosc:3:podwyzka');
  expect(kolejnoscWysylek(wejscie)).toEqual([b, a, c]);
  expect(wejscie).toEqual([c, a, b]);
});

it('wspólny katalog problemów podaje kod, tekst i decyzję o wstrzymaniu', () => {
  const blokady = ['skok', 'rozjazd-dol', 'rozjazd-gora', 'zero-masowe', 'stan-rodzica',
    'bez-stanu-w-sklepie', 'ujemny-stan', 'ilosc-niezmienialna', 'zamrozona-ilosc', 'brak-karty'];
  const informacje = ['brak-stanu', 'stany-niezatwierdzone', 'stany-wylaczone', 'brak-pollera', 'karencja'];
  for (const kod of [...blokady, ...informacje]) {
    expect(PROBLEMY_ILOSCI[kod]).toEqual({ kod, wstrzymuje: blokady.includes(kod),
      od: null, cel: null, odczyt: null, tekst: expect.any(String) });
  }
});
