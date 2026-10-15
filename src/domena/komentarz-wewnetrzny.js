import { bladOperatora } from './bledy.js';

// KOMENTARZ WEWNĘTRZNY przy zamówieniu (21.08.2026, prośba właściciela: „opcja komentarz
// wewnętrzny w OMS — klient go nie widzi, tylko do wewnętrznego wglądu").
//
// ⚠️ TO JEST DRUGA STRONA „UWAG KLIENTA", A NIE ICH ODMIANA. `zamowienia.uwagi` to
// `customer_note` z Woo — zapis tego, co napisał KLIENT, tylko do odczytu i przepisywany
// przez pollera przy każdej synchronizacji. Ten komentarz jest NASZ: pisze go operator,
// sklep o nim nie wie i wiedzieć nie ma. Stąd osobna kolumna, a nie doklejanie do tamtej —
// dopisek w kolumnie sklepowej zniknąłby przy najbliższym przebiegu pollera, po cichu.
//
// ⚠️ NIE OPUSZCZA PANELU i to jest cała jego treść. Nie jedzie na fakturę (domain/
// pozycje-faktury.js), nie jedzie na specyfikację do paczki, którą czyta klient
// (domain/specyfikacja.js), nie jedzie do sklepu ani do Allegro. Każde z tych miejsc składa
// swoją treść z nazwanych pól, więc nowa kolumna nie ma jak do nich wpaść sama — i są na to
// testy, bo „nie ma jak" bywa prawdą tylko do najbliższej zmiany.

// Górna granica. Nie jest to ograniczenie techniczne (SQLite przyjmie megabajt), tylko
// obrona przed wklejeniem całej korespondencji: pole ma nieść notatkę, a nie archiwum.
export const MAX_ZNAKOW = 4000;

/**
 * Komentarz gotowy do zapisu: `null` znaczy „skasuj notatkę", napis znaczy „zapisz ten".
 *
 * ⚠️ PUSTY NAPIS KASUJE i to jest zamierzone — inaczej raz założonej notatki nie dałoby się
 * zdjąć inaczej niż zapisem spacji, która wygląda jak notatka i nią nie jest.
 *
 * Końce linii normalizujemy do `\n`, bo przeglądarka odsyła z `<textarea>` CRLF-y: bez tego
 * ten sam tekst zapisany dwa razy różniłby się bajtami, a licznik znaków liczyłby niewidzialne
 * `\r` do limitu.
 */
export function znormalizujKomentarz(tekst) {
  if (tekst == null) return null;
  const czysty = String(tekst).replace(/\r\n?/g, '\n').trim();
  if (czysty === '') return null;
  if (czysty.length > MAX_ZNAKOW) {
    throw bladOperatora(
      `Komentarz wewnętrzny ma ${czysty.length} znaków, a mieści się ${MAX_ZNAKOW}. `
      + 'Skróć go albo załóż sprawę w Asanie i zostaw tu sam odnośnik.',
    );
  }
  return czysty;
}
