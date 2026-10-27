// PRZ-121.A04b — dokument innego programu: korekta zwrotu i mail z fakturą.
//
// Pełna aplikacja (zbudujOms), OMS_TRYB=proba, szew `fabryki.programFakturowy` modułu faktur z programem testowym
// o `opis.id = 'test'` (metody-szpiedzy). Faktura inFaktu w bazie = dokument INNEGO programu: korekta i mail odmawiają
// zdaniem z `idDokumentuDla` (409) PRZED pobraniem dokumentu i PRZED rezerwacją korekty. Dokument `test` działa jak dziś.
//
// Mail z fakturą przy module „Brak”: jawny wybór (plik albo Ustawienia) → zdanie „faktury wyłączone”; bez wyboru
// (brak domyślny, nic nie skonfigurowano) — stary tekst znak w znak. Zero sieci: globalny fetch rzuca.
import { afterAll, afterEach, describe, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zbudujOms } from '../../../src/oms/bootstrap.ts';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { modulyDla } from '../../../src/moduly/lista.ts';
import { createModulFaktury } from '../../../src/moduly/faktury/modul.ts';
import { zapiszZamowienie } from '../../../src/oms/db/zamowienia.js';
import { zapiszWyborProgramu } from '../../../src/oms/db/wybor-programu.js';
import { dodajZwrot, zwrot, zarezerwujKorekte } from '../../../src/oms/db/zwroty.js';
import { createKorekta } from '../../../src/moduly/zwroty/services/korekta.js';
import { createAtrapaVies } from '../../../deploy/proba/atrapy/infakt.mjs';
import { programTestowy } from '../../pomoc/program-testowy.js';

const ZDANIE_PLIKU = 'Faktury w OMS-ie są wyłączone — w pliku konfiguracji jest OMS_PROGRAM_FAKTUROWY=brak.';
const ZDANIE_USTAWIEN = 'Faktury w OMS-ie są wyłączone — w Ustawienia → Integracje → Moduł faktur wybrano „Brak”.';
const STARY_MAIL = 'Panel nie ma połączenia z inFaktem — PDF-u faktury nie ma skąd pobrać.';
const ODMOWA_INFAKTU = 'Ta faktura jest w inFakcie, a moduł faktur OMS-u to teraz „test” — otworzysz ją w inFakcie. Nic nie poszło do programu.';

const katalogi = [];
const aplikacje = [];
afterEach(() => vi.unstubAllGlobals());
afterAll(async () => {
  for (const a of aplikacje.splice(0)) { await a.app.close(); a.db.close(); }
  for (const p of katalogi.splice(0)) rmSync(p, { recursive: true, force: true });
});

const zamowienie = (nr) => ({
  zrodlo_id: nr, numer: `PZ-${nr}`,
  klient: { first_name: 'Anna', last_name: 'Półcień', company: 'Pracownia Półcień', email: 'biuro@polcien.invalid',
    address_1: 'Lampowa 1', postcode: '00-950', city: 'Warszawa' },
  dostawa: {}, metoda_wysylki: 'dpd', kwota_pobrania: null, chce_fakture: 1, nip: null,
  kwota_brutto: '258.00', status_woo: 'processing', oplacone_at: null, anulowane: 0, utworzone_at: '2026-10-01T10:00:00Z',
  pozycje: [{ zrodlo_id: 11, nazwa: 'Lampa wisząca Półcień', sku: 'LAMPA-W1', ilosc: 2, cena_brutto: '129.00',
    brutto_linii: '258.00', vat: null }],
});

const FAKTURA_TEST = {
  number: 'TST 1/10/2026', invoice_date: '2026-10-01', uuid: 'dok-test-1',
  services: [{ name: 'Lampa wisząca Półcień', quantity: 2, gross_price: 25800, tax_symbol: '23' }],
};

function zakazSieci() {
  const fetchZakazany = vi.fn(async () => { throw new Error('Sieć zabroniona w teście'); });
  vi.stubGlobal('fetch', fetchZakazany);
  return fetchZakazany;
}

/** Aplikacja z programem `test` w szwie modułu faktur. */
async function zSzwem() {
  const katalog = mkdtempSync(join(tmpdir(), 'inny-program-prz121-')); katalogi.push(katalog);
  const env = { OMS_TRYB: 'proba', OMS_USER: 'operator', OMS_PASS: 'fixture', OMS_SPRZEDAWCA_NIP: '1234563218',
    OMS_RACHUNEK: '34109010140000000000000000', OMS_PROFORMY_KATALOG: katalog, OMS_ETYKIETY_KATALOG: katalog };
  const program = programTestowy({ id: 'test', metody: {
    pobierzFakture: async () => FAKTURA_TEST,
    wystawKorekte: async () => ({ referencja: 'REF-T1', uuid: null, numer: null }),
  } });
  const fabryki = { programFakturowy: () => program, createVies: () => createAtrapaVies({ env }) };
  const moduly = modulyDla(env).map((m) => (m.nazwa === 'faktury' ? createModulFaktury({ fabryki }) : m));
  const a = await zbudujOms({ env, moduly, teraz: () => new Date('2026-10-27T10:00:00Z'), log: () => {} });
  aplikacje.push(a);
  return { a, program };
}

