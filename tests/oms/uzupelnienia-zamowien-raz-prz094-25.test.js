// PRZ-094.25 — uzupelnienia danych zamowien przechodza po zamowieniu RAZ, a nie przy kazdym starcie.
//
// Pomiar PRZ-094.08: `openOmsDb` wolal `uzupelnijDaneZamowien`, ktore czytalo `surowe_json` KAZDEGO
// zamowienia z kolumna wciaz NULL — a NULL zostaje na zawsze, gdy zrodlo nie ma tej informacji
// (brak uwag klienta, brak paczkomatu, Woo bez oferty Allegro...). 100 tys. zamowien = 5,7 s / 210 MB
// przy 13 B surowych, 30 s / 1,2 GB przy 4 KB. Liczba wierszy czytanych przy KOLEJNYM starcie ma byc zerowa.
import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openOmsDb } from '../../src/oms/db/db.ts';
import { uzupelnijDaneZamowien } from '../../src/oms/db/uzupelnienia-zamowien.js';
import { pobierzZamowienie } from '../../src/oms/db/zamowienia.js';
import * as baza from '../../src/oms/db/db.ts';
import * as uruchomienie from '../../src/core/uruchomienie.ts';
import * as katalogBazy from '../../src/core/katalog-bazy.ts';
import { uruchomOms } from '../../src/main.ts';

const ZDANYMI = {
  id: 501,
  customer_note: 'Prosze o dzwonek',
  payment_method_title: 'PayU',
  shipping_total: '12.00',
  shipping_tax: '2.76',
  meta_data: [
    { key: '_parcel_machine_id', value: 'KRA01M' },
    { key: '_parcel_machine_desc', value: 'Krakow, Testowa 1' },
  ],
  line_items: [{ id: 9001, product_id: 77, quantity: 2, total: '100.00', total_tax: '23.00' }],
};
// Zamowienie, z ktorego nic sie nie da wyczytac do kolumn „opcjonalnych" — jak Woo bez paczkomatu i uwag.
const BEZ_DANYCH = {
  id: 502,
  meta_data: [],
  line_items: [{ id: 9002, product_id: 78, quantity: 1, total: '10.00', total_tax: '2.30' }],
};
const Z_ALLEGRO = { lineItems: [{ offer: { id: 'A-1' }, quantity: 1 }] };

const KOLUMNY = 'uwagi, metoda_platnosci, punkt_odbioru, punkt_odbioru_opis, koszt_dostawy_brutto, koszt_dostawy_netto, indywidualne';

