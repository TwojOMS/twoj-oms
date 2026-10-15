import { bladOperatora } from './bledy.js';
import { dzienWarszawa } from './format-daty.js';
// Arytmetyka dat mieszka w `domain/kalendarz.js` — TA SAMA, której używa lista faktur.
// Nie kopiować jej z powrotem tutaj: dwie kopie rozjadą się przy pierwszej poprawce.
import {
  zNumeruDnia, sklejDate as sklej, numerDniaZNapisu,
} from './kalendarz.js';

// Termin płatności i daty na fakturze — wybór operatora zamieniony na POLA, których oczekuje
// inFakt.
//
// Nazwy pól nie są zgadywane. Dwa pierwsze pochodzą z dokumentacji API v3 („Definicja
// faktury VAT"), dwa kolejne ZMIERZONO na żywym API 2026-08-04 (osiem faktur wystawionych
// na koncie produkcyjnym, odczytanych z dokumentu i skasowanych — notatka
// `docs/superpowers/notatki/2026-08-04-infakt-daty-i-oplacenie-rozpoznanie.md`):
//   `invoice_date` — „Data wystawienia (RRRR-MM-DD)"     [dokumentacja]
//   `payment_date` — „Termin zapłaty"                    [dokumentacja]
//   `sale_date`    — data sprzedaży; POMINIĘTE daje `sale_date = invoice_date`  [pomiar]
//   `paid_price`   — kwota już zapłacona, w groszach; daje `left_to_pay: 0`     [pomiar]
//
// ⚠️ `sale_date` to nie ozdobnik: data sprzedaży jest obowiązkowym elementem faktury
// (art. 106e ust. 1 pkt 6), a dla zamówienia opłaconego przed dostawą obowiązek podatkowy
// powstaje w dniu zapłaty (art. 19a ust. 8) — czyli zwykle NIE w dniu wystawienia. Dopóki
// panel tego pola nie wysyłał, każda taka faktura wychodziła z datą sprzedaży podstawioną
// przez inFakt i wymagała ręcznej poprawki.
//
// Panel wysyłał dotąd sam `client_id` i `services`, więc dokument dostawał termin z USTAWIEŃ
// KONTA inFakt — ten sam dla wszystkich, niezależnie od tego, co uzgodniono z klientem.
// To sklep B2B: termin jest tam elementem umowy, a nie kosmetyką dokumentu.

/** „Przy odbiorze" = termin ZERO dni: płatne w dniu wystawienia. */
export const PRZY_ODBIORZE = 'przy_odbiorze';

/**
 * „Bez terminu" = zwykła faktura NIEOPŁACONA, do której panel nie dokłada własnego terminu.
 *
 * ⚠️ NAZWA OBIECUJE WIĘCEJ, NIŻ TEN WARIANT ROBI — i to jest pomiar, nie przypuszczenie.
 * Do 2026-08-04 stało tu, że pominięcie `payment_date` daje dokument bez terminu płatności.
 * Rozpoznanie na żywym API pokazało coś innego: inFakt podstawia wtedy `payment_date`
 * = `invoice_date` i na dokumencie DRUKUJE „Termin płatności: <data wystawienia>".
 * **Dokumentu bez terminu płatności tą drogą uzyskać się nie da w ogóle** — a termin
 * nie jest obowiązkowym elementem faktury (nie ma go w katalogu z art. 106e ust. 1), więc
 * nic tu nie jest złamane; złamany był opis. Praktycznie ten wariant znaczy „płatne od razu",
 * czyli na papierze wychodzi na to samo, co „przy odbiorze".
 *
 * Rozróżnienie mimo to ZOSTAJE i nie wolno go skleić, bo różnią się tym, co wysyłamy:
 * „przy odbiorze" to termin ZEROWY UZGODNIONY Z KLIENTEM (wysyłamy `payment_date` sami,
 * i to my odpowiadamy za tę datę), a „bez terminu" to brak ustaleń (nie wysyłamy nic i datę
 * dopisuje inFakt). Gdyby kiedykolwiek zmieniło się to, co inFakt podstawia — a jest to
 * ustawienie po ich stronie, nie nasze — sklejone warianty zaczęłyby po cichu wysyłać
 * termin, którego nikt nie uzgodnił, na dokumencie, którego się nie edytuje, tylko kasuje.
 *
 * NIEOPŁACONA jest tu drugim, osobnym faktem: dokumentacja API v3 mówi wprost „Faktura
 * zawsze tworzy się w statusie `draft`", więc pusta faktura wychodzi nieopłacona sama
 * z siebie. Wariantem „zapłacone" jest ZAPLACONE niżej i to są DWA RÓŻNE stany dokumentu —
 * ten mówi klientowi „pozostało do zapłaty 123,00", tamten „pozostało 0,00".
 */
