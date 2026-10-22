import {
  pobierzOkres, zamowieniaOkresu, zamknijOkres, otworzOkresPonownie, odblokujFaktureOkresu,
  odepnijZamowienieOdOkresu,
} from '../../../oms/db/okresy.js';
import { pobierzZamowienie, dopiszLog } from '../../../oms/db/zamowienia.js';
import { METODY_WPLATY_RECZNEJ } from '../../../domena/metody-platnosci.js';
import { wplatyOkresu, dodajWplateOkresu, usunWplateOkresu } from '../../../oms/db/platnosci.js';
import { saldoOkresuGrosze } from '../../../domena/saldo-okresu.js';
import {
  createFakturaOkresu, sumaOczekiwanaOkresuGrosze, podzialZamowienOkresu,
} from '../services/faktura-okresu.js';
import {
  stanFakturyOkresu, okresPrzyjmujeZamowienia, MIESIACE,
} from '../../../domena/okres-rozliczeniowy.js';
import { parsujWplate, sumaWplatGrosze } from '../../../domena/platnosci.js';
import { podsumowaniePozycji } from '../../../domena/tabela-pozycji.js';
import { adresOdbiorcy } from '../../../domena/adres-odbiorcy.js';
import { komunikatDlaOperatora } from '../../../domena/bledy.js';
import { GDZIE_KLUCZ_INFAKTU } from '../../../domena/konfiguracja-infakt.js';
import { wolnoOdpiac } from '../../../domena/zmiana-okresu.js';
import { zl } from '../../../domena/suma-pozycji.js';
import { umowaZbiorcza } from '../../../domena/klient-zbiorczy.js';
import { klientPoKluczu } from '../../../oms/db/klienci.js';
import { ktoKlikal } from '../../zamowienia/lista.js';
import { nipSprzedawcyLubBrak } from '../../../domena/nip-bdo-firmy.js';

// Trasy ROZLICZENIA ZBIORCZEGO: miesiac klienta, ktorego kilkadziesiat zamowien skalda sie
// na JEDNA fakture. Osobny plik z tego samego powodu, co routes/panel.js — routes/zamowienia.js
// ma juz dwa tysiace linii, a tutaj przedmiotem jest okres, nie zamowienie.
//
// ⚠️ TRZY TRASY W TYM PLIKU SA WYJSCIAMI AWARYJNYMI i istnieja dlatego, ze poprzednie zadania
// zostawily stany, z ktorych KOD potrafi wyjsc, a CZLOWIEK nie mial jak (jedynym wyjsciem byl
// SQL na produkcyjnej bazie):
//   • /otworz          — zamkniety miesiac odmawia przyjecia zamowienia komunikatem, ktory
//                        obiecuje operatorowi decyzje („korekta albo zmiana daty");
//   • /faktura/odblokuj — po zerwanej probie wystawienia okres siada w `do_wyjasnienia`;
//   • /wplata/:id/usun  — wplata wpisana pomylkowo przewraca saldo calego miesiaca.
// Kazda z nich zmienia stan, wiec kazda jest POST-em z przekierowaniem (wzorzec
// z routes/zamowienia.js), a nie odnosnikiem.

/**
 * Rozliczenie okresu do pokazania na ekranie: kwota faktury, suma wplat i saldo.
 *
 * ⚠️ OWINIETE W `try`, DOKLADNIE JAK `saldoWplat` w domain/platnosci.js — i z tego samego
 * powodu. `saldoOkresuGrosze` RZUCA, gdy ktoras wplata ma kwote nie do sparsowania (a od
 * Zadania 8 czyta wplaty takze PRZED faktura, wiec rzuci rowniez wtedy); tak samo rzuca
 * `sumaOczekiwanaOkresuGrosze` na uszkodzonej kwocie zamowienia. Uszkodzona kwota nie ma
 * prawa wywalic calego ekranu okresu — ale MA sie pokazac jako blad, nigdy jako ciche
 * „wszystko gra". Stan 'blad' jest tu dokladnym odpowiednikiem tamtego.
 *
 * ⚠️ KWOTA FAKTURY IDZIE Z `sumaOczekiwanaOkresuGrosze`, czyli z TEJ SAMEJ liczby, ktora
 * przechodzi bariere przy wystawianiu (services/faktura-okresu.js) — nie z inFaktu i nie
 * z wlasnego sumowania. Jedno zrodlo arytmetyki dla bariery, faktury i salda.
 *
 * ⚠️ WPLATY IDA JAKO WIERSZE, nie jako gotowe grosze: konwersja TEXT→liczba po stronie
 * wolajacego byla druga kopia arytmetyki wplat i wlasnie ja usunieto w Zadaniu 8 (naglowek
 * domain/platnosci.js tlumaczy, jak taka kopia klamie: 35.65 + 35.65 + 141.60 na floatach
 * daje falszywa NIEDOPLATE).
 */
