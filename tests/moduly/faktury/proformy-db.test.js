import { potwierdzOdmoweHistorycznegoSchema } from '../../pomoc/baseline-historyczne.js';
import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import {
  zapiszProforme, proformyZamowienia, pobierzProforme, uniewaznijPoprzednie, nastepnyNumer, usunProforme,
} from '../../../src/moduly/faktury/db/proformy.js';

const nowaBaza = () => openOmsDb(':memory:');
const plikBazy = () => join(mkdtempSync(join(tmpdir(), 'oms-proformy-')), 'oms.sqlite');

const wstawZamowienie = (db, id = 1) => db.prepare(
  'INSERT INTO zamowienia (id, sklep, zrodlo_id, numer, kwota_brutto, utworzone_at)'
  + " VALUES (?, 'pro', ?, ?, '654.00', '2026-08-04T10:00:00.000Z')",
).run(id, id, String(id));

// Surowy INSERT — UDAJE drugi panel, ktory policzyl numer na wlasna reke. Testy wyscigu
// i indeksow musza wstawiac wiersz Z POMINIECIEM `zapiszProforme`, bo to wlasnie ona jest
// tu badana: gdyby wstawialy przez nia, sprawdzalyby wylacznie, ze umie liczyc do dwoch.
const wstawWprost = (db, { zamowienieId = 1, numer, rok, miesiac, kolejny, kwota = '654.00' }) =>
  db.prepare(
    'INSERT INTO proformy (zamowienie_id, numer, rok, miesiac, kolejny, kwota_brutto, utworzona_at)'
    + " VALUES (?,?,?,?,?,?,'2026-08-04T10:00:00.000Z')",
  ).run(zamowienieId, numer, rok, miesiac, kolejny, kwota);

describe('tabela proformy', () => {
  it('istnieje po otwarciu bazy', () => {
    const db = nowaBaza();
    const t = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
    expect(t).toContain('proformy');
  });

  // ⚠️ Baza produkcyjna zyje na NAS-ie i schema.sql wykonuje sie przy KAZDYM otwarciu
  // (CREATE TABLE IF NOT EXISTS), wiec tabela ma dojechac takze do bazy zalozonej wczesniej,
  // bez niej — i to bez przebudowywania czegokolwiek, co juz tam stoi.
  it('dokłada się do istniejącej bazy i nie kasuje jej danych', () => {
    // Wyjątek zatwierdzony przez właściciela 2026-09-30: odmowa niezgodnego baseline + prawidłowe reopen.
    potwierdzOdmoweHistorycznegoSchema(["DROP TABLE proformy"], ['proformy']);
    const plik = plikBazy();
    const pierwsza = openOmsDb(plik);
    wstawZamowienie(pierwsza);
    pierwsza.close();

    const druga = openOmsDb(plik);
    const t = druga.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
    expect(t).toContain('proformy');
    expect(druga.prepare('SELECT COUNT(*) c FROM zamowienia').get().c).toBe(1);
    druga.close();
  });

  // Proforma bez zamowienia jest dokumentem donikad — kaskada trzyma to samo, co przy
  // pozycjach, wplatach i przesylkach.
  it('kasuje się razem z zamówieniem (ON DELETE CASCADE)', () => {
    const db = nowaBaza();
    wstawZamowienie(db);
    zapiszProforme(db, 1, { kwotaBrutto: '654.00', rok: 2026, miesiac: 8 });
    db.prepare('DELETE FROM zamowienia WHERE id = 1').run();
    expect(db.prepare('SELECT COUNT(*) c FROM proformy').get().c).toBe(0);
  });
});

