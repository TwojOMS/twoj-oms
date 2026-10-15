import { anulowaneEfektywnie } from '../../../domena/status-reczny.js';
import { dzienWarszawa, fmtDataCzas } from '../../../domena/format-daty.js';
import { kluczOkresu } from '../../../domena/okres-rozliczeniowy.js';
import { czyKanalAllegro } from '../../../domena/wysylka.js';

// Zrodlo danych dla zewnetrznego tygodniowego raportu sprzedazy.
//
// ⚠️ POWOD ISTNIENIA: zamowienia klienta rozliczanego zbiorczo wisza w panelu POJEDYNCZO,
// a klient dostaje jedna fakture miesieczna. Raport liczacy sprzedaz z faktur widzialby
// jedna paczke za kilkaset zlotych raz w miesiacu — ten endpoint oddaje mu te same
// zamowienia sztuka po sztuce, w oknie, o ktore pyta.
//
// ⚠️ KANAL WYNIKA ZE ZRODLA ZAMOWIENIA, a nie z samego braku okresu (ustalenie recenzji
// Zadania 10). Reguly sa trzy i ida DOKLADNIE w tej kolejnosci:
//
//   1. zamowienie ze znacznikiem `indywidualne` to zamowienie z PANELU OFERT INDYWIDUALNYCH
//      — kanal 'SKLEP_INDYWIDUALNE'. Ta regula stoi PIERWSZA, bo takie zamowienie ma
//      ten sam klucz sklepu co detal (wpada do tego samego WooCommerce) i pod regula nr 2
//      wyszloby jako zwykly sklep;
//   2. zamowienie NIE-reczne (`sklep` inny niz 'reczne') to SPRZEDAZ SKLEPOWA — kanal 'SKLEP';
//   3. zamowienie reczne dzieli sie tak jak dotad: z okresem rozliczeniowym → DROPSHIPPING,
//      bez okresu → B2B (to zamowienia hurtowe jadace do siedziby klienta).
//
// ⚠️ TO JEST GRANICA MIEDZY TYM, CO RAPORT BIERZE Z APILO, A TYM, CO BIERZE Z OMS-U.
// Konsument historyczny ma juz osobne kanaly SKLEP_WOO
// i B2B i liczy je Z APILO. Gdyby zamowienie ze sklepu
// wyszlo stad jako 'B2B' — a tak bylo przed ta poprawka, bo sklepowe zamowienia nie maja
// okresu — raport sumujacy oba zrodla policzylby detal ze sklepu DWA RAZY: raz jako
// sklep z Apilo, raz jako B2B z OMS-u. Zawyzona sprzedaz, nie blad; nikt by tego nie zauwazyl.
// Etykieta 'SKLEP' jest CELOWO inna niz konsumenckie 'SKLEP_WOO' — ma sie nie dac zsumowac
// przez pomylke z zadnym kanalem, ktory konsument liczy z Apilo.
//
// ⚠️ Zamowien sklepowych NIE USUWAMY z odpowiedzi. Konsument ma je zobaczyc i JAWNIE
// odrzucic; cichy filtr po stronie serwera znaczylby, ze nikt po drugiej stronie nie wie,
// ze cokolwiek odpadlo — a zamowienie zniknieta z okna jest dokladnie tak samo zle,
// jak zamowienie policzone dwa razy.
const KANAL_SKLEP = 'SKLEP';

