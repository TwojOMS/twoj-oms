import { czyPoraPobrania } from '../../../domena/pora-pobrania.js';
import { odKursora, podzielNaOkna, nastepnyKrok } from '../../../domena/okna-pobrania.js';
import { naWiersz } from '../../../domena/koszt-metadane.js';
import {
  zapiszKoszt, wczytajKursor, zapiszKursor, odnotujUdanyPrzebieg, zapiszBladPobrania,
  zapiszOdrzuconyKoszt, usunOdrzucony, liczbaOdrzuconych, kosztyBezArchiwum,
} from '../../../oms/db/koszty.js';
import { zarchiwizuj } from './archiwum-kosztow.js';
// ⚠️ TYLKO STALE CZASOWE — do policzenia najgorszego przebiegu (nizej). Klient KSeF jedzie do
// czuwacza WSTRZYKNIETY (`klient`), a nie budowany tutaj: inaczej testy tego modulu musialyby
// dotknac sieci, a druga instancja klienta oznaczalaby drugie pelne logowanie.
import { LIMIT_ZADANIA_MS, NAJDLUZSZE_ODPYTYWANIE_MS } from '../../../oms/ksef/client.js';

// ⚠️⚠️ TO NIE JEST `services/czuwacz-ksef.js`. TAMTEN pyta inFakt, czy NASZA faktura sprzedazowa
// dostala numer KSeF (zeby wyslac ja do Allegro). TEN pobiera z KSeF faktury, na ktorych to MY
// jestesmy nabywca. Dwa czuwacze, dwa zrodla, dwa kierunki — nazwy musza je rozdzielac.
//
// ⚠️ TEN MODUL WYLACZNIE CZYTA. Nie ma tu zadnej sciezki, ktora cokolwiek wysyla do KSeF.
//
// ⚠️ PORA: RAZ NA DOBE, o 3 w nocy czasu Warszawy — na prosbe wlasciciela. Zegar tyka co
// godzine (bootstrap.js), a o porze decyduje `czyPoraPobrania`, czyli JEDYNE miejsce w tym
// module znajace strefe. Przycisk „Odswiez teraz" jedzie tym samym przebiegiem z `wymuszony`.
//
// ⚠️ CZAS PRZEBIEGU. Samo pelne logowanie do KSeF potrafi w najgorszym razie trwac ~31 minut
// (30 pytan o stan po 60 s limitu kazde, ksef/client.js), a przebieg dziedziczy ten czas
// i doklada do niego strony. Przebieg dluzszy niz godzina zabiera wiec kolejne tykniecie —
// i dlatego pominiecie „poprzedni przebieg jeszcze trwa" MUSI zostawic slad w logu
// (bootstrap.js), inaczej doba bez kosztow wyglada dokladnie tak, jak doba bez zakupow.
export const SUFIT_STRON = 200;

// ⚠️ POWODY POMINIECIA SA STALYMI, A NIE NAPISAMI U WOLAJACEGO — bo bootstrap loguje TYLKO
// JEDEN z nich. „Nie ta pora" zdarza sie 23 razy na dobe i jest stanem poprawnym; wpis o nim
// przy kazdym tyknieciu utopilby prawdziwa awarie (log rosnie od ZDARZEN, nie od PRZEBIEGOW).
// Porownanie po tresci zdania rozjechaloby sie przy pierwszej poprawce stylistycznej.
export const POWOD_TRWA = 'poprzedni przebieg jeszcze trwa';
export const POWOD_NIE_TA_PORA = 'nie ta pora';

// Dwa powody, dla ktorych okno konczy sie PRZEDWCZESNIE — czyli bez zdania KSeF-u „to juz
// koniec". Oba zatrzymuja caly przebieg (patrz petla nizej), ale mowia operatorowi co innego,
// wiec sa stalymi, a nie napisami w dwoch miejscach.
const SUFIT = 'sufit stron';
const NIEPEWNY_KONIEC = 'niepewny koniec okna';

// ⚠️⚠️ BUDZET CZASU NA ARCHIWUM XML, A NIE SUFIT SZTUK — i to jest decyzja, nie wygoda.
//
// Archiwizacja doklada JEDNO ZADANIE HTTP NA DOKUMENT. Przy backfillu od stycznia to setki
// zadan w jednym przebiegu, a przebieg dziedziczy juz najgorszy przypadek logowania do KSeF
// (~31 min, ksef/client.js) i chodzi na zegarze godzinowym: przekroczenie godziny GUBI kolejne
// tykniecie (bootstrap.js), a okno pobrania kosztow jest raz na dobe.
//
// Sufit sztuk nie ogranicza CZASU: sto dokumentow po jednym zadaniu kazde brzmi tanio, ale
// przy KSeF-ie odpowiadajacym wolno kazde z nich idzie do limitu klienta — czyli granica na
// sztukach nie mowi nic o tym, ile przebieg potrwa. Ta sama lekcja, co przy wystawianiu faktur
// hurtem (services/faktura-hurtem.js): budzet czasu zamiast sufitu liczby dokumentow.
//
// Zaleglosc NIE PRZEPADA — kolejka archiwum jest STANEM TABELY (`kosztyBezArchiwum`, kolumna
// `sciezka_xml`), wiec reszta wraca sama nastepnej nocy. Archiwum jest dodatkiem do lustra
// w bazie, wiec „dociagnie sie przez kilka nocy" jest tu cena calkowicie akceptowalna.
export const BUDZET_ARCHIWUM_MS = 10 * 60 * 1000;

