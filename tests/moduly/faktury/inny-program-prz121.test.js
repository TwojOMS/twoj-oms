// PRZ-121.04a — dokument innego programu w module faktur (plan PRZ-121, „A04a”).
//
// Moduł faktur OMS-u to program „test” (szew `fabryki.programFakturowy`, wyłącznie OMS_TRYB=proba; metody = szpiedzy).
// W bazie leżą trzy faktury: inFakt nowa (`program`+`dokument_id`), inFakt stara (sam `infakt_uuid`, wiersz obrazu sprzed
// PRZ-118) i dokument programu „test”.
//   • działanie człowieka (PDF faktury zamówienia, faktura do Allegro, wysyłka do KSeF) na dokumencie inFaktu → odmowa
//     409 (`bezProgramu`) PRZED rezerwacją w `wysylki_ksef` / zajęciem wysyłki do Allegro i PRZED siecią;
//   • identyfikator bez wiersza w bazie (dokument wystawiony poza OMS-em) przechodzi jak dziś;
//   • automaty (czuwacz KSeF, doczytanie numeru na karcie) dokument innego programu pomijają, przebieg idzie dalej,
//     a liczba pominiętych trafia RAZ do logu przebiegu.
// Żadnego żądania do inFaktu ani KSeF: globalny fetch rzuca, a program to szpiedzy.
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zbudujOms } from '../../../src/oms/bootstrap.ts';
import { modulyDla } from '../../../src/moduly/lista.ts';
import { createModulFaktury } from '../../../src/moduly/faktury/modul.ts';
import { zapiszZamowienie } from '../../../src/oms/db/zamowienia.js';
import { METODY_OBOWIAZKOWE, METODA_ZDOLNOSCI } from '../../../src/integracje/program-fakturowy.ts';
import { createAtrapaVies } from '../../../deploy/proba/atrapy/infakt.mjs';
import { createFakturaAllegro } from '../../../src/moduly/faktury/services/faktura-allegro.js';
import { createWysylkaKsef } from '../../../src/moduly/faktury/services/wysylka-ksef.js';
import { createCzuwaczKsef } from '../../../src/moduly/faktury/services/czuwacz-ksef.js';

const PDF = Buffer.concat([Buffer.from('%PDF-1.4'), Buffer.alloc(64)]);
const NIP_PRACOWNI = '5250000009'; // zmyślony, z poprawną sumą kontrolną
const SKLEP = 'allegro_polcien';
const ODMOWA = 'Ta faktura jest w inFakcie, a moduł faktur OMS-u to teraz „test”';

const INFAKT_NOWA = 'inf-nowa-0001';
const INFAKT_STARA = 'inf-stara-0002';
const TEST_DOK = 'test-dok-0003';
const SPOZA_OMS = 'test-spoza-0009';

/** Program „test” — metody kontraktu to szpiedzy; nic nie wychodzi z procesu. */
function programSzpieg() {
  const metody = {};
  for (const m of [...METODY_OBOWIAZKOWE, ...Object.values(METODA_ZDOLNOSCI)]) metody[m] = vi.fn(async () => null);
  metody.pobierzPdf = vi.fn(async () => PDF);
  metody.pobierzFakture = vi.fn(async () => ({ numer: null, ksefNumer: null }));
  metody.wyslijDokumentDoKsef = vi.fn(async () => ({ przyjete: 1 }));
  metody.listaFaktur = vi.fn(async () => []);
  metody.listaKorekt = vi.fn(async () => []);
  metody.listaNieoplaconych = vi.fn(async () => []);
  return {
    ...metody,
    opis: {
      id: 'test',
      nazwa: { mianownik: 'Testownik', dopelniacz: 'Testownika', miejscownik: 'Testowniku', narzednik: 'Testownikiem' },
      regulaVat: 'wierszami', zdolnosci: Object.keys(METODA_ZDOLNOSCI), wystawienieWysylaDoKsef: false,
      limity: { zadanieMs: 30000, najdluzszaListaMs: 120000, stronaListy: 25, sufitStron: 40, rownolegleStron: 4 },
      adres: 'https://testownik.invalid', ekran: '/ustawienia/integracje/testownik',
    },
  };
}

