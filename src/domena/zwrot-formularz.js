import { grosze, zl } from './kwoty.js';
import { kluczPozycji } from './pozycje-reczne.js';
// ⚠️ `kwotaOczekiwanaGrosze` — JEDYNA definicja „kwoty zamowienia" w panelu (patrz komentarz
// przy niej i przy barierze kwoty w zwrot.js). NIE `kwota_brutto`: kolumna sklepu nie rosnie
// od naszych dopiskow, wiec ekran pokazywalby 317,00 zl przy zamowieniu wartym 367,00 zl,
// a bariera odbijalaby zwrot calosci bez slowa wyjasnienia na ekranie.
import { kwotaOczekiwanaGrosze, wartoscPozycjiGrosze, wysylkaBruttoGrosze } from './suma-pozycji.js';
import {
  juzZwrocone, listaPolaFormularza, normalizujKwote, sumaZwroconejDostawyGrosze,
  sumaZwrotowGrosze, wierszeFormularzaZwrotu,
} from './zwrot.js';

// ⚠️⚠️ PO CO TEN MODUL ISTNIEJE (prosba wlasciciela, 2026-08-15): „Teraz nie widać kwot jakie
// mam wpisać — powinno być gdzieś podsumowanie zamówienia przed zwrotem. Kwota zwrotu
// (pozycje) — czy to liczy się samo?".
//
// Do tego dnia NIE liczylo sie samo: operator przepisywal z palca kwote przy KAZDEJ pozycji
// i kwote laczna, a ekran nie pokazywal mu ani ceny z zamowienia, ani wartosci zamowienia.
// Panel te liczby zna. Ten modul jest miejscem, w ktorym je liczy — RAZ, dla widoku i dla
// zapisu, zeby ekran i bariery nie mogly kiedys odpowiedziec inaczej.
//
// ⚠️ Modul jest CZYSTY: dostaje zamowienie (i ewentualnie to, co operator juz wpisal) i oddaje
// gotowy ksztalt do wyrenderowania. Bazy nie dotyka, a trasa (web/routes/zwroty.js) niczego
// tu nie liczy u siebie — ta sama zasada, co w domain/zwrot.js.
//
// ⚠️ ZERO JAVASCRIPTU W PRZEGLADARCE. Ekran ma dwa kroki WLASNIE dlatego, ze panel nie ma
// (i nie ma miec) skryptu przeliczajacego sume na zywo: krok 1 zbiera liczby, krok 2 pokazuje
// sume policzona TUTAJ, na serwerze.

/**
 * ⚠️⚠️ PRZY RABACIE CENA JEDNOSTKOWA × SZTUKI NIE ROWNA SIE WARTOSCI LINII — i to jest cala
 * tresc tej funkcji.
 *
 * Sklep potrafi dac rabat na linie: trzy sztuki po 35,00 zl bywaja policzone na 100,00 zl,
 * nie na 105,00 zl. `brutto_linii` (przez `wartoscPozycjiGrosze` — TA SAMA funkcja, ktora
 * liczy wartosc linii na karcie, w barierze arytmetycznej faktury i w pozycji wysylanej do
 * inFaktu) jest ta liczba, ktora stoi na FAKTURZE. Zwrot calosci policzony iloczynem
 * rozjechalby sie z zakupem o 5,00 zl — na fakturze KORYGUJACEJ.
 *
 * Dlatego:
 *   • wraca CALA pozostala ilosc → dokladnie pozostala wartosc linii (bez zaokraglania),
 *   • wraca CZESC → proporcjonalnie do pozostalej wartosci, w GROSZACH, z zaokragleniem.
 *
 * „Pozostala" znaczy: pomniejszona o to, co juz wrocilo we wczesniejszych zwrotach tej
 * pozycji. Dzieki temu suma zwrotow czesciowych schodzi sie z wartoscia linii CO DO GROSZA:
 * trzy razy po 33,33 zl to 99,99 zl, ale ostatni zwrot bierze RESZTE (33,34 zl), bo liczy sie
 * z pozostalej wartosci, a nie z iloczynu.
 *
 * ⚠️ PODLOGA ZERA (drobiazg 1, recenzja 2026-08-15). Allegro potrafi oddac kupujacemu WIECEJ,
 * niz warta byla linia (gest, wyrownanie kosztu odeslania) — a taki zwrot da sie w panelu
 * zapisac. Po nim `pozostalaWartoscGr` schodzi ponizej zera i pole kwoty wypelnialo sie
 * napisem `−50.00`. Liczba ujemna nie znaczy tu NIC, co panel umialby zapisac (`parsujZwrot`
 * odmawia kwocie ujemnej), wiec ekran nie ma prawa jej proponowac.
 *
 * ⚠️ STRAZNIK ZERA STOI PRZED ODCZYTEM CENY (drobiazg I2, recenzja kontrolna 2026-08-15) — i to
 * nie jest kosmetyka kolejnosci. `wartoscPozycjiGrosze` RZUCA przy pozycji bez ceny, wiec przy
 * odwrotnej kolejnosci wiersz, ktory NIE WRACA (zero sztuk), wywracal cale liczenie, mimo ze
 * odpowiedz i tak brzmiala „zero", a cena nie byla do niczego potrzebna. Ta warstwa ma NIGDY
 * nie rzucac tam, gdzie umie odpowiedziec. Gdy sztuki naprawde wracaja, wyjatek zostaje — bo
 * kwoty zwrotu bez ceny policzyc sie NIE DA — i lapie go trasa, zamieniajac na zdanie po polsku.
 */
