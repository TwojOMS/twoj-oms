// PRAWDZIWY PRZEWOZNIK PRZESYLKI (PRZ-067, decyzja właściciela 13.10).
//
// Kolumna `przesylki.kurier` mowi, JAKA DROGA nadalismy paczke (`dpd`, `inpost` — nasze umowy;
// `allegro_wza`, `allegro` — panel Allegro), a NIE kto ja wiezie. Paczka Allegro moze jechac
// DPD, InPostem, DHL, ORLEN Paczka, Allegro One albo Packeta. Filtr i logo w zakladce Przesylki
// maja pokazywac TEGO przewoznika, bo operator szuka „paczek DPD", a nie „paczek nadanych przez
// panel Allegro".
//
// ⚠️ `carrier_allegro = ALLEGRO` NIE JEST SYGNALEM. Pomiar z produkcji (13.10, 60 dni, 257 przesylek):
// ALLEGRO stoi przy „Allegro Kurier DPD", „Allegro Kurier DHL", „Allegro Automat ORLEN Paczka"
// i przy One Box. Prawdziwego przewoznika przesylki Allegro ustala NAZWA USLUGI. Mocnym sygnalem
// sa tylko INPOST i PACKETA.
//
// Jedno miejsce na: klucz, nazwe dla czlowieka, plik logo i adres sledzenia. Poprawka adresu
// albo rozszerzenia pliku to jedna linia tutaj.
import { nazwaDostawy, metodaWysylki } from './wysylka.js';

import { OPISY_PRZEWOZNIKOW } from './przewoznicy.ts';

const opisy = Object.values(OPISY_PRZEWOZNIKOW);
export const PRZEWOZNICY = Object.freeze(Object.fromEntries(opisy.map(
  ({ klucz, nazwa, logo, sledzenie }) => [klucz, Object.freeze({
    klucz, nazwa, logo, sledzenie: sledzenie.replace('{numer}', ''),
  })],
)));

const mapaRozpoznania = (pole) => Object.fromEntries(opisy.flatMap(
  opis => (opis.rozpoznanie[pole] ?? []).map(wartosc => [wartosc, opis.klucz]),
));

// `Object.hasOwn`, nie `PRZEWOZNICY[klucz]`: klucz przychodzi z adresu (`?kurier=`), a
// `__proto__`/`constructor` daloby obiekt zamiast „nieznany".
const wpis = (klucz) => (typeof klucz === 'string' && Object.hasOwn(PRZEWOZNICY, klucz) ? PRZEWOZNICY[klucz] : null);

// Kod nadania → przewoznik. Kod mowi, kim NADALISMY, wiec jest wazniejszy niz metoda zamowienia:
// zmierzone `inpost||dpd` (2 szt.) to paczka InPostu, mimo ze klient wybral DPD.
const Z_KODU = mapaRozpoznania('kod');

// Kod `carrier_allegro` → przewoznik. Tylko sygnaly jednoznaczne; ALLEGRO celowo nieobecne.
const Z_CARRIERA = mapaRozpoznania('carrier');

// SLOWA W NAZWIE USLUGI. ⚠️ KOLEJNOSC JEST TRESCIA:
//  1. Packeta PRZED ORLEN — „…Automaty Paczkowe Packeta, ORLEN Paczka" to wysylka na Slowacje,
//     ktora wiezie Packeta (ORLEN to tylko siec punktow odbioru po drugiej stronie).
//  2. Konkretni przewoznicy (DPD, InPost, DHL, ORLEN) PRZED „One" — „Allegro One Box, DPD"
//     znaczy „do automatu One Box, ale paczke wiezie DPD".
//  3. „One" na koncu — „Allegro One Box, One Kurier" i „Allegro One Kurier - dostawa jutro"
//     to siec Allegro One.
// Pelne slowa, bez rozrozniania wielkosci liter: „Phone", „DPDX", „Orlenowo" niczego nie znacza.
const SLOWA = [...opisy].sort((a, b) => a.kolejnoscSlow - b.kolejnoscSlow)
  .flatMap(opis => (opis.rozpoznanie.slowa ?? []).map(s => [s, opis.klucz]));
const slowo = (s) => new RegExp(`(?:^|[^\\p{L}\\p{N}])${s}(?:[^\\p{L}\\p{N}]|$)`, 'iu');
const WZORCE = SLOWA.map(([s, klucz]) => [slowo(s), klucz]);

