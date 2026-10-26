// @ts-check
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pobierzZamowienie, dopiszLog } from '../../../oms/db/zamowienia.js';
import {
  rozpocznijPrzesylke, zakonczPrzesylke, oznaczBlad, oznaczDoWyjasnienia, zapiszBladSync,
  oznaczTworzonaUKuriera, pobierzPrzesylke, zapiszIdPrzesylkiKuriera,
} from '../db/przesylki.js';
import { wybierzKuriera } from '../../../oms/kurierzy/index.js';
import { bladOperatora } from '../../../domena/bledy.js';
import { bezpiecznaNazwa } from '../../../domena/pliki.js';
import { adresOdbiorcy } from '../../../domena/adres-odbiorcy.js';
import { powodBrakuGotowosciNadania } from '../../../domena/gotowosc-nadania.js';
// Kurier WSKAZANY przez czlowieka — potrzebny wylacznie zamowieniom z Allegro, ktorych
// metody panel nie umie nadac sam. Patrz domain/kurier-nadania.js.
import { metodaNadania } from '../../../domena/kurier-nadania.js';
import { stanPrzesylki } from '../../../domena/przesylka-stan.js';
// ⚠️ OSOBNY `import` OBOK RE-EKSPORTU NIZEJ I TO NIE JEST DUBLOWANIE. `export { X } from '...'`
// NIE wprowadza `X` do zasiegu modulu, a `createNadanie` uzywa tej stalej jako wartosci
// domyslnej parametru — bez tej linii plik wywalilby sie na `PACZKA_DOMYSLNA is not defined`
// dopiero przy wywolaniu, czyli przy pierwszym nadaniu.
import { PACZKA_DOMYSLNA } from '../../../domena/ustawienia-panelu.js';
import {
  dodajNotatkeZPowtorka, tekstNotatkiNadania, ponowNotatkeNadania, PREFIKS_NOTATKI,
} from './notatka-nadania.js';

// ⚠️ STAŁA PRZENIESIONA DO DOMENY 2026-08-17 (domain/ustawienia-panelu.js), bo od tego dnia
// jest FALLBACKIEM ustawienia, a nie jedynym źródłem wartości. Re-eksport zostaje, bo czyta ją
// stąd kilkanaście miejsc, w tym testy i scripts/demo-oms.js — przepisywanie wszystkich
// importów przy okazji tej zmiany byłoby zmianą bez związku ze sprawą (ta sama decyzja,
// co przy przeniesieniu `grosze`/`zl` do domain/kwoty.js).
//
// ⚠️ TO NADAL NIE SĄ WYMIARY KARTONU — uzasadnienie 110×75×1 stoi przy definicji w domenie.
// Tutaj wartość służy WYŁĄCZNIE jako punkt startowy dla wywołań spoza HTTP: trasy czytają
// paczkę z ustawień (routes/zamowienia.js) i przekazują ją jawnie.
export { PACZKA_DOMYSLNA } from '../../../domena/ustawienia-panelu.js';