export function kwotaZaSztukiGrosze(p, { sztuki, zwroconeSztuki = 0, zwroconeGr = 0 }) {
  const pozostaleSztuki = (Number(p?.ilosc) || 0) - zwroconeSztuki;
  if (pozostaleSztuki <= 0 || sztuki <= 0) return 0;
  const pozostalaWartoscGr = Math.max(wartoscPozycjiGrosze(p) - zwroconeGr, 0);
  if (sztuki >= pozostaleSztuki) return pozostalaWartoscGr;
  return Math.round((pozostalaWartoscGr * sztuki) / pozostaleSztuki);
}

/**
 * Suma kwot przy pozycjach, KTORE FAKTYCZNIE WRACAJA — czyli „kwota zwrotu (pozycje)",
 * liczona przez SERWER zamiast przepisywana z palca.
 *
 * ⚠️ Pomija wiersze z iloscia 0 DOKLADNIE tak, jak pomija je `parsujZwrot` (`if (w.ilosc === 0)
 * continue`). Rozjazd miedzy tymi dwoma miejscami odbilby sie od bariery spojnosci przy
 * zapisie — a operator nie mialby pojecia dlaczego, bo obu liczb nie wpisywal.
 *
 * ⚠️ `null` (a nie odmowa po polsku), gdy ktorejs kwoty nie da sie policzyc albo tablice
 * formularza maja rozna dlugosc. Powod: ODMOWA MA JEDNEGO AUTORA i jest nim `parsujZwrot` —
 * on chodzi po tych samych wierszach i powie, PRZY KTOREJ pozycji stoi zly napis. Drugi
 * komunikat o tym samym rozjechalby sie z pierwszym przy pierwszej zmianie tresci.
 */
export function sumaKwotPozycjiZl(body) {
  const surowe = wierszeFormularzaZwrotu(body);
  if (!surowe) return null;
  let sumaGr = 0;
  for (const w of surowe) {
    if (!(Number(w.ilosc) > 0)) continue;
    try {
      sumaGr += grosze(normalizujKwote(w.kwota), `kwota przy „${w.nazwa}"`);
    } catch {
      return null;
    }
  }
  return zl(sumaGr);
}

/**
 * RAZEM na kroku 2 — pozycje plus dostawa. Liczy to SERWER i to jest caly sens drugiego kroku:
 * panel nie ma (i nie ma miec) skryptu w przegladarce, wiec sume operator widzi TU, po
 * wyslaniu formularza, a nie w trakcie wpisywania.
 *
 * ⚠️ Wejsciem jest WYNIK `parsujZwrot` (kwoty juz przepuszczone przez `grosze()/zl()`), a nie
 * surowe cialo — krok 2 „niczego nie liczy od nowa poza suma do pokazania".
 */
export function razemZwrotuZl({ kwota, kwotaDostawy = null }) {
  return zl(
    grosze(normalizujKwote(kwota), 'kwota zwrotu')
    + (kwotaDostawy ? grosze(normalizujKwote(kwotaDostawy), 'zwrot dostawy') : 0),
  );
}

