import { czyPobranie } from './wysylka.js';
import { etapPrzesylki, KODY_ALLEGRO } from './etap-przesylki.js';
import { dzienWarszawa } from './format-daty.js';

// KIEDY POBRANIE JEST JUŻ PIENIĘDZMI — czysta reguła, bez bazy, bez sieci, bez zegara.
//
// ⚠️⚠️ REGUŁA BRZMI „DORĘCZONA = OPŁACONA", NIGDY „POBRANIE = OPŁACONE" (decyzja właściciela
// 28.08.2026). Różnica nie jest kosmetyczna: paczka nieodebrana wraca ZWROTEM i pieniędzy
// nie ma. Reguła oparta na samej metodzie płatności oznaczałaby taki dokument jako zapłacony
// i skasowała jedyny ślad po niezapłaconym zamówieniu.
//
// ⚠️ TA REGUŁA NIE JEST DRUGĄ PRAWDĄ O PIENIĄDZACH. O zapłacie dalej mówi inFakt i jego
// `status` (spec §4.1). Ona odpowiada na inne pytanie: czy panel ma inFaktowi ZGŁOSIĆ fakt,
// którego tamten nie zna, bo kurier nie rozmawia z księgowością.

/** Etap przesyłki, przy którym pieniądze są już u nas. Jeden, celowo. */
const ETAP_ZAPLATY = 'doreczona';

/**
 * BEZPIECZNIK NIEUDANEGO DORĘCZENIA — świadomie stoi TUTAJ, a nie w `etapPrzesylki`.
 *
 * `etapPrzesylki` (etap-przesylki.js) klasyfikuje po fragmentach opisu i „Nie doręczono —
 * adresat nieobecny" albo „Nieudana próba doręczenia" wpada w te same wzorce co prawdziwe
 * doręczenie (`doręczon`, `odbiorc`). Dziś kosztuje to najwyżej złą pastylkę na ekranie
 * przesyłek — `etapPrzesylki` obsługuje też zakładkę przesyłek i czuwacza bez ruchu, więc
 * naprawa jej wzorców to osobna decyzja o szerszym zasięgu (właściciel, 28.08.2026: NIE ruszać).
 * W ścieżce pieniędzy ta sama pomyłka oznaczałaby fakturę jako opłaconą, choć kurier
 * niczego nie zainkasował — stąd druga, węższa bramka, TYLKO tutaj, TYLKO dla PIENIĘDZY.
 *
 * ⚠️ „TYLKO tutaj" ZNACZY „TYLKO W TYM MODULE", a nie „tylko dla czuwacza pobrań": od
 * 28.08.2026 czyta ją także pas długów, przez `czyPaczkaBezGotowki` niżej. To dalej jest
 * JEDNA bramka — po prostu z dwoma wołającymi.
 *
 * Warianty celowo bez polskich znaków — nie każdy kurier je wysyła w opisie zdarzenia.
 */
const FRAZY_NIEUDANEGO_DORECZENIA = [
  'nie doręcz', 'niedoręcz', 'nie dorecz', 'niedorecz',
  'nieudan', 'nieobecn', 'awizo', 'próba doręcz', 'proba dorecz', 'odmow',
];

function opisBrzmiJakNieudaneDoreczenie(opis) {
  const s = String(opis ?? '').trim().toLowerCase();
  return FRAZY_NIEUDANEGO_DORECZENIA.some((f) => s.includes(f));
}

/**
 * CZY PRZY TEJ PACZCE PIENIĘDZY NIE MA — jedna reguła, DWÓCH czytelników.
 *
 * ⚠️⚠️ ISTNIEJE, BO DWIE WARSTWY PYTAŁY O TO SAMO INACZEJ (recenzja poprawkowa 28.08.2026, W4).
 * Ścieżka pieniędzy (`czyPobranieRozliczone` niżej) miała bezpiecznik nieudanego doręczenia,
 * a pas długów (services/faktury-widok.js) pytał wyłącznie `etapPrzesylki(...) === 'zwrot'`.
 * Skutek na paczce ze statusem „Nie doręczono — adresat nieobecny": `etapPrzesylki` daje
 * `doreczona`, więc czuwacz przesyłek PRZESTAJE ją odpytywać (doręczone wypadają z puli),
 * a pas długów jej NIE POKAZUJE, bo to nie „zwrot". Gotówki nie ma, faktura w inFakcie
 * nieopłacona, a dokument znika z listy „kto nam zalega" NA STAŁE — w naszych danych ta
 * paczka już się nigdy nie ruszy.
 *
 * ⚠️ ŚWIADOMIE PRZYJMUJEMY FAŁSZYWY ALARM. Paczka doręczona za DRUGIM podejściem (kurier
 * wrócił nazajutrz, ale ostatni zapisany opis jest ten nieudany) pokaże się na pasie długów,
 * dopóki nie zajrzy tam człowiek. To jest TAŃSZE niż dług ukryty na zawsze — ta sama
 * doktryna, co w całym module: odsiewamy na DOWÓD zapłaty, nigdy na braku danych.
 *
 * ⚠️ „W DRODZE" TO NIE JEST TA ODPOWIEDŹ. Przy paczce jadącej gotówki też jeszcze nie ma,
 * ale BĘDZIE — i właśnie dlatego pas długów jej nie pokazuje. Ta funkcja mówi wyłącznie
 * o paczce, przy której kurier NIE zainkasował i sam z siebie już nie zainkasuje.
 */
