// ZDANIA O PŁATNOŚCI W MAILACH DO KLIENTA (PRZ-102.17, zlecenie właściciela 20.10.2026: „gdzie to się ustawia" — i chce
// móc je zmienić). Ustawienia → Szablony wiadomości → sekcja „Zdania o płatności".
//
// Moduł czysty: lista zdań, teksty domyślne, opisy „kiedy pada" i reguły treści. Nie czyta bazy i nie wysyła.
//
// Edytowalne są WYŁĄCZNIE zdania będące czystym tekstem: siedem wariantów zdania zamykającego (`{zamkniecie}`),
// dwa nagłówki bloku `{dane_platnosci}` i dwa zdania o załącznikach. Danych w bloku (kwota, odbiorca, rachunek, tytuł,
// termin) nikt tu nie zmienia — liczy je kod (blok-platnosci.js).
//
// PRZ-102.19 (właściciel 20.10: „szablony nie mają sensu, jeżeli część danych jest zapisana w kodzie") dołożył drugą część
// sekcji, „Etykiety i stałe teksty" (`etykieta: true`, do 30 znaków): etykiety wierszy przelewu i dopisek „brutto",
// nagłówki, kolumny i stałe teksty bloków zamówienia ({pozycje}, {sposob_platnosci}, {wysylka}, {dane_do_faktury})
// oraz „Pozdrawiamy," z bloku {podpis}. Ten sam zapis, ten sam formularz, te same reguły przy zapisie i przy odczycie.
// Wartości (kwota, rachunek, tytuł, termin, pozycje, adres) dalej liczy kod — z panelu zmienia się tylko napis obok.
//
// ⚠️ BRAK ZAPISU = DZISIEJSZY MAIL CO DO ZNAKU. Teksty domyślne niżej to dosłowne zdania, które do PRZ-102.17/19 stały
// na sztywno w rendererach maili; test porównuje maile z wzorcem zapisanym przed zmianą
// (tests/moduly/wiadomosci/zdania-platnosci-rownosc-prz102-17.test.js).

export const KLUCZ_ZDAN = 'wiadomosci.zdania_platnosci';

export const MAKS_ZDAN = Object.freeze({ zdanie: 300, naglowek: 40, etykieta: 30 });

/** Pole wstawiane w zdanie o załączonej proformie — numer dokumentu zna dopiero usługa (koperta maila). */
export const POLE_NUMERU_PROFORMY = '{numer_proformy}';

// Zdanie przy pobraniu musi mówić, że płaci się przy doręczeniu — bez tego klient zapłaci przelewem i drugi raz
// kurierowi (ten sam powód, dla którego {zamkniecie} jest obowiązkowe: POLA w szablony-wiadomosci.js, powodWymogu).
// Bez polskich znaków też („doreczeniu"), bo klient przeczyta to tak samo.
const RE_POBRANIE = /kurier|dor[eę]czeni/iu;