/**
 * ⚠️⚠️ ILE KOSZTU DOSTAWY MOZE JESZCZE WROCIC — RESZTA, a nie „wszystko albo nic" (drobiazg M1,
 * recenzja kontrolna 2026-08-15).
 *
 * Do tego dnia ekran pytal „czy zwrocono COKOLWIEK z dostawy" i przy odpowiedzi twierdzacej
 * zostawial puste pole ze zdaniem „Koszt dostawy wrócił już przy wcześniejszym zwrocie — drugi
 * raz nie wraca". Bariera przy zapisie (`parsujZwrot`) liczy tymczasem RESZTE i slusznie
 * pozwala oddac brakujace 10,00 zl z 19,00 zl — jest na to test „czesciowy zwrot dostawy
 * zostawia reszte na drugi raz". Funkcja byla wspolna, ale REGULA nie: ekran mowil czlowiekowi
 * nieprawde i zamykal droge, ktora zapis ma otwarta.
 *
 * ⚠️ Arytmetyka jest TA SAMA, co w sufcie zwrotu dostawy (`wysylkaBruttoGrosze` minus
 * `sumaZwroconejDostawyGrosze`, z podloga zera) — i tak ma zostac. Drugi sposob liczenia
 * „ile dostawy zostalo" rozjechalby ekran z bariera przy pierwszej zmianie: ekran
 * proponowalby zwrot, ktoremu zapis odmawia, albo odwrotnie.
 */
function dostawaZostalaGrosze(z) {
  return Math.max(wysylkaBruttoGrosze(z) - sumaZwroconejDostawyGrosze(z?.zwroty), 0);
}

/**
 * Zdanie o dostawie oddanej wczesniej — albo `null`, gdy nie ma o czym mowic.
 *
 * ⚠️ TRZY STANY, NIE DWA: nic nie wrocilo (cisza), wrocila CZESC (ekran proponuje reszte i mowi
 * skad ona sie wziela), wrocila CALOSC (drugi raz nie wraca). Sklejenie dwoch ostatnich w jedno
 * bylo cala trescia drobiazgu M1.
 */
function uwagaODostawie(oddanaGr, zostalaGr) {
  if (oddanaGr <= 0) return null;
  if (zostalaGr <= 0) return 'Koszt dostawy wrócił już przy wcześniejszym zwrocie — drugi raz nie wraca.';
  return `Z kosztu dostawy wróciło już ${zl(oddanaGr)} zł przy wcześniejszym zwrocie`
    + ` — zostało ${zl(zostalaGr)} zł i tyle panel podpowiada.`;
}

/** Kwota z formularza w groszach albo `null`, gdy nie da sie jej policzyc (odmowe wypowie `parsujZwrot`). */
function groszeAlboNull(surowa) {
  try {
    return grosze(normalizujKwote(surowa), 'kwota');
  } catch {
    return null;
  }
}

/** Wartosci, ktore operator juz wpisal — mapa `klucz pozycji -> { ilosc, kwota }`. */
function wpisaneWiersze(wpisane) {
  const surowe = wpisane ? wierszeFormularzaZwrotu(wpisane) : null;
  if (!surowe) return null;
  return new Map(surowe.map((w) => [w.klucz_pozycji, w]));
}

// Cena jednostkowa jest tu WYLACZNIE do pokazania — do zadnej arytmetyki nie wchodzi (patrz
// `kwotaZaSztukiGrosze`). Uszkodzona cena ma dac pusta komorke, a nie wywalic ekran: ta sama
// zasada, co w `sumaLiniiBrutto` na karcie zamowienia (domain/tabela-pozycji.js).
function cenaJednostkowaZl(p) {
  try {
    return zl(grosze(normalizujKwote(p?.cena_brutto), 'cena jednostkowa'));
  } catch {
    return null;
  }
}

/**
 * WSZYSTKO, co ekran nowego zwrotu (krok 1) ma pokazac — jedna funkcja, jedno wywolanie.
 *
 * `wpisane` to cialo formularza z kroku 2 („Wstecz — popraw"): gdy jest, wygrywa z propozycja,
 * bo operator te liczby juz raz zobaczyl i ewentualnie poprawil. Dopasowanie idzie po KLUCZU
 * pozycji, nie po kolejnosci — kolejnosc wierszy w formularzu nie jest faktem o zwrocie.
 */
