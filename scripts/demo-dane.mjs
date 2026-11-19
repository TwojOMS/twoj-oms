#!/usr/bin/env node
// Generator danych demo dla piaskownicy `oms-proba` i demo publicznego.
//
// Firma, katalog, klienci i 150 zamówień (kanał, koszyk, wysyłka, płatność, dzień i godzina względem
// `dzis`) stoją w scripts/demo-dane-firma.mjs — zmyślona manufaktura lamp „Pracownia Półcień”: sklep
// Woo + dwa konta Allegro (główne i outlet) + zamówienia ręczne B2B/UE. Ten plik dokłada to, co wynika
// z wieku zamówienia: statusy, paczki z numerami, faktury (w tym WDT i pobranie), zwroty, wiadomości,
// a obok koszty, dane miesięczne, stałych klientów z okresem zbiorczym, kampanię i reklamy. Uzupełnienia dokładają 6 zamówień
// oraz proformy, podjazdy, etykiety DHL/ORLEN/Allegro One, paczkę bez ruchu i firmy spoza KSeF.
// Dodatkowe dane obejmują duże koszyki, więcej faktur (też dla osób prywatnych i z Allegro), cztery firmy
// rozliczane zbiorczo z okresami w każdym stanie (faktury okresów i wpłaty prawdziwą usługą modułu faktur na atrapie
// inFaktu), korektę z usługi zwrotów oraz paczki utworzone i w drodze u wszystkich przewoźników i we wszystkich kanałach.
//
// „Teraz” demo: domyślnie 06:30 w Polsce dnia `dzis`; `teraz` (HH:MM) przesuwa je — reset tuż po północy nie może pokazać
// zamówień z przyszłości, więc dzisiejszych jest wtedy mniej. Status „nowe” mają wyłącznie zamówienia z dziś.
//
// ⚠️ DANE WYŁĄCZNIE ZMYŚLONE: adresy e-mail w domenie `.invalid` (RFC 2606 — nie istnieje i nie
// zaistnieje), NIP-y z prefiksem 999 (żaden urząd skarbowy go nie wydaje) z poprawną sumą kontrolną,
// adresy „Ulica Przykładowa”, numery listów z prefiksem 0000. Strażnik: tests/instalacja/demo-dane.test.js.
//
// ⚠️ DETERMINISTYCZNY: te same `ziarno` i `dzis` dają te same dane (daty liczone od `dzis`, więc
// demo resetowane co godzinę ma zawsze świeże 60 dni). Tylko na pustej bazie — niepusta to odmowa.
//
// Użycie: node scripts/demo-dane.mjs --baza ŚCIEŻKA_BEZWZGLĘDNA [--ziarno N] [--dzis RRRR-MM-DD] [--teraz HH:MM]
// (plik bazy nie może istnieć; środowisko demo: ENV_DEMO niżej, kanały: KANALY_DEMO).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROBLEMY_ILOSCI, skrotZatwierdzenia } from '../src/domena/ilosc-kanalu.js';
import { wstawOferte, zmienOferte, zapiszZatwierdzenieStanow } from '../src/oms/db/oferty-kanalow.ts';
import { migawkaStanow, stanyKart } from '../src/oms/db/stany-magazynowe.js';
import { zapiszZamowienie, zapiszFaktyStatusu, dodajPozycjeReczna } from '../src/oms/db/zamowienia.js';
import { utworzZamowienieReczne } from '../src/oms/db/zamowienia-reczne.js';
import { dodajZwrot, oznaczPieniadzeOddane, zarezerwujKorekte, zapiszKorekte } from '../src/oms/db/zwroty.js';
import { dodajWplateReczna } from '../src/oms/db/platnosci.js';
import { zapiszWiadomosc } from '../src/oms/db/wiadomosci.js';
import { zamknijWatek } from '../src/oms/db/allegro-watki.js';
import { zapiszRecznyKoszt } from '../src/oms/db/koszty.js';
import { zapiszDaneMiesiaca } from '../src/oms/db/dane-miesieczne.js';
import { dopiszKlienta } from '../src/oms/db/klienci.js';
import { zapiszMetaDzien, zapiszGa4Dzien } from '../src/oms/db/kampanie.js';
import {
  zapiszPolaczenie,
  zapiszDni,
  zapiszTransakcje,
  zapiszMetaKampanie,
  zapiszStan,
} from '../src/oms/db/reklamy.js';
import { przypiszDoOkresu } from '../src/moduly/faktury/services/okres.js';
import {
  createFakturaOkresu,
  podzialZamowienOkresu,
  sumaOczekiwanaOkresuGrosze,
} from '../src/moduly/faktury/services/faktura-okresu.js';
import { createKorekta } from '../src/moduly/zwroty/services/korekta.js';
import { zalozZamowienieReczne } from '../src/moduly/zamowienia/services/zamowienie-reczne.js';
import { zamknijOkres, zamowieniaOkresu } from '../src/oms/db/okresy.js';
import { dodajWplateOkresu } from '../src/oms/db/platnosci.js';
import { klientPoKluczu, klientPoNip } from '../src/oms/db/klienci.js';
import { pobierzZamowienie } from '../src/oms/db/zamowienia.js';
import { umowaZbiorcza, warunkiDostawy } from '../src/domena/klient-zbiorczy.js';
import { darmowaDostawa } from '../src/domena/oplata-obslugi.js';
import { zapiszProforme } from '../src/moduly/faktury/db/proformy.js';
import { createProforma } from '../src/moduly/faktury/services/proforma.js';
import { wczytajFaktury } from '../src/moduly/faktury/modul.ts';
import { numerRecznego } from '../src/domena/koszt-reczny.js';
import { inicjalizujGraniceBezHistorii } from '../src/domena/sprzedaz-okresu.js';
import { wczytajRaporty } from '../src/moduly/raporty/konfiguracja.ts';
import {
  KANALY,
  PRODUKTY,
  KLIENCI,
  FIRMY_B2B,
  FIRMY_UE,
  ZAMOWIENIA,
  KAMPANIA,
  KOSZTY,
  WATKI_ALLEGRO,
  ZAMOWIENIA_ZBIORCZE,
  ZAMOWIENIA_PACZEK,
} from './demo-dane-firma.mjs';
import { zdjecieProduktu } from './demo-dane-katalog.mjs';
import { zapiszKonfiguracjeIntegracji } from '../src/oms/db/konfiguracja-integracji.js';

/** Kanały demo (sklep Woo, Allegro, Allegro Outlet) — etykiety widzi gość demo. */
export const KANALY_DEMO = Object.freeze(KANALY.map((k) => Object.freeze({ ...k })));
export { FIRMA as FIRMA_DEMO } from './demo-dane-firma.mjs';

/** Konfiguracja demo bez sekretów. `OMS_PASS` dopisuje ten, kto zakłada instancję (losowe). */
export const ENV_DEMO = Object.freeze({
  OMS_TRYB: 'proba',
  OMS_SPRZEDAWCA_NIP: '9990001002', // Fikcyjny: urzędu skarbowego 999 nie ma, więc NIP nie należy do żadnej firmy.
  OMS_RACHUNEK: '34109010140000000000000000',
  OMS_KANALY: JSON.stringify(KANALY_DEMO),
  OMS_RAPORTY_NAZWY_KANALOW: '{}',
  OMS_RAPORTY_PODLOGA_KOSZTOW: '2026-01',
  // Demo bez statusu „Indywidualne” — OMS_KANAL_INDYWIDUALNY celowo nie jest ustawione.
  // Adres wystawcy proformy (src/domena/adres-sprzedawcy.js) — bez niego „Wystaw proformę” w demo odmawia.
  // Sam adres nie włącza kuriera: wysyłka wymaga DPD_URL albo INPOST_TOKEN (moduly/wysylka/kurierzy.ts).
  DPD_NADAWCA_NAZWA: 'Pracownia Półcień (demo)',
  DPD_NADAWCA_ULICA: 'Ulica Przykładowa 1',
  DPD_NADAWCA_KOD: '44-100',
  DPD_NADAWCA_MIASTO: 'Gliwice',
});

const DOBA = 86400000;

// mulberry32 — mały, deterministyczny generator; Math.random byłby różny przy każdym resecie.
function losowanie(ziarno) {
  let a = ziarno >>> 0;
  const nast = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    liczba: nast,
    calk: (od, doW) => od + Math.floor(nast() * (doW - od + 1)),
    jeden: (lista) => lista[Math.floor(nast() * lista.length)],
    szansa: (p) => nast() < p,
  };
}

const zl = (gr) => (gr / 100).toFixed(2);
const nettoGr = (bruttoGr) => Math.round(bruttoGr / 1.23);

/** NIP z prefiksem 999 i poprawną sumą kontrolną (wagi 6,5,7,2,3,4,5,6,7). */
export function nipFikcyjny(n) {
  for (let k = n; ; k++) {
    const cyfry = ('999' + String(k).padStart(6, '0')).split('').map(Number);
    const suma = [6, 5, 7, 2, 3, 4, 5, 6, 7].reduce((s, w, i) => s + w * cyfry[i], 0) % 11;
    if (suma !== 10) return cyfry.join('') + suma;
  }
}

const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, '.000Z');

/** Dzień RRRR-MM-DD → północ UTC tego dnia w ms (godziny dodaje wołający). */
function poczatekDnia(dzien) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dzien)) throw new Error('DEMO_DZIS: oczekiwano RRRR-MM-DD');
  return Date.parse(dzien + 'T00:00:00.000Z');
}

/** Godzina zegara w Polsce danego dnia → chwila UTC (CET/CEST z Intl, bez zgadywania). */
function chwilaWarszawy(dzienMs, godzina, minuta) {
  const naiwna = dzienMs + godzina * 3600000 + minuta * 60000;
  const strefa = new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Warsaw', timeZoneName: 'shortOffset' })
    .formatToParts(new Date(naiwna))
    .find((p) => p.type === 'timeZoneName').value;
  return naiwna - Number(/GMT([+-]\d+)/.exec(strefa)?.[1] ?? 0) * 3600000;
}

const dzienWarszawy = (ms) => new Date(ms).toLocaleDateString('sv-SE', { timeZone: 'Europe/Warsaw' });

/**
 * „Teraz” demo w ms: domyślnie 06:30 w Polsce dnia `dzis` (gość otwierający demo rano nie widzi niczego z przyszłości),
 * `teraz` = 'HH:MM' zegara w Polsce tego dnia albo chwila ISO z tego dnia — reset o 00:00 podaje prawdziwą godzinę.
 */
export function terazDemo(dzis, teraz) {
  const dzienMs = poczatekDnia(dzis);
  if (teraz == null) return chwilaWarszawy(dzienMs, 6, 30);
  const hhmm = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(teraz));
  const ms = hhmm ? chwilaWarszawy(dzienMs, Number(hhmm[1]), Number(hhmm[2])) : Date.parse(String(teraz));
  if (!Number.isFinite(ms) || dzienWarszawy(ms) !== dzis)
    throw new Error('DEMO_TERAZ: oczekiwano HH:MM albo chwili ISO z dnia `dzis`');
  return ms;
}

const PRODUKT = new Map(PRODUKTY.map((p) => [p.sku, p]));
const NAZWY_WYSYLKI = {
  dpd: 'Kurier DPD',
  inpost_paczkomat: 'Paczkomat InPost',
  odbior_osobisty: 'Odbiór osobisty w pracowni',
  allegro_paczkomat: 'Allegro Paczkomaty InPost',
  allegro_dpd: 'Allegro Kurier DPD',
  allegro_punkt: 'Allegro One Punkt',
  allegro_kurier: 'Allegro Kurier',
};
const KOSZT_WYSYLKI_GR = {
  dpd: 1900,
  inpost_paczkomat: 1500,
  odbior_osobisty: 0,
  allegro_paczkomat: 1099,
  allegro_dpd: 1699,
  allegro_punkt: 899,
  allegro_kurier: 2499,
};
// Kody Woo `cod`/`bacs` → kanoniczne klucze domena/metody-platnosci.js (filtr listy pokaże polską etykietę).
const PLATNOSC = { cod: 'pobranie', bacs: 'przelew' };

/** Zmyślony login kupującego z Allegro: imię_trzy-litery-nazwiska + numer; bez polskich znaków. */
function loginKupujacego(osoba, n) {
  return `${osoba.imie.toLowerCase().replace(/[^a-z]/g, '')}_${osoba.nazwisko
    .slice(0, 3)
    .toLowerCase()
    .replace(/[^a-z]/g, '')}${n}`;
}

/** Linie koszyka z katalogu; rabat kontraktowy B2B w %, WDT = cena bez polskiego VAT-u. */
function pozycje(koszyk, { rabat = 0, wdt = false } = {}) {
  // Pozycja ze sklepu ma identyfikator linii (Woo line_item.id, Allegro lineItem.id) — bez niego „×”
  // na karcie odmawia („poczekaj na synchronizację”), a demo i piaskownica nie pokazałyby usuwania pozycji.
  return koszyk.map(([sku, ilosc, nazwaWlasna], i) => {
    const p = PRODUKT.get(sku);
    if (!p) throw new Error(`DEMO_SKU: ${sku}`);
    let cena = Math.round((p.cena_gr * (100 - rabat)) / 100);
    if (wdt) cena = nettoGr(cena);
    return {
      zrodlo_id: String(i + 1),
      nazwa: nazwaWlasna ?? p.nazwa,
      sku,
      ilosc,
      zdjecie_url: zdjecieProduktu(sku),
      cena_brutto: zl(cena),
      cena_netto: zl(wdt ? cena : nettoGr(cena)),
      brutto_linii: zl(cena * ilosc),
      netto_linii: zl((wdt ? cena : nettoGr(cena)) * ilosc),
      vat: wdt ? 0 : 23,
    };
  });
}

/**
 * Status docelowy z wieku zamówienia: stare są wysłane, świeże w realizacji. „Nowe” WYŁĄCZNIE
 * zamówienie złożone dziś (`zDzis`, dzień w Polsce) — wczorajsze „nowe” wyglądało na zaniedbaną skrzynkę. Jedno losowanie
 * na wywołanie jak dotąd, więc sekwencja `los` (a z nią całe demo) się nie przesuwa.
 */
function losujStatus(los, wiekDni, zDzis) {
  const r = los.liczba();
  if (r < 0.04) return 'anulowane';
  if (wiekDni >= 7 && r < 0.11) return 'zwrot';
  // Limit wysyłki to 1–2 dni robocze (domena/termin-wysylki.js): niewysłane starsze zamówienia lądują
  // w „Po terminie”. Kilka takich ma być (funkcja widoczna), dwadzieścia wyglądałoby na firmę w kryzysie.
  if (wiekDni <= 1) return r < 0.5 && zDzis ? 'nowe' : 'w_realizacji';
  if (wiekDni <= 3) return r < 0.4 ? 'w_realizacji' : 'wyslane';
  if (wiekDni <= 6) return r < 0.14 ? 'w_realizacji' : 'wyslane';
  return r < 0.98 ? 'wyslane' : 'w_realizacji';
}

