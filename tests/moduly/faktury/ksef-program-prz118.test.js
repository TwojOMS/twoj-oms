// PRZ-118.07 — odczyt, PDF i KSeF sprzedaży na kontrakcie ProgramFakturowy (plan PRZ-118, zmiana 07).
//
// Program testowy „Testownik” (opis.id 'testowy') — NIE inFakt: własny opis, liczniki wywołań, opcja pominięcia
// zdolności. Zachowanie konta (dokumenty, kartoteka nabywców, PDF) daje mu atrapa piaskownicy
// (deploy/proba/atrapy/infakt.mjs) owinięta adapterem; nic nie wychodzi z procesu. Do pełnej aplikacji wchodzi
// szwem `fabryki.programFakturowy` modułu faktur (wyłącznie OMS_TRYB=proba) — wtedy usługa `infakt` = ten program.
//
// (2) wystawienie ≠ wysyłka: faktura zamówienia, faktura okresu i korekta → 0 wywołań wysyłki; podgląd → 0;
//     zatwierdzenie N dokumentów → dokładnie N.
// (3) program bez `wyslijDoKsef` → podgląd i zatwierdzenie odpowiadają zdaniem (nie 500), automat pominięty z tym powodem.
// (4) program bez `nieoplacone` → zakładka FAKTURY się renderuje, sekcja nieopłaconych mówi zdaniem, że program jej nie podaje.
// (5) czuwacz KSeF i czuwacz archiwum liczą budżet z `program.opis.limity`.
// Strażnik „kto woła wysyłkę” (1): tests/core/straznik-wysylki-ksef-prz118.test.js.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zbudujOms } from '../../../src/oms/bootstrap.ts';
import { modulyDla } from '../../../src/moduly/lista.ts';
import { createModulFaktury } from '../../../src/moduly/faktury/modul.ts';
import { zapiszZamowienie } from '../../../src/oms/db/zamowienia.js';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { programInfakt } from '../../../src/integracje/programy/infakt.ts';
import { METODY_OBOWIAZKOWE, METODA_ZDOLNOSCI, sprawdzProgramFakturowy } from '../../../src/integracje/program-fakturowy.ts';
import { createAtrapaInfaktu, createAtrapaVies } from '../../../deploy/proba/atrapy/infakt.mjs';
import { createWysylkaKsef } from '../../../src/moduly/faktury/services/wysylka-ksef.js';
import { createAutomatKsef } from '../../../src/moduly/faktury/services/ksef-automat.js';
import { createCzuwaczKsef, NAJDLUZSZY_PRZEBIEG_MS, najdluzszyPrzebiegMs } from '../../../src/moduly/faktury/services/czuwacz-ksef.js';
import {
  createCzuwaczArchiwumSprzedazy, NAJDLUZSZY_PRZEBIEG_ARCHIWUM_SPRZEDAZY_MS, najdluzszyPrzebiegArchiwumSprzedazyMs,
} from '../../../src/moduly/faktury/services/czuwacz-archiwum-sprzedazy.js';
import { dopiszKlientaZbiorczego } from './_klient-zbiorczy-pomocniki.js';

const TERAZ = '2026-10-15T10:00:00.000Z';
const NIP_PRACOWNI = '5250000009'; // zmyślony, z poprawną sumą kontrolną
const AUTH = { authorization: `Basic ${Buffer.from('operator:fixture').toString('base64')}` };
const POST = { ...AUTH, origin: 'http://localhost', 'content-type': 'application/x-www-form-urlencoded' };
const formularz = (pola) => new URLSearchParams(pola).toString();

const NAZWA_TESTOWNIKA = Object.freeze({
  mianownik: 'Testownik', dopelniacz: 'Testownika', miejscownik: 'Testowniku', narzednik: 'Testownikiem',
});
const ZDANIE_KSEF = 'Testownik nie wysyła do KSeF z OMS-u —';
const ZDANIE_NIEOPLACONYCH = 'Testownik nie podaje listy nieopłaconych faktur';

/**
 * Program testowy z licznikami. `podklad` — obiekt o metodach kontraktu (tu: atrapa inFaktu za adapterem), który
 * daje zachowanie konta; `bez` — metody (zdolności) pominięte; `limity` — nadpisane limity opisu.
 *
 * ⚠️ `znajdzKlientaPoNip` / `zalozKlienta` NIE należą do kontraktu: dokładamy je wyłącznie dlatego, że na gałęzi tej
 * zmiany faktura.js (zmiana 06 idzie równolegle) woła jeszcze kartotekę inFaktu wprost. Po 06 faktura idzie przez
 * `przygotujNabywce`, a te dwie metody przestają być wołane. Strażnik kontraktu ich nie ogląda.
 */
