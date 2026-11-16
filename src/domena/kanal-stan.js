// CZY KANAL WOLA O POMOC — i czy wolno go wiazac z panelu.
//
// ⚠️⚠️ TA JEDNA REGULA RZADZI DWIEMA RZECZAMI NARAZ: tym, co panel POKAZUJE, i tym, czy
// POZWALA kliknac wiazanie. Druga kopia rozjechalaby sie przy pierwszym nowym stanie —
// a rozjazd znaczy albo przycisk prowadzacy prosto w odmowe, albo ostrzezenie bez wyjscia
// (reguła: każdy stan ma wyjście). Dlatego jest CZYSTA: bez sieci, bez bazy, bez zegara poza `zostaloDni`.
//
// POWSTALA PO AWARII, W KTOREJ KANAL PRZESTAL ODPOWIADAC. Panel zapisal blad do
// `tokeny_kanalu.ostatni_blad` i do `stan_pollera` — I NA TYM SKONCZYL. Sprzedawca
// dowiedzial sie kilka godzin pozniej, bo nie dalo sie nadac paczki. Panel WIEDZIAL
// i nie powiedzial.

// Ile dni przed koncem waznosci refresh tokena uprzedzamy. Ta sama liczba, co
// `DNI_OSTRZEZENIA` w allegro/tokeny.js — kanal ma miec JEDEN termin, a nie dwa zdania
// o dwoch roznych datach.
import { kolizjeKont } from './tozsamosc-kanalu.js';

export const DNI_UPRZEDZENIA = 7;

// ⚠️ TRESC MOWI, CO PRZESTALO DZIALAC, a nie tylko „blad tokenu". Czlowiek ma ocenic, czy
// to pilne, zanim otworzy cokolwiek innego — a „blad tokenu" nie mowi mu o tym nic.
const SKUTKI = 'nie pobiera zamówień, nie odsyła statusów i nie nada paczki ani nie wyśle faktury';

