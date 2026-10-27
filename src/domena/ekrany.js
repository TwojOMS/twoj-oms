// JEDNA AUTORYTATYWNA LISTA EKRANOW PANELU (spec 2026-09-12).
//
// Karmi trzy rzeczy: straznika (kto gdzie wchodzi), menu boczne i pasek ikon. Do tego dnia
// lista stala w DWOCH miejscach — `STRONY` w domain/menu-stron.js i recznie pisany pasek
// ikon w layout-oms.ejs — i JUZ SIE ROZJECHALY: menu mialo „Stali klienci" bez „Wiadomosci",
// pasek odwrotnie. Dopoki to byla nawigacja, byla to kosmetyka. Przy uprawnieniach ekran
// pominiety na liscie jest EKRANEM BEZ PTASZKA, czyli albo cicha dziura, albo martwy
// przycisk — wiec lista musi byc jedna.
//
// ⚠️ TEN MODUL NIE DOTYKA ANI BAZY, ANI ZADANIA. Czysta funkcja adresu — dzieki temu test
// kompletnosci tras moze ja wolac na surowych wzorcach Fastify (`/zamowienia/:id/faktura`)
// tak samo, jak straznik wola ja na prawdziwym adresie (`/zamowienia/12/faktura`).

import { czyTrasaOtwarta } from '../core/bezpieczenstwo/logowanie-wspolne.js';
import { POZYCJE_USTAWIEN, podmenuUstawien } from './podmenu-ustawien.js';

// ⚠️⚠️ DLACZEGO `/zamowienia` ROZPADA SIE NA CZTERY ZAKRESY.
// Jeden stary klucz `dokumenty-zamowienia` obejmowal razem faktury, zwroty, proformy i
// techniczna kolejke druku. Produkcja ma wystawiac FV i obslugiwac zwroty/korekty, ale nie
// dostaje przez to proform ani ludzkiego wejscia do kolejki. Trzy listy ponizej rozdzielaja
// te kompetencje bez zmiany zachowania samych operacji.
//
// `[^/]+` zamiast `\d+` jest CELOWE: ten sam wzorzec ma pasowac i do `/zamowienia/12/faktura`,
// i do `/zamowienia/:id/faktura` wyliczonego z instancji Fastify przez test kompletnosci.
// Kolejnosc ma znaczenie — `faktury-hurtem` musi paść PRZED wzorcem z `[^/]+`, bo inaczej
// zostalby wziety za identyfikator zamowienia.
const WZORCE_FAKTUR_ZAMOWIENIA = [
  /^\/zamowienia\/faktury-hurtem(\/|$)/,
  /^\/zamowienia\/[^/]+\/faktura(\/|$)/,
  /^\/zamowienia\/[^/]+\/faktura-allegro$/,
  // ⚠️⚠️ DZIURA Z RECENZJI (12.09.2026): `/zamowienia/:id/dane/faktura` nie lapal sie na
  // wzorzec wyzej, bo ten wymaga „faktura" jako PIERWSZEGO segmentu po identyfikatorze —
  // trasa spadala do prefiksu `/zamowienia` i ladowala na ekranie „zamowienia". Rola
  // Produkcja mogla wiec przez ten formularz zmienic NIP nabywcy, a `rabatKontraktowy`
  // wywolywany zaraz po zapisie NIP-u umial przy okazji zmienic `rabat_procent` calego
  // zamowienia (src/oms/web/routes/zamowienia.js, `zapisDanych('faktura', ...)`).
  //
  // Dlatego cala galaz `/zamowienia/<id>/dane/` nalezy tu DOMYSLNIE, a wyjatki wysylkowe
  // sa wymienione JAWNIE zaraz ponizej. Kierunek jest celowy: pomylka „za wasko" (nowa
  // trasa `/dane/...` przypadkiem trafia do dokumentow, choc dotyczy tylko wysylki) da
  // operatorowi bez dostepu powod, zeby to zglosic — widac ja od razu. Pomylka „za szeroko"
  // (nowa trasa `/dane/...` zostaje przy zamowieniach, a dotyka faktury albo ceny) nie
  // zostawia sladu: pakowacz z rola Produkcja zmienia NIP i rabat, i nikt sie nie dowiaduje.
  // Dlatego trasa `/dane/cokolwiek` dopisana za pol roku ma domyslnie wpasc do dokumentow —
  // wyjatek trzeba dopisac SWIADOMIE, a nie dostac go za darmo.
  /^\/zamowienia\/[^/]+\/dane\/(?!wysylka$|kopiuj-do-wysylki$).+/,
];

