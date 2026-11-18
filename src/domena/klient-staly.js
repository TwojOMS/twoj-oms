import { bladOperatora } from './bledy.js';
import { METODA_DOMYSLNA } from './moduly-kurierow.ts';
import { tekst } from './dane-reczne.js';
import { grosze } from './kwoty.js';
import { normalizujNip, nipRozpoznany } from './klient-zbiorczy.js';
import { czyWdt } from './wdt.js';
import { parsujKosztDostawy } from './koszt-dostawy.js';
import { DOSTAWY, PLATNOSCI } from './nowe-zamowienie.js';
import { parsujRabat } from './rabat.js';
import { parsujTerminZamowienia, ETYKIETY_TERMINU } from './termin-platnosci.js';

// BAZA STAŁYCH KLIENTÓW — czysta reguła, żeby przy dodawaniu nowego zamówienia nie wpisywać
// za każdym razem danych klienta do faktury i wysyłki.
//
// Przy zamówieniu telefonicznym albo mailowym to jest dwanaście pól przepisywanych z pamięci
// albo z poprzedniej faktury — przy słuchawce, pod presją czasu. Ten sam mechanizm, który
// przy pozycjach rozwiązało „dodaj z magazynu", tutaj dotyczy NAGŁÓWKA zamówienia.
//
// ⚠️ MODUŁ JEST CZYSTY: bez bazy, bez SQL-a, bez zegara. Rozstrzyga wyłącznie, co wpis
// znaczy i jak zamienia się w pola formularza.
//
// ⚠️⚠️ DANE KLIENTA TO MIGAWKA W CHWILI ZAMÓWIENIA, NIE ŁĄCZE. Ten moduł oddaje POLA
// FORMULARZA, a nie identyfikator do zapamiętania przy zamówieniu — i to jest decyzja, nie
// skrót. Zamówienie dalej trzyma własne `klient_json` / `dostawa_json`; zmiana adresu w bazie
// klientów NIE MA PRAWA ruszyć adresu na fakturze wystawionej trzy tygodnie temu. Dokładnie
// ta sama zasada, co przy cenie z magazynu („nazwa i cena to migawka, nie łącze") i przy
// nazwie sprzedawcy w wierszu kosztu.

/** Pola bloku wysyłkowego w bazie klientów — te same nazwy, co pola `w_*` formularza. */
export const POLA_WYSYLKI = Object.freeze(['nazwa', 'firma', 'ulica', 'kod', 'miasto', 'telefon', 'email']);

/**
 * Pola bloku fakturowego — te same nazwy, co pola `f_*` formularza I co klucze oddawane
 * przez GUS (`domena/gus.js`).
 *
 * ⚠️ ZGODNOŚĆ Z GUS-EM NIE JEST PRZYPADKIEM: oba wypełniają te same pola na tym samym
 * ekranie, więc rozjazd nazw znaczyłby, że „Pobierz z GUS" i „Wstaw dane klienta" wpisują
 * w dwa różne komplety pól i drugi klik po pierwszym zostawia połowę starych wartości.
 */
export const POLA_FAKTURY = Object.freeze(['firma', 'nip', 'ulica', 'kod', 'miasto', 'email']);

/**
 * Klucz klienta — krótka, stabilna nazwa własna („przyklad", „hurt-a").
 *
 * ⚠️ TA SAMA POSTAĆ, CO KLUCZE W `OMS_KLIENCI_ZBIORCZY`, i to jest celowe: klient rozliczany
 * zbiorczo prędzej czy później trafi też tutaj, a dwa różne klucze na ten sam podmiot
 * znaczyłyby, że nikt nie umie ich zestawić.
 */
export function kluczZNazwy(surowy, nazwa) {
  // Pierwszy argument zostaje dla zgodności wywołań; klucz żądania jest ignorowany.
  // Klucz wyprowadzony z nazwy, żeby formularz miał JEDNO pole obowiązkowe zamiast dwóch.
  // Znaki spoza ASCII lecą przez rozkład kanoniczny: „Łąkowe Drogi" → „lakowe-drogi",
  // „Żabka" → „zabka". Bez tego klucz z polskimi znakami wyglądałby w adresie jak śmieć.
  const zNazwy = String(nazwa ?? '')
    // Zakres zapisany UCIECZKAMI, nie znakami wprost: znaki łączące są w pliku niewidoczne,
    // więc wpisane dosłownie kasuje je pierwszy lepszy edytor „czyszczący" i regexp po cichu
    // przestaje cokolwiek robić.
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/ł/gi, 'l')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
    .replace(/-+$/, '');
  // Pusty wynik uzupełni warstwa bazy jako klient-<id> w transakcji INSERT-u.
  return zNazwy;
}