export function czyPaczkaBezGotowki(przesylka) {
  const kod = przesylka?.status_kuriera_kod;
  if (etapPrzesylki(przesylka?.status_kuriera, kod) === 'zwrot') return true;
  // Bezpiecznik dotyczy TYLKO etapu wziętego z OPISU. Gdy `kod` jest znanym kodem
  // maszynowym Allegro, to on rozstrzyga — kod nie jest tłumaczonym tekstem, więc żaden
  // fragment opisu (np. dołączony po polsku obok kodu) go nie cofa.
  const zKoduZnany = Boolean(KODY_ALLEGRO[String(kod ?? '').trim()]);
  return !zKoduZnany && opisBrzmiJakNieudaneDoreczenie(przesylka?.status_kuriera);
}

export function czyPobranieRozliczone({ zamowienie, przesylka, uuidFaktury } = {}) {
  // Bez dokumentu w inFakcie nie ma czego oznaczać — i nie jest to błąd, tylko normalny
  // stan zamówienia, na które nikt nie prosił o fakturę.
  if (!uuidFaktury) return false;
  // Wartość EFEKTYWNA, po ręcznych korektach (`czyPobranie` czyta nadpisanie, a w jego
  // braku kolumnę) — a nie `kwota_pobrania`. To decyzja o pobraniu rządzi, kwota jest
  // jej skutkiem; ta sama zasada, co w `platnoscPrzyOdbiorze` (domain/platnosci.js).
  if (!czyPobranie(zamowienie)) return false;
  // Etap liczony z OSTATNIEGO znanego statusu — dokładnie jak w czuwaczu przesyłek.
  // Brak statusu daje etap inny niż `doreczona`, więc milczenie kuriera NIE jest zapłatą.
  if (etapPrzesylki(przesylka?.status_kuriera, przesylka?.status_kuriera_kod) !== ETAP_ZAPLATY) {
    return false;
  }
  // Bezpiecznik nieudanego doręczenia — TA SAMA funkcja, z której czyta pas długów.
  // Przy etapie `doreczona` sprowadza się dokładnie do dawnego warunku (etap nie jest
  // `zwrot`, więc zostaje pytanie o frazy), tyle że kopia jest JEDNA.
  if (czyPaczkaBezGotowki(przesylka)) return false;
  return true;
}

