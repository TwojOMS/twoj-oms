// PRZ-118.09 — NAZWA PROGRAMU FAKTUROWEGO W TEKSTACH I WIDOKACH.
//
// (1) MIGAWKA: każdy ekran, którego widok albo model zmienia 09, wyrenderowany przez trasy PEŁNEJ aplikacji z inFaktem
//     (prawdziwy klient inFaktu, a pod nim nagrywarka — tests/pomoc/nagrywarka-infaktu.js, nic nie wychodzi z procesu)
//     i bez inFaktu. HTML porównywany `toEqual` z tests/dane/prz118-09-migawki.json, zapisanym na drzewie `src/` SPRZED
//     zmiany 09 (ZAPISZ_MIGAWKE=1, tylko z czystym `src/`). Czerwony = ekran inFaktu zmienił się choćby o znak.
//
// Determinizm: stały zegar (podmienione tylko Date), identyfikatory dokumentów (losowe UUID atrapy) zastąpione
// U1, U2… w kolejności pierwszego wystąpienia na stronie, wersja zasobów (`?v=`) wycięta — zmiana CSS nie jest
// zmianą tekstu. Panel nie ma tokenów CSRF ani nonce w HTML (sprawdzone: brak w layoucie i w tych widokach).
//
// ⚠️ Migawki NIE przepisuje się, żeby zazielenić test po zmianie 09 — to jest cały dowód „wynik dla inFaktu bez zmian”.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zbudujOms } from '../../../src/oms/bootstrap.ts';
import { zapiszZamowienie } from '../../../src/oms/db/zamowienia.js';
import { dodajWplateOkresu } from '../../../src/oms/db/platnosci.js';
import { usunKonfiguracjeIntegracji } from '../../../src/oms/db/konfiguracja-integracji.js';
import { wstrzymajFakture, zapiszWynikAutomatu } from '../../../src/moduly/faktury/db/ksef-automat.js';
import { dopiszKlientaZbiorczego } from './_klient-zbiorczy-pomocniki.js';
import { createNagrywarkaInfaktu } from '../../pomoc/nagrywarka-infaktu.js';
import { programTestowy } from '../../pomoc/program-testowy.js';
import { programInfakt } from '../../../src/integracje/programy/infakt.ts';
import { METODY_OBOWIAZKOWE, METODA_ZDOLNOSCI } from '../../../src/integracje/program-fakturowy.ts';
import { podsumowanieVatKarty } from '../../../src/domena/tabela-pozycji.js';
import { modulyDla } from '../../../src/moduly/lista.ts';
import { createModulFaktury } from '../../../src/moduly/faktury/modul.ts';
import { createAtrapaVies } from '../../../deploy/proba/atrapy/infakt.mjs';

const KATALOG_TESTU = dirname(fileURLToPath(import.meta.url));
const KORZEN = join(KATALOG_TESTU, '../../..');
const MIGAWKA = join(KORZEN, 'tests/dane/prz118-09-migawki.json');
const TERAZ = '2026-10-15T10:00:00.000Z';
const KLUCZ = 'syntetyczny-klucz-testowy';
const NIP_PRACOWNI = '5250000009'; // zmyślony, z poprawną sumą kontrolną

const AUTH = { authorization: `Basic ${Buffer.from('operator:fixture').toString('base64')}` };
const POST = { ...AUTH, origin: 'http://localhost', 'content-type': 'application/x-www-form-urlencoded' };