// Checkbox z formularza: wysłany i nie „pusty”/„0”.
const zaznaczony = (wartosc) => wartosc !== undefined && wartosc !== '' && wartosc !== '0';

const blok = (body, pola, przedrostek) => Object.fromEntries(pola.map((p) => [p, tekst(body?.[`${przedrostek}${p}`])]));

/**
 * Formularz klienta → wiersz gotowy do zapisania.
 *
 * ⚠️ ODMOWA JEST CAŁOŚCIOWA i idzie PRZED pierwszym zapisem — ta sama zasada, co przy
 * zakładaniu zamówienia. Wpis w bazie klientów obiecuje, że przy następnym telefonie nie
 * trzeba już myśleć; wpis pół-poprawny obiecuje to samo i kłamie.
 */
export function znormalizujKlienta(body = {}) {
  const nazwa = tekst(body.nazwa);
  if (!nazwa) throw bladOperatora('Podaj nazwę klienta — bez niej nie da się go znaleźć na liście.');

  const faktura = blok(body, POLA_FAKTURY, 'f_');
  const wysylka = blok(body, POLA_WYSYLKI, 'w_');

  // ⚠️ NIP ŻYJE W DWÓCH MIEJSCACH I MUSI BYĆ TĄ SAMĄ WARTOŚCIĄ: kolumna `nip` (po niej idzie
  // dopasowanie) i `faktura_json.nip` (to on trafia na dokument). Rozjazd między nimi dałby
  // klienta, którego panel znajduje po jednym numerze, a fakturuje na drugi.
  // ⚠️ `||`, NIE `??` — i to jest poprawka błędu, nie kosmetyka. Formularz WYSYŁA pole
  // `nip` zawsze, więc przy pustym polu `??` dostawał `''` (nie `undefined`) i zapasowy
  // odczyt z „NIP na fakturze" NIGDY się nie uruchamiał. A pole fakturowe jest tym, które
  // człowiek wypełnia najczęściej, bo to przy nim stoi przycisk „Pobierz z GUS".
  // Skutek był cichy: karta zapisywała się BEZ NIP-u, a bez niego panel nie wskaże
  // nabywcy faktury okresowej (moduly/faktury/trasy/okresy.js) ani nie dopasuje zamówień.
  const surowyNip = String(body.nip ?? '').trim() || String(faktura.nip ?? '').trim();
  const nip = normalizujNip(surowyNip);

  // ⚠️ ODMOWA ZAMIAST OKROJENIA. Normalizacja kasująca wszystko, co nie jest cyfrą,
  // zapisałaby „SK1234567890" jako „1234567890" — dziesięć cyfr, czyli
  // numer WYGLĄDAJĄCY NA POLSKI NIP. Taki numer poszedłby na fakturę i nikt by się nie
  // zorientował, bo na ekranie wygląda poprawnie. Numer nierozpoznany ma zatrzymać zapis.
  if (surowyNip && !nipRozpoznany(surowyNip)) {
    throw bladOperatora(
      `Numer „${surowyNip}" nie wygląda ani na polski NIP, ani na numer VAT-UE. ` +
        'Polski wpisz samymi cyframi, zagraniczny z kodem kraju (np. „SK1234567890").',
    );
  }

  // ⚠️ PUSTA DOSTAWA TO „NIE USTALONO”, NIE DPD — i pusty koszt razem z nią.
  // Koszt z karty klienta trafia do nowych zamówień: cichy „dpd” z 0,00 to darmowa wysyłka,
  // której nikt nie ustalił.
  // ⚠️ PUSTE POLE KOSZTU TO TEŻ „NIE USTALONO”, także przy WYBRANEJ dostawie. Gdyby puste
  // pole znaczyło 0,00, poprawka samego adresu u klienta z pustym kosztem robiłaby
  // z niego „wysyłka gratis”. Darmowa wysyłka
  // powstaje tylko z wpisanego wprost „0”; pusty koszt jest bezpieczny, bo „Wstaw dane”
  // podstawia kwotę domyślną z Ustawień.
  const metodaWysylki = wybor(body.metoda_wysylki, DOSTAWY, 'sposobu dostawy', '');
  const kosztDostawy =
    metodaWysylki && tekst(body.koszt_dostawy_brutto) !== null ? parsujKosztDostawy(body.koszt_dostawy_brutto) : '';

  return {
    klucz: kluczZNazwy(body.klucz, nazwa),
    nazwa,
    // ⚠️ Pusty NIP zapisujemy jako NULL, nie jako pusty napis: indeks unikalny po NIP-ie
    // dopuszcza wiele NULL-i, ale tylko JEDEN pusty napis — drugi klient bez NIP-u odbiłby
    // się od bazy komunikatem o duplikacie numeru, którego nikt nie wpisał.
    nip: nip || null,
    faktura: { ...faktura, nip: nip || null },
    wysylka,
    b2b: body.b2b !== undefined && body.b2b !== '' && body.b2b !== '0' ? 1 : 0,
    rabat_procent: parsujRabat(body.rabat_procent),
    chce_fakture: body.chce_fakture !== undefined && body.chce_fakture !== '' && body.chce_fakture !== '0' ? 1 : 0,
    metoda_wysylki: metodaWysylki,
    koszt_dostawy_brutto: kosztDostawy,
    platnosc: wybor(body.platnosc, PLATNOSCI, 'rodzaju płatności', 'przelew'),
    termin_platnosci: parsujTerminZamowienia(body.termin_platnosci),
    komentarz: tekst(body.komentarz),
    // ⚠️ Brak pola to „aktywny” TYLKO bez znacznika `aktywny_w_formularzu` — tak
    // zakłada klienta karta zamówienia. Formularz klientów ma checkbox, a odznaczony checkbox
    // przeglądarka pomija; bez znacznika odznaczenie „Aktywny” przy edycji nie wygaszało nikogo.
    aktywny: zaznaczony(body.aktywny) || (body.aktywny === undefined && !body.aktywny_w_formularzu) ? 1 : 0,
    ...warunkiUmowyZbiorczej(body),
  };
}