export function stanKanalu(wejscie) {
  // Brak wejscia to stan wymagajacy uwagi, nie wyjatek: rzucenie tutaj wywalaloby strone
  // glowna z powodu kanalu, ktorego nikt jeszcze nie podlaczyl.
  if (!wejscie) {
    return {
      kanal: null, zyje: false, pilne: true, uprzedzenie: false, wolnoWiazac: true,
      zostaloDni: null, refreshWygasaAt: null, kontoAllegro: null,
      powod: 'Panel nie zna stanu tego kanału — połącz go z Allegro.',
    };
  }

  // ⚠️ BIALA LISTA POL, NIGDY `...wejscie`. Ta funkcja bywa wolana `stanDlaEkranu()`, ale
  // nic nie broni komus podac jej surowego wiersza z `tokeny_kanalu` — a tam siedza TOKENY.
  // Przepisanie wejscia w calosci wypchneloby je na ekran (reguła: sekrety nie wychodzą).
  const {
    kanal = null, polaczony = false, zostaloDni = null, refreshWygasaAt = null, ostatniBlad = null,
    // ⚠️ Nazwy zakresow NIE SA poswiadczeniem — wolno je pokazac, i trzeba, bo bez nazwy
    // czlowiek nie wie, co dodac w aplikacji Allegro (domena/uprawnienia-kanalu.js).
    brakujaceUprawnienia = [],
    // ⚠️ IDENTYFIKATOR KONTA ALLEGRO TEZ NIE JEST POSWIADCZENIEM — i jest JEDYNA rzecza,
    // po ktorej czlowiek pozna, ze przewiazal kanal na zle konto (domena/tozsamosc-kanalu.js).
    kontoAllegro = null,
    // Czy inny kanal wisi na TYM SAMYM koncie. Liczone poza ta funkcja, bo wymaga
    // spojrzenia na WSZYSTKIE kanaly naraz, a ta ocenia jeden.
    kolizjaKonta = false,
    // Token bez zakresów ofert, aplikacja je ma, ktoś kliknął
    // „Chcę wystawiać oferty". Same flagi, żadnych poświadczeń.
    brakOfert = false, aplikacjaMaOferty = false, chceOfert = false,
  } = wejscie;

  const nazwa = kanal ? `Kanał ${kanal}` : 'Kanał Allegro';

  // ⚠️ ZAPISANY BLAD WYSTARCZA — TERMIN NIE RATUJE. Zdarza sie, ze `refresh_wygasa_at`
  // pokazuje jeszcze dziesiatki dni, a kanal od godzin nie odpowiada: `invalid_grant` znaczy,
  // ze token ZOSTAL ZUZYTY (jest jednorazowy), a nie ze wygasl. Regula czytajaca sam termin
  // uznalaby ten kanal za zdrowy.
  const zepsuty = Boolean(String(ostatniBlad ?? '').trim());
  const pilne = !polaczony || zepsuty;

  if (pilne) {
    return {
      kanal,
      zyje: false,
      pilne: true,
      uprzedzenie: false,
      // Tam, gdzie panel ostrzega, MUSI byc wyjscie — i to jest cale uzasadnienie tego pola.
      wolnoWiazac: true,
      zostaloDni,
      refreshWygasaAt,
      kontoAllegro,
      powod: polaczony
        ? `${nazwa} ${SKUTKI}. Połączenie z Allegro wygasło i panel sam z tego nie wyjdzie.`
        : `${nazwa} nie jest połączony z Allegro, więc ${SKUTKI}.`,
    };
  }

  // ⚠️⚠️ KANAL NA CUDZYM KONCIE — AWARIA DANYCH, NIE UPRZEDZENIE. Sprawdzane PRZED terminem
  // i przed uprawnieniami, bo tamte dwa moga poczekac, a ten kanal W TEJ CHWILI sciaga cudze
  // zamowienia pod swoja nazwa: dubluje zamowienia i platnosci (przychod liczony dwa razy)
  // i przestawia kursor pollera, przez co prawdziwe zamowienia zostaja po cichu pominiete.
  //
  // ⚠️ TU LEZY POWOD, DLA KTOREGO W TYM STANIE MUSI BYC PRZYCISK. Kanal na cudzym koncie
  // przechodzi przez pozostale sita jako zdrowy — polaczony, bez bledu, komplet zakresow,
  // dluga waznosc — wiec panel UKRYWALBY wiazanie dokladnie wtedy, gdy jest jedyna naprawa,
  // a czlowiek musialby szukac jej poza panelem.
  if (kolizjaKonta) {
    return {
      kanal,
      zyje: false,
      pilne: true,
      uprzedzenie: false,
      wolnoWiazac: true,
      brakujaceUprawnienia,
      zostaloDni,
      refreshWygasaAt,
      kontoAllegro,
      // ⚠️ NUMER KONTA W TRESCI. Bez niego czlowiek nie ma jak rozstrzygnac, ktore z dwoch
      // wiazan poszlo nie tam — a panel tego nie wie i wskazuje OBA kanaly.
      // ⚠️ „WYLOGUJ SIE" TO NIE UPRZEJMOSC, TYLKO KROK NAPRAWY. Device flow wiaze kanal
      // z kontem ZALOGOWANYM W PRZEGLADARCE; klikniecie bez wylogowania powtarza dokladnie
      // ten sam blad, i tak wlasnie ta pomylka powstala.
      powod: `${nazwa} jest powiązany z kontem Allegro ${kontoAllegro ?? '(nieznanym)'}, `
        + 'a na tym samym koncie wisi już inny kanał — dwa kanały to mają być dwa konta. '
        + 'Dopóki tak jest, panel ściąga CUDZE zamówienia pod tą nazwą: dubluje je razem '
        + 'z płatnościami i przesuwa kursor, przez co prawdziwe zamówienia zostają pominięte. '
        + 'Zanim przewiążesz: wyloguj się z Allegro w przeglądarce, bo inaczej powiążesz go '
        + 'z tym samym kontem jeszcze raz.',
    };
  }

  const uprzedzenie = zostaloDni != null && zostaloDni <= DNI_UPRZEDZENIA;
  // ⚠️⚠️ NIEKOMPLETNE UPRAWNIENIA OTWIERAJA WIAZANIE, i to jest ZAWEZENIE bariery,
  // nie jej zdjecie. Kanal moze dzialac znakomicie przy zamowieniach i jednoczesnie nie
  // miec zakresu do Centrum wiadomosci: token niesie zakresy Z CHWILI AUTORYZACJI,
  // a odswiezenie ich NIE DOPISUJE. Bez tego warunku jedyna droga do nowego uprawnienia
  // wiodlaby przez zepsucie kanalu albo przez czekanie do terminu waznosci.
  const niekompletny = Array.isArray(brakujaceUprawnienia) && brakujaceUprawnienia.length > 0;
  // ⚠️⚠️ ZGODA NA OFERTY OTWIERA WIĄZANIE TYLKO NA ŻĄDANIE. Wszystkie trzy warunki:
  // token wiadomo że bez zakresów ofert, aplikacja je ma (inaczej nowa zgoda niczego nie
  // doda, a zużyje działającą parę), i człowiek kliknął „Chcę wystawiać oferty". Samo
  // „aplikacja może" nie wystarcza — zdrowe konto nie zaprasza do przewiązania.
  const zgodaOfertOtwarta = Boolean(brakOfert && aplikacjaMaOferty && chceOfert);

  return {
    kanal,
    // ⚠️ ZBLIZAJACY SIE TERMIN TO NIE AWARIA. Kanal dziala; pas w kolorze bledu klamalby
    // o tym, co sie dzieje, a ostrzezenie widziane codziennie przestaje byc ostrzezeniem.
    zyje: true,
    pilne: false,
    uprzedzenie,
    // ⚠️ PRZY KANALE ZDROWYM WIAZAC NIE WOLNO — i to jest BARIERA, nie kosmetyka. Ponowne
    // wiazanie NADPISUJE dzialajaca pare i uniewaznia ja po stronie Allegro; cofnac sie
    // z tego nie da. Przycisk stojacy obok innych przyciskow zaprasza do klikniecia
    // „na wszelki wypadek" i zabija dzialajacy kanal. Dlatego „Połącz z Allegro" nie jest
    // zwyklym przyciskiem: pojawia sie tylko w stanach z listy nizej.
    wolnoWiazac: uprzedzenie || niekompletny || zgodaOfertOtwarta,
    zgodaOfertOtwarta,
    brakujaceUprawnienia,
    zostaloDni,
    refreshWygasaAt,
    kontoAllegro,
    // ⚠️ POWÓD MUSI NIEŚĆ NAZWY BRAKUJĄCYCH ZAKRESÓW. Bez nich człowiek widzi „przewiąż"
    // i nie wie, czego brakuje ani co wcześniej dodać w aplikacji Allegro — a przewiązanie
    // przed dodaniem uprawnienia NICZEGO nie naprawi, za to zużyje działającą parę tokenów.
    // Kolejność: termin ma pierwszeństwo, bo to on kończy się nieodwracalnie.
    powod: uprzedzenie
      ? `${nazwa}: połączenie z Allegro wygasa ${String(refreshWygasaAt ?? '').slice(0, 10)}`
        + `${zostaloDni != null ? ` (za ${zostaloDni} dni)` : ''} — po tym terminie przestanie działać.`
      : (niekompletny
        ? `${nazwa} działa, ale token nie ma uprawnień: ${brakujaceUprawnienia.join(', ')}. `
          + 'Odświeżenie tokenu ich NIE doda — najpierw nadaj je w aplikacji na '
          + 'apps.developer.allegro.pl, potem przewiąż kanał.'
        : (zgodaOfertOtwarta ? `${nazwa}: konto działa — ponowna zgoda doda wystawianie ofert.` : null)),
  };
}

