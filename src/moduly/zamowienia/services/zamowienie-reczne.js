import {
  utworzZamowienieReczne,
  zapiszKosztDostawyRecznego,
  przeliczKwoteRecznego,
} from '../../../oms/db/zamowienia-reczne.js';
import { dodajPozycjeReczna, zapiszNadpisaniaFaktury, pobierzZamowienie } from '../../../oms/db/zamowienia.js';
import { wartoscTowaruGrosze, darmowaDostawa } from '../../../domena/oplata-obslugi.js';
import { rabatKontraktowy, zmienUstalenia } from './rabat.js';
import { doklejOplate } from './oplata.js';
import { warunkiDostawy } from '../../../domena/klient-zbiorczy.js';
import { klientPoNip } from '../../../oms/db/klienci.js';

/**
 * Wspólna droga formularza i API: pozycje → rabat umowny → dostawa i obsługa → suma.
 * `okresId` ustala wołający przed nadaniem numeru, `znacznik` jest jednym odczytem zegara.
 * `naliczajOplate: false` zachowuje kwoty zaakceptowane w ofercie panelu indywidualnego.
 */
// `zw` (program wbudowany, trasa podaje z kontekstu) — pozycje i opłata ze stawką „zw”; bez flagi jak dotąd.
export function zalozZamowienieReczne({ db, dane, znacznik, okresId = null, naliczajOplate = true, zw = false }) {
  const id = utworzZamowienieReczne(db, { ...dane, utworzone_at: znacznik }, okresId);
  try {
    return dokoncz({ db, dane, id, naliczajOplate, zw });
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

function dokoncz({ db, dane, id, naliczajOplate, zw }) {
  for (const pozycja of dane.pozycje ?? []) dodajPozycjeReczna(db, id, pozycja, { zw });

  // Próg dostawy liczymy od zapisanych pozycji po rabacie, nigdy od cen katalogowych.
  // Ręcznie uzgodnionego rabatu nie nadpisujemy stawką klienta.
  const kontrakt = rabatKontraktowy(db, dane.nip);
  if (kontrakt.decyzja(dane.rabat_procent) === 'ustaw') {
    zmienUstalenia(
      db,
      id,
      {
        b2b: dane.b2b,
        termin_platnosci: dane.termin_platnosci,
        rabat_procent: kontrakt.stawka.procent,
      },
      { zw },
    );
  }
  // Pozycje → rabat umowny → reguła dostawy → opłata → przeliczenie kwoty.
  const z = pobierzZamowienie(db, id);
  const wartoscTowaruGr = wartoscTowaruGrosze(z.pozycje);
  if (
    naliczajOplate &&
    darmowaDostawa({
      bezWysylki: dane.metoda_wysylki === 'odbior_osobisty',
      etykietaKlienta: dane.etykietaKlienta,
      wartoscTowaruGr,
      klient: warunkiDostawy(klientPoNip(db, dane.nip)),
    })
  ) {
    zapiszKosztDostawyRecznego(db, id, '0.00');
  }
  const oplata = !naliczajOplate
    ? null
    : doklejOplate({
        db,
        zamowienieId: id,
        nip: dane.nip,
        // Etykieta klienta = paczke nadaje klient na SWOIM koncie kurierskim; operator
        // zaznacza to w formularzu (domena/nowe-zamowienie.js).
        etykietaKlienta: dane.etykietaKlienta,
        // Odbiór osobisty ma pierwszeństwo przed własną etykietą.
        bezWysylki: dane.metoda_wysylki === 'odbior_osobisty',
        wartoscTowaruGr,
        zw,
      });
  // Kwota zamowienia recznego IDZIE ZA POZYCJAMI I DOSTAWA (patrz przeliczKwoteRecznego).
  // Wolane PO doklejeniu oplaty — inaczej kwota zamowienia nie objelaby jej i karta
  // zapalilaby blokade bariery arytmetycznej od pierwszej sekundy.
  // utworzZamowienieReczne wstawia wiersz z kwota_brutto = '0.00' na sztywno — bez tego
  // przeliczenia zamowienie z pozycjami albo z niezerowym kosztem dostawy zalozyloby sie
  // z bariera arytmetyczna zablokowana OD RAZU.
  przeliczKwoteRecznego(db, id);
  // Osobny e-mail do faktury idzie ta sama droga, co poprawka tego pola na karcie —
  // patrz komentarz przy nadpisaniaFaktury w domena/nowe-zamowienie.js.
  if (dane.nadpisaniaFaktury) zapiszNadpisaniaFaktury(db, id, dane.nadpisaniaFaktury, null);
  return { id, numer: pobierzZamowienie(db, id).numer, oplata };
}
