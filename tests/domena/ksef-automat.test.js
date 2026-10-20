// PRZ-102.12 — reguły automatu wysyłki do KSeF: pora przebiegu (czas Warszawy, zmiana czasu), jedna próba
// na dzień, okno miesięcy, formularz ustawień. Czyste funkcje, czas podawany wprost — zero zegara systemowego.
import { describe, it, expect } from 'vitest';
import {
  chwilaWarszawy, czyPoraPrzebiegu, miesiaceAutomatu, sprawdzFormularzAutomatu, ostatniPrzebiegPoZapisie,
  najblizszyPrzebieg, GODZINA_DOMYSLNA, KTO_AUTOMAT,
} from '../../src/domena/ksef-automat.js';
import { doZaznaczeniaWszystkich } from '../../src/domena/wysylka-ksef.js';

const o = (iso) => chwilaWarszawy(new Date(iso));
const wl = (godzina, ostatniPrzebieg = null) => ({ wlaczony: true, godzina, ostatniPrzebieg });

describe('chwilaWarszawy', () => {
  it('przelicza UTC na dzień i godzinę w Warszawie (lato i zima, przełom roku)', () => {
    expect(o('2026-10-20T18:01:00Z')).toEqual({ dzien: '2026-10-20', godzina: '20:01' });
    expect(o('2026-12-31T23:30:00Z')).toEqual({ dzien: '2027-01-01', godzina: '00:30' });
    expect(o('2026-01-15T19:00:00Z')).toEqual({ dzien: '2026-01-15', godzina: '20:00' });
  });
});

describe('czyPoraPrzebiegu — ustawione 20:00', () => {
  it('wyłączony automat nie ma pory nigdy', () => {
    expect(czyPoraPrzebiegu({ wlaczony: false, godzina: '20:00', ostatniPrzebieg: null }, o('2026-10-20T18:01:00Z'))).toBe(false);
  });
  it('19:59 — jeszcze nie; 20:00 i 20:01 — tak', () => {
    expect(czyPoraPrzebiegu(wl('20:00'), o('2026-10-20T17:59:00Z'))).toBe(false);
    expect(czyPoraPrzebiegu(wl('20:00'), o('2026-10-20T18:00:00Z'))).toBe(true);
    expect(czyPoraPrzebiegu(wl('20:00'), o('2026-10-20T18:01:00Z'))).toBe(true);
  });
  it('dzisiejszy przebieg już był — nie ma drugiego; wczorajszy nie przeszkadza', () => {
    expect(czyPoraPrzebiegu(wl('20:00', '2026-10-20'), o('2026-10-20T21:00:00Z'))).toBe(false);
    expect(czyPoraPrzebiegu(wl('20:00', '2026-10-19'), o('2026-10-20T18:01:00Z'))).toBe(true);
  });
  it('po starcie panelu późnym wieczorem, bez dzisiejszego przebiegu — pora (nadrabia jedną próbę)', () => {
    expect(czyPoraPrzebiegu(wl('20:00', '2026-10-19'), o('2026-10-20T21:59:00Z'))).toBe(true);
  });
});