let licznik = 0;
/** Zamówienie z fakturą. `dok` = kolumny dokumentu (`program`, `dokument_id`, `infakt_uuid`). */
function zFaktura(db, dok, { ksefNumer = null } = {}) {
  licznik += 1;
  const id = zapiszZamowienie(db, SKLEP, {
    zrodlo_id: `PC-${licznik}`, numer: `PC-${700 + licznik}`,
    klient: { company: 'Pracownia Półcień sp. z o.o.', email: 'biuro@polcien.invalid' }, dostawa: { city: 'Warszawa' },
    metoda_wysylki: 'allegro_dpd', kwota_pobrania: null, chce_fakture: 1, nip: NIP_PRACOWNI,
    kwota_brutto: '258.00', koszt_dostawy_brutto: '0.00', status_woo: 'processing',
    oplacone_at: '2026-10-10T09:00:00Z', anulowane: 0, utworzone_at: '2026-10-10T08:00:00Z',
    pozycje: [{ zrodlo_id: 11, nazwa: 'Lampa wisząca Półcień', sku: 'LAMPA-W1', ilosc: 2, cena_brutto: '129.00', vat: null }],
  }, {});
  db.prepare(`INSERT INTO faktury (zamowienie_id, program, dokument_id, infakt_uuid, numer, ksef_numer, utworzona_at)
    VALUES (?,?,?,?,?,?,?)`).run(id, dok.program ?? null, dok.dokument_id ?? null, dok.infakt_uuid ?? null,
    `${licznik}/10/2026`, ksefNumer, new Date(Date.now() - 2 * 24 * 3600 * 1000).toISOString());
  return id;
}

const DOK = {
  infaktNowa: { program: 'infakt', dokument_id: INFAKT_NOWA, infakt_uuid: INFAKT_NOWA },
  infaktStara: { infakt_uuid: INFAKT_STARA },
  test: { program: 'test', dokument_id: TEST_DOK },
};

