import { beforeAll, afterAll, describe, it, expect, vi } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { modulyDla } from '../../../src/moduly/lista.ts';
import { ENV_DEMO, wygenerujDaneDemo } from '../../../scripts/demo-dane.mjs';
import { wczytajRaporty } from '../../../src/moduly/raporty/konfiguracja.ts';
import * as statystyki from '../../../src/domena/statystyki-okresu.js';
import { sprzedazWOkresie, zwrotyWOkresie } from '../../../src/domena/sprzedaz-okresu.js';
import * as sprzedaz from '../../../src/domena/sprzedaz-okresu.js';
import * as rachunek from '../../../src/domena/rachunek-zarzadczy.js';
import { dzienWarszawa, fmtDataCzas, fmtDataCzasKrotko } from '../../../src/domena/format-daty.js';
import { OKNO_ZAMOWIEN } from '../../../src/oms/db/okno-zamowien.js';
import { rozkladUslug, terminowosc } from '../../../src/domena/statystyki-wysylki.js';
import { rozkladMetod } from '../../../src/domena/statystyki-platnosci.js';
import { zamowieniaOkresu as stareZamowienia, pierwszyDzienZamowien as staryPierwszy } from '../../pomoc/skala-referencja/statystyki-okresu.js';
import { sprzedazWOkresie as staraSprzedaz, zwrotyWOkresie as stareZwroty } from '../../pomoc/skala-referencja/sprzedaz-okresu.js';
import { terminowosc as staraTerminowosc } from '../../pomoc/skala-referencja/statystyki-wysylki.js';
import { rachunekOkresu as staryRachunek } from '../../pomoc/skala-referencja/rachunek-zarzadczy.js';

let db;
const { regulySprzedazy: reguly } = wczytajRaporty(ENV_DEMO);
const okresy = [
  { od: '2026-08-01', do: '2026-08-01' },
  { od: '2026-08-01', do: '2026-08-31' },
  { od: '2025-10-19', do: '2026-10-18' },
  { od: '2024-01-01', do: '2026-12-31' },
  { od: '2025-03-29', do: '2025-03-31' },
  { od: '2025-10-25', do: '2025-10-27' },
];
beforeAll(() => {
  db = openOmsDb(':memory:', { moduly: modulyDla(ENV_DEMO) });
  wygenerujDaneDemo(db, { dzis: '2026-10-18', env: ENV_DEMO });
  db.prepare('UPDATE granice_historii SET do_dnia = ?').run('2023-12-31');
  const dodaj = db.prepare(`INSERT INTO zamowienia
    (sklep, zrodlo_id, numer, utworzone_at, wyslane_at, kwota_brutto, pobranie, anulowane, klient_json, surowe_json)
    VALUES ('reczne', ?, ?, ?, ?, '100.00', 1, ?, ?, ?)`);
  db.exec('BEGIN');
  for (let i = 0; i < 2400; i++) {
    const data = new Date(Date.UTC(2024, 0, 1) + (i % 1020) * 86400000).toISOString();
    dodaj.run(900000 + i, `SKALA-${i}`, data, i % 7 ? data : null, i % 13 === 0 ? 1 : 0,
      JSON.stringify({ email: 'klient@example.invalid' }), JSON.stringify({ pad: 'x'.repeat(4096) }));
  }
  for (const [i, data] of ['2026-07-31T22:30:00Z', '2026-08-01 00:15:00',
    '2025-03-29T23:30:00Z', '2025-03-30T01:30:00Z', '2025-10-26T00:30:00Z',
    '2025-10-26T01:30:00Z', '2024-01-01T23:10:00Z', '2024-01-01 23:30:00',
    '2026-08-01T00:15:00+0200'].entries()) {
    dodaj.run(990000 + i, `GRANICA-${i}`, data, data, 0, '{}', '{}');
  }
  db.exec('COMMIT');
});
afterAll(() => db.close());

