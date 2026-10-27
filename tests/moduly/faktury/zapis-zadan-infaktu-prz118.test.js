// PRZ-118.01 — ZŁOTY ZAPIS ŻĄDAŃ DO inFAKTU: siatka regresji kontraktu programu fakturowego.
//
// Jedyna definicja „bez zmiany zachowania” dla zmian 02–09 PRZ-118 (plan: docs/plany/PRZ-118-program-fakturowy.md).
// Pełna aplikacja (`zbudujOms` — ta sama kompozycja co produkcja), 11 scenariuszy wyłącznie przez trasy HTTP
// (oraz zegar czuwacza przesyłek, który nie ma trasy — patrz scenariusz 11), a KAŻDE żądanie, które poszłoby do
// inFaktu, zapisuje nagrywarka podstawiona pod `globalThis.fetch` (tests/pomoc/nagrywarka-infaktu.js).
// Wynik porównywany `toEqual` ze wzorcem tests/dane/prz118-zapis-zadan.json, zapisanym przy czystym `main`.
//
// ⚠️ Test celowo NIE zna usług OMS-u (createFaktura, faktura-okresu, korekta…) ani parametru `infakt` — tylko
// adresy tras, formularze i zegar. Zmiany 02–09 przebudowują usługi; trasy i żądania do inFaktu mają zostać.
// ⚠️ Wzorca NIE przepisuje się po zmianie 01. Czerwony test = zmienione żądanie do inFaktu. Wolno go zapisać
// ponownie (ZAPISZ_WZORZEC=1) wyłącznie na czystym drzewie `src/`, co pilnuje sam test.
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zbudujOms } from '../../../src/oms/bootstrap.ts';
import { zapiszZamowienie } from '../../../src/oms/db/zamowienia.js';
import { rozpocznijPrzesylke, zakonczPrzesylke, zapiszStatusDpd } from '../../../src/moduly/wysylka/db/przesylki.js';
import { dopiszKlientaZbiorczego } from './_klient-zbiorczy-pomocniki.js';
import { createNagrywarkaInfaktu } from '../../pomoc/nagrywarka-infaktu.js';

const KATALOG_TESTU = dirname(fileURLToPath(import.meta.url));
const KORZEN = join(KATALOG_TESTU, '../../..');
const WZORZEC = join(KORZEN, 'tests/dane/prz118-zapis-zadan.json');
const TERAZ = '2026-10-15T10:00:00.000Z';
const KLUCZ = 'syntetyczny-klucz-testowy';
const NIP_PRACOWNI = '5250000009';  // zmyślony, z poprawną sumą kontrolną
const NIP_UE = 'DE123456789';       // zmyślony numer VAT-UE (VIES odpowiada nagrywarka)

const AUTH = { authorization: `Basic ${Buffer.from('operator:fixture').toString('base64')}` };
const POST = { ...AUTH, origin: 'http://localhost', 'content-type': 'application/x-www-form-urlencoded' };
const formularz = (pola) => new URLSearchParams(pola).toString();

// Numeracja z planu (01.3), 05b/01b/11b dopisane po odbiorze; kolejność wykonania inna w dwóch miejscach: PDF korekty (06) wymaga korekty (07),
// a „Sprawdź połączenie” (10) idzie na drugiej instancji, po zamknięciu pierwszej — zawsze ostatnie.
const SCENARIUSZE = [
  '01 faktura krajowa przedpłacona (oznaczenie zapłaty)',
  '02 faktura za pobraniem (payment_method)',
  '03 faktura WDT z numerem serii (iluMaNumer, number)',
  '04 nabywca bez NIP-u (założenie klienta)',
  '05 faktura okresu rozliczeniowego',
  '07 korekta zwrotu (pobierzFakture, wystawKorekte, listaKorekt)',
  '06 PDF faktury i korekty',
  '08 zakładka FAKTURY za miesiąc i nieopłacone',
  '09 podgląd i zatwierdzenie wysyłki 2 dokumentów do KSeF',
  '11 czuwacz pobrań (zegar czuwacza przesyłek)',
  // Dopisane po odbiorze 01 (mutacje kierownika): gałęzie, których scenariusze 01–11 nie dotykały. Idą PO 11,
  // żeby numery dokumentów (U…, FV …) i żądania scenariuszy 01–11 zostały bajt w bajt te same.
  '05b faktura okresu dla nabywcy UE (WDT: VIES, seria, pola WDT)',
  '01b przedpłacona z datą wystawienia przed wpłatą (paid_date = data wpłaty)',
  '11b czuwacz pobrań: doręczenie po dacie wystawienia (paid_date = doręczenie)',
  '10 Sprawdź połączenie (klucz z Ustawień)',
];

