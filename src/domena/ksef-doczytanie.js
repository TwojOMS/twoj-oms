// Czy przy otwarciu karty zapytać inFakt o numer KSeF TEJ jednej faktury.
//
// ⚠️ ISTNIEJE, BO DWA EKRANY POKAZYWAŁY CO INNEGO, I TO NIE BYŁ PRZYPADEK. Zakładka FAKTURY
// czyta inFakt NA ŻYWO przy każdym wejściu, więc numer widać tam około minuty po wysyłce. Karta
// zamówienia czyta `ksef_numer` z WŁASNEJ bazy, a to pole wypełnia wyłącznie czuwacz, który
// tyka CO GODZINĘ (oms/bootstrap.ts, ODSTEP_CZUWACZA_MS). Objaw: numer KSeF pojawiał się
// w panelu faktur szybko, a na karcie dużo później.
//
// ⚠️⚠️ GORSZY PRZYPADEK NIŻ OPÓŹNIENIE: DLA CZĘŚCI FAKTUR NUMER NIE PRZYSZEDŁBY NIGDY.
// Czuwacz pyta WYŁĄCZNIE o dwie grupy (domena/ksef-oczekiwanie.js): zamówienia z kanału
// Allegro i dokumenty, których wysyłkę do KSeF zlecił sam panel. Faktura sklepowa, która
// trafiła do KSeF inną drogą — bo ktoś kliknął wysyłkę w inFakcie albo poszła automatem
// inFaktu — nie dostawała numeru na karcie NIGDY. To ograniczenie zostaje w czuwaczu
// (pytanie o wszystkie to setki wywołań miesięcznie bez nowej informacji), a znosi je
// dopiero ta ścieżka: pytamy o dokument, na który CZŁOWIEK WŁAŚNIE PATRZY.
//
// ⚠️ TO JEST TEN SAM WZORZEC, CO NUMERY LISTÓW Z ALLEGRO NA KARCIE (moduly/zamowienia/karta.js):
// koszt ograniczony UWAGĄ CZŁOWIEKA, zero ruchu w tle. Różnica jest w dławiku — tam znacznik
// próby idzie do logu, bo kolumny nie ma; tutaj kolumna JEST i nazywa się
// `ksef_sprawdzona_at`. Czuwacz zapisuje ją przy każdym pytaniu, udanym czy nie, więc
// dostajemy dławik za darmo, bez nowej kolumny i bez wpisu do logu przy każdej odsłonie.

/**
 * Ile czekamy między pytaniami o TEN SAM dokument.
 *
 * ⚠️ DWIE MINUTY, A NIE GODZINA — i to jest cała różnica wobec czuwacza. inFakt nadaje numer
 * około minuty po przyjęciu zlecenia, więc próg krótszy niż to okno kazałby
 * pytać w kółko o dokument, który jeszcze numeru nie ma. Próg dłuższy znaczyłby, że człowiek
 * odświeża kartę i dalej widzi „brak”, choć numer jest już od minuty.
 *
 * ⚠️ Dławi TEMPO, nie CZAS ŻYCIA: karty faktur bez numeru można otwierać latami, ale
 * dwadzieścia razy F5 w minutę to JEDNO zapytanie do inFaktu.
 */
import { idDokumentu } from './dokument-programu.js';

export const PROG_DOCZYTANIA_KSEF_MS = 2 * 60 * 1000;

/**
 * @param faktura wiersz z `faktury` (moze byc `null` — zamowienie bez faktury)
 * @param teraz znacznik w ms
 */
export function czyDoczytacKsef(faktura, teraz = Date.now(), progMs = PROG_DOCZYTANIA_KSEF_MS) {
  // Bez uuid nie ma o co pytac: rezerwacja bez dokumentu to jeszcze nie faktura.
  if (!idDokumentu(faktura)) return false;
  // ⚠️ NUMER RAZ ZAPISANY KONCZY SPRAWE. Jest jedynym dowodem, ze dokument jest w KSeF, i nic
  // go nie unicestwia — wiec pytanie o niego drugi raz nie moze przyniesc nowej informacji.
  if (faktura.ksef_numer) return false;

  const ostatnie = Date.parse(faktura.ksef_sprawdzona_at ?? '');
  // Nigdy nie pytalismy (albo stempel jest uszkodzony) — pytamy. Brak informacji nie jest
  // powodem do milczenia; ta sama zasada, co przy `stanFaktury` i przy dlawiku Allegro.
  if (!Number.isFinite(ostatnie)) return true;

  return teraz - ostatnie >= progMs;
}
