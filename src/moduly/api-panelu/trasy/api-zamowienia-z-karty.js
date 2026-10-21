import { etykietyStatusow } from '../../../oms/db/statusy.js';
import { komunikatDlaOperatora } from '../../../domena/bledy.js';
import { parsujZamowienieZKarty } from '../../../domena/zamowienie-z-karty.js';
import { czytajStawkeDomyslna } from '../../faktury/db/stawka-vat.js';
import { zalozZamowienieReczne } from '../../zamowienia/services/zamowienie-reczne.js';
import { dopiszLog, pobierzZamowienie, znajdzZamowieniaPoNumerze, zapiszFaktyStatusu, ostatniWpisLogu } from '../../../oms/db/zamowienia.js';
import { faktyDlaStatusu, anulowaneEfektywnie } from '../../../domena/status-reczny.js';
import { wyliczStatus } from '../../../domena/status.js';
import { adresOdbiorcy } from '../../../domena/adres-odbiorcy.js';
import { chceFakture, daneFaktury, firmaNabywcy } from '../../../domena/dane-faktury.js';
import { czyPobranie, nazwaDostawy, metodaWysylki, punktOdbioru, punktOdbioruOpis } from '../../../domena/wysylka.js';

const POWOD_POWTORKI = 'Zamówienie z tej karty już istnieje.';