// Pola adresu, które przechodzą RAZEM (opis przy `daneNabywcyNaKarcie`).
const ADRES_FAKTURY = Object.freeze(['ulica', 'kod', 'miasto', 'kraj']);
const ADRES_WYSYLKI = Object.freeze(['firma', 'ulica', 'kod', 'miasto', 'kraj']);
const WYZWALA_ADRES = ['ulica', 'kod', 'miasto', 'kraj'];

function scalBlok(stary, nowy, adres) {
  const wynik = { ...(stary ?? {}) };
  for (const [pole, wartosc] of Object.entries(nowy ?? {})) {
    if (!adres.includes(pole) && tekst(wartosc) !== null) wynik[pole] = wartosc;
  }
  if (WYZWALA_ADRES.some((pole) => tekst(nowy?.[pole]) !== null)) {
    for (const pole of adres) {
      if (Object.hasOwn(nowy ?? {}, pole) || Object.hasOwn(wynik, pole)) wynik[pole] = tekst(nowy?.[pole]);
    }
  }
  return wynik;
}

/**
 * „Uaktualnij dane stałego klienta” (karta zamówienia): istniejący wpis z bazy + dane nabywcy
 * z zamówienia → wiersz do `zapiszKlienta`.
 *
 * ⚠️⚠️ Z ZAMÓWIENIA PRZECHODZĄ TYLKO DANE NABYWCY — NIP, blok faktury, blok wysyłki (i nazwa
 * na pustą kartę). Reszta wiersza to `istniejacy`. `zapiszKlienta` pisze KOMPLET
 * kolumn, więc wiersz zbudowany przez `znormalizujKlienta` (bez pól umowy zbiorczej) dałby
 * klientowi z umową po jednym kliknięciu `rozliczenie_zbiorcze = 0` i kwoty NULL, a jego
 * zamówienia szłyby na pojedyncze faktury zamiast do okresu. Lista „czego nie ruszać”
 * zawiodłaby tak samo przy następnej kolumnie. Umowa i jej kwoty, B2B, rabat, termin, płatność, dostawa i jej koszt, „chce
 * fakturę”, notatka, aktywność i klucz zostają takie, jak w bazie.
 *
 * ⚠️⚠️ PUSTE Z ZAMÓWIENIA ZNACZY „NIE PODANO”, NIE „SKASUJ”. Zamówienie telefoniczne bez adresu
 * na fakturze skasowałoby adres, który karta klienta już miała. Przechodzą więc tylko wartości
 * niepuste (null, '' i same spacje zostawiają kartę); świadome czyszczenie pola zostaje
 * w formularzu Stałych klientów. NAZWA przechodzi tylko na pustą kartę: krótka nazwa nadana
 * ręcznie („Pracownia Przykładowa”) to nazwa własna z listy, a nie dana z faktury — pełna
 * firma i tak ląduje w `faktura.firma`.
 *
 * ⚠️⚠️ ADRES TO CAŁOŚĆ, NIE ZESTAW PÓL (`ADRES_FAKTURY`, `ADRES_WYSYLKI`). Gdy zamówienie podaje
 * choć jedno pole adresu (ulica, kod, miasto, kraj), przechodzą WSZYSTKIE, także puste: ulica
 * i miasto z zamówienia ze starym kodem z karty to adres, którego nikt nie podał. W wysyłce
 * razem z adresem idzie `firma` — nowy odbiorca nie może dostać na etykiecie starej nazwy
 * firmy. Sama firma bez adresu adresu NIE wyzwala (zamówienie telefoniczne podaje firmę zawsze).
 * Gdy zamówienie adresu nie ma wcale, zostaje adres z karty. E-mail i telefon: tylko niepuste.
 */
