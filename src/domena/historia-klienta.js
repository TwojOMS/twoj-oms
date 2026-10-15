import { grosze } from './kwoty.js';
import { wyliczStatus } from './status.js';

// PODSUMOWANIE HISTORII STALEGO KLIENTA (21.08.2026) — trzy liczby nad tabela zamowien
// na karcie klienta: ile ich bylo, na ile i kiedy ostatnie.
//
// ⚠️ MODUL JEST CZYSTY: dostaje gotowa liste naglowkow zamowien (db/zamowienia.js:
// `zamowieniaPoNip`) i niczego nie pyta bazy. Dzieki temu regule „co wchodzi do sumy"
// da sie sprawdzic testem bez zakladania zamowien.

/**
 * ⚠️⚠️ ANULOWANE NIE WCHODZI DO SUMY, ale WCHODZI DO LICZNIKA — i to nie jest niekonsekwencja.
 * „Klient zamowil u nas dziewiec razy" jest prawda takze wtedy, gdy jedno z zamowien
 * anulowal; „klient zostawil u nas X zlotych" przestaje byc prawda, gdy do X wliczyc
 * zamowienie, ktorego nigdy nie zaplacil. Anulowane liczy sie wiec OSOBNO i ekran pisze
 * o nich wprost — cicho pominiete wygladalyby jak brak zamowien.
 *
 * ⚠️ SUMA JEST BRUTTO I NIE ODEJMUJE ZWROTOW. Zwrot bywa czesciowy i ma wlasna kwote
 * (tabela `zwroty`); odjecie go tutaj wymagaloby drugiego zrodla i drugiej reguly obok
 * rachunku zarzadczego, ktory juz to robi. Zamowienie ze zwrotem ma na liscie status
 * „Zwrot", wiec fakt nie ginie — a podpis nad kwota mowi, co ta liczba znaczy.
 *
 * ⚠️ PIENIADZE PRZEZ `grosze` Z DOMENY, nigdy `Number(...)` na napisie: kwoty leza
 * w bazie napisami i sumowanie ich zmiennoprzecinkowo rozjezdza sie o grosze przy
 * kilkunastu zamowieniach (przewodnik OMS, 4.5).
 */
export function podsumowanieHistorii(zamowienia) {
  const lista = zamowienia ?? [];
  const anulowane = lista.filter((z) => wyliczStatus(z) === 'anulowane');
  const liczone = lista.filter((z) => wyliczStatus(z) !== 'anulowane');
  const sumaGrosze = liczone.reduce((s, z) => s + grosze(z.kwota_brutto, 'kwota_brutto'), 0);
  // ⚠️ MAKSIMUM I MINIMUM Z LISTY, a nie „pierwszy i ostatni wiersz". Porzadek ustala
  // zapytanie i moze sie zmienic; data ostatniego zamowienia nie ma prawa zalezec od
  // `ORDER BY` w innym pliku.
  const daty = lista.map((z) => z.utworzone_at).filter(Boolean).sort();
  return {
    ile: lista.length,
    ileAnulowanych: anulowane.length,
    sumaGrosze,
    pierwsze: daty[0] ?? null,
    ostatnie: daty[daty.length - 1] ?? null,
  };
}
