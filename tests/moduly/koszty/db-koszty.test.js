import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import {
  zapiszKoszt, kosztyMiesiaca, wczytajKursor, zapiszKursor, zapiszBladPobrania, zapiszSciezki,
  stanKosztow, zapiszOdrzuconyKoszt, odrzuconeKoszty, liczbaOdrzuconych, usunOdrzucony,
  kosztyBezArchiwum, zapiszRecznyKoszt, kosztyOtrzymaneWMiesiacu, odrzuconeWMiesiacu,
} from '../../../src/oms/db/koszty.js';
import {
  kategoriaDlaNip, przypnijKategorie, wszystkieKategorie,
} from '../../../src/oms/db/kategorie-kosztow.js';
import { grosze } from '../../../src/domena/kwoty.js';
import { naWierszReczny } from '../../../src/domena/koszt-reczny.js';

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite');

// ⚠️ KWOTY SĄ NAPISAMI — tak, jak oddaje je `naWiersz` i tak, jak trzyma je kolumna TEXT.
// Ten kształt to nie preferencja zapisu w teście: liczba w tym miejscu przeszłaby przez
// SQLite bez słowa (kolumna o powinowactwie tekstowym przyjmie 123 i odda '123'), więc
// gdyby test podawał liczby, nie sprawdzałby niczego z tego, co robi prawdziwa ścieżka.
const wiersz = (nadpisz = {}) => ({
  ksefNumber: 'K-1', numerDokumentu: 'FV/1', sprzedawcaNip: '5252674798',
  sprzedawcaNazwa: 'Allegro', dataWystawienia: '2026-06-05',
  dataTrwalegoZapisu: '2026-06-05T14:00:00Z', netto: '100.00', vat: '23.00', brutto: '123.00',
  waluta: 'PLN', rodzaj: 'Vat', maZalacznik: 0, ...nadpisz,
});

// Firma reczna testowa — sam ksztalt slownika firm (db/firmy-reczne.js), potrzebny
// wylacznie do zlozenia poprawnego wiersza przez `naWierszReczny`.
const FIRMA_RECZNA = {
  nazwa: 'Google', sprzedawca: 'Google Ireland Limited', kategoria: 'Reklama', typ: 'zmienny',
};
const wierszReczny = (nadpisz = {}) => naWierszReczny(
  { dataWystawienia: '2026-08-06', kwota: '200.00', ...nadpisz },
  FIRMA_RECZNA,
);

// Baza PLIKOWA (nie `:memory:`) — jedyny sposob, zeby zamknac ja i otworzyc PONOWNIE,
// czyli zeby test w ogole zobaczyl zachowanie migracji. Katalog swiezy przy kazdym
// wywolaniu, tak samo jak w tests/oms/backfill-indywidualne.test.js.
const plikBazy = () => join(mkdtempSync(join(tmpdir(), 'oms-koszty-')), 'oms.sqlite');

