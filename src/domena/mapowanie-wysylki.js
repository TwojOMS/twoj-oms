import { METODY_WYSYLKI } from './wysylka.js';

// ⚠️ TU I TYLKO TU mieszka odpowiedz na pytanie „czym to jedzie". Jedno miejsce na
// WSZYSTKIE sklepy — odpowiednik panelu mapowania dostaw w Apilo, tyle ze w kodzie
// (decyzja wlasciciela 2026-08-01: „mozemy sobie to zrobic recznie w kodzie").
//
// Sklepy nazywaja te sama dostawe inaczej i beda ja nazywac inaczej dalej: „Kurier DPD",
// „Kurier DPD (darmowa wysylka)", „Kurier DPD pobranie". Panel ma z tego wyprowadzic
// JEDNA z trzech wartosci, ktore rozumie reszta modulu (METODY_WYSYLKI) — i zrobic to tak,
// zeby dopisanie nowej dostawy bylo dopisaniem WIERSZA W TEJ TABELI, a nie polowaniem na
// warunki rozsiane po kodzie.
//
// DWIE WARSTWY, w tej kolejnosci:
//
//  1. `instancje` — `instance_id` linii wysylki. TO JEST DROGA GLOWNA i jedyna pewna.
//     `instance_id` jest niezmienne; tytul metody zmienia sie jednym klikiem w wp-adminie,
//     a `method_id` potrafi KLAMAC (np. instancja pobrania z `method_id` odbioru osobistego na sklepie A).
//
//  2. `poPozycji` — dopasowanie po POZYCJI zamowienia, uzywane WYLACZNIE wtedy, gdy
//     zamowienie nie ma zadnej linii wysylki. Na sklepie A to nie jest przypadek
//     brzegowy: zamowienia zlozone z oferty (panel indywidualny) niosa wysylke jako
//     ZWYKLA POZYCJE ze SKU `psm-zam-placeholder`, a `shipping_lines` jest puste.
//     ⚠️ Ta warstwa ZGADUJE po nazwie i wlasnie dlatego jest druga, nie pierwsza.

// Mapa instancji wysyłki KONKRETNEGO sklepu jest konfiguracją instalacji (`<PREFIKS>_MAPOWANIE`
// kanału z `OMS_KANALY`, walidowane w moduly/kanaly/konfiguracja.ts), a nie stałą w kodzie.
// PRZ-060: dawna mapa sklepów właściciela (z pułapką instancji pobrania o `method_id` odbioru
// osobistego) żyje już tylko jako fixture zamrożonych testów: tests/pomoc/mapowanie-sklepow-historyczne-fixture.js.

// Nazwa metody dla CZLOWIEKA — do pokazania obok „nieznana" w komunikacie i w logu.
const TEKST = (v) => String(v ?? '').trim().toLowerCase();

/**
 * Metoda wysyłki z linii wysyłki zamówienia — droga główna.
 *
 * Zwraca `null`, gdy zamówienie nie ma ani jednej linii wysyłki albo gdy jej `instance_id`
 * nie ma w tablicy: to NIE jest błąd, tylko „ta warstwa nie wie" — odpowiedź daje wtedy
 * warstwa druga albo, gdy i ona nie wie, `'nieznana'`.
 *
 * ⚠️ Patrzymy WYŁĄCZNIE na pierwszą linię: sklepy oferują jedną metodę na zamówienie.
 * Sklep, który dopuści dwie, wymaga przemyślenia tego od nowa — a nie cichego wyboru
 * pierwszej z brzegu jako „tej właściwej".
 */
export function metodaZLinii(surowe, instancje) {
  const linie = surowe?.shipping_lines;
  if (!Array.isArray(linie) || linie.length === 0) return null;
  const id = Number(linie[0].instance_id);
  if (!Number.isFinite(id)) return null;
  return instancje?.[id] ?? null;
}

/**
 * Metoda wysyłki wyprowadzona z POZYCJI zamówienia — warstwa zapasowa.
 *
 * Używana tylko wtedy, gdy zamówienie nie ma linii wysyłki. Reguła dopasowuje się po SKU
 * (dokładnie) albo po fragmencie nazwy (bez wielkości liter) — pierwsza pasująca wygrywa,
 * więc kolejność w tablicy jest znacząca i dlatego reguły stoją tam jawnie, jedna pod drugą.
 */
export function metodaZPozycji(surowe, reguly) {
  for (const regula of reguly ?? []) {
    for (const p of surowe?.line_items ?? []) {
      if (regula.sku && TEKST(p.sku) === TEKST(regula.sku)) return regula;
      if (regula.nazwaZawiera && TEKST(p.name).includes(TEKST(regula.nazwaZawiera))) return regula;
    }
  }
  return null;
}

/**
 * Metoda wysyłki zamówienia — jedno wejście dla całego panelu.
 *
 * `'nieznana'` jest PEŁNOPRAWNYM wynikiem, nie awarią: karta pokazuje wtedy „nieznana
 * metoda — nadaj w Apilo", nadanie odmawia, a operator może metodę ustawić ręcznie na
 * karcie. To jest bezpieczna odpowiedź — obiecanie kuriera, którego panel nie umie
 * obsłużyć, nie jest.
 */
export function metodaWysylkiZamowienia(surowe, mapowanie) {
  // ⚠️ Do 2026-08-01 ta funkcja dostawala SAMA MAPE INSTANCJI (`{1: 'dpd'}`), a od Etapu 2
  // dostaje calą tablicę (`{instancje, poPozycji}`). Wywolanie po staremu jest bledem
  // PROGRAMISTY, a jego objawem byloby „nieznana" na KAZDYM zamowieniu — czyli cala
  // synchronizacja wygladajaca na udana, z lista pelna zamowien nie do nadania. Lepiej
  // glosno przy pierwszym zamowieniu niz cicho przy wszystkich.
  if (mapowanie && !('instancje' in mapowanie) && Object.keys(mapowanie).some((k) => /^\d+$/.test(k))) {
    throw new Error(
      'mapowanie wysyłki: podano samą mapę instancji zamiast tablicy dostaw '
      + '({ instancje, poPozycji }) — patrz domain/mapowanie-wysylki.js',
    );
  }
  const wpis = metodaZLinii(surowe, mapowanie?.instancje)
    ?? metodaZPozycji(surowe, mapowanie?.poPozycji);
  // Literówka w tablicy wyżej nie ma prawa wpuścić do bazy wartości, której nie zna
  // `wybierzKuriera`, `wyliczStatus` ani karta — a pierwszy raz zobaczylibyśmy ją dopiero
  // przy nadaniu prawdziwej paczki.
  //
  // ⚠️ Nierozpoznana dostawa NIE MOŻE nieść pobrania: panel i tak jej nie nada, a
  // „nieznana + pobranie" wyglądałoby na paczkę, za którą kurier ma coś zainkasować.
  if (!METODY_WYSYLKI.includes(wpis?.metoda)) return { metoda: 'nieznana', pobranie: false };
  return { metoda: wpis.metoda, pobranie: Boolean(wpis.pobranie) };
}
