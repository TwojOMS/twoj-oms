import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { znormalizujKlienta, daneNabywcyNaKarcie } from '../../../src/domena/klient-staly.js';
import { dopiszKlienta, zapiszKlienta, klientPoId, klientPoKluczu, wgrajUmowyZbiorczeZKonfiguracji } from '../../../src/oms/db/klienci.js';

let db;
beforeEach(() => { db = openOmsDb(':memory:'); });
afterEach(() => db.close());
const dane = (nad = {}) => znormalizujKlienta({ nazwa: 'Pracownia Półcień', ...nad });
const dodaj = (nad = {}) => klientPoId(db, dopiszKlienta(db, dane(nad)));

describe('PRZ-160 P2.04 — stabilny klucz klienta', () => {
  it('ignoruje klucz żądania, także niepoprawny, i działa bez tego pola', () => {
    expect(dane({ klucz: '!!!' }).klucz).toBe('pracownia-polcien');
    expect(dodaj().klucz).toBe('pracownia-polcien');
  });

  it('także bez normalizacji w bazie wyprowadza klucz z nazwy', () => {
    const id = dopiszKlienta(db, { ...dane(), klucz: 'obcy' });
    expect(klientPoId(db, id).klucz).toBe('pracownia-polcien');
  });

  it('kolizje dostają kolejne wolne przyrostki -2 i -3', () => {
    expect([dodaj().klucz, dodaj().klucz, dodaj().klucz]).toEqual([
      'pracownia-polcien', 'pracownia-polcien-2', 'pracownia-polcien-3',
    ]);
  });

  it('przyrostek mieści się w limicie 32 znaków i omija zajęte klucze', () => {
    const nazwa = 'a'.repeat(40);
    expect(dodaj({ nazwa }).klucz).toBe('a'.repeat(32));
    expect(dodaj({ nazwa }).klucz).toBe(`${'a'.repeat(30)}-2`);
    expect(dodaj({ nazwa }).klucz).toBe(`${'a'.repeat(30)}-3`);
  });

  it('nazwa bez liter i cyfr dostaje klient-<id>, a jedna litera działa', () => {
    const k = dodaj({ nazwa: '!!!', klucz: 'podany' });
    expect(k.klucz).toBe(`klient-${k.id}`);
    expect(dodaj({ nazwa: 'A' }).klucz).toBe('a');
    const drugi = dodaj({ nazwa: '!!!' });
    expect(drugi.klucz).toBe(`klient-${drugi.id}`);
  });

  it('zastępczy klucz także omija kolizję ze zwykłą nazwą', () => {
    dodaj({ nazwa: 'Klient 2' });
    const k = dodaj({ nazwa: '!!!' });
    expect(k.id).toBe(2);
    expect(k.klucz).toBe('klient-2-2');
  });

  it('błąd końcowego zapisu klucza wycofuje cały INSERT', () => {
    db.exec(`CREATE TRIGGER odmowa_klucza BEFORE UPDATE OF klucz ON klienci
      BEGIN SELECT RAISE(ABORT, 'odmowa testowa'); END`);
    expect(() => dodaj({ nazwa: '!!!' })).toThrow('odmowa testowa');
    expect(db.prepare('SELECT count(*) AS ile FROM klienci').get().ile).toBe(0);
  });

  it('edycja nazwy i podanego klucza zachowuje stary klucz i powiązanie okresu', () => {
    const k = dodaj();
    db.prepare(`INSERT INTO okresy_rozliczeniowe (klient_klucz, rok, miesiac, utworzony_at)
      VALUES (?, 2026, 11, '2026-11-13')`).run(k.klucz);
    zapiszKlienta(db, k.id, dane({ nazwa: 'Nowa nazwa', klucz: 'nowy-klucz' }));
    expect(klientPoId(db, k.id)).toMatchObject({ klucz: k.klucz, nazwa: 'Nowa nazwa' });
    const okres = db.prepare('SELECT klient_klucz FROM okresy_rozliczeniowe').get();
    expect(klientPoKluczu(db, okres.klient_klucz)?.id).toBe(k.id);
    zapiszKlienta(db, k.id, { ...klientPoId(db, k.id), klucz: 'z-zadania' });
    expect(klientPoId(db, k.id).klucz).toBe(k.klucz);
  });

  it('Zapamiętaj klienta i import umów zachowują istniejący klucz', () => {
    const k = dodaj({ nip: '1234500028' });
    zapiszKlienta(db, k.id, daneNabywcyNaKarcie(k, { nazwa: 'Inna', klucz: 'inny', faktura: { firma: 'Inna' } }));
    wgrajUmowyZbiorczeZKonfiguracji(db, { OMS_KLIENCI_ZBIORCZY: 'inny:Inna:1234500028:0:0:0:0' });
    expect(klientPoId(db, k.id).klucz).toBe(k.klucz);
    expect(klientPoId(db, k.id).rozliczenie_zbiorcze).toBe(1);
  });

  it('historyczny klucz niezależny od nazwy zostaje także bez klucza w edycji', () => {
    const k = dodaj();
    db.prepare('UPDATE klienci SET klucz = ? WHERE id = ?').run('dawny-klucz', k.id);
    const { klucz, ...bezKlucza } = dane({ nazwa: '!!!' });
    zapiszKlienta(db, k.id, bezKlucza);
    expect(klientPoId(db, k.id).klucz).toBe('dawny-klucz');
  });

  it('INSERT z kluczem zastępczym nie zatwierdza transakcji wywołującego', () => {
    db.exec('BEGIN IMMEDIATE');
    const k = dodaj({ nazwa: '!!!' });
    expect(k.klucz).toBe(`klient-${k.id}`);
    expect(db.isTransaction).toBe(true);
    db.exec('ROLLBACK');
    expect(klientPoId(db, k.id)).toBeNull();
  });

  it('kolizja NIP-u nadal odmawia i nie dodaje klienta', () => {
    dodaj({ nip: '1234500028' });
    expect(() => dodaj({ nip: '1234500028' })).toThrow(/ma już w bazie innego klienta/);
    expect(db.prepare('SELECT count(*) AS ile FROM klienci').get().ile).toBe(1);
  });
});
