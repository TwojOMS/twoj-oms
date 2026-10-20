import { powodOdmowyStatusu, anulowaneEfektywnie } from './status-reczny.js';
import { czyPobranie, czyKanalAllegro, metodaWysylki, kwotaPobrania } from './wysylka.js';
import { metodaNadania } from './kurier-nadania.js';
import { powodBrakuGotowosciNadania } from './gotowosc-nadania.js';
import { parsujNadpisanieKwotyPobrania } from './pobranie-nadania.js';
import { proponowanaDataSprzedazy } from './data-sprzedazy.js';
import { terminFaktury, ZAPLACONE } from './termin-platnosci.js';
import { powodOdmowyFaktury, powodOdmowyZaplaconej } from './faktura-odmowa.js';
import { stanFaktury } from './faktura-stan.js';
import { podsumowaniePozycji } from './tabela-pozycji.js';
import { pozycjeDokumentu } from './pozycje-faktury.js';

// Akcje masowe ze strony głównej: zmiana statusu i nadanie przesyłek domyślnymi parametrami.
//
// ⚠️ CAŁA WARTOŚĆ TEGO MODUŁU JEST W TYM, CZEGO NIE PRZEPUSZCZA. Nadanie paczki jest
// nieodwracalne (DPD odmawia powtórzenia referencji — przewodnik OMS, 4.3), a robione hurtem
// jest nieodwracalne razy N. Reguły pomijania siedzą TUTAJ, w warstwie czystej, i to jest
// istotne z dwóch powodów:
//
//  1. ekran podglądu przed nadaniem pokazuje DOKŁADNIE ten sam podział, który potem wykona
//     trasa — nie własną, drugą listę warunków, która rozjedzie się przy pierwszej zmianie;
//  2. da się je przeczytać w jednym miejscu, zamiast rekonstruować z `if`-ów rozsypanych
//     po trasie HTTP.
//
// ⚠️ ZASADA WSPÓLNA DLA OBU FUNKCJI: jedno zamówienie, którego nie wolno ruszyć, NIE
// BLOKUJE reszty. Odmowa całości znaczyłaby, że operator musi znaleźć winowajcę wśród
// dwudziestu zaznaczeń i kliknąć jeszcze raz — czyli że funkcja przestaje być użyteczna
// przy pierwszym anulowanym zamówieniu. Pominięte wracają Z POWODEM i mają się pokazać
// na ekranie; ciche wyrzucenie ich z listy byłoby gorsze niż odmowa.

/**
 * Zamówienia o zaznaczonych identyfikatorach, W KOLEJNOŚCI LISTY (a nie w kolejności,
 * w jakiej przyszły z formularza).
 *
 * Wybieramy z tablicy JUŻ WCZYTANEJ na potrzeby listy, a nie osobnym zapytaniem po
 * identyfikatorach — dzięki temu każde zamówienie w akcji masowej przeszło przez dokładnie
 * te same warstwy (zLinii, wyliczStatus, nadpisania ręczne), co wiersz, który operator
 * widział na ekranie.
 */
export function wybraneZListy(zamowienia, surowe) {
  // Jeden zaznaczony checkbox przychodzi z Fastify jako napis, kilka — jako tablica.
  const lista = surowe == null ? [] : [].concat(surowe);
  const chciane = new Set(lista.map((w) => Number(w)).filter((n) => Number.isInteger(n)));
  if (!chciane.size) return [];
  // Identyfikator spoza listy pomijamy PO CICHU: to nie jest stan zamówienia, tylko
  // nieaktualny formularz (druga zakładka, przycisk Wstecz). Zmyślanie zamówienia albo
  // zgłaszanie „nie ma takiego" nie dałoby operatorowi nic, czego nie widzi w wyniku.
  return (zamowienia ?? []).filter((z) => chciane.has(Number(z.id)));
}

/**
 * Podział zaznaczonych na te, którym wolno ustawić status, i pominięte z powodem.
 * Powód pochodzi z `powodOdmowyStatusu` — TEJ SAMEJ funkcji, która rządzi zmianą
 * pojedynczą. Druga kopia tej reguły rozjechałaby się przy pierwszej zmianie i tryb
 * masowy zacząłby przepuszczać to, czego karta odmawia.
 */
