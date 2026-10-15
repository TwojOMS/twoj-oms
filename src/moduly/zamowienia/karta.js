import { pobierzZamowienie, potwierdzWplate, dopiszLog, zapiszFaktyStatusu, zapiszNadpisanieWysylki, przywrocMetodeWysylkiZeSklepu, zapiszKomentarzWewnetrzny, ostatniWpisLogu } from '../../oms/db/zamowienia.js';
import { AKCJA_LOGU as AKCJA_ALLEGRO_PRZESYLKA } from '../wysylka/services/przesylki-allegro.js';
import { odswiezStatusKuriera, zapiszLubOdpusc } from '../wysylka/services/status-kuriera.js';
import { wyliczStatus, ETYKIETY } from '../../domena/status.js';
import { faktyDlaStatusu, powodOdmowyStatusu } from '../../domena/status-reczny.js';
import { sprawdzZmianeMetody, metodaZeSklepu, czyKanalAllegro } from '../../domena/wysylka.js';
import { wartoPytacAllegroONumery } from '../../domena/allegro-numery.js';
import { join } from 'node:path';
import { komunikatDlaOperatora } from '../../domena/bledy.js';
import { znormalizujKomentarz } from '../../domena/komentarz-wewnetrzny.js';
import { adresOdbiorcy } from '../../domena/adres-odbiorcy.js';
import { daneFaktury } from '../../domena/dane-faktury.js';
import { parsujPaczke } from '../../domena/paczka.js';
import { nipDoZapytania, komunikatAwariiGus } from '../../domena/gus.js';
import { ETYKIETY_TERMINU, parsujTerminZamowienia } from '../../domena/termin-platnosci.js';
import { znormalizujKlienta } from '../../domena/klient-staly.js';
import { klientPoNip, dopiszKlienta, zapiszKlienta } from '../../oms/db/klienci.js';
import { zmienUstalenia } from './services/rabat.js';
import { parsujWplate } from '../../domena/platnosci.js';
import { dodajWplateReczna, usunWplateReczna } from '../../oms/db/platnosci.js';
import {teraz,AKCJA_ALLEGRO_PROBA,allegroWymagaOdpytania,miniaturyEkranu,ktoKlikal,sprzedawcaSpecyfikacji,daneKarty,KATALOG_WIDOKOW,fragment} from './wspolne.js';
export function registerKartaRoutes(app, kontekst) {
const {db,config,poller,nadanie,faktura,proforma,kurierzy,gus,syncSklep,wiadomosci,przesylkiAllegro,stanyKanalow,zdrowie,fakturaAllegro,fakturaHurtem,doczytanieKsef,powrotKarty,adresPowrotuNaKarte,wczytajListe,statusyDlaKarty,OKNO_OSTRZEZEN_PRZESYLEK_DNI,zbierzOstrzezenia,wyborWiadomosci,daneWiadomosci,renderujKarte,renderujNowe,magazynEkranu,niesiePolaFormularza,opisZmian,kopiujDaneFakturyDoWysylki,pozycjaZadania,zWynikami,magazynDlaKarty}=kontekst;
app.get('/zamowienia/:id', async (req, reply) => {
    let z = pobierzZamowienie(db, Number(req.params.id));
    if (!z) return reply.code(404).send('Nie ma takiego zamówienia');

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
    if (!z) return reply.code(404).send('Nie ma takiego zamówienia');
    if (!gus) return reply.code(503).send('GUS nie jest skonfigurowany (brak GUS_KLUCZ) — wpisz dane ręcznie.');

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
    if (!z) return reply.code(404).send('Nie ma takiego zamówienia');
    try {
      kopiujDaneFakturyDoWysylki(id, z, req);
    } catch (e) {
      dopiszLog(db, id, { akcja: 'dane.kopiuj', wynik: `BŁĄD: ${e.message}` });
      return reply.code(400).send(`Nie udało się skopiować danych: ${komunikatDlaOperatora(e)}`);
    }
    return reply.redirect(adresPowrotuNaKarte(req, id, { kotwica: 'wysylka' }));
  });
app.post('/zamowienia/:id/status', async (req, reply) => {
    const id = Number(req.params.id);
    const z = pobierzZamowienie(db, id);
    if (!z) return reply.code(404).send('Nie ma takiego zamówienia');

    const docelowy = String(req.body?.status ?? '').trim();
    // Odmowa PRZED zapisem: inaczej zostawialaby polowicznie zapisane fakty.
    const odmowa = powodOdmowyStatusu(z, docelowy);
    if (odmowa) return reply.code(400).send(odmowa);

    try {
      zapiszFaktyStatusu(db, id, faktyDlaStatusu(z, docelowy, { powod: req.body?.powod ?? null }));
    } catch (e) {
      dopiszLog(db, id, { akcja: 'status.reczny', wynik: `BŁĄD: ${e.message}` });
      return reply.code(400).send(`Nie udało się zmienić statusu: ${komunikatDlaOperatora(e)}`);
    }

    // Log zapisuje status FAKTYCZNIE OSIAGNIETY, a nie sam wybor — i to nie jest kosmetyka.
    // Fakty silniejsze od wyboru (nadana paczka bije „w realizacji") wygrywaja, wiec
    // zapisanie samego wyboru robiloby z logu opis zyczen, a nie stanu zamowienia.
    const osiagniety = wyliczStatus(pobierzZamowienie(db, id));
    dopiszLog(db, id, {
      akcja: 'status.reczny',
      wynik: `DECYZJA CZŁOWIEKA (${ktoKlikal(req)}): wybrano „${ETYKIETY[docelowy]}" — zapisane fakty; `
        + `status po zmianie: ${ETYKIETY[osiagniety]}`
        + `${docelowy === 'zwrot' && req.body?.powod ? `; powód zwrotu: ${String(req.body.powod).trim()}` : ''}.`,
    });
    if (syncSklep) await syncSklep.odeslijStatus(id);
    return reply.redirect(adresPowrotuNaKarte(req, id));
  });
app.post('/zamowienia/:id/wiadomosc/:temat', async (req, reply) => {
    const id = Number(req.params.id);
    if (!pobierzZamowienie(db, id)) return reply.code(404).send('Nie ma takiego zamówienia');
    if (!wiadomosci) return reply.code(503).send('Poczta nie jest skonfigurowana — wiadomości panel nie wyśle.');

    try {
      await wiadomosci.wyslij(id, String(req.params.temat), { ktoKlikal: ktoKlikal(req) });
    } catch (e) {
      // ⚠️ Awaria SMTP i odmowa domeny wychodza TA SAMA droga, bo dla operatora to jedno
      // zdanie: „nie poszlo, i dlatego". Slad techniczny zostaje w logu karty (usluga).
      return reply.code(400).send(`Wiadomość NIE została wysłana: ${komunikatDlaOperatora(e)}`);
    }
    return reply.redirect(adresPowrotuNaKarte(req, id, { kotwica: 'wiadomosci' }));
  });
app.post('/zamowienia/:id/komentarz', async (req, reply) => {
    const id = Number(req.params.id);
    if (!pobierzZamowienie(db, id)) return reply.code(404).send('Nie ma takiego zamowienia');

    let komentarz;
    try {
      komentarz = znormalizujKomentarz(req.body?.komentarz);
    } catch (e) {
      // Za dlugi tekst to bledny formularz, a nie awaria — bez wpisu w logu, tak samo jak
      // przy innych odmowach walidacji na tej karcie.
      return reply.code(400).send(komunikatDlaOperatora(e));
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
      wynik: `DECYZJA CZŁOWIEKA (${ktoKlikal(req)}): kanał ${req.body?.b2b !== undefined ? 'B2B' : 'ręczne'}, `
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
app.post('/zamowienia/:id/klient/zapamietaj', async (req, reply) => {
    const id = Number(req.params.id);
    const z = pobierzZamowienie(db, id);
    if (!z) return reply.code(404).send('Nie ma takiego zamówienia');

    const f = daneFaktury(z);
    const a = adresOdbiorcy(z) ?? {};
    const istniejacy = klientPoNip(db, f.nip);

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
        metoda_wysylki: z.metoda_wysylki,
        koszt_dostawy_brutto: z.koszt_dostawy_brutto,
        // ⚠️ Ustalenia bierzemy z zamowienia TYLKO przy nowym wpisie — patrz naglowek trasy.
        b2b: (istniejacy ? istniejacy.b2b : z.b2b) ? 'on' : '',
        rabat_procent: istniejacy ? istniejacy.rabat_procent : (z.rabat_procent ?? 0),
        termin_platnosci: istniejacy ? istniejacy.termin_platnosci : z.termin_platnosci,
        platnosc: istniejacy?.platnosc ?? '',
        komentarz: istniejacy?.komentarz ?? '',
      });
    } catch (e) {
      return reply.code(400).send(`Nie udało się zapamiętać klienta: ${komunikatDlaOperatora(e)}`);
    }

    try {
      if (istniejacy) zapiszKlienta(db, istniejacy.id, dane);
      else dopiszKlienta(db, dane);
    } catch (e) {
      dopiszLog(db, id, { akcja: 'klient.zapamietaj', wynik: `BŁĄD: ${e.message}` });
      return reply.code(400).send(`Nie udało się zapamiętać klienta: ${komunikatDlaOperatora(e)}`);
    }

    dopiszLog(db, id, {
      akcja: 'klient.zapamietaj',
      wynik: `DECYZJA CZŁOWIEKA (${ktoKlikal(req)}): ${istniejacy ? 'uaktualniono' : 'dopisano'} `
        + `stałego klienta „${dane.nazwa}" (${dane.klucz}${dane.nip ? `, NIP ${dane.nip}` : ', bez NIP-u'}) `
        + 'z danych tego zamówienia.',
    });
    return reply.redirect(adresPowrotuNaKarte(req, id, { kotwica: 'faktura' }));
  });
app.post('/zamowienia/:id/sync-sklep', async (req, reply) => {
    const id = Number(req.params.id);
    if (!pobierzZamowienie(db, id)) return reply.code(404).send('Nie ma takiego zamówienia');
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
      wynik: `DECYZJA CZŁOWIEKA (${ktoKlikal(req)}): metoda wysyłki ustawiona ręcznie na ${nadpisanie.metoda}`
        + `${nadpisanie.pobranie ? ` za pobraniem, kwota pobrania ${nadpisanie.kwota_pobrania} zł` : ' (bez pobrania)'}.`,
    });
    return reply.redirect(adresPowrotuNaKarte(req, id));
  });
