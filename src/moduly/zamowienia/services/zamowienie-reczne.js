import { utworzZamowienieReczne, przeliczKwoteRecznego } from '../../../oms/db/zamowienia-reczne.js';
import { dodajPozycjeReczna, zapiszNadpisaniaFaktury, pobierzZamowienie } from '../../../oms/db/zamowienia.js';
import { wartoscTowaruGrosze } from '../../../domena/oplata-obslugi.js';
import { rabatKontraktowy, zmienUstalenia } from './rabat.js';
import { doklejOplate } from './oplata.js';

/**
 * Zalozenie zamowienia RECZNEGO — jedyna droga, ktora wolno isc do bazy.
 *
 * ⚠️ KOLEJNOSC W TEJ FUNKCJI JEST O PIENIADZE i nie wolno jej przestawiac:
 *   1. zamowienie (numer nadawany w transakcji),
 *   2. pozycje,
 *   3. OPLATA — po pozycjach, bo prog darmowej dostawy liczy sie od wartosci TOWARU;
 *      przed nimi liczylby sie od zera, czyli oplata kurierska na kazdym zamowieniu
 *      klienta zbiorczego,
 *   4. KWOTA — po oplacie, inaczej suma zamowienia jej nie obejmie i bariera arytmetyczna
 *      zablokuje fakture od pierwszej sekundy,
 *   5. nadpisania faktury (osobny e-mail na dokumenty).
 *
 * ⚠️ TA FUNKCJA ISTNIEJE PO TO, ZEBY SEKWENCJI NIE PRZEPISYWAC DRUGI RAZ. Trasa formularza
 * (web/routes/zamowienia.js, POST /zamowienia/nowe) i trasa API wolaja JA, a nie wlasne
 * kopie — przepisana ponownie zostalaby przepisana z inna kolejnoscia, a to sa pieniadze.
 *
 * `okresId` przychodzi Z ZEWNATRZ (services/okres.js), bo jako jedyny potrafi ODMOWIC
 * (zamkniety miesiac) i musi to zrobic PRZED nadaniem numeru, ktorego nie da sie zwolnic.
 *
 * `znacznik` to JEDEN odczyt zegara wolajacego — ten sam, ktorym rozstrzygnal okres.
 * Wlasny odczyt tutaj dawalby na przelomie miesiaca zamowienie w LIPCOWYM okresie
 * z SIERPNIOWA data zlozenia (recenzja koncowa galezi, D4).
 *
 * ⚠️ `naliczajOplate` ISTNIEJE PO TO, ZEBY ZAMOWIENIE Z KARTY PANELU INDYWIDUALNEGO NIE
 * DOSTALO OPLATY ZA OBSLUGE. Oplata (obsluga / usluga kurierska) to element modelu
 * DROPSHIPPINGOWEGO — placi ja klient rozliczany zbiorczo za to, ze nadajemy jego paczki.
 * Zamowienie indywidualne to sprzedaz z OFERTY, ktora klient zaakceptowal co do grosza,
 * i doklejenie do niej 19 zl robi trzy szkody naraz:
 *   • faktura wychodzi wyzsza niz zaakceptowana oferta;
 *   • `oplacone` po stronie OMS-u wymaga pokrycia CALEJ kwoty, wiec wplata rowna ofercie
 *     zostawia zamowienie NIEOPLACONE — a wtedy ETAP IV panelu nie odpala sie NIGDY
 *     i nikt sie o tym nie dowiaduje, bo to stan „klient jeszcze nie zaplacil";
 *   • trasa z karty swiadomie podaje `okresId: null` (poza rozliczeniem zbiorczym),
 *     wiec naliczanie oplaty zbiorczej bylo z nia wprost sprzeczne.
 *
 * Domyslka jest `true`, zeby trasa formularza („Nowe zamowienie" w OMS-ie) dzialala
 * dokladnie jak dotad — to ona obsluguje klientow zbiorczych i to jej oplata sie nalezy.
 * Warunek „jesli okresId jest null" bylby CICHY i przy pierwszym zamowieniu zbiorczym
 * zalozonym poza okresem skasowalby oplate tam, gdzie sie nalezy.
 */
export function zalozZamowienieReczne({ db, dane, znacznik, okresId = null, naliczajOplate = true }) {
  const id = utworzZamowienieReczne(db, { ...dane, utworzone_at: znacznik }, okresId);
  try {
    return dokoncz({ db, dane, id, naliczajOplate });
  } catch (e) {
    // ⚠️ NUMER JUZ ZOSTAL NADANY i nie da sie go zwolnic — `utworzZamowienieReczne` domyka
    // wlasna transakcje, wiec wyjatek z dalszych krokow zostawia zamowienie POL-ZALOZONE
    // (numer jest, pozycji albo kwoty brak). Wolajacy MUSI dostac jego numer wewnetrzny,
    // bo tylko wtedy powie operatorowi „dokoncz tamto", a nie pozwoli zalozyc drugiego
    // zamowienia z drugim numerem na te sama sprzedaz. Przed wyjeciem sekwencji z trasy
    // niosla to zmienna `id` widoczna w `catch` trasy; tutaj niesie to sam wyjatek.
    //
    // Straz na ksztalt rzuconej wartosci: `throw 'tekst'` albo `throw null` da tutaj wartosc,
    // ktorej w trybie scislym nie da sie dopisac pola — proba podstawilaby TypeError w miejsce
    // ORYGINALNEGO bledu i wolajacy zobaczylby zupelnie inna przyczyne niz prawdziwa.
    if (e && typeof e === 'object') e.zamowienieId = id;
    throw e;
  }
}

