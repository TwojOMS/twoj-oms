import { naNumerDnia, zNumeruDnia, sklejDate, numerDniaZNapisu } from './kalendarz.js';

// Czyste reguły listy faktur — bez sieci, bez bazy, bez zegara (dzień przychodzi argumentem).
// Tych samych odpowiedzi potrzebują trzy warstwy: usługa widoku, sam widok i testy.

/** Do ilu dni przed terminem świecimy ostrzegawczo. Tydzień = jeden cykl przelewów. */
export const PROG_WKROTCE_DNI = 7;

export function dniDoTerminu(termin, dzis) {
  const a = numerDniaZNapisu(String(termin ?? '').trim());
  const b = numerDniaZNapisu(String(dzis ?? '').trim());
  if (a === null || b === null) return null;
  return a - b;
}

export function stanTerminu(termin, dzis) {
  const dni = dniDoTerminu(termin, dzis);
  if (dni === null) return 'brak';
  if (dni < 0) return 'po_terminie';
  if (dni === 0) return 'dzis';
  return dni <= PROG_WKROTCE_DNI ? 'wkrotce' : 'odlegly';
}

export function opisTerminu(termin, dzis) {
  const dni = dniDoTerminu(termin, dzis);
  if (dni === null) return 'bez terminu';
  if (dni < 0) return `po terminie o ${-dni} ${-dni === 1 ? 'dzień' : 'dni'}`;
  if (dni === 0) return 'termin dzisiaj';
  return `za ${dni} ${dni === 1 ? 'dzień' : 'dni'}`;
}

/**
 * `'2026-06'` → `{ od: '2026-06-01', do: '2026-06-30' }`.
 *
 * Ostatni dzień liczymy jako „pierwszy dzień następnego miesiąca minus jeden" na NUMERZE DNIA
 * — dzięki temu luty, rok przestępny i grudzień nie mają własnych przypadków w kodzie.
 */
export function zakresMiesiaca(miesiac) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(miesiac ?? '').trim());
  if (!m) return null;
  const rok = Number(m[1]);
  const nr = Number(m[2]);
  if (nr < 1 || nr > 12) return null;
  const pierwszy = naNumerDnia(rok, nr, 1);
  const nastepny = nr === 12 ? naNumerDnia(rok + 1, 1, 1) : naNumerDnia(rok, nr + 1, 1);
  return { od: sklejDate(zNumeruDnia(pierwszy)), do: sklejDate(zNumeruDnia(nastepny - 1)) };
}

/**
 * Stan dokumentu wobec KSeF — TRZY odpowiedzi, nie dwie.
 *
 * ⚠️ ROZSTRZYGA `ksef_number`, A NIE `ksef_data`. Zmierzone 06.08.2026: faktura VAT pola
 * `ksef_data` w ogóle nie oddaje (także przy `fields=…,ksef_data`); ma je dopiero korekta.
 * Reguła oparta na obiekcie działałaby na korektach i milczała na fakturach — czyli tam,
 * gdzie jest cały ruch.
 *
 * ⚠️⚠️ TRZECI STAN `wyslana_czeka` POWSTAŁ Z FAŁSZU NA EKRANIE, KTÓREGO CAŁYM ZADANIEM JEST
 * ZŁAPAĆ POMYŁKĘ PRZED OPERACJĄ NIEODWRACALNĄ (recenzja całości, Finding 1). inFakt nadaje
 * numer KSeF dopiero po ~70 sekundach od przyjęcia zlecenia, więc dokument wysłany o 14:00
 * miał go dopiero o 14:01 — a lista otwarta o 14:00:30 pisała przy nim „brak", oddawała pole
 * wyboru, „zaznacz wszystkie" brało go z powrotem, a ekran podglądu liczył go do „Poleci do
 * KSeF". Drugie zatwierdzenie odbiłoby się od rezerwacji w bazie (db/wysylki-ksef.js), ale
 * człowiek dowiedziałby się o tym dopiero po kliknięciu przycisku od operacji nieodwracalnej.
 *
 * ⚠️ NUMER MA PIERWSZEŃSTWO PRZED REZERWACJĄ: gdy organ numer nadał, dokument JEST w KSeF,
 * a nie „czeka" — inaczej wiersz zostawałby w stanie przejściowym na zawsze.
 *
 * ⚠️ FUNKCJA ZOSTAJE CZYSTA. Fakt „panel zlecił wysyłkę" (wiersz w `wysylki_ksef`, klucz =
 * uuid inFaktu) przychodzi ARGUMENTEM — czyta go services/faktury-widok.js jednym zapytaniem
 * na całą listę. Wołanie bez drugiego argumentu zachowuje się dokładnie jak przed zmianą.
 */
export const stanKsef = (dok, zlecona = false) => {
  if (dok?.ksef_number) return 'jest';
  return zlecona ? 'wyslana_czeka' : 'brak';
};

/** Status inFaktu znaczący „zapłacone". Jedyny, jaki wolno tu rozpoznać — patrz niżej. */
const STATUS_ZAPLACONA = 'paid';

