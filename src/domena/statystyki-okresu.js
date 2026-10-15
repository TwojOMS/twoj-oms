// MIANOWNIK CAŁEJ ZAKŁADKI STATYSTYKI — jedno miejsce, w którym powstaje odpowiedź na
// pytanie „które zamówienia w ogóle wchodzą na ten ekran". Trzy sekcje (wysyłka,
// terminowość, płatności) dostają TĘ SAMĄ listę; osobne filtrowanie w każdej z nich
// znaczyłoby trzy tabele, których sumy się nie zgadzają.
import { dzienWarszawa } from './format-daty.js';
import { anulowaneEfektywnie } from './status-reczny.js';
import { czyTestowe } from './sprzedaz-okresu.js';
import { listaZamowien } from '../oms/db/zamowienia.js';

const bezpiecznyJson = (s) => { try { return JSON.parse(s ?? '{}') ?? {}; } catch { return {}; } };

/**
 * Zamówienia okresu, gotowe do agregacji.
 *
 * ⚠️⚠️ ŹRÓDŁEM JEST `listaZamowien(db)` — DOKŁADNIE TEN SAM ODCZYT, KTÓRY RYSUJE LISTĘ
 * ZAMÓWIEŃ, i to jest treść poprawki krytycznej z 13.09.2026. Do tego dnia zakładka czytała
 * SUROWE KOLUMNY (`wierszeZamowien` w db/statystyki.js), a lista oddaje wartości EFEKTYWNE —
 * więc dwa ekrany panelu mówiły o tej samej paczce co innego:
 *
 *  - `oplacone_at` na liście POWSTAJE PRZY ODCZYCIE, z tabeli `platnosci`, z progiem „kwota
 *    oczekiwana od klienta" (zLinii w db/zamowienia.js; surowa kolumna leży obok jako
 *    `oplacone_at_sklep`). A `startZegara` w domain/termin-wysylki.js stoi właśnie na
 *    `oplacone_at`. Migracja `przeniesWplatyDoListy` (db/db.js) przy wpłacie ręcznej surową
 *    kolumnę ZERUJE, a `dodajWplateReczna` nigdy jej nie zapisuje — więc zamówienia opłacone
 *    przelewem zaksięgowanym ręcznie nie miały startu zegara wcale. Zmierzone: 16 z 132
 *    zamówień sierpnia (12% miesiąca) wypadało z obu procentów pod etykietą „bez daty startu
 *    zegara", która opisuje NIEOPŁACONĄ PRZEDPŁATĘ, czyli coś innego. Drugi tryb tej samej
 *    wady: przy dopłacie efektywna data pokrycia jest PÓŹNIEJSZA niż sklepowa, więc
 *    statystyka liczyła od wcześniejszej i schlebiała wynikowi.
 *  - `metoda_wysylki` i `pobranie` na liście też są efektywne (ręczna korekta z karty leży
 *    w `wysylka_reczna_json`), a rozkład przewoźników i rozkład metod płatności czytają
 *    właśnie te dwa pola.
 *
 * ⚠️⚠️ DLACZEGO WOŁAMY `listaZamowien`, A NIE LICZYMY POKRYCIA TUTAJ. Próg to
 * `kwotaOczekiwanaGrosze` (domain/suma-pozycji.js), która potrzebuje pozycji Z CENAMI,
 * ręcznych NADPISAŃ pozycji (`pozycje_reczne_json` + `nalozNadpisaniaPozycji`) ORAZ członu
 * różnicowego wysyłki (`koszt_dostawy_brutto` wobec `koszt_dostawy_brutto_sklep`, czyli
 * `wysylkaEfektywna`). Policzenie tego w tym pliku znaczyłoby przepisanie połowy `zLinii` —
 * czyli TRZECIĄ definicję opłacenia, dokładnie tę, przed którą ostrzega recenzja. Przy
 * wywołaniu `listaZamowien` definicja jest DOSŁOWNIE jedna i ekrany nie mają jak się
 * rozjechać: statystyka dostaje ten sam obiekt, który widzi wiersz tabeli.
 *
 * ⚠️ KOSZT JEST ZMIERZONY I ŚWIADOMY. `listaZamowien` pyta o wpłaty, przesyłki i fakturę
 * PER ZAMÓWIENIE (N+1), więc na bazie syntetycznej 226 zamówień kosztuje 88 ms wobec 1,8 ms
 * dawnego odczytu surowego, a przy 2000 zamówień 659 ms wobec 13 ms (pomiar 13.09.2026,
 * SQLite w pamięci). Bierzemy to, bo TEN SAM koszt płaci dziś lista zamówień pod `/` —
 * najczęściej odwiedzany ekran panelu — więc statystyki nie stawiają panelowi nowego
 * sufitu, tylko wchodzą pod ten, który już jest. Zawężenie odczytu (prefiks roku i miesiąca)
 * trzeba będzie zrobić RAZEM dla obu ekranów, gdy zamówień będzie 500 dziennie; zrobione
 * tylko tutaj rozdzieliłoby definicje z powrotem.
 *
 * ⚠️ `anulowaneEfektywnie`, `dzienWarszawa` i `czyTestowe` działają na wierszu po nakładce
 * tak samo, jak na surowym (idempotencja opisana przy `anulowaneWSklepie` w status-reczny.js):
 * `anulowane` jest już wartością efektywną, a sklepowa leży w `anulowane_sklep`.
 *
 * ⚠️ KOTWICĄ JEST DZIEŃ ZŁOŻENIA (`dzienWarszawa(utworzone_at)`) — dokładnie ta sama, którą
 * liczy `sprzedazWOkresie`. Decyzja właściciela z 13.09.2026: liczba zamówień w STATYSTYKACH ma się
 * zgadzać z RAPORTAMI co do sztuki, bo te ekrany będzie zestawiał. Kotwica po dacie WYSŁANIA
 * byłaby uczciwsza dla samej terminowości (procent nie rusza się po policzeniu), ale wsadzałaby
 * to samo zamówienie w inny miesiąc niż raport — 28171 złożone w lipcu, wysłane 4.08.
 *
 * ⚠️ GRANICA HISTORII (`granicaDla` w `sprzedazWOkresie`) TU NIE OBOWIĄZUJE i to jest świadome:
 * tamta reguła scala historię z Apilo z bieżącą sprzedażą, a historia (10 878 wierszy w
 * `sprzedaz_historyczna`) nie niesie ani przewoźnika, ani metody płatności, ani daty wysłania.
 * Nie ma tu czego scalać — liczą się wyłącznie wiersze OMS-u, od 3.07.2026.
 */
export function zamowieniaOkresu(db, { od, do: doDnia }, reguly = {}) {
  const wybrane = [];
  for (const w of listaZamowien(db)) {
    if (anulowaneEfektywnie(w)) continue;
    const dzien = dzienWarszawa(w.utworzone_at);
    if (!dzien || dzien < od || dzien > doDnia) continue;
    // ⚠️ POPRAWKA RĘCZNA WYGRYWA — tak samo jak przy każdym innym odczycie klienta.
    // Adres zmieniony na karcie leży w `klient_reczny_json`, nie w `klient_json`.
    const klient = { ...bezpiecznyJson(w.klient_json), ...bezpiecznyJson(w.klient_reczny_json) };
    const nazwa = `${klient.first_name ?? ''} ${klient.last_name ?? ''} ${klient.company ?? ''}`;
    if (czyTestowe(klient.email, nazwa, reguly)) continue;
    wybrane.push({ ...w, dzien });
  }
  return wybrane;
}