export function podzielDoStatusu(zamowienia, docelowy) {
  const doZmiany = [];
  const pominiete = [];
  for (const z of zamowienia ?? []) {
    const powod = powodOdmowyStatusu(z, docelowy);
    if (powod) pominiete.push({ id: z.id, numer: z.numer, powod });
    else doZmiany.push(z);
  }
  return { doZmiany, pominiete };
}

// PRZ-070 (właściciel 14.10.2026): hurt nadaje KAŻDĄ metodę, którą umie karta — i pyta o nią TYMI
// SAMYMI funkcjami (`metodaNadania`, `powodBrakuGotowosciNadania`). Do tego dnia stała tu biała
// lista `['dpd']`, a kanał Allegro odpadał zdaniem „paczki tego kanału nadajesz w Allegro",
// które przestało być prawdą 11.08 (DPD przez „Wysyłam z Allegro") i 18.09 (osiem usług).
// Druga, własna lista warunków rozjechała się z kartą właśnie tak — dlatego jej tu już nie ma.
//
// Pobranie wchodzi do hurtu z kwotą Z ZAMÓWIENIA (decyzja właściciela 14.10). Kwota jest widoczna
// w uwagach ekranu podglądu, a usługa nadania zapisuje ją do logu przed wywołaniem kuriera.
const WZA = ['allegro_dpd', 'allegro_punkt', 'allegro_kurier', 'allegro_inne'];

/** Kształt wiersza na ekranie podglądu: od kuriera zależy, o jaki rozmiar pytamy. */
export function rodzajFormularzaNadania(metodaUzyta) {
  if (metodaUzyta === 'dpd') return 'dpd';
  if (metodaUzyta === 'inpost_paczkomat') return 'paczkomat';
  if (WZA.includes(metodaUzyta)) return 'wza';
  return null;
}

/**
 * Podział zaznaczonych na te, które pójdą do kuriera, pominięte z powodem i uwagi —
 * czyli rzeczy, które nadania NIE blokują, ale mają być widoczne przed kliknięciem.
 * Przepuszczone niosą `metodaUzyta` i `rodzajFormularza` — trasa nie liczy ich drugi raz.
 */
export function podzielDoNadania(zamowienia) {
  const doNadania = [];
  const pominiete = [];
  const uwagi = [];
  for (const z of zamowienia ?? []) {
    const decyzja = decyzjaNadania(z);
    if (decyzja.powod) {
      pominiete.push({ id: z.id, numer: z.numer, powod: decyzja.powod });
      continue;
    }
    doNadania.push({ ...z, metodaUzyta: decyzja.metodaUzyta, rodzajFormularza: decyzja.rodzaj });
    // ⚠️ PRZY POBRANIU brak wpłaty jest normą, a nie sygnałem — uwaga mówi o PIENIĄDZACH,
    // które zainkasuje kurier, bo hurtem nikt nie zagląda w kwoty po kolei.
    if (czyPobranie(z)) {
      uwagi.push({
        id: z.id,
        numer: z.numer,
        tresc: decyzja.rodzaj === 'wza'
          ? `za pobraniem — kwotę pobrania poda Allegro (w zamówieniu ${kwotaPobrania(z) ?? '?'} zł)`
          : `za pobraniem — kurier zainkasuje ${kwotaPobrania(z)} zł`,
      });
    } else if (!z?.oplacone_at) {
      // Nieopłacone NIE blokuje: to sklep B2B i wysyłka na fakturę z terminem płatności jest
      // normalna (ta sama decyzja, co przy nadaniu pojedynczym — patrz services/nadanie.js).
      // Ale hurtem nikt nie zagląda w kwoty, więc na ekranie podglądu ma to być WIDOCZNE.
      uwagi.push({
        id: z.id,
        numer: z.numer,
        tresc: `nie jest opłacone${z?.kwota_brutto ? ` (${z.kwota_brutto} zł)` : ''} — paczka pojedzie mimo to`,
      });
    }
  }
  return { doNadania, pominiete, uwagi };
}

