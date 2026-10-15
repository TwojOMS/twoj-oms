// KTO WYKONUJE BIEZACE ZADANIE (spec 2026-09-12, §9).
//
// ⚠️ DLACZEGO AsyncLocalStorage, A NIE PARAMETR. `dopiszLog` ma 194 wywolania, z czego 102
// w trasach. Dolozenie parametru znaczyloby 102 reczne poprawki przy okazji zmiany
// uwierzytelniania — a jedno pominiete miejsce to wpis historii, ktory MILCZY o autorze,
// wygladajac dokladnie tak, jak wpis sprzed wdrozenia. Zadna suita tego nie zlapie.
// Kontekst jest jedna linia w haku i zero linii w wywolaniach.
//
// ⚠️ POZA ZADANIEM (czuwacze, zegary, skrypty) kontekstu NIE MA — i to jest odpowiedz
// „automat", a nie „nieznany". Rozroznienie ma znaczenie: puste `kto` znaczy WYLACZNIE
// „wpis sprzed wdrozenia kont", i tylko takie wpisy rysuja sie jako „—".

import { AsyncLocalStorage } from 'node:async_hooks';

const magazyn = new AsyncLocalStorage();

/** Uruchamia `fn` tak, by wszystko w jej środku wiedziało, kto to robi. */
export function wKontekscie(kto, fn) {
  return magazyn.run({ kto: kto ?? null }, fn);
}

/** Imię osoby wykonującej bieżące żądanie albo `null` poza żądaniem. */
export function ktoTeraz() {
  return magazyn.getStore()?.kto ?? null;
}
