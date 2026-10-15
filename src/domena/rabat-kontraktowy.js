import { parsujRabat } from './rabat.js';

// Stawka rabatu, ktora NALEZY SIE klientowi z umowy — i decyzja, co z nia zrobic wobec
// stawki juz wpisanej na zamowieniu (2026-08-23).
//
// ⚠️ POWOD ISTNIENIA: rabat 40% klienta hurtowego byl wpisany w dwoch miejscach naraz i dzialal
// wylacznie wtedy, gdy operator kliknal „Wstaw dane klienta". Dwa z trzech sierpniowych
// zamowien tego klienta stanely po cenie KATALOGOWEJ — faktura zbiorcza bylaby zawyzona
// o 69,56 zl. Stawka umowna nie moze zalezec od pamieci czlowieka.
//
// ⚠️ MODUL JEST CZYSTY: bez bazy, bez konfiguracji, bez zegara. Dostaje gotowy wiersz klienta
// i oddaje liczbe oraz nazwe decyzji. Wyszukanie klienta robi serwis, przecenianie pozycji —
// services/rabat.js.

/**
 * @param {{klientBazy: object|null}} zrodla
 * @returns {{procent: number, zrodlo: 'baza'|'brak'}}
 *
 * ⚠️ POLE `rozjazd` ODESZLO 2026-08-24 RAZEM Z `OMS_KLIENCI_ZBIORCZY`. Do tego dnia stawka
 * stala w dwoch miejscach naraz (baza i `.env`), wiec ta funkcja oddawala rozjazd, a karta
 * pokazywala pas bez przycisku — naprawa nie byla w zasiegu ekranu. Zrodlo jest teraz JEDNO
 * (karta klienta), wiec nie ma dwoch liczb do uzgadniania.
 *
 * ⚠️ NIE MYLIC z pasem rozjazdu, ktory ZOSTAL: tamten porownuje stawke UMOWY ze stawka
 * wpisana NA ZAMOWIENIU (`decyzjaRabatu` -> 'ostrzez') i mowi o czyms zupelnie innym.
 */
export function stawkaKontraktowa({ klientBazy } = {}) {
  return {
    procent: parsujRabat(klientBazy?.rabat_procent ?? 0),
    zrodlo: klientBazy ? 'baza' : 'brak',
  };
}

/**
 * Co zrobic ze stawka umowna wobec rabatu, ktory JUZ jest na zamowieniu.
 *
 * Reguly sprawdzane PO KOLEI, pierwsza pasujaca wygrywa:
 *   0. klienta nie ma w bazie            -> 'nic'      (nie ma umowy, nie ma czego porownywac)
 *   1. zamowienie ma 0%, umowa cos daje  -> 'ustaw'    (i przelicz pozycje)
 *   2. stawki sie roznia                 -> 'ostrzez'  (uzgodnienie czlowieka wygrywa)
 *   3. reszta                            -> 'nic'
 *
 * ⚠️ KOLEJNOSC 1 PRZED 2 JEST WARUNKIEM DZIALANIA: przypadek 1. spelnia tez warunek 2.,
 * wiec odwrotna kolejnosc znaczylaby, ze rabat NIGDY nie wchodzi sam.
 *
 * ⚠️ REGULA 0 ISTNIEJE, ZEBY PASEK NIE WYL PRZY DOBRYCH DANYCH. Bez niej zamowienie
 * z rabatem 25% dla klienta spoza umowy (stawka 0) spelnialoby warunek 2. i zapalalo
 * ostrzezenie za kazdym razem — a ostrzezenie wyjace zawsze przestaje znaczyc cokolwiek
 * (ta sama lekcja, co przy `podejrzanyBrakTagu` w raportach).
 */
export function decyzjaRabatu({ rabatZamowienia, stawka } = {}) {
  if (!stawka || stawka.zrodlo !== 'baza') return 'nic';
  const nazamowieniu = parsujRabat(rabatZamowienia ?? 0);
  if (nazamowieniu === 0 && stawka.procent > 0) return 'ustaw';
  if (nazamowieniu !== stawka.procent) return 'ostrzez';
  return 'nic';
}