export function formularzZwrotu(z, { dzis, wpisane = null } = {}) {
  const wczesniej = juzZwrocone(z?.zwroty);
  const wpisaneMapa = wpisaneWiersze(wpisane);
  const zwroconoGr = sumaZwrotowGrosze(z?.zwroty);
  const dostawaGr = wysylkaBruttoGrosze(z);
  const oddanaGr = sumaZwroconejDostawyGrosze(z?.zwroty);
  const dostawaZostalaGr = dostawaZostalaGrosze(z);

  const pozycje = (z?.pozycje ?? []).map((p, i) => {
    const klucz = kluczPozycji(p, i);
    const byle = wczesniej.get(klucz) ?? { ilosc: 0, kwotaGr: 0 };
    const kupiono = Number(p?.ilosc ?? 0);
    const doZwrotu = Math.max(kupiono - byle.ilosc, 0);
    const wpisany = wpisaneMapa?.get(klucz);
    // Propozycja to CALA pozostala ilosc — najczestszy zwrot to zwrot wszystkiego, a operator
    // i tak widzi „Kupiono" obok i moze zejsc nizej.
    const surowaIlosc = wpisany ? Number(wpisany.ilosc) : doZwrotu;
    const ilosc = Number.isFinite(surowaIlosc) ? surowaIlosc : 0;
    // ⚠️⚠️ KWOTA, KTORA PANEL PROPONUJE DLA POKAZANEJ LICZBY SZTUK — i to jest sedno naprawy
    // wady krytycznej (recenzja 2026-08-15). Krok 2 niesie ja w polu ukrytym i po niej poznaje,
    // czy operator kwoty DOTKNAL: rowna propozycji znaczy „nie tknal", wiec kwota ma sie
    // przeliczyc dla liczby sztuk, ktora wpisal (patrz `przygotujKrok2` nizej).
    //
    // ⚠️ Liczona dla `ilosc`, a NIE dla `doZwrotu` — i to nie jest szczegol. Po „Wstecz —
    // popraw" pole niesie juz kwote PRZELICZONA przez krok 2 (np. 33,33 zl przy 1 z 3 szt.);
    // propozycja liczona dla calej pozostalej ilosci (100,00 zl) rozjechalaby sie z nia, panel
    // uznalby wlasna liczbe za „recznie wpisana" i kwota przestalaby podazac za kazda kolejna
    // zmiana ilosci.
    const propozycjaGr = kwotaZaSztukiGrosze(p, {
      sztuki: ilosc, zwroconeSztuki: byle.ilosc, zwroconeGr: byle.kwotaGr,
    });
    const kwotaZl = wpisany && wpisany.kwota !== undefined
      ? String(wpisany.kwota)
      : zl(propozycjaGr);
    return {
      klucz,
      nazwa: String(p?.nazwa ?? ''),
      cenaJednZl: cenaJednostkowaZl(p),
      kupiono,
      doZwrotu,
      ilosc,
      kwotaZl,
      propozycjaZl: zl(propozycjaGr),
    };
  });

  // ⚠️ Odznaczony checkbox NIE KASUJE podpowiedzi w polu kwoty — pole dostaje ja z powrotem,
  // zeby ponowne zaznaczenie nie kazalo operatorowi szukac kosztu dostawy na karcie. O tym,
  // czy dostawa wraca, decyduje WYLACZNIE checkbox (patrz `przygotujKrok2` nizej).
  const dostawaWpisana = String(wpisane?.kwota_dostawy ?? '').trim();
  // ⚠️ PODPOWIADAMY RESZTE (drobiazg M1) — patrz `dostawaZostalaGrosze` wyzej. Pusty napis
  // znaczy „nie ma czego proponowac", a nie „dostawa istnieje, ale ekran o niej milczy".
  const dostawaPodpowiedz = dostawaZostalaGr <= 0 ? '' : zl(dostawaZostalaGr);
  const dostawa = {
    zaznaczona: wpisaneMapa ? Boolean(wpisane?.zwroc_dostawe) : Boolean(dostawaPodpowiedz),
    kwotaZl: dostawaWpisana || dostawaPodpowiedz,
    // ⚠️ ZDANIE, A NIE SUROWE FAKTY („oddanaWczesniej", „zostalaZl"), z ktorych widok mialby je
    // zlozyc sam — regula ma jednego autora, dokladnie jak przy `ostrzezenieSumy`. Poprzedni
    // ksztalt niosl wlasnie taki surowy znacznik i to on pozwolil ekranowi rozjechac sie
    // z bariera: „cokolwiek wrocilo" to nie to samo pytanie, co „ile jeszcze moze wrocic".
    uwaga: uwagaODostawie(oddanaGr, dostawaZostalaGr),
  };

  // ⚠️ PODLOGA ZERA (drobiazg 1, recenzja 2026-08-15) — dokladnie z tego samego powodu, co przy
  // `kwotaZaSztukiGrosze`: po zwrocie, w ktorym oddano wiecej niz wartosc zamowienia (Allegro
  // to potrafi), kafel pokazywal „Zostało do zwrotu −11,00 zł". Ujemna kwota „do zwrotu" nie
  // opisuje niczego — zostalo zero.
  const zamowienieGr = kwotaOczekiwanaGrosze(z);
  const zostaloGr = Math.max(zamowienieGr - zwroconoGr, 0);

  return {
    podsumowanie: {
      zamowienieZl: zl(zamowienieGr),
      dostawaZl: zl(dostawaGr),
      zwroconoZl: zl(zwroconoGr),
      zostaloZl: zl(zostaloGr),
    },
    pozycje,
    dostawa,
    // ⚠️⚠️ WADA WAZNA Z RECENZJI: PROPOZYCJA BYWALA ODBIJANA PRZEZ WLASNA BARIERE PANELU —
    // patrz `ostrzezenieOSumiePropozycji` nizej.
    ostrzezenieSumy: ostrzezenieOSumiePropozycji(pozycje, dostawa, zostaloGr),
    data: String(wpisane?.data ?? dzis ?? ''),
    powod: String(wpisane?.powod ?? ''),
  };
}