// ——— Prośba o zapłatę (recenzja PRZ-102.17: pierwsza wersja przepuszczała „Prosimy o zapłatę 476 zł.") ————————
//
// Tekst sprawdzamy po sprowadzeniu do małych liter BEZ polskich znaków (`plaski`), więc „Zapłać", „ZAPLAC" i „zapłać"
// to jedno i `\b` działa (same litery ASCII). Najpierw wycinamy ZAPRZECZENIA zapłaty („nie trzeba nic przelewać",
// „nie musisz już nic dopłacać", „nie ma potrzeby przelewania", „nie płać") — tylko z krótką listą wypełniaczy
// między „nie" a czasownikiem, żeby „nie zapomnij zapłacić" NIE było zaprzeczeniem.
//
// REGUŁA dla „opłacone" — zdanie PROSI o zapłatę, gdy po wycięciu zaprzeczeń ma którekolwiek z:
//   1. czasownik prośby w trybie rozkazującym albo bezokoliczniku (przelej, przelać, zapłać, zapłacić, wpłać, dopłać,
//      ureguluj, uregulować, płać, płacić…);
//   2. „prosimy / proszę / czekamy / oczekujemy" i w tym samym zdaniu (do kropki) rdzeń płatności (zapłat, wpłat,
//      przelew/przelan, płatno, uregulow, należno, dopłat);
//   3. dane do zapłaty: „do zapłaty", termin…, rachun…, konto/konta, ciąg 6+ cyfr (także z odstępami — numer rachunku),
//      kwota z „zł";
//   4. sam rzeczownik płatności (zapłata, wpłata, przelew, przelanie, płatność, należność, dopłata) BEZ słowa
//      potwierdzenia, że to już się stało: dotarł…, zaksięgowan…, otrzymal…/otrzyman…, wpłynęł…, „dziękujemy za",
//      zaplacon…/oplacon…, rozliczon…, zarejestrowan….
// Przechodzą więc „Zamówienie jest opłacone — dziękujemy.", „Dziękujemy za wpłatę.", „Wpłata dotarła.", „Płatność
// zaksięgowana.", a odpadają „Prosimy o płatność.", „Czekamy na wpłatę.", „Prosimy o przelew na konto …".
//
// Dla „pobranie" pieniądze SĄ do zapłaty — kurierowi — więc „Zapłać kurierowi" i „Należność pobierze kurier" są
// w porządku. Groźny jest wyłącznie DRUGI kanał: przelew albo wpłata na konto. Odmowa, gdy po wycięciu zaprzeczeń
// zostaje: przel…, wpłat…/wpłac…, konto/konta, rachun… albo ciąg 6+ cyfr. Domyślne „nie trzeba nic przelewać"
// przechodzi (zaprzeczenie), „…ale prosimy też o przelew" i „Nie płać kurierowi, zapłać przelewem" — nie.
//
// To filtr na oczywistą pomyłkę, nie rozumienie zdania: zdanie, które prosi o pieniądze peryfrazą bez żadnego z tych
// słów („liczymy na szybki ruch z Państwa strony"), przejdzie.

const plaski = (s) => String(s).toLocaleLowerCase('pl-PL')
  .replace(/[ąćęłńóśźż]/gu, (c) => ({ ą: 'a', ć: 'c', ę: 'e', ł: 'l', ń: 'n', ó: 'o', ś: 's', ź: 'z', ż: 'z' })[c]);

const RDZEN_ZAPLATY = '(?:przel|wplac|wplat|zaplac|zaplat|doplac|doplat|plac)';
const WYPELNIACZE = '(?:nic|juz|niczego|wiecej|dodatkowo|dodatkow[a-z]*|zadn[a-z]*|zadnych)';
const RE_ZAPRZECZENIE = new RegExp(`\\bnie\\s+(?:ma\\s+potrzeby\\s+|trzeba\\s+|potrzeba\\s+|musisz\\s+|musicie\\s+|nalezy\\s+)?`
  + `(?:${WYPELNIACZE}\\s+){0,2}${RDZEN_ZAPLATY}[a-z]*`, 'g');