const WZORCE_ZWROTOW_ZAMOWIENIA = [
  /^\/zamowienia\/[^/]+\/zwrot(\/|$)/,
  /^\/zamowienia\/[^/]+\/zwroty(\/|$)/,
];

const WZORCE_POZOSTALYCH_DOKUMENTOW_ZAMOWIENIA = [
  /^\/zamowienia\/[^/]+\/proforma$/,
  /^\/proformy(\/|$)/,
  /^\/kolejka-druku-faktur(\/|$)/,
];

/**
 * ⚠️ `dokladne` obsluguje ekran zamowien: lista stoi pod „/", a „/" jako PREFIKS pasowalby
 * do kazdego adresu w panelu. Ta sama pulapka, ktora domain/menu-stron.js rozwiazuje polem
 * `sekcja` — tu jest jedno pole wiecej, bo lista sluzy takze straznikowi.
 */
export const EKRANY = [
  {
    klucz: 'zamowienia',
    etykieta: 'Zamówienia',
    href: '/',
    nawigacja: { dzial: 'sprzedaz', grupa: 'obsluga', kolejnosc: 10 },
    dokladne: ['/'],
    // `/zamowienia/specyfikacje.pdf` wpada tu SWIADOMIE, mimo ze brzmi jak dokument:
    // specyfikacja to kartka wkladana do KAZDEJ paczki (pdf/specyfikacja-pdf.js), bez VAT-u
    // i bez numeru faktury. Odciecie jej Produkcji zatrzymaloby pakowanie.
    prefiksy: ['/zamowienia', '/ostrzezenia', '/kolejka-druku'],
  },
  {
    klucz: 'faktury-zamowienia', etykieta: 'Faktury zamówień', href: null, prefiksy: [],
    nawigacja: { dzial: 'sprzedaz', grupa: 'obsluga', kolejnosc: 15 },
  },
  {
    klucz: 'zwroty-zamowienia', etykieta: 'Obsługa zwrotu i korekty', href: null, prefiksy: [],
    nawigacja: { dzial: 'sprzedaz', grupa: 'obsluga', kolejnosc: 15 },
  },
  {
    klucz: 'pozostale-dokumenty-zamowienia',
    etykieta: 'Pozostałe dokumenty zamówień',
    href: null,
    prefiksy: [],
    nawigacja: { dzial: 'sprzedaz', grupa: 'obsluga', kolejnosc: 15 },
  },
  {
    klucz: 'przesylki', etykieta: 'Przesyłki', href: '/przesylki', prefiksy: ['/przesylki'],
    nawigacja: { dzial: 'sprzedaz', grupa: 'obsluga', kolejnosc: 20 },
  },
  {
    klucz: 'okresy', etykieta: 'Okresy rozliczeniowe', href: '/okresy', prefiksy: ['/okresy'],
    // PRZ-102.03 (wariant C, właściciel 20.10): Rozliczenia, Stali klienci i Wiadomości to grupa „Klienci” pod
    // „Obsługą zamówień”; analizy (`analizy-cele`) wyszły z menu bocznego do górnego paska.
    nawigacja: { dzial: 'sprzedaz', grupa: 'klienci', kolejnosc: 60, etykieta: 'Rozliczenia' },
  },
  {
    klucz: 'faktury', etykieta: 'Faktury', href: '/faktury', prefiksy: ['/faktury'],
    nawigacja: { dzial: 'sprzedaz', grupa: 'obsluga', kolejnosc: 30 },
  },
  {
    klucz: 'koszty', etykieta: 'Koszty', href: '/koszty', prefiksy: ['/koszty'],
    nawigacja: { dzial: 'analizy-cele', grupa: 'analizy-cele', kolejnosc: 40 },
  },
  {
    klucz: 'raporty', etykieta: 'Raporty', href: '/raporty', prefiksy: ['/raporty'],
    nawigacja: { dzial: 'analizy-cele', grupa: 'analizy-cele', kolejnosc: 10 },
  },
  {
    klucz: 'statystyki', etykieta: 'Statystyki', href: '/statystyki', prefiksy: ['/statystyki'],
    nawigacja: { dzial: 'analizy-cele', grupa: 'analizy-cele', kolejnosc: 20 },
  },
  {
    klucz: 'kampania', etykieta: 'Reklamy', href: '/kampania', prefiksy: ['/kampania'],
    nawigacja: { dzial: 'analizy-cele', grupa: 'analizy-cele', kolejnosc: 30 },
  },
  // Cele i zadania okresowe (spec 2026-09-13). Trafia AUTOMATYCZNIE do rol `administrator`
  // (lista '*') i `sprzedaz` (filtr odrzuca tylko `finanse` i `ustawienia`), a NIE trafia
  // do `produkcja`, ktora ma jawna liste zakresow operacyjnych. To jest wlasciwy rozklad: grafik
  // pracuje na roli Sprzedaz i dostaje ekran bez zadnej dodatkowej zmiany, a pakowacz
  // nie oglada celow sprzedazowych wlascicieli firmy.
  {
    klucz: 'cele', etykieta: 'Cele', href: '/cele', prefiksy: ['/cele'],
    nawigacja: { dzial: 'analizy-cele', grupa: 'analizy-cele', kolejnosc: 60 },
  },
  {
    klucz: 'finanse', etykieta: 'Finanse', href: '/finanse', prefiksy: ['/finanse'],
    nawigacja: { dzial: 'analizy-cele', grupa: 'analizy-cele', kolejnosc: 50 },
  },
  {
    klucz: 'magazyn', etykieta: 'Magazyn', href: '/magazyn', prefiksy: ['/magazyn'],
    nawigacja: { dzial: 'magazyn', grupa: 'magazyn', kolejnosc: 10 },
  },
  {
    klucz: 'klienci', etykieta: 'Stali klienci', href: '/klienci', prefiksy: ['/klienci'],
    nawigacja: { dzial: 'sprzedaz', grupa: 'klienci', kolejnosc: 50 },
  },
  {
    klucz: 'wiadomosci', etykieta: 'Wiadomości', href: '/wiadomosci', prefiksy: ['/wiadomosci'],
    nawigacja: { dzial: 'sprzedaz', grupa: 'klienci', kolejnosc: 40 },
  },
  { klucz: 'ustawienia', etykieta: 'Ustawienia', href: '/ustawienia', prefiksy: ['/ustawienia'] },
];

