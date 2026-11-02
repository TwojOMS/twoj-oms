// PRZ-122.TFe: przypadki wspólne przeniesione z tests/moduly/faktury/wspolne-bez-twojefaktury-prz122.test.js; asercje bez zmian.
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { afterEach, describe, it, expect, vi } from 'vitest';
import { PDFDocument, PDFName, PDFDict } from 'pdf-lib';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { modulRdzen } from '../../../src/moduly/rdzen/modul.ts';
import { createModulFaktury } from '../../../src/moduly/faktury/modul.ts';
import { zapiszZamowienie } from '../../../src/oms/db/zamowienia.js';
import { rozpocznijFakture, zakonczFakture } from '../../../src/moduly/faktury/db/faktury.js';
import { createFakturyWidok } from '../../../src/moduly/faktury/services/faktury-widok.js';
import { createWysylkaKsef } from '../../../src/moduly/faktury/services/wysylka-ksef.js';
import { createAutomatKsef } from '../../../src/moduly/faktury/services/ksef-automat.js';
import {
  wczytajAutomatKsef, zapiszUstawieniaAutomatu, wstrzymajFakture, zwolnijWstrzymane, uzgodnijWstrzymane,
} from '../../../src/moduly/faktury/db/ksef-automat.js';
import { createPaczkaDlaBiura } from '../../../src/moduly/koszty/services/paczka-dla-biura.js';
import { createKontekstZamowien } from '../../../src/moduly/zamowienia/kontekst.js';
import { createModulKoszty } from '../../../src/moduly/koszty/modul.ts';
import { registerResetDemoRoutes } from '../../../src/moduly/faktury/trasy/reset-demo.js';
import { KLUCZ_ZLECENIA_RESETU } from '../../../src/domena/reset-demo.js';
const bezTf = () => openOmsDb(':memory:', { moduly: [modulRdzen] });
const maTabeleTf = (db) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name LIKE 'tf\\_%' ESCAPE '\\'").get());
const teraz = () => new Date('2026-10-28T02:10:00Z');

afterEach(() => { vi.useRealTimers(); });

describe('paczka dla biura bez funkcji plików KSeF', () => {
  const pdf = async () => { const d = await PDFDocument.create(); d.addPage([200, 200]); return Buffer.from(await d.save()); };
  const faktura = { uuid: 'u1', id: 1, number: '5/10/2026', kind: 'vat', invoice_date: '2026-10-05', sale_date: '2026-10-05',
    net_price: 10000, tax_price: 2300, gross_price: 12300, currency: 'PLN', client_company_name: 'Pracownia Półcień sp. z o.o.',
    client_tax_code: '1234500011', ksef_number: '1234563218-20261005-AAAAAAAAAAAA-01' };
  const zrodlo = (opis) => ({ ...(opis ? { opis } : {}), listaFaktur: async () => [faktura], listaKorekt: async () => [],
    pobierzPdf: pdf, pobierzPdfKorekty: pdf });
  const osadzone = async (bajty) => {
    const names = (await PDFDocument.load(bajty)).catalog.lookupMaybe(PDFName.of('Names'), PDFDict);
    return names?.lookupMaybe(PDFName.of('EmbeddedFiles'), PDFDict) ?? null;
  };

  it('faktura inFaktu: sam PDF, bez załączników (jak na main)', async () => {
    const db = bezTf();
    try {
      expect(maTabeleTf(db)).toBe(false);
      const w = await createPaczkaDlaBiura({ db, infakt: zrodlo(null), teraz }).zbuduj('2026-10', 'sprzedaz');
      expect(w.dokumentow).toBe(1);
      expect(await osadzone(w.bajty)).toBeNull();
    } finally { db.close(); }
  });

  it('program wbudowany, ale bez funkcji plików KSeF: sam PDF, bez załączników i bez błędu', async () => {
    const db = bezTf();
    try {
      const w = await createPaczkaDlaBiura({ db, program: zrodlo({ wbudowany: true }), teraz }).zbuduj('2026-10', 'sprzedaz');
      expect(w.dokumentow).toBe(1);
      expect(await osadzone(w.bajty)).toBeNull();
    } finally { db.close(); }
  });
});