// Kolejność warunków = kolejność ważności: pierwszy trafiony powód jest tym, który operator
// zobaczy. Anulowanie idzie przed wszystkim, bo to jedyny stan, w którym paczka nie powinna
// wyjechać W OGÓLE, a nie „nie tędy".
function decyzjaNadania(z) {
  if (anulowaneEfektywnie(z)) return { powod: 'zamówienie jest anulowane' };
  const metoda = String(metodaWysylki(z) ?? 'nieznana');
  const allegrowaMetoda = metoda.startsWith('allegro_');
  // ⚠️⚠️ TO SĄ PIENIĄDZE (poprawka z 04.08.2026 zostaje w mocy). Metoda jest EDYTOWALNA
  // z karty, kanał (`sklep`) — nie: ustawia go poller i żaden formularz panelu go nie rusza.
  // Zamówienie z Allegro przestawione na metodę sklepową poszłoby naszą umową, czyli DRUGĄ,
  // płatną paczką do klienta z opłaconą dostawą u Allegro. Nie do cofnięcia.
  if (czyKanalAllegro(z) && !allegrowaMetoda) {
    return { powod: 'zamówienie z Allegro ma ręcznie ustawioną metodę sklepową — nadaj je z karty zamówienia' };
  }
  // Odwrotna furtka: zamówienie sklepowe przestawione na metodę allegrową. Adapter WzA i tak
  // odmówi (`wolnoNadacZOms` pyta o kanał), ale ekran podglądu nie ma tego obiecywać.
  if (!czyKanalAllegro(z) && allegrowaMetoda) {
    return { powod: 'metoda allegrowa przy zamówieniu spoza Allegro — popraw metodę na karcie zamówienia' };
  }
  // Żywa paczka = wszystko poza nieudanym nadaniem. Przy 'blad' u kuriera nic nie powstało
  // (patrz services/nadanie.js: numeru nie ma, miejsce w indeksie zwolnione), więc takie
  // zamówienie wolno nadać normalnie. Przy 'do_wyjasnienia' numer listu ISTNIEJE, mimo że
  // nadanie się nie domknęło — i właśnie dlatego ten stan nie zwalnia indeksu.
  //
  // Hurtem nadajemy WYŁĄCZNIE paczkę nr 1. Dosyłka i zamiennik za zgubioną są decyzjami
  // jednostkowymi, z powodem wpisywanym do logu — nie czymś, co wychodzi z zaznaczenia
  // wiersza na liście.
  if ((z?.przesylki ?? []).some((p) => p?.status !== 'blad')) {
    return { powod: 'ma już nadaną paczkę — dosyłkę nadaj z karty zamówienia' };
  }
  if (metoda === 'odbior_osobisty') return { powod: 'odbiór osobisty — nie ma czego nadawać' };
  // Droga domyślna karty dla paczki nr 1, bez wskazania kuriera. Furtka „naszą umową" przy
  // zamówieniu z Allegro (dosyłka, zamiennik) zostaje decyzją jednostkową z ekranu karty.
  const { metoda: metodaUzyta, blad } = metodaNadania(z, '', { kolejnosc: 1 });
  if (blad) return { powod: blad };
  const rodzaj = rodzajFormularzaNadania(metodaUzyta);
  if (!rodzaj) return { powod: 'nieznana metoda wysyłki — ustaw ją na karcie zamówienia' };
  const braki = powodBrakuGotowosciNadania(z, metodaUzyta);
  if (braki) return { powod: braki };
  // ⚠️ TO SĄ PIENIĄDZE. Pytamy o POBRANIE w wartości EFEKTYWNEJ (po ręcznych korektach),
  // dokładnie tej, którą operator widzi w kolumnie „Dostawa".
  if (czyPobranie(z)) {
    // ⚠️ Umowa z InPostem na pobranie NIEPOTWIERDZONA (domena/kurier-nadania.js) — paczka
    // mogłaby pojechać bez inkasa. Karta zostawia tu furtkę dla człowieka, hurt nie.
    if (rodzaj === 'paczkomat') {
      return { powod: 'pobranie do paczkomatu — nadaj z karty zamówienia (umowa z InPostem na pobranie jest niepotwierdzona)' };
    }
    // DPD bez kwoty nie wstawia <cod>: paczka jedzie jak przedpłacona i NIGDZIE nie ma błędu.
    // Przy WzA kwotę bierze adapter z podpowiedzi Allegro, więc pusta kolumna nie szkodzi.
    if (rodzaj === 'dpd' && kwotaPobrania(z) == null) {
      return { powod: 'pobranie bez kwoty — uzupełnij kwotę pobrania na karcie zamówienia' };
    }
    // Recenzja D8 (P3-1): kwotę sprawdza TA SAMA funkcja, co pole na ekranie nadania karty —
    // zero, pusty napis albo zły zapis („104.", „1e2") dałyby w DPD paczkę bez <cod>.
    if (rodzaj === 'dpd' && parsujNadpisanieKwotyPobrania({ kwota_pobrania: kwotaPobrania(z) }, { pobranie: true, kolejnosc: 1 }).blad) {
      return { powod: `kwota pobrania jest niepoprawna — popraw ją na karcie zamówienia („${kwotaPobrania(z)}”)` };
    }
  }
  return { metodaUzyta, rodzaj };
}