// Poprawna data to WYŁĄCZNIE napis `RRRR-MM-DD`. Cokolwiek innego — `null`, `undefined`,
// pusty napis, „bzdura", liczba, obiekt `Date` — datą nie jest i nie wolno go porównywać
// jak daty (patrz pułapka niżej w docblocku funkcji).
const JEST_POPRAWNA_DATA = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Dzień, który poleci do inFaktu jako `paid_date` — albo `null`, gdy żadnej daty nie znamy.
 *
 * ⚠️⚠️ KONTRAKT (od Poprawki 1, 28.08.2026): FUNKCJA MOŻE ZWRÓCIĆ `null`. WOŁAJĄCY MA
 * OBOWIĄZEK TO SPRAWDZIĆ i przy `null` NIE wysyłać oznaczenia zapłaty do inFaktu — zamiast
 * tego zostawić ślad (log / status do wyjaśnienia ręcznego). Wcześniej funkcja zawsze
 * zwracała jakąś datę; `invoiceDate === null` (realnie osiągalne, gdy pochodzi z odpowiedzi
 * inFaktu: `dane?.invoice_date ?? null`) przechodziło przez `dzien > null`, JS konwertował
 * `null` na `0` i prawie każda data wygrywała porównanie — poza `dzien` pustym, gdzie
 * funkcja PO CICHU oddawała `null`, mimo że dzień doręczenia był ZNANY. `null` leciałby
 * dalej jako `paid_date` do systemu księgowego.
 *
 * Reguła (rozstrzygnięcie właściciela, 28.08.2026):
 *  - znamy dzień doręczenia, `invoiceDate` NIE jest poprawną datą → dzień doręczenia
 *    (znamy datę, więc nie ma powodu jej gubić);
 *  - NIE znamy dnia doręczenia I `invoiceDate` NIE jest poprawną datą → `null`
 *    (jedyny przypadek odmowy: nie ma żadnej daty do wysłania, a zmyślona data w dokumencie
 *    księgowym jest gorsza niż brak oznaczenia);
 *  - oba poprawne → PÓŹNIEJSZA z dwóch, jak dotychczas.
 *
 * ⚠️ PÓŹNIEJSZA Z DWÓCH DAT. Dokumentacja `/paid.json` stawia jeden warunek: `paid_date`
 * nie wcześniejsza niż data wystawienia. Paczka doręczona 25.08 przy fakturze wystawionej
 * 27.08 dałaby odmowę — i status, który miał się naprawić, zostałby zły. Ta sama bramka, co
 * w `dataZaplatyDoOznaczenia` (services/faktura.js), i celowo ta sama: dwie drogi do
 * oznaczenia zapłaty nie mogą liczyć daty inaczej.
 *
 * ⚠️⚠️ `status_kuriera_at` BYŁA DO 28.08.2026 KOLUMNĄ CZYSTO PREZENTACYJNĄ (komentarz przy
 * `zapiszStatusDpd` w db/przesylki.js) i ten moduł czyni ją NOŚNĄ. Zapisywana jest jako
 * `at ?? null`, więc BYWA PUSTA — kurier nie zawsze oddaje czas zdarzenia. Brak daty NIE
 * JEST sama w sobie powodem do odmowy: to krok po fakcie doręczenia, więc gdy `invoiceDate`
 * jest poprawną datą, spadamy na nią — ona jest zawsze poprawna i zawsze spełnia warunek
 * inFaktu. Odmowa oznaczenia z powodu brakującego stempla zostawiłaby dokument jako
 * fałszywy dług na zawsze.
 *
 * Porównanie LEKSYKOGRAFICZNE na `RRRR-MM-DD`: w tym formacie porządek napisów JEST
 * porządkiem kalendarza, a `new Date('2026-10-25')` czyta napis jako UTC i potrafi cofnąć
 * się o dobę.
 */
export function dataZaplatyPobrania(przesylka, invoiceDate) {
  return pozniejszaZnanaData(dzienWarszawa(przesylka?.status_kuriera_at ?? ''), invoiceDate);
}

/**
 * PÓŹNIEJSZA Z DWÓCH ZNANYCH DAT — albo `null`, gdy żadna nie jest datą.
 *
 * Sedno kontraktu `dataZaplatyPobrania` wyżej, wyjęte osobno WYŁĄCZNIE dlatego, że drugi
 * wołający ma ten sam problem z inną pierwszą datą: skrypt sprzątający liczy `paid_date`
 * także dla dokumentów rozliczonych WPŁATAMI (services/sprzatanie-zaplat.js), gdzie dniem
 * zapłaty jest dzień pokrycia kwoty, a nie dzień doręczenia. Reguła — „nie zejść poniżej
 * daty wystawienia, a przy braku obu dat nie wysyłać nic" — jest w obu przypadkach TA SAMA
 * i nie ma prawa istnieć w dwóch kopiach: rozjazd między nimi kończyłby się `paid_date`,
 * które inFakt odrzuca, albo — gorzej — datą zmyśloną w dokumencie księgowym.
 *
 * @param dzien dzień `RRRR-MM-DD` albo pusty napis, gdy nieznany (tak oddaje `dzienWarszawa`).
 */
export function pozniejszaZnanaData(dzien, invoiceDate) {
  // `dzienWarszawa` oddaje pusty napis przy wartości nieparsowalnej — pusty jest
  // leksykograficznie MNIEJSZY niż każda data, więc sam `Math.max` by go odsiał; sprawdzamy
  // jednak wprost, żeby czytelnik nie musiał tego wyprowadzać.
  const invoiceDateOk = typeof invoiceDate === 'string' && JEST_POPRAWNA_DATA.test(invoiceDate);
  if (!dzien) return invoiceDateOk ? invoiceDate : null;
  if (!invoiceDateOk) return dzien;
  return dzien > invoiceDate ? dzien : invoiceDate;
}