const RE_CZASOWNIK_PROSBY = /\b(?:przelej(?:cie)?|przelac|przelewac|zaplac(?:cie)?|zaplacic|wplac(?:cie)?|wplacic|doplac(?:cie)?|doplacic|ureguluj(?:cie)?|uregulowac|plac(?:cie)?|placic)\b/;
const RE_FRAZA_PROSBY = /\b(?:prosimy|prosze|czekamy|czekam|oczekujemy|oczekuje)\b[^.!?]{0,80}?(?:zaplat|wplat|przel[ae]|przelew|platno|uregulow|naleznos|doplat)/;
const RE_DANE_DO_ZAPLATY = /\bdo zaplaty\b|\btermin[a-z]*|\brachun[a-z]*|\bkont[oa]\b|\d(?:[  ]?\d){5,}|\d+(?:[.,]\d+)?\s*zl\b/;
const RE_RZECZOWNIK_PLATNOSCI = /\b(?:zaplat[a-z]*|wplat[a-z]*|przelew[a-z]*|przelani[a-z]*|platnos[a-z]*|naleznos[a-z]*|doplat[a-z]*)/;
const RE_POTWIERDZENIE = /\b(?:dotarl[a-z]*|zaksiegowan[a-z]*|otrzymal[a-z]*|otrzyman[a-z]*|wplynel[a-z]*|wplynal[a-z]*|zaplacon[a-z]*|oplacon[a-z]*|rozliczon[a-z]*|zarejestrowan[a-z]*)|\bdziekujemy za\b/;
const RE_DRUGI_KANAL = /\bprzel[a-z]*|\bwpla[ct][a-z]*|\bkont[oa]\b|\brachun[a-z]*|\d(?:[  ]?\d){5,}/;

/** Fragment zdania, który PROSI o zapłatę (do komunikatu), albo `null`. Reguła — komentarz wyżej. */
export function prosbaOZaplate(tekst) {
  const t = plaski(tekst).replace(RE_ZAPRZECZENIE, ' ');
  const m = RE_CZASOWNIK_PROSBY.exec(t) ?? RE_FRAZA_PROSBY.exec(t) ?? RE_DANE_DO_ZAPLATY.exec(t);
  if (m) return m[0];
  const rzeczownik = RE_RZECZOWNIK_PLATNOSCI.exec(t);
  return rzeczownik && !RE_POTWIERDZENIE.test(t) ? rzeczownik[0] : null;
}

/** Fragment zdania przy pobraniu, który odsyła do przelewu albo konta (drugi kanał zapłaty), albo `null`. */
export function drugiKanalZaplaty(tekst) {
  return RE_DRUGI_KANAL.exec(plaski(tekst).replace(RE_ZAPRZECZENIE, ' '))?.[0] ?? null;
}

/**
 * Zdania w kolejności ekranu. `grupa`: 'zamkniecie' (warianty `{zamkniecie}`), 'blok' (`{dane_platnosci}`), a od
 * PRZ-102.19 'przelew' (etykiety wierszy przelewu i „brutto"), 'zamowienie' (stałe teksty bloków zamówienia) i 'podpis'.
 * `kiedy` — po ludzku, kiedy zdanie pada w mailu; `uwaga` — reguła treści widoczna przy polu.
 */
