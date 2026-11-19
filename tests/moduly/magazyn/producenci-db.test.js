import { afterEach, describe, expect, it } from 'vitest';
import { otworzBaze, wykonajMigracje } from '../../../src/core/baza.ts';
import { modulRdzen } from '../../../src/moduly/rdzen/modul.ts';
import { migracjaProducentow } from '../../../src/moduly/rdzen/migracje/0020-producenci.ts';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import {
  listaProducentow,
  producentPoId,
  dodajProducenta,
  zmienProducenta,
  usunProducenta,
  ustawDomyslnego,
  przypiszMarki,
  przypisaniaMarek,
} from '../../../src/oms/db/producenci.js';
import { utworzKarte } from '../../../src/oms/db/magazyn.js';

const AT = '2026-11-19T10:00:00.000Z';
const POLCIEN = {
  nazwa: 'Pracownia Półcień',
  adres: 'ul. Przykładowa 1, 00-001 Miasto',
  email: 'kontakt@polcien.invalid',
  www: '',
};
const WARSZTAT = {
  nazwa: 'Warsztat Przykładowy',
  adres: 'ul. Zmyślona 2, 00-002 Miasto',
  email: '',
  www: 'warsztat.example',
};

let db;
afterEach(() => {
  db?.close();
  db = null;
});
const baza = () => (db = openOmsDb(':memory:'));
const marka = (nazwa) => db.prepare('INSERT INTO marki (nazwa, utworzona_at) VALUES (?, ?)').run(nazwa, AT);
const wstawSurowo = (nazwa, { email = 'x@polcien.invalid', www = null, domyslny = 0 } = {}) =>
  db
    .prepare(
      `INSERT INTO producenci (nazwa, adres, email, www, domyslny, utworzono_at, zmieniono_at)
       VALUES (?, 'ul. Przykładowa 1', ?, ?, ?, ?, ?)`,
    )
    .run(nazwa, email, www, domyslny, AT, AT);

describe('migracja 0020 producenci', () => {
  it('na bazie z migracją 18 dokłada tabele, powtórzona niczego nie psuje', () => {
    db = otworzBaze(':memory:');
    wykonajMigracje(db, [{ ...modulRdzen, migracje: modulRdzen.migracje.filter((m) => m.numer <= 18) }]);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'producenci'").get()).toBeUndefined();
    db.prepare('INSERT INTO marki (nazwa, utworzona_at) VALUES (?, ?)').run('Półcień', AT);

    const wynik = wykonajMigracje(db, [modulRdzen]);
    expect(wynik.map((w) => [w.numer, w.tryb])).toContainEqual([20, 'wykonana']);
    expect(migracjaProducentow.numer).toBe(20);
    wstawSurowo('Pracownia Półcień', { domyslny: 1 });
    db.prepare('INSERT INTO marki_producenci (marka, producent_id, zmieniono_at) VALUES (?, 1, ?)').run('Półcień', AT);

    migracjaProducentow.wykonaj(db);
    expect(wykonajMigracje(db, [modulRdzen])).toEqual([]);
    expect(db.prepare('SELECT COUNT(*) AS ile FROM producenci').get().ile).toBe(1);
    expect(
      db
        .prepare('SELECT marka, producent_id FROM marki_producenci')
        .all()
        .map((w) => ({ ...w })),
    ).toEqual([{ marka: 'Półcień', producent_id: 1 }]);
  });

  it('CHECK: bez e-maila i www, pusta nazwa albo pusty adres — błąd bazy', () => {
    baza();
    expect(() => wstawSurowo('Bez kontaktu', { email: null, www: null })).toThrow(/CHECK/);
    expect(() => wstawSurowo('   ')).toThrow(/CHECK/);
    expect(() =>
      db
        .prepare(
          `INSERT INTO producenci (nazwa, adres, email, utworzono_at, zmieniono_at) VALUES ('X', ' ', 'x@a.invalid', ?, ?)`,
        )
        .run(AT, AT),
    ).toThrow(/CHECK/);
    expect(() => wstawSurowo('Zły znacznik', { domyslny: 2 })).toThrow(/CHECK/);
    expect(db.prepare('SELECT COUNT(*) AS ile FROM producenci').get().ile).toBe(0);
  });

  it('UNIQUE: dwa wiersze domyślne — błąd bazy', () => {
    baza();
    wstawSurowo('Pierwszy', { domyslny: 1 });
    wstawSurowo('Zwykły');
    wstawSurowo('Zwykły drugi');
    expect(() => wstawSurowo('Drugi domyślny', { domyslny: 1 })).toThrow(/UNIQUE/);
  });

  it('FK: usunięcie producenta przypisanego do marki — błąd bazy; przypisanie do nieistniejącego też', () => {
    baza();
    wstawSurowo('Pracownia Półcień');
    db.prepare('INSERT INTO marki_producenci (marka, producent_id, zmieniono_at) VALUES (?, 1, ?)').run('Półcień', AT);
    expect(() => db.prepare('DELETE FROM producenci WHERE id = 1').run()).toThrow(/FOREIGN KEY/);
    expect(() =>
      db.prepare('INSERT INTO marki_producenci (marka, producent_id, zmieniono_at) VALUES (?, 9, ?)').run('Inna', AT),
    ).toThrow(/FOREIGN KEY/);
  });
});

