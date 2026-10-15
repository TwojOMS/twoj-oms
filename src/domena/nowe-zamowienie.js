import { bladOperatora } from './bledy.js';
import { tekst } from './dane-reczne.js';
import { parsujKosztDostawy } from './koszt-dostawy.js';
import { grosze, zl } from './kwoty.js';
import { parsujRabat } from './rabat.js';
import { parsujTerminZamowienia } from './termin-platnosci.js';
import { jakoTablica, parsujNowaPozycje } from './pozycje-reczne.js';
// Dzielenie imienia i nazwiska NIE jest zdefiniowane tutaj — mieszka we wspólnym module
// src/domain/nazwa-osoby.js, bo panel (src/domain/oms-order.js) musi używać dokładnie tej
// samej reguły podziału co ten ekran. Uzasadnienie patrz komentarz przy definicji.
import { rozbijNazwe } from './z-panelu/nazwa-osoby.js';

// ⚠️ PO CO TO ISTNIEJE. Ekran „Nowe zamówienie" zakłada zamówienie RAZEM z adresem, danymi
// nabywcy i pozycjami — jednym zapisem, przy słuchawce przy uchu. Cała zamiana formularza
// na fakty siedzi TUTAJ, a nie w trasie, z jednego powodu: trasa musi móc PARSOWAĆ CAŁOŚĆ
// PRZED pierwszym zapisem do bazy. Odmowa w połowie zostawiłaby zamówienie z numerem,
// bez pozycji i bez ani jednego śladu, że coś poszło nie tak.
//
// ⚠️ ŻADNE POLE NIE JEST OBOWIĄZKOWE (decyzja właściciela, 2026-08-01). Pusty formularz
// zakłada zamówienie bez klienta, bez pozycji, na 0 zł — i to jest zamierzone: numer nadany
// od razu przy telefonie jest wart więcej niż komplet danych, a karta i tak zapali blokady
// przy nadaniu (brak adresu) i przy fakturze (bariera arytmetyczna). Odmowy zostają
// WYŁĄCZNIE tam, gdzie wpis jest wewnętrznie sprzeczny albo niemożliwy do odczytania.

/**
 * DWA OSOBNE PYTANIA zamiast jednej „metody wysyłki" — bo tak właśnie pyta się klienta przez
 * telefon („kurierem czy odbiór?", „przelew czy za pobraniem?"). Od 2026-08-01 tak samo
 * wygląda to w bazie: `metoda_wysylki` + `pobranie` to DWIE kolumny, a metodaWysylkiZWyboru
 * niżej niczego już nie skleja — tylko sprawdza, że para nie jest sprzeczna.
 *
 * Etykiety stąd idą prosto na ekran (widok NIE ma prawa wpisać ich u siebie drugi raz) —
 * ta sama zasada, co przy rodzajach zamówienia, które ten ekran zastąpił.
 */
// ⚠️ LISTA MUSI BYĆ PODZBIOREM `METODY_WYSYLKI` (domain/wysylka.js) — to tamta rozstrzyga,
// co panel w ogóle umie nazwać i nadać. Metoda spoza niej dałaby zamówienie, którego karta
// nie potrafi opisać, a ekran nadania nie potrafi obsłużyć.
//
// ⚠️ `inpost_paczkomat` DOSZEDŁ 07.08.2026 (prośba właściciela: „przy dodawaniu nowego
// zamówienia nie da się dodać wysyłki paczkomatem"). Metoda istniała w panelu od 01.08, ale
// ten ekran jej nie oferował — zamówienie telefoniczne do paczkomatu trzeba było zakładać
// jako DPD i poprawiać na karcie.
//
// Metod Allegro tu NIE MA i mieć nie będzie: zamówienie ręczne z metodą allegrową byłoby
// zamówieniem udającym kanał, którego nie ma (patrz `czyKanalAllegro` — dyskryminatorem jest
// kolumna `sklep`, a ta zawsze będzie tu `reczne`).
export const DOSTAWY = {
  dpd: 'DPD — kurier',
  inpost_paczkomat: 'InPost Paczkomat',
  odbior_osobisty: 'Odbiór osobisty',
};

export const PLATNOSCI = {
  przelew: 'Przelew',
  pobranie: 'Pobranie',
  gotowka: 'Gotówka',
};

