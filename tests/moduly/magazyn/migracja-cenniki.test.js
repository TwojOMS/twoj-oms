import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { modulyDla } from '../../../src/moduly/lista.ts';
import { modulMagazyn } from '../../../src/moduly/magazyn/modul.ts';
import { migracjaCennikowDostaw } from '../../../src/moduly/magazyn/migracje/0003-cenniki-dostaw.ts';
import { ENV_DEMO, wygenerujDaneDemo } from '../../../scripts/demo-dane.mjs';
import { klienciKataloguDemo } from '../../../scripts/demo-dane-katalog.mjs';
import { odswiezMagazyn } from '../../../src/moduly/magazyn/services/magazyn-sync.js';
import { utworzKartyZNiepowiazanych } from '../../../src/oms/db/magazyn.js';
import { ustawieniaOfertKonta, zapiszUstawieniaOfertKonta } from '../../../src/oms/db/oferty-kanalow.ts';
import {
  wyjatekCennika,
  wyjatkiCennikowKarty,
  zapiszWyjatekCennika,
  usunWyjatekCennika,
} from '../../../src/oms/db/cenniki-kart.ts';
import { brakiUstawienOfert } from '../../../src/domena/erli-oferty-ustawienia.js';

// Migracja magazyn/0003: reguły cenników konta (cenniki_json) i wyjątki cennika na karcie.
// Wyłącznie dokładanie; stare pole cennik_dostaw staje się jedną regułą „wszystko”.
// Dane zmyślone: „Pracownia Półcień”, lampy LMP-*.

const KORZEN = fileURLToPath(new URL('../../../', import.meta.url));
const T0 = '2026-11-14T10:00:00.000Z';
const T1 = '2026-11-14T10:05:00.000Z';
const TERAZ = () => new Date(T0);
const REGULY = [{ doMm: [80, 380, 640], doG: 25000, cennik: 'Mała paczka' }, { cennik: 'Kurier gabaryt' }];

const katalogi = [];
const bazy = [];
afterEach(() => {
  for (const db of bazy.splice(0)) if (db.isOpen) db.close();
  for (const k of katalogi.splice(0)) rmSync(k, { recursive: true, force: true });
});

function nowyPlik() {
  const k = mkdtempSync(join(tmpdir(), 'oms-prz160-e3d02-'));
  katalogi.push(k);
  return join(k, 'oms.sqlite');
}
const bez0003 = (moduly) =>
  moduly.map((m) => (m.nazwa === 'magazyn' ? { ...m, migracje: m.migracje.filter((x) => x.numer !== 3) } : m));
const kolumny = (db, t) =>
  db
    .prepare(`PRAGMA table_info(${t})`)
    .all()
    .map((k) => k.name);
const tabele = (db) =>
  db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all()
    .map((w) => w.name);