/**
 * ⚠️⚠️ „EKRAN NIE MA PROPONOWAC CZEGOS, CO SIE NIE UDA" — ta sama zasada, ktora rzadzi juz
 * dostawa oddana wczesniej, rozciagnieta na POZYCJE (wada wazna, recenzja 2026-08-15).
 *
 * Propozycja sumuje WARTOSCI LINII (`wartoscPozycjiGrosze`) plus dostawe, a bariera przy zapisie
 * mierzy `kwotaOczekiwanaGrosze`. Te dwie liczby zwykle sa rowne — ale nie musza: zamowienie,
 * w ktorym linie i dostawa nie sumuja sie do kwoty zamowienia, istnieje i panel ma dla niego
 * OSOBNA odmowe przy fakturze (bariera arytmetyczna, services/faktura.js).
 *
 * Zmierzone: pozycje 198,00 + 100,90 + dostawa 19,00 przy `kwota_brutto = '317.00'`. Kafel
 * mowil „Zostało do zwrotu 317,00 zł", pola wypelnialy sie na 317,90 zl, a zapis odbijal sie
 * komunikatem „Suma zwrotów (317,90 zł) przekracza kwotę zamówienia (317,00 zł)" — czyli
 * operator dostawal ODMOWE ZA LICZBY, KTORYCH NIE WPISAL, i nie mial jak zgadnac, ktora pozycje
 * sciac o 90 groszy.
 *
 * ⚠️ MOWIMY, A NIE PRZYCINAMY — i to jest decyzja, nie wygoda. Przyciecie musialoby wybrac,
 * KTORA linie zaniza o 90 groszy, a te kwoty ida WPROST na fakture korygujaca: 99,10 zl przy
 * pozycji wartej 100,00 zl to liczba, ktorej nikt (ani ksiegowa, ani organ) nie umie
 * wytlumaczyc. To jest rozstrzygniecie dla czlowieka, nie dla panelu.
 *
 * ⚠️⚠️ KOMUNIKAT NIE ZGADUJE PRZYCZYNY (drobiazg M2, recenzja kontrolna 2026-08-15). Do tego
 * dnia zdanie mialo zaszyta diagnoze — „To zamówienie nie sumuje się samo ze sobą: jego pozycje
 * i dostawa dają więcej niż kwota, na którą opiewa" — i BYWALO NIEPRAWDZIWE. Zmierzone:
 * zamowienie sumujace sie CO DO GROSZA (198,00 + 100,00 + 19,00 = 317,00), w ktorym rozjazd
 * zrobil WCZESNIEJSZY ZWROT: Allegro oddalo za pozycje 248,00 zl przy wartosci 198,00 zl (gest),
 * wiec zostaje 69,00 zl, a podpowiedzi daja 119,00 zl. Panel oskarzal zamowienie o wade, ktorej
 * ono nie ma, i radzil „zetnij o 50,00 zł kwotę przy którejś pozycji" — czyli dokladnie te
 * liczbe, ktorej nie da sie wytlumaczyc na fakturze korygujacej.
 *
 * Ta funkcja ZNA trzy liczby: sume podpowiedzi, „zostalo do zwrotu" i roznice miedzy nimi.
 * NIE ZNA przyczyny — bo do niej prowadza co najmniej dwie rozne drogi, a panel nie ma czym
 * ich odroznic. Zdanie mowi wiec to, co panel wie, i wymienia WSZYSTKIE pokretla, ktorych
 * operator moze uzyc, nie wskazujac zadnego jako winnego.
 */
