// Produkty, z ktorych wzor NIE powstal, ulozone tak, zeby dalo sie na nie patrzec.
//
// ⚠️⚠️ CALY POWOD ISTNIENIA TEGO PLIKU (mina zmierzona przy Zadaniu 8): pominietych jest
// okolo 473, z czego **447 to oferty Allegro**, ktore wzorow nie zakladaja CELOWO (wzor
// powstaje z katalogu sklepu, a oferte wiaze sie z nim recznie — patrz `powodPominiecia`
// w domain/wzor-z-produktu.js). Realnej roboty jest okolo 26. Plaska lista 473 wierszy
// utopilaby te 26 w tamtych 447, a pierwsza reakcja czlowieka na ekran pelen „pominietych"
// brzmi „to blad, napraw" — i tak zniknelaby jedyna informacja, po ktora sie tu przychodzi.
//
// Stad trzy rzeczy naraz: GRUPY po powodzie, LICZBA przy grupie i ROBOTA NA GORZE.
import { czyPominietyCelowo } from './wzor-z-produktu.js';
import { wymagajListyKanalow } from './lista-kanalow.js';

/**
 * Pominiete produkty → grupy `{ powod, ile, celowo, produkty }`.
 *
 * `celowo` znaczy „tak ma byc, nie ma tu nic do zrobienia". Rozstrzyga SAMA POZYCJA, a nie
 * tresc powodu: grupa jest celowa dokladnie wtedy, gdy ANI JEDNA jej pozycja nie jest robota.
 * Pyta o to `czyPominietyCelowo` z `domain/wzor-z-produktu.js` — ta sama warstwa, ktora
 * rozstrzyga o zakladaniu wzoru, nie druga jej kopia.
 *
 * ⚠️ DO 2026-08-11 STALA TU BIALA LISTA KANALOW („celowe = nie ze sklepu"), i to bylo za waskie.
 * Pomiar na produkcyjnej bazie pokazal 13 pozycji ZE SKLEPU, ktore wzorami nie beda nigdy
 * (`Projekt indywidualny` — 12 wariantow rozniacych sie sama cena — i zaslepka panelu ofert).
 * Lezaly na gorze ekranu jako robota i udawaly usterke, ktorej naprawic sie nie da.
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
 * liscie sortowania w db/magazyn.js.
 */
export function grupujPominiete(produkty, kanalySklepow) {
  wymagajListyKanalow(kanalySklepow);
  const grupy = new Map();
  for (const p of produkty ?? []) {
    const powod = String(p?.powod ?? '');
    if (!grupy.has(powod)) grupy.set(powod, []);
    grupy.get(powod).push(p);
  }

  return [...grupy.entries()]
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
    .sort((a, b) => Number(a.celowo) - Number(b.celowo)
      || b.ile - a.ile
      || a.powod.localeCompare(b.powod, 'pl'));
}
