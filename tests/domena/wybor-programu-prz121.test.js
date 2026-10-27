// PRZ-121.01 — wybór modułu faktur: reguła (plik > zapis > inFakt gotowy > „brak”), wartość z pliku i z zapisu,
// formularz, zdanie „faktury wyłączone” i odczyt programu dokumentu (JS i SQL) dla odmów i automatów.
import { describe, it, expect } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import {
  MODULY_FAKTUR, wyborZPliku, wybierzProgram, sprawdzFormularzWyboru, zdanieBrakuProgramu, zdanieCzekaniaNaRestart,
} from '../../src/domena/wybor-programu.js';
import {
  programDokumentu, programDokumentuSql, idDokumentuDla, czyDokumentProgramu,
} from '../../src/domena/dokument-programu.js';
import { openOmsDb } from '../../src/oms/db/db.ts';
import { wczytajWyborProgramu, zapiszWyborProgramu, usunWyborProgramu } from '../../src/oms/db/wybor-programu.js';
import { wczytajKonfiguracjeIntegracji } from '../../src/oms/db/konfiguracja-integracji.js';

const ZDANIE_USTAWIEN = 'Faktury w OMS-ie są wyłączone — w Ustawienia → Integracje → Moduł faktur wybrano „Brak”.';
const ZDANIE_PLIKU = 'Faktury w OMS-ie są wyłączone — w pliku konfiguracji jest OMS_PROGRAM_FAKTUROWY=brak.';

describe('PRZ-121.01 lista modułów faktur', () => {
  it('brak i inFakt dostępne; Fakturownia i TwojeFaktury „wkrótce”', () => {
    expect(MODULY_FAKTUR.map((m) => [m.id, m.dostepny])).toEqual([
      ['brak', true], ['infakt', true], ['fakturownia', false], ['twojefaktury', false]]);
    expect(MODULY_FAKTUR.find((m) => m.id === 'twojefaktury').etykieta).toBe('TwojeFaktury (program wbudowany)');
  });
});

describe('PRZ-121.01 OMS_PROGRAM_FAKTUROWY z pliku', () => {
  it.each([[undefined, null], ['', null], ['   ', null], ['brak', 'brak'], ['infakt', 'infakt'], [' InFakt ', 'infakt'], ['BRAK', 'brak']])(
    '%j → %j', (wartosc, wynik) => expect(wyborZPliku(wartosc)).toBe(wynik));

  it.each(['infkat', 'fakturownia', 'twojefaktury', ' Fakturownia ', 'xyz'])('„%s” → wyjątek z nazwą zmiennej i listą', (wartosc) => {
    expect(() => wyborZPliku(wartosc)).toThrow(/^OMS_PROGRAM_FAKTUROWY: .*brak albo infakt \(fakturownia, twojefaktury — wkrótce\)/);
  });

  it('moduł „wkrótce” ma inne zdanie niż literówka', () => {
    expect(() => wyborZPliku('fakturownia')).toThrow('„fakturownia” będzie dostępny wkrótce');
    expect(() => wyborZPliku('infkat')).toThrow('nieznany moduł faktur „infkat”');
  });
});

describe('PRZ-121.01 reguła wyboru', () => {
  it.each([
    // plik wygrywa nad zapisem i nad gotowym inFaktem
    [{ zPliku: 'brak', zUstawien: 'infakt', infaktGotowy: true }, { program: 'brak', zrodlo: 'plik', uwaga: null }],
    [{ zPliku: 'infakt', zUstawien: 'brak', infaktGotowy: false }, { program: 'infakt', zrodlo: 'plik', uwaga: null }],
    // zapis wygrywa nad regułą domyślną
    [{ zPliku: null, zUstawien: 'brak', infaktGotowy: true }, { program: 'brak', zrodlo: 'ustawienia', uwaga: null }],
    [{ zPliku: null, zUstawien: ' InFakt ', infaktGotowy: false }, { program: 'infakt', zrodlo: 'ustawienia', uwaga: null }],
    // bez pliku i bez zapisu: jak przed zmianą
    [{ zPliku: null, zUstawien: null, infaktGotowy: true }, { program: 'infakt', zrodlo: 'domyslny', uwaga: null }],
    [{ zPliku: null, zUstawien: null, infaktGotowy: false }, { program: 'brak', zrodlo: 'domyslny', uwaga: null }],
  ])('%j → %j', (wejscie, wynik) => expect(wybierzProgram(wejscie)).toEqual(wynik));

  it.each(['fakturownia', 'xyz', ''])('zapis „%s” → „brak” + uwaga (nie wyjątek), nawet przy gotowym inFakcie', (zapis) => {
    const w = wybierzProgram({ zPliku: null, zUstawien: zapis, infaktGotowy: true });
    expect(w.program).toBe('brak');
    expect(w.zrodlo).toBe('ustawienia');
    expect(w.uwaga).toBe(`Zapisany moduł faktur „${zapis}” nie działa w tej wersji OMS-u — faktury są wyłączone. Wybierz moduł ponownie.`);
  });

  it('domyślnie nigdy Fakturownia ani TwojeFaktury', () => {
    for (const infaktGotowy of [true, false]) {
      expect(['infakt', 'brak']).toContain(wybierzProgram({ infaktGotowy }).program);
    }
  });
});