// Numery listów z prefiksem 0000 — format kuriera (DPD: 13 cyfr + U, InPost: 24 cyfry), żaden prawdziwy.
function numerListu(los, kurier, n) {
  if (kurier === 'inpost') return '0000' + String(n).padStart(8, '0') + String(los.calk(10000000, 99999999)) + '0000';
  return '0000' + String(n).padStart(9, '0') + 'U';
}

// Paczka `doreczonaMs = null` to etykieta gotowa, kurier jeszcze nie odebrał (zakładka Przesyłki).
function przesylka(db, zamowienieId, { kurier, numer, nadanaMs, doreczonaMs, terazMs }) {
  const odebrana = doreczonaMs != null;
  const doreczona = odebrana && doreczonaMs <= terazMs;
  db.prepare(
    `INSERT INTO przesylki (zamowienie_id, kurier, status, numer_listu, etykieta_reczna, nadana_recznie,
      status_kuriera, status_kuriera_at, status_kuriera_pobrany_at, utworzona_at, kolejnosc, zrodlo_numeru)
    VALUES (?,?, 'nadana', ?, 1, 1, ?, ?, ?, ?, 1, 'demo')`,
  ).run(
    zamowienieId,
    kurier,
    numer,
    !odebrana ? null : doreczona ? 'Przesyłka doręczona do odbiorcy' : 'Przesyłka w drodze',
    // Pierwszy skan 6 h po nadaniu, ale nie później niż „teraz” (paczka nadana w nocy przed resetem o 00:20).
    !odebrana ? null : iso(doreczona ? doreczonaMs : Math.min(nadanaMs + 6 * 3600000, terazMs - 60000)),
    odebrana ? iso(terazMs) : null,
    iso(nadanaMs),
  );
}

let licznikFaktur = 0;
let licznikKorekt = 0;
// `ksef: false` — faktura jeszcze niewysłana do KSeF (najnowsza w demo, „Wyślij do KSeF” działa na atrapie).
function faktura(db, zamowienieId, wystawionaMs, { wdt = false, ksef = true } = {}) {
  licznikFaktur += 1;
  const d = new Date(wystawionaMs);
  const numer = wdt
    ? `WDT/${licznikFaktur}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${d.getUTCFullYear()}`
    : `FV ${licznikFaktur}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${d.getUTCFullYear()}`;
  const uuid = `00000000-0000-4000-8000-${String(licznikFaktur).padStart(12, '0')}`;
  db.prepare(
    `INSERT INTO faktury (zamowienie_id, infakt_uuid, numer, ksef_status, utworzona_at, ksef_numer)
    VALUES (?,?,?,?,?,?)`,
  ).run(
    zamowienieId,
    uuid,
    numer,
    ksef ? 'wyslana' : null,
    iso(wystawionaMs),
    ksef
      ? `9991234563-${d.toISOString().slice(0, 10).replaceAll('-', '')}-DEMO${String(licznikFaktur).padStart(6, '0')}`
      : null,
  );
}

function wiadomosc(db, zamowienieId, temat_id, adresat, temat, atMs) {
  zapiszWiadomosc(db, { zamowienieId, temat_id, adresat, temat, kto: 'demo', at: iso(atMs) });
}

function pusta(db) {
  for (const tabela of ['zamowienia', 'koszty', 'klienci', 'kampanie']) {
    if (db.prepare(`SELECT COUNT(*) AS n FROM ${tabela}`).get().n > 0) throw new Error('DEMO_BAZA_NIEPUSTA');
  }
}

/**
 * Wypełnia PUSTĄ bazę (po migracjach) danymi demo. Zwraca liczniki — test i skrypt je pokazują.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ ziarno?: number, dzis: string, teraz?: string, env?: Record<string, string> }} o  dzis = RRRR-MM-DD, ostatni
 *   dzień danych; teraz = 'HH:MM' w Polsce (domyślnie 06:30, patrz terazDemo); env = konfiguracja instancji (z niej
 *   klasyfikacja kanałów raportu do granic historii)
 */
