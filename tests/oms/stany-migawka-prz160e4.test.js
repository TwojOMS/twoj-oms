import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { openOmsDb } from '../../src/oms/db/db.ts';
import { migracjaOfertKanalow } from '../../src/moduly/magazyn/migracje/0001-oferty-kanalow.ts';
import { wstawOferte } from '../../src/oms/db/oferty-kanalow.ts';
import { zapiszZamowienie, zapiszNadpisaniaPozycji } from '../../src/oms/db/zamowienia.js';
import { zapiszProduktSklepowy, powiazProdukt } from '../../src/oms/db/magazyn.js';
import * as stany from '../../src/oms/db/stany-magazynowe.js';

const T0 = '2026-11-14T08:00:00.000Z';
const T1 = '2026-11-14T09:00:00.000Z';
const T2 = '2026-11-14T10:00:00.000Z';
const T3 = '2026-11-14T11:00:00.000Z';
let db;
let numer;
beforeEach(() => {
  db = openOmsDb(':memory:');
  migracjaOfertKanalow.wykonaj(db);
  db.exec(`CREATE TABLE IF NOT EXISTS stany_otwarcia (
    karta_id INTEGER NOT NULL, granica TEXT NOT NULL, ilosc INTEGER NOT NULL CHECK (ilosc >= 0),
    zrodlo TEXT NOT NULL, konto_login TEXT, utworzono_at TEXT NOT NULL, PRIMARY KEY (karta_id, granica));
    CREATE TABLE IF NOT EXISTS stany_zatwierdzenia (id INTEGER PRIMARY KEY, przelaczenie_id INTEGER NOT NULL,
    zatwierdzil TEXT NOT NULL, zatwierdzono_at TEXT NOT NULL, ofert INTEGER NOT NULL, skrot TEXT NOT NULL);`);
  for (const id of [1, 2, 3]) {
    db.prepare(`INSERT INTO karty_produktow (id, sku, nazwa, utworzony_at, zmieniony_at) VALUES (?, ?, ?, ?, ?)`)
      .run(id, `PP-LAMPA-${id}`, `Lampa Półcień ${id}`, T0, T0);
    wstawOferte(db, { kanal: 'erli_polcien', kartaId: id, idZewnetrzne: `oferta-${id}`, pochodzenie: 'oms' }, { teraz: T0 });
  }
  numer = 0;
  stany.przelaczStany(db, { wlacz: true, at: T0 });
});
afterEach(() => { vi.restoreAllMocks(); db.close(); });

function zakup({ sklep = 'erli_polcien', oferta = 'oferta-1', at = T1, zmienione = T1, anulowane = 0, status = null } = {}) {
  const id = zapiszZamowienie(db, sklep, { zrodlo_id: String(++numer), numer: `E-${numer}`,
    klient: {}, dostawa: {}, utworzone_at: at, kwota_brutto: '20.00', metoda_wysylki: 'dpd',
    kwota_pobrania: null, chce_fakture: 0, nip: null, oplacone_at: null,
    anulowane, status_woo: status, pozycje: [{ zrodlo_id: 'p1', oferta_id: oferta,
      produkt_id: null, wariant_id: null, sku: null, zdjecie_url: null,
      nazwa: 'Lampa Półcień', ilosc: 2, cena_brutto: '10.00', vat: '23' }] }, {});
  db.prepare('UPDATE zamowienia SET zmienione_at = ? WHERE id = ?').run(zmienione, id);
  return id;
}
function ruch(kartaId, ilosc, at = T1) {
  stany.dodajRuch(db, { kartaId, rodzaj: 'przyjecie', ilosc, klucz: `r-${kartaId}-${at}`, at });
}
function wiersz(id = 1, dodatkowe = {}) {
  return { id, kanal: 'erli_polcien', kartaId: id, idZewnetrzne: `oferta-${id}`, od: T0, regula: 'zlozone', ...dodatkowe };
}