describe('nastepnyNumer', () => {
  it('pierwsza proforma miesiąca ma licznik 1', () => {
    const db = nowaBaza();
    expect(nastepnyNumer(db, 2026, 8)).toMatchObject({ rok: 2026, miesiac: 8, kolejny: 1, numer: 'PF/1/08/2026' });
  });

  it('licznik rośnie w obrębie miesiąca', () => {
    const db = nowaBaza();
    wstawZamowienie(db);
    wstawWprost(db, { numer: 'PF/1/08/2026', rok: 2026, miesiac: 8, kolejny: 1 });
    wstawWprost(db, { numer: 'PF/2/08/2026', rok: 2026, miesiac: 8, kolejny: 2 });
    expect(nastepnyNumer(db, 2026, 8).kolejny).toBe(3);
  });

  // ⚠️ LICZNIK ZERUJE SIE CO MIESIAC — dokladnie jak w serii Apilo. Licznik ciagly
  // przez caly rok dawalby inne numery niz dokumenty, ktore klienci juz maja.
  it('nowy miesiąc zaczyna od 1', () => {
    const db = nowaBaza();
    wstawZamowienie(db);
    wstawWprost(db, { numer: 'PF/1/08/2026', rok: 2026, miesiac: 8, kolejny: 1 });
    wstawWprost(db, { numer: 'PF/2/08/2026', rok: 2026, miesiac: 8, kolejny: 2 });
    expect(nastepnyNumer(db, 2026, 9)).toMatchObject({ kolejny: 1, numer: 'PF/1/09/2026' });
  });

  it('ten sam miesiąc innego roku ma własny licznik', () => {
    const db = nowaBaza();
    wstawZamowienie(db);
    wstawWprost(db, { numer: 'PF/1/08/2026', rok: 2026, miesiac: 8, kolejny: 1 });
    expect(nastepnyNumer(db, 2027, 8).kolejny).toBe(1);
  });

  // ⚠️ NUMER RAZ NADANY JEST SPALONY, takze gdy dokument uniewazniono. Klient dostal PDF
  // z tym numerem na maila i moze go miec przed soba — drugi dokument o tym samym numerze
  // znaczylby dwie rozne kwoty pod jednym tytulem przelewu.
  it('unieważniona proforma nadal zajmuje swój numer', () => {
    const db = nowaBaza();
    wstawZamowienie(db);
    const p = zapiszProforme(db, 1, { kwotaBrutto: '654.00', rok: 2026, miesiac: 8 });
    uniewaznijPoprzednie(db, 1);
    expect(pobierzProforme(db, p.id).uniewazniona_at).toBeTruthy();
    expect(nastepnyNumer(db, 2026, 8).kolejny).toBe(2);
  });

  // ⚠️ TEST NA `MAX` ZAMIAST `COUNT(*)`, I DOPIERO SKASOWANIE WIERSZA GO SPRAWDZA.
  // Test wyzej (uniewaznienie) NIE odroznia obu wariantow: uniewaznienie ZOSTAWIA wiersz,
  // wiec `COUNT` i `MAX` daja w nim to samo — asercja jest tam prawdziwa z definicji.
  //
  // Rozjazd jest realny: `usunProforme` (sprzatanie po awarii zapisu pliku) kasuje wiersz,
  // tak samo `ON DELETE CASCADE`. Gdy znika wiersz o NIZSZYM liczniku — a tak wyglada
  // typowy dzien: zamowienie A dostaje numer 1, zamowienie B numer 2, zapis pliku dla A pada
  // — `COUNT(*)` cofa licznik na juz zajety numer i KAZDY kolejny INSERT odbija sie od
  // indeksu `proformy_kolejny`. Operator nie wystawilby ani jednej proformy do konca miesiaca.
  it('skasowany wiersz o NIŻSZYM numerze nie cofa licznika (MAX, nie COUNT)', () => {
    const db = nowaBaza();
    wstawZamowienie(db);
    const a = zapiszProforme(db, 1, { kwotaBrutto: '654.00', rok: 2026, miesiac: 8 });
    const b = zapiszProforme(db, 1, { kwotaBrutto: '700.00', rok: 2026, miesiac: 8 });
    expect([a.kolejny, b.kolejny]).toEqual([1, 2]);

    // Zamowieniu A nie udalo sie zapisac pliku — wiersz znika, numer 2 dalej jest u klienta.
    usunProforme(db, a.id);

    expect(db.prepare('SELECT COUNT(*) c FROM proformy').get().c).toBe(1);
    expect(nastepnyNumer(db, 2026, 8).kolejny).toBe(3);
  });

  // Ta sama dziura, tylko wpuszczona inna droga: kaskada po skasowaniu zamowienia.
  // Numer proformy, ktora poszla do klienta, nie ma prawa wrocic do puli tylko dlatego,
  // ze ktos skasowal CUDZE zamowienie.
  it('proforma skasowana kaskadą razem z zamówieniem też nie cofa licznika', () => {
    const db = nowaBaza();
    wstawZamowienie(db, 1);
    wstawZamowienie(db, 2);
    zapiszProforme(db, 1, { kwotaBrutto: '100.00', rok: 2026, miesiac: 8 });
    zapiszProforme(db, 2, { kwotaBrutto: '200.00', rok: 2026, miesiac: 8 });

    db.prepare('DELETE FROM zamowienia WHERE id = 1').run();

    expect(nastepnyNumer(db, 2026, 8).kolejny).toBe(3);
  });
});