function rozliczenieOkresu(zamowienia, wplaty) {
  try {
    const kwotaFakturyGr = sumaOczekiwanaOkresuGrosze(zamowienia);
    const { saldoGr, stan } = saldoOkresuGrosze({ kwotaFakturyGr, wplaty });
    return {
      kwotaFakturyZl: zl(kwotaFakturyGr),
      wplaconoZl: zl(sumaWplatGrosze(wplaty)),
      // Wartosc BEZWZGLEDNA: o tym, czy to niedoplata, zaliczka czy nadplata, mowi `stan`,
      // a nie znak liczby (patrz nizej) — minus przed kwota na ekranie tylko myliby.
      saldoZl: zl(Math.abs(saldoGr)),
      // ⚠️ `oplacony` z `saldoOkresuGrosze` CELOWO NIE JEDZIE DALEJ. Zaden widok go nie
      // czytal, a martwe pole na sciezce pieniedzy jest zaproszeniem do drugiej, konkurencyjnej
      // odpowiedzi na pytanie „czy rozliczone" — `oplacony` jest prawdziwe takze przy
      // NADPLACIE (saldoGr >= 0), wiec widok, ktory po nie siegnie, schowa pieniadze do zwrotu.
      // Znaczenie niesie `stan` i tylko `stan`.
      //
      // ⚠️ TO `stan` NIESIE ZNACZENIE, NIE ZNAK SALDA. `saldoGr: +500000` przy pustej fakturze
      // to ZALICZKA wplacona przed rozliczeniem; `saldoGr: +499901` po fakturze to NADPLATA
      // do zwrotu. Obie dodatnie, a rozni je wylacznie `stan`. Widok, ktory pomalowalby
      // „dodatnie = pieniadze do oddania klientowi", pokazywalby zaliczke jako nadwyzke do
      // zwrotu — a to sa pieniadze, ktorych nikt nie widzi nigdzie indziej niz w tym panelu.
      stan,
      blad: null,
    };
  } catch (e) {
    return {
      kwotaFakturyZl: null, wplaconoZl: null, saldoZl: null, stan: 'blad', blad: e.message,
    };
  }
}

/**
 * Nabywca okresu — z KARTY KLIENTA, po kluczu (okres wie, czyj jest).
 *
 * Jedno miejsce na dwa uzycia: ekran (nazwa klienta) i wystawienie faktury (NIP nabywcy).
 * Dwie kopie tego wyszukiwania rozjechalyby sie przy pierwszej zmianie ksztaltu wpisu,
 * a wtedy ekran pokazywalby klienta, ktorego faktura i tak by nie znalazla.
 *
 * ⚠️ PO KLUCZU, NIE PO NIP-IE — i to jest jedyne takie miejsce. Okres niesie `klient_klucz`
 * zapisany w chwili przypisania pierwszego zamowienia; NIP moze sie w karcie zmienic
 * (poprawka literowki), a okres ma dalej wskazywac tego samego nabywce.
 *
 * ⚠️ Do 2026-08-24 czytalo to `OMS_KLIENCI_ZBIORCZY`. Zrodlem jest teraz tabela `klienci`.
 */
const klientOkresu = (db, okres) => umowaZbiorcza(klientPoKluczu(db, okres.klient_klucz));