/** Faktura inFaktu (nowy wiersz: program + dokument_id) albo stary wiersz z samym `infakt_uuid`, albo dokument `test`. */
function faktura(db, id, rodzaj, nr) {
  if (rodzaj === 'infakt-stara') {
    db.prepare('INSERT INTO faktury (zamowienie_id, infakt_uuid, numer, utworzona_at) VALUES (?,?,?,?)')
      .run(id, `uuid-infakt-${nr}`, `FV/${nr}/10/2026`, '2026-10-01T10:00:00Z');
    return;
  }
  const [program, dok, numer] = rodzaj === 'infakt'
    ? ['infakt', `uuid-infakt-${nr}`, `FV/${nr}/10/2026`] : ['test', 'dok-test-1', 'TST 1/10/2026'];
  db.prepare('INSERT INTO faktury (zamowienie_id, program, dokument_id, numer, utworzona_at) VALUES (?,?,?,?,?)')
    .run(id, program, dok, numer, '2026-10-01T10:00:00Z');
}

const zwrotNa = (db, id) => dodajZwrot(db, id, { data: '2026-10-14', kwota: '129.00',
  pozycje: [{ klucz_pozycji: 's11', nazwa: 'Lampa wisząca Półcień', ilosc: 1, kwota: '129.00' }] }).id;

const logKarty = (db, id) => db.prepare('SELECT akcja, wynik FROM log WHERE zamowienie_id = ? ORDER BY id').all(id);

describe('PRZ-121.A04b korekta zwrotu do faktury innego programu (szew `test`)', () => {
  for (const rodzaj of ['infakt', 'infakt-stara']) {
    it(`faktura ${rodzaj}: 409 z \`bezProgramu\`, zwrot bez rezerwacji, program niewołany`, async () => {
      const fetchZakazany = zakazSieci();
      const { a, program } = await zSzwem();
      const id = zapiszZamowienie(a.db, 'reczne', zamowienie(6101), {});
      faktura(a.db, id, rodzaj, 6101);
      const zwrotId = zwrotNa(a.db, id);
      const blad = await a.usluga('zwroty', 'korekta').wystaw(id, zwrotId).catch((e) => e);
      expect(blad).toBeInstanceOf(Error);
      expect(blad.message).toBe(ODMOWA_INFAKTU);
      expect(blad).toMatchObject({ status: 409, bezProgramu: true });
      // Zwrot bez rezerwacji: odmowa nie ma prawa zablokować korekty wystawionej później z właściwego programu.
      expect(zwrot(a.db, id, zwrotId)).toMatchObject({ korekta_zlecona_at: null, korekta_numer: null });
      expect(program.wywolania).toEqual([]);
      expect(fetchZakazany).not.toHaveBeenCalled();
    });
  }

  it('dokument `test`: korekta jak dziś — „przed” z programu, rezerwacja i wystawienie', async () => {
    const fetchZakazany = zakazSieci();
    const { a, program } = await zSzwem();
    const id = zapiszZamowienie(a.db, 'reczne', zamowienie(6102), {});
    faktura(a.db, id, 'test', 6102);
    const zwrotId = zwrotNa(a.db, id);
    await a.usluga('zwroty', 'korekta').wystaw(id, zwrotId);
    expect(program.wywolania.find(([m]) => m === 'pobierzFakture')[1]).toBe('dok-test-1');
    expect(program.ile('wystawKorekte')).toBe(1);
    expect(zwrot(a.db, id, zwrotId).korekta_zlecona_at).toBeTruthy();
    expect(fetchZakazany).not.toHaveBeenCalled();
  });
});

describe('PRZ-121.A04b mail z fakturą innego programu (szew `test`)', () => {
  it('faktura inFaktu: odmowa zdaniem z `idDokumentuDla`, nic nie wysłane, ślad „nieudane złożenie”', async () => {
    const fetchZakazany = zakazSieci();
    const { a, program } = await zSzwem();
    const mailer = vi.spyOn(a.usluga('wiadomosci', 'mailer'), 'sendMail');
    const id = zapiszZamowienie(a.db, 'reczne', zamowienie(6201), {});
    faktura(a.db, id, 'infakt', 6201);
    const blad = await a.usluga('wiadomosci', 'wiadomosci').wyslij(id, 'faktura').catch((e) => e);
    expect(blad.message).toBe(ODMOWA_INFAKTU);
    expect(blad).toMatchObject({ status: 409, bezProgramu: true });
    expect(program.ile('pobierzPdf')).toBe(0);
    expect(mailer).not.toHaveBeenCalled();
    const log = logKarty(a.db, id);
    expect(log.some((w) => w.akcja === 'wiadomosc.nieudane-zlozenie' && w.wynik.includes(ODMOWA_INFAKTU))).toBe(true);
    expect(log.some((w) => w.akcja === 'wiadomosc')).toBe(false);
    expect(fetchZakazany).not.toHaveBeenCalled();
  });

  it('dokument `test`: PDF z programu jak dziś', async () => {
    zakazSieci();
    const { a, program } = await zSzwem();
    const id = zapiszZamowienie(a.db, 'reczne', zamowienie(6202), {});
    faktura(a.db, id, 'test', 6202);
    // Bez poczty mail i tak nie wyjdzie — sprawdzamy, że ZŁOŻENIE doszło do programu właściwym identyfikatorem.
    await a.usluga('wiadomosci', 'wiadomosci').wyslij(id, 'faktura').catch(() => {});
    expect(program.ile('pobierzPdf')).toBe(1);
    expect(program.wywolania.find(([m]) => m === 'pobierzPdf')[1]).toBe('dok-test-1');
  });
});

