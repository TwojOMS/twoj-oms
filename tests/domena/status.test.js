import { describe, it, expect } from 'vitest';
import { wyliczStatus, doZrobienia, anulowaneWymagaUwagi, ETYKIETY } from '../../src/domena/status.js';
import { PROG_ZAWIESZONEJ_FAKTURY_MS } from '../../src/domena/faktura-stan.js';
import { PROG_ZAWIESZONEGO_NADANIA_MS } from '../../src/domena/przesylka-stan.js';

const z = (o = {}) => ({
  anulowane: 0, zwrot_at: null, w_realizacji_at: null, wyslane_at: null,
  przesylki: [], faktura: null, ...o,
});
const teraz = () => new Date().toISOString();
const dawno = () => new Date(Date.now() - PROG_ZAWIESZONEJ_FAKTURY_MS - 60_000).toISOString();
const dawnoNadanie = () => new Date(Date.now() - PROG_ZAWIESZONEGO_NADANIA_MS - 60_000).toISOString();

// Przesylka nadana i CALKOWICIE zalatwiona: numer listu jest, etykieta lezy na dysku, sklep
// zsynchronizowany, odpytywanie DPD dziala. Dopiero taki wiersz wolno uznac za „nic tu po
// czlowieku" — wczesniej testy uzywaly atrapy `{ status: 'nadana' }`, ktora W RZECZYWISTOSCI
// opisuje paczke bez etykiety, czyli jeden z tych stanow, ktore wlasnie znikaly z listy.
const nadana = (nad = {}) => ({
  status: 'nadana', numer_listu: '1000000000001U', etykieta_sciezka: '/etykiety/1301.pdf',
  sync_woo_blad: null, status_kuriera_blad: null, utworzona_at: teraz(), ...nad,
});

describe('wyliczStatus', () => {
  it('puste zamówienie → nowe', () => {
    expect(wyliczStatus(z())).toBe('nowe');
  });

  it('znacznik realizacji → w_realizacji', () => {
    expect(wyliczStatus(z({ w_realizacji_at: '2026-07-29' }))).toBe('w_realizacji');
  });

  // ⚠️ ZMIANA 2026-07-31: status wysłany NIE wynika już z istnienia nadanej paczki,
  // tylko z własnego faktu `wyslane_at`. Etykieta powstaje przy pakowaniu, a paczka
  // wyjeżdża dopiero z kurierem — panel nie zna momentu wyjazdu, zna go człowiek.
  it('data wysyłki → wyslane', () => {
    expect(wyliczStatus(z({ wyslane_at: '2026-07-31' }))).toBe('wyslane');
  });

  it('sama nadana przesyłka to JESZCZE NIE wysłane — etykieta to nie wyjazd paczki', () => {
    expect(wyliczStatus(z({ przesylki: [{ status: 'nadana' }] }))).toBe('nowe');
  });

  // Przesylka w trakcie to jeszcze nie wyslane — inaczej zawieszone nadanie
  // udawaloby zamkniete zamowienie.
  it('przesyłka w trakcie NIE liczy się jako wysłane', () => {
    expect(wyliczStatus(z({ przesylki: [{ status: 'w_trakcie' }] }))).toBe('nowe');
  });

  it('data wysyłki bije znacznik realizacji', () => {
    expect(wyliczStatus(z({ w_realizacji_at: '2026-07-29', wyslane_at: '2026-07-31' }))).toBe('wyslane');
  });

  // Zwrot opisuje to, co stalo sie PO wyslaniu.
  it('zwrot bije wysłane', () => {
    expect(wyliczStatus(z({ zwrot_at: '2026-07-31', wyslane_at: '2026-07-30' }))).toBe('zwrot');
  });

  it('anulowane bije wszystko', () => {
    expect(wyliczStatus(z({ anulowane: 1, zwrot_at: '2026-07-31', wyslane_at: '2026-07-30' }))).toBe('anulowane');
  });

  // Ponizsze testy pinuja kazda sasiednia relacje pierwszenstwa OSOBNO
  // (tylko dwa fakty naraz), zeby przy zepsuciu bylo od razu widac,
  // ktora relacja padla — powyzszy test zbiorczy tego nie gwarantuje.
  it('anulowane bije zwrot (w izolacji)', () => {
    expect(wyliczStatus(z({ anulowane: 1, zwrot_at: '2026-07-31' }))).toBe('anulowane');
  });

  it('anulowane bije wysłane (w izolacji)', () => {
    expect(wyliczStatus(z({ anulowane: 1, wyslane_at: '2026-07-30' }))).toBe('anulowane');
  });

  // Brakujacy przypadek: bez tego testu zamiana kolejnosci anulowane/w_realizacji
  // w status.js nie psula zadnego testu.
  it('anulowane bije znacznik realizacji (w izolacji)', () => {
    expect(wyliczStatus(z({ anulowane: 1, w_realizacji_at: '2026-07-29' }))).toBe('anulowane');
  });

  it('zwrot bije znacznik realizacji (w izolacji)', () => {
    expect(wyliczStatus(z({ zwrot_at: '2026-07-31', w_realizacji_at: '2026-07-29' }))).toBe('zwrot');
  });

  it('każdy status ma polską etykietę', () => {
    for (const k of ['anulowane', 'zwrot', 'wyslane', 'w_realizacji', 'nowe']) {
      expect(ETYKIETY[k]).toBeTruthy();
    }
  });
});