let katalog;
let a;
let program;
beforeAll(async () => {
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('PRZ-121.04a: sieć zabroniona w teście'); }));
  katalog = mkdtempSync(join(tmpdir(), 'prz121-04a-'));
  const env = {
    OMS_TRYB: 'proba', OMS_USER: 'operator', OMS_PASS: 'fixture', OMS_SPRZEDAWCA_NIP: '1234563218',
    OMS_RACHUNEK: '34109010140000000000000000', OMS_PROFORMY_KATALOG: katalog, OMS_ETYKIETY_KATALOG: katalog,
  };
  program = programSzpieg();
  const fabryki = { programFakturowy: () => program, createVies: () => createAtrapaVies({ env }) };
  const moduly = modulyDla(env).map((m) => (m.nazwa === 'faktury' ? createModulFaktury({ fabryki }) : m));
  a = await zbudujOms({ env, moduly, teraz: () => new Date(), log: () => {} });
});
afterAll(async () => {
  await a?.app.close();
  a?.db.close();
  rmSync(katalog, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

const wierszeRezerwacji = () => a.db.prepare('SELECT uuid FROM wysylki_ksef ORDER BY uuid').all().map((w) => w.uuid);
const odmowa409 = { status: 409, bezProgramu: true };

describe('PRZ-121.04a PDF faktury zamówienia', () => {
  it('dokument inFaktu (nowy i stary wiersz) → 409 bez wywołania programu; dokument „test” — PDF jak dziś', async () => {
    const faktura = a.usluga('faktury', 'faktura');
    expect(faktura).toBeTruthy();
    for (const dok of [DOK.infaktNowa, DOK.infaktStara]) {
      const id = zFaktura(a.db, dok);
      await expect(faktura.pdf(id)).rejects.toMatchObject(odmowa409);
      await expect(faktura.pdf(id)).rejects.toThrow(ODMOWA);
    }
    expect(program.pobierzPdf).not.toHaveBeenCalled();

    const idTest = zFaktura(a.db, DOK.test);
    const w = await faktura.pdf(idTest);
    expect(Buffer.compare(w.bajty, PDF)).toBe(0);
    expect(program.pobierzPdf).toHaveBeenCalledTimes(1);
    expect(program.pobierzPdf).toHaveBeenCalledWith(TEST_DOK);
  });
});

describe('PRZ-121.04a faktura do Allegro', () => {
  it('dokument inFaktu → 409 przed zajęciem wysyłki i przed siecią; dokument „test” idzie jak dziś', async () => {
    program.pobierzPdf.mockClear();
    const sygnaly = [];
    const klient = {
      pobierzFakturyZamowienia: vi.fn(async () => { sygnaly.push('lista'); return []; }),
      zglosFakture: vi.fn(async () => { sygnaly.push('zglos'); return { id: 'INV-PC-1' }; }),
      wyslijPlikFaktury: vi.fn(async () => { sygnaly.push('plik'); return { file: { securityVerification: { status: 'WAITING' } } }; }),
    };
    const usluga = createFakturaAllegro({ db: a.db, program, klienciKanalow: { [SKLEP]: klient } });
    for (const dok of [DOK.infaktNowa, DOK.infaktStara]) {
      const id = zFaktura(a.db, { ...dok, dokument_id: dok.dokument_id && `${dok.dokument_id}-a`,
        infakt_uuid: `${dok.infakt_uuid}-a` }, { ksefNumer: 'KSEF-PC-1' });
      // Dzierżawa wysyłki (`allegro_zgloszenie_at`) ŚWIEŻO zajęta: gdyby odmowa stała za `zajmijWysylkeDoAllegro`,
      // odpowiedzią byłoby „WŁAŚNIE TRWA”, a nie 409 o programie dokumentu.
      const dzierzawa = new Date().toISOString();
      a.db.prepare('UPDATE faktury SET allegro_zgloszenie_at = ? WHERE zamowienie_id = ?').run(dzierzawa, id);
      await expect(usluga.wyslij(id)).rejects.toMatchObject(odmowa409);
      // Odmowa nie dotknęła dzierżawy (ani nie zajęła, ani nie zwolniła) i niczego nie zapisała o Allegro.
      const f = a.db.prepare('SELECT * FROM faktury WHERE zamowienie_id = ?').get(id);
      expect(f.allegro_zgloszenie_at).toBe(dzierzawa);
      expect(f.allegro_wyslana_at).toBeNull();
      expect(f.allegro_invoice_id).toBeNull();
    }
    expect(program.pobierzPdf).not.toHaveBeenCalled();
    expect(sygnaly).toEqual([]);

    const idTest = zFaktura(a.db, { program: 'test', dokument_id: `${TEST_DOK}-a` }, { ksefNumer: 'KSEF-PC-2' });
    await usluga.wyslij(idTest);
    expect(program.pobierzPdf).toHaveBeenCalledWith(`${TEST_DOK}-a`);
    expect(sygnaly).toEqual(['lista', 'zglos', 'plik']);
  });
});

describe('PRZ-121.04a wysyłka do KSeF', () => {
  const dokument = (uuid, n) => ({ uuid, number: `${n}/10/2026`, rodzaj: 'vat', client_tax_code: NIP_PRACOWNI, ksef_number: null });

  it('[inFakt nowa, inFakt stara, test, spoza OMS-u] → inFakt odmówiony bez wiersza rezerwacji, reszta wysłana', async () => {
    program.wyslijDokumentDoKsef.mockClear();
    const k = (s) => `${s}-k`;
    zFaktura(a.db, { program: 'infakt', dokument_id: k(INFAKT_NOWA), infakt_uuid: k(INFAKT_NOWA) });
    zFaktura(a.db, { infakt_uuid: k(INFAKT_STARA) });
    zFaktura(a.db, { program: 'test', dokument_id: k(TEST_DOK) });
    const dokumenty = [dokument(k(INFAKT_NOWA), 81), dokument(k(INFAKT_STARA), 82), dokument(k(TEST_DOK), 83), dokument(SPOZA_OMS, 84)];
    const usluga = createWysylkaKsef({ db: a.db, program, fakturyWidok: { dokumenty: async () => dokumenty }, log: () => {} });
    const args = { uuids: dokumenty.map((d) => d.uuid), miesiac: '2026-10', pole: 'invoice_date' };
    const w = await usluga.wyslij(args);
    expect(w.wyslane.map((d) => d.uuid)).toEqual([k(TEST_DOK), SPOZA_OMS]);
    const odmowione = w.pominiete.filter((p) => p.powod.includes(ODMOWA));
    expect(odmowione.map((p) => p.numer)).toEqual(['81/10/2026', '82/10/2026']);
    expect(wierszeRezerwacji()).not.toContain(k(INFAKT_NOWA));
    expect(wierszeRezerwacji()).not.toContain(k(INFAKT_STARA));
    expect(wierszeRezerwacji()).toEqual(expect.arrayContaining([k(TEST_DOK), SPOZA_OMS]));
    expect(program.wyslijDokumentDoKsef.mock.calls.map((c) => c[0])).toEqual([k(TEST_DOK), SPOZA_OMS]);
  });

  it('ten sam identyfikator w dwóch programach (najpierw „fakturownia”, potem „test”), aktywny „test” → wysłany bez odmowy', async () => {
    program.wyslijDokumentDoKsef.mockClear();
    const ID = '123';
    zFaktura(a.db, { program: 'fakturownia', dokument_id: ID });
    zFaktura(a.db, { program: 'test', dokument_id: ID });
    const usluga = createWysylkaKsef({ db: a.db, program, fakturyWidok: { dokumenty: async () => [dokument(ID, 93)] }, log: () => {} });
    const w = await usluga.wyslij({ uuids: [ID], miesiac: '2026-10', pole: 'invoice_date' });
    expect(w.pominiete).toEqual([]);
    expect(w.wyslane.map((d) => d.uuid)).toEqual([ID]);
    expect(program.wyslijDokumentDoKsef.mock.calls.map((c) => c[0])).toEqual([ID]);
  });

  it('faktura okresu z inFaktu przy aktywnym „test” → odmówiona bez wiersza rezerwacji', async () => {
    program.wyslijDokumentDoKsef.mockClear();
    const OKRES = 'inf-okres-0005';
    a.db.prepare(`INSERT INTO okresy_rozliczeniowe (klient_klucz, rok, miesiac, stan, program, dokument_id, infakt_uuid, numer,
      utworzony_at) VALUES ('polcien', 2026, 9, 'zamkniety', 'infakt', ?, ?, 'FZ/9/2026', ?)`)
      .run(OKRES, OKRES, new Date().toISOString());
    const usluga = createWysylkaKsef({ db: a.db, program, fakturyWidok: { dokumenty: async () => [dokument(OKRES, 94)] }, log: () => {} });
    const w = await usluga.wyslij({ uuids: [OKRES], miesiac: '2026-10', pole: 'invoice_date' });
    expect(w.wyslane).toEqual([]);
    expect(w.pominiete.filter((p) => p.powod.includes(ODMOWA)).map((p) => p.numer)).toEqual(['94/10/2026']);
    expect(wierszeRezerwacji()).not.toContain(OKRES);
    expect(program.wyslijDokumentDoKsef).not.toHaveBeenCalled();
  });

  it('podgląd mówi to samo, co zrobi zatwierdzenie: inFakt pominięty z powodem, nic nie zarezerwowane ani wysłane', async () => {
    program.wyslijDokumentDoKsef.mockClear();
    const p = (s) => `${s}-p`;
    zFaktura(a.db, { program: 'infakt', dokument_id: p(INFAKT_NOWA), infakt_uuid: p(INFAKT_NOWA) });
    zFaktura(a.db, { program: 'test', dokument_id: p(TEST_DOK) });
    const dokumenty = [dokument(p(INFAKT_NOWA), 91), dokument(p(TEST_DOK), 92)];
    const usluga = createWysylkaKsef({ db: a.db, program, fakturyWidok: { dokumenty: async () => dokumenty }, log: () => {} });
    const podglad = await usluga.podglad({ uuids: dokumenty.map((d) => d.uuid), miesiac: '2026-10', pole: 'invoice_date' });
    expect(podglad.doWyslania.map((d) => d.uuid)).toEqual([p(TEST_DOK)]);
    expect(podglad.pominiete.filter((x) => x.powod.includes(ODMOWA)).map((x) => x.numer)).toEqual(['91/10/2026']);
    expect(wierszeRezerwacji()).not.toContain(p(TEST_DOK));
    expect(program.wyslijDokumentDoKsef).not.toHaveBeenCalled();
  });
});

describe('PRZ-121.04a automaty: czuwacz KSeF i doczytanie numeru', () => {
  it('czuwacz pyta program tylko o dokument „test”, przebieg idzie dalej, liczba pominiętych raz w logu', async () => {
    program.pobierzFakture.mockClear();
    a.db.prepare('DELETE FROM faktury').run();
    const c = (s) => `${s}-c`;
    zFaktura(a.db, { program: 'infakt', dokument_id: c(INFAKT_NOWA), infakt_uuid: c(INFAKT_NOWA) });
    zFaktura(a.db, { infakt_uuid: c(INFAKT_STARA) });
    zFaktura(a.db, { program: 'test', dokument_id: c(TEST_DOK) });
    const log = vi.fn();
    const czuwacz = createCzuwaczKsef({ db: a.db, program, log });
    const wynik = await czuwacz.przebieg();
    expect(program.pobierzFakture.mock.calls.map((x) => x[0])).toEqual([c(TEST_DOK)]);
    expect(wynik).toMatchObject({ sprawdzone: 1, znalezione: 0 });
    expect(log).toHaveBeenCalledTimes(1);
    expect(String(log.mock.calls[0].join(' '))).toContain('2');
    // Pominięty dokument nie dostał stempla „pytaliśmy” — panel nie pytał o niego nikogo.
    const stemple = a.db.prepare('SELECT program, ksef_sprawdzona_at FROM faktury ORDER BY id').all();
    expect(stemple.map((s) => s.ksef_sprawdzona_at != null)).toEqual([false, false, true]);
  });

  it('czuwacz: dokumenty innego programu nie zajmują miejsca w limicie przebiegu', async () => {
    program.pobierzFakture.mockClear();
    a.db.prepare('DELETE FROM faktury').run();
    const l = (s) => `${s}-l`;
    // inFakt starsze, więc w dotychczasowej kolejności stałyby pierwsze i przy limicie 1 zabierałyby jedyne miejsce.
    zFaktura(a.db, { program: 'infakt', dokument_id: l(INFAKT_NOWA), infakt_uuid: l(INFAKT_NOWA) });
    zFaktura(a.db, { program: 'test', dokument_id: l(TEST_DOK) });
    const czuwacz = createCzuwaczKsef({ db: a.db, program, limit: 1, log: () => {} });
    await czuwacz.przebieg();
    expect(program.pobierzFakture.mock.calls.map((x) => x[0])).toEqual([l(TEST_DOK)]);
  });

  it('doczytanie na karcie pomija dokument inFaktu (nic nie pyta), dokument „test” czyta jak dziś', async () => {
    program.pobierzFakture.mockClear();
    const doczytanie = a.usluga('faktury', 'doczytanieKsef');
    expect(doczytanie).toBeTruthy();
    const f = (id) => a.db.prepare('SELECT * FROM faktury WHERE zamowienie_id = ?').get(id);
    const d = (s) => `${s}-d`;
    const idNowa = zFaktura(a.db, { program: 'infakt', dokument_id: d(INFAKT_NOWA), infakt_uuid: d(INFAKT_NOWA) });
    const idStara = zFaktura(a.db, { infakt_uuid: d(INFAKT_STARA) });
    const idTest = zFaktura(a.db, { program: 'test', dokument_id: d(TEST_DOK) });
    expect(await doczytanie.dlaFaktury(f(idNowa), idNowa)).toBe(false);
    expect(await doczytanie.dlaFaktury(f(idStara), idStara)).toBe(false);
    expect(program.pobierzFakture).not.toHaveBeenCalled();
    expect(f(idNowa).ksef_sprawdzona_at).toBeNull();
    await doczytanie.dlaFaktury(f(idTest), idTest);
    expect(program.pobierzFakture.mock.calls.map((x) => x[0])).toEqual([d(TEST_DOK)]);
  });
});