export const BEZ_TERMINU = 'bez_terminu';

/**
 * „Zapłacone" = zamówienie opłacone z góry; dokument ma mówić, że klient nic nie jest winien.
 *
 * ⚠️ SPROSTOWANIE DO POPRZEDNIEJ WERSJI TEGO PLIKU. Stało tu, że „`paid_price` w dokumentacji
 * v3 NIE ISTNIEJE" i że opłacenie wymaga osobnego wywołania
 * (POST /v3/async/invoices/{uuid}/paid.json). Ostrożność, z której to wyrosło — „nie wysyłamy
 * do dokumentu księgowego pól o zgadniętej nazwie" — była i jest słuszna. Wniosek był błędny.
 * Pomiar na żywym API 2026-08-04 rozstrzygnął oba zdania, w obie strony:
 *
 *   - `paid_price` ISTNIEJE: przyjmowane w payloadzie przy tworzeniu, zwracane w odpowiedzi,
 *     daje `left_to_pay: 0`, a na dokumencie „Zapłacono: 123,00 / Pozostało do zapłaty: 0,00".
 *     To jest właściwa droga i dlatego wariant mieści się w JEDNYM payloadzie.
 *   - `/paid.json` NIE NADAJE SIĘ: zwraca 201 i referencję zadania, przestawia wewnętrzny
 *     `status` faktury na `paid` (do filtrowania list w inFakcie), ale `left_to_pay`
 *     i `paid_price` zostają nietknięte, a dokument dla klienta dalej mówi „Zapłacono: 0,00".
 *     Sprawdzone po 5, 10 i 15 sekundach — to nie jest opóźnienie kolejki.
 *
 * Konsekwencja jest większa niż wygoda: skoro kwota zapłaty jedzie w tym samym POST-cie
 * co dokument, NIE ISTNIEJE stan „faktura wystawiona, ale nieoznaczona jako opłacona".
 * To usunięcie całej klasy awarii, a nie jej obsłużenie.
 *
 * Kwota idzie ARGUMENTEM, a nie liczy się tutaj — patrz `datyFaktury` niżej.
 */
export const ZAPLACONE = 'zaplacone';

/** Terminy z formularza. Lista jest tu, żeby widok i faktura brały ją z jednego miejsca. */
export const TERMINY_DNI = [7, 14, 21, 30];

// Aliasy krótkie — formularz może przysłać jedno albo drugie, a domena nie ma prawa
// odmówić wystawienia faktury z powodu synonimu.
const ODBIOR = new Set([PRZY_ODBIORZE, 'odbior']);
const BRAK = new Set([BEZ_TERMINU, 'brak']);
const OPLACONE = new Set([ZAPLACONE, 'oplacone']);

/**
 * Czy operator wybrał wariant „zapłacone" — RAZEM z aliasem krótkim.
 *
 * Istnieje, bo bariera o pieniądze (services/faktura.js: „zapłacone" wymaga wpłat pokrywających
 * kwotę) musi rozpoznać ten wariant DOKŁADNIE tak samo, jak rozpoznaje go `datyFaktury` niżej.
 * Druga kopia tego rozpoznania — choćby `termin === 'zaplacone'` — zostawiłaby aliasowi
 * `oplacone` cichą objazdówkę wokół bariery: dokument mówiłby „Zapłacono", a nikt by nie
 * zapłacił.
 */
export const czyZaplacone = (termin) => OPLACONE.has(typeof termin === 'string' ? termin.trim() : termin);

