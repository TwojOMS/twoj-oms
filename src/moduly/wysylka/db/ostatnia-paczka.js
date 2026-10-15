// src/oms/db/ostatnia-paczka.js
//
// JEDNA klauzula SQL wybierajaca „te paczke, ktora rzadzi rozliczeniem" — wspoldzielona
// przez czterech czytelnikow: czuwacza pobran (services/oznaczanie-pobran.js), pas dlugow
// (services/faktury-widok.js), skrypt sprzatajacy (services/sprzatanie-zaplat.js)
// i kandydatow ostrzezenia o zwroconym pobraniu (db/ostrzezenia.js).
//
// ⚠️ MIESZKA W WARSTWIE `db/`, A NIE W SERWISIE, I TO JEST TRESC TEGO PLIKU. Do 31.08.2026
// definicja stala w services/oznaczanie-pobran.js, wiec czwarty czytelnik — zapytanie
// z warstwy `db/` — musialby importowac Z SERWISU. Byl to jedyny taki import w repo
// (pozostale 35 modulow serwisow importuje z `db/`, nigdy odwrotnie) i pierwszy krok do
// cyklu: wystarczyloby, zeby oznaczanie-pobran kiedykolwiek siegnelo po db/ostrzezenia.js.
// Klauzula jest SQL-em, wiec warstwa `db/` jest jej wlasciwym miejscem, a nie kompromisem.
//
// ⚠️ Uzasadnienie samej reguly (dlaczego „najnowsze zdarzenie", a nie „ktorakolwiek
// doreczona") zostalo przy niej — patrz docblock nizej.

/**
 * DOKŁADNIE JEDNA PACZKA NA ZAMÓWIENIE — ta z najnowszym zdarzeniem u kuriera.
 *
 * ⚠️ EKSPORTOWANE, ŻEBY DRUGI CZYTELNIK PACZEK NIE MIAŁ WŁASNEJ KOPII TEJ REGUŁY. Skrypt
 * sprzątający (scripts/sonda-oznaczenia-zaplaty.mjs przez services/sprzatanie-zaplat.js)
 * pokazuje właścicielowi to samo, co robi ten skan — a wypis, który mówi o paczkach coś
 * innego niż czuwacz, byłby gorszy niż brak wypisu: człowiek zatwierdzałby zlecenia na
 * podstawie zdania, którego wykonanie nie potwierdzi. Klauzula ma być JEDNA, a nie dwie
 * wyglądające tak samo w dniu napisania. Uzasadnienie samej reguły — w komentarzu wyżej.
 *
 * ⚠️ TRZECIM CZYTELNIKIEM JEST PAS DŁUGÓW (`POBRANIA_PRZESYLKI` w services/faktury-widok.js).
 * Do 28.08.2026 miał WŁASNĄ, przepisaną kopię tej klauzuli — mimo że komentarz obok obiecywał
 * „klauzula ma być JEDNA". Teraz naprawdę jest jedna.
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