function ostrzezenieOSumiePropozycji(pozycje, dostawa, zostaloGr) {
  let sumaGr = 0;
  for (const p of pozycje) {
    if (!(p.ilosc > 0)) continue;
    const gr = groszeAlboNull(p.kwotaZl);
    // Kwoty, ktorej nie da sie policzyc, nie ma sensu sumowac — o niej powie `parsujZwrot`,
    // wskazujac pozycje po nazwie (ta sama zasada, co w `sumaKwotPozycjiZl`).
    if (gr === null) return null;
    sumaGr += gr;
  }
  if (dostawa.zaznaczona && dostawa.kwotaZl) {
    const gr = groszeAlboNull(dostawa.kwotaZl);
    if (gr === null) return null;
    sumaGr += gr;
  }
  if (sumaGr <= zostaloGr) return null;
  return `Podpowiedziane kwoty sumują się do ${zl(sumaGr)} zł, a do zwrotu zostało ${zl(zostaloGr)} zł`
    + ` — o ${zl(sumaGr - zostaloGr)} zł za dużo, więc panel odmówi zapisu całości.`
    + ' Skąd bierze się ta różnica, panel nie wie i nie zgaduje.'
    + ` Sprawdź, ile naprawdę wróciło do kupującego, i zejdź łącznie o ${zl(sumaGr - zostaloGr)} zł`
    + ' — kwotą przy pozycji, liczbą sztuk albo rezygnacją ze zwrotu dostawy.';
}

/**
 * ⚠️⚠️⚠️ KWOTA PODAZA ZA ILOSCIA — NAPRAWA WADY KRYTYCZNEJ (recenzja 2026-08-15).
 *
 * Do tego dnia krok 1 wypelnial kwote wartoscia CALEJ pozostalej linii i na tym sie konczylo:
 * operator zmienial „Wraca (szt.)", kwoty nie ruszal — bo i po co, stoi tam wiarygodna liczba,
 * a zdanie pod tabela do niej przekonuje — a krok 2 „niczego nie liczyl od nowa". Zmierzone:
 * pozycja 3 szt. z rabatem (`brutto_linii` 100,00 przy cenie 35,00), operator ustawia „wraca 1"
 * → zapisywal sie ZWROT 100,00 ZL ZA 1 Z 3 SZTUK. Przechodzil WSZYSTKIE bariery, bo suma
 * zgadzala sie sama ze soba.
 *
 * Skutki byly poza panelem i nieodwracalne: `zwrotyWOkresie` (domain/agregacja-sprzedazy.js)
 * zdejmowalo z przychodu 100,00 zl zamiast 33,33 — wprost w podstawie podatku — a `paryKorekty`
 * (domain/korekta-pozycje.js) skladalo korekte mowiaca „z 3 szt. / 100,00 zl na 2 szt. /
 * 0,00 zl", czyli dokument u organu. Kolejnego zwrotu tej pozycji panel odmawial sam sobie, bo
 * zostawala mu wartosc 0.
 *
 * ⚠️ TO BYLA REGRESJA PRZEBUDOWY NA DWA KROKI. Wczesniej pola startowaly na zerze i operator
 * wpisywal liczbe, ktora sam wybral; teraz panel wstawia liczbe wiarygodna. Przy rabacie
 * 33,33 zl nie da sie policzyc w glowie — nie bylo wiec jak zauwazyc pomylki.
 *
 * REGULA, po dwoch stronach:
 *   • kwota RÓWNA propozycji z kroku 1 (pole ukryte `pozycja_kwota_propozycja`) znaczy, ze
 *     operator jej NIE DOTKNAL → panel przelicza ja dla wpisanej liczby sztuk. To jest „liczy
 *     sie samo" z prosby wlasciciela;
 *   • kwota ZMIENIONA wygrywa — decyzja wlasciciela brzmi „kwotę przepisujesz z Allegro i to
 *     ONA jest prawdą" — ale gdy rozni sie od tego, co panel policzylby dla tej liczby sztuk,
 *     krok 2 MA TO POKAZAC. Ostrzezenie, nie odmowa.
 *
 * ⚠️⚠️ PRZELICZENIE NIE MA BYC CICHE (wada wazna I1, recenzja kontrolna 2026-08-15). Rozpoznanie
 * „operator nie dotknal kwoty" to POROWNANIE LICZB, a liczby da sie zrownac przypadkiem —
 * w druga strone niz naprawiona wyzej wada krytyczna. Zmierzone: pozycja 3 szt. / `brutto_linii`
 * 100,00 zl (rabat), Allegro oddalo kupujacemu 100,00 zl przy zwrocie 1 szt. (gest, wyrownanie
 * kosztu odeslania). Operator ustawia „wraca 1" i ZOSTAWIA 100,00 zl, BO TYLE NAPRAWDE WYSZLO —
 * a panel, widzac kwote rowna swojej propozycji, uznawal ja za nietknieta i po cichu zapisywal
 * 33,33 zl. Do podstawy podatku wchodzilo 33,33 zamiast 100,00, a korekta byla o 66,67 za mala.
 *
 * REGULA ZOSTAJE BEZ ZMIAN (kwota nietknieta dalej sie przelicza, zmieniona dalej wygrywa) —
 * zmienia sie jedno: gdy sciezka „nietkniete" FAKTYCZNIE ZMIENIA LICZBE, krok 2 mowi to zdaniem
 * z obiema kwotami. Gdy przeliczenie niczego nie zmienia (zwrot calosci, czyli przypadek
 * najczestszy), ekran milczy — zdanie o niczym uczyloby tylko tego, zeby zdan nie czytac.
 *
 * ⚠️ BEZ POLA PROPOZYCJI NIC SIE NIE PRZELICZA i to jest bezpieczna strona pomylki: cialo,
 * ktorego nie zlozyl krok 1 (recznie sklecony POST, formularz z innej wersji panelu), nie ma
 * prawa dostac kwoty przepisanej na podstawie propozycji, ktorej nikomu nie pokazano.
 * Ostrzezenie i tak powie, ze liczby sie nie zgadzaja.
 *
 * ⚠️ WIERSZ Z ILOSCIA 0 zostaje nietkniety. `parsujZwrot` pomija go tak samo, a wyzerowanie mu
 * kwoty gubiloby liczbe potrzebna po „Wstecz — popraw".
 */