/**
 * Wybór dostawy + wybór płatności → PARA `{ metoda, pobranie }`, czyli dwie kolumny.
 *
 * ⚠️ PARA, NIE JEDNA WARTOŚĆ (2026-08-01). Ekran zakładania od początku pytał o dostawę
 * i płatność OSOBNO, a ta funkcja sklejała odpowiedzi w jedną nazwę (`dpd_pobranie`) —
 * czyli gubiła po drodze rozróżnienie, które człowiek właśnie zrobił. Teraz obie decyzje
 * jadą dalej w tej postaci, w jakiej zostały podjęte.
 *
 * ⚠️ Odbiór osobisty z pobraniem to jedyna sprzeczna para i musi dostać ODMOWĘ, nie ciche
 * złożenie w cokolwiek: pobranie inkasuje KURIER, a przy odbiorze osobistym kuriera nie ma.
 * Przepuszczone dałoby zamówienie, którego nikt nigdy nie zainkasuje — a to są pieniądze.
 */
export function metodaWysylkiZWyboru(dostawa, platnosc) {
  if (!Object.hasOwn(DOSTAWY, dostawa)) {
    throw bladOperatora(`Nie znam sposobu dostawy „${dostawa}”.`);
  }
  if (!Object.hasOwn(PLATNOSCI, platnosc)) {
    throw bladOperatora(`Nie znam rodzaju płatności „${platnosc}”.`);
  }
  if (dostawa === 'odbior_osobisty' && platnosc === 'pobranie') {
    throw bladOperatora(
      'Odbiór osobisty i pobranie wykluczają się — pobranie inkasuje kurier, a przy odbiorze '
      + 'osobistym kuriera nie ma. Wybierz gotówkę albo przelew.',
    );
  }
  return { metoda: dostawa, pobranie: platnosc === 'pobranie' ? 1 : 0 };
}

// Imię i nazwisko przyjmujemy JEDNYM polem — przy telefonie nikt nie dyktuje osobno imienia
// i osobno nazwiska. W bazie blok `dostawa` (Woo `shipping`) ma dwa pola, bo taki jest
// kształt sklepowy, a adresOdbiorcy skleja je z powrotem przez `${first} ${last}`.trim().
// Podział na imię/nazwisko (`rozbijNazwe`) mieszka we wspólnym module — patrz import
// u góry pliku i komentarz przy jego definicji.

// Kolumny formularza pozycji. Prefiks `poz_` odróżnia je od formularza „Dodaj pozycję"
// na karcie, który niesie te same nazwy pojedynczo.
const KOLUMNY_POZYCJI = ['nazwa', 'sku', 'ilosc', 'cena_netto', 'cena_brutto'];

// ⚠️ TOZSAMOSC PRODUKTU JEDZIE OBOK, A NIE W `KOLUMNY_POZYCJI` — i to nie jest kosmetyka.
// Te pola sa UKRYTE i wypelnia je wylacznie „dodaj z magazynu" (21.08.2026). Gdyby
// weszly do tablicy wyzej, decydowalyby o tym, czy wiersz jest PUSTY: wiersz z samym
// identyfikatorem (a takim staje sie kazdy, ktoremu operator wyczyscil nazwe i cene)
// przestalby byc pomijany i formularz odmawialby zalozenia zamowienia, wskazujac numer
// wiersza, w ktorym nie widac ani jednego znaku.
//
// ⚠️ `cena_katalogowa` NALEZY DO TEJ SAMEJ RODZINY, choc jest kwota: to nie jest cena, ktora
// klient placi (ta stoi w `cena_brutto`), tylko cena SPRZED rabatu — zapisywana po to, zeby
// dalo sie pokazac na karcie, skad wziela sie kwota, i przeliczyc zamowienie po zmianie
// rabatu (domain/rabat.js). Wiersz, w ktorym zostala sama, jest tak samo pusty jak kazdy inny.
const KOLUMNY_TOZSAMOSCI = ['produkt_id', 'wariant_id', 'cena_katalogowa'];

const pusteWiersz = (w) => KOLUMNY_POZYCJI.every((k) => String(w[k] ?? '').trim() === '');