describe('zapiszProforme', () => {
  it('zapisuje wiersz z numerem i rozbiciem numeru na kolumny', () => {
    const db = nowaBaza();
    wstawZamowienie(db);
    const p = zapiszProforme(db, 1, { kwotaBrutto: '654.00', plikSciezka: '/dane/pf-1.pdf', rok: 2026, miesiac: 8 });
    expect(p).toMatchObject({
      zamowienie_id: 1,
      numer: 'PF/1/08/2026',
      rok: 2026,
      miesiac: 8,
      kolejny: 1,
      kwota_brutto: '654.00',
      plik_sciezka: '/dane/pf-1.pdf',
      uniewazniona_at: null,
    });
    expect(p.utworzona_at).toBeTruthy();
  });

  it('kolejne wywołanie dostaje następny numer', () => {
    const db = nowaBaza();
    wstawZamowienie(db);
    const pierwsza = zapiszProforme(db, 1, { kwotaBrutto: '654.00', rok: 2026, miesiac: 8 });
    const druga = zapiszProforme(db, 1, { kwotaBrutto: '700.00', rok: 2026, miesiac: 8 });
    expect(pierwsza.numer).toBe('PF/1/08/2026');
    expect(druga.numer).toBe('PF/2/08/2026');
  });

  // Rok i miesiac maja wyjsc z JEDNEGO odczytu zegara, a nie z dwoch: na przelomie miesiaca
  // dwa niezalezne odczyty daja numer z sierpnia w licznikiem wrzesniowym.
  it('bez podanego roku i miesiąca bierze je ze znacznika czasu', () => {
    const db = nowaBaza();
    wstawZamowienie(db);
    const p = zapiszProforme(db, 1, { kwotaBrutto: '654.00', utworzonaAt: '2026-12-31T23:30:00.000Z' });
    expect(p.numer).toBe(`PF/1/${String(p.miesiac).padStart(2, '0')}/${p.rok}`);
    expect(p.utworzona_at).toBe('2026-12-31T23:30:00.000Z');
  });

  // ⚠️ KWOTA JEST MIGAWKA Z CHWILI WYSTAWIENIA. Dokument poszedl do klienta i zyje juz
  // wlasnym zyciem — pozniejsza zmiana pozycji zamowienia nie ma prawa przepisac kwoty
  // na wystawionej proformie, bo klient przelewa to, co ma na papierze.
  it('kwota_brutto to migawka — zmiana zamówienia jej nie rusza', () => {
    const db = nowaBaza();
    wstawZamowienie(db);
    const p = zapiszProforme(db, 1, { kwotaBrutto: '654.00', rok: 2026, miesiac: 8 });

    db.prepare("UPDATE zamowienia SET kwota_brutto = '999.00' WHERE id = 1").run();
    db.prepare(
      "INSERT INTO pozycje (zamowienie_id, nazwa, ilosc, cena_brutto, zrodlo) VALUES (1, 'Dopłata', 1, '345.00', 'reczna')",
    ).run();

    expect(pobierzProforme(db, p.id).kwota_brutto).toBe('654.00');
  });

  // Ta sama lekcja, co przy wplatach okresu: `String(kwota)` na `undefined` zapisywalo
  // w bazie napis „undefined", ktorego zaden pozniejszy odczyt juz nie sparsuje — a wiersz
  // z numerem z serii zostawal w bazie na zawsze.
  it('odmawia zapisu kwoty, której nie da się odczytać', () => {
    const db = nowaBaza();
    wstawZamowienie(db);
    expect(() => zapiszProforme(db, 1, { kwotaBrutto: undefined, rok: 2026, miesiac: 8 })).toThrow();
    expect(db.prepare('SELECT COUNT(*) c FROM proformy').get().c).toBe(0);
  });
});