describe('PRZ-121.A04b mail z fakturą przy module faktur „Brak”', () => {
  /** Bez szwu, bez OMS_TRYB=proba: faktura inFaktu w bazie, moduł faktur „Brak” jawny albo domyślny. */
  async function bezProgramu({ plik = null, zapis = null, klucz = false }) {
    const katalog = mkdtempSync(join(tmpdir(), 'mail-brak-prz121-')); katalogi.push(katalog);
    const sciezka = join(katalog, 'oms.db');
    const przed = openOmsDb(sciezka);
    if (zapis) zapiszWyborProgramu(przed, zapis);
    przed.close();
    const env = { OMS_DB_PATH: sciezka, OMS_PROFORMY_KATALOG: katalog, OMS_ETYKIETY_KATALOG: katalog,
      OMS_SPRZEDAWCA_NIP: '1234563218', OMS_RACHUNEK: '34109010140000000000000000', OMS_USER: 'operator', OMS_PASS: 'fixture',
      ...(klucz ? { INFAKT_API_KEY: 'zmyslony-klucz-maila-prz121-000000001' } : {}),
      ...(plik ? { OMS_PROGRAM_FAKTUROWY: plik } : {}) };
    const a = await zbudujOms({ env, teraz: () => new Date('2026-10-27T10:00:00Z'), log: () => {} });
    aplikacje.push(a);
    return a;
  }

  for (const [nazwa, ustawienie, zdanie] of [
    ['plik', { plik: 'brak', klucz: true }, `${ZDANIE_PLIKU} PDF-u faktury nie ma skąd pobrać.`],
    ['ustawienia', { zapis: 'brak', klucz: true }, `${ZDANIE_USTAWIEN} PDF-u faktury nie ma skąd pobrać.`],
    ['bez wyboru (brak domyślny)', {}, STARY_MAIL],
  ]) {
    it(`${nazwa}: ${zdanie === STARY_MAIL ? 'stary tekst znak w znak' : 'zdanie „faktury wyłączone”'}, nic nie wysłane`, async () => {
      const fetchZakazany = zakazSieci();
      const a = await bezProgramu(ustawienie);
      const mailer = vi.spyOn(a.usluga('wiadomosci', 'mailer'), 'sendMail');
      const id = zapiszZamowienie(a.db, 'reczne', zamowienie(6301), {});
      faktura(a.db, id, 'infakt', 6301);
      const blad = await a.usluga('wiadomosci', 'wiadomosci').wyslij(id, 'faktura').catch((e) => e);
      expect(blad.message).toBe(zdanie);
      expect(mailer).not.toHaveBeenCalled();
      expect(fetchZakazany).not.toHaveBeenCalled();
    });
  }
});

describe('PRZ-121.A04b doczytanie korekty do faktury innego programu (recenzja)', () => {
  it('korekta zlecona przy inFakcie, moduł teraz `test`: obcy program niepytany, numer jego korekty nie przykleja się', async () => {
    const db = openOmsDb(':memory:');
    try {
      const id = zapiszZamowienie(db, 'reczne', zamowienie(6110), {});
      db.prepare('INSERT INTO faktury (zamowienie_id, program, dokument_id, numer, utworzona_at) VALUES (?,?,?,?,?)')
        .run(id, 'infakt', 'uuid-infakt-6110', 'FV 1/10/2026', '2026-10-01T10:00:00Z');
      const zwrotId = zwrotNa(db, id);
      expect(zarezerwujKorekte(db, id, zwrotId, '2026-10-14T10:00:00Z')).toBeTruthy();
      const program = programTestowy({ id: 'test', metody: {
        listaKorekt: async () => [{ uuid: 'kor-test-9', number: 'TST K 9/10/2026',
          corrected_invoice_number: 'FV 1/10/2026', invoice_date: '2026-10-20' }],
      } });
      await createKorekta({ db, program }).doczytaj(id, zwrotId);
      expect(program.ile('listaKorekt')).toBe(0);
      expect(zwrot(db, id, zwrotId).korekta_numer).toBeNull();
    } finally { db.close(); }
  });
});