export function wygenerujDaneDemo(db, { ziarno = 72, dzis, teraz, env = ENV_DEMO }) {
  pusta(db);
  const los = losowanie(ziarno);
  licznikFaktur = 0;
  licznikKorekt = 0;
  // „Teraz” demo: 06:30 w Polsce dnia `dzis`. Reset bywa robiony o każdej porze — późniejsza
  // godzina dawałaby zamówienia i wiadomości z przyszłości dla porannego gościa.
  const koniecDnia = terazDemo(dzis, teraz);
  // Kanał z panelu, poza trzema istniejącymi kanałami env. Zamówienia dopisze dopiero poller ERLI.
  // Starsze testy generatora budują bazę bez modułu kanałów — nie ma w niej tej tabeli.
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='kanaly_sprzedazy'").get()) {
    const at = iso(koniecDnia);
    db.prepare(
      `INSERT INTO kanaly_sprzedazy
      (klucz,typ,nazwa,srodowisko,zrodlo,konto_id,login,raport,autoryzacja,pobieranie,od_utc,
       wersja,generacja,generacja_importu,utworzono_at,zmieniono_at,aktor_id,aktor_login)
      VALUES ('erli_polcien','erli','ERLI Półcień','produkcja','panel','1000001','pracownia-polcien',
       'ERLI_POLCIEN','polaczone','wlaczone',?,1,1,1,?,?,0,'demo')`,
    ).run(iso(koniecDnia - 60 * DOBA), at, at);
    zapiszKonfiguracjeIntegracji(
      db,
      'erli:erli_polcien',
      {
        ustawienia: { adresApi: 'https://sklep.polcien.example', domyslnyCzasWysylki: 2 },
        sekrety: { kluczApi: 'atrapa-polcien' },
      },
      { teraz: new Date(koniecDnia) },
    );
  }
  const liczniki = {
    zamowienia: 0,
    faktury: 0,
    korekty: 0,
    zwroty: 0,
    przesylki: 0,
    wiadomosci: 0,
    koszty: 0,
    statusy: {},
  };
  const sklepWoo = KANALY.find((k) => k.typ === 'woo').klucz;

  // Stali klienci: firmy B2B (cztery z rozliczeniem zbiorczym, każda z innymi ustaleniami) i z UE (WDT).
  const firmy = [
    ...FIRMY_B2B.map((f) => ({ ...f, kraj: 'PL' })),
    ...FIRMY_UE.map((f) => ({ ...f, rozliczenie_zbiorcze: false, rabat_procent: 0 })),
  ];
  for (const [i, k] of firmy.entries()) {
    dopiszKlienta(
      db,
      {
        nazwa: k.nazwa,
        nip: k.nip,
        b2b: 1,
        rabat_procent: k.rabat_procent ?? 0,
        chce_fakture: 1,
        metoda_wysylki: 'dpd',
        koszt_dostawy_brutto: zl(k.koszt_dostawy_gr ?? KOSZT_WYSYLKI_GR.dpd),
        platnosc: 'przelew',
        termin_platnosci: k.termin_platnosci ?? '14',
        komentarz: k.etykietaKlienta
          ? 'Klient demonstracyjny — dane zmyślone. Sklep internetowy: wysyłamy do jego klientów na jego etykiecie.'
          : 'Klient demonstracyjny — dane zmyślone.',
        aktywny: 1,
        rozliczenie_zbiorcze: k.rozliczenie_zbiorcze ? 1 : 0,
        prog_darmowej_dostawy_gr: k.prog_darmowej_dostawy_gr ?? null,
        oplata_obslugi_gr: k.oplata_obslugi_gr ?? null,
        faktura_json: JSON.stringify({
          company: k.nazwa,
          address_1: k.ulica,
          city: k.miasto,
          postcode: k.kod,
          country: k.kraj,
        }),
        wysylka_json: JSON.stringify({
          company: k.nazwa,
          address_1: k.ulica,
          city: k.miasto,
          postcode: k.kod,
          country: k.kraj,
        }),
      },
      iso(koniecDnia - 70 * DOBA),
    );
  }

  // Zamówienia z pliku firmy, w kolejności złożenia. Moment = dzień wstecz + godzina zegara w Polsce.
  const zamowienia = ZAMOWIENIA.map((z) => ({
    z,
    ms: chwilaWarszawy(poczatekDnia(dzis) - z.dzienWstecz * DOBA, z.godzina, z.minuta),
  })).sort((a, b) => a.ms - b.ms);
  const momenty = zamowienia.map((w) => w.ms);
  // Pętla wstawia tylko zamówienia starsze niż DNI_UZUPELNIEN_PRZ087 — świeższe z pliku firmy (także z dziś po „teraz”) pomija.
  if (zamowienia.some((w) => Math.floor((koniecDnia - w.ms) / DOBA) > DNI_UZUPELNIEN_PRZ087 && w.ms >= koniecDnia)) {
    throw new Error('DEMO_PRZYSZLOSC: zamówienie po „teraz” demo');
  }

  const numery = Object.fromEntries(KANALY.map((k, n) => [k.klucz, k.typ === 'woo' ? 2400 : 0 + n * 100000]));
  let nrListu = 0,
    kandydaciZaleglosci = 0;
  const zamowieniaSklepu = [],
    loginy = Object.fromEntries(KANALY.map((k) => [k.klucz, []]));
  for (const [i, { z, ms: utworzoneMs }] of zamowienia.entries()) {
    const wiekDni = Math.floor((koniecDnia - utworzoneMs) / DOBA);
    // Ostatnie dni i wszystko „w toku” (nowe, w realizacji) składają uzupełnienia
    // z policzonymi liczbami — losowanie dawało przypadkową liczbę nowych i kilka zamówień po terminie. Pętla idzie
    // po czasie, więc pominięte są wyłącznie ostatnie wiersze: sekwencja `los` dla starszych się nie zmienia.
    if (wiekDni <= DNI_UZUPELNIEN_PRZ087) continue;
    const wylosowany = losujStatus(los, wiekDni, dzienWarszawy(utworzoneMs) === dzis);
    const status = ['nowe', 'w_realizacji'].includes(wylosowany) ? 'wyslane' : wylosowany;
    const kanal = z.kanal;
    const osobaZ = z.klient.osoba != null ? KLIENCI[z.klient.osoba] : null;
    const ue = z.klient.ue != null;
    const firma = z.klient.b2b != null ? { ...FIRMY_B2B[z.klient.b2b], kraj: 'PL' } : ue ? FIRMY_UE[z.klient.ue] : null;
    const klient = osobaZ
      ? { first_name: osobaZ.imie, last_name: osobaZ.nazwisko, email: osobaZ.email, phone: '' }
      : { first_name: '', last_name: '', company: firma.nazwa, email: `zamowienia.${i}@example.invalid`, phone: '' };
    const dostawa = osobaZ
      ? {
          first_name: osobaZ.imie,
          last_name: osobaZ.nazwisko,
          address_1: osobaZ.ulica,
          city: osobaZ.miasto,
          postcode: osobaZ.kod,
          country: 'PL',
        }
      : {
          first_name: '',
          last_name: '',
          company: firma.nazwa,
          address_1: firma.ulica,
          city: firma.miasto,
          postcode: firma.kod,
          country: firma.kraj,
        };
    // Adres nabywcy = adres z dostawy (karta i faktura się zgadzają); bez niego faktura nie ma pełnych danych.
    Object.assign(klient, {
      address_1: dostawa.address_1,
      postcode: dostawa.postcode,
      city: dostawa.city,
      country: dostawa.country,
    });
    const metoda = z.wysylka,
      nazwaMetody = NAZWY_WYSYLKI[metoda];
    const pobranie = ['cod', 'allegro_pobranie'].includes(z.platnosc);
    const poz = pozycje(z.pozycje, { rabat: firma && !ue ? firma.rabat_procent : 0, wdt: ue });
    const rabatKuponuGr = z.kupon ? KAMPANIA.rabat_gr : 0;
    const towarGr = poz.reduce((s, p) => s + Math.round(Number(p.brutto_linii) * 100), 0);
    // Próg darmowej dostawy z karty klienta — ta sama reguła domeny co formularz zamówienia ręcznego.
    const kosztDostawyGr =
      kanal === 'reczne' &&
      firma &&
      !ue &&
      darmowaDostawa({
        bezWysylki: metoda === 'odbior_osobisty',
        etykietaKlienta: false,
        wartoscTowaruGr: towarGr,
        klient: warunkiDostawy(klientPoNip(db, firma.nip)),
      })
        ? 0
        : KOSZT_WYSYLKI_GR[metoda];
    const sumaGr = towarGr + kosztDostawyGr - rabatKuponuGr;
    // Fakturę chce ~40% klientów detalicznych — co trzeci z nich to osoba prywatna bez NIP-u.
    // Jedno losowanie jak dotąd (zmienia się tylko próg), więc sekwencja `los` się nie przesuwa.
    const chceFakture = Boolean(firma) || los.szansa(0.4);
    const prywatna = !firma && chceFakture && i % 3 === 0;
    const nip = firma ? firma.nip : chceFakture && !prywatna ? nipFikcyjny(5000 + i * 11) : null;
    const wplata =
      status !== 'nowe' && status !== 'anulowane' && !pobranie
        ? iso(Math.min(utworzoneMs + los.calk(1, 40) * 60000, koniecDnia - 60000))
        : status === 'nowe' && los.szansa(0.5) && !pobranie
          ? iso(Math.min(utworzoneMs + 5 * 60000, koniecDnia - 60000))
          : null;
    // Okres rozliczeniowy (klient zbiorczy) — null dla rozliczanych pojedynczo.
    const okres =
      kanal === 'reczne' && firma && !ue
        ? przypiszDoOkresu({ db, nip, dataZlozenia: iso(utworzoneMs), hurt: false })
        : null;
    // Co druga faktura krajowego B2B przelewem starsza niż 18 dni czeka na przelew — termin 14 dni minął,
    // więc Faktury pokazują „nieopłacone po terminie”. Wpłata wyżej i tak jest losowana: sekwencja `los` bez zmian.
    // Bez zamówień z okresu — te nie mają własnej faktury (zaległość pokazuje faktura okresu).
    const kandydatZaleglosci =
      Boolean(firma) && !ue && !okres && ['przelew', 'bacs'].includes(z.platnosc) && wiekDni >= 18;
    const zalega = kandydatZaleglosci && ++kandydaciZaleglosci % 2 === 1;
    const oplacone = zalega ? null : wplata;

    let id;
    if (kanal === 'reczne') {
      id = utworzZamowienieReczne(
        db,
        {
          utworzone_at: iso(utworzoneMs),
          rok: new Date(utworzoneMs).getUTCFullYear(),
          klient,
          dostawa,
          metoda_wysylki: metoda,
          koszt_dostawy_brutto: zl(kosztDostawyGr),
          chce_fakture: chceFakture,
          nip,
          metoda_platnosci: PLATNOSC[z.platnosc] ?? z.platnosc,
          b2b: Boolean(firma),
          termin_platnosci: firma ? '14' : null,
          rabat_procent: firma && !ue ? firma.rabat_procent : 0,
          uwagi: z.uwagi ?? null,
        },
        okres,
      );
      for (const p of poz) {
        dodajPozycjeReczna(db, id, {
          nazwa: p.nazwa,
          sku: p.sku,
          ilosc: p.ilosc,
          cena_brutto: p.cena_brutto,
          brutto_linii: p.brutto_linii,
        });
      }
      db.prepare('UPDATE zamowienia SET kwota_brutto = ? WHERE id = ?').run(zl(sumaGr), id);
      // Klient zbiorczy płaci za MIESIĄC (wpłata okresu), nie za zamówienie — i nie dostaje faktury
      // pojedynczej: faktura okresu odmówiłaby zamówieniu z własną fakturą (services/faktura-okresu.js).
      if (oplacone && !okres)
        dodajWplateReczna(db, id, {
          kwota: zl(sumaGr),
          data: oplacone.slice(0, 10),
          metoda: PLATNOSC[z.platnosc] ?? z.platnosc,
        });
    } else {
      const woo = kanal === sklepWoo;
      const zrodloId = ++numery[kanal];
      const numer = woo ? String(zrodloId) : `${String(zrodloId).padStart(7, '0')}-${kanal}`;
      if (woo && status !== 'anulowane')
        zamowieniaSklepu.push({ zrodloId, dzien: iso(utworzoneMs).slice(0, 10), kwota: zl(sumaGr) });
      // Ten sam zmyślony login idzie i do wątku wiadomości (niżej), i do bloku klienta zamówienia —
      // lista zamówień pokazuje go pod imieniem i nazwiskiem tak, jak pokaże prawdziwy `buyer.login`.
      const loginAllegro = woo ? null : loginKupujacego(osobaZ, i);
      if (loginAllegro) {
        loginy[kanal].push(loginAllegro);
        klient.login = loginAllegro;
      }
      id = zapiszZamowienie(
        db,
        kanal,
        {
          zrodlo_id: zrodloId,
          numer,
          klient,
          dostawa,
          metoda_wysylki: metoda,
          metoda_wysylki_nazwa: nazwaMetody,
          pobranie,
          kwota_pobrania: pobranie ? zl(sumaGr) : null,
          punkt_odbioru: /paczkomat|punkt/.test(metoda) ? `GLI${String(i).padStart(2, '0')}M` : null,
          punkt_odbioru_opis: /paczkomat|punkt/.test(metoda) ? 'Punkt odbioru (demo), Ulica Przykładowa 5' : null,
          chce_fakture: chceFakture ? 1 : 0,
          nip,
          kwota_brutto: zl(sumaGr),
          koszt_dostawy_brutto: zl(kosztDostawyGr),
          koszt_dostawy_netto: zl(nettoGr(kosztDostawyGr)),
          status_woo: status === 'anulowane' ? 'cancelled' : status === 'wyslane' ? 'completed' : 'processing',
          metoda_platnosci: PLATNOSC[z.platnosc] ?? z.platnosc,
          indywidualne: status === 'indywidualne',
          oplacone_at: oplacone,
          anulowane: status === 'anulowane' ? 1 : 0,
          utworzone_at: iso(utworzoneMs),
          uwagi: z.uwagi ?? null,
          kupony: z.kupon ? [{ kod: z.kupon, rabat: zl(rabatKuponuGr) }] : [],
          atrybucja: woo
            ? {
                typ: 'utm',
                zrodlo: z.kupon ? 'facebook' : los.jeden(['google', 'facebook', '(direct)', 'pinterest']),
                medium: z.kupon ? 'paid_social' : 'organic',
                kampania: z.kupon ? z.kupon.toLowerCase() : null,
              }
            : null,
          pozycje: poz,
        },
        { demo: true },
      );
    }
    liczniki.zamowienia += 1;

    // Fakty statusu i to, co z nich wynika: paczka, faktura, wiadomości, zwrot.
    const wRealizacji = ['w_realizacji', 'wyslane', 'zwrot'].includes(status)
      ? utworzoneMs + los.calk(2, 26) * 3600000
      : null;
    const wyslaneMs = ['wyslane', 'zwrot'].includes(status)
      ? (wRealizacji ?? utworzoneMs) + los.calk(4, 40) * 3600000
      : null;
    const wyslane = wyslaneMs && wyslaneMs < koniecDnia ? wyslaneMs : null;
    if (wRealizacji || wyslane) {
      zapiszFaktyStatusu(db, id, {
        w_realizacji_at: wRealizacji ? iso(Math.min(wRealizacji, koniecDnia - 3600000)) : null,
        wyslane_at: wyslane ? iso(wyslane) : null,
      });
    }
    if (wyslane && metoda !== 'odbior_osobisty') {
      const kurier = metoda.includes('paczkomat') ? 'inpost' : metoda === 'allegro_punkt' ? 'allegro' : 'dpd';
      przesylka(db, id, {
        kurier,
        numer: numerListu(los, kurier, ++nrListu),
        nadanaMs: wyslane,
        doreczonaMs: wyslane + los.calk(18, 60) * 3600000,
        terazMs: koniecDnia,
      });
      liczniki.przesylki += 1;
    } else if (status === 'w_realizacji' && wiekDni >= 1 && wiekDni <= 3 && metoda !== 'odbior_osobisty') {
      // Etykieta gotowa, kurier jeszcze nie odebrał — tylko świeże: starsza wisiałaby jako alarm „stoi bez ruchu”.
      const kurier = metoda.includes('paczkomat') ? 'inpost' : metoda === 'allegro_punkt' ? 'allegro' : 'dpd';
      przesylka(db, id, {
        kurier,
        numer: numerListu(los, kurier, ++nrListu),
        nadanaMs: Math.min(wRealizacji + 3600000, koniecDnia - 3600000),
        doreczonaMs: null,
        terazMs: koniecDnia,
      });
      liczniki.przesylki += 1;
    }
    const zafakturowane = chceFakture && !okres && (wyslane || status === 'w_realizacji') && status !== 'anulowane';
    if (zafakturowane) {
      // Nie później niż 5 min przed „teraz” demo — „w realizacji” bywa liczone na jutro rano, a faktura z
      // przyszłości wyprzedzała na liście najnowszą (niewysłaną do KSeF) z uzupełnień.
      faktura(db, id, Math.min((wyslane ?? wRealizacji ?? utworzoneMs) + 1800000, koniecDnia - 5 * 60000), { wdt: ue });
      liczniki.faktury += 1;
    }
    if (pobranie && wyslane && wyslane + 3 * DOBA < koniecDnia) {
      // Pobranie: pieniądze przychodzą od kuriera po doręczeniu.
      dodajWplateReczna(db, id, { kwota: zl(sumaGr), data: iso(wyslane + 3 * DOBA).slice(0, 10), metoda: 'pobranie' });
    }
    if (status !== 'anulowane') {
      wiadomosc(db, id, 'potwierdzenie', klient.email, 'Potwierdzenie zamówienia', utworzoneMs + 600000);
      liczniki.wiadomosci += 1;
      if (wyslane) {
        wiadomosc(db, id, 'faktura', klient.email, 'Zamówienie wysłane', wyslane + 600000);
        liczniki.wiadomosci += 1;
      }
      if (!oplacone && !pobranie && wiekDni >= 3) {
        wiadomosc(db, id, 'przypomnienie', klient.email, 'Przypomnienie o płatności', utworzoneMs + 2 * DOBA);
        liczniki.wiadomosci += 1;
      }
    }
    if (status === 'zwrot' && wyslane) {
      const p = poz[0];
      const dataZwrotu = iso(Math.min(wyslane + los.calk(5, 12) * DOBA, koniecDnia - DOBA)).slice(0, 10);
      const zw = dodajZwrot(db, id, {
        data: dataZwrotu,
        kwota: zl(Math.round(Number(p.cena_brutto) * 100)),
        powod: los.jeden(['Klosz pęknięty w transporcie', 'Odcień szkła inny niż na zdjęciu', 'Odstąpienie od umowy']),
        pozycje: [{ klucz_pozycji: p.sku, nazwa: p.nazwa, ilosc: 1, kwota: p.cena_brutto }],
      });
      if (los.szansa(0.6)) oznaczPieniadzeOddane(db, id, zw.id, iso(poczatekDnia(dataZwrotu) + 12 * 3600000));
      // Zwrot zafakturowanego zamówienia dostaje korektę (Faktury pokazują ją obok faktur). Bez
      // losowania — każde nowe wywołanie `los` przesunęłoby sekwencję i zmieniło całe demo.
      if (zafakturowane) {
        licznikKorekt += 1;
        const d = new Date(poczatekDnia(dataZwrotu));
        zarezerwujKorekte(db, id, zw.id, iso(poczatekDnia(dataZwrotu) + 13 * 3600000));
        zapiszKorekte(db, id, zw.id, {
          uuid: `00000000-0000-4000-9000-${String(licznikKorekt).padStart(12, '0')}`,
          numer: `${licznikKorekt}/KOR/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${d.getUTCFullYear()}`,
        });
        liczniki.korekty += 1;
      }
      liczniki.zwroty += 1;
    }
    liczniki.statusy[status] = (liczniki.statusy[status] ?? 0) + 1;
  }

  const pomocnicy = pomocnicyUzupelnien(db, { dzis, koniecDnia, numery, kolejnyList: () => ++nrListu, liczniki });
  uzupelnieniaPrz082(db, { env, koniecDnia, pomocnicy });
  uzupelnieniaPrz087(db, { pomocnicy });
  uzupelnieniaPrz160(db, { dzis, pomocnicy });
  uzupelnieniaPrz163(db, { pomocnicy });

  // Koszty (ręczne, bez KSeF) i dane miesięczne — trzy miesiące wstecz od `dzis`.
  const miesiace = [];
  for (let m = 2; m >= 0; m--) {
    const d = new Date(poczatekDnia(dzis));
    d.setUTCDate(1);
    d.setUTCMonth(d.getUTCMonth() - m);
    miesiace.push(d.toISOString().slice(0, 7));
  }
  // Koszty z pliku firmy — skala dobrana tak, by firma po ZUS-ie wychodziła na plus.
  // Pierwszy miesiąc ma sprzedaż tylko od pierwszego zamówienia — koszty w tej samej proporcji,
  // inaczej Finanse porównywałyby pełne koszty z połową sprzedaży (−1000% „vs poprzedni miesiąc”).
  const pierwszyDzien = iso(momenty[0]).slice(0, 10);
  const dniMiesiaca = (m) => new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)), 0)).getUTCDate();
  for (const [mi, miesiac] of miesiace.entries()) {
    // Bieżący miesiąc tak samo: koszty w proporcji do dni, które minęły, i z datą najpóźniej `dzis` —
    // inaczej 1. dnia miesiąca zakładka Koszty (otwiera się na bieżącym miesiącu) byłaby pusta.
    const biezacy = miesiac === dzis.slice(0, 7);
    const odDnia = miesiac === pierwszyDzien.slice(0, 7) ? Number(pierwszyDzien.slice(8, 10)) : 1;
    const doDnia = biezacy ? Number(dzis.slice(8, 10)) : dniMiesiaca(miesiac);
    const udzial = miesiac < pierwszyDzien.slice(0, 7) ? 0 : (doDnia - odDnia + 1) / dniMiesiaca(miesiac);
    if (udzial <= 0) continue;
    for (const [ki, { kategoria, typ, sprzedawca, netto_od_gr: od, netto_do_gr: doK }] of KOSZTY.entries()) {
      const netto = Math.round((od === doK ? od : los.calk(od / 100, doK / 100) * 100) * udzial);
      const dzien = Math.max(odDnia, Math.min(doDnia, 3 + ki * 3));
      const dataW = `${miesiac}-${String(dzien).padStart(2, '0')}`;
      zapiszRecznyKoszt(db, {
        numerDokumentu: `DEMO/${miesiac}/${ki + 1}`,
        sprzedawcaNip: nipFikcyjny(7000 + ki * 13),
        sprzedawcaNazwa: sprzedawca,
        dataWystawienia: dataW,
        netto: zl(netto),
        vat: zl(Math.round(netto * 0.23)),
        brutto: zl(netto + Math.round(netto * 0.23)),
        waluta: 'PLN',
        kategoriaDokumentu: kategoria,
        typDokumentu: typ,
      });
      liczniki.koszty += 1;
    }
    if (udzial === 1 && !biezacy) {
      zapiszDaneMiesiaca(db, miesiac, {
        zusSpoleczne: '650.00',
        zusZdrowotna: '432.54',
        zusFunduszPracy: '0.00',
        zusRazem: '1082.54',
        pit5: String(180 + mi * 40),
        vat7: String(700 + mi * 90),
        uwagi: 'DEMO — kwoty zmyślone.',
      });
    }
  }

  // Funkcja Cele jest usunięta z OMS-u. Losowania, które tu
  // stały (11 × los.calk), zostają: bez nich kampania i reklamy niżej dostałyby inne liczby.
  for (let d = 20; d >= 0; d -= 2) los.calk(2, 6);

  // Kampania z kuponem z pliku firmy — 21 dni do `dzis`, z dziennymi danymi Meta i GA4.
  const odKampanii = iso(poczatekDnia(dzis) - 20 * DOBA).slice(0, 10);
  db.prepare('INSERT INTO kampanie (kod, nazwa, od_dnia, do_dnia, sklep, cel_uzyc) VALUES (?,?,?,?,?,?)').run(
    KAMPANIA.kod,
    KAMPANIA.nazwa,
    odKampanii,
    iso(poczatekDnia(dzis) + 7 * DOBA).slice(0, 10),
    sklepWoo,
    40,
  );
  for (let d = 20; d >= 0; d--) {
    const dzien = iso(poczatekDnia(dzis) - d * DOBA).slice(0, 10);
    const wydatek = los.calk(1500, 4500);
    // CPM ~16 zł i CTR 1,7–2,5% (Meta w handlu: 1–3%).
    const wyswietlenia = Math.round(wydatek / 1.6);
    const klikniecia = Math.round(wyswietlenia * (0.017 + (d % 5) * 0.002));
    zapiszMetaDzien(db, KAMPANIA.kod, {
      dzien,
      wydatek: zl(wydatek),
      wyswietlenia,
      zasieg: Math.round(wyswietlenia * 0.72),
      klikniecia,
      kliknieciaLinku: Math.round(klikniecia * 0.62),
    });
    zapiszGa4Dzien(db, KAMPANIA.kod, {
      dzien,
      sesje: los.calk(60, 160),
      uzytkownicy: los.calk(50, 130),
      sesjeMeta: los.calk(10, 40),
      odslonyPromo: los.calk(20, 80),
    });
  }

  // Reklamy: połączenie Meta (dwie kampanie) i GA4 (koszt Google Ads + transakcje = numery zamówień sklepu).
  // Identyfikatory kont są zmyślone; bez kluczy integracji czuwacz reklam ich nie odpytuje.
  const pobrano = iso(koniecDnia);
  const meta = zapiszPolaczenie(db, {
    typ: 'meta',
    kontoId: 'act_000000000001',
    kanal: sklepWoo,
    waluta: 'PLN',
    strefa: 'Europe/Warsaw',
  });
  const ga4 = zapiszPolaczenie(db, {
    typ: 'ga4',
    kontoId: 'properties/000000001',
    kanal: sklepWoo,
    waluta: 'PLN',
    strefa: 'Europe/Warsaw',
  });
  const KAMPANIE_META = [
    ['000001', KAMPANIA.nazwa],
    ['000002', 'Remarketing — klosze i abażury'],
  ];
  const dniMeta = [],
    dniGa4 = [];
  for (let d = 30; d >= 0; d--) {
    const dzien = iso(poczatekDnia(dzis) - d * DOBA).slice(0, 10);
    for (const [[kampaniaId, nazwa], mnoznik] of [
      [KAMPANIE_META[0], d <= 20 ? 1 : 0],
      [KAMPANIE_META[1], 0.4],
    ]) {
      if (!mnoznik) continue;
      const wydatek = Math.round(los.calk(3000, 6000) * mnoznik);
      // CPM ~17 zł, CTR 1,6–2,4% — jak kampania wyżej.
      const wyswietlenia = Math.round(wydatek / 1.7);
      const klikniecia = Math.round(wyswietlenia * (0.016 + (d % 4) * 0.0025));
      dniMeta.push({
        dzien,
        kampaniaId,
        nazwa,
        wydatek: zl(wydatek),
        klikniecia,
        wyswietlenia,
        kliknieciaLinku: Math.round(klikniecia * 0.6),
      });
    }
    const koszt = los.calk(1500, 4000);
    // Wyszukiwarka — CPC ~1,10 zł, CTR 4,5–5,7%.
    const klikniecia = Math.round(koszt / 110);
    dniGa4.push({
      dzien,
      kampaniaId: '000003',
      nazwa: 'Google — lampy ręcznie robione',
      koszt: zl(koszt),
      klikniecia,
      wyswietlenia: Math.round(klikniecia / (0.045 + (d % 3) * 0.006)),
    });
  }
  zapiszDni(db, { typ: 'meta', polaczenieId: meta.id, wiersze: dniMeta, pobranoAt: pobrano });
  zapiszDni(db, { typ: 'ga4', polaczenieId: ga4.id, wiersze: dniGa4, pobranoAt: pobrano });
  zapiszTransakcje(db, {
    polaczenieId: ga4.id,
    pobranoAt: pobrano,
    wiersze: zamowieniaSklepu
      .filter((_, k) => k % 5 === 0)
      .map((z) => ({ dzien: z.dzien, kampaniaId: '000003', transactionId: String(z.zrodloId), przychod: z.kwota })),
  });
  zapiszMetaKampanie(db, {
    polaczenieId: meta.id,
    pobranoAt: pobrano,
    kampanie: KAMPANIE_META.map(([id, nazwa]) => ({
      id,
      nazwa,
      effectiveStatus: 'ACTIVE',
      budzetDzienny: '50.00',
      waluta: 'PLN',
    })),
  });
  for (const p of [meta, ga4])
    zapiszStan(db, { polaczenieId: p.id, ostatniaProbaAt: pobrano, ostatniSukcesAt: pobrano });

  // Firmy spoza KSeF — Meta i Google nie mają polskiego NIP-u, ich faktur nie ma w KSeF
  // (domena/koszt-reczny.js). Na liście wyboru formularza i z fakturą za każdy zamknięty miesiąc: kwota = wydatek
  // z reklam demo wyżej, data = ostatni dzień miesiąca. Bieżący miesiąc bez faktury — jeszcze trwa.
  const FIRMY_POZA_KSEF = [
    ['Facebook (Meta)', 'Meta Platforms Ireland Limited', dniMeta, 'wydatek'],
    ['Google Ads', 'Google Ireland Limited', dniGa4, 'koszt'],
  ];
  const wstawFirme = db.prepare(`INSERT OR IGNORE INTO firmy_reczne (nazwa, sprzedawca, kategoria, typ, dodana_at)
    VALUES (?, ?, 'Reklama', 'zmienny', ?)`);
  for (const [nazwa, sprzedawca, dni, pole] of FIRMY_POZA_KSEF) {
    wstawFirme.run(nazwa, sprzedawca, iso(koniecDnia - 70 * DOBA));
    const naMiesiac = new Map();
    for (const w of dni)
      naMiesiac.set(w.dzien.slice(0, 7), (naMiesiac.get(w.dzien.slice(0, 7)) ?? 0) + Math.round(Number(w[pole]) * 100));
    for (const [miesiac, gr] of naMiesiac) {
      if (miesiac >= dzis.slice(0, 7)) continue;
      const data = `${miesiac}-${String(dniMiesiaca(miesiac)).padStart(2, '0')}`;
      zapiszRecznyKoszt(db, {
        numerDokumentu: numerRecznego(nazwa, data),
        sprzedawcaNip: null,
        sprzedawcaNazwa: sprzedawca,
        dataWystawienia: data,
        netto: zl(gr),
        vat: zl(0),
        brutto: zl(gr),
        waluta: 'PLN',
        kategoriaDokumentu: 'Reklama',
        typDokumentu: 'zmienny',
      });
      liczniki.koszty += 1;
    }
  }

  // Wiadomości z Allegro: osiem wątków z kupującymi demo, część czeka na odpowiedź.
  const wstawWatek =
    db.prepare(`INSERT INTO allegro_watki (kanal, thread_id, interlocutor_login, last_message_date_time,
    typ, przeczytany, ostatnia_od_kupujacego, ostatnia_tresc, pobrany_at) VALUES (?,?,?,?,?,?,?,?,?)`);
  const wstawWiadomosc =
    db.prepare(`INSERT INTO allegro_wiadomosci (kanal, thread_id, message_id, od_kupujacego, tresc, utworzona_at)
    VALUES (?,?,?,?,?,?)`);
  for (const [w, { kanal, pytanie, odpowiedz, zalatwione }] of WATKI_ALLEGRO.entries()) {
    const watek = `demo-watek-${w + 1}`;
    const pytanieMs = koniecDnia - (w * 2 + 1) * 3 * 3600000;
    const ostatniaMs = odpowiedz ? pytanieMs + 2 * 3600000 : pytanieMs;
    const kupujacy = loginy[kanal]?.length
      ? loginy[kanal][(loginy[kanal].length - 1 - w) % loginy[kanal].length]
      : `kupujacy_${w}`;
    wstawWatek.run(
      kanal,
      watek,
      kupujacy,
      iso(ostatniaMs),
      'BUYER_SELLER',
      odpowiedz || zalatwione ? 1 : 0,
      odpowiedz ? 0 : 1,
      odpowiedz ?? pytanie,
      pobrano,
    );
    // „Załatwione” jak z przycisku w Wiadomościach — do daty ostatniej wiadomości (nowa otworzy wątek sama).
    if (zalatwione) zamknijWatek(db, kanal, watek, iso(ostatniaMs), pobrano);
    wstawWiadomosc.run(kanal, watek, `${watek}-1`, 1, pytanie, iso(pytanieMs));
    if (odpowiedz) wstawWiadomosc.run(kanal, watek, `${watek}-2`, 0, odpowiedz, iso(ostatniaMs));
  }

  // Granica historii kanałów raportu: demo nie ma historii sprzed OMS-u — granica dzień przed pierwszym zamówieniem.
  const { regulySprzedazy } = wczytajRaporty(env);
  const dzienPrzed = iso(poczatekDnia(iso(momenty[0]).slice(0, 10)) - 2 * DOBA).slice(0, 10);
  for (const kanal of regulySprzedazy.klasyfikacja.raporty) {
    if (db.prepare('SELECT 1 FROM granice_historii WHERE kanal = ?').get(kanal)) continue;
    inicjalizujGraniceBezHistorii(db, kanal, dzienPrzed, regulySprzedazy.klasyfikacja);
  }

  return liczniki;
}

