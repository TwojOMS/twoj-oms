import { odczytajNadpisania, zastosuj, polaZmienione, sklejUlice } from './dane-reczne.js';

// Dane NABYWCY na fakturę, składane W JEDNYM MIEJSCU — dokładnie tą samą zasadą, co adres
// odbiorcy (domain/adres-odbiorcy.js): wartość ręczna, jeśli jest; w przeciwnym razie ze
// sklepu. Używają tego DWIE strony, które muszą pokazywać to samo: karta zamówienia
// (operator poprawia dane, bo klient napisał, że podał złe) i services/faktura.js (zakłada
// z nich nabywcę w kartotece inFaktu i szuka go po NIP-ie).
//
// Dlaczego OSOBNY komplet danych, a nie ten sam co przy wysyłce: paczka może jechać pod
// adres montażu, a faktura na siedzibę firmy — i klient prosi zwykle o zmianę JEDNEJ
// z nich. Wspólny komplet zmuszałby operatora do decydowania, którą prawdę poświęcić.
//
// Źródłem sklepowym jest blok `klient` (Woo `billing`) plus kolumna `nip` (z meta
// `_billing_nip`, patrz domain/mapowanie.js) — dlatego `nip` jest tu polem obok reszty,
// mimo że w bazie leży w innym miejscu niż `klient_json`.

// `email` doszedł 2026-07-31 na prośbę właściciela i jest NIEOBOWIĄZKOWY: firma bywa
// „zakupy@", „faktury@" albo księgowość zupełnie spoza zamówienia, a adres ze sklepu
// (billing) jest wtedy nie tym, pod który ma pójść dokument.
export const POLA_FAKTURY_RECZNE = ['firma', 'nip', 'ulica', 'kod', 'miasto', 'email'];

// Nazwa firmy DOKŁADNIE ze sklepu — `null`, gdy klient jej nie podał. JEDNO źródło dla
// obu odczytów niżej (`surowe`, które dokłada podstawienie osoby, i `firmaNabywcy`, które
// go nie dokłada), żeby te dwa nie rozjechały się przy pierwszej zmianie.
const firmaZeSklepu = (zamowienie) => zamowienie?.klient?.company || null;

/**
 * NIP bez wpisanej przez klienta ETYKIETY „NIP” — `null`, gdy po niej nic nie zostaje.
 *
 * ⚠️ Zgłoszenie właściciela 14.10.2026: kupujący na Allegro wpisał w pole NIP „NIP: <dziesięć cyfr>”,
 * panel podał to inFaktowi dosłownie i dostał 422 „Podany NIP jest nieprawidłowy”. W bazie
 * produkcyjnej były co najmniej dwa takie zamówienia z Allegro.
 *
 * Zdejmujemy WYŁĄCZNIE etykietę — resztę zostawiamy bajt w bajt. Prefiks kraju („PL”, „SK”)
 * i separatory mają własne, starannie rozdzielone reguły (domain/klient-zbiorczy.js:
 * normalizujNip, domain/wdt.js), a numer unijny nie ma prawa zlać się z polskim.
 */
export function bezEtykietyNip(surowy) {
  const t = String(surowy ?? '').trim().replace(/^NIP(?![A-Z0-9])\s*[:.\-]?\s*/i, '').trim();
  return t || null;
}

// `kraj` CELOWO poza listą pól edytowalnych: nikt o niego nie prosił, a inFakt przyjmuje
// go bez zastrzeżeń w postaci ze sklepu.
function surowe(zamowienie) {
  const k = zamowienie?.klient ?? {};
  const osoba = `${k.first_name ?? ''} ${k.last_name ?? ''}`.trim();
  return {
    // Nazwa nabywcy: firma, a gdy jej nie ma — imię i nazwisko. inFakt wymaga niepustego
    // `company_name` TAKŻE dla osoby prywatnej (422 „Proszę podać nazwę firmy"), więc
    // ostateczny fallback ('Nabywca') zostaje po stronie services/faktura.js — tu chodzi
    // o to, co pokazać człowiekowi i co pozwolić mu poprawić.
    //
    // ⚠️ TO PODSTAWIENIE MA ZOSTAĆ, ale wolno je czytać WYŁĄCZNIE tam, gdzie chodzi
    // o dokument (faktura, proforma, karta, szukanie). Nie wolno go przepisywać do adresu
    // WYSYŁKI — patrz `firmaNabywcy` niżej.
    firma: firmaZeSklepu(zamowienie) || osoba || null,
    // Bez etykiety „NIP” — także w zamówieniach zapisanych przed poprawką 14.10.2026.
    nip: bezEtykietyNip(zamowienie?.nip),
    // Numer budynku bywa OSOBNYM polem sklepu (address_2) — sklejamy dokładnie tą samą
    // regułą co adres wysyłki (sklejUlice w dane-reczne.js), żeby faktura i karta zamówienia
    // pokazywały ten sam adres nabywcy.
    ulica: sklejUlice(k.address_1, k.address_2),
    kod: k.postcode || null,
    miasto: k.city || null,
    kraj: k.country || 'PL',
    email: k.email || null,
  };
}