describe('warstwa bazy producentów', () => {
  it('dodaj i zmień: walidacja domeny przed zapisem, wartości po normalizacji', () => {
    baza();
    const bez = dodajProducenta(db, { ...POLCIEN, adres: ' ' }, { at: AT });
    expect(bez).toEqual({
      ok: false,
      bledy: { adres: 'Podaj adres pocztowy producenta' },
      wartosci: expect.any(Object),
    });
    expect(listaProducentow(db)).toEqual([]);

    const { ok, id } = dodajProducenta(db, WARSZTAT, { at: AT });
    expect(ok).toBe(true);
    expect(producentPoId(db, id)).toEqual({
      id,
      nazwa: 'Warsztat Przykładowy',
      adres: 'ul. Zmyślona 2, 00-002 Miasto',
      email: null,
      www: 'https://warsztat.example',
      domyslny: false,
      utworzono_at: AT,
      zmieniono_at: AT,
    });

    expect(zmienProducenta(db, id, { ...WARSZTAT, www: '' }, { at: AT }).bledy).toHaveProperty('email');
    expect(
      zmienProducenta(db, id, { ...WARSZTAT, email: 'biuro@warsztat.invalid' }, { at: '2026-11-20T08:00:00.000Z' }),
    ).toEqual({ ok: true });
    expect(producentPoId(db, id)).toMatchObject({
      email: 'biuro@warsztat.invalid',
      zmieniono_at: '2026-11-20T08:00:00.000Z',
    });
    expect(zmienProducenta(db, 999, WARSZTAT).blad).toBe('Nie ma takiego producenta.');
    expect(producentPoId(db, 999)).toBeNull();
  });

  it('lista: alfabetycznie, z markami i liczbą kart tych marek', () => {
    baza();
    const w = dodajProducenta(db, WARSZTAT, { at: AT }).id;
    const p = dodajProducenta(db, POLCIEN, { at: AT }).id;
    for (const m of ['Półcień', 'Półcień Mini', 'Bez producenta']) marka(m);
    utworzKarte(db, { sku: 'PP-1', nazwa: 'Lampa Półcień 1', marka: 'Półcień' });
    utworzKarte(db, { sku: 'PP-2', nazwa: 'Lampa Półcień 2', marka: 'Półcień Mini' });
    utworzKarte(db, { sku: 'PP-3', nazwa: 'Lampa Półcień 3', marka: 'Bez producenta' });
    expect(
      przypiszMarki(db, [
        { marka: 'Półcień Mini', producentId: p },
        { marka: 'Półcień', producentId: String(p) },
      ]),
    ).toEqual({ ok: true });
    expect(
      listaProducentow(db).map(({ id, nazwa, marki, karty, domyslny }) => ({ id, nazwa, marki, karty, domyslny })),
    ).toEqual([
      { id: p, nazwa: 'Pracownia Półcień', marki: ['Półcień', 'Półcień Mini'], karty: 2, domyslny: false },
      { id: w, nazwa: 'Warsztat Przykładowy', marki: [], karty: 0, domyslny: false },
    ]);
  });

  it('przypiszMarki: pusty producent zdejmuje przypisanie, marka spoza słownika albo nieznany producent — odmowa bez zapisu', () => {
    baza();
    const p = dodajProducenta(db, POLCIEN, { at: AT }).id;
    marka('Półcień');
    marka('Półcień Mini');
    przypiszMarki(db, [
      { marka: 'Półcień', producentId: p },
      { marka: 'Półcień Mini', producentId: p },
    ]);
    expect(przypisaniaMarek(db)).toEqual(
      new Map([
        ['Półcień', p],
        ['Półcień Mini', p],
      ]),
    );

    const spoza = przypiszMarki(db, [
      { marka: 'Półcień', producentId: '' },
      { marka: 'Nieznana', producentId: p },
    ]);
    expect(spoza.blad).toContain('Nieznana');
    expect(przypisaniaMarek(db).size).toBe(2);
    expect(przypiszMarki(db, [{ marka: 'Półcień', producentId: 77 }]).blad).toMatch(/producent/i);

    expect(
      przypiszMarki(db, [
        { marka: 'Półcień', producentId: '' },
        { marka: 'Półcień Mini', producentId: null },
      ]),
    ).toEqual({
      ok: true,
    });
    expect(przypisaniaMarek(db)).toEqual(new Map());
  });

  it('usunProducenta: odmowa z listą marek (komunikat, nie wyjątek SQL), bez marek usuwa', () => {
    baza();
    const p = dodajProducenta(db, POLCIEN, { at: AT }).id;
    marka('Półcień');
    marka('Półcień Mini');
    przypiszMarki(db, [
      { marka: 'Półcień Mini', producentId: p },
      { marka: 'Półcień', producentId: p },
    ]);
    expect(usunProducenta(db, p)).toEqual({
      blad: 'Nie można usunąć „Pracownia Półcień” — jest producentem marek: Półcień, Półcień Mini. Najpierw przypisz tym markom innego producenta.',
      marki: ['Półcień', 'Półcień Mini'],
    });
    przypiszMarki(db, [{ marka: 'Półcień Mini', producentId: '' }]);
    expect(usunProducenta(db, p).blad).toBe(
      'Nie można usunąć „Pracownia Półcień” — jest producentem marki: Półcień. Najpierw przypisz tej marce innego producenta.',
    );
    przypiszMarki(db, [{ marka: 'Półcień', producentId: '' }]);
    expect(usunProducenta(db, p)).toEqual({ ok: true });
    expect(producentPoId(db, p)).toBeNull();
    expect(usunProducenta(db, p).blad).toBe('Nie ma takiego producenta.');
  });

  it('domyślny: najwyżej jeden, zmiana w jednej transakcji, usunięcie domyślnego odmawia, null zdejmuje', () => {
    baza();
    const p = dodajProducenta(db, POLCIEN, { at: AT }).id;
    const w = dodajProducenta(db, WARSZTAT, { at: AT }).id;
    expect(ustawDomyslnego(db, p)).toEqual({ ok: true });
    expect(ustawDomyslnego(db, w)).toEqual({ ok: true });
    expect(
      listaProducentow(db)
        .filter((x) => x.domyslny)
        .map((x) => x.id),
    ).toEqual([w]);

    expect(ustawDomyslnego(db, 999).blad).toBe('Nie ma takiego producenta.');
    expect(producentPoId(db, w).domyslny).toBe(true);

    expect(usunProducenta(db, w)).toEqual({
      blad: 'Nie można usunąć „Warsztat Przykładowy” — to producent domyślny. Najpierw wskaż innego albo zdejmij oznaczenie.',
    });
    expect(ustawDomyslnego(db, null)).toEqual({ ok: true });
    expect(listaProducentow(db).some((x) => x.domyslny)).toBe(false);
    expect(usunProducenta(db, w)).toEqual({ ok: true });
  });
});