app.post('/zamowienia/:id/wysylka/przywroc', async (req, reply) => {
    const id = Number(req.params.id);
    const z = pobierzZamowienie(db, id);
    if (!z) return reply.code(404).send('Nie ma takiego zamówienia');
    try {
      przywrocMetodeWysylkiZeSklepu(db, id);
    } catch (e) {
      dopiszLog(db, id, { akcja: 'wysylka.przywroc', wynik: `BŁĄD: ${e.message}` });
      return reply.code(400).send(`Nie udało się przywrócić metody: ${komunikatDlaOperatora(e)}`);
    }
    dopiszLog(db, id, {
      akcja: 'wysylka.przywroc',
      wynik: `DECYZJA CZŁOWIEKA (${ktoKlikal(req)}): ręczna metoda wysyłki skasowana — rządzi sklep `
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
      wynik: `DECYZJA CZŁOWIEKA (${ktoKlikal(req)}): zaksięgowana wpłata ${wplata.kwota} zł z ${wplata.data}`,
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
      wynik: `DECYZJA CZŁOWIEKA (${ktoKlikal(req)}): dopisana wpłata ${wplata.kwota} zł z ${wplata.data}`
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
      wynik: `DECYZJA CZŁOWIEKA (${ktoKlikal(req)}): usunięta wpłata ręczna ${usunieta.kwota} zł`
        + ` z ${usunieta.data ?? '(bez daty)'}`,
    });
    return reply.redirect(adresPowrotuNaKarte(req, id));
  });
}