/**
 * Wspólne klocki uzupełnień: zamówienie z koszyka katalogu, wysyłka z paczką, licznik statusów.
 * `koszyk` = [[sku, ilość, nazwa?]] — trzeci element zastępuje nazwę z katalogu (personalizacja).
 */
function pomocnicyUzupelnien(db, { dzis, koniecDnia, numery, kolejnyList, liczniki }) {
  const chwila = (dniWstecz, h, m) => chwilaWarszawy(poczatekDnia(dzis) - dniWstecz * DOBA, h, m);
  const sklepWoo = KANALY.find((k) => k.typ === 'woo').klucz;
  let nrMaila = 0;
  // `chceFakture` — faktura bez NIP-u, na osobę prywatną; bez parametru: fakturę chce ten, kto podał NIP.
  const dodaj = ({
    kanal,
    osoba,
    b2b,
    koszyk,
    wysylka,
    nazwaWysylki = NAZWY_WYSYLKI[wysylka],
    platnosc,
    nip = null,
    utworzoneMs,
    oplaconeMs = null,
    indywidualne = false,
    uwagi = null,
    chceFakture = null,
  }) => {
    const osobaZ = osoba != null ? KLIENCI[osoba] : null;
    const firma = b2b != null ? FIRMY_B2B[b2b] : null;
    const klient = osobaZ
      ? { first_name: osobaZ.imie, last_name: osobaZ.nazwisko, email: osobaZ.email, phone: '' }
      : {
          first_name: '',
          last_name: '',
          company: firma.nazwa,
          email: `zamowienia.d${++nrMaila}@example.invalid`,
          phone: '',
        };
    const dostawa = osobaZ
      ? {
          first_name: osobaZ.imie,
          last_name: osobaZ.nazwisko,
          address_1: osobaZ.ulica,
          city: osobaZ.miasto,
          postcode: osobaZ.kod,
          country: 'PL',
        }
      : {
          first_name: '',
          last_name: '',
          company: firma.nazwa,
          address_1: firma.ulica,
          city: firma.miasto,
          postcode: firma.kod,
          country: 'PL',
        };
    // Adres nabywcy = adres z dostawy (karta i faktura się zgadzają); bez niego faktura nie ma pełnych danych.
    Object.assign(klient, {
      address_1: dostawa.address_1,
      postcode: dostawa.postcode,
      city: dostawa.city,
      country: dostawa.country,
    });
    const poz = pozycje(koszyk, { rabat: firma?.rabat_procent ?? 0 });
    const kosztGr = KOSZT_WYSYLKI_GR[wysylka];
    const sumaGr = poz.reduce((s, x) => s + Math.round(Number(x.brutto_linii) * 100), 0) + kosztGr;
    const pobranie = ['cod', 'allegro_pobranie'].includes(platnosc);
    const nipZamowienia = firma ? firma.nip : nip;
    const metodaPlatnosci = PLATNOSC[platnosc] ?? platnosc;
    let id;
    if (kanal === 'reczne') {
      const okres = przypiszDoOkresu({ db, nip: nipZamowienia, dataZlozenia: iso(utworzoneMs), hurt: false });
      id = utworzZamowienieReczne(
        db,
        {
          utworzone_at: iso(utworzoneMs),
          rok: new Date(utworzoneMs).getUTCFullYear(),
          klient,
          dostawa,
          metoda_wysylki: wysylka,
          koszt_dostawy_brutto: zl(kosztGr),
          chce_fakture: true,
          nip: nipZamowienia,
          metoda_platnosci: metodaPlatnosci,
          b2b: true,
          termin_platnosci: '14',
          rabat_procent: firma.rabat_procent,
          uwagi,
          indywidualne,
        },
        okres,
      );
      for (const x of poz)
        dodajPozycjeReczna(db, id, {
          nazwa: x.nazwa,
          sku: x.sku,
          ilosc: x.ilosc,
          cena_brutto: x.cena_brutto,
          brutto_linii: x.brutto_linii,
        });
      db.prepare('UPDATE zamowienia SET kwota_brutto = ? WHERE id = ?').run(zl(sumaGr), id);
      if (oplaconeMs)
        dodajWplateReczna(db, id, { kwota: zl(sumaGr), data: iso(oplaconeMs).slice(0, 10), metoda: metodaPlatnosci });
    } else {
      const woo = kanal === sklepWoo;
      const zrodloId = ++numery[kanal];
      const punkt = /paczkomat|punkt/.test(wysylka);
      // Kanał Allegro (nie sklep Woo) niesie login kupującego; numery 900+ nie nachodzą na pętlę główną.
      if (!woo && osobaZ) klient.login = loginKupujacego(osobaZ, 900 + (zrodloId % 100));
      id = zapiszZamowienie(
        db,
        kanal,
        {
          zrodlo_id: zrodloId,
          numer: woo ? String(zrodloId) : `${String(zrodloId).padStart(7, '0')}-${kanal}`,
          klient,
          dostawa,
          metoda_wysylki: wysylka,
          metoda_wysylki_nazwa: nazwaWysylki,
          pobranie,
          kwota_pobrania: pobranie ? zl(sumaGr) : null,
          punkt_odbioru: punkt ? `GLI9${String(zrodloId % 100).padStart(2, '0')}M` : null,
          punkt_odbioru_opis: punkt ? 'Punkt odbioru (demo), Ulica Przykładowa 5' : null,
          chce_fakture: (chceFakture ?? Boolean(nipZamowienia)) ? 1 : 0,
          nip: nipZamowienia,
          kwota_brutto: zl(sumaGr),
          koszt_dostawy_brutto: zl(kosztGr),
          koszt_dostawy_netto: zl(nettoGr(kosztGr)),
          status_woo: 'processing',
          metoda_platnosci: metodaPlatnosci,
          indywidualne,
          oplacone_at: oplaconeMs ? iso(oplaconeMs) : null,
          anulowane: 0,
          utworzone_at: iso(utworzoneMs),
          uwagi,
          kupony: [],
          atrybucja: woo ? { typ: 'utm', zrodlo: 'google', medium: 'organic', kampania: null } : null,
          pozycje: poz,
        },
        { demo: true },
      );
    }
    wiadomosc(db, id, 'potwierdzenie', klient.email, 'Potwierdzenie zamówienia', utworzoneMs + 600000);
    liczniki.zamowienia += 1;
    liczniki.wiadomosci += 1;
    return { id, klient };
  };
  const status = (s) => {
    liczniki.statusy[s] = (liczniki.statusy[s] ?? 0) + 1;
  };
  const wyslij = (z, { kurier, wRealizacjiMs, wyslaneMs, doreczonaMs }) => {
    zapiszFaktyStatusu(db, z.id, { w_realizacji_at: iso(wRealizacjiMs), wyslane_at: iso(wyslaneMs) });
    przesylka(db, z.id, {
      kurier,
      numer: numerListu({ calk: () => 10000000 + z.id }, kurier, kolejnyList()),
      nadanaMs: wyslaneMs,
      doreczonaMs,
      terazMs: koniecDnia,
    });
    wiadomosc(db, z.id, 'faktura', z.klient.email, 'Zamówienie wysłane', wyslaneMs + 600000);
    liczniki.przesylki += 1;
    liczniki.wiadomosci += 1;
    status('wyslane');
  };
  // Chwila nie później niż `zapasMin` minut przed „teraz” demo (reset tuż po północy).
  const doTeraz = (ms, zapasMin = 10) => Math.min(ms, koniecDnia - zapasMin * 60000);
  return { chwila, sklepWoo, dodaj, status, wyslij, kolejnyList, liczniki, koniecDnia, doTeraz };
}