// ⚠️ WYSCIG O NUMER. Dwa klikniecia „Wystaw proforme" w tej samej sekundzie licza ten sam
// „nastepny" numer, jesli odczyt licznika i zapis nie stoja w JEDNEJ transakcji. Indeks
// UNIQUE (rok, miesiac, kolejny) jest DRUGA siatka, nie pierwsza.
describe('wyścig o numer', () => {
  it('nastepnyNumer i INSERT idą w jednej transakcji, w tej kolejności', () => {
    const prawdziwa = nowaBaza();
    wstawZamowienie(prawdziwa);
    const sql = [];
    // Podsluchana baza: przepuszcza wszystko do prawdziwej, ale zapisuje kolejnosc zapytan.
    // Sprawdzamy ZACHOWANIE (co i w jakiej kolejnosci poszlo do bazy), a nie ksztalt kodu.
    const db = {
      prepare: (s) => { sql.push(s); return prawdziwa.prepare(s); },
      exec: (s) => { sql.push(s); return prawdziwa.exec(s); },
    };

    zapiszProforme(db, 1, { kwotaBrutto: '654.00', rok: 2026, miesiac: 8 });

    const gdzie = (re) => sql.findIndex((s) => re.test(s));
    const start = gdzie(/^\s*BEGIN/i);
    const odczyt = gdzie(/SELECT[\s\S]*FROM\s+proformy/i);
    const zapis = gdzie(/INSERT\s+INTO\s+proformy/i);
    const koniec = gdzie(/^\s*COMMIT/i);

    expect(start).toBeGreaterThanOrEqual(0);
    // Transakcja MUSI byc IMMEDIATE: zwykle BEGIN bierze blokade zapisu dopiero przy
    // INSERT-cie, czyli PO odczytaniu licznika — a to jest dokladnie to okno, ktorego
    // ta transakcja ma nie zostawiac.
    expect(sql[start]).toMatch(/BEGIN\s+IMMEDIATE/i);
    expect(start).toBeLessThan(odczyt);
    expect(odczyt).toBeLessThan(zapis);
    expect(zapis).toBeLessThan(koniec);
  });

  // Realny wyscig: dwa polaczenia (dwa procesy panelu — kontener i jego bliźniak po
  // restarcie) czytaja licznik w tej samej chwili i oba widza to samo.
  it('dwa panele liczą ten sam numer — bazę przechodzi tylko jeden', () => {
    const plik = plikBazy();
    const a = openOmsDb(plik);
    const b = openOmsDb(plik);
    wstawZamowienie(a);

    const nA = nastepnyNumer(a, 2026, 8);
    const nB = nastepnyNumer(b, 2026, 8);
    expect(nB.kolejny).toBe(nA.kolejny);

    wstawWprost(a, { numer: nA.numer, rok: nA.rok, miesiac: nA.miesiac, kolejny: nA.kolejny });
    expect(() => wstawWprost(b, { numer: nB.numer, rok: nB.rok, miesiac: nB.miesiac, kolejny: nB.kolejny }))
      .toThrow(/UNIQUE/i);

    a.close();
    b.close();
  });

  // ⚠️ TEST NA INDEKS `UNIQUE (rok, miesiac, kolejny)` SAM W SOBIE. Numer jest tu INNY,
  // wiec indeks na `numer` nie ma prawa nic zlapac — gdyby ograniczenie na trojce
  // (rok, miesiac, kolejny) znikneło, ten wiersz wjechalby do bazy i seria mialaby dziure
  // po numerze, ktorego nikt juz nie policzy.
  it('indeks (rok, miesiac, kolejny) odrzuca duplikat licznika nawet przy innym numerze', () => {
    const db = nowaBaza();
    wstawZamowienie(db);
    wstawWprost(db, { numer: 'PF/1/08/2026', rok: 2026, miesiac: 8, kolejny: 1 });
    expect(() => wstawWprost(db, { numer: 'PF/1/08/2026 (kopia)', rok: 2026, miesiac: 8, kolejny: 1 }))
      .toThrow(/UNIQUE/i);
  });

  it('indeks na numerze odrzuca drugi dokument o tym samym numerze', () => {
    const db = nowaBaza();
    wstawZamowienie(db);
    wstawWprost(db, { numer: 'PF/1/08/2026', rok: 2026, miesiac: 8, kolejny: 1 });
    expect(() => wstawWprost(db, { numer: 'PF/1/08/2026', rok: 2026, miesiac: 8, kolejny: 2 }))
      .toThrow(/UNIQUE/i);
  });

  // Pozytywna strona tej samej reguly: zapis przez `zapiszProforme` na drugim polaczeniu
  // liczy numer PO zajeciu blokady zapisu, wiec numeru nie powiela.
  it('drugie połączenie zapisujące przez zapiszProforme dostaje kolejny numer', () => {
    const plik = plikBazy();
    const a = openOmsDb(plik);
    const b = openOmsDb(plik);
    wstawZamowienie(a);

    const pierwsza = zapiszProforme(a, 1, { kwotaBrutto: '654.00', rok: 2026, miesiac: 8 });
    const druga = zapiszProforme(b, 1, { kwotaBrutto: '654.00', rok: 2026, miesiac: 8 });
    expect(pierwsza.numer).toBe('PF/1/08/2026');
    expect(druga.numer).toBe('PF/2/08/2026');

    a.close();
    b.close();
  });
});

