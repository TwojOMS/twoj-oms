import { pobierzZamowienie, dopiszLog, zapiszBladSyncSklepu, zapiszStanRealizacji } from '../../../oms/db/zamowienia.js';
import { statusDlaSklepu } from '../../../domena/sync-sklep.js';
import { statusDlaAllegro, stanAllegroPotwierdzaZgodnosc } from '../../../domena/allegro-status.js';
import { czyKanalAllegro } from '../../../domena/wysylka.js';
import { idsDolaczonych, PREFIKS_BLEDU_DOLACZONYCH as PREFIKS_DOLACZONYCH } from '../../../domena/scalanie.js';

/**
 * Odesłanie statusu zamówienia tam, skąd przyszło: do sklepu (WooCommerce) albo do kanału
 * (Allegro). Decyzję CO wysłać (i czy w ogóle) podejmuje domena — `domain/sync-sklep.js`
 * dla sklepów, `domain/allegro-status.js` dla kanałów — tutaj jest wyłącznie wykonanie,
 * zapis śladu i log.
 *
 * ⚠️ NIGDY NIE RZUCA. Zmiana statusu w panelu jest zapisem faktu stwierdzonego przez
 * człowieka i nie ma prawa się nie udać dlatego, że sklep albo Allegro akurat nie
 * odpowiada. Nieudana synchronizacja zostawia widoczny ślad (`zamowienia.sync_woo_blad` →
 * pasek „Do załatwienia" na karcie) i czeka na ponowienie, zamiast wycofywać decyzję
 * operatora.
 */
/**
 * ⚠️ KLIENT WYBIERANY PO SKLEPIE ZAMOWIENIA (Etap 2, 2026-08-01), a nie „ten jedyny".
 * Od kiedy panel obsluguje dwa sklepy, staly klient znaczylby, ze status zamowienia
 * ze sklepu A jedzie do sklepu B — czyli do ZUPELNIE INNEGO zamowienia o tym samym numerze
 * albo do zadnego. Mapa jest kluczowana wartoscia kolumny `zamowienia.sklep`, ta sama,
 * ktora rozdziela pollery. Dokladnie tak samo dziala mapa kanalow.
 */
// ⚠️ MIEJSCE OPISANE W DWOCH PRZYPADKACH, A NIE GOLYM RZECZOWNIKIEM — i to nie jest
// czepianie sie polszczyzny (D1, recenzja Partii 1 Planu B). Plan B wprowadzil szablony
// `w ${gdzie}` i `do ${gdzie}` z jednym slowem w mianowniku: dla Allegro wychodzilo dobrze
// („w Allegro", „do Allegro"), a dla sklepu — „status w sklep ustawiony na „completed"" i
// „nie dojechal do sklep". Przed Planem B log brzmial poprawnie („status w sklepie…"),
// wiec byla to REGRESJA, ktora przeszla przez cala partie, bo na te napisy nie bylo
// zadnego testu. Slad bledu laduje na pasku „Do zalatwienia" na karcie — czyta go operator.
const SKLEP = { nazwa: 'sklep', w: 'w sklepie', dokad: 'do sklepu' };
const KANAL_ALLEGRO = { nazwa: 'Allegro', w: 'w Allegro', dokad: 'do Allegro' };