// Trasy dostepne KAZDEMU zalogowanemu, niezaleznie od ptaszkow. Wylogowanie odebrane
// koncie bez ptaszka znaczyloby czlowieka zamknietego w panelu, ktorego nie umie opuscic;
// przelacznik motywu nie niesie zadnej informacji.
// PRZ-069: strona własnego konta (imię, zmiana hasła) — bez ptaszka, także dla konta bez żadnego ekranu.
const DLA_KAZDEGO = ['/wyloguj', '/motyw', '/konto', '/konto/imie', '/konto/haslo'];

// ⚠️⚠️ TRASY, KTORE ODPYTUJE MASZYNA, A NIE CZLOWIEK — i to jest cala ich definicja.
//
// Obie kolejki druku obsluguja czuwacze PowerShella na komputerze przy drukarce
// (`deploy/drukarka/czuwacz-etykiet.ps1`, `czuwacz-faktur.ps1`). Loguja sie BASIC AUTHEM
// na hasle z `.env` i odpytuja te adresy w petli. ZADEN widok panelu do nich nie prowadzi —
// sprawdzone: `grep "kolejka-druku" src/oms/web/views/` nie ma ani jednego trafienia.
//
// ⚠️⚠️ DLACZEGO TO TU STOI (recenzja calosci, 2026-09-13). Adresy naleza do ekranow
// `zamowienia` i `pozostale-dokumenty-zamowienia`, wiec po degradacji konta serwisowego (pierwszy
// czynny admin w tabeli) czuwacze dostawaly 403 — a ich petla lapie kazdy blad jako „panel
// nieosiagalny", pisze JEDEN wiersz do lokalnego pliku przy drukarce i probuje dalej bez
// konca. `/health` nie ma ani jednego sygnalu o kolejce druku, wiec czujka monitoring tez
// by milczala. Skutek: z Zebry PRZESTAJA WYCHODZIC ETYKIETY, a dowiadujemy sie o tym przy
// paczce. Zmierzone przed poprawka: `/kolejka-druku` 200 przy pustej tabeli, 403 po
// zalozeniu pierwszego admina.
//
// ⚠️ Mapowanie na ekran ZOSTAJE bez zmian — czlowiek z rola Produkcja dalej nie ma tu czego
// szukac. To jest wylacznie wyjatek dla KONTA MASZYNOWEGO, i dlatego czyta go `dopuscSerwisowe`
// w security/straznik.js, a nie `ekranDlaAdresu`.
const PREFIKSY_MASZYNOWE = ['/kolejka-druku', '/kolejka-druku-faktur'];