const katalogi = [];
afterEach(() => {
  vi.restoreAllMocks();
  while (katalogi.length) fs.rmSync(katalogi.pop(), { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});
function nowyPlik() {
  const k = fs.mkdtempSync(path.join(os.tmpdir(), 'oms-uzupelnienia-prz094-25-'));
  katalogi.push(k);
  return path.join(k, 'oms.sqlite');
}

function wstaw(db, zrodloId, surowe) {
  const info = db.prepare(
    "INSERT INTO zamowienia (sklep, zrodlo_id, numer, kwota_brutto, utworzone_at, surowe_json)"
    + " VALUES ('sklep_x', ?, ?, '0.00', '2026-10-01T10:00:00Z', ?)",
  ).run(zrodloId, `T-${zrodloId}`, JSON.stringify(surowe));
  const id = Number(info.lastInsertRowid);
  const linie = surowe.line_items ?? surowe.lineItems ?? [];
  for (let i = 0; i < linie.length; i++) {
    db.prepare("INSERT INTO pozycje (zamowienie_id, nazwa, ilosc, cena_brutto) VALUES (?, 'x', 1, '1.00')").run(id);
  }
  return id;
}

const kolumny = (db, id) => db.prepare(`SELECT ${KOLUMNY} FROM zamowienia WHERE id = ?`).get(id);
const pozycja = (db, id) => db.prepare(
  'SELECT brutto_linii, netto_linii, zrodlo_id, produkt_id, oferta_id FROM pozycje WHERE zamowienie_id = ? ORDER BY id',
).all(id);

/** Baza z zamowieniami wpisanymi „z zewnatrz" (jak po imporcie/starej wersji) — jeszcze bez uzupelnien. */
function bazaZZamowieniami(wstawiaj) {
  const plik = nowyPlik();
  const db = openOmsDb(plik);
  const ids = wstawiaj(db);
  db.close();
  return { plik, ids };
}

/** Licznik odczytow `surowe_json` — liczy WIERSZE zwrocone przez zapytania, ktore je czytaja, niezaleznie od raportu funkcji. */
function zLicznikiem(db) {
  const licznik = { wiersze: 0, najwiekszaPorcja: 0 };
  const obej = (st) => new Proxy(st, {
    get(cel, nazwa) {
      if (nazwa === 'all') {
        return (...a) => {
          const r = cel.all(...a);
          licznik.wiersze += r.length;
          licznik.najwiekszaPorcja = Math.max(licznik.najwiekszaPorcja, r.length);
          return r;
        };
      }
      if (nazwa === 'get') {
        return (...a) => { const r = cel.get(...a); if (r) licznik.wiersze += 1; return r; };
      }
      const v = cel[nazwa];
      return typeof v === 'function' ? v.bind(cel) : v;
    },
  });
  const proxy = new Proxy(db, {
    get(cel, nazwa) {
      if (nazwa === 'prepare') {
        return (sql) => {
          const st = cel.prepare(sql);
          return /surowe_json/.test(sql) && /^\s*SELECT/i.test(sql) ? obej(st) : st;
        };
      }
      const v = cel[nazwa];
      return typeof v === 'function' ? v.bind(cel) : v;
    },
  });
  return { db: proxy, licznik };
}

describe('PRZ-094.25 uzupelnienia danych zamowien — raz na zamowienie', () => {
  it('(b) zamowienie z danymi w surowe_json dostaje uzupelnienia jak dotad', () => {
    const { plik, ids } = bazaZZamowieniami((db) => [wstaw(db, 1, ZDANYMI), wstaw(db, 2, Z_ALLEGRO)]);
    const db = openOmsDb(plik);
    try {
      expect(kolumny(db, ids[0])).toMatchObject({
        uwagi: 'Prosze o dzwonek', metoda_platnosci: 'PayU', punkt_odbioru: 'KRA01M',
        punkt_odbioru_opis: 'Krakow, Testowa 1', koszt_dostawy_brutto: '14.76', koszt_dostawy_netto: '12.00',
      });
      expect(pozycja(db, ids[0])).toEqual([
        { brutto_linii: '123.00', netto_linii: '100.00', zrodlo_id: 9001, produkt_id: 77, oferta_id: null },
      ]);
      expect(pozycja(db, ids[1])).toEqual([
        { brutto_linii: null, netto_linii: null, zrodlo_id: null, produkt_id: null, oferta_id: 'A-1' },
      ]);
      expect(kolumny(db, ids[1]).indywidualne).toBe(0);
    } finally { db.close(); }
  });

  it('(a) KOLEJNE uzupelnienie nie czyta surowe_json zamowien, ktore pierwsze juz sprawdzilo', () => {
    const { plik } = bazaZZamowieniami((db) => {
      const ids = [];
      for (let i = 1; i <= 30; i++) ids.push(wstaw(db, i, i % 2 ? BEZ_DANYCH : ZDANYMI));
      return ids;
    });
    const db = openOmsDb(plik); // pierwszy start: sprawdza wszystkie 30
    try {
      const pierwsze = zLicznikiem(db);
      uzupelnijDaneZamowien(pierwsze.db);
      expect(pierwsze.licznik.wiersze).toBe(0);
    } finally { db.close(); }
  });

  it('(a) licznik nie jest slepy: nowe zamowienie po starcie JEST czytane i uzupelniane', () => {
    const { plik } = bazaZZamowieniami((db) => [wstaw(db, 1, BEZ_DANYCH)]);
    const db = openOmsDb(plik);
    try {
      const nowe = wstaw(db, 2, ZDANYMI);
      const l = zLicznikiem(db);
      uzupelnijDaneZamowien(l.db);
      expect(l.licznik.wiersze).toBeGreaterThan(0);
      expect(kolumny(db, nowe)).toMatchObject({ uwagi: 'Prosze o dzwonek', punkt_odbioru: 'KRA01M' });
      const znowu = zLicznikiem(db);
      uzupelnijDaneZamowien(znowu.db);
      expect(znowu.licznik.wiersze).toBe(0);
    } finally { db.close(); }
  });

  it('(a) zamowienie sprawdzone przy poprzednim starcie nie jest przeliczane po restarcie', () => {
    const { plik, ids } = bazaZZamowieniami((db) => [wstaw(db, 1, ZDANYMI)]);
    let db = openOmsDb(plik);
    expect(kolumny(db, ids[0]).uwagi).toBe('Prosze o dzwonek');
    db.exec('UPDATE zamowienia SET uwagi = NULL');
    db.close();
    db = openOmsDb(plik); // dowod „nie sprawdza drugi raz": reczne wyzerowanie NIE jest odtwarzane
    try {
      expect(kolumny(db, ids[0]).uwagi).toBeNull();
    } finally { db.close(); }
  });

  it('(a) zamowienie dopisane miedzy startami jest uzupelnione przy nastepnym starcie', () => {
    const { plik } = bazaZZamowieniami((db) => [wstaw(db, 1, BEZ_DANYCH)]);
    let db = openOmsDb(plik);
    const nowe = wstaw(db, 2, ZDANYMI);
    db.close();
    db = openOmsDb(plik);
    try {
      expect(kolumny(db, nowe)).toMatchObject({ uwagi: 'Prosze o dzwonek', metoda_platnosci: 'PayU', punkt_odbioru: 'KRA01M' });
      expect(pozycja(db, nowe)[0]).toMatchObject({ zrodlo_id: 9001, produkt_id: 77 });
    } finally { db.close(); }
  });

  it('skasowanie znacznika wymusza pelne sprawdzenie od poczatku (furtka dla operatora)', () => {
    const { plik, ids } = bazaZZamowieniami((db) => [wstaw(db, 1, ZDANYMI)]);
    let db = openOmsDb(plik);
    db.exec('UPDATE zamowienia SET uwagi = NULL');
    db.exec("DELETE FROM migracje_jednorazowe WHERE nazwa LIKE 'uzupelnienia-zamowien:%'");
    db.close();
    db = openOmsDb(plik);
    try {
      expect(kolumny(db, ids[0]).uwagi).toBe('Prosze o dzwonek');
    } finally { db.close(); }
  });

  it('znacznik wiekszy niz numeracja zamowien (baza podmieniona) nie ukrywa zamowien', () => {
    const { plik, ids } = bazaZZamowieniami((db) => [wstaw(db, 1, ZDANYMI)]);
    let db = openOmsDb(plik);
    db.exec('UPDATE zamowienia SET uwagi = NULL');
    const znacznik = db.prepare("SELECT nazwa FROM migracje_jednorazowe WHERE nazwa LIKE 'uzupelnienia-zamowien:%'").all();
    expect(znacznik).toHaveLength(1); // jeden znacznik, nie jeden na kazdy start
    db.prepare('UPDATE migracje_jednorazowe SET nazwa = ? WHERE nazwa = ?')
      .run(znacznik[0].nazwa.replace(/do-id:\d+$/, 'do-id:999999'), znacznik[0].nazwa);
    db.close();
    db = openOmsDb(plik);
    try {
      expect(kolumny(db, ids[0]).uwagi).toBe('Prosze o dzwonek');
    } finally { db.close(); }
  });

  it('znacznik z inna wersja krokow (np. dolozony krok) nie ukrywa zamowien — przechodzi cala baze', () => {
    const { plik, ids } = bazaZZamowieniami((db) => [wstaw(db, 1, ZDANYMI)]);
    let db = openOmsDb(plik);
    db.exec('UPDATE zamowienia SET uwagi = NULL');
    db.exec("UPDATE migracje_jednorazowe SET nazwa = REPLACE(nazwa, 'uzupelnienia-zamowien:v', 'uzupelnienia-zamowien:v0-stara-') WHERE nazwa LIKE 'uzupelnienia-zamowien:%'");
    db.close();
    db = openOmsDb(plik);
    try {
      expect(kolumny(db, ids[0]).uwagi).toBe('Prosze o dzwonek');
      expect(db.prepare("SELECT COUNT(*) AS c FROM migracje_jednorazowe WHERE nazwa LIKE 'uzupelnienia-zamowien:%'").get().c).toBe(1);
    } finally { db.close(); }
  });

  it('(d) surowe_json jest czytane porcjami po id — pamiec nie zalezy od liczby zamowien', () => {
    const { plik } = bazaZZamowieniami((db) => {
      db.exec('BEGIN');
      for (let i = 1; i <= 1300; i++) wstaw(db, i, BEZ_DANYCH);
      db.exec('COMMIT');
      return [];
    });
    const db = openOmsDb(plik);
    try {
      db.exec("DELETE FROM migracje_jednorazowe WHERE nazwa LIKE 'uzupelnienia-zamowien:%'");
      const l = zLicznikiem(db);
      uzupelnijDaneZamowien(l.db);
      expect(l.licznik.wiersze).toBeGreaterThan(1300); // kilka kolumn, kazda czyta wszystkie
      expect(l.licznik.najwiekszaPorcja).toBeLessThanOrEqual(500);
    } finally { db.close(); }
  });

  it('(c) czytelnicy dla zamowien „bez danych” widza to samo po pierwszym i po drugim starcie', () => {
    const { plik, ids } = bazaZZamowieniami((db) => [wstaw(db, 1, BEZ_DANYCH), wstaw(db, 2, Z_ALLEGRO)]);
    let db = openOmsDb(plik);
    const przed = ids.map((id) => ({ karta: pobierzZamowienie(db, id), kol: kolumny(db, id), poz: pozycja(db, id) }));
    db.close();
    db = openOmsDb(plik);
    try {
      const po = ids.map((id) => ({ karta: pobierzZamowienie(db, id), kol: kolumny(db, id), poz: pozycja(db, id) }));
      // Zadnych znacznikow zastepczych w kolumnach: brak danych to dalej NULL, wiec karta/lista/eksport
      // czytaja te same wartosci co zawsze.
      expect(po).toEqual(przed);
      expect(po[0].kol).toMatchObject({ uwagi: null, metoda_platnosci: null, punkt_odbioru: null, punkt_odbioru_opis: null });
      expect(po[0].karta).toBeTruthy();
    } finally { db.close(); }
  });

  it('start zapisuje w logu liczbe zamowien do sprawdzenia i czas uzupelnien', () => {
    const { plik } = bazaZZamowieniami((db) => [wstaw(db, 1, BEZ_DANYCH), wstaw(db, 2, ZDANYMI)]);
    const linie = [];
    let db = openOmsDb(plik, { log: (s) => linie.push(s) });
    db.close();
    db = openOmsDb(plik, { log: (s) => linie.push(s) });
    db.close();
    expect(linie).toHaveLength(2);
    expect(linie[0]).toMatch(/^uzupełnienia danych zamówień: 2 do sprawdzenia, \d+ ms/);
    expect(linie[1]).toMatch(/^uzupełnienia danych zamówień: 0 do sprawdzenia, \d+ ms/);
  });
});

describe('PRZ-094.25 linia logu startu produkcji', () => {
  it('uruchomOms podaje openOmsDb funkcje logu — linia z kosztem uzupelnien trafia do logu procesu', async () => {
    const env = {
      OMS_TRYB: 'produkcja', OMS_USER: 'operator', OMS_PASS: 'fixture', OMS_SPRZEDAWCA_NIP: '1234563218',
      OMS_RACHUNEK: '34109010140000000000000000', OMS_PROFORMY_KATALOG: 'C:/fixture/proformy',
      OMS_ETYKIETY_KATALOG: 'C:/fixture/etykiety', OMS_DB_PATH: 'C:/fixture/oms.sqlite', OMS_PORT: '0',
    };
    const wypisane = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(katalogBazy, 'sprawdzKatalogBazy').mockImplementation(() => {});
    const otworz = vi.spyOn(baza, 'openOmsDb').mockReturnValue({});
    vi.spyOn(uruchomienie, 'uruchomAplikacje').mockResolvedValue({ zamknij: async () => {} });
    await uruchomOms(env, '127.0.0.1');
    const opcje = otworz.mock.calls[0][1];
    expect(opcje.log).toBeTypeOf('function');
    opcje.log('uzupełnienia danych zamówień: 0 do sprawdzenia, 3 ms');
    expect(wypisane).toHaveBeenCalledWith('uzupełnienia danych zamówień: 0 do sprawdzenia, 3 ms');
  });
});
