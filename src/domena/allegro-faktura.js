import { czyKanalAllegro } from './wysylka.js';
import { idDokumentu } from './dokument-programu.js';
import { dzienWarszawa } from './format-daty.js';

// Brzmienia zdań o stanie D (niżej) w JEDNYM miejscu.
export const ODMOWA_ALLEGRO_PO_ZAMIANIE_NIP =
  'Kupujący ma w Allegro poprzednią fakturę (sprzed zamiany NIP-u) — ' +
  'nowej panel nie wysyła sam; wyślij ją z panelu Allegro albo zakładką Wiadomości.';

/**
 * Znacznik D: zamówienie przepięte na fakturę zastępczą (zły NIP), gdy poprzednia
 * faktura mogła już być u kupującego. `przepnijNaZastepcza` zostawia wtedy `allegro_wyslana_at` i zeruje
 * `allegro_invoice_id`; zwykła wysyłka takiego wiersza nie tworzy (id zapisywane przed `PUT`). `program` zawęża do
 * TwojeFaktury — ewentualne stare wiersze inFaktu bez id nie są zamianą. `REJECTED` (także spóźniony zapis czuwacza
 * po przepięciu) to nie D: kupujący starego pliku nie ma, nową wolno zgłosić nowym numerem.
 */
export function poZamianieNipWAllegro(f) {
  return Boolean(
    f &&
    f.program === 'twojefaktury' &&
    f.allegro_wyslana_at &&
    !f.allegro_invoice_id &&
    f.allegro_weryfikacja !== 'REJECTED',
  );
}

/** Zdanie karty zamówienia przy znaczniku D albo `null`. Dzień wysyłki w czasie Warszawy jako DD.MM. */
export function zdanieKartyPoZamianieNip(f) {
  if (!poZamianieNipWAllegro(f)) return null;
  const [, mm, dd] = dzienWarszawa(f.allegro_wyslana_at).split('-');
  return (
    `Kupujący ma w Allegro poprzednią fakturę (sprzed zamiany NIP-u), wysłaną ${dd}.${mm}. ` +
    `Nowej ${f.numer} panel nie wysyła sam.`
  );
}

/**
 * Czy tę fakturę wolno wysłać kupującemu przez Allegro. Czysta decyzja: żadnego HTTP,
 * żadnego zapisu, nigdy nie rzuca.
 *
 * ⚠️⚠️ TO JEST BARIERA PRZED OPERACJĄ NIEODWRACALNĄ — najbardziej nieodwracalną w całym
 * panelu. Dokument ląduje na koncie kupującego i panel NIE MA CZYM go stamtąd zabrać:
 * skasowanie faktury w inFakcie nie zabiera jej kupującemu z rąk, a Allegro nie daje
 * żadnego „cofnij". Dlatego WSZYSTKIE przesłanki stoją TUTAJ, w czystej funkcji, którą
 * da się sprawdzić bez sieci i bez bazy — a nie w usłudze, gdzie każda z nich musiałaby
 * być odczytana z prawdziwej odpowiedzi HTTP, żeby ktokolwiek zobaczył, że zniknęła.
 *
 * ⚠️ ODMOWA MÓWI, CO ZROBIĆ — nie samo „nie wolno". Bariera bez wyjścia jest stanem bez
 * wyjścia (reguła: odmowa ma powód): operator, który widzi brak przycisku i nie wie, czego
 * brakuje, kończy grzebaniem w bazie albo wysyłaniem faktury ręką z inFaktu.
 *
 * ⚠️⚠️ FURTKI „BEZ NUMERU KSeF" NIE MA. Brak numeru KSeF nie daje się zdjąć decyzją
 * człowieka: do kupującego faktura idzie zawsze z numerem KSeF, a dokument bez numeru
 * wysyła się ręcznie z panelu Allegro albo zakładką „Wiadomości" — poza panelem, świadomie,
 * a nie jednym klawiszem obok zwykłej wysyłki.
 *
 * ⚠️ TO NIE ZOSTAWIA STANU BEZ WYJŚCIA (reguła: każdy stan ma wyjście): panel sam wysyła
 * fakturę do KSeF (zakładka FAKTURY, `POST /faktury/ksef/wyslij`). Wyjściem z „czeka na KSeF"
 * jest więc wysłanie jej do KSeF, a nie ominięcie numeru.
 */
