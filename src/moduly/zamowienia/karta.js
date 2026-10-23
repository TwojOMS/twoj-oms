import { ekranOdmowyKarty } from './odmowa-karty.js';
import { etykietyStatusow } from '../../oms/db/statusy.js';
import { pobierzZamowienie, potwierdzWplate, dopiszLog, zapiszFaktyStatusu, zapiszNadpisanieWysylki, przywrocMetodeWysylkiZeSklepu, zapiszKomentarzWewnetrzny, ostatniWpisLogu, zapiszTerminWysylkiRecznego } from '../../oms/db/zamowienia.js';
import { parsujDateWysylki, recznyTermin } from '../../domena/termin-wysylki.js';
import { dzienWarszawa } from '../../domena/format-daty.js';
import { AKCJA_LOGU as AKCJA_ALLEGRO_PRZESYLKA } from '../wysylka/services/przesylki-allegro.js';
import { odswiezStatusKuriera, zapiszLubOdpusc } from '../wysylka/services/status-kuriera.js';
import { wyliczStatus } from '../../domena/status.js';
import { faktyDlaStatusu, powodOdmowyStatusu } from '../../domena/status-reczny.js';
import { sprawdzZmianeMetody, metodaZeSklepu, czyKanalAllegro, pobranieZeSklepu } from '../../domena/wysylka.js';
import { powodOdmowyPobraniaGrupy } from '../../domena/scalanie.js';
import { wartoPytacAllegroONumery } from '../../domena/allegro-numery.js';
import { join } from 'node:path';
import { komunikatDlaOperatora } from '../../domena/bledy.js';
import { maDostepDoAdresu } from '../../domena/ekrany.js';
import { EKRAN_POCZTY, komunikatWysylkiMaila } from '../wiadomosci/poczta-ustawien.ts';
import { znormalizujKomentarz } from '../../domena/komentarz-wewnetrzny.js';
import { adresOdbiorcy } from '../../domena/adres-odbiorcy.js';
import { daneFaktury } from '../../domena/dane-faktury.js';
import { parsujPaczke } from '../../domena/paczka.js';
import { nipDoZapytania, komunikatAwariiGus } from '../../domena/gus.js';
import { gusDostepny, KOMUNIKAT_BRAK_GUS } from '../../domena/konfiguracja-gus.js';
import { ETYKIETY_TERMINU, parsujTerminZamowienia } from '../../domena/termin-platnosci.js';
import { znormalizujKlienta, daneNabywcyNaKarcie } from '../../domena/klient-staly.js';
import { DOSTAWY } from '../../domena/nowe-zamowienie.js';
import { klientPoNip, dopiszKlienta, zapiszKlienta } from '../../oms/db/klienci.js';
import { zmienUstalenia } from './services/rabat.js';
import { parsujWplate } from '../../domena/platnosci.js';
import { dodajWplateReczna, usunWplateReczna } from '../../oms/db/platnosci.js';
import {teraz,AKCJA_ALLEGRO_PROBA,allegroWymagaOdpytania,miniaturyEkranu,ktoKlikal,sprzedawcaSpecyfikacji,daneKarty,KATALOG_WIDOKOW,fragment} from './wspolne.js';
export function registerKartaRoutes(app, kontekst) {
const {db,config,poller,nadanie,faktura,proforma,kurierzy,gus,syncSklep,wiadomosciCzynne,przesylkiAllegro,stanyKanalow,zdrowie,fakturaAllegro,fakturaHurtem,doczytanieKsef,powrotKarty,adresPowrotuNaKarte,wczytajListe,statusyDlaKarty,OKNO_OSTRZEZEN_PRZESYLEK_DNI,zbierzOstrzezenia,wyborWiadomosci,daneWiadomosci,renderujKarte,renderujNowe,magazynEkranu,niesiePolaFormularza,opisZmian,kopiujDaneFakturyDoWysylki,pozycjaZadania,zWynikami,magazynDlaKarty}=kontekst;
app.get('/zamowienia/:id', async (req, reply) => {
    let z = pobierzZamowienie(db, Number(req.params.id));
    if (!z) return reply.code(404).send('Nie ma takiego zamówienia');
    // PRZ-101.04: dołączone nie ma własnej karty — jest częścią głównego (pozycje pokazuje karta głównego).
    if (z.scalone_do) return reply.redirect(`/zamowienia/${z.scalone_do}`);

    // ⚠️ NUMER KSeF DOCIAGA KARTA, TAK SAMO JAK NUMERY LISTOW Z ALLEGRO NIZEJ — i z tego
    // samego powodu: koszt ograniczony UWAGA CZLOWIEKA, zero ruchu w tle.
    //
    // Zgloszenie wlasciciela 12.08.2026: „dlaczego numer KSeF pojawia sie w panelu faktur
    // szybko, a na karcie duzo pozniej?". Bo zakladka FAKTURY czyta inFakt NA ZYWO, a karta
    // czytala wylacznie `ksef_numer` z bazy — a to pole wypelnial tylko czuwacz, co GODZINE.
    // Gorzej: czuwacz pyta wylacznie o kanal Allegro i o dokumenty wyslane przez panel
    // (domain/ksef-oczekiwanie.js), wiec dla faktury sklepowej, ktora poszla do KSeF inna
    // droga, numer na karcie nie pojawilby sie NIGDY.
    //
    // ⚠️ Odpornosc siedzi w USLUDZE (services/ksef-doczytanie.js nie rzuca nigdy), a nie tutaj
    // — inaczej kazde wywolanie trzeba by owijac w try/catch przy renderowaniu karty. Dlawik
    // stoi na `ksef_sprawdzona_at`, wiec dwadziescia razy F5 to jedno zapytanie do inFaktu.
    //
    // Ponowny odczyt WYLACZNIE po zapisaniu numeru: karta renderuje sie z obiektu wczytanego
    // wyzej, wiec bez tego numer siedzialby w bazie, a sekcja faktury byla by pusta az do
    // przeladowania strony (ta sama pulapka, co przy przesylkach Allegro nizej).
    if (doczytanieKsef && await doczytanieKsef.dlaFaktury(z.faktura, z.id)) {
      z = pobierzZamowienie(db, z.id);
    }

    // ⚠️ NUMERY LISTOW Z ALLEGRO DOCIAGA KARTA, A NIE POLLER — i to jest decyzja, nie
    // wygoda. Allegro oddaje przesylki WYLACZNIE per zamowienie
    // (`GET /order/checkout-forms/{id}/shipments`), zapytania zbiorczego nie ma. Poller
    // chodzacy co dwie minuty po wszystkich zamowieniach musialby wiec wykonac jedno zadanie
    // NA KAZDE otwarte zamowienie w KAZDYM przebiegu — przy dwudziestu otwartych to ~14 000
    // zadan na dobe po informacje, ktora w zyciu paczki zmienia sie raz. Karta juz dzis
    // odswieza przy otwarciu status kuriera (odswiezStatusKuriera), wiec ta sciezka jest tym
    // samym, sprawdzonym wzorcem: koszt ograniczony UWAGA CZLOWIEKA, zero ruchu w tle.
    //
    // Warunek zatrzymania nie wymaga nowej kolumny-dlawika: pytamy, dopoki zamowienie NIE MA
    // `wyslane_at`, czyli dopoki wisi na liscie roboczej. Zamowienie domkniete przez czlowieka
    // przestaje generowac jakikolwiek ruch — takze przy przegladaniu archiwum, faktur
    // i reklamacji.
    //
    // ⚠️ ZNANE OGRANICZENIE TEGO WARUNKU — DOSYLKA NADANA PO OZNACZENIU WYSYLKI NIE DOJDZIE.
    // Mechanizm dopisania DRUGIEJ paczki dziala (sprawdzenie idzie po NUMERZE listu, nie po
    // liczbie wierszy), ale wyzwalacz go w tym scenariuszu nie dosiega: prawdziwa dosylka to
    // reakcja na paczke ZAGUBIONA, czyli zdarzenie z tygodnia, w ktorym zamowienie dawno ma
    // `wyslane_at` — a wtedy panel juz NIE PYTA i drugiego numeru nie zobaczy NIGDY.
    // Drugi numer dociagnie sie wylacznie wtedy, gdy Allegro odda go, ZANIM czlowiek przestawi
    // status (np. zamowienie rozbite na dwie paczki przy pakowaniu). Wyjscie awaryjne dla
    // dosylki jest reczne: rejestracja przesylki nadanej poza panelem z karty. Wciagniecie
    // dosylek wymagaloby pytania TAKZE o zamowienia wyslane, a wiec wlasnego dlawika w nowej
    // kolumnie — czyli osobnego zadania, nie doklejenia warunku tutaj.
    //
    // ⚠️ Odpornosc jest TUTAJ, a nie w usludze (ta CELOWO nie polyka bledow — inaczej awaria
    // kanalu bylaby nieodroznialna od „ta paczka nie ma jeszcze numeru"). Awaria Allegro nie
    // ma prawa wywalic karty, dokladnie jak awaria kuriera; slad idzie do logu, zeby
    // diagnozujacy mial gdzie zajrzec.
    //
    // ⚠️ DLAWIK GODZINOWY (I-3) — `wyslane_at` ogranicza CZAS ZYCIA odpytywania, a nie jego
    // TEMPO. Bez tego warunku dwadziescia razy F5 na karcie znaczylo dwadziescia zadan do
    // Allegro; teraz znaczy jedno. Uzasadnienie i sposob przechowania znacznika proby (wpis
    // do logu zamiast nowej kolumny) stoja przy `allegroWymagaOdpytania`.
    //
    // ⚠️ OD 25.08.2026 CZAS ZYCIA ODPYTYWANIA LICZY `wartoPytacAllegroONumery`
    // (domain/allegro-numery.js), a nie samo `!z.wyslane_at`. Tamten warunek gubil numer
    // PIERWSZEJ paczki, gdy operator oznaczal wysylke szybciej, niz panel zdazyl zajrzec —
    // przy zamowieniu 1207 dzielilo je DWADZIESCIA SEKUND, a na produkcji zebralo sie tak
    // 22 zamowienia Allegro bez ani jednej przesylki, mimo numerow po stronie Allegro.
    // Dlawik godzinowy zostaje bez zmian: reguly ograniczaja CZAS ZYCIA, dlawik TEMPO.
    if (przesylkiAllegro && czyKanalAllegro(z)
      && wartoPytacAllegroONumery(z, { maPrzesylke: (z.przesylki ?? []).length > 0, teraz: new Date().toISOString() })
      && allegroWymagaOdpytania(db, z.id)) {
      // Znacznik proby PRZED wywolaniem, a nie po nim: proba ma sie liczyc TAKZE wtedy, gdy
      // Allegro odpowie bledem albo nie odpowie wcale — inaczej dlawik nie objalby dokladnie
      // tych dwoch przypadkow, w ktorych boli najbardziej (awaria = zapytanie przy kazdym
      // otwarciu karty). To ta sama zasada, co przy `zapiszProbeStatusuDpd`.
      // Nieudany zapis znacznika odpuszczamy tak samo, jak kazdy inny zapis przy renderowaniu
      // karty (zapiszLubOdpusc): karta ma sie otworzyc, choćby dysk byl pelny — kosztem
      // dlawika, ktory wtedy po prostu nie dziala.
      zapiszLubOdpusc(() => dopiszLog(db, z.id, {
        akcja: AKCJA_ALLEGRO_PROBA,
        wynik: 'panel zapytał Allegro o numery listów tego zamówienia',
      }));
      try {
        // Ponowny odczyt WYLACZNIE po dopisaniu wiersza: karta renderuje sie z obiektu
        // wczytanego wyzej, wiec bez tego numer siedzialby w bazie, a sekcja paczek na
        // ekranie byla by pusta az do przeladowania strony.
        if ((await przesylkiAllegro.odswiez(z.id)).dopisane > 0) z = pobierzZamowienie(db, z.id);
      } catch (e) {
        // ⚠️ DLAWIK NA WPIS DO LOGU: ten sam blad NIE dopisuje sie w kolko przy kolejnych
        // odslonach tej samej karty. Bez tego log rosnie proporcjonalnie do liczby ODSLON,
        // a nie do liczby FAKTOW — po cofnietej zgodzie (401) kazde otwarcie karty dokladalo
        // identyczny wiersz „BŁĄD", az do zasypania historii zamowienia, ktora operator
        // czyta wlasnie przy diagnozie.
        //
        // Dlawimy PORÓWNANIEM Z OSTATNIM WPISEM TEJ AKCJI, a nie czasem — bo czas wymagalby
        // nowej kolumny (tak jest zrobiony dlawik statusu kuriera: `status_kuriera_pobrany_at`
        // w wierszu przesylki, GODZINA_MS), a kolumny tu nie ma i jej dokladanie to osobne
        // zadanie. Log JEST tu jedynym stanem, ktory przezywa zadanie, wiec jest jedynym
        // dostepnym dlawikiem bez zmiany schematu. Wpis wraca sam z siebie, gdy zmieni sie
        // FAKT: inny komunikat bledu albo udany odczyt numeru (usluga pisze pod ta sama
        // akcje, wiec jej wpis przesuwa „ostatni" i nastepna awaria znow sie odnotuje).
        //
        // ⚠️ CZEGO TO NIE ZALATWIA — i to zostaje otwarte: operator DALEJ widzi na karcie
        // „brak przesylki", bo tabeli `log` nie renderuje ZADEN widok. Awaria kanalu jest na
        // ekranie nieodroznialna od zamowienia bez paczki. Zalatwia to dopiero kolumna bledu
        // kanalu (odpowiednik `status_kuriera_blad`) razem z miejscem na nia w widoku —
        // osobne zadanie. Tutaj kasujemy wylacznie szkode robiona logowi.
        const wynik = `BŁĄD: ${e?.message ?? e}`;
        zapiszLubOdpusc(() => {
          if (ostatniWpisLogu(db, z.id, AKCJA_ALLEGRO_PRZESYLKA)?.wynik === wynik) return;
          dopiszLog(db, z.id, { akcja: AKCJA_ALLEGRO_PRZESYLKA, wynik });
        });
      }
    }

    // Awaria kuriera (sieć, timeout, INCORRECT_LOGIN_OR_PASSWORD po zmianie hasła, wygasły
    // token InPostu...) NIE MOŻE wywalić ani zawiesić karty zamówienia — karta ma się
    // wyrenderować ze starym statusem (albo bez niego), a awaria idzie do logu i na kolumnę
    // `status_kuriera_blad`, nie jako wyjątek na ekran. Twardy limit czasu na samo zapytanie
    // siedzi w kliencie kuriera (LIMIT_ZAPYTANIA_STATUS_MS — w obu, w dpd.js i w inpost.js).
    //
    // Pętla po paczkach, a nie po zamówieniu: dławik godzinowy siedzi w wierszu przesyłki,
    // więc każda paczka pyta o SWÓJ numer listu i we własnym rytmie.
    //
    // ⚠️ USŁUGĘ WYBIERAMY PO `p.kurier`, A NIE „TĘ JEDNĄ". Do Zadania 9 stało tu wywołanie
    // DPD dla KAŻDEJ przesyłki zamówienia — więc od chwili, w której panel zaczął nadawać
    // paczkomaty, numer InPostu jechałby do DPD. Karty by to nie wywaliło (odświeżanie jest
    // odporne z założenia) i właśnie dlatego było groźne: każda paczkomatowa paczka pytałaby
    // co godzinę niewłaściwego kuriera i pokazywała „status niedostępny" zamiast statusu.
    //
    // Brak klienta danego kuriera (panel bez sekcji INPOST_*) to TRYB POPRAWNY, nie awaria:
    // paczka po prostu nie jest odpytywana, karta wstaje, reszta zamówień działa dalej.
    // Ta sama zasada, co przy składaniu mapy w bootstrap.js.
    // Wybor „kogo pytac" (w tym podwykonawcy WzA) i dlawik godzinowy siedza W SRODKU
    // odswiezStatusKuriera (services/status-kuriera.js) — karta i zegar przesylek ida
    // ta sama sciezka i dziela jeden licznik proby na paczke.
    for (const p of z.przesylki) {
      await odswiezStatusKuriera(db, kurierzy, z, p);
    }

    // ⚠️ PODGLAD MAILA DOCIAGA TRASA, a nie `renderujKarte` — bo przy fakturze wymaga zapytania
    // do inFaktu (PDF na swiezo), czyli I/O, a tamta funkcja jest SYNCHRONICZNA i ma taka
    // zostac (szesc miejsc wywolania, z ktorych ZADNE inne podgladu nie pokazuje).
    //
    // ⚠️ ODMOWA NIE JEST BLEDEM STRONY. `?wiadomosc=faktura` przy zamowieniu bez faktury
    // oddaje karte z POWODEM, a nie 400 na pustym ekranie: operator ma sie dowiedziec,
    // czego dopisac (niezmiennik 4.9).
    //
    // ⚠️ ADRES CZYTA `wyborWiadomosci` — TA SAMA funkcja, ktora ustawia stan sekcji w
    // `daneWiadomosci`. Dwa niezalezne odczyty tego parametru (tak bylo do 22.08.2026) daja
    // sekcje w stanie „podglad" bez danych podgladu przy pierwszej rozbieznosci miedzy nimi.
    const wyborW = wyborWiadomosci(req);
    const dodatkiKarty = {};
    const wiadomosci = wiadomosciCzynne();
    if (wiadomosci && wyborW.stan === 'podglad') {
      try {
        dodatkiKarty.wiadomosciPodglad = await wiadomosci.podglad(z.id, wyborW.wybor);
      } catch (e) {
        dodatkiKarty.wiadomosciBlad = komunikatDlaOperatora(e);
      }
    }
    return renderujKarte(req, reply, z, dodatkiKarty);
  });
app.post('/zamowienia/:id/dane/gus', async (req, reply) => {
    const id = Number(req.params.id);
    const z = pobierzZamowienie(db, id);
    if (!z) return ekranOdmowyKarty(reply, 'Nie ma takiego zamówienia', adresPowrotuNaKarte(req, id, { kotwica: 'faktura' }), 404);
    // PRZ-102.11: klucz z pliku albo z Ustawień, sprawdzany przy każdym żądaniu (zapis działa bez restartu).
    if (!gusDostepny(gus)) return ekranOdmowyKarty(reply, KOMUNIKAT_BRAK_GUS, adresPowrotuNaKarte(req, id, { kotwica: 'faktura' }), 503);

    // NIP bierzemy Z FORMULARZA, nie z bazy: operator zwykle właśnie go wpisał albo poprawił,
    // a jeszcze nie zapisał. Branie z bazy pytałoby o STARY numer i cicho oddawało nie tę firmę.
    let nip;
    try {
      nip = nipDoZapytania(req.body?.nip);
    } catch (e) {
      return renderujKarte(req, reply, z, { komunikatGus: { rodzaj: 'blad', tekst: komunikatDlaOperatora(e) } });
    }

    let firma = null;
    try {
      firma = await gus.firmaPoNip(nip);
    } catch (e) {
      // Awaria GUS-u NIE MOŻE wywalić karty — dokładnie ta sama zasada, co przy odpytywaniu
      // DPD o status. Pełna treść idzie do logu, na ekran to, co napisaliśmy dla człowieka.
      dopiszLog(db, id, { akcja: 'dane.gus', wynik: `BŁĄD: ${e.message}` });
      return renderujKarte(req, reply, z, {
        komunikatGus: {
          rodzaj: 'blad',
          tekst: komunikatAwariiGus(e),
        },
      });
    }

    if (!firma) {
      dopiszLog(db, id, { akcja: 'dane.gus', wynik: `GUS: nie znaleziono firmy o NIP ${nip}.` });
      return renderujKarte(req, reply, z, {
        komunikatGus: { rodzaj: 'brak', tekst: `GUS nie zna firmy o NIP ${nip}. Sprawdź numer albo wpisz dane ręcznie.` },
      });
    }

    dopiszLog(db, id, {
      akcja: 'dane.gus',
      wynik: `GUS (${ktoKlikal(req)}): pobrano „${firma.firma}" (NIP ${firma.nip ?? nip}, REGON ${firma.regon ?? '—'}) `
        + '— dane WSTAWIONE DO FORMULARZA, nic jeszcze nie zapisano.',
    });
    return renderujKarte(req, reply, z, {
      daneZGus: firma,
      komunikatGus: {
        rodzaj: 'ok',
        tekst: `GUS: ${firma.firma}${firma.regon ? ` (REGON ${firma.regon})` : ''}. `
          + 'Sprawdź dane i kliknij „Zapisz" — dopóki tego nie zrobisz, nic się nie zmieniło.',
      },
    });
  });
app.post('/zamowienia/:id/dane/kopiuj-do-wysylki', async (req, reply) => {
    const id = Number(req.params.id);
    const z = pobierzZamowienie(db, id);
    if (!z) return ekranOdmowyKarty(reply, 'Nie ma takiego zamówienia', adresPowrotuNaKarte(req, id, { kotwica: 'wysylka' }), 404);
    try {
      kopiujDaneFakturyDoWysylki(id, z, req);
    } catch (e) {
      dopiszLog(db, id, { akcja: 'dane.kopiuj', wynik: `BŁĄD: ${e.message}` });
      return ekranOdmowyKarty(reply, `Nie udało się skopiować danych: ${komunikatDlaOperatora(e)}`, adresPowrotuNaKarte(req, id, { kotwica: 'wysylka' }));
    }
    return reply.redirect(adresPowrotuNaKarte(req, id, { kotwica: 'wysylka' }));
  });
app.post('/zamowienia/:id/status', async (req, reply) => {
    const id = Number(req.params.id);
    const z = pobierzZamowienie(db, id);
    if (!z) return ekranOdmowyKarty(reply, 'Nie ma takiego zamówienia', adresPowrotuNaKarte(req, id), 404);

    const docelowy = String(req.body?.status ?? '').trim();
    // Odmowa PRZED zapisem: inaczej zostawialaby polowicznie zapisane fakty.
    const odmowa = powodOdmowyStatusu(z, docelowy);
    if (odmowa) return ekranOdmowyKarty(reply, odmowa, adresPowrotuNaKarte(req, id));

    try {
      zapiszFaktyStatusu(db, id, { ...faktyDlaStatusu(z, docelowy, { powod: req.body?.powod ?? null }), kto: req.konto?.login ?? ktoKlikal(req) });
    } catch (e) {
      dopiszLog(db, id, { akcja: 'status.reczny', wynik: `BŁĄD: ${e.message}` });
      return ekranOdmowyKarty(reply, `Nie udało się zmienić statusu: ${komunikatDlaOperatora(e)}`, adresPowrotuNaKarte(req, id));
    }

    // Log zapisuje status FAKTYCZNIE OSIAGNIETY, a nie sam wybor — i to nie jest kosmetyka.
    // Fakty silniejsze od wyboru (nadana paczka bije „w realizacji") wygrywaja, wiec
    // zapisanie samego wyboru robiloby z logu opis zyczen, a nie stanu zamowienia.
    const osiagniety = wyliczStatus(pobierzZamowienie(db, id));
    dopiszLog(db, id, {
      akcja: 'status.reczny',
      wynik: `Ręcznie (${ktoKlikal(req)}): wybrano „${etykietyStatusow(db)[docelowy]}" — zapisane fakty; `
        + `status po zmianie: ${etykietyStatusow(db)[osiagniety]}`
        + `${docelowy === 'zwrot' && req.body?.powod ? `; powód zwrotu: ${String(req.body.powod).trim()}` : ''}.`,
    });
    if (syncSklep) await syncSklep.odeslijStatus(id);
    return reply.redirect(adresPowrotuNaKarte(req, id));
  });
app.post('/zamowienia/:id/wiadomosc/:temat', async (req, reply) => {
    const id = Number(req.params.id);
    if (!pobierzZamowienie(db, id)) return ekranOdmowyKarty(reply, 'Nie ma takiego zamówienia', adresPowrotuNaKarte(req, id, { kotwica: 'wiadomosci' }), 404);
    // PRZ-108.02: pytamy przy każdym żądaniu — poczta zapisana w Ustawieniach po starcie działa bez restartu.
    const wiadomosci = wiadomosciCzynne();
    if (!wiadomosci) return ekranOdmowyKarty(reply, 'Poczta nie jest skonfigurowana — wiadomości panel nie wyśle.', adresPowrotuNaKarte(req, id, { kotwica: 'wiadomosci' }), 503);

    try {
      await wiadomosci.wyslij(id, String(req.params.temat), { ktoKlikal: ktoKlikal(req) });
    } catch (e) {
      // ⚠️ Awaria SMTP i odmowa domeny wychodza TA SAMA droga, bo dla operatora to jedno
      // zdanie: „nie poszlo, i dlatego". Slad techniczny zostaje w logu karty (usluga).
      // PRZ-109.03: odmowa serwera poczty (znacznik z uslugi, kod nodemailera) dostaje zdanie z kodu, a konto
      // z dostepem do ekranu poczty — takze wskazowke, gdzie poprawic. Tresc bledu nigdy na ekran.
      const wskazUstawienia = maDostepDoAdresu(req.konto ?? null, EKRAN_POCZTY);
      return ekranOdmowyKarty(reply, `Wiadomość NIE została wysłana: ${komunikatWysylkiMaila(e, { wskazUstawienia })}`, adresPowrotuNaKarte(req, id, { kotwica: 'wiadomosci' }));
    }
    return reply.redirect(adresPowrotuNaKarte(req, id, { kotwica: 'wiadomosci' }));
  });
app.post('/zamowienia/:id/komentarz', async (req, reply) => {
    const id = Number(req.params.id);
    if (!pobierzZamowienie(db, id)) return ekranOdmowyKarty(reply, 'Nie ma takiego zamowienia', adresPowrotuNaKarte(req, id), 404);

    let komentarz;
    try {
      komentarz = znormalizujKomentarz(req.body?.komentarz);
    } catch (e) {
      // Za dlugi tekst to bledny formularz, a nie awaria — bez wpisu w logu, tak samo jak
      // przy innych odmowach walidacji na tej karcie.
      return ekranOdmowyKarty(reply, komunikatDlaOperatora(e), adresPowrotuNaKarte(req, id));
    }

    zapiszKomentarzWewnetrzny(db, id, komentarz);
    dopiszLog(db, id, {
      akcja: 'komentarz.wewnetrzny',
      wynik: komentarz
        ? `komentarz wewnetrzny zapisany (${ktoKlikal(req)}), ${komentarz.length} zn.`
        : `komentarz wewnetrzny skasowany (${ktoKlikal(req)})`,
    });
    return reply.redirect(adresPowrotuNaKarte(req, id));
  });
app.post('/zamowienia/:id/ustalenia', async (req, reply) => {
    const id = Number(req.params.id);
    if (!pobierzZamowienie(db, id)) return reply.code(404).send('Nie ma takiego zamówienia');

    let wynik;
    try {
      wynik = zmienUstalenia(db, id, {
        // Pole wyboru: przegladarka przysyla je WYLACZNIE gdy zaznaczone.
        b2b: req.body?.b2b !== undefined,
        termin_platnosci: parsujTerminZamowienia(req.body?.termin_platnosci),
        rabat_procent: req.body?.rabat_procent,
      });
    } catch (e) {
      dopiszLog(db, id, { akcja: 'ustalenia', wynik: `BŁĄD: ${e.message}` });
      return reply.code(400).send(`Nie udało się zapisać ustaleń: ${komunikatDlaOperatora(e)}`);
    }

    const zlotowki = (gr) => (gr / 100).toFixed(2);
    dopiszLog(db, id, {
      akcja: 'ustalenia',
      wynik: `Ręcznie (${ktoKlikal(req)}): kanał ${req.body?.b2b !== undefined ? 'B2B' : 'ręczne'}, `
        + `termin ${ETYKIETY_TERMINU[String(req.body?.termin_platnosci ?? '').trim()] ?? 'nieuzgodniony'}, `
        + `rabat ${wynik.rabat}%.`
        // ⚠️ DZIENNIK MUSI POWIEDZIEC, CO SIE STALO Z PIENIEDZMI. Sam „rabat 30%" nie tlumaczy,
        // dlaczego zamowienie jest warte inna kwote niz wczoraj — a to jest jedyne miejsce
        // w panelu, gdzie kwota zamowienia zmienia sie bez dotykania pozycji.
        + (wynik.zmienione.length
          ? ` Przeliczono ${wynik.zmienione.length} poz.: ${zlotowki(wynik.sumaPrzedGr)} zł → ${zlotowki(wynik.sumaPoGr)} zł.`
          : ' Żadnej pozycji nie przeliczono.')
        + (wynik.pominiete.length
          ? ` Pominięto ${wynik.pominiete.length} poz. z ceną wpisaną ręcznie: `
            + `${wynik.pominiete.map((p) => `„${p.nazwa}"`).join(', ')}.`
          : ''),
    });
    return reply.redirect(adresPowrotuNaKarte(req, id, { kotwica: 'szczegoly' }));
  });
// PRZ-104: ręczna data wysyłki („najpóźniej do”) — puste pole = powrót do standardowego terminu.
// Reguła terminu i walidacja dnia mieszkają w domenie (termin-wysylki.js); trasa tylko parsuje i zapisuje.
app.post('/zamowienia/:id/termin-wysylki', async (req, reply) => {
    const id = Number(req.params.id);
    const z = pobierzZamowienie(db, id);
    if (!z) return ekranOdmowyKarty(reply, 'Nie ma takiego zamówienia', adresPowrotuNaKarte(req, id, { kotwica: 'szczegoly' }), 404);

    // „Przywróć standardowy termin” to drugi przycisk TEGO SAMEGO formularza (`przywroc=1`):
    // wtedy pole daty, choć przyszło wypełnione, nie liczy się.
    const surowe = req.body?.przywroc ? '' : req.body?.data_wysylki;
    const bylo = recznyTermin(z);
    // Ta sama data jeszcze raz (np. „Zapisz” bez zmiany przy minionej dacie) — nic się nie dzieje;
    // inaczej odmowa „wcześniejsza niż dziś” dotyczyłaby daty, której nikt nie zmieniał.
    if ((String(surowe ?? '').trim() || null) === bylo) return reply.redirect(adresPowrotuNaKarte(req, id, { kotwica: 'szczegoly' }));

    let dzien;
    try {
      dzien = parsujDateWysylki(surowe, dzienWarszawa(new Date().toISOString()));
    } catch (e) {
      // Zła data to błędny formularz, nie awaria — bez wpisu w logu, jak inne odmowy walidacji tej karty.
      return ekranOdmowyKarty(reply, `Nie zapisano daty wysyłki: ${komunikatDlaOperatora(e)}`, adresPowrotuNaKarte(req, id, { kotwica: 'szczegoly' }));
    }
    // ⚠️ PO WYSYŁCE BEZ ZMIAN (decyzja właściciela 21.10.2026) — inaczej spóźnioną wysyłkę dałoby się
    // „poprawić” po fakcie, a statystyka terminowości przestałaby mówić prawdę. Jedyna blokada stoi
    // w zapisie (`wyslane_at IS NULL` w UPDATE), więc łapie też paczkę nadaną po otwarciu karty.
    if (!zapiszTerminWysylkiRecznego(db, id, dzien)) {
      return ekranOdmowyKarty(reply, 'Zamówienie jest już wysłane — daty wysyłki nie da się zmienić.', adresPowrotuNaKarte(req, id, { kotwica: 'szczegoly' }), 409);
    }
    const naEkran = (d) => d.split('-').reverse().join('.');
    dopiszLog(db, id, {
      akcja: 'termin.wysylki',
      wynik: dzien
        ? `Ręcznie (${ktoKlikal(req)}): data wysyłki ${naEkran(dzien)} (było: ${bylo ? naEkran(bylo) : 'standardowy termin'}).`
        : `Ręcznie (${ktoKlikal(req)}): przywrócono standardowy termin wysyłki (było: ${bylo ? naEkran(bylo) : 'standardowy termin'}).`,
    });
    return reply.redirect(adresPowrotuNaKarte(req, id, { kotwica: 'szczegoly' }));
  });
app.post('/zamowienia/:id/klient/zapamietaj', async (req, reply) => {
    const id = Number(req.params.id);
    const z = pobierzZamowienie(db, id);
    if (!z) return ekranOdmowyKarty(reply, 'Nie ma takiego zamówienia', adresPowrotuNaKarte(req, id, { kotwica: 'faktura' }), 404);

    const f = daneFaktury(z);
    const a = adresOdbiorcy(z) ?? {};
    const istniejacy = klientPoNip(db, f.nip);
    // ⚠️ NOWY KLIENT Z NIEROZPOZNANA DOSTAWA DOSTAJE DOSTAWE NIEUSTALONA (PRZ-102.24): pusta
    // metoda i pusty koszt. Allegro/Woo daja `nieznana` albo nazwe spoza `DOSTAWY` — walidacja
    // odbijala wtedy cale „Zapamietaj” z 400, a podstawione „dpd” udawaloby ustalenie, ktorego
    // nikt nie zrobil. Pusta metoda daje w `znormalizujKlienta` pusta metode i pusty koszt
    // (kolumny NOT NULL, pusty napis przechodzi).
    // ⚠️⚠️ KOSZTU Z ZAMOWIENIA NOWY KLIENT NIE DOSTAJE NIGDY, takze przy rozpoznanej metodzie:
    // to oplata za tamta jedna przesylke, nie ustalenie. Kupon darmowej wysylki dawal klientowi
    // „wysylka gratis” na stale, koszt null — 0,00, dwie paczki po 19,00 — stale 38,00.
    // Koszt zostaje pusty, a „Wstaw dane” podstawia kwote domyslna z Ustawien.
    const metodaNowego = !istniejacy && Object.hasOwn(DOSTAWY, String(z.metoda_wysylki ?? ''))
      ? z.metoda_wysylki
      : '';

    let dane;
    try {
      dane = znormalizujKlienta({
        klucz: istniejacy?.klucz ?? '',
        nazwa: f.firma || a.nazwa || z.numer,
        nip: f.nip,
        f_firma: f.firma, f_nip: f.nip, f_ulica: f.ulica, f_kod: f.kod, f_miasto: f.miasto, f_email: f.email,
        w_nazwa: a.nazwa, w_firma: a.company, w_ulica: a.ulica, w_kod: a.kod, w_miasto: a.miasto,
        w_telefon: a.telefon, w_email: a.email,
        chce_fakture: z.chce_fakture ? 'on' : '',
        // ⚠️ Dostawa i jej koszt u ISTNIEJACEGO klienta z karty, nie z zamowienia: na karte i tak
        // nie trafiaja (`daneNabywcyNaKarcie`), a walidacja ponizej odbijala 400 „Nie znam sposobu
        // dostawy” przy `metoda_wysylki = 'nieznana'` z Allegro/Woo — i adres sie nie aktualizowal.
        metoda_wysylki: istniejacy ? istniejacy.metoda_wysylki : metodaNowego,
        koszt_dostawy_brutto: istniejacy ? istniejacy.koszt_dostawy_brutto : '',
        // ⚠️ Ustalenia bierzemy z zamowienia TYLKO przy nowym wpisie. Istniejacy wpis i tak dostaje
        // nizej wszystko spoza danych nabywcy z bazy (`daneNabywcyNaKarcie`, PRZ-102.07).
        b2b: (istniejacy ? istniejacy.b2b : z.b2b) ? 'on' : '',
        rabat_procent: istniejacy ? istniejacy.rabat_procent : (z.rabat_procent ?? 0),
        termin_platnosci: istniejacy ? istniejacy.termin_platnosci : z.termin_platnosci,
        platnosc: istniejacy?.platnosc ?? '',
        komentarz: istniejacy?.komentarz ?? '',
      });
    } catch (e) {
      return ekranOdmowyKarty(reply, `Nie udało się zapamiętać klienta: ${komunikatDlaOperatora(e)}`, adresPowrotuNaKarte(req, id, { kotwica: 'faktura' }));
    }

    try {
      // ⚠️⚠️ U ISTNIEJACEGO KLIENTA TYLKO NIEPUSTE DANE NABYWCY. `zapiszKlienta` pisze komplet
      // kolumn; bez tego jeden klik zerowal umowe zbiorcza i jej kwoty, a zamowienie bez adresu
      // kasowalo adres z karty (PRZ-102.07).
      if (istniejacy) {
        dane = daneNabywcyNaKarcie(istniejacy, dane);
        zapiszKlienta(db, istniejacy.id, dane);
      } else {
        dopiszKlienta(db, dane);
      }
    } catch (e) {
      dopiszLog(db, id, { akcja: 'klient.zapamietaj', wynik: `BŁĄD: ${e.message}` });
      return ekranOdmowyKarty(reply, `Nie udało się zapamiętać klienta: ${komunikatDlaOperatora(e)}`, adresPowrotuNaKarte(req, id, { kotwica: 'faktura' }));
    }

    dopiszLog(db, id, {
      akcja: 'klient.zapamietaj',
      wynik: `Ręcznie (${ktoKlikal(req)}): ${istniejacy ? 'uaktualniono' : 'dopisano'} `
        + `stałego klienta „${dane.nazwa}" (${dane.klucz}${dane.nip ? `, NIP ${dane.nip}` : ', bez NIP-u'}) `
        + 'z danych tego zamówienia.',
    });
    return reply.redirect(adresPowrotuNaKarte(req, id, { kotwica: 'faktura' }));
  });
app.post('/zamowienia/:id/sync-sklep', async (req, reply) => {
    const id = Number(req.params.id);
    if (!pobierzZamowienie(db, id)) return ekranOdmowyKarty(reply, 'Nie ma takiego zamówienia', adresPowrotuNaKarte(req, id), 404);
    if (syncSklep) await syncSklep.odeslijStatus(id);
    return reply.redirect(adresPowrotuNaKarte(req, id));
  });
app.post('/zamowienia/:id/wysylka/metoda', async (req, reply) => {
    const id = Number(req.params.id);
    // ⚠️ ZAMOWIENIE JEST TU POTRZEBNE, a nie tylko sprawdzane. Bramka w domenie musi znac
    // KANAL (`z.sklep`), bo odmowa dla Allegro nie moze byc kluczowana metoda — metoda to
    // dokladnie ta wartosc, ktora ten formularz zmienia (patrz sprawdzZmianeMetody).
    const zam = pobierzZamowienie(db, id);
    if (!zam) return reply.code(404).send('Nie ma takiego zamówienia');

    // Pole wyboru: przegladarka przysyla je WYLACZNIE gdy zaznaczone — brak klucza znaczy
    // „bez pobrania" (ta sama zasada, co przy `chce_fakture`). ⚠️ To jest miejsce, w ktorym
    // decyzja czlowieka o inkasie wchodzi do panelu: zgubiona tutaj nie odezwie sie nigdzie
    // indziej, bo od tej chwili nikt juz o pobranie nie pyta.
    const czyPobranieZFormularza = req.body?.pobranie !== undefined;
    // ⚠️ KOD PACZKOMATU JEST ADRESEM PRZESYLKI. Bez niego zamowienia paczkomatowego nie da
    // sie nadac (domain/gotowosc-nadania.js odmawia juz na karcie), a przypadek jest zyciowy:
    // klient bywa, ze podaje kod w uwagach zamiast wybrac paczkomat w checkoucie. To pole
    // jest JEDYNYM wyjsciem z tamtej odmowy — bez niego panel wchodzilby w stan, z ktorego
    // sam nie umie wyjsc. Bramka (wielkie litery, pominiecie przy metodach bez punktu)
    // siedzi w domenie, nie tutaj.
    const { nadpisanie, blad } = sprawdzZmianeMetody(
      String(req.body?.metoda ?? '').trim(), czyPobranieZFormularza, req.body?.kwota_pobrania,
      req.body?.punkt_odbioru, zam,
    );
    // Bledny formularz, a nie awaria — wiec bez wpisu w logu, tak samo jak przy parsujPaczke.
    if (blad) return reply.code(400).send(blad);
    // PRZ-101.04 (recenzja, W2): pobranie na zamówieniu scalonym — odmowa (domena/scalanie.js).
    const pobranieGrupy = nadpisanie.pobranie ? powodOdmowyPobraniaGrupy(zam) : null;
    if (pobranieGrupy) return reply.code(400).send(pobranieGrupy);

    try {
      zapiszNadpisanieWysylki(db, id, nadpisanie);
    } catch (e) {
      dopiszLog(db, id, { akcja: 'wysylka.metoda', wynik: `BŁĄD: ${e.message}` });
      return reply.code(400).send(`Nie udało się zmienić metody wysyłki: ${komunikatDlaOperatora(e)}`);
    }
    dopiszLog(db, id, {
      akcja: 'wysylka.metoda',
      // Log nazywa OBIE decyzje — dostawe i pobranie — bo od 2026-08-01 sama nazwa metody
      // nie mowi juz nic o tym, czy kurier ma cos zainkasowac.
      wynik: `Ręcznie (${ktoKlikal(req)}): metoda wysyłki ustawiona ręcznie na ${nadpisanie.metoda}`
        + `${nadpisanie.pobranie ? ` za pobraniem, kwota pobrania ${nadpisanie.kwota_pobrania} zł` : ' (bez pobrania)'}.`,
    });
    return reply.redirect(adresPowrotuNaKarte(req, id));
  });
app.post('/zamowienia/:id/wysylka/przywroc', async (req, reply) => {
    const id = Number(req.params.id);
    const z = pobierzZamowienie(db, id);
    if (!z) return reply.code(404).send('Nie ma takiego zamówienia');
    // PRZ-101.04 (recenzja, W2): powrót do sklepu, który ma pobranie, to włączenie pobrania tylnymi
    // drzwiami — ta sama odmowa, co przy zmianie metody.
    const pobranieGrupy = pobranieZeSklepu(z) ? powodOdmowyPobraniaGrupy(z) : null;
    if (pobranieGrupy) return reply.code(400).send(pobranieGrupy);
    try {
      przywrocMetodeWysylkiZeSklepu(db, id);
    } catch (e) {
      dopiszLog(db, id, { akcja: 'wysylka.przywroc', wynik: `BŁĄD: ${e.message}` });
      return reply.code(400).send(`Nie udało się przywrócić metody: ${komunikatDlaOperatora(e)}`);
    }
    dopiszLog(db, id, {
      akcja: 'wysylka.przywroc',
      wynik: `Ręcznie (${ktoKlikal(req)}): ręczna metoda wysyłki skasowana — rządzi sklep `
        + `(${metodaZeSklepu(z)}).`,
    });
    return reply.redirect(adresPowrotuNaKarte(req, id));
  });
app.post('/zamowienia/:id/wplata', async (req, reply) => {
    const id = Number(req.params.id);
    if (!pobierzZamowienie(db, id)) return reply.code(404).send('Nie ma takiego zamówienia');
    let wplata;
    try {
      wplata = potwierdzWplate(db, id);
    } catch (e) {
      return reply.code(400).send(komunikatDlaOperatora(e));
    }
    dopiszLog(db, id, {
      akcja: 'wplata.reczna',
      wynik: `Ręcznie (${ktoKlikal(req)}): zaksięgowana wpłata ${wplata.kwota} zł z ${wplata.data}`,
    });
    return reply.redirect(adresPowrotuNaKarte(req, id));
  });
app.post('/zamowienia/:id/platnosci', async (req, reply) => {
    const id = Number(req.params.id);
    if (!pobierzZamowienie(db, id)) return reply.code(404).send('Nie ma takiego zamówienia');
    let wplata;
    try {
      wplata = parsujWplate(req.body);
    } catch (e) {
      return reply.code(400).send(komunikatDlaOperatora(e));
    }
    dodajWplateReczna(db, id, wplata);
    dopiszLog(db, id, {
      akcja: 'platnosc.dodana',
      wynik: `Ręcznie (${ktoKlikal(req)}): dopisana wpłata ${wplata.kwota} zł z ${wplata.data}`
        + `${wplata.metoda ? `, metoda: ${wplata.metoda}` : ''}${wplata.uwaga ? `, uwaga: ${wplata.uwaga}` : ''}`,
    });
    return reply.redirect(adresPowrotuNaKarte(req, id));
  });
app.post('/zamowienia/:id/platnosci/:platnoscId/usun', async (req, reply) => {
    const id = Number(req.params.id);
    const platnoscId = Number(req.params.platnoscId);
    if (!pobierzZamowienie(db, id)) return reply.code(404).send('Nie ma takiego zamówienia');
    let usunieta;
    try {
      usunieta = usunWplateReczna(db, id, platnoscId);
    } catch (e) {
      return reply.code(400).send(komunikatDlaOperatora(e));
    }
    dopiszLog(db, id, {
      akcja: 'platnosc.usunieta',
      wynik: `Ręcznie (${ktoKlikal(req)}): usunięta wpłata ręczna ${usunieta.kwota} zł`
        + ` z ${usunieta.data ?? '(bez daty)'}`,
    });
    return reply.redirect(adresPowrotuNaKarte(req, id));
  });
}