// ⚠️⚠️ NAJGORSZY MOZLIWY CZAS JEDNEGO PRZEBIEGU — LICZONY, A NIE OPISANY W KOMENTARZU
// (recenzja calej galezi, W4). `bootstrap.js` odmawia startu panelu, gdy ta liczba nie miesci
// sie w oknie pobrania, wiec podniesienie ktorejkolwiek ze skladowych bez policzenia skutku ma
// POLOZYC PANEL PRZY STARCIE, a nie po cichu rozjechac zegar na produkcji. Ta sama regula, co
// przy `NAJDLUZSZY_PRZEBIEG_MS` w services/czuwacz-ksef.js.
//
// Trzy skladniki, kazdy z modulu, ktory go naprawde narzuca:
//   • PELNE LOGOWANIE do KSeF — do 30 pytan o stan operacji, kazde z wlasnym limitem 60 s
//     (`NAJDLUZSZE_ODPYTYWANIE_MS`, ksef/client.js): ~31 minut;
//   • STRONY METADANYCH — sufit stron razy limit jednego zadania: 200 × 60 s = 200 minut;
//   • ARCHIWUM XML — budzet czasu plus JEDNO zadanie, ktore zdazylo wystartowac tuz przed
//     jego wyczerpaniem (budzet sprawdza sie PRZED pobraniem, nie w jego trakcie).
//
// ⚠️ CZEKANIE PO 429 NIE PSUJE TEJ GRANICY — i to jest sprawdzone, a nie zalozone. Ponowienie
// po odmowie z limitu (ksef/limit.js, wolane w services/archiwum-kosztow.js) potrafi uspic
// przebieg na kilka minut, ale ma DRUGA bramke budzetu, tym razem WEWNATRZ iteracji: spanie
// nastepuje tylko wtedy, gdy `teraz() + czekanie <= koniecBudzetu`, a inaczej odmowa wraca
// z `powod: 'limit'` i konczy archiwizacje. Czekanie miesci sie wiec zawsze w BUDZECIE, a nie
// obok niego — dlatego suma nizej dalej brzmi „budzet archiwum + jedno zadanie" i podniesienie
// `MAKS_CZEKANIE_S` w ksef/limit.js NIE wymaga poprawki tej liczby.
//
// ⚠️ MIARA TO OKNO POBRANIA (raz na dobe), A NIE ODSTEP ZEGARA (godzina) — i to jest
// rozstrzygniecie, nie niedbalosc. Czuwacz KSeF pracuje przy KAZDYM tyknieciu, wiec przebieg
// dluzszy niz odstep zabiera mu prace. Ten pracuje w JEDNYM oknie na dobe (`czyPoraPobrania`),
// wiec tykniecia zjedzone przez dlugi przebieg i tak oddalyby „nie ta pora" — nie ginie nic.
// Ginie dopiero przy przebiegu dluzszym niz DOBA: on zabiera nastepne okno pobrania, czyli
// cala dobe kosztow. Porownanie z godzina byloby warunkiem nie do spelnienia (sam sufit stron
// to ponad trzy godziny) i musialoby zostac „naprawione" wylaczeniem straznika.
export const NAJDLUZSZY_PRZEBIEG_KOSZTOW_MS = NAJDLUZSZE_ODPYTYWANIE_MS
  + SUFIT_STRON * LIMIT_ZADANIA_MS
  + BUDZET_ARCHIWUM_MS + LIMIT_ZADANIA_MS;

// ⚠️ HAMULEC NA MARTWE ZRODLO. KSeF nieosiagalny znaczy, ze KAZDY dokument odbije sie tak samo
// — bez tego licznika przebieg waliby w martwe API tyle razy, ile jest niezarchiwizowanych
// dokumentow (przy backfillu: setki), kazde zadanie do limitu czasu klienta. Licznik liczy
// bledy Z RZEDU i zeruje sie po kazdym udanym pliku, bo pojedynczy dokument, ktorego KSeF nie
// oddaje, nie ma prawa zablokowac calej kolejki na zawsze.
export const LIMIT_KOLEJNYCH_BLEDOW_ARCHIWUM = 3;

// Pozniejsza z dwoch dat trwalego zapisu — czyli ta, ktora wolno postawic jako kursor.
// ⚠️ MAKSIMUM, A NIE „ostatnia widziana". Kursor to obietnica „wszystko do tej daty juz
// przeczytalismy", wiec cofniecie go o jeden dokument znaczy dokument przeczytany dwa razy
// (niegrozne, `INSERT OR IGNORE`), a przesuniecie go za daleko — dokument NIE przeczytany
// nigdy. Porownujemy przez `Date`, a nie napisami: `permanentStorageDate` przychodzi z KSeF
// i nikt nam nie obiecal, ze zawsze bedzie w tej samej postaci ISO z „Z" na koncu.
// Data nieczytelna (`NaN`) przegrywa kazde porownanie, wiec kursora nie ruszy.
function pozniejsza(a, b) {
  if (!b) return a;
  if (!a) return b;
  return new Date(b).getTime() > new Date(a).getTime() ? b : a;
}

