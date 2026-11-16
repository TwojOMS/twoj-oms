import { statusBazowy } from './status.js';
import { czyKanalAllegro } from './wysylka.js';

// Odesłanie statusu do sklepu. Panel jest miejscem, w którym człowiek stwierdza, co się
// z zamówieniem stało — a sklep musi się o tym dowiedzieć, bo to on pisze do klienta
// i to w nim właściciel (i klient) szuka stanu zamówienia.
//
// ⚠️ WYZWALACZEM JEST FAKT WYSYŁKI, A NIE NADANIE PACZKI. Kiedyś nadanie paczki
// przestawiało zamówienie w sklepie na 'completed', ale etykieta drukuje się przy pakowaniu,
// a paczka jedzie dzień później. Status panelu wynikał wtedy z istnienia paczki i nie dało
// się go odczepić, więc odczepiony został sklep. Odkąd `wyslane_at` ustawia człowiek,
// wyzwalacz wrócił na właściwe miejsce: nie „powstała etykieta", tylko „człowiek powiedział,
// że paczka pojechała".
//
// Dlatego ta funkcja NIE JEST wołana z `services/nadanie.js` — wyłącznie stamtąd, gdzie
// zapisuje się fakt wysyłki.

// Mapa panel → sklep. Jeden wpis. Anulowanie i zwrot
// świadomie NIE jadą: `cancelled` i `refunded` w WooCommerce ruszają magazyn i pieniądze,
// a zwrot w panelu bywa notatką operacyjną („klient odesłał, czekamy"), nie decyzją
// o zwrocie płatności. Dopisanie ich to jeden wiersz — ale ma być osobną decyzją.
export const STATUS_SKLEPU_DLA = { wyslane: 'completed' };

// Stany sklepu, na których panel nie ma prawa nic przestawiać. Zamówienie zwrócone albo
// wyrzucone do kosza ma w sklepie swoją historię (i najczęściej zwróconą płatność);
// nadpisanie tego przez „Zrealizowane" byłoby wskrzeszeniem, którego nikt nie zlecił.
const NIETYKALNE = ['refunded', 'trash', 'cancelled'];

/**
 * Status, który należy WYSŁAĆ do sklepu dla tego zamówienia — albo `null`, gdy nic nie
 * trzeba robić. Czysta decyzja: żadnego HTTP, żadnego zapisu.
 *
 * `null` przy stanie już osiągniętym nie jest oszczędnością na żądaniach. WooCommerce
 * wysyła klientowi „Twoje zamówienie zostało zrealizowane" przy PRZEJŚCIU na 'completed';
 * powtórne wysyłanie tej samej wartości to proszenie się o drugiego maila do klienta przy
 * każdym kliknięciu i przy każdym ponowieniu.
 */
export function statusDlaSklepu(z) {
  // UWAGA: Warunek patrzy na POCHODZENIE, nie na obecnosc `zrodlo_id`. Zamowienie reczne ma
  // `zrodlo_id` — to numer w naszej wlasnej serii — wiec straznik oparty na jego braku
  // przepuscilby je i panel probowalby przestawic zamowienie, ktorego w sklepie nie ma.
  if (!z || z.sklep === 'reczne' || !z.zrodlo_id) return null;
  // ⚠️ KANALY (Allegro) NIE SA SKLEPAMI, a maja i `sklep`, i `zrodlo_id` — wiec oba
  // straznik i wyzej je przepuszczaja. Mapa nizej mowi `wyslane → completed`, a `completed`
  // to status WooCommerce, ktorego Allegro w ogole NIE ZNA. Bez tego warunku kazde wyslane
  // zamowienie allegrowe szukaloby klienta Woo pod swoim kluczem kanalu (`allegro_a`),
  // nie znajdowalo go i zapisywalo `sync_woo_blad` — czyli wieszalo na pasku „Do zalatwienia"
  // sprawe NIE DO ZALATWIENIA, przy zamowieniu, ktore jest calkowicie w porzadku.
  //
  // Rozpoznanie WSPOLNYM predykatem `czyKanalAllegro` (domena/wysylka.js), a nie wlasna
  // kopia `startsWith('allegro_')` — taka stala tu kiedys stala jako TRZECIA kopia tego
  // samego zdania. Predykat sprawdza prefiks, a nie liste znanych sklepow: biala lista
  // uciszalaby po cichu kazdy nowy sklep dopiety do panelu. Rozjazd kopii znaczylby tutaj,
  // ze zamowienie z Allegro probuje przestawic status w WooCommerce.
  //
  // ⚠️ ODESLANIE STATUSU DO ALLEGRO (PROCESSING/SENT) MA WLASNA MAPE w `allegro-status.js`
  // i jest OSOBNA DECYZJA — nigdy przez zdjecie tego warunku: zdjecie go oznaczaloby
  // wyslanie do Allegro statusu WooCommerce, ktorego Allegro nie rozumie.
  if (czyKanalAllegro(z)) return null;
  const docelowy = STATUS_SKLEPU_DLA[statusBazowy(z)];
  if (!docelowy) return null;
  if (z.status_woo === docelowy) return null;
  if (NIETYKALNE.includes(z.status_woo)) return null;
  return docelowy;
}