export const ZDANIA = Object.freeze([
  { klucz: 'pobranie', grupa: 'zamkniecie', kiedy: 'Gdy zamówienie jest za pobraniem — w każdym z trzech maili.',
    uwaga: 'Musi mówić, że płaci się kurierowi albo przy doręczeniu (słowo „kurier” albo „doręczeniu”) i nie może odsyłać do przelewu ani konta — inaczej klient może zapłacić dwa razy.',
    domyslne: 'Należność pobierze kurier przy doręczeniu — nie trzeba nic przelewać.' },
  { klucz: 'oplacone', grupa: 'zamkniecie', kiedy: 'Gdy zamówienie jest już opłacone — wpłaty pokrywają całą kwotę.',
    uwaga: 'Nie może prosić o zapłatę (np. „prosimy o wpłatę”, „przelej”, kwota, „konto”, „termin”) — zamówienie jest rozliczone. „Dziękujemy za wpłatę” albo „wpłata dotarła” są w porządku.',
    domyslne: 'Zamówienie jest opłacone — dziękujemy.' },
  { klucz: 'bez_danych_z_zalacznikiem', grupa: 'zamkniecie',
    kiedy: 'Gdy panel nie poda danych do przelewu (brak numeru rachunku w ustawieniach firmy albo błąd w kwotach zamówienia), a w mailu jedzie dokument PDF.',
    domyslne: 'Szczegóły płatności znajdziesz na dokumencie w załączniku.' },
  { klucz: 'bez_danych_bez_zalacznika', grupa: 'zamkniecie',
    kiedy: 'Jak wyżej, ale bez żadnego załącznika (np. przypomnienie, gdy nie ma proformy).',
    domyslne: 'Szczegóły płatności podamy w odpowiedzi na tego maila — wystarczy napisać.' },
  { klucz: 'proforma', grupa: 'zamkniecie', kiedy: 'W mailu z proformą, gdy klient ma zapłacić przelewem.',
    domyslne: 'Po zaksięgowaniu wpłaty przekażemy zamówienie do realizacji.' },
  { klucz: 'przypomnienie', grupa: 'zamkniecie', kiedy: 'W przypomnieniu o płatności, gdy klient ma zapłacić przelewem.',
    domyslne: 'Jeśli płatność już wyszła, prosimy zignorować tę wiadomość. A gdyby coś było niejasne — wystarczy odpowiedzieć na tego maila.' },
  { klucz: 'pozostale', grupa: 'zamkniecie', kiedy: 'W pozostałych przypadkach — w praktyce faktura do zapłaty przelewem.',
    domyslne: 'Jeśli coś się nie zgadza, wystarczy odpowiedzieć na tego maila.' },
  { klucz: 'naglowek_do_zaplaty', grupa: 'blok', naglowek: true, kiedy: 'Nagłówek nad kwotą do zapłaty. W mailu pisany wielkimi literami.',
    domyslne: 'Do zapłaty' },
  { klucz: 'naglowek_przelew', grupa: 'blok', naglowek: true,
    kiedy: 'Nagłówek nad danymi do przelewu (odbiorca, rachunek, tytuł, termin — te wstawia panel). W mailu pisany wielkimi literami.',
    domyslne: 'Przelew' },
  { klucz: 'zalacznik_proformy', grupa: 'blok', kiedy: 'Gdy do przypomnienia panel dołącza aktualną proformę.',
    uwaga: `Musi zawierać ${POLE_NUMERU_PROFORMY} — w to miejsce panel wstawia numer proformy.`,
    domyslne: `W załączeniu proforma ${POLE_NUMERU_PROFORMY}.` },
  { klucz: 'zalacznik_wywozu', grupa: 'blok', kiedy: 'Gdy do faktury dla firmy z UE (WDT) panel dołącza „Potwierdzenie wywozu towarów”.',
    domyslne: 'W załączeniu również „Potwierdzenie wywozu towarów" (WDT) — prosimy o podpis i odesłanie skanu po przewiezieniu towarów na miejsce.' },

  // ——— PRZ-102.19: etykiety i stałe teksty (`etykieta: true` — jedno krótkie pole, do MAKS_ZDAN.etykieta znaków) ————
  // `kiedy` bez apostrofów, `&`, `<` i `>` — ekran escapuje je inaczej niż cudzysłów, a test szuka opisu na ekranie.
  { klucz: 'etykieta_odbiorca', grupa: 'przelew', etykieta: true,
    kiedy: 'Etykieta wiersza z nazwą odbiorcy przelewu (proforma, faktura, przypomnienie). Nazwę wstawia panel z Ustawienia → Firma.',
    domyslne: 'Odbiorca' },
  { klucz: 'etykieta_rachunek', grupa: 'przelew', etykieta: true,
    kiedy: 'Etykieta wiersza z numerem rachunku. Numer wstawia panel z ustawień firmy — tu go nie zmienisz.',
    uwaga: 'Cztery etykiety danych do przelewu muszą się od siebie różnić — inaczej klient nie odróżni rachunku od tytułu.',
    domyslne: 'Rachunek' },
  { klucz: 'etykieta_tytul', grupa: 'przelew', etykieta: true,
    kiedy: 'Etykieta wiersza z tytułem przelewu. Tytuł (numer proformy, faktury albo zamówienia) wstawia panel.',
    domyslne: 'Tytuł przelewu' },
  { klucz: 'etykieta_termin', grupa: 'przelew', etykieta: true,
    kiedy: 'Etykieta wiersza z terminem płatności — pada tylko, gdy przy zamówieniu uzgodniono termin.',
    domyslne: 'Termin' },
  { klucz: 'dopisek_brutto', grupa: 'przelew', etykieta: true,
    kiedy: 'Dopisek przy kwocie do zapłaty w mailach o płatności i przy sumie w tabeli pozycji („Razem brutto”, „RAZEM: … brutto”).',
    uwaga: 'Nie może być pusty — kwota bez informacji, czy to brutto, wprowadza w błąd. Pusty = „brutto”.',
    domyslne: 'brutto' },

  { klucz: 'naglowek_zamowienie', grupa: 'zamowienie', etykieta: true,
    kiedy: 'Nagłówek nad tabelą pozycji — blok {pozycje} (potwierdzenie przyjęcia i szablony własne). W mailu wielkimi literami.',
    domyslne: 'Zamówienie' },
  { klucz: 'naglowek_platnosc', grupa: 'zamowienie', etykieta: true,
    kiedy: 'Nagłówek nad sposobem płatności — blok {sposob_platnosci} w potwierdzeniu przyjęcia. W mailu wielkimi literami.',
    domyslne: 'Płatność' },
  { klucz: 'naglowek_wysylka', grupa: 'zamowienie', etykieta: true,
    kiedy: 'Nagłówek nad metodą i adresem dostawy — blok {wysylka}. W mailu wielkimi literami.',
    domyslne: 'Wysyłka' },
  { klucz: 'naglowek_faktura', grupa: 'zamowienie', etykieta: true,
    kiedy: 'Nagłówek nad informacją o fakturze — blok {dane_do_faktury}. W mailu wielkimi literami.',
    domyslne: 'Faktura' },
  { klucz: 'kolumna_pozycja', grupa: 'zamowienie', etykieta: true,
    kiedy: 'Kolumna z nazwą produktu w tabeli pozycji (tylko wersja HTML maila).', domyslne: 'Pozycja' },
  { klucz: 'kolumna_ilosc', grupa: 'zamowienie', etykieta: true,
    kiedy: 'Kolumna z ilością w tabeli pozycji (tylko wersja HTML maila).', domyslne: 'Ilość' },
  { klucz: 'kolumna_cena', grupa: 'zamowienie', etykieta: true,
    kiedy: 'Kolumna z ceną za sztukę w tabeli pozycji (tylko wersja HTML maila).', domyslne: 'Cena' },
  { klucz: 'kolumna_wartosc', grupa: 'zamowienie', etykieta: true,
    kiedy: 'Kolumna z wartością pozycji w tabeli pozycji (tylko wersja HTML maila).', domyslne: 'Wartość' },
  { klucz: 'etykieta_razem', grupa: 'zamowienie', etykieta: true,
    kiedy: 'Wiersz z sumą pod tabelą pozycji — w mailu z dopiskiem przy kwocie („Razem brutto”, w wersji tekstowej „RAZEM: … brutto”).',
    domyslne: 'Razem' },
  { klucz: 'jednostka', grupa: 'zamowienie', etykieta: true,
    kiedy: 'Jednostka przy cenie w wersji tekstowej tabeli pozycji — po ukośniku („189,00 zł/szt”).', domyslne: 'szt' },
  { klucz: 'faktura_tak', grupa: 'zamowienie', etykieta: true,
    kiedy: 'Pierwsza linia bloku {dane_do_faktury}, gdy klient chce fakturę — pod nią dane nabywcy.', domyslne: 'Tak — wystawimy na:' },
  { klucz: 'faktura_bez_danych', grupa: 'zamowienie', etykieta: true,
    kiedy: 'Zamiast danych nabywcy, gdy klient chce fakturę, a zamówienie nie ma jego danych.', domyslne: 'dane do uzgodnienia' },
  { klucz: 'faktura_nie', grupa: 'zamowienie', etykieta: true,
    kiedy: 'Blok {dane_do_faktury}, gdy klient nie chce faktury.', domyslne: 'Nie' },
  { klucz: 'adres_do_uzgodnienia', grupa: 'zamowienie', etykieta: true,
    kiedy: 'Blok {wysylka}, gdy zamówienie nie ma adresu dostawy (w wersji tekstowej maila w nawiasie).', domyslne: 'adres do uzgodnienia' },
  { klucz: 'platnosc_do_uzgodnienia', grupa: 'zamowienie', etykieta: true,
    kiedy: 'Blok {sposob_platnosci}, gdy zamówienie nie ma metody płatności.', domyslne: 'do uzgodnienia' },

  { klucz: 'pozdrowienie', grupa: 'podpis', etykieta: true,
    kiedy: 'Linia nad marką w bloku {podpis} — w każdym mailu do klienta i w tekście wstawianym do wątku Allegro.',
    domyslne: 'Pozdrawiamy,' },
]);

