import { wyliczStatus } from './status.js';
import { czyKanalAllegro } from './wysylka.js';

// Odesłanie statusu realizacji do Allegro. Osobna mapa i osobna decyzja niż `sync-sklep.js`,
// dokładnie tak, jak zapowiada komentarz w tamtym pliku: `completed` z WooCommerce nie znaczy
// u Allegro NIC, a `SENT` nie znaczy nic w sklepie.
//
// ⚠️ ALLEGRO ODBIJA STAN OMS-U, TAKŻE W TYŁ — decyzja właściciela z 05.08.2026, wprost:
// „taki status jak w OMS, taki w Allegro; wracam w OMS na NOWE, to w Allegro zmienia się na
// NOWE". Dlatego `nowe → NEW` JEST w tej mapie i musi w niej zostać. Reguła „nigdy wstecz"
// (`RANGA_REALIZACJI`), którą miała tu wcześniej ta wersja planu, blokowałaby dokładnie ten
// powrót — powstała z błędnego założenia, że etykieta kupiona w panelu Allegro sama
// podnosi status. NIE PODNOSI (potwierdzone przez właściciela).
//
// Anulowanie i zwrot NIE JADĄ — ta sama decyzja co przy sklepach. `CANCELLED` nie jest u Allegro
// statusem realizacji (rezygnacja to osobny proces), a „zwrot" w panelu bywa notatką operacyjną.
// ⚠️ Skutek do świadomej akceptacji: zamówienie anulowane albo zwrócone w OMS zostawia
// w Allegro OSTATNI wysłany status. To jedyne miejsce, w którym odbicie NIE jest wierne.
export const STATUS_ALLEGRO_DLA = {
  nowe: 'NEW',
  w_realizacji: 'PROCESSING',
  wyslane: 'SENT',
};

/**
 * Status realizacji, który należy WYSŁAĆ do Allegro — albo `null`, gdy nic nie trzeba robić.
 * Czysta decyzja: żadnego HTTP, żadnego zapisu, nigdy nie rzuca.
 */
export function statusDlaAllegro(z, stanWAllegro) {
  // ⚠️ `zrodlo_id` JEST WARUNKIEM, NIE OZDOBNIKIEM. To identyfikator zamówienia w Allegro
  // i jedyne, z czego wołający buduje ścieżkę `PUT /order/checkout-forms/{id}/fulfillment`.
  // Bez niego reguła oddawałaby „wyślij", a zapis poleciałby pod adres z `undefined`
  // w środku — czyli w cudze zamówienie albo w 404, zależnie od szczęścia.
  if (!z || !czyKanalAllegro(z) || !z.zrodlo_id) return null;
  // ⚠️ BRAK ARGUMENTU TO NIE JEST „Allegro nic nie powiedziało" — to jest „NIE PYTALIŚMY".
  // Rozróżnienie krytyczne: `null` (Allegro faktycznie nie ma statusu) pozwala wysłać,
  // `undefined` (nie zdążyliśmy odczytać) MUSI odmówić. Bez tego awaria odczytu wyglądałaby
  // jak czyste zamówienie i cofałaby status kupującemu.
  if (stanWAllegro === undefined) return null;
  // Anulowane nie dostaje NICZEGO: wysyłanie statusu realizacji do zamówienia, z którego
  // kupujący zrezygnował, jest w najlepszym razie bez sensu, a w najgorszym myli go co do
  // tego, czy paczka jedzie.
  if (z.anulowane) return null;

  const docelowy = STATUS_ALLEGRO_DLA[wyliczStatus(z)];
  // Brak wpisu = status, którego świadomie nie odsyłamy (anulowane, zwrot).
  if (!docelowy) return null;

  // ⚠️ JEDYNY WARUNEK POZA MAPĄ: nie wysyłamy tego, co w Allegro JUŻ JEST. To nie oszczędność
  // na żądaniach — kupujący widzi status realizacji u siebie, a powtórzone ustawienie tej samej
  // wartości to proszenie się o drugie powiadomienie przy każdym kliknięciu i przy każdym
  // ponowieniu. Ta sama zasada, którą `statusDlaSklepu` stosuje wobec `status_woo`.
  //
  // Porównanie jest RÓWNOŚCIĄ, nie kolejnością — bo odbicie ma być wierne w obie strony.
  // `stanWAllegro` MUSI pochodzić z odczytu na żywo: nasza kopia bywa nieaktualna na zawsze
  // (Allegro nie podbija `updatedAt` przy zmianie tego pola), więc porównanie z kolumną
  // POMIJAŁOBY wysyłki, które są potrzebne.
  return stanWAllegro === docelowy ? null : docelowy;
}

/**
 * Czy ŚWIEŻY ODCZYT dowodzi, że rozjazdu z Allegro NIE MA — czyli że stan docelowy jest
 * już osiągnięty. Czysta decyzja, żadnego HTTP, nigdy nie rzuca.
 *
 * ⚠️ TO NIE JEST NEGACJA `statusDlaAllegro`. Ta funkcja oddaje `null` z SZEŚCIU różnych
 * powodów, a tylko JEDEN z nich cokolwiek dowodzi. „Anulowane", „zwrot", „nie pytaliśmy"
 * i „brak wpisu w mapie" znaczą wyłącznie tyle, że niczego nie wysyłamy — o tym, co
 * naprawdę stoi w Allegro, nie mówią NIC.
 *
 * Po co to istnieje (K2, recenzja Partii 1 Planu B): nieudany sync zostawia ślad
 * (`sync_woo_blad`), a komunikat na karcie podpowiada człowiekowi, żeby ustawił status
 * ręcznie w panelu Allegro. Kiedy to zrobi i kliknie „Wyślij ponownie", nie ma już czego
 * wysyłać — i bez tej funkcji ślad zostawał na karcie NA ZAWSZE (jedynym wyjściem był
 * ręczny UPDATE w pliku SQLite, czyli dokładnie stan bez wyjścia z niezmiennika 4.9).
 *
 * ⚠️ Odpowiednika dla SKLEPÓW celowo nie ma i mieć nie może: tam porównanie idzie
 * z kolumną `status_woo`, czyli z naszą KOPIĄ, która bywa nieaktualna. Tutaj `stanWAllegro`
 * pochodzi z odczytu na żywo tuż przed decyzją — i to jest cała różnica.
 */
export function stanAllegroPotwierdzaZgodnosc(z, stanWAllegro) {
  if (!z || !czyKanalAllegro(z) || !z.zrodlo_id) return false;
  // „Nie pytaliśmy" (`undefined`) nie jest dowodem na nic — patrz komentarz wyżej.
  if (stanWAllegro === undefined) return false;
  if (z.anulowane) return false;
  const docelowy = STATUS_ALLEGRO_DLA[wyliczStatus(z)];
  if (!docelowy) return false;
  return stanWAllegro === docelowy;
}