export function wolnoWyslacDoAllegro(z) {
  const nie = (powod) => ({ wolno: false, powod });
  if (!z) return nie('Nie ma takiego zamówienia.');
  // Rozpoznanie kanału WYŁĄCZNIE wspólnym predykatem — nigdy własna kopia
  // `startsWith('allegro_')`.
  if (!czyKanalAllegro(z)) return nie('To zamówienie nie przyszło z Allegro — nie ma dokąd wysłać faktury.');
  // `chce_fakture` przy kanale to `invoice.required` od Allegro. Faktura idzie TYLKO na
  // żądanie kupującego. Wysłanie dokumentu komuś, kto o niego nie prosił, jest tak samo
  // nieodwracalne jak każde inne — a przy zakupie prywatnym oznacza dokument, którego
  // kupujący u siebie nie chciał.
  if (!z.chce_fakture) return nie('Kupujący nie prosił o fakturę.');
  const f = z.faktura;
  // Numer ORAZ UUID: bez numeru kupujacy nie polaczy dokumentu z nasza ksiegowoscia,
  // a bez UUID-a nie ma skad wziac PDF-u (panel nie trzyma kopii dokumentu).
  if (!f || !f.numer || !idDokumentu(f)) return nie('To zamówienie nie ma jeszcze wystawionej faktury.');
  // ⚠️⚠️ `allegro_wyslana_at` NIE JEST DOWODEM „DOKUMENT U KUPUJĄCEGO".
  // Kolumna niesie wyłącznie „PUT .../file się udał" — a Allegro sprawdza plik antywirusem
  // JUŻ POTEM. Przy `REJECTED` kupujący faktury NIE MA, choć kolumna jest wypełniona.
  //
  // Gdyby ta odmowa gryzła także przy `REJECTED`, robiłaby z niego STAN BEZ WYJŚCIA
  // (reguła: każdy stan ma wyjście): pasek spraw każe wysłać dokument jeszcze raz, obie trasy
  // odmawiają, przycisku nie ma, a odnotowanie skasowania w inFakcie też odmawia. Panel
  // kazałby ponowić, sam odmawiał i przy okazji kłamał, że kupujący fakturę ma.
  //
  // ⚠️ `REJECTED` JEST JEDYNYM STANEM, W KTÓRYM PONOWIENIE JEST BEZPIECZNE I DARMOWE:
  // `allegro_invoice_id` już mamy, więc usługa idzie ścieżką ADOPCJI i robi sam
  // `PUT .../file`, który PODMIENIA plik przy istniejącym zgłoszeniu. ŻADNEGO drugiego
  // POST-u, więc ani jednego z dziesięciu slotów więcej i ani jednego duplikatu.
  //
  // ⚠️ LISTA STANÓW PRZEPUSZCZAJĄCYCH JEST BIAŁA — dokładnie jak STANY_KONCOWE_WERYFIKACJI
  // niżej i z tego samego powodu. `ACCEPTED`, `WAITING`, pusto ORAZ status, którego dziś
  // nie znamy, to dalej „dokument może być u kupującego" i dalej ODMAWIAMY. Czarna lista
  // („wszystko oprócz ACCEPTED") otwierałaby ponowienie przy każdym nowym statusie Allegro.
  //
  // ⚠️ ZNACZNIK D PRZED zdaniem niżej: po zamianie faktury (zły NIP) wiersz wskazuje NOWĄ
  // fakturę, a „wysłana" była STARA. Zdanie „Faktura <numer> została już wysłana" podałoby numer nowej — kłamstwo.
  if (poZamianieNipWAllegro(f)) return nie(ODMOWA_ALLEGRO_PO_ZAMIANIE_NIP);
  if (f.allegro_wyslana_at && f.allegro_weryfikacja !== 'REJECTED') {
    return nie(
      `Faktura ${f.numer} została już wysłana do Allegro ${f.allegro_wyslana_at} — kupujący ma ją na koncie. ` +
        'Panel nie ma czym jej stamtąd zabrać; jeśli dokument jest błędny, potrzebna jest KOREKTA.',
    );
  }
  // ⚠️⚠️ KOMUNIKAT NIE ODSYŁA DO inFAKTU ani do przycisku „bez numeru KSeF" (takiego nie ma).
  // Panel wysyła do KSeF sam (`POST /faktury/ksef/wyslij`, domena/wysylka-ksef.js), więc zdanie
  // „wyślij ją do KSeF w inFakcie" odsyłałoby operatora poza panel do czynności, którą panel
  // ma dwie zakładki dalej.
  if (!f.ksef_numer) {
    return nie(`Faktura ${f.numer} nie jest jeszcze w KSeF — a do kupującego ma iść dokument z numerem KSeF.`);
  }
  return { wolno: true, powod: null };
}

/**
 * Status weryfikacji pliku wyciagniety z wpisu faktury oddanego przez Allegro.
 *
 * ⚠️ CZYTAMY DWA MIEJSCA, bo dokumentacja podaje dwa sprzeczne ksztalty: tutorial mowi
 * `file.securityVerification.status`, a ogloszenie funkcji (allegro-api#4130) — to samo pole
 * na najwyzszym poziomie wpisu. Rozstrzygnie pierwsza prawdziwa faktura; do tego czasu czytanie
 * jednego miejsca znaczyloby 50% szans, ze panel nigdy nie zobaczy odrzucenia pliku — czyli
 * twierdzilby, ze kupujacy ma fakture, ktorej nie ma.
 *
 * `eptVerification` (platnosci odroczone) NIE jest tym samym pojeciem i tu go nie mieszamy —
 * ma wlasne pole `reason` i wlasne znaczenie, a wrzucenie go do jednej kolumny zrobiloby
 * z „odrzucony antywirusowo" i „odrzucony przez EPT" jeden nierozroznialny stan.
 */
