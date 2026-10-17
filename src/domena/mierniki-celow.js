// JEDNO AUTORYTATYWNE MIEJSCE, W KTORYM STOI, SKAD BIERZE SIE LICZBA NA KAFLU.
//
// Wzorzec swiadomie zerzniety z domain/ekrany.js: jedna lista, fail-closed. Tam lista
// ekranow karmi straznika i pasek ikon; tu lista miernikow karmi pomiar i formularz celu.
// W obu wypadkach rozjazd dwoch list jest niewidoczny do pierwszej awarii.
//
// ⚠️ ETAP 1 NIE MA ANI JEDNEGO AUTOMATU — decyzja właściciela z 13.09.2026, i to jest decyzja,
// nie zapomnienie. Powod stoi w specyfikacji: lustro sklepu (`produkty_sklepowe`) NIE WIE,
// kiedy produkt sie pojawil, bo `odczytane_at` jest nadpisywane przy kazdym odswiezeniu
// (`zapiszProduktSklepowy` robi ON CONFLICT DO UPDATE po wszystkich kolumnach lustra).
// Pytanie „ile nowych produktow w tym tygodniu" nie ma dzis w bazie odpowiedzi ani na przod,
// ani wstecz — automat produktow wymaga najpierw nowej kolumny w lustrze. To Etap 2.
//
// ⚠️ DOLOZENIE AUTOMATU to JEDNA pozycja w tej mapie. Bez migracji, bez zmian w widoku
// i bez dotykania `postepCelu` — o ile `policz` dotrzyma kontraktu ponizej.

/**
 * Kontrakt funkcji `policz`:
 *   policz(db, { od, do }) → { ile: number, zrodloAt: string|null } | null
 *
 * `ile`      — ile zdarzen/sztuk w tym zakresie dni.
 * `zrodloAt` — znacznik swiezosci ZRODLA (np. `odczytane_at` lustra), NIE czas wywolania.
 *              `null` znaczy „zrodlo nie starzeje sie" i wymaga `progSwiezosciH === null`;
 *              prog bez znacznika to miernik, ktory nie umie powiedziec, jak stara jest
 *              jego liczba — `postepCelu` traktuje go jako ZEPSUTY, nie swiezy.
 * `null`     — „nie umiem policzyc". Oddaje sie go zamiast zera, bo zero to odpowiedz,
 *              a brak odpowiedzi odpowiedzia nie jest.
 *
 * `progSwiezosciH` — po ilu godzinach od `zrodloAt` liczba staje sie `nieswieza`.
 *                    `null` = nie starzeje sie.
 */
export const MIERNIKI = {
  reczny: {
    etykieta: 'Ręcznie',
    // null = zrodlem sa zdarzenia z `cele_zdarzenia` (SUM po okresie), nie funkcja.
    policz: null,
    // Recznego nie da sie „zestarzec": to fakt wpisany przez czlowieka, a nie odczyt
    // z systemu, ktory mogl przestac odpowiadac.
    progSwiezosciH: null,
  },
};

/**
 * Opis miernika albo `null`, gdy klucza nie ma w rejestrze.
 *
 * ⚠️ `hasOwnProperty`, NIE `MIERNIKI[klucz]`. Gole indeksowanie oddaje dla 'constructor'
 * i 'toString' funkcje z prototypu Object — czyli obiekt z `policz === undefined`, ktory
 * przeszedlby dalej jako „miernik bez funkcji liczacej", czyli jako RECZNY. Cel z takim
 * kluczem pokazywalby sume zdarzen (zero) i wygladal na zaniedbany, bez ani jednego bledu.
 */
export function miernik(klucz) {
  if (typeof klucz !== 'string') return null;
  return Object.prototype.hasOwnProperty.call(MIERNIKI, klucz) ? MIERNIKI[klucz] : null;
}

/** Lista do `<select>` w formularzu celu. Wyprowadzona z mapy, zeby nie mogla sie rozjechac. */
export const KLUCZE_MIERNIKOW = Object.entries(MIERNIKI)
  .map(([klucz, opis]) => ({ klucz, etykieta: opis.etykieta }));
