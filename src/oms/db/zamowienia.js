import { zStatusamiWlasnymi, maTabeleStatusow, kolumnyStatusow } from './statusy.js';
import {
  metodaWysylki, kwotaPobrania, czyPobranie, punktOdbioru, punktOdbioruOpis,
} from '../../domena/wysylka.js';
import { anulowaneEfektywnie } from '../../domena/status-reczny.js';
import { dataPokryciaWplat, brakujacaKwotaGrosze } from '../../domena/platnosci.js';
import { zl, kwotaOczekiwanaGrosze, wysylkaBruttoGrosze } from '../../domena/suma-pozycji.js';
import { wysylkaEfektywna } from '../../domena/wysylka-kwota.js';
import { nalozNadpisaniaPozycji } from '../../domena/pozycje-reczne.js';
import { zdjeciePozycji } from '../../domena/miniatury.js';
import { bladOperatora } from '../../domena/bledy.js';
import { ktoTeraz } from '../../domena/kontekst-zadania.js';
import { idsDolaczonych } from '../../domena/scalanie.js';
// ⚠️ NIP nabywcy i jego normalizacja — TE SAME funkcje, ktorych uzywa faktura
// i „Zapamietaj tego klienta" (patrz `zamowieniaPoNip` na koncu pliku).
import { daneFaktury } from '../../domena/dane-faktury.js';
import { normalizujNip } from '../../domena/klient-zbiorczy.js';
import { platnosciZamowienia, platnosciDlaZamowien, zsynchronizujWplateSklepu, dodajWplateReczna } from './platnosci.js';
import { zwrotyZamowienia, zwrotyDlaZamowien } from './zwroty.js';

const teraz = () => new Date().toISOString();

// Porzadek pozycji jest CZESCIA REGULY, nie kosmetyka widoku — z dwoch powodow naraz:
//
//  1. numer porzadkowy pozycji jest ZAPASOWYM kluczem recznych nadpisan (kluczPozycji
//     w domain/pozycje-reczne.js), wiec nieustalona kolejnosc znaczylaby inne przypisanie
//     poprawek przy kazdym odczycie;
//  2. pozycje SKLEPOWE dostaja przy kazdej synchronizacji nowe, WYZSZE `id` (DELETE + INSERT),
//     wiec samo ORDER BY id wypychaloby pozycje dopisana recznie na POCZATEK tabeli co dwie
//     minuty — numeracja na karcie tanczylaby operatorowi przed oczami.
//
// Stad: najpierw sklep (w kolejnosci ze sklepu), potem dopiski, kazdy po `id`.
const PORZADEK_POZYCJI = "ORDER BY CASE WHEN zrodlo = 'reczna' THEN 1 ELSE 0 END, p.id";

// ⚠️ ZDJECIE POZYCJI Z ALLEGRO PRZYCHODZI ZLACZENIEM, A NIE Z KOLUMNY `pozycje.zdjecie_url`.
//
// Formularz zakupowy Allegro zdjecia nie niesie, wiec przy zapisie nie ma czego wpisac —
// a wpisanie go tam POZNIEJ nie mialoby sensu, bo poller kasuje i wstawia pozycje sklepowe
// co dwie minuty (przewodnik OMS, 4.7) i adres przepadalby przy kazdej synchronizacji.
// Adres mieszka wiec w pamieci podrecznej kluczowanej OFERTA (`zdjecia_ofert`, patrz
// db/schema.sql i db/zdjecia-ofert.js), a odczyt dokleja go tutaj.
//
// ⚠️ ZLACZENIE ZEWNETRZNE (LEFT JOIN) i osobna nazwa kolumny (`zdjecie_oferty`), a nie
// COALESCE wprost na `zdjecie_url`. Dwa powody:
//   * COALESCE w SELECT-cie oddawalby DWIE kolumny o tej samej nazwie (`p.*` juz niesie
//     `zdjecie_url`), a ktora z nich wygra przy budowaniu obiektu wiersza, jest sprawa
//     sterownika — na taki szczegol nie wolno stawiac miniatur w calym panelu;
//   * regula „ktore zrodlo wygrywa" ma stac w DOMENIE (zdjeciePozycji w domain/miniatury.js),
//     a nie w napisie SQL — dokladnie tak samo, jak reszta regul tej karty.
//
// ⚠️ SKLEPOM TO NIC NIE ZMIENIA. Pozycje z WooCommerce maja `oferta_id` puste, wiec
// zlaczenie nie trafia ANI RAZU i `zdjecie_oferty` jest tam zawsze NULL — `sklep_b` i `sklep_a`
// czytaja dokladnie te sama wartosc, co przed ta zmiana.
const POZYCJE_ZE_ZDJECIEM = 'SELECT p.*, o.zdjecie_url AS zdjecie_oferty FROM pozycje p'
  + ' LEFT JOIN zdjecia_ofert o ON o.oferta_id = p.oferta_id';

// Doklejenie adresu z pamieci ofert — JEDNO miejsce dla karty, listy i ekranu nadania.
// Sama regula wyboru zrodla siedzi w domenie; tutaj zostaje wylacznie jej zastosowanie.
const zZdjeciemOferty = (p) => ({ ...p, zdjecie_url: zdjeciePozycji(p) });

function wiersz(db, sklep, zrodloId) {
  return db.prepare('SELECT * FROM zamowienia WHERE sklep = ? AND zrodlo_id = ?').get(sklep, zrodloId);
}

// ---------------------------------------------------------------------------------
// ⚠️ BRAK DANYCH U ZRODLA NIE KASUJE DANYCH U NAS — niezmiennik dodany przy Allegro
// (Etap 4, spec 5.4; przewodnik OMS 4.7a). Allegro udostepnia dane osobowe kupujacego przez
// OGRANICZONY CZAS, a poller nadpisuje `klient_json`/`dostawa_json` co dwie minuty
// (przewodnik 4.7). Bez tej reguly w dniu, w ktorym Allegro przestanie oddawac dane, panel
// SKASOWALBY adres z karty zamowienia — byc moze takiego, ktore wlasnie czeka na wysylke.
//
// ⚠️ TA WARSTWA CELOWO NIE WIE, „CO ZNACZY PUSTY ADRES", i to jest sedno tej reguly.
// `zapiszZamowienie` jest WSPOLNE dla wszystkich kanalow — jada nim zywe sklepy
// (sklep A, sklep B), na ktorych panel naprawde nadaje DPD i InPost. Tutaj
// widac wylacznie `null` kontra „jakis obiekt", bo tylko tyle jest prawda dla KAZDEGO
// kanalu naraz. Skanowanie pol bloku w tym miejscu bylo bledem, ktory kosztowalby sklep:
// `country` jest dla Allegro naszym domyslem, a dla WooCommerce prawdziwa dana sklepu, wiec
// jedna regula musialaby o jednym z kanalow klamac. Zamrozony nieaktualny `shipping` Woo
// rozbraja `brakujacePolaAdresu` (domain/adres-odbiorcy.js) — jedyny bezpiecznik przed
// nadaniem paczki bez adresu — i podstawia na ekranie nadania wiarygodny STARY adres.
//
// Rozpoznanie „koperta z wyzerowanymi polami to brak adresu" nalezy do KANALU i mieszka
// w `adresPanelu` (domain/allegro-mapowanie.js): tam wiadomo, ze `country` wpisujemy sami,
// a `email`/`phone` sa doklejane z `buyer`/`delivery`, wiec blok nigdy nie sklada sie
// z samego adresu. Mapowanie oddaje wtedy `null` i regula ponizej po prostu go przepuszcza.
//
// ⚠️ Dotyczy WYLACZNIE `klient_json` i `dostawa_json`. `kwota_brutto`, `status_woo` czy `nip`
// przychodzace puste to AWARIA ZRODLA, a nie brak danych osobowych, i maja byc WIDOCZNE —
// zamrozenie ich na ostatniej niepustej wartosci ukryloby zepsuty kanal. (`nip`
// i `punkt_odbioru` sa jawnym dlugiem — przewodnik OMS 4.7a.)
//
// ⚠️ Tylko sciezka UPDATE. Przy INSERT nie ma czego chronic, a zamiana pustki na `NULL`
// zabralaby mozliwosc odroznienia „zrodlo nie ma adresu" od „adres jeszcze nie doczytany".
// ---------------------------------------------------------------------------------
const daneOsoboweAlboNull = (v) => (v == null ? null : JSON.stringify(v));