export function statusWeryfikacji(wpis) {
  return wpis?.file?.securityVerification?.status ?? wpis?.securityVerification?.status ?? null;
}

/**
 * ⚠️⚠️ ACCEPTED I REJECTED SĄ KOŃCOWE. Wszystko inne — `WAITING`, brak wartości, a także status,
 * którego dziś nie znamy — jest BRAKIEM ROZSTRZYGNIĘCIA.
 *
 * Uznanie nieznanego statusu za końcowy („skoro nie jest WAITING, to już po sprawie") zrobiłoby
 * z niego CICHE MILCZENIE panelu: czuwacz przestałby pytać, pasek spraw nic by nie powiedział,
 * a kupujący mógłby nie mieć faktury. Lista stanów końcowych jest więc BIAŁĄ, nie czarną.
 */
const STANY_KONCOWE_WERYFIKACJI = ['ACCEPTED', 'REJECTED'];

/**
 * JEDNA definicja „weryfikacja pliku jeszcze nierozstrzygnięta" — w dwóch postaciach, dokładnie
 * tym samym wzorcem, co „faktura czekająca na KSeF" (domena/ksef-oczekiwanie.js) i z tego samego
 * powodu: pyta o to zapytanie czuwacza (services/czuwacz-ksef.js), a melduje pasek spraw na
 * karcie (domena/sprawy-karty.js). Dwie kopie warunku rozjeżdżają się przy pierwszej zmianie
 * reguły — a rozjazd TUTAJ znaczy albo setki wywołań miesięcznie bez ani jednej nowej informacji,
 * albo milczenie panelu przy dokumencie, którego kupujący nie dostał.
 *
 * Warunek do klauzuli WHERE. Alias: `f` = faktury.
 *
 * ⚠️ `IS NOT` zamiast `<>`: `<>` na NULL-u daje NULL (czyli fałsz), więc odrzucałoby każdą
 * fakturę z pustą kolumną `allegro_weryfikacja` — a to jest właśnie stan „wysłana, nie wiemy nic".
 *
 * ⚠️ PODŁOGI PO DACIE WYSŁANIA TU NIE MA — nakłada ją zapytanie czuwacza, tak samo jak przy
 * warunku KSeF. Pasek spraw podłogi mieć NIE MOŻE: to on jest wyjściem ze stanu, w którym czuwacz
 * przestał pytać.
 */
export const WARUNEK_WERYFIKACJA_NIEROZSTRZYGNIETA_SQL = `
  f.allegro_wyslana_at IS NOT NULL
  AND f.allegro_invoice_id IS NOT NULL
  AND f.allegro_weryfikacja IS NOT 'ACCEPTED'
  AND f.allegro_weryfikacja IS NOT 'REJECTED'
`;

/**
 * Ten sam warunek, co SQL wyżej — na wierszu faktury. NIGDY nie rzuca: woła to pasek spraw,
 * który nie ma prawa zabrać karty.
 *
 * ⚠️ `allegro_invoice_id` JEST CZĘŚCIĄ WARUNKU, a nie ozdobnikiem: bez identyfikatora zgłoszenia
 * nie da się rozpoznać NASZEGO wpisu na liście z Allegro (kupujący może mieć przy zamówieniu do
 * dziesięciu faktur), więc pytanie o taki wiersz nie mogłoby przynieść odpowiedzi.
 */
export function weryfikacjaNierozstrzygnieta(f) {
  if (!f?.allegro_wyslana_at || !f?.allegro_invoice_id) return false;
  return !STANY_KONCOWE_WERYFIKACJI.includes(f.allegro_weryfikacja);
}

/**
 * Nazwa pliku WIDOCZNA DLA KUPUJACEGO na jego koncie Allegro.
 *
 * ⚠️ Ukośnik z numeru faktury („12/08/2026") musi zniknąć: w nazwie pliku znaczy katalog,
 * a nie da się przewidzieć, co z tym zrobi przeglądarka kupującego przy pobieraniu. Ta sama
 * zasada, co przy nazwie PDF-u proformy (`bezpiecznaNazwa` z domena/pliki.js) — tyle że
 * tam plik ląduje u nas, a tu ląduje u obcego człowieka i nie da się go podmienić.
 */
export function nazwaPlikuFaktury(numer) {
  if (!numer) return 'faktura.pdf';
  return `FV-${String(numer).replace(/[^\w.-]+/g, '-')}.pdf`;
}