// Metoda wysylki → przewoznik. ZAPAS, gdy nazwa uslugi nic nie mowi (brak nazwy od Allegro albo
// ogolna nazwa slownikowa po recznej zmianie metody). `allegro_punkt`/`allegro_inne` celowo
// nieobecne: punkt to ORLEN, DHL BOX albo One Box — zgadywanie byloby klamstwem w filtrze.
const Z_METODY = mapaRozpoznania('metody');

/**
 * Prawdziwy przewoznik przesylki albo `null`, gdy nie da sie go ustalic.
 * Kolejnosc: kod nadania (dpd/inpost) → carrier Allegro (INPOST/PACKETA) → nazwa uslugi → metoda.
 *
 * @param {{ kurier?: string|null, carrierAllegro?: string|null, nazwaUslugi?: string|null, metoda?: string|null }} wejscie
 * @returns {{ klucz: string, nazwa: string, logo: string, sledzenie: string } | null}
 */
export function przewoznikPrzesylki({ kurier = null, carrierAllegro = null, nazwaUslugi = null, metoda = null } = {}) {
  if (kurier && Object.hasOwn(Z_KODU, kurier)) return wpis(Z_KODU[kurier]);
  const carrier = String(carrierAllegro ?? '').trim().toUpperCase();
  if (Object.hasOwn(Z_CARRIERA, carrier)) return wpis(Z_CARRIERA[carrier]);
  const nazwa = String(nazwaUslugi ?? '');
  if (nazwa) {
    for (const [wzorzec, klucz] of WZORCE) if (wzorzec.test(nazwa)) return wpis(klucz);
  }
  if (metoda && Object.hasOwn(Z_METODY, metoda)) return wpis(Z_METODY[metoda]);
  return null;
}

/**
 * Adres strony sledzenia albo `null` (nieznany przewoznik, brak numeru). Numer zawsze przez
 * `encodeURIComponent` — numer z `&`/`#` inaczej doklejalby parametry do adresu przewoznika.
 */
export function adresSledzenia(klucz, numer) {
  const p = wpis(klucz);
  const nr = typeof numer === 'string' ? numer.trim() : (numer == null ? '' : String(numer).trim());
  if (!p || !nr) return null;
  return `${p.sledzenie}${encodeURIComponent(nr)}`;
}

/**
 * Przewoznik WIERSZA zakladki Przesylki: przesylka z bazy + jej zamowienie (moze byc `null`).
 *
 * ⚠️ Nazwa uslugi idzie przez `nazwaDostawy`, a metoda przez `metodaWysylki` — TA SAMA droga,
 * co kolumna „Dostawa" i karta. Reczna zmiana metody uniewaznia nazwe od Allegro; bez tego
 * paczka przestawiona na karcie z „Allegro Kurier DPD" na paczkomat dalej liczylaby sie jako DPD.
 */
export function przewoznikWiersza(p, zamowienie) {
  return przewoznikPrzesylki({
    kurier: p?.kurier ?? null,
    carrierAllegro: p?.carrier_allegro ?? null,
    nazwaUslugi: zamowienie ? nazwaDostawy(zamowienie) : null,
    metoda: zamowienie ? metodaWysylki(zamowienie) : null,
  });
}

/**
 * Link do sledzenia paczki (PRZ-152.G7) — JEDNA droga dla zakladki Przesylki, karty zamowienia
 * i maila „Zamowienie wyslane": prawdziwy przewoznik z `przewoznikWiersza` (kod → carrier
 * Allegro → nazwa uslugi → metoda), potem jego adres. Sam kod drogi nadania nie wystarcza:
 * `allegro_wza` nie mowi, kto wiezie, wiec paczka WzA jadaca DPD zostawala bez linku.
 * `null`, gdy przewoznika nie da sie ustalic albo nie ma numeru — nigdy zgadniety adres.
 */
export function linkSledzeniaPaczki(p, zamowienie) {
  return adresSledzenia(przewoznikPaczki(p, zamowienie)?.klucz, p?.numer_listu);
}

/**
 * Przewoznik KONKRETNEJ paczki (link do sledzenia, plakietka na karcie — PRZ-152.G8) albo `null`.
 * Nieznany kod spoza Allegro nie dziedziczy przewoznika zamowienia: zamowienie mowi, jak klient
 * chcial dostac paczke, a nie kto ja wiezie. Kurier zamowienia uzupelnia tylko drogi Allegro (WzA).
 */
export function przewoznikPaczki(p, zamowienie) {
  const kod = p?.kurier ?? null;
  if (kod && !Object.hasOwn(Z_KODU, kod) && !String(kod).startsWith('allegro')) return null;
  return przewoznikWiersza(p, zamowienie);
}