export function zapiszZamowienie(db, sklep, z, surowe) {
  const istniejace = wiersz(db, sklep, z.zrodlo_id);
  const surowyJson = JSON.stringify(surowe ?? null);
  // Kupony to dana SKLEPU jak uwagi czy status — poller odswieza ja przy kazdej
  // synchronizacji (kupon zdjety z zamowienia w sklepie ma tu zniknac). NULL, nie '[]',
  // dla zamowienia bez kuponow: kanaly bez tego pojecia (Allegro, reczne) i zamowienia
  // bez kodu maja wygladac identycznie — patrz domain/kupony.js.
  const kuponyJson = z.kupony?.length ? JSON.stringify(z.kupony) : null;
  // Skad przyszlo zamowienie — dana SKLEPU jak kupony i uwagi, wiec poller ja odswieza.
  // ⚠️ NULL, gdy sklep atrybucji nie zapisal: to „nie wiemy", a nie „wejscie bezposrednie"
  // (patrz domain/atrybucja.js). Kanaly bez tego pojecia (Allegro, reczne) maja tu NULL
  // zawsze i tak ma zostac.
  const atrybucjaJson = z.atrybucja ? JSON.stringify(z.atrybucja) : null;

  // Naglowek i podmiana pozycji musza wyladowac razem: poller pisze, panel czyta
  // z tego samego polaczenia rownolegle (inny request), a DELETE+INSERT pozycji
  // bez transakcji dawaloby okno, w ktorym zamowienie jest widoczne bez pozycji.
  db.exec('BEGIN IMMEDIATE');
  try {
    let id;
    if (istniejace) {
      // Aktualizujemy WYLACZNIE pola przychodzace ze sklepu. Znaczniki reczne
      // (w_realizacji_at, zwrot_at) nie sa tu wymienione i to jest cala ich ochrona.
      //
      // ⚠️ `oplacone_at` jest tu WPROST ze sklepu (bez dawnego CASE ... oplacone_recznie)
      // i to jest zmiana, nie przeoczenie: od chwili, gdy wplaty sa LISTA (tabela
      // `platnosci`), ta kolumna trzyma juz WYLACZNIE surowe `date_paid` sklepu i sluzy
      // JEDYNIE do zbudowania wplaty zrodla 'sklep' ponizej. Wartosc, ktora czyta reszta
      // panelu, powstaje przy ODCZYCIE, z listy wplat (zLinii) — czyli tak samo jak status
      // (przewodnik OMS, 4.1). Praca czlowieka lezy w wierszach `platnosci` o zrodle
      // 'reczna', ktorych synchronizacja NIE DOTYKA (patrz db/platnosci.js).
      //
      // ⚠️ Z DOKLADNIE tego samego powodu nie ma tu `dostawa_reczna_json`,
      // `klient_reczny_json` ani `chce_fakture_reczne`. Poprawione dane klienta NIE
      // nadpisuja `klient_json`/`dostawa_json`/`chce_fakture` — te dalej naleza do sklepu
      // i maja sie odswiezac — tylko leza OBOK, polowo, i wygrywaja dopiero przy odczycie
      // (domain/dane-reczne.js). Dopisanie ktorejkolwiek z tych trzech kolumn do listy
      // ponizej kasowaloby prace czlowieka co dwie minuty.
      //
      // ⚠️ TAK SAMO `anulowane_recznie` i `wysylka_reczna_json` (reczna korekta stanu).
      // `anulowane` i `metoda_wysylki` PONIZEJ sa i maja byc odswiezane — to fakty sklepu.
      // Wartosc EFEKTYWNA powstaje dopiero przy odczycie (zLinii), z sumy jednego i drugiego.
      // Dopisanie tych dwoch kolumn tutaj kasowaloby recznie anulowane zamowienie
      // i recznie ustawione pobranie przy najblizszym przebiegu pollera.
      //
      // ⚠️ `indywidualne` JEST tutaj i to jest odwrotnosc powyzszych: to fakt SKLEPU,
      // liczony z surowej odpowiedzi (domain/indywidualne.js), wiec ma sie odswiezac przy
      // kazdej synchronizacji — oferta moze dojsc do zamowienia juz po jego zlozeniu.
      // Pominiecie go tutaj zamraza znacznik na wartosci z PIERWSZEJ synchronizacji,
      // czyli zamowienie z panelu policzyloby sie w zlym kanale raportu na zawsze.
      db.prepare(`
        UPDATE zamowienia SET
          numer = ?,
          -- ⚠️ COALESCE TYLKO PRZY TYCH DWOCH KOLUMNACH — patrz daneOsoboweAlboNull() wyzej.
          klient_json = COALESCE(?, klient_json),
          dostawa_json = COALESCE(?, dostawa_json),
          metoda_wysylki = ?, metoda_wysylki_nazwa = ?, pobranie = ?, kwota_pobrania = ?,
          punkt_odbioru = ?, punkt_odbioru_opis = ?,
          chce_fakture = ?, nip = ?, kwota_brutto = ?, koszt_dostawy_brutto = ?, koszt_dostawy_netto = ?,
          status_woo = ?, status_realizacji = ?, metoda_platnosci = ?, indywidualne = ?,
          oplacone_at = ?,
          anulowane = ?, uwagi = ?, kupony_json = ?, atrybucja_json = ?, surowe_json = ?, zmienione_at = ?
        WHERE id = ?
      `).run(
        z.numer, daneOsoboweAlboNull(z.klient), daneOsoboweAlboNull(z.dostawa),
        z.metoda_wysylki, z.metoda_wysylki_nazwa ?? null, z.pobranie ? 1 : 0, z.kwota_pobrania,
        z.punkt_odbioru ?? null, z.punkt_odbioru_opis ?? null,
        z.chce_fakture, z.nip, z.kwota_brutto, z.koszt_dostawy_brutto ?? null, z.koszt_dostawy_netto ?? null,
        z.status_woo, z.status_realizacji ?? null, z.metoda_platnosci ?? null, z.indywidualne ? 1 : 0, z.oplacone_at,
        z.anulowane, z.uwagi ?? null, kuponyJson, atrybucjaJson, surowyJson, teraz(), istniejace.id,
      );
      id = istniejace.id;
    } else {
      db.prepare(`
        INSERT INTO zamowienia (sklep, zrodlo_id, numer, klient_json, dostawa_json, metoda_wysylki,
          metoda_wysylki_nazwa, pobranie, kwota_pobrania, punkt_odbioru, punkt_odbioru_opis,
          chce_fakture, nip, kwota_brutto, koszt_dostawy_brutto, koszt_dostawy_netto,
          status_woo, status_realizacji, metoda_platnosci, indywidualne, oplacone_at, anulowane,
          uwagi, kupony_json, atrybucja_json, surowe_json, utworzone_at, zmienione_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      `).run(
        sklep, z.zrodlo_id, z.numer, JSON.stringify(z.klient), JSON.stringify(z.dostawa), z.metoda_wysylki,
        z.metoda_wysylki_nazwa ?? null, z.pobranie ? 1 : 0, z.kwota_pobrania, z.punkt_odbioru ?? null, z.punkt_odbioru_opis ?? null,
        z.chce_fakture, z.nip, z.kwota_brutto, z.koszt_dostawy_brutto ?? null,
        z.koszt_dostawy_netto ?? null, z.status_woo, z.status_realizacji ?? null,
        z.metoda_platnosci ?? null,
        z.indywidualne ? 1 : 0, z.oplacone_at, z.anulowane, z.uwagi ?? null, kuponyJson, atrybucjaJson, surowyJson,
        z.utworzone_at ?? teraz(), teraz(),
      );
      id = wiersz(db, sklep, z.zrodlo_id).id;
    }
    zapiszPozycje(db, id, z.pozycje);
    // Wplata ze sklepu jest taka sama dana sklepowa jak pozycje — i ma jechac W TEJ SAMEJ
    // transakcji, zeby nie istnialo okno, w ktorym zamowienie ma juz nowa kwote, a wplata
    // jeszcze stara (albo odwrotnie). Dotyka WYLACZNIE wierszy zrodla 'sklep'.
    zsynchronizujWplateSklepu(db, id, {
      oplacone_at: z.oplacone_at,
      kwota: z.kwota_brutto,
      metoda: z.metoda_platnosci ?? null,
    });
    db.exec('COMMIT');
    return id;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

// Pozycje SKLEPOWE sa podmieniane w calosci: zamowienie edytowane w sklepie ma miec u nas
// swoj aktualny stan, a nie sume wszystkich wersji.
//
// ⚠️ WARUNEK PRZY DELETE JEST CALA OCHRONA POZYCJI DOPISANYCH RECZNIE (przewodnik OMS, 4.7).
// Bez niego „klient chce dodatkowy szablon i musi doplacic" znikaloby z karty w ciagu dwoch
// minut — razem z pieniedzmi, ktorych panel przestalby sie od klienta domagac. Ta sama
// granica i ten sam wzorzec, co przy wplatach (zsynchronizujWplateSklepu w db/platnosci.js).
//
// COALESCE, a nie samo `zrodlo <> 'reczna'`: w SQL `NULL <> 'reczna'` daje NULL, czyli
// „nie kasuj". Wiersz z NULL-em (baza, ktorej migracja z jakiegos powodu nie dosiegla)
// przezylby wiec kasowanie i zostal wstawiony DRUGI RAZ przy kazdym przebiegu pollera —
// pozycje mnozylyby sie co dwie minuty, a suma rosla razem z nimi.
function zapiszPozycje(db, zamowienieId, pozycje) {
  db.prepare("DELETE FROM pozycje WHERE zamowienie_id = ? AND COALESCE(zrodlo, 'sklep') <> 'reczna'")
    .run(zamowienieId);
  // ⚠️ `zrodlo` jest wpisane W ZAPYTANIU ('sklep'), a nie podane argumentem — przy dokladaniu
  // kolumny latwo policzyc znaki zapytania „po kolumnach" i przesunac WSZYSTKIE wartosci
  // o jedna. Dzis: 15 kolumn = 14 znakow zapytania + 1 wpisana na sztywno ('sklep'),
  // i dokladnie 14 argumentow `.run()` (PRZ-091 doklada `wariant_id` na koncu).
  const ins = db.prepare(
    'INSERT INTO pozycje (zamowienie_id, nazwa, sku, ilosc, cena_brutto, cena_netto, brutto_linii, netto_linii, vat,'
    + " zrodlo, zrodlo_id, zdjecie_url, produkt_id, oferta_id, wariant_id) VALUES (?,?,?,?,?,?,?,?,?,'sklep',?,?,?,?,?)",
  );
  for (const p of pozycje ?? []) {
    ins.run(
      zamowienieId, p.nazwa, p.sku, p.ilosc, p.cena_brutto, p.cena_netto ?? null,
      p.brutto_linii ?? null, p.netto_linii ?? null, p.vat, p.zrodlo_id ?? null,
      p.zdjecie_url ?? null, p.produkt_id ?? null,
      // ⚠️ Identyfikator oferty Allegro idzie TEDY, a nie osobnym UPDATE-em obok. Poller
      // kasuje i wstawia pozycje sklepowe co dwie minuty (przewodnik OMS, 4.7), wiec
      // cokolwiek dopisane obok mapowania znika przy najblizszym przebiegu — dopisek
      // wygladalby na dzialajacy dokladnie do pierwszej synchronizacji po wdrozeniu.
      p.oferta_id ?? null,
      p.wariant_id ?? null,
    );
  }
}

// ---------------------------------------------------------------------------------
// RECZNE POZYCJE I RECZNE POPRAWKI POZYCJI. Dwa mechanizmy, bo to dwie rozne rzeczy:
//
//  - pozycja DOPISANA jest w calosci nasza, wiec edytuje sie ja WPROST w wierszu (poller
//    jej nie tknie — patrz warunek przy DELETE wyzej);
//  - pozycja ZE SKLEPU nalezy do sklepu, wiec jej poprawka mieszka OBOK, w
//    `pozycje_reczne_json`, i wygrywa dopiero przy odczycie (zLinii nizej).
//
// Zapis kwot idzie ZAWSZE przez domain/pozycje-reczne.js (parsujNowaPozycje /
// parsujEdycjePozycji): to tam ilosc i cena zamieniaja sie w wartosci znormalizowane,
// a `brutto_linii` liczy sie w groszach. Te funkcje przyjmuja gotowy wynik i nic nie licza.
// ---------------------------------------------------------------------------------

export function dodajPozycjeReczna(
  db,
  zamowienieId,
  {
    nazwa, sku, ilosc, cena_brutto, brutto_linii,
    produkt_id: produktId = null, wariant_id: wariantId = null, cena_katalogowa: katalogowa = null,
  },
) {
  // ⚠️ `produkt_id` i `wariant_id` SA OPCJONALNE i domyslnie puste — pozycja wpisana z reki
  // przy telefonie nie ma zadnego produktu w sklepie i NULL jest o niej prawda. Wypelnia je
  // wylacznie „dodaj z magazynu" (21.08.2026): tam operator wskazal konkretny wiersz lustra,
  // wiec panel wie i ktory produkt, i ktory ROZMIAR poszedl.
  // ⚠️ `cena_katalogowa` to CENA SPRZED RABATU, nie druga cena do zaplaty. Wypelnia ja
  // wylacznie „dodaj z magazynu"; NULL znaczy „pozycja wpisana z reki", czyli kwota juz
  // uzgodniona — i taka pozycja jest dla przeliczenia rabatem niewidzialna (domain/rabat.js).
  db.prepare(
    'INSERT INTO pozycje (zamowienie_id, nazwa, sku, ilosc, cena_brutto, cena_netto, brutto_linii, netto_linii, vat,'
    + " zrodlo, zrodlo_id, produkt_id, wariant_id, cena_katalogowa) VALUES (?,?,?,?,?,NULL,?,NULL,NULL,'reczna',NULL,?,?,?)",
  ).run(zamowienieId, nazwa, sku ?? null, ilosc, cena_brutto, brutto_linii, produktId, wariantId, katalogowa);
  db.prepare('UPDATE zamowienia SET zmienione_at = ? WHERE id = ?').run(teraz(), zamowienieId);
  return { nazwa, sku: sku ?? null, ilosc, cena_brutto, brutto_linii };
}

// Wiersz szukamy po PARZE (id pozycji, id zamowienia) — tak samo jak przy wplatach: w swiezej
// bazie liczniki AUTOINCREMENT roznych tabel zbiegaja sie (przewodnik OMS, 6.3), wiec sam
// `id` przepuscilby pomylke argumentu w trasie i pozwolil poprawic CUDZA pozycje.
function pozycjaZamowienia(db, zamowienieId, pozycjaId) {
  const p = db.prepare('SELECT * FROM pozycje WHERE id = ? AND zamowienie_id = ?').get(pozycjaId, zamowienieId);
  if (!p) throw bladOperatora('Nie ma takiej pozycji przy tym zamówieniu.');
  return p;
}

/** Edycja pozycji DOPISANEJ RECZNIE — wprost w wierszu, bo jest nasza w calosci. */
export function zapiszPozycjeReczna(db, zamowienieId, pozycjaId, { nazwa, ilosc, cena_brutto, brutto_linii }) {
  const p = pozycjaZamowienia(db, zamowienieId, pozycjaId);
  if (p.zrodlo !== 'reczna') {
    throw bladOperatora('Pozycji ze sklepu nie zapisuje się wprost — poprawka mieszka obok, jako nadpisanie.');
  }
  db.prepare('UPDATE pozycje SET nazwa = ?, ilosc = ?, cena_brutto = ?, brutto_linii = ? WHERE id = ?')
    .run(nazwa, ilosc, cena_brutto, brutto_linii, pozycjaId);
  db.prepare('UPDATE zamowienia SET zmienione_at = ? WHERE id = ?').run(teraz(), zamowienieId);
  return { ...p, nazwa, ilosc, cena_brutto, brutto_linii };
}

// WYJSCIE ze stanu, w ktory panel sam pozwala wejsc (przewodnik OMS, 4.9): omylkowo dopisana
// pozycja podnosi kwote oczekiwana od klienta i kaze panelowi pokazywac niedoplate, ktorej
// nie ma. Bez tej drogi jedynym wyjsciem bylby SQL na produkcji.
//
// ⚠️ Pozycji ZE SKLEPU usunac sie nie da i to nie jest niedorobka — dokladnie ta sama zasada,
// co przy wplatach: nalezy do sklepu, a poller wstawilby ja z powrotem przy najblizszym
// przebiegu, wiec panel obiecywalby skasowanie, ktore samo sie cofa po dwoch minutach.
export function usunPozycjeReczna(db, zamowienieId, pozycjaId) {
  const p = pozycjaZamowienia(db, zamowienieId, pozycjaId);
  if (p.zrodlo !== 'reczna') {
    throw bladOperatora(
      'Pozycji ze sklepu nie da się usunąć z panelu — należy do sklepu i poller wstawiłby ją z powrotem'
      + ' przy najbliższej synchronizacji. Jeśli ta pozycja jest błędna, popraw zamówienie w sklepie'
      + ' albo skoryguj ją tutaj przez edycję.',
    );
  }
  db.prepare('DELETE FROM pozycje WHERE id = ?').run(pozycjaId);
  db.prepare('UPDATE zamowienia SET zmienione_at = ? WHERE id = ?').run(teraz(), zamowienieId);
  return p;
}

// Cala mapa nadpisan pozycji naraz — sklada ja domena (ustawNadpisaniePozycji), zeby ta
// funkcja nie musiala znac ani kluczy, ani polowosci nadpisania. `null` zapisujemy tak samo
// jak przy danych klienta: „brak poprawek" ma w bazie wygladac jak przed pierwsza edycja.
export function zapiszNadpisaniaPozycji(db, id, mapa) {
  db.prepare('UPDATE zamowienia SET pozycje_reczne_json = ?, zmienione_at = ? WHERE id = ?')
    .run(mapa ? JSON.stringify(mapa) : null, teraz(), id);
}

// ⚠️ JEDYNA droga zapisu recznych faktow statusu — i to jest cala tresc tej funkcji.
//
// Wczesniej byly tu DWIE: `oznacz()` z biala lista kolumn (bo nazwa kolumny byla
// interpolowana) i `oznaczZwrot()`. Zniknely razem z osobnymi przyciskami „Oznacz
// w realizacji" / „Oznacz zwrot": dopoki istnialy dwie drogi zapisu tych samych faktow,
// odmowy pilnujace granic (nie da sie ustawic „Wyslane", nie da sie odanulowac zamowienia
// anulowanego w sklepie) obowiazywalyby tylko na jednej z nich.
//
// WSZYSTKIE CZTERY POLA JEDNYM UPDATE-em, dokladnie z tego samego powodu co data wplaty
// razem ze znacznikiem recznosci: awaria miedzy dwoma osobnymi zapisami (pelny dysk,
// restart procesu) zostawialaby stan, ktorego nikt nie chcial — zwrot bez powodu albo
// anulowanie przy niewyczyszczonym zwrocie. Komplet faktow liczy domena
// (faktyDlaStatusu w domain/status-reczny.js), tutaj jest wylacznie zapis.
//
// `anulowane` (kolumna ze sklepu) CELOWO NIE JEST tu ruszana: reczne anulowanie zapisuje
// sie WYLACZNIE w `anulowane_recznie`, a wartosc efektywna powstaje przy odczycie jako suma
// logiczna obu (zLinii). Zapis do kolumny sklepowej zostalby i tak zdmuchniety przez
// najblizsza synchronizacje, a po drodze skasowalby fakt przyslany przez sklep.
/**
 * Oznaczenie zamówienia jako wysłanego — WYŁĄCZNIE gdy nie było jeszcze oznaczone.
 *
 * ⚠️ Osobna, wąska droga obok `zapiszFaktyStatusu` i to jest świadome: tamta zapisuje
 * KOMPLET faktów statusu (bo tak działa ręczny wybór z listy), a tu chodzi o dołożenie
 * JEDNEGO faktu bez dotykania pozostałych. Użycie tamtej skasowałoby przy okazji zwrot
 * albo ręczne anulowanie — czyli rejestracja paczki cofałaby decyzje, których nie dotyczy.
 *
 * `WHERE wyslane_at IS NULL` nie jest ostrożnością na wyrost: data pierwszej wysyłki ma
 * zostać pierwszą. Dosyłka za zgubioną paczkę nie może przestawiać jej na dzisiaj.
 */
export function oznaczWyslane(db, id, kiedy = teraz()) {
  db.prepare('UPDATE zamowienia SET wyslane_at = ?, zmienione_at = ? WHERE id = ? AND wyslane_at IS NULL')
    .run(kiedy, teraz(), id);
  przeniesWyslaneNaDolaczone(db, id, { tylkoPuste: true });
}

/**
 * PRZ-101.04: „wysłane” zamówienia GŁÓWNEGO przechodzi na jego dołączone (domena/scalanie.js).
 *
 * ⚠️ TU, W WARSTWIE ZAPISU, a nie w trasach: fakt `wyslane_at` zapisują dziś trzy trasy (karta,
 * zmiana masowa, przesyłka ręczna) przez DWIE funkcje tego pliku (`oznaczWyslane`,
 * `zapiszFaktyStatusu`). Przeniesienie w każdej trasie osobno to trzy miejsca do zapomnienia.
 * Odesłanie statusu dołączonych do sklepu robi `odeslijStatus` głównego (services/sync-sklep.js).
 *
 * Dołączone ma DOKŁADNIE stan głównego: cofnięcie „Wysłane” na głównym cofa je też na dołączonych
 * (`tylkoPuste: false`). `scalone_do = ?` w warunku — dotykamy wyłącznie zamówień nadal dołączonych.
 * `SELECT *`, bo baza bez migracji modułu zamówień (testy na samym rdzeniu) kolumny nie ma.
 */
function przeniesWyslaneNaDolaczone(db, glowneId, { tylkoPuste = false } = {}) {
  const w = db.prepare('SELECT * FROM zamowienia WHERE id = ?').get(glowneId);
  const ids = idsDolaczonych(w);
  if (!ids.length) return;
  // ⚠️ ANULOWANE DOŁĄCZONE POMIJAMY (recenzja, W3) — warunek `anulowaneEfektywnie`, ten sam, co
  // `d.anulowane` w `sprawdzCzlonkowGrupy`: paczka grupy nie wiezie pozycji anulowanego zamówienia,
  // więc „wysłane” byłoby nieprawdą. Sprawa zostaje na głównym (`uwagaDolaczonychAnulowanych`).
  const nieanulowane = db.prepare(`SELECT id, anulowane, anulowane_recznie FROM zamowienia WHERE id IN (${ids.map(() => '?').join(',')}) AND scalone_do = ?`)
    .all(...ids, glowneId).filter((d) => !anulowaneEfektywnie(d)).map((d) => d.id);
  if (!nieanulowane.length) return;
  const znaki = nieanulowane.map(() => '?').join(',');
  db.prepare(`UPDATE zamowienia SET wyslane_at = ?, zmienione_at = ? WHERE id IN (${znaki}) AND scalone_do = ?`
    + (tylkoPuste ? ' AND wyslane_at IS NULL' : '')).run(w.wyslane_at ?? null, teraz(), ...nieanulowane, glowneId);
}

/**
 * Ślad po nieudanym (albo udanym) odesłaniu statusu do sklepu.
 *
 * Musi siedzieć w tabeli, a nie tylko w `log`: żaden widok nie renderuje `log`, więc bez
 * tej kolumny panel pokazywałby „Wysłane", sklep dalej „W trakcie realizacji", a operator
 * nie miałby jak się dowiedzieć, że rozjazd w ogóle istnieje. Dokładnie ten sam powód, dla
 * którego istnieje `przesylki.sync_woo_blad`.
 *
 * `null` czyści ślad — udana synchronizacja ma zdejmować uwagę z karty, a nie zostawiać
 * na niej nieaktualne ostrzeżenie.
 */
export function zapiszBladSyncSklepu(db, id, opis) {
  db.prepare('UPDATE zamowienia SET sync_woo_blad = ?, zmienione_at = ? WHERE id = ?')
    .run(opis ?? null, teraz(), id);
}

// Odswiezenie stanu realizacji POZA pollerem. Konieczne, bo Allegro nie podbija `updatedAt`
// przy zmianie tego pola (zmierzone 05.08.2026), wiec poller takiego zamowienia nie odczyta
// ponownie NIGDY, a kolumna zostaje nieaktualna na zawsze.
export function zapiszStanRealizacji(db, id, status) {
  db.prepare('UPDATE zamowienia SET status_realizacji = ? WHERE id = ?').run(status ?? null, id);
}

export function zapiszFaktyStatusu(db, id, { w_realizacji_at, wyslane_at, zwrot_at, zwrot_powod, anulowane_recznie, status_wlasny = null, zachowaj_status_wlasny = false, kto = null }) {
  db.exec('SAVEPOINT zapis_statusu');
  try {
    db.prepare(
      'UPDATE zamowienia SET w_realizacji_at = ?, wyslane_at = ?, zwrot_at = ?, zwrot_powod = ?, anulowane_recznie = ?,'
      + ' zmienione_at = ? WHERE id = ?',
    ).run(
      w_realizacji_at ?? null, wyslane_at ?? null, zwrot_at ?? null, zwrot_powod ?? null,
      anulowane_recznie ? 1 : 0, teraz(), id,
    );
    if (maTabeleStatusow(db)) {
      if (status_wlasny) {
        // UPSERT narzucał wyzwalaczowi UPDATE własną politykę konfliktu i łamał
        // INSERT OR IGNORE do lista_brudne. Dwa zapisy w tym samym savepoincie są atomowe.
        const zapis = db.prepare('UPDATE zamowienia_status_wlasny SET klucz = ?, ustawione_at = ?, kto = ? WHERE zamowienie_id = ?')
          .run(status_wlasny, teraz(), kto, id);
        if (!zapis.changes) db.prepare('INSERT INTO zamowienia_status_wlasny (zamowienie_id, klucz, ustawione_at, kto) VALUES (?, ?, ?, ?)')
          .run(id, status_wlasny, teraz(), kto);
      } else if (!zachowaj_status_wlasny) db.prepare('DELETE FROM zamowienia_status_wlasny WHERE zamowienie_id = ?').run(id);
    } else if (status_wlasny) throw new Error('Brak migracji statusów własnych.');
    // PRZ-101.04: „wysłane” głównego przechodzi na dołączone — w tym samym savepoincie, atomowo.
    przeniesWyslaneNaDolaczone(db, id);
    db.exec('RELEASE zapis_statusu');
  } catch (e) {
    db.exec('ROLLBACK TO zapis_statusu');
    db.exec('RELEASE zapis_statusu');
    throw e;
  }
}

// „Zaksieguj wplate" — z punktu widzenia operatora dziala dokladnie tak, jak dzialalo:
// jedno klikniecie i zamowienie jest oplacone. Pod spodem to juz nie przestawienie
// znacznika, tylko DOPISANIE WPLATY NA BRAKUJACA KWOTE — bo `oplacone_at` przestalo byc
// czyms, co da sie ustawic wprost (wynika z listy wplat, patrz zLinii nizej).
//
// Kwota liczona jako roznica, a nie jako cala kwota zamowienia: przy zamowieniu z zaliczka
// wpisanie calosci zrobiloby z niej nadplate rowna zaliczce.
//
// Odmowa przy pokrytej kwocie jest istotna: bez niej drugie klikniecie (albo odswiezenie
// strony po POST) dokladaloby wplate na 0 zl albo — gdyby zero przeszlo — na kwote ujemna.
export function potwierdzWplate(db, id, kiedy = teraz()) {
  const z = pobierzZamowienie(db, id);
  if (!z) throw bladOperatora('Nie ma takiego zamówienia.');
  const brakGr = brakujacaKwotaGrosze(z);
  if (brakGr <= 0) {
    throw bladOperatora('To zamówienie ma już wpłaty pokrywające całą kwotę — nie ma czego księgować.');
  }
  return dodajWplateReczna(db, id, { kwota: zl(brakGr), data: kiedy });
}

// ---------------------------------------------------------------------------------
// Reczne poprawki danych klienta. Trzy funkcje zapisu, ZERO wpisow w bialej liscie
// `oznacz()` — i to nie jest przeoczenie. `oznacz()` interpoluje nazwe kolumny, wiec
// wpuszczenie tam kolumny z JSON-em znaczyloby, ze trasa HTTP moze wstawic w nia dowolna
// tresc bez przejscia przez roznice() — czyli obejsc polowosc nadpisania, ktora jest cala
// wartoscia tego mechanizmu.
//
// Pusty obiekt nadpisan zapisujemy jako NULL, a nie '{}': „brak poprawek" ma w bazie
// wygladac tak samo, jak przed pierwsza edycja, zeby dalo sie o to pytac wprost.
// ---------------------------------------------------------------------------------
const jsonAlboNull = (nadpisania) => (Object.keys(nadpisania ?? {}).length ? JSON.stringify(nadpisania) : null);

export function zapiszNadpisaniaWysylki(db, id, nadpisania) {
  db.prepare('UPDATE zamowienia SET dostawa_reczna_json = ?, zmienione_at = ? WHERE id = ?')
    .run(jsonAlboNull(nadpisania), teraz(), id);
}

// Dane nabywcy i przelacznik „chce fakture" JEDNYM UPDATE-em, z tego samego powodu co data
// i flaga przy wplacie: oba pochodza z jednego formularza i jednej decyzji czlowieka, wiec
// awaria miedzy dwoma osobnymi zapisami (pelny dysk, restart procesu) zostawialaby poprawiony
// NIP bez zgody na fakture albo odwrotnie.
export function zapiszNadpisaniaFaktury(db, id, nadpisania, chceFaktureReczne) {
  db.prepare('UPDATE zamowienia SET klient_reczny_json = ?, chce_fakture_reczne = ?, zmienione_at = ? WHERE id = ?')
    .run(jsonAlboNull(nadpisania), chceFaktureReczne ?? null, teraz(), id);
}

// JEDYNE wyjscie ze stanu, z ktorego panel sam by nie wyszedl — ta sama zasada, co przy
// zawieszonej fakturze i zawieszonym nadaniu. Bez tego literowka zapisana raz zostawalaby
// na karcie na zawsze, bo sklep juz nigdy by jej nie przebil.
// Reczne nadpisanie METODY WYSYLKI (i kwoty pobrania) — patrz komentarz przy kolumnie
// `wysylka_reczna_json` w schema.sql i przy sprawdzZmianeMetody w domain/wysylka.js.
//
// Metoda i kwota ida tu JEDNA WARTOSCIA, wiec niezmiennik „pobranie zawsze z kwota" jest
// niemozliwy do zlamania nawet przez awarie w polowie zapisu — nie ma polowy. Bramka na
// pieniadze (czy kwota w ogole jest i czy da sie ja odczytac) siedzi w domenie, PRZED
// wywolaniem tej funkcji.
//
// `null` zapisujemy dokladnie tak samo jak przy danych klienta: „brak nadpisania" ma
// w bazie wygladac tak, jak przed pierwsza zmiana.
export function zapiszNadpisanieWysylki(db, id, nadpisanie) {
  db.prepare('UPDATE zamowienia SET wysylka_reczna_json = ?, zmienione_at = ? WHERE id = ?')
    .run(nadpisanie ? JSON.stringify(nadpisanie) : null, teraz(), id);
}

// Wyjscie ze stanu, z ktorego panel sam by nie wyszedl — ta sama zasada, co przy danych
// klienta: bez tego pomylkowe przelaczenie metody zostawaloby na karcie na zawsze, bo sklep
// juz nigdy by go nie przebil. CELOWO osobna trasa od „Przywroc dane ze sklepu" (adres):
// przywracanie adresu nie ma prawa po cichu cofac decyzji o pobraniu i odwrotnie.
export function przywrocMetodeWysylkiZeSklepu(db, id) {
  db.prepare('UPDATE zamowienia SET wysylka_reczna_json = NULL, zmienione_at = ? WHERE id = ?').run(teraz(), id);
}

/**
 * Komentarz wewnętrzny — nasza notatka przy zamówieniu (2026-08-21).
 *
 * ⚠️ `null` KASUJE i tak ma być: normalizacja w domenie (domain/komentarz-wewnetrzny.js)
 * oddaje `null` dla pustego pola, więc wyczyszczenie textarea zdejmuje notatkę zamiast
 * zapisywać pusty napis, który na karcie wyglądałby jak notatka.
 *
 * Kolumna jest NASZA, więc poller jej nie dotyka: UPDATE synchronizacji wymienia kolumny
 * z nazwy (patrz `zapiszZamowienie` wyżej) i tej wśród nich nie ma.
 */
export function zapiszKomentarzWewnetrzny(db, id, komentarz) {
  db.prepare('UPDATE zamowienia SET komentarz_wewnetrzny = ?, zmienione_at = ? WHERE id = ?')
    .run(komentarz ?? null, teraz(), id);
}

/**
 * Odnotowanie, że potwierdzenie przyjęcia zamówienia POSZŁO do klienta (2026-08-21).
 *
 * ⚠️ Zapis idzie DOPIERO po udanej wysyłce (services/potwierdzenie.js) — karta twierdząca
 * „wysłano" przy mailu, którego nigdy nie było, jest gorsza niż brak śladu.
 */
export function oznaczPotwierdzenieWyslane(db, id, kiedy = teraz()) {
  db.prepare('UPDATE zamowienia SET potwierdzenie_wyslane_at = ?, zmienione_at = ? WHERE id = ?')
    .run(kiedy, teraz(), id);
}

/**
 * USTALENIA HANDLOWE zamówienia: kanał B2B, uzgodniony termin płatności, rabat (2026-08-21).
 *
 * ⚠️ TRZY POLA JEDNYM ZAPISEM, bo są jedną decyzją operatora — tak samo jak są jednym paskiem
 * na karcie. Trzy osobne trasy znaczyłyby trzy osobne wpisy w dzienniku dla jednego kliknięcia
 * i stan pośredni po awarii w połowie.
 *
 * ⚠️ SAM ZAPIS RABATU NICZEGO NIE PRZELICZA — ceny leżą w pozycjach. Przeliczeniem zajmuje się
 * `services/rabat.js`, który woła to DOPIERO po zapisaniu nowych cen: kolumna i pozycje mają
 * opisywać ten sam stan, a odwrotna kolejność zostawiałaby po awarii zamówienie z rabatem
 * 30% w nagłówku i cenami sprzed rabatu w tabeli.
 */
export function zapiszUstaleniaHandlowe(db, id, { b2b, termin_platnosci: termin, rabat_procent: rabat }) {
  db.prepare(
    'UPDATE zamowienia SET b2b = ?, termin_platnosci = ?, rabat_procent = ?, zmienione_at = ? WHERE id = ?',
  ).run(b2b ? 1 : 0, termin ?? null, Number(rabat) || 0, teraz(), id);
}

export function przywrocDaneZeSklepu(db, id) {
  db.prepare(
    'UPDATE zamowienia SET dostawa_reczna_json = NULL, klient_reczny_json = NULL,'
    + ' chce_fakture_reczne = NULL, zmienione_at = ? WHERE id = ?',
  ).run(teraz(), id);
}

// ⚠️ TU I TYLKO TU nakladamy reczne nadpisania na fakty, ktore czyta CALY modul:
// anulowanie, metode wysylki i kwote pobrania. Adres i dane do faktury robia to inaczej
// (jawnym wywolaniem adresOdbiorcy()/daneFaktury() u kazdego czytelnika) i ta roznica jest
// SWIADOMA:
//
//  - adres ma DWOCH czytelnikow i jedzie do kuriera JAWNIE, jako osobny argument `adres`;
//  - `anulowane`, `metoda_wysylki` i `kwota_pobrania` czyta z wiersza wiele miejsc naraz —
//    wyliczStatus, doZrobienia, services/nadanie.js, services/faktura.js, kurierzy/dpd.js,
//    lista i karta. Pojedyncze POMINIETE wywolanie znaczyloby tam paczke nadana do
//    zamowienia anulowanego recznie albo pobranie zainkasowane drugi raz od klienta.
//    Nakladanie w warstwie odczytu jest jedynym sposobem, zeby nikt nie mogl zapomniec.
//
// Regula mieszka w domenie (domain/wysylka.js, domain/status-reczny.js) — TU jest wylacznie
// miejsce jej zastosowania. Wartosci ze sklepu NIE GINA: leza obok, w kolumnach `_sklep`,
// bo karta musi umiec pokazac „zmienione recznie" i zaproponowac przywrocenie.
//
// `wyliczStatus` pozostaje NIETKNIETY: doklada mu sie fakty, nie zmienia regule.
//
// ⚠️ TU TEZ powstaje `oplacone_at` — JAKO FAKT WYLICZANY Z LISTY WPLAT, a nie jako kolumna
// do przestawiania. Ta sama zasada, co przy statusie (przewodnik OMS, 4.1): zamowienie jest
// oplacone, gdy suma wplat pokrywa jego kwote, i niesie date tej wplaty, ktora prog
// przekroczyla. Cofniecie faktu (usuniecie omylkowej wplaty) cofa „oplacone" SAMO.
//
// Powod, dla ktorego liczymy to TUTAJ, a nie u kazdego czytelnika osobno, jest ten sam,
// co przy `anulowane` i `metoda_wysylki` wyzej: `oplacone_at` czyta wiele miejsc naraz
// (ostrzezenie na karcie i na ekranie nadania, kolumna na liscie) i JEDNO pominiete
// wywolanie znaczyloby paczke nadana bez ostrzezenia o braku pieniedzy.
//
// Kolumna `zamowienia.oplacone_at` NIE GINIE — lezy obok jako `oplacone_at_sklep`,
// tak samo jak `anulowane_sklep` i `metoda_wysylki_sklep`.
//
// ⚠️ TU TEZ nakladaja sie RECZNE NADPISANIA POZYCJI — i to jest ten sam powod, co przy
// `anulowane` i `metoda_wysylki` wyzej, tylko o wieksza stawke. Wartosci pozycji czyta NARAZ
// tabela na karcie, suma pod nia, saldo wplat, bariera arytmetyczna faktury i `gross_price`
// pozycji wysylanej do inFaktu. Nakladanie u kazdego czytelnika osobno znaczyloby, ze jedno
// pominiete wywolanie wysyla na dokument cene, ktorej panel nie pokazuje — a faktury nie da
// sie „cofnac", tylko skorygowac.
//
// Pozycje wczytujemy TUTAJ (a nie u czytelnika), zeby nie istniala droga odczytu zamowienia
// z pozycjami surowymi. `pozycjeSurowe` przyjmujemy z zewnatrz wylacznie dlatego, ze lista
// zamowien pobiera je JEDNYM zapytaniem dla wszystkich wierszy naraz. Wplaty — z tego samego
// powodu (PRZ-051): pytanie o nie przy kazdym wierszu bylo polowa kosztu listy.
function zLinii(db, w, pozycjeSurowe = null, platnosciSurowe = null) {
  if (!w) return null;
  const platnosci = platnosciSurowe ?? platnosciZamowienia(db, w.id);
  const pozycje = nalozNadpisaniaPozycji(
    pozycjeSurowe ?? db.prepare(`${POZYCJE_ZE_ZDJECIEM} WHERE p.zamowienie_id = ? ${PORZADEK_POZYCJI}`)
      .all(w.id).map(zZdjeciemOferty),
    w.pozycje_reczne_json,
  );
  // Liczona RAZ: czyta ja piec pol obiektu ponizej, a kazde wywolanie na nowo parsuje ten
  // sam JSON z kolumny.
  const wysylka = wysylkaEfektywna(w);
  return {
    ...zStatusamiWlasnymi(db, w),
    pozycje,
    klient: w.klient_json ? JSON.parse(w.klient_json) : null,
    dostawa: w.dostawa_json ? JSON.parse(w.dostawa_json) : null,
    anulowane_sklep: w.anulowane,
    anulowane: anulowaneEfektywnie(w) ? 1 : 0,
    metoda_wysylki_sklep: w.metoda_wysylki,
    pobranie_sklep: w.pobranie,
    kwota_pobrania_sklep: w.kwota_pobrania,
    metoda_wysylki: metodaWysylki(w),
    // Pobranie jest OSOBNA wartoscia od rodzaju dostawy (domain/wysylka.js) — od 2026-08-01.
    pobranie: czyPobranie(w) ? 1 : 0,
    kwota_pobrania: kwotaPobrania(w),
    // ⚠️ Kod paczkomatu nakladamy TUTAJ z dokladnie tego samego powodu, co metode i pobranie:
    // czyta go naraz karta, ekran nadania i (od Zadania 6) klient InPostu, a jedno pominiete
    // wywolanie znaczyloby paczke nadana pod adres ze sklepu mimo recznej korekty — czyli
    // przesylke lezaca w paczkomacie, po ktora nikt nie przyjdzie.
    punkt_odbioru_sklep: w.punkt_odbioru,
    punkt_odbioru_opis_sklep: w.punkt_odbioru_opis,
    punkt_odbioru: punktOdbioru(w),
    punkt_odbioru_opis: punktOdbioruOpis(w),
    // ⚠️ KOSZT DOSTAWY TEZ JEST WARTOSCIA EFEKTYWNA (od 07.08.2026) — reczna poprawka ceny
    // i liczby paczek lezy w `pozycje_reczne_json` pod kluczem `wysylka`, bo kolumny ponizej
    // poller przepisuje co dwie minuty (domain/wysylka-kwota.js).
    //
    // Kolumna `koszt_dostawy_brutto` niesie teraz WARTOSC CALEJ LINII (cena × ilosc), bo
    // dokladnie tak czytali ja wszyscy dotychczasowi czytelnicy: jako „ile kosztuje dostawa
    // tego zamowienia". Cena za sztuke i liczba paczek stoja obok, w polach `wysylka_*`.
    //
    // ⚠️ Wartosci `_sklep` MUSZA tu byc, i to nie dla wygody widoku: to po nich funkcje
    // z domain/wysylka-kwota.js poznaja, ze patrza na wiersz PO nakladce, i nie licza jej
    // drugi raz na wlasnym wyniku. Bez nich cena podniesiona raz rosla by przy kazdym
    // odczycie, a czlon roznicowy w `kwotaOczekiwanaGrosze` wychodzilby zerowy — czyli
    // bariera arytmetyczna faktury przepuscilaby kwote, ktorej nikt nie zatwierdzil.
    koszt_dostawy_brutto_sklep: w.koszt_dostawy_brutto,
    koszt_dostawy_netto_sklep: w.koszt_dostawy_netto,
    koszt_dostawy_brutto: bezpiecznaWysylka(w, wysylka),
    koszt_dostawy_netto: wysylka.cena_netto,
    wysylka_ilosc: wysylka.ilosc,
    wysylka_cena_brutto: wysylka.cena_brutto,
    wysylka_zmieniona_recznie: wysylka.polaZmienione.length ? 1 : 0,
    platnosci,
    oplacone_at_sklep: w.oplacone_at,
    // ⚠️ PROGIEM JEST KWOTA OCZEKIWANA OD KLIENTA, a nie `kwota_brutto`. Zamowienie
    // z dopisana pozycja jest oplacone dopiero wtedy, gdy wplaty pokryja TAKZE doplate —
    // liczenie od kwoty sklepowej robiloby z niego „oplacone" w chwili, gdy klient zaplacil
    // samo to, co zamowil w sklepie, i doplata zniknelaby z ekranu bez sladu.
    //
    // Uszkodzona/pusta kwota zamowienia nie ma prawa wywalic listy ani karty — a gdy juz
    // sie zdarzy, ma dac NIEOPLACONE (ostrzezenie), nigdy ciche „oplacone".
    oplacone_at: bezpiecznaDataPokrycia(platnosci, { ...w, pozycje }),
    // „Potwierdzone recznie" znaczy teraz dokladnie to samo, co znaczylo: przy zamowieniu
    // jest wplata, ktorej sklep nie zna. Liczone z listy, nie z kolumny.
    oplacone_recznie: platnosci.some((p) => p.zrodlo === 'reczna') ? 1 : 0,
  };
}

/**
 * Koszt CALEJ LINII wysylki do kolumny `koszt_dostawy_brutto` wiersza efektywnego.
 *
 * ⚠️ NIE RZUCA i nie zamienia braku danych w zero. Zamowienie sprzed dolozenia kolumny ma tu
 * NULL i ma go zachowac („brak danych", nie „darmowa dostawa"); kwota uszkodzona (reczny
 * UPDATE w pliku SQLite) przechodzi dalej taka, jaka jest — dokladnie jak przed ta zmiana.
 * Karta ma sie wyswietlic w obu przypadkach, a rozjazd i tak pokaze wiersz „Razem"
 * i bariera arytmetyczna faktury.
 */
function bezpiecznaWysylka(w, wysylka) {
  if (wysylka.cena_brutto == null) return null;
  try {
    return zl(wysylkaBruttoGrosze(w));
  } catch {
    return wysylka.cena_brutto;
  }
}

// Prog liczymy TA SAMA funkcja, co saldo wplat i bariera faktury (kwotaOczekiwanaGrosze),
// a `dataPokryciaWplat` dostaje go w zlotowkach, bo taki ma kontrakt. Zamiana idzie przez
// `zl()` z liczby CALKOWITEJ groszy, wiec jest dokladna.
function bezpiecznaDataPokrycia(platnosci, zamowienie) {
  try {
    return dataPokryciaWplat(platnosci, zl(kwotaOczekiwanaGrosze(zamowienie)));
  } catch {
    return null;
  }
}

// Odszukanie zamowienia po numerze WIDOCZNYM dla operatora — to, co stoi na karcie i na
// liscie (`R/2026/003` albo numer sklepowy), nigdy wewnetrzny `id` z bazy. Formularz
// zakladania dosylki ma przyjmowac dokladnie to, co operator widzi, a nie zgadywany
// identyfikator, ktorego nigdzie na ekranie nie ma (finding recenzji Zadania 5/7).
//
// Numery sklepowe i numery serii recznej to DWIE ROZNE PRZESTRZENIE bez wspolnego
// ograniczenia unikalnosci w bazie: `zamowienia_numer_reczny` (schema.sql) pilnuje
// WYLACZNIE serii `R/RRRR/NNN`, kolumna `numer` sama w sobie nie ma globalnego UNIQUE.
// Kolizja miedzy dwiema przestrzeniami jest dzis NIEOSIAGALNA (formaty sie nie pokrywaja),
// ale funkcja i tak liczy WSZYSTKIE trafienia zamiast brac pierwsze z brzegu — pomylka
// w tym miejscu wiazataloby dwa zamowienia NA STALE (kolumna zamowienie_zrodlowe_id),
// wiec bezpieczniej oddac wieloznacznosc wprost, niz cicho zgadnac.
export function znajdzZamowieniaPoNumerze(db, numer) {
  return db.prepare('SELECT id FROM zamowienia WHERE numer = ?').all(numer).map((w) => w.id);
}

/**
 * Powiazanie dosylki z zamowieniem pierwotnym. `null` KASUJE powiazanie.
 *
 * Ustawiane z karty, a nie przy zakladaniu: ekran „Nowe zamowienie" stracil to pole
 * 2026-08-01 (decyzja wlasciciela — formularz mial byc krotki), wiec bez tej trasy
 * dosylka nie mialaby jak pokazac sie przy zamowieniu, ktorego dotyczy, i reklamacja
 * policzylaby sie drugi raz jako sprzedaz (patrz domain/dosylka.js).
 */
export function ustawZamowienieZrodlowe(db, id, zrodloweId) {
  db.prepare('UPDATE zamowienia SET zamowienie_zrodlowe_id = ?, zmienione_at = ? WHERE id = ?')
    .run(zrodloweId ?? null, teraz(), id);
}

// ⚠️⚠️ FAKTURA CZYTANA RAZEM Z REZERWACJA WYSYLKI DO KSeF, i to nie jest ozdobnik. Predykat
// „czeka na numer KSeF" (domain/ksef-oczekiwanie.js) ma OD 06.08.2026 druga galaz: dokument,
// ktorego wysylke do KSeF zlecil panel. Faktem tej galezi jest wiersz w `wysylki_ksef` — po
// stronie SQL-a czyta go czuwacz, po stronie predykatu MUSI przyjsc tutaj, bo inaczej te same
// dwie postacie jednej reguly odpowiadalyby ROZNIE na to samo zamowienie (dokladnie ten rozjazd,
// ktory zamknela recenzja Partii 2, W4+W5).
//
// LEFT JOIN, nie osobne zapytanie: kolumna ma byc na fakturze zawsze — takze wtedy, gdy panel
// tego dokumentu nie wysylal (wtedy pusta). `w.uuid = f.infakt_uuid` przy pustym UUID-zie nie
// zlaczy niczego (NULL nie rowna sie NULL), wiec rezerwacja nie przyklei sie do rezerwacji.
const FAKTURA_BEZ_WARUNKU = `
  SELECT f.*, w.zlecona_at AS ksef_zlecona_at
  FROM faktury f
  LEFT JOIN wysylki_ksef w ON w.uuid = f.infakt_uuid
`;
const FAKTURA_ZAMOWIENIA = `${FAKTURA_BEZ_WARUNKU} WHERE f.zamowienie_id = ?`;

const fakturaZamowienia = (db, zamowienieId) => db.prepare(FAKTURA_ZAMOWIENIA).get(zamowienieId) ?? null;

/**
 * PRZ-101.04 (recenzja, W3): numery DOŁĄCZONYCH anulowanych, dla każdego głównego z `glowne`
 * (`Map<id głównego, numery[]>`). Anulowane EFEKTYWNIE (`anulowaneEfektywnie`, sklep albo ręcznie) —
 * ten sam warunek, co `d.anulowane` w `sprawdzCzlonkowGrupy` (faktura grupy). Czyta `z.dolaczone_anulowane`:
 * lista robocza (`uwagaDolaczonychAnulowanych`), karta i gotowość nadania.
 */
function dolaczoneAnulowaneDla(db, glowne) {
  const mapa = new Map();
  const ids = [...new Set(glowne.flatMap((g) => idsDolaczonych(g)))];
  if (!ids.length) return mapa;
  const wlasciciel = new Map(glowne.flatMap((g) => idsDolaczonych(g).map((d) => [d, g.id])));
  for (let i = 0; i < ids.length; i += PORCJA_ID) {
    const porcja = ids.slice(i, i + PORCJA_ID);
    const wiersze = db.prepare(`SELECT id, numer, scalone_do, anulowane, anulowane_recznie FROM zamowienia
      WHERE id IN (${porcja.map(() => '?').join(',')}) ORDER BY id`).all(...porcja);
    for (const w of wiersze) {
      // Tylko dołączone NADAL do tego głównego (rozdzielenie zdejmuje `scalone_do`).
      if (w.scalone_do !== wlasciciel.get(w.id) || !anulowaneEfektywnie(w)) continue;
      if (!mapa.has(w.scalone_do)) mapa.set(w.scalone_do, []);
      mapa.get(w.scalone_do).push(w.numer ?? `#${w.id}`);
    }
  }
  return mapa;
}

export function pobierzZamowienie(db, id) {
  const z = zLinii(db, db.prepare(`SELECT *, ${kolumnyStatusow(db)} FROM zamowienia WHERE id = ?`).get(id));
  if (!z) return null;
  if (idsDolaczonych(z).length) z.dolaczone_anulowane = dolaczoneAnulowaneDla(db, [z]).get(z.id) ?? [];
  z.przesylki = przesylkiZamowienia(db, id);
  z.faktura = fakturaZamowienia(db, id);
  // Karta pokazuje szczegoly zwrotu, wiec dostaje CALE wpisy. `ma_zwrot` liczymy z nich,
  // zeby nie bylo dwoch niezaleznych zrodel tej samej prawdy na jednym obiekcie.
  z.zwroty = zwrotyZamowienia(db, id);
  z.ma_zwrot = z.zwroty.length > 0;
  // PRZ-101.04: numer głównego do odmów i przekierowania dołączonego („faktura w zamówieniu głównym N”).
  if (z.scalone_do) z.scalone_do_numer = db.prepare('SELECT numer FROM zamowienia WHERE id = ?').get(z.scalone_do)?.numer ?? null;
  return z;
}

// Zamowienie moze miec kilka paczek (nie miesci sie w jednej, albo pierwsza zaginela
// i dosylamy zamiennik BEZ zakladania drugiego zamowienia), wiec to jest LISTA, a nie
// pojedynczy wiersz — i pusta lista, a nie null, zeby kod czytajacy nie musial rozrozniac
// „brak paczek" od „nie wiem".
//
// `status <> 'blad'` odsiewa nieudane proby nadania: sa faktem w bazie (opis awarii jest
// jedynym sladem dla czlowieka), ale zadna paczka za nimi nie stoi. Porzadek po
// `kolejnosc` jest tym, co widzi operator na karcie — numer paczki musi znaczyc to samo
// tu, w referencji do DPD i na ekranie.
const PRZESYLKI_ZYWE = "SELECT * FROM przesylki WHERE status <> 'blad'";

function przesylkiZamowienia(db, zamowienieId) {
  return db.prepare(`${PRZESYLKI_ZYWE} AND zamowienie_id = ? ORDER BY kolejnosc`)
    .all(zamowienieId);
}

// Kolumna „Produkty" na liście (Zadanie „strona główna") potrzebuje pozycji KAZDEGO
// zamówienia. JEDNO zapytanie z IN (...), a nie petla z zapytaniem per wiersz — przy
// jednym kanale to niewidoczne, ale wzorzec zostaje na lata (brief zadania wprost tego
// zada). Pusta lista identyfikatorow dostaje pusta mape bez dotykania bazy: `IN ()`
// jest poprawnym SQL-em, ale nie ma po co go wysylac.
//
// Porzadek jest DOKLADNIE ten sam, co przy odczycie pojedynczego zamowienia
// (PORZADEK_POZYCJI): lista i karta musza numerowac pozycje identycznie, bo numer porzadkowy
// bywa kluczem recznego nadpisania.
function pozycjeDlaZamowien(db, ids) {
  const mapa = new Map();
  if (ids.length === 0) return mapa;
  const placeholdery = ids.map(() => '?').join(',');
  const wiersze = db.prepare(
    `${POZYCJE_ZE_ZDJECIEM} WHERE p.zamowienie_id IN (${placeholdery}) ${PORZADEK_POZYCJI}`,
  ).all(...ids).map(zZdjeciemOferty);
  for (const w of wiersze) {
    if (!mapa.has(w.zamowienie_id)) mapa.set(w.zamowienie_id, []);
    mapa.get(w.zamowienie_id).push(w);
  }
  return mapa;
}

// ⚠️ PORCJE IDENTYFIKATOROW (PRZ-051). `IN (?, ?, …)` z kompletem tabeli wpadal przy 32 767
// zamowieniach w limit zmiennych `node:sqlite` (32 766) i lista przestawala sie otwierac
// bledem SQL. 500 to rzad wielkosci ponizej limitu, a koszt porcji (szesc zapytan) rozklada
// sie na 500 wierszy — wiecej nie daje juz mierzalnego zysku.
const PORCJA_ID = 500;

// Porzadek listy: najnowsze pierwsze, a przy rownej dacie WIEKSZY identyfikator pierwszy.
// Bez drugiego klucza kolejnosc wierszy z ta sama data byla przypadkowa — a przy stronicowaniu
// (PRZ-051) przypadkowa kolejnosc znaczy wiersz pokazany na dwoch stronach albo na zadnej.
// Ten sam porzadek trzyma indeks listy (oms/db/indeks-listy.js).
export function porzadekListy(a, b) {
  if (a.utworzone_at !== b.utworzone_at) return a.utworzone_at < b.utworzone_at ? 1 : -1;
  return b.id - a.id;
}

const kolumnyBezSurowych = new WeakMap();
// Lista kolumn czytana z bazy, nie wpisana tutaj: kolumna dolozona migracja trafia do odczytu
// sama, a zapomniana nie zniknelaby z ekranu po cichu.
function kolumnyListy(db) {
  let k = kolumnyBezSurowych.get(db);
  if (!k) {
    k = db.prepare('PRAGMA table_info(zamowienia)').all().map((c) => c.name)
      .filter((n) => n !== 'surowe_json').map((n) => `"${n}"`).join(', ');
    kolumnyBezSurowych.set(db, k);
  }
  return k;
}

/**
 * Pelne zamowienia (to samo, co `listaZamowien`, wiersz w wiersz) dla WSKAZANYCH
 * identyfikatorow, w porzadku listy. Identyfikator, ktorego nie ma, po prostu nie wraca.
 *
 * `bezSurowych` — bez `surowe_json` (dziesiatki KB odpowiedzi sklepu na wiersz). Lista
 * i jej indeks go nie czytaja; akcje masowe tak (nadanie InPost czyta z niego punkt), wiec
 * domyslnie odczyt jest pelny.
 */
export function zamowieniaPoId(db, ids, { bezSurowych = false, naBlad = null } = {}) {
  const unikalne = [...new Set([].concat(ids ?? []).map(Number).filter(Number.isInteger))];
  const zamowienia = [];
  const kolumny = `${bezSurowych ? kolumnyListy(db) : '*'}, ${kolumnyStatusow(db)}`;
  for (let i = 0; i < unikalne.length; i += PORCJA_ID) {
    const porcja = unikalne.slice(i, i + PORCJA_ID);
    const znaki = porcja.map(() => '?').join(',');
    const wiersze = db.prepare(`SELECT ${kolumny} FROM zamowienia WHERE id IN (${znaki})`).all(...porcja);
    if (!wiersze.length) continue;
    const pozycjeMapa = pozycjeDlaZamowien(db, porcja);
    const platnosciMapa = platnosciDlaZamowien(db, porcja);
    // ⚠️ TO SAMO ZAPYTANIE, CO NA KARCIE (`PRZESYLKI_ZYWE`, `FAKTURA_BEZ_WARUNKU`), tylko dla
    // porcji. Faktura czytana tu wezej niz tam znaczylaby, ze ta sama regula domenowa
    // (np. „czeka na numer KSeF") odpowiada inaczej na liscie, a inaczej po kliknieciu w wiersz.
    const przesylkiMapa = new Map();
    for (const p of db.prepare(`${PRZESYLKI_ZYWE} AND zamowienie_id IN (${znaki}) ORDER BY zamowienie_id, kolejnosc`).all(...porcja)) {
      if (!przesylkiMapa.has(p.zamowienie_id)) przesylkiMapa.set(p.zamowienie_id, []);
      przesylkiMapa.get(p.zamowienie_id).push(p);
    }
    const fakturyMapa = new Map();
    for (const f of db.prepare(`${FAKTURA_BEZ_WARUNKU} WHERE f.zamowienie_id IN (${znaki})`).all(...porcja)) {
      if (!fakturyMapa.has(f.zamowienie_id)) fakturyMapa.set(f.zamowienie_id, f);
    }
    const zwrotyMapa = zwrotyDlaZamowien(db, porcja);
    const anulowaneDolaczoneMapa = dolaczoneAnulowaneDla(db, wiersze);
    for (const w of wiersze) {
      // Pusta lista, nie null/undefined — zeby widok nie musial rozrozniac „bez pozycji"
      // od „nie wiem". Pozycje i wplaty ida PRZEZ zLinii, zeby lista widziala je z nalozonymi
      // nadpisaniami dokladnie tak samo, jak karta.
      // ⚠️ `naBlad` (PRZ-051): wiersz, ktorego nie da sie odczytac (np. reczny SQL zostawil
      // zly JSON w kolumnie), NIE MOZE zabrac reszty porcji — indeks listy i strona listy
      // dostaja pozostale zamowienia, a uszkodzone ida do wolajacego z przyczyna. Bez `naBlad`
      // wyjatek leci dalej jak dotad (karta, akcje masowe: tam odmowa jest wlasciwa).
      let z;
      try {
        z = zLinii(db, w, pozycjeMapa.get(w.id) ?? [], platnosciMapa.get(w.id) ?? []);
      } catch (e) {
        if (!naBlad) throw e;
        naBlad(w, e);
        continue;
      }
      z.przesylki = przesylkiMapa.get(w.id) ?? [];
      // Faktura jest tu potrzebna TAK SAMO jak przesylka: bez niej lista robocza nie ma
      // z czego rozpoznac zamowienia z faktura wiszaca do wyjasnienia (patrz doZrobienia).
      z.faktura = fakturyMapa.get(w.id) ?? null;
      // Naglowki zwrotow (nie sama flaga) — uzasadnienie przy `listaZamowien`.
      z.zwroty = zwrotyMapa.get(w.id) ?? [];
      z.ma_zwrot = z.zwroty.length > 0;
      // PRZ-101.04: ta sama wartość, co na karcie (`pobierzZamowienie`) — inaczej lista robocza
      // i karta odpowiadałyby różnie na pytanie „czy jest tu robota”.
      if (idsDolaczonych(w).length) z.dolaczone_anulowane = anulowaneDolaczoneMapa.get(w.id) ?? [];
      zamowienia.push(z);
    }
  }
  return zamowienia.sort(porzadekListy);
}

/** `{ id, numer }` wskazanych zamówień (porcjami, jak `zamowieniaPoId`). */
export function numeryZamowien(db, ids) {
  const unikalne = [...new Set([].concat(ids ?? []).map(Number).filter(Number.isInteger))];
  const wynik = [];
  for (let i = 0; i < unikalne.length; i += PORCJA_ID) {
    const porcja = unikalne.slice(i, i + PORCJA_ID);
    wynik.push(...db.prepare(`SELECT id, numer FROM zamowienia WHERE id IN (${porcja.map(() => '?').join(',')})`).all(...porcja));
  }
  return wynik;
}

export function listaZamowien(db) {
  // ⚠️ PORCJAMI, NIE JEDNYM `IN` NA CALA TABELE (PRZ-051): `zamowieniaPoId` dzieli
  // identyfikatory na porcje, a dzieci (pozycje, wplaty, przesylki, faktura, zwroty) czyta
  // jednym zapytaniem na porcje — wczesniej przesylki, faktura i wplaty szly osobnym
  // zapytaniem na KAZDY wiersz (N+1, kompilacja SQL na wiersz).
  //
  // ⚠️ NAGLOWKI ZWROTOW, NIE SAMA FLAGA — i to jest odejscie od pierwszego podejscia (`ma_zwrot`
  // liczone z osobnego `SELECT DISTINCT zamowienie_id`, bez samych zwrotow). Ten prostszy
  // wariant wystarczal `wyliczStatus`, ale NIE WYSTARCZAL `doZrobienia`: zamowienie z
  // nierozliczonym zwrotem (pieniadze nieoddane) dostawaloby na liscie samo `ma_zwrot`,
  // bez `zwroty` do sprawdzenia — `doZrobienia` liczy `(z.zwroty ?? []).some(...)`, wiec
  // pusta/brakujaca tablica zawsze dawala `false` i zamowienie znikalo z listy roboczej
  // NATYCHMIAST, zamiast czekac na rozliczenie (zmierzone bezposrednio na tym wierszu kodu
  // przed poprawka). Lista dalej NIE dostaje pozycji zwrotu (szczegoly sa na karcie) —
  // dostaje naglowki, ktorych `doZrobienia` potrzebuje do policzenia rozliczenia.
  return zamowieniaPoId(db, db.prepare('SELECT id FROM zamowienia').all().map((w) => w.id));
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} zamowienieId
 * @param {{akcja: string, wynik?: string | null}} wpis
 */
export function dopiszLog(db, zamowienieId, { akcja, wynik = null }) {
  // ⚠️ `kto` NIE JEST PARAMETREM — bierze sie z kontekstu zadania (domain/kontekst-zadania.js).
  // Powod stoi w tamtym pliku: 194 wywolania tej funkcji, z czego 102 w trasach. Dolozenie
  // parametru znaczyloby 102 reczne poprawki. Poza zadaniem (czuwacze, zegary) kontekstu
  // nie ma i wpis nalezy do automatu — stad `?? 'automat'`, a NIE `?? null`: `null` jest
  // zarezerwowany wylacznie dla wpisow SPRZED wdrozenia kont (patrz DOLOZ w db/db.js).
  db.prepare('INSERT INTO log (zamowienie_id, at, akcja, wynik, kto) VALUES (?,?,?,?,?)')
    .run(zamowienieId, teraz(), akcja, wynik, ktoTeraz() ?? 'automat');
}

/**
 * OSTATNI wpis danej akcji dla tego zamowienia (albo `null`, jesli takiego nie bylo).
 *
 * Sluzy DLAWIENIU wpisow powtarzanych bez nowego faktu: log ma rosnac proporcjonalnie do
 * liczby ZDARZEN, a nie do liczby ODSLON karty. Wolajacy porownuje `wynik` i odpuszcza
 * zapis, gdy nic sie nie zmienilo — patrz GET /zamowienia/:id (odczyt przesylek z Allegro).
 *
 * ⚠️ Ostatni wpis TEJ AKCJI, a nie ostatni wpis w ogole: miedzy dwoma odslonami karty
 * moga trafic do logu zupelnie inne rzeczy (zmiana statusu, faktura, nadanie), a one
 * o powtorzeniu bledu nic nie mowia. Sortujemy po `id`, nie po `at` — `at` ma rozdzielczosc
 * milisekundy i dwa wpisy z tej samej milisekundy ustawilyby sie w dowolnej kolejnosci.
 */
export function ostatniWpisLogu(db, zamowienieId, akcja) {
  return db.prepare('SELECT * FROM log WHERE zamowienie_id = ? AND akcja = ? ORDER BY id DESC LIMIT 1')
    .get(zamowienieId, akcja) ?? null;
}

/** Wpisow historii na jednej stronie karty zamowienia. */
export const WPISOW_HISTORII_NA_STRONE = 50;

/**
 * HISTORIA ZMIAN zamowienia — wpisy `log`, NAJNOWSZE PIERWSZE, jedna strona (PRZ-094.18).
 *
 * ⚠️⚠️ TABELA `log` NIE MA INDEKSU PO `zamowienie_id` (migracja 0001), wiec KAZDE wywolanie to
 * pelny skan. Dlatego wola to WYLACZNIE karta rozwinieta swiadomie (`?historia=N`); zwinieta
 * karta — otwierana kilkadziesiat razy dziennie — nie ma prawa tu zajrzec, takze po to, zeby
 * policzyc wpisy. Test pilnuje tego licznikiem zapytan (karta-historia-zmian-prz094-18).
 *
 * ⚠️ NIE MA `COUNT(*)`: pobieramy `naStrone + 1` wierszy, a nadmiarowy sluzy tylko za dowod,
 * ze istnieja starsze strony (i nie jest zwracany). Drugi skan tabeli na kazde otwarcie
 * kosztowalby tyle samo, co pierwszy.
 *
 * Sortowanie po `id`, nie po `at` — powod jak przy `ostatniWpisLogu` (milisekunda moze byc wspolna).
 * `kto`: login konta, 'automat' (czuwacze, zegary) albo `null` (wpisy sprzed kont) — zwracane
 * dokladnie tak, jak lezy w bazie; nazwanie ich jest sprawa widoku.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} zamowienieId
 * @param {{strona?: number, naStrone?: number}} [opcje] strona liczona od 1
 * @returns {{wpisy: Array<{id: number, at: string, akcja: string, wynik: string | null, kto: string | null}>, maStarsze: boolean}}
 */
export function historiaLogu(db, zamowienieId, { strona = 1, naStrone = WPISOW_HISTORII_NA_STRONE } = {}) {
  const wiersze = db.prepare('SELECT id, at, akcja, wynik, kto FROM log WHERE zamowienie_id = ? ORDER BY id DESC LIMIT ? OFFSET ?')
    .all(zamowienieId, naStrone + 1, (strona - 1) * naStrone);
  return { wpisy: wiersze.slice(0, naStrone), maStarsze: wiersze.length > naStrone };
}

/**
 * ZAMOWIENIA TEGO PODMIOTU — historia stalego klienta (21.08.2026).
 *
 * ⚠️⚠️ DOPASOWANIE PO NIP-IE, NIGDY PO MAILU ANI PO NAZWIE. Ta sama zasada, co przy
 * „Zapamietaj tego klienta" (`klientPoNip`) i przy klientach zbiorczych: mail jest
 * wlasnoscia KORESPONDENCJI (klient pisze z telefonu, przez pracownika, z prywatnego
 * adresu), a NIP jest wlasnoscia PODMIOTU — i to on trafia na fakture. Historia zlozona
 * po mailu pokazywalaby zamowienia obcej firmy z tym samym adresem ksiegowosci.
 *
 * ⚠️⚠️ NIP EFEKTYWNY (`daneFaktury`), a NIE surowa kolumna `nip`. Reczna poprawka NIP-u
 * mieszka w `klient_reczny_json` i to wlasnie ona jedzie na fakture — a takze to po niej
 * panel rozpoznaje klienta przy „Zapamietaj tego klienta". Porownanie z sama kolumna
 * gubiloby dokladnie te zamowienia, przy ktorych ktos NIP poprawil, czyli te, w ktorych
 * najlatwiej o pomylke.
 *
 * ⚠️ HISTORIA SIEGA TYLKO TABELI `zamowienia`. Sprzedaz sprzed granicy kanalu lezy
 * w `sprzedaz_historyczna` (import z Apilo) i NIE MA TAM NIP-u — ani jednej kolumny.
 * Doklejenie tamtych wierszy po nazwie albo mailu byloby zgadywaniem; ekran mowi wprost,
 * od kiedy liczy (patrz widok `klient.ejs`).
 *
 * Pelny przeglad tabeli jest tu SWIADOMY: dopasowanie wymaga rozpakowania nadpisan, wiec
 * w SQL-u i tak sie go nie zrobi, a ekran karty klienta oglada sie rzadko i pojedynczo.
 */
export function zamowieniaPoNip(db, nip) {
  const szukany = normalizujNip(nip);
  if (!szukany) return [];
  const kandydaci = db.prepare('SELECT id, nip, klient_reczny_json FROM zamowienia').all();
  const ids = kandydaci
    .filter((w) => normalizujNip(daneFaktury(w).nip) === szukany)
    .map((w) => w.id);
  if (!ids.length) return [];
  const placeholdery = ids.map(() => '?').join(',');
  // ⚠️ WASKI ODCZYT, nie `zLinii`: karcie klienta wystarcza naglowek zamowienia, a `zLinii`
  // ciagnie pozycje, platnosci, przesylki i faktury kazdego wiersza — czyli caly ciezar
  // listy roboczej po to, zeby pokazac numer, date i kwote.
  const wiersze = db.prepare(
    `SELECT id, sklep, numer, kwota_brutto, utworzone_at, oplacone_at, wyslane_at,
            w_realizacji_at, anulowane, anulowane_recznie, zwrot_at, indywidualne, b2b,
            ${kolumnyStatusow(db)}
       FROM zamowienia WHERE id IN (${placeholdery}) ORDER BY utworzone_at DESC`,
  ).all(...ids);
  // ⚠️ `ma_zwrot` I `anulowane` MUSZA BYC POLICZONE TAK SAMO, JAK NA LISCIE I NA KARCIE —
  // czyta je `wyliczStatus` (domain/status.js), a to jedyne miejsce, ktore rozstrzyga status.
  // Wiersz bez `ma_zwrot` oddalby „wyslane" dla zamowienia, ktore wlasnie wrocilo;
  // `anulowane` prosto z kolumny pomijaloby anulowanie RECZNE (`anulowane_recznie`).
  const zwrotyMapa = zwrotyDlaZamowien(db, ids);
  return wiersze.map((w) => ({
    ...zStatusamiWlasnymi(db, w),
    anulowane: anulowaneEfektywnie(w) ? 1 : 0,
    ma_zwrot: (zwrotyMapa.get(w.id) ?? []).length > 0,
  }));
}

// BACKFILL DAT BEZ `Z` — druga polowa naprawy z domain/mapowanie.js (utcSklepu, audyt
// 22.08.2026). Kanaly Woo pisaly `utworzone_at`/`oplacone_at` czasem LOKALNYM sklepu,
// wiec 53 produkcyjne wiersze staly obok allegrowego UTC-Z i kazde porownanie dat miedzy
// kanalami klamalo o 2 h (trzy zamowienia z UJEMNYM czasem do nadania).
//
// ⚠️ CHODZI PRZY KAZDYM STARCIE KONTENERA (bootstrap, obok wyczyscBladStatusuBezSledzenia),
// wiec jest SAMOWYGASAJACY: predykat `NOT LIKE '%Z'` przestaje trafiac w wiersz w chwili,
// w ktorej go naprawi — po jednym przebiegu na produkcji nie zostaje nic do roboty
// (pulapka migracji bez granicy: przewodnik, „Migracje bazy chodza przy KAZDYM starcie").
//
// ⚠️ ZRODLEM JEST `surowe_json.date_created_gmt` / `date_paid_gmt` — PRAWDA SKLEPU, nie
// arytmetyka stref (ten projekt przejechal sie na czasie Warszawy dwa razy). Zmierzone
// na produkcji przed napisaniem tej funkcji: wszystkie 53 nagie wiersze maja GMT w surowym
// JSON-ie. Wiersz bez GMT zostaje NIETKNIETY i policzony w `pominiete` — zgadnieta strefa
// tworzylaby date, ktorej nikt nigdy nie widzial.
// ⚠️ WYLACZNIE SKLEPY WOO (lista z konfiguracji, jak `bezSledzenia` przy statusie kuriera).
// Poza nimi nagi znacznik bywa DECYZJA, nie skaza: wsteczna wplata reczna dostaje „gola
// polnoc" swiadomie (godziny przelewu nie zmyslamy — parsujDateWplaty, 07.08), a taki
// wiersz liczony w `pominiete` wolalby o reke czlowieka przy kazdym starcie, bezpodstawnie.
export function znormalizujDatyWoo(db, sklepyWoo = []) {
  if (!sklepyWoo.length) return { naprawione: 0, pominiete: 0 };
  const znaki = sklepyWoo.map(() => '?').join(',');
  const wiersze = db.prepare(`
    SELECT id, utworzone_at, oplacone_at, surowe_json FROM zamowienia
    WHERE sklep IN (${znaki})
      AND ((utworzone_at IS NOT NULL AND utworzone_at NOT LIKE '%Z')
        OR (oplacone_at IS NOT NULL AND oplacone_at NOT LIKE '%Z'))
  `).all(...sklepyWoo);
  const zZet = (gmt) => {
    const g = String(gmt ?? '').trim();
    if (!g) return null;
    return g.endsWith('Z') ? g : `${g}Z`;
  };
  const zapisz = db.prepare('UPDATE zamowienia SET utworzone_at = ?, oplacone_at = ? WHERE id = ?');
  let naprawione = 0;
  let pominiete = 0;
  for (const w of wiersze) {
    let surowe = null;
    try { surowe = JSON.parse(w.surowe_json); } catch { surowe = null; }
    const nagieUtworzone = Boolean(w.utworzone_at) && !String(w.utworzone_at).endsWith('Z');
    const nagieOplacone = Boolean(w.oplacone_at) && !String(w.oplacone_at).endsWith('Z');
    const utworzone = nagieUtworzone ? zZet(surowe?.date_created_gmt) : null;
    const oplacone = nagieOplacone ? zZet(surowe?.date_paid_gmt) : null;
    // Polowiczna naprawa (jedna kolumna ma GMT, druga nie) tez liczy sie jako pominieta:
    // wiersz zostaje w predykacie i wpis w logu bootstrapu nie zgasnie, dopoki czlowiek
    // nie obejrzy go recznie.
    if ((nagieUtworzone && !utworzone) || (nagieOplacone && !oplacone)) {
      pominiete += 1;
      continue;
    }
    zapisz.run(utworzone ?? w.utworzone_at, oplacone ?? w.oplacone_at, w.id);
    naprawione += 1;
  }
  return { naprawione, pominiete };
}