/** @param {import('../nadanie-typy.ts').OpcjeNadania} opcje */
export function createNadanie({ db, kurierzy, klienci = {}, katalogEtykiet, paczkaDomyslna = PACZKA_DOMYSLNA, czekaj = undefined }) {
  // Katalog zakladamy przy BUDOWIE uslugi, czyli zanim ktokolwiek dotknie DPD.
  // Przy pierwszym uruchomieniu panelu tego katalogu po prostu nie ma, a odkrycie tego
  // dopiero po nadaniu paczki oznaczaloby przydzielony numer listu bez miejsca na etykiete.
  mkdirSync(katalogEtykiet, { recursive: true });

  /**
   * OGON UDANEGO NADANIA: pliki etykiet → zapis przesyłki → log → notatka w sklepie.
   *
   * Wydzielony w Zadaniu 6, bo od tej chwili prowadzą tu DWIE drogi: zwykłe nadanie
   * i przycisk „Sprawdź ponownie" (sprawdzPonownie niżej), który dobiera numer i etykiety
   * przesyłki JUŻ UTWORZONEJ u kuriera. Dwie kopie tego kodu rozjechałyby się przy
   * pierwszej zmianie — a to jest miejsce, w którym numer listu trafia do bazy.
   */
  /** @param {{z: import('../nadanie-typy.ts').ZamowienieNadania, przesylkaId: number, kurier: string, wynik: import('../../../core/kontrakty.ts').WynikNadania, adresUzytyJson: string | null}} dane */
  async function dokonczNadanie({ z, przesylkaId, kurier, wynik, adresUzytyJson }) {
    // Numer listu jest cenniejszy niz plik etykiety: nie przydzielimy go drugi raz.
    // Awaria zapisu pliku NIE MOZE wiec przerwac zapisu przesylki, bo
    // zostawialaby wiersz 'w_trakcie' bez numeru, na zawsze blokujacy indeks czesciowy
    // (jedynym wyjsciem bylby reczny UPDATE w SQLite).
    let sciezka = null;
    if (wynik.etykietaPdf) {
      try {
        sciezka = join(katalogEtykiet, `${bezpiecznaNazwa(z.numer)}-${bezpiecznaNazwa(wynik.numerListu)}.pdf`);
        writeFileSync(sciezka, wynik.etykietaPdf);
      } catch (przyczyna) {
        const e = /** @type {import('../nadanie-typy.ts').BladNadania} */ (przyczyna);
        sciezka = null;
        dopiszLog(db, z.id, { akcja: 'etykieta', wynik: `BŁĄD zapisu: ${e.message}` });
      }
    }

    // ZPL dla Zebry — dokladnie ten sam wzorzec odpornosci co PDF wyzej i z tego samego
    // powodu: numer listu jest juz przydzielony, wiec ANI awaria pobrania ZPL od DPD
    // (wynik.etykietaZpl === null, patrz kurierzy/dpd.js), ANI awaria zapisu pliku na dysk
    // nie moze zakleszczyc zamowienia. Pobranie ZPL PRZY NADANIU (a nie przy druku) znaczy,
    // ze powtorny wydruk z kolejki druku nie wymaga juz kolejnej rozmowy z DPD.
    let sciezkaZpl = null;
    if (wynik.etykietaZpl) {
      try {
        sciezkaZpl = join(katalogEtykiet, `${bezpiecznaNazwa(z.numer)}-${bezpiecznaNazwa(wynik.numerListu)}.zpl`);
        writeFileSync(sciezkaZpl, wynik.etykietaZpl);
      } catch (przyczyna) {
        const e = /** @type {import('../nadanie-typy.ts').BladNadania} */ (przyczyna);
        sciezkaZpl = null;
        dopiszLog(db, z.id, { akcja: 'etykieta-zpl', wynik: `BŁĄD zapisu: ${e.message}` });
      }
    } else if (kurier !== 'allegro_wza') {
      // DPD nie oddalo ZPL-a (siec, zly status, brak documentData — patrz zplBladOpis
      // w kurierzy/dpd.js). To FAKT do zapisania, nie awaria nadania: operator ma PDF
      // i widzi na karcie, ze druku na Zebrze nie bedzie, zamiast po cichu czekac
      // na przycisk „Drukuj", ktory nigdy sie nie pojawi.
      dopiszLog(db, z.id, { akcja: 'etykieta-zpl', wynik: `BRAK: ${wynik.zplBladOpis ?? 'DPD nie oddało etykiety ZPL.'}` });
    }

    zakonczPrzesylke(db, przesylkaId, {
      numerListu: wynik.numerListu, etykietaSciezka: sciezka, etykietaZplSciezka: sciezkaZpl, surowa: wynik.surowa,
      // Adres FAKTYCZNIE uzyty przy tym nadaniu — nie ten z zamowienia w sklepie, ktory
      // od tej chwili moze byc juz nieaktualny (operator go poprawil). Bez tego panel
      // przestalby wiedziec, dokad paczka NAPRAWDE pojechala (patrz komentarz przy
      // kolumnie przesylki.adres_uzyty w schema.sql).
      adresUzyty: adresUzytyJson,
    });
    dopiszLog(db, z.id, { akcja: 'nadanie', wynik: wynik.numerListu });

    // ⚠️ NADANIE NIE ZMIENIA STATUSU — ani w panelu, ani w sklepie. To ta sama decyzja
    // wlasciciela („po nadaniu paczki nie zmieniaj statusu"), tylko wreszcie wyrazona we
    // wlasciwym miejscu: etykieta powstaje przy PAKOWANIU, a paczka wyjezdza z kurierem
    // dzien pozniej. Statusem rzadzi fakt `wyslane_at`, ktory ustawia czlowiek, i DOPIERO
    // ON jedzie do sklepu jako 'completed' (services/sync-sklep.js).
    //
    // Historycznie stalo tu `woo.ustawStatus(..., 'completed')` i zostalo 30.07 usuniete
    // w odpowiedzi na te sama prosbe — wtedy blednie odczytana jako „nie zmieniaj statusu
    // W SKLEPIE". Odesylanie statusu wrocilo 31.07, ale juz z innego wyzwalacza; TUTAJ ma
    // go nie byc. Notatka z numerem listu zostaje: to osobna sprawa niz status.
    // ⚠️ ZAMOWIENIE RECZNE NIE ISTNIEJE W SKLEPIE. Jego `zrodlo_id` to WYLACZNIE pozycja
    // we wlasnej serii numeracji (R/RRRR/NNN, patrz db/zamowienia-reczne.js), a NIE
    // identyfikator zadnego zamowienia Woo — dokladnie ta sama pulapka, ktora Zadanie 2
    // zalatalo w domain/sync-sklep.js (statusDlaSklepu patrzy na POCHODZENIE, nie na
    // obecnosc `zrodlo_id`). Notatka wyslana pod ten numer trafialaby w przypadkowe cudze
    // zamowienie w Woo (albo w nic) i wracala jako blad synchronizacji, ktory nie opisuje
    // niczego prawdziwego — zamowienie wisialo na liscie „do zalatwienia" na zawsze.
    // Pominiecie MUSI byc widoczne w logu jako SWIADOMA decyzja, nie cichy `if`, zeby
    // odrozniala sie od awarii.
    if (z.sklep === 'reczne') {
      dopiszLog(db, z.id, {
        akcja: 'sync-woo',
        wynik: 'POMINIĘTO: zamówienie ręczne nie istnieje w sklepie — notatka nie ma dokąd pojechać.',
      });
    } else if (!klienci[z.sklep]) {
      // Sklep bez skonfigurowanych kluczy — notatka nie ma dokad pojechac. To NIE jest
      // awaria nadania: paczka juz jedzie, a brak notatki ma zostac widoczny w logu.
      dopiszLog(db, z.id, {
        akcja: 'sync-woo',
        wynik: `POMINIĘTO: brak konfiguracji sklepu „${z.sklep}" — notatka nie ma dokąd pojechać.`,
      });
    } else {
      // Paczka juz istnieje fizycznie, wiec awaria zapisu notatki NIE moze wycofac nadania —
      // numer listu i etykieta zostaja, notatke odsylamy „best effort".
      try {
        // PRZ-117: jedna powtórka po chwilowym błędzie sieci (services/notatka-nadania.js).
        await dodajNotatkeZPowtorka(klienci[z.sklep], z.zrodlo_id, tekstNotatkiNadania(kurier, wynik.numerListu), { czekaj });
        dopiszLog(db, z.id, { akcja: 'sync-woo', wynik: 'OK' });
      } catch (przyczyna) {
        const e = /** @type {import('../nadanie-typy.ts').BladNadania} */ (przyczyna);
        // Nieudana synchronizacja MUSI byc widoczna, nie tylko zalogowana: zaden widok nie
        // renderuje tabeli `log`, wiec bez tego zapisu przy przesylce operator nie ma jak
        // sie dowiedziec, ze notatka z numerem listu nie trafila do klienta.
        zapiszBladSync(db, przesylkaId, `${PREFIKS_NOTATKI}${e.message}`);
        dopiszLog(db, z.id, { akcja: 'sync-woo', wynik: `BŁĄD: notatka: ${e.message}` });
      }
    }

  }

  // `kolejnosc` to numer paczki, ktora wlasnie nadajemy — patrz rozpocznijPrzesylke.
  // Domyslne 1 znaczy „pierwsza paczka" i jest DAWNYM zachowaniem tej funkcji: bez jawnego
  // numeru kazde wywolanie celuje w to samo miejsce w indeksie, wiec drugie odbija sie
  // od bazy. Numeru NIE WOLNO tu wyliczac z bazy — wtedy dwa szybkie klikniecia dostalyby
  // numery 1 i 2 i obie paczki fizycznie by wyjechaly. Kto chce paczke nr 2, musi ja nazwac.
  // ⚠️ `punktOdbioru` (Zadanie 7): kod paczkomatu POPRAWIONY na ekranie nadania, jak
  // `adres` wyzej. Opcjonalny — wywolania spoza HTTP (testy, DPD) go nie podaja i wtedy
  // klient InPostu sam siega po `zamowienie.punkt_odbioru` (kurierzy/inpost.js). DPD ten
  // argument w ogole nie czyta, wiec przekazanie go zawsze jest bezpieczne.
  // ⚠️ `kwotaPobrania` (Z4): kwota pobrania POPRAWIONA na ekranie nadania — TA SAMA rodzina
  // co `adres` i `punktOdbioru`. Nadpisanie jest JEDNORAZOWE: leci do kuriera przy TYM
  // nadaniu i NIE ZAPISUJE SIE do zamowienia (ani do kolumny `kwota_pobrania`, ani do
  // `wysylka_reczna_json`) — trwala korekta ma swoje miejsce na karcie. Opcjonalne:
  // wywolania spoza formularza (nadanie zbiorcze, testy) go nie podaja i wtedy kwota
  // pochodzi z zamowienia, dokladnie jak dotad.
  // ⚠️ `kurierWybrany` (2026-08-07): kurier WSKAZANY PRZEZ CZLOWIEKA na ekranie nadania.
  // Ma znaczenie WYLACZNIE dla zamowien z Allegro — tam panel nie zna kuriera, bo paczke
  // z tego kanalu nadaje sie etykieta kupiona w panelu Allegro, a nasza umowa wchodzi
  // dopiero przy dosylce albo zamienniku. Dla wszystkich pozostalych zamowien wartosc jest
  // IGNOROWANA (domain/kurier-nadania.js) i nic sie dla nich nie zmienia.
  //
  // Wybor jest JEDNORAZOWY — dokladnie jak `punktOdbioru` i `kwotaPobrania` wyzej: leci
  // do kuriera przy TYM nadaniu i NIE zapisuje sie do zamowienia. Trwale przestawienie
  // metody ma swoje miejsce na karcie i jest CZYMS INNYM (klamaloby, ze klient wybral
  // nasze DPD, i wypisywalo zamowienie z siatek ochronnych kluczowanych metoda).
  // ⚠️ `pobranieNaTejPaczce` (04.09.2026): jawna decyzja operatora, ze pobranie ma pojechac
  // na TEJ paczce, nawet gdy jej numer jest wiekszy od 1. Domyslne `kolejnosc === 1` to
  // DOKLADNIE dawne zachowanie — wolajacy spoza formularza (nadanie zbiorcze, testy) niczego
  // nie zauwaza. Uzasadnienie i granice: komentarz przy warunku <cod> w kurierzy/dpd.js.
  /**
   * @param {number} zamowienieId
   * @param {import('../../../core/kontrakty.ts').PaczkaKuriera} [paczka]
   * @param {import('../nadanie-typy.ts').OpcjePaczkiNadania} [opcje]
   */
  async function nadaj(zamowienieId, paczka = paczkaDomyslna, {
    kolejnosc = 1, komentarz = null, adres, punktOdbioru, kwotaPobrania, kurierWybrany,
    pobranieNaTejPaczce = kolejnosc === 1, drukowac = false,
  } = {}) {
    /** @type {import('../nadanie-typy.ts').ZamowienieNadania | null} */
    const z = pobierzZamowienie(db, zamowienieId);
    if (!z) throw bladOperatora('Nie ma takiego zamówienia.');

    // ⚠️ Adres odbiorcy: TA linia jest cała ochrona przed edycją pozorną (patrz
    // kurierzy/dpd.js i domain/adres-formularza.js). `adres` normalnie przychodzi z
    // formularza ekranu nadania (POST /zamowienia/:id/nadaj — operator mógł go poprawić
    // przed zatwierdzeniem) i idzie do klienta kuriera WPROST, bez ponownego czytania
    // z zamówienia. Fallback na adresOdbiorcy(z) zostaje WYŁĄCZNIE dla wywołań spoza HTTP
    // (testy, przyszłe zadania wsadowe) — trasa POST zawsze przekazuje adres jawnie.
    // ⚠️ PRZY PACZKOMACIE DOCELEM JEST KOD PUNKTU, NIE ULICA ODBIORCY. Kolumna
    // `przesylki.adres_uzyty` istnieje po to, zeby panel umial odpowiedziec „dokad ta paczka
    // NAPRAWDE pojechala" — a przy paczkomacie odpowiedzia jest kod automatu. Operator moze
    // go poprawic na ekranie nadania (`punktOdbioru`), wiec bez dopisania go tutaj paczka
    // jechalaby do automatu X, a panel do konca zycia twierdzilby, ze do Y: adres odbiorcy
    // przy paczkomacie to jego adres DOMOWY, ktory z miejscem odbioru nie ma nic wspolnego.
    const punktUzyty = punktOdbioru ?? z.punkt_odbioru ?? null;
    const adresUzyty = {
      ...(adres ?? adresOdbiorcy(z)),
      ...(punktUzyty ? { punkt_odbioru: punktUzyty } : {}),
    };

    // TWARDA odmowa, nie samo ukrycie przycisku w widoku: karta w przegladarce pokazuje
    // stan sprzed sekund, a klient moze anulowac dokladnie wtedy, gdy operator ma ja otwarta.
    // Bez tej odmowy paczka do anulowanego zamowienia fizycznie by wyjechala, a nikt by sie
    // nie zorientowal: nadanie NIE zmienia statusu zamowienia w sklepie (decyzja
    // wlasciciela, patrz koniec funkcji), wiec karta zamowienia w Woo nie dostalaby ZADNEGO
    // sygnalu, ze cos poszlo nie tak.
    //
    // CELOWO blokujemy WYLACZNIE anulowanie. Brak oplaty NIE blokuje nadania: to sklep B2B,
    // wysylka na fakture z terminem platnosci jest normalna, a blokada zmuszalaby operatora
    // do falszywego oznaczania wplat. Nieoplacone zamowienie dostaje OSTRZEZENIE w widoku.
    if (z.anulowane) throw bladOperatora('Zamówienie jest anulowane — nie wolno go nadać.');

    // Czego zamowieniu BRAKUJE, zeby dalo sie je nadac (dzis: kod paczkomatu). Odmowa stoi
    // PRZED `rozpocznijPrzesylke`, wiec nieudana proba nie zostawia nawet wiersza w bazie —
    // nie ma czego odblokowywac, a operator dostaje zdanie mowiace, co uzupelnic.
    // TA SAMA funkcja rzadzi przyciskiem na karcie i ekranem nadania: panel ma nie
    // proponowac akcji, ktora sam odrzuci (domain/gotowosc-nadania.js).
    // ⚠️ METODA, KTORA NAPRAWDE OBSLUZY TO NADANIE — liczona PRZED wszystkim innym, bo od
    // niej zalezy i to, czego zamowieniu brakuje (kod paczkomatu), i do kogo zadzwonimy.
    // Dla zamowienia spoza Allegro oddaje po prostu `z.metoda_wysylki`, wiec dla sklepow
    // ta linia niczego nie zmienia. Dla zamowienia z Allegro BEZ wskazanego kuriera oddaje
    // ODMOWE — i to jest ta sama bariera, co dotad („metoda nie jest obslugiwana"), tylko
    // wreszcie mowiaca czlowiekowi, co ma zrobic, zamiast odsylac go z zapakowana paczka.
    const { metoda: metodaUzyta, blad: bladKuriera, wskazanyRecznie } = metodaNadania(z, kurierWybrany, { kolejnosc });
    if (bladKuriera) throw bladOperatora(bladKuriera);

    const braki = powodBrakuGotowosciNadania(z, metodaUzyta);
    if (braki) throw bladOperatora(braki);

    // Odmowa PRZED dotknieciem kuriera: nieznana metoda nie ma prawa wygenerowac listu.
    const { nazwa, klient } = wybierzKuriera(metodaUzyta, kurierzy);
    const przesylka = rozpocznijPrzesylke(db, zamowienieId, nazwa, kolejnosc);

    // ⚠️ WSKAZANIE KURIERA DO LOGU — PRZED wywolaniem kuriera, tak jak kwota pobrania nizej
    // i z tego samego powodu: to jest odstepstwo od metody zapisanej na zamowieniu, wiec za
    // miesiac „dlaczego ta allegrowa paczka pojechala naszym DPD" musi dac sie odpowiedziec
    // bez zgadywania. Wiersz przesylki niesie samego kuriera (`kurier`), ale nie niesie
    // DECYZJI — a to ona jest tu nieoczywista. Wpis pada takze wtedy, gdy nadanie zaraz
    // padnie, i takze wtedy, gdy skonczy sie stanem `do_wyjasnienia` (paczka u kuriera JEST).
    if (wskazanyRecznie) {
      dopiszLog(db, zamowienieId, {
        akcja: 'nadanie.kurier',
        wynik: `Ręcznie: zamówienie z Allegro (${z.metoda_wysylki}) nadane NASZĄ umową — ${metodaUzyta}.`,
      });
    }

    // Komentarz (dawny „powod dosylki") zapisujemy PO zajeciu miejsca w indeksie, a PRZED
    // wywolaniem kuriera: po pierwsze nie zasmieca logu przy odbitym dwukliku, po drugie
    // zostaje w historii takze wtedy, gdy nadanie zaraz padnie. Od Zadania „adres
    // edytowalny" pole jest dostepne przy KAZDYM nadaniu, nie tylko przy paczce N > 1 —
    // ale wymuszamy wpis w logu TYLKO gdy paczka N > 1 (tam nadal ZAWSZE zostawiamy slad,
    // takze pusty, bo pytanie „po co byla druga paczka" pada najczesciej) albo gdy operator
    // faktycznie cos napisal. Pusty komentarz przy zwyklej pierwszej paczce nie ma czego
    // uzasadniac i NIE MA prawa zasmiecac logu wpisem „nie podano powodu" przy kazdym
    // zwyklym nadaniu.
    //
    // ⚠️ POLE „KOMENTARZ" ZNIKNELO Z EKRANU NADANIA (Z5, decyzja wlasciciela 04.08) i to
    // bylo SWIADOME — nigdy nie jechalo do kuriera, trafialo wylacznie do logu. Parametr
    // zostaje, bo wolaja stad takze wywolania spoza formularza; z ekranu przychodzi dzis
    // ZAWSZE `null`, wiec galaz `kolejnosc > 1` wpisuje do logu stale „nie podano powodu".
    // I tak ma byc: slad „byla druga paczka" jest cenniejszy niz jego uzasadnienie, ktorego
    // nikt juz nie ma gdzie wpisac. Kto bedzie tedy szedl szukac pola w `nadaj.ejs` — nie
    // znajdzie go i to nie jest usterka.
    const tresc = String(komentarz ?? '').trim();
    if (kolejnosc > 1) {
      dopiszLog(db, zamowienieId, { akcja: 'nadanie.kolejna', wynik: `paczka nr ${kolejnosc}: ${tresc || 'nie podano powodu'}` });
    } else if (tresc) {
      // Komentarz idzie WYLACZNIE do logu — to notatka dla ludzi w panelu, NIGDY do DPD
      // (patrz wywolanie klient.nadaj() nizej: nie jest czescia przekazywanego obiektu).
      dopiszLog(db, zamowienieId, { akcja: 'nadanie.komentarz', wynik: tresc });
    }

    // ⚠️ KWOTA POBRANIA DO LOGU — PRZED wywolaniem kuriera, tak jak komentarz wyzej i
    // z tego samego powodu, tylko o wieksza stawke. Nadpisanie kwoty NIE MA GORNEGO PROGU
    // (swiadoma decyzja wlasciciela 04.08), wiec literowka „31033" zamiast „310,33"
    // pojedzie do kuriera taka, jaka jest — a wtedy TEN WPIS jest jedynym miejscem, w
    // ktorym po miesiacu widac, ile kurier mial zainkasowac. Kolumna `kwota_pobrania`
    // odpowiedzi nie da: poller nadpisuje ja danymi ze sklepu co dwie minuty (przewodnik
    // OMS, 4.7), a nadpisanie z tego ekranu i tak sie do niej nie zapisuje.
    // Wpis pada PRZED nadaniem, zeby zostal takze wtedy, gdy nadanie padnie z paczka JUZ
    // UTWORZONA u kuriera (stan `do_wyjasnienia` — wtedy pobranie fizycznie istnieje).
    if (kwotaPobrania != null) {
      dopiszLog(db, zamowienieId, {
        akcja: 'nadanie.pobranie',
        wynik: `kwota do zainkasowania przez kuriera: ${kwotaPobrania} zł`,
      });
    }

    // ⚠️⚠️ POBRANIE NA PACZCE N > 1 — OSOBNY WPIS, NIE DOPISEK DO POWYZSZEGO (04.09.2026).
    // To jest odstepstwo od reguly „pobranie jedzie na paczce nr 1", ktore panel wykonuje
    // WYLACZNIE na wyrazna decyzje czlowieka, i za miesiac pytanie „dlaczego kurier
    // zainkasowal przy drugiej paczce" musi dac sie rozstrzygnac bez zgadywania. Wpis pada
    // PRZED wywolaniem kuriera, wiec zostaje takze wtedy, gdy nadanie padnie z paczka JUZ
    // utworzona u kuriera (stan 'do_wyjasnienia' — wtedy pobranie fizycznie istnieje).
    // Kwota jest w tresci, bo `kwota_pobrania` na zamowieniu odpowiedzi nie da: poller
    // nadpisuje ja ze sklepu co dwie minuty, a nadpisanie z ekranu sie do niej nie zapisuje.
    if (pobranieNaTejPaczce && kolejnosc > 1) {
      dopiszLog(db, zamowienieId, {
        akcja: 'nadanie.pobranie',
        wynik: `Ręcznie: pobranie jedzie na paczce nr ${kolejnosc}, a nie na pierwszej `
          + '(paczka nr 1 jest zamiennikiem wyrzuconej etykiety, nie dosyłką obok niej). '
          + `Kurier zainkasuje ${kwotaPobrania ?? z.kwota_pobrania} zł.`,
      });
    }

    let wynik;
    try {
      wynik = await klient.nadaj({
        zamowienie: z, paczka, kolejnosc, adres: adresUzyty, punktOdbioru, kwotaPobrania,
        pobranieNaTejPaczce, drukowac,
      });
    } catch (przyczyna) {
      const e = /** @type {import('../nadanie-typy.ts').BladNadania} */ (przyczyna);
      // TRZY ROZNE AWARIE, trzy rozne wyjscia — dotad ladowaly w jednym worku (dwa od DPD).
      //
      // ⚠️ NOWY, TRZECI PRZYPADEK (InPost): wyjatek niesie `shipmentId`, ale nie niesie
      // numeru listu. Znaczy to, ze `POST /shipments` SIE UDAL — przesylka u kuriera
      // ISTNIEJE — a padlo dopiero odpytywanie o numer. Oznaczenie takiego wiersza jako
      // 'blad' (droga DPD, bo numeru nie ma) zwolniloby indeks czesciowy i pozwolilo nadac
      // DRUGA prawdziwa paczke, ktorej InPost nie odsieje po referencji. Patrz nizej.
      // ⚠️⚠️ POBRANIE NIEPOTWIERDZONE PRZEZ KURIERA — WLASNE WYJSCIE, PRZED POZOSTALYMI
      // (27.08.2026). Przesylka u kuriera ISTNIEJE, ale kurier NIE potwierdzil, ze zainkasuje
      // pieniadze (kurierzy/inpost.js). Bez tej galezi sprawa trafialaby — po samym
      // `shipmentId` — na 'w_trakcie' z przyciskiem „Sprawdz ponownie", a to klikniecie
      // dobiera numer i etykiety i KONCZY nadanie z pominieciem straznika. Panel zamknalby
      // wiec jako nadana paczke, za ktora nikt nie zaplaci.
      //
      // 'do_wyjasnienia' jest jedynym stanem bez drogi „dokoncz": wychodzi sie z niego
      // WYLACZNIE decyzja czlowieka. Numer listu bywa juz przyznany, bywa `null` — jedno
      // i drugie jest tu poprawne, bo o stanie rozstrzyga POBRANIE, nie numer.
      if (e.pobranieNiepotwierdzone) {
        oznaczDoWyjasnienia(db, przesylka.id, {
          numerListu: e.numerListu ?? null,
          opis: e.message,
          surowa: e.surowa ?? null,
          adresUzyty: JSON.stringify(adresUzyty),
          idPrzesylkiKuriera: e.shipmentId ?? null,
        });
        dopiszLog(db, zamowienieId, {
          akcja: 'nadanie',
          wynik: `DO WYJAŚNIENIA — POBRANIE NIEPOTWIERDZONE (przesyłka ${e.shipmentId}): ${e.message}`,
        });
      } else if (e.numerListu) {
        // DPD juz przydzielilo numer. Ponowienia byc NIE MOZE: ta sama referencja wroci
        // z DUPLICATED_PARCEL_SEARCH_KEY, a paczka u kuriera fizycznie istnieje — i pojechala
        // pod adres UZYTY W TYM WYWOLANIU. Bez zapisu adresu tutaj panel nigdy by sie juz nie
        // dowiedzial, dokad, bo operator mogl go poprawic na ekranie nadania tuz przed tym
        // klikniciem, a adres w zamowieniu ze sklepu od tej chwili moze byc juz inny.
        oznaczDoWyjasnienia(db, przesylka.id, {
          numerListu: e.numerListu,
          opis: e.message,
          surowa: e.surowa ?? null,
          adresUzyty: JSON.stringify(adresUzyty),
          // Identyfikator przesylki u kuriera jest tu DRUGIM sladem obok numeru listu —
          // po nim czlowiek odnajdzie ta przesylke w Managerze Paczek. Przy DPD go nie ma
          // i kolumna zostaje pusta (COALESCE nie nadpisuje NULL-em).
          idPrzesylkiKuriera: e.shipmentId ?? null,
        });
        dopiszLog(db, zamowienieId, { akcja: 'nadanie', wynik: `DO WYJAŚNIENIA (list ${e.numerListu}): ${e.message}` });
      } else if (e.shipmentId) {
        // ⚠️ PRZESYLKA U KURIERA ISTNIEJE, MIMO ZE NADANIE PADLO. Zapisujemy identyfikator
        // i ZOSTAWIAMY wiersz zywy ('w_trakcie'), bo to jedyny stan, ktory jednoczesnie
        // trzyma indeks (zadnej drugiej paczki) i pozwala sprawe dokonczyc bez tworzenia
        // czegokolwiek nowego — przyciskiem „Sprawdz ponownie" na karcie.
        oznaczTworzonaUKuriera(db, przesylka.id, {
          idPrzesylkiKuriera: e.shipmentId,
          opis: e.message,
          surowa: e.surowa ?? null,
          adresUzyty: JSON.stringify(adresUzyty),
        });
        dopiszLog(db, zamowienieId, {
          akcja: 'nadanie',
          wynik: `PRZESYŁKA UTWORZONA U KURIERA (${e.shipmentId}), ale bez numeru listu: ${e.message}`,
        });
      } else {
        // Numeru nie ma — nic sie u kuriera nie wydarzylo, wiec zwalniamy miejsce w indeksie
        // i pozwalamy ponowic.
        oznaczBlad(db, przesylka.id, e.message);
        dopiszLog(db, zamowienieId, { akcja: 'nadanie', wynik: `BŁĄD: ${e.message}` });
      }
      throw e;
    }

    // ⚠️ IDENTYFIKATOR PRZESYLKI U KURIERA — ZAPIS PRZED CZYMKOLWIEK INNYM.
    // Od udanego `POST` przesylka w ShipX ISTNIEJE. Wszystko, co dzieje sie dalej (pliki
    // etykiet, wpis do bazy, notatka w sklepie), może paść — a wtedy jedyna droga do tej
    // paczki wiedzie przez zapisany identyfikator. Dlatego leci do bazy PIERWSZY, zanim
    // panel dotknie dysku. Klient DPD identyfikatora nie ma i ta linia go nie dotyczy.
    if (wynik.shipmentId) zapiszIdPrzesylkiKuriera(db, przesylka.id, wynik.shipmentId);

    // ⚠️ PRZESYLKA JEST, NUMERU JESZCZE NIE MA (InPost — tworzenie bywa asynchroniczne).
    // To NIE jest awaria i nie wolno jej tak zglaszac: nadanie sie UDALO, brakuje wylacznie
    // numeru, ktory kurier przyzna sam za chwile. Wiersz zostaje 'w_trakcie' z zapisanym
    // identyfikatorem — karta pokazuje wtedy „przesylka tworzona u kuriera" i przycisk
    // „Sprawdz ponownie", ktory te sama przesylke DOKONCZY (sprawdzPonownie nizej).
    if (wynik.wTrakcieTworzenia) {
      oznaczTworzonaUKuriera(db, przesylka.id, {
        idPrzesylkiKuriera: wynik.shipmentId,
        surowa: wynik.surowa ?? null,
        adresUzyty: JSON.stringify(adresUzyty),
      });
      dopiszLog(db, zamowienieId, {
        akcja: 'nadanie',
        wynik: `TWORZONA U KURIERA (${wynik.shipmentId}) — numeru listu jeszcze nie ma, `
          + 'dokończ przyciskiem „Sprawdź ponownie" na karcie.',
      });
      return { numerListu: null, wTrakcieTworzenia: true, idPrzesylkiKuriera: wynik.shipmentId };
    }

    await dokonczNadanie({
      z, przesylkaId: przesylka.id, kurier: nazwa, wynik, adresUzytyJson: JSON.stringify(adresUzyty),
    });
    return { numerListu: wynik.numerListu };
  }

  /**
   * „SPRAWDŹ PONOWNIE" — dokończenie przesyłki, która u kuriera JUŻ ISTNIEJE.
   *
   * ⚠️ TA FUNKCJA NIE MA PRAWA UTWORZYĆ ŻADNEJ PRZESYŁKI. Woła WYŁĄCZNIE
   * `klient.sprawdzPrzesylke(id)`, czyli `GET` po zapisanym identyfikatorze — nigdy
   * `klient.nadaj()`. Dziesięć kliknięć pod rząd ma dać zero nowych paczek, bo InPost nie
   * odsiewa duplikatów po referencji (spec, 4.4) i nikt by tego za nas nie złapał.
   *
   * Argumentem jest ID PRZESYŁKI, nie zamówienia — dokładnie jak przy odblokujPrzesylke
   * i domknijPrzesylke: zamówienie może mieć kilka paczek, a „pierwsza z brzegu"
   * rozstrzygałaby los innej niż ta, przy której operator kliknął.
   */
  /** @param {number} przesylkaId */
  async function sprawdzPonownie(przesylkaId) {
    const p = pobierzPrzesylke(db, przesylkaId);
    if (!p) throw bladOperatora('Nie ma takiej przesyłki.');
    // Stan liczony domeną, nie warunkiem wpisanym tutaj — ten sam, który maluje kartę.
    // Sprawdzenie przesyłki NADANEJ nie miałoby czego dokończyć, a przy 'blad' i przy
    // paczce bez identyfikatora nie ma nawet o co zapytać kuriera.
    if (stanPrzesylki(p) !== 'tworzona_u_kuriera') {
      throw bladOperatora(
        'Ta przesyłka nie czeka na numer u kuriera — nie ma czego sprawdzać. '
        + 'Przycisk „Sprawdź ponownie" dotyczy wyłącznie przesyłki, która u kuriera już powstała, '
        + 'ale nie dostała jeszcze numeru listu.',
      );
    }

    const klient = kurierzy?.[p.kurier];
    // Kurier wyłączony w konfiguracji (albo przesyłka sprzed jego podpięcia) — mówimy to
    // wprost, zamiast wywalić się na `undefined.sprawdzPrzesylke`.
    if (!klient?.sprawdzPrzesylke) {
      throw bladOperatora(`Kurier ${p.kurier} nie jest skonfigurowany — nie ma kogo zapytać o tę przesyłkę.`);
    }

    const z = pobierzZamowienie(db, p.zamowienie_id);
    let wynik;
    try {
      // ⚠️ ZAMOWIENIE IDZIE DRUGIM ARGUMENTEM — DPD i InPost je ignoruja, ale `allegro_wza`
      // bez niego nie wie, KTOREGO KONTA pytac: kanaly Allegro to osobne konta, a przesylka
      // kupiona na jednym nie istnieje dla drugiego.
      wynik = await klient.sprawdzPrzesylke(p.id_przesylki_kuriera, z);
    } catch (przyczyna) {
      const e = /** @type {import('../nadanie-typy.ts').BladNadania} */ (przyczyna);
      if (e.numerListu) {
        // ⚠️ NUMER LISTU JEST CENNIEJSZY NIŻ PDF — także tutaj. Klient rzuca z numerem
        // wtedy, gdy przesyłka numer JUŻ DOSTAŁA, a padło dopiero pobranie etykiety.
        // Zapisanie tego wyjątku jako zwykłej awarii sprawdzenia zgubiłoby numer, który
        // kurier przyznał tylko raz — i zostawiło paczkę bez żadnego identyfikatora
        // przewozowego w panelu.
        oznaczDoWyjasnienia(db, p.id, {
          numerListu: e.numerListu,
          opis: e.message,
          surowa: e.surowa ?? null,
          adresUzyty: p.adres_uzyty ?? null,
          idPrzesylkiKuriera: p.id_przesylki_kuriera,
        });
        dopiszLog(db, p.zamowienie_id, {
          akcja: 'nadanie.sprawdzenie', wynik: `DO WYJAŚNIENIA (list ${e.numerListu}): ${e.message}`,
        });
        throw e;
      }
      // Nieudane sprawdzenie NICZEGO nie zmienia w bazie poza opisem: przesyłka nadal
      // istnieje u kuriera, wiersz nadal trzyma indeks, a przycisk zostaje na karcie.
      // ⚠️ Zwłaszcza NIE oznaczamy 'blad' — to zwolniłoby miejsce pod drugą paczkę.
      oznaczTworzonaUKuriera(db, p.id, {
        idPrzesylkiKuriera: p.id_przesylki_kuriera, opis: e.message, surowa: e.surowa ?? null,
      });
      dopiszLog(db, p.zamowienie_id, { akcja: 'nadanie.sprawdzenie', wynik: `BŁĄD: ${e.message}` });
      throw e;
    }

    // Kurier wciąż nie przyznał numeru. Nic się nie stało — zapisujemy tylko świeżą
    // odpowiedź i kasujemy poprzedni opis błędu (jeśli był), żeby karta nie straszyła
    // awarią, której już nie ma.
    if (wynik.wTrakcieTworzenia) {
      oznaczTworzonaUKuriera(db, p.id, {
        idPrzesylkiKuriera: p.id_przesylki_kuriera, surowa: wynik.surowa ?? null,
      });
      dopiszLog(db, p.zamowienie_id, {
        akcja: 'nadanie.sprawdzenie',
        wynik: `przesyłka ${p.id_przesylki_kuriera} nadal bez numeru listu — spróbuj za chwilę.`,
      });
      return { numerListu: null, wTrakcieTworzenia: true };
    }

    // Adres bierzemy Z WIERSZA, a nie z zamówienia: paczka pojechała pod adres zapisany
    // w chwili nadania i żadna późniejsza poprawka w sklepie tego nie zmienia. Ponowne
    // liczenie go tutaj podmieniłoby historię paczki, która już istnieje.
    await dokonczNadanie({
      z, przesylkaId: p.id, kurier: p.kurier, wynik, adresUzytyJson: p.adres_uzyty ?? null,
    });
    return { numerListu: wynik.numerListu };
  }

  // paczkaDomyslna wystawiona na zewnatrz, zeby ekran nadania (GET /zamowienia/:id/nadaj)
  // mogl nia wypelnic formularz — TA SAMA stala, nie druga kopia w widoku.
  // PRZ-117: przycisk „Spróbuj ponownie” przy nieudanej notatce — tu, bo tylko nadanie ma klientów sklepów.
  const ponowNotatke = (/** @type {number} */ przesylkaId) => ponowNotatkeNadania({ db, klienci }, przesylkaId);

  return { nadaj, sprawdzPonownie, ponowNotatke, paczkaDomyslna };
}