/** Dane nabywcy DOKŁADNIE ze sklepu — do porównania i do przywracania. */
export const daneFakturyZeSklepu = surowe;

/** Dane nabywcy, które panel uważa za prawdziwe. */
export function daneFaktury(zamowienie) {
  const nadpisania = odczytajNadpisania(zamowienie?.klient_reczny_json);
  return zastosuj(surowe(zamowienie), nadpisania, POLA_FAKTURY_RECZNE);
}

/**
 * PRAWDZIWA nazwa firmy nabywcy — bez podstawiania imienia i nazwiska. `null` znaczy
 * „ten klient nie podał firmy" i jest stanem NORMALNYM (osoba prywatna).
 *
 * ⚠️ PO CO OSOBNE WEJŚCIE, skoro `daneFaktury().firma` już jest. Bo tamto pole niesie
 * podstawienie osoby, potrzebne WYŁĄCZNIE dokumentowi (inFakt wymaga niepustego
 * `company_name` także dla osoby prywatnej — 422 „Proszę podać nazwę firmy"). Wszędzie
 * poza dokumentem to podstawienie jest KŁAMSTWEM o kliencie, a przepisane do adresu
 * wysyłki — kłamstwem TRWAŁYM: „Skopiuj do wysyłki" zapisywało z niego
 * `{"company":"Jan Kowalski"}` do `dostawa_reczna_json`, czyli dokładnie ten błąd, który
 * 05.08 zdjęto z `adres-odbiorcy.js`, tyle że utrwalony w bazie i blokujący prawdziwą
 * nazwę firmy, gdyby sklep kiedyś ją dosłał.
 *
 * To ten sam kształt, co `adresZeSklepu()` obok (adres-odbiorcy.js): dana i podstawienie
 * mają OSOBNE wejścia, a nie jedno, o którym trzeba pamiętać, że czasem zmyśla.
 *
 * Ręczna poprawka operatora ma tu PEŁNĄ moc (ta sama `zastosuj`, co w `daneFaktury`):
 * nazwa firmy dopisana ręcznie jest jawną decyzją człowieka, a nie podstawieniem.
 */
export function firmaNabywcy(zamowienie) {
  const nadpisania = odczytajNadpisania(zamowienie?.klient_reczny_json);
  return zastosuj({ firma: firmaZeSklepu(zamowienie) }, nadpisania, ['firma']).firma;
}

/** Pola faktury odbiegające od sklepu — dostają oznaczenie „zmienione ręcznie". */
export function polaReczneFaktury(zamowienie) {
  return polaZmienione(surowe(zamowienie), daneFaktury(zamowienie), POLA_FAKTURY_RECZNE);
}

// Czy klient chce fakturę. Na sklepie B NIE MA takiego pola — mapowanie
// wnioskuje z NIP-u (patrz domain/mapowanie.js), a to z natury bywa nietrafione: ktoś nie
// poda NIP-u przy zamówieniu, a potem dzwoni po fakturę. Dlatego panel ma własny
// przełącznik, i to ON rozstrzyga, gdy jest ustawiony.
//
// ⚠️ `== null`, NIE prawdziwość: 0 znaczy „operator ŚWIADOMIE powiedział, że faktury nie
// ma być" i musi wygrywać ze sklepowym NIP-em tak samo mocno, jak 1 wygrywa z jego brakiem.
// Sprawdzanie prawdziwości robiłoby z wyłączenia brak nadpisania — czyli jedyny kierunek
// przełącznika, którego nie dałoby się użyć.
export function chceFakture(zamowienie) {
  const reczne = zamowienie?.chce_fakture_reczne;
  return reczne == null ? Boolean(zamowienie?.chce_fakture) : Boolean(reczne);
}

/** Czy przełącznik odbiega od tego, co wnioskuje sklep — do oznaczenia na karcie. */
export function chceFaktureZmienioneRecznie(zamowienie) {
  const reczne = zamowienie?.chce_fakture_reczne;
  return reczne != null && Boolean(reczne) !== Boolean(zamowienie?.chce_fakture);
}