/**
 * Komplet danych JEDNEGO okresu — wspolny dla listy i dla karty, zeby oba liczyly to samo.
 *
 * ⚠️ KWOTY LICZA SIE Z TEGO SAMEGO ZBIORU, CO FAKTURA — podzial idzie
 * `podzialZamowienOkresu` (services/faktura-okresu.js), czyli DOKLADNIE tym warunkiem,
 * ktorym `wystaw` odsiewa zamowienia od pozycji dokumentu. Do 2026-08-01 ekran liczyl
 * z wszystkich zamowien okresu, a faktura bez anulowanych: karta obiecywala „Razem do
 * zafakturowania 140.00 zł" tam, gdzie do inFaktu szlo 100,00, zaplata co do grosza
 * wygladala na NIEDOPLATE, a nadplata do zwrotu nie pojawiala sie nigdzie. Druga definicja
 * tego, co wchodzi na fakture, jest tu bledem o pieniadze, nie o wyglad.
 *
 * ⚠️ ...ale ANULOWANE JADA DALEJ jako `wszystkieZamowienia`. Zamowienie usuniete z ekranu
 * zamiast oznaczonego to zamowienie, ktorego operator szuka w panelu po numerze ze sklepu
 * i nie znajduje. Wiersz zostaje, kwota z sumy wypada — a widok mowi, dlaczego.
 */
function daneOkresu(db, config, okres) {
  const wszystkie = zamowieniaOkresu(db, okres.id).map((id) => pobierzZamowienie(db, id));
  const { zamowienia, anulowane } = podzialZamowienOkresu(wszystkie);
  const wplaty = wplatyOkresu(db, okres.id);
  return {
    okres,
    // Brak wpisu w konfiguracji NIE jest awaria ekranu — okres zalozony pod kluczem, ktorego
    // juz tam nie ma, ma sie dac obejrzec (i to wlasnie wtedy najbardziej), tyle ze bez nazwy
    // i bez przycisku wystawienia faktury.
    klient: klientOkresu(db, okres),
    // `zamowienia` = to, co WCHODZI na fakture (i tylko z tego licza sie kwoty).
    zamowienia,
    anulowane,
    wszystkieZamowienia: wszystkie,
    wplaty,
    // ⚠️ STAN FAKTURY CZYTAMY `stanFakturyOkresu`, a NIE wnioskujemy go z salda ani z samych
    // kolumn. Swiezy okres ma puste kolumny faktury, wiec `stanFaktury` uznalby go za
    // „wystawiona" (patrz komentarz nad ta funkcja w domain/okres-rozliczeniowy.js).
    stanFaktury: stanFakturyOkresu(okres),
    rozliczenie: rozliczenieOkresu(zamowienia, wplaty),
  };
}

