import { describe, it, expect } from 'vitest';
import {
  cenaObowiazujaca,
  cenaPrzyszla,
  kwotaZakupuZNapisu,
  dzienZNapisu,
  dzienPolski,
  wpisZFormularza,
  wpisZbedny,
  zrodloCenyZakupu,
} from '../../src/domena/cena-zakupu.js';

const W = (obowiazuje_od, cena_netto_gr) => ({ obowiazuje_od, cena_netto_gr });
const PAZDZIERNIK = W('2026-10-01', 1100);
const LISTOPAD = W('2026-11-05', 1230);
const GRUDZIEN = W('2026-12-01', 1310);

describe('cenaObowiazujaca — wpis o największej dacie „od” nie późniejszej niż dzień', () => {
  it('pusta historia albo same przyszłe wpisy → brak ceny', () => {
    expect(cenaObowiazujaca([], '2026-11-18')).toBe(null);
    expect(cenaObowiazujaca(undefined, '2026-11-18')).toBe(null);
    expect(cenaObowiazujaca([GRUDZIEN], '2026-11-18')).toBe(null);
  });

  it('w dniu zmiany obowiązuje już nowa cena, dzień wcześniej jeszcze stara', () => {
    const h = [PAZDZIERNIK, LISTOPAD];
    expect(cenaObowiazujaca(h, '2026-11-05')).toBe(LISTOPAD);
    expect(cenaObowiazujaca(h, '2026-11-04')).toBe(PAZDZIERNIK);
    expect(cenaObowiazujaca([LISTOPAD], '2026-11-05')).toBe(LISTOPAD);
    expect(cenaObowiazujaca([LISTOPAD], '2026-11-04')).toBe(null);
  });

  it('przeszłość i zapowiedziana podwyżka: dziś liczy się ostatnia przeszła cena', () => {
    const h = [PAZDZIERNIK, LISTOPAD, GRUDZIEN];
    expect(cenaObowiazujaca(h, '2026-11-01')).toBe(PAZDZIERNIK);
    expect(cenaObowiazujaca(h, '2026-11-18')).toBe(LISTOPAD);
    expect(cenaObowiazujaca(h, '2027-01-01')).toBe(GRUDZIEN);
  });

  it('kolejność wejścia nie ma znaczenia', () => {
    expect(cenaObowiazujaca([GRUDZIEN, PAZDZIERNIK, LISTOPAD], '2026-11-18')).toBe(LISTOPAD);
    expect(cenaObowiazujaca([LISTOPAD, GRUDZIEN, PAZDZIERNIK], '2026-11-01')).toBe(PAZDZIERNIK);
  });
});

describe('cenaPrzyszla — najbliższy wpis po dniu', () => {
  it('bierze najbliższą przyszłą cenę, nie najdalszą', () => {
    const styczen = W('2027-01-01', 1400);
    expect(cenaPrzyszla([styczen, LISTOPAD, GRUDZIEN], '2026-11-18')).toBe(GRUDZIEN);
    expect(cenaPrzyszla([styczen, LISTOPAD, GRUDZIEN], '2026-12-01')).toBe(styczen);
    expect(cenaPrzyszla([PAZDZIERNIK, LISTOPAD], '2026-11-18')).toBe(null);
    expect(cenaPrzyszla([], '2026-11-18')).toBe(null);
  });
});

describe('kwotaZakupuZNapisu — złote z formularza na grosze', () => {
  it.each([
    ['12,30', 1230],
    ['12.3', 1230],
    ['0', 0],
    [' 7 ', 700],
    ['1,05', 105],
    ['2.67', 267],
    ['10000000,00', 1_000_000_000],
  ])('%j → %i gr', (napis, gr) => {
    expect(kwotaZakupuZNapisu(napis)).toEqual({ gr });
  });

  it.each([
    '12,345',
    '-1',
    '1e3',
    '12,30 zł',
    '',
    '   ',
    '10000000,01',
    '99999999999999999999',
    '90071992547410',
    '12,',
    ',5',
    '1 230',
    '12,3,4',
  ])('%j → odmowa z komunikatem', (napis) => {
    const wynik = kwotaZakupuZNapisu(napis);
    expect(wynik.gr).toBeUndefined();
    expect(wynik.blad).toMatch(/\S/);
  });

  it('wartość, która nie jest napisem (pole przysłane dwa razy) → odmowa', () => {
    expect(kwotaZakupuZNapisu(['12,30', '13,10']).blad).toMatch(/\S/);
    expect(kwotaZakupuZNapisu(1230).blad).toMatch(/\S/);
    expect(kwotaZakupuZNapisu(undefined).blad).toMatch(/\S/);
  });
});

describe('dzienZNapisu — data „obowiązuje od”', () => {
  it('prawdziwa data RRRR-MM-DD w zakresie 2000–2099', () => {
    expect(dzienZNapisu('2026-11-05')).toEqual({ dzien: '2026-11-05' });
    expect(dzienZNapisu(' 2024-02-29 ')).toEqual({ dzien: '2024-02-29' });
    expect(dzienZNapisu('2000-01-01')).toEqual({ dzien: '2000-01-01' });
    expect(dzienZNapisu('2099-12-31')).toEqual({ dzien: '2099-12-31' });
  });

  it.each(['2026-02-30', '2025-02-29', '2026-13-01', '05.11.2026', '1999-12-31', '2100-01-01', '0202-11-05', ''])(
    '%j → odmowa',
    (napis) => {
      const wynik = dzienZNapisu(napis);
      expect(wynik.dzien).toBeUndefined();
      expect(wynik.blad).toMatch(/\S/);
    },
  );

  it('wartość, która nie jest napisem → odmowa', () => {
    expect(dzienZNapisu(['2026-11-05', '2026-11-06']).blad).toMatch(/\S/);
  });
});

