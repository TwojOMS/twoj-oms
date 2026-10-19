import {
  sumaPozycjiZWysylkaGrosze, kwotaOczekiwanaGrosze, wartoscPozycjiGrosze, wysylkaBruttoGrosze, zl,
} from './suma-pozycji.js';
import { KLUCZ_WYSYLKI, wysylkaEfektywna } from './wysylka-kwota.js';
import { nettoZBruttoDoPokazania } from './vat.js';
import { czyPozycjaPlaceholdera } from './indywidualne.js';
import { czyPozycjaWysylki } from './pozycje-niesprzedazowe.js';

// Suma linii BRUTTO do wyswietlenia w kolumnie „Suma" — liczona TA SAMA funkcja, ktora
// wchodzi do sumy sprawdzanej przez podsumowaniePozycji() nizej, do bariery arytmetycznej
// faktury i do `gross_price` pozycji wysylanej do inFaktu (wartoscPozycjiGrosze
// w domain/suma-pozycji.js). Wczesniej ta regula istniala tutaj w osobnej kopii — jedna
// funkcja jest cala roznica miedzy „tabela i bariera pokazuja to samo" a „rozjada sie przy
// pierwszej zmianie".
//
// Nie rzuca: uszkodzona cena ma dac pusta komorke, a nie wywalic karte — dokladnie tak, jak
// podsumowaniePozycji nizej.
function sumaLiniiBrutto(p) {
  try {
    return zl(wartoscPozycjiGrosze(p));
  } catch {
    return null;
  }
}

// Netto W KOLUMNIE „Cena netto". Dwie regulz, i roznica miedzy nimi jest calym sednem
// przewodnika 4.5:
//
//  - POZYCJA ZE SKLEPU, nietknieta: netto bierzemy WPROST ze zrodla (Woo, przez
//    domain/mapowanie.js). Brak danych (wiersz sprzed dolozenia kolumny) pokazuje sie jako
//    „brak danych" (null) i NIGDY nie jest zgadywany dzieleniem brutta przez 1,23 — to
//    dzielenie produkowalo rozjazd o grosze, o ktory panel sam sie rozbijal.
//  - POZYCJA DOPISANA albo PRZECENIONA RECZNIE: netto ze sklepu albo nie istnieje, albo juz
//    nie pasuje do linii. Wartoscia ZRODLOWA jest tu brutto, ktore wpisal operator, wiec
//    netto wolno pokazac jako wyliczone ze stawki VAT — patrz komentarz w domain/vat.js.
//    WYLACZNIE do pokazania: do inFaktu i tak idzie brutto.
function cenaNetto(p) {
  if (p.cena_netto != null && String(p.cena_netto).trim() !== '') return p.cena_netto;
  return naszaCena(p) ? nettoZBruttoDoPokazania(p.cena_brutto) : null;
}

// Czy kwota tej linii pochodzi OD NAS, a nie ze sklepu. `zrodlo` sprawdzamy obok `reczna`
// celowo: `reczna` zaklada warstwa odczytu, a wiersz, ktory ja ominal, ma dalej wygladac na
// to, czym jest — inaczej pozycja dopisana recznie renderowalaby sie jako sklepowa.
const naszaCena = (p) => Boolean(p.reczna) || p.zrodlo === 'reczna'
  || (p.polaZmienione ?? []).some((pole) => pole === 'ilosc' || pole === 'cena_brutto');