describe('automat KSeF inFaktu na bazie bez tf_*', () => {
  it('przebieg o godzinie wysyła fakturę inFaktu przez wspólną usługę wysyłki', async () => {
    const db = bezTf();
    try {
      const dokumenty = [{ uuid: 'A', number: 'A/2026', rodzaj: 'vat', invoice_date: '2026-10-19', sale_date: '2026-10-19',
        ksef_number: null, client_company_name: 'Pracownia Półcień', client_tax_code: '1234563218', gross_price: 12300, left_to_pay: 0 }];
      const wyslane = [];
      const infakt = {
        listaFaktur: async ({ od, do: koniec, pole = 'invoice_date' }) => dokumenty.filter((d) => d[pole] >= od && d[pole] <= koniec).map((d) => ({ ...d })),
        listaKorekt: async () => [],
        wyslijDokumentDoKsef: async (uuid) => { wyslane.push(uuid); return { odpowiedzInfaktu: { ok: true, uuid } }; },
      };
      const id = zapiszZamowienie(db, 'pro', {
        zrodlo_id: 'w-A', numer: 'Z-A', klient: { first_name: 'Jan', last_name: 'Przykładowy' }, dostawa: {}, metoda_wysylki: 'dpd',
        kwota_pobrania: null, chce_fakture: 1, nip: null, kwota_brutto: '123.00', koszt_dostawy_brutto: '0.00',
        status_woo: 'processing', oplacone_at: null, anulowane: 0, pozycje: [],
      }, {});
      zakonczFakture(db, rozpocznijFakture(db, id).id, { uuid: 'A', numer: 'A/2026', ksefStatus: null });
      const fakturyWidok = createFakturyWidok({ db, infakt });
      const wysylkaKsef = createWysylkaKsef({ db, infakt, fakturyWidok, log: () => {} });
      zapiszUstawieniaAutomatu(db, { wlaczony: true, godzina: '20:00', ostatniPrzebieg: null, login: 'polcien' });
      const w = await createAutomatKsef({ db, fakturyWidok, wysylkaKsef, teraz: () => new Date('2026-10-20T18:01:00Z'), log: () => {} }).przebieg();
      expect(w.stan).toBe('ok');
      expect(wyslane).toEqual(['A']);
      expect(maTabeleTf(db)).toBe(false);
    } finally { db.close(); }
  });
});

describe('„Zwolnij” i uzgodnienie wstrzymanych bez funkcji TwojeFaktury', () => {
  it('zwolnienie zdejmuje wpis inFaktu; uzgodnienie bez funkcji TF niczego nie zmienia i nie sięga do tf_*', () => {
    const db = bezTf();
    try {
      const kiedy = '2026-10-27T10:00:00.000Z';
      wstrzymajFakture(db, { uuid: 'a', numer: '1/10/2026', dzien: '2026-10-27', powod: 'odmowa inFaktu' }, kiedy);
      wstrzymajFakture(db, { uuid: 'b', numer: '2/10/2026', dzien: '2026-10-27', powod: 'nie wysłano', kod: 'nie-wyslano', wersja: 1 }, kiedy);
      const przed = wczytajAutomatKsef(db).wstrzymane;
      expect(uzgodnijWstrzymane(db, null, kiedy)).toBe(false);
      expect(uzgodnijWstrzymane(db, ['b'], kiedy)).toBe(false);
      expect(wczytajAutomatKsef(db).wstrzymane).toEqual(przed);
      expect(zwolnijWstrzymane(db, ['a'], kiedy)).toBe(true);
      expect(wczytajAutomatKsef(db).wstrzymane.map((w) => w.uuid)).toEqual(['b']);
      expect(zwolnijWstrzymane(db, ['a'], kiedy)).toBe(false);
    } finally { db.close(); }
  });
});