describe('PRZ-121.01 formularz wyboru', () => {
  it.each(['brak', 'infakt', ' INFAKT '])('przyjmuje „%s”', (program) => {
    expect(sprawdzFormularzWyboru({ program })).toEqual({ ustawienia: { program: program.trim().toLowerCase() }, bledy: [] });
  });
  it.each(['fakturownia', 'twojefaktury', 'xyz', '', undefined])('odrzuca %j', (program) => {
    expect(sprawdzFormularzWyboru({ program }).bledy.length).toBe(1);
  });
});

describe('PRZ-121.01 zdanie „faktury wyłączone”', () => {
  it('jawny „brak” z pliku i z Ustawień → zdanie; z dopiskiem po spacji', () => {
    expect(zdanieBrakuProgramu(wybierzProgram({ zPliku: 'brak' }))).toBe(ZDANIE_PLIKU);
    expect(zdanieBrakuProgramu(wybierzProgram({ zUstawien: 'brak', infaktGotowy: true }))).toBe(ZDANIE_USTAWIEN);
    expect(zdanieBrakuProgramu(wybierzProgram({ zUstawien: 'brak' }), 'Nic nie poszło do programu.'))
      .toBe(`${ZDANIE_USTAWIEN} Nic nie poszło do programu.`);
  });
  it('„brak” domyślny i inFakt → null (wołający zostawia stary tekst)', () => {
    expect(zdanieBrakuProgramu(wybierzProgram({ infaktGotowy: false }))).toBeNull();
    expect(zdanieBrakuProgramu(wybierzProgram({ infaktGotowy: true }))).toBeNull();
    expect(zdanieBrakuProgramu(wybierzProgram({ zPliku: 'infakt' }))).toBeNull();
    expect(zdanieBrakuProgramu(wybierzProgram({ zUstawien: 'infakt' }))).toBeNull();
    expect(zdanieBrakuProgramu(null)).toBeNull();
  });
  it('nieznany zapis → jego uwaga', () => {
    expect(zdanieBrakuProgramu(wybierzProgram({ zUstawien: 'fakturownia' })))
      .toBe('Zapisany moduł faktur „fakturownia” nie działa w tej wersji OMS-u — faktury są wyłączone. Wybierz moduł ponownie.');
  });
  it('czekanie na restart: zdanie tylko przy różnicy, przy „brak” z automatem KSeF', () => {
    const infakt = { program: 'infakt' }; const brak = { program: 'brak' };
    expect(zdanieCzekaniaNaRestart(infakt, infakt)).toBeNull();
    expect(zdanieCzekaniaNaRestart(infakt, brak)).toBe('Zapisany moduł faktur „Brak” zadziała po ponownym uruchomieniu OMS-u — do tego czasu działa „inFakt”. Automatyczna wysyłka do KSeF już stoi.');
    expect(zdanieCzekaniaNaRestart(brak, infakt)).toBe('Zapisany moduł faktur „inFakt” zadziała po ponownym uruchomieniu OMS-u — do tego czasu faktury są wyłączone.');
    expect(zdanieCzekaniaNaRestart(brak, infakt, { gotowy: false })).toMatch(/^Zapisany moduł faktur „inFakt” nie ma klucza API/);
    expect(zdanieCzekaniaNaRestart(infakt, brak, { gotowy: false })).toMatch(/zadziała po ponownym uruchomieniu/);
  });
});

// Cztery wiersze z planu: nowy, stary (sam infakt_uuid), bez identyfikatora, `program` bez identyfikatora; plus dokument
// programu „test” (okno wycofania po PRZ-119 / szew próby).
const WIERSZE = {
  nowy: { program: 'infakt', dokument_id: 'd-1', infakt_uuid: 'd-1' },
  stary: { program: null, dokument_id: null, infakt_uuid: 'u-2' },
  bezId: { program: null, dokument_id: null, infakt_uuid: null },
  programBezId: { program: 'infakt', dokument_id: null, infakt_uuid: null },
  test: { program: 'test', dokument_id: 't-5', infakt_uuid: null },
};