// Wiersz wysylki, na rowni z pozycjami — patrz wierszePozycji nizej. Ceny ida WPROST
// z wartosci EFEKTYWNEJ (domain/wysylka-kwota.js), nigdy dzieleniem brutto przez 1,23:
// `?? null`, NIE `|| ...`, bo prawdziwa darmowa dostawa ma w bazie STRING '0.00' (prawdziwy,
// niepusty) i nie ma prawa go zgubic — jedynie NULL (stara baza sprzed przeliczenia) ma
// pokazac brak danych.
//
// `lp` i `ilosc` sa PRAWDZIWE, a nie myslnikami: wysylka jest pelnoprawnym wierszem tabeli,
// wchodzi do sumy tak samo jak reszta i tak samo trafia na fakture — udawanie, ze jest czyms
// mniej, mylilo przy czytaniu karty.
//
// ⚠️ WIERSZ MA `klucz` OD 07.08.2026 I TO JEST CALA ZMIANA (prosba wlasciciela: „wysylka
// powinna byc edytowalna tak samo jak produkty. Ilosc oraz cena"). Do tego dnia `klucz` byl
// tu `null` z komentarzem „kosztu wysylki CELOWO nie da sie edytowac: nikt o to nie prosil" —
// i to wlasnie `null` sprawial, ze widok pomijal ten wiersz w trybie edycji. Druga polowa
// tamtego zdania („kazde dodatkowe pole dotykajace kwoty to kolejne miejsce, w ktorym mozna
// sie pomylic o pieniadze") zostaje w mocy: poprawka jedzie przez TA SAMA barierę
// arytmetyczną, przez ten sam czlon roznicowy i przez te same walidatory, co pozycje.
function wierszWysylki(zamowienie, lp) {
  const w = wysylkaEfektywna(zamowienie);
  return {
    lp,
    klucz: KLUCZ_WYSYLKI,
    nazwa: 'Wysyłka',
    sku: null,
    // Ten sam ksztalt wiersza, co przy pozycjach — widok nie ma pytac, ktory to rodzaj.
    skuDoPokazania: null,
    // Wysylka i podsumowanie nie maja ceny katalogowej — rabat ich nie dotyczy.
    cenaKatalogowa: null,
    ilosc: w.ilosc,
    // Netto ZE SKLEPU, dopoki nikt nie ruszal kwoty; po zmianie ceny albo liczby paczek
    // wartosc sklepowa do tej linii nie pasuje (wysylkaEfektywna zeruje ja wtedy sama)
    // i netto liczy sie ze stawki VAT — WYLACZNIE do pokazania, dokladnie jak przy
    // przecenionej pozycji wyzej. Do inFaktu i tak jedzie brutto.
    cenaNetto: w.cena_netto ?? (w.polaZmienione.length ? nettoZBruttoDoPokazania(w.cena_brutto) : null),
    cenaBrutto: w.cena_brutto ?? null,
    // Suma wysylki jest zawsze KWOTA BRUTTO CALEJ LINII (cena × ilosc) — TA SAMA funkcja,
    // ktora wchodzi do sumy pod tabela, do bariery arytmetycznej i na fakture. Przy braku
    // danych (NULL, stara baza) wychodzi '0.00': brak kosztu, nie blad. Zero, NIGDY
    // pominiety wiersz ani puste miejsce.
    //
    // Nie rzuca — uszkodzona cena ma dac pusta komorke, a nie wywalic karte (jak
    // sumaLiniiBrutto wyzej). Rozjazd i tak pokaze sie w wierszu „Razem".
    suma: sumaWysylki(zamowienie),
    // Wysylka nie jest produktem, wiec nie ma zdjecia — pole istnieje, zeby kazdy wiersz
    // tabeli mial ten sam ksztalt i widok nie musial pytac, ktory to rodzaj wiersza.
    zdjecie: null,
    // Ta sama zasada co przy zdjeciu: brak identyfikatora — zeby odnosnikPozycji
    // (domain/link-pozycji.js) mial z czego skorzystac bez pytania widoku, ktory to wiersz.
    // OBA identyfikatory naraz, bo wiersz wysylki wystepuje w KAZDYM kanale.
    produktId: null,
    ofertaId: null,
    wysylka: true,
    reczna: false,
    oznaczReczna: false,
    // Przy zamowieniu RECZNYM znika tak samo, jak przy pozycjach — nie ma sklepu, wobec
    // ktorego cokolwiek by odbiegalo. Znika razem z nim przycisk „Przywroc ze sklepu"
    // przy tym wierszu, i to jest poprawne: nie ma dokad wracac (ta sama decyzja, co przy
    // `saNadpisania` dla danych klienta).
    polaZmienione: zamowienie?.sklep === 'reczne' ? [] : w.polaZmienione,
    podsumowanie: false,
  };
}

function sumaWysylki(zamowienie) {
  try {
    return zl(wysylkaBruttoGrosze(zamowienie));
  } catch {
    return null;
  }
}