// ⚠️⚠️ NAZWA CELOWO INNA NIZ 'INDYWIDUALNE' — i to jest cala pointa tej stalej.
//
// Konsument historyczny MA JUZ WLASNY kanal 'INDYWIDUALNE',
// liczony Z APILO: konto ofert indywidualnych oraz rozpoznane zamowienia z WooCommerce
// z pozycja powiazana z oferta panelu. To sa DOKLADNIE
// te same zamowienia, ktore ten endpoint oznacza znacznikiem `indywidualne`.
//
// Oddanie stad tej samej nazwy daloby raport sumujacy oba zrodla, ktory policzylby je
// DWA RAZY — zawyzona sprzedaz, nie blad, wiec nikt by tego nie zauwazyl. To dokladnie ta
// sama zasada, dla ktorej KANAL_SKLEP nazywa sie 'SKLEP', a nie 'SKLEP_WOO'.
//
// ⚠️⚠️ KAZDY NOWY KANAL WYMAGA ZMIANY PO STRONIE RAPORTOW — I TO ZANIM WEJDZIE TUTAJ.
//
// Wczesniejsza wersja tego komentarza twierdzila, ze „nazwa nieznana konsumentowi trafia
// do worka «pozostale» i nie zsumuje sie z niczym". TO BYLA NIEPRAWDA i sprawdzenie tego
// jest jedynym powodem, dla ktorego dzis raport dziala: `sprzedazDropshippinguZOms`
// (zewnetrzny raport sprzedazy) na nieznany kanal RZUCA WYJATKIEM
// i PRZERYWA CALY RAPORT — celowo, bo worek „pozostale" jest u konsumenta kanalem
// LICZONYM i ciche wrzucenie tam czegokolwiek zawyzyloby sprzedaz.
//
// Dopisanie kanalu do `KANALY_OMS` po tamtej stronie musialo wiec
// wyprzedzic wdrozenie tej galezi. Kolejnosc jest odwrotna niz zwykle: NAJPIERW raporty,
// POTEM panel.
//
// Gdy OMS bedzie zastepowal Apilo, przelaczenie roli tego kanalu z 'apilo' na 'liczony'
// bedzie SWIADOMA zmiana po tamtej stronie, a nie cichym efektem ubocznym tej.
const KANAL_SKLEP_INDYWIDUALNE = 'SKLEP_INDYWIDUALNE';

// ⚠️⚠️ KANAL ALLEGRO — dopisany przy recenzji calej galezi (04.08.2026, usterka I-2).
//
// Galaz dodala kanaly sprzedazy (`zamowienia.sklep` = 'allegro_konto-a' / 'allegro_konto-b')
// i TEGO PLIKU NIE TKNELA. Regula nr 2 wyzej brzmi „wszystko, co nie jest `reczne`, to SKLEP",
// wiec sprzedaz z Allegro wychodzila stad OZNACZONA JAKO DETAL ZE SKLEPU — a mechanizm
// ostrzegawczy opisany akapit wyzej („kazdy nowy kanal wymaga zmiany po stronie raportow")
// zostal przez to obejsciem WYLACZONY: konsument nie widzial nowej nazwy, wiec nie mial na
// czym rzucic. Cichy skutek: zamowienia z Allegro doliczone do kanalu, ktory konsument
// odrzuca jako „liczony z Apilo" — czyli w raporcie nie widac ich WCALE, mimo ze sa.
//
// ⚠️ NAZWA CELOWO INNA NIZ NAZWY KONT ALLEGRO — dokladnie ta sama
// zasada, co przy 'SKLEP' vs 'SKLEP_WOO'. Konsument historyczny
// MA JUZ te dwa kanaly, liczone Z APILO. Oddanie stad tej samej nazwy daloby
// raport sumujacy oba zrodla, ktory policzylby te zamowienia DWA RAZY — zawyzona sprzedaz,
// nie blad, wiec nikt by tego nie zauwazyl.
//
// JEDNA nazwa na oba konta, a nie dwie: po tej stronie kanal jest ROZPOZNANIEM ZRODLA, a nie
// podzialem sprzedazy — rozbicie na konta wymagaloby dwoch wpisow w `KANALY_OMS` i dawalo
// konsumentowi wybor, ktorego dzis nie ma po co podejmowac (oba konta i tak licza sie
// z Apilo). Podzial na konta zostaje mozliwy: wartosc kolumny `sklep` jedzie do konsumenta
// i tak, w `numer`ze i w zamowieniu.
//
// ⚠️⚠️ WARUNEK WDROZENIA, NIE ZALECENIE: `sprzedazDropshippinguZOms`
// (zewnetrzny raport sprzedazy) na NIEZNANY kanal RZUCA WYJATKIEM i PRZERYWA
// CALY RAPORT — celowo. Dopisanie `ALLEGRO: 'apilo'` do `KANALY_OMS` po TAMTEJ stronie MUSI
// wyprzedzic wdrozenie tej galezi. Kolejnosc jest odwrotna niz zwykle: NAJPIERW raporty,
// POTEM panel. To nie jest niedogodnosc, tylko cala wartosc tego mechanizmu: raport, ktory
// staje, jest nieporownanie lepszy od raportu, ktory po cichu policzy detal dwa razy albo
// zgubi sprzedaz z Allegro.
const KANAL_ALLEGRO = 'ALLEGRO';