it('migawka zna tylko otwarcia i ruchy; zatwierdzenie dotyczy id bieżącego włączenia', () => {
  ruch(1, 8);
  stany.zapiszOtwarcie(db, { kartaId: 2, ilosc: 0, zrodlo: 'kanal', at: T1 });
  zakup({ oferta: 'oferta-3' }); // sama sprzedaż nie czyni stanu znanym
  const id = stany.przelacznikStanow(db).przelaczenieId;
  db.prepare('INSERT INTO stany_zatwierdzenia VALUES (1, ?, ?, ?, 3, ?)').run(id, 'operator', T1, 'skrot');
  const s = stany.migawkaStanow(db);
  expect(s.znane).toEqual(new Set([1, 2]));
  expect(s.otwarcia.get(2)).toEqual({ ilosc: 0, zrodlo: 'kanal' });
  expect(s.stany.get(2)).toEqual({ ruchy: 0, zuzycie: 0, stan: 0 });
  expect(s.zatwierdzenie).toEqual({ id: 1, przelaczenieId: id, skrot: 'skrot' });
  expect(s.policzonoAt).toEqual(expect.any(String));
  expect(stany.stanKarty(db, 2)).toEqual({ ruchy: 0, zuzycie: 0, stan: 0 });
  stany.przelaczStany(db, { wlacz: false, at: T2 });
  expect(stany.migawkaStanow(db).znane.size).toBe(0);
  stany.przelaczStany(db, { wlacz: true, at: T3 });
  expect(stany.migawkaStanow(db).zatwierdzenie).toBeNull();
});

it('import zera zapisuje znany stan bez ruchu, ponowny import go nie dubluje', () => {
  expect(stany.zapiszImportOtwarcia(db, 'PP-LAMPA-1;0', { at: T1 }).zapisane).toBe(1);
  expect(stany.migawkaStanow(db).znane.has(1)).toBe(true);
  expect(stany.migawkaStanow(db).stany.get(1).stan).toBe(0);
  expect(db.prepare('SELECT COUNT(*) n FROM ruchy_magazynowe').get().n).toBe(0);
  expect(db.prepare('SELECT COUNT(*) n FROM stany_otwarcia').get().n).toBe(1);
  expect(stany.zapiszImportOtwarcia(db, 'PP-LAMPA-1;0').zapisane).toBe(0);
});

it('otwarcie dodatnie jest atomowe, idempotentne i nie zmienia stanKarty', () => {
  expect(stany.zapiszOtwarcie(db, { kartaId: 1, ilosc: 5, zrodlo: 'kanal', at: T1 }).dopisano).toBe(true);
  expect(stany.zapiszOtwarcie(db, { kartaId: 1, ilosc: 7, zrodlo: 'kanal', at: T1 }).dopisano).toBe(false);
  expect(stany.stanKarty(db, 1).stan).toBe(5);
  expect(() => stany.zapiszOtwarcie(db, { kartaId: 3, ilosc: -1, zrodlo: 'kanal' })).toThrow();
  db.exec("CREATE TRIGGER odmowa BEFORE INSERT ON ruchy_magazynowe BEGIN SELECT RAISE(ABORT, 'odmowa'); END");
  expect(() => stany.zapiszOtwarcie(db, { kartaId: 2, ilosc: 3, zrodlo: 'kanal' })).toThrow(/odmowa/);
  expect(stany.migawkaStanow(db).znane.has(2)).toBe(false);
});

it('kontynuacja bierze ruchy do wyłączenia i zamówienia z całej poprzedniej granicy, także z przerwy', () => {
  ruch(1, 12);
  stany.zapiszOtwarcie(db, { kartaId: 2, ilosc: 0, zrodlo: 'import', at: T1 });
  zakup();
  stany.przelaczStany(db, { wlacz: false, at: T2 });
  zakup({ at: '2026-11-14T10:30:00Z' });
  stany.przelaczStany(db, { wlacz: true, at: T3 });
  ruch(1, 100, '2026-11-14T11:30:00Z');
  zakup({ at: '2026-11-14T11:30:00Z' });
  const s = stany.stanKontynuacji(db);
  expect(s.stany.get(1).stan).toBe(8);
  expect(s.znane).toEqual(new Set([1, 2]));
  expect(s.stany.get(2).stan).toBe(0);
});

