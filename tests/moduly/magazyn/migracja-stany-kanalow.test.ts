import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DatabaseSync } from 'node:sqlite';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { modulyDla } from '../../../src/moduly/lista.ts';
import { modulMagazyn } from '../../../src/moduly/magazyn/modul.ts';
import { modulRdzen } from '../../../src/moduly/rdzen/modul.ts';
import { migracjaStanowKanalow } from '../../../src/moduly/magazyn/migracje/0004-stany-kanalow.ts';
import { migracjaStanowOtwarciaLustra } from '../../../src/moduly/rdzen/migracje/0017-stany-otwarcia-lustro.ts';
import { ENV_DEMO, wygenerujDaneDemo } from '../../../scripts/demo-dane.mjs';
import { klienciKataloguDemo } from '../../../scripts/demo-dane-katalog.mjs';
import { odswiezMagazyn } from '../../../src/moduly/magazyn/services/magazyn-sync.js';
import { utworzKartyZNiepowiazanych } from '../../../src/oms/db/magazyn.js';
import {
  wstawOferte,
  ofertaPoId,
  zmienOferte,
  ustawieniaOfertKonta,
  zapiszUstawieniaOfertKonta,
  zapiszZatwierdzenieStanow,
  zatwierdzenieStanow,
  zapiszPrzepiecie,
} from '../../../src/oms/db/oferty-kanalow.ts';

// Migracje magazyn/0004 (rejestr: flaga ilości z OMS, ślad wysyłki, ilość w toku, problem ilości,
// surowy odczyt; bufor i próg skoku konta; tabele zatwierdzeń D51 i przepięć D59) oraz rdzen/0017 (stany otwarcia
// Ilość kanału w lustrze D60). Wyłącznie dokładanie; domyślne wartości zachowują działanie przy wyłączonych stanach.
// Dane zmyślone: „Pracownia Półcień”, lampy LMP-*.

type W = Record<string, unknown>;
const KORZEN = fileURLToPath(new URL('../../../', import.meta.url));
const T0 = '2026-11-14T10:00:00.000Z';
const T1 = '2026-11-14T10:05:00.000Z';
const TERAZ = () => new Date(T0);

const NOWE_TABELE = ['stany_otwarcia', 'stany_zatwierdzenia', 'stany_przepiecia'];
const NOWE_KOLUMNY: Record<string, string[]> = {
  oferty_kanalow: [
    'ilosc_z_oms',
    'ilosc_wyslana_at',
    'stan_karty_wyslany',
    'ilosc_w_toku_json',
    'ilosc_problem_json',
    'odczyt_ilosc_kanalu',
  ],
  oferty_ustawienia_kont: ['bufor_szt', 'prog_skoku_szt'],
  produkty_sklepowe: ['ilosc_kanalu', 'stan_prowadzony', 'ilosc_odczytana_at'],
};

const katalogi: string[] = [];
const bazy: DatabaseSync[] = [];
afterEach(() => {
  for (const db of bazy.splice(0)) if (db.isOpen) db.close();
  for (const k of katalogi.splice(0)) rmSync(k, { recursive: true, force: true });
});

function nowyPlik() {
  const k = mkdtempSync(join(tmpdir(), 'oms-prz160-e401-'));
  katalogi.push(k);
  return join(k, 'oms.sqlite');
}
type Moduly = ReturnType<typeof modulyDla>;
// Instalacja sprzed E4: bez magazyn/4 i rdzen/17.
const sprzedE4 = (moduly: Moduly): Moduly =>
  moduly.map((m) => {
    if (m.nazwa === 'magazyn') return { ...m, migracje: m.migracje.filter((x) => x.numer !== 4) };
    if (m.nazwa === 'rdzen') return { ...m, migracje: m.migracje.filter((x) => x.numer !== 17) };
    return m;
  });
const wiersz = (db: DatabaseSync, sql: string, ...a: (string | number | null)[]) => db.prepare(sql).get(...a) as W;
const wiersze = (db: DatabaseSync, sql: string, ...a: (string | number | null)[]) => db.prepare(sql).all(...a) as W[];
const kolumny = (db: DatabaseSync, t: string) => wiersze(db, `PRAGMA table_info(${t})`).map((k) => String(k.name));
const tabele = (db: DatabaseSync) =>
  wiersze(db, "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").map((w) => String(w.name));