function programTestowy({ podklad = {}, surowy = {}, bez = [], limity = {} } = {}) {
  const liczniki = {};
  const licz = (nazwa) => async (...a) => {
    liczniki[nazwa] = (liczniki[nazwa] ?? 0) + 1;
    return podklad[nazwa] ? podklad[nazwa](...a) : null;
  };
  const metody = {};
  for (const m of [...METODY_OBOWIAZKOWE, ...Object.values(METODA_ZDOLNOSCI)]) if (!bez.includes(m)) metody[m] = licz(m);
  for (const m of ['znajdzKlientaPoNip', 'zalozKlienta']) if (surowy[m]) metody[m] = (...a) => surowy[m](...a);
  const zdolnosci = Object.entries(METODA_ZDOLNOSCI).filter(([, m]) => metody[m]).map(([z]) => z);
  const program = {
    ...metody,
    opis: {
      id: 'testowy', nazwa: NAZWA_TESTOWNIKA, regulaVat: 'wierszami', zdolnosci, wystawienieWysylaDoKsef: false,
      limity: { zadanieMs: 30000, najdluzszaListaMs: 120000, stronaListy: 25, sufitStron: 40, rownolegleStron: 4, ...limity },
      adres: 'https://testownik.invalid', ekran: '/ustawienia/integracje/testownik',
    },
  };
  return { program: sprawdzProgramFakturowy(program), liczniki };
}

function envTestu(katalog) {
  return {
    OMS_TRYB: 'proba', OMS_USER: 'operator', OMS_PASS: 'fixture', OMS_SPRZEDAWCA_NIP: '1234563218',
    OMS_RACHUNEK: '34109010140000000000000000', OMS_PROFORMY_KATALOG: katalog, OMS_ETYKIETY_KATALOG: katalog,
  };
}

/** Pełna aplikacja z programem testowym w szwie `fabryki.programFakturowy`. */
async function aplikacja(katalog, opcje = {}) {
  const env = envTestu(katalog);
  let wynik = null;
  const fabryki = {
    programFakturowy: ({ db, teraz }) => {
      const atrapa = createAtrapaInfaktu({ db, teraz, env, log: () => {} });
      wynik = programTestowy({ podklad: programInfakt(atrapa), surowy: atrapa, ...opcje });
      return wynik.program;
    },
    createVies: () => createAtrapaVies({ env }),
  };
  const moduly = modulyDla(env).map((m) => (m.nazwa === 'faktury' ? createModulFaktury({ fabryki }) : m));
  const a = await zbudujOms({ env, moduly, teraz: () => new Date(), log: () => {} });
  const http = (metoda, url, pola) => a.app.inject({ method: metoda, url, headers: metoda === 'GET' ? AUTH : POST,
    ...(metoda === 'GET' ? {} : { payload: typeof pola === 'string' ? pola : formularz(pola ?? {}) }) });
  return { a, http, liczniki: wynik.liczniki, program: wynik.program };
}

const zamowienie = (numer, nad = {}) => ({
  zrodlo_id: Number(numer.replace(/\D/g, '')), numer,
  klient: { company: 'Pracownia Półcień sp. z o.o.', email: 'biuro@polcien.invalid', phone: '+48500100200',
    address_1: 'Lampowa 1', postcode: '00-950', city: 'Warszawa', country: 'PL' },
  dostawa: { first_name: 'Anna', last_name: 'Półcień', address_1: 'Lampowa 1', postcode: '00-950', city: 'Warszawa', country: 'PL' },
  metoda_wysylki: 'dpd', kwota_pobrania: null, pobranie: 0, chce_fakture: 1, nip: NIP_PRACOWNI,
  kwota_brutto: '357.00', koszt_dostawy_brutto: '15.00', status_woo: 'processing', oplacone_at: null, anulowane: 0,
  utworzone_at: '2026-10-10T09:00:00Z',
  pozycje: [
    { zrodlo_id: 11, nazwa: 'Lampa wisząca Półcień', sku: 'LAMPA-W1', ilosc: 2, cena_brutto: '129.00', brutto_linii: '258.00', vat: null },
    { zrodlo_id: 12, nazwa: 'Klosz lniany', sku: 'KLOSZ-L', ilosc: 1, cena_brutto: '84.00', brutto_linii: '84.00', vat: null },
  ],
  ...nad,
});

let katalog;
beforeEach(() => {
  katalog = mkdtempSync(join(tmpdir(), 'prz118-07-'));
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(TERAZ));
});
afterEach(() => {
  vi.useRealTimers();
  rmSync(katalog, { recursive: true, force: true });
});