// Ile faktur wolno wystawic jednym klikneciem operatora.
//
// UWAGA: TO NIE JEST ZABEZPIECZENIE — zabezpieczeniem jest BUDZET CZASU, ktory powstanie
// w services/faktura-hurtem.js (Zadanie 3). Sufit tutaj jest wylacznie uprzejmoscia
// interfejsu: zaznaczenie dwustu zamowien ma odbic sie od czytelnego komunikatu, zanim
// ktokolwiek zdazy kliknac, a nie zamienic sie w dwanascie rund wywolan do inFaktu. Kto
// oprze na tej stalej prawdziwa ochrone przed zbyt dlugim zadaniem, oprze ja na zlej rzeczy.
export const SUFIT_FAKTUR_HURTEM = 25;

/**
 * Odmowa calej partii, gdy zaznaczenie przekracza sufit — ODMOWA, NIE CICHE PRZYCIECIE.
 * Wziecie pierwszych `SUFIT_FAKTUR_HURTEM` zaznaczonych wygladaloby na ekranie dokladnie
 * tak samo jak komplet, a to jest ekran o dokumentach ksiegowych: operator ma wiedziec,
 * ze czesc zamowien zostala poza fakturami, zamiast dowiedziec sie o tym po fakcie.
 */
export function powodZaDuzejPartii(ile) {
  if (Number(ile) <= SUFIT_FAKTUR_HURTEM) return null;
  // ⚠️ `ile` to liczba PO odsianiu pominietych (doWystawienia.length), NIE liczba
  // zaznaczonych na liscie — operator mogl zaznaczyc wiecej, a czesc odpasc z innego powodu
  // (brak wplaty, juz wystawiona faktura). Zdanie mowi wiec o tym, co KWALIFIKUJE SIE do
  // wystawienia, a nie o samym zaznaczeniu — inaczej klamie liczba (do 12.08.2026 stalo tu
  // „Zaznaczono N zamowien" z ta sama liczba, co bylo nieprawda przy jakimkolwiek pominieciu).
  return `Do wystawienia kwalifikuje się ${ile} zamówień, a panel wystawia najwyżej `
    + `${SUFIT_FAKTUR_HURTEM} faktur naraz. Nie wystawiono niczego — zaznacz mniej i powtórz.`;
}

// Ile specyfikacji wolno wydrukowac jednym klikneciem.
//
// ⚠️ OSOBNA STALA OD `SUFIT_FAKTUR_HURTEM` I WYZSZA — to naklad drukarki, nie dokumenty
// ksiegowe. Faktury sa nieodwracalne i ida do inFaktu po jednej; specyfikacja powstaje
// lokalnie, nie zostawia sladu nigdzie, a pomylka kosztuje klikniecie „wstecz". Wspolna
// stala kazalaby pakowaczowi dzielic dzien wysylkowy na porcje po 25 kartek bez powodu.
//
// ⚠️ DO 12.08.2026 SUFITU NIE BYLO WCALE, z uzasadnieniem „generowanie jest lokalne, wiec nic
// nie grozi". To bylo BLEDNE, i to z powodow niewidocznych z poziomu samej trasy:
//  - `listaZamowien` nie ma `LIMIT` ani stronicowania, a zakladka „Wszystkie" renderuje
//    KOMPLET bazy;
//  - „zaznacz wszystkie" to zwykly odnosnik `?zaznacz=1`, ktory zaznacza kazdy wyrenderowany
//    wiersz — czyli caly ten komplet;
//  - `zbudujSpecyfikacjeWieluPdf` rysuje SYNCHRONICZNIE, w petli, na watku petli zdarzen.
// Zlozenie tych trzech rzeczy daje jedno pomylkowe klikniecie, po ktorym panel przestaje
// odpowiadac KOMUKOLWIEK na czas rysowania tylu stron, ile zamowien jest w bazie. To ta sama
// klasa awarii — zablokowana petla zdarzen — ktorej modul unika przy nadaniu i przy fakturach.
//
// ⚠️ SKAD 100. Pomiar rysowania (laptop, 12.08.2026, zamowienia po 3 pozycje): 100 zamowien
// = 176 ms, 500 = 597 ms, 1000 = 1120 ms. Sto kartek to okolo pol ryzy papieru i wiecej, niz
// sklep A pakuje w ktorykolwiek dzien — sufit nie wchodzi wiec w droge prawdziwej pracy,
// a odcina rzad wielkosci, na ktorym zaczyna sie problem (kontener na NAS-ie jest wolniejszy
// od laptopa, wiec zapas liczy sie w rzedach wielkosci, nie w procentach). Gdyby dzien
// wysylkowy kiedys naprawde przekroczyl sto paczek, ta liczba ma urosnac razem z nim — ale
// wtedy SWIADOMIE, a nie przez zapomniany sufit.
export const SUFIT_SPECYFIKACJI_DRUKU = 100;