describe('doZrobienia', () => {
  it('nowe i w realizacji zostają na liście roboczej', () => {
    expect(doZrobienia(z())).toBe(true);
    expect(doZrobienia(z({ w_realizacji_at: '2026-07-29' }))).toBe(true);
  });

  it('wysłane, zwrot i anulowane schodzą z listy roboczej', () => {
    expect(doZrobienia(z({ wyslane_at: teraz(), przesylki: [nadana()] }))).toBe(false);
    expect(doZrobienia(z({ zwrot_at: '2026-07-31' }))).toBe(false);
    expect(doZrobienia(z({ anulowane: 1 }))).toBe(false);
  });

  // Ta sama zasada, ktora projekt zapisal przy przesylce 'do_wyjasnienia' („znikneloby
  // z pola widzenia"), niezastosowana dotad do faktur: zamowienie WYSLANE, z faktura
  // wiszaca w stanie bez wyjscia, mialo status „wyslane" i wypadalo z listy roboczej.
  // Ostrzezenie widzial wylacznie ten, kto otworzyl akurat te karte.
  it('faktura „do wyjaśnienia” trzyma wysłane zamówienie na liście roboczej', () => {
    const zam = z({ wyslane_at: teraz(), przesylki: [nadana()], faktura: { ksef_status: 'do_wyjasnienia', utworzona_at: teraz() } });
    expect(wyliczStatus(zam)).toBe('wyslane');
    expect(doZrobienia(zam)).toBe(true);
  });

  it('osierocona rezerwacja faktury też trzyma zamówienie na liście roboczej', () => {
    expect(doZrobienia(z({ wyslane_at: teraz(), przesylki: [nadana()], faktura: { ksef_status: 'w_toku', utworzona_at: dawno() } }))).toBe(true);
  });

  // Wiszaca faktura przy zamowieniu ANULOWANYM jest jeszcze grozniejsza: dokument mogl
  // powstac do zamowienia, ktore nie dojdzie do skutku.
  it('anulowane zamówienie z wiszącą fakturą zostaje na liście roboczej', () => {
    expect(doZrobienia(z({ anulowane: 1, faktura: { ksef_status: 'do_wyjasnienia', utworzona_at: teraz() } }))).toBe(true);
  });

  it('faktura wystawiona i faktura właśnie wystawiana NIE trzymają zamówienia na liście', () => {
    expect(doZrobienia(z({ wyslane_at: teraz(), przesylki: [nadana()], faktura: { ksef_status: 'sent', numer: 'FV/1/2026', utworzona_at: teraz() } }))).toBe(false);
    expect(doZrobienia(z({ wyslane_at: teraz(), przesylki: [nadana()], faktura: { ksef_status: 'w_toku', utworzona_at: teraz() } }))).toBe(false);
  });

  // ⚠️ K1 (recenzja Partii 1 Planu B). TA SAMA zasada, co dwie powyżej — „stan wymagający
  // człowieka nie może zniknąć z listy roboczej" — zastosowana wreszcie do śladu po
  // nieudanym odesłaniu statusu CAŁEGO zamówienia (`zamowienia.sync_woo_blad`).
  //
  // Zmierzone przy recenzji: masowa zmiana na „Wysłane" przy padniętym kanale zapisała ślad
  // 20/20, a na liście roboczej nie było WIDOCZNE ANI JEDNO z nich — bo `wyliczStatus` daje
  // wtedy 'wyslane' i zamówienie schodzi z listy w tej samej sekundzie, w której powstał
  // problem. Kupujący dalej widzi u siebie stary status i nikt się o tym nie dowie bez
  // otwarcia karty.
  //
  // Kolumna przy PRZESYŁCE (`przesylki.sync_woo_blad`) to co innego i ma własną regułę
  // wyżej (sprawyPrzesylki) — tu chodzi o status zamówienia, nie o notatkę z numerem listu.
  it('nieudane odesłanie statusu trzyma wysłane zamówienie na liście roboczej', () => {
    const zam = z({ wyslane_at: teraz(), przesylki: [nadana()], sync_woo_blad: 'HTTP 503' });
    expect(wyliczStatus(zam)).toBe('wyslane');
    expect(doZrobienia(zam)).toBe(true);
  });

  // ⚠️ Reguła rządzi listą roboczą OBU kanałów i to jest ŚWIADOME: zamówienie sklepowe,
  // którego `completed` nie dojechało do WooCommerce, znaczy klienta bez maila
  // „zamówienie zrealizowane". Ono też ma wrócić na listę.
  it('działa tak samo dla zamówienia sklepowego (nie tylko allegrowego)', () => {
    expect(doZrobienia(z({ wyslane_at: teraz(), przesylki: [nadana()], sync_woo_blad: 'timeout' }))).toBe(true);
  });

  it('pusty ślad (NULL) niczego nie trzyma — zamówienie schodzi z listy normalnie', () => {
    expect(doZrobienia(z({ wyslane_at: teraz(), przesylki: [nadana()], sync_woo_blad: null }))).toBe(false);
  });
});