const ZDANIE = new Map(ZDANIA.map((z) => [z.klucz, z]));

/** Najwięcej znaków w polu zdania — to samo ograniczenie ma pole na ekranie (`maxlength`). */
export const maksZdania = (z) => (z.etykieta ? MAKS_ZDAN.etykieta : z.naglowek ? MAKS_ZDAN.naglowek : MAKS_ZDAN.zdanie);

/** Etykiety wierszy przelewu — muszą się od siebie różnić (`kolizjeEtykiet`). */
export const ETYKIETY_PRZELEWU = Object.freeze(['etykieta_odbiorca', 'etykieta_rachunek', 'etykieta_tytul', 'etykieta_termin']);

/** Etykiety, po których kod sam stawia dwukropek („Rachunek: …", „RAZEM: …") — wpisany dwukropek obcina `sprawdzZdanie`. */
export const ETYKIETY_Z_DWUKROPKIEM = Object.freeze([...ETYKIETY_PRZELEWU, 'etykieta_razem']);

// Recenzja PRZ-102.19 (W3b): napisy przy kwocie brutto, sumie, cenie i wartości nie mogą mówić „netto" — kwoty w mailu
// SĄ brutto, a „476,00 zł netto" to klient, który dopłaci VAT albo zakwestionuje fakturę.
const BEZ_NETTO = new Set(['dopisek_brutto', 'etykieta_razem', 'kolumna_cena', 'kolumna_wartosc']);
const RE_NETTO = /netto|bez\s*vat|net\b/iu;