/**
 * Odmowa calej partii druku, gdy zaznaczenie przekracza sufit — ODMOWA, NIE CICHE PRZYCIECIE,
 * dokladnie jak przy fakturach. Wydrukowanie pierwszych `SUFIT_SPECYFIKACJI_DRUKU` kartek
 * wygladaloby na ekranie tak samo jak komplet, a pakowacz dowiedzialby sie o brakach dopiero
 * przy paczce bez dokumentu.
 *
 * ⚠️ `ile` to liczba ZAZNACZONYCH (specyfikacja nie ma pominietych — powstaje dla kazdego
 * zamowienia), wiec zdanie mowi o zaznaczeniu. Przy fakturach jest odwrotnie i to nie jest
 * niekonsekwencja, tylko roznica miedzy dwiema drogami — patrz `powodZaDuzejPartii` wyzej.
 */
// `co` (PRZ-084): ten sam sufit trzyma liste produktow i zestawienie z menu „Wydruki" —
// rysowane tak samo synchronicznie — wiec zdanie ma nazwac wydruk, ktory kliknieto.
export function powodZaDuzegoDruku(ile, co = 'specyfikacji') {
  if (Number(ile) <= SUFIT_SPECYFIKACJI_DRUKU) return null;
  return `Zaznaczono ${ile} zamówień, a panel drukuje najwyżej ${SUFIT_SPECYFIKACJI_DRUKU} `
    + `zamówień w jednym wydruku ${co}. Nie wydrukowano niczego — zaznacz mniej i powtórz.`;
}

// Stan faktury, ktory blokuje wystawienie hurtem, przelozony na zdanie dla operatora.
// `null` = 'brak' rezerwacji, wolno wystawiac. Sformulowania po 'wystawiona'/'w_toku'/
// 'zawieszona'/'do_wyjasnienia' powtarzaja ton uzywany juz na karcie zamowienia
// (domain/sprawy-karty.js, web/views/zamowienie.ejs) — operator ma czytac to samo zdanie,
// niezaleznie od tego, ktorym ekranem trafil na ten sam stan.
function powodStanuFaktury(z, teraz) {
  const stan = stanFaktury(z?.faktura, teraz);
  if (stan === 'brak') return null;
  if (stan === 'wystawiona') {
    const numer = z?.faktura?.numer ? ` ${z.faktura.numer}` : '';
    return `Zamówienie ${z?.numer} ma już wystawioną fakturę${numer} — hurtem nie wystawia się drugiej.`;
  }
  if (stan === 'w_toku') {
    return `Wystawianie faktury zamówienia ${z?.numer} już trwa — odśwież i sprawdź kartę zamówienia.`;
  }
  if (stan === 'zawieszona') {
    return `Wystawianie faktury zamówienia ${z?.numer} jest zawieszone — sprawdź kartę zamówienia.`;
  }
  // 'do_wyjasnienia'
  return `Faktura zamówienia ${z?.numer} jest do wyjaśnienia w inFakcie — sprawdź kartę zamówienia.`;
}