/** Sposób zapłaty „za pobraniem" na dokumencie inFaktu (pomiar — domain/sposob-platnosci.js). */
const PLATNOSC_POBRANIE = 'delivery';

/**
 * Czy inFakt uważa ten dokument za zapłacony — TRZY odpowiedzi, nie dwie.
 *
 * ⚠️⚠️ POWSTAŁA Z ROZJECHANIA SIĘ DWÓCH KOPII TEJ SAMEJ ODPOWIEDZI. Do 28.08.2026 pas długów
 * pytał o `status` (poprawka z 10.08), a kolumna „Płatność" obok — o `left_to_pay`. Zmierzone
 * na żywym koncie 28.08: SZEŚĆ dokumentów sierpnia miało `status: paid` i niezerowe
 * `left_to_pay`, więc pas milczał, a kolumna świeciła na czerwono przy tej samej fakturze
 * (zgłoszona 51/08/2026: `paid`, `paid_date: 2026-08-26`, `left_to_pay: 99000`).
 *
 * ⚠️ OBA WARUNKI SĄ POTRZEBNE i każdy stoi przed INNĄ awarią:
 *   - sam `status`:      przedpłata ma `left_to_pay: 0`, ale status `sent` (pomiar 04.08) —
 *                        cała sprzedaż ze sklepów wyglądałaby na dług „0,00 zł";
 *   - sam `left_to_pay`: te sześć wyżej, bo oznaczenie zapłaty tego pola NIE ZERUJE
 *                        (nie ustawia też `paid_price` — zostaje `0`, pomiar 28.08).
 *
 * ⚠️ TRZECI STAN ISTNIEJE, ŻEBY NIE ZGADYWAĆ. Dokument bez statusu i bez kwoty nie mówi nic,
 * a `do_zaplaty` byłoby przy nim oskarżeniem klienta o dług, którego nikt nie zmierzył.
 * Pas długów traktuje `nieznany` jak `do_zaplaty` (patrz `czekaNaPrzelew`) — bo tam milczenie
 * kosztuje więcej niż fałszywy alarm — ale KOLUMNA ma prawo powiedzieć „nie wiem".
 */
export function stanZaplaty(dok) {
  if (dok?.status === STATUS_ZAPLACONA) return 'zaplacona';
  // Zero ZNACZY „nic nie zostało" tylko wtedy, gdy inFakt naprawdę podał liczbę.
  // ⚠️ `Number(null)` TO `0`, a `Number('')` też — samo `Number.isFinite(Number(x))` uznałoby
  // więc BRAK POLA za dowód zapłaty. Stąd sprawdzenie typu PRZED przeliczeniem.
  const surowe = dok?.left_to_pay;
  const podane = typeof surowe === 'number'
    || (typeof surowe === 'string' && surowe.trim() !== '');
  if (podane && Number.isFinite(Number(surowe)) && Number(surowe) <= 0) return 'zaplacona';
  if (podane || typeof dok?.status === 'string') return 'do_zaplaty';
  return 'nieznany';
}

