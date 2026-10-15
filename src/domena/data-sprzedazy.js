import { dataPokryciaWplat } from './platnosci.js';
import { kwotaOczekiwanaGrosze, zl } from './suma-pozycji.js';
import { dzienWarszawa } from './format-daty.js';
import { normalizujMetode } from './metody-platnosci.js';

// Reguła prawna: kiedy obowiązek podatkowy VAT powstaje z ZAPŁATY (art. 19a ust. 8), a kiedy
// z WYDANIA towaru (art. 19a ust. 1) — patrz „Podstawa prawna" w planie
// docs/superpowers/plans/2026-08-04-oms-faktura-data-sprzedazy-i-zaplacone.md.
//
// Ta funkcja tylko PROPONUJE datę sprzedaży — operator widzi ją w polu na karcie i może ją
// poprawić, dokładnie tak samo jak dziś przy dacie wystawienia (patrz `datyFaktury` w
// domain/termin-platnosci.js). Ostatnie słowo o tym, co poleci na fakturę, ma człowiek,
// nigdy ta funkcja.

// „Dzisiaj" liczone W CZASIE WARSZAWSKIM, tak samo jak `dzisiajWarszawa()` w
// termin-platnosci.js. Kontener chodzi z TZ=UTC — gołe `new Date()` między północą
// a drugą w nocy oddałoby DZIEŃ POPRZEDNI, czyli fakturę do pobrania z wczorajszą datą
// sprzedaży, wystawioną dziś rano.
const dzisWarszawa = () => dzienWarszawa(new Date().toISOString());

// „RRRR-MM-DD" → „D.MM", tak jak we wzorcu z planu („zapłacono 3.08 — ..."). To zapis,
// w którym operator normalnie pisze daty w rozmowie z klientem, nie ISO z zerami wiodącymi.
function poPolsku(dataIso) {
  const m = /^\d{4}-(\d{2})-(\d{2})$/.exec(dataIso ?? '');
  return m ? `${Number(m[2])}.${m[1]}` : (dataIso ?? '');
}

/**
 * ⚠️⚠️ INKASO KURIERA NIE JEST ZAPŁATĄ PRZED DOSTAWĄ — I NIE MOŻE JEJ UDAWAĆ.
 *
 * Art. 19a ust. 8 przenosi obowiązek podatkowy na dzień zapłaty WYŁĄCZNIE wtedy, gdy
 * pieniądze przyszły PRZED dostawą. Przy pobraniu kurier inkasuje przy doręczeniu, czyli
 * nigdy przed — więc wiersz wpłaty opisany metodą „Za pobraniem" nie ma prawa uruchomić
 * tej gałęzi, bez względu na to, jaką datę nosi.
 *
 * ⚠️ TO NIE JEST HIPOTEZA. Zmierzone na produkcji 31.08.2026 przy zamówieniu 1259: sklep
 * PRO, oznaczając zamówienie jako zrealizowane, zapisuje `date_paid`, a poller czyta to
 * jako wpłatę (`zrodlo: 'sklep'`, `metoda: 'Za pobraniem'`) — mimo że paczka dopiero
 * ruszyła w drogę, a `left_to_pay` na fakturze wynosił pełne 99,90. Panel proponował
 * wtedy datę sprzedaży ze zdaniem „zapłacono 31.08 — art. 19a ust. 8", czyli podawał
 * człowiekowi FAŁSZYWĄ PODSTAWĘ PRAWNĄ przy dokumencie księgowym.
 *
 * ⚠️ SZKODA NIE BYŁA KOSMETYCZNA TYLKO PRZEZ ZBIEG OKOLICZNOŚCI: wiersz wpłaty powstaje
 * dwie sekundy po `wyslane_at`, więc obie gałęzie dawały ten sam dzień. Przy odroczonej
 * wysyłce (sklep oznacza zamówienie wcześniej, niż paczka wyjeżdża) fałszywa wpłata
 * cofa datę sprzedaży do dnia oznaczenia — potrafi to być POPRZEDNI MIESIĄC, czyli VAT
 * w złym okresie JPK.
 *
 * ⚠️ BRAMKA JEST WĄSKA CELOWO — odsiewa INKASO, a nie każdą wpłatę przy zamówieniu
 * z pobraniem. Klient, który mimo pobrania naprawdę przelał pieniądze przed wysyłką,
 * dalej podlega art. 19a ust. 8 i data sprzedaży ma być datą jego przelewu. Dlatego
 * pytamy o metodę POJEDYNCZEJ wpłaty, a nie o `czyPobranie(zamowienie)`.
 *
 * Rozpoznanie przez `normalizujMetode` (domain/metody-platnosci.js), a nigdy własnym
 * dopasowaniem napisu: metoda przychodzi ze sklepu jako WOLNY TEKST i to tamten słownik
 * jest jedynym miejscem, które wie, że „Za pobraniem", „za pobraniem" i „Pobranie DPD"
 * to ta sama rzecz.
 */