const schemat = (db) =>
  db.prepare("SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all();

function odcisk(db, lista) {
  const wynik = {};
  for (const t of lista) {
    const wiersze = db
      .prepare(`SELECT * FROM "${t}"`)
      .all()
      .map((w) => JSON.stringify(Object.entries(w).filter(([k]) => k !== 'cenniki_json')))
      .sort();
    wynik[t] = { kolumny: kolumny(db, t).filter((k) => k !== 'cenniki_json'), wiersze };
  }
  return wynik;
}

function bazaPamieci(moduly = modulyDla(ENV_DEMO)) {
  const db = openOmsDb(':memory:', { moduly, teraz: TERAZ });
  bazy.push(db);
  const karta = db.prepare(
    'INSERT INTO karty_produktow (id, sku, nazwa, utworzony_at, zmieniony_at) VALUES (?, ?, ?, ?, ?)',
  );
  karta.run(501, 'LMP-501', 'Lampa Półcień mała', T0, T0);
  karta.run(502, 'LMP-502', 'Lampa Półcień duża', T0, T0);
  return db;
}

const wstawUstawienia = (db, klucz, cennik) =>
  db
    .prepare(
      `INSERT INTO oferty_ustawienia_kont
  (klucz, oferty_czynne, narzut_bp, stala_ilosc, cennik_dostaw, zmieniono_at) VALUES (?, 1, 0, 5, ?, ?)`,
    )
    .run(klucz, cennik, T0);

describe('migracja magazyn/0003 — cenniki dostaw', () => {
  it('moduł magazynu niesie migrację numer 3', () => {
    expect(modulMagazyn.migracje).toContain(migracjaCennikowDostaw);
    expect(migracjaCennikowDostaw.numer).toBe(3);
  });

  it('baza demo: dane i schemat bez zmian, stary cennik staje się jedną regułą „wszystko”', async () => {
    const plik = nowyPlik();
    const stare = bez0003(modulyDla(ENV_DEMO));
    let db = openOmsDb(plik, { moduly: stare, teraz: TERAZ });
    wygenerujDaneDemo(db, { dzis: '2026-11-13', env: ENV_DEMO });
    const { sklepy, allegro, kanalySklepow, kanalyAllegro } = klienciKataloguDemo();
    const teraz = () => '2026-11-13T04:00:00.000Z';
    await odswiezMagazyn({ db, sklepy, allegro, teraz, kanalySklepow, kanalyAllegro, log: () => {} });
    utworzKartyZNiepowiazanych(db, { teraz, kanalySklepow });
    db.prepare("DELETE FROM oferty_ustawienia_kont WHERE klucz IN ('allegro_polcien', 'erli_polcien')").run();
    wstawUstawienia(db, 'allegro_polcien', 'cennik-7');
    wstawUstawienia(db, 'erli_polcien', null);
    db.close();
    db = openOmsDb(plik, { moduly: stare, teraz: TERAZ });
    const stareTabele = tabele(db).filter((t) => t !== 'migracje');
    expect(stareTabele).not.toContain('karty_cenniki_kont');
    expect(kolumny(db, 'oferty_ustawienia_kont')).not.toContain('cenniki_json');
    const przed = odcisk(db, stareTabele);
    const schematPrzed = schemat(db).filter((w) => w.name !== 'migracje' && w.name !== 'oferty_ustawienia_kont');
    db.close();

    db = openOmsDb(plik, { moduly: modulyDla(ENV_DEMO), teraz: TERAZ });
    bazy.push(db);
    expect(odcisk(db, stareTabele)).toEqual(przed);
    expect(schemat(db).filter((w) => schematPrzed.some((p) => p.name === w.name))).toEqual(schematPrzed);
    expect(tabele(db)).toContain('karty_cenniki_kont');
    expect(db.prepare('SELECT count(*) n FROM karty_cenniki_kont').get().n).toBe(0);
    expect(db.prepare("SELECT numer FROM migracje WHERE modul = 'magazyn' AND numer = 3").get()).toEqual({ numer: 3 });
    const json = (k) => db.prepare('SELECT cenniki_json j FROM oferty_ustawienia_kont WHERE klucz = ?').get(k).j;
    expect(JSON.parse(json('allegro_polcien'))).toEqual([{ cennik: 'cennik-7' }]);
    expect(json('erli_polcien')).toBeNull();
    expect(ustawieniaOfertKonta(db, 'allegro_polcien')).toMatchObject({
      cennikDostaw: 'cennik-7',
      cenniki: [{ cennik: 'cennik-7' }],
    });
    expect(ustawieniaOfertKonta(db, 'erli_polcien')).toMatchObject({ cennikDostaw: null, cenniki: [] });
  });

  it('instalacja bez Allegro i ERLI: te same wiersze i te same braki ustawień po migracji', () => {
    const plik = nowyPlik();
    const stare = bez0003(modulyDla(ENV_DEMO));
    let db = openOmsDb(plik, { moduly: stare, teraz: TERAZ });
    db.prepare('DELETE FROM oferty_ustawienia_kont').run();
    const tabelePrzed = tabele(db).filter((t) => t !== 'migracje');
    const przed = odcisk(db, tabelePrzed);
    const brakiPrzed = brakiUstawienOfert(ustawieniaOfertKonta(db, 'erli_brak'), 'erli');
    db.close();
    db = openOmsDb(plik, { moduly: modulyDla(ENV_DEMO), teraz: TERAZ });
    bazy.push(db);
    expect(odcisk(db, tabelePrzed)).toEqual(przed);
    expect(db.prepare('SELECT count(*) n FROM oferty_ustawienia_kont').get().n).toBe(0);
    expect(brakiUstawienOfert(ustawieniaOfertKonta(db, 'erli_brak'), 'erli')).toEqual(brakiPrzed);
  });

  it('drugie uruchomienie nie zmienia schematu ani danych — także reguł zapisanych po migracji', () => {
    const db = bazaPamieci();
    wstawUstawienia(db, 'allegro_polcien', 'cennik-stary');
    migracjaCennikowDostaw.wykonaj(db);
    // Konto przeszło na reguły rozmiaru; stara kolumna została z dawną wartością.
    zapiszUstawieniaOfertKonta(db, 'allegro_polcien', { cenniki: REGULY }, { teraz: T1 });
    zapiszWyjatekCennika(db, { kartaId: 501, konto: 'allegro_polcien', cennik: 'Kurier gabaryt' }, { teraz: T1 });
    const przed = [
      schemat(db),
      odcisk(db, tabele(db)),
      db.prepare('SELECT klucz, cenniki_json FROM oferty_ustawienia_kont').all(),
    ];
    migracjaCennikowDostaw.wykonaj(db);
    migracjaCennikowDostaw.wykonaj(db);
    expect([
      schemat(db),
      odcisk(db, tabele(db)),
      db.prepare('SELECT klucz, cenniki_json FROM oferty_ustawienia_kont').all(),
    ]).toEqual(przed);
    expect(ustawieniaOfertKonta(db, 'allegro_polcien').cenniki).toEqual(REGULY);
  });

  it('strażnik migracji zielony', () => {
    expect(execFileSync(process.execPath, ['scripts/straznik-migracji.mjs'], { cwd: KORZEN, encoding: 'utf8' })).toBe(
      '',
    );
  });
});

describe('ustawienia konta — cenniki i alias cennikDostaw (D4)', () => {
  it('zapis cenników sprawdza reguły; poprawne wracają przy odczycie', () => {
    const db = bazaPamieci();
    expect(() =>
      zapiszUstawieniaOfertKonta(
        db,
        'erli_polcien',
        { cenniki: [{ doMm: [1, 2, 3], doG: 5, cennik: 'A' }] },
        { teraz: T0 },
      ),
    ).toThrow(/większych/);
    expect(ustawieniaOfertKonta(db, 'erli_polcien').cenniki).toEqual([]);
    zapiszUstawieniaOfertKonta(db, 'erli_polcien', { cenniki: REGULY }, { teraz: T0 });
    expect(ustawieniaOfertKonta(db, 'erli_polcien')).toMatchObject({ cenniki: REGULY, cennikDostaw: null });
  });

  it('alias: zapis cennikDostaw ustawia jedną regułę „wszystko”, null czyści', () => {
    const db = bazaPamieci();
    zapiszUstawieniaOfertKonta(db, 'erli_polcien', { cenniki: REGULY }, { teraz: T0 });
    zapiszUstawieniaOfertKonta(db, 'erli_polcien', { cennikDostaw: 'Lampy' }, { teraz: T1 });
    expect(ustawieniaOfertKonta(db, 'erli_polcien')).toMatchObject({
      cennikDostaw: 'Lampy',
      cenniki: [{ cennik: 'Lampy' }],
    });
    zapiszUstawieniaOfertKonta(db, 'erli_polcien', { cennikDostaw: null }, { teraz: T1 });
    expect(ustawieniaOfertKonta(db, 'erli_polcien')).toMatchObject({ cennikDostaw: null, cenniki: [] });
    expect(() =>
      zapiszUstawieniaOfertKonta(db, 'erli_polcien', { cennikDostaw: 'X', cenniki: REGULY }, { teraz: T1 }),
    ).toThrow();
  });

  it('baza bez migracji 0003: stary cennik czyta się jako jedna reguła, zapis aliasu działa', () => {
    const db = bazaPamieci(bez0003(modulyDla(ENV_DEMO)));
    expect(kolumny(db, 'oferty_ustawienia_kont')).not.toContain('cenniki_json');
    zapiszUstawieniaOfertKonta(db, 'allegro_polcien', { cennikDostaw: 'Cennik Półcień' }, { teraz: T0 });
    expect(ustawieniaOfertKonta(db, 'allegro_polcien')).toMatchObject({
      cennikDostaw: 'Cennik Półcień',
      cenniki: [{ cennik: 'Cennik Półcień' }],
    });
  });
});

describe('karty_cenniki_kont — wyjątek cennika na karcie per konto', () => {
  it('zapis, odczyt, nadpisanie, usunięcie; znika z kartą', () => {
    const db = bazaPamieci();
    expect(wyjatekCennika(db, { kartaId: 501, konto: 'allegro_polcien' })).toBeNull();
    zapiszWyjatekCennika(
      db,
      { kartaId: 501, konto: 'allegro_polcien', cennik: ' Kurier gabaryt ' },
      { teraz: T0, aktor: 'administrator' },
    );
    zapiszWyjatekCennika(db, { kartaId: 501, konto: 'erli_polcien', cennik: 'Mała paczka' }, { teraz: T0 });
    zapiszWyjatekCennika(db, { kartaId: 501, konto: 'erli_polcien', cennik: 'Średnia paczka' }, { teraz: T1 });
    expect(wyjatekCennika(db, { kartaId: 501, konto: 'allegro_polcien' })).toBe('Kurier gabaryt');
    expect(wyjatkiCennikowKarty(db, 501)).toEqual([
      { konto: 'allegro_polcien', cennik: 'Kurier gabaryt', zmienionoAt: T0, aktor: 'administrator' },
      { konto: 'erli_polcien', cennik: 'Średnia paczka', zmienionoAt: T1, aktor: null },
    ]);
    expect(() =>
      zapiszWyjatekCennika(db, { kartaId: 501, konto: 'erli_polcien', cennik: '  ' }, { teraz: T1 }),
    ).toThrow();
    expect(usunWyjatekCennika(db, { kartaId: 501, konto: 'erli_polcien' })).toBe(1);
    expect(usunWyjatekCennika(db, { kartaId: 501, konto: 'erli_polcien' })).toBe(0);
    db.prepare('DELETE FROM karty_produktow WHERE id = 501').run();
    expect(db.prepare('SELECT count(*) n FROM karty_cenniki_kont').get().n).toBe(0);
  });

  it('pusty cennik albo konto odrzuca sama tabela', () => {
    const db = bazaPamieci();
    const wstaw = (konto, cennik) =>
      db
        .prepare(
          `INSERT INTO karty_cenniki_kont (karta_id, konto, cennik, zmieniono_at)
      VALUES (502, ?, ?, ?)`,
        )
        .run(konto, cennik, T0);
    expect(() => wstaw('allegro_polcien', ' ')).toThrow(/CHECK/);
    expect(() => wstaw(' ', 'A')).toThrow(/CHECK/);
    expect(() => wstaw('allegro_polcien', 'A')).not.toThrow();
    expect(() => wstaw('allegro_polcien', 'B')).toThrow(/UNIQUE|PRIMARY/);
  });

  it('bez migracji 0003 wyjątku nie ma, odczyt nie wybucha', () => {
    const db = new DatabaseSync(':memory:');
    bazy.push(db);
    expect(wyjatekCennika(db, { kartaId: 501, konto: 'allegro_polcien' })).toBeNull();
    expect(wyjatkiCennikowKarty(db, 501)).toEqual([]);
  });
});
