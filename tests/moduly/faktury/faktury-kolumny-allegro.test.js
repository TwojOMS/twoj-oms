import { potwierdzOdmoweHistorycznegoSchema } from '../../pomoc/baseline-historyczne.js';
import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { rozpocznijFakture, fakturaSkasowanaWInfakcie } from '../../../src/moduly/faktury/db/faktury.js';

// Pięć kolumn łańcucha KSeF → Allegro (Plan B, Zadanie 5). ŻADNA z nich nie jest
// `ksef_status`: tamta kolumna trzyma już dwie różne rzeczy pod jedną nazwą (wewnętrzny
// stan panelu ORAZ `ksef_data` z inFaktu), a dodatkowo `fakturaSkasowanaWInfakcie`
// ODMAWIA kasowania, gdy jest niepusta — wpisanie tam numeru KSeF zmieniłoby tę odmowę
// przypadkiem. Ostatni test niżej pilnuje właśnie tego rozdziału.
const NOWE = [
  'ksef_numer',
  'ksef_sprawdzona_at',
  'allegro_invoice_id',
  'allegro_wyslana_at',
  'allegro_weryfikacja',
];

const kolumnyFaktur = (db) => db.prepare('PRAGMA table_info(faktury)').all().map((k) => k.name);

// Baza SPRZED zmiany symulowana tak samo jak w tests/oms/migracja-status-realizacji.test.js:
// zakładamy ją normalnie (schema.sql tworzy już nowe kolumny), a potem RĘCZNIE je zdejmujemy —
// czyli dokładnie taki kształt, jaki ma dzisiejsza baza produkcyjna tuż przed wdrożeniem.
function bazaBezKolumn(plik) {
  const db = openOmsDb(plik);
  for (const k of NOWE) db.exec(`ALTER TABLE faktury DROP COLUMN ${k}`);
  return db;
}

const nowyPlik = () => join(mkdtempSync(join(tmpdir(), 'oms-faktury-allegro-')), 'oms.sqlite');

function zZamowieniem(db) {
  db.prepare(
    "INSERT INTO zamowienia (sklep, zrodlo_id, numer, kwota_brutto, utworzone_at)"
    + " VALUES ('allegro_szkicownia', 1, '1', '10.00', '2026-08-06')",
  ).run();
  return db;
}

