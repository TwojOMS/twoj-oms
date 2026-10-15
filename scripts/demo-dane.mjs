#!/usr/bin/env node
// PRZ-072 — generator danych demo dla piaskownicy `oms-proba` i przyszłego demo publicznego.
//
// Firma, katalog, klienci i 150 zamówień (kanał, koszyk, wysyłka, płatność, dzień i godzina względem
// `dzis`) stoją w scripts/demo-dane-firma.mjs — zmyślona manufaktura lamp „Pracownia Półcień”: sklep
// Woo + dwa konta Allegro (główne i outlet) + zamówienia ręczne B2B/UE. Ten plik dokłada to, co wynika
// z wieku zamówienia: statusy, paczki z numerami, faktury (w tym WDT i pobranie), zwroty, wiadomości,
// a obok koszty, dane miesięczne, stałych klientów z okresem zbiorczym, kampanię i reklamy. PRZ-082 dokłada 6 zamówień
// i to, czego właściciel chciał w demo: proformy, podjazdy, etykiety DHL/ORLEN/Allegro One, paczkę bez ruchu, firmy spoza KSeF.
//
// ⚠️ DANE WYŁĄCZNIE ZMYŚLONE: adresy e-mail w domenie `.invalid` (RFC 2606 — nie istnieje i nie
// zaistnieje), NIP-y z prefiksem 999 (żaden urząd skarbowy go nie wydaje) z poprawną sumą kontrolną,
// adresy „Ulica Przykładowa”, numery listów z prefiksem 0000. Strażnik: tests/instalacja/demo-dane.test.js.
//
// ⚠️ DETERMINISTYCZNY: te same `ziarno` i `dzis` dają te same dane (daty liczone od `dzis`, więc
// demo resetowane co godzinę ma zawsze świeże 60 dni). Tylko na pustej bazie — niepusta to odmowa.
//
// Użycie: node scripts/demo-dane.mjs --baza ŚCIEŻKA_BEZWZGLĘDNA [--ziarno N] [--dzis RRRR-MM-DD]
// (plik bazy nie może istnieć; środowisko demo: ENV_DEMO niżej, kanały: KANALY_DEMO).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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
import { zapiszPolaczenie, zapiszDni, zapiszTransakcje, zapiszMetaKampanie, zapiszStan } from '../src/oms/db/reklamy.js';
import { przypiszDoOkresu } from '../src/moduly/faktury/services/okres.js';
import { zapiszProforme } from '../src/moduly/faktury/db/proformy.js';
import { createProforma } from '../src/moduly/faktury/services/proforma.js';
import { wczytajFaktury } from '../src/moduly/faktury/modul.ts';
import { numerRecznego } from '../src/domena/koszt-reczny.js';
import { inicjalizujGraniceBezHistorii } from '../src/domena/sprzedaz-okresu.js';
import { wczytajRaporty } from '../src/moduly/raporty/konfiguracja.ts';
import { KANALY, PRODUKTY, KLIENCI, FIRMY_B2B, FIRMY_UE, ZAMOWIENIA, KAMPANIA, KOSZTY, WATKI_ALLEGRO } from './demo-dane-firma.mjs';

/** Kanały demo (sklep Woo, Allegro, Allegro Outlet) — etykiety widzi gość demo. */
export const KANALY_DEMO = Object.freeze(KANALY.map((k) => Object.freeze({ ...k })));
export { FIRMA as FIRMA_DEMO } from './demo-dane-firma.mjs';