// „Dzisiaj" liczone W CZASIE WARSZAWSKIM, tą samą funkcją, którą panel drukuje daty na karcie
// (domain/format-daty.js). Kontener chodzi z TZ=UTC, więc gołe `new Date()` między północą
// a drugą w nocy oddawałoby DZIEŃ POPRZEDNI — czyli fakturę z wczorajszą datą wystawienia,
// a pierwszego dnia miesiąca fakturę wpadającą w poprzedni miesiąc rozliczeniowy.
const dzisiajWarszawa = () => dzienWarszawa(new Date().toISOString());

// Liczba dni z pola formularza. Musi być CAŁKOWITA i NIEUJEMNA: „7.5" albo „-3" to nie termin,
// tylko literówka, a ujemny termin dałby fakturę płatną przed wystawieniem.
function dniZWyboru(termin) {
  if (typeof termin === 'number') return Number.isInteger(termin) && termin >= 0 ? termin : null;
  const s = String(termin ?? '').trim();
  return /^\d+$/.test(s) ? Number(s) : null;
}

/**
 * Wybór operatora → pola dat i płatności do payloadu faktury.
 *
 * Wejście: `{ dataWystawienia, dataSprzedazy, termin }` prosto z formularza (wszystko napisami).
 *   - `dataWystawienia`: `RRRR-MM-DD`; PUSTA znaczy „dzisiaj", nie błąd — operator, który
 *     niczego nie zmienia, wystawia dzisiejszą datą i nie ma powodu go za to karać;
 *   - `dataSprzedazy`: `RRRR-MM-DD`; PUSTA znaczy „nie wysyłamy pola", a NIE „dzisiaj" —
 *     inaczej niż data wystawienia, i to jest celowe. Reguła prawna, która tę datę proponuje,
 *     siedzi w `domain/data-sprzedazy.js` i wchodzi tu przez FORMULARZ: na dokument idzie
 *     to, co operator widzi w polu. Gdy pola nie podano, payload zostaje bajt w bajt taki,
 *     jaki panel wysyłał dotąd (inFakt podstawi wtedy `sale_date = invoice_date`);
 *   - `termin`: liczba dni (całkowita, nieujemna), `PRZY_ODBIORZE`, `BEZ_TERMINU`
 *     albo `ZAPLACONE`.
 *
 * `kwotaGrosze` (drugi argument) jest potrzebna WYŁĄCZNIE wariantowi `ZAPLACONE` i musi być
 * TĄ SAMĄ kwotą, którą sprawdziła bariera arytmetyczna (`kwotaOczekiwanaGrosze`) — nigdy
 * policzoną drugi raz. Dlatego przychodzi argumentem, a nie liczy się tutaj: dokument
 * mówiący „zapłacono", ale inną kwotą niż faktycznie zapłacona, byłby gorszy niż odmowa.
 *
 * Wyjście: JEDEN płaski obiekt gotowy do wsypania do payloadu, bez drugiego wywołania API:
 *   `{ invoice_date, sale_date?, payment_date? | paid_price? }`
 * Brak właściwości jest tu INFORMACJĄ, nie zaniedbaniem — `payment_date` nie ma przy
 * „bez terminu" i przy „zapłacone", `paid_price` ma TYLKO „zapłacone", a `sale_date` tylko
 * wtedy, gdy operator datę sprzedaży podał.
 *
 * Rzuca `bladOperatora` — to człowiek przy panelu ma dowiedzieć się, co poprawić w formularzu,
 * zanim cokolwiek poleci do inFaktu.
 *
 * Trzeci argument (`dzis`) istnieje WYŁĄCZNIE dla testów: bez niego test „pusta data znaczy
 * dzisiaj" musiałby powtórzyć liczenie dnia, czyli sprawdzać kod kodem.
 */