// OSTATNI wiersz tabeli: suma wszystkiego powyzej. Byla akapitem pod tabela i przestala nim
// byc — liczba, ktora trzeba porownac z wierszami, ma stac w tej samej kolumnie, co one.
// Wartosc bierzemy z podsumowaniePozycji(), zeby suma w tabeli i suma w ostrzezeniu pod nia
// NIE MOGLY sie rozjechac (to nie jest hipotetyczne: dokladnie ta klasa bledu kazala kiedys
// liczyc sume w dwoch miejscach).
function wierszPodsumowania(podsumowanie) {
  return {
    lp: null,
    klucz: null,
    nazwa: 'Razem',
    sku: null,
    skuDoPokazania: null,
    cenaKatalogowa: null,
    zdjecie: null,
    // Ten sam powod co przy wierszu wysylki wyzej — kazdy wiersz ma ten sam ksztalt.
    produktId: null,
    ofertaId: null,
    ilosc: null,
    cenaNetto: null,
    cenaBrutto: null,
    suma: podsumowanie.sumaZl,
    wysylka: false,
    reczna: false,
    oznaczReczna: false,
    polaZmienione: [],
    podsumowanie: true,
  };
}

// Czy transport przyszedl JUZ JAKO POZYCJA, a nasz syntetyczny wiersz „Wysylka" bylby jego
// drugim, pustym odbiciem (21.08.2026, zgloszenie wlasciciela z zam. 1184 / nr 28216:
// „zobacz co tu sie stalo z wysylka").
//
// Zamowienie zlozone Z OFERTY (wtyczka panelu indywidualnego) przychodzi ze sklepu BEZ
// `shipping_lines` — wysylka jest w nim zwykla POZYCJA („wysylka kurierem DPD", 19 zl).
// Karta rysowala wtedy transport DWA RAZY: raz prawdziwy, jako produkt, i raz wlasny wiersz
// „Wysylka 0,00" — czyli twierdzila, ze dostawa jest darmowa, majac 19 zl w wierszu obok.
// Kwoty byly przez caly czas dobre (suma sie zgadza, faktura pomija zerowa dostawe sama —
// domain/pozycje-faktury.js); klamal wylacznie obraz.
//
// TRZY WARUNKI NARAZ i kazdy z nich odpowiada za inna granice:
//
//  1. Wysylka wg panelu to ZERO. Zamowienie z platna dostawa ma dwa rozne transporty i to
//     jest sprawa dla czlowieka, a nie do schowania.
//  2. Nikt jej recznie nie ruszal. Wysylka WYZEROWANA RECZNIE musi zostac na ekranie —
//     inaczej operator, ktory wpisal 0, traci jedyne miejsce, w ktorym da sie to cofnac.
//  3. Wsrod pozycji JEST transport (domain/pozycje-niesprzedazowe.js — ta sama regula, ktora
//     trzyma wysylke poza rankingiem produktow w raportach). Bez tego warunku zniknalby tez
//     wiersz darmowej dostawy ze zwyklego koszyka, gdzie zero jest PRAWDA o transporcie.
//
// ⚠️ Nie rzuca: uszkodzona cena wysylki ma ZOSTAWIC wiersz (rozjazd pokaze sie w „Razem"),
// a nie wywalic karte — ta sama zasada, co w sumaLiniiBrutto i podsumowaniePozycji.
function wysylkaJestJuzPozycja(zamowienie, wiersze) {
  try {
    if (wysylkaBruttoGrosze(zamowienie) !== 0) return false;
  } catch {
    return false;
  }
  if (wysylkaEfektywna(zamowienie).polaZmienione.length > 0) return false;
  return wiersze.some((w) => czyPozycjaWysylki(w.nazwa));
}

