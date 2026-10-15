// Zapytania zasilające pola wyboru nad tabelą zamówień (domain/filtry-listy.js).
//
// ⚠️ To JEDYNE miejsce, gdzie filtr dotyka bazy — samo filtrowanie dzieje się w warstwie
// czystej, na tablicy już wczytanej dla listy. Powód jest ten sam, co przy licznikach
// w panelu bocznym (przewodnik OMS, 4.1): status i metoda wysyłki są wartościami
// WYLICZANYMI (fakty + ręczne nadpisania), więc powtórzenie tych reguł w SQL-u rozjechałoby
// się z tym, co widać w wierszu, przy pierwszej zmianie reguły.
//
// Lista metod płatności jest wyjątkiem, bo to zwykła kolumna tekstowa ze sklepu — nic tu
// nie ma czego wyliczać, a przelecenie po wszystkich zamówieniach w JS tylko po to, żeby
// zebrać kilka nazw, byłoby robotą bez powodu.

/**
 * Nazwy metod płatności FAKTYCZNIE występujące w zamówieniach — do pola wyboru nad tabelą.
 *
 * Lista pochodzi z bazy, a nie ze stałej w kodzie, i to jest celowe: sklep dokłada bramki
 * bez pytania nas o zdanie (Przelewy24 czekają na PRO z zainstalowaną wtyczką bez kluczy),
 * a wpisana na sztywno lista milcząco przestałaby obejmować nową metodę — czyli filtr
 * pokazywałby komplet, którym nie jest.
 */
export function metodyPlatnosciWBazie(db) {
  return db.prepare(
    "SELECT DISTINCT metoda_platnosci AS m FROM zamowienia"
    + " WHERE metoda_platnosci IS NOT NULL AND TRIM(metoda_platnosci) <> ''"
    + ' ORDER BY m COLLATE NOCASE',
  ).all().map((w) => w.m);
}