it('brak nowych tabel i rejestru jest bezpieczny; brak historii nie daje kontynuacji', () => {
  db.exec('DROP TABLE stany_otwarcia; DROP TABLE stany_zatwierdzenia; DROP TABLE oferty_kanalow');
  expect(stany.migawkaStanow(db).otwarcia.size).toBe(0);
  expect(stany.migawkaStanow(db).zatwierdzenie).toBeNull();
  expect(stany.wyjasnieniaOfert(db, [wiersz()])).toEqual(new Map());
  expect(stany.stanKontynuacji(db)).toBeNull();
});

it('2000 zamówień i wiele ofert: jedno grupujące zapytanie, rozdzielenie kont i okien, anulowanie po T', () => {
  for (let i = 0; i < 2000; i++) zakup();
  const stare = zakup({ at: '2026-11-14T07:00:00Z', zmienione: T2, anulowane: 1 });
  zapiszNadpisaniaPozycji(db, stare, { sp1: { ilosc: 3 } });
  zakup({ sklep: 'erli_inny' });
  ruch(1, 5);
  const zapytania = [];
  const prepare = db.prepare.bind(db);
  vi.spyOn(db, 'prepare').mockImplementation(sql => { zapytania.push(sql); return prepare(sql); });
  const wynik = stany.wyjasnieniaOfert(db, [wiersz(), wiersz(2), wiersz(3), wiersz(4, { kartaId: 1, idZewnetrzne: 'oferta-1', od: T2 })]);
  expect(wynik.get(1)).toMatchObject({ sprzedaneOd: 4000, anulowaneOd: 3, wyjasnioneKarty: 4008, poller: null });
  expect(wynik.get(2).sprzedaneOd).toBe(0);
  expect(wynik.get(4).sprzedaneOd).toBe(0);
  expect(zapytania).toHaveLength(1);
});

it('Woo liczy sprzedaż po zmianie, bez pending, anulowania i statusy bez rozchodu powiększają zakres', () => {
  zakup({ at: '2026-11-14T07:00:00Z', zmienione: T1, status: 'processing' });
  zakup({ status: 'pending' });
  zakup({ status: 'failed' });
  const wynik = stany.wyjasnieniaOfert(db, [wiersz(1, { regula: 'zmienione' })]);
  expect(wynik.get(1)).toMatchObject({ sprzedaneOd: 2, anulowaneOd: 4 });
});

it('wyjaśnia całą kartę między ofertami i kontami, sumuje bezwzględne ruchy i zwraca stan pollera', () => {
  wstawOferte(db, { kanal: 'erli_inny', kartaId: 1, idZewnetrzne: 'druga', pochodzenie: 'przejeta' }, { teraz: T0 });
  zakup({ sklep: 'erli_inny', oferta: 'druga' });
  zakup();
  ruch(1, -3);
  ruch(1, 5, T2);
  db.prepare(`INSERT INTO stan_pollera (sklep, ostatni_przebieg_at, ostatni_blad, ostatni_blad_rodzaj)
    VALUES (?, ?, ?, ?)`).run('erli_polcien', T2, 'odczyt nieudany', 'sieciowy');
  const wynik = stany.wyjasnieniaOfert(db, [wiersz()]).get(1);
  expect(wynik).toEqual({ sprzedaneOd: 2, anulowaneOd: 0, wyjasnioneKarty: 12,
    poller: { ostatniPrzebiegAt: T2, ostatniBlad: 'odczyt nieudany', ostatniBladRodzaj: 'sieciowy' } });
});

it('wyjaśnia produkt i wariant Woo, respektuje kartę z lustra przed rejestrem', () => {
  const id = zakup();
  db.prepare("UPDATE pozycje SET oferta_id = NULL, produkt_id = '100', wariant_id = '101' WHERE zamowienie_id = ?").run(id);
  powiazProdukt(db, zapiszProduktSklepowy(db, { kanal: 'erli_polcien', produkt_id: '100', wariant_id: '101',
    nazwa: 'Lampa Półcień', odczytane_at: T0 }), 2);
  const wynik = stany.wyjasnieniaOfert(db, [wiersz(2, { idZewnetrzne: '100/101', regula: 'zmienione' })]).get(2);
  expect(wynik).toMatchObject({ sprzedaneOd: 2, anulowaneOd: 0, wyjasnioneKarty: 2 });
});