// Wiersze tabeli „Pozycje" GOTOWE do wyswietlenia: lp, nazwa, sku, ilosc, netto, brutto,
// suma — plus wysylka jako pelnoprawny wiersz i suma jako WIERSZ OSTATNI. Widok niczego
// z tego nie liczy sam — ta sama zasada, co przy stanie przesylki i sprawach do zalatwienia
// (routes/zamowienia.js).
//
// Pozycje wchodza tu JUZ EFEKTYWNE (po nadpisaniach recznych) — naklada je warstwa odczytu
// (nalozNadpisaniaPozycji, wolane w zLinii w db/zamowienia.js), a nie ten plik. Dzieki temu
// tabela, suma, saldo wplat, bariera i faktura widza DOKLADNIE te same liczby.
export function wierszePozycji(zamowienie) {
  // ⚠️ ZAMÓWIENIE RĘCZNE NIE OZNACZA NICZEGO JAKO „ręczne" (07.08.2026, prośba właściciela).
  // Oba znaczniki — „dopisana ręcznie" przy wierszu i „zmienione: …" przy polach — odpowiadają
  // na pytanie „czym to się różni od tego, co przysłał SKLEP". Przy zamówieniu telefonicznym
  // sklepu nie ma: KAŻDA pozycja jest dopisana ręcznie, więc znacznik stał przy każdej i nie
  // niósł ani jednej informacji. Ta sama zasada, co przy `saNadpisania` i przy oznaczeniach
  // danych klienta (routes/zamowienia.js: daneKarty).
  //
  // ⚠️ `reczna` ZOSTAJE PRAWDĄ i zostać musi — to ona rządzi przyciskiem „Usuń" przy wierszu
  // i tym, że pozycja zapisuje się wprost, a nie jako różnica wobec sklepu. Gaśnie WYŁĄCZNIE
  // `oznaczReczna`, czyli sam napis.
  const zeSklepu = zamowienie?.sklep !== 'reczne';
  const wiersze = (zamowienie?.pozycje ?? []).map((p, i) => ({
    lp: i + 1,
    // Trwaly identyfikator pozycji (domain/pozycje-reczne.js) — to on jedzie w adresie
    // formularza edycji/usuniecia. NIGDY nasze `pozycje.id`: poller kasuje i wstawia pozycje
    // sklepowe co dwie minuty, wiec `id` na otwartej karcie potrafi byc juz nieaktualne.
    klucz: p.klucz ?? null,
    nazwa: p.nazwa,
    // ⚠️⚠️ `sku` NIESIE PRAWDĘ, `skuDoPokazania` DECYDUJE O NAPISIE — i ten podział kosztował
    // jedną regresję na produkcji (21.08.2026, tego samego dnia).
    //
    // Pierwsza wersja tej poprawki gasiła SKU zaślepki WPROST w `sku`. Napis faktycznie
    // znikał, ale razem z nim znikała jedyna przesłanka, po której `odnosnikPozycji`
    // (domain/link-pozycji.js) rozpoznaje pozycję z oferty — i każda taka pozycja dostała
    // odnośnik do UKRYTEGO produktu-zaślepki. Zgłoszone słowami „dlaczego te produkty są
    // linkami?": na zam. 1184 obie pozycje prowadziły pod ten sam adres `p=28040`.
    //
    // Wniosek do przewodnika: wiersz karty jest CZYTANY NIE TYLKO PRZEZ WIDOK. Pole, które
    // wygląda na „to, co widać", bywa jednocześnie daną, na której stoi reguła — więc
    // wygaszanie napisu robi się OBOK wartości, nigdy na niej.
    sku: p.sku || null,
    // Sam napis: SKU zaślepki to identyfikator ukrytego produktu technicznego, którym wtyczka
    // panelu indywidualnego wstawia do koszyka każdą pozycję z oferty (szablon, wysyłkę,
    // ekspres). Dla czytającego kartę nie znaczy nic, a stał pod nazwą KAŻDEJ pozycji.
    skuDoPokazania: czyPozycjaPlaceholdera(p.sku) ? null : (p.sku || null),
    // Zdjecie produktu ze sklepu. Wiersz niesie ADRES ORYGINALU, a nie miniatury — wariant
    // 150x150 wylicza `domain/miniatury.js` dopiero w widoku, dokladnie tak jak na liscie
    // zamowien. Gdyby tabela liczyla go u siebie, istnialyby dwie reguly na to samo i przy
    // pierwszej zmianie karta pokazywalaby inny rozmiar niz lista.
    zdjecie: p.zdjecie_url ?? null,
    // Identyfikator produktu w sklepie — wylacznie dla odnosnika z pozycji
    // (domain/link-pozycji.js). Sam adres sklada TRASA, bo tylko ona zna `baseUrl`.
    produktId: p.produkt_id ?? null,
    // ...i jego odpowiednik dla Allegro: identyfikator OFERTY. Osobne pole, a nie wspolne
    // „id u zrodla", bo to sa dwie rozne rzeczy o dwoch roznych typach — patrz komentarz
    // przy `pozycje.oferta_id` w db/schema.sql. Wiersz niesie OBA, a ktory z nich cokolwiek
    // znaczy, rozstrzyga kanal — i rozstrzyga to domena, nie widok.
    ofertaId: p.oferta_id ?? null,
    ilosc: p.ilosc,
    cenaNetto: cenaNetto(p),
    cenaBrutto: p.cena_brutto,
    // ⚠️ CENA SPRZED RABATU — POKAZYWANA WYLACZNIE WTEDY, GDY ROZNI SIE OD CENY PLACONEJ
    // (21.08.2026). Przy rabacie zerowym obie sa identyczne i wypisanie ich obok siebie
    // („74,90 → 74,90") byloby szumem przy kazdej pozycji kazdego zamowienia z magazynu.
    //
    // ⚠️ TO NIE JEST DRUGA CENA DO ZAPLATY. Zadna suma, zadna faktura i zaden mail jej nie
    // czytaja — jedynym jej czytelnikiem jest karta, a jedynym uzytkownikiem operator, ktory
    // musi umiec odpowiedziec klientowi na pytanie „skad ta kwota".
    cenaKatalogowa: p.cena_katalogowa && String(p.cena_katalogowa) !== String(p.cena_brutto)
      ? p.cena_katalogowa
      : null,
    suma: sumaLiniiBrutto(p),
    // PRZ-101.04: numer zamówienia, z którego pozycja przyszła — tylko w wierszach grupy scalonej
    // (`zamowienieGrupy`); przy zwykłym zamówieniu `null`, więc widok nic nie dopisuje.
    zZamowienia: p.z_zamowienia ?? null,
    wysylka: false,
    // Oznaczenia dla karty: „dopisane recznie" (caly wiersz) i „zmienione recznie" (pola).
    // Widok ich nie liczy sam — to decyzja domenowa, tak samo jak przy danych klienta.
    reczna: Boolean(p.reczna) || p.zrodlo === 'reczna',
    // NAPIS „dopisana ręcznie", nie fakt ręczności — patrz komentarz nad funkcją.
    oznaczReczna: zeSklepu && (Boolean(p.reczna) || p.zrodlo === 'reczna'),
    // ⚠️ WARUNEK `zeSklepu` JEST TU DZIŚ SEMANTYCZNIE PUSTY i wie o tym weryfikacja mutacyjna
    // (usunięcie go nie wywala żadnego testu — sprawdzone 07.08.2026). Powód: zamówienie
    // ręczne ma WYŁĄCZNIE pozycje o źródle 'reczna', a `nalozNadpisaniaPozycji` daje takim
    // wierszom `polaZmienione: []` zawsze (nadpisania ich nie dotyczą, bo edytuje się je
    // wprost w wierszu). Zostaje jako druga siatka — symetrycznie do `oznaczReczna` wyżej
    // i do wiersza wysyłki niżej, gdzie warunek pustym NIE jest. Nie „sprzątać" go jako
    // martwego kodu: przestanie być pusty w dniu, w którym zamówienie ręczne dostanie
    // jakąkolwiek pozycję o źródle innym niż 'reczna'.
    polaZmienione: zeSklepu ? (p.polaZmienione ?? []) : [],
    podsumowanie: false,
  }));
  if (!wysylkaJestJuzPozycja(zamowienie, wiersze)) {
    wiersze.push(wierszWysylki(zamowienie, wiersze.length + 1));
  }
  wiersze.push(wierszPodsumowania(podsumowaniePozycji(zamowienie)));
  return wiersze;
}

