import { czyKanalAllegro } from './wysylka.js';

/**
 * Czy te fakture wolno wyslac kupujacemu przez Allegro. Czysta decyzja: zadnego HTTP,
 * zadnego zapisu, nigdy nie rzuca.
 *
 * ⚠️⚠️ TO JEST BARIERA PRZED OPERACJA NIEODWRACALNA — najbardziej nieodwracalna w calym
 * panelu. Dokument laduje na koncie kupujacego i panel NIE MA CZYM go stamtad zabrac:
 * skasowanie faktury w inFakcie nie zabiera jej kupujacemu z rak, a Allegro nie daje
 * zadnego „cofnij". Dlatego WSZYSTKIE przeslanki stoja TUTAJ, w czystej funkcji, ktora
 * da sie sprawdzic bez sieci i bez bazy — a nie w usludze, gdzie kazda z nich musialaby
 * byc odczytana z prawdziwej odpowiedzi HTTP, zeby ktokolwiek zobaczyl, ze zniknela.
 *
 * ⚠️ ODMOWA MOWI, CO ZROBIC — nie samo „nie wolno". Bariera bez wyjscia jest stanem bez
 * wyjscia (PRZEWODNIK.md 4.9): operator, ktory widzi brak przycisku i nie wie, czego
 * brakuje, konczy grzebaniem w bazie albo wysylaniem faktury reka z inFaktu.
 *
 * ⚠️⚠️ FURTKA `bezKsef` ZNIKNELA 01.09.2026 (decyzja właściciela). Do tego dnia jedna przeslanka —
 * brak numeru KSeF — dawala sie zdjac swiadoma decyzja czlowieka, a przycisk otwieral sie po
 * DOBIE czekania. Powod usuniecia jest prosty i wypowiedziany wprost: „fv ida zawsze z ksef",
 * a dokument bez numeru wysyla sie recznie z panelu Allegro albo zakladka „Wiadomosci" —
 * poza panelem, swiadomie, a nie jednym klawiszem obok zwyklej wysylki.
 *
 * ⚠️ TO NIE ZOSTAWIA STANU BEZ WYJSCIA (niezmiennik 4.9), i to jest cala roznica wobec sierpnia,
 * kiedy furtke dokladano: panel UMIE dzis sam wyslac fakture do KSeF (zakladka FAKTURY,
 * `POST /faktury/ksef/wyslij`). Wyjsciem z „czeka na KSeF" jest wiec wyslanie jej do KSeF,
 * a nie ominiecie numeru.
 */