const czyInkasoKuriera = (platnosc) => normalizujMetode(platnosc?.metoda).klucz === 'pobranie';

/**
 * Propozycja daty sprzedaży na fakturę wg reguły prawnej. Wołana PRZY KAŻDYM OTWARCIU KARTY
 * zamówienia, więc NIE MOŻE rzucić — uszkodzona/nieliczbowa kwota (w zamówieniu, w pozycji
 * albo we wpłacie) ma dać sensowny wynik w gałęzi „wydanie", a nie wywalić widok.
 *
 * Reguła:
 *   1. Zamówienie ma PEŁNE pokrycie wpłat (`dataPokryciaWplat` na kwocie OCZEKIWANEJ, czyli
 *      `kwotaOczekiwanaGrosze` — kwota ze sklepu PLUS pozycje dopisane ręcznie, NIE
 *      `kwota_brutto`, patrz domain/suma-pozycji.js) ORAZ zapłatę otrzymano PRZED wydaniem
 *      towaru (dzień wpłaty domykającej <= dzień z `wyslane_at`, albo wysyłki jeszcze nie
 *      było) → `podstawa: 'zaplata'`, `data` = dzień WARSZAWSKI tej konkretnej wpłaty, która
 *      domknęła kwotę (nie ostatniej, nie pierwszej). Art. 19a ust. 8: całość zapłaty PRZED
 *      dostawą przenosi obowiązek podatkowy na dzień zapłaty — i „przed dostawą" jest tu
 *      warunkiem, a nie ozdobnikiem. Niedopłata i brak wpłat też nie wchodzą tu —
 *      `dataPokryciaWplat` zwraca wtedy `null`.
 *   2. W przeciwnym razie (brak pokrycia ALBO zapłata dopiero po wydaniu — zwykły przelew
 *      po wysyłce, inkaso kuriera przy pobraniu) → `podstawa: 'wydanie'`, `data` = dzień z `z.wyslane_at`, a gdy
 *      pusty/nieparsowalny → `dzis` (dzień pakowania/wystawienia — patrz rozstrzygnięcie
 *      właściciela z 2026-08-04 w planie, Task 2: „pobranie wystawiamy w dniu wysyłki").
 *      Art. 19a ust. 1: obowiązek powstaje z chwilą wydania towaru.
 *
 * Drugi argument (`dzis`) istnieje dla testów i dla spójności z resztą modułu (por. drugi
 * argument `datyFaktury` w termin-platnosci.js) — bez niego test „brak wysyłki znaczy dziś"
 * musiałby powtórzyć liczenie dnia, czyli sprawdzać kod kodem.
 */