const schemat = (db: DatabaseSync) =>
  wiersze(db, "SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name");

// Odcisk: kolumny i zawartość każdej tabeli, bez kolumn dodanych przez E4.01.
function odcisk(db: DatabaseSync, lista: string[]) {
  const wynik: Record<string, { kolumny: string[]; wiersze: string[] }> = {};
  for (const t of lista) {
    const pomin = NOWE_KOLUMNY[t] ?? [];
    const w = wiersze(db, `SELECT * FROM "${t}"`)
      .map((r) => JSON.stringify(Object.entries(r).filter(([k]) => !pomin.includes(k))))
      .sort();
    wynik[t] = { kolumny: kolumny(db, t).filter((k) => !pomin.includes(k)), wiersze: w };
  }
  return wynik;
}

function bazaPamieci() {
  const db = openOmsDb(':memory:', { moduly: modulyDla(ENV_DEMO), teraz: TERAZ });
  bazy.push(db);
  const karta = db.prepare(
    'INSERT INTO karty_produktow (id, sku, nazwa, utworzony_at, zmieniony_at) VALUES (?, ?, ?, ?, ?)',
  );
  karta.run(501, 'LMP-501', 'Lampa Półcień mała', T0, T0);
  karta.run(502, 'LMP-502', 'Lampa Półcień duża', T0, T0);
  return db;
}