/**
 * Czy ten dokument to pieniądze, na które CZEKAMY NA PRZELEW — czyli wiersz pasa długów.
 *
 * ⚠️⚠️ TO NIE JEST „left_to_pay > 0" I NIE WOLNO DO TEGO WRÓCIĆ. Zgłoszenie właściciela
 * 10.08.2026, potwierdzone pomiarem na żywym koncie tego samego dnia:
 *
 *   q[left_to_pay_gt]=0                  → 67 dokumentów:  status paid=65, sent=2
 *   q[left_to_pay_gt]=0 & status!=paid   → 2:  64/07/2026, 24/08/2026   (dokładnie te zaległe)
 *   z 65 odsianych — KAŻDY ma wypełnione `paid_date`
 *
 * Oznaczenie zapłaty w inFakcie ustawia `status` i `paid_date`, ale **`left_to_pay` zostawia
 * nietknięte** — dokładnie ta sama pułapka, którą moduł ma zmierzoną przy `/paid.json`
 * (docblock `ZAPLACONE` w domain/termin-platnosci.js). Pas długów pokazywał więc 67 pozycji na
 * ~35 tys. zł, gdy realnie zalegały dwie. Pole `left_to_pay` mówi, ILE zostało do zapłaty na
 * dokumencie; o tym, CZY zapłacono, mówi status.
 *
 * ⚠️ OBA WARUNKI MUSZĄ ZACHODZIĆ NARAZ, bo każdy stoi przed INNĄ awarią — i każdy z osobna
 * przepuszcza tę drugą:
 *   - sam status:      faktura przedpłacona z `paid_price` ma `left_to_pay: 0`, ale status
 *                      `sent` (pomiar 04.08.2026) → cała sprzedaż ze sklepów wjechałaby na
 *                      listę długów z kwotą „0,00 zł";
 *   - sam left_to_pay: te 65 wyżej.
 *
 * ⚠️ POBRANIE ODPADA OSOBNO (decyzja właściciela 10.08.2026): pieniądze odbiera kurier, więc
 * nikt nie czeka na przelew i nie ma kogo upominać. Dziś wszystkie 31 takich dokumentów ma już
 * status `paid`, czyli ten warunek zdejmuje ZERO wierszy — stoi za fakturę wystawioną DZIŚ,
 * zanim pobranie wróci z DPD. ⚠️ Dokumenty za pobraniem sprzed 07.08.2026 mają jeszcze
 * `payment_method: 'transfer'` (błąd naprawiony tamtego dnia) i tą drogą się nie odsieją —
 * odsiewa je status, bo wszystkie są już rozliczone.
 *
 * ⚠️ ODSIEWAMY WYŁĄCZNIE NA DOWÓD ZAPŁATY, nigdy na braku danych. Nieznany status, brak statusu
 * i nieznana metoda płatności ZOSTAJĄ na liście, tak samo jak dokument, którego w ogóle nie ma.
 * Fałszywy alarm o pieniądzach jest widoczny i człowiek go wyjaśni w minutę; cicho ukryty dług
 * nie daje o sobie znać w ogóle. Ta sama zasada, co przy odmowie zamiast pustej listy
 * w services/faktury-widok.js: na tym ekranie milczenie kosztuje więcej niż fałszywy alarm.
 *
 * ⚠️ SPROSTOWANIE 28.08.2026: rozstrzygnięcie „czy zapłacono" wyprowadzone do `stanZaplaty`
 * wyżej. Ta funkcja dokłada do niego WYŁĄCZNIE swoje dwie rzeczy: odsianie pobrania i to,
 * że `nieznany` ZOSTAJE na liście długów. Powód wyprowadzenia jest w docblocku tamtej.
 *
 * ⚠️ FAKT O PACZCE JEDZIE ARGUMENTEM, A FUNKCJA ZOSTAJE CZYSTA — dokładnie tym wzorcem,
 * co `zlecona` w `stanKsef` wyżej. Składa go `services/faktury-widok.js` JEDNYM zapytaniem
 * na całą listę (faktury → zamowienia → przesylki), nie jednym na wiersz. Wołanie bez
 * drugiego argumentu zachowuje się dokładnie jak przed zmianą.
 *
 * ⚠️ ARGUMENT NAZYWA SIĘ `pobranieBezGotowki`, A NIE `pobranieZwrocone` (recenzja poprawkowa
 * 28.08.2026, W4) — i to jest cała zmiana nazwy: zwrot NIE JEST jedynym sposobem, w jaki
 * gotówka przy pobraniu nie dochodzi. Nieudane doręczenie („adresat nieobecny", awizo) daje
 * etap `doreczona`, więc pod starą nazwą i starym pytaniem taki dokument znikał z pasa długów
 * na stałe. Odpowiada `czyPaczkaBezGotowki` (domain/pobranie-zaplacone.js) — TA SAMA funkcja,
 * z której czyta czuwacz pobrań.
 *
 * ⚠️⚠️ POWÓD (spec 2026-08-28): odsianie pobrania było BEZWARUNKOWE, więc paczka NIEODEBRANA
 * — czyli realny dług, bo kurier niczego nie zainkasował — znikała z pasa tak samo jak
 * doręczona. Do 28.08 nie bolało, bo pobrania i tak nie miały statusu `paid` i widać je było
 * w tabeli miesiąca; po domknięciu pętli (services/oznaczanie-pobran.js) przestałyby być
 * widoczne gdziekolwiek.
 */
export function czekaNaPrzelew(dok, { pobranieBezGotowki = false } = {}) {
  if (stanZaplaty(dok) === 'zaplacona') return false;
  // Pieniądze odbiera kurier, więc nie ma na co czekać i nie ma kogo upominać — ale
  // WYŁĄCZNIE dopóki paczka jest w drodze albo naprawdę doszła.
  if (dok?.payment_method === PLATNOSC_POBRANIE && !pobranieBezGotowki) return false;
  return true;
}

// ⚠️ Nie wystarczy `?? []` — zdegradowana odpowiedź API potrafi oddać PRAWDZIWY, niepusty
// obiekt (np. `{ error: … }`) albo liczbę zamiast tablicy, a obie te wartości są truthy,
// więc `??` je przepuszcza i rozkłada spreadem, który rzuca `TypeError`. Ta funkcja renderuje
// EKRAN i nie ma prawa go zwalić na złym payloadzie — nie-tablica to tu „brak dokumentów",
// nie błąd do zgłoszenia.
const bierz = (x) => (Array.isArray(x) ? x : []);

export function scalDokumenty(faktury, korekty) {
  const wszystkie = [...bierz(faktury), ...bierz(korekty)];
  return wszystkie.sort((a, b) => {
    const da = String(a?.invoice_date ?? '');
    const db = String(b?.invoice_date ?? '');
    if (da !== db) return db.localeCompare(da);
    return String(b?.number ?? '').localeCompare(String(a?.number ?? ''));
  });
}