describe('czyPoraPrzebiegu — zmiana czasu', () => {
  it('niedziela 25.10.2026 (CEST→CET): 20:00 to 19:00 UTC, a nie 18:00', () => {
    expect(czyPoraPrzebiegu(wl('20:00'), o('2026-10-25T18:30:00Z'))).toBe(false); // 19:30 CET
    expect(czyPoraPrzebiegu(wl('20:00'), o('2026-10-25T19:01:00Z'))).toBe(true); // 20:01 CET
    expect(czyPoraPrzebiegu(wl('20:00'), o('2026-10-24T18:01:00Z'))).toBe(true); // 20:01 CEST dzień wcześniej
  });
  it('podwójna 02:30 w nocy zmiany czasu — po pierwszym przebiegu drugi już nie', () => {
    const pierwsza = o('2026-10-25T00:30:00Z'); // 02:30 CEST
    const druga = o('2026-10-25T01:30:00Z'); // 02:30 CET
    expect(pierwsza).toEqual({ dzien: '2026-10-25', godzina: '02:30' });
    expect(druga).toEqual({ dzien: '2026-10-25', godzina: '02:30' });
    expect(czyPoraPrzebiegu(wl('02:30'), o('2026-10-25T00:29:00Z'))).toBe(false);
    expect(czyPoraPrzebiegu(wl('02:30'), pierwsza)).toBe(true);
    expect(czyPoraPrzebiegu(wl('02:30', pierwsza.dzien), druga)).toBe(false);
  });
  it('brakująca 02:30 w nocy 28.03.2027 (CET→CEST) — przebieg o 03:00, nie przepada', () => {
    expect(czyPoraPrzebiegu(wl('02:30'), o('2027-03-28T00:59:00Z'))).toBe(false); // 01:59 CET
    expect(o('2027-03-28T01:00:00Z')).toEqual({ dzien: '2027-03-28', godzina: '03:00' });
    expect(czyPoraPrzebiegu(wl('02:30'), o('2027-03-28T01:00:00Z'))).toBe(true);
  });
});

describe('miesiaceAutomatu', () => {
  it('poprzedni i bieżący miesiąc — faktura z 31. nie przepada 1.', () => {
    expect(miesiaceAutomatu('2026-10-01')).toEqual(['2026-09', '2026-10']);
    expect(miesiaceAutomatu('2027-01-05')).toEqual(['2026-12', '2027-01']);
  });
});

describe('sprawdzFormularzAutomatu', () => {
  it('pole ukryte 0 i zaznaczone pole 1 przychodzą razem — rozstrzyga ostatnie', () => {
    expect(sprawdzFormularzAutomatu({ wlaczony: ['0', '1'], godzina: '20:00' })).toEqual({ wlaczony: true, godzina: '20:00', bledy: [] });
    expect(sprawdzFormularzAutomatu({ wlaczony: '0', godzina: '07:05' })).toEqual({ wlaczony: false, godzina: '07:05', bledy: [] });
    expect(sprawdzFormularzAutomatu({ wlaczony: '1', godzina: '00:00' }).bledy).toEqual([]);
    expect(sprawdzFormularzAutomatu({ wlaczony: '1', godzina: '23:45' }).bledy).toEqual([]);
  });
  // Poprawka po recenzji (drobne 3): przy 23:59 jedyne tyknięcie po godzinie mogło wypaść już po północy (pierwsze
  // tyknięcie 60 s po starcie, zegar dryfuje), a dzień przepadał. Najpóźniej 23:45 — zostaje 15 tyknięć do północy.
  it.each(['23:46', '23:59'])('godzina %s — za blisko północy, błąd z wyjaśnieniem', (godzina) => {
    expect(sprawdzFormularzAutomatu({ wlaczony: '1', godzina }).bledy[0]).toContain('23:45');
  });
  it('23:45 — tyknięcie o 23:59:30 jeszcze wysyła tego dnia', () => {
    expect(czyPoraPrzebiegu(wl('23:45'), o('2026-10-20T21:59:30Z'))).toBe(true);
  });
  it.each(['24:00', '7:00', '20:60', '', 'abc', '20:00:00', ' 20:00', undefined])('zła godzina %j — błąd', (godzina) => {
    expect(sprawdzFormularzAutomatu({ wlaczony: '1', godzina }).bledy).toHaveLength(1);
  });
  it.each([undefined, 'tak', '2', ['1', 'x']])('zła wartość przełącznika %j — błąd', (wlaczony) => {
    expect(sprawdzFormularzAutomatu({ wlaczony, godzina: '20:00' }).bledy).toHaveLength(1);
  });
});