export function daneNabywcyNaKarcie(istniejacy, dane) {
  return {
    ...istniejacy,
    nazwa: tekst(istniejacy.nazwa) ?? dane.nazwa,
    nip: tekst(dane.nip) ?? istniejacy.nip,
    faktura: scalBlok(istniejacy.faktura, dane.faktura, ADRES_FAKTURY),
    wysylka: scalBlok(istniejacy.wysylka, dane.wysylka, ADRES_WYSYLKI),
  };
}

/** Niezależne przełączniki usług. Odznaczony ignoruje kwotę żądania. */
function warunkiUmowyZbiorczej(body) {
  const wlaczony = (pole) => body[pole] !== undefined && body[pole] !== '' && body[pole] !== '0';
  const wynik = { rozliczenie_zbiorcze: wlaczony('rozliczenie_zbiorcze') ? 1 : 0 };
  for (const [pole, kolumna, opis] of [
    ['prog_darmowej_dostawy', 'prog_darmowej_dostawy_gr', 'ustalony próg darmowej dostawy'],
    ['oplata_obslugi', 'oplata_obslugi_gr', 'ustaloną opłatę za obsługę'],
  ]) {
    if (!wlaczony(`${pole}_wlaczony`)) {
      wynik[kolumna] = null;
      continue;
    }
    const surowa = String(body[pole] ?? '')
      .trim()
      .replace(',', '.');
    if (surowa === '') throw bladOperatora(`Klient musi mieć ${opis} — uzupełnij kwotę albo wyłącz przełącznik.`);
    if (!Number.isFinite(Number(surowa)) || Number(surowa) < 0) {
      throw bladOperatora(`Nie umiem odczytać kwoty „${body[pole]}” — podaj ${opis} w złotych.`);
    }
    wynik[kolumna] = grosze(surowa, opis);
  }
  return wynik;
}

function wybor(surowy, slownik, opis, domyslny) {
  const wartosc = String(surowy ?? '').trim();
  if (wartosc === '') return domyslny;
  if (!Object.hasOwn(slownik, wartosc)) throw bladOperatora(`Nie znam ${opis} „${surowy}".`);
  return wartosc;
}

/**
 * Wiersz klienta → POLA FORMULARZA nowego zamówienia.
 *
 * ⚠️ NADPISUJE, i to jest cała treść przycisku „Wstaw dane". Wstawianie „tylko w puste pola"
 * brzmi ostrożniej, a jest gorsze: operator, który poprawił jedno pole, dostałby komplet
 * pomieszany z dwóch źródeł i nie miałby jak stwierdzić, które jest które. Dlatego pasek
 * stoi NAD polami — żeby ręka trafiała tam ZANIM zacznie wpisywać — a ekran mówi wprost,
 * że pola zostały wypełnione.
 *
 * ⚠️ POLA POZYCJI ZOSTAJĄ NIETKNIĘTE (`...formularz` na wejściu). Klient bywa wybierany po
 * dodaniu towaru z magazynu i skasowanie wtedy pozycji byłoby najgorszym możliwym momentem.
 */