export function proponowanaDataSprzedazy(zamowienie, dzis = dzisWarszawa()) {
  let dataZaplaty = null;
  try {
    // Kwota progu MUSI iść przez tę samą miarę, co bariera arytmetyczna faktury i saldo
    // wpłat na karcie — inaczej propozycja daty rozjechałaby się z tym, co operator widzi
    // jako „opłacone" gdzie indziej na tej samej karcie.
    const progOczekiwanyZl = zl(kwotaOczekiwanaGrosze(zamowienie));
    // ⚠️ PRÓG LICZY SIĘ Z SAMYCH PRZEDPŁAT, a inkaso kuriera do niego nie dokłada — patrz
    // `czyInkasoKuriera` wyżej. Kwota progu zostaje PEŁNA (`kwotaOczekiwanaGrosze`), więc
    // zamówienie opłacone w części przelewem, a w części pobraniem, nie domyka się przed
    // dostawą i słusznie spada do gałęzi „wydanie".
    const przedplaty = (zamowienie?.platnosci ?? []).filter((p) => !czyInkasoKuriera(p));
    dataZaplaty = dataPokryciaWplat(przedplaty, progOczekiwanyZl);
  } catch {
    // Kwota zamówienia, pozycji albo którejś wpłaty jest uszkodzona/nieliczbowa — nie da się
    // policzyć pokrycia. Bezpieczne przybliżenie to „wydanie": karta ma się otworzyć i pokazać
    // coś sensownego, a nie wywalić na złych danych w bazie (patrz saldoWplat — ta sama zasada).
    dataZaplaty = null;
  }

  // ⚠️ PRZEZ `dzienWarszawa`, nigdy `slice(0, 10)` po napisie: `wyslane_at` to NASZ znacznik
  // w UTC, a 23:40 UTC to w Warszawie latem już następny dzień. Ten dzień idzie na fakturę
  // jako data sprzedaży, więc pomyłka o dobę potrafi wrzucić dokument w inny miesiąc JPK/VAT.
  const dataWyslania = dzienWarszawa(zamowienie?.wyslane_at);
  const dzienZaplaty = dataZaplaty ? dzienWarszawa(dataZaplaty) : '';

  // ⚠️ WARUNEK „PRZED DOSTAWĄ" JEST CAŁĄ TREŚCIĄ art. 19a ust. 8 — bez niego ta gałąź
  // odpalała się przy KAŻDYM pokryciu kwoty, także przy zwykłym przelewie po wysyłce
  // (i przy pobraniu, gdzie kurier inkasuje dopiero przy doręczeniu). Skutek nie był
  // kosmetyczny: faktura dostawała datę sprzedaży z INNEGO MIESIĄCA niż powstał obowiązek
  // podatkowy, czyli lądowała w złym okresie JPK/VAT.
  //
  // Porównanie leksykograficzne na dniach warszawskich `RRRR-MM-DD` — bez `Date`, bo to
  // format, w którym porządek napisów JEST porządkiem kalendarza, a `new Date('2026-10-25')`
  // czyta napis jako UTC i po przeliczeniu na strefę potrafi cofnąć się o dobę.
  //
  // `<=`, nie `<`: przy zapłacie tego samego dnia co wydanie obie interpretacje dają tę samą
  // datę, więc to najprostsza bezpieczna granica. Brak `dataWyslania` znaczy „dostawy jeszcze
  // nie było", czyli każda zapłata jest zapłatą przed dostawą.
  //
  // ⚠️ `dzienZaplaty`, a NIE `dataZaplaty`: `dzienWarszawa` na wartości, której nie umie
  // odczytać, oddaje pusty string (format-daty.js — nigdy „Invalid Date" na ekranie).
  // Bez tego warunku uszkodzona data wpłaty dawała `{ data: '', podstawa: 'zaplata' }`:
  // zdanie z dziurą i domyślnie wybrany wariant „zapłacone" na karcie, przy dacie, której
  // panel nie zna. Nie wiedząc KIEDY zapłacono, nie wolno twierdzić, że obowiązek powstał
  // w dniu zapłaty — spadamy do „wydanie".
  if (dzienZaplaty && (!dataWyslania || dzienZaplaty <= dataWyslania)) {
    return {
      data: dzienZaplaty,
      podstawa: 'zaplata',
      wyjasnienie: `zapłacono ${poPolsku(dzienZaplaty)} — obowiązek podatkowy powstał w dniu `
        + 'zapłaty (art. 19a ust. 8 ustawy o VAT).',
    };
  }

  if (dataWyslania) {
    // Gdy zapłata BYŁA, ale dopiero po wydaniu, zdanie mówi to wprost — inaczej operator
    // widziałby datę wysyłki na zamówieniu, o którym wie, że jest opłacone, i nie wiedziałby,
    // czy panel po prostu nie zauważył wpłaty.
    const poWydaniu = dzienZaplaty
      ? `, zapłacono dopiero ${poPolsku(dzienZaplaty)} (po wydaniu)`
      : '';
    return {
      data: dataWyslania,
      podstawa: 'wydanie',
      wyjasnienie: `wysłano ${poPolsku(dataWyslania)}${poWydaniu} — obowiązek podatkowy powstał `
        + 'w dniu wydania towaru (art. 19a ust. 1 ustawy o VAT).',
    };
  }

  return {
    data: dzis,
    podstawa: 'wydanie',
    wyjasnienie: 'brak daty wysyłki — przyjęto dzień dzisiejszy jako dzień wydania towaru '
      + '(art. 19a ust. 1 ustawy o VAT).',
  };
}