// Usługa faktur Allegro bez kanału Allegro w konfiguracji — karta pokazuje przycisk wysyłki (nic nie jest wołane).
const Z_FAKTURA_ALLEGRO = Object.freeze({ 'faktury.fakturaAllegro': Object.freeze({}) });

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
/** HTML do porównania: UUID-y → U1, U2… (kolejność pierwszego wystąpienia na TEJ stronie), wersja zasobów wycięta. */
export function znormalizuj(html) {
  const nazwy = new Map();
  return html
    .replace(UUID, (u) => {
      const k = u.toLowerCase();
      if (!nazwy.has(k)) nazwy.set(k, `U${nazwy.size + 1}`);
      return nazwy.get(k);
    })
    .replace(/\?v=[^"'&\s)]+/g, '?v=X');
}

/**
 * Wpis migawki: treść `<main>` w całości (czytelny diff) + SHA-256 reszty strony (układ, menu, logo — ok. 185 KB
 * na stronę, wspólne dla wszystkich ekranów; skrót i tak łapie każdą zmianę znaku poza `<main>`).
 */
export function wpisMigawki(html) {
  const n = znormalizuj(html);
  const od = n.indexOf('<main');
  const doKonca = n.indexOf('</main>');
  if (od < 0 || doKonca < od) return { glowna: n, reszta: null };
  const glowna = n.slice(od, doKonca + '</main>'.length);
  const reszta = createHash('sha256').update(n.slice(0, od) + '<main/>' + n.slice(doKonca + '</main>'.length)).digest('hex');
  return { glowna, reszta };
}

export function envTestu(katalog, { zKluczem = true, proba = false } = {}) {
  return {
    OMS_USER: 'operator', OMS_PASS: 'fixture', OMS_SPRZEDAWCA_NIP: '1234563218',
    OMS_RACHUNEK: '34109010140000000000000000', OMS_PROFORMY_KATALOG: katalog, OMS_ETYKIETY_KATALOG: katalog,
    ...(zKluczem ? { INFAKT_API_KEY: KLUCZ, INFAKT_ARCHIWUM: join(katalog, 'archiwum') } : {}),
    ...(proba ? { OMS_TRYB: 'proba' } : {}),
  };
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

/**
 * Ekrany z programem fakturowym (inFakt albo program testowy — ten sam scenariusz, te same trasy).
 * `awaria(metody)` — od tej chwili wskazane metody atrapy rzucają (ekrany z błędem odczytu); `awaria([])` — koniec.
 * @returns {Promise<Record<string, string>>} nazwa ekranu → HTML (surowy, przed normalizacją)
 */
export async function ekranyZProgramem(a, { awaria }) {
  const db = a.db;
  const ekrany = {};
  const http = (metoda, url, pola) => a.app.inject({ method: metoda, url, headers: metoda === 'GET' ? AUTH : POST,
    ...(metoda === 'GET' ? {} : { payload: typeof pola === 'string' ? pola : new URLSearchParams(pola ?? {}).toString() }) });
  const oczekuj = (r, kod, co) => expect(r.statusCode, `${co}: ${r.body.slice(0, 400)}`).toBe(kod);
  const ekran = async (nazwa, metoda, url, pola) => {
    const r = await http(metoda, url, pola);
    oczekuj(r, 200, nazwa);
    ekrany[nazwa] = r.body;
  };

  // ── faktura krajowa przedpłacona i za pobraniem; karta z fakturą i bez
  const z1 = zapiszZamowienie(db, 'reczne', zamowienie('PC-101'), {});
  oczekuj(await http('POST', `/zamowienia/${z1}/platnosci`, { kwota: '357,00', data: '2026-10-12', metoda: 'Przelew' }), 302, 'wpłata');
  oczekuj(await http('POST', `/zamowienia/${z1}/faktura`, { termin: 'zaplacone', data_wystawienia: '', data_sprzedazy: '' }), 302, 'faktura z1');
  // Jedyna faktura jest zapłacona — pas nieopłaconych mówi „Nikt nie zalega…”.
  await ekran('FAKTURY — nikt nie zalega', 'GET', '/faktury?miesiac=2026-10');
  const z2 =zapiszZamowienie(db, 'reczne', zamowienie('PC-102', { pobranie: 1, kwota_pobrania: '357.00' }), {});
  oczekuj(await http('POST', `/zamowienia/${z2}/faktura`, {}), 302, 'faktura z2');
  await ekran('karta z fakturą', 'GET', `/zamowienia/${z1}`);
  const z3 = zapiszZamowienie(db, 'reczne', zamowienie('PC-103'), {});
  // Za pobraniem — hurt wystawi ją „przy odbiorze” (PC-103 bez wpłaty zostaje pominięte: obie listy na ekranie).
  const z4 = zapiszZamowienie(db, 'reczne', zamowienie('PC-104', { nip: null, pobranie: 1, kwota_pobrania: '357.00' }), {});
  await ekran('karta bez faktury', 'GET', `/zamowienia/${z3}`);

  // ── faktury hurtem: podgląd (nic jeszcze nie idzie do programu)
  await ekran('faktury hurtem — podgląd', 'POST', '/zamowienia/faktury-hurtem/podglad',
    new URLSearchParams([['id', String(z3)], ['id', String(z4)]]).toString());

  // ── okres rozliczeniowy: przed fakturą, po fakturze, karta zamówienia w okresie
  dopiszKlientaZbiorczego(db, { klucz: 'polcien', nazwa: 'Pracownia Półcień sp. z o.o.', nip: NIP_PRACOWNI });
  const z5a = zapiszZamowienie(db, 'reczne', zamowienie('PC-105'), {});
  const z5b = zapiszZamowienie(db, 'reczne', zamowienie('PC-106', { utworzone_at: '2026-10-11T09:00:00Z' }), {});
  for (const id of [z5a, z5b]) oczekuj(await http('POST', `/zamowienia/${id}/okres`, {}), 302, `okres ${id}`);
  const { okres_rozliczeniowy_id: okresId } = db.prepare('SELECT okres_rozliczeniowy_id FROM zamowienia WHERE id = ?').get(z5a);
  await ekran('okres przed fakturą', 'GET', `/okresy/${okresId}`);
  await ekran('karta w okresie przed fakturą', 'GET', `/zamowienia/${z5a}`);
  oczekuj(await http('POST', `/okresy/${okresId}/wystaw-fakture`, {}), 302, 'faktura okresu');
  await ekran('okres po fakturze', 'GET', `/okresy/${okresId}`);
  await ekran('karta w okresie po fakturze', 'GET', `/zamowienia/${z5a}`);
  // Saldo wbrew fakturze: po wystawieniu jedno zamówienie anulowane, a klient zapłacił całość.
  db.prepare('UPDATE zamowienia SET anulowane = 1 WHERE id = ?').run(z5b);
  dodajWplateOkresu(db, okresId, { kwota: '714.00', data: '2026-10-14', metoda: 'Przelew', uwaga: null });
  await ekran('okres — saldo wbrew fakturze', 'GET', `/okresy/${okresId}`);
  // Okresy z fakturą do wyjaśnienia i zawieszoną (stan, który zostawia przerwane wystawianie).
  const okresWyj = Number(db.prepare(`INSERT INTO okresy_rozliczeniowe (klient_klucz, rok, miesiac, stan, ksef_status, blad_opis, utworzona_at, utworzony_at)
    VALUES ('polcien', 2026, 8, 'zamkniety', 'do_wyjasnienia', 'zerwane połączenie', '2026-09-01T08:00:00.000Z', '2026-08-01T08:00:00.000Z')`).run().lastInsertRowid);
  const okresZaw = Number(db.prepare(`INSERT INTO okresy_rozliczeniowe (klient_klucz, rok, miesiac, stan, ksef_status, utworzona_at, utworzony_at)
    VALUES ('polcien', 2026, 7, 'zamkniety', 'w_toku', '2026-08-01T08:00:00.000Z', '2026-07-01T08:00:00.000Z')`).run().lastInsertRowid);
  await ekran('okres — faktura do wyjaśnienia', 'GET', `/okresy/${okresWyj}`);
  await ekran('okres — faktura zawieszona', 'GET', `/okresy/${okresZaw}`);

  // ── zwrot z korektą (zlecenie przez trasę; numer korekty doczytany przy otwarciu ekranu zwrotu)
  oczekuj(await http('POST', `/zamowienia/${z1}/zwrot`, {
    data: '2026-10-14', kwota: '129.00', kwota_dostawy: '', powod: 'klosz pęknięty',
    klucz: 's11', nazwa: 'Lampa wisząca Półcień', ilosc: '1', pozycja_kwota: '129.00',
  }), 302, 'zwrot');
  const { id: zwrotId } = db.prepare('SELECT id FROM zwroty WHERE zamowienie_id = ?').get(z1);
  oczekuj(await http('POST', `/zamowienia/${z1}/zwroty/${zwrotId}/korekta`, {}), 302, 'korekta');
  await ekran('zwrot z korektą', 'GET', `/zamowienia/${z1}/zwrot`);
  // Zwrot z korektą zleconą dawno i bez numeru (odrzucona) oraz dwa takie przy jednym zamówieniu (panel nie pytał).
  const wstawZwrot = (zam, zlecona) => db.prepare(`INSERT INTO zwroty (zamowienie_id, data, kwota, powod, korekta_zlecona_at, utworzony_at)
    VALUES (?, '2026-10-01', '84.00', 'klosz', ?, '2026-10-01T08:00:00.000Z')`).run(zam, zlecona);
  wstawZwrot(z2, '2026-10-01T09:00:00.000Z');
  await ekran('zwrot — korekta odrzucona', 'GET', `/zamowienia/${z2}/zwrot`);
  wstawZwrot(z2, '2026-10-02T09:00:00.000Z');
  await ekran('zwrot — dwie korekty, panel nie pytał', 'GET', `/zamowienia/${z2}/zwrot`);
  const z6 = zapiszZamowienie(db, 'reczne', zamowienie('PC-107'), {});
  db.prepare("INSERT INTO faktury (zamowienie_id, numer, ksef_status, utworzona_at, program, dokument_id) VALUES (?, 'FV 90/10/2026', NULL, '2026-10-12T08:00:00.000Z', 'infakt', 'dok-reczny-90')").run(z6);
  wstawZwrot(z6, null);
  await ekran('zwrot — bez korekty (pole numeru ręcznej)', 'GET', `/zamowienia/${z6}/zwrot`);

  // ── karta: faktura do wyjaśnienia, zawieszona, zamówienie anulowane po fakturze
  const z7 = zapiszZamowienie(db, 'reczne', zamowienie('PC-108'), {});
  db.prepare("INSERT INTO faktury (zamowienie_id, ksef_status, blad_opis, utworzona_at) VALUES (?, 'do_wyjasnienia', 'zerwane połączenie', '2026-10-14T08:00:00.000Z')").run(z7);
  await ekran('karta — faktura do wyjaśnienia', 'GET', `/zamowienia/${z7}`);
  const z8 = zapiszZamowienie(db, 'reczne', zamowienie('PC-109'), {});
  db.prepare("INSERT INTO faktury (zamowienie_id, ksef_status, utworzona_at) VALUES (?, 'w_toku', '2026-10-14T08:00:00.000Z')").run(z8);
  await ekran('karta — faktura zawieszona', 'GET', `/zamowienia/${z8}`);
  db.prepare('UPDATE zamowienia SET anulowane = 1 WHERE id = ?').run(z2);
  await ekran('karta — anulowane z fakturą', 'GET', `/zamowienia/${z2}`);

  // ── FAKTURY: odczyt na żywo, potem awaria obu list
  await ekran('FAKTURY', 'GET', '/faktury?miesiac=2026-10');
  awaria(['listaFaktur', 'listaKorekt', 'listaNieoplaconych']);
  await ekran('FAKTURY — program nie odpowiada', 'GET', '/faktury?miesiac=2026-10');
  awaria([]);

  // ── KSeF: podgląd i wynik wysyłki dwóch faktur z NIP-em
  const faktury = await a.usluga('faktury', 'fakturyWidok').dokumenty({ miesiac: '2026-10', pole: 'invoice_date', dzis: '2026-10-15' });
  const doKsef = ['FV 1/10/2026', 'FV 2/10/2026'].map((n) => faktury.find((f) => f.number === n).uuid);
  const ksef = new URLSearchParams([['miesiac', '2026-10'], ['pole', 'invoice_date'], ...doKsef.map((u) => ['uuid', u])]).toString();
  await ekran('KSeF — podgląd', 'POST', '/faktury/ksef/podglad', ksef);
  await ekran('KSeF — wynik', 'POST', '/faktury/ksef/wyslij', ksef);

  // ── automat KSeF: przebieg przerwany z wynikiem niepewnym i wstrzymaną fakturą; ekran wyniku i Automatyzacje
  zapiszWynikAutomatu(db, { dzien: '2026-10-14', stan: 'przerwany', startAt: '2026-10-14T18:00:00.000Z', koniecAt: null,
    wTrakcie: { numer: 'FV 7/10/2026' }, wyslane: [{ numer: 'FV 5/10/2026' }], niepewne: [{ numer: 'FV 6/10/2026' }],
    pominiete: [], blad: 'zerwane połączenie', poZasadzie: [] });
  wstrzymajFakture(db, { uuid: 'dok-wstrzymany-8', numer: 'FV 8/10/2026', dzien: '2026-10-14', powod: 'nabywca bez adresu' });
  await ekran('automat KSeF — wynik', 'GET', '/faktury/ksef/automat');
  await ekran('Ustawienia → Automatyzacje', 'GET', '/ustawienia/automatyzacje');
  zapiszWynikAutomatu(db, { dzien: '2026-10-14', stan: 'przerwany', startAt: '2026-10-14T18:00:00.000Z', koniecAt: null,
    wTrakcie: null, wyslane: [], niepewne: [], pominiete: [], blad: null, poZasadzie: [] });
  await ekran('automat KSeF — przerwany przed pierwszym dokumentem', 'GET', '/faktury/ksef/automat');

  // ── koszty: Ustawienia → Integracje → KSeF (zdanie o wysyłce sprzedaży przez program)
  await ekran('Ustawienia → KSeF kosztów', 'GET', '/ustawienia/integracje/ksef');

  // ── karta zamówienia z Allegro (na końcu: wiersze faktur bez dokumentu w programie nie zmieniają ekranów wyżej).
  // Bez usługi faktur Allegro — zdanie „Kanał Allegro albo … nie jest skonfigurowany”; z usługą — wysyłka pliku
  // i ponowienie po odrzuceniu (`nadpisania['faktury.fakturaAllegro']` w składzie aplikacji).
  await ekranyAllegro(db, ekran, '', 301);
  return ekrany;
}

async function ekranyAllegro(db, ekran, przedrostek, nr) {
  const wstawFakture = (zam, numer, dodatki = {}) => db.prepare(`INSERT INTO faktury (zamowienie_id, numer, ksef_status, ksef_numer,
    utworzona_at, program, dokument_id, allegro_invoice_id, allegro_wyslana_at, allegro_weryfikacja)
    VALUES (?, ?, NULL, ?, '2026-10-13T08:00:00.000Z', 'infakt', ?, ?, ?, ?)`).run(zam, numer, `${NIP_PRACOWNI}-20261013-0A1B2C3D4E5F-0${zam % 10}`,
    `dok-allegro-${zam}`, dodatki.invoiceId ?? null, dodatki.wyslana ?? null, dodatki.weryfikacja ?? null);
  const za = zapiszZamowienie(db, 'allegro_lampy', zamowienie(`AL-${nr}`), {});
  wstawFakture(za, `FV ${nr}/10/2026`);
  await ekran(`${przedrostek}karta Allegro — faktura dla kupującego`, 'GET', `/zamowienia/${za}`);
  const zr = zapiszZamowienie(db, 'allegro_lampy', zamowienie(`AL-${nr + 1}`), {});
  wstawFakture(zr, `FV ${nr + 1}/10/2026`, { invoiceId: 'alg-inv-92', wyslana: '2026-10-14T08:00:00.000Z', weryfikacja: 'REJECTED' });
  await ekran(`${przedrostek}karta Allegro — plik odrzucony`, 'GET', `/zamowienia/${zr}`);
}

/** Ekrany bez programu fakturowego — tam, gdzie widok mówi o braku inFaktu. */
export async function ekranyBezProgramu(a) {
  const db = a.db;
  const ekrany = {};
  const http = (metoda, url, pola) => a.app.inject({ method: metoda, url, headers: metoda === 'GET' ? AUTH : POST,
    ...(metoda === 'GET' ? {} : { payload: typeof pola === 'string' ? pola : new URLSearchParams(pola ?? {}).toString() }) });
  const ekran = async (nazwa, metoda, url, pola) => {
    const r = await http(metoda, url, pola);
    expect(r.statusCode, `${nazwa}: ${r.body.slice(0, 400)}`).toBe(200);
    ekrany[nazwa] = r.body;
  };
  const z = zapiszZamowienie(db, 'reczne', zamowienie('PC-201'), {});
  await ekran('bez programu: FAKTURY', 'GET', '/faktury');
  await ekran('bez programu: karta', 'GET', `/zamowienia/${z}`);
  await ekran('bez programu: faktury hurtem — podgląd', 'POST', '/zamowienia/faktury-hurtem/podglad', `id=${z}`);
  dopiszKlientaZbiorczego(db, { klucz: 'polcien', nazwa: 'Pracownia Półcień sp. z o.o.', nip: NIP_PRACOWNI });
  const zo = zapiszZamowienie(db, 'reczne', zamowienie('PC-202'), {});
  expect((await http('POST', `/zamowienia/${zo}/okres`, {})).statusCode).toBe(302);
  const { okres_rozliczeniowy_id: okresId } = db.prepare('SELECT okres_rozliczeniowy_id FROM zamowienia WHERE id = ?').get(zo);
  await ekran('bez programu: okres', 'GET', `/okresy/${okresId}`);
  await ekran('bez programu: Ustawienia → Automatyzacje', 'GET', '/ustawienia/automatyzacje');
  await ekran('bez programu: Ustawienia → KSeF kosztów', 'GET', '/ustawienia/integracje/ksef');
  await ekranyAllegro(db, ekran, 'bez programu: ', 401);
  return ekrany;
}

describe('PRZ-118.09 nazwa programu w tekstach i widokach', () => {
  let katalog;
  let nagrywarka;
  const atrapaRzuca = new Set();
  beforeAll(() => {
    katalog = mkdtempSync(join(tmpdir(), 'prz118-09-'));
    mkdirSync(join(katalog, 'archiwum'));
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(TERAZ));
  });
  // Każdy test na ŚWIEŻEJ atrapie: dokumenty z jednego scenariusza nie mogą zmieniać ekranów drugiego.
  beforeEach(() => {
    atrapaRzuca.clear();
    nagrywarka = createNagrywarkaInfaktu({ teraz: () => new Date(), kluczApi: KLUCZ });
    // Awaria na żądanie: metoda atrapy podmieniona na obiekcie (nagrywarka i adapter czytają ją w chwili wywołania).
    for (const m of ['listaFaktur', 'listaKorekt', 'listaNieoplaconych']) {
      const oryginal = nagrywarka.atrapa[m].bind(nagrywarka.atrapa);
      nagrywarka.atrapa[m] = async (...a) => {
        if (atrapaRzuca.has(m)) throw Object.assign(new Error('Atrapa: awaria odczytu (test PRZ-118.09).'), { status: 500 });
        return oryginal(...a);
      };
    }
    vi.stubGlobal('fetch', nagrywarka.fetch);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    nagrywarka?.zamknij();
    nagrywarka = null;
  });
  afterAll(() => {
    vi.useRealTimers();
    if (katalog) rmSync(katalog, { recursive: true, force: true });
  });
  const awaria = (metody) => { atrapaRzuca.clear(); for (const m of metody) atrapaRzuca.add(m); };

  it('(1) inFakt: każdy zmieniany ekran renderuje ten sam HTML co przed zmianą 09 (migawka)', async () => {
    const teraz = () => new Date();
    const wynik = {};
    const a = await zbudujOms({ env: envTestu(katalog), teraz, log: () => {}, nadpisania: Z_FAKTURA_ALLEGRO });
    try {
      for (const [k, v] of Object.entries(await ekranyZProgramem(a, { awaria }))) wynik[k] = wpisMigawki(v);
    } finally { await a.app.close(); a.db.close(); }
    const b = await zbudujOms({ env: envTestu(katalog, { zKluczem: false }), teraz, log: () => {} });
    let c = null;
    try {
      for (const [k, v] of Object.entries(await ekranyBezProgramu(b))) wynik[k] = wpisMigawki(v);
      // Automat KSeF przy kluczu zapisanym w Ustawieniach: przed restartem („już podłączony…”), a po restarcie
      // i odłączeniu („odłączony…”) — dwa pozostałe zdania powodu bezczynności automatu.
      const zapis = await b.app.inject({ method: 'POST', url: '/ustawienia/integracje/infakt', headers: POST,
        payload: new URLSearchParams({ apiKey: KLUCZ }).toString() });
      expect(zapis.statusCode, zapis.body.slice(0, 300)).toBe(303);
      const r1 = await b.app.inject({ method: 'GET', url: '/ustawienia/automatyzacje', headers: AUTH });
      expect(r1.statusCode).toBe(200);
      wynik['klucz w Ustawieniach przed restartem: Automatyzacje'] = wpisMigawki(r1.body);
      await b.app.close();
      c = await zbudujOms({ env: envTestu(katalog, { zKluczem: false }), db: b.db, teraz, log: () => {} });
      usunKonfiguracjeIntegracji(c.db, 'infakt');
      const r2 = await c.app.inject({ method: 'GET', url: '/ustawienia/automatyzacje', headers: AUTH });
      expect(r2.statusCode).toBe(200);
      wynik['program odłączony do restartu: Automatyzacje'] = wpisMigawki(r2.body);
    } finally { await b.app.close(); if (c) await c.app.close(); b.db.close(); }

    if (process.env.ZAPISZ_MIGAWKE === '1') {
      const brudne = execFileSync('git', ['status', '--porcelain', '--', 'src'], { cwd: KORZEN, encoding: 'utf8' }).trim();
      if (brudne) throw new Error(`ZAPISZ_MIGAWKE=1 odmawia: src/ ma niezatwierdzone zmiany:\n${brudne}`);
      const sha = execFileSync('git', ['rev-parse', '--short=7', 'HEAD'], { cwd: KORZEN, encoding: 'utf8' }).trim();
      const drzewoSrc = execFileSync('git', ['rev-parse', 'HEAD:src'], { cwd: KORZEN, encoding: 'utf8' }).trim();
      writeFileSync(MIGAWKA, `${JSON.stringify({ sha, drzewoSrc,
        opis: 'PRZ-118.09 — HTML ekranów z inFaktem i bez programu SPRZED zmiany 09. NIE przepisywać po zmianie 09.',
        ekrany: wynik }, null, 1)}\n`);
    }
    const migawka = JSON.parse(readFileSync(MIGAWKA, 'utf8')).ekrany;
    expect(Object.keys(wynik)).toEqual(Object.keys(migawka));
    for (const k of Object.keys(migawka)) expect(wynik[k], `ekran „${k}”`).toEqual(migawka[k]);
  }, 120_000);

  // Program testowy („Testownik”) nad tą samą atrapą: każda metoda kontraktu woła adapter inFaktu na atrapie,
  // ale opis (id, nazwa, ekran) jest Testownika. Szew `fabryki.programFakturowy` działa tylko w trybie próby.
  function programNadAtrapa(zmianyOpisu = {}) {
    const pod = programInfakt(nagrywarka.atrapa);
    const metody = Object.fromEntries([...METODY_OBOWIAZKOWE, ...Object.values(METODA_ZDOLNOSCI)]
      .map((m) => [m, (...a) => pod[m](...a)]));
    const p = programTestowy({ metody });
    return Object.keys(zmianyOpisu).length ? Object.assign(Object.create(null), p, { opis: Object.freeze({ ...p.opis, ...zmianyOpisu }) }) : p;
  }
  async function aplikacjaTestownika({ nadpisania = {}, program = programNadAtrapa() } = {}) {
    const env = envTestu(katalog, { zKluczem: false, proba: true });
    const fabryki = { programFakturowy: () => program, createVies: () => createAtrapaVies({ env }) };
    const moduly = modulyDla(env).map((m) => (m.nazwa === 'faktury' ? createModulFaktury({ fabryki }) : m));
    return zbudujOms({ env, moduly, teraz: () => new Date(), log: () => {}, nadpisania });
  }
  // Napisy, które zostają z założenia: ścieżka ekranu Ustawień inFaktu (`/ustawienia/integracje/infakt/…` — podmenu
  // i automat KSeF, plan: PRZ-119) i zmienna `INFAKT_ARCHIWUM` — obie bez „inFak” z wielką literą F.
  const NAZWA_INFAKTU = /inFak/;

  it('(2) program testowy: te same ekrany mówią „Testownik/Testownika/w Testowniku”, ani jednego „inFakt…”', async () => {
    const a = await aplikacjaTestownika({ nadpisania: Z_FAKTURA_ALLEGRO });
    let ekrany;
    try { ekrany = await ekranyZProgramem(a, { awaria }); } finally { await a.app.close(); a.db.close(); }
    // Bez usługi faktur Allegro: zdanie „Kanał Allegro albo … nie jest skonfigurowany” z odnośnikiem do ekranu programu.
    const b = await aplikacjaTestownika();
    const http = (url) => b.app.inject({ method: 'GET', url, headers: AUTH });
    try {
      const ekran = async (nazwa, _m, url) => { const r = await http(url); expect(r.statusCode).toBe(200); ekrany[nazwa] = r.body; };
      await ekranyAllegro(b.db, ekran, 'bez usługi Allegro: ', 501);
    } finally { await b.app.close(); b.db.close(); }

    expect(Object.keys(ekrany).length).toBeGreaterThanOrEqual(30);
    // Wszystkie trafienia naraz (ekran → fragmenty), żeby czerwony test pokazał pełną listę, a nie pierwszy ekran.
    const trafienia = Object.fromEntries(Object.entries(ekrany)
      .map(([nazwa, html]) => [nazwa, [...html.matchAll(/.{0,80}inFak.{0,40}/g)].map((m) => m[0].trim())])
      .filter(([, t]) => t.length));
    expect(trafienia, 'ekrany mówią inFakt przy programie testowym').toEqual({});
    for (const html of Object.values(ekrany)) expect(NAZWA_INFAKTU.test(html)).toBe(false);
    const tekst = (n) => ekrany[n].replace(/\s+/g, ' ');
    // Każdy przypadek odmiany co najmniej raz, na ekranie, gdzie dla inFaktu stoi odpowiednia forma.
    expect(tekst('FAKTURY')).toContain('dane z Testownika, odczyt na żywo');
    expect(tekst('FAKTURY — nikt nie zalega')).toContain('Tak twierdzi Testownik.');
    expect(tekst('FAKTURY')).toContain('Faktura skasowana w Testowniku');
    expect(tekst('FAKTURY — program nie odpowiada')).toContain('Nie wiadomo — Testownik nie odpowiedział.');
    expect(tekst('KSeF — podgląd')).toContain('Panel wysyła dokumenty do Testownika, a Testownik do KSeF.');
    expect(tekst('KSeF — wynik')).toContain('Co naprawdę poszło, widać w Testowniku.');
    expect(tekst('automat KSeF — wynik')).toContain('Testownik odrzucił ją');
    expect(tekst('faktury hurtem — podgląd')).toContain('Pójdzie do Testownika');
    expect(tekst('faktury hurtem — podgląd')).toContain('w Testowniku </button>');
    expect(tekst('okres — faktura zawieszona')).toContain('zrestartowany w trakcie wywołania Testownika');
    expect(tekst('zwrot — korekta odrzucona')).toContain('ale Testownik nie wystawił dokumentu');
    expect(tekst('karta — faktura do wyjaśnienia')).toContain('Sprawdziłem w Testowniku — faktury nie ma, odblokuj');
    expect(tekst('karta Allegro — faktura dla kupującego')).toContain('PDF pobierze się z Testownika na świeżo');
    expect(tekst('Ustawienia → KSeF kosztów')).toContain('Wysyłka faktur sprzedaży idzie przez Testownik');
    // Odnośnik do ekranu programu = opis.ekran (nie ekran inFaktu).
    const allegro = tekst('bez usługi Allegro: karta Allegro — faktura dla kupującego');
    expect(allegro).toContain('Kanał Allegro albo Testownik nie jest skonfigurowany');
    expect(allegro).toContain('Klucz API Testownika wpiszesz w <a href="/ustawienia/integracje/testownik">Ustawienia → Integracje → Testownik</a>');
    expect(allegro).not.toContain('href="/ustawienia/integracje/infakt"');
  }, 120_000);

  it('(3) reguła VAT: „wierszami” = dzisiejszy wynik; inna → błąd podsumowania (karta mówi dlaczego, nie liczy)', async () => {
    const z = { ...zamowienie('PC-601'), sklep: 'reczne', faktura: null };
    const dzis = podsumowanieVatKarty(z, { stawkaDomyslna: '23' });
    expect(dzis).toMatchObject({ nettoZl: '290.25', vatZl: '66.75', bruttoZl: '357.00', blad: null });
    expect(podsumowanieVatKarty(z, { stawkaDomyslna: '23', regula: 'wierszami' })).toEqual(dzis);
    const inna = podsumowanieVatKarty(z, { stawkaDomyslna: '23', regula: 'odSumy' });
    expect(inna).toMatchObject({ nettoZl: null, vatZl: null, bruttoZl: null });
    expect(inna.blad).toMatch(/odSumy/);

    // Karta czyta regułę z programu (opis.regulaVat). `sprawdzProgramFakturowy` przy składaniu przepuszcza tylko
    // „wierszami”, więc program o innej regule wchodzi nadpisaniem usługi `faktury.infakt` (jak mocki 9 plików testów).
    const odSumy = programNadAtrapa({ regulaVat: 'odSumy' });
    const a = await aplikacjaTestownika({ nadpisania: { 'faktury.infakt': odSumy } });
    try {
      const id = zapiszZamowienie(a.db, 'reczne', zamowienie('PC-602'), {});
      const r = await a.app.inject({ method: 'GET', url: `/zamowienia/${id}`, headers: AUTH });
      expect(r.statusCode).toBe(200);
      expect(r.body).toContain(inna.blad.replace(/[„”"]/g, (c) => (c === '"' ? '&#34;' : c)));
      expect(r.body).not.toContain('290.25');
    } finally { await a.app.close(); a.db.close(); }
  }, 60_000);
});