const wSekcji = (sciezka, prefiks) => sciezka === prefiks || sciezka.startsWith(`${prefiks}/`);

/**
 * Czy adres obsluguje maszyna (czuwacz druku), a nie czlowiek przez ekran.
 * Konto serwisowe z `.env` zachowuje do nich dostep TAKZE po degradacji.
 */
export function czyTrasaMaszynowa(url) {
  const sciezka = String(url ?? '').split('?')[0] || '/';
  return PREFIKSY_MASZYNOWE.some((p) => wSekcji(sciezka, p));
}

/**
 * Klucz ekranu, do ktorego nalezy adres — albo `null`, gdy do ZADNEGO.
 *
 * ⚠️ `null` JEST ODMOWA, nie „przepusc". Regula odwrotna znaczy, ze kazda trasa dopisana
 * za pol roku jest po cichu otwarta dla wszystkich. Bezpiecznikiem jest test kompletnosci
 * tras wyliczany Z INSTANCJI FASTIFY (tests/oms/kompletnosc-tras.test.js) — nowa trasa
 * bez przypisania to czerwony test, a nie niespodzianka na produkcji.
 */
export function ekranDlaAdresu(url) {
  const sciezka = String(url ?? '').split('?')[0] || '/';
  if (czyTrasaOtwarta(sciezka)) return 'otwarte';
  if (DLA_KAZDEGO.includes(sciezka)) return 'kazdy';
  if (sciezka === '/api' || sciezka.startsWith('/api/')) return 'api';
  for (const wzorzec of WZORCE_FAKTUR_ZAMOWIENIA) {
    if (wzorzec.test(sciezka)) return 'faktury-zamowienia';
  }
  for (const wzorzec of WZORCE_ZWROTOW_ZAMOWIENIA) {
    if (wzorzec.test(sciezka)) return 'zwroty-zamowienia';
  }
  for (const wzorzec of WZORCE_POZOSTALYCH_DOKUMENTOW_ZAMOWIENIA) {
    if (wzorzec.test(sciezka)) return 'pozostale-dokumenty-zamowienia';
  }
  for (const ekran of EKRANY) {
    if ((ekran.dokladne ?? []).includes(sciezka)) return ekran.klucz;
    if (ekran.prefiksy.some((p) => wSekcji(sciezka, p))) return ekran.klucz;
  }
  return null;
}