describe('PRZ-118.07 (2) wystawienie ≠ wysyłka do KSeF', () => {
  it('faktura, faktura okresu i korekta nie wołają wysyłki; podgląd też nie; zatwierdzenie N dokumentów woła N razy', async () => {
    const { a, http, liczniki } = await aplikacja(katalog);
    const oczekuj = (r, kod, co) => expect(r.statusCode, `${co}: ${r.body.slice(0, 400)}`).toBe(kod);
    try {
      const db = a.db;
      // Faktura zamówienia, przedpłacona (oznaczenie zapłaty) i za pobraniem.
      const z1 = zapiszZamowienie(db, 'reczne', zamowienie('PC-701'), {});
      oczekuj(await http('POST', `/zamowienia/${z1}/platnosci`, { kwota: '357,00', data: '2026-10-12', metoda: 'Przelew' }), 302, 'wpłata');
      oczekuj(await http('POST', `/zamowienia/${z1}/faktura`, { termin: 'zaplacone', data_wystawienia: '', data_sprzedazy: '' }), 302, 'faktura 1');
      const z2 = zapiszZamowienie(db, 'reczne', zamowienie('PC-702', { pobranie: 1, kwota_pobrania: '357.00' }), {});
      oczekuj(await http('POST', `/zamowienia/${z2}/faktura`, {}), 302, 'faktura 2');
      // Faktura okresu klienta zbiorczego.
      dopiszKlientaZbiorczego(db, { klucz: 'polcien', nazwa: 'Pracownia Półcień sp. z o.o.', nip: NIP_PRACOWNI });
      const z3 = zapiszZamowienie(db, 'reczne', zamowienie('PC-703'), {});
      oczekuj(await http('POST', `/zamowienia/${z3}/okres`, {}), 302, 'okres');
      const { okres_rozliczeniowy_id: okresId } = db.prepare('SELECT okres_rozliczeniowy_id FROM zamowienia WHERE id = ?').get(z3);
      oczekuj(await http('POST', `/okresy/${okresId}/wystaw-fakture`, {}), 302, 'faktura okresu');
      // Korekta zwrotu.
      oczekuj(await http('POST', `/zamowienia/${z1}/zwrot`, {
        data: '2026-10-14', kwota: '129.00', kwota_dostawy: '', powod: 'klosz pęknięty',
        klucz: 's11', nazwa: 'Lampa wisząca Półcień', ilosc: '1', pozycja_kwota: '129.00',
      }), 302, 'zwrot');
      const { id: zwrotId } = db.prepare('SELECT id FROM zwroty WHERE zamowienie_id = ?').get(z1);
      oczekuj(await http('POST', `/zamowienia/${z1}/zwroty/${zwrotId}/korekta`, {}), 302, 'korekta');

      // Wszystkie trzy drogi wystawienia naprawdę doszły do programu…
      expect(liczniki.wystaw).toBe(3);
      expect(liczniki.wystawKorekte).toBe(1);
      // …i żadna nie wysłała niczego do KSeF.
      expect(liczniki.wyslijDokumentDoKsef ?? 0).toBe(0);

      // Zakładka FAKTURY i PDF z listy idą przez program.
      oczekuj(await http('GET', '/faktury?miesiac=2026-10'), 200, 'FAKTURY');
      expect(liczniki.listaFaktur).toBeGreaterThan(0);
      expect(liczniki.listaNieoplaconych).toBeGreaterThan(0);
      const faktury = await a.usluga('faktury', 'programFakturowy').listaFaktur({});
      const doKsef = faktury.filter((f) => f.client_tax_code).slice(0, 2).map((f) => f.uuid);
      expect(doKsef).toHaveLength(2);
      oczekuj(await http('GET', `/faktury/${doKsef[0]}/pdf?rodzaj=vat&numer=x`), 200, 'PDF');
      expect(liczniki.pobierzPdf).toBe(1);

      // Podgląd niczego nie wysyła; zatwierdzenie wysyła dokładnie zaznaczone dokumenty, każdy raz.
      const ksef = new URLSearchParams([['miesiac', '2026-10'], ['pole', 'invoice_date'], ...doKsef.map((u) => ['uuid', u])]).toString();
      const podglad = await http('POST', '/faktury/ksef/podglad', ksef);
      oczekuj(podglad, 200, 'podgląd');
      expect(liczniki.wyslijDokumentDoKsef ?? 0).toBe(0);
      oczekuj(await http('POST', '/faktury/ksef/wyslij', ksef), 200, 'wysyłka');
      expect(liczniki.wyslijDokumentDoKsef).toBe(2);
    } finally {
      await a.app.close();
      a.db.close();
    }
  });
});