/** Kanal raportowy zamowienia — patrz komentarz wyzej. Zrodlo rozstrzyga PRZED okresem. */
function kanalZamowienia(w) {
  // Zamowienie z panelu ofert indywidualnych. Idzie PRZED regula sklepowa, bo takie
  // zamowienie ma klucz tego samego sklepu i bez tego warunku wyszloby jako zwykly sklep.
  //
  // ⚠️ Pole `indywidualne` MUSI byc na liscie kolumn zapytania SQL nizej. Bez tego czytaloby
  // sie `undefined`, warunek nigdy by nie zadzialal, a zamowienie po cichu wyszloby jako
  // 'SKLEP' — awaria bez ani jednego bledu na ekranie.
  if (w.indywidualne) return KANAL_SKLEP_INDYWIDUALNE;
  // ⚠️ IDZIE PRZED REGULA SKLEPOWA, bo dokladnie ona wchlaniala te zamowienia: warunek
  // `sklep !== 'reczne'` jest prawdziwy takze dla `allegro_*`. Predykat jest TEN SAM, ktory
  // pilnuje odmowy nadania (domain/wysylka.js) — jedno zrodlo prawdy o tym, co jest kanalem
  // Allegro; druga kopia prefiksu rozjechalaby sie po cichu przy trzecim koncie.
  if (czyKanalAllegro(w)) return KANAL_ALLEGRO;
  if (w.sklep !== 'reczne') return KANAL_SKLEP;
  return w.okres_rozliczeniowy_id ? 'DROPSHIPPING' : 'B2B';
}

// Sam dzien kalendarzowy, nic wiecej. Znacznik czasu ('2026-07-01T05:00') tez odrzucamy:
// raport pyta o polskie DNI handlowe, a wpuszczenie godziny znaczyloby dwie rozne
// odpowiedzi na to samo pytanie („tydzien od 1 lipca" zaleznie od tego, co dokleil klient).
const WZORZEC_DNIA = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Dzien z parametru albo `null`, gdy wartosc nie jest poprawna data kalendarzowa.
 *
 * ⚠️ WALIDACJE ROBI `kluczOkresu` (domain/okres-rozliczeniowy.js), a nie `new Date`, i to
 * jest cala pointa tej funkcji: V8 NIE odrzuca dat kalendarzowo niepoprawnych, tylko je
 * cicho przewija — `new Date('2026-02-30')` to 2 marca, a nie Invalid Date. Bez tego
 * literowka w adresie dalaby raportowi tydzien przesuniety o dzien, wygladajacy zupelnie
 * wiarygodnie. `kluczOkresu` sprawdza date WPROST Z NAPISU (rok-miesiac-dzien, z dlugoscia
 * miesiaca) i rzuca — uzywamy tamtej reguly zamiast pisac trzecia kopie tego samego.
 */
function dzienZParametru(surowa) {
  if (typeof surowa !== 'string') return null;
  const s = surowa.trim();
  if (!WZORZEC_DNIA.test(s)) return null;
  try {
    kluczOkresu(s);
  } catch {
    return null;
  }
  return s;
}

