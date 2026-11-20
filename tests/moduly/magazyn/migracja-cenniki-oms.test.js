import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { modulyDla } from '../../../src/moduly/lista.ts';
import { ENV_DEMO } from '../../../scripts/demo-dane.mjs';
import { modulMagazyn } from '../../../src/moduly/magazyn/modul.ts';
import { migracjaCennikowOms } from '../../../src/moduly/magazyn/migracje/0006-cenniki-oms.ts';
import { cennikiOms, cennikOmsKarty, maCennikiOms } from '../../../src/oms/db/cenniki-oms.ts';
import { ustawieniaOfertKonta, zapiszUstawieniaOfertKonta } from '../../../src/oms/db/oferty-kanalow.ts';
import { wyjatekCennika, zapiszWyjatekCennika } from '../../../src/oms/db/cenniki-kart.ts';
import { dobierzCennik, regulyKonta } from '../../../src/domena/cennik-dostaw.js';

// Migracja magazyn/0006: reguły kont i wyjątki kart przechodzą do cenników OMS z powiązaniami. Baza „przed” to baza
// bez tej migracji (dawny odczyt), potem migracja na tej samej bazie. Dane zmyślone: lampy „Pracowni Półcień”.

const KORZEN = fileURLToPath(new URL('../../../', import.meta.url));
const T0 = '2026-11-19T10:00:00.000Z';
const A = 'allegro_lampy';
const B = 'erli_lampy';
const C = 'allegro_lampy_stare';

const bazy = [];
afterEach(() => {
  for (const db of bazy.splice(0)) if (db.isOpen) db.close();
});

// Baza sprzed 0006 nie ma też późniejszych migracji (wybór konta z 0007 zapisywałby się poza dawną tabelą).
const bez0006 = (moduly) =>
  moduly.map((m) => (m.nazwa === 'magazyn' ? { ...m, migracje: m.migracje.filter((x) => x.numer < 6) } : m));

function bazaPrzed() {
  const db = openOmsDb(':memory:', { moduly: bez0006(modulyDla(ENV_DEMO)), teraz: () => new Date(T0) });
  bazy.push(db);
  db.prepare('DELETE FROM karty_cenniki_kont').run();
  db.prepare('DELETE FROM oferty_ustawienia_kont').run();
  return db;
}

