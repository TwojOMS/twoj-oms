import { afterEach, beforeEach, expect, it } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { modulRdzen } from '../../../src/moduly/rdzen/modul.ts';
import { createModulZamowienia } from '../../../src/moduly/zamowienia/modul.ts';
import { modulMagazyn } from '../../../src/moduly/magazyn/modul.ts';
import { sprzedazKartyWedlugKanalu } from '../../../src/oms/db/sprzedaz-kanalow-karty.js';
import { migracjaIndeksuPozycjiKarty } from '../../../src/moduly/zamowienia/migracje/0005-indeks-pozycji-karty.ts';

let db;

beforeEach(() => {
  db = openOmsDb(':memory:', {
    moduly: [
      modulRdzen,
      { nazwa: 'magazyn', migracje: modulMagazyn.migracje },
      { nazwa: 'zamowienia', migracje: createModulZamowienia().migracje },
    ],
  });
});

afterEach(() => db.close());

// Plan zapytania z tymi samymi parametrami, z którymi wywołuje je karta magazynu.
function planSprzedazyKarty(produkty, oferty) {
  let zlapane;
  const prepare = db.prepare.bind(db);
  db.prepare = (sql) => {
    const zapytanie = prepare(sql);
    if (!sql.includes('FROM pozycje')) return zapytanie;
    return { get: (parametry) => ((zlapane = { sql, parametry }), zapytanie.get(parametry)) };
  };
  try {
    sprzedazKartyWedlugKanalu(db, 1, produkty, oferty);
  } finally {
    db.prepare = prepare;
  }
  expect(zlapane).toBeDefined();
  return db.prepare(`EXPLAIN QUERY PLAN ${zlapane.sql}`).all(zlapane.parametry);
}

// Kroki planu pod węzłem `MATERIALIZE pasujace` — tam zapytanie wybiera pozycje z tabeli.
function krokiPasujacych(plan) {
  const korzen = plan.find((w) => w.detail === 'MATERIALIZE pasujace');
  expect(korzen).toBeDefined();
  const wezly = new Set([korzen.id]);
  for (const w of plan) if (wezly.has(w.parent)) wezly.add(w.id);
  return plan.filter((w) => wezly.has(w.parent)).map((w) => w.detail);
}

it('wybór pozycji karty idzie po indeksach, a nie przez całą tabelę pozycji', () => {
  const kroki = krokiPasujacych(
    planSprzedazyKarty(
      [{ kanal: 'sklep_polcien', produkt_id: '42', wariant_id: '' }],
      [{ kanal: 'allegro_polcien', idZewnetrzne: '4200' }],
    ),
  );
  expect(kroki).not.toContain('SCAN p');
  expect(kroki).toEqual(
    expect.arrayContaining([
      expect.stringMatching(/^SEARCH p USING INDEX pozycje_produkt_karty /),
      expect.stringMatching(/^SEARCH p USING INDEX pozycje_oferta_karty /),
    ]),
  );
});

it('migracja indeksu jest addytywna i bezpieczna przy ponownym wykonaniu', () => {
  expect(() => migracjaIndeksuPozycjiKarty.wykonaj(db)).not.toThrow();
  const indeksy = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'pozycje' ORDER BY name")
    .all()
    .map((w) => w.name);
  expect(indeksy).toEqual(expect.arrayContaining(['pozycje_oferta_karty', 'pozycje_produkt_karty']));
  expect(db.prepare("SELECT 1 FROM migracje WHERE modul = 'zamowienia' AND numer = 5").get()).toBeTruthy();
});