export function registerOkresyRoutes(app, { db, config = {}, infakt = null, vies = null }) {
  // Zdejmuje z kazdej trasy powtarzajace sie „a jesli takiego okresu nie ma". 404 zamiast
  // wywrotki na `undefined.id` — dokladnie jak przy zamowieniu.
  const okresZadania = (req, reply) => {
    const okres = pobierzOkres(db, Number(req.params.id));
    if (!okres) {
      reply.code(404).send('Nie ma takiego okresu rozliczeniowego.');
      return null;
    }
    return okres;
  };

  app.get('/okresy', async (req, reply) => {
    const okresy = db.prepare(
      'SELECT * FROM okresy_rozliczeniowe ORDER BY rok DESC, miesiac DESC, klient_klucz',
    ).all().map((o) => daneOkresu(db, config, o));
    // MIESIACE z domeny (nie z widoku) — ta sama lista, z ktorej `opisOdmowy` sklada
    // komunikat odmowy. Trzecia kopia w szablonie znaczylaby, ze odmowa i ekran moga
    // kiedys nazwac ten sam miesiac inaczej.
    return reply.view('okresy-lista.ejs', { title: 'Okresy rozliczeniowe', okresy, MIESIACE });
  });

  app.get('/okresy/:id', async (req, reply) => {
    const okres = okresZadania(req, reply);
    if (!okres) return reply;
    const dane = daneOkresu(db, config, okres);
    // Zbior id-kow z WYNIKU podzialu (`dane.anulowane`) — jedno miejsce prawdy o tym,
    // ktore zamowienie jest poza faktura, do ponownego uzycia przy znaczniku wiersza nizej.
    const anulowaneId = new Set(dane.anulowane.map((z) => z.id));
    return reply.view('okres.ejs', {
      title: `Okres ${okres.rok}-${String(okres.miesiac).padStart(2, '0')}`,
      ...dane,
      // Ta sama lista nazw miesiecy, ktorej uzywa komunikat odmowy (domain/okres-rozliczeniowy.js).
      MIESIACE,
      // Opcje wymaganego pola „Metoda" wplaty okresu — ten sam slownik, co na karcie
      // zamowienia (domain/metody-platnosci.js), jeden jezyk uzgodnien z wyciagiem.
      metodyWplaty: METODY_WPLATY_RECZNEJ,
      // ⚠️ TABELA POKAZUJE WSZYSTKIE zamowienia okresu, takze ANULOWANE — z flaga, po ktorej
      // widok je oznaczy i wyjmie z sumy. Sumy licza sie z `dane.zamowienia` (bez anulowanych),
      // wiec wiersz i „Razem" nie moga sie rozjechac: `anulowane` to ta sama wartosc, ktora
      // rozstrzygnela podzial.
      //
      // Kwota POJEDYNCZEGO zamowienia liczona `podsumowaniePozycji` — ta sama funkcja, co
      // w kolumnie „Kwota" na liscie zamowien, i NIGDY nie rzucajaca: uszkodzona kwota
      // jednego zamowienia nie ma prawa zabrac operatorowi widoku calego miesiaca.
      //
      // ⚠️ ZNACZNIK „anulowane" PRZY WIERSZU CZYTA WYNIK `podzialZamowienOkresu`
      // (`dane.anulowane`, przez `anulowaneId`), a NIE liczy `Boolean(z.anulowane)` po raz
      // drugi. Dzis oba dadza ten sam wynik, ale druga definicja tego samego warunku jest
      // dokladnie tym bledem, ktory recenzja Zadania 9 uznala za krytyczny (ekran liczyl
      // sume z innego zbioru niz faktura) — gdyby regula podzialu kiedys urosla o kolejny
      // warunek, znacznik przy wierszu i suma w „Razem" znow by sie rozjechaly.
      wierszeZamowien: dane.wszystkieZamowienia.map((z) => ({
        z,
        anulowane: anulowaneId.has(z.id),
        kwotaZl: podsumowaniePozycji(z).oczekiwanaZl,
        // Nazwa klienta w postaci, ktora panel uwaza za prawdziwa (reczne poprawki nalozone
        // na sklep) — TA SAMA funkcja, ktora czyta karta, ekran nadania i fakturowanie.
        klientZamowienia: adresOdbiorcy(z).nazwa,
      })),
      // Bez tej flagi widok kusilby „Wystaw fakturę" takze wtedy, gdy inFakt nie jest
      // skonfigurowany — klikniecie konczyloby sie 503 bez wyjasnienia (ta sama zasada,
      // co `mozliwaFaktura` na karcie zamowienia).
      mozliwaFaktura: Boolean(infakt),
      // Czy okres w ogole przyjmuje jeszcze zamowienia — steruje przyciskiem „Zamknij".
      otwarty: okresPrzyjmujeZamowienia(okres.stan),
      // ⚠️ TA SAMA REGULA, KTORA ODMAWIA W TRASIE `.../odepnij` — widok jej NIE POWTARZA.
      // Rozjazd znaczylby przycisk prowadzacy prosto w odmowe (albo, gorzej, brak wyjscia
      // z pomylki tam, gdzie panel je ma).
      wolnoOdpinac: wolnoOdpiac({ okres }).wolno,
    });
  });

  // ---------------------------------------------------------------------------------
  // FAKTURA ZBIORCZA.
  // ---------------------------------------------------------------------------------

  app.post('/okresy/:id/wystaw-fakture', async (req, reply) => {
    const okres = okresZadania(req, reply);
    if (!okres) return reply;
    if (!infakt) return reply.code(503).send(`inFakt nie jest skonfigurowany — faktury z panelu nie wystawisz. ${GDZIE_KLUCZ_INFAKTU}`);
    // Nabywca bierze sie z konfiguracji po kluczu okresu — okres wie, czyj jest. Panel NIE
    // zaklada tu klienta sam (uzasadnienie w services/faktura-okresu.js).
    const klient = klientOkresu(db, okres);
    if (!klient) {
      return reply.code(400).send(
        `Okres należy do klienta „${okres.klient_klucz}", którego nie ma w konfiguracji `
        + '(OMS_KLIENCI_ZBIORCZY) — bez NIP-u panel nie wskaże nabywcy faktury.',
      );
    }
    try {
      // `vies` i NIP sprzedawcy jada do uslugi dla galezi WDT (klient okresu z numerem
      // VAT-UE) — dla klienta krajowego usluga ich nie dotyka.
      // PRZ-108.10: NIP sprzedawcy funkcją — plik albo Ustawienia → Firma, czytany przy wystawieniu.
      await createFakturaOkresu({
        db, infakt, vies, nipSprzedawcy: () => nipSprzedawcyLubBrak(config),
      }).wystaw(okres.id, klient);
    } catch (e) {
      // Nieudana proba MUSI zostawic slad — to najgrozniejsza akcja w panelu, a bez wpisu
      // w logu zerwane polaczenie z inFaktem wygladaloby jak „nic sie nie stalo". Wpis idzie
      // do logu KAZDEGO zamowienia okresu, bo tam czlowiek szuka historii — dokladnie tak
      // samo, jak robi to `wystaw` po udanym wystawieniu (services/faktura-okresu.js).
      //
      // ⚠️ Z NAZWA OPERATORA, tak samo jak przy odblokowaniu nizej. Pierwszym pytaniem po
      // zerwanej probie jest „kto to klikał i o której" — bo od tego zalezy, kogo zapytac,
      // czy zajrzal juz do inFaktu. Wpis bez nazwy zostawial to pytanie bez odpowiedzi.
      for (const id of zamowieniaOkresu(db, okres.id)) {
        dopiszLog(db, id, { akcja: 'faktura-okresu', wynik: `BŁĄD (${ktoKlikal(req)}): ${e.message}` });
      }
      return reply.code(400).send(`Nie udało się wystawić faktury za okres: ${komunikatDlaOperatora(e)}`);
    }
    return reply.redirect(`/okresy/${okres.id}`);
  });

  // JEDYNE wyjscie ze stanow `do_wyjasnienia` i `zawieszona` — bez niego okres zostaje w nich
  // NA ZAWSZE (a `zawieszona` powstaje przy zwyklym restarcie panelu w trakcie wywolania
  // inFaktu). Panel NICZEGO w inFakcie nie kasuje i nie sprawdza: to odnotowanie faktu, ktory
  // czlowiek stwierdzil poza panelem. Odmowa dla faktury WYSTAWIONEJ siedzi
  // w `odblokujFaktureOkresu` (db/okresy.js) — tu tylko przenosimy ja na ekran.
  app.post('/okresy/:id/faktura/odblokuj', async (req, reply) => {
    const okres = okresZadania(req, reply);
    if (!okres) return reply;
    try {
      odblokujFaktureOkresu(db, okres.id);
    } catch (e) {
      return reply.code(400).send(`Nie udało się odblokować faktury okresu: ${komunikatDlaOperatora(e)}`);
    }
    for (const id of zamowieniaOkresu(db, okres.id)) {
      dopiszLog(db, id, {
        akcja: 'faktura-okresu.odblokowanie',
        wynik: `Ręcznie (${ktoKlikal(req)}): sprawdzone w inFakcie, faktury za okres `
          + `${okres.rok}-${String(okres.miesiac).padStart(2, '0')} nie ma — rezerwacja `
          + `(${okres.ksef_status}${okres.blad_opis ? `: ${okres.blad_opis}` : ''}) skasowana.`,
      });
    }
    return reply.redirect(`/okresy/${okres.id}`);
  });

  // ---------------------------------------------------------------------------------
  // STAN OKRESU: zamkniecie i powrot.
  // ---------------------------------------------------------------------------------

  // Zamkniecie odcina miesiac od nowych zamowien PRZED wystawieniem faktury (samo wystawienie
  // zamyka okres i tak — patrz services/faktura-okresu.js).
  app.post('/okresy/:id/zamknij', async (req, reply) => {
    const okres = okresZadania(req, reply);
    if (!okres) return reply;
    // ⚠️ Zamkniecie okresu NIE-otwartego nie jest niewinnym powtorzeniem. Dla okresu
    // ZAFAKTUROWANEGO `zamknijOkres` przestemplowalby `stan` na „zamkniety" — a to jest
    // pierwszy warunek, po ktorym `stanFakturyOkresu` poznaje wystawiona fakture (kolumny
    // moga byc puste, jesli inFakt oddal odpowiedz bez uuid-a i numeru). Skutek: panel
    // uznalby miesiac za niezafakturowany i pozwolil wystawic DRUGI dokument. Dla okresu
    // juz zamknietego skasowalaby sie tylko data zamkniecia, ale i to jest slad, ktorego
    // nie ma powodu kasowac.
    if (!okresPrzyjmujeZamowienia(okres.stan)) {
      return reply.code(400).send(
        `Ten okres nie jest otwarty (stan: ${okres.stan}) — nie ma czego zamykać.`,
      );
    }
    zamknijOkres(db, okres.id);
    return reply.redirect(`/okresy/${okres.id}`);
  });

  // DROGA POWROTNA po zamknieciu. Zamkniety okres odmawia przyjecia zamowienia komunikatem,
  // ktory obiecuje operatorowi decyzje („korekta albo zmiana daty" — domain/okres-rozliczeniowy.js:
  // opisOdmowy), a do tej pory panel nie mial ani tej decyzji, ani drogi powrotu.
  app.post('/okresy/:id/otworz', async (req, reply) => {
    const okres = okresZadania(req, reply);
    if (!okres) return reply;
    if (okresPrzyjmujeZamowienia(okres.stan)) {
      return reply.code(400).send('Ten okres jest już otwarty — nie ma czego otwierać.');
    }
    // ⚠️ STRAZ, KTOREJ NIE MA W BAZIE, I TO JEST SWIADOME. `otworzOkresPonownie` (db/okresy.js)
    // to goly UPDATE — otwarcie okresu z WYSTAWIONA faktura wpusciloby nowe zamowienia do
    // miesiaca, za ktory klient juz dostal dokument (poprawia sie go wtedy wylacznie korekta),
    // a przy okazji skasowaloby stan „zafakturowany", czyli blokade drugiej faktury.
    // Wyjscie ze stanow wymagajacych decyzji czlowieka ma WLASNA droge — `/faktura/odblokuj`
    // wyzej — i to ona, a nie ten przycisk, pilnuje tamtych warunkow.
    const stanF = stanFakturyOkresu(okres);
    if (stanF !== 'brak') {
      return reply.code(400).send(
        `Ten okres ma fakturę (stan: ${stanF})${okres.numer ? ` — ${okres.numer}` : ''}, `
        + 'więc panel go nie otworzy: nowe zamówienia wypadłyby poza dokument, który klient '
        + 'już dostał. Jeśli faktura się nie udała i wiesz, że w inFakcie jej NIE MA — użyj '
        + '„Sprawdziłem w inFakcie — faktury nie ma, odblokuj". Jeśli jest, zostaje korekta.',
      );
    }
    otworzOkresPonownie(db, okres.id);
    return reply.redirect(`/okresy/${okres.id}`);
  });

  // ---------------------------------------------------------------------------------
  // WPLATY OKRESU. Klient zbiorczy placi RAZ, po fakturze — wplata nalezy do MIESIACA,
  // nie do zadnego pojedynczego zamowienia (db/platnosci.js, tabela `platnosci_okresu`).
  // ---------------------------------------------------------------------------------

  app.post('/okresy/:id/wplata', async (req, reply) => {
    const okres = okresZadania(req, reply);
    if (!okres) return reply;
    let wplata;
    try {
      // ⚠️ KWOTA IDZIE PRZEZ `parsujWplate` (domain/platnosci.js), a NIE prosto z `req.body`
      // do bazy. Przecinek dziesietny jest tym, co czlowiek w Polsce naprawde wpisuje —
      // '500,00' oddane bazie surowo odbijalo sie od `grosze()` jako „kwota nie jest liczbą".
      // Ta sama funkcja pilnuje kwoty > 0 i uzupelnia puste pole daty biezacym czasem
      // (wplata bez daty nie ma sie jak uporzadkowac wobec pozostalych — patrz wplatyOkresu).
      wplata = parsujWplate(req.body ?? {});
    } catch (e) {
      return reply.code(400).send(komunikatDlaOperatora(e));
    }
    try {
      dodajWplateOkresu(db, okres.id, wplata);
    } catch (e) {
      return reply.code(400).send(komunikatDlaOperatora(e));
    }
    return reply.redirect(`/okresy/${okres.id}`);
  });

  // WYJSCIE ze stanu, w ktory panel sam pozwala wejsc: wplata wpisana pomylkowo przewraca
  // saldo CALEGO miesiaca, a gdy domyka kwote faktury — kaze panelowi uznac okres za oplacony.
  //
  // ⚠️ Adres niesie OBA identyfikatory i `usunWplateOkresu` szuka wiersza po PARZE
  // (okres, wplata). To zakres wlasnosci, nie ozdoba: w swiezej bazie liczniki AUTOINCREMENT
  // roznych tabel zbiegaja sie, wiec sam `id` wplaty pozwolilby skasowac wplate nalezaca
  // do innego okresu (przewodnik OMS, sekcja 6, punkt 3).
  app.post('/okresy/:id/wplata/:platnoscId/usun', async (req, reply) => {
    const okres = okresZadania(req, reply);
    if (!okres) return reply;
    try {
      usunWplateOkresu(db, okres.id, Number(req.params.platnoscId));
    } catch (e) {
      return reply.code(400).send(komunikatDlaOperatora(e));
    }
    return reply.redirect(`/okresy/${okres.id}`);
  });

  // ⚠️ WYJSCIE Z JEDYNEJ POMYLKI MODULU, KTORA NIE MIALA WYJSCIA (niezmiennik 4.9).
  // Zamowienie trafia do okresu po NIP-ie przy zakladaniu; literowka znaczyla, ze wypada
  // i z faktury miesiecznej, i z raportu — a jedynym ratunkiem byl SQL na produkcji.
  //
  // ⚠️ BARIERA JEST TUTAJ, NIE W SZABLONIE. Widok chowa przycisk przy zafakturowanym okresie,
  // ale zadanie ze starej, otwartej karty omija widok w calosci — i to wlasnie ono zmienialoby
  // podstawe dokumentu, ktory klient juz dostal.
  app.post('/okresy/:id/zamowienia/:zamId/odepnij', async (req, reply) => {
    const okres = okresZadania(req, reply);
    if (!okres) return reply;
    const zgoda = wolnoOdpiac({ okres });
    if (!zgoda.wolno) return reply.code(400).send(zgoda.powod);
    const zamId = Number(req.params.zamId);
    try {
      odepnijZamowienieOdOkresu(db, okres.id, zamId);
    } catch (e) {
      return reply.code(400).send(komunikatDlaOperatora(e));
    }
    // Slad idzie do logu ZAMOWIENIA, nie okresu: pytanie „czemu tego nie ma na fakturze
    // zbiorczej" zadaje sie patrzac na zamowienie.
    dopiszLog(db, zamId, {
      akcja: 'okres.odepnij',
      wynik: `odpięte od okresu ${okres.rok}-${String(okres.miesiac).padStart(2, '0')} (${ktoKlikal(req)})`,
    });
    return reply.redirect(`/okresy/${okres.id}`);
  });
}