export function datyFaktury(
  { dataWystawienia, dataSprzedazy, termin } = {},
  kwotaGrosze = null,
  dzis = dzisiajWarszawa(),
) {
  const napisDaty = String(dataWystawienia ?? '').trim() || dzis;
  const numer = numerDniaZNapisu(napisDaty);
  if (numer === null) {
    throw bladOperatora(
      `Data wystawienia „${napisDaty}" nie jest poprawną datą w formacie RRRR-MM-DD — `
      + 'popraw ją albo zostaw pole puste, żeby wystawić dzisiejszą datą.',
    );
  }
  const daty = { invoice_date: sklej(zNumeruDnia(numer)) };

  // Data sprzedaży sprawdzana TAK SAMO jak data wystawienia — odwzorowaniem w obie strony,
  // nie samym regexem. Pole jest inne o tyle, że PUSTE znaczy „nie wysyłamy", więc odmowa
  // dotyczy wyłącznie napisu, który operator naprawdę wpisał.
  const napisSprzedazy = String(dataSprzedazy ?? '').trim();
  if (napisSprzedazy) {
    const numerSprzedazy = numerDniaZNapisu(napisSprzedazy);
    if (numerSprzedazy === null) {
      throw bladOperatora(
        `Data sprzedaży „${napisSprzedazy}" nie jest poprawną datą w formacie RRRR-MM-DD — `
        + 'popraw ją albo zostaw pole puste, żeby inFakt przyjął datę wystawienia.',
      );
    }
    // Bez porównania z datą wystawienia: inFakt przyjmuje sprzedaż zarówno WCZEŚNIEJSZĄ
    // (przedpłata zafakturowana później), jak i PÓŹNIEJSZĄ (faktura do pobrania wystawiona
    // w przeddzień wyjazdu paczki) — oba przypadki są legalne (art. 106i ust. 1, 2 i 7)
    // i oba zmierzone na żywym API.
    daty.sale_date = sklej(zNumeruDnia(numerSprzedazy));
  }

  const wybor = typeof termin === 'string' ? termin.trim() : termin;

  // Wariant „zapłacone" wychodzi PIERWSZY, bo jako jedyny nie ma nic wspólnego z terminem:
  // zamiast daty, do kiedy zapłacić, niesie kwotę już zapłaconą — patrz ZAPLACONE wyżej.
  if (OPLACONE.has(wybor)) {
    // Kwota MUSI być całkowitą liczbą groszy i większą od zera. Napis „12300" przeszedłby
    // do payloadu jako napis, ułamek to złotówki wzięte za grosze, a zero to nie „zapłacone",
    // tylko nieopłacona faktura z fałszywą adnotacją. Każdy z tych przypadków dałby dokument
    // księgowy mówiący nieprawdę o pieniądzach — i dlatego odmawiamy, zamiast wysyłać
    // `paid_price: undefined` i milczeć.
    if (!Number.isInteger(kwotaGrosze) || kwotaGrosze <= 0) {
      throw bladOperatora(
        'Faktura oznaczona jako zapłacona wymaga kwoty zapłaconej w groszach, a panel dostał '
        + `„${kwotaGrosze ?? ''}". Nie wystawiono niczego — zgłoś to, bo bez kwoty dokument `
        + 'powiedziałby klientowi, że wciąż jest coś winien.',
      );
    }
    return { ...daty, paid_price: kwotaGrosze };
  }

  // Wariant „bez terminu" — BEZ `payment_date` i BEZ `paid_price`. To nadal faktura
  // NIEOPŁACONA i sklejenie jej z „zapłacone" powiedziałoby klientowi, że nic nie jest winien.
  if (BRAK.has(wybor)) return daty;

  const dni = ODBIOR.has(wybor) ? 0 : dniZWyboru(wybor);
  if (dni === null) {
    throw bladOperatora(
      `Termin płatności „${termin ?? ''}" nie jest liczbą dni — podaj całkowitą liczbę dni `
      + '(np. 14) albo wybierz „przy odbiorze" lub „bez terminu".',
    );
  }
  return { ...daty, payment_date: sklej(zNumeruDnia(numer + dni)) };
}