/**
 * Uzupełnienia demo. Osobne zamówienia zamiast przestawiania pętli w
 * wygenerujDaneDemo: każde nowe wywołanie `los` zmieniłoby całe demo. Każda pozycja ma test w
 * tests/instalacja/demo-reset-faktury.test.js.
 *  • faktura przelewem z terminem za kilka dni (B2B, 14 dni), • najnowsza faktura niewysłana do KSeF (wystawiona
 *    dziś — alarm „nie została wysłana” dotyczy dokumentów sprzed dzisiejszego dnia), • utworzone etykiety DHL,
 *    ORLEN Paczka i Allegro One, • jedna paczka bez ruchu, • historia podjazdów, • dwie proformy na każdy miesiąc.
 */
function uzupelnieniaPrz082(db, { env, koniecDnia, pomocnicy }) {
  const { chwila, sklepWoo, dodaj, status, wyslij, kolejnyList, liczniki } = pomocnicy;

  // Faktura z terminem za kilka dni: B2B przelewem, termin 14 dni, faktura sprzed 8 dni → termin za ~6 dni, bez wpłaty.
  const hotel = dodaj({
    kanal: 'reczne',
    b2b: 1,
    koszyk: [
      ['LMP-WIS-001', 4],
      ['LMP-ABA-001', 4],
    ],
    wysylka: 'dpd',
    platnosc: 'bacs',
    utworzoneMs: chwila(9, 10, 15),
  });
  wyslij(hotel, {
    kurier: 'dpd',
    wRealizacjiMs: chwila(9, 13, 20),
    wyslaneMs: chwila(8, 11, 0),
    doreczonaMs: chwila(7, 12, 40),
  });
  faktura(db, hotel.id, chwila(8, 11, 30));
  liczniki.faktury += 1;

  // Jedna paczka bez ruchu: DPD „w drodze” od 9 dni, ostatnie zdarzenie kuriera tego samego dnia.
  const stoi = dodaj({
    kanal: sklepWoo,
    osoba: 7,
    koszyk: [['LMP-STO-002', 1]],
    wysylka: 'dpd',
    platnosc: 'bacs',
    utworzoneMs: chwila(10, 13, 5),
    oplaconeMs: chwila(10, 13, 15),
  });
  wyslij(stoi, {
    kurier: 'dpd',
    wRealizacjiMs: chwila(10, 15, 0),
    wyslaneMs: chwila(9, 12, 0),
    doreczonaMs: koniecDnia + 30 * DOBA,
  });

  // Utworzone etykiety Allegro (kurier jeszcze nie odebrał): przewoźnika rozpoznaje nazwa usługi (domena/przewoznik-przesylki.js).
  const ETYKIETY = [
    ['allegro_kurier', 'Allegro Kurier DHL', 10, 'LMP-POD-001'],
    ['allegro_punkt', 'Allegro Automat ORLEN Paczka', 11, 'LMP-NOC-001'],
    ['allegro_punkt', 'Allegro One Box, One Kurier', 12, 'LMP-KIN-003'],
  ];
  for (const [i, [wysylka, nazwaWysylki, osoba, sku]] of ETYKIETY.entries()) {
    const z = dodaj({
      kanal: 'allegro',
      osoba,
      koszyk: [[sku, 1]],
      wysylka,
      nazwaWysylki,
      platnosc: 'allegro',
      utworzoneMs: chwila(1, 16 + i, 10),
      oplaconeMs: chwila(1, 16 + i, 12),
    });
    zapiszFaktyStatusu(db, z.id, { w_realizacji_at: iso(chwila(1, 18 + i, 0)), wyslane_at: null });
    if (nazwaWysylki.startsWith('Allegro One')) {
      // Dwie paczki One nadane przez WzA — grupa „Allegro One Kurier” na ekranie podjazdów
      // (atrapa Allegro odbija je z bazy, terminów nie podaje → zlecenie na samą datę).
      for (const k of [1, 2]) {
        db.prepare(
          `INSERT INTO przesylki (zamowienie_id, kurier, status, numer_listu, id_przesylki_kuriera, etykieta_sciezka,
            etykieta_reczna, nadana_recznie, utworzona_at, kolejnosc, zrodlo_numeru)
          VALUES (?, 'allegro_wza', 'nadana', ?, ?, ?, 0, 0, ?, ?, 'demo')`,
        ).run(
          z.id,
          numerListu({ calk: () => 20000000 + z.id }, 'allegro', kolejnyList()),
          `demo-one-${z.id}-${k}`,
          `demo-one-${z.id}-${k}.pdf`,
          iso(chwila(1, 18 + i, 30)),
          k,
        );
      }
      liczniki.przesylki += 2;
      status('w_realizacji');
      continue;
    }
    przesylka(db, z.id, {
      kurier: 'allegro',
      numer: numerListu({ calk: () => 20000000 + z.id }, 'allegro', kolejnyList()),
      nadanaMs: chwila(1, 18 + i, 30),
      doreczonaMs: null,
      terazMs: koniecDnia,
    });
    liczniki.przesylki += 1;
    status('w_realizacji');
  }
  // Zlecanie podjazdów One włączone w demo (w piaskownicy idzie do atrapy; DPD zostaje wyłączone, fail-closed).
  db.prepare('INSERT OR REPLACE INTO ustawienia (klucz, wartosc, zmienione_at) VALUES (?, ?, ?)').run(
    'podjazdy.allegro.one.aktywne',
    '1',
    iso(koniecDnia),
  );

  // Najnowsza faktura — wystawiona dziś rano, jeszcze nie w KSeF.
  const swieza = dodaj({
    kanal: sklepWoo,
    osoba: 5,
    nip: nipFikcyjny(9100),
    koszyk: [['LMP-KIN-001', 2]],
    wysylka: 'dpd',
    platnosc: 'bacs',
    utworzoneMs: chwila(1, 21, 40),
    oplaconeMs: chwila(1, 21, 52),
  });
  zapiszFaktyStatusu(db, swieza.id, {
    w_realizacji_at: iso(Math.min(chwila(0, 5, 50), koniecDnia - 10 * 60000)),
    wyslane_at: null,
  });
  faktura(db, swieza.id, koniecDnia - 2 * 60000, { ksef: false });
  liczniki.faktury += 1;
  status('w_realizacji');

  // Historia podjazdów: cztery ostatnie dni z paczkami DPD z Allegro — trzy potwierdzone, najstarszy odrzucony.
  const paczki = db
    .prepare(
      `SELECT p.id, p.numer_listu, p.utworzona_at FROM przesylki p JOIN zamowienia z ON z.id = p.zamowienie_id
    WHERE z.sklep = 'allegro' AND p.kurier = 'dpd' AND p.status_kuriera IS NOT NULL ORDER BY p.utworzona_at DESC`,
    )
    .all();
  const dni = new Map();
  for (const x of paczki) {
    const dzien = new Date(x.utworzona_at).toLocaleDateString('sv-SE', { timeZone: 'Europe/Warsaw' });
    if (!dni.has(dzien) && dni.size === 4) continue;
    dni.set(dzien, [...(dni.get(dzien) ?? []), x]);
  }
  const adres = {
    name: 'Pracownia Półcień (demo)',
    street: 'Ulica Przykładowa 1',
    postalCode: '44-100',
    city: 'Gliwice',
    countryCode: 'PL',
    email: 'pracownia@example.invalid',
    phone: '',
  };
  const wstawPodglad = db.prepare(
    'INSERT INTO podjazdy_podglady (id, kto, snapshot_json, wygasa_at, utworzony_at) VALUES (?,?,?,?,?)',
  );
  const wstawPodjazd =
    db.prepare(`INSERT INTO podjazdy (podglad_id, grupa_id, command_id, kanal, przewoznik, adres_json, termin_json, stan,
      pickup_id, carrier_pickup_id, pickup_carrier, kto, utworzony_at, ostatnia_proba_at, blad_opis) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const dopnij = db.prepare(
    'INSERT INTO podjazdy_przesylki (podjazd_id, przesylka_id, shipment_id, numer_listu, aktywna_rezerwacja) VALUES (?,?,?,?,0)',
  );
  for (const [n, [dzien, lista]] of [...dni].reverse().entries()) {
    const at = iso(chwilaWarszawy(poczatekDnia(dzien), 8, 40));
    const odrzucony = n === 0;
    const podglad = `demo-podglad-${n + 1}`;
    wstawPodglad.run(podglad, 'demo', JSON.stringify({ data: dzien, adres, grupy: [] }), at, at);
    const info = wstawPodjazd.run(
      podglad,
      'allegro|demo-dpd',
      `00000000-0000-4000-a000-${String(n + 1).padStart(12, '0')}`,
      'allegro',
      'DPD',
      JSON.stringify(adres),
      JSON.stringify({ date: dzien, minTime: '12:00', maxTime: '16:00' }),
      odrzucony ? 'odrzucony' : 'potwierdzony',
      odrzucony ? null : `DEMO-ODBIOR-${n + 1}`,
      odrzucony ? null : `0000${String(n + 1).padStart(8, '0')}`,
      odrzucony ? null : 'DPD',
      'demo',
      at,
      at,
      odrzucony ? 'Kurier nie ma wolnych terminów odbioru w wybranym dniu (demo).' : null,
    );
    for (const x of lista) dopnij.run(Number(info.lastInsertRowid), x.id, `demo-shipment-${x.id}`, x.numer_listu);
  }

  // Proformy: dwie na każdy miesiąc demo (miesiąc po polsku, jak numer proformy) — najpierw zamówienia ręczne B2B,
  // potem przelewem. Wystawia je PRAWDZIWA usługa (numer z serii, PDF w OMS_PROFORMY_KATALOG — przycisk „PDF” działa),
  // z zegarem ustawionym na 5 min po złożeniu zamówienia. Bez katalogu (sam generator na pustym env) — wiersze bez pliku.
  const miesiacPl = (ms) => new Date(ms).toLocaleDateString('sv-SE', { timeZone: 'Europe/Warsaw' }).slice(0, 7);
  const kandydaci = db
    .prepare(
      `SELECT id, kwota_brutto, utworzone_at FROM zamowienia WHERE anulowane = 0
    ORDER BY (sklep = 'reczne') DESC, (metoda_platnosci = 'przelew') DESC, utworzone_at`,
    )
    .all();
  let zegar = koniecDnia;
  const usluga = env?.OMS_PROFORMY_KATALOG?.trim()
    ? createProforma({
        db,
        teraz: () => new Date(zegar),
        config: (({ proforma, nadawca }) => ({ proforma, nadawca }))(wczytajFaktury(env)),
      })
    : null;
  const wystawione = new Map();
  for (const z of kandydaci) {
    const ms = Date.parse(z.utworzone_at) + 5 * 60000;
    const m = miesiacPl(Date.parse(z.utworzone_at));
    if (miesiacPl(ms) !== m || ms >= koniecDnia || (wystawione.get(m) ?? 0) >= 2) continue;
    zegar = ms;
    if (usluga) {
      // Usługa odmawia zamówieniu, któremu proforma by skłamała (np. kupon: suma pozycji ≠ kwota) — bez zużycia
      // numeru z serii (services/proforma.js, faza 2 przed 4). Wtedy bierzemy następnego kandydata z miesiąca.
      try {
        usluga.wystaw(z.id);
      } catch (e) {
        if (e?.dlaOperatora) continue;
        throw e;
      }
    } else {
      zapiszProforme(db, z.id, {
        kwotaBrutto: z.kwota_brutto,
        rok: Number(m.slice(0, 4)),
        miesiac: Number(m.slice(5, 7)),
        utworzonaAt: iso(ms),
      });
    }
    wystawione.set(m, (wystawione.get(m) ?? 0) + 1);
  }
}

// Ile ostatnich dni pętla losowa zostawia uzupełnieniom (0 = dziś).
const DNI_UZUPELNIEN_PRZ087 = 3;

/**
 * Zamówienia „w toku”. Test: tests/instalacja/demo-zamowienia-statusy.test.js.
 *  • NOWE: 14, wszystkie z dziś (przed „teraz” demo 06:30), dostawa DPD, Paczkomat, Allegro One, DHL, odbiór osobisty;
 *  • PERSONALIZACJA (status „w realizacji”): personalizacja w nazwie pozycji (GRAWER, kolor RAL, nadruk) — to, co pracownia robi na zamówienie;
 *  • W REALIZACJI: razem z pozostałymi uzupełnieniami co najmniej 20, głównie z wczoraj, dokładnie dwa po terminie wysyłki,
 *    różne dostawy i płatności (z pobraniem i B2B, gdzie zegar liczy się od złożenia);
 *  • WYSŁANE z dni 2–3 — pętla losowa ich już nie daje, a wykres sprzedaży nie może mieć dziury.
 * ⚠️ Termin liczy się z prawdziwego zegara gościa (domena/termin-wysylki.js): wczorajsze Allegro opłacone PRZED 12:00
 * w dzień roboczy ma limit 0 dni i byłoby po terminie — dlatego wczorajsze zamówienia stoją po południu.
 */
function uzupelnieniaPrz087(db, { pomocnicy }) {
  const { chwila, sklepWoo, dodaj, status, wyslij, koniecDnia } = pomocnicy;
  const W = sklepWoo;
  // B2B tylko firmy BEZ rozliczenia zbiorczego (FIRMY_B2B[0] ma okres miesięczny — pojedynczej faktury się mu nie wystawia).
  const ONE = 'Allegro One Punkt',
    ONE_KURIER = 'Allegro One Kurier',
    DHL = 'Allegro Kurier DHL';
  const oplacone = (ms, platnosc) =>
    ['cod', 'allegro_pobranie', 'bacs', 'przelew'].includes(platnosc) ? null : ms + 4 * 60000;

  // NOWE — 14 z dziś (12 + 2 duże), część jeszcze nieopłacona (przelew, pobranie).
  const NOWE = [
    [W, 14, [['LMP-STO-006', 1]], 'dpd', null, 'przelewy24', 0, 12],
    ['allegro', 55, [['LMP-NOC-001', 1]], 'allegro_punkt', ONE, 'allegro', 0, 41],
    [
      W,
      15,
      [
        ['LMP-WIS-001', 1],
        ['LMP-AKC-001', 1],
      ],
      'inpost_paczkomat',
      null,
      'blik',
      1,
      5,
    ],
    ['allegro', 56, [['LMP-KIN-003', 1]], 'allegro_kurier', DHL, 'allegro', 1, 37],
    [W, 16, [['LMP-POD-001', 1]], 'odbior_osobisty', null, 'bacs', 2, 18],
    [W, 17, [['LMP-ABA-001', 2]], 'dpd', null, 'cod', 2, 49],
    ['allegro', 57, [['LMP-STO-001', 1]], 'allegro_kurier', ONE_KURIER, 'allegro', 3, 26],
    ['allegro', 58, [['LMP-AKC-002', 3]], 'allegro_paczkomat', null, 'allegro_pobranie', 3, 58],
    ['allegro', 59, [['LMP-WIS-002', 1]], 'allegro_kurier', DHL, 'allegro', 4, 33],
    [
      'reczne',
      null,
      [
        ['LMP-KIN-001', 4],
        ['LMP-AKC-001', 4],
      ],
      'dpd',
      null,
      'bacs',
      5,
      2,
      2,
    ],
    [W, 18, [['LMP-NOC-002', 1]], 'inpost_paczkomat', null, 'karta', 5, 40],
    [W, 19, [['LMP-STO-004', 1]], 'odbior_osobisty', null, 'blik', 6, 14],
    // Dwa duże „nowe” do zwijania na liście (widać 5) — Allegro 7 produktów, sklep 12.
    [
      'allegro',
      61,
      ['LMP-STO-003', 'LMP-WIS-003', 'LMP-POD-003', 'LMP-KIN-003', 'LMP-NOC-002', 'LMP-ABA-003', 'LMP-AKC-003'].map(
        (sku, i) => [sku, i === 0 ? 2 : 1],
      ),
      'allegro_kurier',
      ONE_KURIER,
      'allegro',
      4,
      47,
    ],
    [
      W,
      24,
      [
        'LMP-STO-001',
        'LMP-STO-002',
        'LMP-WIS-001',
        'LMP-WIS-005',
        'LMP-POD-001',
        'LMP-POD-004',
        'LMP-KIN-001',
        'LMP-KIN-004',
        'LMP-NOC-003',
        'LMP-ABA-001',
        'LMP-ABA-002',
        'LMP-AKC-001',
      ].map((sku, i) => [sku, i % 4 === 0 ? 2 : 1]),
      'dpd',
      null,
      'przelewy24',
      5,
      18,
    ],
  ];
  for (const [kanal, osoba, koszyk, wysylka, nazwaWysylki, platnosc, h, m, b2b] of NOWE) {
    const ms = chwila(0, h, m);
    // Nic po „teraz” — reset o 00:20 ma mniej dzisiejszych nowych, nigdy zamówienie z przyszłości.
    if (ms > koniecDnia - 60000) continue;
    dodaj({
      kanal,
      osoba: osoba ?? undefined,
      b2b,
      koszyk,
      wysylka,
      ...(nazwaWysylki ? { nazwaWysylki } : {}),
      platnosc,
      utworzoneMs: ms,
      oplaconeMs: oplacone(ms, platnosc),
    });
    status('nowe');
  }

  // Personalizacja w nazwie pozycji (grawer, nadruk) — zwykłe „w realizacji” z wczoraj (nie po terminie), bez statusu „Indywidualne”.
  const INDYWIDUALNE = [
    [
      W,
      20,
      [['LMP-STO-005', 1, 'Lampa stołowa Dąbek, dąb olejowany — GRAWER na podstawie: „Dla Zosi na 18. urodziny”']],
      'dpd',
      'przelewy24',
      1,
      9,
      30,
    ],
    [
      W,
      21,
      [['LMP-NOC-003', 1, 'Lampka nocna — GRAWER imienia „Antoś” i daty urodzenia 03.09.2026']],
      'inpost_paczkomat',
      'blik',
      1,
      20,
      5,
    ],
    [
      'reczne',
      null,
      [['LMP-ABA-002', 12, 'Abażur lniany — NADRUK logo hotelu (projekt klienta)']],
      'dpd',
      'bacs',
      1,
      11,
      40,
      1,
    ],
    [
      W,
      22,
      [['LMP-WIS-002', 1, 'Lampa wisząca Kopuła 60 cm — KOLOR NA ZAMÓWIENIE RAL 6021, przewód 3 m']],
      'dpd',
      'karta',
      1,
      15,
      15,
    ],
    [
      'allegro',
      60,
      [['LMP-KIN-002', 2, 'Kinkiet — GRAWER numeru mieszkania „14A” na tarczy']],
      'allegro_kurier',
      'allegro',
      1,
      13,
      50,
      null,
      DHL,
    ],
    [
      W,
      23,
      [['LMP-POD-002', 1, 'Lampa podłogowa — GRAWER dedykacji na stopie „Mamie i Tacie, 40 lat razem”']],
      'dpd',
      'przelewy24',
      4,
      10,
      25,
    ],
  ];
  for (const [kanal, osoba, koszyk, wysylka, platnosc, dni, h, m, b2b, nazwaWysylki] of INDYWIDUALNE) {
    const ms = chwila(dni, h, m);
    const z = dodaj({
      kanal,
      osoba: osoba ?? undefined,
      b2b: b2b ?? undefined,
      koszyk,
      wysylka,
      ...(nazwaWysylki ? { nazwaWysylki } : {}),
      platnosc,
      utworzoneMs: ms,
      oplaconeMs: kanal === 'reczne' ? null : ms + 6 * 60000,
      uwagi: 'Personalizacja — proszę o podgląd projektu przed wykonaniem.',
    });
    // Starsze (4 dni) są już wysłane — personalizowane zamówienie w realizacji byłoby po terminie wysyłki.
    if (dni >= 4)
      wyslij(z, {
        kurier: 'dpd',
        wRealizacjiMs: ms + 2 * 3600000,
        wyslaneMs: ms + 20 * 3600000,
        doreczonaMs: ms + 44 * 3600000,
      });
    else {
      zapiszFaktyStatusu(db, z.id, { w_realizacji_at: iso(ms + 2 * 3600000), wyslane_at: null });
      status('w_realizacji');
    }
  }

  // W REALIZACJI — 18 tutaj (+4 z pozostałych uzupełnień = 22): 14 z wczoraj po 12:00, 2 z dziś rano, 2 sprzed 5 dni (po terminie).
  const W_REALIZACJI = [
    [W, 24, [['LMP-STO-002', 1]], 'dpd', null, 'przelewy24', 1, 12, 20],
    ['allegro', 61, [['LMP-NOC-001', 2]], 'allegro_paczkomat', null, 'allegro', 1, 12, 48],
    [W, 25, [['LMP-WIS-003', 1]], 'dpd', null, 'cod', 1, 13, 10],
    ['allegro', 62, [['LMP-STO-003', 1]], 'allegro_kurier', DHL, 'allegro', 1, 13, 35],
    [
      W,
      26,
      [
        ['LMP-AKC-003', 2],
        ['LMP-AKC-001', 2],
      ],
      'inpost_paczkomat',
      null,
      'blik',
      1,
      14,
      2,
    ],
    [
      'reczne',
      null,
      [
        ['LMP-STO-006', 6],
        ['LMP-AKC-001', 6],
      ],
      'dpd',
      null,
      'bacs',
      1,
      14,
      30,
      3,
    ],
    ['allegro', 63, [['LMP-KIN-004', 1]], 'allegro_punkt', ONE, 'allegro', 1, 15, 5],
    [W, 27, [['LMP-POD-003', 1]], 'odbior_osobisty', null, 'karta', 1, 15, 44],
    ['allegro', 64, [['LMP-ABA-003', 1]], 'allegro_dpd', null, 'allegro_pobranie', 1, 16, 20],
    [
      W,
      28,
      [
        ['LMP-NOC-002', 1],
        ['LMP-AKC-002', 1],
      ],
      'inpost_paczkomat',
      null,
      'przelewy24',
      1,
      17,
      3,
    ],
    ['allegro', 65, [['LMP-WIS-005', 1]], 'allegro_kurier', ONE_KURIER, 'allegro', 1, 18, 26],
    [W, 29, [['LMP-STO-001', 1]], 'dpd', null, 'bacs', 1, 19, 11],
    ['allegro', 66, [['LMP-AKC-001', 4]], 'allegro_paczkomat', null, 'allegro', 1, 20, 47],
    [W, 30, [['LMP-KIN-001', 2]], 'inpost_paczkomat', null, 'cod', 1, 22, 15],
    [W, 31, [['LMP-ABA-004', 1]], 'dpd', null, 'blik', 0, 0, 35],
    ['allegro', 67, [['LMP-STO-004', 1]], 'allegro_kurier', DHL, 'allegro', 0, 2, 50],
    // Po terminie: opłacone 5 dni temu (co najmniej 3 dni robocze przy limicie 1).
    [W, 32, [['LMP-WIS-004', 1]], 'dpd', null, 'przelewy24', 5, 10, 5],
    ['allegro', 68, [['LMP-POD-004', 1]], 'allegro_kurier', ONE_KURIER, 'allegro', 5, 14, 40],
  ];
  for (const [kanal, osoba, koszyk, wysylka, nazwaWysylki, platnosc, dni, h, m, b2b] of W_REALIZACJI) {
    const ms = chwila(dni, h, m);
    if (dni === 0 && ms + 30 * 60000 > koniecDnia - 60000) continue; // Nic po „teraz”
    // `bacs` (przelew) przy w realizacji jest już zapłacony — pracownia nie rusza przedpłaty bez wpłaty.
    const wplata = ['cod', 'allegro_pobranie'].includes(platnosc) || kanal === 'reczne' ? null : ms + 7 * 60000;
    const z = dodaj({
      kanal,
      osoba: osoba ?? undefined,
      b2b,
      koszyk,
      wysylka,
      ...(nazwaWysylki ? { nazwaWysylki } : {}),
      platnosc,
      utworzoneMs: ms,
      oplaconeMs: wplata,
    });
    zapiszFaktyStatusu(db, z.id, {
      w_realizacji_at: iso(dni === 0 ? ms + 30 * 60000 : ms + 2 * 3600000),
      wyslane_at: null,
    });
    status('w_realizacji');
  }

  // WYSŁANE z dni 2–3 — doręczone albo w drodze.
  const WYSLANE = [
    [W, 33, [['LMP-STO-005', 1]], 'dpd', 'przelewy24', 3, 9, 15, 'dpd'],
    ['allegro', 69, [['LMP-NOC-001', 1]], 'allegro_paczkomat', 'allegro', 3, 16, 40, 'inpost'],
    [W, 34, [['LMP-ABA-001', 1]], 'inpost_paczkomat', 'blik', 2, 10, 30, 'inpost'],
    ['allegro', 70, [['LMP-KIN-003', 1]], 'allegro_dpd', 'allegro', 2, 13, 5, 'dpd'],
  ];
  for (const [kanal, osoba, koszyk, wysylka, platnosc, dni, h, m, kurier] of WYSLANE) {
    const ms = chwila(dni, h, m);
    const z = dodaj({ kanal, osoba, koszyk, wysylka, platnosc, utworzoneMs: ms, oplaconeMs: ms + 5 * 60000 });
    wyslij(z, {
      kurier,
      wRealizacjiMs: ms + 2 * 3600000,
      wyslaneMs: ms + 20 * 3600000,
      doreczonaMs: ms + 44 * 3600000,
    });
  }
}

// Zwrot części dużego koszyka, do którego korektę wystawia usługa zwrotów (rozliczeniaPrz160).
const POWOD_ZWROTU_PRZ160 = 'Kinkiet nie pasuje do wnęki — klient zatrzymuje resztę zamówienia';

/**
 * Część synchroniczna: duże koszyki, faktury dla osób prywatnych i z Allegro, paczki utworzone
 * i w drodze we wszystkich kanałach (ZAMOWIENIA_PACZEK) oraz zamówienia czterech firm rozliczanych zbiorczo
 * (ZAMOWIENIA_ZBIORCZE) — te PRAWDZIWĄ usługą zamówienia ręcznego (rabat z karty, próg darmowej dostawy, opłata za
 * obsługę własnej etykiety), z okresem z `przypiszDoOkresu`. Faktury okresów, wpłaty i korekta — rozliczeniaPrz160
 * (asynchronicznie, na atrapie inFaktu). Bez `los`: sekwencja losowań reszty demo się nie zmienia.
 */
/**
 * Jedno zamówienie ze sklepu z 15 różnymi produktami — lista zamówień pokazuje 5 pozycji
 * i zwija resztę pod „Pokaż jeszcze 10”. Wczoraj wieczorem, opłacone, w realizacji: blisko góry listy przez cały dzień.
 * Bez `los` — sekwencja losowania reszty demo się nie przesuwa.
 */
export const SKU_DUZEGO_KOSZYKA_PRZ163 = PRODUKTY.filter((p) => p.kanaly?.includes('polcien'))
  .slice(0, 15)
  .map((p) => p.sku);
function uzupelnieniaPrz163(db, { pomocnicy }) {
  const { chwila, sklepWoo, dodaj, status, doTeraz } = pomocnicy;
  const z = dodaj({
    kanal: sklepWoo,
    osoba: 3,
    koszyk: SKU_DUZEGO_KOSZYKA_PRZ163.map((sku, i) => [sku, i % 5 === 0 ? 2 : 1]),
    wysylka: 'dpd',
    platnosc: 'bacs',
    utworzoneMs: chwila(1, 20, 25),
    oplaconeMs: chwila(1, 20, 40),
  });
  zapiszFaktyStatusu(db, z.id, { w_realizacji_at: iso(doTeraz(chwila(0, 7, 30))), wyslane_at: null });
  status('w_realizacji');
}

function uzupelnieniaPrz160(db, { dzis, pomocnicy }) {
  const { chwila, dodaj, status, wyslij, kolejnyList, liczniki, koniecDnia, doTeraz } = pomocnicy;
  const fakturuj = (z, ms) => {
    faktura(db, z.id, doTeraz(ms, 10));
    liczniki.faktury += 1;
  };
  // Kolejność: najpierw firmy zbiorcze, potem paczki — najnowsze zamówienie „czeka na fakturę” (fv 'czeka') jest wtedy
  // zwykłym zamówieniem ze sklepu, na którym „Wystaw fakturę” działa (zamówieniu z okresu panel faktury pojedynczej odmawia).
  zamowieniaZbiorcze();
  zamowieniaPaczek();

  // Okres istnieje od pierwszego zamówienia miesiąca — data założenia z niego, nie z zegara generatora.
  db.prepare(
    `UPDATE okresy_rozliczeniowe SET utworzony_at = (SELECT MIN(z.utworzone_at) FROM zamowienia z
    WHERE z.okres_rozliczeniowy_id = okresy_rozliczeniowe.id) WHERE EXISTS (SELECT 1 FROM zamowienia z WHERE z.okres_rozliczeniowy_id = okresy_rozliczeniowe.id)`,
  ).run();

  // Duże koszyki i paczki.
  function zamowieniaPaczek() {
    for (const [
      n,
      [kanal, kto, koszyk, wysylka, nazwaWysylki, platnosc, dni, h, m, kurier, stan, fv],
    ] of ZAMOWIENIA_PACZEK.entries()) {
      const ms = chwila(dni, h, m);
      const b2b = typeof kto === 'object' ? kto.b2b : undefined;
      const z = dodaj({
        kanal,
        osoba: b2b == null ? kto : undefined,
        b2b,
        koszyk,
        wysylka,
        ...(nazwaWysylki ? { nazwaWysylki } : {}),
        platnosc,
        // Przelew B2B czeka na termin faktury; reszta zapłacona przy zakupie.
        utworzoneMs: ms,
        oplaconeMs: kanal === 'reczne' ? null : ms + 6 * 60000,
        ...(['nip', 'czeka'].includes(fv)
          ? { nip: nipFikcyjny(9200 + n * 7) }
          : fv === 'prywatna'
            ? { chceFakture: true }
            : {}),
      });
      const wystawic = fv && fv !== 'czeka';
      const wRealizacjiMs = doTeraz(ms + 2 * 3600000, 40);
      if (stan === 'utworzona') {
        zapiszFaktyStatusu(db, z.id, { w_realizacji_at: iso(wRealizacjiMs), wyslane_at: null });
        przesylka(db, z.id, {
          kurier,
          numer: numerListu({ calk: () => 30000000 + z.id }, kurier, kolejnyList()),
          nadanaMs: doTeraz(wRealizacjiMs + 3600000, 20),
          doreczonaMs: null,
          terazMs: koniecDnia,
        });
        liczniki.przesylki += 1;
        status('w_realizacji');
        if (wystawic) fakturuj(z, wRealizacjiMs + 30 * 60000);
        continue;
      }
      const wyslaneMs = doTeraz(ms + 20 * 3600000, 30);
      wyslij(z, {
        kurier,
        wRealizacjiMs,
        wyslaneMs,
        doreczonaMs: stan === 'w_drodze' ? koniecDnia + 2 * DOBA : wyslaneMs + 30 * 3600000,
      });
      if (wystawic) fakturuj(z, wyslaneMs + 30 * 60000);
      if (n === 0) {
        // Klient odsyła jeden z dwóch kinkietów — korektę do tej części wystawi usługa zwrotów (rozliczeniaPrz160).
        const p = pobierzZamowienie(db, z.id).pozycje.find((x) => x.sku === 'LMP-KIN-001');
        dodajZwrot(db, z.id, {
          data: dzienWarszawy(doTeraz(koniecDnia - 2 * DOBA)),
          kwota: p.cena_brutto,
          powod: POWOD_ZWROTU_PRZ160,
          pozycje: [{ klucz_pozycji: p.sku, nazwa: p.nazwa, ilosc: 1, kwota: p.cena_brutto }],
        });
        liczniki.zwroty += 1;
        liczniki.statusy.wyslane -= 1;
        status('zwrot');
      }
    }
  }

  // Firmy rozliczane zbiorczo — zamówienia w miesiącach okresów (bieżący, poprzedni, sprzed dwóch).
  function zamowieniaZbiorcze() {
    const [rok, miesiac, dzienMies] = dzis.split('-').map(Number);
    const oknoOd = poczatekDnia(dzis) - 58 * DOBA;
    for (const [n, [indeks, wstecz, dzien, h, m, koszyk, wysylka, osobaOdbiorcy]] of ZAMOWIENIA_ZBIORCZE.entries()) {
      const firma = FIRMY_B2B[indeks];
      let ms;
      if (wstecz === 0) {
        const k = Math.min(dzien, dzienMies - 1);
        // 1. dnia miesiąca bieżący okres ma tylko dzisiejsze zamówienia — złożone przed „teraz”.
        ms = k > 0 ? chwila(k, h, m) : Math.min(chwila(0, h, m), koniecDnia - (15 + 3 * n) * 60000);
        if (k === 0 && ms < chwila(0, 0, 0)) continue;
      } else {
        const d = new Date(Date.UTC(rok, miesiac - 1 - wstecz, dzien)).toISOString().slice(0, 10);
        ms = chwilaWarszawy(poczatekDnia(d), h, m);
      }
      if (ms < oknoOd || ms > koniecDnia - 10 * 60000) continue;
      const klient = {
        first_name: '',
        last_name: '',
        company: firma.nazwa,
        email: `zamowienia.zb${indeks}@example.invalid`,
        phone: '',
        address_1: firma.ulica,
        postcode: firma.kod,
        city: firma.miasto,
        country: 'PL',
      };
      // Dropshipping: paczka jedzie do klienta firmy, fakturę dostaje firma.
      const o = osobaOdbiorcy != null ? KLIENCI[osobaOdbiorcy] : null;
      const dostawa = o
        ? {
            first_name: o.imie,
            last_name: o.nazwisko,
            address_1: o.ulica,
            city: o.miasto,
            postcode: o.kod,
            country: 'PL',
          }
        : {
            first_name: '',
            last_name: '',
            company: firma.nazwa,
            address_1: firma.ulica,
            city: firma.miasto,
            postcode: firma.kod,
            country: 'PL',
          };
      const okres = przypiszDoOkresu({ db, nip: firma.nip, dataZlozenia: iso(ms), hurt: false });
      const { id } = zalozZamowienieReczne({
        db,
        znacznik: iso(ms),
        okresId: okres,
        dane: {
          rok: new Date(ms).getUTCFullYear(),
          klient,
          dostawa,
          metoda_wysylki: wysylka,
          koszt_dostawy_brutto: zl(
            wysylka === 'odbior_osobisty' ? 0 : (firma.koszt_dostawy_gr ?? KOSZT_WYSYLKI_GR[wysylka]),
          ),
          chce_fakture: true,
          nip: firma.nip,
          metoda_platnosci: 'przelew',
          b2b: true,
          termin_platnosci: firma.termin_platnosci,
          rabat_procent: 0,
          etykietaKlienta: Boolean(firma.etykietaKlienta),
          uwagi: o ? 'Wysyłka na etykiecie klienta (dropshipping).' : null,
          pozycje: koszyk.map(([sku, ilosc]) => {
            const p = PRODUKT.get(sku);
            return {
              nazwa: p.nazwa,
              sku,
              ilosc,
              cena_brutto: zl(p.cena_gr),
              brutto_linii: zl(p.cena_gr * ilosc),
              cena_katalogowa: zl(p.cena_gr),
            };
          }),
        },
      });
      const z = { id, klient: { email: klient.email } };
      wiadomosc(
        db,
        id,
        'potwierdzenie',
        klient.email,
        'Potwierdzenie zamówienia',
        Math.min(ms + 600000, koniecDnia - 60000),
      );
      liczniki.zamowienia += 1;
      liczniki.wiadomosci += 1;
      if (koniecDnia - ms < DOBA) {
        zapiszFaktyStatusu(db, id, { w_realizacji_at: iso(doTeraz(ms + 3600000, 5)), wyslane_at: null });
        status('w_realizacji');
        continue;
      }
      const wyslaneMs = doTeraz(ms + 24 * 3600000, 30);
      if (wysylka === 'odbior_osobisty' || firma.etykietaKlienta) {
        // Odbiór osobisty i paczka na etykiecie klienta — bez przesyłki w panelu.
        zapiszFaktyStatusu(db, id, { w_realizacji_at: iso(ms + 3 * 3600000), wyslane_at: iso(wyslaneMs) });
        wiadomosc(
          db,
          id,
          'faktura',
          klient.email,
          'Zamówienie wysłane',
          Math.min(wyslaneMs + 600000, koniecDnia - 60000),
        );
        liczniki.wiadomosci += 1;
        status('wyslane');
      } else {
        wyslij(z, { kurier: 'dpd', wRealizacjiMs: ms + 3 * 3600000, wyslaneMs, doreczonaMs: wyslaneMs + 26 * 3600000 });
      }
    }
  }
}

/**
 * Część asynchroniczna (po magazynie, na atrapie inFaktu jak w piaskownicy): okresy poprzednich miesięcy
 * zamknięte albo zafakturowane PRAWDZIWĄ usługą faktury okresu (createFakturaOkresu), część opłacona wpłatą okresu
 * (dodajWplateOkresu) i w atrapie („Oznacz zapłaconą”), oraz korekta częściowego zwrotu usługą zwrotów (createKorekta).
 * Zegar atrapy stoi na chwili zdarzenia demo; znaczniki, które warstwa bazy bierze z zegara systemowego (zamknięcie,
 * rezerwacja faktury, wpłata, zlecenie korekty), przestawiamy na tę samą chwilę — inaczej demo z `dzis` w przeszłości
 * miałoby faktury „z jutra”. Poza trybem próby (bez atrapy) okresy zostają otwarte.
 */
async function rozliczeniaPrz160(db, { dzis, koniecDnia, env }) {
  if (env?.OMS_TRYB !== 'proba') return null;
  const { createAtrapaInfaktu } = await import('../deploy/proba/atrapy/infakt.mjs');
  let zegar = koniecDnia;
  const infakt = createAtrapaInfaktu({ db, env, teraz: () => new Date(zegar), log: () => {} });
  const nipSprzedawcy = () => env.OMS_SPRZEDAWCA_NIP ?? null;
  const fakturaOkresu = createFakturaOkresu({ db, infakt, nipSprzedawcy, teraz: () => new Date(zegar).toISOString() });
  const wynik = { zafakturowane: 0, oplacone: 0, zamkniete: 0, korekty: 0 };
  const chwilaDnia = (dzien, h, m, zapasMin) =>
    Math.min(chwilaWarszawy(poczatekDnia(dzien), h, m), koniecDnia - zapasMin * 60000);

  // Nabywca faktury okresu jest w kartotece programu — klienta zbiorczego zakłada się tam raz, ręcznie (faktura-okresu.js).
  for (const f of FIRMY_B2B.filter((x) => x.rozliczenie_zbiorcze)) {
    if (!(await infakt.znajdzKlientaPoNip(f.nip))) {
      await infakt.zalozKlienta({
        company_name: f.nazwa,
        nip: f.nip,
        street: f.ulica,
        city: f.miasto,
        postal_code: f.kod,
        country: 'PL',
      });
    }
  }
  const [rokD, miesiacD] = dzis.split('-').map(Number);
  for (const o of db.prepare('SELECT * FROM okresy_rozliczeniowe ORDER BY rok, miesiac, id').all()) {
    const wstecz = rokD * 12 + miesiacD - (o.rok * 12 + o.miesiac);
    if (wstecz <= 0) continue;
    const klient = umowaZbiorcza(klientPoKluczu(db, o.klient_klucz));
    const firma = FIRMY_B2B.find((f) => f.nip === klient?.nip);
    const rola = wstecz === 1 ? firma?.okresy?.poprzedni : firma?.okresy?.starsze;
    if (!rola) continue;
    const dzienFaktury = new Date(Date.UTC(o.rok, o.miesiac, 1)).toISOString().slice(0, 10);
    zegar = chwilaDnia(dzienFaktury, 8, 0, 15);
    if (rola === 'zamkniety') {
      zamknijOkres(db, o.id);
      db.prepare('UPDATE okresy_rozliczeniowe SET zamkniety_at = ? WHERE id = ?').run(iso(zegar), o.id);
      wynik.zamkniete += 1;
      continue;
    }
    const okres = await fakturaOkresu.wystaw(o.id, klient, {
      dataWystawienia: dzienFaktury,
      termin: firma.termin_platnosci,
    });
    db.prepare('UPDATE okresy_rozliczeniowe SET zamkniety_at = ?, utworzona_at = ? WHERE id = ?').run(
      iso(zegar),
      iso(zegar),
      o.id,
    );
    wynik.zafakturowane += 1;
    if (rola !== 'oplacony') continue;
    const dzienWplaty = [
      new Date(Date.parse(`${dzienFaktury}T12:00:00Z`) + 6 * DOBA).toISOString().slice(0, 10),
      dzis,
    ].sort()[0];
    zegar = chwilaDnia(dzienWplaty, 10, 0, 10);
    const { zamowienia } = podzialZamowienOkresu(zamowieniaOkresu(db, o.id).map((id) => pobierzZamowienie(db, id)));
    const wplata = dodajWplateOkresu(db, o.id, {
      kwota: zl(sumaOczekiwanaOkresuGrosze(zamowienia)),
      data: dzienWplaty,
      metoda: 'przelew',
      uwaga: `Przelew za fakturę ${okres.numer} (demo)`,
    });
    db.prepare('UPDATE platnosci_okresu SET utworzona_at = ? WHERE id = ?').run(iso(zegar), wplata.id);
    await infakt.oznaczZaplacona(okres.infakt_uuid ?? okres.dokument_id, { paidDate: dzienWplaty });
    wynik.oplacone += 1;
  }

  // Korekta do zwrotu części koszyka — tą samą usługą, co przycisk „Wystaw korektę” na ekranie zwrotu.
  const zwrot = db
    .prepare('SELECT id, zamowienie_id, data FROM zwroty WHERE powod = ? AND korekta_zlecona_at IS NULL')
    .get(POWOD_ZWROTU_PRZ160);
  if (zwrot) {
    zegar = chwilaDnia(zwrot.data, 13, 0, 20);
    const korekta = createKorekta({ db, infakt, nipSprzedawcy });
    await korekta.wystaw(zwrot.zamowienie_id, zwrot.id);
    await korekta.doczytaj(zwrot.zamowienie_id, zwrot.id);
    db.prepare('UPDATE zwroty SET korekta_zlecona_at = ? WHERE id = ?').run(iso(zegar), zwrot.id);
    wynik.korekty += 1;
  }
  return wynik;
}

function opcjeCli(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!['--baza', '--ziarno', '--dzis', '--teraz'].includes(argv[i]) || argv[i + 1] === undefined) {
      throw new Error('Użycie: --baza ŚCIEŻKA_BEZWZGLĘDNA [--ziarno N] [--dzis RRRR-MM-DD] [--teraz HH:MM]');
    }
    o[argv[i].slice(2)] = argv[i + 1];
  }
  if (!o.baza || !path.isAbsolute(o.baza)) throw new Error('DEMO_BAZA: wymagana ścieżka bezwzględna');
  const ziarno = o.ziarno === undefined ? 72 : Number(o.ziarno);
  if (!Number.isInteger(ziarno) || ziarno < 0) throw new Error('DEMO_ZIARNO: liczba całkowita ≥ 0');
  const dzis = o.dzis ?? new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Warsaw' });
  terazDemo(dzis, o.teraz);
  return { baza: path.resolve(o.baza), ziarno, dzis, ...(o.teraz ? { teraz: o.teraz } : {}) };
}

/** Tworzy NOWY plik bazy z demo. Istniejący plik (albo jego -wal/-shm) = odmowa, bajty nietknięte. */
// Parametry kart jak u firmy po porządkach: akcesoria i abażury nie mają mocy ani gwintu, a kilka lamp nie ma
// wymaganego Gwintu — ekran braków ma co pokazać. Wartości wynikają z numeru karty, więc demo jest deterministyczne.
const KATEGORIE_BEZ_MOCY = new Set(['Abażury i klosze', 'Akcesoria']);
const MOCE_DEMO = [4, 6, 9, 12, 40];
const KOLORY_DEMO = ['czarny', 'biały', 'mosiądz', 'chrom'];
const GWINTY_DEMO = ['E27', 'E14', 'GU10'];
const MATERIALY_DEMO = ['metal', 'szkło', 'drewno', 'tkanina', 'ceramika'];

async function zasiejParametryKartDemo(db, karty, { at }) {
  const { dodajParametr, ustawWartoscKarty } = await import('../src/oms/db/parametry-kart.js');
  const definicje = [
    { nazwa: 'Moc żarówki', typ: 'liczba', jednostka: 'W' },
    { nazwa: 'Kolor', typ: 'lista', wartosci: KOLORY_DEMO },
    { nazwa: 'Gwint', typ: 'lista', wartosci: GWINTY_DEMO, wymagany: true },
    { nazwa: 'Materiał', typ: 'tekst' },
  ];
  const [moc, kolor, gwint, material] = definicje.map((d) => {
    const w = dodajParametr(db, d, { at });
    if (!w.ok) throw new Error(`DEMO_PARAMETRY: ${d.nazwa}: ${w.blad}`);
    return w.id;
  });
  const lampy = karty.filter((k) => !KATEGORIE_BEZ_MOCY.has(k.kategoria_glowna));
  const bezGwintu = new Set([2, lampy.length - 3].map((i) => lampy[i]?.id));
  const zapisz = (karta, parametr, wartosc) => {
    const w = ustawWartoscKarty(db, karta, parametr, wartosc, { at });
    if (!w.ok) throw new Error(`DEMO_PARAMETRY: karta ${karta}: ${w.blad}`);
  };
  for (const [i, k] of karty.entries()) {
    zapisz(k.id, kolor, KOLORY_DEMO[i % KOLORY_DEMO.length]);
    zapisz(k.id, material, MATERIALY_DEMO[i % MATERIALY_DEMO.length]);
    if (KATEGORIE_BEZ_MOCY.has(k.kategoria_glowna)) continue;
    zapisz(k.id, moc, String(MOCE_DEMO[i % MOCE_DEMO.length]));
    if (!bezGwintu.has(k.id)) zapisz(k.id, gwint, GWINTY_DEMO[i % GWINTY_DEMO.length]);
  }
}

// Oferty outletu bez karty — żeby ekran „Do powiązania” w Magazynie też miał treść.
const OUTLET_NIEPOWIAZANY = new Set(['LMP-NOC-002-OUT', 'LMP-ABA-004-OUT']);

/**
 * Demo po zatwierdzeniu stanów w kanałach. Sześć ofert z ilością z OMS (istniejąca oferta Allegro
 * i pięć przejętych z lustra), po jednym problemie ilości `skok` i `rozjazd-dol`, jedno zatwierdzenie ostatniego
 * włączenia ze skrótem liczonym tą samą funkcją domeny co aplikacja. Przy każdym resecie wychodzi to samo.
 */
function stanyKanalowDemo(db, { synchronizacja }) {
  const opcje = { teraz: synchronizacja };
  const wlaczone = db.prepare('SELECT id FROM magazyn_przelaczenia WHERE wlaczone = 1 ORDER BY id DESC LIMIT 1').get();
  if (!wlaczone) throw new Error('DEMO_STANY: stany magazynowe nie są włączone');
  const ofertyDemo = db
    .prepare(
      `SELECT id FROM oferty_kanalow WHERE kanal = 'allegro' AND stan = 'aktywna'
    AND pochodzenie = 'oms' ORDER BY id`,
    )
    .all()
    .map((w) => Number(w.id));
  const lustro = db
    .prepare(
      `SELECT produkt_id, karta_id FROM produkty_sklepowe WHERE kanal = 'allegro' AND karta_id IS NOT NULL
    AND COALESCE(wariant_id, '') = '' AND karta_id IN (SELECT karta_id FROM stany_otwarcia) ORDER BY karta_id LIMIT 5`,
    )
    .all();
  for (const w of lustro) {
    ofertyDemo.push(
      wstawOferte(
        db,
        {
          kartaId: Number(w.karta_id),
          kanal: 'allegro',
          idZewnetrzne: String(w.produkt_id),
          pochodzenie: 'przejeta',
          tryb: 'zarzadzana',
          stan: 'aktywna',
        },
        opcje,
      ).id,
    );
  }
  if (ofertyDemo.length !== 6)
    throw new Error(`DEMO_STANY: oczekiwano 6 ofert z ilością z OMS, jest ${ofertyDemo.length}`);
  const problemyDemo = new Map([
    [1, { ...PROBLEMY_ILOSCI.skok, od: synchronizacja, cel: 4, odczyt: 18 }],
    [2, { ...PROBLEMY_ILOSCI['rozjazd-dol'], od: synchronizacja, cel: 12, odczyt: 3, zakres: { min: 9, max: 12 } }],
  ]);
  for (const [i, id] of ofertyDemo.entries()) {
    zmienOferte(
      db,
      id,
      {
        iloscZOms: true,
        iloscWyslanaAt: synchronizacja,
        ...(problemyDemo.has(i) ? { iloscProblem: problemyDemo.get(i) } : {}),
      },
      opcje,
    );
  }
  const wiersze = db.prepare('SELECT * FROM oferty_kanalow').all();
  const skrot = skrotZatwierdzenia({
    oferty: wiersze,
    migawka: migawkaStanow(db),
    maxRuchId: db.prepare('SELECT MAX(id) m FROM ruchy_magazynowe').get().m,
    bufory: db.prepare('SELECT * FROM oferty_ustawienia_kont').all(),
  });
  zapiszZatwierdzenieStanow(
    db,
    { przelaczenieId: Number(wlaczone.id), zatwierdzil: 'demo', ofert: ofertyDemo.length, skrot },
    opcje,
  );
}

/**
 * Lustro magazynu z katalogu demo (scripts/demo-dane-katalog.mjs). Idzie PRAWDZIWYM odswiezMagazyn —
 * tą samą drogą co „Synchronizuj” — potem karty z produktów sklepu i oferty Allegro przypięte po SKU (-OUT → bazowe).
 */
async function wypelnijMagazyn(db, { dzis, koniecDnia }) {
  const { odswiezMagazyn } = await import('../src/moduly/magazyn/services/magazyn-sync.js');
  const { zapiszCeneZakupu } = await import('../src/oms/db/ceny-zakupu.js');
  const { utworzKartyZNiepowiazanych, niepowiazaneOfertyAllegro, powiazOfertyHurtem, zapiszKarte } =
    await import('../src/oms/db/magazyn.js');
  const { klienciKataloguDemo } = await import('./demo-dane-katalog.mjs');
  const { sklepy, allegro, kanalySklepow, kanalyAllegro } = klienciKataloguDemo();
  // Synchronizacja o 04:00 UTC, chyba że „teraz” demo jest wcześniej (reset tuż po północy).
  const synchronizacja = new Date(Math.min(Date.parse(`${dzis}T04:00:00.000Z`), koniecDnia - 30 * 60000)).toISOString();
  const teraz = () => synchronizacja;
  const synchronizuj = async () => {
    const przebieg = await odswiezMagazyn({ db, sklepy, allegro, teraz, kanalySklepow, kanalyAllegro, log: () => {} });
    const bledy = przebieg.kanaly.filter((k) => k.blad);
    if (bledy.length) throw new Error(`DEMO_MAGAZYN: ${bledy.map((k) => `${k.kanal}: ${k.blad}`).join('; ')}`);
    return przebieg;
  };
  const przebieg = await synchronizuj();
  const karty = utworzKartyZNiepowiazanych(db, { teraz, kanalySklepow });
  // Karta powstaje bez SKU (nadanie SKU to w Magazynie osobny krok) — demo dostaje SKU katalogu, jak firma po nadaniu.
  const poSku = new Map(
    db
      .prepare(
        `SELECT karta_id, sku_sklepu FROM produkty_sklepowe
    WHERE kanal IN (${kanalySklepow.map(() => '?').join(',')}) AND karta_id IS NOT NULL AND sku_sklepu IS NOT NULL`,
      )
      .all(...kanalySklepow)
      .map((p) => [p.sku_sklepu, p.karta_id]),
  );
  for (const [sku, kartaId] of poSku) zapiszKarte(db, kartaId, { sku }, { at: teraz() });
  // Firma po porządkach: ceny zakupu z historią na trzech kartach, wymiary ze sklepu poza trzema produktami —
  // ekran braków ma co pokazać (0/30 kompletnych wyglądałoby na magazyn, którym nikt się nie zajmuje).
  const kartyDemo = db.prepare('SELECT id, kategoria_glowna FROM karty_produktow ORDER BY id').all();
  const dzien = (przesuniecie) => iso(poczatekDnia(dzis) + przesuniecie * DOBA).slice(0, 10);
  const kartyZHistoria = kartyDemo.slice(0, 3);
  for (const [i, karta] of kartyZHistoria.entries()) {
    const opcje = { kto: null, zrodlo: 'karta', at: teraz() };
    zapiszCeneZakupu(db, karta.id, { gr: 4500 + i * 1000, od: dzien(-90) }, opcje);
    zapiszCeneZakupu(db, karta.id, { gr: 5000 + i * 1000, od: dzien(-30) }, opcje);
    if (i === 0) zapiszCeneZakupu(db, karta.id, { gr: 5500, od: dzien(30) }, opcje);
  }
  await zasiejParametryKartDemo(db, kartyDemo, { at: teraz() });
  const pary = niepowiazaneOfertyAllegro(db, kanalyAllegro)
    .filter((o) => !OUTLET_NIEPOWIAZANY.has(o.sku_sklepu))
    .map((o) => ({ produktId: o.id, kartaId: poSku.get(String(o.sku_sklepu).replace(/-OUT$/, '')) }))
    .filter((p) => p.kartaId);
  const oferty = powiazOfertyHurtem(db, pary, kanalyAllegro);
  (await import('./demo-dane-katalog.mjs')).zasiejOfertyAllegroDemo(db, { teraz });
  (await import('./demo-dane-katalog.mjs')).zasiejCenyKanalowDemo(db, { teraz });
  (await import('./demo-dane-katalog.mjs')).zasiejCennikiOmsDemo(db, { teraz });
  // Woo ma już do czego zapisać cenę i galerię, również dla powiązanego szkicu.
  await synchronizuj();
  const od = dzien(-60);
  const opcjeCenyZakupu = { kto: null, zrodlo: 'karta', at: teraz() };
  const kartyZCena = db.prepare('SELECT id, cena_gr FROM karty_produktow ORDER BY id').all();
  for (const [i, { id, cena_gr }] of kartyZCena.entries()) {
    zapiszKarte(db, id, { stawka_vat: '23' }, { at: teraz() });
    if (kartyZHistoria.some((karta) => karta.id === id)) continue;
    const procent = 45 + ((i * 7) % 16);
    const gr = Math.round((cena_gr * procent) / 1000) * 10;
    zapiszCeneZakupu(db, id, { gr, od }, opcjeCenyZakupu);
  }
  (await import('./demo-dane-katalog.mjs')).zasiejProducentowDemo(db, { teraz });
  // Pozycje zamówień demo powstały przed lustrem i niosą samo SKU — prawdziwe zamówienia z Woo mają
  // produkt_id/variation_id, z Allegro oferta_id. Uzupełniamy je z lustra po SKU w kanale zamówienia (tylko demo).
  const naLustro = db.prepare(
    'SELECT produkt_id, wariant_id FROM produkty_sklepowe WHERE kanal = ? AND sku_sklepu = ? LIMIT 1',
  );
  const doUzupelnienia = db
    .prepare(
      'SELECT p.id, p.sku, z.sklep FROM pozycje p JOIN zamowienia z ON z.id = p.zamowienie_id WHERE p.sku IS NOT NULL AND p.produkt_id IS NULL AND p.oferta_id IS NULL',
    )
    .all();
  const ustawOferte = db.prepare('UPDATE pozycje SET oferta_id = ? WHERE id = ?');
  const ustawProdukt = db.prepare('UPDATE pozycje SET produkt_id = ?, wariant_id = ? WHERE id = ?');
  for (const p of doUzupelnienia) {
    const l = naLustro.get(p.sklep, p.sku);
    if (!l) continue;
    if (kanalyAllegro.includes(p.sklep)) ustawOferte.run(l.produkt_id, p.id);
    else ustawProdukt.run(Number(l.produkt_id), l.wariant_id || null, p.id);
  }
  // Stany magazynowe WŁĄCZONE w demo (u klienta domyślnie wyłączone) — 30 dni temu, ze stanem otwarcia
  // dla kart z SKU; zamówienia demo z ostatnich 30 dni zdejmują towar, kilka kart schodzi na minus.
  const { przelaczStany, zapiszOtwarcie } = await import('../src/oms/db/stany-magazynowe.js');
  const granica = new Date(Date.parse(synchronizacja) - 30 * 86400000).toISOString();
  przelaczStany(db, { wlacz: true, konto: { id: null, login: 'demo' }, at: granica });
  const zSku = db
    .prepare("SELECT id, wycofana FROM karty_produktow WHERE TRIM(COALESCE(sku, '')) <> '' ORDER BY id")
    .all();
  const kartyZOtwarciem = [];
  for (const [i, k] of zSku.entries()) {
    if (i % 9 === 4) continue; // kilka kart bez stanu otwarcia — zejdą na minus po pierwszym zamówieniu
    zapiszOtwarcie(db, {
      kartaId: k.id,
      ilosc: 9 + ((i * 5) % 17),
      zrodlo: 'demo',
      konto: { id: null, login: 'demo' },
      at: granica,
    });
    if (!k.wycofana) kartyZOtwarciem.push(k.id);
  }
  // Przykłady są oparte na stanie po rozchodach. Dwa pokazują stan poniżej progu, trzeci równość,
  // a pozostałe mają jeszcze zapas powyżej progu.
  const { stany } = stanyKart(db);
  const kartyZProgiem = kartyZOtwarciem.filter((id) => stany.get(id)?.stan > 0).slice(0, 6);
  for (const [i, id] of kartyZProgiem.entries()) {
    const { stan } = stany.get(id);
    const prog = i < 3 ? stan + Number(i < 2) : 0;
    zapiszKarte(db, id, { prog_niskiego_stanu: prog }, { at: teraz() });
  }
  stanyKanalowDemo(db, { synchronizacja });
  return {
    produkty: przebieg.kanaly.reduce((s, k) => s + k.zapisane, 0),
    karty: karty.utworzone,
    powiazaneOferty: oferty.powiazane.length,
  };
}

export async function utworzBazeDemo({ baza, ziarno = 72, dzis, teraz, env = ENV_DEMO }) {
  const koniecDnia = terazDemo(dzis, teraz);
  if ([baza, `${baza}-wal`, `${baza}-shm`].some((p) => fs.existsSync(p))) throw new Error('DEMO_ODMOWA_NADPISANIA');
  const { otworzBazeStartu } = await import('../src/oms/db/db.ts');
  const { modulyDla } = await import('../src/moduly/lista.ts');
  fs.mkdirSync(path.dirname(baza), { recursive: true });
  // Klucz poświadczeń z env: generator zapisuje sekrety (np. klucz API ERLI) przez warstwę dostępu.
  const db = otworzBazeStartu(env, baza, { moduly: modulyDla(env), bezKataloguBazy: true });
  // Kilka tysięcy małych zatwierdzeń: na dysku NAS-a każde z fsync trwało łącznie >4 min (laptop 2 s).
  // Baza demo jest jednorazowa — przy awarii w połowie i tak jest kasowana niżej.
  db.exec('PRAGMA synchronous = OFF');
  try {
    const wynik = wygenerujDaneDemo(db, { ziarno, dzis, teraz, env });
    wynik.magazyn = await wypelnijMagazyn(db, { dzis, koniecDnia });
    wynik.rozliczenia = await rozliczeniaPrz160(db, { dzis, koniecDnia, env });
    if (db.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok') throw new Error('DEMO_INTEGRITY');
    return wynik;
  } catch (e) {
    db.close();
    for (const p of [baza, `${baza}-wal`, `${baza}-shm`]) fs.rmSync(p, { force: true });
    throw e;
  } finally {
    if (db.isOpen) db.close();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const o = opcjeCli(process.argv.slice(2));
    const wynik = await utworzBazeDemo(o);
    console.log(JSON.stringify({ status: 'demo-gotowe', ...o, ...wynik }));
  } catch (e) {
    console.error(e instanceof Error && /^DEMO_/.test(e.message) ? e.message : `DEMO_ODMOWA: ${e?.message ?? e}`);
    process.exitCode = 1;
  }
}
