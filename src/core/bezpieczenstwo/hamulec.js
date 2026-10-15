// Hamulec na powtarzane proby logowania.
//
// Po co, skoro panel stoi w LAN-ie. Basic Auth ma wbudowany koszt zgadywania: kazda proba
// to nowe okienko przegladarki, wiec nikt nie zgaduje hasla recznie. Formularz tego kosztu
// NIE MA — jest polem tekstowym, do ktorego skrypt wrzuca tysiac hasel na minute. Bez
// hamulca zamiana okienka na ekran logowania byloby wiec ulatwieniem takze dla zgadujacego.
//
// Dlaczego w pamieci, a nie w bazie. Licznik zyje minute i nie ma znaczenia po restarcie —
// zapis do SQLite przy KAZDEJ nieudanej probie dokladalby operacje dyskowa dokladnie w tym
// miejscu, w ktorym zgadujacy chcialby nam jej narobic najwiecej.

export const LIMIT_PROB = 5;
export const KARA_MS = 60_000;

/**
 * Tworzy hamulec. Kazde wywolanie daje WLASNY licznik — testy nie moga sobie nawzajem
 * przestawiac stanu, a dwie uslugi w jednym procesie nie dziela kary.
 *
 * `teraz` jest wszedzie parametrem, a nie odczytem zegara w srodku: inaczej test na
 * wygasniecie kary musialby naprawde spac minute.
 */
export function utworzHamulec({ limit = LIMIT_PROB, karaMs = KARA_MS, wygasanieMs = null, maksKluczy = null } = {}) {
  const liczniki = new Map();

  // PRZ-069 (recenzja D8 r1, P3-3): OPCJONALNE wygasanie i limit kluczy — dla /haslo/:token. Bez opcji
  // (logowanie) zachowanie jak dotad: licznik zyje do udanego logowania, a po karze kazda kolejna pomylka
  // od razu zapala nastepna. Z `wygasanieMs` wpis bez kary, ktorego ostatnia proba jest starsza niz
  // `wygasanieMs`, znika — licznik startuje od zera. `maksKluczy` przycina mape: najpierw martwe wpisy,
  // potem najdawniej uzywane (Map trzyma kolejnosc wstawienia, a kazdy blad przesuwa wpis na koniec).
  const martwy = (wpis, teraz) => wygasanieMs !== null && wpis.doKiedy <= teraz && teraz - wpis.ostatnia >= wygasanieMs;
  const zywy = (klucz, teraz) => {
    const wpis = liczniki.get(klucz);
    if (wpis && martwy(wpis, teraz)) { liczniki.delete(klucz); return undefined; }
    return wpis;
  };
  const przytnij = (teraz) => {
    if (maksKluczy === null || liczniki.size <= maksKluczy) return;
    for (const [k, w] of liczniki) if (martwy(w, teraz)) liczniki.delete(k);
    while (liczniki.size > maksKluczy) liczniki.delete(liczniki.keys().next().value);
  };

  return {
    /**
     * Czy wolno probowac. Zwraca `{ wolno, zostaloMs }` — `zostaloMs` jest po to, zeby
     * ekran mogl powiedziec „sprobuj za 40 sekund" zamiast bezradnego „za duzo prob".
     */
    sprawdz(klucz, teraz = Date.now()) {
      const wpis = zywy(klucz, teraz);
      if (!wpis || wpis.doKiedy <= teraz) return { wolno: true, zostaloMs: 0 };
      return { wolno: false, zostaloMs: wpis.doKiedy - teraz };
    },

    /**
     * Odnotowuje nieudana probe. Kara zapala sie dopiero przy `limit`-tej z rzedu.
     *
     * ⚠️ Kara LICZY SIE OD OSTATNIEJ PROBY, nie od pierwszej. Inaczej zgadujacy czekalby
     * minute raz, a potem mial darmowe proby az do konca okna — czyli hamulec spowalnialby
     * go jednorazowo zamiast stale.
     */
    odnotujBlad(klucz, teraz = Date.now()) {
      const wpis = zywy(klucz, teraz) ?? {
        proby: 0, doKiedy: 0, zapisanoBlokade: false,
      };
      wpis.proby += 1;
      wpis.ostatnia = teraz;
      liczniki.delete(klucz); // na koniec kolejnosci — przycinanie usuwa najdawniej uzywane
      if (wpis.proby >= limit) {
        wpis.doKiedy = teraz + karaMs;
        // Nowa kara — jeszcze niezapisana. Bez tego resetu druga kara tego samego klucza
        // (po wygasnieciu pierwszej i piatej kolejnej pomylce) nie napisalaby juz ani
        // jednego wiersza „zablokowane”, bo `zapisanoBlokade` zostaloby z poprzedniej kary.
        wpis.zapisanoBlokade = false;
      }
      liczniki.set(klucz, wpis);
      przytnij(teraz);
      return wpis.proby;
    },

    /**
     * Czy TERAZ nalezy zapisac do dziennika logowan wpis „zablokowane” dla tej kary.
     *
     * ⚠️⚠️ N1 (druga fala, recenzja 2026-09-12): PRZED ta funkcja logowanie.js pisalo jeden
     * taki wiersz na KAZDE zadanie, ktore trafialo na juz trwajaca kare — a trwa ona 60 s,
     * wiec pukanie skryptem dawalo setki wierszy na jedna kare (zmierzone: 291 zadan w 2 s =
     * 291 wierszy). Prawda WYLACZNIE dla pierwszego zadania po zapaleniu kary; kazde kolejne,
     * az do jej wygasniecia, dostaje `false` i nic nie zapisuje. Wolac WYLACZNIE gdy
     * `sprawdz` juz powiedzial `wolno: false` — inaczej nie ma czego oznaczac.
     */
    zapiszBlokadeRaz(klucz, teraz = Date.now()) {
      const wpis = liczniki.get(klucz);
      if (!wpis || wpis.doKiedy <= teraz) return false; // kara juz minela albo nie istnieje
      if (wpis.zapisanoBlokade) return false;
      wpis.zapisanoBlokade = true;
      return true;
    },

    /**
     * Kasuje licznik po udanym logowaniu.
     *
     * ⚠️ BEZ TEGO cztery pomylki w ciagu dnia i jedno poprawne haslo zostawialyby licznik
     * na czterech — a piata pomylka tydzien pozniej zapalalaby kare, ktorej nikt by nie
     * zrozumial. Udane logowanie jest dowodem, ze to nie zgadujacy.
     */
    wyczysc(klucz) {
      liczniki.delete(klucz);
    },

    /** Dla testow i diagnostyki — nie do pokazywania czlowiekowi. */
    proby(klucz) {
      return liczniki.get(klucz)?.proby ?? 0;
    },

    /** Dla testow — liczba kluczy w pamieci (PRZ-069: przycinanie przy `maksKluczy`). */
    rozmiar() {
      return liczniki.size;
    },
  };
}