// Zamowienie zalozone Z KARTY panelu zamowien indywidualnych. Jedyny klient tej trasy to
// panel (kontener obok, ten sam LAN) — czlowiek zaklada zamowienia formularzem.
//
// ⚠️ TRASA NIE JEST WYJETA SPOD OCHRONY CSRF (src/security/csrf.js) i nie ma byc. Klient
// serwerowy poda `Origin` sam — to jedna linijka po jego stronie, a wyjatek w strazniku
// zostalby na zawsze i dotyczylby takze przegladarki.
//
// `proforma` (services/proforma.js) jedzie tu z tego samego powodu, co do tras karty:
// panel wystawia proforme klientowi i sam ja mailuje. `null` (panel bez sekcji
// OMS_PROFORMY_*) to tryb POPRAWNY — trasa odmawia wtedy czytelnie 503, zamiast udawac,
// ze dokument powstal.
export function trasaApiZamowieniaZKarty(app, { db, config, proforma = null, syncSklep = null, kanalIndywidualny = true }) {
  // `utworzone_at` wjezdza tu WYLACZNIE po to, zeby galaz `catch` mogla rozstrzygnac, KTO
  // zalozyl znaleziony wiersz (patrz komentarz nizej). Do odpowiedzi 409 nie idzie — jej
  // ksztalt to `{ id, numer, powod }` i tyle wie o niej panel.
  function istniejace(kartaId) {
    return db.prepare('SELECT id, numer, utworzone_at FROM zamowienia WHERE karta_id = ?').get(kartaId) ?? null;
  }

  function odpowiedzPowtorki(reply, wiersz) {
    return reply.code(409).send({ id: wiersz.id, numer: wiersz.numer, powod: POWOD_POWTORKI });
  }

  function numerZamowienia(id) {
    return db.prepare('SELECT numer FROM zamowienia WHERE id = ?').get(id)?.numer ?? null;
  }

  app.post('/api/zamowienia-z-karty', async (req, reply) => {
    // PRZ-089: zamówienie z karty liczy się w raporcie jako INDYWIDUALNE — bez tego kanału raport odmówiłby
    // („brak granicy”), więc odmowa stoi tu, przy wejściu, a nie po zapisie.
    if (!kanalIndywidualny) return reply.code(503).send({ powod: 'Kanał zamówień indywidualnych jest wyłączony (OMS_KANAL_INDYWIDUALNY).' });
    let dane;
    // ⚠️ ZEGAR ODCZYTANY RAZ, NA CALA TRASE — ta sama zasada, co w trasie formularza
    // (D4): `utworzone_at` i rok serii numeracji maja pochodzic z JEDNEJ wartosci.
    const znacznik = new Date().toISOString();
    try {
      dane = parsujZamowienieZKarty(req.body ?? {}, { stawkaDomyslna: czytajStawkeDomyslna(db) });
    } catch (e) {
      return reply.code(400).send({ powod: komunikatDlaOperatora(e) });
    }

    // ⚠️ SPRAWDZENIE PRZED ZAPISEM JEST WYGODA, NIE GWARANCJA. Gwarancje daje czesciowy
    // indeks UNIQUE (Zadanie 1) — dwa zadania w tej samej chwili przejda oba przez ten
    // odczyt, a odbije sie dopiero drugi INSERT. Dlatego nizej lapiemy takze wyjatek.
    const juz = istniejace(dane.karta_id);
    if (juz) return odpowiedzPowtorki(reply, juz);

    try {
      // ⚠️ `naliczajOplate: false` — ZAMOWIENIE Z KARTY NIE DOSTAJE OPLATY ZA OBSLUGE.
      // Oplata (obsluga / usluga kurierska) nalezy sie w modelu DROPSHIPPINGOWYM: klient
      // rozliczany zbiorczo placi za to, ze nadajemy jego paczki. Tutaj sprzedajemy
      // z OFERTY zaakceptowanej przez klienta co do grosza — a `doklejOplate` dopina
      // wiersz na sam trafiony NIP, wiec klient, ktory JEST u nas takze klientem
      // zbiorczym, dostawalby fakture wyzsza od wlasnej oferty. Gorsze od kwoty jest
      // milczenie: `oplacone` po stronie OMS-u zapala sie dopiero przy pokryciu CALEJ
      // kwoty, wiec wplata rowna ofercie zostawialaby zamowienie nieoplacone, poller
      // panelu nie ustawilby `paid_at` i ETAP IV nie odpalilby sie NIGDY — a wygladaloby
      // to jak zwykle „klient jeszcze nie zaplacil". To takze jedyna spojna czytelnosc
      // `okresId: null` ponizej: to zamowienie stoi POZA rozliczeniem zbiorczym.
      const { id, numer } = zalozZamowienieReczne({
        db, dane, znacznik, okresId: null, naliczajOplate: false,
      });
      dopiszLog(db, id, {
        akcja: 'zamowienie.z-karty',
        wynik: `Zalozone z karty ${dane.karta_id} panelu indywidualnego, ${dane.pozycje.length} poz.`,
      });
      return reply.code(201).send({ id, numer });
    } catch (e) {
      // ⚠️ NAJPIERW PYTAMY WYJATEK, DOPIERO POTEM BAZE — i ta kolejnosc jest cala pointa
      // tego bloku. Zamowienie z ta karta moze w bazie LEZEC z dwoch zupelnie roznych
      // powodow, a odpowiedzi na nie sa przeciwstawne:
      //
      //   • `e.zamowienieId` (services/zamowienie-reczne.js) znaczy „numer zostal nadany
      //     PRZEZ TO zadanie, a dalszy krok padl" — zamowienie jest POL-ZALOZONE (numer jest,
      //     pozycji albo kwoty brak) i NIE WOLNO oddac na to 409. Dla panelu 409 znaczy
      //     „juz zrobione, nic nie rob": karta zostalaby oznaczona jako przeniesiona,
      //     a w OMS-ie wisialoby zamowienie za 0 zl, o ktorym nikt by sie nie dowiedzial.
      //     Numeru nie da sie zwolnic (INSERT domyka wlasna transakcje), wiec odpowiedz
      //     MUSI go niesc — panel zapisze `powod` w logu karty i to jedyny slad, po ktorym
      //     czlowiek znajdzie tamto zamowienie zamiast zakladac drugie;
      //   • brak `e.zamowienieId` przy istniejacym wierszu znaczy, ze to NASZ INSERT odbil
      //     sie od czesciowego indeksu UNIQUE — czyli rownolegle zadanie zdazylo pierwsze.
      //     To jest prawdziwa powtorka i idzie tym samym 409, co odczyt wyzej.
      //
      // ⚠️ ZNACZNIK Z WYJATKU POTRAFI ZGINAC i to nie jest teoria: `zalozZamowienieReczne`
      // dokleja `zamowienieId` tylko do wartosci, ktora jest obiektem I daje sie dopisac.
      // `throw 'tekst'`, `throw null` albo obiekt ZAMROZONY (przypisanie do zamrozonego
      // w trybie scislym rzuca TypeError w miejsce oryginalnego bledu) zostawiaja wyjatek
      // bez znacznika. Bez rozstrzygniecia ponizej trasa znalazlaby WLASNY, pol-zalozony
      // wiersz i oddala 409 — czyli panel uslyszalby „juz zrobione" o zamowieniu za 0 zl,
      // dokladnie wbrew temu, przed czym broni ten blok.
      //
      // ⚠️ ROZSTRZYGA DATA, NIE KOMPLETNOSC WIERSZA. Kuszace „ma pozycje / ma niezerowa
      // kwote = jest dokonczone" jest BLEDNE: zamowienie bez pozycji, wycenione sama
      // dostawa, to stan DOZWOLONY (decyzja wlasciciela: zadne pole formularza nie jest
      // obowiazkowe), wiec taka heurystyka oddawalaby 500 w kolko przy poprawnie zalozonym
      // zamowieniu i panel nigdy by go sobie nie zapisal. `znacznik` znamy na pewno — to ta
      // sama wartosc, ktora podalismy `zalozZamowienieReczne`, a `utworzZamowienieReczne`
      // wpisuje ja do `utworzone_at` DOKLADNIE, bez wlasnego odczytu zegara. Rownosc znaczy
      // wiec „ten wiersz zalozylo TO zadanie", i nie ma tu miejsca na osad.
      let zamowienieId = e?.zamowienieId ?? null;
      if (!zamowienieId) {
        const wiersz = istniejace(dane.karta_id);
        // ⚠️ TA GALAZ (prawdziwe 409) JEST DZIS NIEOSIAGALNA Z TESTU i to nie znaczy, ze jest
        // martwa. Zeby na nia wejsc, miedzy odczytem wyzej a naszym INSERTEM musi wcisnac sie
        // CUDZY zapis tej samej karty — a to wymaga DRUGIEGO PROCESU na tym samym pliku bazy
        // (jeden proces + synchroniczny sterownik node:sqlite + brak `await` w srodku sekwencji
        // = nikt sie nie wcisnie). Dokladnie tak wyglada wdrozenie po dolozeniu drugiego
        // kontenera albo skryptu migracyjnego obok panelu. NIE USUWAC jako kod nieuzywany:
        // to jedyna rzecz, ktora odroznia „ktos byl pierwszy" od „moja awaria".
        if (wiersz && wiersz.utworzone_at !== znacznik) return odpowiedzPowtorki(reply, wiersz);
        // Nasz wlasny pol-zalozony wiersz — odpowiedz MUSI niesc jego numer (patrz nizej).
        if (wiersz) zamowienieId = wiersz.id;
      }

      // Do dziennika idzie SUROWY komunikat bledu, na ekran (i do logu karty w panelu)
      // wylacznie `komunikatDlaOperatora` — blad techniczny niesie szczegoly infrastruktury.
      // Wpis jest PRZYPIETY do pol-zalozonego zamowienia, gdy takie powstalo: luzem wisialby
      // poza karta, na ktorej operator bedzie go szukal.
      dopiszLog(db, zamowienieId, { akcja: 'zamowienie.z-karty', wynik: `BŁĄD ZAPISU: ${e.message}` });

      const numer = zamowienieId ? numerZamowienia(zamowienieId) : null;
      const slad = numer ?? (zamowienieId ? `nr wewnętrzny ${zamowienieId}` : null);
      return reply.code(500).send({
        powod: `${komunikatDlaOperatora(e)}${slad ? ` Zamówienie zdążyło powstać (${slad}) — dokończ je w OMS-ie zamiast zakładać drugie.` : ''}`,
      });
    }
  });

  // Odczyt stanu zamowienia zalozonego z karty — panel odpytuje ta trase co 10 minut,
  // zeby wykryc wplate (Zadanie 9, poza tym repo).
  //
  // ⚠️ ODCZYT IDZIE PRZEZ pobierzZamowienie (zLinii w db/zamowienia.js), NIE surowe kolumny
  // `oplacone_at` / `anulowane` z tabeli `zamowienia`. Od migracji `przeniesWplatyDoListy`
  // (db/db.js, komentarz przy niej) te dwie kolumny sa faktami SKLEPU — poller WooCommerce
  // je odswieza co dwie minuty. Zamowienie zalozone Z TEJ KARTY ma `sklep = 'reczne'`
  // (zalozZamowienieReczne) i ZADEN poller go nie dotyka — po utworzeniu `oplacone_at`
  // zostaje `NULL` NA ZAWSZE. Jedyna prawdziwa droga do oznaczenia platnosci takiego
  // zamowienia to reczna wplata operatora z ekranu karty OMS-u (`/zamowienia/:id/wplata`
  // albo `/zamowienia/:id/platnosci`), a ta zapisuje sie WYLACZNIE do tabeli `platnosci`
  // (zrodlo='reczna') — surowej kolumny w ogole nie dotyka (db/platnosci.js: dodajWplateReczna).
  // Trasa czytajaca surowa kolumne wprost oddawalaby `oplacone: false` przez cale zycie
  // takiego zamowienia, bez wzgledu na to, ile realnych wplat operator zaksieguje — a to
  // dokladnie ta wartosc, po ktora poller panelu (Zadanie 9) siega, zeby ustawic `paid_at`
  // karty. To samo dotyczy `anulowane`: reczne anulowanie zamowienia recznego zapisuje sie
  // w `anulowane_recznie`, a efektywna wartosc (`anulowaneEfektywnie`) liczy sie z NIEJ,
  // nie z kolumny sklepowej. `pobierzZamowienie` liczy oba fakty tak samo, jak reszta OMS-u
  // (karta, lista, ekran nadania) — to JEDYNE miejsce w module, ktore ma prawo o nich mowic.
  app.get('/api/zamowienia-z-karty/:kartaId', async (req, reply) => {
    const w = db.prepare('SELECT id FROM zamowienia WHERE karta_id = ?').get(req.params.kartaId);
    if (!w) return reply.code(404).send({ powod: 'Ta karta nie ma zamówienia w OMS-ie.' });
    const z = pobierzZamowienie(db, w.id);
    return reply.send({
      id: z.id,
      numer: z.numer,
      // Fakt, nie data: panel ma wlasny znacznik `paid_at` i to on rozstrzyga o ETAPIE IV.
      oplacone: Boolean(z.oplacone_at),
      anulowane: Boolean(z.anulowane),
      kwotaBrutto: z.kwota_brutto,
    });
  });

  // ---------------------------------------------------------------------------------
  // DANE DOSTAWY I DOKUMENTU — dla strony akceptacji projektu (20.08.2026).
  //
  // Klient po zaakceptowaniu projektu ma zobaczyc, DOKAD to jedzie i na co dostanie dokument,
  // zeby zdazyl zareagowac, zanim paczka pojedzie pod zly adres. Panel tych danych NIE MA:
  // przy torze automatycznym adres zostal w sklepie, a panel zna tylko numer zamowienia.
  // (Zmierzone 20.08 na produkcji: 4 karty z 23 oplaconych mialy adres po stronie panelu.)
  //
  // ⚠️ KLUCZEM JEST ID ZAMOWIENIA, NIE `karta_id`. Trasa wyzej szuka po `karta_id`, ktore ma
  // WYLACZNIE zamowienie zalozone Z KARTY (tor reczny). Tor automatyczny — klient placi
  // w sklepie, OMS zaciaga zamowienie sam — takiego wiazania nie ma i nigdy nie dostanie;
  // panel wie o nim tylko tyle, ze `card.omsId` wskazuje ten wiersz. Trasa po `karta_id`
  // oddawalaby wiec 404 dokladnie tym zamowieniom, ktorych ta funkcja dotyczy najbardziej.
  //
  // ⚠️ WARTOSCI EFEKTYWNE, nie surowe kolumny sklepowe. Operator poprawia adres i metode
  // na karcie OMS-u (`dostawa_reczna_json`, `wysylka_reczna_json`, `klient_reczny_json`)
  // i to jego poprawka jedzie kurierem — wiec to ona ma stanac klientowi przed oczami.
  // Pokazanie surowego adresu ze sklepu znaczyloby „potwierdz dane, ktorych i tak nie uzyjemy".
  app.get('/api/zamowienia/:id/dostawa', async (req, reply) => {
    const id = Number(req.params.id);
    const z = Number.isFinite(id) ? pobierzZamowienie(db, id) : null;
    if (!z) return reply.code(404).send({ powod: 'Nie ma takiego zamówienia.' });

    const adres = adresOdbiorcy(z);
    const faktura = chceFakture(z) ? daneFaktury(z) : null;
    return reply.send({
      id: z.id,
      numer: z.numer,
      adres: {
        // `firma` OSOBNO od `nazwa` — dla osoby prywatnej firmy nie ma i nie wolno jej
        // podstawiac imieniem (patrz firmaNabywcy w domain/dane-faktury.js).
        nazwa: adres?.nazwa || null,
        firma: adres?.company || null,
        ulica: adres?.ulica || null,
        kod: adres?.kod || null,
        miasto: adres?.miasto || null,
        telefon: adres?.phone || null,
      },
      // ⚠️ „Nieznana metoda" NIE JEDZIE DO KLIENTA. Wewnątrz OMS-u to sensowna wartość
      // („do wyjaśnienia przez operatora"), ale na stronie, na której klient sprawdza swoje
      // dane, brzmi jak awaria u nas. Zamiast tego nie mówimy nic i strona pomija tę linię —
      // stan spotykany w produkcji (zamówienia sprzed mapowania metod).
      metoda: metodaWysylki(z) === 'nieznana' ? null : nazwaDostawy(z),
      punkt: punktOdbioru(z),
      punktOpis: punktOdbioruOpis(z),
      dokument: faktura ? 'faktura' : 'paragon',
      faktura: faktura
        ? {
          firma: firmaNabywcy(z) ?? faktura.firma ?? null,
          nip: faktura.nip ?? null,
          ulica: faktura.ulica ?? null,
          kod: faktura.kod ?? null,
          miasto: faktura.miasto ?? null,
        }
        : null,
    });
  });

  // ---------------------------------------------------------------------------------
  // STAN WYSYLKI — dla pollera wysylek panelu indywidualnego (26.08.2026).
  //
  // Karta panelu ma sama przejsc na „Wyslane", gdy zamowienie tutaj dostanie `wyslane_at`.
  // Do tej pory ten fakt wprowadzalo sie DWA razy (raz belka statusu w OMS-ie, raz przycisk
  // na karcie panelu), a rozjazd nie dawal o sobie znac niczym — dokladnie ta sama klasa
  // problemu, ktora 22.08 zamknela trasa `/w-realizacji`, tylko w przeciwna strone.
  //
  // ⚠️ KLUCZEM JEST ID ZAMOWIENIA, NIE `karta_id` — z tego samego powodu, co w `/dostawa`:
  // tor automatyczny zadnego `karta_id` po stronie OMS-u nie ma, a wysylka dotyczy go
  // tak samo. Panel zna `omsId` w obu torach.
  //
  // ⚠️ `wyslane_at` to fakt stawiany REKA OPERATORA (belka statusu / rejestracja wysylki);
  // nadanie przesylki go nie ustawia i to jest swiadoma decyzja tego modulu — trasa jej
  // nie obchodzi, tylko ja przekazuje. `anulowane` jest wartoscia EFEKTYWNA z zLinii
  // (sklepowe + reczne), jak we wszystkich odczytach dla panelu.
  app.get('/api/zamowienia/:id/stan-wysylki', async (req, reply) => {
    const id = Number(req.params.id);
    const z = Number.isFinite(id) ? pobierzZamowienie(db, id) : null;
    if (!z) return reply.code(404).send({ powod: 'Nie ma takiego zamówienia.' });
    return reply.send({
      id: z.id,
      numer: z.numer,
      wyslane: Boolean(z.wyslane_at),
      // Data osobno od faktu: panel zapisuje na karcie dzien PRAWDZIWEJ wysylki,
      // a nie chwile, w ktorej poller raczyl zapytac.
      wyslaneAt: z.wyslane_at ?? null,
      anulowane: Boolean(z.anulowane),
    });
  });

  // ---------------------------------------------------------------------------------
  // ZAMOWIENIE PO NUMERZE SKLEPOWYM (Etap 1a planu 2026-08-18-layout-karty-i-koniec-apilo).
  //
  // Tor automatyczny panelu idzie: oferta → zamowienie w sklepie → NUMER tego zamowienia →
  // ta trasa → `oplacone` → `paid_at` karty → ETAP IV. Zastepuje odczyt zaplaty z Apilo,
  // wiec od jej poprawnosci zalezy, czy karta rusza do produkcji za WLASCIWE pieniadze.
  //
  // ⚠️⚠️ PARAMETR `sklep` JEST OBOWIAZKOWY I TO JEST CALY SENS TEJ TRASY. Numer zamowienia
  // NIE JEST UNIKALNY MIEDZY SKLEPAMI: dwa skonfigurowane sklepy numeruja niezaleznie,
  // wiec `28060` moze istniec w obu naraz — i baza tego nie zabrania (kolumna `numer` nie ma
  // globalnego UNIQUE, czesciowy indeks pilnuje wylacznie serii recznej `R/RRRR/NNN`).
  // Trasa bez tego parametru wiazalaby karte z CUDZYM zamowieniem: panel przeczytalby cudza
  // zaplate, oznaczyl karte jako oplacona i uruchomil ETAP IV za pieniadze, ktorych ten
  // klient nie przelal. To ta sama klasa bledu, ktora zlikwidowalo przejscie z dopasowania
  // po adresie e-mail na numer oferty — i wraca tu tylnymi drzwiami, gdy numer sam ma
  // decydowac.
  // ---------------------------------------------------------------------------------
  app.get('/api/zamowienia/po-numerze/:numer', async (req, reply) => {
    // ⚠️ PUSTY NAPIS ODRZUCAMY TAK SAMO JAK BRAK PARAMETRU, i to nie jest nadgorliwosc:
    // panel sklada ten adres z wlasnej konfiguracji (`SHOP_SKLEP`), a brakujaca zmienna nie
    // znika — wchodzi do adresu jako `?sklep=`. Sprawdzenie samego `undefined` przepusciloby
    // taki adres i wrocilo do „szukaj po calej bazie", czyli dokladnie tam, przed czym ten
    // parametr stoi. Spacja to ta sama pomylka po obcieciu.
    const sklep = String(req.query?.sklep ?? '').trim();
    if (!sklep) {
      return reply.code(400).send({
        powod: 'Brakuje parametru „sklep". Numer zamówienia nie jest unikalny między sklepami '
          + '(sklepy numerują niezależnie), więc bez wskazania sklepu nie da się '
          + 'powiedzieć, o które zamówienie chodzi.',
      });
    }

    const numer = String(req.params.numer ?? '').trim();
    // ⚠️ FUNKCJA JEST W LICZBIE MNOGIEJ Z TEGO SAMEGO POWODU, dla ktorego istnieje `sklep`
    // wyzej (db/zamowienia.js, komentarz przy `znajdzZamowieniaPoNumerze`). Oddaje WSZYSTKIE
    // trafienia, a zawezenie do sklepu robimy TU — bo dopiero pelny wiersz wie, z ktorego
    // sklepu pochodzi.
    const trafienia = znajdzZamowieniaPoNumerze(db, numer)
      .map((id) => pobierzZamowienie(db, id))
      // Porownanie DOKLADNE, bez zwijania wielkosci liter. Klucz sklepu jest identyfikatorem
      // z konfiguracji (`sklep-a`, `sklep-b`), a nie tekstem dla czlowieka — „uprzejme"
      // dopasowanie rozmyte wpuszczaloby z powrotem wieloznacznosc, ktora ta trasa ma zamykac.
      .filter((z) => z && z.sklep === sklep);

    if (trafienia.length === 0) {
      return reply.code(404).send({
        powod: `Sklep „${sklep}" nie ma zamówienia o numerze „${numer}".`,
      });
    }
    // ⚠️ WIELOZNACZNOSC MIMO PODANEGO SKLEPU = ODMOWA, NIGDY „WEZ PIERWSZE". Do jednej bazy
    // pisze i biezacy poller, i jednorazowy import historii (services/import-apilo.js), a
    // kolumna `numer` nie ma UNIQUE — dwa wiersze o tym samym numerze w tym samym sklepie sa
    // wiec osiagalne. Zgadniecie wiaze karte panelu z zamowieniem NA STALE, wiec jedyna
    // uczciwa odpowiedz brzmi „nie wiem, ktore" — a odpowiedz NIE NIESIE zadnego `id`,
    // bo panel, ktory je dostanie, i tak go uzyje.
    if (trafienia.length > 1) {
      return reply.code(409).send({
        powod: `Numer „${numer}" pasuje w sklepie „${sklep}" do więcej niż jednego zamówienia `
          + `(${trafienia.length}) — nie da się wskazać jednoznacznie. Zgłoś to jako usterkę.`,
      });
    }

    const [z] = trafienia;
    return reply.send({
      id: z.id,
      numer: z.numer,
      sklep: z.sklep,
      // ⚠️ TE DWA FAKTY LICZY `pobierzZamowienie`, A NIE SUROWE KOLUMNY — z tego samego
      // powodu, co w trasie wyzej: `oplacone_at` zapala sie dopiero przy pokryciu CALEJ
      // kwoty (z listy wplat), a `anulowane` sumuje anulowanie sklepu z recznym.
      oplacone: Boolean(z.oplacone_at),
      anulowane: Boolean(z.anulowane),
      kwotaBrutto: z.kwota_brutto,
      // Kolumna jest liczbowa (0/1), a NULL znaczy „jeszcze nie przeliczone" (db/db.js
      // dolicza je przy starcie). Panel pyta o fakt, wiec dostaje fakt — a nie trzy stany,
      // z ktorych dwa musialby traktowac tak samo.
      indywidualne: Boolean(z.indywidualne),
    });
  });

  // ---------------------------------------------------------------------------------
  // PROFORMA DLA PANELU (Etap 1b tego samego planu).
  //
  // ⚠️ TRASY PRZEGLADARKOWE (POST /zamowienia/:id/proforma, GET /proformy/:id/pdf
  // w routes/zamowienia.js) ZOSTAJA NIETKNIETE. Te tutaj sa DODATKIEM, nie zamiana, bo panel
  // potrzebuje czego innego niz czlowiek przy karcie OMS-u:
  //   • tamta odpowiada `302` na ekran HTML karty — klient serwerowy nie ma z tego jak
  //     wyciagnac numeru dokumentu ani adresu pliku;
  //   • tamta oddaje PDF z `Content-Disposition: attachment` — instrukcja dla przegladarki,
  //     bez znaczenia dla panelu, ktory bierze bajty i wpina je do maila jako WLASNY
  //     zalacznik.
  // Ujednolicenie starych tras do ksztaltu API zostawiloby operatora karty z golym JSON-em
  // zamiast powrotu na zamowienie.
  //
  // ⚠️ OMS NIE MA I NIE DOSTANIE MAILERA (zero `nodemailer`/`sendMail` w calym src/oms/).
  // Proforme MAILUJE PANEL — tutaj konczy sie na oddaniu numeru i bajtow.
  // ---------------------------------------------------------------------------------

  // Kolejnosc sprawdzen JAK W TRASIE PRZEGLADARKOWEJ (routes/zamowienia.js): najpierw
  // „czy jest takie zamowienie", potem „czy proformy sa skonfigurowane". Dwie postacie tej
  // samej operacji nie moga odpowiadac roznie na to samo zadanie.
  app.post('/api/zamowienia/:id/proforma', async (req, reply) => {
    const id = Number(req.params.id);
    if (!pobierzZamowienie(db, id)) return reply.code(404).send({ powod: 'Nie ma takiego zamówienia.' });
    if (!proforma) return reply.code(503).send({ powod: 'Proformy nie są skonfigurowane.' });
    let p;
    try {
      // SYNCHRONICZNIE — caly dokument powstaje u nas, bez sieci (services/proforma.js).
      p = proforma.wystaw(id);
    } catch (e) {
      // ⚠️ ODMOWA MA DOJSC NA ZEWNATRZ W CALOSCI. `czyWolnoWystawic` odmawia po polsku
      // („zamówienie jest anulowane", „wyszłaby na 0,00 zł") i panel wpisuje ten tekst do
      // logu karty — to jedyna rzecz, z ktorej czlowiek dowie sie, czemu dokument nie
      // powstal. Blad techniczny (sterownik bazy, sciezka serwera) zostaje w dzienniku,
      // dokladnie jak przy zakladaniu zamowienia wyzej.
      dopiszLog(db, id, { akcja: 'proforma.http', wynik: `BŁĄD: ${e.message}` });
      return reply.code(400).send({ powod: `Nie udało się wystawić proformy: ${komunikatDlaOperatora(e)}` });
    }
    // ⚠️ `id` W ODPOWIEDZI TO IDENTYFIKATOR PROFORMY, NIE ZAMOWIENIA — cala odpowiedz opisuje
    // POWSTALY DOKUMENT. Proforma ma HISTORIE (kolejna uniewaznia poprzednia), wiec kazda ma
    // wlasny, staly adres do pobrania — i to on jedzie w `pdfUrl` gotowy, zamiast byc sklejany
    // po stronie panelu z identyfikatora. Dwa miejsca wiedzace, jak wyglada ta trasa,
    // rozjechalyby sie przy pierwszej zmianie adresu.
    return reply.code(201).send({ id: p.id, numer: p.numer, pdfUrl: `/api/proformy/${p.id}/pdf` });
  });

  // Bajty proformy dla panelu. GET, bo to czysty odczyt — i BEZ `Content-Disposition`:
  // panel nie zapisuje pliku na dysk przegladarki, tylko wklada go do maila.
  app.get('/api/proformy/:id/pdf', async (req, reply) => {
    if (!proforma) return reply.code(503).send({ powod: 'Proformy nie są skonfigurowane.' });
    const id = Number(req.params.id);
    let wynik;
    try {
      wynik = proforma.pdf(id);
    } catch (e) {
      // Brak wiersza, brak sciezki, brak pliku na dysku — dla panelu to jedno: „nie ma czego
      // pobrac". Powod jest operatorski i ma dojsc do logu karty w calosci.
      return reply.code(404).send({ powod: komunikatDlaOperatora(e) });
    }
    return reply.type('application/pdf').send(wynik.bajty);
  });

  /**
   * AKCEPTACJA PROJEKTU → „W realizacji" (22.08.2026).
   *
   * Klient klika „Akceptuję projekt" na stronie sklepu, panel zamowien indywidualnych
   * przesuwa swoja karte do realizacji — i tym samym wywolaniem przesuwa TU zamowienie.
   * Do tego dnia robil to czlowiek, klikajac belke statusu w OMS-ie: ta sama informacja
   * wprowadzana dwa razy, a rozjazd („karta w realizacji, zamowienie dalej indywidualne")
   * nie dawal o sobie znac NICZYM.
   *
   * Zgodne z zasada statusu z 2026-08-07 (PRZEWODNIK 4.x): wyjscie ze statusu
   * „Indywidualne" to `w_realizacji_at` i nic wiecej — zadnej nowej kolumny, zadnego
   * nowego przelacznika. Zmieniamy wylacznie to, KTO go zapisuje.
   *
   * ⚠️ TRASA JEST WASKA Z ROZMYSLEM: ustawia WYLACZNIE „w realizacji". Ogolne
   * „ustaw status" dalo by panelowi droge do „anulowane" i „wyslane" — a to sa rzeczy
   * nieodwracalne, ktorych zaden automat nie powinien miec w zasiegu.
   */
  app.post('/api/zamowienia/:id/w-realizacji', async (req, reply) => {
    const id = Number(req.params.id);
    const z = Number.isFinite(id) ? pobierzZamowienie(db, id) : null;
    if (!z) return reply.code(404).send({ powod: 'Nie ma takiego zamówienia.' });

    const status = wyliczStatus(z);

    // ⚠️⚠️ CZEGO NIE WOLNO COFNAC. `faktyDlaStatusu(z,'w_realizacji')` KASUJE `wyslane_at` —
    // co jest poprawne przy swiadomym cofnieciu z belki karty, a zabojcze tutaj: spozniona
    // akceptacja zdjelaby zamowieniu status „Wyslane", paczka wrocilaby na liste robocza
    // i dalaby sie nadac DRUGI RAZ. Tak samo anulowanie i zwrot: automat nie ma prawa
    // wskrzeszac zamowien, ktore czlowiek zamknal.
    const odmowa = z.wyslane_at ? 'Zamówienie jest już wysłane — status zostaje bez zmian.'
      : anulowaneEfektywnie(z) ? 'Zamówienie jest anulowane — status zostaje bez zmian.'
        : (z.zwrot_at || z.ma_zwrot) ? 'Zamówienie ma zarejestrowany zwrot — status zostaje bez zmian.'
          : null;
    if (odmowa) {
      dopiszLog(db, id, { akcja: 'status.automat', wynik: `ODMOWA: akceptacja projektu w panelu, ale ${odmowa}` });
      return reply.code(409).send({ id: z.id, numer: z.numer, status, powod: odmowa });
    }

    // Idempotencja: `faktyDlaStatusu` zachowuje istniejace `w_realizacji_at` (`|| teraz`),
    // wiec drugi przebieg pollera niczego nie przestawia. Zapis i tak wykonujemy, bo ten
    // sam UPDATE zeruje ewentualny stary `zwrot_powod` — a dlawimy LOG, nie zapis.
    const zachowajEtap = (z.statusy_wlasne ?? []).some(s => s.klucz === z.status_wlasny && s.jak === 'w_realizacji');
    zapiszFaktyStatusu(db, id, { ...faktyDlaStatusu(z, 'w_realizacji'), zachowaj_status_wlasny: zachowajEtap });

    // Log mowi WPROST, ze zrobil to automat — inaczej wpis wygladalby jak decyzja czlowieka,
    // a przy sporze „kto to przestawil" to jedyny slad. Dlawimy powtorki (wzorzec
    // `ostatniWpisLogu`): poller panelu potrafi zapytac ponownie, a log ma rosnac
    // proporcjonalnie do liczby ZDARZEN, nie odpytan.
    const wpis = `AUTOMAT: klient zaakceptował projekt w panelu indywidualnym — status: ${etykietyStatusow(db).w_realizacji}`;
    if (ostatniWpisLogu(db, id, 'status.automat')?.wynik !== wpis) {
      dopiszLog(db, id, { akcja: 'status.automat', wynik: wpis });
    }

    // Odeslanie statusu do sklepu — ta sama droga, co przy recznej zmianie z belki karty.
    // Pominiecie go tutaj znaczyloby, ze zamowienie zmienia stan inaczej w zaleznosci od
    // tego, kto je przestawil.
    if (syncSklep) await syncSklep.odeslijStatus(id);

    const po = pobierzZamowienie(db, id);
    return reply.send({ id: po.id, numer: po.numer, status: wyliczStatus(po), wRealizacjiAt: po.w_realizacji_at });
  });
}