describe('PRZ-118.07 (3) program bez zdolności wyslijDoKsef', () => {
  it('podgląd i zatwierdzenie odpowiadają zdaniem z nazwą programu (nie 500), automat KSeF pominięty z tym powodem', async () => {
    const { a, http, program } = await aplikacja(katalog, { bez: ['wyslijDokumentDoKsef'] });
    try {
      expect(program.opis.zdolnosci).not.toContain('wyslijDoKsef');
      const ksef = formularz({ miesiac: '2026-10', pole: 'invoice_date', uuid: 'u-1' });
      for (const url of ['/faktury/ksef/podglad', '/faktury/ksef/wyslij']) {
        const r = await http('POST', url, ksef);
        expect(r.statusCode, url).toBeLessThan(500);
        expect(r.statusCode, url).not.toBe(200);
        expect(r.body, url).toContain(ZDANIE_KSEF);
        expect(r.body, url).not.toContain('inFakt');
      }
      const automat = a.usluga('faktury', 'automatKsef');
      const w = await automat.przebieg();
      expect(w).toMatchObject({ pominiety: true });
      expect(w.powod).toContain(ZDANIE_KSEF);
    } finally {
      await a.app.close();
      a.db.close();
    }
  });

  it('usługa wysyłki sama też odmawia tym zdaniem, zanim cokolwiek zarezerwuje', async () => {
    const db = openOmsDb(':memory:');
    const { program } = programTestowy({ bez: ['wyslijDokumentDoKsef'] });
    const dokumenty = vi.fn(async () => []);
    const u = createWysylkaKsef({ db, program, fakturyWidok: { dokumenty } });
    expect(u.niedostepna).toContain(ZDANIE_KSEF);
    await expect(u.wyslij({ uuids: ['u-1'], miesiac: '2026-10', pole: 'invoice_date' })).rejects.toThrow(ZDANIE_KSEF);
    expect(dokumenty).not.toHaveBeenCalled();
    const automat = createAutomatKsef({ db, fakturyWidok: { dokumenty }, wysylkaKsef: u, log: () => {} });
    expect((await automat.przebieg()).powod).toContain(ZDANIE_KSEF);
    db.close();
  });
});

describe('PRZ-118.07 (4) program bez zdolności nieoplacone', () => {
  it('zakładka FAKTURY renderuje się, a sekcja nieopłaconych mówi zdaniem, że program jej nie podaje', async () => {
    const { a, http, liczniki } = await aplikacja(katalog, { bez: ['listaNieoplaconych'] });
    try {
      const r = await http('GET', '/faktury?miesiac=2026-10');
      expect(r.statusCode, r.body.slice(0, 300)).toBe(200);
      expect(r.body).toContain(ZDANIE_NIEOPLACONYCH);
      // Brak zdolności to nie awaria: ani „nie udało się”, ani „nikt nie zalega”.
      expect(r.body).not.toContain('Nie udało się pobrać nieopłaconych');
      expect(r.body).not.toContain('Nikt nie zalega z przelewem');
      expect(liczniki.listaFaktur).toBeGreaterThan(0);
    } finally {
      await a.app.close();
      a.db.close();
    }
  });
});

describe('PRZ-118.07 (5) budżet czuwaczy z program.opis.limity', () => {
  it('budżet przebiegu czuwacza KSeF i archiwum sprzedaży liczony z limitów programu, a czuwacze składają się na programie', () => {
    const db = openOmsDb(':memory:');
    const { program } = programTestowy({ limity: { zadanieMs: 31000, najdluzszaListaMs: 90000 } });
    const { limity } = program.opis;
    // 50 × 31 s + 50 × 5 s; 30 min + 90 s + 31 s — inne niż stałe inFaktu, więc liczone naprawdę z limitów programu.
    expect(najdluzszyPrzebiegMs(limity)).toBe(50 * 31000 + 50 * 5000);
    expect(najdluzszyPrzebiegMs(limity)).not.toBe(NAJDLUZSZY_PRZEBIEG_MS);
    expect(najdluzszyPrzebiegArchiwumSprzedazyMs(limity)).not.toBe(NAJDLUZSZY_PRZEBIEG_ARCHIWUM_SPRZEDAZY_MS);
    expect(najdluzszyPrzebiegArchiwumSprzedazyMs(limity) - najdluzszyPrzebiegArchiwumSprzedazyMs({ ...limity, najdluzszaListaMs: 0, zadanieMs: 0 }))
      .toBe(90000 + 31000);
    expect(typeof createCzuwaczKsef({ db, program }).przebieg).toBe('function');
    expect(typeof createCzuwaczArchiwumSprzedazy({ db, program, katalogArchiwum: katalog }).przebieg).toBe('function');
    db.close();
  });

});