// BARIERA ARYTMETYCZNA W PODGLADZIE — szosta bariera, dolozona 12.08.2026 (recenzja).
//
// ⚠️ PO CO, SKORO `wystaw()` I TAK ODMOWI. Bo bez niej zamowienie z rozjechana suma stalo na
// ekranie podgladu w sekcji „Pójdzie do inFaktu", operator je zatwierdzal, a ono ladowalo
// w „Nie udało się". Zaden dokument nie powstawal — bariera w services/faktura.js dziala —
// ale PODGLAD OBIECYWAL COS, CZEGO TRASA NA PEWNO NIE ZROBI. To dokladnie ten rozjazd miedzy
// ekranem a wykonaniem, ktory ta galaz miala zlikwidowac (patrz naglowek modulu, punkt 1).
//
// ⚠️ NIC TU NIE LICZYMY OD NOWA. `podsumowaniePozycji` (domain/tabela-pozycji.js) jest juz
// liczone przy KAZDYM renderze listy dla wiersza „Razem", jest z definicji NIERZUCAJACE
// i porownuje te same dwie liczby, co `sprawdzSumeDokumentu` w services/faktura.js —
// `sumaPozycjiZWysylkaGrosze` wobec `kwotaOczekiwanaGrosze`, w groszach, na calkowitych.
//
// ⚠️ PUSTY DOKUMENT PYTAMY OSOBNO i pytamy o niego `pozycjeDokumentu`, nie wlasnym warunkiem.
// Zamowienie na 0,00 zl bez ani jednej pozycji sumuje sie POPRAWNIE (0 = 0), wiec przechodzi
// przez sprawdzenie sumy — a `sprawdzSumeDokumentu` mimo to odmawia, bo faktura bez pozycji
// to realny blad w inFakcie. Gdyby ten warunek przepisac tu z reki („brak pozycji i zerowa
// wysylka"), powstalaby druga kopia reguly i rozjechalaby sie przy pierwszej zmianie skladu
// dokumentu. `try`, bo `pozycjeDokumentu` na uszkodzonej kwocie rzuca.
function powodRozjazduDokumentu(z) {
  const p = podsumowaniePozycji(z);
  if (p.blad) {
    return `Kwot zamówienia ${z?.numer} nie da się policzyć (${p.blad}) — popraw pozycje na karcie zamówienia.`;
  }
  if (!p.zgadzaSie) {
    return `Pozycje zamówienia ${z?.numer} sumują się do ${p.sumaZl} zł, a zamówienie opiewa na `
      + `${p.oczekiwanaZl} zł — popraw pozycje na karcie, bo wystawienie faktury i tak odmówi.`;
  }
  try {
    if (pozycjeDokumentu(z).length === 0) {
      return `Zamówienie ${z?.numer} nie ma żadnej pozycji do zafakturowania — faktury bez pozycji panel nie wystawi.`;
    }
  } catch {
    // Nieczytelna kwota w pozycji. Sumowanie wyzej jej nie zlapalo (bo `podsumowaniePozycji`
    // oddaje wtedy `blad`, a tam juz bylismy), wiec to jest przypadek, ktorego ta funkcja nie
    // umie nazwac lepiej niz `wystaw()`. Przepuszczamy — odmowa przyjdzie z bariery prawdziwej.
    return null;
  }
  return null;
}

/** Jak wariant wygląda na ekranie podglądu — te same słowa, co w terminach karty zamówienia. */
export const ETYKIETA_WARIANTU = { zaplacone: 'zapłacona', przy_odbiorze: 'za pobraniem — przy odbiorze' };

/**
 * Wariant faktury hurtem: `{ termin, dataSprzedazy }` albo `{ powod }`.
 *
 * PRZ-070 (właściciel 14.10.2026): pobranie wchodzi do hurtu. Wariant liczy TA SAMA reguła, co
 * formularz karty (`terminFaktury` + `proponowanaDataSprzedazy`, moduly/zamowienia/kontekst.js):
 * przedpłata bez inkasa kuriera pokrywa należność → „zapłacone", inaczej → „przy odbiorze"
 * (sposób zapłaty „za pobraniem" dokłada services/faktura.js przez domain/sposob-platnosci.js).
 * Takie faktury nie trafiają na pas długów (`czekaNaPrzelew` odsiewa pobranie od 10.08),
 * więc powód, dla którego hurt był „tylko opłacone" (decyzja 11.08), ich nie dotyczy.
 *
 * ⚠️ PRZY POBRANIU NIE PYTAMY `powodOdmowyZaplaconej`: sklep zapisuje „wpłatę" z metodą
 * „Za pobraniem" w chwili oznaczenia zamówienia (pomiar 31.08.2026, zamówienie 1259), więc
 * suma wpłat twierdzi, że zapłacono, zanim kurier zobaczył klienta. Faktura „zapłacona"
 * na takiej podstawie byłaby nieprawdą na dokumencie, którego się nie poprawia, tylko koryguje.
 * Zamówienia BEZ pobrania — bez zmian: wyłącznie opłacone, wariant „zapłacone".
 *
 * @param dzis wyłącznie dla testów — dzień „dziś" w Warszawie, przekazywany do propozycji daty.
 */