function przeliczoneWiersze(z, body) {
  const surowe = wierszeFormularzaZwrotu(body);
  if (!surowe) return null;
  const propozycje = listaPolaFormularza(body, 'pozycja_kwota_propozycja');
  // Rowna dlugosc albo nic — przesuniecie o jeden przypisaloby propozycje jednej pozycji do
  // drugiej i panel przeliczylby kwote, ktorej operator wlasnie bronil (ta sama zasada, co
  // przy `wierszeFormularzaZwrotu`).
  const dopasowane = propozycje.length === surowe.length ? propozycje : null;
  const pozycje = new Map((z?.pozycje ?? []).map((p, i) => [kluczPozycji(p, i), p]));
  const wczesniej = juzZwrocone(z?.zwroty);

  return surowe.map((w, i) => {
    const p = pozycje.get(w.klucz_pozycji);
    const sztuki = Number(w.ilosc);
    const wpisanaGr = groszeAlboNull(w.kwota);
    const bezPrzeliczenia = { kwotaZl: w.kwota, ostrzezenie: null };
    // Pozycja, ktorej panel nie zna, kwota nieliczbowa, ilosc nieliczbowa, wiersz, ktory nie
    // wraca — o kazdym z tych przypadkow wypowie sie `parsujZwrot`. Tutaj nie liczymy niczego.
    if (!p || wpisanaGr === null || !Number.isFinite(sztuki) || sztuki <= 0) return bezPrzeliczenia;

    const byle = wczesniej.get(w.klucz_pozycji) ?? { ilosc: 0, kwotaGr: 0 };
    const zaSztuki = (ile) => kwotaZaSztukiGrosze(p, {
      sztuki: ile, zwroconeSztuki: byle.ilosc, zwroconeGr: byle.kwotaGr,
    });
    const panelGr = zaSztuki(sztuki);
    const pozostale = Math.max(Number(p?.ilosc ?? 0) - byle.ilosc, 0);
    const propozycjaGr = dopasowane ? groszeAlboNull(dopasowane[i]) : null;
    // ⚠️⚠️ SCIEZKA „OPERATOR KWOTY NIE TKNAL" — i to ona przelicza kwote. Zdanie powstaje
    // WYLACZNIE wtedy, gdy przeliczenie faktycznie podmienilo liczbe (wada wazna I1 wyzej).
    if (propozycjaGr !== null && propozycjaGr === wpisanaGr) {
      const przeliczone = panelGr !== wpisanaGr;
      return {
        kwotaZl: zl(panelGr),
        ostrzezenie: przeliczone
          ? `Przy „${w.nazwa}" panel przeliczył ${zl(wpisanaGr)} → ${zl(panelGr)} zł,`
            + ` bo wraca ${sztuki} z ${pozostale} szt. — kwoty nie tknąłeś, więc policzył ją sam`
            + ` z wartości linii. Jeśli do kupującego naprawdę wyszło ${zl(wpisanaGr)} zł,`
            + ' wróć i wpisz tę kwotę ręcznie: wpisana ręcznie zostaje.'
          : null,
      };
    }
    if (wpisanaGr === panelGr) return { kwotaZl: zl(wpisanaGr), ostrzezenie: null };

    const calaLinia = wpisanaGr === zaSztuki(pozostale) ? ' — czyli wartość CAŁEJ pozostałej linii' : '';
    return {
      kwotaZl: zl(wpisanaGr),
      ostrzezenie: `Przy „${w.nazwa}" wraca ${sztuki} z ${pozostale} szt., a wpisana kwota to `
        + `${zl(wpisanaGr)} zł${calaLinia}; panel policzyłby ${zl(panelGr)} zł.`
        + ' Zostaje Twoja kwota — kwotę przepisujesz z Allegro i to ona jest prawdą.'
        + ' Jeśli to pomyłka, wróć i popraw.',
    };
  });
}