// Identyfikatory z ukrytych pol formularza. `produkt_id` jest kolumna INTEGER, `wariant_id`
// TEXT — patrz schema.sql. Smiec zamiast liczby idzie jako BRAK, a nie jako NaN: pozycja ma
// powstac tak czy inaczej, bo to jest ekran uzywany przy sluchawce.
function tozsamoscWiersza(w) {
  const produktId = Number(String(w.produkt_id ?? '').trim());
  const wariant = String(w.wariant_id ?? '').trim();
  return {
    produkt_id: String(w.produkt_id ?? '').trim() !== '' && Number.isFinite(produktId) ? produktId : null,
    wariant_id: wariant === '' ? null : wariant,
    cena_katalogowa: cenaKatalogowaWiersza(w.cena_katalogowa),
  };
}

/**
 * Cena katalogowa z UKRYTEGO pola formularza — znormalizowana albo `null`.
 *
 * ⚠️ SMIEC IDZIE PO CICHU JAKO BRAK, i to jest jedyne miejsce w tym pliku, gdzie milczenie
 * jest lepsze od odmowy. Pola nie ma na ekranie: operator go nie wpisuje, nie widzi
 * i nie umie poprawic, wiec odmowa zalozenia zamowienia mowilaby mu o polu, ktorego nie
 * znajdzie. Skutek braku jest przy tym maly i domkniety — pozycja bez ceny katalogowej jest
 * NIEWIDZIALNA dla przeliczenia rabatem (domain/rabat.js) i zachowuje sie dokladnie tak, jak
 * pozycja wpisana z reki. Zadna kwota, ktora klient placi, od tego pola nie zalezy.
 */
function cenaKatalogowaWiersza(surowa) {
  // `napis`, nie `tekst`: `tekst` jest tu funkcja importowana z dane-reczne.js i przyslonieta
  // zmienna lokalna czytalaby sie jak jej wywolanie.
  const napis = String(surowa ?? '').trim().replace(',', '.');
  if (napis === '') return null;
  const liczba = Number(napis);
  if (!Number.isFinite(liczba) || liczba <= 0) return null;
  return zl(grosze(napis, 'cena katalogowa'));
}

/**
 * Wstawienie pozycji z magazynu do FORMULARZA nowego zamówienia (21.08.2026).
 *
 * ⚠️ DO FORMULARZA, NIE DO BAZY — i to jest cała różnica wobec karty. Zamówienie jeszcze
 * nie istnieje: ekran zakładania tworzy je jednym „Załóż zamówienie" razem z adresem,
 * fakturą i pozycjami. Dopisywanie czegokolwiek do bazy wcześniej znaczyłoby zamówienie
 * z nadanym, nieodwracalnym numerem, założone przez samo szukanie w magazynie.
 *
 * Pozycja ląduje w PIERWSZYM wierszu bez nazwy i bez ceny; gdy takiego nie ma, dochodzi
 * nowy na końcu. Formularz rośnie razem z zamówieniem — pięć wierszy to była podpowiedź
 * dla operatora, a nie granica.
 */
export function wstawPozycjeDoFormularza(formularz = {}, pozycja) {
  const pola = {
    poz_nazwa: pozycja.nazwa,
    poz_sku: pozycja.sku ?? '',
    poz_ilosc: String(pozycja.ilosc),
    // Netto zostaje PUSTE świadomie: brutto jest wartością przechowywaną, a wpisane obok
    // netto ze sklepu tylko kusiłoby, żeby je poprawić i rozjechać z ceną, którą klient płaci.
    poz_cena_netto: '',
    poz_cena_brutto: pozycja.cena_brutto,
    poz_produkt_id: pozycja.produkt_id == null ? '' : String(pozycja.produkt_id),
    poz_wariant_id: pozycja.wariant_id ?? '',
    // Cena sprzed rabatu jedzie RAZEM z pozycja i tak samo ukryta — bez niej rabat przetrwalby
    // do zapisu w kwocie, ale zamowienie nie umialoby juz powiedziec, od czego byl liczony.
    poz_cena_katalogowa: pozycja.cena_katalogowa ?? '',
  };
  const klucze = Object.keys(pola);
  const tablice = Object.fromEntries(klucze.map((k) => [k, [...jakoTablica(formularz[k])]]));
  const ile = Math.max(0, ...klucze.map((k) => tablice[k].length));

  let gdzie = -1;
  for (let i = 0; i < ile; i += 1) {
    const pusty = String(tablice.poz_nazwa[i] ?? '').trim() === ''
      && String(tablice.poz_cena_brutto[i] ?? '').trim() === ''
      && String(tablice.poz_cena_netto[i] ?? '').trim() === '';
    if (pusty) { gdzie = i; break; }
  }
  if (gdzie === -1) gdzie = ile;

  for (const k of klucze) {
    // Dziury w tablicy (wiersz krótszy niż inne) muszą stać się pustymi napisami, a nie
    // `undefined` — inaczej widok wypisałby w polu „undefined", a parser policzyłby to jako
    // treść i odmówił założenia zamówienia.
    for (let i = tablice[k].length; i < gdzie; i += 1) tablice[k][i] = '';
    tablice[k][gdzie] = pola[k];
  }
  return { ...formularz, ...tablice };
}