export function trasaApiSprzedaz(app, { db }) {
  app.get('/api/sprzedaz', async (req, odp) => {
    // Brak zakresu ma byc bledem, a nie cichym zwrotem calej historii: raport pobralby
    // wtedy wszystko i policzyl tydzien jako cala sprzedaz firmy.
    if (!req.query?.od || !req.query?.do) {
      return odp.code(400).send({ blad: 'Wymagane parametry: od, do (RRRR-MM-DD).' });
    }
    const od = dzienZParametru(req.query.od);
    const doDnia = dzienZParametru(req.query.do);
    // ⚠️ Zla data to TEZ blad, z tego samego powodu co brak daty. Przepuszczona dalej
    // oddalaby pusta liste — czyli raport pokazalby tydzien BEZ SPRZEDAZY zamiast sie
    // zatrzymac, a nikt nie kwestionuje zera, ktore wyglada jak zero.
    if (!od || !doDnia) {
      return odp.code(400).send({
        blad: 'Niepoprawna data: parametry od, do muszą być istniejącymi dniami (RRRR-MM-DD).',
      });
    }
    // ⚠️ Odwrocone granice to TEZ blad, z dokladnie tego samego powodu co zla data. Okno
    // `od` > `do` jest z definicji puste, wiec przepuszczone dalej oddaloby 200 i pusta
    // liste — czyli RAPORT Z ZEROWA SPRZEDAZA, wygladajacy zupelnie wiarygodnie. A tak
    // wyglada zarowno literowka w dacie tygodnia, jak i zamiana argumentow miejscami po
    // stronie konsumenta. Zera nikt nie kwestionuje; odmowy nie da sie przeoczyc.
    // Granice ROWNE sa poprawne: `od` = `do` to legalne pytanie o jeden dzien.
    if (od > doDnia) {
      return odp.code(400).send({
        blad: 'Niepoprawny zakres: parametr od nie może być późniejszy niż do.',
      });
    }

    // ⚠️ OKNO LICZYMY W EUROPE/WARSAW, NIE W UTC, i NIE W SQL-u. Kolumna `utworzone_at`
    // niesie DWA formaty naraz i zadne porownanie napisow nie jest dla obu poprawne:
    //   • zamowienia reczne — znacznik UTC z „Z" (kontener chodzi z TZ=UTC), wiec zamowienie
    //     zlozone 1 lipca o 01:30 czasu polskiego ma tam '2026-06-30T23:30:00.000Z'
    //     i przy oknie liczonym w UTC wypadaloby z lipca do czerwca (albo z tygodnia,
    //     o ktory pyta raport, w ogole);
    //   • zamowienia ze sklepu — `date_created` z Woo, czyli czas Warszawy BEZ oznaczenia
    //     strefy (domain/mapowanie.js), ktorego nie wolno przeliczac drugi raz.
    // Rozroznia je `dzienWarszawa` z domain/format-daty.js — TA SAMA funkcja, ktora liczy
    // dzien drukowany w tabeli i ktora filtruje liste (domain/filtry-listy.js). Filtr
    // „lipiec" na ekranie i „lipiec" w raporcie musza brac te same zamowienia; druga
    // implementacja tej reguly rozjechalaby sie na pierwszym zamowieniu z nocy.
    //
    // ⚠️ OBIE GRANICE SA DOMKNIETE: okno to polskie dni kalendarzowe od `od` do `do`
    // WLACZNIE, czyli [poczatek dnia `od`, koniec dnia `do`] w Europe/Warsaw. Porownanie
    // ostre przy gornej granicy odcinaloby zamowienie zlozone w ostatniej chwili doby,
    // a raport pytajacy tydzien po tygodniu gubilby je zupelnie.
    const wiersze = db.prepare(
      // ⚠️ `indywidualne` NA LIScie KOLUMN JEST OBOWIAZKOWE — czyta je `kanalZamowienia`.
      // Bez niego pole byloby `undefined`, warunek nigdy by nie zadzialal i zamowienie
      // z panelu ofert wyszloby CICHO jako zwykly 'SKLEP'. Zadnego wyjatku, zadnego 500 —
      // tylko jeden kanal raportu zaniżony, a drugi zawyzony.
      'SELECT id, sklep, numer, kwota_brutto, utworzone_at, okres_rozliczeniowy_id,'
      + ' indywidualne, anulowane, anulowane_recznie FROM zamowienia',
    ).all();

    const zamowienia = wiersze
      // ⚠️ ANULOWANIE EFEKTYWNE, nie sama kolumna `anulowane`. Ta nalezy do SKLEPU (przepisuje
      // ja poller), a zamowienia rozliczane zbiorczo sa RECZNE — zadny sklep ich nie anuluje,
      // wiec operator anuluje je kolumna `anulowane_recznie`. Warunek o samym `anulowane`
      // wliczalby anulowane zamowienie do sprzedazy. Regula jest JEDNA i mieszka
      // w domain/status-reczny.js — dwie definicje tego, co wchodzi do sumy, juz raz sie
      // w tym module rozjechaly.
      .filter((w) => !anulowaneEfektywnie(w))
      .filter((w) => {
        const dzien = dzienWarszawa(w.utworzone_at);
        // Zamowienie z data nie do odczytania NIE ma prawa udawac, ze miesci sie w kazdym
        // oknie — tak samo jak przy filtrach listy (domain/filtry-listy.js).
        //
        // ⚠️ `Boolean(dzien)` jest dzis REDUNDANTNY I NIE DA SIE GO ZABIC TESTEM — zmierzone
        // przy recenzji Zadania 10 (mutacja: usuniety straznik, cala suita nadal zielona).
        // Dowod rownowaznosci: `dzienWarszawa` zawsze oddaje napis, a jedyna jego falszywa
        // wartoscia jest '' — i '' >= od jest FALSZEM dla kazdego `od`, bo `dzienZParametru`
        // gwarantuje niepusty 'RRRR-MM-DD' (sprawdzone takze dla od='0000-01-01'). Zostaje
        // JAKO PASY OBOK SZELEK: chroni przed przyszla zmiana po drugiej stronie warunku
        // (domyslne/opcjonalne `od`, przejscie na porownanie inne niz napisowe), a nie przed
        // dzisiejszym wejsciem. Zamiast pisac test, ktory niczego nie pilnuje, zostawiamy
        // tu ten pomiar — zeby kolejna recenzja nie szukala po raz drugi.
        return Boolean(dzien) && dzien >= od && dzien <= doDnia;
      })
      // Kolejnosc chronologiczna liczona po czasie WARSZAWSKIM, a nie przez `ORDER BY
      // utworzone_at` w SQL-u: sortowanie napisow w dwoch formatach naraz przeplatalo
      // zamowienia ze sklepu z recznymi o dwie godziny w zla strone. `fmtDataCzas` oddaje
      // stalej dlugosci 'RRRR-MM-DD GG:MM:SS' w jednej strefie, wiec porownanie napisow
      // (bez `localeCompare`, ktore potrafi traktowac znaki interpunkcyjne inaczej)
      // jest tu porownaniem chwil.
      .sort((a, b) => {
        const da = fmtDataCzas(a.utworzone_at);
        const dbb = fmtDataCzas(b.utworzone_at);
        if (da !== dbb) return da < dbb ? -1 : 1;
        return a.id - b.id;
      })
      .map((w) => ({
        numer: w.numer,
        kanal: kanalZamowienia(w),
        // ⚠️ Kwota WPROST z kolumny, bez przeliczania. Dla zamowien recznych `kwota_brutto`
        // jest utrzymywana przy zapisie pozycji i ma juz doklejona oplate za obsluge
        // (kwotaOczekiwanaGrosze w domain/suma-pozycji.js oddaje dla nich po prostu kwote
        // zamowienia) — wlasne sumowanie pozycji byloby druga arytmetyka tych samych pieniedzy.
        kwotaBrutto: w.kwota_brutto,
        // ⚠️ SUROWA kolumna, w dwoch skalach czasu naraz — i tak ma zostac (kontrakt).
        // Do KUBELKOWANIA sluzy `dzien` ponizej, nie ta wartosc.
        dataZlozenia: w.utworzone_at,
        // ⚠️ DZIEN HANDLOWY, policzony po stronie, ktora wie jak: `dzienWarszawa`, ta sama
        // funkcja, ktora przepuscila to zamowienie przez okno wyzej. Bez tego pola konsument
        // kubelkujacy tygodnie musialby liczyc dzien z `dataZlozenia` — a `slice(0,10)` albo
        // `getUTCDay()` na znaczniku UTC odtworzyloby dokladnie ten blad, ktory ten endpoint
        // naprawia: zamowienie reczne '2026-07-05T22:30:00.000Z' to niedziela 6 lipca 00:30
        // czasu polskiego i wpadloby do POPRZEDNIEGO tygodnia. Filtr okna i to pole musza
        // mowic to samo, wiec licza je te same reguly.
        dzien: dzienWarszawa(w.utworzone_at),
      }));

    return { zamowienia };
  });
}