function envTestu(katalog, { zKluczem = true } = {}) {
  return {
    OMS_USER: 'operator', OMS_PASS: 'fixture', OMS_SPRZEDAWCA_NIP: '1234563218',
    OMS_RACHUNEK: '34109010140000000000000000', OMS_PROFORMY_KATALOG: katalog, OMS_ETYKIETY_KATALOG: katalog,
    ...(zKluczem ? { INFAKT_API_KEY: KLUCZ } : {}),
    // Kurier z pliku — bez niego moduł wysyłki nie składa czuwacza przesyłek (scenariusz 11). Adresy .invalid:
    // paczka w teście jest już doręczona, więc czuwacz o nic DPD nie pyta, a nagrywarka i tak odmówiłaby sieci.
    DPD_URL: 'https://dpd.invalid/api', DPD_LOGIN: 'login-testowy', DPD_PASSWORD: 'haslo-testowe', DPD_FID: '1',
    DPD_INFO_URL: 'https://dpd-info.invalid/api', DPD_INFO_CHANNEL: 'kanal-testowy',
    DPD_NADAWCA_NAZWA: 'Pracownia Półcień', DPD_NADAWCA_ULICA: 'Lampowa 1', DPD_NADAWCA_KOD: '00-950',
    DPD_NADAWCA_MIASTO: 'Warszawa',
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

describe('PRZ-118.01 złoty zapis żądań do inFaktu (pełna aplikacja, trasy HTTP)', () => {
  let katalog;
  let nagrywarka;
  beforeAll(() => {
    katalog = mkdtempSync(join(tmpdir(), 'prz118-zapis-'));
    // Stały zegar: trasy i usługi biorą „dziś” z `new Date()`, nie z zegara aplikacji — podmieniamy tylko Date,
    // timery zostają prawdziwe (nagrywarka odpowiada po setTimeout, AbortSignal.timeout klienta działa).
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(TERAZ));
    nagrywarka = createNagrywarkaInfaktu({ teraz: () => new Date(), kluczApi: KLUCZ });
    // Przed złożeniem aplikacji: transport HTTP (core/http.ts) bierze `fetch` w chwili tworzenia klienta.
    vi.stubGlobal('fetch', nagrywarka.fetch);
  });
  afterAll(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    nagrywarka?.zamknij();
    if (katalog) rmSync(katalog, { recursive: true, force: true });
  });

  it('11 scenariuszy daje dokładnie te żądania do inFaktu, co wzorzec z czystego main', async () => {
    const teraz = () => new Date();
    const a = await zbudujOms({ env: envTestu(katalog), teraz, log: () => {} });
    const http = (metoda, url, pola) => a.app.inject({ method: metoda, url, headers: metoda === 'GET' ? AUTH : POST,
      ...(metoda === 'GET' ? {} : { payload: formularz(pola ?? {}) }) });
    const oczekuj = (r, kod, co) => expect(r.statusCode, `${co}: ${r.body.slice(0, 400)}`).toBe(kod);
    const scen = (i) => nagrywarka.scenariusz(SCENARIUSZE[i]);
    try {
      const db = a.db; // wyłącznie do zasiania zamówień i paczki — stan, który w produkcji wnosi sklep i kurier
      // ── 01 ─ krajowa, przedpłacona: wpłata na karcie, faktura „zapłacone” → oznaczenie zapłaty w inFakcie
      scen(0);
      const z1 = zapiszZamowienie(db, 'reczne', zamowienie('PC-101'), {});
      oczekuj(await http('POST', `/zamowienia/${z1}/platnosci`, { kwota: '357,00', data: '2026-10-12', metoda: 'Przelew' }), 302, 'wpłata 01');
      oczekuj(await http('POST', `/zamowienia/${z1}/faktura`, { termin: 'zaplacone', data_wystawienia: '', data_sprzedazy: '' }), 302, 'faktura 01');

      // ── 02 ─ za pobraniem, ten sam nabywca (kartoteka inFaktu już go zna), bez pól terminu (stara droga)
      scen(1);
      const z2 = zapiszZamowienie(db, 'reczne', zamowienie('PC-102', { pobranie: 1, kwota_pobrania: '357.00' }), {});
      oczekuj(await http('POST', `/zamowienia/${z2}/faktura`, {}), 302, 'faktura 02');

      // ── 03 ─ WDT: VIES (poza zapisem) → nabywca → seria WDT (iluMaNumer) → wystawienie z numerem serii
      scen(2);
      const z3 = zapiszZamowienie(db, 'reczne', zamowienie('PC-103', {
        nip: NIP_UE, koszt_dostawy_brutto: '40.00', kwota_brutto: '382.00',
        klient: { company: 'Leuchtenwerkstatt Halbschatten GmbH', email: 'buero@halbschatten.invalid',
          address_1: 'Erfundene Straße 1', postcode: '10115', city: 'Berlin', country: 'DE' },
      }), {});
      oczekuj(await http('POST', `/zamowienia/${z3}/faktura`, { termin: '14', data_wystawienia: '', data_sprzedazy: '' }), 302, 'faktura 03');

      // ── 04 ─ osoba prywatna bez NIP-u: bez szukania w kartotece, od razu założenie klienta; daty z formularza
      scen(3);
      const z4 = zapiszZamowienie(db, 'reczne', zamowienie('PC-104', {
        nip: null, klient: { first_name: 'Jan', last_name: 'Cienisty', email: 'jan@cien.invalid',
          address_1: 'Mroczna 5', postcode: '30-001', city: 'Kraków', country: 'PL' },
        koszt_dostawy_brutto: '0.00', kwota_brutto: '342.00',
      }), {});
      oczekuj(await http('POST', `/zamowienia/${z4}/faktura`, { termin: '7', data_wystawienia: '2026-10-14', data_sprzedazy: '2026-10-13' }), 302, 'faktura 04');

      // ── 05 ─ faktura zbiorcza za okres: dwa zamówienia klienta z umową zbiorczą, nabywca z kartoteki inFaktu
      scen(4);
      dopiszKlientaZbiorczego(db, { klucz: 'polcien', nazwa: 'Pracownia Półcień sp. z o.o.', nip: NIP_PRACOWNI });
      const z5a = zapiszZamowienie(db, 'reczne', zamowienie('PC-105'), {});
      const z5b = zapiszZamowienie(db, 'reczne', zamowienie('PC-106', { utworzone_at: '2026-10-11T09:00:00Z' }), {});
      for (const id of [z5a, z5b]) oczekuj(await http('POST', `/zamowienia/${id}/okres`, {}), 302, `okres ${id}`);
      const { okres_rozliczeniowy_id: okresId } = db.prepare('SELECT okres_rozliczeniowy_id FROM zamowienia WHERE id = ?').get(z5a);
      oczekuj(await http('POST', `/okresy/${okresId}/wystaw-fakture`, {}), 302, 'faktura okresu');

      // ── 07 ─ zwrot jednej lampy z zamówienia 01 → korekta → numer korekty z listy przy otwarciu ekranu zwrotu
      scen(5);
      oczekuj(await http('POST', `/zamowienia/${z1}/zwrot`, {
        data: '2026-10-14', kwota: '129.00', kwota_dostawy: '', powod: 'klosz pęknięty',
        klucz: 's11', nazwa: 'Lampa wisząca Półcień', ilosc: '1', pozycja_kwota: '129.00',
      }), 302, 'zwrot');
      const { id: zwrotId } = db.prepare('SELECT id FROM zwroty WHERE zamowienie_id = ?').get(z1);
      oczekuj(await http('POST', `/zamowienia/${z1}/zwroty/${zwrotId}/korekta`, {}), 302, 'korekta');
      oczekuj(await http('GET', `/zamowienia/${z1}/zwrot`), 200, 'ekran zwrotu (doczytanie numeru korekty)');

      // ── 06 ─ PDF faktury z karty zamówienia i PDF korekty z zakładki FAKTURY
      scen(6);
      oczekuj(await http('GET', `/zamowienia/${z1}/faktura/pdf`), 200, 'PDF faktury');
      const [korekta] = await nagrywarka.atrapa.listaKorekt({});
      oczekuj(await http('GET', `/faktury/${korekta.uuid}/pdf?rodzaj=korekta&numer=${encodeURIComponent(korekta.number)}`), 200, 'PDF korekty');

      // ── 08 ─ zakładka FAKTURY: miesiąc po dacie wystawienia i po dacie sprzedaży, pas nieopłaconych
      scen(7);
      oczekuj(await http('GET', '/faktury?miesiac=2026-10'), 200, 'FAKTURY');
      oczekuj(await http('GET', '/faktury?miesiac=2026-10&pole=sale_date'), 200, 'FAKTURY po dacie sprzedaży');

      // ── 09 ─ KSeF: podgląd i zatwierdzenie dwóch faktur z NIP-em (01 i 02)
      scen(8);
      // Pierwsze dwie faktury konta (01 i 02) — identyfikatory z „inFaktu”, jak w checkboksach zakładki.
      const faktury = await nagrywarka.atrapa.listaFaktur({});
      const doKsef = ['FV 1/10/2026', 'FV 2/10/2026'].map((n) => faktury.find((f) => f.number === n).uuid);
      const ksef = new URLSearchParams([['miesiac', '2026-10'], ['pole', 'invoice_date'], ...doKsef.map((u) => ['uuid', u])]).toString();
      oczekuj(await a.app.inject({ method: 'POST', url: '/faktury/ksef/podglad', headers: POST, payload: ksef }), 200, 'podgląd KSeF');
      const wyslane = await a.app.inject({ method: 'POST', url: '/faktury/ksef/wyslij', headers: POST, payload: ksef });
      oczekuj(wyslane, 200, 'wysyłka KSeF');

      // ── 11 ─ czuwacz pobrań: paczka zamówienia 02 doręczona → odczyt faktury → zlecenie oznaczenia zapłaty.
      // Czuwacz nie ma trasy; woła go zegar modułu wysyłki (`czuwaczPrzesylek`) — tak samo jak uruchomZegary.
      scen(9);
      const p = rozpocznijPrzesylke(db, z2, 'dpd', 1);
      zakonczPrzesylke(db, p.id, { numerListu: 'PCN0000000001', etykietaSciezka: join(katalog, 'etykieta.pdf'), surowa: '<x/>' });
      zapiszStatusDpd(db, p.id, { opis: 'Przesyłka doręczona', at: '2026-10-14T13:00:00.000' });
      const zegar = a.zegary.find((z) => z.nazwa === 'czuwaczPrzesylek');
      expect(zegar, 'zegar czuwacza przesyłek').toBeTruthy();
      await zegar.przebieg();

      // ── 05b ─ okres klienta z NIP-em UE: VIES → nabywca z kartoteki (założony w 03) → seria WDT → wystawienie
      // z `number` i polami WDT. Termin płatności faktury okresu NIE jest polem trasy (okresy.js woła usługę bez
      // terminu), więc `datyFaktury` okresu dają z trasy zawsze {} — tej gałęzi HTTP nie dosięga.
      scen(10);
      dopiszKlientaZbiorczego(db, { klucz: 'halbschatten', nazwa: 'Leuchtenwerkstatt Halbschatten GmbH', nip: NIP_UE });
      const z12 = zapiszZamowienie(db, 'reczne', zamowienie('PC-107', {
        nip: NIP_UE, koszt_dostawy_brutto: '40.00', kwota_brutto: '382.00',
        klient: { company: 'Leuchtenwerkstatt Halbschatten GmbH', email: 'buero@halbschatten.invalid',
          address_1: 'Erfundene Straße 1', postcode: '10115', city: 'Berlin', country: 'DE' },
      }), {});
      oczekuj(await http('POST', `/zamowienia/${z12}/okres`, {}), 302, 'okres UE');
      const { okres_rozliczeniowy_id: okresUe } = db.prepare('SELECT okres_rozliczeniowy_id FROM zamowienia WHERE id = ?').get(z12);
      oczekuj(await http('POST', `/okresy/${okresUe}/wystaw-fakture`, {}), 302, 'faktura okresu UE');

      // ── 01b ─ faktura „zapłacone” z datą wystawienia 12.10 przy wpłacie z 14.10: oznaczenie zapłaty ma nieść
      // datę wpłaty (późniejszą), nie datę wystawienia — w 01 obie reguły dawały ten sam dzień.
      scen(11);
      const z13 = zapiszZamowienie(db, 'reczne', zamowienie('PC-108'), {});
      oczekuj(await http('POST', `/zamowienia/${z13}/platnosci`, { kwota: '357,00', data: '2026-10-14', metoda: 'BLIK' }), 302, 'wpłata 01b');
      oczekuj(await http('POST', `/zamowienia/${z13}/faktura`, { termin: 'zaplacone', data_wystawienia: '2026-10-12', data_sprzedazy: '2026-10-12' }), 302, 'faktura 01b');

      // ── 11b ─ pobranie: faktura z 12.10 „przy odbiorze”, paczka doręczona 14.10 → paid_date = dzień doręczenia
      // (w 11 data wystawienia była późniejsza od doręczenia i wygrywała).
      scen(12);
      const z14 = zapiszZamowienie(db, 'reczne', zamowienie('PC-109', { pobranie: 1, kwota_pobrania: '357.00' }), {});
      oczekuj(await http('POST', `/zamowienia/${z14}/faktura`, { termin: 'przy_odbiorze', data_wystawienia: '2026-10-12', data_sprzedazy: '' }), 302, 'faktura 11b');
      const p14 = rozpocznijPrzesylke(db, z14, 'dpd', 1);
      zakonczPrzesylke(db, p14.id, { numerListu: 'PCN0000000002', etykietaSciezka: join(katalog, 'etykieta2.pdf'), surowa: '<x/>' });
      zapiszStatusDpd(db, p14.id, { opis: 'Przesyłka doręczona', at: '2026-10-14T13:00:00.000' });
      await zegar.przebieg();
    } finally {
      await a.app.close();
      a.db.close();
    }

    // ── 10 ─ „Sprawdź połączenie” ma sens tylko dla klucza z Ustawień (klucz z pliku ekran odsyła do pliku),
    // więc druga instancja: bez INFAKT_API_KEY, klucz zapisany formularzem, potem przycisk.
    nagrywarka.scenariusz(SCENARIUSZE.at(-1));
    const b = await zbudujOms({ env: envTestu(katalog, { zKluczem: false }), teraz, log: () => {} });
    try {
      const zapis = await b.app.inject({ method: 'POST', url: '/ustawienia/integracje/infakt', headers: POST, payload: formularz({ apiKey: KLUCZ }) });
      expect(zapis.statusCode, zapis.body.slice(0, 300)).toBe(303);
      const r = await b.app.inject({ method: 'POST', url: '/ustawienia/integracje/infakt/sprawdz', headers: POST, payload: '' });
      expect(r.statusCode).toBe(200);
      expect(r.body).toContain('Połączenie z inFaktem działa');
    } finally {
      await b.app.close();
      b.db.close();
    }

    const wynik = nagrywarka.wynik();
    // Siatka bez dziur: każdy scenariusz musiał dojść do inFaktu, i nic poza inFaktem nie wyszło z procesu.
    for (const s of SCENARIUSZE) expect(wynik[s]?.length ?? 0, `scenariusz bez żądań do inFaktu: ${s}`).toBeGreaterThan(0);
    expect(Object.keys(wynik)).toEqual(SCENARIUSZE);
    expect(nagrywarka.bledneKlucze, 'żądania bez klucza API z konfiguracji').toEqual([]);
    expect(nagrywarka.obce.filter((o) => o.host !== 'ec.europa.eu'), 'żądania poza inFakt i VIES').toEqual([]);
    // VIES nie wchodzi do wzorca (to nie inFakt), ale każda faktura WDT (03 i okres 05b) ma go zapytać raz.
    expect(nagrywarka.obce.map((o) => `${o.metoda} ${o.host}${o.sciezka}`))
      .toEqual(Array(2).fill('GET ec.europa.eu/taxation_customs/vies/rest-api/ms/DE/vat/123456789'));

    if (process.env.ZAPISZ_WZORZEC === '1') {
      // Wzorzec tylko z czystego drzewa kodu — inaczej „wzorzec” utrwaliłby niezatwierdzoną zmianę zachowania.
      const brudne = execFileSync('git', ['status', '--porcelain', '--', 'src', 'deploy'], { cwd: KORZEN, encoding: 'utf8' }).trim();
      if (brudne) throw new Error(`ZAPISZ_WZORZEC=1 odmawia: src/ albo deploy/ ma niezatwierdzone zmiany:\n${brudne}`);
      const sha = execFileSync('git', ['rev-parse', '--short=7', 'HEAD'], { cwd: KORZEN, encoding: 'utf8' }).trim();
      // Drzewo `src/` jednoznacznie wskazuje kod, na którym nagrano wzorzec (to samo drzewo co na 644bae8).
      const drzewoSrc = execFileSync('git', ['rev-parse', 'HEAD:src'], { cwd: KORZEN, encoding: 'utf8' }).trim();
      writeFileSync(WZORZEC, `${JSON.stringify({ sha, drzewoSrc, opis: 'PRZ-118.01 — złoty zapis żądań do inFaktu. NIE przepisywać po zmianie 01 (plan PRZ-118).', scenariusze: wynik }, null, 2)}\n`);
    }
    const wzorzec = JSON.parse(readFileSync(WZORZEC, 'utf8'));
    expect(wynik).toEqual(wzorzec.scenariusze);
  });
});