// Recenzja PRZ-102.19 (W2, homoglify): etykieta to litery łacińskie (polskie też są łacińskie), cyfry, spacje i zwykła
// interpunkcja. Cyrylickie „а" w „Rаchunek" wygląda jak „a", ale nie jest nim — porównanie etykiet by go nie złapało.
const RE_ZNAKI_ETYKIETY = /^[\p{Script=Latin}0-9 .,:;!?()/'"„”‚’«»…&%+–—-]*$/u;
// W3a: ciąg 6+ cyfr (także ze spacjami i myślnikami między nimi) to numer konta albo telefonu, nie etykieta — inaczej
// do tabeli przelewu da się wpisać drugi numer rachunku obok prawdziwego.
const RE_CIAG_CYFR = /\d(?:[\s\-–—]?\d){5,}/u;

/**
 * Rdzeń napisu do porównań (recenzja PRZ-102.19, W2): NFKC, tylko litery i cyfry, małe litery — „Tytuł-przelewu",
 * „TYTUŁ PRZELEWU!" i „Tytuł przelewu" to jedno.
 */
export const rdzenEtykiety = (s) => String(s ?? '').normalize('NFKC').replace(/[^\p{L}\p{N}]/gu, '').toLocaleLowerCase('pl-PL');

export const POWOD_KOLIZJI = 'Etykiety danych do przelewu muszą się różnić i żadna nie może brzmieć jak domyślna etykieta innego wiersza — dwa podobne wiersze klient pomyli (np. wpisze numer rachunku w tytuł).';
export const POWOD_FAKTURY = '„Tak — wystawimy na:” i „Nie” w bloku faktury muszą się różnić — inaczej klient nie wie, czy dostanie fakturę.';

/**
 * Pola, które w KOMPLECIE tekstów do maila (`zdaniaDoMaila`) się zderzają: `{ klucz: powód }` (puste = w porządku).
 * Komplet, a nie sam formularz: „Termin" przemianowane na „Rachunek" zderza się z NIEZMIENIONYM „Rachunek".
 *   • etykieta przelewu równa (po `rdzenEtykiety`) innej etykiecie przelewu ALBO domyślnej etykiecie innego wiersza
 *     (zamiana Rachunek↔Tytuł przelewu = dwie kolizje) — tabela z dwoma „Rachunkami" to przelew z rachunkiem w tytule;
 *   • „Tak — wystawimy na:" równe „Nie" (D2).
 */
export function kolizjeEtykiet(teksty) {
  const wynik = {};
  const r = (k) => rdzenEtykiety(teksty[k]);
  for (const k of ETYKIETY_PRZELEWU) {
    const zderzona = ETYKIETY_PRZELEWU.some((inny) => inny !== k
      && (r(inny) === r(k) || rdzenEtykiety(DOMYSLNE_ZDANIA[inny]) === r(k)));
    if (zderzona) wynik[k] = POWOD_KOLIZJI;
  }
  if (r('faktura_tak') === r('faktura_nie')) { wynik.faktura_tak = POWOD_FAKTURY; wynik.faktura_nie = POWOD_FAKTURY; }
  return wynik;
}

export const DOMYSLNE_ZDANIA = Object.freeze(Object.fromEntries(ZDANIA.map((z) => [z.klucz, z.domyslne])));

export const czyZnaneZdanie = (klucz) => ZDANIE.has(String(klucz ?? ''));

/**
 * Zdania zapisane w panelu (z JSON-a w `ustawienia`) — tylko znane klucze z niepustym napisem.
 * Uszkodzony wiersz = nic nie zapisane: maile wracają do zdań domyślnych, nie padają.
 */
export function odczytajZdania(json) {
  try {
    const s = JSON.parse(json ?? 'null');
    if (!s || typeof s !== 'object' || Array.isArray(s)) return {};
    return Object.fromEntries(Object.entries(s).filter(([k, v]) => ZDANIE.has(k) && typeof v === 'string' && v.trim()));
  } catch {
    return {};
  }
}

/** Zdania do maila: zapisane w panelu, a reszta domyślna. */
export function zdaniaDoMaila(zapisane = {}) {
  const wynik = {};
  for (const { klucz, domyslne } of ZDANIA) {
    const v = zapisane?.[klucz];
    wynik[klucz] = typeof v === 'string' && v.trim() ? v : domyslne;
  }
  return wynik;
}

/**
 * Reguły treści jednego zdania — po walidacji znaków (długość, znaki sterujące) zrobionej przez wołającego.
 * Zwraca powód odmowy albo `null`. Puste zdanie nie trafia tutaj (= tekst domyślny).
 */
export function regulaTresci(klucz, tekst) {
  const z = ZDANIE.get(klucz);
  if (!z) return 'Nieznane zdanie.';
  const maks = maksZdania(z);
  if (tekst.length > maks) {
    return `${z.etykieta ? 'Etykieta' : z.naglowek ? 'Nagłówek' : 'Zdanie'} może mieć najwyżej ${maks} znaków (wpisano ${tekst.length}).`;
  }
  const bezPola = klucz === 'zalacznik_proformy' ? tekst.split(POLE_NUMERU_PROFORMY).join('') : tekst;
  if (klucz === 'zalacznik_proformy' && bezPola === tekst) {
    return `Zdanie o proformie musi zawierać ${POLE_NUMERU_PROFORMY} — w to miejsce panel wstawia numer proformy.`;
  }
  if (/[{}]/u.test(bezPola)) {
    return klucz === 'zalacznik_proformy'
      ? `Klamry służą tu tylko do ${POLE_NUMERU_PROFORMY} — inne trafiłyby do klienta dosłownie.`
      : 'Klamry nie tworzą tu żadnego pola i trafiłyby do klienta dosłownie — usuń je.';
  }
  // Recenzja PRZ-102.19 (W2, W3, D2) — tylko krótkie etykiety; zdania z PRZ-102.17 mają swoje reguły niżej.
  if (z.etykieta) {
    if (!RE_ZNAKI_ETYKIETY.test(tekst)) {
      return 'Etykieta może zawierać tylko litery alfabetu łacińskiego (z polskimi), cyfry, spacje i zwykłą interpunkcję — bez znaczników i liter z innych alfabetów, które udają łacińskie.';
    }
    if (!rdzenEtykiety(tekst)) return 'Etykieta musi zawierać choć jedną literę albo cyfrę.';
    if (RE_CIAG_CYFR.test(tekst)) {
      return 'Etykieta nie może zawierać ciągu sześciu i więcej cyfr — w tabeli przelewu wyglądałby jak drugi numer rachunku.';
    }
    if (BEZ_NETTO.has(klucz) && RE_NETTO.test(tekst.normalize('NFKC'))) {
      return 'Kwoty w mailu są brutto — napis przy kwocie, sumie, cenie i wartości nie może mówić „netto” ani „bez VAT”.';
    }
    if (klucz === 'faktura_nie' && rdzenEtykiety(tekst).startsWith('tak')) {
      return 'Odpowiedź „nie chce faktury” nie może zaczynać się od „Tak” — klient zrozumie, że fakturę dostanie.';
    }
  }
  if (klucz === 'pobranie' && !RE_POBRANIE.test(tekst)) {
    return 'Zdanie przy pobraniu musi mówić, że płaci się kurierowi albo przy doręczeniu (użyj słowa „kurier” albo „doręczeniu”). Bez tego klient może zapłacić przelewem, a potem drugi raz kurierowi.';
  }
  if (klucz === 'pobranie' && drugiKanalZaplaty(tekst)) {
    return 'Zdanie przy pobraniu nie może odsyłać do przelewu ani konta — klient zapłaciłby przelewem, a potem drugi raz kurierowi. Zaprzeczenie („nie trzeba nic przelewać”) jest w porządku.';
  }
  if (klucz === 'oplacone' && prosbaOZaplate(tekst)) {
    return 'Zdanie przy opłaconym zamówieniu nie może prosić o zapłatę (prośba o wpłatę, przelew, kwota, rachunek, konto, termin) — zamówienie jest już rozliczone, a klient zapłaciłby drugi raz. Opis tego, co już się stało („dziękujemy za wpłatę”, „wpłata dotarła”), jest w porządku.';
  }
  return null;
}

/** Zdanie o załączonej proformie z numerem dokumentu. */
export const zdanieProformy = (szablon, numer) => String(szablon).split(POLE_NUMERU_PROFORMY).join(String(numer ?? ''));

/** Nagłówek sekcji w wersji tekstowej maila — wielkimi literami, jak w HTML-u (tam robi to styl). */
export const naglowekTekstu = (n) => String(n).toLocaleUpperCase('pl-PL');

/**
 * Komplet tekstów modelu maila (PRZ-102.19): `m.teksty` z `modelWiadomosci`/`modelZamowienia` (zapisane w panelu
 * + domyślne). Model złożony bez nich (starsze wywołania, testy) = brzmienie domyślne, to samo co przed zmianą.
 */
export const tekstyModelu = (m) => m?.teksty ?? DOMYSLNE_ZDANIA;