// I4. Zasada „stan wymagajacy czlowieka nie moze zniknac z listy roboczej" jest w tym
// projekcie zapisana dwa razy (komentarz przy przesylce 'do_wyjasnienia', potem doZrobienia
// dla faktur), ale do przesylki JUZ NADANEJ nie byla zastosowana ani razu. A tam boli
// najbardziej: wyliczStatus daje 'wyslane', wiec zamowienie schodzi z listy w tej samej
// sekundzie, w ktorej powstal problem.
describe('doZrobienia — nadana przesyłka z nierozwiązaną sprawą', () => {
  // NAJWAZNIEJSZY przypadek: paczka pojechala, ale sklep zostal na 'processing', wiec klient
  // NIGDY nie dostal numeru listu. Automatycznego ponowienia nie ma (swiadomie), a ostrzezenie
  // istnialo wylacznie na karcie, ktorej nikt nie ma powodu otwierac.
  it('nieudany sync ze sklepem trzyma nadane zamówienie na liście roboczej', () => {
    const zam = z({ wyslane_at: teraz(), przesylki: [nadana({ sync_woo_blad: 'status: sklep padł' })] });
    expect(wyliczStatus(zam)).toBe('wyslane');
    expect(doZrobienia(zam)).toBe(true);
  });

  it('nadana przesyłka bez etykiety zostaje na liście roboczej', () => {
    expect(doZrobienia(z({ przesylki: [nadana({ etykieta_sciezka: null })] }))).toBe(true);
  });

  it('martwe odpytywanie DPD zostaje na liście roboczej', () => {
    expect(doZrobienia(z({ przesylki: [nadana({ status_kuriera_blad: 'INCORRECT_LOGIN_OR_PASSWORD' })] }))).toBe(true);
  });

  // Kontrola pozytywna, ktora dzialala od Zadania 10 — pilnujemy, ze nie zgubilismy jej
  // po drodze przy przepisywaniu warunku na sprawyPrzesylki().
  it('przesyłka „do wyjaśnienia” nadal zostaje na liście roboczej', () => {
    expect(doZrobienia(z({ przesylki: [{ status: 'do_wyjasnienia', numer_listu: 'X1', utworzona_at: teraz() }] }))).toBe(true);
  });

  // I3. Osierocone 'w_trakcie' po restarcie procesu: wiersz zostaje na zawsze, a status
  // zamowienia to wtedy 'nowe' — akurat ten przypadek z listy nie znikal, ale musi byc
  // rozpoznawany jako sprawa czlowieka, bo panel sam z niego nie wyjdzie.
  it('zawieszone nadanie zostaje na liście roboczej', () => {
    expect(doZrobienia(z({ przesylki: [{ status: 'w_trakcie', utworzona_at: dawnoNadanie() }] }))).toBe(true);
  });

  it('nadanie, które naprawdę trwa, nie jest liczone jako sprawa człowieka', () => {
    expect(doZrobienia(z({
      zwrot_at: '2026-07-31',
      przesylki: [{ status: 'w_trakcie', utworzona_at: teraz() }],
    }))).toBe(false);
  });
});