describe('tabela kosztow', () => {
  it('pierwszy zapis oddaje true, powtorzony false i NIE tworzy dubletu', () => {
    const db = openOmsDb();
    expect(zapiszKoszt(db, wiersz())).toBe(true);
    expect(zapiszKoszt(db, wiersz())).toBe(false);
    expect(db.prepare('SELECT COUNT(*) c FROM koszty').get().c).toBe(1);
  });

  it('powtorzony zapis NIE kasuje sciezek archiwum dopisanych pozniej', () => {
    const db = openOmsDb();
    zapiszKoszt(db, wiersz());
    db.prepare('UPDATE koszty SET sciezka_xml = ? WHERE ksef_number = ?').run('/x/a.xml', 'K-1');
    zapiszKoszt(db, wiersz());
    expect(db.prepare('SELECT sciezka_xml s FROM koszty WHERE ksef_number = ?').get('K-1').s).toBe('/x/a.xml');
  });

  // ⚠️⚠️ KOLUMNY KWOT SĄ TEXT-em, NIE REAL-em — niezmiennik 4.5 („co do grosza, na liczbach
  // całkowitych"). Pilnuje tego sam SCHEMAT, bo kolumna `REAL` nie protestuje: przyjmie napis
  // '1067.00' i cicho odda z powrotem liczbę 1067, a wtedy suma miesiąca liczyłaby się na
  // floatach mimo poprawnego kodu wyżej. Dlatego test pyta o DEKLAROWANY TYP, a nie tylko
  // o to, co wróciło z jednego odczytu.
  it('kwoty leza w bazie jako TEXT i wracaja jako napisy', () => {
    const db = openOmsDb();
    const typy = Object.fromEntries(
      db.prepare('PRAGMA table_info(koszty)').all().map((k) => [k.name, k.type]),
    );
    expect([typy.netto, typy.vat, typy.brutto]).toEqual(['TEXT', 'TEXT', 'TEXT']);

    zapiszKoszt(db, wiersz({ netto: '1067.00', vat: '245.41', brutto: '1312.41' }));
    const w = db.prepare('SELECT netto, vat, brutto FROM koszty WHERE ksef_number = ?').get('K-1');
    expect(w).toEqual({ netto: '1067.00', vat: '245.41', brutto: '1312.41' });
    expect(grosze(w.brutto, 'brutto')).toBe(131241);
  });

  // Suma miesiąca liczona z tego, co NAPRAWDĘ wróciło z bazy — bo to jest liczba, którą
  // zobaczy właściciel, i to ona ma się zgadzać co do grosza z zestawieniem z KSeF.
  it('suma miesiaca z bazy jest dokladna co do grosza', () => {
    const db = openOmsDb();
    const kwoty = ['1067.00', '245.41', '36.90', '12.30', '199.99', '45.67', '88.88',
      '7.77', '123.45', '64.20', '310.15', '15.99', '5.55', '46.29'];
    kwoty.forEach((brutto, i) => zapiszKoszt(db, wiersz({ ksefNumber: `K-${i}`, brutto })));
    const suma = kosztyMiesiaca(db, '2026-06')
      .reduce((acc, w) => acc + grosze(w.brutto, 'brutto'), 0);
    expect(suma).toBe(226955);
  });

  it('miesiac filtruje po dacie WYSTAWIENIA', () => {
    const db = openOmsDb();
    zapiszKoszt(db, wiersz());
    zapiszKoszt(db, wiersz({ ksefNumber: 'K-2', dataWystawienia: '2026-07-01' }));
    expect(kosztyMiesiaca(db, '2026-06').map((w) => w.ksef_number)).toEqual(['K-1']);
  });

  // ⚠️ `INSERT OR IGNORE` POŁYKA TAKŻE NARUSZENIE `NOT NULL` (recenzja, W1). Wiersz odrzucony
  // przez bazę oddawał `changes: 0`, czyli DOKŁADNIE to samo, co dokument widziany drugi raz —
  // `zapiszKoszt` mówiło wtedy „już był", czuwacz liczył zero nowych, kursor jechał dalej,
  // a dokumentu nie ma i nigdy nie będzie. Sprawdzamy każdą kolumnę `NOT NULL`, którą podaje
  // mapowanie: pominięcie choćby jednej zostawia tę samą dziurę.
  it.each(['numerDokumentu', 'dataWystawienia', 'dataTrwalegoZapisu', 'waluta', 'rodzaj'])(
    'wiersz odrzucony przez NOT NULL (%s) RZUCA, zamiast udawac „juz byl"',
    (pole) => {
      const db = openOmsDb();
      expect(() => zapiszKoszt(db, wiersz({ ksefNumber: 'K-BRAK', [pole]: null })))
        .toThrow(/K-BRAK/);
      expect(db.prepare('SELECT COUNT(*) c FROM koszty').get().c).toBe(0);
    },
  );

  // ...a prawdziwy dublet nadal ma oddawać `false`, nie rzucać — inaczej czuwacz padałby
  // przy KAŻDYM zachodzącym oknie pobrania, czyli w normalnym przebiegu.
  it('dublet nadal oddaje false — potwierdzenie nie zamienia go w blad', () => {
    const db = openOmsDb();
    zapiszKoszt(db, wiersz());
    expect(zapiszKoszt(db, wiersz())).toBe(false);
  });

  // ⚠️ ZŁY MIESIĄC MA ODMÓWIĆ, A NIE ODDAĆ PUSTĄ LISTĘ (recenzja, W2). Pusta lista czyta się
  // jak „nie było kosztów", więc literówka w adresie ekranu pokazywałaby zero złotych kosztów
  // miesiąca — liczbę, której nikt nie ma jak zakwestionować. Ta sama zasada i ten sam
  // komunikat, co przy `dokumenty()`/`proformy()` w services/faktury-widok.js.
  it.each([['2026-6'], ['06/2026'], ['2026-13'], [''], [undefined], [null]])(
    'kosztyMiesiaca(%p) odmawia zamiast oddac pusta liste',
    (zly) => {
      expect(() => kosztyMiesiaca(openOmsDb(), zly)).toThrow(/RRRR-MM/);
    },
  );

  // ⚠️ Zakres `>=`/`<=` zamiast `substr()`: łapie także datę ze ZNACZNIKIEM CZASU. Ta sama
  // pułapka, którą `substr(...,1,10)` zjadł na proformach (services/faktury-widok.js) —
  // tylko w drugą stronę: tu chodzi o dokument z ostatniego dnia miesiąca.
  it('miesiac lapie takze date ze znacznikiem czasu, i nie wciaga sasiednich', () => {
    const db = openOmsDb();
    zapiszKoszt(db, wiersz());
    zapiszKoszt(db, wiersz({ ksefNumber: 'K-30', dataWystawienia: '2026-06-30T22:30:00Z' }));
    zapiszKoszt(db, wiersz({ ksefNumber: 'K-MAJ', dataWystawienia: '2026-05-31' }));
    zapiszKoszt(db, wiersz({ ksefNumber: 'K-LIP', dataWystawienia: '2026-07-01' }));
    expect(kosztyMiesiaca(db, '2026-06').map((w) => w.ksef_number)).toEqual(['K-1', 'K-30']);
  });

  it('kursor zapisuje sie i odczytuje', () => {
    const db = openOmsDb();
    expect(wczytajKursor(db)).toBeNull();
    zapiszKursor(db, '2026-06-05T14:00:00Z');
    expect(wczytajKursor(db)).toBe('2026-06-05T14:00:00Z');
  });

  // ⚠️ Bez tego testu `zapiszBladPobrania` moglby po cichu zapisywac takze kursor (NULL
  // z klauzuli VALUES) i KAZDA pojedyncza awaria cofalaby pobieranie do podlogi historii.
  // Przy powtarzajacym sie bledzie panel mielilby te sama historie w kolko i nigdy nie
  // doszedl do biezacych dokumentow — a wygladaloby to na „dziala, tylko wolno".
  it('nieudany przebieg odklada blad, ale NIE cofa kursora', () => {
    const db = openOmsDb();
    zapiszKursor(db, '2026-06-05T14:00:00Z');
    zapiszBladPobrania(db, 'KSeF: 503');
    expect(wczytajKursor(db)).toBe('2026-06-05T14:00:00Z');
    expect(db.prepare('SELECT ostatni_blad b FROM stan_kosztow WHERE id = 1').get().b).toBe('KSeF: 503');
  });

  // ...a udany przebieg gasi slad po bledzie, ktory dawno minal — inaczej panel straszylby
  // awaria, ktorej juz nie ma.
  it('udany przebieg czysci poprzedni blad', () => {
    const db = openOmsDb();
    zapiszBladPobrania(db, 'KSeF: 503');
    zapiszKursor(db, '2026-06-06T09:00:00Z');
    expect(db.prepare('SELECT ostatni_blad b FROM stan_kosztow WHERE id = 1').get().b).toBeNull();
  });

  // ⚠️ BŁĄD BEZ ZNACZNIKA CZASU NIE MÓWI, CZY AWARIA JEST SPRZED GODZINY, CZY SPRZED TRZECH
  // TYGODNI (recenzja, D4) — a to jest cała różnica między „KSeF miał chwilową czkawkę"
  // a „panel nie pobiera kosztów od miesiąca". Znacznik gaśnie razem z błędem.
  it('blad pobrania niesie znacznik czasu, i gasnie razem z bledem', () => {
    const db = openOmsDb();
    zapiszBladPobrania(db, 'KSeF: 503');
    const po = stanKosztow(db);
    expect(po.ostatni_blad).toBe('KSeF: 503');
    expect(po.ostatni_blad_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    zapiszKursor(db, '2026-06-06T09:00:00Z');
    expect(stanKosztow(db).ostatni_blad_at).toBeNull();
  });

  // `stanKosztow` czyta ekran zakładki (pasek „ostatnie pobranie / ostatni błąd"). Bez tego
  // testu funkcja nie miała ANI JEDNEGO wywołania — także w testach (recenzja, D1).
  it('stanKosztow oddaje NULL przed pierwszym przebiegiem, potem komplet stanu', () => {
    const db = openOmsDb();
    expect(stanKosztow(db)).toBeNull();
    zapiszKursor(db, '2026-06-06T09:00:00Z');
    expect(stanKosztow(db)).toMatchObject({
      id: 1, kursor: '2026-06-06T09:00:00Z', ostatni_blad: null, ostatni_blad_at: null,
    });
    expect(stanKosztow(db).ostatnie_udane_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  // ⚠️ Zapis SAMEGO PDF-a nie ma prawa skasowac sciezki do XML-a (COALESCE, nie przypisanie).
  // XML jest oryginalem dokumentu — drugi raz z KSeF nie pobierzemy go za darmo.
  it('dopisanie PDF-a nie kasuje sciezki do XML-a', () => {
    const db = openOmsDb();
    zapiszKoszt(db, wiersz());
    zapiszSciezki(db, 'K-1', { xml: '/x/a.xml' });
    zapiszSciezki(db, 'K-1', { pdf: '/x/a.pdf' });
    const w = db.prepare('SELECT sciezka_xml x, sciezka_pdf p FROM koszty WHERE ksef_number = ?').get('K-1');
    expect(w).toEqual({ x: '/x/a.xml', p: '/x/a.pdf' });
  });
});

// ⚠️⚠️ ZMIANA TYPU KOLUMNY NIE DOCIERA PRZEZ `CREATE TABLE IF NOT EXISTS` (recenzja, W3).
//
// Poprzedni commit tej gałęzi zakładał `koszty` z kwotami REAL. Baza, która raz odpaliła
// tamten commit — a odpaliła go maszyna, na której gałąź testowano — zostaje z REAL-em
// NA ZAWSZE: schemat przechodzi obok (tabela istnieje), a lista DOLOZ w db.js dokłada
// KOLUMNY, nie typy. Kolumna REAL przyjmuje napis '1067.00' bez słowa i oddaje z powrotem
// liczbę 1067, więc cała decyzja „kwoty jako TEXT" znikałaby po cichu na tej jednej bazie.
//
// Test na DWÓCH otwarciach: pierwsze zakłada tabelę w STARYM kształcie (surowe node:sqlite,
// bo `openOmsDb` zakłada już nowy), drugie to prawdziwe otwarcie panelu.
describe('migracja kwot kosztow REAL → TEXT', () => {
  const STARA_TABELA = `
    CREATE TABLE koszty (
      ksef_number TEXT PRIMARY KEY NOT NULL,
      numer_dokumentu TEXT NOT NULL,
      sprzedawca_nip TEXT,
      sprzedawca_nazwa TEXT,
      data_wystawienia TEXT NOT NULL,
      data_trwalego_zapisu TEXT NOT NULL,
      netto REAL NOT NULL,
      vat REAL NOT NULL,
      brutto REAL NOT NULL,
      waluta TEXT NOT NULL,
      rodzaj TEXT NOT NULL,
      ma_zalacznik INTEGER NOT NULL DEFAULT 0,
      sciezka_xml TEXT,
      sciezka_pdf TEXT,
      pobrany_at TEXT NOT NULL
    )`;

  it('baza zalozona ze STARYM typem odmawia startu i zachowuje REAL, kwoty i archiwum', () => {
    const sciezka = plikBazy();
    const stara = new DatabaseSync(sciezka);
    stara.exec(STARA_TABELA);
    stara.prepare(
      'INSERT INTO koszty (ksef_number, numer_dokumentu, sprzedawca_nip, data_wystawienia,'
      + ' data_trwalego_zapisu, netto, vat, brutto, waluta, rodzaj, sciezka_xml, pobrany_at)'
      + ' VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
    ).run(
      'K-STARY', 'FV/9', '5252674798', '2026-06-05', '2026-06-05T14:00:00Z',
      1067.0, 245.41, 1312.41, 'PLN', 'Vat', '/x/stary.xml', '2026-06-05T15:00:00Z',
    );
    // Dowód, że stara baza NAPRAWDĘ trzyma tu liczby, a nie napisy:
    expect(typeof stara.prepare('SELECT brutto b FROM koszty').get().b).toBe('number');
    const schematPrzed = stara.prepare("SELECT sql FROM sqlite_master WHERE name = 'koszty'").get();
    const wierszPrzed = stara.prepare('SELECT * FROM koszty').get();
    stara.close();

    expect(() => openOmsDb(sciezka)).toThrow(/inny schemat niż baseline/);
    const db = new DatabaseSync(sciezka);
    const typy = Object.fromEntries(
      db.prepare('PRAGMA table_info(koszty)').all().map((k) => [k.name, k.type]),
    );
    expect([typy.netto, typy.vat, typy.brutto]).toEqual(['REAL', 'REAL', 'REAL']);
    expect(db.prepare("SELECT sql FROM sqlite_master WHERE name = 'koszty'").get()).toEqual(schematPrzed);

    const w = db.prepare('SELECT * FROM koszty WHERE ksef_number = ?').get('K-STARY');
    expect(w).toEqual(wierszPrzed);
    expect([w.netto, w.vat, w.brutto]).toEqual([1067, 245.41, 1312.41]);
    expect(typeof w.brutto).toBe('number');
    expect(w.sciezka_xml).toBe('/x/stary.xml');
    expect(w.numer_dokumentu).toBe('FV/9');

    db.close();
  });

  it('baza w NOWYM ksztalcie przechodzi obok migracji (idempotencja)', () => {
    const sciezka = plikBazy();
    const db1 = openOmsDb(sciezka);
    zapiszKoszt(db1, wiersz());
    zapiszSciezki(db1, 'K-1', { xml: '/x/a.xml' });
    db1.close();
    const db2 = openOmsDb(sciezka);
    const w = db2.prepare('SELECT * FROM koszty WHERE ksef_number = ?').get('K-1');
    expect([w.netto, w.brutto, w.sciezka_xml]).toEqual(['100.00', '123.00', '/x/a.xml']);
    db2.close();
  });

  // ⚠️⚠️ U1 (druga runda recenzji): `printf('%.2f', …)` NIE PROTESTUJE przy kwocie, ktora
  // nie jest liczba — `printf('%.2f', NULL)` i `printf('%.2f', 'NaN')` OBA daja '0.00'. Kod
  // sprzed poprawki K1 (koszt-metadane.js) zapisywal dla brakujacej kwoty doslowny napis
  // 'NaN', a kolumna REAL przyjmuje go jako TEXT bez slowa protestu. Taki wiersz po
  // przebudowie stawalby sie kosztem 0,00 zl, wygladalby poprawnie, wszedlby do sumy
  // miesiaca i przez `INSERT OR IGNORE` juz nigdy by sie sam nie poprawil — dokladnie ta
  // awaria, przed ktora broni K1. Przebudowa ma wiec ODMOWIC, zanim to nastapi.
  //
  // Sprawdzamy DEKLAROWANA KLASE PAMIECI (`typeof(...)`), nie sama wartosc: NULL i tekst
  // 'NaN' to dwie ROZNE drogi do tego samego cichego zera.
  describe('przebudowa odmawia przy kwocie, ktora nie jest liczba (U1)', () => {
    const STARA_TABELA_LUZNA = STARA_TABELA.replace(
      /(netto|vat|brutto) REAL NOT NULL/g,
      '$1 REAL',
    );

    it.each([
      ['NULL', null],
      ['tekst "NaN"', 'NaN'],
    ])('wiersz z %s w kwocie blokuje przebudowe czytelnym bledem', (_opis, zlaWartosc) => {
      const sciezka = plikBazy();
      const stara = new DatabaseSync(sciezka);
      stara.exec(STARA_TABELA_LUZNA);
      stara.prepare(
        'INSERT INTO koszty (ksef_number, numer_dokumentu, sprzedawca_nip, data_wystawienia,'
        + ' data_trwalego_zapisu, netto, vat, brutto, waluta, rodzaj, pobrany_at)'
        + ' VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      ).run(
        'K-USZKODZONY', 'FV/9', '5252674798', '2026-06-05', '2026-06-05T14:00:00Z',
        1067.0, 245.41, zlaWartosc, 'PLN', 'Vat', '2026-06-05T15:00:00Z',
      );
      const schematPrzed = stara.prepare("SELECT sql FROM sqlite_master WHERE name = 'koszty'").get();
      const wartosciPrzed = stara.prepare('SELECT netto, vat, brutto, typeof(brutto) typ FROM koszty').get();
      stara.close();

      // Odmowa dotyczy niezgodnego baseline; nie uruchamia starej przebudowy danych.
      expect(() => openOmsDb(sciezka)).toThrow(/inny schemat niż baseline/);

      // Baza zostaje NIETKNIETA: stara tabela ma nadal ten sam, jeden wiersz — zaden koszt
      // nie zamienil sie po cichu w zero.
      const po = new DatabaseSync(sciezka);
      expect(po.prepare('SELECT COUNT(*) c FROM koszty').get().c).toBe(1);
      expect(po.prepare("SELECT sql FROM sqlite_master WHERE name = 'koszty'").get()).toEqual(schematPrzed);
      expect(po.prepare('SELECT netto, vat, brutto, typeof(brutto) typ FROM koszty').get()).toEqual(wartosciPrzed);
      expect(po.prepare('SELECT brutto FROM koszty').get().brutto).toBe(zlaWartosc);
      po.close();
    });
  });

  // ⚠️ U3 (druga runda recenzji): `koszty_przed_przebudowa` zalegajaca w bazie (mozliwe
  // wylacznie po recznej ingerencji) ma dac czytelny blad, a nie surowe „there is already
  // another table or index with this name" z SQLite, z ktorego nie wynika ani ze to migracja
  // kosztow, ani co zrobic.
  it('zalegla tabela koszty_przed_przebudowa daje czytelny blad, nie surowy blad SQLite (U3)', () => {
    const sciezka = plikBazy();
    const stara = new DatabaseSync(sciezka);
    stara.exec(STARA_TABELA);
    stara.exec('CREATE TABLE koszty_przed_przebudowa (cokolwiek INTEGER)');
    const schematPrzed = stara.prepare("SELECT name, sql FROM sqlite_master WHERE name IN ('koszty', 'koszty_przed_przebudowa') ORDER BY name").all();
    stara.close();

    // Nie wystarczy, ze komunikat WSPOMINA nazwe tabeli — surowy blad SQLite
    // ("there is already another table or index with this name: ...") tez ja wspomina.
    // Ma tez POWIEDZIEC, co to za tabela (migracja kosztow) i co z nia zrobic (usunac albo
    // zmienic nazwe) — czego surowy blad SQLite nie mowi.
    let zlapany = null;
    try {
      openOmsDb(sciezka);
    } catch (e) {
      zlapany = e;
    }
    expect(zlapany).not.toBeNull();
    expect(zlapany.message).toMatch(/koszty_przed_przebudowa/);
    expect(zlapany.message).not.toMatch(/there is already another table or index/i);
    expect(zlapany.message).toMatch(/inny schemat niż baseline/);
    const po = new DatabaseSync(sciezka);
    expect(po.prepare("SELECT name, sql FROM sqlite_master WHERE name IN ('koszty', 'koszty_przed_przebudowa') ORDER BY name").all()).toEqual(schematPrzed);
    po.close();
  });
});

// ⚠️ TYP JEST WARTOSCIA MASZYNOWA, BEZ DIAKRYTYKOW: 'zmienny' | 'staly' | 'drobne'.
// NAZWA kategorii to co innego — ta jest tekstem dla operatora i ma pelna polszczyzne
// („Prowizje sprzedażowe", „Księgowość").
//
// Rozstrzygniecie, a nie kosmetyka: zapisany raz jako 'stały' i raz jako 'staly' ten sam
// typ rozpada sie na DWIE grupy przy liczeniu progu rentownosci — po cichu, bo obie wygladaja
// poprawnie na ekranie. Zmierzone na node:sqlite: `CHECK (typ IN ('zmienny','staly','drobne'))`
// razem z `INSERT OR IGNORE` POLYKA wiersz z 'stały' bez jednego slowa (changes = 0), wiec
// niezgodnosc kosztowalaby CZTERY z dziesieciu kategorii startowych (Ksiegowosc,
// Oprogramowanie, Telefon, Hosting i domeny) — i nikt by sie o tym nie dowiedzial.
// Stad tez licznik ponizej: dwa wyrywkowe odczyty tego nie wylapia.
describe('kategorie kosztow', () => {
  it('czysta baza nie narzuca przypisań NIP klientowi', () => {
    const db = openOmsDb();
    expect(db.prepare('SELECT COUNT(*) c FROM kategorie_kosztow').get().c).toBe(0);
    expect(kategoriaDlaNip(db, '5252674798')).toBeNull();
    expect(kategoriaDlaNip(db, '1000001141')).toBeNull();
  });

  // Zmiany wlasciciela z 2026-08-13: OVH przechodzi na „Hosting i domeny", a faktury
  // Plastics Group dostaja od razu wlasna kategorie (material wchodzi w produkt → zmienny).
  it('operator przypina OVH do „Hosting i domeny", a Plastics Group do „Materiały do produkcji"', () => {
    const db = openOmsDb();
    przypnijKategorie(db, '1000001158', 'Hosting i domeny', 'staly');
    przypnijKategorie(db, '1000001164', 'Materiały do produkcji', 'zmienny');
    expect(kategoriaDlaNip(db, '1000001158')).toEqual({ kategoria: 'Hosting i domeny', typ: 'staly' });
    expect(kategoriaDlaNip(db, '1000001164')).toEqual({ kategoria: 'Materiały do produkcji', typ: 'zmienny' });
  });

  it('nieznany NIP nie ma kategorii — i to ma byc widoczne, nie zgadniete', () => {
    expect(kategoriaDlaNip(openOmsDb(), '9999999999')).toBeNull();
  });

  it('przypiecie kategorii dziala dla wszystkich przyszlych faktur tego NIP-u', () => {
    const db = openOmsDb();
    przypnijKategorie(db, '9999999999', 'Materiały', 'zmienny');
    expect(kategoriaDlaNip(db, '9999999999')).toEqual({ kategoria: 'Materiały', typ: 'zmienny' });
  });

  // ⚠️ NIP NORMALIZUJE SIĘ PO OBU STRONACH (recenzja, D3). `nip` jest tu KLUCZEM GŁÓWNYM, więc
  // '525-267-47-98' i '5252674798' zakładałyby DWA wiersze dla jednego podatnika — a chybiony
  // odczyt nie wygląda na rozjazd zapisu, tylko na „ten NIP nie ma jeszcze kategorii".
  // Ta sama funkcja, co przy GUS-ie (`znormalizujNip` w domain/gus.js), nie druga kopia reguły.
  it.each(['5252674798', '525-267-47-98', '525 267 47 98', 'PL5252674798'])(
    'kategorie startowe trafia sie NIP-em w postaci %p',
    (jak) => {
      const db = openOmsDb();
      przypnijKategorie(db, '5252674798', 'Prowizje sprzedażowe', 'zmienny');
      expect(kategoriaDlaNip(db, jak))
        .toEqual({ kategoria: 'Prowizje sprzedażowe', typ: 'zmienny' });
    },
  );

  it('przypiecie NIP-em z myslnikami NIE zaklada drugiego wiersza tego samego podatnika', () => {
    const db = openOmsDb();
    przypnijKategorie(db, '5252674798', 'Prowizje sprzedażowe', 'zmienny');
    przypnijKategorie(db, '525-267-47-98', 'Prowizje Allegro', 'drobne');
    expect(db.prepare('SELECT COUNT(*) c FROM kategorie_kosztow').get().c).toBe(1);
    expect(kategoriaDlaNip(db, '5252674798')).toEqual({ kategoria: 'Prowizje Allegro', typ: 'drobne' });
  });

  // `wszystkieKategorie` zasila podpowiedzi przy przypinaniu. Bez tego testu nie miała ANI
  // JEDNEGO wywołania — także w testach (recenzja, D1).
  it('wszystkieKategorie oddaje pary (kategoria, typ) bez powtorzen, po nazwie', () => {
    const db = openOmsDb();
    const lista = wszystkieKategorie(db);
    // Dziesięć NIP-ów startowych, ale „Kurierzy" siedzi na dwóch z nich — DISTINCT po parze;
    // do tego dwie kategorie ze słownika, które nie mają jeszcze ANI JEDNEGO NIP-u.
    expect(lista).toHaveLength(11);
    expect(lista.filter((k) => k.kategoria === 'Kurierzy')).toEqual([{ kategoria: 'Kurierzy', typ: 'zmienny' }]);
    expect(lista[0]).toEqual({ kategoria: 'Hosting i domeny', typ: 'staly' });
    expect(lista.at(-1)).toEqual({ kategoria: 'Telefon', typ: 'staly' });
    // ...a ta sama nazwa z INNYM typem to osobna podpowiedź: para jest tu tożsamością.
    przypnijKategorie(db, '1111111111', 'Kurierzy', 'staly');
    expect(wszystkieKategorie(db).filter((k) => k.kategoria === 'Kurierzy')).toHaveLength(2);
  });

  // ⚠️⚠️ U2 (druga runda recenzji): `znormalizujNip` woloane BEZ `|| null` w obu funkcjach
  // ponizej zamienia „brak NIP-u" w pusty napis, a pusty napis JEST KLUCZEM GLOWNYM tabeli
  // `kategorie_kosztow` — sklejalby wiec ze soba WSZYSTKICH sprzedawcow bez NIP-u (`null`,
  // `undefined`, smiec bez cyfr) w jedna, wspolna kategorie.
  it('brak NIP-u nie jest kluczem — rozne braki NIP-u sie nie sklejaja (U2)', () => {
    const db = openOmsDb();
    // 'brak' normalizuje sie do pustego napisu (bez cyfr) — przypiecie kategorii bez
    // prawdziwego NIP-u nie ma prawa zalozyc wiersza.
    expect(() => przypnijKategorie(db, 'brak', 'Cos', 'zmienny')).toThrow();
    expect(kategoriaDlaNip(db, null)).toBeNull();
    expect(kategoriaDlaNip(db, undefined)).toBeNull();
    expect(kategoriaDlaNip(db, 'zupelnie inny')).toBeNull();
    // ...i zaden z powyzszych brakow nie dolozyl wiersza do tabeli.
    expect(db.prepare('SELECT COUNT(*) c FROM kategorie_kosztow').get().c).toBe(0);
  });

  it('⚠️ kategorie przezywaja ponowne otwarcie bazy (migracja chodzi przy KAZDYM starcie)', () => {
    const sciezka = plikBazy();
    const db1 = openOmsDb(sciezka);
    przypnijKategorie(db1, '1111111111', 'Wlasna', 'staly');
    // ⚠️⚠️ ZMIANA NA NIP-IE Z LISTY STARTOWEJ — I TO ONA JEST TU NAJWAZNIEJSZA. Przypiecie
    // NIP-u SPOZA listy (wyzej) przezyje restart takze przy `INSERT OR REPLACE`, bo wgranie
    // startowe w ogole go nie dotyka — czyli sam ten odczyt NIE UDOWADNIA niczego o migracji.
    // Sprawdzone mutacja: REPLACE w `wgrajKategorieStartowe` przechodzil obok testu opartego
    // wylacznie na '1111111111'. Dopiero NADPISANA kategoria startowa pokazuje, czy migracja
    // cofa wlascicielowi jego zmiane przy najblizszym starcie kontenera.
    przypnijKategorie(db1, '5252674798', 'Prowizje Allegro', 'drobne');
    db1.close();
    const db2 = openOmsDb(sciezka);
    expect(kategoriaDlaNip(db2, '1111111111')).toEqual({ kategoria: 'Wlasna', typ: 'staly' });
    // ...i migracja NIE nadpisala jej wartoscia startowa
    expect(kategoriaDlaNip(db2, '5252674798')).toEqual({ kategoria: 'Prowizje Allegro', typ: 'drobne' });
    db2.close();
  });
});

// ⚠️⚠️ SLOWNIK KATEGORII JEST CZYMS INNYM NIZ PRZYPISANIA NIP → KATEGORIA — i cala ta grupa
// testow istnieje po to, zeby te dwie rzeczy nie zrosly sie z powrotem.
//
// Lista wyboru na ekranie brala sie wczesniej z `DISTINCT` po tabeli PRZYPISAN, wiec kategoria
// bez ani jednego dostawcy nie miala jak sie na niej pojawic — a bez pojawienia sie nie miala
// jak zostac wybrana, czyli nie mogla powstac NIGDY. „Sprzęt" i „Reklama" (wlasciciel, 13.08)
// nie maja z gory znanego NIP-u i sa dokladnie tym przypadkiem.
describe('slownik kategorii kosztow', () => {
  it('⚠️ kategoria BEZ ani jednego NIP-u stoi na liscie wyboru', () => {
    const nazwy = wszystkieKategorie(openOmsDb()).map((k) => k.kategoria);
    expect(nazwy).toContain('Sprzęt');
    expect(nazwy).toContain('Reklama');
    // ...i nie ma ich w tabeli PRZYPISAN, bo nie ma czego do nich przypiac.
    const db = openOmsDb();
    expect(db.prepare("SELECT COUNT(*) c FROM kategorie_kosztow WHERE kategoria IN ('Sprzęt','Reklama')").get().c).toBe(0);
  });

  it('typy nowych kategorii sa takie, jak zdecydowal wlasciciel', () => {
    const lista = wszystkieKategorie(openOmsDb());
    expect(lista).toContainEqual({ kategoria: 'Sprzęt', typ: 'staly' });
    expect(lista).toContainEqual({ kategoria: 'Reklama', typ: 'zmienny' });
    expect(lista).toContainEqual({ kategoria: 'Materiały do produkcji', typ: 'zmienny' });
  });

  it('⚠️ kategoria bez NIP-u przezywa restart kontenera', () => {
    const sciezka = plikBazy();
    const db1 = openOmsDb(sciezka);
    db1.close();
    const db2 = openOmsDb(sciezka);
    expect(wszystkieKategorie(db2).map((k) => k.kategoria)).toContain('Sprzęt');
    db2.close();
  });

  // Pole na ekranie zostaje TEKSTOWE — nowa kategoria musi dac sie zalozyc bez wchodzenia
  // do bazy. Wpisana raz ma jednak zostac na liscie, takze wtedy, gdy operator przepnie
  // pozniej tego dostawce gdzie indziej: inaczej wlasna kategoria znika w chwili, w ktorej
  // przestaje miec dostawce, i trzeba ja wpisywac z pamieci po raz drugi.
  it('⚠️ wlasna kategoria operatora zostaje na liscie po przepieciu dostawcy gdzie indziej', () => {
    const sciezka = plikBazy();
    const db1 = openOmsDb(sciezka);
    przypnijKategorie(db1, '1111111111', 'Targi i wystawy', 'drobne');
    przypnijKategorie(db1, '1111111111', 'Reklama', 'zmienny');
    db1.close();
    const db2 = openOmsDb(sciezka);
    expect(wszystkieKategorie(db2)).toContainEqual({ kategoria: 'Targi i wystawy', typ: 'drobne' });
    db2.close();
  });
});

// ⚠️⚠️ ZMIANA NAZWY KATEGORII NIE DOCIERA PRZEZ `INSERT OR IGNORE`. Wgranie startowe dokłada
// wyłącznie to, czego w bazie NIE MA — wiersz `1000001158 → 'Hosting'`, który leży na produkcji
// od pierwszego uruchomienia modułu, przeszedłby obok każdej poprawki napisu w tablicy.
describe('migracja: „Hosting" → „Hosting i domeny"', () => {
  // Baza w stanie SPRZED zmiany: przypisanie ze starą nazwą, bez śladu po migracji.
  const bazaSprzedZmiany = () => {
    const sciezka = plikBazy();
    const db = openOmsDb(sciezka);
    przypnijKategorie(db, '1000001158', 'Hosting', 'staly');
    db.prepare('DELETE FROM migracje_jednorazowe').run();
    db.close();
    return sciezka;
  };

  it('stara nazwa w bazie produkcyjnej dostaje nowa przy najblizszym starcie', () => {
    const db = openOmsDb(bazaSprzedZmiany());
    expect(kategoriaDlaNip(db, '1000001158')).toEqual({ kategoria: 'Hosting i domeny', typ: 'staly' });
    // ...i po zmianie nie zostaje w panelu ani jedna kategoria o starej nazwie.
    expect(wszystkieKategorie(db).map((k) => k.kategoria)).not.toContain('Hosting');
    db.close();
  });

  // ⚠️ MIGRACJA JEST JEDNORAZOWA, A NIE PILNOWANIEM NAZWY PRZY KAZDYM STARCIE. Ta sama zasada,
  // co przy `INSERT OR IGNORE` we wgraniu startowym: migracja dokłada to, czego brakuje, i nie
  // cofa decyzji człowieka. Bez znacznika wykonania nazwa „Hosting" wpisana świadomie przez
  // operatora znikałaby mu przy najbliższym restarcie kontenera — po cichu i bez śladu.
  it('⚠️ po wykonaniu NIE cofa wlasnej zmiany operatora, ktory wroci do starej nazwy', () => {
    const sciezka = plikBazy();
    const db1 = openOmsDb(sciezka);
    przypnijKategorie(db1, '1000001158', 'Hosting', 'staly');
    db1.close();
    const db2 = openOmsDb(sciezka);
    expect(kategoriaDlaNip(db2, '1000001158')).toEqual({ kategoria: 'Hosting', typ: 'staly' });
    db2.close();
  });

  it('⚠️ nie rusza dostawcy, ktorego operator przypial gdzie indziej', () => {
    const sciezka = bazaSprzedZmiany();
    const db1 = openOmsDb(sciezka);
    // Operator zdążył przenieść OVH do własnej kategorii, zanim migracja się wykonała…
    db1.prepare('DELETE FROM migracje_jednorazowe').run();
    przypnijKategorie(db1, '1000001158', 'Serwery', 'staly');
    db1.close();
    const db2 = openOmsDb(sciezka);
    expect(kategoriaDlaNip(db2, '1000001158')).toEqual({ kategoria: 'Serwery', typ: 'staly' });
    db2.close();
  });
});

// ⚠️⚠️ KWARANTANNA MUSI MIEĆ WYJŚCIE (recenzja, W4). Do tej pory był tylko zapis i dwa odczyty:
// dokument raz odłożony zostawał tam NA ZAWSZE, także wtedy, gdy panel zapisał go już poprawnie
// (spotkanie ponowne w oknie zachodzącym albo poprawka mapowania). Panel twierdziłby wtedy
// bez końca, że w sumie miesiąca brakuje dokumentu, który w niej JEST — czyli dokładnie ten
// rodzaj trwale zapalonego ostrzeżenia, który przykrywa następną, prawdziwą dziurę.
describe('kwarantanna kosztow — wyjscie', () => {
  const metadane = (n) => ({ ksefNumber: `K-${n}`, invoiceNumber: `FV/${n}` });

  it('usunOdrzucony kasuje wiersz po numerze KSeF i mowi, ile skasowal', () => {
    const db = openOmsDb();
    zapiszOdrzuconyKoszt(db, metadane(1), 'brak kwoty');
    zapiszOdrzuconyKoszt(db, metadane(2), 'brak kwoty');
    expect(liczbaOdrzuconych(db)).toBe(2);

    expect(usunOdrzucony(db, 'K-1')).toBe(1);
    expect(odrzuconeKoszty(db).map((w) => w.ksef_number)).toEqual(['K-2']);
  });

  // ⚠️⚠️ KOLEJKA ARCHIWUM JEST STANEM TABELI, A NIE LISTĄ „nowych z tego przebiegu". Tylko
  // dlatego dokument, którego nie udało się zapisać na NAS-ie (albo pobrać z KSeF), wraca sam
  // przy następnym przebiegu — bez osobnej księgowości „do ponowienia". Ta sama zasada, co
  // przy liczbie w kwarantannie: stan tabeli, nie licznik przebiegu.
  it('kolejka archiwum to dokumenty BEZ sciezki XML — i tylko one', () => {
    const db = openOmsDb();
    zapiszKoszt(db, wiersz({ ksefNumber: 'K-1' }));
    zapiszKoszt(db, wiersz({ ksefNumber: 'K-2' }));
    zapiszSciezki(db, 'K-1', { xml: 'Kosztowe 2026/Czerwiec/jest.xml' });

    expect(kosztyBezArchiwum(db).map((w) => w.ksef_number)).toEqual(['K-2']);
  });

  // ⚠️ NAJNOWSZE NAJPIERW. Nocny przebieg ma zwykle kilka świeżych dokumentów i (przy
  // backfillu) setki starych; kolejność rosnąca kazałaby nowym czekać za całym zaległym
  // ogonem, czyli tygodniami. Zaległość drenuje się od końca, po budżecie na przebieg.
  it('kolejka archiwum idzie od najnowszego dokumentu', () => {
    const db = openOmsDb();
    zapiszKoszt(db, wiersz({ ksefNumber: 'K-STARY', dataWystawienia: '2026-01-09' }));
    zapiszKoszt(db, wiersz({ ksefNumber: 'K-NOWY', dataWystawienia: '2026-08-11' }));

    expect(kosztyBezArchiwum(db).map((w) => w.ksef_number)).toEqual(['K-NOWY', 'K-STARY']);
  });

  // Wiersz jedzie do `zarchiwizuj` SUROWY (kolumny snake_case) — dokładnie tak, jak czyta go
  // `kosztyMiesiaca` i `domain/lista-kosztow.js`. Drugiego mapowania na camelCase nie ma.
  it('kolejka archiwum oddaje CALY wiersz, a nie sam numer KSeF', () => {
    const db = openOmsDb();
    zapiszKoszt(db, wiersz());

    expect(kosztyBezArchiwum(db)[0]).toMatchObject({
      ksef_number: 'K-1', numer_dokumentu: 'FV/1', data_wystawienia: '2026-06-05',
      sprzedawca_nazwa: 'Allegro', sprzedawca_nip: '5252674798',
    });
  });

  // Kasowanie leci po KAŻDYM udanym zapisie kosztu, czyli w zdecydowanej większości na pustej
  // kwarantannie — i ma być wtedy ciche, a nie głośne. Numer, którego nie ma, to stan poprawny.
  it('nieznany numer i brak numeru nie ruszaja tabeli ani nie rzucaja', () => {
    const db = openOmsDb();
    zapiszOdrzuconyKoszt(db, metadane(1), 'brak kwoty');

    expect(usunOdrzucony(db, 'K-NIEMA')).toBe(0);
    expect(usunOdrzucony(db, null)).toBe(0);
    expect(usunOdrzucony(db, undefined)).toBe(0);
    expect(liczbaOdrzuconych(db)).toBe(1);
  });
});

// ⚠️⚠️ „OTRZYMANY" JEST INNA DATA NIZ „WYSTAWIONY" — kryterium biura rachunkowego
// (spec 2026-09-02). Dla dokumentu z KSeF miesiac otrzymania liczy sie po dacie TRWALEGO
// ZAPISU (nadania numeru KSeF), nie po dacie wystawienia, ktora rzadzi `kosztyMiesiaca`
// wyzej — sprzedawca wystawia fakture pod koniec miesiaca, a do KSeF trafia dopiero na
// poczatku kolejnego, i to WLASNIE TEN miesiac ma pokazac biuro w swojej paczce. Dla
// dokumentu recznego zadnej daty trwalego zapisu z KSeF nie ma (jego `data_trwalego_zapisu`
// w bazie to chwila wpisania do panelu, patrz naglowek `zapiszRecznyKoszt` wyzej w tym
// pliku), wiec otrzymanie liczy sie po dacie wystawienia.
describe('kosztyOtrzymaneWMiesiacu', () => {
  it('koszt z KSeF liczy sie po dacie TRWALEGO ZAPISU, nie wystawienia', () => {
    const db = openOmsDb();
    zapiszKoszt(db, wiersz({
      ksefNumber: 'A', dataWystawienia: '2026-07-30', dataTrwalegoZapisu: '2026-08-02T10:00:00Z',
    }));
    zapiszKoszt(db, wiersz({
      ksefNumber: 'B', dataWystawienia: '2026-08-31', dataTrwalegoZapisu: '2026-09-01T00:30:00Z',
    }));
    zapiszKoszt(db, wiersz({
      ksefNumber: 'C', dataWystawienia: '2026-08-10', dataTrwalegoZapisu: '2026-08-10T10:00:00Z',
    }));
    expect(kosztyOtrzymaneWMiesiacu(db, '2026-08').map((k) => k.ksef_number)).toEqual(['A', 'C']);
  });

  it('koszt reczny liczy sie po dacie wystawienia', () => {
    const db = openOmsDb();
    zapiszRecznyKoszt(db, wierszReczny({ dataWystawienia: '2026-08-20' }));
    expect(kosztyOtrzymaneWMiesiacu(db, '2026-08')).toHaveLength(1);
    expect(kosztyOtrzymaneWMiesiacu(db, '2026-09')).toHaveLength(0);
  });

  // ⚠️ ZLY MIESIAC MA ODMOWIC, A NIE ODDAC PUSTA LISTE — ta sama zasada, co przy
  // `kosztyMiesiaca` wyzej w tym pliku.
  it('zly miesiac = odmowa dla operatora', () => {
    expect(() => kosztyOtrzymaneWMiesiacu(openOmsDb(), '2026-8')).toThrow(/RRRR-MM/);
  });

  // ⚠️⚠️ GRANICA `PO_KONCU_DNIA` NA `data_trwalego_zapisu` — bez ogonka '~' porownanie
  // '2026-08-31T22:30:00Z' <= '2026-08-31' jest FALSZEM (napis ze znacznikiem czasu jest
  // leksykograficznie WIEKSZY), wiec dokument z ostatniego dnia miesiaca, ktory dostal numer
  // KSeF pozno wieczorem, wypadalby z paczki biura rachunkowego wlasnie tego dnia, ktorego
  // dotyczy. Trzy proby na samej granicy: ostatni dzien/pozna godzina (ma wejsc), pierwsza
  // sekunda kolejnego miesiaca (ma odpasc) i ostatnia sekunda miesiaca poprzedniego (ma odpasc).
  it('granica konca miesiaca: pozna godzina 31.08 wchodzi, 01.09 i 31.07 nie', () => {
    const db = openOmsDb();
    zapiszKoszt(db, wiersz({
      ksefNumber: 'GRANICA-W', dataWystawienia: '2026-08-31', dataTrwalegoZapisu: '2026-08-31T22:30:00Z',
    }));
    zapiszKoszt(db, wiersz({
      ksefNumber: 'GRANICA-PO', dataWystawienia: '2026-09-01', dataTrwalegoZapisu: '2026-09-01T00:00:00Z',
    }));
    zapiszKoszt(db, wiersz({
      ksefNumber: 'GRANICA-PRZED', dataWystawienia: '2026-07-31', dataTrwalegoZapisu: '2026-07-31T23:59:59Z',
    }));
    const wynik = kosztyOtrzymaneWMiesiacu(db, '2026-08');
    expect(wynik.map((k) => k.ksef_number)).toEqual(['GRANICA-W']);
    expect(wynik[0].dzien_otrzymania).toBe('2026-08-31');
  });
});

// ⚠️ KWARANTANNA MIESIACA — ILE DOKUMENTOW BIURO RACHUNKOWE NIE DOSTANIE W SWOJEJ PACZCE,
// bo panel nie umial ich zapisac jako koszt (patrz naglowek `zapiszOdrzuconyKoszt` wyzej
// w tym pliku). Miesiac liczy sie po `data_trwalego_zapisu`, bo to jedyna data, ktora
// kwarantanna zna — ten sam wiersz nie ma daty wystawienia (metadane sa surowe i niepelne,
// stad w ogole trafil do kwarantanny).
describe('odrzuconeWMiesiacu', () => {
  it('liczy kwarantanne po dacie trwalego zapisu', () => {
    const db = openOmsDb();
    zapiszOdrzuconyKoszt(
      db,
      { ksefNumber: 'Q1', invoiceNumber: 'X', permanentStorageDate: '2026-08-05T10:00:00Z' },
      'brak kwoty',
    );
    zapiszOdrzuconyKoszt(
      db,
      { ksefNumber: 'Q2', invoiceNumber: 'Y', permanentStorageDate: '2026-09-05T10:00:00Z' },
      'brak kwoty',
    );
    expect(odrzuconeWMiesiacu(db, '2026-08')).toBe(1);
  });

  it('zly miesiac = odmowa dla operatora', () => {
    expect(() => odrzuconeWMiesiacu(openOmsDb(), '2026-8')).toThrow(/RRRR-MM/);
  });

  // ⚠️ TA SAMA GRANICA `PO_KONCU_DNIA`, CO W `kosztyOtrzymaneWMiesiacu` WYZEJ — tu na
  // `data_trwalego_zapisu` wiersza kwarantanny. Dokument odlozony na bok pozno wieczorem
  // ostatniego dnia miesiaca ma nadal trafic do liczby "ile biuro nie dostanie" za TEN
  // miesiac, a nie za nastepny.
  it('granica konca miesiaca: kwarantanna z pozna godzina 31.08 liczy sie, 01.09 juz nie', () => {
    const db = openOmsDb();
    zapiszOdrzuconyKoszt(
      db,
      { ksefNumber: 'Q-GRANICA-W', invoiceNumber: 'X', permanentStorageDate: '2026-08-31T22:30:00Z' },
      'brak kwoty',
    );
    zapiszOdrzuconyKoszt(
      db,
      { ksefNumber: 'Q-GRANICA-PO', invoiceNumber: 'Y', permanentStorageDate: '2026-09-01T00:00:00Z' },
      'brak kwoty',
    );
    expect(odrzuconeWMiesiacu(db, '2026-08')).toBe(1);
  });
});
