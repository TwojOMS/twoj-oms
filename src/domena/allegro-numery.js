// CZY PYTAC ALLEGRO O NUMERY LISTOW TEGO ZAMOWIENIA (25.08.2026).
//
// Numer listu paczki nadanej w panelu Allegro panel wylacznie CZYTA
// (services/przesylki-allegro.js) — przy otwarciu karty, bo zapytania zbiorczego Allegro
// nie ma, a poller chodzacy po wszystkich zamowieniach robilby jedno zadanie NA KAZDE
// otwarte zamowienie w KAZDYM przebiegu. Koszt ograniczony UWAGA CZLOWIEKA.
//
// ⚠️⚠️ DO 25.08.2026 WARUNEK BRZMIAL SAMO „dopoki zamowienie nie ma `wyslane_at`" i gubil
// numery. Zmierzone na produkcji: 22 zamowienia Allegro oznaczone jako wyslane nie mialy
// w panelu ANI JEDNEJ przesylki, a numery po stronie Allegro byly.
//
// Wzorcowy przypadek — zamowienie 1207: przesylka powstala w Allegro o 09:11:40, czlowiek
// oznaczyl zamowienie jako wyslane o 09:12. DWADZIESCIA SEKUND. Okno zamknelo sie, zanim
// ktokolwiek otworzyl karte. Ograniczenie bylo opisane, ale WASKO — jako „dosylka nadana
// po oznaczeniu wysylki nie dojdzie" — podczas gdy w praktyce zjadalo takze numer PIERWSZEJ
// paczki, gdy operator klika szybciej, niz panel zdazy zajrzec.

import { dniKalendarzowe } from './etap-przesylki.js';

/**
 * ⚠️ OKNO ISTNIEJE PO TO, ZEBY ARCHIWUM NIE WALILO W API ALLEGRO. Bez gornej granicy
 * kazde otwarcie starej karty (reklamacja, faktura, przegladanie historii) znaczyloby
 * jedno `GET /order/checkout-forms/{id}/shipments` — czyli dokladnie ten koszt, przed
 * ktorym broni komentarz przy trasie. Trzydziesci dni z ogromnym zapasem pokrywa realny
 * rozjazd: numer pojawia sie u Allegro w godzinach od nadania, nie w tygodniach.
 */
export const OKNO_DOPYTANIA_PO_WYSLANIU_DNI = 30;

/**
 * @param z            wiersz `zamowienia` (kanal sprawdza WOLAJACY — `czyKanalAllegro`)
 * @param maPrzesylke  czy zamowienie ma juz JAKAKOLWIEK przesylke
 * @param teraz        ISO chwili biezacej
 */
export function wartoPytacAllegroONumery(z, { maPrzesylke = false, teraz } = {}) {
  if (!z) return false;

  // Zamowienie W TOKU pytamy jak dotad — takze gdy paczka juz jest, bo dosylka do zamowienia,
  // ktore wisi na liscie roboczej, ma sie dociagnac. To zachowanie sprzed zmiany, nietkniete.
  if (!z.wyslane_at) return true;

  // ⚠️ PO WYSLANIU PYTAMY WYLACZNIE, GDY NIE MAMY NIC. Numer, ktory juz mamy, jest
  // odpowiedzia ostateczna — nie zmienia sie w zyciu paczki. Pytanie „zawsze po wyslaniu"
  // przywrociloby nieograniczony ruch, przed ktorym broni okno nizej.
  //
  // Skutek uboczny, SWIADOMY: dosylka nadana po oznaczeniu wysylki nadal nie dojdzie, jesli
  // pierwsza paczka jest juz zapisana. To zostaje znanym ograniczeniem — zamykamy dziure,
  // ktora gubila numer JEDYNEJ paczki, a nie te, ktora gubi DRUGA.
  if (maPrzesylke) return false;

  const dni = dniKalendarzowe(z.wyslane_at, teraz);
  // ⚠️ `dniKalendarzowe` oddaje 0 takze dla daty NIEPARSOWALNEJ. Sam wynik nie odroznia
  // wiec „wyslane przed chwila" od „smiec w kolumnie", a te dwa przypadki maja rozne
  // odpowiedzi: smiec bez tego sprawdzenia pytalby BEZ KONCA, przy kazdym otwarciu karty
  // i wlasnie w archiwum.
  if (!Number.isFinite(Date.parse(z.wyslane_at ?? ''))) return false;
  return dni <= OKNO_DOPYTANIA_PO_WYSLANIU_DNI;
}