export function wstawKlientaDoFormularza(formularz = {}, klient) {
  if (!klient) throw bladOperatora('Nie ma takiego klienta w bazie — wybierz go z listy.');
  const f = klient.faktura ?? {};
  const w = klient.wysylka ?? {};
  return {
    ...formularz,
    w_nazwa: w.nazwa ?? '',
    w_firma: w.firma ?? '',
    w_ulica: w.ulica ?? '',
    w_kod: w.kod ?? '',
    w_miasto: w.miasto ?? '',
    w_telefon: w.telefon ?? '',
    w_email: w.email ?? '',
    f_firma: f.firma ?? '',
    f_nip: f.nip ?? klient.nip ?? '',
    f_ulica: f.ulica ?? '',
    f_kod: f.kod ?? '',
    f_miasto: f.miasto ?? '',
    f_email: f.email ?? '',
    // Pola wyboru: przeglądarka przysyła je WYŁĄCZNIE gdy zaznaczone, więc pusty napis
    // znaczy „odznaczone" — i tak właśnie odczyta to `parsujNoweZamowienie`.
    f_chce_fakture: klient.chce_fakture ? 'on' : '',
    b2b: klient.b2b ? 'on' : '',
    dostawa: klient.metoda_wysylki ?? METODA_DOMYSLNA,
    // ⚠️ PUSTY KOSZT = DOSTAWA NIEUSTALONA (klient z zamówienia z nierozpoznaną dostawą),
    // a nie „gratis”. Puste pole zapisałoby zamówienie z 0,00; `undefined` zostawia
    // ekranowi kwotę domyślną z Ustawień dla wybranej dostawy.
    koszt_dostawy_brutto: tekst(klient.koszt_dostawy_brutto) ?? undefined,
    platnosc: klient.platnosc ?? 'przelew',
    termin_platnosci: klient.termin_platnosci ?? '',
    rabat_procent: String(klient.rabat_procent ?? 0),
    klient_klucz: klient.klucz,
  };
}

/**
 * Jedno zdanie o kliencie pod paskiem wyboru — po to, żeby operator zobaczył, CO ZARAZ
 * wejdzie do formularza, zanim to wejdzie.
 *
 * ⚠️ „wysyłka gratis" jest tu wymieniona z premedytacją: to jedyne ustalenie, którego nie
 * widać w żadnym z wypełnionych pól po wstawieniu (kwota 0,00 wygląda jak pole niewypełnione).
 */
export function opisKlienta(klient, { zwolniona = false } = {}) {
  if (!klient) return '';
  const czesci = [klient.nazwa];
  if (klient.nip) czesci.push(`NIP ${klient.nip}`);
  // Nabywca z numerem VAT-UE = dokumenty WDT 0% i kwoty NETTO w zamówieniu — operator
  // ma to zobaczyć ZANIM zacznie wpisywać ceny, dokładnie jak „wysyłka gratis" niżej.
  // Pozycje z magazynu panel przelicza sam (rabat → ÷1,23); dopisek
  // zostaje dla cen wpisywanych RĘCZNIE — te trzeba podać już w netto.
  // Firma zwolniona z VAT (flagę liczy wołający: `sprzedawcaZwolniony`) — numer UE to nie WDT.
  if (czyWdt(klient.nip, { zwolniona })) czesci.push('WDT 0% — magazyn liczy ÷1,23 sam, ceny ręczne wpisuj w NETTO');
  if (klient.b2b) czesci.push('B2B');
  if (klient.rabat_procent) czesci.push(`rabat ${klient.rabat_procent}%`);
  const koszt = String(klient.koszt_dostawy_brutto ?? '').trim();
  if (koszt === '0.00') czesci.push('wysyłka gratis');
  if (klient.prog_darmowej_dostawy_gr != null)
    czesci.push(`darmowa dostawa od ${(klient.prog_darmowej_dostawy_gr / 100).toFixed(2)} zł`);
  if (klient.oplata_obslugi_gr != null)
    czesci.push(`obsługa ${(klient.oplata_obslugi_gr / 100).toFixed(2)} zł przy własnej etykiecie`);
  const platnosc = PLATNOSCI[klient.platnosc] ?? null;
  const termin = ETYKIETY_TERMINU[klient.termin_platnosci] ?? null;
  if (platnosc) czesci.push(termin ? `${platnosc}, ${termin}` : platnosc);
  if (!klient.aktywny) czesci.push('NIEAKTYWNY');
  return czesci.join(' · ');
}
