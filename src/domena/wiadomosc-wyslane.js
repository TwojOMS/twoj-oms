import { linkDoSledzenia } from './tracking.js';
import { przewoznikWiersza } from './przewoznik-przesylki.js';
import { punktOdbioru, punktOdbioruOpis } from './wysylka.js';

// MAIL „ZAMÓWIENIE WYSŁANE" (PRZ-102.21, decyzja właściciela 20.10: „Tak, jako szablon. Automatyzacje wysyłki
// wiadomości jako osobne zadanie."). Moduł czysty: z zamówienia liczy listę paczek do maila — nic nie wysyła.
//
// ⚠️ TYLKO PACZKI Z NUMEREM LISTU. `z.przesylki` jest już bez nieudanych prób ('blad', db/zamowienia.js);
// tu odpada jeszcze wiersz bez numeru (nadanie trwa, przesyłka tworzona u kuriera) i 'do_wyjasnienia' —
// numer przydzielony, ale nadanie nie doszło do końca, więc paczki za nim może nie być. Mail z takim numerem
// wysłałby klienta na stronę śledzenia, która nic nie pokaże.
//
// ⚠️ LINK TYLKO ZE SPRAWDZONYCH WZORCÓW (`linkDoSledzenia`, tracking.js) — ten sam, co na karcie. Nieznany wzorzec
// = sam numer, nigdy zgadnięty adres. Nazwa przewoźnika dla człowieka z `przewoznikWiersza` — tej samej reguły,
// co zakładka Przesyłki (paczka „Wysyłam z Allegro" ma nazwę tego, kto ją wiezie, nie „allegro").

const BEZ_PACZKI = 'Zamówienie nie ma przesyłki z numerem listu — nadaj paczkę albo wpisz numer w sekcji Przesyłka.';

/** Paczki, o których mail może powiedzieć „wysłane": żywe i z numerem listu, w kolejności z karty. */
export function paczkiDoMaila(z) {
  return (z?.przesylki ?? [])
    .filter((p) => String(p?.numer_listu ?? '').trim() && p.status !== 'blad' && p.status !== 'do_wyjasnienia')
    .map((p) => {
      const numer = String(p.numer_listu).trim();
      return { przewoznik: przewoznikWiersza(p, z)?.nazwa ?? 'Przesyłka', numer, link: linkDoSledzenia(p.kurier, numer) };
    });
}

/** Czy wolno wysłać „Zamówienie wysłane" — warunki wspólne (anulowane, adres) sprawdza `czyWolnoWyslac`. */
export const powodBrakuPaczki = (z) => (paczkiDoMaila(z).length ? null : BEZ_PACZKI);

/**
 * Model bloku `{przesylki}`: paczki i punkt odbioru (paczkomat/punkt — kod i opis, gdy są w danych zamówienia).
 * Punkt należy do zamówienia, nie do paczki, więc stoi raz, pod listą.
 */
export function modelWyslane(z) {
  const kod = String(punktOdbioru(z) ?? '').trim();
  const opis = String(punktOdbioruOpis(z) ?? '').trim();
  return { przesylki: paczkiDoMaila(z), punkt: kod || opis ? [kod, opis].filter(Boolean).join(' — ') : null };
}

/** Linie tekstowe bloku — nagłówek i wcięte linie, jak pozostałe sekcje maili (blokiTekstuPotwierdzenia). */
export function blokiTekstuWyslane(m) {
  const linie = m.przesylki.flatMap((p) => [`${p.przewoznik}, numer listu: ${p.numer}`, ...(p.link ? [`Śledzenie: ${p.link}`] : [])]);
  if (m.punkt) linie.push(`Punkt odbioru: ${m.punkt}`);
  return { przesylki: linie.length ? [m.przesylki.length > 1 ? 'PRZESYŁKI' : 'PRZESYŁKA', ...linie.map((l) => `  ${l}`)] : [] };
}

/** Stan tematu na ekranie wyboru: numery, które pojadą w mailu. */
export const numeryPaczek = (z) => paczkiDoMaila(z).map((p) => `${p.przewoznik} ${p.numer}`).join(', ');