describe('ostatniPrzebiegPoZapisie — włączenie po godzinie nie wysyła od razu', () => {
  const wylaczony = { wlaczony: false, godzina: GODZINA_DOMYSLNA, ostatniPrzebieg: '2026-10-18' };
  it('włączenie o 21:30 z godziną 20:00 — dziś bez przebiegu, pierwszy jutro', () => {
    expect(ostatniPrzebiegPoZapisie(wylaczony, { wlaczony: true, godzina: '20:00' }, o('2026-10-20T19:30:00Z'))).toBe('2026-10-20');
  });
  it('włączenie o 19:00 z godziną 20:00 — przebieg jeszcze dziś', () => {
    expect(ostatniPrzebiegPoZapisie(wylaczony, { wlaczony: true, godzina: '20:00' }, o('2026-10-20T17:00:00Z'))).toBe('2026-10-18');
  });
  it('przesunięcie godziny na już miniętą — dziś bez przebiegu', () => {
    const wlaczony = { wlaczony: true, godzina: '22:00', ostatniPrzebieg: '2026-10-19' };
    expect(ostatniPrzebiegPoZapisie(wlaczony, { wlaczony: true, godzina: '18:00' }, o('2026-10-20T17:00:00Z'))).toBe('2026-10-20');
  });
  it('ponowny zapis bez zmiany i wyłączenie nie ruszają dnia ostatniego przebiegu', () => {
    const wlaczony = { wlaczony: true, godzina: '20:00', ostatniPrzebieg: '2026-10-19' };
    expect(ostatniPrzebiegPoZapisie(wlaczony, { wlaczony: true, godzina: '20:00' }, o('2026-10-20T19:30:00Z'))).toBe('2026-10-19');
    expect(ostatniPrzebiegPoZapisie(wlaczony, { wlaczony: false, godzina: '20:00' }, o('2026-10-20T19:30:00Z'))).toBe('2026-10-19');
  });
});

describe('najblizszyPrzebieg', () => {
  it('opisuje, kiedy automat ruszy', () => {
    expect(najblizszyPrzebieg({ wlaczony: false, godzina: '20:00', ostatniPrzebieg: null }, o('2026-10-20T10:00:00Z'))).toBeNull();
    expect(najblizszyPrzebieg(wl('20:00'), o('2026-10-20T10:00:00Z'))).toBe('dziś o 20:00');
    expect(najblizszyPrzebieg(wl('20:00', '2026-10-20'), o('2026-10-20T19:00:00Z'))).toBe('jutro o 20:00');
    expect(najblizszyPrzebieg(wl('20:00', '2026-10-19'), o('2026-10-20T19:00:00Z'))).toBe('w ciągu minuty');
  });
});

describe('doZaznaczeniaWszystkich — ta sama reguła co pola wyboru na ekranie Faktur', () => {
  const vat = { rodzaj: 'vat', stanKsef: 'brak', client_tax_code: '1234563218' };
  it('faktura VAT z NIP-em (także UE) bez KSeF — tak; reszta — nie', () => {
    expect(doZaznaczeniaWszystkich(vat)).toBe(true);
    expect(doZaznaczeniaWszystkich({ ...vat, client_tax_code: 'SK1098765431' })).toBe(true);
    expect(doZaznaczeniaWszystkich({ ...vat, client_tax_code: '  ' })).toBe(false);
    expect(doZaznaczeniaWszystkich({ ...vat, rodzaj: 'korekta' })).toBe(false);
    expect(doZaznaczeniaWszystkich({ ...vat, stanKsef: 'jest' })).toBe(false);
    expect(doZaznaczeniaWszystkich({ ...vat, stanKsef: 'wyslana_czeka' })).toBe(false);
    expect(doZaznaczeniaWszystkich(null)).toBe(false);
  });
  it('operator w logu nazywa się „automat KSeF”', () => { expect(KTO_AUTOMAT).toBe('automat KSeF'); });
});