describe('kolumny faktury dla łańcucha KSeF → Allegro', () => {
  it('świeża baza ma wszystkie pięć, żadnej z wartością domyślną', () => {
    const db = openOmsDb(':memory:');
    const info = db.prepare('PRAGMA table_info(faktury)').all();
    for (const nazwa of NOWE) {
      const kolumna = info.find((k) => k.name === nazwa);
      expect(kolumna, `brak kolumny ${nazwa}`).toBeTruthy();
      // NULL ma znaczyć „jeszcze nic o tym nie wiemy" — każda wartość domyślna
      // udawałaby wiedzę, której panel nie ma.
      expect(kolumna.dflt_value, `${nazwa} ma wartość domyślną`).toBeNull();
    }
    db.close();
  });

  // ⚠️ Baza produkcyjna powstała PRZED tymi kolumnami, a `CREATE TABLE IF NOT EXISTS` jej nie
  // ruszy. Test MUSI iść na PLIKU: baza `:memory:` znika przy `close()`, więc drugie otwarcie
  // dostałoby świeży schemat i udowodniło coś zupełnie innego.
  it('STARA baza (bez tych kolumn) dostaje je migracją', () => {
    // Wyjątek zatwierdzony przez właściciela 2026-09-30: odmowa niezgodnego baseline + prawidłowe reopen.
    potwierdzOdmoweHistorycznegoSchema(["ALTER TABLE faktury DROP COLUMN ksef_numer"], ['ksef_numer']);
    const plik = nowyPlik();
    const pierwsza = openOmsDb(plik);
    for (const k of NOWE) expect(kolumnyFaktur(pierwsza)).toContain(k);
    pierwsza.close();

    // Poprawny baseline ma kolumny; oznaczenie i reopen nie zmieniają schematu.
    const druga = openOmsDb(plik);
    for (const k of NOWE) expect(kolumnyFaktur(druga)).toContain(k);
    druga.close();
  });

  // ⚠️ TO JEST TEN BŁĄD, KTÓRY POŁOŻYŁBY PRODUKCJĘ. Sama obecność kolumny w PRAGMA to za mało:
  // bez migracji czuwacz KSeF wywaliłby się na „no such column", w tle, co godzinę, i widać by
  // to było wyłącznie w logu kontenera.
  it('po migracji zapis numeru KSeF i danych z Allegro naprawdę siada w kolumnach', () => {
    // Wyjątek zatwierdzony przez właściciela 2026-09-30: odmowa niezgodnego baseline + prawidłowe reopen.
    potwierdzOdmoweHistorycznegoSchema(["ALTER TABLE faktury DROP COLUMN allegro_invoice_id"], ['allegro_invoice_id']);
    const plik = nowyPlik();
    zZamowieniem(openOmsDb(plik)).close();

    const db = openOmsDb(plik);
    rozpocznijFakture(db, 1);
    db.prepare(
      'UPDATE faktury SET ksef_numer = ?, ksef_sprawdzona_at = ?, allegro_invoice_id = ?,'
      + ' allegro_wyslana_at = ?, allegro_weryfikacja = ? WHERE zamowienie_id = 1',
    ).run(
      '1234563218-20260804-632857000005-03',
      '2026-08-06T10:00:00',
      'inv-1',
      '2026-08-06T10:01:00',
      'WAITING',
    );

    const f = db.prepare('SELECT * FROM faktury WHERE zamowienie_id = 1').get();
    expect(f.ksef_numer).toBe('1234563218-20260804-632857000005-03');
    expect(f.ksef_sprawdzona_at).toBe('2026-08-06T10:00:00');
    expect(f.allegro_invoice_id).toBe('inv-1');
    expect(f.allegro_wyslana_at).toBe('2026-08-06T10:01:00');
    expect(f.allegro_weryfikacja).toBe('WAITING');
    db.close();
  });

  it('drugie otwarcie niczego nie kasuje ani nie wywala (idempotentność)', () => {
    // Wyjątek zatwierdzony przez właściciela 2026-09-30: odmowa niezgodnego baseline + prawidłowe reopen.
    potwierdzOdmoweHistorycznegoSchema(["ALTER TABLE faktury DROP COLUMN allegro_wyslana_at"], ['allegro_wyslana_at']);
    const plik = nowyPlik();
    zZamowieniem(openOmsDb(plik)).close();

    const druga = openOmsDb(plik);
    rozpocznijFakture(druga, 1);
    druga.prepare("UPDATE faktury SET ksef_numer = 'KSEF-1' WHERE zamowienie_id = 1").run();
    druga.close();

    // Oznaczony poprawny baseline zachowuje kolumny i zapisany numer dokumentu.
    const trzecia = openOmsDb(plik);
    for (const k of NOWE) expect(kolumnyFaktur(trzecia)).toContain(k);
    expect(trzecia.prepare('SELECT ksef_numer FROM faktury WHERE zamowienie_id = 1').get().ksef_numer)
      .toBe('KSEF-1');
    trzecia.close();
  });

  // ⚠️ SEDNO ROZDZIAŁU KOLUMN — i jego GRANICA (recenzja Partii 2, K3).
  //
  // Rozdział kolumn zostaje: numer KSeF czytany przez czuwacza siada w `ksef_numer`, a
  // `ksef_status` (trzymająca DWIE różne rzeczy pod jedną nazwą) pozostaje nietknięta.
  //
  // ODMOWA KASOWANIA CZYTA JEDNAK OBIE. Do 06.08.2026 patrzyła wyłącznie na `ksef_status` —
  // czyli na dowód, którego przy ręcznej wysyłce do KSeF NIGDY NIE MA (panel dostaje tam
  // `ksef_data` z chwili wystawienia, a właściciel wysyła dokument dopiero potem). Czuwacz
  // od tej pory ZBIERA dowód, że dokument jest w KSeF, i zapisuje go do `ksef_numer` — więc
  // odmowa MUSI go widzieć. Bez tego panel wiedziałby, że dokument jest w KSeF, i dalej
  // oferował jego skasowanie: po odnotowaniu „skasowałem" zamówienie zwalnia się do
  // ponownego wystawienia i do KSeF jedzie DRUGI dokument. Nieodwracalne.
  // ⚠️ KOLUMNA `ksef_odczyt` (recenzja Partii 2, K1+W6) — dokladana TA SAMA droga, co piatka
  // wyzej, i z tego samego powodu: baza produkcyjna powstala przed nia, a `CREATE TABLE IF NOT
  // EXISTS` jej nie ruszy. Bez migracji czuwacz wywalalby sie na „no such column" co godzine,
  // w tle, a widac by to bylo wylacznie w logu kontenera.
  it('kolumnę ksef_odczyt ma świeża baza i dostaje ją STARA, migracją', () => {
    // Wyjątek zatwierdzony przez właściciela 2026-09-30: odmowa niezgodnego baseline + prawidłowe reopen.
    potwierdzOdmoweHistorycznegoSchema(["ALTER TABLE faktury DROP COLUMN ksef_odczyt"], ['ksef_odczyt']);
    const swieza = openOmsDb(':memory:');
    const kolumna = swieza.prepare('PRAGMA table_info(faktury)').all().find((k) => k.name === 'ksef_odczyt');
    expect(kolumna).toBeTruthy();
    // NULL ma znaczyc „nikt jeszcze nie pytal" — kazda wartosc domyslna udawalaby wiedze.
    expect(kolumna.dflt_value).toBeNull();
    swieza.close();

    const plik = nowyPlik();
    const pierwsza = openOmsDb(plik);
    expect(kolumnyFaktur(pierwsza)).toContain('ksef_odczyt');
    pierwsza.close();

    const druga = openOmsDb(plik);
    expect(kolumnyFaktur(druga)).toContain('ksef_odczyt');
    druga.close();
  });

  it('numer KSeF siada w ksef_numer, a ksef_status zostaje nietknięty', () => {
    const db = zZamowieniem(openOmsDb(':memory:'));
    expect(kolumnyFaktur(db)).toContain('ksef_status');

    rozpocznijFakture(db, 1);
    db.prepare(
      "UPDATE faktury SET ksef_status = NULL, numer = 'FV/1/2026', ksef_numer = 'KSEF-1'"
      + ' WHERE zamowienie_id = 1',
    ).run();

    const f = db.prepare('SELECT * FROM faktury WHERE zamowienie_id = 1').get();
    expect(f.ksef_numer).toBe('KSEF-1');
    expect(f.ksef_status).toBeNull();
    db.close();
  });

  // ⚠️ TO JEST TA POMYŁKA, KTÓREJ NIE DA SIĘ COFNĄĆ. Dokumentu, który jest w KSeF, nie kasuje
  // się — koryguje. Dowodem „jest w KSeF" jest OD TERAZ także `ksef_numer` (czuwacz), nie tylko
  // `ksef_status` (odpowiedź inFaktu z chwili wystawienia).
  it('numer KSeF w ksef_numer ODMAWIA kasowania, choć ksef_status jest pusty', () => {
    const db = zZamowieniem(openOmsDb(':memory:'));
    rozpocznijFakture(db, 1);
    db.prepare(
      "UPDATE faktury SET ksef_status = NULL, numer = 'FV/1/2026', ksef_numer = 'KSEF-1'"
      + ' WHERE zamowienie_id = 1',
    ).run();

    expect(() => fakturaSkasowanaWInfakcie(db, 1)).toThrow(/KSEF-1/);
    expect(() => fakturaSkasowanaWInfakcie(db, 1)).toThrow(/korygu/);
    // Wiersz ZOSTAJE — bez tego zamówienie zwolniłoby się do drugiego wystawienia.
    expect(db.prepare('SELECT * FROM faktury WHERE zamowienie_id = 1').get()).toBeTruthy();
    db.close();
  });
});