export function createCzuwaczKosztow({
  db, klient, sesja, teraz = () => new Date(),
  // ⚠️ SCIEZKA BAZOWA ARCHIWUM XML (`KSEF_ARCHIWUM`, config.js) — OPCJONALNA I TAKA MA ZOSTAC.
  // Brak sciezki znaczy „nie archiwizujemy" i NIC WIECEJ: koszty pobieraja sie dokladnie jak
  // dotad, bo plik na NAS-ie jest dodatkiem do lustra w bazie, a nie odwrotnie.
  katalogArchiwum = null,
  // Wstrzykiwalne wylacznie dla testow — ta sama zasada, co przy `log` w wysylka-ksef.js.
  archiwizuj = zarchiwizuj,
  // ⚠️ CZEKANIE PO ODMOWIE Z LIMITU KSeF (ksef/limit.js) — wstrzykiwalne WYLACZNIE po to, zeby
  // testy nie spaly po 55 s na prawdziwym zegarze. W produkcji jedzie zwykly `setTimeout`.
  spij = (ms) => new Promise((r) => { setTimeout(r, ms); }),
  log = console.error,
}) {
  // ⚠️ JEDEN PRZEBIEG NARAZ — ten sam straznik, co w pollerze i w czuwaczu KSeF. Zegar tyka
  // niezaleznie od tego, czy poprzedni przebieg sie skonczyl, a tutaj przebieg potrafi trwac
  // dziesiatki minut (patrz `SUFIT_STRON` wyzej). Bez blokady przycisk „Odswiez teraz"
  // wcisniety w trakcie nocnego pobrania dawalby DWA rownolegle przebiegi na tym samym
  // kursorze. Zwalniana w `finally`: blokada zostawiona po bledzie wyciszylaby czuwacza
  // na zawsze, bez ani jednego sladu.
  let trwa = false;

  /**
   * ⚠️⚠️ JEDEN TRUJACY DOKUMENT NIE MA PRAWA ANI ZATRZYMAC POBIERANIA, ANI ZNIKNAC PO CICHU.
   *
   * Zderzaja sie tu dwie reguly, obie sluszne i obu nie wolno ruszyc:
   *   • `naWiersz` i `zapiszKoszt` RZUCAJA (brak kwoty, odrzucenie wiersza przez baze) — bo
   *     ciche zero w kosztach zanizyloby sume miesiaca podana z pelnym przekonaniem;
   *   • blad przebiegu NIE RUSZA KURSORA — bo dziura w lustrze to ta sama zanizona suma.
   * Razem znacza, ze JEDEN dokument bez kwoty zatrzymuje czuwacza w tym samym oknie w kolko,
   * co noc, bez drogi obok. Tresc dokumentu jest po stronie kontrahenta — nie mamy jak jej
   * poprawic, wiec „poczekamy, az samo przejdzie" nie jest tu planem.
   *
   * ROZSTRZYGNIECIE: odmowa DOTYCZACA DOKUMENTU jest faktem o TYM DOKUMENCIE, a nie awaria
   * przebiegu. Dokument idzie do KWARANTANNY (`koszty_odrzucone`) razem z CALYMI surowymi
   * metadanymi, przebieg liczy go w `odrzuconych` i idzie dalej, a kursor jedzie do przodu.
   *
   * DLACZEGO NIE PO CICHU: wiersz w kwarantannie jest TRWALY i nazywa dokument z numeru KSeF,
   * a `stanKosztow` dostaje na tej samej nocy `ostatni_blad` z ta liczba. Dokument nie wchodzi
   * do sumy miesiaca — i nie ma prawa wejsc, bo jego kwoty NIE ZNAMY; zestawienie z KSeF bedzie
   * wieksze niz suma w panelu i widac dokladnie, o ktory dokument.
   *
   * DLACZEGO NIE ZATRZYMANIE (rozwazona i odrzucona alternatywa: kursor zatrzymany tuz przed
   * trujacym dokumentem): przebieg zostawalby wtedy NA STALE w stanie „ostatni blad", a okno
   * do ponownego przeczytania roslo by z kazdym dniem. Gorsze jest jednak co innego — trwale
   * czerwony pasek na zakladce przestaje cokolwiek znaczyc i przykrywa NASTEPNA, prawdziwa
   * awarie pobierania (dokladnie ta lekcja stoi przy `zapiszBladPobrania` w db/koszty.js).
   *
   * DLACZEGO SUROWE METADANE: kursor przejechal obok, wiec KSeF nie pokaze juz tego dokumentu
   * w zadnym oknie przyrostowym. Bez kopii naprawa (poprawka mapowania, korekta od sprzedawcy)
   * wymagalaby recznego cofania kursora na cale miesiace.
   *
   * ⚠️ KWARANTANNA JEST WYLACZNIE DLA ODMOWY OPISANEJ DLA CZLOWIEKA (`dlaOperatora`, czyli
   * `naWiersz` i `zapiszKoszt`). Blad TECHNICZNY — padnieta baza, brak tabeli, zerwany dysk —
   * leci dalej i przerywa przebieg. Inaczej awaria dysku przejechalaby po calym oknie
   * „odrzucajac" po kolei kazdy poprawny dokument, a kursor pojechalby za nia.
   *
   * ⚠️⚠️ ZAKAZ NA PRZYSZLOSC: TU NIE WOLNO WOLAC KLIENTA KSeF. ANI TERAZ, ANI POZNIEJ.
   *
   * Cale rozpoznanie „to odmowa dotyczaca dokumentu" opiera sie na jednym znaczniku:
   * `dlaOperatora`. A klient KSeF (ksef/client.js) taguje nim KAZDY swoj blad — takze
   * HTTP 500, takze „KSeF nieosiagalny", takze limit czasu. Ten znacznik mowi wylacznie
   * „to zdanie nadaje sie do pokazania czlowiekowi", a NIE „to jest wina tego dokumentu".
   *
   * Dzis to nie boli, bo w tej petli nie ma ani jednego wywolania sieciowego: leca tu
   * WYLACZNIE `naWiersz` (czysta domena) i `zapiszKoszt` (baza). Ale pierwsze dolozenie
   * tutaj czegokolwiek, co pyta KSeF — dociagniecia XML-a, sprawdzenia zalacznika,
   * czegokolwiek — zamieni AWARIE KSeF w ciche wrzucenie CALEGO OKNA do kwarantanny,
   * dokument po dokumencie, z kursorem jadacym spokojnie za nia. Jedna czkawka MF i cale
   * okno kosztow wypada z sumy miesiaca, bez ani jednego bledu przebiegu.
   *
   * Jesli kiedys naprawde trzeba tu bedzie zapytac KSeF, to NAJPIERW musi powstac odroznienie
   * „odmowa dotyczaca DOKUMENTU" od „awaria ZRODLA" (osobny znacznik na bledach klienta,
   * nie `dlaOperatora`), a dopiero potem wywolanie. Nie odwrotnie.
   */
  function zapiszAlboOdloz(metadane) {
    try {
      const wiersz = naWiersz(metadane);
      const nowy = zapiszKoszt(db, wiersz);
      // ⚠️ UDANY ZAPIS WYPUSZCZA DOKUMENT Z KWARANTANNY (recenzja, W4). Takze przy `nowy ===
      // false`: „juz byl" znaczy, ze dokument LEZY w `koszty`, a wtedy wiersz kwarantanny
      // klamalby, ze brakuje go w sumie miesiaca — i klamalby TRWALE, bo okna pobrania
      // zachodza na siebie i to jest normalny przebieg, a nie przypadek skrajny.
      usunOdrzucony(db, wiersz.ksefNumber);
      return { nowy, data: wiersz.dataTrwalegoZapisu };
    } catch (e) {
      if (!e?.dlaOperatora) throw e;
      zapiszOdrzuconyKoszt(db, metadane, e.message);
      // Kursor przesuwa sie takze po dokumencie ODLOZONYM — jest przetworzony (lezy
      // w kwarantannie), a nie zgubiony. Gdy KSeF nie podal nawet daty trwalego zapisu,
      // nie ma czym przesunac: `null` zostawia kursor na poprzednim dokumencie i ten wroci
      // w nastepnym przebiegu, gdzie `ON CONFLICT` po prostu odswiezy `ostatnia_proba_at`.
      return { odrzucony: true, data: metadane?.permanentStorageDate ?? null };
    }
  }

  /**
   * ⚠️⚠️ ARCHIWUM ORYGINALNYCH XML-i (services/archiwum-kosztow.js) — POZA PETLA POBIERANIA,
   * I TO JEST WARUNEK POPRAWNOSCI, A NIE UKLAD KODU.
   *
   * Przeczytaj naglowek `zapiszAlboOdloz` wyzej, zanim to ruszysz. Tamta petla rozpoznaje
   * „odmowa dotyczaca DOKUMENTU" po jednym znaczniku — `dlaOperatora` — a klient KSeF taguje
   * nim KAZDY swoj blad, takze HTTP 500, takze „KSeF nieosiagalny", takze limit czasu.
   * Dociagniecie XML-a WEWNATRZ tamtej petli zamienialoby wiec zwykla czkawke MF w ciche
   * wrzucenie CALEGO okna do kwarantanny, dokument po dokumencie, z kursorem jadacym spokojnie
   * za nia: caly miesiac kosztow wypada z sumy, bez ani jednego bledu przebiegu. Dlatego
   * archiwizacja jedzie DOPIERO po zamknieciu wszystkich okien i po `zapiszKursor` — pilnuje
   * tego test „XML pobiera sie DOPIERO po zapisaniu kursora".
   *
   * ⚠️⚠️ NIC STAD NIE MA PRAWA WYLECIEC W GORE. Wyjatek przepuszczony dalej trafilby do
   * `catch` przebiegu, czyli dopisalby awarie NAS-a do `ostatni_blad` (kasujac slad
   * o kwarantannie zapisany chwile wczesniej) i odrzucil obietnice przebiegu. Baza ma juz
   * KOMPLET danych o tych dokumentach; plik jest dodatkiem. Kursor zostaje tam, gdzie stanal.
   *
   * ⚠️ KOLEJKA TO STAN TABELY, nie lista „nowych z tego przebiegu" (`kosztyBezArchiwum`).
   * Dzieki temu dokument, ktorego nie udalo sie pobrac albo zapisac, wraca sam nastepnej nocy,
   * a dokument juz zarchiwizowany nie jest sciagany drugi raz (bramka w `zarchiwizuj`).
   */
  async function zarchiwizujZalegle() {
    if (!katalogArchiwum) return 0;
    const koniecBudzetu = teraz().getTime() + BUDZET_ARCHIWUM_MS;
    let zrobionych = 0;
    let bledyZRzedu = 0;
    for (const wiersz of kosztyBezArchiwum(db)) {
      if (teraz().getTime() >= koniecBudzetu) {
        log('Archiwum kosztow: budzet czasu na archiwizacje wyczerpany — reszta dokumentow '
          + 'pojedzie nastepnym przebiegiem. Dane w bazie sa kompletne, brakuje tylko plikow.');
        break;
      }
      try {
        // ⚠️⚠️ ODMOWA Z LIMITU (HTTP 429) TO PRZERWA, A NIE AWARIA — i to jest jedyny powod,
        // dla ktorego pobranie XML-a jedzie przez `zCzekaniemNa429` (ksef/limit.js), a nie
        // wprost. Zmierzone na produkcji 2026-09-02: po 16 XML-ach w ~20 s KSeF odbijal kazde
        // kolejne zadanie, a licznik `bledyZRzedu` — pisany na MARTWE zrodlo — liczyl te odmowy
        // jak awarie i po trzech przerywal archiwizacje. Archiwum dociagalo wtedy 16 dokumentow
        // na dobe, czyli przy backfillu od stycznia: miesiace zamiast kilku nocy.
        //
        // ⚠️⚠️ PONOWIENIE SIEDZI W `zarchiwizuj`, A NIE TUTAJ, I TO JEST WARUNEK POPRAWNOSCI
        // (recenzja Task 16). Owiniecie CALEGO `archiwizuj` obejmowaloby takze `sesja
        // .accessToken()`, czyli PELNE logowanie do KSeF — a to wolno zrobic najwyzej RAZ
        // (`/auth/token/redeem` jest jednorazowy, ksef/sesja.js). 429 z sekwencji logowania
        // — a klient taguje `status: 429` KAZDA odmowe z limitu — kazalby wiec powtorzyc caly
        // ciag logowania do czterech razy, za kazdym razem odbijajac sie od zuzytego redeem.
        // Opcje limitu jada wiec do `zarchiwizuj`, ktore owija SAMO `pobierzXml`; blad
        // z `powod: 'limit'` leci stamtad tak samo jak dotad i lapie go `catch` nizej.
        //
        // ⚠️ MIEDZY POBRANIAMI NIE SPIMY „NA WSZELKI WYPADEK". Odstep wyliczony z limitu
        // (16/min = 3,75 s na dokument) spowalnialby KAZDY przebieg, takze ten z trzema
        // dokumentami, i opieralby sie na liczbie, ktorej MF nam nie obiecalo. Limit i tak
        // przychodzi jako 429, a przebieg ma budzet czasu — wiec czekamy dopiero, gdy KSeF
        // o to poprosi, i dokladnie tyle, ile poprosil.
        const wynik = await archiwizuj({
          db,
          klient,
          sesja,
          wiersz,
          katalogBazowy: katalogArchiwum,
          log,
          limit: { spij, teraz, doKiedy: koniecBudzetu, log },
        });
        if (wynik?.xml) { zrobionych += 1; bledyZRzedu = 0; continue; }
        // Nieudany ZAPIS na dysk (`zarchiwizuj` zjada go sam i tylko loguje) liczy sie do tego
        // samego licznika, co blad pobrania: padniety NAS odbije tak samo kazdy nastepny
        // dokument, a kazda taka proba kosztuje jedno POBRANIE z KSeF.
        bledyZRzedu += 1;
      } catch (e) {
        // ⚠️⚠️ LIMIT KSeF KONCZY ARCHIWIZACJE, ALE NIE JEST BLEDEM. `zCzekaniemNa429` (wolane
        // w `zarchiwizuj`) oddaje `powod: 'limit'` dopiero wtedy, gdy czekanie NIE MIESCI SIE
        // w budzecie przebiegu —
        // czyli stan jest dokladnie ten sam, co przy wyczerpanym budzecie czasu wyzej: dane
        // w bazie sa kompletne, brakuje tylko plikow, a kolejka archiwum jest stanem tabeli
        // (`sciezka_xml`), wiec reszta wraca sama nastepnej nocy.
        //
        // Dlatego ani `bledyZRzedu` (hamulec na MARTWE zrodlo — a to zrodlo zyje i wlasnie
        // powiedzialo, kiedy wrocic), ani `ostatni_blad` (czerwony pasek przez caly backfill
        // przestaje cokolwiek znaczyc i przykrywa NASTEPNA, prawdziwa awarie pobierania —
        // ta sama lekcja, co przy `zapiszBladPobrania` w db/koszty.js). Zostaje slad w logu.
        //
        // ⚠️ ROZPOZNANIE PO `powod`, A NIE PO TRESCI ZDANIA: komunikat 429 pisze MF i zmieni
        // sie bez uprzedzenia, a wtedy limit wrocilby po cichu do liczenia sie jako awaria.
        if (e?.powod === 'limit') {
          log(`Archiwum kosztow: KSeF odmowil na limicie zadan (${e.message}) — archiwizacja `
            + 'konczy sie na ten przebieg, a reszta dokumentow pojedzie nastepnej nocy. '
            + 'Dane w bazie sa kompletne, brakuje tylko plikow.');
          break;
        }
        bledyZRzedu += 1;
        log(`Archiwum kosztow: nie udalo sie pobrac XML-a dokumentu ${wiersz.ksef_number} `
          + `(${e.message}) — dokument JEST w kosztach i w sumie miesiaca, brakuje tylko pliku `
          + 'w archiwum. Panel sprobuje ponownie przy kolejnym przebiegu.');
      }
      if (bledyZRzedu >= LIMIT_KOLEJNYCH_BLEDOW_ARCHIWUM) {
        log(`Archiwum kosztow: ${bledyZRzedu} bledy z rzedu — archiwizacja przerwana na ten `
          + 'przebieg (zrodlo albo dysk sa niedostepne). Pobranie kosztow to NIE dotyka.');
        break;
      }
    }
    return zrobionych;
  }

  async function przebieg({ wymuszony = false } = {}) {
    if (trwa) return { pominiety: true, powod: POWOD_TRWA };
    if (!wymuszony && !czyPoraPobrania(teraz())) return { pominiety: true, powod: POWOD_NIE_TA_PORA };
    trwa = true;
    try {
      let nowych = 0; let przeczytanych = 0; let odrzuconych = 0;
      // ⚠️⚠️ KURSOR NIE JEST „OSTATNIA WIDZIANA DATA" — jest NAJDALSZA (recenzja, W2). Zmienna
      // niosaca date ostatniego rekordu MUSI byc per-okno (`ostatniaData` nizej, w ciele petli),
      // bo sluzy do PRZESUWANIA OKNA i jest jedyna przeslanka straznika `!ostatniaData`
      // w `nastepnyKrok`. Wspolna dla wszystkich okien przeciekala: pusta strona z `isTruncated`
      // w oknie N dostawala date z okna N-1, straznik nie zachodzil, a kolejne zapytanie szlo
      // z zakresem 149 dni przy TWARDYM limicie MF trzech miesiecy — czyli 400 z KSeF i przebieg
      // padajacy co noc w tym samym miejscu. Kursor dostaje wiec wlasna zmienna, na poziomie
      // calego przebiegu, i tylko ona jedzie do `zapiszKursor`.
      let najdalszaData = null;
      // ⚠️⚠️ PRZEDWCZESNY KONIEC OKNA KONCZY CALY PRZEBIEG, A NIE SAMO OKNO — i to jest poprawka
      // do pierwszej wersji tej petli, w ktorej wyczerpanie sufitu po cichu przechodzilo do
      // NASTEPNEGO okna. Skutek byl dokladnie taki, przed jakim broni cala reszta tego modulu:
      // dokumenty z ogona przerwanego okna nie zostawaly przeczytane NIGDY (kursor przeskakiwal
      // za nie razem z ostatnim oknem), a przebieg konczyl sie bez bledu. Dziura w kosztach,
      // czyli zanizona suma podana z pelnym przekonaniem.
      //
      // Zatrzymanie calego przebiegu jest za to bezpieczne: strony ida rosnaco po dacie
      // trwalego zapisu, wiec kursor na ostatnim przeczytanym dokumencie jest prawdziwy,
      // a nastepny przebieg podejmuje DOKLADNIE stad. Zaden dokument nie wypada, przebieg
      // po prostu trwa dwie noce zamiast jednej — i mowi o tym.
      //
      // ⚠️ WYJSCIA PRZEDWCZESNE SA DWA (recenzja, W3), i obydwa dostaja te sama obrone:
      //   • SUFIT STRON — okno nie zmiescilo sie w limicie;
      //   • NIEPEWNY KONIEC — KSeF oddal PELNA strone i NIE podal `hasMore`, a klient zszedl
      //     do bezpiecznego `false` (ksef/client.js, ksztalt niezmierzony na zywym API). Wtedy
      //     „koniec okna" jest NASZYM domyslem, a nie zdaniem KSeF-u, wiec nie wolno na nim
      //     oprzec przeskoku kursora nad ogonem okna. Strona NIEPELNA nastepnika miec nie
      //     moze, wiec zwyczajna noc bez nowych faktur nie zapala tu niczego — uzasadnienie
      //     w calosci przy `koniecNiepewny` w ksef/client.js.
      let niedokonczone = false;
      let powodPrzerwania = null;
      // ⚠️ JEDNA CHWILA NA CALY PRZEBIEG. Dwa osobne `teraz()` (raz na koniec okien, raz na
      // sprawdzenie kursora) potrafilyby sie rozjechac o tykniecie zegara i dac zakres, ktorego
      // nikt nigdy nie przeczyta.
      const chwila = teraz().toISOString();
      const kursor = wczytajKursor(db);
      // ⚠️ KURSOR Z PRZYSZLOSCI (recenzja, D1). Data pozniejsza niz biezaca chwila — skew zegara
      // kontenera albo `permanentStorageDate` z KSeF w innej strefie — dawala PUSTA liste okien:
      // czuwacz nie robil NIC, na zawsze, bez ani jednego bledu. `odKursora` czyta wtedy ostatni
      // odcinek zapasu (domain/okna-pobrania.js), wiec pobieranie idzie dalej i samo sie naprawia
      // — a operator dostaje o tym zdanie, bo cichy dziwny stan jest tu gorszy niz halas.
      const kursorZPrzyszlosci = Boolean(kursor) && new Date(kursor).getTime() > new Date(chwila).getTime();
      // ⚠️ OKNO ZACHODZI NA POPRZEDNIE (`odKursora` cofa sie o zapas) — i na tym stoi cala reszta
      // modulu: `INSERT OR IGNORE` w db/koszty.js, `usunOdrzucony` po udanym zapisie i bramka po
      // `sciezka_xml` w archiwum sa napisane pod ponowne spotkanie tych samych dokumentow.
      const okna = podzielNaOkna(odKursora(kursor, chwila), chwila);
      let oknaPrzetworzone = 0;
      for (const okno of okna) {
        oknaPrzetworzone += 1;
        let { from } = okno; let pageOffset = 0;
        // ⚠️ PER-OKNO, CELOWO. Patrz `najdalszaData` wyzej: ta zmienna prowadzi PRZESUWANIE
        // OKNA, wiec data z okna poprzedniego jest tu wartoscia bogusowa, a nie zapasowa.
        let ostatniaData = null;
        let niepewnyKoniec = false;
        let strona = 0;
        for (; strona < SUFIT_STRON; strona += 1) {
          // ⚠️ TOKEN NA KAZDA STRONE, NIE RAZ NA PRZEBIEG. Przebieg potrafi trwac godziny (samo
          // pelne logowanie do KSeF to w najgorszym razie ~31 min, patrz naglowek), a access
          // token ma swoja waznosc. `sesja.accessToken()` jest tani — czyta z bazy i wychodzi
          // do sieci dopiero przy wygasnieciu — wiec pobranie go raz na starcie kupowalo
          // dokladnie nic, a kosztowalo cala klase awarii „401 w polowie nocy".
          const accessToken = await sesja.accessToken();
          const {
            faktury, hasMore, isTruncated, koniecNiepewny,
          } = await klient.pobierzMetadane({
            accessToken, from, to: okno.to, pageOffset,
          });
          for (const m of faktury) {
            przeczytanych += 1;
            const wynik = zapiszAlboOdloz(m);
            if (wynik.nowy) nowych += 1;
            if (wynik.odrzucony) odrzuconych += 1;
            if (wynik.data) {
              ostatniaData = wynik.data;
              najdalszaData = pozniejsza(najdalszaData, wynik.data);
            }
          }
          // ⚠️ BLAD STAD LECI DALEJ I MA LECIEC. `nastepnyKrok` rzuca, gdy przy obcietym
          // wyniku brakuje daty ostatniego rekordu — wczesniej oddawal wtedy cicho pustke
          // i pobieranie konczylo sie DZIURA w danych. To nie jest odmowa dotyczaca jednego
          // dokumentu, tylko utrata pewnosci co do calego okna, wiec przebieg pada, kursor
          // zostaje, a slad idzie do `zapiszBladPobrania` nizej.
          const krok = nastepnyKrok({
            hasMore, isTruncated, pageOffset, ostatniaData,
          });
          if (krok.koniec) { niepewnyKoniec = koniecNiepewny === true; break; }
          if (krok.from) { from = krok.from; pageOffset = 0; } else { pageOffset = krok.pageOffset; }
        }
        // Petla wyszla po warunku, a nie przez `break` — czyli sufit zostal wyczerpany
        // i to okno NIE JEST doczytane do konca.
        if (strona === SUFIT_STRON) { niedokonczone = true; powodPrzerwania = SUFIT; break; }
        // Okno skonczylo sie na NASZYM domysle, a nie na zdaniu KSeF-u (patrz `koniecNiepewny`
        // w ksef/client.js) — wiec nie wolno na tym oprzec przeskoku nad ogonem okna.
        if (niepewnyKoniec) { niedokonczone = true; powodPrzerwania = NIEPEWNY_KONIEC; break; }
      }
      // ⚠️ KURSOR PRZESUWA SIE DOPIERO PO CALYM UDANYM PRZEBIEGU. Przesuwanie go po kazdej
      // stronie znaczyloby, ze awaria w polowie zostawia dziure w lustrze — a dziura w kosztach
      // to zanizona suma w raporcie, czyli bledna liczba podana z pelnym przekonaniem.
      // ⚠️ UDANY PRZEBIEG ODNOTOWUJE SIE ZAWSZE, TAKZE PUSTY (recenzja, W1). `zapiszKursor` byl
      // jedynym zapisem `ostatnie_udane_at`, wiec spokojna doba bez faktur kosztowych zostawiala
      // ekran ze zdaniem „nigdy sie nie udalo" i z awaria sprzed trzech tygodni wciaz zapalona.
      // Kursor zostaje tam, gdzie stal — nie ma czym go przesunac (uzasadnienie w db/koszty.js).
      if (najdalszaData) zapiszKursor(db, najdalszaData); else odnotujUdanyPrzebieg(db);
      // ⚠️ SLADY IDA PO `zapiszKursor`, A NIE PRZED — ta funkcja CZYSCI `ostatni_blad` (bo udany
      // przebieg gasi stara awarie). Odwrotna kolejnosc skasowalaby komunikat w tej samej
      // milisekundzie, w ktorej powstal. Wynik: pasek zakladki mowi jednoczesnie „pobrano teraz"
      // i „N dokumentow nie weszlo do sumy", i to jest prawda o obu tych rzeczach naraz.
      const uwagi = [];
      // ⚠️⚠️ STAN CALEJ TABELY, A NIE LICZNIK TEGO PRZEBIEGU (recenzja, W1). Licznik gasl po
      // PIERWSZEJ czystej nocy: `zapiszKursor` czysci `ostatni_blad`, a przebieg bez nowych
      // odrzucen nie mial czego dopisac — wiec po jednej dobie jedynym sladem po dokumencie
      // pominietym w sumie miesiaca zostawala tabela, ktorej nic nie czyta. To wywracalo cale
      // uzasadnienie wyboru kwarantanny („nic nie znika po cichu"). Kwarantanna jest stanem
      // TRWALYM i ma byc widoczna dopoki trwa — czyli az do `usunOdrzucony` po udanym zapisie.
      const wKwarantannie = liczbaOdrzuconych(db);
      if (wKwarantannie) uwagi.push(opisOdrzuconych(wKwarantannie));
      if (kursorZPrzyszlosci) {
        uwagi.push(`Kursor pobierania (${kursor}) był z przyszłości — zegar panelu albo daty `
          + 'z KSeF się rozjechały. Panel przeczytał ostatnie dni zamiast nie robić nic, ale '
          + 'sprawdź, czy suma miesiąca jest kompletna.');
      }
      if (powodPrzerwania === SUFIT) {
        uwagi.push(`Pobranie przerwane na limicie ${SUFIT_STRON} stron w jednym oknie — reszta `
          + 'pojedzie następnym przebiegiem, od miejsca, w którym stanął kursor. Żaden dokument '
          + 'nie przepadł, ale suma miesiąca może być jeszcze niepełna.');
      }
      if (powodPrzerwania === NIEPEWNY_KONIEC) {
        uwagi.push('Pobranie przerwane: KSeF oddał pełną stronę BEZ znacznika hasMore, więc panel '
          + 'nie wie, czy przeczytał okno do końca — i nie przeskoczył nad nim do okresów '
          + 'późniejszych. Reszta pojedzie następnym przebiegiem, od miejsca, w którym stanął '
          + 'kursor. Żaden dokument nie przepadł, ale suma miesiąca może być jeszcze niepełna.');
      }
      if (uwagi.length) zapiszBladPobrania(db, uwagi.join(' '));
      // ⚠️ NA SAMYM KONCU I POZA CALA PETLA POBIERANIA — uzasadnienie w naglowku
      // `zarchiwizujZalegle` wyzej (zakaz wolania klienta KSeF w petli kwarantanny) oraz
      // w `zarchiwizuj` (awaria NAS-a nie przerywa niczego). Kursor jest juz zapisany, wiec
      // cokolwiek stanie sie tutaj, przebieg pozostaje udany i dane w bazie sa kompletne.
      const zarchiwizowanych = await zarchiwizujZalegle();
      return {
        nowych,
        przeczytanych,
        odrzuconych,
        zarchiwizowanych,
        niedokonczone,
        // ⚠️ OKNA PRZETWORZONE, NIE ZAPLANOWANE (recenzja, D5). Przy `niedokonczone: true`
        // liczba zaplanowanych klamie — mowi, ile okien panel MIAL przeczytac, a czytelnik
        // bierze ja za „ile przeczytal". Obie liczby sa przydatne, wiec obie sa nazwane.
        okien: oknaPrzetworzone,
        okienZaplanowanych: okna.length,
      };
    } catch (e) {
      zapiszBladPobrania(db, e.message);
      throw e;
    } finally {
      trwa = false;
    }
  }

  // Zdanie dla czlowieka przy panelu. ⚠️ Z NUMERAMI DOKUMENTOW, bo samo „1 dokument odrzucony"
  // nie daje sie z niczym zestawic — a jedyne, co z tym stanem da sie zrobic, to otworzyc te
  // konkretne dokumenty w KSeF. Numery ida z bazy (`ostatnia_proba_at` malejaco), wiec na gorze
  // sa te z wlasnie zakonczonego przebiegu.
  //
  // ⚠️ ZDANIE MOWI O STANIE KWARANTANNY, NIE O TYM PRZEBIEGU (recenzja, W1) — i tak ma byc
  // napisane. Dokument odrzucony trzy noce temu wciaz nie wchodzi do sumy miesiaca, a przebieg,
  // ktory sam nic nie odrzucil, nie jest zadnym powodem, zeby o nim przestac mowic. Zdanie
  // gasnie dopiero razem z ostatnim wierszem kwarantanny (`usunOdrzucony` po udanym zapisie).
  function opisOdrzuconych(ile) {
    const numery = db.prepare(
      'SELECT ksef_number FROM koszty_odrzucone ORDER BY ostatnia_proba_at DESC LIMIT 5',
    ).all().map((w) => w.ksef_number);
    const reszta = ile > numery.length ? ` i ${ile - numery.length} więcej` : '';
    return `Pobrano koszty, ale ${ile} dokument(y) leżą odrzucone i NIE weszły do sumy miesiąca `
      + `(${numery.join(', ')}${reszta}). Panel nie zna ich kwot i nie zmyśli ich: sprawdź te `
      + 'dokumenty w KSeF.';
  }

  return { przebieg };
}