// ---------------------------------------------------------------------------------
// TERMIN UZGODNIONY Z KLIENTEM — zapisany PRZY ZAMÓWIENIU (21.08.2026, scenariusz
// właściciela: „formy płatności, w tym przypadku FV przelew 14 dni").
//
// ⚠️ PO CO TO ISTNIEJE, skoro formularz faktury i tak proponuje 14 dni. Bo do dziś termin
// żył WYŁĄCZNIE w tamtym formularzu, a więc:
//   • potwierdzenie przyjęcia zamówienia pisało samo „PŁATNOŚĆ: Przelew" — bez terminu,
//     który przed chwilą uzgodniliście przez telefon;
//   • uzgodnienie nie zostawiało ŻADNEGO śladu do chwili wystawienia faktury, a ta bywa
//     wystawiana tydzień później i przez kogoś innego.
// To sklep B2B: termin jest tam elementem umowy, a nie kosmetyką dokumentu (patrz nagłówek
// tego pliku) — więc należy do zamówienia, nie do jednego ekranu.
//
// ⚠️⚠️ `ZAPLACONE` NIE NALEŻY DO TEGO SŁOWNIKA i to jest decyzja, nie przeoczenie.
// „Zapłacone" nie jest terminem, tylko STANEM, który wynika z wpłat — rozstrzyga go
// `proponowanaDataSprzedazy` i bariera o pieniądze w services/faktura.js. Wpisane tutaj jako
// „uzgodnienie" byłoby obietnicą operatora, że klient zapłacił, składaną w chwili, gdy klient
// jeszcze nie zapłacił.

/** Etykiety wariantów terminu — jedno źródło dla ekranu zakładania, karty i maila. */
export const ETYKIETY_TERMINU = Object.freeze({
  [PRZY_ODBIORZE]: 'płatne przy odbiorze',
  [BEZ_TERMINU]: 'płatne od razu',
  ...Object.fromEntries(TERMINY_DNI.map((d) => [String(d), `termin ${d} dni`])),
});

/**
 * Termin z formularza ZAMÓWIENIA (nie faktury). Pusty = brak ustaleń i to jest stan normalny.
 *
 * Zwraca napis — tę samą wartość, którą przyjmuje `datyFaktury` — albo `null`. Napis, a nie
 * liczba, bo kolumna jest TEXT-em i mieści oba warianty słowne obok liczby dni; jedna postać
 * w bazie znaczy jedno porównanie zamiast dwóch.
 */
export function parsujTerminZamowienia(surowy) {
  const wartosc = String(surowy ?? '').trim();
  if (wartosc === '') return null;
  if (ODBIOR.has(wartosc)) return PRZY_ODBIORZE;
  if (BRAK.has(wartosc)) return BEZ_TERMINU;
  if (OPLACONE.has(wartosc)) {
    throw bladOperatora(
      '„Zapłacone" nie jest terminem płatności, tylko stanem wynikającym z wpłat — panel '
      + 'rozstrzygnie go sam przy wystawianiu faktury. Wybierz termin albo zostaw pole puste.',
    );
  }
  if (!/^\d+$/.test(wartosc)) {
    throw bladOperatora(
      `Termin płatności „${surowy}" nie jest liczbą dni — podaj całkowitą liczbę dni (np. 14) `
      + 'albo wybierz „przy odbiorze" lub „płatne od razu".',
    );
  }
  return wartosc;
}

/**
 * Termin, którym ma wystartować formularz faktury.
 *
 * ⚠️ KOLEJNOŚĆ JEST ISTOTNA I NIE ZMIENIA SIĘ WZGLĘDEM TEGO, CO BYŁO. Uzgodnienie zapisane
 * przy zamówieniu zastępuje WYŁĄCZNIE zapasowe „14 dni" — nigdy dwóch faktów, które są od
 * niego mocniejsze:
 *   1. zamówienie z pełnym pokryciem wpłat → „zapłacone" (klient już zapłacił, więc dokument
 *      ma to mówić, a nie proponować termin do zapłaty, której nie ma);
 *   2. zamówienie za pobraniem → „przy odbiorze" (kwotę inkasuje kurier).
 * Uzgodniony termin nadpisujący którykolwiek z nich dałby fakturę zaprzeczającą pieniądzom,
 * które już wpłynęły.
 */
export function terminFaktury({ zaplacone, pobranie, terminZamowienia }) {
  if (zaplacone) return ZAPLACONE;
  if (pobranie) return PRZY_ODBIORZE;
  const uzgodniony = String(terminZamowienia ?? '').trim();
  if (uzgodniony) return /^\d+$/.test(uzgodniony) ? Number(uzgodniony) : uzgodniony;
  return 14;
}