it('dzienPolski pisze dzień po polsku bez przeliczania strefy', () => {
  expect(dzienPolski('2026-11-05')).toBe('05.11.2026');
  expect(dzienPolski('2099-01-01')).toBe('01.01.2099');
});

it('wzorzec dnia odrzuca miesiąc 13 i dzień 32 już na wzorcu (dzienPolski nie liczy kalendarza)', () => {
  expect(dzienPolski('2026-13-05')).toBe('');
  expect(dzienPolski('2026-01-32')).toBe('');
  expect(dzienPolski('2026-00-10')).toBe('');
  expect(dzienPolski('2026-10-00')).toBe('');
  expect(dzienPolski('2026-12-31')).toBe('31.12.2026');
});

it('zrodloCenyZakupu: „karta” i „edycja hurtem”; nieznane źródło zostaje, jak przyszło', () => {
  expect(zrodloCenyZakupu('karta')).toBe('karta');
  expect(zrodloCenyZakupu('hurt')).toBe('edycja hurtem');
  expect(zrodloCenyZakupu('import')).toBe('import');
  expect(zrodloCenyZakupu(null)).toBe('—');
});

describe('wpisZFormularza — co z pól karty idzie do historii', () => {
  const DZIS = '2026-11-18';

  it('pusta cena znaczy „nie zmieniaj”, także gdy data jest wpisana', () => {
    expect(wpisZFormularza({}, DZIS)).toEqual({ wpis: null, blad: null });
    expect(wpisZFormularza({ cena_zakupu_netto: '', cena_zakupu_od: '2026-12-01' }, DZIS)).toEqual({
      wpis: null,
      blad: null,
    });
    expect(wpisZFormularza({ cena_zakupu_netto: '  ', cena_zakupu_od: '' }, DZIS)).toEqual({ wpis: null, blad: null });
  });

  it('cena bez daty obowiązuje od dziś; z datą — od tej daty', () => {
    expect(wpisZFormularza({ cena_zakupu_netto: '12,30', cena_zakupu_od: '' }, DZIS)).toEqual({
      wpis: { gr: 1230, od: DZIS },
      blad: null,
    });
    expect(wpisZFormularza({ cena_zakupu_netto: '12,30' }, DZIS)).toEqual({ wpis: { gr: 1230, od: DZIS }, blad: null });
    expect(wpisZFormularza({ cena_zakupu_netto: '13,10', cena_zakupu_od: '2026-12-01' }, DZIS)).toEqual({
      wpis: { gr: 1310, od: '2026-12-01' },
      blad: null,
    });
  });

  it('zła kwota albo zła data → błąd, bez wpisu', () => {
    const zlaKwota = wpisZFormularza({ cena_zakupu_netto: '12,345', cena_zakupu_od: '' }, DZIS);
    expect(zlaKwota.wpis).toBe(null);
    expect(zlaKwota.blad).toMatch(/cena zakupu/i);
    const zlaData = wpisZFormularza({ cena_zakupu_netto: '12,30', cena_zakupu_od: '2026-02-30' }, DZIS);
    expect(zlaData.wpis).toBe(null);
    expect(zlaData.blad).toMatch(/obowiązuje od/i);
  });

  it('pole przysłane dwa razy → błąd', () => {
    expect(wpisZFormularza({ cena_zakupu_netto: ['12,30', '13,10'] }, DZIS).blad).toMatch(/\S/);
    expect(wpisZFormularza({ cena_zakupu_netto: '12,30', cena_zakupu_od: [DZIS, DZIS] }, DZIS).blad).toMatch(/\S/);
    expect(wpisZFormularza({ cena_zakupu_netto: ['', ''] }, DZIS).blad).toMatch(/\S/);
  });
});

describe('wpisZbedny — zapis, który niczego by nie zmienił', () => {
  it('ta sama kwota co obowiązująca w dniu „od” → zbędny; inna kwota albo brak ceny → potrzebny', () => {
    const h = [PAZDZIERNIK, LISTOPAD, GRUDZIEN];
    expect(wpisZbedny(h, { gr: 1230, od: '2026-11-18' })).toBe(true);
    expect(wpisZbedny(h, { gr: 1230, od: '2026-11-05' })).toBe(true);
    expect(wpisZbedny(h, { gr: 1310, od: '2026-11-18' })).toBe(false);
    expect(wpisZbedny(h, { gr: 1230, od: '2026-12-01' })).toBe(false);
    expect(wpisZbedny(h, { gr: 1100, od: '2026-11-05' })).toBe(false);
    expect(wpisZbedny([], { gr: 0, od: '2026-11-18' })).toBe(false);
    expect(wpisZbedny([GRUDZIEN], { gr: 1310, od: '2026-11-18' })).toBe(false);
  });
});