/**
 * Ocena WSZYSTKICH kanalow naraz — jedyne miejsce, w ktorym powstaje `kolizjaKonta`.
 *
 * ⚠️⚠️ FUNKCJA ISTNIEJE PO TO, ZEBY EKRAN I USLUGA LICZYLY TO SAMO. `stanKanalu()` ocenia
 * JEDEN kanal, a kolizja kont jest widoczna dopiero przy spojrzeniu na wszystkie. Gdyby
 * ekran liczyl ja u siebie, a usluga wiazania u siebie, pierwsza rozbieznosc
 * dalaby PRZYCISK PROWADZACY PROSTO W ODMOWE: kanal pokazany jako do przewiazania, a POST
 * odrzucony przez bariere „kanal dziala". Przed tym ostrzega naglowek tego pliku.
 *
 * Wejscie to lista `stanDlaEkranu()` — bialych list pol bez poswiadczen (reguła: sekrety nie wychodzą).
 */
export function stanyKanalowZKolizjami(stanyDlaEkranu) {
  const lista = stanyDlaEkranu ?? [];
  const sklejone = new Set(kolizjeKont(lista));
  return lista.map((s) => stanKanalu({ ...s, kolizjaKonta: sklejone.has(s?.kanal) }));
}

/**
 * Kanaly, o ktorych panel MA POWIEDZIEC — w kolejnosci pilnosci.
 *
 * ⚠️ TA FUNKCJA ISTNIEJE, BO FILTR W TRASIE BYL NIETESTOWALNY. Test sprawdzajacy
 * ksztalt wyrazenia w zrodle nie wykryje, ze przy dwoch zepsutych kanalach drugi jest
 * niewidoczny — czyli dokladnie tej wady, ktora ten pas ma naprawic (`poller.stan()`
 * oddaje PIERWSZEGO pollera z bledem). Filtr jest osobna funkcja, zeby testowac jego WYNIK.
 *
 * ⚠️ AWARIE PRZED UPRZEDZENIAMI. Kanal martwy i kanal wygasajacy za tydzien to dwie rozne
 * pilnosci; kolejnosc na ekranie jest tu trescia, nie estetyka.
 */
export function kanalyWymagajaceUwagi(stany) {
  return (stany ?? [])
    .filter((s) => s?.pilne || s?.uprzedzenie)
    .sort((a, b) => Number(b.pilne) - Number(a.pilne));
}