// Podsumowanie do wiersza „Razem" i do ostrzezenia pod tabela: suma WSZYSTKICH pozycji
// (razem z dopisanymi recznie) plus wysylka, porownana z KWOTA OCZEKIWANA OD KLIENTA —
// na liczbach calkowitych w groszach, TA SAMA funkcja co bariera arytmetyczna faktury
// (services/faktura.js, przez domain/suma-pozycji.js).
//
// ⚠️ Druga strona porownania to `kwotaOczekiwanaGrosze`, a NIE `kwota_brutto`: kwota ze
// sklepu nie rosnie od naszych dopiskow (bo wplata sklepowa podaza za nia — patrz
// db/platnosci.js), wiec porownywanie z nia kazaloby panelowi krzyczec o rozjezdzie przy
// KAZDYM zamowieniu z dopisana pozycja.
//
// Nigdy nie rzuca: uszkodzona/pusta kwota nie ma prawa wywalic karty, ale MA sie pokazac
// jako rozjazd — faktura i tak odmowi z tego samego powodu.
export function podsumowaniePozycji(zamowienie) {
  try {
    const sumaGr = sumaPozycjiZWysylkaGrosze(zamowienie);
    const oczekiwanaGr = kwotaOczekiwanaGrosze(zamowienie);
    return { sumaZl: zl(sumaGr), oczekiwanaZl: zl(oczekiwanaGr), zgadzaSie: sumaGr === oczekiwanaGr, blad: null };
  } catch (e) {
    return { sumaZl: null, oczekiwanaZl: zamowienie?.kwota_brutto ?? null, zgadzaSie: false, blad: e.message };
  }
}