function dokoncz({ db, dane, id, naliczajOplate }) {
  for (const pozycja of dane.pozycje ?? []) dodajPozycjeReczna(db, id, pozycja);

  // ⚠️⚠️ RABAT UMOWNY WCHODZI TU: PO POZYCJACH, ale PRZED `doklejOplate` — i ta kolejnosc
  // jest o pieniadze (23.08.2026). Prog darmowej dostawy liczy sie od wartosci towaru
  // PO RABACIE (`wartoscTowaruGrosze`), wiec rabat naliczony PO oplacie dawalby prog
  // policzony od cen KATALOGOWYCH: towar za 520 zl katalogowo (po 40% jedyne 312 zl, czyli
  // ponizej progu 500) nie dostalby uslugi kurierskiej, ktora sie nalezy.
  //
  // ⚠️ Powod istnienia calego kroku: stawka umowna dzialala wylacznie wtedy, gdy operator
  // kliknal „Wstaw dane klienta". Dwa z trzech sierpniowych zamowien klienta hurtowego stanely przez
  // to po cenie katalogowej — faktura zbiorcza bylaby zawyzona o 69,56 zl.
  //
  // Decyzje podejmuje domain/rabat-kontraktowy.js: rabat wpisany RECZNIE nie jest nadpisywany,
  // a klient spoza bazy nie dostaje niczego.
  const kontrakt = rabatKontraktowy(db, dane.nip);
  if (kontrakt.decyzja(dane.rabat_procent) === 'ustaw') {
    zmienUstalenia(db, id, {
      b2b: dane.b2b,
      termin_platnosci: dane.termin_platnosci,
      rabat_procent: kontrakt.stawka.procent,
    });
  }
  // ⚠️ OPLATA WCHODZI PO TOWARZE, NIGDY PRZED. Prog darmowej dostawy liczy sie od
  // wartosci towaru, a ta istnieje dopiero wtedy, gdy pozycje sa w bazie. Odwrotna
  // kolejnosc dawalaby prog liczony od zera, czyli oplate kurierska na KAZDYM
  // zamowieniu klienta zbiorczego.
  //
  // Czytamy pozycje z BAZY, a nie z `dane.pozycje`: liczymy od tego, co naprawde
  // zostalo zapisane, a nie od tego, co mielismy zamiar zapisac.
  const oplata = !naliczajOplate ? null : doklejOplate({
    db,
    zamowienieId: id,
    nip: dane.nip,
    // Etykieta klienta = paczke nadaje klient na SWOIM koncie kurierskim; operator
    // zaznacza to w formularzu (domain/nowe-zamowienie.js).
    etykietaKlienta: dane.etykietaKlienta,
    // ⚠️ ODBIOR OSOBISTY = NIKT NIE NADAJE PACZKI, wiec nie ma za co pobierac oplaty
    // (ani kurierskiej, ani za obsluge). Bez tego klient zbiorczy odbierajacy towar
    // na miejscu dostawal wiersz „Usługa kurierska" — przy gotowce realna kwote do
    // zainkasowania za usluge, ktorej nie bylo. Reguła siedzi w domenie, tutaj
    // ustalamy tylko FAKT z metody wysylki wybranej w formularzu.
    bezWysylki: dane.metoda_wysylki === 'odbior_osobisty',
    // BEZ `?.` celowo: brak swiezo zapisanego zamowienia ma polecic wyjatkiem, a nie
    // cichym zerem — zero znaczy „towar za 0 zl", czyli ponizej progu, czyli oplata
    // kurierska doklejona bez podstawy.
    wartoscTowaruGr: wartoscTowaruGrosze(pobierzZamowienie(db, id).pozycje),
  });
  // Kwota zamowienia recznego IDZIE ZA POZYCJAMI I DOSTAWA (patrz przeliczKwoteRecznego).
  // Wolane PO doklejeniu oplaty — inaczej kwota zamowienia nie objelaby jej i karta
  // zapalilaby blokade bariery arytmetycznej od pierwszej sekundy.
  // utworzZamowienieReczne wstawia wiersz z kwota_brutto = '0.00' na sztywno — bez tego
  // przeliczenia zamowienie z pozycjami albo z niezerowym kosztem dostawy zalozyloby sie
  // z bariera arytmetyczna zablokowana OD RAZU.
  przeliczKwoteRecznego(db, id);
  // Osobny e-mail do faktury idzie ta sama droga, co poprawka tego pola na karcie —
  // patrz komentarz przy nadpisaniaFaktury w domain/nowe-zamowienie.js.
  if (dane.nadpisaniaFaktury) zapiszNadpisaniaFaktury(db, id, dane.nadpisaniaFaktury, null);
  return { id, numer: pobierzZamowienie(db, id).numer, oplata };
}
