import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { modulRdzen } from '../../../src/moduly/rdzen/modul.ts';
import { skrotKlucza } from '../../../src/domena/klucze-api.js';
import { zalozKluczApi, kluczPoSkrocie, odwolajKluczApi, listaKluczyApi, odnotujUzycie,
  dopiszDoDziennikaApi, wyczyscDziennikApi } from '../../../src/core/bezpieczenstwo/klucze-api.js';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
const teraz = '2026-11-06T10:00:00.000Z';
let db;
const zaloz = (dane = {}) => zalozKluczApi(db, {
  nazwa: 'integracja testowa', zakresy: ['druk'], kontoId: null, teraz, ...dane,
});
beforeEach(() => {
  db = new DatabaseSync(':memory:');
  for (const migracja of modulRdzen.migracje) migracja.wykonaj(db);
});
afterEach(() => db.close());

describe('zapytania kluczy API na migracjach rdzenia', () => {
  it('zapisuje tylko skrót, daty i uporządkowane zakresy, a zwraca klucz raz', () => {
    const wynik = zaloz({ nazwa: ' integracja testowa ', zakresy: ['druk', 'produkty:odczyt'], wygasaAt: '2027-01-01T00:00:00.000Z' });
    expect(Object.keys(wynik).sort()).toEqual(['id', 'klucz', 'prefiks']);
    const wiersz = db.prepare('SELECT * FROM klucze_api').get();
    expect(JSON.stringify(wiersz)).not.toContain(wynik.klucz);
    expect(wiersz.skrot).toBe(skrotKlucza(wynik.klucz));
    expect(wiersz.skrot).not.toBe(wynik.klucz);
    expect(wiersz).toMatchObject({ id: wynik.id, nazwa: 'integracja testowa', prefiks: wynik.prefiks,
      utworzony_at: teraz, wygasa_at: '2027-01-01T00:00:00.000Z', odwolany_at: null });
    expect(JSON.parse(wiersz.zakresy)).toEqual(['produkty:odczyt', 'druk']);
    expect(kluczPoSkrocie(db, wiersz.skrot).zakresy).toEqual(['produkty:odczyt', 'druk']);
    expect(kluczPoSkrocie(db, 'nieznany')).toBeNull();
  });
  it('odrzuca pustą nazwę i niepoprawne zakresy bez zapisu', () => {
    for (const nazwa of ['', ' \r\n\t ']) expect(() => zaloz({ nazwa })).toThrow(Error);
    for (const zakresy of [[], ['admin'], ['druk', 'druk'], null, 'druk']) {
      expect(() => zaloz({ zakresy })).toThrow(Error);
    }
    expect(listaKluczyApi(db)).toEqual([]);
  });
  it('odwołuje istniejący klucz, zachowuje pierwszą datę i zgłasza brak zmiany', () => {
    const { id, klucz } = zaloz();
    expect(odwolajKluczApi(db, id, teraz)).toBe(true);
    expect(kluczPoSkrocie(db, skrotKlucza(klucz)).odwolany_at).toBe(teraz);
    expect(odwolajKluczApi(db, id, '2026-11-07T00:00:00.000Z')).toBe(false);
    expect(kluczPoSkrocie(db, skrotKlucza(klucz)).odwolany_at).toBe(teraz);
    expect(odwolajKluczApi(db, id + 1, teraz)).toBe(false);
  });
  it('lista nie ujawnia skrótu; wyłączenie lub usunięcie konta nie odwołuje klucza', () => {
    const kontoId = Number(db.prepare(`INSERT INTO konta
      (login, imie, hash_hasla, rola, utworzone_at) VALUES (?,?,?,?,?)`)
      .run('tester', 'Osoba testowa', 'test', 'admin', teraz).lastInsertRowid);
    const { id, klucz } = zaloz({ kontoId });
    const sprawdz = (login, czynne) => {
      const w = listaKluczyApi(db).find(w => w.id === id);
      expect(w).not.toHaveProperty('skrot');
      expect(w).toMatchObject({ utworzyl_login: login, utworzyl_czynne: czynne, zakresy: ['druk'] });
      expect(kluczPoSkrocie(db, skrotKlucza(klucz)).odwolany_at).toBeNull();
    };
    sprawdz('tester', 1);
    db.prepare('UPDATE konta SET czynne = 0 WHERE id = ?').run(kontoId);
    sprawdz('tester', 0);
    db.prepare('DELETE FROM konta WHERE id = ?').run(kontoId);
    sprawdz(null, null);
    zaloz();
    expect(listaKluczyApi(db)[1]).toMatchObject({ utworzyl_login: null, utworzyl_czynne: null });
  });
  it('odnotowuje ostatnie użycie i IP bez zmiany innych kluczy', () => {
    const { id } = zaloz();
    const drugi = zaloz();
    odnotujUzycie(db, id, { teraz, ip: '192.0.2.1' });
    expect(listaKluczyApi(db).find(w => w.id === id)).toMatchObject({ ostatnio_uzyty_at: teraz, ostatnie_ip: '192.0.2.1' });
    expect(listaKluczyApi(db).find(w => w.id === drugi.id).ostatnio_uzyty_at).toBeNull();
  });
  it('zapisuje znane i nieznane klucze w dzienniku, usuwa tylko wpisy starsze od granicy', () => {
    const { id, prefiks } = zaloz();
    const wpis = { kluczId: id, prefiks, at: teraz, metoda: 'GET', sciezka: '/api/v1/ja', status: 200, ip: '192.0.2.1' };
    dopiszDoDziennikaApi(db, { ...wpis, at: '2026-11-05T00:00:00.000Z' });
    dopiszDoDziennikaApi(db, wpis);
    dopiszDoDziennikaApi(db, { ...wpis, kluczId: null, prefiks: null, at: '2026-11-07T00:00:00.000Z', status: 401, ip: null });
    wyczyscDziennikApi(db, { starszeNiz: teraz });
    expect(db.prepare('SELECT * FROM klucze_api_dziennik ORDER BY id').all()).toEqual([
      { id: 2, klucz_id: id, prefiks, at: teraz, metoda: 'GET', sciezka: '/api/v1/ja', status: 200, ip: '192.0.2.1' },
      { id: 3, klucz_id: null, prefiks: null, at: '2026-11-07T00:00:00.000Z', metoda: 'GET', sciezka: '/api/v1/ja', status: 401, ip: null },
    ]);
  });
  it('schemat pilnuje unikalności prefiksu i skrótu oraz ma indeks dziennika po dacie', () => {
    const wstaw = db.prepare(`INSERT INTO klucze_api (nazwa, prefiks, skrot, zakresy, utworzony_at)
      VALUES (?, ?, ?, '["druk"]', '2026-11-06T00:00:00.000Z')`);
    wstaw.run('Pierwszy', 'abcd1234', 'a'.repeat(64));
    expect(() => wstaw.run('Ten sam prefiks', 'abcd1234', 'b'.repeat(64))).toThrow(/UNIQUE/);
    expect(() => wstaw.run('Ten sam skrót', 'efgh5678', 'a'.repeat(64))).toThrow(/UNIQUE/);
    const indeksy = db.prepare("PRAGMA index_list('klucze_api_dziennik')").all().map(w => w.name);
    expect(indeksy).toContain('idx_klucze_api_dziennik_at');
  });
});
