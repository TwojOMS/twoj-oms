// Produkty, z ktorych karta NIE powstala, ulozone tak, zeby dalo sie na nie patrzec.
//
// ⚠️⚠️ CAŁY POWÓD ISTNIENIA TEGO PLIKU (mina zmierzona): pominiętych bywają setki, z czego
// **zdecydowana większość to oferty Allegro**, które kart nie zakładają CELOWO (karta
// powstaje z katalogu sklepu, a ofertę wiąże się z nim ręcznie — patrz `powodPominiecia`
// w domena/karta-z-produktu.js). Realnej roboty jest kilkadziesiąt pozycji. Płaska lista
// utopiłaby je w tamtych setkach, a pierwsza reakcja człowieka na ekran pełen „pominiętych"
// brzmi „to błąd, napraw" — i tak zniknęłaby jedyna informacja, po którą się tu przychodzi.
//
// Stad trzy rzeczy naraz: GRUPY po powodzie, LICZBA przy grupie i ROBOTA NA GORZE.
import { czyPominietyCelowo } from './karta-z-produktu.js';
import { wymagajListyKanalow } from './lista-kanalow.js';

/**
 * Pominiete produkty → grupy `{ powod, ile, celowo, produkty }`.
 *
 * `celowo` znaczy „tak ma byc, nie ma tu nic do zrobienia". Rozstrzyga SAMA POZYCJA, a nie
 * tresc powodu: grupa jest celowa dokladnie wtedy, gdy ANI JEDNA jej pozycja nie jest robota.
 * Pyta o to `czyPominietyCelowo` z `domena/karta-z-produktu.js` — ta sama warstwa, ktora
 * rozstrzyga o zakladaniu karty, nie druga jej kopia.
 *
 * ⚠️ BIAŁA LISTA KANAŁÓW („celowe = nie ze sklepu") JEST ZA WĄSKA. Pomiar na prawdziwej bazie
 * pokazał pozycje ZE SKLEPU, które kartami nie będą nigdy (projekt indywidualny — warianty
 * różniące się samą ceną — i zaślepka panelu ofert). Przy białej liście leżały na górze ekranu
 * jako robota i udawały usterkę, której naprawić się nie da.
 *
 * ⚠️ `every`, a nie „pierwsza pozycja": grupa mieszana (ten sam powod trafil produkt ze
 * sklepu i oferte) jest ROBOTA. Falszywe „tak ma byc" na produkcie sklepowym schowaloby
 * go pod zwinieta sekcja na dole ekranu — czyli dokladnie tam, gdzie nikt nie zaglada.
 *
 * ⚠️ KLUCZEM GRUPY JEST NIETKNIETY NAPIS POWODU, prosto z domeny. Skracanie go tutaj
 * („oferta Allegro") rozjechaloby ekran z jedynym miejscem, ktore o tym rozstrzyga,
 * a przy okazji sklejaloby oba konta Allegro w jedna grupe — a to sa dwa rozne katalogi.
 *
 * ⚠️ `Map`, nie literal obiektu: powody sa napisami spoza naszej kontroli (niosa nazwe
 * kanalu z lustra cudzego API), wiec powod o tresci „constructor" na `{}` nie zalozylby
 * wlasnego klucza, tylko po cichu siegnal do prototypu — ta sama pulapka, co przy bialej
 * liscie sortowania w oms/db/magazyn.js.
 */
export function grupujPominiete(produkty, kanalySklepow) {
  wymagajListyKanalow(kanalySklepow);
  const grupy = new Map();
  for (const p of produkty ?? []) {
    const powod = String(p?.powod ?? '');
    if (!grupy.has(powod)) grupy.set(powod, []);
    grupy.get(powod).push(p);
  }

  return (
    [...grupy.entries()]
      .map(([powod, lista]) => ({
        powod,
        ile: lista.length,
        celowo: lista.every((p) => czyPominietyCelowo(p, kanalySklepow)),
        produkty: lista,
      }))
      // Kolejnosc: najpierw ROBOTA, potem rzeczy celowe; w obu pasach najliczniejsze na
      // gorze. Trzecie kryterium (nazwa powodu) nie jest ozdoba — bez niego dwie grupy
      // o rownej liczbie ustawialyby sie zaleznie od kolejnosci wierszy z bazy, a ekran
      // ogladany dwa razy z rzedu wygladalby inaczej bez zadnej zmiany danych.
      .sort((a, b) => Number(a.celowo) - Number(b.celowo) || b.ile - a.ile || a.powod.localeCompare(b.powod, 'pl'))
  );
}