/**
 * Pozycje z pięciu wierszy formularza (równoległe tablice `poz_nazwa[]`, `poz_ilosc[]`...
 * — `@fastify/formbody` nie parsuje zagnieżdżonych nawiasów, patrz parsujHurtPozycji).
 *
 * ⚠️ Wiersz CAŁKOWICIE pusty jest pomijany — to normalny stan czterech z pięciu wierszy.
 * Wiersz ZACZĘTY, ale niekompletny, dostaje odmowę ZE WSKAZANIEM NUMERU: operator wpisał
 * nazwę przy telefonie i musi się dowiedzieć, że brakuje ceny. Ciche pominięcie zapisałoby
 * zamówienie bez pozycji, za którą klient ma zapłacić.
 */
export function parsujPozycjeFormularza(body) {
  const wszystkie = [...KOLUMNY_POZYCJI, ...KOLUMNY_TOZSAMOSCI];
  const kolumny = Object.fromEntries(
    wszystkie.map((k) => [k, jakoTablica(body?.[`poz_${k}`])]),
  );
  // ⚠️ Dlugosc liczona po KOLUMNACH WIDOCZNYCH. Ukryte pola sa w formularzu zawsze (jedno
  // na wiersz), wiec liczone razem z nimi dawalyby stala liczbe wierszy takze wtedy, gdy
  // operator nie wpisal niczego — a `pusteWiersz` i tak by je pominal. Roznicy w wyniku nie
  // ma, jest w czytelnosci: „ile" ma znaczyc „ile wierszy cokolwiek niesie".
  const ile = Math.max(0, ...KOLUMNY_POZYCJI.map((k) => kolumny[k].length));

  const pozycje = [];
  for (let i = 0; i < ile; i += 1) {
    const wiersz = Object.fromEntries(wszystkie.map((k) => [k, kolumny[k][i]]));
    if (pusteWiersz(wiersz)) continue;
    try {
      // TA SAMA funkcja, co przy dopisywaniu pozycji na karcie — jedna reguła ceny, ilości
      // i przeliczania netto na brutto, nie dwie rozjeżdżające się kopie.
      //
      // Tożsamość produktu dokładamy OBOK jej wyniku, a nie do środka: `parsujNowaPozycje`
      // rozstrzyga o nazwie, ilości i pieniądzach — i tylko o tym.
      pozycje.push({ ...parsujNowaPozycje(wiersz), ...tozsamoscWiersza(wiersz) });
    } catch (e) {
      throw bladOperatora(`Wiersz ${i + 1}: ${e.message}`);
    }
  }
  return pozycje;
}

/**
 * „Skopiuj dane do wysyłki" NA EKRANIE ZAKŁADANIA — dane nabywcy przepisane w pola adresu
 * paczki (prośba właściciela 07.08.2026; ten sam przycisk istnieje na karcie od pierwszej
 * fali tego dnia).
 *
 * ⚠️ OPERUJE NA POLACH FORMULARZA, NIE NA BAZIE — i to jest cała różnica wobec bliźniaka
 * z karty (`kopiujDaneFakturyDoWysylki` w routes/zamowienia.js). Tam kopiuje się ZAPISANE
 * zamówienie, więc trzeba je najpierw zapisać; tutaj nic jeszcze nie istnieje, więc kopia
 * jest przestawieniem wartości między polami i **nic nie zapisuje**. Wspólna funkcja dla obu
 * miejsc byłaby złożeniem dwóch różnych rzeczy: tamta rozstrzyga, co jest nadpisaniem wobec
 * sklepu, a tu żadnego sklepu nie ma.
 *
 * Powtórzone są za to DECYZJE, i celowo tak samo:
 *  - **imię i nazwisko oraz telefon zostają nietknięte.** Kurier wymaga osoby do kontaktu,
 *    a dane faktury jej nie niosą — nadpisanie ich nazwą firmy zostawiłoby paczkę bez
 *    nikogo, kogo kurier mógłby zapytać o drzwi;
 *  - **e-mail z faktury wygrywa, ale tylko gdy jest.** Pusty nie ma prawa skasować adresu,
 *    pod który idzie powiadomienie o paczce.
 *
 * Pola nieobecne w żądaniu zostają nieobecne (`...body` na wejściu) — formularz wraca do
 * operatora w całości, razem z pozycjami, których ten przycisk nie dotyczy.
 */