/**
 * Wszystko, co krok 2 dostaje od domeny: CIALO do `parsujZwrot` (i dalej, polami ukrytymi, do
 * zapisu) oraz OSTRZEZENIA o kwotach, ktore operator wpisal inaczej, niz policzylby panel.
 *
 * Trzy rzeczy dzieja sie TU i nigdzie indziej:
 *   • kwoty przy pozycjach PODAZAJA ZA ILOSCIA (`przeliczoneWiersze` wyzej),
 *   • kwote laczna LICZY SERWER (`sumaKwotPozycjiZl`) — operator jej nie wpisuje, wiec bariera
 *     spojnosci w `parsujZwrot` przestaje go odrzucac i zostaje STRAZNIKIEM: pilnuje, ze miedzy
 *     krokiem 2 a zapisem nikt tych dwoch liczb nie rozjechal (druga otwarta karta, back+resubmit,
 *     recznie sklecony POST),
 *   • ODZNACZONY CHECKBOX ZERUJE DOSTAWE. Pole kwoty dostawy zostaje wypelnione podpowiedzia
 *     nawet przy odznaczonym checkboxie (patrz wyzej), wiec bez tej linii panel oddalby koszt
 *     dostawy, ktorego nikt nie zaznaczyl.
 *
 * ⚠️ SUMA LICZY SIE Z KWOT JUZ PRZELICZONYCH, nie z surowego ciala — inaczej krok 2 pokazywalby
 * jedna liczbe, pola ukryte nioslyby druga, a bariera spojnosci odbilaby zapis, ktorego operator
 * nie wpisywal.
 *
 * ⚠️ `?? '0'` przy kwocie: `sumaKwotPozycjiZl` oddaje `null`, gdy ktorejs kwoty nie da sie
 * policzyc — i wtedy odmowe wypowie `parsujZwrot`, wskazujac pozycje po nazwie. Podstawiona
 * tu jakakolwiek inna liczba przykrylaby tamten komunikat komunikatem o niezgodnej sumie.
 */
export function przygotujKrok2(z, body) {
  const wiersze = przeliczoneWiersze(z, body);
  const zPrzeliczonymi = wiersze
    ? { ...body, pozycja_kwota: wiersze.map((w) => w.kwotaZl) }
    : { ...body };
  return {
    cialo: {
      ...zPrzeliczonymi,
      kwota: sumaKwotPozycjiZl(zPrzeliczonymi) ?? '0',
      kwota_dostawy: body?.zwroc_dostawe ? body?.kwota_dostawy : '',
    },
    ostrzezenia: (wiersze ?? []).map((w) => w.ostrzezenie).filter(Boolean),
  };
}
