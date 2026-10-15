import { composeItemName, PROJEKT_NAZWA } from './quote-text.js';
// Dzielenie imienia i nazwiska NIE jest zduplikowane tutaj — mieszka we wspólnym module,
// bo panel i ekran „Nowe zamówienie" w OMS-ie (src/oms/domain/nowe-zamowienie.js) muszą
// dzielić dokładnie tę samą regułę: karta panelu i zamówienie w OMS-ie mają pokazywać
// TEGO SAMEGO odbiorcę, inaczej rozjazd wyjdzie dopiero na etykiecie kurierskiej.
import { rozbijNazwe } from './nazwa-osoby.js';

const tekst = (v) => String(v ?? '').trim();

/**
 * Przedrostek ZNACZNIKA TECHNICZNEGO, który panel wpisuje zamówieniu w pole `uwagi`.
 *
 * ⚠️⚠️ TO POLE NIESIE DWIE RÓŻNE RZECZY I TRZEBA JE ODRÓŻNIAĆ. `zamowienia.uwagi` to
 * normalnie **słowa klienta** (`customer_note` ze sklepu, `messageToSeller` z Allegro) —
 * a tutaj panel dopisuje własny ślad z identyfikatorem karty i odnośnikiem do niej.
 *
 * Stała jest wyeksportowana, bo czyta ją specyfikacja zamówienia w OMS-ie
 * (`src/oms/domain/specyfikacja.js`), żeby NIE wydrukować tego zdania klientowi na kartce
 * w paczce. Jedno miejsce z tym napisem, nie dwa: skopiowany literał rozjechałby się przy
 * pierwszej poprawce brzmienia i znacznik zacząłby po cichu wyciekać na dokument razem
 * z wewnętrznym adresem karty.
 */
export const UWAGA_Z_KARTY = 'Zamówienie indywidualne — karta ';

/**
 * Karta → ciało żądania do OMS-u (odpowiednik buildApiloOrderInput).
 *
 * ⚠️ WYSYŁKA JEST KOSZTEM DOSTAWY, NIE POZYCJĄ. W Apilo szła jako pozycja typu „wysyłka",
 * bo tak wygląda zamówienie w Apilo; w OMS-ie ma własną kolumnę, z której liczy się próg
 * darmowej dostawy i podsumowanie VAT. Wysłana jako pozycja policzyłaby się dwa razy.
 */
export function buildOmsOrderInput(card, { publicBaseUrl = null, dodatki = [] } = {}) {
  const q = card.quote ?? { items: [], shipping: '0' };
  const od = card.orderData ?? {};
  const ship = od.shipping ?? {};
  const inv = od.invoice ?? {};
  const chceFakture = Boolean(inv.wanted);
  const osoba = rozbijNazwe(ship.name || card.klientNazwa);
  const adresFvTenSam = inv.sameAsShipping !== false;

  const link = publicBaseUrl ? `\n${publicBaseUrl}/cards/${card.id}` : '';

  return {
    kartaId: card.id,
    // Blok PŁATNOŚCI = nabywca na fakturze + telefon i e-mail kontaktowy. Telefonu i maila
    // NIE dubluje blok dostawy — adresOdbiorcy w OMS-ie czyta je właśnie stąd.
    klient: {
      ...osoba,
      company: chceFakture ? tekst(inv.company) : '',
      address_1: chceFakture && !adresFvTenSam ? tekst(inv.street) : tekst(ship.street),
      postcode: chceFakture && !adresFvTenSam ? tekst(inv.postal) : tekst(ship.postal),
      city: chceFakture && !adresFvTenSam ? tekst(inv.city) : tekst(ship.city),
      country: 'PL',
      phone: tekst(ship.phone),
      email: tekst(card.klientEmail),
    },
    dostawa: {
      ...osoba,
      company: '',
      address_1: tekst(ship.street),
      postcode: tekst(ship.postal),
      city: tekst(ship.city),
      country: 'PL',
    },
    nip: chceFakture && tekst(inv.nip) ? tekst(inv.nip) : null,
    chceFakture,
    kosztDostawyBrutto: String(q.shipping ?? '0'),
    pozycje: [
      ...(q.items ?? []).map((i) => ({
        // TA SAMA funkcja, która składa nazwę pozycji w mailu z wyceną — klient ma zobaczyć
        // na fakturze dokładnie to, co zaakceptował w ofercie.
        nazwa: composeItemName(i),
        ilosc: i.qty,
        cena_brutto: String(i.price),
      })),
      // ⚠️ Przygotowanie projektu jest ODDZIELNĄ pozycją, tak samo jak w ofercie sklepu.
      // Bez tego zamówienie w OMS-ie opiewałoby na mniej niż wycena, którą klient
      // zaakceptował — a faktura wyszłaby na złą kwotę.
      ...(Number(q.projekt ?? 0) > 0
        ? [{ nazwa: PROJEKT_NAZWA, ilosc: 1, cena_brutto: String(Number(q.projekt)) }]
        : []),
      // ⚠️ DODATKI WYBRANE PRZEZ KLIENTA (ekspres, kolejny egzemplarz) — dopisywane przez
      // formularz proformy, gdzie klient dobiera je PO wysłaniu wyceny. Wchodzą tu, a nie
      // do `card.quote`, bo wycena ma zostać zapisem tego, CO WYCENILIŚMY; zamówienie ma
      // być zapisem tego, CO KLIENT ZAMÓWIŁ. Bez nich zamówienie w OMS-ie opiewałoby na
      // mniej, niż klient zatwierdził, a `oplacone` (wymaga pokrycia CAŁEJ kwoty) nie
      // zapaliłoby się nigdy — ETAP IV stanąłby po cichu, jak przy pominiętej pozycji
      // „przygotowanie projektu".
      ...(Array.isArray(dodatki) ? dodatki : []),
    ],
    uwagi: `${UWAGA_Z_KARTY}${card.id}${link}`,
  };
}