export function wariantFakturyHurtem(z, dzis) {
  const propozycja = () => (dzis ? proponowanaDataSprzedazy(z, dzis) : proponowanaDataSprzedazy(z));
  if (czyPobranie(z)) {
    const p = propozycja();
    return {
      termin: terminFaktury({ zaplacone: p?.podstawa === 'zaplata', pobranie: true }),
      dataSprzedazy: p?.data ?? null,
    };
  }
  const powod = powodOdmowyZaplaconej(z);
  if (powod) return { powod };
  return { termin: ZAPLACONE, dataSprzedazy: propozycja()?.data ?? null };
}

/**
 * Podzial zaznaczonych na te, ktorym wolno wystawic fakture hurtem, i pominiete z powodem.
 *
 * ⚠️ HURT DOTYCZY ZAMOWIEN OPLACONYCH ALBO ZA POBRANIEM (decyzja wlasciciela 11.08.2026,
 * rozszerzona o pobranie 14.10.2026 — PRZ-070). Oplacone ida wariantem „zaplacone", pobranie
 * wariantem z `wariantFakturyHurtem`. Zadna z tych faktur nie moze wyladowac na pasie dlugow
 * w zakladce FAKTURY: oplacone nie sa dlugiem, a pobranie pas odsiewa sam.
 *
 * Kolejnosc rozstrzygania jest CZESCIA REGULY, tak jak w `powodOdmowyFaktury`, i POWTARZA
 * kolejnosc z `wystaw()` (services/faktura.js) — inaczej podglad tlumaczylby pominiecie
 * innym powodem, niz podalaby karta przy tym samym zamowieniu:
 *  1. `powodOdmowyFaktury` — okres rozliczeniowy, anulowanie, brak zgody klienta;
 *  2. stan istniejacej rezerwacji faktury (`stanFaktury`) — czy nie ma juz dokumentu;
 *  3. bariera arytmetyczna — czy pozycje sumuja sie do kwoty zamowienia (patrz
 *     `powodRozjazduDokumentu` wyzej; w `wystaw()` to `sprawdzSumeDokumentu`);
 *  4. `wariantFakturyHurtem` — przy pobraniu wariant bez odmowy, poza nim
 *     `powodOdmowyZaplaconej` (czy wplaty pokrywaja naleznosc).
 *
 * ⚠️ Powody pochodza z TYCH SAMYCH funkcji, ktore rzadza wystawieniem pojedynczym — patrz
 * docblock w domain/faktura-odmowa.js. Ta funkcja nie przepisuje reguly, tylko ja odpytuje.
 */
export function podzielDoFaktury(zamowienia, teraz = Date.now(), opcje = {}) {
  const doWystawienia = [];
  const pominiete = [];
  for (const z of zamowienia ?? []) {
    const powod = powodOdmowyFaktury(z, opcje)
      ?? powodStanuFaktury(z, teraz)
      ?? powodRozjazduDokumentu(z)
      ?? wariantFakturyHurtem(z).powod
      ?? null;
    if (powod) pominiete.push({ id: z.id, numer: z.numer, powod });
    else doWystawienia.push(z);
  }
  // Od NAJSTARSZEGO do najnowszego — numery faktur sa kolejne, wiec to ustawia numeracje
  // zgodnie z chronologia zamowien. `id` rozstrzyga remis, zeby sortowanie bylo stabilne
  // niezaleznie od kolejnosci zaznaczenia na liscie.
  doWystawienia.sort((a, b) => String(a.utworzone_at ?? '').localeCompare(String(b.utworzone_at ?? ''))
    || Number(a.id) - Number(b.id));
  return { doWystawienia, pominiete };
}