/** Jedna regula prawa uzywana przez straznika, nawigacje i kontrolki widokow. */
export function maDostepDoEkranu(konto, klucz) {
  if (klucz === 'otwarte') return true;
  if (!konto || !klucz) return false;
  if (klucz === 'kazdy') return true;
  return konto.admin === true || konto.uprawnienia?.has(klucz) === true;
}

/** Prawo do konkretnego adresu, wyliczone z autorytatywnej mapy tras. */
export function maDostepDoAdresu(konto, url) {
  const klucz = ekranDlaAdresu(url);
  if (klucz === null) return false;
  return maDostepDoEkranu(konto, klucz);
}

/** Domyślny tytuł strony z tej samej prezentacyjnej mapy, która nazywa nawigację. */
export function tytulEkranuDlaAdresu(url) {
  const sciezka = String(url ?? '').split('?')[0];
  const integracje = {
    '/ustawienia/integracje/dpd': 'Kurier DPD Polska',
    '/ustawienia/integracje/inpost': 'Kurier InPost',
    '/ustawienia/integracje/infakt': 'inFakt',
    '/ustawienia/integracje/program-fakturowy': 'Moduł faktur',
    '/ustawienia/integracje/gus': 'GUS (dane firm po NIP)',
    '/ustawienia/integracje/ksef': 'KSeF — faktury kosztowe',
    '/ustawienia/integracje/poczta': 'Poczta wychodząca',
    '/ustawienia/integracje/reklamy': 'Integracje reklam',
  };
  if (integracje[sciezka]) return integracje[sciezka];
  const pozycja = POZYCJE_USTAWIEN.find((p) => p.href === sciezka);
  if (pozycja) return pozycja.etykieta;
  // Odpowiedź 400 formularza korzysta z nazwy ekranu, do którego należy w menu.
  if (['/ustawienia/paczka', '/ustawienia/dostawa', '/ustawienia/formulka', '/ustawienia/kanaly'].some((p) => wSekcji(sciezka, p))) {
    return podmenuUstawien(sciezka).find((p) => p.aktywna)?.etykieta ?? 'Ustawienia';
  }
  const klucz = ekranDlaAdresu(url);
  return EKRANY.find((ekran) => ekran.klucz === klucz)?.etykieta ?? 'Zamówienia';
}

// ROLE SA PRESETEM, NIE ZAMKIEM. Zakladajac konto wybierasz role, ona zaznacza ptaszki —
// i od tej chwili PTASZKI SA PRAWDA. Rola zostaje etykieta, a ekran kont pokazuje
// „Sprzedaż" albo „Sprzedaż + zmiany", zeby etykieta nigdy nie mowila czegos innego
// niz faktyczne uprawnienia.
//
// ⚠️ To jest JEDYNE miejsce, w ktorym stoja nazwy i sklady rol. Kupujacy „Twoj OMS"
// zmienia je tutaj i nigdzie indziej.
export const ROLE = {
  administrator: { etykieta: 'Administrator', ekrany: '*', admin: true },
  sprzedaz: {
    etykieta: 'Sprzedaż',
    // Wszystko poza pieniedzmi wlasciciela (finanse: ZUS, PIT-5, rachunek zarzadczy)
    // i poza konfiguracja panelu (ustawienia: tokeny, wiazanie kanalow).
    ekrany: EKRANY.map((e) => e.klucz).filter((k) => k !== 'finanse' && k !== 'ustawienia'),
    admin: false,
  },
  produkcja: {
    etykieta: 'Produkcja',
    ekrany: ['zamowienia', 'przesylki', 'faktury-zamowienia', 'zwroty-zamowienia'],
    admin: false,
  },
};

/** Komplet kluczy ekranow presetu. Nieznana rola nie daje NICZEGO (fail-closed). */
export function ekranyRoli(rola) {
  const opis = ROLE[rola];
  if (!opis) return [];
  return opis.ekrany === '*' ? EKRANY.map((e) => e.klucz) : [...opis.ekrany];
}