describe('reset demo na bazie bez tf_*', () => {
  /** Trasy złożone na atrapie aplikacji — bez modułu faktur (którego migracje zakładają tf_*). */
  function trasy(db) {
    const t = {};
    const app = { get: (adres, f) => { t[`GET ${adres}`] = f; }, post: (adres, f) => { t[`POST ${adres}`] = f; } };
    const restart = { zakoncz: vi.fn() };
    registerResetDemoRoutes(app, { db, wyborProgramu: { teraz: () => ({ program: 'infakt' }) }, nipTeraz: () => '1234563218',
      teraz, restart });
    const odpowiedz = () => {
      const r = { kod: 200, widok: null, raw: { once: () => {} } };
      r.code = (k) => { r.kod = k; return r; };
      r.view = (szablon, dane) => { r.widok = { szablon, dane }; return r; };
      return r;
    };
    const admin = { konto: { admin: true, login: 'polcien' }, url: '/ustawienia/dane-demo', body: {} };
    return { t, restart, odpowiedz, admin };
  }

  it('ekran bez numeru FV i zlecenie resetu przechodzą', async () => {
    const db = bezTf();
    try {
      const { t, odpowiedz, admin } = trasy(db);
      const ekran = odpowiedz();
      await t['GET /ustawienia/dane-demo'](admin, ekran);
      expect(ekran.kod).toBe(200);
      expect(ekran.widok.szablon).toBe('ustawienia-dane-demo.ejs');
      expect(ekran.widok.dane).toMatchObject({ numer: null, nip: '1234563218' });
      const reset = odpowiedz();
      await t['POST /ustawienia/dane-demo/reset']({ ...admin, body: { potwierdzam: 'tak' } }, reset);
      expect(reset.kod).toBe(200);
      expect(JSON.parse(db.prepare('SELECT wartosc FROM ustawienia WHERE klucz = ?').get(KLUCZ_ZLECENIA_RESETU).wartosc))
        .toMatchObject({ login: 'polcien' });
      expect(maTabeleTf(db)).toBe(false);
    } finally { db.close(); }
  });
});

describe('moduł kosztów podaje paczce pliki KSeF z usługi faktur', () => {
  const zbuduj = (uslugi) => {
    let dostal = null;
    const modul = createModulKoszty({ fabryki: { createPaczkaDlaBiuraFn: (a) => { dostal = a; return {}; } } });
    const program = { opis: { wbudowany: true }, listaFaktur: async () => [] };
    const db = bezTf();
    try {
      modul.zbuduj({ db, konfiguracja: modul.konfiguracja({ OMS_SPRZEDAWCA_NIP: '1234563218' }), teraz, log: () => {},
        usluga: (m, n) => {
          const k = `${m}.${n}`;
          const u = { 'faktury.infakt': program, 'faktury.programFakturowy': program, ...uslugi };
          if (!Object.hasOwn(u, k)) throw new Error(`Usługa „${k}" nie istnieje albo moduł „${m}" nie jest zbudowany przed wołającym`);
          return u[k];
        } });
    } finally { db.close(); }
    return dostal;
  };
  it('z usługą faktur — ta sama funkcja; bez niej — null (paczka jak u inFaktu)', () => {
    const pliki = () => null;
    expect(zbuduj({ 'faktury.plikiKsefDokumentu': pliki }).plikiKsef).toBe(pliki);
    expect(zbuduj({}).plikiKsef).toBeNull();
  });
});

describe('importy plików wspólnych', () => {
  const WSPOLNE = [
    'src/moduly/faktury/services/ksef-automat.js', 'src/moduly/faktury/zegary.ts', 'src/moduly/faktury/db/ksef-automat.js',
    'src/moduly/koszty/services/paczka-dla-biura.js', 'src/moduly/zamowienia/kontekst.js', 'src/moduly/faktury/trasy/reset-demo.js',
    'src/moduly/faktury/trasy/ustawienia-programu.js', 'src/moduly/faktury/services/wysylka-ksef.js',
    'src/moduly/koszty/modul.ts', 'src/moduly/zamowienia/modul.ts',
  ];
  it.each(WSPOLNE)('%s nie importuje kodu TwojeFaktury', (plik) => {
    const tekst = readFileSync(new URL(`../../../${plik}`, import.meta.url), 'utf8');
    const importy = tekst.split(/\r?\n/).filter((l) => /^\s*(import|export)\b.*\bfrom\s+['"]/.test(l) || /^\s*}\s*from\s+['"]/.test(l));
    expect(importy.filter((l) => /twojefaktury|ksef-sprzedazy|fa3-xml|faktura-pdf|ksef\/wysylka/.test(l))).toEqual([]);
  });
});