export function wolnoWyslacDoAllegro(z) {
  const nie = (powod) => ({ wolno: false, powod });
  if (!z) return nie('Nie ma takiego zamówienia.');
  // Rozpoznanie kanalu WYLACZNIE wspolnym predykatem — nigdy wlasna kopia
  // `startsWith('allegro_')` (Global Constraints planu B).
  if (!czyKanalAllegro(z)) return nie('To zamówienie nie przyszło z Allegro — nie ma dokąd wysłać faktury.');
  // `chce_fakture` przy kanale to `invoice.required` od Allegro. Decyzja wlasciciela:
  // faktura idzie TYLKO na zadanie kupujacego. Wyslanie dokumentu komus, kto o niego nie
  // prosil, jest tak samo nieodwracalne jak kazde inne — a przy zakupie prywatnym oznacza
  // dokument, ktorego kupujacy u siebie nie chcial.
  if (!z.chce_fakture) return nie('Kupujący nie prosił o fakturę.');
  const f = z.faktura;
  // Numer ORAZ UUID: bez numeru kupujacy nie polaczy dokumentu z nasza ksiegowoscia,
  // a bez UUID-a nie ma skad wziac PDF-u (panel nie trzyma kopii dokumentu).
  if (!f || !f.numer || !f.infakt_uuid) return nie('To zamówienie nie ma jeszcze wystawionej faktury.');
  // ⚠️⚠️ `allegro_wyslana_at` NIE JEST DOWODEM „DOKUMENT U KUPUJACEGO" (recenzja Partii 3, K2).
  // Kolumna niesie wylacznie „PUT .../file sie udal" — a Allegro sprawdza plik antywirusem
  // JUZ POTEM. Przy `REJECTED` kupujacy faktury NIE MA, choc kolumna jest wypelniona.
  //
  // Do 06.08.2026 ta odmowa gryzla takze przy `REJECTED` i robila z niego STAN BEZ WYJSCIA
  // (niezmiennik 4.9): pasek spraw kazal wyslac dokument jeszcze raz, obie trasy odmawialy,
  // przycisku nie bylo, a „Skasowalem w inFakcie" tez odmawia. Panel kazal ponowic, sam
  // odmawial i przy okazji klamal, ze kupujacy fakture ma.
  //
  // ⚠️ `REJECTED` JEST JEDYNYM STANEM, W KTORYM PONOWIENIE JEST BEZPIECZNE I DARMOWE:
  // `allegro_invoice_id` juz mamy, wiec usluga idzie sciezka ADOPCJI i robi sam
  // `PUT .../file`, ktory PODMIENIA plik przy istniejacym zgloszeniu. ZADNEGO drugiego
  // POST-u, wiec ani jednego z dziesieciu slotow wiecej i ani jednego duplikatu.
  //
  // ⚠️ LISTA STANOW PRZEPUSZCZAJACYCH JEST BIALA — dokladnie jak STANY_KONCOWE_WERYFIKACJI
  // nizej i z tego samego powodu. `ACCEPTED`, `WAITING`, pusto ORAZ status, ktorego dzis
  // nie znamy, to dalej „dokument moze byc u kupujacego" i dalej ODMAWIAMY. Czarna lista
  // („wszystko oprocz ACCEPTED") otwieralaby ponowienie przy kazdym nowym statusie Allegro.
  if (f.allegro_wyslana_at && f.allegro_weryfikacja !== 'REJECTED') {
    return nie(
      `Faktura ${f.numer} została już wysłana do Allegro ${f.allegro_wyslana_at} — kupujący ma ją na koncie. `
      + 'Panel nie ma czym jej stamtąd zabrać; jeśli dokument jest błędny, potrzebna jest KOREKTA.',
    );
  }
  // ⚠️⚠️ KOMUNIKAT SKROCONY 01.09.2026 (zgloszenie właściciela) — i to nie byla sama kosmetyka.
  // Zdanie drugie brzmialo „Wyślij ją do KSeF w inFakcie (panel tego nie robi)" i bylo
  // NIEPRAWDA od czasu zakladki FAKTURY: panel wysyla do KSeF sam (`POST /faktury/ksef/wyslij`,
  // domain/wysylka-ksef.js). Odsylal wiec operatora poza panel do czynnosci, ktora panel ma
  // dwie zakladki dalej. Trzecie zdanie kierowalo do przycisku „bez numeru KSeF", ktorego
  // dzis nie ma w ogole.
  if (!f.ksef_numer) {
    return nie(
      `Faktura ${f.numer} nie jest jeszcze w KSeF — a do kupującego ma iść dokument z numerem KSeF.`,
    );
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
 * tym samym wzorcem, co „faktura czekająca na KSeF" (domain/ksef-oczekiwanie.js) i z tego samego
 * powodu: pyta o to zapytanie czuwacza (services/czuwacz-ksef.js), a melduje pasek spraw na
 * karcie (domain/sprawy-karty.js). Dwie kopie warunku rozjeżdżają się przy pierwszej zmianie
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
 * ⚠️ Ukosnik z numeru faktury („12/08/2026") musi zniknac: w nazwie pliku znaczy katalog,
 * a nie da sie przewidziec, co z tym zrobi przegladarka kupujacego przy pobieraniu. Ta sama
 * zasada, co przy nazwie PDF-u proformy (routes/zamowienia.js: bezpiecznaNazwa) — tyle ze
 * tam plik ladowal u nas, a tu laduje u obcego czlowieka i nie da sie go podmienic.
 */
export function nazwaPlikuFaktury(numer) {
  if (!numer) return 'faktura.pdf';
  return `FV-${String(numer).replace(/[^\w.-]+/g, '-')}.pdf`;
}