export function skopiujFaktureDoWysylki(body = {}) {
  return {
    ...body,
    w_firma: body?.f_firma ?? '',
    w_ulica: body?.f_ulica ?? '',
    w_kod: body?.f_kod ?? '',
    w_miasto: body?.f_miasto ?? '',
    w_email: tekst(body?.f_email) ?? body?.w_email ?? '',
  };
}

/**
 * Cały formularz „Nowe zamówienie" zamieniony na fakty gotowe do zapisu.
 *
 * Zwraca bloki `klient` (Woo `billing`) i `dostawa` (Woo `shipping`) W TAKIM KSZTAŁCIE,
 * jakiego oczekują adresOdbiorcy() i daneFaktury() — zamówienie ręczne nie ma sklepu, więc
 * to, co tu zapiszemy, JEST dla panelu daną źródłową.
 */
export function parsujNoweZamowienie(body = {}) {
  const dostawaWybor = String(body?.dostawa ?? 'dpd');
  const platnosc = String(body?.platnosc ?? 'przelew');
  const { metoda: metodaWysylki, pobranie } = metodaWysylkiZWyboru(dostawaWybor, platnosc);

  const osoba = rozbijNazwe(body?.w_nazwa);
  const emailWysylki = tekst(body?.w_email);
  const emailFaktury = tekst(body?.f_email);

  // Blok WYSYLKI. `phone` i `email` celowo go NIE dotyczą: adresOdbiorcy czyta je z bloku
  // płatności (`klient`), bo tak wyglądają dane ze sklepu — zapisane tutaj byłyby niewidoczne.
  const dostawa = {
    ...osoba,
    company: tekst(body?.w_firma),
    address_1: tekst(body?.w_ulica),
    postcode: tekst(body?.w_kod),
    city: tekst(body?.w_miasto),
    country: 'PL',
  };

  // Blok PLATNOSCI = nabywca na fakturze + telefon i e-mail kontaktowy do wysyłki.
  const klient = {
    ...osoba,
    company: tekst(body?.f_firma),
    address_1: tekst(body?.f_ulica),
    postcode: tekst(body?.f_kod),
    city: tekst(body?.f_miasto),
    country: 'PL',
    phone: tekst(body?.w_telefon),
    email: emailWysylki,
  };

  // ⚠️ E-mail do faktury i e-mail do wysyłki mają w bazie JEDNO miejsce (`klient.email`).
  // Gdy klient podaje osobny adres na dokumenty („faktury@", biuro rachunkowe), idzie on
  // jako ręczne nadpisanie danych nabywcy — dokładnie tą samą drogą, co poprawka tego pola
  // na karcie. Wpisany wprost w blok podmieniłby po cichu adres, pod który idzie
  // powiadomienie o paczce.
  const nadpisaniaFaktury = emailFaktury && emailFaktury !== emailWysylki
    ? { email: emailFaktury }
    : null;

  return {
    klient,
    dostawa,
    nip: tekst(body?.f_nip),
    // Pole wyboru: przeglądarka przysyła je WYŁĄCZNIE gdy zaznaczone.
    chce_fakture: body?.f_chce_fakture !== undefined ? 1 : 0,
    metoda_wysylki: metodaWysylki,
    // ⚠️ TO SA PIENIADZE — wlasna kolumna, nie skladnik nazwy metody. Zgubione tutaj
    // znaczy zamowienie telefoniczne przyjete „za pobraniem", ktore pojedzie bez inkasa.
    pobranie,
    // ⚠️ ETYKIETA DLA CZLOWIEKA, nie klucz maszynowy (ustalenie recenzji 2026-08-01).
    // Zamowienia ze sklepu trzymaja w tej kolumnie `payment_method_title` z Woo („Przelewy24",
    // „Płatność przy odbiorze"), a lista wyboru w filtrach buduje sie z DISTINCT tej kolumny
    // (db/filtry.js). Klucz `przelew` obok tytulu „Przelewy24" dalby dwa slowniki w jednym
    // rozwijanym polu i filtr, ktory dla czlowieka wyglada na powtorzony.
    metoda_platnosci: PLATNOSCI[platnosc],
    koszt_dostawy_brutto: parsujKosztDostawy(body?.koszt_dostawy_brutto),
    // ⚠️ KOD PACZKOMATU JEST ADRESEM TEJ PRZESYŁKI, nie ozdobą — bez niego nie ma czego
    // nadać. Zapisuje się WYŁĄCZNIE przy metodzie, która punkt odbioru w ogóle ma: kod
    // zostawiony po przełączeniu na DPD byłby śmieciem udającym adres (ta sama zasada
    // i to samo zdanie, co w `sprawdzZmianeMetody` — domain/wysylka.js).
    //
    // Wielkie litery, bo tak wyglądają kody InPostu na etykietach i w ShipX: „kty01m"
    // przepisane ze słuchu zostałoby przez API odrzucone.
    punkt_odbioru: metodaWysylki === 'inpost_paczkomat'
      ? (tekst(body?.punkt_odbioru)?.toUpperCase() ?? null)
      : null,
    // ⚠️ TO NIE JEST SPOSOB DOSTAWY, tylko odpowiedz na pytanie „kto placi za transport".
    // Klient rozliczany zbiorczo nadaje czesc paczek na WLASNYM koncie kurierskim — wtedy
    // doklejamy mu sama oplate za obsluge zamiast uslugi kurierskiej (services/oplata.js).
    // Zamowienia spoza rozliczenia zbiorczego to pole po prostu nie dotyczy.
    // Pole wyboru: przegladarka przysyla je WYLACZNIE gdy zaznaczone.
    etykietaKlienta: body?.etykieta_klienta !== undefined,
    // ⚠️ TO NIE JEST WIELKOSC ZAMOWIENIA, tylko odpowiedz na pytanie „dokad to jedzie".
    // Klient rozliczany zbiorczo sklada DWA rodzaje zamowien: drop do klienta koncowego
    // (jedna faktura na koniec miesiaca) i hurt do WLASNEJ siedziby (faktura od razu,
    // z terminem). Hurt NIE wchodzi do okresu rozliczeniowego — services/okres.js.
    // Pozostalych zamowien to pole nie dotyczy; pole wyboru, wiec jak wyzej.
    hurt: body?.hurt !== undefined,
    // ⚠️ TO JEST KANAL RAPORTOWY, a nie etykietka na karcie (21.08.2026). Znacznik podstawia
    // sie z bazy stalych klientow, ale od chwili zapisu rozstrzyga ZAMOWIENIE — patrz
    // `kanalOms` w domain/kanaly-raportowe.js i uzasadnienie migawki tamze.
    // Pole wyboru: przegladarka przysyla je WYLACZNIE gdy zaznaczone.
    b2b: body?.b2b !== undefined ? 1 : 0,
    // ⚠️ TERMIN UZGODNIONY Z KLIENTEM, nie wybor na fakturze. Zastepuje wylacznie zapasowe
    // „14 dni" w formularzu faktury i wchodzi do maila z potwierdzeniem — nigdy nie wygrywa
    // z pobraniem ani z faktem oplacenia (domain/termin-platnosci.js: terminFaktury).
    termin_platnosci: parsujTerminZamowienia(body?.termin_platnosci),
    // ⚠️ RABAT JEST SPRAWA WEWNETRZNA — klient widzi wylacznie ceny (decyzja wlasciciela).
    // Kolumna sluzy DWOM rzeczom: pokazaniu na karcie, skad wziely sie kwoty, i przeliczeniu
    // pozycji po zmianie rabatu. Sam zapis kolumny NICZEGO nie przelicza; ceny licza sie
    // przy wstawianiu pozycji z magazynu (domain/magazyn-do-zamowienia.js).
    rabat_procent: parsujRabat(body?.rabat_procent),
    nadpisaniaFaktury,
    pozycje: parsujPozycjeFormularza(body),
  };
}