describe('migracje E4.01 — magazyn/0004 i rdzen/0017', () => {
  it('moduły niosą migracje: magazyn numer 4, rdzeń numer 17', () => {
    expect(modulMagazyn.migracje).toContain(migracjaStanowKanalow);
    expect(migracjaStanowKanalow.numer).toBe(4);
    expect(modulRdzen.migracje).toContain(migracjaStanowOtwarciaLustra);
    expect(migracjaStanowOtwarciaLustra.numer).toBe(17);
  });

  it('istniejące oferty bez zmian: baza demo przed i po migracji ma te same dane, nowe pola = zachowanie sprzed E4', async () => {
    const plik = nowyPlik();
    const stare = sprzedE4(modulyDla(ENV_DEMO));
    let db = openOmsDb(plik, { moduly: stare, teraz: TERAZ });
    wygenerujDaneDemo(db, { dzis: '2026-11-13', env: ENV_DEMO });
    const { sklepy, allegro, kanalySklepow, kanalyAllegro } = klienciKataloguDemo();
    const teraz = () => '2026-11-13T04:00:00.000Z';
    // Opcje przez zmienną: typy JSDoc obu funkcji nie znają jeszcze `kanalySklepow` i `kanalyAllegro`.
    const opcjeOdswiezenia = { db, sklepy, allegro, teraz, kanalySklepow, kanalyAllegro, log: () => {} };
    await odswiezMagazyn(opcjeOdswiezenia);
    const opcjeKart = { teraz, kanalySklepow };
    utworzKartyZNiepowiazanych(db, opcjeKart);
    const karty = wiersze(db, 'SELECT id FROM karty_produktow ORDER BY id LIMIT 2').map((w) => Number(w.id));
    const wstaw = db.prepare(`INSERT INTO oferty_kanalow (karta_id, kanal, id_zewnetrzne, pochodzenie, tryb, stan,
      wyslana_ilosc, odczyt_ilosc, utworzono_at, zmieniono_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    wstaw.run(karty[0], 'erli_polcien', 'QX7P2M-K1', 'oms', 'zarzadzana', 'aktywna', 4, 4, T0, T0);
    wstaw.run(karty[1], 'erli_polcien', 'QX7P2M-K2', 'przejeta', 'obserwowana', 'aktywna', null, 9, T0, T0);
    db.prepare(
      `INSERT INTO oferty_ustawienia_kont (klucz, oferty_czynne, narzut_bp, stala_ilosc, zmieniono_at)
      VALUES ('erli_polcien', 1, 1250, 5, ?)`,
    ).run(T0);
    db.prepare(
      `INSERT INTO magazyn_przelaczenia (wlaczone, konto_login, utworzono_at) VALUES (1, 'administrator', ?)`,
    ).run(T0);
    db.close();
    // Odcisk po ponownym otwarciu tą samą wersją — skutki samego otwarcia nie mieszają się z migracją.
    db = openOmsDb(plik, { moduly: stare, teraz: TERAZ });
    const stareTabele = tabele(db).filter((t) => t !== 'migracje');
    for (const t of NOWE_TABELE) expect(stareTabele).not.toContain(t);
    expect(wiersz(db, 'SELECT count(*) n FROM produkty_sklepowe').n).toBeGreaterThan(1);
    const przed = odcisk(db, stareTabele);
    const zmienione = Object.keys(NOWE_KOLUMNY);
    const schematPrzed = schemat(db).filter((w) => w.name !== 'migracje' && !zmienione.includes(String(w.name)));
    db.close();

    db = openOmsDb(plik, { moduly: modulyDla(ENV_DEMO), teraz: TERAZ });
    bazy.push(db);
    expect(odcisk(db, stareTabele)).toEqual(przed);
    expect(schemat(db).filter((w) => schematPrzed.some((p) => p.name === w.name))).toEqual(schematPrzed);
    for (const [t, k] of Object.entries(NOWE_KOLUMNY)) expect(kolumny(db, t)).toEqual(expect.arrayContaining(k));
    for (const t of NOWE_TABELE) expect(wiersz(db, `SELECT count(*) n FROM ${t}`).n).toBe(0);
    expect(
      wiersze(
        db,
        "SELECT modul, numer FROM migracje WHERE (modul = 'magazyn' AND numer = 4) OR (modul = 'rdzen' AND numer = 17) ORDER BY modul",
      ),
    ).toEqual([
      { modul: 'magazyn', numer: 4 },
      { modul: 'rdzen', numer: 17 },
    ]);

    // Zasada 1: żadna istniejąca oferta nie dostaje ilości z OMS, śladu wysyłki ani problemu ilości.
    expect(
      wiersze(
        db,
        `SELECT ilosc_z_oms, ilosc_wyslana_at, stan_karty_wyslany, ilosc_w_toku_json, ilosc_problem_json,
      odczyt_ilosc_kanalu FROM oferty_kanalow ORDER BY id`,
      ),
    ).toEqual(
      [0, 1].map(() => ({
        ilosc_z_oms: 0,
        ilosc_wyslana_at: null,
        stan_karty_wyslany: null,
        ilosc_w_toku_json: null,
        ilosc_problem_json: null,
        odczyt_ilosc_kanalu: null,
      })),
    );
    for (const o of wiersze(db, 'SELECT id FROM oferty_kanalow')) {
      expect(ofertaPoId(db, Number(o.id))).toMatchObject({
        iloscZOms: false,
        iloscWyslanaAt: null,
        stanKartyWyslany: null,
        iloscWToku: null,
        iloscProblem: null,
        odczytIloscKanalu: null,
      });
    }
    expect(
      wiersz(db, "SELECT bufor_szt, prog_skoku_szt FROM oferty_ustawienia_kont WHERE klucz = 'erli_polcien'"),
    ).toEqual({ bufor_szt: 0, prog_skoku_szt: 5 });
    expect(ustawieniaOfertKonta(db, 'erli_polcien')).toMatchObject({
      czynne: true,
      narzutBp: 1250,
      stalaIlosc: 5,
      buforSzt: 0,
      progSkokuSzt: 5,
    });
    expect(
      wiersz(
        db,
        `SELECT count(*) n FROM produkty_sklepowe
      WHERE ilosc_kanalu IS NOT NULL OR stan_prowadzony IS NOT NULL OR ilosc_odczytana_at IS NOT NULL`,
      ).n,
    ).toBe(0);
  });

  it('drugie uruchomienie obu migracji nie zmienia schematu ani danych', () => {
    const db = bazaPamieci();
    const o = wstawOferte(db, { kartaId: 501, kanal: 'erli_polcien', idZewnetrzne: 'QX7P2M-K501' }, { teraz: T0 });
    zmienOferte(db, o.id, { iloscZOms: true, odczytIloscKanalu: -3 }, { teraz: T0 });
    zapiszUstawieniaOfertKonta(db, 'erli_polcien', { buforSzt: 2, progSkokuSzt: 7 }, { teraz: T0 });
    db.prepare(
      "INSERT INTO stany_otwarcia (karta_id, granica, ilosc, zrodlo, utworzono_at) VALUES (501, ?, 0, 'import', ?)",
    ).run(T0, T0);
    const przed = [schemat(db), odcisk(db, tabele(db))];
    for (let i = 0; i < 2; i++) {
      expect(() => migracjaStanowKanalow.wykonaj(db)).not.toThrow();
      expect(() => migracjaStanowOtwarciaLustra.wykonaj(db)).not.toThrow();
    }
    expect([schemat(db), odcisk(db, tabele(db))]).toEqual(przed);
  });

  it('strażnik migracji zielony', () => {
    expect(execFileSync(process.execPath, ['scripts/straznik-migracji.mjs'], { cwd: KORZEN, encoding: 'utf8' })).toBe(
      '',
    );
  });

  it('nowe tabele mają kształt z planu (D51, D52, D59)', () => {
    const db = bazaPamieci();
    expect(kolumny(db, 'stany_otwarcia')).toEqual([
      'karta_id',
      'granica',
      'ilosc',
      'zrodlo',
      'konto_login',
      'utworzono_at',
    ]);
    expect(kolumny(db, 'stany_zatwierdzenia')).toEqual([
      'id',
      'przelaczenie_id',
      'zatwierdzil',
      'zatwierdzono_at',
      'ofert',
      'skrot',
    ]);
    expect(kolumny(db, 'stany_przepiecia')).toEqual([
      'id',
      'kanal',
      'produkt_id',
      'wariant_id',
      'z_karty',
      'na_karte',
      'ilosc_wstecz',
      'konto_login',
      'utworzono_at',
    ]);
  });

  it('stany_otwarcia: zero jest zapisywalne, ujemna odmowa, jedna wartość na kartę i granicę (D52)', () => {
    const db = bazaPamieci();
    const wstaw = (karta: number, ilosc: number) =>
      db
        .prepare(
          `INSERT INTO stany_otwarcia (karta_id, granica, ilosc, zrodlo, utworzono_at)
      VALUES (?, ?, ?, 'import', ?)`,
        )
        .run(karta, T0, ilosc, T0);
    expect(() => wstaw(501, 0)).not.toThrow();
    expect(() => wstaw(502, -1)).toThrow(/CHECK/);
    expect(() => wstaw(501, 3)).toThrow(/UNIQUE|PRIMARY/);
  });

  it('bez CHECK na nowych kolumnach: odczyt i ilość kanału przyjmują −3 (D60)', () => {
    const db = bazaPamieci();
    const o = wstawOferte(db, { kartaId: 501, kanal: 'erli_polcien', idZewnetrzne: 'QX7P2M-K501' }, { teraz: T0 });
    db.prepare('UPDATE oferty_kanalow SET odczyt_ilosc_kanalu = -3 WHERE id = ?').run(o.id);
    expect(wiersz(db, 'SELECT odczyt_ilosc_kanalu v FROM oferty_kanalow WHERE id = ?', o.id).v).toBe(-3);
    db.prepare(
      `INSERT INTO produkty_sklepowe (kanal, produkt_id, nazwa, odczytane_at, ilosc_kanalu, stan_prowadzony)
      VALUES ('woo_polcien', '77', 'Lampa Półcień mała', ?, -3, 'rodzic')`,
    ).run(T0);
    expect(wiersz(db, "SELECT ilosc_kanalu, stan_prowadzony FROM produkty_sklepowe WHERE produkt_id = '77'")).toEqual({
      ilosc_kanalu: -3,
      stan_prowadzony: 'rodzic',
    });
  });
});

describe('repozytorium rejestru — pola E4 (D50, D53, D54)', () => {
  it('nowa oferta: bez ilości z OMS, bez śladu wysyłki', () => {
    const db = bazaPamieci();
    const o = wstawOferte(db, { kartaId: 501, kanal: 'erli_polcien', idZewnetrzne: 'QX7P2M-K501' }, { teraz: T0 });
    expect(o).toMatchObject({
      iloscZOms: false,
      iloscWyslanaAt: null,
      stanKartyWyslany: null,
      iloscWToku: null,
      iloscProblem: null,
      odczytIloscKanalu: null,
    });
  });

  it('zmienOferte zapisuje i czyta pola ilości; odczyt kanału −3 przyjęty', () => {
    const db = bazaPamieci();
    const o = wstawOferte(db, { kartaId: 501, kanal: 'erli_polcien', idZewnetrzne: 'QX7P2M-K501' }, { teraz: T0 });
    expect(() => zmienOferte(db, o.id, { odczytIloscKanalu: -3, stanKartyWyslany: -1 }, { teraz: T0 })).not.toThrow();
    const problem = { kod: 'skok', wstrzymuje: true, od: T0, cel: 3, odczyt: 9, tekst: 'Skok stanu karty o 6 szt.' };
    const po = zmienOferte(
      db,
      o.id,
      {
        iloscZOms: true,
        iloscWyslanaAt: T1,
        stanKartyWyslany: -2,
        iloscWToku: { cel: 3, at: T1 },
        iloscProblem: problem,
        odczytIloscKanalu: -3,
      },
      { teraz: T1 },
    );
    expect(po).toMatchObject({
      iloscZOms: true,
      iloscWyslanaAt: T1,
      stanKartyWyslany: -2,
      iloscWToku: { cel: 3, at: T1 },
      iloscProblem: problem,
      odczytIloscKanalu: -3,
      zmienionoAt: T1,
    });
    expect(wiersz(db, 'SELECT ilosc_z_oms, ilosc_w_toku_json FROM oferty_kanalow WHERE id = ?', o.id)).toEqual({
      ilosc_z_oms: 1,
      ilosc_w_toku_json: JSON.stringify({ cel: 3, at: T1 }),
    });
    expect(
      zmienOferte(db, o.id, { iloscZOms: false, iloscWToku: null, iloscProblem: null }, { teraz: T1 }),
    ).toMatchObject({ iloscZOms: false, iloscWToku: null, iloscProblem: null });
  });

  it('zmienOferte odrzuca złe wartości pól ilości i nic nie zapisuje', () => {
    const db = bazaPamieci();
    const o = wstawOferte(db, { kartaId: 501, kanal: 'erli_polcien', idZewnetrzne: 'QX7P2M-K501' }, { teraz: T0 });
    expect(() => zmienOferte(db, o.id, { iloscZOms: 1 })).toThrow(/iloscZOms/);
    expect(() => zmienOferte(db, o.id, { odczytIloscKanalu: 2.5 })).toThrow(/odczytIloscKanalu/);
    expect(() => zmienOferte(db, o.id, { stanKartyWyslany: '4' })).toThrow(/stanKartyWyslany/);
    expect(() => zmienOferte(db, o.id, { iloscWToku: [3] })).toThrow(/iloscWToku/);
    expect(() => zmienOferte(db, o.id, { iloscProblem: 'skok' })).toThrow(/iloscProblem/);
    expect(() => zmienOferte(db, o.id, { iloscZOms: true, iloscWyslanaAt: 7 })).toThrow(/iloscWyslanaAt/);
    expect(ofertaPoId(db, o.id)).toMatchObject({ iloscZOms: false, iloscWyslanaAt: null, zmienionoAt: T0 });
  });
});

describe('repozytorium ustawień — bufor i próg skoku', () => {
  it('konto bez zapisu: bufor 0, próg skoku 5', () => {
    const db = bazaPamieci();
    expect(ustawieniaOfertKonta(db, 'erli_polcien')).toMatchObject({ zapisane: false, buforSzt: 0, progSkokuSzt: 5 });
  });

  it('zapis w zakresie przechodzi; bufor −1 i próg 0 → odmowa, nic nie zapisane', () => {
    const db = bazaPamieci();
    expect(
      zapiszUstawieniaOfertKonta(db, 'erli_polcien', { buforSzt: 0, progSkokuSzt: 1 }, { teraz: T0 }),
    ).toMatchObject({ buforSzt: 0, progSkokuSzt: 1 });
    expect(
      zapiszUstawieniaOfertKonta(db, 'erli_polcien', { buforSzt: 1000000, progSkokuSzt: 1000000 }, { teraz: T0 }),
    ).toMatchObject({ buforSzt: 1000000, progSkokuSzt: 1000000 });
    for (const zle of [
      { buforSzt: -1 },
      { buforSzt: 1000001 },
      { buforSzt: 1.5 },
      { buforSzt: null },
      { progSkokuSzt: 0 },
      { progSkokuSzt: 1000001 },
      { progSkokuSzt: '5' },
      { progSkokuSzt: null },
    ]) {
      expect(() => zapiszUstawieniaOfertKonta(db, 'allegro_polcien', zle, { teraz: T1 })).toThrow(/Bufor|Próg skoku/);
    }
    expect(wiersz(db, "SELECT count(*) n FROM oferty_ustawienia_kont WHERE klucz = 'allegro_polcien'").n).toBe(0);
  });
});

describe('zatwierdzenie stanów (D51) i przepięcie (D59)', () => {
  it('zatwierdzenie wiąże się z przełączeniem, nie z datą', () => {
    const db = bazaPamieci();
    expect(zatwierdzenieStanow(db, 1)).toBeNull();
    const z = zapiszZatwierdzenieStanow(
      db,
      { przelaczenieId: 1, zatwierdzil: 'administrator', ofert: 12, skrot: 'a1b2c3' },
      { teraz: T0 },
    );
    expect(z).toEqual({
      id: expect.any(Number),
      przelaczenieId: 1,
      zatwierdzil: 'administrator',
      zatwierdzonoAt: T0,
      ofert: 12,
      skrot: 'a1b2c3',
    });
    expect(zatwierdzenieStanow(db, 1)).toEqual(z);
    expect(zatwierdzenieStanow(db, 2)).toBeNull();
    const drugie = zapiszZatwierdzenieStanow(
      db,
      { przelaczenieId: 1, zatwierdzil: null, ofert: 13, skrot: 'd4e5f6' },
      { teraz: T1 },
    );
    expect(zatwierdzenieStanow(db, 1)).toEqual(drugie);
  });

  it('zatwierdzenie: złe dane → odmowa', () => {
    const db = bazaPamieci();
    expect(() => zapiszZatwierdzenieStanow(db, { przelaczenieId: 0, zatwierdzil: 'a', ofert: 1, skrot: 'x' })).toThrow(
      /przelaczenieId/,
    );
    expect(() => zapiszZatwierdzenieStanow(db, { przelaczenieId: 1, zatwierdzil: 'a', ofert: -1, skrot: 'x' })).toThrow(
      /ofert/,
    );
    expect(() => zapiszZatwierdzenieStanow(db, { przelaczenieId: 1, zatwierdzil: 'a', ofert: 1, skrot: ' ' })).toThrow(
      /skrot/,
    );
    expect(wiersz(db, 'SELECT count(*) n FROM stany_zatwierdzenia').n).toBe(0);
  });

  it('przepięcie zapisuje ślad z kartą źródłową i docelową', () => {
    const db = bazaPamieci();
    const p = zapiszPrzepiecie(
      db,
      {
        kanal: 'woo_polcien',
        produktId: '77',
        wariantId: '78',
        zKarty: 501,
        naKarte: 502,
        iloscWstecz: 3,
        kontoLogin: 'administrator',
      },
      { teraz: T0 },
    );
    expect(p).toEqual({
      id: expect.any(Number),
      kanal: 'woo_polcien',
      produktId: '77',
      wariantId: '78',
      zKarty: 501,
      naKarte: 502,
      iloscWstecz: 3,
      kontoLogin: 'administrator',
      utworzonoAt: T0,
    });
    expect(wiersz(db, 'SELECT * FROM stany_przepiecia WHERE id = ?', p.id)).toEqual({
      id: p.id,
      kanal: 'woo_polcien',
      produkt_id: '77',
      wariant_id: '78',
      z_karty: 501,
      na_karte: 502,
      ilosc_wstecz: 3,
      konto_login: 'administrator',
      utworzono_at: T0,
    });
    expect(
      zapiszPrzepiecie(
        db,
        { kanal: 'woo_polcien', produktId: '90', zKarty: null, naKarte: 501, iloscWstecz: 0 },
        { teraz: T1 },
      ),
    ).toMatchObject({ wariantId: null, zKarty: null, naKarte: 501, kontoLogin: null });
    expect(() =>
      zapiszPrzepiecie(db, { kanal: 'woo_polcien', produktId: '77', zKarty: 501, naKarte: 501, iloscWstecz: 0 }),
    ).toThrow(/kart/);
    expect(() =>
      zapiszPrzepiecie(db, { kanal: 'woo_polcien', produktId: '77', zKarty: 501, naKarte: 502, iloscWstecz: -1 }),
    ).toThrow(/iloscWstecz/);
  });
});
