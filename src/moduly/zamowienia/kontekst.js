import { gusDostepny } from '../../domena/konfiguracja-gus.js';
import { etykietyStatusow } from '../../oms/db/statusy.js';
import { listaZamowien, zamowieniaPoId, numeryZamowien, pobierzZamowienie, dopiszLog, zapiszNadpisaniaWysylki, historiaLogu } from '../../oms/db/zamowienia.js';
import { indeksListy } from '../../oms/db/indeks-listy.js';
import { proformyZamowienia } from '../faktury/db/proformy.js';
import { aktualnaProforma, czyWolnoWystawic, rozjazdKwotyProformy } from '../../domena/proforma-stan.js';
import { nastepnyNumerReczny } from '../../oms/db/zamowienia-reczne.js';
import { DOSTAWY, PLATNOSCI, liczbaWierszyFormularza, wdtZFormularza } from '../../domena/nowe-zamowienie.js';
import { nastepnaKolejnosc, skasujPrzesylkeReczna, przesylkiDoSledzenia } from '../wysylka/db/przesylki.js';
import { ostatniaPozycjaDlaPrzesylki } from '../wysylka/db/kolejka-druku.js';
import { ostatniaPozycjaDlaFaktury } from '../faktury/db/kolejka-druku-faktur.js';
import { stanFaktury } from '../../domena/faktura-stan.js';
import { stanPrzesylki, sprawyZamowienia, sprawyDoZalatwieniaRecznie, mozliwaKolejnaPaczka, numerWpisanyZReki, mozliweUkrycie, przesylkaUkryta } from '../../domena/przesylka-stan.js';
import { wyliczStatus, doZrobienia, anulowaneWymagaUwagi, uwagaDolaczonychAnulowanych } from '../../domena/status.js';
import { podsumowanieZwrotow } from '../../domena/zwrot-widok.js';
import { powodBrakuGotowosciNadania } from '../../domena/gotowosc-nadania.js';
import { etykietaWysylki, czyKanalAllegro } from '../../domena/wysylka.js';
import { bezpiecznyPowrotNaListe } from '../../domena/filtry-listy.js';
import { adresKartyZamowienia, adresPowrotuDoWiersza } from '../../domena/adres-karty-zamowienia.js';
import { METODY_WPLATY_RECZNEJ } from '../../domena/metody-platnosci.js';
import { linkDoSledzenia } from '../../domena/tracking.js';
import { powiazaniaDosylki } from '../../domena/dosylka.js';
import { wczytajAutomatKsef } from '../faktury/db/ksef-automat.js';
import { regulyDoOstrzezen } from '../automatyzacje/db/reguly.js';
import { ostrzezeniaAutomatuKsef, ostrzezeniaAutomatyzacji, ostrzezeniaFaktur, ostrzezeniaPrzesylek, ostrzezeniaWiadomosci, ostrzezeniaIntegracji, ostrzezeniaTerminow, ostrzezeniaZwrotow, ostrzezeniaPobran, zlozOstrzezenia, ostrzezeniaDlaKonta } from '../../domena/ostrzezenia.js';
import { ukryteTypyKonta } from '../../oms/db/powiadomienia.js';
import { odrzucenia, lukiKsef, poTerminie, zwrotyBezKorekty, pobraniaBezGotowki, dzienWystawieniaLuki } from '../../oms/db/ostrzezenia.js';
import { wysylkaKsef as rezerwacjaKsef } from '../faktury/db/wysylki-ksef.js';
import { wysylkaZKarty, POWOD_KOREKTA } from '../../domena/wysylka-ksef.js';
import { czyWysylacKonsumenckie } from '../faktury/db/ksef-konsumenckie.js';
import { listaWatkow } from '../../oms/db/allegro-watki.js';
import { adresKanalu, rodzajKanalu } from '../../domena/kanaly.js';
import { przewoznikWiersza } from '../../domena/przewoznik-przesylki.js';
import { klientListy } from '../../domena/klient-listy.js';
import { ikonaPlatnosci, ikonaPrzesylki, ikonaChceFaktury, ikonaFaktury, odznakaSyncStatusu } from '../../domena/lista-ikony.js';
import { wiekZamowienia, czyEkspres, terminNaKarcie } from '../../domena/wiek-zamowienia.js';
import { kuponyZWiersza } from '../../domena/kupony.js';
import ejs from 'ejs';
import { join } from 'node:path';
import { TEMATY, NAZWA_TEMATU, czyWolnoWyslac, czyWolnoWyslacWlasny, stanTematu, ostatnieWgTematow } from '../../domena/wiadomosci.js';
import { fmtDataCzasKrotko } from '../../domena/format-daty.js';
import { wiadomosciZamowienia } from '../../oms/db/wiadomosci.js';
import { adresatKlienta } from '../../domena/adresat-klienta.js';
import { cennikDlaZamowienia, rozmiarDoPokazania, cenniki as zbudujCenniki } from '../../domena/magazyn-do-zamowienia.js';
import { szukajDoZamowienia, odczytKatalogu } from '../../oms/db/magazyn.js';
import { adresOdbiorcy, adresZeSklepu, POLA_ADRESU_RECZNE } from '../../domena/adres-odbiorcy.js';
import { daneFaktury, firmaNabywcy } from '../../domena/dane-faktury.js';
import { roznice } from '../../domena/dane-reczne.js';
import { wczytajUstawienia } from '../../oms/db/ustawienia.js';
import { kwotyDostawy } from '../../domena/ustawienia-panelu.js';
import { wierszePozycji, podsumowaniePozycji, podsumowanieVatKarty } from '../../domena/tabela-pozycji.js';
import { czytajStawkeDomyslna } from '../faktury/db/stawka-vat.js';
import { brakiNaStanieZamowienia } from '../../oms/db/stany-zamowienia.js';
import { odnosnikPozycji } from '../../domena/link-pozycji.js';
import { sprawyKarty } from '../../domena/sprawy-karty.js';
import { wolnoWyslacDoAllegro } from '../../domena/allegro-faktura.js';
import { PRZY_ODBIORZE, BEZ_TERMINU, ZAPLACONE, TERMINY_DNI, ETYKIETY_TERMINU, terminFaktury } from '../../domena/termin-platnosci.js';
import { opisKlienta } from '../../domena/klient-staly.js';
import { RABAT_MAX } from '../../domena/rabat.js';
import { wszyscyKlienci, klientPoNip } from '../../oms/db/klienci.js';
import { rabatKontraktowy } from './services/rabat.js';
import { saldoWplat, platnoscPrzyOdbiorze, domyslnaKwotaWplaty } from '../../domena/platnosci.js';
import { dzienWarszawa } from '../../domena/format-daty.js';
import { zakresDatyWysylki } from '../../domena/termin-wysylki.js';
import { proponowanaDataSprzedazy } from '../../domena/data-sprzedazy.js';
import { STAWKI_VAT } from '../../domena/vat.js';
import { czyNipUe } from '../../domena/wdt.js';
import { kluczOkresu } from '../../domena/okres-rozliczeniowy.js';
import { wolnoPrzypisac } from '../../domena/zmiana-okresu.js';
import { umowaZbiorcza } from '../../domena/klient-zbiorczy.js';
import { pobierzOkres } from '../../oms/db/okresy.js';
import { idDokumentu } from '../../domena/dokument-programu.js';
import { MIESIACE } from '../../domena/okres-rozliczeniowy.js';
import { decyzjaScalenia, zamowienieGrupy } from '../../domena/scalanie.js';
import { dolaczoneZamowienia, zamowienieZGrupa } from '../../oms/db/scalenia.js';
import { odmianaNazwyProgramu, ekranProgramu } from '../../domena/nazwa-programu.js';
import { zdanieBrakuProgramu } from '../../domena/wybor-programu.js';
import {teraz,AKCJA_ALLEGRO_PROBA,allegroWymagaOdpytania,miniaturyEkranu,ktoKlikal,sprzedawcaSpecyfikacji,daneKarty,KATALOG_WIDOKOW,fragment} from './wspolne.js';
export function createKontekstZamowien(opcje) {
const {
  db, config = {}, poller, nadanie, faktura, proforma = null, kurierzy = {}, gus = null, syncSklep = null,
  // ⚠️ WSZYSTKIE MAILE DO KLIENTA Z KARTY (services/wiadomosci.js, 22.08.2026) — sekcja
  // „Wiadomosci" na dole karty i trasa POST /zamowienia/:id/wiadomosc/:temat. `null` (panel
  // bez skonfigurowanej poczty) to tryb POPRAWNY: sekcja sie nie renderuje, a trasa odmawia
  // wprost 503. Ta sama zasada, co przy `faktura`, `gus` i `fakturaAllegro`.
  //
  // ⚠️ USLUGI `potwierdzenie` TE TRASY JUZ NIE BIORA (22.08.2026, sprzatanie po recenzji
  // calosci galezi). Potwierdzenie przyjecia zamowienia wysyla `services/wiadomosci.js`,
  // DELEGUJAC do `services/potwierdzenie.js` — a osierocony ekran `GET/POST
  // /zamowienia/:id/potwierdzenie` (bez ani jednego odnosnika po przenosinach paska na dol
  // karty) zniknal razem z widokiem `potwierdzenie-podglad.ejs`.
  wiadomosci = null,
  przesylkiAllegro = null,
  // Stan kanalow dla paska ostrzezenia (domain/kanal-stan.js). Funkcja, bo stan zmienia sie
  // miedzy zadaniami; `null` to panel bez kanalow Allegro.
  stanyKanalow = null,
  // Ocena zdrowia dla ostrzezen `integracja` — TA SAMA funkcja, ktora odpowiada czujce na
  // /health (sklada ja bootstrap.js). `null` to tryb POPRAWNY (stary sklad, testy): tabelka
  // pokazuje wtedy pozostale typy, a integracje po prostu milcza.
  zdrowie = null,
  // ⚠️ WYSYLKA PDF-U FAKTURY NA KONTO KUPUJACEGO W ALLEGRO (services/faktura-allegro.js).
  // `null` (panel bez zmiennych ALLEGRO_* albo bez inFaktu) to tryb POPRAWNY: karta nie
  // pokazuje przycisku, a trasa mowi wprost 503 — ta sama zasada, co przy `faktura` i `gus`.
  fakturaAllegro = null,
  // ⚠️ WYSTAWIANIE FAKTUR HURTEM (services/faktura-hurtem.js), a nie usluga `faktura`:
  // hurt ma wlasny BUDZET CZASU i wlasna kolejnosc, a trasa nie ma prawa skladac tego u
  // siebie. `null` (panel bez inFaktu) to tryb POPRAWNY — trasa odmawia wtedy czytelnie
  // (503), dokladnie jak nadanie bez skonfigurowanego kuriera.
  fakturaHurtem = null,
  doczytanieKsef = null,
  // PRZ-102.23: przycisk „Wyślij do KSeF” przy fakturze na karcie prowadzi do podglądu tej usługi
  // (POST /faktury/ksef/podglad). `null` (panel bez inFaktu) = bez przycisku — podgląd i tak odda 503.
  wysylkaKsef = null,
  // PRZ-118.09: usługa `infakt` modułu faktur (surowy klient inFaktu albo program fakturowy; `null` = panel bez
  // programu) — WYŁĄCZNIE do zdań na karcie (nazwa, ekran programu) i reguły VAT podsumowania (`opis.regulaVat`).
  infakt = null,
  // PRZ-121.03b: wybór modułu faktur (usługa `faktury.wyborProgramu`; `null` = bez modułu faktur). Tylko do zdania "zdanieBraku".
  wyborProgramu = null,
}=opcje;
const nazwaProgramu = odmianaNazwyProgramu(infakt);
// Reguła VAT programu; obiekt bez opisu (surowy klient inFaktu, mock) i brak programu = „wierszami”, jak przed zmianą.
const regulaVat = infakt?.opis?.regulaVat ?? 'wierszami';
// PRZ-108.02: usługa wiadomości powstaje także bez poczty (poczta z Ustawień może dojść po starcie) i mówi
// `gotowe()`, czy poczta jest TERAZ ustawiona. Pytamy przy każdym żądaniu: bez poczty = jak `null` wyżej.
const wiadomosciCzynne = () => (wiadomosci && wiadomosci.gotowe?.() !== false ? wiadomosci : null);
const powrotKarty =(req) => bezpiecznyPowrotNaListe(req.query?.powrot ?? req.body?.powrot, config.definicje, etykietyStatusow(db));
// Cenniki „Dodaj z magazynu" (PRZ-060): `OMS_CENNIKI` albo sklepy Woo z definicji kanałów.
// Składane RAZ, przy budowie tras — zła lista odmawia startu, a nie pierwszego telefonu.
const cennikiInstalacji = zbudujCenniki({ lista: config.cenniki ?? null, definicje: config.definicje ?? [] });
const adresPowrotuNaKarte = (req, id, opcje = {}) => adresKartyZamowienia(id, {
    powrot: powrotKarty(req),
    ...opcje,
  }, config.definicje);
// ⚠️ OD PRZ-051 LISTA NIE CZYTA CALEJ BAZY. `ids` — tylko te zamowienia (strona listy,
// zaznaczenie akcji masowej), w porzadku listy; bez `ids` dawny komplet (zostal dla wolajacych,
// ktorzy naprawde potrzebuja wszystkiego). Liczniki zakladek i wybor strony daje indeks listy
// (oms/db/indeks-listy.js), a ten wiersz liczy TE SAME funkcje, z ktorych indeks bierze odpowiedzi.
//
// `bezSurowych` — strona listy nie czyta `surowe_json`; akcje masowe tak (nadanie InPost).
// `pomijajUszkodzone` — strona listy pomija wiersz, ktorego nie da sie odczytac albo policzyc,
// i oddaje go przez `naPominiete(z)` (lista nazywa go z numerem); akcje masowe i karta zostaja
// przy dawnej odmowie.
const wczytajListe = (ids, { teraz = new Date(), bezSurowych = false, pomijajUszkodzone = false, naPominiete = () => {} } = {}) => {
    // ⚠️ JEDNO „teraz" NA CALY RENDER (recenzja galezi, FIX 6) — liczone RAZ, przed `.map`,
    // a nie osobno w kazdym wierszu. Dwa wiersze zegara wieku licza sie wzgledem TEJ SAMEJ
    // chwili: osobne `new Date()` na wiersz moglyby na styku sekundy/doby oddac dwoch
    // sasiadow w tabeli inny dzien albo inny stan „po terminie" dla identycznego zamowienia.
    // Od PRZ-051 te sama chwile dostaje `doZrobienia` i indeks listy (trasa podaje ja z gory).
    const zamowienia = ids === undefined ? listaZamowien(db) : zamowieniaPoId(db, ids, { bezSurowych, naBlad: pomijajUszkodzone ? (w) => naPominiete(w) : null });
    const dekoruj = (z) => ({
      ...z,
      status: wyliczStatus(z),
      robocze: doZrobienia(z, teraz.getTime()),
      stanFaktury: stanFaktury(z.faktura, teraz.getTime()),
      // Widok NIE liczy sam, ktore sprawy przy przesylce sa nierozwiazane — to decyzja
      // domenowa i ma brzmiec tak samo tu, co na karcie. Bez tych odznak zamowienie
      // wracalo na liste robocza (doZrobienia) bez ANI SLOWA o tym, dlaczego tam jest.
      // Liczone po WSZYSTKICH paczkach — sprawa drugiej paczki musi byc widoczna
      // dokladnie tak samo jak sprawa pierwszej (patrz sprawyZamowienia).
      sprawyPrzesylki: sprawyZamowienia(z.przesylki, teraz.getTime()),
      anulowaneZUwaga: anulowaneWymagaUwagi(z),
      // PRZ-101.04 (recenzja, W3): powód, dla którego główne grupy wraca na „Do zrobienia”.
      uwagaDolaczonych: uwagaDolaczonychAnulowanych(z),
      // Kanal sprzedazy do wyswietlenia — z kolumny `sklep`, NIGDY zaszyty na sztywno
      // w widoku (brief zadania „strona glowna": kolejne kanaly dojda).
      kanalSprzedazy: adresKanalu(z.sklep, config.definicje),
      // Rodzaj kanału (Allegro / WooCommerce) do plakietki w kolorze marki — z `typ` definicji, NIE z nazwy
      // sklepu (PRZ-094.17). `null` = kanał bez marki (ręczne, indywidualne), wtedy bez plakietki.
      rodzajKanalu: rodzajKanalu(z.sklep, config.definicje),
      // Kolumna „Klient” (PRZ-094.19): osoba, firma i — tylko w Allegro — login kupującego. Z bloku `klient`
      // wiersza, bez `surowe_json` (domena/klient-listy.js). Rodzaj liczony drugi raz, bo obiekt wyżej jeszcze nie istnieje.
      klientListy: klientListy(z.klient, rodzajKanalu(z.sklep, config.definicje)),
      // Przewoźnik z TEJ SAMEJ funkcji, co logo i filtr w zakładce Przesyłki (domena/przewoznik-przesylki.js),
      // liczony po nazwie i metodzie dostawy WIERSZA — tej samej, którą kolumna „Dostawa” wypisuje obok.
      przewoznikListy: przewoznikWiersza(null, z),
      // Etykieta odznaki „Indywidualne" w wierszu. Sklada ja TA SAMA funkcja, co nazwe
      // pozycji w polu wyboru filtra i w panelu bocznym — widok nie wpisuje jej u siebie.
      etykietaIndywidualnego: adresKanalu('indywidualne', config.definicje),
      // Znacznik zamowienia z panelu indywidualnego — Z KOLUMNY, nie liczony tu drugi raz
      // z `surowe_json` (tym zajmuje sie poller i przeliczenie wstecz w db/db.js).
      // Kolumna jest INTEGER, wiec sprowadzamy ja do boolean: filtr kanalu i licznik panelu
      // pytaja o PRAWDE, a nie o 0/1, i nie maja prawa rozjechac sie na tym, ktore z nich
      // zapomni o rzutowaniu.
      indywidualne: Boolean(z.indywidualne),
      // Cztery ikony wiersza (brief, punkt C). Widok NIE liczy niczego sam — ta sama
      // zasada, co przy stanie przesylki i fakturze wyzej: kazda ikona to DECYZJA
      // DOMENOWA (domain/lista-ikony.js), zeby lista i ewentualne inne miejsce, ktore
      // kiedys zechce tego samego skrotu, nie mogly sie rozjechac.
      // Kolumna „Kwota" pokazuje KWOTE OCZEKIWANA OD KLIENTA (ze sklepu + dopisane recznie),
      // a nie samo `kwota_brutto`. Lista jest ekranem, na ktory operator patrzy pierwszy —
      // kwota sklepowa przy zamowieniu z doplata znaczylaby, ze panel zanizza tu dlug klienta
      // dokladnie w miejscu, w ktorym najlatwiej to przeoczyc. Liczy to domena
      // (podsumowaniePozycji), ktora NIGDY nie rzuca: uszkodzona kwota nie ma prawa wywalic
      // listy, a wtedy pokazuje sie wartosc ze sklepu.
      kwotaOczekiwanaZl: podsumowaniePozycji(z).oczekiwanaZl,
      // Kupony sklepu pod kwota (kampania WRZESIEN30) — plakietka w kolumnie „Kwota",
      // bo kupon jest faktem PIENIEZNYM i tam operator go szuka. Nie w komorce numeru:
      // znacznik EKSPRES juz raz rozepchnal tamta kolumne (przewodnik 4.61).
      kupony: kuponyZWiersza(z.kupony_json),
      // Zegar wieku i terminu (domain/wiek-zamowienia.js) — jak ikony: widok dostaje
      // GOTOWE napisy i flagę, niczego nie liczy sam. `null` = zegar nie dotyczy
      // (wysłane/anulowane). Znacznik EKSPRES osobno, bo żyje dłużej niż zegar.
      zegar: wiekZamowienia(z, teraz),
      ekspres: czyEkspres(z.pozycje),
      ikonaPlatnosci: ikonaPlatnosci(z),
      ikonaPrzesylki: ikonaPrzesylki(z),
      ikonaChceFaktury: ikonaChceFaktury(z),
      ikonaFaktury: ikonaFaktury(z),
      // Status, ktory nie dojechal do sklepu/Allegro (K1). Od tej samej zmiany taki slad
      // trzyma zamowienie na liscie roboczej (doZrobienia), wiec musi miec na tej liscie
      // WIDOCZNY powod — inaczej zamowienie wraca i nie wiadomo po co.
      odznakaSync: odznakaSyncStatusu(z),
      // ⚠️ Odznaka zwrotu (Zadanie 5, spec §4.4): NIE „ma zwrot" (to juz mowi kolorowa
      // pastylka statusu — `wyliczStatus` oddaje 'zwrot' na zawsze, gdy `z.ma_zwrot`, wiec
      // druga plakietka z tym samym slowem obok byla by czystym powtorzeniem). Ta odznaka
      // niesie NOWA informacje: zwrot jest jeszcze NIEROZLICZONY (pieniadze nieoddane albo
      // brak korekty), czyli DOKLADNIE powod, dla ktorego `doZrobienia` (domain/status.js)
      // trzyma to zamowienie na liscie roboczej mimo koncowego statusu. Ta sama funkcja
      // `podsumowanieZwrotow`, co na karcie — jedno miejsce liczy `nierozliczonych`.
      zwrotPodsumowanie: podsumowanieZwrotow(z),
    });
    if (!pomijajUszkodzone) return zamowienia.map(dekoruj);
    return zamowienia.flatMap((z) => {
      try { return [dekoruj(z)]; } catch { naPominiete(z); return []; }
    });
  };
// Kolumna boczna karty — TE SAME liczniki, co na liscie: z indeksu listy (PRZ-051), a nie
// z przeczytania calej bazy przy kazdym otwarciu karty.
const statusyDlaKarty = async (z, req = null) => {
    // ⚠️ BEZ LICZB, gdy indeks sie nie odswiezyl (pelny dysk, baza tylko do odczytu): liczba
    // sprzed zapisu, ktory nie doszedl, twierdzilaby cos, czego nie ma — brak liczby niczego
    // nie twierdzi, a karta i tak ma sie otworzyc (ta sama zasada, co odswiezanie kuriera).
    let l = null;
    try {
      const teraz = Date.now();
      const indeks = indeksListy(db);
      await indeks.odswiez(teraz);
      l = indeks.liczniki(teraz);
    } catch (e) { req?.log?.error?.(e, 'indeks listy: liczniki karty niepoliczone'); }
    const status = wyliczStatus(z);
    return [
      { klucz: 'do_zrobienia', etykieta: 'Do zrobienia', liczba: l?.do_zrobienia, href: '/', aktywna: false },
      { klucz: 'wszystkie', etykieta: 'Wszystkie', liczba: l?.wszystkie, href: '/?wszystkie=1', aktywna: false },
      ...Object.keys(etykietyStatusow(db)).map((klucz) => ({
        klucz,
        etykieta: etykietyStatusow(db)[klucz],
        liczba: l?.statusy[klucz],
        href: `/?status=${klucz}`,
        aktywna: klucz === status,
      })),
    ];
  };
const OKNO_OSTRZEZEN_PRZESYLEK_DNI = 60;
function zbierzOstrzezenia(req) {
    try {
      const teraz = new Date();
      const odIso = new Date(teraz.getTime() - OKNO_OSTRZEZEN_PRZESYLEK_DNI * 24 * 3600 * 1000).toISOString();
      // Numer zamowienia czyta sie LENIWIE — tylko dla paczki, ktora naprawde stoi i trafia do
      // ostrzezenia (PRZ-051). Mapa calej tabeli kosztowala 32–56 ms przy 15 000 zamowien,
      // a mapa calego okna 60 dni — 70 ms przy 28 000 paczek; stojacych paczek jest kilka.
      const przesylki = przesylkiDoSledzenia(db, odIso);
      const znane = new Map();
      const numery = { get: (id) => {
        if (!znane.has(id)) znane.set(id, numeryZamowien(db, [id])[0]);
        return znane.get(id);
      } };
      const dzis = dzienWarszawa(teraz.toISOString());
      const wiersze = [
        ...ostrzezeniaIntegracji({ zdrowie: zdrowie?.() ?? null }),
        ...ostrzezeniaFaktur({ luki: lukiKsef(db), dzis }),
        // PRZ-102.12: kłopot ostatniego przebiegu automatu KSeF (błąd, przerwany, „nie wiadomo”, pominięte).
        ...(() => { const a = wczytajAutomatKsef(db); return ostrzezeniaAutomatuKsef({ wynik: a.wynik, wstrzymane: a.wstrzymane, nazwa: nazwaProgramu }); })(),
        // PRZ-108.08: reguła automatyzacji wstrzymana albo niepewna wysyłka maila — tylko administrator (reguły i ich
        // dziennik są w Ustawieniach, dostępnych wyłącznie dla niego).
        ...(req?.konto?.admin ? ostrzezeniaAutomatyzacji({ reguly: regulyDoOstrzezen(db,
          new Date(teraz.getTime() - 7 * 24 * 3600 * 1000).toISOString()) }) : []),
        ...ostrzezeniaTerminow({ poTerminie: poTerminie(db) }),
        ...ostrzezeniaZwrotow({ zwroty: zwrotyBezKorekty(db), dzis }),
        ...ostrzezeniaPobran({ pobrania: pobraniaBezGotowki(db) }),
        ...ostrzezeniaPrzesylek({ przesylki, zamowienia: numery, teraz }),
        ...ostrzezeniaWiadomosci({ watki: listaWatkow(db), teraz }),
      ];
      // PRZ-102.04: najpierw prawa konta (wiersz bez prawa do ekranu przycisku = 403 po kliku).
      return zlozOstrzezenia({ wiersze: ostrzezeniaDlaKonta({ wiersze, konto: req?.konto ?? null }), odrzucone: odrzucenia(db), teraz, ukryteTypy: ukryteTypyKonta(db, req?.konto?.id) });
    } catch (e) {
      req?.log?.error?.(e, 'ostrzeżenia strony głównej nie policzyły się');
      return [];
    }
  }
function wyborWiadomosci(req) {
    const wybor = String(req.query?.wiadomosc ?? '').trim();
    return {
      wybor,
      // 'spoczynek' | 'wybor' | 'podglad'
      stan: wybor === '' ? 'spoczynek' : (wybor === 'nowa' ? 'wybor' : 'podglad'),
      // ⚠️ `wybrany` to WYLACZNIE prawdziwy temat. Adres z nieznana wartoscia zostaje w stanie
      // „podglad" i dostaje POWOD z uslugi („Nie ma takiego tematu wiadomosci."), ale nie
      // udaje wybranego tematu — inaczej formularz wysylki celowalby w nieistniejaca trase.
      // PRZ-101.03: albo istniejący szablon własny (`wlasny-N`) — usunięty w międzyczasie już nim nie jest.
      wybrany: TEMATY.includes(wybor) || tematyWlasne().some((t) => t.id === wybor) ? wybor : null,
    };
  }
// Szablony własne z Ustawień → Szablony wiadomości (PRZ-101.03); panel bez poczty albo stara usługa = brak.
function tematyWlasne() {
    return wiadomosciCzynne()?.tematyWlasne?.() ?? [];
  }
function daneWiadomosci(req, z, dodatki = {}) {
    const uslugaWiadomosci = wiadomosciCzynne();
    if (!uslugaWiadomosci) return { wiadomosciSekcja: null };

    // ⚠️ JEDEN OBIEKT ZAMOWIENIA NA CALA SEKCJE — `k.z`, ten sam, na ktorym usluga rozstrzyga
    // zgode i sklada maila (poprawka 22.08.2026). Do tej pory adresat brał sie z obiektu
    // trasy, a zgoda i stan tematu z odczytanego tutaj ponownie: dwa zrodla w jednym pasku,
    // z ktorych kazde mogloby opisywac inny stan zamowienia.
    const k = uslugaWiadomosci.kontekst(z.id);
    const { stan, wybrany } = wyborWiadomosci(req);

    // ⚠️⚠️ REZERWA ZA STARĄ KOLUMNĘ `zamowienia.potwierdzenie_wyslane_at` (ZNALEZISKO RECENZJI
    // CAŁOŚCI GAŁĘZI, 22.08.2026 — styk trasy i schematu bazy). `schema.sql` obiecuje wprost:
    // kolumna „ZOSTAJE i dalej jest zapisywana […] karta ma mówić prawdę także o mailach
    // wysłanych PRZED powstaniem rejestru" — rejestr `wiadomosci` istnieje dopiero od
    // 22.08.2026. Zamówienie potwierdzone WCZEŚNIEJ (np. 21.08) nie ma w nim ani jednego
    // wiersza tematu „potwierdzenie", choć mail naprawdę poszedł (kolumna to pamięta). Bez tej
    // rezerwy karta takiego zamówienia kłamała na TRZY sposoby naraz: ekran wyboru pokazywał
    // „jeszcze nie wysłane", ekran podglądu nie pokazywał paska „Ta wiadomość poszła już…",
    // a przycisk mówił „Wyślij" zamiast „Wyślij ponownie" — czyli znikał JEDYNY hamulec przed
    // wysłaniem klientowi DRUGIEGO potwierdzenia, a maila nie da się cofnąć.
    //
    // ⚠️ REJESTR MA PIERWSZEŃSTWO: rezerwa dokłada się WYŁĄCZNIE wtedy, gdy w rejestrze nie ma
    // ani jednego wiersza tego tematu — od dnia powstania rejestru każde potwierdzenie zapisuje
    // się TAM (services/potwierdzenie.js), więc kolumna i rejestr nigdy się nie przeczą,
    // kolumna jest po prostu starsza o kilka dni.
    //
    // Rezerwę będzie można usunąć, gdy nie zostanie już ani jedno zamówienie potwierdzone przed
    // powstaniem rejestru — w praktyce dla danych tego panelu nigdy, ale to nie szkodzi:
    // kolumna zostaje w schema.sql (patrz komentarz tam), przestaje tylko mieć czytelnika.
    const zRejestru = wiadomosciZamowienia(db, k.z.id);
    const rezerwaPotwierdzenia = !zRejestru.some((w) => w.temat_id === 'potwierdzenie')
      && k.z.potwierdzenie_wyslane_at
      ? { temat_id: 'potwierdzenie', adresat: adresatKlienta(k.z), wyslana_at: k.z.potwierdzenie_wyslane_at }
      : null;
    const lista = rezerwaPotwierdzenia ? [rezerwaPotwierdzenia, ...zRejestru] : zRejestru;

    // ⚠️ „KIEDY TEN TEMAT POSZEDŁ OSTATNIO" — POLICZONE RAZ, Z LISTY, KTÓRĄ I TAK MAMY.
    // Do 22.08.2026 stały tu CZTERY osobne zapytania `ostatniaWiadomosc` (po jednym na temat),
    // a widok karty liczył to samo PO RAZ PIĄTY, po `w.lista`, z własną — i inną — regułą
    // („ostatni pasujący element listy" zamiast „największe id"). Karta otwiera się
    // kilkadziesiąt razy dziennie, a dwie reguły na jedno pytanie rozjeżdżają się przy
    // pierwszej zmianie sortowania. Reguła mieszka teraz w domenie: `ostatnieWgTematow`.
    const ostatnie = ostatnieWgTematow(lista);

    const tematy = TEMATY.map((temat_id) => ({
      id: temat_id,
      nazwa: NAZWA_TEMATU[temat_id],
      zgoda: czyWolnoWyslac(k.z, temat_id, k),
      stan: stanTematu(k.z, temat_id, { ...k, ostatnia: ostatnie.get(temat_id) ?? null, nazwaProgramu }),
    }));
    // PRZ-101.03: szablony własne — ta sama lista, ten sam podgląd, ta sama wysyłka i to samo ostrzeżenie
    // „Ta wiadomość poszła już…" (rejestr `wiadomosci` z temat_id = `wlasny-N`).
    for (const { id, nazwa } of tematyWlasne()) {
      const zgoda = czyWolnoWyslacWlasny(k.z);
      const ostatnia = ostatnie.get(id);
      tematy.push({ id, nazwa, wlasny: true, zgoda, stan: !zgoda.wolno ? zgoda.powod
        : ostatnia ? `wysłane ${fmtDataCzasKrotko(ostatnia.wyslana_at)} — pójdzie ponownie` : 'szablon własny' });
    }

    return {
      wiadomosciSekcja: {
        stan,
        tematy,
        lista,
        adresat: adresatKlienta(k.z),
        wybrany,
        // ⚠️ DLA WIDOKU: pasek „Ta wiadomość poszła już…" i etykieta „Wyślij ponownie" mają
        // czytać TĘ wartość, a nie liczyć własnej z `lista` (patrz komentarz przy `ostatnie`).
        ostatnia: wybrany ? (ostatnie.get(wybrany) ?? null) : null,
        // ⚠️ PODGLAD PRZYCHODZI W `dodatki`, A NIE LICZY SIE TUTAJ. Przy fakturze wymaga
        // zapytania do inFaktu (PDF na swiezo), czyli I/O — a `renderujKarte` jest
        // SYNCHRONICZNA i ma taka zostac. Dociaga go trasa karty, zanim ja zawola;
        // `dodatki` to dokladnie ta polka („rzeczy, ktorych w bazie jeszcze nie ma").
        podglad: dodatki.wiadomosciPodglad ?? null,
        blad: dodatki.wiadomosciBlad ?? null,
      },
    };
  }
// PRZ-101.04: sekcja „Zamówienie scalone” na karcie GŁÓWNEGO — pozycje całej grupy w jednej
// tabeli, wysyłka wg decyzji i suma grupy. Liczy TA SAMA funkcja, co faktura (`zamowienieGrupy`),
// więc karta pokazuje dokładnie to, co pojedzie na dokument. Uszkodzona kwota członka nie ma
// prawa wywrócić karty — sekcja mówi wtedy wprost, że sumy nie da się policzyć.
function scalenieKarty(z) {
  const decyzja = decyzjaScalenia(z);
  if (!decyzja) return null;
  const dolaczone = dolaczoneZamowienia(db, z);
  let grupa = null;
  try { grupa = zamowienieGrupy(z, dolaczone); } catch { grupa = null; }
  // Wpłaty grupy i saldo grupy liczy `platnosciKarty` niżej (PRZ-101.11) — sekcja „Płatności”.
  return {
    wysylka: decyzja.wysylka,
    dolaczone: dolaczone.map((d) => ({
      id: d.id, numer: d.numer, sklep: adresKanalu(d.sklep, config.definicje ?? []), anulowane: Boolean(d.anulowane),
    })),
    // Recenzja, W3: dołączone anulowane w sklepie — ta sama reguła, co lista robocza i nadanie.
    uwagaDolaczonych: uwagaDolaczonychAnulowanych(z),
    razem: grupa?.kwota_brutto ?? null,
    // Ta sama reguła, co odmowa w `rozdzielZamowienia` — przycisk tylko tam, gdzie zadziała.
    mozeRozdzielic: !z.faktura && !z.wyslane_at && !(z.przesylki ?? []).length,
    maFakture: Boolean(z.faktura),
  };
}

// Pozycje karty głównego: zamówienie grupy (`zamowienieZGrupa`). Uszkodzona kwota członka nie ma
// prawa wywrócić karty — wtedy panel „Pozycje” pokazuje samo główne, a sekcja scalenia mówi o błędzie.
function zKartyZGrupa(z) {
  try { return zamowienieZGrupa(db, z); } catch { return z; }
}

// PRZ-101.11 (właściciel 19.10: „jeżeli oba zamówienia były opłacone, to obie wpłaty powinny pojawić się
// na liście wpłat”): sekcja „Płatności” głównego pokazuje wpłaty CAŁEJ grupy, a saldo liczy z kwoty
// grupy (ta sama `zamowienieGrupy`, co faktura). Wpłaty zostają w bazie przy SWOICH zamówieniach —
// `zZamowienia` to numer dołączonego (dopisek „zam. N”), `null` przy wpłacie głównego.
function platnosciKarty(z) {
  const g = zKartyZGrupa(z);
  if (!g?.grupa) return { doSalda: z, wplaty: z.platnosci.map((w) => ({ ...w, zZamowienia: null })) };
  const numery = new Map(g.grupa.czlonkowie.map((c) => [c.id, c.numer]));
  const wplaty = [...g.platnosci]
    .sort((a, b) => String(a.data ?? '').localeCompare(String(b.data ?? '')))
    .map((w) => ({ ...w, zZamowienia: w.zamowienie_id === z.id ? null : (numery.get(w.zamowienie_id) ?? null) }));
  return { doSalda: g, wplaty };
}

async function renderujKarte(req, reply, z, dodatki = {}) {
  // Liczniki kolumny bocznej czekaja na indeks listy (PRZ-051) — stad funkcja asynchroniczna;
  // wszyscy wolajacy i tak oddaja jej wynik z trasy asynchronicznej.
  const panelStatusow = await statusyDlaKarty(z, req);
  // Widok NIE liczy niczego sam — kazda decyzja domenowa (stan przesylki, sprawy do
  // zalatwienia, stan kolejki druku, link do sledzenia) jest policzona TUTAJ i ma brzmiec
  // tak samo na karcie, na liscie roboczej i przy kolizji w bazie. Przy wielu paczkach
  // dochodzi to samo raz na paczke, a nie raz na zamowienie.
  const paczki = z.przesylki.map((p) => ({
    p,
    stan: stanPrzesylki(p),
    link: linkDoSledzenia(p.kurier, p.numer_listu),
    // Przycisk „zalatwione recznie" ma sie pokazywac WYLACZNIE wtedy, gdy jest co zdjac
    // — inaczej kusilby operatora akcja, ktora i tak odbije sie od 400.
    mozliwaSprawa: sprawyDoZalatwieniaRecznie(p).length > 0,
    // Czy numer listu PRZEPISAL CZLOWIEK — czyli czy moze byc w nim literowka. Steruje
    // znacznikiem przy paczce I przyciskiem kasowania, a liczy to TA SAMA funkcja, ktora
    // rozstrzyga odmowe w bazie (skasujPrzesylkeReczna). Widok nie ma prawa liczyc tego sam
    // po `kurier`: 'allegro' niesie i wpis reczny, i numer odczytany z API (poprawka I-1).
    wpisanaZReki: numerWpisanyZReki(p),
    // Stan przycisku „Drukuj" / „Porzuć" — WYŁĄCZNIE najnowszy wiersz kolejki druku dla
    // TEJ przesyłki (starsze wiersze to historia po ewentualnym reprincie).
    ostatniaPozycjaKolejki: ostatniaPozycjaDlaPrzesylki(db, p.id),
    // ⚠️ „Ukryj" WYLACZNIE przy paczce, do ktorej nadano juz kolejna (04.09.2026) — regula
    // liczona w domenie, bo widok nie ma prawa jej powtarzac. Uzasadnienie „opcja, nie
    // automat" stoi przy `mozliweUkrycie` (domain/przesylka-stan.js).
    mozliweUkrycie: mozliweUkrycie(p, z.przesylki),
    ukryta: przesylkaUkryta(p),
  }));

  // Zadanie B: karta jest domyslnie TYLKO DO ODCZYTU — formularz danych klienta pojawia
  // sie WYLACZNIE po kliknieciu „Edytuj" przy danej sekcji, osobno dla wysylki i osobno
  // dla faktury, sterowane parametrem adresu (bez JavaScriptu, zgodnie z reszta panelu).
  //
  // ⚠️ Porownanie z JEDNA wartoscia stringa, a nie np. dwoma niezaleznymi flagami: dzieki
  // temu tryb edycji jednej sekcji z DEFINICJI nie moze otworzyc drugiej — string rowna
  // sie najwyzej jednej z dwoch nazw naraz. Powtorzony klucz w adresie (?edytuj=a&edytuj=b)
  // Fastify oddaje jako tablice, wiec `typeof === 'string'` odrzuca go tak samo jak
  // nieznana wartosc — obie sekcje wracaja do odczytu.
  const edytujParam = typeof req.query?.edytuj === 'string' ? req.query.edytuj : null;
  const edytujWysylka = edytujParam === 'wysylka';
  const edytujFaktura = edytujParam === 'faktura';
  // Trzeci rodzaj edycji: JEDNA pozycja, wskazana kluczem (`pozycja-s4321`). Ten sam
  // parametr i ta sama zasada, co wyzej — string rowna sie najwyzej jednej wartosci, wiec
  // otwarcie edycji pozycji Z DEFINICJI nie moze otworzyc naraz danych klienta ani drugiej
  // pozycji. Nieznany klucz po prostu niczego nie otwiera (karta zostaje do odczytu).
  const edytujPozycje = edytujParam?.startsWith('pozycja-') ? edytujParam.slice('pozycja-'.length) : null;
  // Czwarty rodzaj edycji (przebudowa karty 2026-07-31): CALY panel pozycji naraz.
  // Ten sam parametr, wiec z definicji nie otwiera sie razem z zadnym innym trybem.
  const edytujWszystkiePozycje = edytujParam === 'pozycje';
  // Sekcja „Szczegoly" (status + metoda wysylki) — do tej pory oba formularze staly
  // rozwiniete na karcie; teraz chowaja sie za „Edytuj" tak samo, jak reszta.
  const edytujSzczegoly = edytujParam === 'szczegoly';
  const edytujWplata = edytujParam === 'wplata';

  // HISTORIA ZMIAN (PRZ-094.18) — sekcja na samym dole karty, DOMYSLNIE ZWINIETA.
  // ⚠️⚠️ ZWINIETA = ZERO ZAPYTAN DO `log`. Tabela nie ma indeksu po `zamowienie_id`, wiec
  // nawet samo policzenie wpisow to pelny skan przy kazdym otwarciu karty. Odczyt idzie
  // WYLACZNIE za `?historia=N` (N = numer strony, od 1); wszystko inne — brak parametru,
  // `abc`, `0`, `-1`, ulamek, szesc cyfr w gore, powtorzony klucz (tablica) — zostawia
  // sekcje zwinieta. Ta sama zasada „jedna wartosc tekstowa albo nic" co przy `?edytuj=`.
  const stronaHistorii = typeof req.query?.historia === 'string' && /^[1-9]\d{0,5}$/u.test(req.query.historia)
    ? Number(req.query.historia) : null;
  const historia = stronaHistorii ? { strona: stronaHistorii, ...historiaLogu(db, z.id, { strona: stronaHistorii }) } : null;

  // Zadanie 7 (proforma): widok NIE liczy niczego sam — ta sama zasada, co przy kazdej
  // innej decyzji domenowej na tej karcie. Lista jest HISTORIA (najstarsze pierwsze,
  // db/proformy.js), a „ktora jest aktualna" i „czy w ogole wolno wystawic kolejna"
  // licza sie TU, jedna funkcja na jedno pytanie (domain/proforma-stan.js), zeby karta
  // i serwis (services/proforma.js) nie mogly kiedys odpowiedziec na nie inaczej.
  const listaProform = proformyZamowienia(db, z.id);
  const proformaAktualna = aktualnaProforma(listaProform);

  // Zadanie 6 (plan 2026-08-04-oms-faktura-data-sprzedazy-i-zaplacone): propozycja daty
  // sprzedazy i domyslny wybor terminu na fakture — obie decyzje domenowe, licza sie TU,
  // ta sama zasada co wyzej (proforma) i wszedzie indziej na tej karcie.
  const propozycjaSprzedazy = proponowanaDataSprzedazy(z);
  // Kolejnosc jest ISTOTNA i CELOWA:
  //   1. Zamowienie z PELNYM pokryciem wplat (`podstawa === 'zaplata'`) → „zaplacone",
  //      NAWET gdy jest tez za pobraniem (np. doplacone przelewem przed wysylka) —
  //      klient juz zaplacil, wiec dokument ma to mowic, a nie termin do pobrania.
  //   2. W przeciwnym razie zamowienie za pobraniem (wartosc EFEKTYWNA po recznych
  //      korektach, `platnoscPrzyOdbiorze` — TA SAMA funkcja co pasek Szczegolow nizej)
  //      → „przy odbiorze".
  //   3. Pozostale → 14 dni, jak dotychczas.
  //   4. NOWE (21.08.2026): uzgodnienie zapisane PRZY ZAMOWIENIU zastepuje zapasowe „14 dni"
  //      — i wylacznie je. Regula siedzi w domenie (`terminFaktury`), bo o kolejnosci tych
  //      czterech przypadkow nie ma prawa rozstrzygac ani widok, ani trasa.
  const platnosci = platnosciKarty(z);
  const domyslnyTermin = terminFaktury({
    zaplacone: propozycjaSprzedazy.podstawa === 'zaplata',
    pobranie: platnoscPrzyOdbiorze(z),
    terminZamowienia: z.termin_platnosci,
  });
  const okresZamowienia = z.okres_rozliczeniowy_id ? pobierzOkres(db, z.okres_rozliczeniowy_id) : null;

  // Bez tej flagi widok kusil przyciskiem „Wystaw fakturę" takze wtedy, gdy inFakt
  // nie jest w ogole skonfigurowany — klikniecie konczylo sie 503 bez wyjasnienia.
  return reply.view('zamowienie.ejs', {
    title: `Zamówienie ${z.numer}`,
    // PRZ-101.05: plakietka przewoźnika przy metodzie wysyłki — to samo rozpoznanie co `przewoznikListy` na liście
    // (domena/przewoznik-przesylki.js, po nazwie i metodzie dostawy zamówienia); `null` = bez plakietki.
    przewoznikKarty: przewoznikWiersza(null, z),
    // PRZ-104: wiersz „Termin wysyłki” w Szczegółach — napisy z domeny (wiek-zamowienia.js), ta sama
    // miara spóźnienia co zegar listy i statystyki.
    terminWysylkiKarty: terminNaKarcie(z, new Date()),
    // PRZ-091: karty produktów na minusie, które zdejmuje to zamówienie. Stany wyłączone / zamówienie anulowane = [].
    // Liczone TU, a nie w trasie GET, żeby każda odsłona karty (także po odmowie formularza) mówiła to samo.
    brakiNaStanie: brakiNaStanieZamowienia(db, z.id),
    scalenie: scalenieKarty(z),
    // N1: wynik „Odłącz anulowane” przy wystawionej fakturze grupy (trasa scalania renderuje kartę).
    komunikatScalenia: dodatki.komunikatScalenia ?? null,
    powrot: powrotKarty(req),
    adresPowrotu: adresPowrotuDoWiersza(powrotKarty(req), z.id, config.definicje),
    adresKarty: (stan = null, kotwica = null) => {
      const adres = adresPowrotuNaKarte(req, z.id, { stan, kotwica });
      // Bez kontekstu listy zachowujemy dotychczasowe względne linki wejścia w edycję.
      // Dzięki temu odświeżenie karty i stare zakładki mają identyczny adres jak wcześniej.
      return powrotKarty(req) === '/' && stan ? adres.slice(adres.indexOf('?')) : adres;
    },
    adresWiadomosci: (temat) => {
      const parametry = new URLSearchParams();
      const powrot = powrotKarty(req);
      if (powrot !== '/') parametry.set('powrot', powrot);
      parametry.set('wiadomosc', String(temat));
      const pytanie = `?${parametry.toString()}#wiadomosci`;
      return powrot === '/' ? pytanie : `/zamowienia/${encodeURIComponent(String(z.id))}${pytanie}`;
    },
    // Historia zmian: `strona` = numer strony do pokazania, `null` = „Zwin" (karta bez ?historia).
    // Kotwica #historia trzyma ekran przy sekcji po przeladowaniu. Powrot na liste zostaje w
    // kazdym odnosniku, tak jak przy wiadomosciach.
    adresHistorii: (strona) => {
      const parametry = new URLSearchParams();
      const powrot = powrotKarty(req);
      if (powrot !== '/') parametry.set('powrot', powrot);
      if (strona) parametry.set('historia', String(strona));
      const pytanie = parametry.size ? `?${parametry.toString()}` : '';
      return strona && powrot === '/' ? `${pytanie}#historia` : `/zamowienia/${encodeURIComponent(String(z.id))}${pytanie}#historia`;
    },
    historia,
    adresPodwidoku: (sciezka) => {
      const powrot = powrotKarty(req);
      const pytanie = powrot === '/' ? '' : `?${new URLSearchParams({ powrot }).toString()}`;
      return `/zamowienia/${encodeURIComponent(String(z.id))}/${sciezka}${pytanie}`;
    },
    // ⚠️ TU, NIE w `daneKarty`: tamta funkcja stoi POZA domknieciem trasy i nie widzi `db`
    // (pierwsza wersja probowala tam siegnac i karta oddawala 500 „db is not defined").
    // Liczy sie tylko NAJNOWSZY wiersz kolejki — starsze sa historia po powtorkach.
    drukFaktury: z.faktura ? ostatniaPozycjaDlaFaktury(db, z.faktura.id) : null,
    z, status: wyliczStatus(z), etykiety: etykietyStatusow(db), mozliwaFaktura: Boolean(faktura),
    // „Dodaj z magazynu" (21.08.2026) — wyszukiwarka lustra katalogow przy dopisywaniu
    // pozycji. `wyniki: null` znaczy „jeszcze nie szukano" i to CO INNEGO niz `[]`
    // („szukano, nie ma") — widok mowi wtedy dwie rozne rzeczy.
    magazyn: magazynDlaKarty(req, z),
    // ⚠️ `potwierdzenieMozliwe`/`potwierdzenieZgoda` USUNIĘTE STĄD (recenzja 22.08.2026,
    // Zadanie 10 — część B): liczyły się przy KAŻDYM otwarciu karty, a żaden szablon ich nie
    // czytał — potwierdzenie ma od 22.08 własny przycisk w sekcji „Wiadomości" niżej, sterowany
    // `wiadomosciSekcja`/`daneWiadomosci`. Stara trasa `GET/POST /zamowienia/:id/potwierdzenie`
    // razem z ekranem `potwierdzenie-podglad.ejs` ZNIKŁA (sprzątanie po recenzji całości
    // gałęzi): po przenosinach paska nie prowadził do niej ani jeden odnośnik w panelu, a
    // wysyłkę i tak robi `services/potwierdzenie.js`, wołana przez `services/wiadomosci.js`.
    // ——— SEKCJA „WIADOMOSCI" (22.08.2026) ————————————————————————————————————————————
    // ⚠️ STAN SIEDZI W ADRESIE (`?wiadomosc=`), nie w JavaScripcie — ten sam idiom, co
    // `?edytuj=` na tej karcie i `?nowy` na liscie klientow. „Wroc" w przegladarce
    // i odswiezenie robia wtedy to, czego czlowiek sie spodziewa, a karta w trybie odczytu
    // (otwierana kilkadziesiat razy dziennie) nie wozi ani jednej biblioteki.
    ...daneWiadomosci(req, z, dodatki),
    // ⚠️ NAZWY TEMATOW Z DOMENY, nigdy przepisane w szablonie: ten sam slownik nazywa temat
    // na ekranie wyboru, w liscie wyslanych i w logu karty (services/wiadomosci.js).
    // Idzie do widoku ZAWSZE, takze przy panelu bez poczty — sekcji wtedy nie ma, ale
    // brakujaca zmienna wywalilaby caly szablon, gdyby kiedys wyszla poza to `if`.
    nazwyTematow: { ...NAZWA_TEMATU, ...Object.fromEntries(tematyWlasne().map((t) => [t.id, t.nazwa])) },
    paczki, edytujWysylka, edytujFaktura, edytujPozycje, edytujWszystkiePozycje, edytujSzczegoly, edytujWplata,
    // ⚠️ TYLKO W TRYBIE EDYCJI POZYCJI — wyszukiwarka magazynu jest wylacznie tam, a karta
    // w trybie odczytu otwiera sie kilkadziesiat razy dziennie i nie ma powodu wozic z nia
    // biblioteki, ktorej nie uzyje.
    htmx: edytujWszystkiePozycje,
    // Zadanie 7: sekcja proformy stoi NAD sekcja faktury VAT (patrz zamowienie.ejs).
    // `mozliwaProforma` z TEGO SAMEGO powodu co `mozliwaFaktura` wyzej — usluga moze
    // nie byc podpieta (np. w testach innych sekcji karty), a przycisk nie ma prawa
    // kusic akcja, ktora zaraz odda 503 bez wyjasnienia.
    mozliwaProforma: Boolean(proforma),
    proformy: listaProform,
    proformaAktualnaId: proformaAktualna?.id ?? null,
    // `{ wolno, powod }` — gdy `wolno` jest falszywe, widok ma pokazac POWOD, nie sam
    // brak przycisku (brief zadania 7). Za pobraniem `wolno` jest PRAWDZIWE: to jest
    // OSTRZEZENIE, nie blokada, wiec siedzi osobno, nizej.
    zgodaProforma: czyWolnoWystawic(z),
    // ⚠️ Ważna proforma na INNA kwote niz zamowienie — ostrzezenie, nie blokada. Migawka
    // kwoty na dokumencie jest SLUSZNA (klient przeleje to, co ma na PDF-ie), wiec panel
    // nie ma czego „naprawiac" — ma tylko powiedziec, ze obowiazujacy dokument opiewa juz
    // na inna kwote, niz nam sie nalezy. Liczone TU, jak kazda inna decyzja domenowa karty.
    rozjazdProformy: rozjazdKwotyProformy(z, proformaAktualna),
    // Pasek „Do zalatwienia" — wszystkie sprawy zebrane W JEDNYM miejscu. Widok NIE liczy
    // ich sam (domain/sprawy-karty.js): kazda z nich rzadzi juz czyms innym (lista robocza,
    // bariera faktury, wyliczone `oplacone_at`), wiec druga kopia reguly rozjechalaby sie
    // przy pierwszej zmianie i pasek zaczalby klamac o tym, czy jest co robic.
    sprawy: sprawyKarty(z, Date.now(), { nazwa: nazwaProgramu }),
    // PRZ-118.09: nazwa i ekran programu fakturowego w zdaniach karty (bez programu — inFakt, jak dotąd).
    nazwaProgramu, ekranProgramu: ekranProgramu(infakt),
    // PRZ-121.03b: zdanie „faktury wyłączone” przy jawnym „brak” (plik albo Ustawienia); w innym razie `null` i widok
    // renderuje dotychczasowe akapity znak w znak.
    zdanieBraku: zdanieBrakuProgramu(wyborProgramu),
    // ⚠️ Czy to KANAL, liczone TU i TA SAMA funkcja co wszedzie indziej (`czyKanalAllegro`).
    // Widok potrzebuje tego do JEDNEJ rzeczy — brzmienia plakietki przy „Wyslij ponownie" —
    // ale wpisanie tam `z.sklep.startsWith('allegro_')` byloby CZWARTA kopia tego zdania,
    // tyle ze w EJS-ie, gdzie nie siega zaden test jednostkowy. Pasek spraw juz mowi
    // „nie dojechal do Allegro"; bez tej flagi karta twierdzilaby OBOK, ze „Sklep nie przyjal
    // statusu" — czyli jedna karta wskazywalaby dwa rozne miejsca usterki naraz.
    kanalAllegro: czyKanalAllegro(z),
    // ⚠️ CZY WOLNO WYSLAC FAKTURE NA KONTO KUPUJACEGO — liczone TU, jedna funkcja domenowa,
    // TA SAMA, ktora odmawia w usludze (services/faktura-allegro.js). Widok NIE ma prawa
    // liczyc tego sam: przycisk pokazany przy zamowieniu, ktore bariera i tak odrzuci,
    // kusi do klikania operacji NIEODWRACALNEJ, a przycisk schowany przy zamowieniu, ktore
    // wolno wyslac, zostawia czlowieka bez wyjscia.
    //
    // ⚠️ `{ wolno, powod }`, a nie sam boolean: gdy `wolno` jest falszywe, karta ma pokazac
    // POWOD (ta sama zasada, co przy `zgodaProforma` wyzej). Sam brak przycisku to stan bez
    // wyjscia — operator nie wie, czego brakuje, wiec albo grzebie w bazie, albo wysyla
    // fakture reka z inFaktu, poza wiedza panelu.
    zgodaFakturaAllegro: wolnoWyslacDoAllegro(z),
    // Czy usluga w ogole jest podpieta. Bez kanalu Allegro albo bez inFaktu przycisk
    // kusilby akcja konczaca sie 503 — ta sama zasada, co `mozliwaFaktura`/`mozliwyGus`.
    mozliwaFakturaAllegro: Boolean(fakturaAllegro),
    // Dane klienta w postaci, ktora panel uwaza za prawdziwa (reczne poprawki nalozone
    // na sklep) — TA SAMA funkcja, ktora czyta ekran nadania i fakturowanie. Widok nie
    // sklada tego sam z `z.klient`/`z.dostawa`: dwie kopie tej samej reguly rozjechalyby
    // sie przy pierwszej zmianie i karta zaczelaby operatorowi klamac.
    dane: daneKarty(z),
    // Czy w ogole wolno zaproponowac nadanie. Przy paczce w toku albo zawieszonej
    // odpowiedz brzmi „nie" — patrz mozliwaKolejnaPaczka. To DRUGA linia obrony:
    // prawdziwa odmowa siedzi w rozpocznijPrzesylke.
    mozliwaKolejnaPaczka: mozliwaKolejnaPaczka(z.przesylki),
    // Numer, ktory dostanie nastepna paczka. Liczony TA SAMA funkcja, co numer wkladany
    // do formularza na ekranie nadania — inaczej karta obiecywalaby „paczka nr 2",
    // a ekran nadania wystawialby inny numer.
    kolejnoscKolejnej: nastepnaKolejnosc(db, z.id),
    // Czego zamowieniu brakuje, zeby dalo sie je nadac (dzis: kod paczkomatu). Widok NIE
    // liczy tego sam — TA SAMA funkcja odmawia w services/nadanie.js i na ekranie nadania,
    // wiec karta nie moze zaproponowac nadania, ktore panel zaraz odrzuci.
    brakDoNadania: powodBrakuGotowosciNadania(z),
    // Widok NIE liczy sam, czy rezerwacja jest osierocona — to decyzja domenowa i ma
    // brzmiec tak samo tutaj, na liscie roboczej i przy kolizji w bazie.
    stanFaktury: stanFaktury(z.faktura),
    // PRZ-118.04: identyfikator dokumentu faktury i okresu dla widoku — przez domena/dokument-programu.js.
    idDokumentuFaktury: idDokumentu(z.faktura),
    idDokumentuOkresu: idDokumentu(okresZamowienia),
    // PRZ-102.23: „Wyślij do KSeF” przy fakturze (`wysylkaZKarty`) na pewnych faktach z bazy: uuid, numer KSeF,
    // rezerwacja. NIP karty (bieżące dane, edytowalne po wystawieniu) daje tylko dopisek przy przycisku —
    // o konsumenckiej rozstrzyga podgląd na dokumencie z inFaktu. Miesiąc listy z daty wystawienia,
    // którą czuwacz przeczytał z inFaktu (lustro luk), a bez niej z chwili wystawienia w panelu (czas Warszawy).
    // Faktura grupy scalonej ma wiersz tylko przy głównym; faktura okresu nie ma go wcale — przycisku tam nie ma.
    ksefKarty: (() => {
      const uuid = idDokumentu(z.faktura);
      if (!wysylkaKsef || !uuid) return null;
      return wysylkaZKarty({
        uuid,
        ksefNumer: z.faktura.ksef_numer,
        nip: daneFaktury(z).nip,
        konsumenckie: czyWysylacKonsumenckie(db),
        zleconaAt: rezerwacjaKsef(db, uuid)?.zlecona_at ?? null,
        dzienWystawienia: dzienWystawieniaLuki(db, uuid) ?? (z.faktura.utworzona_at ? dzienWarszawa(z.faktura.utworzona_at) : null),
      });
    })(),
    powodKorektyKsef: POWOD_KOREKTA,
    // Zadanie 4: sekcja „Pozycje" — lp/nazwa/SKU/ilosc/netto/brutto/suma, wysylka jako
    // OSTATNI wiersz. Widok NIE liczy niczego sam — ta sama zasada, co przy stanie
    // przesylki wyzej: wiersze i podsumowanie (razem z ostrzezeniem o rozjezdzie z kwota
    // zamowienia) sa gotowe, zeby szablon tylko je wypisal.
    // Odnosnik z pozycji sklada sie TUTAJ, bo tylko trasa zna adres sklepu. Zamowienie
    // recznego sklepu nie ma (`config.sklepy` go nie zna) — wtedy `baseUrl` jest puste
    // i domena sama oddaje brak odnosnika.
    //
    // ⚠️ TRASA NIE WIE, KTORY TO KANAL, i tak ma zostac. `odnosnikPozycji`
    // (domain/link-pozycji.js) dostaje CALE zamowienie i sama rozstrzyga, czy pozycja
    // prowadzi do produktu w sklepie, czy do oferty na Allegro — razem z podpisem
    // odnosnika. Dolozenie tu `if`-a po kanale odtworzyloby rozjazd, ktoremu tamten modul
    // ma zapobiec (uzasadnienie wyboru w calosci w jego naglowku).
    // PRZ-101.04: główne grupy scalonej pokazuje pozycje CAŁEJ grupy (ta sama funkcja, co faktura
    // i wydruki), z numerem zamówienia przy każdej. Tryb „Edytuj” całego panelu edytuje wyłącznie
    // pozycje głównego — formularz zapisuje je do jego wiersza, więc dostaje tylko je.
    // PRZ-105: stawka każdej pozycji i podsumowanie netto/VAT/brutto — domyślna z Ustawień, ta sama co faktura.
    pozycjeKarty: wierszePozycji(edytujWszystkiePozycje ? z : zKartyZGrupa(z), { stawkaDomyslna: czytajStawkeDomyslna(db) }).map((w) => {
      const odnosnik = odnosnikPozycji(z, w, { baseUrl: config.sklepy?.[z.sklep]?.baseUrl ?? null });
      return { ...w, linkProduktu: odnosnik?.adres ?? null, linkProduktuTytul: odnosnik?.tytul ?? null };
    }),
    podsumowaniePozycji: podsumowaniePozycji(edytujWszystkiePozycje ? z : zKartyZGrupa(z)),
    podsumowanieVat: podsumowanieVatKarty(edytujWszystkiePozycje ? z : zKartyZGrupa(z), { stawkaDomyslna: czytajStawkeDomyslna(db), regula: regulaVat }),
    // Sekcja „Platnosci": suma wplat wobec kwoty zamowienia. Widok NIE liczy tego sam —
    // ta sama zasada, co przy podsumowaniu pozycji wyzej. Porownanie idzie na liczbach
    // calkowitych w groszach, TA SAMA funkcja co bariera arytmetyczna faktury.
    // PRZ-101.11: przy zamówieniu scalonym — saldo grupy i wpłaty wszystkich jej zamówień.
    saldoWplat: saldoWplat(platnosci.doSalda),
    wplatyKarty: platnosci.wplaty,
    // ⚠️ WARTOSCI DOMYSLNE FORMULARZA WPLATY liczy DOMENA, nie widok — kwota to BRAKUJACA
    // reszta (ta sama funkcja, ktora drukuje pasek salda), a „dzis" to dzien WARSZAWSKI.
    // Kontener chodzi z TZ=UTC, wiec gole `new Date()` miedzy polnoca a druga w nocy
    // podstawialoby DZIEN POPRZEDNI — czyli wplate wsteczna przy kazdym nocnym ksiegowaniu.
    domyslnaKwotaWplaty: domyslnaKwotaWplaty(platnosci.doSalda),
    // Opcje wymaganego pola „Metoda" na formularzu wplaty — z domeny, zeby widok nie
    // wpisywal drugi raz listy, ktorej pilnuje test slownika (metody-platnosci.test.js).
    metodyWplaty: METODY_WPLATY_RECZNEJ,
    dzisiaj: dzienWarszawa(new Date().toISOString()),
    // Widok NIE liczy tego sam (przewodnik OMS, sekcja 3) — te sama funkcje czyta pasek
    // spraw, wiec karta i pasek nie moga powiedziec czegos innego o tym samym zamowieniu.
    pobranie: platnoscPrzyOdbiorze(z),
    // Czy w ogole pokazywac przycisk „Pobierz z GUS". Bez klucza (GUS_KLUCZ) klienta nie
    // ma, wiec przycisk tylko kusilby akcja konczaca sie 503 bez wyjasnienia.
    mozliwyGus: gusDostepny(gus), // PRZ-102.11: plik albo Ustawienia, przy kazdym widoku (bez restartu)
    // ⚠️ NIEZAPISANE dane z GUS-u i komunikat o wyniku pobrania. Widok wklada je do pol
    // formularza, ale w bazie ich JESZCZE NIE MA — zapisuje dopiero „Zapisz". Nazwa firmy
    // idzie na fakture, wiec czlowiek musi ja zobaczyc, zanim stanie sie faktem.
    daneZGus: dodatki.daneZGus ?? null,
    komunikatGus: dodatki.komunikatGus ?? null,
    // Stawka dla skryptu przeliczajacego netto/brutto w formularzu „Dodaj pozycje" (widok: data-vat)
    // — JEDNO zrodlo, widok nie ma prawa wpisac jej u siebie drugi raz.
    // PRZ-105: to stawka DOMYŚLNA z Ustawień (zaznaczona w liście stawek formularza), a nie stawka
    // dokumentu — WDT jedzie osobno (`wdt` niżej, w widoku `data-wdt`), skrypt liczy wtedy stawką 0:
    // kwoty zamowienia WDT sa kwotami netto, wiec podpowiedz netto = brutto mowi prawde o dokumencie.
    stawkaVat: czytajStawkeDomyslna(db),
    stawkiVat: STAWKI_VAT,
    // Pas WDT na karcie — TA SAMA regula, ktora wybiera stawke pozycji faktury
    // (domain/pozycje-faktury.js), wiec pas i dokument nie moga sie rozjechac.
    wdt: czyNipUe(daneFaktury(z).nip),
    // Miniatura produktu przy pozycji — TA SAMA droga, co na liscie zamowien i na ekranie
    // nadania (miniaturyEkranu wyzej). Karta liczaca adres u siebie pokazywalaby z czasem
    // inny rozmiar niz lista, a przy okazji sciagalaby oryginal zamiast miniatury.
    miniatura: miniaturyEkranu(db, [z]),
    // ⚠️ Nazwy metod wysylki NIE JADA juz osobno do widoku: karta, lista i ekran nadania
    // wolaja `etykietaWysylki` z domeny (wstrzykiwana w web/server.js jako defaultContext),
    // bo od 2026-08-01 etykieta sklada sie z DWOCH wartosci — dostawy i pobrania. Do
    // 2026-08-01 karta miala tu WLASNY lancuch `if`-ow i wlasnie w nim siedzial blad I5:
    // kazda metoda poza pobraniem i „nieznana" drukowala sie jako „DPD", w tym odbior
    // osobisty, ktory nie ma zadnego kuriera.
    // Opcje terminu platnosci — Z DOMENY, zeby widok nie wpisywal drugi raz listy, ktorej
    // serwer i tak jest jedynym sedzia (domain/termin-platnosci.js).
    terminy: { przyOdbiorze: PRZY_ODBIORZE, bezTerminu: BEZ_TERMINU, zaplacone: ZAPLACONE, dni: TERMINY_DNI },
    etykietyTerminu: ETYKIETY_TERMINU,
    rabatMax: RABAT_MAX,
    // ⚠️ KLIENT Z BAZY SZUKANY PO NIP-IE, nie po nazwie ani po mailu — ta sama zasada, co
    // przy klientach zbiorczych. Sluzy JEDNEJ rzeczy: przycisk ma powiedziec „Zapamietaj"
    // albo „Uaktualnij dane", a nie zalozyc drugi wpis na ten sam podmiot i odbic sie
    // od indeksu unikalnego komunikatem, ktorego operator nie zamowil.
    // ⚠️ `daneFaktury(z)`, a NIE kolumna `z.nip`: reczna poprawka NIP-u lezy w nadpisaniach
    // (`klient_reczny_json`) i wygrywa dopiero przy odczycie. Czytanie samej kolumny znaczyloby,
    // ze klient z POPRAWIONYM numerem nigdy sie nie dopasuje — a poprawia sie go wlasnie
    // wtedy, gdy sklep przyslal zly.
    klientZBazy: klientPoNip(db, daneFaktury(z).nip),
    // Pas rozjazdu stawek — widok NIE liczy tego sam (ta sama zasada, co reszta karty).
    // Niesie decyzje ('ostrzez' zapala pas) i stawke z umowy razem z ewentualnym rozjazdem
    // bazy z konfiguracja.
    rabatUmowy: (() => {
      const k = rabatKontraktowy(db, daneFaktury(z).nip);
      return { decyzja: k.decyzja(z.rabat_procent), stawka: k.stawka };
    })(),
    // Zadanie 6: propozycja daty sprzedazy na fakture — TYLKO propozycja, operator moze
    // ja poprawic w polu, tak samo jak dzis przy dacie wystawienia. Widok NIE liczy tego
    // sam (domain/data-sprzedazy.js), ta sama zasada co reszta tej karty.
    propozycjaSprzedazy,
    // Domyslny wybor terminu w formularzu ponizej. Widok NIE liczy tego sam.
    domyslnyTermin,
    // Powiazanie dosylki z zamowieniem pierwotnym — widoczne z OBU stron (Zadanie 7).
    // Widok nie liczy tego sam z tej samej przyczyny co reszta karty: dwie kopie tej samej
    // reguly rozjechalyby sie przy pierwszej zmianie.
    dosylka: powiazaniaDosylki(db, z.id),
    // ⚠️ OKRES ROZLICZENIOWY — FAKT, KTOREGO KARTA DO 2026-08-03 NIE NIOSLA W OGOLE
    // (`grep okres` po tym szablonie dawal ZERO trafien). Operator widzial zwykle zamowienie
    // firmowe z NIP-em i przycisk „Wystaw fakturę", a to zamowienie rozlicza sie JEDNA
    // faktura zbiorcza za caly miesiac. Bez tej informacji karta nie dawala mu ani jednego
    // sygnalu, ze cokolwiek jest inaczej — i wlasnie stad brala sie druga droga do dokumentu
    // (recenzja koncowa galezi, K1).
    //
    // Idzie CALY wiersz okresu, nie samo id: widok ma nazwac miesiac po imieniu, a nie
    // pokazac „okres nr 1". `MIESIACE` z domeny (ta sama tablica, ktorej uzywa `opisOdmowy`
    // i ekran okresu) — trzecia kopia nazw miesiecy w szablonie znaczylaby, ze odmowa,
    // ekran okresu i karta moga kiedys nazwac ten sam miesiac inaczej.
    // Kolumna boczna karty — te same statusy, co na liscie, z zaznaczonym statusem
    // TEGO zamowienia. Rysuje ja uklad (layout-oms.ejs).
    panelStatusow,
    okresZamowienia,
    // ⚠️ TA SAMA REGULA, KTORA ODMAWIA W TRASIE `POST /zamowienia/:id/okres` — widok jej
    // nie powtarza. `null` znaczy „nie pokazuj przycisku": zamowienie ma juz okres albo
    // wlasna fakture, jest hurtem, albo jego NIP nie nalezy do klienta zbiorczego.
    // Panel nie kusi przyciskiem, ktorego klikniecie skonczyloby sie odmowa.
    przypisanieDoOkresu: (() => {
      const nip = daneFaktury(z).nip;
      const klient = umowaZbiorcza(klientPoNip(db, nip));
      if (!wolnoPrzypisac({ zamowienie: z, faktura: z.faktura, klient }).wolno) return null;
      // ⚠️ `kluczOkresu` RZUCA przy braku daty zlozenia i tak ma zostac (podstawienie
      // „dzisiaj" wrzucaloby zamowienia z przelomu miesiaca na fakture nie tego miesiaca).
      // Karta nie ma prawa sie od tego wywalic — brak daty znaczy tylko brak przycisku.
      try {
        const { rok, miesiac } = kluczOkresu(z.utworzone_at);
        return { klient, nip, rok, miesiac };
      } catch { return null; }
    })(),
    MIESIACE,
  });
  }
function renderujNowe(
    reply,
    {
      formularz = {}, daneZGus = null, komunikatGus = null, blad = null, magazyn = null,
      klientWybrany = null,
    } = {},
  ) {
    return reply.view('nowe-zamowienie.ejs', {
      title: 'Nowe zamówienie',
      // Zywe szukanie w magazynie — patrz komentarz przy `<script>` w layout-oms.ejs.
      htmx: true,
      formularz,
      daneZGus,
      komunikatGus,
      blad,
      // Numer POKAZYWANY, zanim powstanie — operator dyktuje go klientowi przez telefon
      // jeszcze w trakcie wypelniania. To PODGLAD, nie rezerwacja: numer nadaje dopiero
      // transakcja zapisu (nastepnyNumerReczny wolane drugi raz w utworzZamowienieReczne),
      // wiec dwa otwarte formularze pokaza ten sam numer, a dostana rozne. Tak ma byc —
      // rezerwowanie numerow zostawialoby dziury po kazdym porzuconym formularzu.
      numerPodgladowy: nastepnyNumerReczny(db, new Date().getFullYear()),
      // PRZ-104: granice pola „Data wysyłki” — te same, które sprawdza zapis (parsujDateWysylki).
      dzisWysylki: zakresDatyWysylki(dzienWarszawa(new Date().toISOString())),
      dostawy: DOSTAWY,
      // ⚠️ MAPA, NIE JEDNA KWOTA — bo ekran musi umiec podmienic wartosc po zmianie metody
      // w liscie rozwijanej, a panel nie odpytuje serwera przy kazdym ruchu pola. Kwoty jada
      // z JEDNEGO zrodla (domain/ustawienia-panelu.js: kwotyDostawy): druga kopia liczb
      // w skrypcie rozjechalaby sie z ustawieniem przy pierwszej zmianie.
      kwotyDostawy: kwotyDostawy(wczytajUstawienia(db)),
      platnosci: PLATNOSCI,
      stawkaVat: czytajStawkeDomyslna(db),
      stawkiVat: STAWKI_VAT,
      // PRZ-105: nabywca z UE po NIP-ie faktury z formularza — ta sama reguła co dokument; dalej na żywo
      // przestawia ją public/suma-podglad.js.
      wdtFormularza: wdtZFormularza(formularz),
      gusDziala: gusDostepny(gus),
      // ⚠️ TYLKO AKTYWNI. Klient wygaszony zostaje w bazie (jego zamowienia sa migawka i maja
      // sie dac wytlumaczyc), ale nie ma prawa kusic na liscie wyboru przy telefonie.
      klienci: wszyscyKlienci(db),
      // Zdanie pod paskiem wyboru — sklada je DOMENA (`opisKlienta`), zeby widok nie musial
      // wiedziec, ze „0.00" znaczy „wysylka gratis".
      opisWybranego: opisKlienta(klientWybrany),
      // Slownik terminow ten sam, co przy fakturze — bez wariantu „zaplacone", ktory nie jest
      // uzgodnieniem, tylko stanem wynikajacym z wplat (domain/termin-platnosci.js).
      terminy: { przyOdbiorze: PRZY_ODBIORZE, bezTerminu: BEZ_TERMINU, dni: TERMINY_DNI },
      etykietyTerminu: ETYKIETY_TERMINU,
      rabatMax: RABAT_MAX,
      // „Dodaj z magazynu" — `wyniki: null` znaczy „jeszcze nie szukano", `[]` znaczy
      // „szukano, nie ma". Bez wyszukiwania ekran i tak pokazuje pasek, bo to jest jego
      // jedyne wejscie.
      magazyn: magazyn ?? {
        fraza: '', cennik: cennikiInstalacji.domyslny, kanaly: cennikiInstalacji.kanaly, nazwy: cennikiInstalacji.nazwy,
        odczyt: odczytKatalogu(db, cennikiInstalacji.domyslny), wyniki: null, dodano: null,
      },
      // ⚠️ FORMULARZ ROSNIE (21.08.2026): szosta pozycja wstawiona z magazynu nie moze zniknac
      // przez to, ze petla w widoku jest krotsza od tablicy. Od PRZ-103 (21.10) start = jeden wiersz,
      // kolejne doklada operator, a skasowane nie maja wracac po przycisku.
      liczbaWierszy: liczbaWierszyFormularza(formularz),
    });
  }
function magazynEkranu(req, { wyniki = null, dodano = null } = {}) {
    // ⚠️ Z CIALA ALBO Z ADRESU. Przyciski ekranu wysylaja formularz (POST, `req.body`),
    // a zywe szukanie pobiera sam fragment (GET, `req.query`) — jedna funkcja obsluguje
    // obie drogi, zeby cennik i fraza znaczyly wszedzie dokladnie to samo.
    const cennik = cennikDlaZamowienia({ wybrany: req.body?.cennik ?? req.query?.cennik }, cennikiInstalacji);
    return {
      fraza: String(req.body?.magazyn ?? req.query?.magazyn ?? '').trim(),
      cennik,
      kanaly: cennikiInstalacji.kanaly,
      nazwy: cennikiInstalacji.nazwy,
      odczyt: odczytKatalogu(db, cennik),
      wyniki,
      // ⚠️ POTWIERDZENIE OSTATNIEGO DODANIA. Ekran wraca kotwica DO WYSZUKIWARKI (bo tam
      // operator pracuje dalej), wiec dopisana pozycja bywa poza widokiem — bez tego pola
      // nie widac, czy klikniecie cokolwiek zrobilo.
      dodano,
    };
  }
const niesiePolaFormularza = (body, pola) => pola.some((p) => body?.[p] !== undefined);
const opisZmian = (nadpisania) => (Object.keys(nadpisania).length ? Object.keys(nadpisania).join(', ') : 'brak zmian');
function kopiujDaneFakturyDoWysylki(id, z, req) {
    const f = daneFaktury(z);
    const wysylka = adresOdbiorcy(z);
    // ⚠️ `nazwa` (osoba) zostaje NIETKNIETA, a firma i adres jada z faktury. Kurier wymaga
    // osoby do kontaktu, a dane faktury jej nie niosa — nadpisanie jej nazwa firmy
    // zostawiloby paczke bez nikogo, kogo kurier moglby zapytac o drzwi.
    // ⚠️ `firmaNabywcy(z)`, NIE `f.firma` — to nie jest to samo. `f.firma` niesie
    // podstawienie „gdy nie ma firmy, weź imię i nazwisko", potrzebne WYŁĄCZNIE
    // dokumentowi (inFakt: `company_name` wymagane także dla osoby prywatnej). Przepisane
    // stąd do adresu wysyłki dawało przy każdej osobie prywatnej TRWAŁY wpis
    // `{"company":"Jan Kowalski"}` w `dostawa_reczna_json` — czyli błąd zdjęty 05.08
    // z adres-odbiorcy.js, wracający jednym kliknięciem i blokujący prawdziwą nazwę firmy,
    // gdyby sklep kiedyś ją dosłał. Kopiujemy więc PRAWDZIWĄ firmę albo nic.
    const kandydat = {
      nazwa: wysylka.nazwa,
      company: firmaNabywcy(z),
      ulica: f.ulica,
      kod: f.kod,
      miasto: f.miasto,
      phone: wysylka.phone,
      email: f.email || wysylka.email,
    };
    const nadpisania = roznice(adresZeSklepu(z), kandydat, POLA_ADRESU_RECZNE);
    zapiszNadpisaniaWysylki(db, id, nadpisania);
    dopiszLog(db, id, {
      akcja: 'dane.kopiuj',
      wynik: `Ręcznie (${ktoKlikal(req)}): dane z faktury skopiowane do wysyłki — `
        + `${Object.keys(nadpisania).length ? Object.keys(nadpisania).join(', ') : 'brak zmian (adresy już były takie same)'}.`,
    });
  }
function pozycjaZadania(req, reply) {
    const id = Number(req.params.id);
    const z = pobierzZamowienie(db, id);
    if (!z) {
      reply.code(404).send('Nie ma takiego zamówienia');
      return null;
    }
    const p = z.pozycje.find((w) => w.klucz === req.params.klucz);
    if (!p) {
      reply.code(404).send('To zamówienie nie ma takiej pozycji — odśwież kartę.');
      return null;
    }
    return { id, z, p };
  }
const zWynikami = (wiersze) => wiersze.map((p) => ({ ...p, rozmiar: rozmiarDoPokazania(p) }));
function magazynDlaKarty(req, z) {
    const fraza = String(req.query?.magazyn ?? '').trim();
    // ⚠️ KANAL PRZECHODZI PRZEZ DOMENE, NIGDY WPROST DO ZAPYTANIA. To ona pilnuje, ze
    // cennikiem sa wylacznie sklepy — kanal allegrowy podstawiony w adresie ma wrocic
    // jako cennik detaliczny, a nie odpytac lustro o ceny z prowizja.
    const cennik = cennikDlaZamowienia({ sklepZamowienia: z.sklep, wybrany: req.query?.cennik }, cennikiInstalacji);
    return {
      fraza,
      cennik,
      kanaly: cennikiInstalacji.kanaly,
      nazwy: cennikiInstalacji.nazwy,
      odczyt: odczytKatalogu(db, cennik),
      wyniki: fraza ? zWynikami(szukajDoZamowienia(db, { fraza, kanal: cennik })) : null,
    };
  }
return {db,config,poller,nadanie,faktura,proforma,kurierzy,gus,syncSklep,wiadomosci,wiadomosciCzynne,przesylkiAllegro,stanyKanalow,zdrowie,fakturaAllegro,fakturaHurtem,doczytanieKsef,powrotKarty,adresPowrotuNaKarte,wczytajListe,statusyDlaKarty,OKNO_OSTRZEZEN_PRZESYLEK_DNI,zbierzOstrzezenia,wyborWiadomosci,daneWiadomosci,renderujKarte,renderujNowe,magazynEkranu,niesiePolaFormularza,opisZmian,kopiujDaneFakturyDoWysylki,pozycjaZadania,zWynikami,magazynDlaKarty,cennikiInstalacji};
}
