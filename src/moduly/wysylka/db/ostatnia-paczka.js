// src/moduly/wysylka/db/ostatnia-paczka.js
//
// JEDNA klauzula SQL wybierająca „tę paczkę, która rządzi rozliczeniem” — współdzielona
// przez trzech czytelników: czuwacza pobrań (services/oznaczanie-pobran.js), pas długów
// (moduly/faktury/services/faktury-widok.js) i kandydatów ostrzeżenia o zwróconym pobraniu
// (src/oms/db/ostrzezenia.js).
//
// ⚠️ MIESZKA W WARSTWIE `db/`, A NIE W SERWISIE, I TO JEST TREŚĆ TEGO PLIKU. Dawniej
// definicja stała w services/oznaczanie-pobran.js, więc czytelnik z warstwy `db/` — zapytanie
// ostrzeżeń — musiałby importować Z SERWISU: odwrotnie niż zwykły kierunek serwis → `db/`
// i pierwszy krok do cyklu: wystarczyłoby, żeby oznaczanie-pobran kiedykolwiek sięgnęło po
// ostrzeżenia. Klauzula jest SQL-em, więc warstwa `db/` jest jej właściwym miejscem, a nie kompromisem.
//
// ⚠️ Dlaczego „najnowsze zdarzenie”, a nie „którakolwiek doręczona” — przy pierwszym czytelniku
// (services/oznaczanie-pobran.js, komentarz nad `KANDYDACI`); ograniczenie porządku — w docblocku niżej.

/**
 * DOKŁADNIE JEDNA PACZKA NA ZAMÓWIENIE — ta z najnowszym zdarzeniem u kuriera.
 *
 * ⚠️ EKSPORTOWANE, ŻEBY KOLEJNY CZYTELNIK PACZEK NIE MIAŁ WŁASNEJ KOPII TEJ REGUŁY. Czytelnik,
 * który mówi o paczkach coś innego niż czuwacz, byłby gorszy niż brak odczytu: człowiek
 * podejmowałby decyzje na podstawie zdania, którego wykonanie nie potwierdzi. Klauzula ma być
 * JEDNA, a nie dwie wyglądające tak samo w dniu napisania.
 *
 * ⚠️ DRUGIM CZYTELNIKIEM JEST PAS DŁUGÓW (`POBRANIA_PRZESYLKI` w
 * moduly/faktury/services/faktury-widok.js). Dawniej miał WŁASNĄ, przepisaną kopię tej klauzuli — mimo że komentarz obok
 * obiecywał „klauzula ma być JEDNA”. Teraz naprawdę jest jedna.
 *
 * ⚠️⚠️ `ORDER BY` PORÓWNUJE NAPISY W RÓŻNYCH FORMATACH — świadomie i z ograniczeniem, które
 * trzeba znać. `status_kuriera_at` zapisujemy tak, jak oddaje je kurier: DPD `eventTime` BEZ
 * strefy (`2026-08-25T14:00:00.000`), Allegro z `Z`, InPost z offsetem (`+02:00`). Porównanie
 * leksykograficzne jest więc porządkiem kalendarza WYŁĄCZNIE w obrębie jednego kuriera. Na
 * zamówieniu WIELOPACZKOWYM MIESZAJĄCYM kurierów „najnowsze zdarzenie" może wskazać nie tę
 * paczkę (napisy różnią się już na pozycji strefy, a nie na cyfrach daty). Nie przebudowujemy
 * tego tutaj: normalizacja stempli dotyka zapisu statusów wszystkich trzech kurierów i jest
 * osobną decyzją. Remis (oba stemple puste albo równe) rozstrzyga `kolejnosc DESC` — wygrywa
 * paczka nadana później.
 *
 * Wymaga aliasu `z` na `zamowienia` po stronie wołającego i daje alias `p`.
 */
export const OSTATNIA_ZYWA_PACZKA = `
  LEFT JOIN przesylki p ON p.id = (
    SELECT p2.id FROM przesylki p2
     WHERE p2.zamowienie_id = z.id AND p2.status <> 'blad'
     ORDER BY COALESCE(p2.status_kuriera_at, '') DESC, p2.kolejnosc DESC LIMIT 1)
`;