// I5. Anulowanie PO nadaniu/wystawieniu chowalo zamowienie razem z paczka w drodze
// i dokumentem w KSeF. Nie trzeba zadnego wyscigu — wystarczy anulowanie dzien po wysylce.
describe('anulowane z żywą przesyłką albo fakturą', () => {
  it('anulowane po nadaniu zostaje na liście roboczej', () => {
    const zam = z({ anulowane: 1, przesylki: [nadana()] });
    // Status to FAKT ze sklepu i ma zostac nietkniety — zmieniamy widocznosc, nie fakty.
    expect(wyliczStatus(zam)).toBe('anulowane');
    expect(anulowaneWymagaUwagi(zam)).toBe(true);
    expect(doZrobienia(zam)).toBe(true);
  });

  // Faktura WYSTAWIONA jest tu najgrozniejsza: sama z siebie nie wymaga czlowieka
  // (fakturaWymagaCzlowieka daje false), ale przy anulowanym zamowieniu wymaga KOREKTY.
  it('anulowane z fakturą wystawioną zostaje na liście roboczej', () => {
    const zam = z({ anulowane: 1, faktura: { ksef_status: 'sent', numer: 'FV/1/2026', utworzona_at: teraz() } });
    expect(anulowaneWymagaUwagi(zam)).toBe(true);
    expect(doZrobienia(zam)).toBe(true);
  });

  // Kontrola negatywna: anulowane zamowienie, do ktorego nic sie nie zdazylo wydarzyc,
  // ma dalej schodzic z listy. Inaczej „nie gubimy niczego" zamienia sie w „lista pokazuje
  // wszystko" i przestaje cokolwiek znaczyc.
  it('anulowane bez przesyłki i bez faktury schodzi z listy roboczej', () => {
    const zam = z({ anulowane: 1 });
    expect(anulowaneWymagaUwagi(zam)).toBe(false);
    expect(doZrobienia(zam)).toBe(false);
  });

  // ⚠️⚠️ UKRYCIE PACZKI MA ZDEJMOWAĆ ZAMÓWIENIE TAKŻE Z LISTY ROBOCZEJ (13.09.2026).
  //
  // Tak brzmi komentarz przy kolumnie `ukryta_at` w schema.sql od dnia jej dołożenia
  // (25.08.2026) — i do dziś to nie było prawdą: `anulowaneWymagaUwagi` liczyło KAŻDY
  // wiersz przesyłki, także ukryty. Zmierzone na produkcji 13.09: zamówienie 1267
  // (anulowane ręcznie, paczka ukryta przez człowieka 25.08, list 1048123722945U) wisiało
  // na liście „Do zrobienia" 19 dni — jako 1 z 7 pozycji, czyli 14% tej listy — wbrew
  // decyzji, którą ten człowiek już podjął i która ma w bazie swojego autora (`ukryta_przez`).
  //
  // ⚠️ Predykatem jest `przesylkaUkryta`, NIE goła kolumna `ukryta_at` — bo ukrycie
  // WYGASA, gdy u kuriera wydarzy się coś PO nim (paczka, którą spisano na straty, ruszyła).
  // Reguła kluczowana surową kolumną uciszyłaby wtedy paczkę żywą.
  describe('ukryta paczka nie trzyma anulowanego zamówienia na liście', () => {
    const ukryta = (nadpis = {}) => ({
      ...nadana(), ukryta_at: '2026-08-25T07:20:55.456Z', ukryta_przez: 'adam', ...nadpis,
    });

    it('anulowane z JEDYNĄ paczką ukrytą schodzi z listy', () => {
      const zam = z({ anulowane: 1, przesylki: [ukryta()] });
      // Status to FAKT ze sklepu — ukrycie zmienia widoczność, nie fakty.
      expect(wyliczStatus(zam)).toBe('anulowane');
      expect(anulowaneWymagaUwagi(zam)).toBe(false);
      expect(doZrobienia(zam)).toBe(false);
    });

    it('paczka obudzona zdarzeniem kuriera PO ukryciu znów trzyma zamówienie', () => {
      const zam = z({
        anulowane: 1,
        przesylki: [ukryta({ status_kuriera_at: '2026-08-26T09:00:00.000Z' })],
      });
      expect(anulowaneWymagaUwagi(zam)).toBe(true);
      expect(doZrobienia(zam)).toBe(true);
    });

    it('jedna ukryta i jedna żywa — zamówienie ZOSTAJE', () => {
      const zam = z({ anulowane: 1, przesylki: [ukryta(), nadana()] });
      expect(anulowaneWymagaUwagi(zam)).toBe(true);
      expect(doZrobienia(zam)).toBe(true);
    });

    // ⚠️ Ukrycie paczki NIE ucisza wiszącego dokumentu. To dwie różne sprawy i tylko jedną
    // z nich człowiek zamknął — faktura przy anulowanym zamówieniu dalej wymaga korekty.
    it('ukryta paczka nie ucisza faktury przy anulowanym zamówieniu', () => {
      const zam = z({
        anulowane: 1,
        przesylki: [ukryta()],
        faktura: { ksef_status: 'sent', numer: 'FV/1/2026', utworzona_at: teraz() },
      });
      expect(anulowaneWymagaUwagi(zam)).toBe(true);
      expect(doZrobienia(zam)).toBe(true);
    });
  });
});