const nowaKarta = (db, id, [s, w, g, waga] = [null, null, null, null]) =>
  db
    .prepare(
      `INSERT INTO karty_produktow (id, sku, nazwa, szerokosc_mm, wysokosc_mm, glebokosc_mm, waga_g,
      utworzony_at, zmieniony_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, `LMP-${id}`, `Lampa Półcień ${id}`, s, w, g, waga, T0, T0);

const konto = (db, klucz, cenniki) => zapiszUstawieniaOfertKonta(db, klucz, { cenniki }, { teraz: T0 });
// Konto sprzed reguł: tylko dawna kolumna, bez listy.
const kontoStare = (db, klucz, cennik) =>
  db
    .prepare(
      'INSERT INTO oferty_ustawienia_kont (klucz, cennik_dostaw, cenniki_json, zmieniono_at) VALUES (?, ?, NULL, ?)',
    )
    .run(klucz, cennik, T0);
const wyjatek = (db, kartaId, k, cennik) => zapiszWyjatekCennika(db, { kartaId, konto: k, cennik }, { teraz: T0 });

const dobor = (db, kartaId, k) => {
  const w = dobierzCennik({
    karta: db.prepare('SELECT * FROM karty_produktow WHERE id = ?').get(kartaId),
    reguly: regulyKonta(ustawieniaOfertKonta(db, k)),
    wyjatek: wyjatekCennika(db, { kartaId, konto: k }),
  });
  return w.odmowa ? `odmowa:${w.odmowa.kod}` : `${w.cennik}|${w.powod.rodzaj}|${w.powod.numer ?? ''}`;
};

const obraz = (db) =>
  cennikiOms(db).map((c) => ({
    nazwa: c.nazwa,
    rodzaj: c.rodzaj,
    doMm: c.doMm,
    doG: c.doG,
    powiazania: Object.fromEntries(c.powiazania.map((p) => [p.konto, p.cennikKanalu])),
    karty: db
      .prepare('SELECT karta_id FROM karty_cennik_oms WHERE cennik_id = ? ORDER BY karta_id')
      .all(c.id)
      .map((w) => w.karta_id),
  }));

function scenariusz() {
  const db = bazaPrzed();
  konto(db, A, [{ doMm: [640, 380, 80], doG: 25000, cennik: 'a-mala' }, { cennik: 'a-duza' }]);
  konto(db, B, [{ doMm: [380, 640, 80], doG: 25000, cennik: 'b-mala' }, { cennik: 'b-duza' }]);
  kontoStare(db, C, 'c-stary');
  for (const id of [7, 8, 9]) nowaKarta(db, id, [300, 200, 60, 1500]);
  wyjatek(db, 7, A, 'a-duza');
  wyjatek(db, 8, A, 'a-duza');
  wyjatek(db, 9, A, 'a-mala');
  wyjatek(db, 9, B, 'b-duza');
  return db;
}

describe('migracja cenników dostaw OMS', () => {
  it('jest zarejestrowana w module magazynu jako numer 6', () => {
    expect(modulMagazyn.migracje).toContain(migracjaCennikowOms);
    expect(migracjaCennikowOms.numer).toBe(6);
    expect(modulMagazyn.migracje.filter((m) => m.numer === 6)).toHaveLength(1);
  });

  it('reguły kont i wyjątki kart dają dokładnie cenniki OMS z powiązaniami; ponowienie nic nie zmienia', () => {
    const db = scenariusz();
    expect(maCennikiOms(db)).toBe(false);
    migracjaCennikowOms.wykonaj(db);
    const po = obraz(db);
    expect(po).toEqual([
      {
        nazwa: 'Do 64×38×8 cm, 25 kg',
        rodzaj: 'rozmiar',
        doMm: [640, 380, 80],
        doG: 25000,
        powiazania: { [A]: 'a-mala', [B]: 'b-mala' },
        karty: [],
      },
      {
        nazwa: 'Domyślny',
        rodzaj: 'domyslny',
        doMm: null,
        doG: null,
        powiazania: { [A]: 'a-duza', [B]: 'b-duza', [C]: 'c-stary' },
        karty: [],
      },
      { nazwa: 'Wyjątek 1', rodzaj: 'karta', doMm: null, doG: null, powiazania: { [A]: 'a-duza' }, karty: [7, 8] },
      {
        nazwa: 'Wyjątek 2',
        rodzaj: 'karta',
        doMm: null,
        doG: null,
        powiazania: { [A]: 'a-mala', [B]: 'b-duza' },
        karty: [9],
      },
    ]);
    const powiazania = db.prepare('SELECT aktor_login FROM cenniki_dostaw_powiazania').all();
    expect(new Set(powiazania.map((w) => w.aktor_login))).toEqual(new Set(['migracja']));

    migracjaCennikowOms.wykonaj(db);
    expect(obraz(db)).toEqual(po);
    // Sprzedawca usunął powiązanie po migracji — ponowienie go nie odtwarza.
    db.prepare('DELETE FROM cenniki_dostaw_powiazania WHERE konto = ?').run(C);
    const poZmianie = obraz(db);
    migracjaCennikowOms.wykonaj(db);
    expect(obraz(db)).toEqual(poZmianie);
  });

  it('dawne tabele zostają nietknięte', () => {
    const db = scenariusz();
    const stan = () => ({
      konta: db.prepare('SELECT * FROM oferty_ustawienia_kont ORDER BY klucz').all(),
      wyjatki: db.prepare('SELECT * FROM karty_cenniki_kont ORDER BY karta_id, konto').all(),
    });
    const przed = stan();
    migracjaCennikowOms.wykonaj(db);
    expect(stan()).toEqual(przed);
  });

  it('jedna reguła „wszystko” daje sam cennik domyślny z jednym powiązaniem', () => {
    const db = bazaPrzed();
    konto(db, A, [{ cennik: 'a-wszystko' }]);
    migracjaCennikowOms.wykonaj(db);
    expect(obraz(db)).toEqual([
      { nazwa: 'Domyślny', rodzaj: 'domyslny', doMm: null, doG: null, powiazania: { [A]: 'a-wszystko' }, karty: [] },
    ]);
  });

  it('lista, którą dawny dobór odrzucał, nie daje powiązań — konto dalej bez cennika', () => {
    const db = bazaPrzed();
    db.prepare(
      'INSERT INTO oferty_ustawienia_kont (klucz, cennik_dostaw, cenniki_json, zmieniono_at) VALUES (?, NULL, ?, ?)',
    ).run(A, JSON.stringify([{ cennik: 'a-srodek' }, { doMm: [100, 100, 100], doG: 1000, cennik: 'a-mala' }]), T0);
    nowaKarta(db, 7, [50, 50, 50, 100]);
    expect(dobor(db, 7, A)).toBe('odmowa:brak-cennika');
    migracjaCennikowOms.wykonaj(db);
    expect(db.prepare('SELECT count(*) n FROM cenniki_dostaw_powiazania').get().n).toBe(0);
    expect(dobor(db, 7, A)).toBe('odmowa:brak-cennika');
  });

  it('dwie reguły o tych samych limitach: zostaje pierwsza, jak w dawnym doborze', () => {
    const db = bazaPrzed();
    konto(db, A, [
      { doMm: [400, 300, 100], doG: 5000, cennik: 'a-pierwsza' },
      { doMm: [100, 400, 300], doG: 5000, cennik: 'a-druga' },
      { cennik: 'a-duza' },
    ]);
    nowaKarta(db, 7, [200, 200, 50, 1000]);
    const przed = dobor(db, 7, A);
    migracjaCennikowOms.wykonaj(db);
    expect(obraz(db)[0]).toMatchObject({ nazwa: 'Do 40×30×10 cm, 5 kg', powiazania: { [A]: 'a-pierwsza' } });
    expect(dobor(db, 7, A)).toBe(przed);
  });

  it('nazwa cennika z limitów ma przecinek dziesiętny', () => {
    const db = bazaPrzed();
    konto(db, A, [{ doMm: [415, 85, 380], doG: 2500, cennik: 'a-mala' }, { cennik: 'a-duza' }]);
    migracjaCennikowOms.wykonaj(db);
    expect(obraz(db)[0]).toMatchObject({ nazwa: 'Do 41,5×38×8,5 cm, 2,5 kg', doMm: [415, 380, 85], doG: 2500 });
  });

  it('strażnik migracji zielony', () => {
    expect(execFileSync(process.execPath, ['scripts/straznik-migracji.mjs'], { cwd: KORZEN, encoding: 'utf8' })).toBe(
      '',
    );
  });
});

// Konta z regułami rosnącymi (mniejszy rozmiar wyżej) — dziś typowy zapis; dobór po migracji musi dać to samo.
const KONTA_ROSNACE = {
  allegro_lampy: [
    { doMm: [100, 100, 100], doG: 1000, cennik: 'a-list' },
    { doMm: [300, 200, 100], doG: 5000, cennik: 'a-mala' },
    { doMm: [600, 400, 300], doG: 20000, cennik: 'a-srednia' },
    { cennik: 'a-gabaryt' },
  ],
  erli_lampy: [{ doMm: [640, 380, 80], doG: 25000, cennik: 'e-mala' }, { cennik: 'e-duza' }],
  allegro_lampy_druga: [
    { doMm: [200, 300, 100], doG: 5000, cennik: 'd-mala' },
    { doMm: [1200, 800, 600], doG: 31500, cennik: 'd-paleta' },
    { cennik: 'd-kontener' },
  ],
};
const GRANICE = [
  [100, 100, 100, 1000],
  [300, 200, 100, 5000],
  [600, 400, 300, 20000],
  [640, 380, 80, 25000],
  [1200, 800, 600, 31500],
];
function kartyRownowaznosci() {
  const karty = [];
  for (const [a, b, c, g] of GRANICE) {
    karty.push([a, b, c, g]); // dokładnie na granicy
    karty.push([c, a, b, g]); // obrócona
    karty.push([a + 1, b, c, g]); // o 1 mm za długa
    karty.push([a, b, c, g + 1]); // o 1 g za ciężka
  }
  karty.push([null, null, null, null], [300, 200, null, 1000], [300, 200, 100, null], [null, 200, 100, 500]);
  karty.push([50, 50, 50, 10], [250, 150, 90, 4000], [2000, 100, 100, 3000], [500, 500, 500, 40000]);
  karty.push([380, 640, 80, 24999], [81, 380, 640, 100]);
  return karty;
}

describe('równoważność doboru przed i po migracji', () => {
  it('reguły rosnące, 30 kart, wyjątki: cennik, rodzaj i numer reguły bez zmian', () => {
    const db = bazaPrzed();
    for (const [k, r] of Object.entries(KONTA_ROSNACE)) konto(db, k, r);
    kontoStare(db, C, 'c-stary');
    const karty = kartyRownowaznosci();
    expect(karty).toHaveLength(30);
    karty.forEach((wym, i) => nowaKarta(db, 100 + i, wym));
    wyjatek(db, 100, 'allegro_lampy', 'a-gabaryt');
    wyjatek(db, 101, 'allegro_lampy', 'a-gabaryt');
    // To samo konto, inny cennik — osobny „Wyjątek N”, nie wspólny z kartami 100 i 101.
    wyjatek(db, 103, 'allegro_lampy', 'a-paleta');
    wyjatek(db, 102, 'erli_lampy', 'e-duza');
    wyjatek(db, 102, 'allegro_lampy_druga', 'd-paleta');
    wyjatek(db, 120, C, 'c-specjalny');

    const konta = [...Object.keys(KONTA_ROSNACE), C];
    const wynik = (baza) => konta.flatMap((k) => karty.map((_, i) => `${k}#${100 + i}=${dobor(baza, 100 + i, k)}`));
    const przed = wynik(db);
    migracjaCennikowOms.wykonaj(db);
    expect(maCennikiOms(db)).toBe(true);
    const po = wynik(db);
    const zgodne = przed.filter((w, i) => w === po[i]).length;
    expect(`${zgodne}/${przed.length}`).toBe(`${przed.length}/${przed.length}`);
    expect(po).toEqual(przed);
    // Zestaw ma wszystkie rodzaje wyniku — inaczej równość niczego by nie dowodziła.
    const rodzaje = new Set(przed.map((w) => w.split('=')[1].split('|')[1] ?? w.split('=')[1]));
    expect([...rodzaje].sort()).toEqual(['odmowa:brak-wymiarow', 'regula', 'wieksze', 'wszystko', 'wyjatek'].sort());
    expect(cennikOmsKarty(db, 102)).not.toBeNull();
  });

  it('reguła większa nad mniejszą: po migracji wygrywa mniejsza (ryzyko udokumentowane)', () => {
    const db = bazaPrzed();
    konto(db, A, [
      { doMm: [600, 400, 300], doG: 20000, cennik: 'a-srednia' },
      { doMm: [300, 200, 100], doG: 5000, cennik: 'a-mala' },
      { cennik: 'a-gabaryt' },
    ]);
    nowaKarta(db, 7, [250, 150, 90, 4000]);
    expect(dobor(db, 7, A)).toBe('a-srednia|regula|1');
    migracjaCennikowOms.wykonaj(db);
    expect(dobor(db, 7, A)).toBe('a-mala|regula|1');
  });
});