/** Konfiguracja demo bez sekretów. `OMS_PASS` dopisuje ten, kto zakłada instancję (losowe). */
export const ENV_DEMO = Object.freeze({
  OMS_TRYB: 'proba',
  OMS_SPRZEDAWCA_NIP: '1234563218',
  OMS_RACHUNEK: '34109010140000000000000000',
  OMS_KANALY: JSON.stringify(KANALY_DEMO),
  OMS_RAPORTY_NAZWY_KANALOW: '{}',
  OMS_RAPORTY_PODLOGA_KOSZTOW: '2026-01',
  // PRZ-082: adres wystawcy proformy (domena/adres-sprzedawcy.js) — bez niego „Wystaw proformę” w demo odmawiało.
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
    a = (a + 0x6D2B79F5) >>> 0;
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
    .formatToParts(new Date(naiwna)).find((p) => p.type === 'timeZoneName').value;
  return naiwna - Number(/GMT([+-]\d+)/.exec(strefa)?.[1] ?? 0) * 3600000;
}

const PRODUKT = new Map(PRODUKTY.map((p) => [p.sku, p]));
const NAZWY_WYSYLKI = { dpd: 'Kurier DPD', inpost_paczkomat: 'Paczkomat InPost', odbior_osobisty: 'Odbiór osobisty w pracowni',
  allegro_paczkomat: 'Allegro Paczkomaty InPost', allegro_dpd: 'Allegro Kurier DPD', allegro_punkt: 'Allegro One Punkt',
  allegro_kurier: 'Allegro Kurier' };
const KOSZT_WYSYLKI_GR = { dpd: 1900, inpost_paczkomat: 1500, odbior_osobisty: 0, allegro_paczkomat: 1099,
  allegro_dpd: 1699, allegro_punkt: 899, allegro_kurier: 2499 };
// Kody Woo `cod`/`bacs` → kanoniczne klucze domena/metody-platnosci.js (filtr listy pokaże polską etykietę).
const PLATNOSC = { cod: 'pobranie', bacs: 'przelew' };

/** Linie koszyka z katalogu; rabat kontraktowy B2B w %, WDT = cena bez polskiego VAT-u. */
function pozycje(koszyk, { rabat = 0, wdt = false } = {}) {
  return koszyk.map(([sku, ilosc]) => {
    const p = PRODUKT.get(sku);
    if (!p) throw new Error(`DEMO_SKU: ${sku}`);
    let cena = Math.round(p.cena_gr * (100 - rabat) / 100);
    if (wdt) cena = nettoGr(cena);
    return { nazwa: p.nazwa, sku, ilosc, cena_brutto: zl(cena), cena_netto: zl(wdt ? cena : nettoGr(cena)),
      brutto_linii: zl(cena * ilosc), netto_linii: zl((wdt ? cena : nettoGr(cena)) * ilosc), vat: wdt ? 0 : 23 };
  });
}

/** Status docelowy z wieku zamówienia: stare są wysłane, świeże nowe albo w realizacji. */
function losujStatus(los, wiekDni) {
  const r = los.liczba();
  if (r < 0.04) return 'anulowane';
  if (wiekDni >= 7 && r < 0.11) return 'zwrot';
  // Limit wysyłki to 1–2 dni robocze (domena/termin-wysylki.js): niewysłane starsze zamówienia lądują
  // w „Po terminie”. Kilka takich ma być (funkcja widoczna), dwadzieścia wyglądałoby na firmę w kryzysie.
  if (wiekDni <= 1) return r < 0.5 ? 'nowe' : r < 0.72 ? 'indywidualne' : 'w_realizacji';
  if (wiekDni <= 3) return r < 0.09 ? 'nowe' : r < 0.2 ? 'indywidualne' : r < 0.4 ? 'w_realizacji' : 'wyslane';
  if (wiekDni <= 6) return r < 0.1 ? 'indywidualne' : r < 0.14 ? 'w_realizacji' : 'wyslane';
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
  db.prepare(`INSERT INTO przesylki (zamowienie_id, kurier, status, numer_listu, etykieta_reczna, nadana_recznie,
      status_kuriera, status_kuriera_at, status_kuriera_pobrany_at, utworzona_at, kolejnosc, zrodlo_numeru)
    VALUES (?,?, 'nadana', ?, 1, 1, ?, ?, ?, ?, 1, 'demo')`).run(
    zamowienieId, kurier, numer,
    !odebrana ? null : doreczona ? 'Przesyłka doręczona do odbiorcy' : 'Przesyłka w drodze',
    !odebrana ? null : iso(doreczona ? doreczonaMs : nadanaMs + 6 * 3600000), odebrana ? iso(terazMs) : null, iso(nadanaMs),
  );
}

let licznikFaktur = 0;
let licznikKorekt = 0;
// `ksef: false` — faktura jeszcze niewysłana do KSeF (PRZ-082: najnowsza w demo, „Wyślij do KSeF” działa na atrapie).
function faktura(db, zamowienieId, wystawionaMs, { wdt = false, ksef = true } = {}) {
  licznikFaktur += 1;
  const d = new Date(wystawionaMs);
  const numer = wdt ? `WDT/${licznikFaktur}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${d.getUTCFullYear()}`
    : `FV ${licznikFaktur}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${d.getUTCFullYear()}`;
  const uuid = `00000000-0000-4000-8000-${String(licznikFaktur).padStart(12, '0')}`;
  db.prepare(`INSERT INTO faktury (zamowienie_id, infakt_uuid, numer, ksef_status, utworzona_at, ksef_numer)
    VALUES (?,?,?,?,?,?)`).run(zamowienieId, uuid, numer, ksef ? 'wyslana' : null, iso(wystawionaMs),
    ksef ? `9991234563-${d.toISOString().slice(0, 10).replaceAll('-', '')}-DEMO${String(licznikFaktur).padStart(6, '0')}` : null);
}

function wiadomosc(db, zamowienieId, temat_id, adresat, temat, atMs) {
  zapiszWiadomosc(db, { zamowienieId, temat_id, adresat, temat, kto: 'demo', at: iso(atMs) });
}

function pusta(db) {
  for (const tabela of ['zamowienia', 'koszty', 'klienci', 'cele', 'kampanie']) {
    if (db.prepare(`SELECT COUNT(*) AS n FROM ${tabela}`).get().n > 0) throw new Error('DEMO_BAZA_NIEPUSTA');
  }
}

/**
 * Wypełnia PUSTĄ bazę (po migracjach) danymi demo. Zwraca liczniki — test i skrypt je pokazują.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ ziarno?: number, dzis: string, env?: Record<string, string> }} o  dzis = RRRR-MM-DD, ostatni dzień
 *   danych; env = konfiguracja instancji (z niej klasyfikacja kanałów raportu do granic historii)
 */
export function wygenerujDaneDemo(db, { ziarno = 72, dzis, env = ENV_DEMO }) {
  pusta(db);
  const los = losowanie(ziarno);
  licznikFaktur = 0;
  licznikKorekt = 0;
  // „Teraz” demo: 06:30 w Polsce dnia `dzis`. Reset bywa robiony o każdej porze — późniejsza
  // godzina dawałaby zamówienia i wiadomości z przyszłości dla porannego gościa.
  const koniecDnia = chwilaWarszawy(poczatekDnia(dzis), 6, 30);
  const liczniki = { zamowienia: 0, faktury: 0, korekty: 0, zwroty: 0, przesylki: 0, wiadomosci: 0, koszty: 0, statusy: {} };
  const sklepWoo = KANALY.find((k) => k.typ === 'woo').klucz;

  // Stali klienci: firmy B2B (jedna z rozliczeniem zbiorczym) i z UE (WDT).
  const firmy = [...FIRMY_B2B.map((f) => ({ ...f, kraj: 'PL' })), ...FIRMY_UE.map((f) => ({ ...f, rozliczenie_zbiorcze: false, rabat_procent: 0 }))];
  for (const [i, k] of firmy.entries()) {
    dopiszKlienta(db, {
      klucz: `demo-${i + 1}`, nazwa: k.nazwa, nip: k.nip, b2b: 1, rabat_procent: k.rabat_procent ?? 0,
      chce_fakture: 1, metoda_wysylki: 'dpd', koszt_dostawy_brutto: zl(KOSZT_WYSYLKI_GR.dpd), platnosc: 'przelew',
      termin_platnosci: '14', komentarz: 'Klient demonstracyjny — dane zmyślone.', aktywny: 1,
      rozliczenie_zbiorcze: k.rozliczenie_zbiorcze ? 1 : 0,
      ...(k.rozliczenie_zbiorcze ? { prog_darmowej_dostawy_gr: 50000, oplata_obslugi_gr: 0, oplata_kurierska_gr: KOSZT_WYSYLKI_GR.dpd } : {}),
      faktura_json: JSON.stringify({ company: k.nazwa, address_1: k.ulica, city: k.miasto, postcode: k.kod, country: k.kraj }),
      wysylka_json: JSON.stringify({ company: k.nazwa, address_1: k.ulica, city: k.miasto, postcode: k.kod, country: k.kraj }),
    }, iso(koniecDnia - 70 * DOBA));
  }

  // Zamówienia z pliku firmy, w kolejności złożenia. Moment = dzień wstecz + godzina zegara w Polsce.
  const zamowienia = ZAMOWIENIA
    .map((z) => ({ z, ms: chwilaWarszawy(poczatekDnia(dzis) - z.dzienWstecz * DOBA, z.godzina, z.minuta) }))
    .sort((a, b) => a.ms - b.ms);
  const momenty = zamowienia.map((w) => w.ms);
  if (momenty.at(-1) >= koniecDnia) throw new Error('DEMO_PRZYSZLOSC: zamówienie po „teraz” demo');

  const numery = Object.fromEntries(KANALY.map((k, n) => [k.klucz, k.typ === 'woo' ? 2400 : 0 + n * 100000]));
  let nrListu = 0, kandydaciZaleglosci = 0;
  const zamowieniaSklepu = [], loginy = Object.fromEntries(KANALY.map((k) => [k.klucz, []]));
  for (const [i, { z, ms: utworzoneMs }] of zamowienia.entries()) {
    const wiekDni = Math.floor((koniecDnia - utworzoneMs) / DOBA);
    const status = losujStatus(los, wiekDni);
    const kanal = z.kanal;
    const osobaZ = z.klient.osoba != null ? KLIENCI[z.klient.osoba] : null;
    const ue = z.klient.ue != null;
    const firma = z.klient.b2b != null ? { ...FIRMY_B2B[z.klient.b2b], kraj: 'PL' } : ue ? FIRMY_UE[z.klient.ue] : null;
    const klient = osobaZ ? { first_name: osobaZ.imie, last_name: osobaZ.nazwisko, email: osobaZ.email, phone: '' }
      : { first_name: '', last_name: '', company: firma.nazwa, email: `zamowienia.${i}@example.invalid`, phone: '' };
    const dostawa = osobaZ ? { first_name: osobaZ.imie, last_name: osobaZ.nazwisko, address_1: osobaZ.ulica,
      city: osobaZ.miasto, postcode: osobaZ.kod, country: 'PL' }
      : { first_name: '', last_name: '', company: firma.nazwa, address_1: firma.ulica, city: firma.miasto, postcode: firma.kod, country: firma.kraj };
    const metoda = z.wysylka, nazwaMetody = NAZWY_WYSYLKI[metoda], kosztDostawyGr = KOSZT_WYSYLKI_GR[metoda];
    const pobranie = ['cod', 'allegro_pobranie'].includes(z.platnosc);
    const poz = pozycje(z.pozycje, { rabat: firma && !ue ? firma.rabat_procent : 0, wdt: ue });
    const rabatKuponuGr = z.kupon ? KAMPANIA.rabat_gr : 0;
    const sumaGr = poz.reduce((s, p) => s + Math.round(Number(p.brutto_linii) * 100), 0) + kosztDostawyGr - rabatKuponuGr;
    const chceFakture = Boolean(firma) || los.szansa(0.15);
    const nip = firma ? firma.nip : chceFakture ? nipFikcyjny(5000 + i * 11) : null;
    const wplata = status !== 'nowe' && status !== 'anulowane' && !pobranie
      ? iso(Math.min(utworzoneMs + los.calk(1, 40) * 60000, koniecDnia - 60000))
      : status === 'nowe' && los.szansa(0.5) && !pobranie ? iso(Math.min(utworzoneMs + 5 * 60000, koniecDnia - 60000)) : null;
    // PRZ-076: co druga faktura krajowego B2B przelewem starsza niż 18 dni czeka na przelew — termin 14 dni minął,
    // więc Faktury pokazują „nieopłacone po terminie”. Wpłata wyżej i tak jest losowana: sekwencja `los` bez zmian.
    const kandydatZaleglosci = Boolean(firma) && !ue && ['przelew', 'bacs'].includes(z.platnosc) && wiekDni >= 18;
    const zalega = kandydatZaleglosci && (++kandydaciZaleglosci % 2 === 1);
    const oplacone = zalega ? null : wplata;

    let id;
    if (kanal === 'reczne') {
      const okres = firma && !ue ? przypiszDoOkresu({ db, nip, dataZlozenia: iso(utworzoneMs), hurt: false }) : null;
      id = utworzZamowienieReczne(db, {
        utworzone_at: iso(utworzoneMs), rok: new Date(utworzoneMs).getUTCFullYear(), klient, dostawa,
        metoda_wysylki: metoda, koszt_dostawy_brutto: zl(kosztDostawyGr), chce_fakture: chceFakture, nip,
        metoda_platnosci: PLATNOSC[z.platnosc] ?? z.platnosc, b2b: Boolean(firma), termin_platnosci: firma ? '14' : null,
        rabat_procent: firma && !ue ? firma.rabat_procent : 0, uwagi: z.uwagi ?? null,
      }, okres);
      for (const p of poz) {
        dodajPozycjeReczna(db, id, { nazwa: p.nazwa, sku: p.sku, ilosc: p.ilosc, cena_brutto: p.cena_brutto, brutto_linii: p.brutto_linii });
      }
      db.prepare('UPDATE zamowienia SET kwota_brutto = ? WHERE id = ?').run(zl(sumaGr), id);
      if (oplacone) dodajWplateReczna(db, id, { kwota: zl(sumaGr), data: oplacone.slice(0, 10), metoda: PLATNOSC[z.platnosc] ?? z.platnosc });
    } else {
      const woo = kanal === sklepWoo;
      const zrodloId = ++numery[kanal];
      const numer = woo ? String(zrodloId) : `${String(zrodloId).padStart(7, '0')}-${kanal}`;
      if (woo && status !== 'anulowane') zamowieniaSklepu.push({ zrodloId, dzien: iso(utworzoneMs).slice(0, 10), kwota: zl(sumaGr) });
      if (!woo) loginy[kanal].push(`${osobaZ.imie.toLowerCase().replace(/[^a-z]/g, '')}_${osobaZ.nazwisko.slice(0, 3).toLowerCase().replace(/[^a-z]/g, '')}${i}`);
      id = zapiszZamowienie(db, kanal, {
        zrodlo_id: zrodloId, numer, klient, dostawa,
        metoda_wysylki: metoda, metoda_wysylki_nazwa: nazwaMetody, pobranie, kwota_pobrania: pobranie ? zl(sumaGr) : null,
        punkt_odbioru: /paczkomat|punkt/.test(metoda) ? `GLI${String(i).padStart(2, '0')}M` : null,
        punkt_odbioru_opis: /paczkomat|punkt/.test(metoda) ? 'Punkt odbioru (demo), Ulica Przykładowa 5' : null,
        chce_fakture: chceFakture ? 1 : 0, nip, kwota_brutto: zl(sumaGr),
        koszt_dostawy_brutto: zl(kosztDostawyGr), koszt_dostawy_netto: zl(nettoGr(kosztDostawyGr)),
        status_woo: status === 'anulowane' ? 'cancelled' : status === 'wyslane' ? 'completed' : 'processing',
        metoda_platnosci: PLATNOSC[z.platnosc] ?? z.platnosc,
        indywidualne: status === 'indywidualne', oplacone_at: oplacone, anulowane: status === 'anulowane' ? 1 : 0,
        utworzone_at: iso(utworzoneMs), uwagi: z.uwagi ?? null,
        kupony: z.kupon ? [{ kod: z.kupon, rabat: zl(rabatKuponuGr) }] : [],
        atrybucja: woo ? { typ: 'utm', zrodlo: z.kupon ? 'facebook' : los.jeden(['google', 'facebook', '(direct)', 'pinterest']),
          medium: z.kupon ? 'paid_social' : 'organic', kampania: z.kupon ? z.kupon.toLowerCase() : null } : null,
        pozycje: poz,
      }, { demo: true });
    }
    liczniki.zamowienia += 1;

    // Fakty statusu i to, co z nich wynika: paczka, faktura, wiadomości, zwrot.
    const wRealizacji = ['w_realizacji', 'wyslane', 'zwrot'].includes(status) ? utworzoneMs + los.calk(2, 26) * 3600000 : null;
    const wyslaneMs = ['wyslane', 'zwrot'].includes(status) ? (wRealizacji ?? utworzoneMs) + los.calk(4, 40) * 3600000 : null;
    const wyslane = wyslaneMs && wyslaneMs < koniecDnia ? wyslaneMs : null;
    if (wRealizacji || wyslane) {
      zapiszFaktyStatusu(db, id, { w_realizacji_at: wRealizacji ? iso(Math.min(wRealizacji, koniecDnia - 3600000)) : null,
        wyslane_at: wyslane ? iso(wyslane) : null });
    }
    if (wyslane && metoda !== 'odbior_osobisty') {
      const kurier = metoda.includes('paczkomat') ? 'inpost' : metoda === 'allegro_punkt' ? 'allegro' : 'dpd';
      przesylka(db, id, { kurier, numer: numerListu(los, kurier, ++nrListu), nadanaMs: wyslane,
        doreczonaMs: wyslane + los.calk(18, 60) * 3600000, terazMs: koniecDnia });
      liczniki.przesylki += 1;
    } else if (status === 'w_realizacji' && wiekDni >= 1 && wiekDni <= 3 && metoda !== 'odbior_osobisty') {
      // Etykieta gotowa, kurier jeszcze nie odebrał — tylko świeże: starsza wisiałaby jako alarm „stoi bez ruchu”.
      const kurier = metoda.includes('paczkomat') ? 'inpost' : metoda === 'allegro_punkt' ? 'allegro' : 'dpd';
      przesylka(db, id, { kurier, numer: numerListu(los, kurier, ++nrListu), nadanaMs: Math.min(wRealizacji + 3600000, koniecDnia - 3600000),
        doreczonaMs: null, terazMs: koniecDnia });
      liczniki.przesylki += 1;
    }
    const zafakturowane = chceFakture && (wyslane || status === 'w_realizacji') && status !== 'anulowane';
    if (zafakturowane) {
      // PRZ-082: nie później niż 5 min przed „teraz” demo — „w realizacji” bywa liczone na jutro rano, a faktura z
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
      if (wyslane) { wiadomosc(db, id, 'faktura', klient.email, 'Zamówienie wysłane', wyslane + 600000); liczniki.wiadomosci += 1; }
      if (!oplacone && !pobranie && wiekDni >= 3) { wiadomosc(db, id, 'przypomnienie', klient.email, 'Przypomnienie o płatności', utworzoneMs + 2 * DOBA); liczniki.wiadomosci += 1; }
    }
    if (status === 'zwrot' && wyslane) {
      const p = poz[0];
      const dataZwrotu = iso(Math.min(wyslane + los.calk(5, 12) * DOBA, koniecDnia - DOBA)).slice(0, 10);
      const zw = dodajZwrot(db, id, { data: dataZwrotu, kwota: zl(Math.round(Number(p.cena_brutto) * 100)),
        powod: los.jeden(['Klosz pęknięty w transporcie', 'Odcień szkła inny niż na zdjęciu', 'Odstąpienie od umowy']),
        pozycje: [{ klucz_pozycji: p.sku, nazwa: p.nazwa, ilosc: 1, kwota: p.cena_brutto }] });
      if (los.szansa(0.6)) oznaczPieniadzeOddane(db, id, zw.id, iso(poczatekDnia(dataZwrotu) + 12 * 3600000));
      // PRZ-076: zwrot zafakturowanego zamówienia dostaje korektę (Faktury pokazują ją obok faktur). Bez
      // losowania — każde nowe wywołanie `los` przesunęłoby sekwencję i zmieniło całe demo.
      if (zafakturowane) {
        licznikKorekt += 1;
        const d = new Date(poczatekDnia(dataZwrotu));
        zarezerwujKorekte(db, id, zw.id, iso(poczatekDnia(dataZwrotu) + 13 * 3600000));
        zapiszKorekte(db, id, zw.id, { uuid: `00000000-0000-4000-9000-${String(licznikKorekt).padStart(12, '0')}`,
          numer: `${licznikKorekt}/KOR/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${d.getUTCFullYear()}` });
        liczniki.korekty += 1;
      }
      liczniki.zwroty += 1;
    }
    liczniki.statusy[status] = (liczniki.statusy[status] ?? 0) + 1;
  }

  uzupelnieniaPrz082(db, { dzis, env, koniecDnia, numery, kolejnyList: () => ++nrListu, liczniki });

  // Koszty (ręczne, bez KSeF) i dane miesięczne — trzy miesiące wstecz od `dzis`.
  const miesiace = [];
  for (let m = 2; m >= 0; m--) {
    const d = new Date(poczatekDnia(dzis)); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() - m);
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
      zapiszRecznyKoszt(db, { numerDokumentu: `DEMO/${miesiac}/${ki + 1}`, sprzedawcaNip: nipFikcyjny(7000 + ki * 13),
        sprzedawcaNazwa: sprzedawca, dataWystawienia: dataW, netto: zl(netto), vat: zl(Math.round(netto * 0.23)),
        brutto: zl(netto + Math.round(netto * 0.23)), waluta: 'PLN', kategoriaDokumentu: kategoria, typDokumentu: typ });
      liczniki.koszty += 1;
    }
    if (udzial === 1 && !biezacy) {
      zapiszDaneMiesiaca(db, miesiac, { zusSpoleczne: '650.00', zusZdrowotna: '432.54', zusFunduszPracy: '0.00',
        zusRazem: '1082.54', pit5: String(180 + mi * 40), vat7: String(700 + mi * 90), uwagi: 'DEMO — kwoty zmyślone.' });
    }
  }

  // PRZ-082 (właściciel 14.10): Cele bez danych — gość ich nie widzi (deploy/proba/atrapy/ekrany.mjs). Losowania, które tu
  // stały (11 × los.calk), zostają: bez nich kampania i reklamy niżej dostałyby inne liczby.
  for (let d = 20; d >= 0; d -= 2) los.calk(2, 6);

  // Kampania z kuponem z pliku firmy — 21 dni do `dzis`, z dziennymi danymi Meta i GA4.
  const odKampanii = iso(poczatekDnia(dzis) - 20 * DOBA).slice(0, 10);
  db.prepare('INSERT INTO kampanie (kod, nazwa, od_dnia, do_dnia, sklep, cel_uzyc) VALUES (?,?,?,?,?,?)')
    .run(KAMPANIA.kod, KAMPANIA.nazwa, odKampanii, iso(poczatekDnia(dzis) + 7 * DOBA).slice(0, 10), sklepWoo, 40);
  for (let d = 20; d >= 0; d--) {
    const dzien = iso(poczatekDnia(dzis) - d * DOBA).slice(0, 10);
    const wydatek = los.calk(1500, 4500);
    // PRZ-082: CPM ~16 zł i CTR 1,7–2,5% (Meta w handlu: 1–3%); do 14.10 CPM 3 zł i CTR 0,8%.
    const wyswietlenia = Math.round(wydatek / 1.6);
    const klikniecia = Math.round(wyswietlenia * (0.017 + (d % 5) * 0.002));
    zapiszMetaDzien(db, KAMPANIA.kod, { dzien, wydatek: zl(wydatek), wyswietlenia, zasieg: Math.round(wyswietlenia * 0.72),
      klikniecia, kliknieciaLinku: Math.round(klikniecia * 0.62) });
    zapiszGa4Dzien(db, KAMPANIA.kod, { dzien, sesje: los.calk(60, 160), uzytkownicy: los.calk(50, 130),
      sesjeMeta: los.calk(10, 40), odslonyPromo: los.calk(20, 80) });
  }

  // Reklamy: połączenie Meta (dwie kampanie) i GA4 (koszt Google Ads + transakcje = numery zamówień sklepu).
  // Identyfikatory kont są zmyślone; bez kluczy integracji czuwacz reklam ich nie odpytuje.
  const pobrano = iso(koniecDnia);
  const meta = zapiszPolaczenie(db, { typ: 'meta', kontoId: 'act_000000000001', kanal: sklepWoo, waluta: 'PLN', strefa: 'Europe/Warsaw' });
  const ga4 = zapiszPolaczenie(db, { typ: 'ga4', kontoId: 'properties/000000001', kanal: sklepWoo, waluta: 'PLN', strefa: 'Europe/Warsaw' });
  const KAMPANIE_META = [['000001', KAMPANIA.nazwa], ['000002', 'Remarketing — klosze i abażury']];
  const dniMeta = [], dniGa4 = [];
  for (let d = 30; d >= 0; d--) {
    const dzien = iso(poczatekDnia(dzis) - d * DOBA).slice(0, 10);
    for (const [[kampaniaId, nazwa], mnoznik] of [[KAMPANIE_META[0], d <= 20 ? 1 : 0], [KAMPANIE_META[1], 0.4]]) {
      if (!mnoznik) continue;
      const wydatek = Math.round(los.calk(3000, 6000) * mnoznik);
      // PRZ-082: CPM ~17 zł, CTR 1,6–2,4% — jak kampania wyżej.
      const wyswietlenia = Math.round(wydatek / 1.7);
      const klikniecia = Math.round(wyswietlenia * (0.016 + (d % 4) * 0.0025));
      dniMeta.push({ dzien, kampaniaId, nazwa, wydatek: zl(wydatek), klikniecia, wyswietlenia, kliknieciaLinku: Math.round(klikniecia * 0.6) });
    }
    const koszt = los.calk(1500, 4000);
    // PRZ-082: wyszukiwarka — CPC ~1,10 zł, CTR 4,5–5,7% (do 14.10: 0,55%).
    const klikniecia = Math.round(koszt / 110);
    dniGa4.push({ dzien, kampaniaId: '000003', nazwa: 'Google — lampy ręcznie robione', koszt: zl(koszt), klikniecia,
      wyswietlenia: Math.round(klikniecia / (0.045 + (d % 3) * 0.006)) });
  }
  zapiszDni(db, { typ: 'meta', polaczenieId: meta.id, wiersze: dniMeta, pobranoAt: pobrano });
  zapiszDni(db, { typ: 'ga4', polaczenieId: ga4.id, wiersze: dniGa4, pobranoAt: pobrano });
  zapiszTransakcje(db, { polaczenieId: ga4.id, pobranoAt: pobrano, wiersze: zamowieniaSklepu
    .filter((_, k) => k % 5 === 0).map((z) => ({ dzien: z.dzien, kampaniaId: '000003', transactionId: String(z.zrodloId), przychod: z.kwota })) });
  zapiszMetaKampanie(db, { polaczenieId: meta.id, pobranoAt: pobrano, kampanie: KAMPANIE_META.map(([id, nazwa]) => ({ id, nazwa,
    effectiveStatus: 'ACTIVE', budzetDzienny: '50.00', waluta: 'PLN' })) });
  for (const p of [meta, ga4]) zapiszStan(db, { polaczenieId: p.id, ostatniaProbaAt: pobrano, ostatniSukcesAt: pobrano });

  // PRZ-082 (właściciel 14.10): firmy spoza KSeF — Meta i Google nie mają polskiego NIP-u, ich faktur nie ma w KSeF
  // (domena/koszt-reczny.js). Na liście wyboru formularza i z fakturą za każdy zamknięty miesiąc: kwota = wydatek
  // z reklam demo wyżej, data = ostatni dzień miesiąca. Bieżący miesiąc bez faktury — jeszcze trwa.
  const FIRMY_POZA_KSEF = [['Facebook (Meta)', 'Meta Platforms Ireland Limited', dniMeta, 'wydatek'],
    ['Google Ads', 'Google Ireland Limited', dniGa4, 'koszt']];
  const wstawFirme = db.prepare(`INSERT OR IGNORE INTO firmy_reczne (nazwa, sprzedawca, kategoria, typ, dodana_at)
    VALUES (?, ?, 'Reklama', 'zmienny', ?)`);
  for (const [nazwa, sprzedawca, dni, pole] of FIRMY_POZA_KSEF) {
    wstawFirme.run(nazwa, sprzedawca, iso(koniecDnia - 70 * DOBA));
    const naMiesiac = new Map();
    for (const w of dni) naMiesiac.set(w.dzien.slice(0, 7), (naMiesiac.get(w.dzien.slice(0, 7)) ?? 0) + Math.round(Number(w[pole]) * 100));
    for (const [miesiac, gr] of naMiesiac) {
      if (miesiac >= dzis.slice(0, 7)) continue;
      const data = `${miesiac}-${String(dniMiesiaca(miesiac)).padStart(2, '0')}`;
      zapiszRecznyKoszt(db, { numerDokumentu: numerRecznego(nazwa, data), sprzedawcaNip: null, sprzedawcaNazwa: sprzedawca,
        dataWystawienia: data, netto: zl(gr), vat: zl(0), brutto: zl(gr), waluta: 'PLN', kategoriaDokumentu: 'Reklama', typDokumentu: 'zmienny' });
      liczniki.koszty += 1;
    }
  }

  // Wiadomości z Allegro: osiem wątków z kupującymi demo, część czeka na odpowiedź.
  const wstawWatek = db.prepare(`INSERT INTO allegro_watki (kanal, thread_id, interlocutor_login, last_message_date_time,
    typ, przeczytany, ostatnia_od_kupujacego, ostatnia_tresc, pobrany_at) VALUES (?,?,?,?,?,?,?,?,?)`);
  const wstawWiadomosc = db.prepare(`INSERT INTO allegro_wiadomosci (kanal, thread_id, message_id, od_kupujacego, tresc, utworzona_at)
    VALUES (?,?,?,?,?,?)`);
  for (const [w, { kanal, pytanie, odpowiedz, zalatwione }] of WATKI_ALLEGRO.entries()) {
    const watek = `demo-watek-${w + 1}`;
    const pytanieMs = koniecDnia - (w * 2 + 1) * 3 * 3600000;
    const ostatniaMs = odpowiedz ? pytanieMs + 2 * 3600000 : pytanieMs;
    const kupujacy = loginy[kanal]?.length ? loginy[kanal][(loginy[kanal].length - 1 - w) % loginy[kanal].length] : `kupujacy_${w}`;
    wstawWatek.run(kanal, watek, kupujacy, iso(ostatniaMs), 'BUYER_SELLER', odpowiedz || zalatwione ? 1 : 0, odpowiedz ? 0 : 1, odpowiedz ?? pytanie, pobrano);
    // PRZ-083: „Załatwione” jak z przycisku w Wiadomościach — do daty ostatniej wiadomości (nowa otworzy wątek sama).
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
 * PRZ-082 — uzupełnienia demo z listy właściciela (14.10). Osobne zamówienia zamiast przestawiania pętli w
 * wygenerujDaneDemo: każde nowe wywołanie `los` zmieniłoby całe demo. Każda pozycja ma test w
 * tests/instalacja/demo-dane-prz082.test.js.
 *  • faktura przelewem z terminem za kilka dni (B2B, 14 dni), • najnowsza faktura niewysłana do KSeF (wystawiona
 *    dziś — alarm „nie została wysłana” dotyczy dokumentów sprzed dzisiejszego dnia), • utworzone etykiety DHL,
 *    ORLEN Paczka i Allegro One, • jedna paczka bez ruchu, • historia podjazdów, • dwie proformy na każdy miesiąc.
 */
function uzupelnieniaPrz082(db, { dzis, env, koniecDnia, numery, kolejnyList, liczniki }) {
  const chwila = (dniWstecz, h, m) => chwilaWarszawy(poczatekDnia(dzis) - dniWstecz * DOBA, h, m);
  const sklepWoo = KANALY.find((k) => k.typ === 'woo').klucz;
  let nrMaila = 0;
  const dodaj = ({ kanal, osoba, b2b, koszyk, wysylka, nazwaWysylki = NAZWY_WYSYLKI[wysylka], platnosc, nip = null, utworzoneMs, oplaconeMs = null }) => {
    const osobaZ = osoba != null ? KLIENCI[osoba] : null;
    const firma = b2b != null ? FIRMY_B2B[b2b] : null;
    const klient = osobaZ ? { first_name: osobaZ.imie, last_name: osobaZ.nazwisko, email: osobaZ.email, phone: '' }
      : { first_name: '', last_name: '', company: firma.nazwa, email: `zamowienia.d${++nrMaila}@example.invalid`, phone: '' };
    const dostawa = osobaZ ? { first_name: osobaZ.imie, last_name: osobaZ.nazwisko, address_1: osobaZ.ulica, city: osobaZ.miasto, postcode: osobaZ.kod, country: 'PL' }
      : { first_name: '', last_name: '', company: firma.nazwa, address_1: firma.ulica, city: firma.miasto, postcode: firma.kod, country: 'PL' };
    const poz = pozycje(koszyk, { rabat: firma?.rabat_procent ?? 0 });
    const kosztGr = KOSZT_WYSYLKI_GR[wysylka];
    const sumaGr = poz.reduce((s, x) => s + Math.round(Number(x.brutto_linii) * 100), 0) + kosztGr;
    const nipZamowienia = firma ? firma.nip : nip;
    const metodaPlatnosci = PLATNOSC[platnosc] ?? platnosc;
    let id;
    if (kanal === 'reczne') {
      const okres = przypiszDoOkresu({ db, nip: nipZamowienia, dataZlozenia: iso(utworzoneMs), hurt: false });
      id = utworzZamowienieReczne(db, { utworzone_at: iso(utworzoneMs), rok: new Date(utworzoneMs).getUTCFullYear(), klient, dostawa,
        metoda_wysylki: wysylka, koszt_dostawy_brutto: zl(kosztGr), chce_fakture: true, nip: nipZamowienia,
        metoda_platnosci: metodaPlatnosci, b2b: true, termin_platnosci: '14', rabat_procent: firma.rabat_procent, uwagi: null }, okres);
      for (const x of poz) dodajPozycjeReczna(db, id, { nazwa: x.nazwa, sku: x.sku, ilosc: x.ilosc, cena_brutto: x.cena_brutto, brutto_linii: x.brutto_linii });
      db.prepare('UPDATE zamowienia SET kwota_brutto = ? WHERE id = ?').run(zl(sumaGr), id);
      if (oplaconeMs) dodajWplateReczna(db, id, { kwota: zl(sumaGr), data: iso(oplaconeMs).slice(0, 10), metoda: metodaPlatnosci });
    } else {
      const woo = kanal === sklepWoo;
      const zrodloId = ++numery[kanal];
      const punkt = /paczkomat|punkt/.test(wysylka);
      id = zapiszZamowienie(db, kanal, {
        zrodlo_id: zrodloId, numer: woo ? String(zrodloId) : `${String(zrodloId).padStart(7, '0')}-${kanal}`, klient, dostawa,
        metoda_wysylki: wysylka, metoda_wysylki_nazwa: nazwaWysylki, pobranie: false, kwota_pobrania: null,
        punkt_odbioru: punkt ? `GLI9${String(zrodloId % 100).padStart(2, '0')}M` : null,
        punkt_odbioru_opis: punkt ? 'Punkt odbioru (demo), Ulica Przykładowa 5' : null,
        chce_fakture: nipZamowienia ? 1 : 0, nip: nipZamowienia, kwota_brutto: zl(sumaGr),
        koszt_dostawy_brutto: zl(kosztGr), koszt_dostawy_netto: zl(nettoGr(kosztGr)), status_woo: 'processing',
        metoda_platnosci: metodaPlatnosci, indywidualne: false, oplacone_at: oplaconeMs ? iso(oplaconeMs) : null, anulowane: 0,
        utworzone_at: iso(utworzoneMs), uwagi: null, kupony: [],
        atrybucja: woo ? { typ: 'utm', zrodlo: 'google', medium: 'organic', kampania: null } : null, pozycje: poz,
      }, { demo: true });
    }
    wiadomosc(db, id, 'potwierdzenie', klient.email, 'Potwierdzenie zamówienia', utworzoneMs + 600000);
    liczniki.zamowienia += 1; liczniki.wiadomosci += 1;
    return { id, klient };
  };
  const status = (s) => { liczniki.statusy[s] = (liczniki.statusy[s] ?? 0) + 1; };
  const wyslij = (z, { kurier, wRealizacjiMs, wyslaneMs, doreczonaMs }) => {
    zapiszFaktyStatusu(db, z.id, { w_realizacji_at: iso(wRealizacjiMs), wyslane_at: iso(wyslaneMs) });
    przesylka(db, z.id, { kurier, numer: numerListu({ calk: () => 10000000 + z.id }, kurier, kolejnyList()), nadanaMs: wyslaneMs, doreczonaMs, terazMs: koniecDnia });
    wiadomosc(db, z.id, 'faktura', z.klient.email, 'Zamówienie wysłane', wyslaneMs + 600000);
    liczniki.przesylki += 1; liczniki.wiadomosci += 1; status('wyslane');
  };

  // Faktura z terminem za kilka dni: B2B przelewem, termin 14 dni, faktura sprzed 8 dni → termin za ~6 dni, bez wpłaty.
  const hotel = dodaj({ kanal: 'reczne', b2b: 1, koszyk: [['LMP-WIS-001', 4], ['LMP-ABA-001', 4]], wysylka: 'dpd', platnosc: 'bacs', utworzoneMs: chwila(9, 10, 15) });
  wyslij(hotel, { kurier: 'dpd', wRealizacjiMs: chwila(9, 13, 20), wyslaneMs: chwila(8, 11, 0), doreczonaMs: chwila(7, 12, 40) });
  faktura(db, hotel.id, chwila(8, 11, 30));
  liczniki.faktury += 1;

  // Jedna paczka bez ruchu: DPD „w drodze” od 9 dni, ostatnie zdarzenie kuriera tego samego dnia.
  const stoi = dodaj({ kanal: sklepWoo, osoba: 7, koszyk: [['LMP-STO-002', 1]], wysylka: 'dpd', platnosc: 'bacs',
    utworzoneMs: chwila(10, 13, 5), oplaconeMs: chwila(10, 13, 15) });
  wyslij(stoi, { kurier: 'dpd', wRealizacjiMs: chwila(10, 15, 0), wyslaneMs: chwila(9, 12, 0), doreczonaMs: koniecDnia + 30 * DOBA });

  // Utworzone etykiety Allegro (kurier jeszcze nie odebrał): przewoźnika rozpoznaje nazwa usługi (domena/przewoznik-przesylki.js).
  const ETYKIETY = [['allegro_kurier', 'Allegro Kurier DHL', 10, 'LMP-POD-001'],
    ['allegro_punkt', 'Allegro Automat ORLEN Paczka', 11, 'LMP-NOC-001'], ['allegro_punkt', 'Allegro One Box, One Kurier', 12, 'LMP-KIN-003']];
  for (const [i, [wysylka, nazwaWysylki, osoba, sku]] of ETYKIETY.entries()) {
    const z = dodaj({ kanal: 'allegro', osoba, koszyk: [[sku, 1]], wysylka, nazwaWysylki, platnosc: 'allegro',
      utworzoneMs: chwila(1, 16 + i, 10), oplaconeMs: chwila(1, 16 + i, 12) });
    zapiszFaktyStatusu(db, z.id, { w_realizacji_at: iso(chwila(1, 18 + i, 0)), wyslane_at: null });
    przesylka(db, z.id, { kurier: 'allegro', numer: numerListu({ calk: () => 20000000 + z.id }, 'allegro', kolejnyList()),
      nadanaMs: chwila(1, 18 + i, 30), doreczonaMs: null, terazMs: koniecDnia });
    liczniki.przesylki += 1; status('w_realizacji');
  }

  // Najnowsza faktura — wystawiona dziś rano, jeszcze nie w KSeF.
  const swieza = dodaj({ kanal: sklepWoo, osoba: 5, nip: nipFikcyjny(9100), koszyk: [['LMP-KIN-001', 2]],
    wysylka: 'dpd', platnosc: 'bacs', utworzoneMs: chwila(1, 21, 40), oplaconeMs: chwila(1, 21, 52) });
  zapiszFaktyStatusu(db, swieza.id, { w_realizacji_at: iso(chwila(0, 5, 50)), wyslane_at: null });
  faktura(db, swieza.id, koniecDnia - 2 * 60000, { ksef: false });
  liczniki.faktury += 1; status('w_realizacji');

  // Historia podjazdów: cztery ostatnie dni z paczkami DPD z Allegro — trzy potwierdzone, najstarszy odrzucony.
  const paczki = db.prepare(`SELECT p.id, p.numer_listu, p.utworzona_at FROM przesylki p JOIN zamowienia z ON z.id = p.zamowienie_id
    WHERE z.sklep = 'allegro' AND p.kurier = 'dpd' AND p.status_kuriera IS NOT NULL ORDER BY p.utworzona_at DESC`).all();
  const dni = new Map();
  for (const x of paczki) {
    const dzien = new Date(x.utworzona_at).toLocaleDateString('sv-SE', { timeZone: 'Europe/Warsaw' });
    if (!dni.has(dzien) && dni.size === 4) continue;
    dni.set(dzien, [...(dni.get(dzien) ?? []), x]);
  }
  const adres = { name: 'Pracownia Półcień (demo)', street: 'Ulica Przykładowa 1', postalCode: '44-100', city: 'Gliwice',
    countryCode: 'PL', email: 'pracownia@example.invalid', phone: '' };
  const wstawPodglad = db.prepare('INSERT INTO podjazdy_podglady (id, kto, snapshot_json, wygasa_at, utworzony_at) VALUES (?,?,?,?,?)');
  const wstawPodjazd = db.prepare(`INSERT INTO podjazdy (podglad_id, grupa_id, command_id, kanal, przewoznik, adres_json, termin_json, stan,
      pickup_id, carrier_pickup_id, pickup_carrier, kto, utworzony_at, ostatnia_proba_at, blad_opis) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const dopnij = db.prepare('INSERT INTO podjazdy_przesylki (podjazd_id, przesylka_id, shipment_id, numer_listu, aktywna_rezerwacja) VALUES (?,?,?,?,0)');
  for (const [n, [dzien, lista]] of [...dni].reverse().entries()) {
    const at = iso(chwilaWarszawy(poczatekDnia(dzien), 8, 40));
    const odrzucony = n === 0;
    const podglad = `demo-podglad-${n + 1}`;
    wstawPodglad.run(podglad, 'demo', JSON.stringify({ data: dzien, adres, grupy: [] }), at, at);
    const info = wstawPodjazd.run(podglad, 'allegro|demo-dpd', `00000000-0000-4000-a000-${String(n + 1).padStart(12, '0')}`, 'allegro', 'DPD',
      JSON.stringify(adres), JSON.stringify({ date: dzien, minTime: '12:00', maxTime: '16:00' }), odrzucony ? 'odrzucony' : 'potwierdzony',
      odrzucony ? null : `DEMO-ODBIOR-${n + 1}`, odrzucony ? null : `0000${String(n + 1).padStart(8, '0')}`, odrzucony ? null : 'DPD',
      'demo', at, at, odrzucony ? 'Kurier nie ma wolnych terminów odbioru w wybranym dniu (demo).' : null);
    for (const x of lista) dopnij.run(Number(info.lastInsertRowid), x.id, `demo-shipment-${x.id}`, x.numer_listu);
  }

  // Proformy: dwie na każdy miesiąc demo (miesiąc po polsku, jak numer proformy) — najpierw zamówienia ręczne B2B,
  // potem przelewem. Wystawia je PRAWDZIWA usługa (numer z serii, PDF w OMS_PROFORMY_KATALOG — przycisk „PDF” działa),
  // z zegarem ustawionym na 5 min po złożeniu zamówienia. Bez katalogu (sam generator na pustym env) — wiersze bez pliku.
  const miesiacPl = (ms) => new Date(ms).toLocaleDateString('sv-SE', { timeZone: 'Europe/Warsaw' }).slice(0, 7);
  const kandydaci = db.prepare(`SELECT id, kwota_brutto, utworzone_at FROM zamowienia WHERE anulowane = 0
    ORDER BY (sklep = 'reczne') DESC, (metoda_platnosci = 'przelew') DESC, utworzone_at`).all();
  let zegar = koniecDnia;
  const usluga = env?.OMS_PROFORMY_KATALOG?.trim() ? createProforma({ db, teraz: () => new Date(zegar),
    config: (({ proforma, nadawca }) => ({ proforma, nadawca }))(wczytajFaktury(env)) }) : null;
  const wystawione = new Map();
  for (const z of kandydaci) {
    const ms = Date.parse(z.utworzone_at) + 5 * 60000;
    const m = miesiacPl(Date.parse(z.utworzone_at));
    if (miesiacPl(ms) !== m || ms >= koniecDnia || (wystawione.get(m) ?? 0) >= 2) continue;
    zegar = ms;
    if (usluga) {
      // Usługa odmawia zamówieniu, któremu proforma by skłamała (np. kupon: suma pozycji ≠ kwota) — bez zużycia
      // numeru z serii (services/proforma.js, faza 2 przed 4). Wtedy bierzemy następnego kandydata z miesiąca.
      try { usluga.wystaw(z.id); } catch (e) { if (e?.dlaOperatora) continue; throw e; }
    } else {
      zapiszProforme(db, z.id, { kwotaBrutto: z.kwota_brutto, rok: Number(m.slice(0, 4)), miesiac: Number(m.slice(5, 7)), utworzonaAt: iso(ms) });
    }
    wystawione.set(m, (wystawione.get(m) ?? 0) + 1);
  }
}

function opcjeCli(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!['--baza', '--ziarno', '--dzis'].includes(argv[i]) || argv[i + 1] === undefined) {
      throw new Error('Użycie: --baza ŚCIEŻKA_BEZWZGLĘDNA [--ziarno N] [--dzis RRRR-MM-DD]');
    }
    o[argv[i].slice(2)] = argv[i + 1];
  }
  if (!o.baza || !path.isAbsolute(o.baza)) throw new Error('DEMO_BAZA: wymagana ścieżka bezwzględna');
  const ziarno = o.ziarno === undefined ? 72 : Number(o.ziarno);
  if (!Number.isInteger(ziarno) || ziarno < 0) throw new Error('DEMO_ZIARNO: liczba całkowita ≥ 0');
  const dzis = o.dzis ?? new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Warsaw' });
  poczatekDnia(dzis);
  return { baza: path.resolve(o.baza), ziarno, dzis };
}

/** Tworzy NOWY plik bazy z demo. Istniejący plik (albo jego -wal/-shm) = odmowa, bajty nietknięte. */
// Typowy rozmiar opakowania wzoru (szerokość × wysokość w mm) i czy mieści się w paczkomacie.
const WYMIARY_KATEGORII = { 'Lampy stołowe': [300, 450, 'tak'], 'Lampy wiszące': [450, 400, 'nie'], 'Lampy podłogowe': [500, 1600, 'nie'],
  Kinkiety: [250, 300, 'tak'], 'Lampki nocne': [180, 250, 'tak'], 'Abażury i klosze': [320, 280, 'tak'], Akcesoria: [120, 160, 'tak'] };

// Oferty outletu bez wzoru — żeby ekran „Do powiązania” w Magazynie też miał treść.
const OUTLET_NIEPOWIAZANY = new Set(['LMP-NOC-002-OUT', 'LMP-ABA-004-OUT']);

/**
 * PRZ-076: lustro magazynu z katalogu demo (scripts/demo-dane-katalog.mjs). Idzie PRAWDZIWYM odswiezMagazyn —
 * tą samą drogą co „Synchronizuj” — potem wzory z produktów sklepu i oferty Allegro przypięte po SKU (-OUT → bazowe).
 */
async function wypelnijMagazyn(db, { dzis }) {
  const { odswiezMagazyn } = await import('../src/moduly/magazyn/services/magazyn-sync.js');
  const { utworzWzoryZNiepowiazanych, niepowiazaneOfertyAllegro, powiazOfertyHurtem, zapiszWzor } = await import('../src/oms/db/magazyn.js');
  const { klienciKataloguDemo } = await import('./demo-dane-katalog.mjs');
  const { sklepy, allegro, kanalySklepow, kanalyAllegro } = klienciKataloguDemo();
  const teraz = () => `${dzis}T04:00:00.000Z`;
  const przebieg = await odswiezMagazyn({ db, sklepy, allegro, teraz, kanalySklepow, kanalyAllegro, log: () => {} });
  const bledy = przebieg.kanaly.filter((k) => k.blad);
  if (bledy.length) throw new Error(`DEMO_MAGAZYN: ${bledy.map((k) => `${k.kanal}: ${k.blad}`).join('; ')}`);
  const wzory = utworzWzoryZNiepowiazanych(db, { teraz, kanalySklepow });
  // Wzór powstaje bez SKU (nadanie SKU to w Magazynie osobny krok) — demo dostaje SKU katalogu, jak firma po nadaniu.
  const poSku = new Map(db.prepare(`SELECT wzor_id, sku_sklepu FROM produkty_sklepowe
    WHERE kanal IN (${kanalySklepow.map(() => '?').join(',')}) AND wzor_id IS NOT NULL AND sku_sklepu IS NOT NULL`)
    .all(...kanalySklepow).map((p) => [p.sku_sklepu, p.wzor_id]));
  for (const [sku, wzorId] of poSku) zapiszWzor(db, wzorId, { sku }, { at: teraz() });
  // Firma po porządkach: wymiary i paczkomat uzupełnione, poza kilkoma wzorami — ekran braków ma co pokazać
  // (0/30 kompletnych wyglądałoby na magazyn, którym nikt się nie zajmuje).
  const wzoryDemo = db.prepare('SELECT id, kategoria_glowna FROM wzory ORDER BY id').all();
  for (const [i, w] of wzoryDemo.entries()) {
    const [szer, wys, paczkomat] = WYMIARY_KATEGORII[w.kategoria_glowna] ?? [300, 300, 'tak'];
    const bezWymiarow = i >= wzoryDemo.length - 3;
    const bezPaczkomatu = i < 2;
    zapiszWzor(db, w.id, {
      ...(bezWymiarow ? {} : { szerokosc_mm: szer + (i % 4) * 20, wysokosc_mm: wys + (i % 3) * 30 }),
      ...(bezPaczkomatu ? {} : { paczkomat }),
    }, { at: teraz() });
  }
  const pary = niepowiazaneOfertyAllegro(db, kanalyAllegro)
    .filter((o) => !OUTLET_NIEPOWIAZANY.has(o.sku_sklepu))
    .map((o) => ({ produktId: o.id, wzorId: poSku.get(String(o.sku_sklepu).replace(/-OUT$/, '')) }))
    .filter((p) => p.wzorId);
  const oferty = powiazOfertyHurtem(db, pary, kanalyAllegro);
  return { produkty: przebieg.kanaly.reduce((s, k) => s + k.zapisane, 0), wzory: wzory.utworzone, powiazaneOferty: oferty.powiazane.length };
}

export async function utworzBazeDemo({ baza, ziarno = 72, dzis, env = ENV_DEMO }) {
  if ([baza, `${baza}-wal`, `${baza}-shm`].some((p) => fs.existsSync(p))) throw new Error('DEMO_ODMOWA_NADPISANIA');
  const { openOmsDb } = await import('../src/oms/db/db.ts');
  const { modulyDla } = await import('../src/moduly/lista.ts');
  fs.mkdirSync(path.dirname(baza), { recursive: true });
  const db = openOmsDb(baza, { moduly: modulyDla(env) });
  // Kilka tysięcy małych zatwierdzeń: na dysku NAS-a każde z fsync trwało łącznie >4 min (laptop 2 s).
  // Baza demo jest jednorazowa — przy awarii w połowie i tak jest kasowana niżej.
  db.exec('PRAGMA synchronous = OFF');
  try {
    const wynik = wygenerujDaneDemo(db, { ziarno, dzis, env });
    wynik.magazyn = await wypelnijMagazyn(db, { dzis });
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