// ——— STATUS „INDYWIDUALNE" (2026-08-07) ————————————————————————————————————————————
//
// Prośba właściciela, wprost: „Status «indywidualne» jest zwykłym statusem gdzie
// zamówienie trafia na czas jego przetwarzania aż projekt indywidualny zostanie
// zaakceptowany i przenoszone jest do statusu «w realizacji» razem z resztą zamówień."
// Do tej pory `indywidualne` było WYŁĄCZNIE trwałym znacznikiem kanału (wyliczanym
// z pozycji zamówienia — domain/indywidualne.js), więc zamówienie z panelu indywidualnego
// pokazywało „Nowe" i było „Indywidualne" na zawsze, równolegle. Liczniki w panelu bocznym
// się przez to nie sumowały.
//
// ⚠️ ZNACZNIK KANAŁU ZOSTAJE NIETKNIĘTY W BAZIE — czyta go `/api/sprzedaz` (kanał
// SKLEP_INDYWIDUALNE) i filtr kanału. Zmienia się WYŁĄCZNIE drabinka statusu.
describe('status „indywidualne”', () => {
  it('zamówienie z panelu indywidualnego, bez żadnych faktów → indywidualne, nie nowe', () => {
    expect(wyliczStatus(z({ indywidualne: 1 }))).toBe('indywidualne');
  });

  it('zwykłe zamówienie dalej → nowe', () => {
    expect(wyliczStatus(z({ indywidualne: 0 }))).toBe('nowe');
    expect(wyliczStatus(z())).toBe('nowe');
  });

  // SEDNO prośby: po akceptacji projektu zamówienie idzie „razem z resztą".
  it('znacznik realizacji ZDEJMUJE ze statusu indywidualnego', () => {
    expect(wyliczStatus(z({ indywidualne: 1, w_realizacji_at: '2026-08-07' }))).toBe('w_realizacji');
  });

  it('wysłane i zwrot wygrywają nad indywidualnym', () => {
    expect(wyliczStatus(z({ indywidualne: 1, wyslane_at: '2026-08-07' }))).toBe('wyslane');
    expect(wyliczStatus(z({ indywidualne: 1, zwrot_at: '2026-08-07' }))).toBe('zwrot');
  });

  it('anulowanie wygrywa nad indywidualnym', () => {
    expect(wyliczStatus(z({ indywidualne: 1, anulowane: 1 }))).toBe('anulowane');
  });

  // ⚠️ BEZ TEGO 14 ZAMÓWIEŃ ZNIKNĘŁOBY Z LISTY ROBOCZEJ w dniu wdrożenia: `doZrobienia`
  // wypisuje statusy wprost, a „indywidualne" to praca do wykonania, nie stan końcowy.
  it('zamówienie indywidualne ZOSTAJE na liście roboczej', () => {
    expect(doZrobienia(z({ indywidualne: 1 }))).toBe(true);
  });

  it('ma etykietę do pokazania człowiekowi', () => {
    expect(ETYKIETY.indywidualne).toBe('Indywidualne');
  });

  // Kolejność kluczy w ETYKIETY steruje kolejnością zakładek w panelu bocznym.
  // Właściciel poprosił o status „obok nowe".
  it('stoi w panelu bocznym zaraz za „Nowe”', () => {
    const klucze = Object.keys(ETYKIETY);
    expect(klucze[klucze.indexOf('nowe') + 1]).toBe('indywidualne');
  });
});
