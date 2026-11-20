// src/domena/migawka-powiadomien.js
//
// Scalenie migawki powiadomień: co się zmieniło między poprzednim przebiegiem (wiersze tabeli `powiadomienia`)
// a tym, co reguły z `domena/ostrzezenia.js` zwracają teraz. Czysta funkcja — zapis robi
// `oms/db/powiadomienia-migawka.js` w jednej transakcji.
//
// Sprawa jest aktualna, dopóki reguła ją zwraca; potem ma `rozwiazane_at` i leży w archiwum. Ignorowanie
// zostaje w `ostrzezenia_odrzucone` (wspólne dla firmy) — migawka trzyma też zignorowane sprawy, bo archiwum
// pokazuje je jako zignorowane; o tym, co jest zignorowane, rozstrzyga odczyt, nie zapis.

import { czyZignorowane } from './ostrzezenia.js';

// Archiwum trzyma 30 dni: rozwiązane od `rozwiazane_at`, zignorowane od `odrzucone_at`.
export const RETENCJA_MS = 30 * 24 * 3600 * 1000;

const czas = (x) => Date.parse(x);

function wierszMigawki(w) {
  return {
    klucz: w.klucz,
    typ: w.typ,
    tekst: w.tekst,
    title: w.title ?? null,
    href: w.przycisk?.href ?? null,
    etykieta_przycisku: w.przycisk?.etykieta ?? null,
    etykieta_odrzucenia: w.etykietaOdrzucenia ?? null,
    // Awaria integracji zatrzymuje dopływ danych — reszta listy bez niej może kłamać, więc jest pilna.
    pilne: w.pilne === true || w.typ === 'integracja' ? 1 : 0,
  };
}

/**
 * @param {{ poprzednie: object[], nowe: object[], teraz: Date, odrzucone?: Map<string, string>,
 *   nieudane?: string[] }} a
 *   `poprzednie` — wiersze tabeli; `nowe` — wiersze reguł; `odrzucone` — klucz → odrzucone_at;
 *   `nieudane` — prefiksy kluczy źródeł, które w tym przebiegu nie odpowiedziały.
 * @returns {{ wstaw: object[], odswiez: object[], rozwiaz: string[], wroc: object[], usun: string[] }}
 *   `wroc` — sprawa znów aktualna: zapis kasuje jej przeczytania (nieprzeczytana dla wszystkich).
 *   `usun` — klucze po retencji: wiersz i jego przeczytania znikają, `ostrzezenia_odrzucone` zostaje.
 */
export function scalMigawke({ poprzednie = [], nowe = [], teraz, odrzucone = new Map(), nieudane = [] }) {
  const t = teraz.getTime();
  const chwila = teraz.toISOString();
  const byly = new Map(poprzednie.map((p) => [p.klucz, p]));
  const widziane = new Set();
  const wynik = { wstaw: [], odswiez: [], rozwiaz: [], wroc: [], usun: [] };

  // Zignorowana ponad 30 dni temu znika z archiwum. Wiersz ignorowania zostaje, więc trwająca sprawa nie
  // wraca do aktualnych — i nie wchodzi do migawki na nowo, bo inaczej wróciłaby do archiwum.
  const poRetencjiIgnorowania = (typ, klucz) => {
    const odrzuconeAt = odrzucone.get(klucz);
    return czyZignorowane(typ, odrzuconeAt, t) && t - czas(odrzuconeAt) > RETENCJA_MS;
  };

  for (const w of nowe) {
    if (!w?.klucz || widziane.has(w.klucz)) continue;
    widziane.add(w.klucz);
    const p = byly.get(w.klucz);
    if (poRetencjiIgnorowania(w.typ, w.klucz)) {
      if (p) wynik.usun.push(w.klucz);
      continue;
    }
    const wiersz = wierszMigawki(w);
    if (!p) {
      wynik.wstaw.push({ ...wiersz, pierwszy_raz_at: chwila, ostatnio_at: chwila, rozwiazane_at: null });
      continue;
    }
    // Koniec dobowego wyciszenia integracji: poprzedni przebieg widział sprawę wyciszoną, ten już nie.
    const odrzuconeAt = odrzucone.get(w.klucz);
    const wyciszenieMinelo =
      odrzuconeAt !== undefined &&
      czyZignorowane(w.typ, odrzuconeAt, czas(p.ostatnio_at)) &&
      !czyZignorowane(w.typ, odrzuconeAt, t);
    if (p.rozwiazane_at || wyciszenieMinelo) {
      wynik.wroc.push({ ...wiersz, pierwszy_raz_at: chwila, ostatnio_at: chwila, rozwiazane_at: null });
      continue;
    }
    wynik.odswiez.push({ ...wiersz, pierwszy_raz_at: p.pierwszy_raz_at, ostatnio_at: chwila, rozwiazane_at: null });
  }

  for (const p of poprzednie) {
    if (widziane.has(p.klucz)) continue;
    // Brak wiersza ze źródła, które nie odpowiedziało, nic nie mówi o sprawie: „rozwiązana” byłoby kłamstwem
    // w archiwum, a po powrocie źródła sprawa przyszłaby jako nowa i straciła przeczytania. Zostaje jak była.
    if (nieudane.some((prefiks) => p.klucz.startsWith(prefiks))) continue;
    if (poRetencjiIgnorowania(p.typ, p.klucz)) {
      wynik.usun.push(p.klucz);
    } else if (!p.rozwiazane_at) {
      wynik.rozwiaz.push(p.klucz);
    } else if (t - czas(p.rozwiazane_at) > RETENCJA_MS) {
      wynik.usun.push(p.klucz);
    }
  }
  return wynik;
}