describe('PRZ-121.01 program dokumentu w SQL = programDokumentu', () => {
  it('cztery wiersze planu i dokument programu „test”, z aliasem i bez', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE faktury (k TEXT, program TEXT, dokument_id TEXT, infakt_uuid TEXT)');
    const wstaw = db.prepare('INSERT INTO faktury VALUES (?,?,?,?)');
    for (const [k, w] of Object.entries(WIERSZE)) wstaw.run(k, w.program, w.dokument_id, w.infakt_uuid);
    const oczekiwane = Object.fromEntries(Object.entries(WIERSZE).map(([k, w]) => [k, programDokumentu(w)]));
    expect(oczekiwane).toEqual({ nowy: 'infakt', stary: 'infakt', bezId: null, programBezId: null, test: 'test' });
    for (const [sql, od] of [[programDokumentuSql(), 'faktury'], [programDokumentuSql('f'), 'faktury f']]) {
      const wynik = Object.fromEntries(db.prepare(`SELECT k, ${sql} AS p FROM ${od}`).all().map((r) => [r.k, r.p]));
      expect(wynik).toEqual(oczekiwane);
    }
    expect(() => programDokumentuSql('f; DROP TABLE faktury')).toThrow('niedozwolony alias');
    db.close();
  });
});

describe('PRZ-121.01 idDokumentuDla i czyDokumentProgramu', () => {
  const programTest = { opis: { id: 'test' } };
  it.each([
    // wiersz, program wołającego, czyDokumentProgramu, idDokumentuDla (string = id, null, 'BLAD')
    ['nowy', 'infakt', true, 'd-1'],
    ['stary', 'infakt', true, 'u-2'],
    ['bezId', 'infakt', false, null],
    ['programBezId', 'infakt', false, null],
    ['test', 'infakt', false, 'BLAD'],
    ['nowy', 'test', false, 'BLAD'],
    ['stary', 'test', false, 'BLAD'],
    ['bezId', 'test', false, null],
    ['programBezId', 'test', false, null],
    ['test', 'test', true, 't-5'],
    ['test', programTest, true, 't-5'],
    ['nowy', { listaFaktur: () => [] }, true, 'd-1'], // surowy klient bez opisu = inFakt
    ['nowy', null, false, 'BLAD'], // moduł „Brak”
  ])('%s dla %j', (k, program, czy, id) => {
    const w = WIERSZE[k];
    expect(czyDokumentProgramu(w, program)).toBe(czy);
    if (id !== 'BLAD') { expect(idDokumentuDla(w, program)).toBe(id); return; }
    let blad = null;
    try { idDokumentuDla(w, program); } catch (e) { blad = e; }
    expect(blad).toMatchObject({ status: 409, bezProgramu: true, dlaOperatora: true });
    expect(blad.message).toMatch(/^Ta faktura jest w .+, a moduł faktur OMS-u to teraz „.+” — otworzysz ją w .+\. Nic nie poszło do programu\.$/);
  });
  it('zdanie dla dokumentu inFaktu przy module „Brak”', () => {
    expect(() => idDokumentuDla(WIERSZE.nowy, null))
      .toThrow('Ta faktura jest w inFakcie, a moduł faktur OMS-u to teraz „Brak” — otworzysz ją w inFakcie. Nic nie poszło do programu.');
  });
});

describe('PRZ-121.01 zapis wyboru w konfiguracja_integracji', () => {
  it('wiersz program_fakturowy z kontem, bez sekretów; zapis odmawia modułu „wkrótce”; usunięcie', () => {
    const db = openOmsDb();
    expect(wczytajWyborProgramu(db)).toBeNull();
    zapiszWyborProgramu(db, ' Brak ', { konto: { id: 1, login: 'pracownia' }, teraz: new Date('2026-10-27T10:00:00Z') });
    expect(wczytajWyborProgramu(db)).toEqual({ program: 'brak', kontoLogin: 'pracownia', zmienionoAt: '2026-10-27T10:00:00.000Z' });
    expect(wczytajKonfiguracjeIntegracji(db, 'program_fakturowy').sekrety).toEqual({});
    expect(() => zapiszWyborProgramu(db, 'fakturownia')).toThrow('wkrótce');
    expect(wczytajWyborProgramu(db).program).toBe('brak');
    expect(usunWyborProgramu(db)).toBe(true);
    expect(wczytajWyborProgramu(db)).toBeNull();
    db.close();
  });
});