export function createSyncSklep({ db, klienci = {}, klienciKanalow = {} }) {
  // ⚠️ JEDNA USLUGA, DWIE GALEZIE — a nie druga usluga obok (spec §7). Trasy wolaja
  // `odeslijStatus` w CZTERECH miejscach (zmiana statusu z karty, zmiana MASOWA, paczka
  // nadana poza panelem, „Wyslij ponownie") i zadne z nich nie ma prawa wiedziec, czy
  // zamowienie przyszlo ze sklepu, czy z Allegro. Druga usluga znaczylaby cztery nowe
  // rozgalezienia w trasach — i pewnosc, ze przy piatym miejscu wywolania ktos o jednym
  // zapomni.
  //
  // Slad bledu idzie do TEJ SAMEJ kolumny `sync_woo_blad`: pasek „Do zalatwienia" na karcie
  // jest jeden i ma go czytac z jednego miejsca. Nazwa kolumny mowi „woo" i tak zostaje —
  // migracja na zywej bazie nie jest tego warta, a `sprawy-karty.js` dobiera brzmienie
  // komunikatu po KANALE zamowienia, nie po nazwie kolumny.
  //
  // ⚠️ PANEL BEZ ANI JEDNEGO SKONFIGUROWANEGO KANALU zachowuje sie dokladnie tak, jak przed
  // Planem B: kanaly milcza. To nie jest wygoda, tylko ochrona przed sprawa NIE DO
  // ZALATWIENIA na pasku karty — panel, ktoremu zdjeto zmienne ALLEGRO_*, ma w bazie stare
  // zamowienia z Allegro i kazda zmiana ich statusu wieszalaby „panel nie ma polaczenia",
  // czyli usterke, ktora domknal Etap 4 (04.08.2026). Kanal NIEOBECNY W NIEPUSTEJ MAPIE to
  // co innego — to prawdziwa dziura w konfiguracji jednego z dwoch kont i ma byc widoczna.
  const znaKanaly = Object.keys(klienciKanalow).length > 0;

  // ⚠️ GALAZ ALLEGRO JEST ASYNCHRONICZNA, A SKLEPOWA NIE — i to nie jest niekonsekwencja.
  // Stan realizacji w Allegro trzeba przeczytac NA ZYWO tuz przed decyzja, bo nasza kopia
  // bywa nieaktualna NA ZAWSZE (Allegro nie podbija `updatedAt` przy zmianie tego pola —
  // zmierzone 05.08.2026 na 5 z 10 zamowien). Decyzja oparta na kolumnie milczalaby
  // dokladnie wtedy, gdy jest rozjazd. Sklepy tego problemu nie maja: `status_woo`
  // odswieza poller, a status w WooCommerce zmienia wylacznie panel.
  async function cel(z) {
    if (czyKanalAllegro(z)) {
      if (!znaKanaly) return null;
      // ⚠️ Bez `zrodlo_id` nie ma jak zbudowac sciezki `/order/checkout-forms/{id}/...`:
      // odczyt poszedlby pod adres z „undefined" w srodku i wrocilby bledem, ktorego
      // operator nie ma jak zalatwic. Regula (`statusDlaAllegro`) i tak by odmowila —
      // ale odczyt idzie PRZED nia, wiec straznik musi stac tutaj.
      if (!z.zrodlo_id) return null;
      const klient = klienciKanalow[z.sklep];
      // Bez klienta nie ma jak odczytac stanu — odmowa idzie nizej, wspolna droga.
      if (!klient) return { status: null, klient: null, gdzie: KANAL_ALLEGRO, akcja: 'sync-allegro.status' };
      // ⚠️ Wyjatek z odczytu NIE MOZE zamienic sie w `undefined` przekazane dalej jak zwykla
      // wartosc — `statusDlaAllegro` odmowiloby, ale cicho, bez sladu dla czlowieka. Rzucamy,
      // a `odeslijStatus` zapisuje to jako blad synchronizacji z przyciskiem „Wyslij ponownie".
      const wAllegro = await klient.pobierzStanRealizacji(z.zrodlo_id);
      // Odswiezamy kolumne TYM SAMYM odczytem. ⚠️ NIE DLA KARTY — `status_realizacji` NIE
      // JEST DZIS RENDEROWANY PRZEZ ZADEN WIDOK (`grep status_realizacji src/oms/web/` →
      // zero trafien) i zadna regula z niego nie korzysta: `statusDlaAllegro` dostaje stan
      // ARGUMENTEM, ze swiezego odczytu. Wartosc sluzy DIAGNOSTYCE (zajrzeniu do bazy, gdy
      // kanal zachowuje sie dziwnie) i przyszlym odbiorcom — poller nie odczyta tego
      // zamowienia ponownie NIGDY, wiec bez tego zapisu kolumna zostawalaby przy wartosci
      // z chwili pobrania, nieaktualnej na zawsze.
      //
      // ⚠️ Gdyby ktos kiedys pokazal te kolumne na karcie albo oparl na niej regule —
      // ten zapis staje sie warunkiem poprawnosci, a nie wygoda. Zapis idzie TAKZE wtedy,
      // gdy nie ma czego wysylac: prawda o kanale nie zalezy od tego, czy akurat cos robimy.
      zapiszStanRealizacji(db, z.id, wAllegro);
      const status = statusDlaAllegro(z, wAllegro);
      if (status) return { status, klient, gdzie: KANAL_ALLEGRO, akcja: 'sync-allegro.status' };
      // ⚠️ „NIE MA CZEGO WYSYLAC" MA TU DWA ZUPELNIE ROZNE ZNACZENIA (K2). Jesli swiezy
      // odczyt pokazuje, ze Allegro MA JUZ dokladnie ten status, ktory chcielismy wyslac —
      // to jest DOWOD, ze rozjazdu nie ma. Kazdy inny powod odmowy (anulowane, zwrot, brak
      // wpisu w mapie) nie mowi o stanie w Allegro NIC. Rozroznienie robi domena, zeby
      // usluga nie kopiowala u siebie reguly.
      return stanAllegroPotwierdzaZgodnosc(z, wAllegro)
        ? { potwierdzone: true, stan: wAllegro, gdzie: KANAL_ALLEGRO, akcja: 'sync-allegro.status' }
        : null;
    }
    const status = statusDlaSklepu(z);
    return status ? { status, klient: klienci[z.sklep], gdzie: SKLEP, akcja: 'sync-woo.status' } : null;
  }

  // PRZ-101.04: odesłanie statusu GŁÓWNEGO obejmuje jego dołączone — każde do swojego sklepu
  // (dołączone ma już przeniesione `wyslane_at`, oms/db/zamowienia.js). Wszystkie trasy wołają
  // właśnie to (karta, zmiana masowa, przesyłka ręczna, „Wyślij ponownie”), więc żadna nie musi
  // wiedzieć o grupie. Dołączone jest ukryte z listy, więc jego nieudane odesłanie ląduje także
  // na GŁÓWNYM (`sync_woo_blad` + log) — „Wyślij ponownie” na głównym ponawia całą grupę.
  async function odeslijStatus(id) {
    const wynik = await odeslijJedno(id);
    const z = pobierzZamowienie(db, id);
    const dolaczone = idsDolaczonych(z);
    if (!dolaczone.length) return wynik;
    const bledy = [];
    for (const d of dolaczone) {
      const r = await odeslijJedno(d);
      if (r.blad) bledy.push(`${pobierzZamowienie(db, d)?.numer ?? d}: ${r.blad}`);
    }
    if (bledy.length) {
      const opis = `${PREFIKS_DOLACZONYCH}${bledy.join('; ')}`;
      if (!wynik.blad) zapiszBladSyncSklepu(db, id, opis);
      dopiszLog(db, id, { akcja: 'sync-sklep.scalone', wynik: `BŁĄD: ${opis}` });
      return { ...wynik, blad: wynik.blad ?? opis };
    }
    // Ślad po dołączonych zdejmujemy tylko wtedy, gdy to on wisiał na głównym.
    if (!wynik.blad && String(z.sync_woo_blad ?? '').startsWith(PREFIKS_DOLACZONYCH)) zapiszBladSyncSklepu(db, id, null);
    return wynik;
  }

  async function odeslijJedno(id) {
    const z = pobierzZamowienie(db, id);
    if (!z) return { wyslany: null, powod: 'brak zamówienia' };

    let c;
    try {
      c = await cel(z);
    } catch (e) {
      // ⚠️ NIEUDANY ODCZYT JEST ROWNIE WAZNY JAK NIEUDANY ZAPIS: bez swiezego stanu nie wolno
      // wyslac niczego, a czlowiek musi wiedziec, ze status nie dojechal. Cisza w tym miejscu
      // znaczylaby, ze panel udaje, iz nie bylo czego robic.
      zapiszBladSyncSklepu(db, id, `nie udało się sprawdzić stanu w Allegro: ${e.message}`);
      dopiszLog(db, id, { akcja: 'sync-allegro.status', wynik: `BŁĄD odczytu: ${e.message}` });
      return { wyslany: null, blad: e.message };
    }

    // ⚠️ JEDYNE „NIE MA CZEGO WYSYŁAĆ", KTÓRE COKOLWIEK DOWODZI (K2, niezmiennik 4.9).
    // Świeży odczyt pokazał, że Allegro stoi dokładnie na tym, co chcieliśmy wysłać — czyli
    // rozjazdu nie ma, a ślad po starej awarii jest od tej chwili NIEPRAWDĄ na karcie.
    //
    // Do tej poprawki człowiek, który zrobił dokładnie to, co podpowiadał komunikat
    // (ustawił status ręcznie w panelu Allegro) i kliknął „Wyślij ponownie", zostawał ze
    // sprawą o wadze `blokada` wiszącą na karcie NA ZAWSZE — jedynym wyjściem był ręczny
    // UPDATE w pliku SQLite.
    //
    // Log dopisujemy TYLKO wtedy, gdy naprawdę było co zdjąć: inaczej każda masowa zmiana
    // statusu przy zgodnym Allegro dosypywałaby wpis „sprawdzono" do każdej karty z osobna.
    if (c?.potwierdzone) {
      if (z.sync_woo_blad) {
        zapiszBladSyncSklepu(db, id, null);
        dopiszLog(db, id, {
          akcja: c.akcja,
          wynik: `sprawdzono stan ${c.gdzie.w} („${c.stan}") — rozjazdu nie ma, ślad po nieudanej `
            + 'synchronizacji zdjęty',
        });
      }
      return { wyslany: null, powod: `${c.gdzie.nazwa} ma już ten status` };
    }

    // Brak roboty NIE czyści śladu po wcześniejszym błędzie: gdyby czyścił, cofnięcie
    // statusu na „W realizacji" po nieudanej wysyłce zdejmowałoby uwagę z karty, mimo że
    // kanał dalej stoi na starym stanie.
    //
    // ⚠️ PRZY SKLEPACH TO ZOSTAJE PRAWDĄ BEZ WYJĄTKU, i to jest cała różnica między
    // gałęziami: `statusDlaSklepu` porównuje z kolumną `status_woo`, czyli z KOPIĄ, która
    // może być nieaktualna — „nie ma czego wysyłać" nie dowodzi tam, że sklep ma właściwy
    // stan. Gałąź kanału czyta na żywo i dlatego wolno jej więcej (wyżej).
    if (!c) return { wyslany: null, powod: 'nie ma czego wysyłać' };

    if (!c.klient) {
      const opis = `panel nie ma połączenia z „${z.sklep}" (brak konfiguracji)`;
      zapiszBladSyncSklepu(db, id, opis);
      dopiszLog(db, id, { akcja: c.akcja, wynik: `BŁĄD: ${opis}` });
      return { wyslany: null, blad: opis };
    }

    try {
      if (czyKanalAllegro(z)) await c.klient.ustawStatusRealizacji(z.zrodlo_id, c.status);
      else await c.klient.ustawStatus(z.zrodlo_id, c.status);
    } catch (e) {
      zapiszBladSyncSklepu(db, id, `status „${c.status}" nie dojechał ${c.gdzie.dokad}: ${e.message}`);
      dopiszLog(db, id, { akcja: c.akcja, wynik: `BŁĄD: ${e.message}` });
      return { wyslany: null, blad: e.message };
    }

    // Kolumny `status_woo` i `status_realizacji` CELOWO zostają nietknięte — trzymają to, co
    // kanał OSTATNIO powiedział o sobie, a nie to, o co go poprosiliśmy. Wpisanie tu wartości
    // życzeniowej sprawiłoby, że przy nieudanym zapisie po drugiej stronie panel twierdziłby,
    // że zamówienie jest zrealizowane — a warunek „nie wysyłaj tego, co już jest" uznałby stan
    // za osiągnięty i nigdy by nie ponowił. Prawdę przynosi odczyt: poller przy sklepach,
    // `pobierzStanRealizacji` przy kanałach.
    zapiszBladSyncSklepu(db, id, null);
    dopiszLog(db, id, { akcja: c.akcja, wynik: `status ${c.gdzie.w} ustawiony na „${c.status}"` });
    return { wyslany: c.status };
  }

  return { odeslijStatus };
}