it('kontynuacja po ponad 20 przełączeniach nadal znajduje poprzednią granicę', () => {
  expect(stany.stanKontynuacji(db)).toBeNull();
  for (let i = 0; i < 24; i++) {
    stany.przelaczStany(db, { wlacz: false, at: T1 });
    stany.przelaczStany(db, { wlacz: true, at: T2 });
  }
  stany.zapiszOtwarcie(db, { kartaId: 1, ilosc: 3, zrodlo: 'kanal', at: T2 });
  stany.przelaczStany(db, { wlacz: false, at: T3 });
  expect(stany.stanKontynuacji(db).stany.get(1).stan).toBe(3);
});

it('wiersz bez prawidłowego od (pierwsza wysyłka) dostaje zerowe wyjaśnienie i nie wywraca partii', () => {
  zakup();
  zakup({ oferta: 'oferta-2' });
  let wynik;
  expect(() => { wynik = stany.wyjasnieniaOfert(db, [wiersz(), wiersz(2, { od: null }), wiersz(3, { od: 'nie-data' })]); }).not.toThrow();
  expect(wynik.get(1)).toMatchObject({ sprzedaneOd: 2 });
  expect(wynik.get(2)).toMatchObject({ sprzedaneOd: 0, anulowaneOd: 0, wyjasnioneKarty: 0 });
  expect(wynik.get(3)).toMatchObject({ sprzedaneOd: 0, anulowaneOd: 0 });
});

it('D54 ERLI/Allegro: zamówienie złożone po T liczy się do S także anulowane i nieopłacone', () => {
  zakup({ anulowane: 1, zmienione: T2 });
  zakup();
  const wynik = stany.wyjasnieniaOfert(db, [wiersz()]).get(1);
  expect(wynik).toMatchObject({ sprzedaneOd: 4, anulowaneOd: 2 });
});

it('otwarcie odmawia, gdy karta ma już ruch otwarcia od granicy (import PRZ-091) — bez wiersza stany_otwarcia', () => {
  const { granica } = stany.przelacznikStanow(db);
  stany.dodajRuch(db, { kartaId: 1, rodzaj: 'otwarcie', ilosc: 5, klucz: `otwarcie:1:${granica}`, at: T1 });
  expect(() => stany.zapiszOtwarcie(db, { kartaId: 1, ilosc: 9, zrodlo: 'kanal', at: T1 })).toThrow(/stan otwarcia/);
  const m = stany.migawkaStanow(db);
  expect(m.otwarcia.has(1)).toBe(false);
  expect(m.stany.get(1).stan).toBe(5);
  // Klucz ruchu zajęty innym ruchem — ruch otwarcia nie wchodzi, więc i wiersz otwarcia się cofa.
  stany.dodajRuch(db, { kartaId: 2, rodzaj: 'przyjecie', ilosc: 4, klucz: `otwarcie:2:${granica}`, at: T1 });
  expect(() => stany.zapiszOtwarcie(db, { kartaId: 2, ilosc: 9, zrodlo: 'kanal', at: T1 })).toThrow();
  expect(stany.migawkaStanow(db).otwarcia.has(2)).toBe(false);
});

it('import bez tabeli stany_otwarcia odrzuca tylko linię z zerem, resztę zapisuje', () => {
  db.exec('DROP TABLE stany_otwarcia');
  let w;
  expect(() => { w = stany.zapiszImportOtwarcia(db, 'PP-LAMPA-1;5\nPP-LAMPA-2;0', { at: T1 }); }).not.toThrow();
  expect(w.zapisane).toBe(1);
  expect(w.odrzucone).toEqual([expect.objectContaining({ wiersz: 2 })]);
  expect(stany.podgladImportuOtwarcia(db, 'PP-LAMPA-3;0').doZapisu).toEqual([]);
  expect(db.prepare('SELECT COUNT(*) n FROM ruchy_magazynowe').get().n).toBe(1);
});