describe('proformyZamowienia i pobierzProforme', () => {
  it('oddaje proformy jednego zamówienia, najstarsze pierwsze', () => {
    const db = nowaBaza();
    wstawZamowienie(db, 1);
    wstawZamowienie(db, 2);
    const p1 = zapiszProforme(db, 1, { kwotaBrutto: '654.00', rok: 2026, miesiac: 8 });
    const p2 = zapiszProforme(db, 1, { kwotaBrutto: '700.00', rok: 2026, miesiac: 8 });
    zapiszProforme(db, 2, { kwotaBrutto: '100.00', rok: 2026, miesiac: 8 });

    const lista = proformyZamowienia(db, 1);
    expect(lista.map((p) => p.id)).toEqual([p1.id, p2.id]);
  });

  it('zamówienie bez proform ma pustą listę, nie null', () => {
    const db = nowaBaza();
    wstawZamowienie(db);
    expect(proformyZamowienia(db, 1)).toEqual([]);
  });

  it('pobierzProforme oddaje wiersz po id, a nieistniejące id daje null', () => {
    const db = nowaBaza();
    wstawZamowienie(db);
    const p = zapiszProforme(db, 1, { kwotaBrutto: '654.00', rok: 2026, miesiac: 8 });
    expect(pobierzProforme(db, p.id).numer).toBe('PF/1/08/2026');
    expect(pobierzProforme(db, 9999)).toBeNull();
  });
});

// ⚠️ DWIE WAZNE PROFORMY NARAZ TO KLIENT PLACACY WEDLUG STAREJ KWOTY. Dlatego
// uniewaznienie jest automatyczne przy wystawieniu kolejnej, a nie recznym przyciskiem.
describe('uniewaznijPoprzednie', () => {
  it('unieważnia wszystkie proformy zamówienia poza wskazaną', () => {
    const db = nowaBaza();
    wstawZamowienie(db);
    const p1 = zapiszProforme(db, 1, { kwotaBrutto: '654.00', rok: 2026, miesiac: 8 });
    const p2 = zapiszProforme(db, 1, { kwotaBrutto: '700.00', rok: 2026, miesiac: 8 });

    uniewaznijPoprzednie(db, 1, p2.id);

    expect(pobierzProforme(db, p1.id).uniewazniona_at).toBeTruthy();
    expect(pobierzProforme(db, p2.id).uniewazniona_at).toBeNull();
  });

  // Bez wskazanej „tej aktualnej" uniewaznia wszystkie — potrzebne przy recznym wycofaniu
  // omylkowej proformy, gdy nie ma zadnej nastepnej.
  it('bez wskazanej proformy unieważnia wszystkie', () => {
    const db = nowaBaza();
    wstawZamowienie(db);
    const p1 = zapiszProforme(db, 1, { kwotaBrutto: '654.00', rok: 2026, miesiac: 8 });
    uniewaznijPoprzednie(db, 1);
    expect(pobierzProforme(db, p1.id).uniewazniona_at).toBeTruthy();
  });

  // Data uniewaznienia jest sladem CHWILI decyzji — powtorne wywolanie nie ma prawa
  // przestemplowac dokumentu, ktory uniewazniono tydzien temu.
  it('nie przestempluje już unieważnionej', () => {
    const db = nowaBaza();
    wstawZamowienie(db);
    const p1 = zapiszProforme(db, 1, { kwotaBrutto: '654.00', rok: 2026, miesiac: 8 });
    uniewaznijPoprzednie(db, 1, null, { teraz: '2026-08-04T10:00:00.000Z' });
    uniewaznijPoprzednie(db, 1, null, { teraz: '2026-08-11T10:00:00.000Z' });
    expect(pobierzProforme(db, p1.id).uniewazniona_at).toBe('2026-08-04T10:00:00.000Z');
  });

  // Granica wlasnosci: proforma innego zamowienia to inny klient i inne pieniadze.
  it('nie rusza proform innego zamówienia', () => {
    const db = nowaBaza();
    wstawZamowienie(db, 1);
    wstawZamowienie(db, 2);
    const obca = zapiszProforme(db, 2, { kwotaBrutto: '100.00', rok: 2026, miesiac: 8 });
    zapiszProforme(db, 1, { kwotaBrutto: '654.00', rok: 2026, miesiac: 8 });

    uniewaznijPoprzednie(db, 1);

    expect(pobierzProforme(db, obca.id).uniewazniona_at).toBeNull();
  });
});
