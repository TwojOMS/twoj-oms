import { afterEach, describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { otworzBaze } from '../../src/core/baza.ts';
import { zbudujAplikacje } from '../../src/core/aplikacja.ts';
import { modulRdzen } from '../../src/moduly/rdzen/modul.ts';
import type { ModulOms } from '../../src/core/kontrakty.ts';

const env = { OMS_SPRZEDAWCA_NIP: '1234563218', OMS_RACHUNEK: '34109010140000000000000000' };
const teraz = () => new Date('2026-10-01T10:00:00Z');
const bazy: ReturnType<typeof otworzBaze>[] = [];
const aplikacje: FastifyInstance[] = [];
afterEach(async () => {
  for (const app of aplikacje.splice(0)) await app.close();
  for (const db of bazy.splice(0)) db.close();
});
const baza = () => { const db = otworzBaze(':memory:'); bazy.push(db); return db; };
const rdzen = modulRdzen as ModulOms;
const echo: ModulOms<{ powitanie: string }> = {
  nazwa: 'echo', wersja: '1.0.0', wymaga: ['rdzen'],
  konfiguracja: (e) => ({ powitanie: e.ECHO_POWITANIE ?? 'dzień dobry' }),
  migracje: [], uprawnienia: [], menu: [],
  zbuduj: (ctx) => ({
    uslugi: { powitaj: () => ctx.konfiguracja.powitanie },
    trasy: (app) => { app.get('/echo', async () => ({ tekst: ctx.usluga<(() => string) | null>('echo', 'powitaj')?.() ?? 'wyłączona' })); },
  }),
};
const buduj = async (o: Parameters<typeof zbudujAplikacje>[0]) => {
  const wynik = await zbudujAplikacje(o); aplikacje.push(wynik.app); return wynik;
};

describe('zbudujAplikacje', () => {
  it('buduje zależności przed konsumentem, składa konfigurację, usługę i gotową trasę', async () => {
    const konsument: ModulOms = { ...echo as ModulOms, nazwa: 'konsument', wymaga: ['echo'], zbuduj: (ctx) => ({
      uslugi: { tekst: ctx.usluga<() => string>('echo', 'powitaj')() },
    }) };
    const wynik = await buduj({ moduly: [konsument, echo as ModulOms, rdzen], env: { ...env, ECHO_POWITANIE: 'cześć' }, db: baza() });
    expect(wynik.usluga('konsument', 'tekst')).toBe('cześć');
    const r = await wynik.app.inject({ method: 'GET', url: '/echo' });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ tekst: 'cześć' });
    expect(wynik.usluga('rdzen', 'sprzedawca')).toEqual({ nip: '1234563218', rachunek: '34109010140000000000000000', bdo: null, bank: null });
  });
  it.each([['funkcja', () => 'z testu', 'z testu'], ['null', null, 'wyłączona']] as const)('nadpisanie %s zastępuje usługę', async (_, nadpisanie, tekst) => {
    const wynik = await buduj({ moduly: [rdzen, echo as ModulOms], env, db: baza(), nadpisania: { 'echo.powitaj': nadpisanie } });
    expect((await wynik.app.inject('/echo')).json()).toEqual({ tekst });
  });
  it('brak usługi rzuca błąd zamiast udawać wyłączoną integrację', async () => {
    const wynik = await buduj({ moduly: [rdzen], env, db: baza() });
    expect(() => wynik.usluga('rdzen', 'brak')).toThrow('rdzen.brak');
    expect(() => wynik.usluga('brak', 'sprzedawca')).toThrow('brak.sprzedawca');
  });
  it('zbiera błędy wszystkich modułów i zatrzymuje się przed migracjami/budową', async () => {
    const db = baza(); let budow = 0;
    const zly: ModulOms = { ...echo as ModulOms, nazwa: 'zly', konfiguracja: () => { throw new Error('Brak wymaganej zmiennej: ZLY_KLUCZ'); },
      migracje: [{ numer: 1, nazwa: 'sonda', wykonaj: (d) => d.exec('CREATE TABLE sonda(id INTEGER)') }],
      zbuduj: () => { budow++; return {}; } };
    // PRZ-102.20: brak OMS_RACHUNEK nie jest już błędem startu (rachunek można wpisać w panelu) — zły rachunek nadal jest.
    // PRZ-108.10: brak OMS_SPRZEDAWCA_NIP też nie jest już błędem startu (NIP w panelu) — zły NIP nadal jest.
    await expect(zbudujAplikacje({ moduly: [rdzen, zly], env: { OMS_SPRZEDAWCA_NIP: '1234563219', OMS_RACHUNEK: '34109010140000000000000001' }, db }))
      .rejects.toThrow(/OMS_SPRZEDAWCA_NIP[\s\S]*OMS_RACHUNEK[\s\S]*ZLY_KLUCZ/);
    expect(budow).toBe(0);
    expect(db.prepare('SELECT * FROM migracje').all()).toEqual([]);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()).toEqual([{ name: 'migracje' }]);
  });
  it('blokada próby działa przed konfiguracją, migracjami i budową modułów', async () => {
    const db = baza(); let konfiguracji = 0; let budow = 0;
    const integracja: ModulOms = { ...echo as ModulOms, kluczeIntegracji: ['INFAKT_API_KEY'],
      konfiguracja: () => { konfiguracji++; return {}; }, zbuduj: () => { budow++; return {}; } };
    await expect(zbudujAplikacje({ moduly: [rdzen, integracja], env: { ...env, OMS_TRYB: 'proba', INFAKT_API_KEY: 'syntetyczny' }, db }))
      .rejects.toThrow('INFAKT_API_KEY');
    expect(konfiguracji).toBe(0); expect(budow).toBe(0);
    expect(db.prepare('SELECT * FROM migracje').all()).toEqual([]);
  });
  it('agreguje zdrowie, zegary oraz sortuje menu niezależnie od listy modułów', async () => {
    const zegar = { nazwa: 'sonda', odstepMs: 1000, przebieg: async () => {} };
    const a: ModulOms = { ...echo as ModulOms, nazwa: 'a', uprawnienia: [{ klucz: 'a', etykieta: 'A', role: [] }],
      menu: [{ dzial: 'A', etykieta: 'A', adres: '/a', uprawnienie: 'a', kolejnosc: 20 }],
      zbuduj: () => ({ zdrowie: () => ({ alarmy: ['alarm-a'], uwagi: [] }), zegary: [zegar] }) };
    const b: ModulOms = { ...echo as ModulOms, nazwa: 'b', uprawnienia: [{ klucz: 'b', etykieta: 'B', role: [] }],
      menu: [{ dzial: 'B', etykieta: 'B', adres: '/b', uprawnienie: 'b', kolejnosc: 10 }],
      zbuduj: () => ({ zdrowie: () => ({ alarmy: [], uwagi: ['uwaga-b'] }) }) };
    const wynik = await buduj({ moduly: [rdzen, a, b], env, db: baza() });
    expect(wynik.menu.map((p) => p.adres)).toEqual(['/b', '/a']);
    expect(wynik.zdrowie()).toEqual({ alarmy: ['alarm-a'], uwagi: ['uwaga-b'] });
    expect(wynik.zegary).toEqual([zegar]);
  });
  it('start z odtworzonej starej bazy zachowuje ptaszki i oznacza 17 kluczy rdzen/2', async () => {
    const db = baza();
    db.exec(readFileSync(new URL('../../src/moduly/rdzen/migracje/0001-baseline.sql', import.meta.url), 'utf8'));
    db.exec(`INSERT INTO konta (id, login, imie, hash_hasla, rola, utworzone_at) VALUES
      (1, 'ola', 'Ola', 'x', 'sprzedaz', '2026-09-01'), (2, 'jan', 'Jan', 'x', 'produkcja', '2026-09-01');
      INSERT INTO uprawnienia (konto_id, ekran) VALUES (1, 'zamowienia'), (2, 'magazyn')`);
    const ekran: ModulOms = { ...echo as ModulOms, nazwa: 'ekran', zbuduj: () => ({}),
      uprawnienia: [{ klucz: 'zamowienia', etykieta: 'Zamówienia', role: ['sprzedaz', 'produkcja'] }] };
    await buduj({ moduly: [ekran, rdzen], env, db, teraz });
    expect(db.prepare('SELECT konto_id, ekran FROM uprawnienia ORDER BY konto_id').all())
      .toEqual([{ konto_id: 1, ekran: 'zamowienia' }, { konto_id: 2, ekran: 'magazyn' }]);
    expect(db.prepare('SELECT klucz FROM uprawnienia_rozdane ORDER BY klucz').all().map((r) => r.klucz)).toEqual([
      'cele', 'faktury', 'faktury-zamowienia', 'finanse', 'kampania', 'klienci', 'koszty', 'magazyn', 'okresy',
      'pozostale-dokumenty-zamowienia', 'przesylki', 'raporty', 'statystyki', 'ustawienia', 'wiadomosci', 'zamowienia', 'zwroty-zamowienia',
    ]);
    expect(db.prepare("SELECT numer FROM migracje WHERE modul = 'rdzen' ORDER BY numer").all()).toEqual([{ numer: 1 }, { numer: 2 }, { numer: 3 }, { numer: 4 }, { numer: 5 }, { numer: 6 }, { numer: 7 }]);
    db.exec("DELETE FROM uprawnienia WHERE ekran = 'zamowienia'");
    await buduj({ moduly: [rdzen, ekran], env, db, teraz });
    expect(db.prepare('SELECT konto_id, ekran FROM uprawnienia').all()).toEqual([{ konto_id: 2, ekran: 'magazyn' }]);
  });
});