// Mierzymy rzeczywiście zwrócone wiersze, nie sam napis SQL. Odczyty dzieci też idą przez tę bazę.
function liczOdczyty() {
  let wierszy = 0;
  let najwiekszaPorcja = 0;
  let surowe = false;
  const baza = { prepare(sql) {
    const s = db.prepare(sql);
    if (!/FROM zamowienia\b/i.test(sql)) return s;
    return new Proxy(s, { get(t, k) {
      if (k === 'iterate') return function* (...p) {
        for (const w of t.iterate(...p)) { wierszy += 1; yield w; }
      };
      if (k === 'all') return (...p) => {
        const w = t.all(...p);
        wierszy += w.length;
        najwiekszaPorcja = Math.max(najwiekszaPorcja, w.length);
        surowe ||= w.some(z => Object.hasOwn(z, 'surowe_json'));
        return w;
      };
      const v = Reflect.get(t, k);
      return typeof v === 'function' ? v.bind(t) : v;
    } });
  } };
  return { baza, wynik: () => ({ wierszy, najwiekszaPorcja, surowe }) };
}

describe('PRZ-094.13 — skala bez zmiany liczb', () => {
  it('statystyki nie czytają całej tabeli dla jednego miesiąca ani surowego JSON', () => {
    const p = liczOdczyty();
    statystyki.zamowieniaOkresu(p.baza, okresy[1], reguly);
    expect(p.wynik().wierszy).toBeLessThan(500);
    expect(p.wynik().surowe).toBe(false);
  });
  it('sprzedaż nie czyta całej tabeli dla jednego miesiąca', () => {
    const p = liczOdczyty();
    sprzedazWOkresie(p.baza, okresy[1], reguly);
    expect(p.wynik().wierszy).toBeLessThan(500);
  });
  it('sprzedaż i finanse mają te same wyniki, oddając sterowanie między porcjami', async () => {
    expect(typeof sprzedaz.sprzedazWOkresieAsync).toBe('function');
    expect(typeof rachunek.rachunekOkresuAsync).toBe('function');
    let oddal = false;
    setImmediate(() => { oddal = true; });
    expect(await sprzedaz.sprzedazWOkresieAsync(db, okresy[3], reguly))
      .toEqual(staraSprzedaz(db, okresy[3], reguly));
    expect(oddal).toBe(true);
    const zakres = { od: '2026-01-01', do: '2026-10-18' };
    const opcje = { regulySprzedazy: reguly, podlogaKosztow: '2024-01' };
    oddal = false;
    setImmediate(() => { oddal = true; });
    expect(await rachunek.rachunekOkresuAsync(db, zakres, opcje))
      .toEqual(staryRachunek(db, zakres, opcje));
    expect(rachunek.rachunekOkresu(db, zakres, opcje)).toEqual(staryRachunek(db, zakres, opcje));
    expect(oddal).toBe(true);
  });
  it('sprzedaż oddaje sterowanie również przy całej historii anulowanej', async () => {
    db.exec('SAVEPOINT anulowane; UPDATE zamowienia SET anulowane = 1, anulowane_recznie = 1');
    let oddal = false;
    setImmediate(() => { oddal = true; });
    try {
      expect(await sprzedaz.sprzedazWOkresieAsync(db, okresy[3], reguly)).toEqual([]);
      expect(oddal).toBe(true);
    } finally { db.exec('ROLLBACK TO anulowane; RELEASE anulowane'); }
  });
  for (const okres of okresy) it(`równoważność ${okres.od} — ${okres.do}`, async () => {
    const stare = stareZamowienia(db, okres, reguly);
    const nowe = statystyki.zamowieniaOkresu(db, okres, reguly);
    expect(nowe.map(z => z.id)).toEqual(stare.map(z => z.id));
    expect(rozkladUslug(nowe)).toEqual(rozkladUslug(stare));
    expect(terminowosc(nowe)).toEqual(staraTerminowosc(stare));
    expect(rozkladMetod(nowe)).toEqual(rozkladMetod(stare));
    expect(sprzedazWOkresie(db, okres, reguly)).toEqual(staraSprzedaz(db, okres, reguly));
    expect(zwrotyWOkresie(db, okres, reguly)).toEqual(stareZwroty(db, okres, reguly));
    expect(typeof statystyki.statystykiWOkresie).toBe('function');
    expect(await statystyki.statystykiWOkresie(db, okres, reguly)).toEqual({
      uslugi: rozkladUslug(stare), termin: staraTerminowosc(stare), platnosci: rozkladMetod(stare),
    });
  });
  it('cały okres agreguje porcjami do 500 i oddaje sterowanie pętli zdarzeń', async () => {
    expect(typeof statystyki.statystykiWOkresie).toBe('function');
    const p = liczOdczyty();
    let oddalSterowanie = false;
    setImmediate(() => { oddalSterowanie = true; });
    const wynik = await statystyki.statystykiWOkresie(p.baza, okresy[3], reguly);
    expect(wynik.uslugi.suma).toBeGreaterThan(2000);
    expect(p.wynik().najwiekszaPorcja).toBeLessThanOrEqual(500);
    expect(p.wynik().surowe).toBe(false);
    expect(oddalSterowanie).toBe(true);
  });
  it('pierwszy dzień nie skanuje historii i zachowuje lokalny dzień przy mieszanych strefach', () => {
    const p = liczOdczyty();
    expect(statystyki.pierwszyDzienZamowien(p.baza)).toBe(staryPierwszy(db));
    expect(p.wynik().wierszy).toBeLessThan(30);
  });
  it('plan okna i MIN używa istniejącego indeksu, także dla dat nierozumianych przez SQLite', () => {
    for (const [sql, p] of [
      [`SELECT id FROM zamowienia WHERE ${OKNO_ZAMOWIEN} ORDER BY id`, ['2026-08-01', '2026-08-31']],
      ['SELECT MIN(julianday(utworzone_at)) FROM zamowienia', []],
    ]) {
      const plan = db.prepare('EXPLAIN QUERY PLAN ' + sql).all(...p).map(w => w.detail).join('\n');
      expect(plan).toContain('zamowienia_julianday_utworzenia');
      expect(plan).not.toMatch(/SCAN zamowienia/);
    }
  });
  it('MIN nie myli dnia UTC z lokalnym i obsługuje strefy bez dwukropka oraz pustą bazę', () => {
    const baza = openOmsDb(':memory:', { moduly: modulyDla(ENV_DEMO) });
    try {
      expect(statystyki.pierwszyDzienZamowien(baza)).toBeNull();
      const dodaj = baza.prepare("INSERT INTO zamowienia(sklep,zrodlo_id,numer,utworzone_at,kwota_brutto) VALUES ('reczne',?,?,?,'0.00')");
      dodaj.run(1, 'MIN-1', '2025-02-28T23:00:00Z');
      dodaj.run(2, 'MIN-2', '2025-02-28 23:30:00');
      expect(statystyki.pierwszyDzienZamowien(baza)).toBe('2025-02-28');
      dodaj.run(3, 'MIN-3', '2024-01-01T00:00:00+0100');
      expect(statystyki.pierwszyDzienZamowien(baza)).toBe('2024-01-01');
    } finally { baza.close(); }
  });
  it('formatowanie tej samej chwili korzysta z cache, które ma ograniczoną pojemność', () => {
    const spy = vi.spyOn(Intl.DateTimeFormat.prototype, 'formatToParts');
    const poczatek = Date.UTC(2044, 6, 1, 12);
    const data = new Date(poczatek).toISOString();
    try {
      expect(dzienWarszawa(data)).toBe('2044-07-01');
      expect(fmtDataCzas(data)).toBe('2044-07-01 14:00:00');
      expect(fmtDataCzasKrotko(data)).toBe('2044-07-01 14:00');
      expect(spy).toHaveBeenCalledTimes(1);
      for (let i = 1; i <= 4200; i++) fmtDataCzas(new Date(poczatek + i * 1000).toISOString());
      const przed = spy.mock.calls.length;
      expect(fmtDataCzas(data)).toBe('2044-07-01 14:00:00');
      expect(spy.mock.calls.length).toBe(przed + 1);
    } finally { spy.mockRestore(); }
  });
});
