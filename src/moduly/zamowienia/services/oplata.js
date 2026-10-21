import { umowaZbiorcza } from '../../../domena/klient-zbiorczy.js';
import { klientPoNip } from '../../../oms/db/klienci.js';
import { oplataDlaZamowienia, NAZWA_OBSLUGI, NAZWA_KURIERA } from '../../../domena/oplata-obslugi.js';
import { zl } from '../../../domena/suma-pozycji.js';
import { dodajPozycjeReczna } from '../../../oms/db/zamowienia.js';
import { czytajStawkeDomyslna } from '../../faktury/db/stawka-vat.js';

const NAZWY_OPLAT = [NAZWA_OBSLUGI, NAZWA_KURIERA];

/**
 * Doklada oplate do zamowienia jako POZYCJE RECZNA.
 *
 * ⚠️ IDEMPOTENTNIE — sprawdzamy, czy pozycja o nazwie oplaty juz istnieje. Trasa zapisu
 * bywa wolana ponownie (poprawka zamowienia, powtorzone zatwierdzenie formularza),
 * a druga oplata na tym samym zamowieniu podnioslaby fakture o kwote, ktorej nikt
 * nie zauwazy przy kilkudziesieciu pozycjach.
 *
 * ⚠️ Warunek idempotencji patrzy na OBIE nazwy naraz, nie tylko na te wlasnie naliczona.
 * Zamowienie ma dostac JEDNA oplate — a to, ktora, potrafi sie miedzy wywolaniami zmienic
 * (operator poprawia „klient nadaje sam"). Warunek na sama biezaca nazwe przepuscilby
 * obsluge obok istniejacej uslugi kurierskiej i klient zaplacilby dwa razy.
 *
 * O TYM, CZY oplata sie nalezy, rozstrzyga WYLACZNIE domain/oplata-obslugi.js — tutaj nie
 * ma ani jednego progu i ani jednej kwoty.
 */
export function doklejOplate({
  db, zamowienieId, nip, etykietaKlienta, bezWysylki, wartoscTowaruGr,
}) {
  const klient = umowaZbiorcza(klientPoNip(db, nip));
  // Zaden klient zbiorczy — nie ma czego liczyc i nie ma po co pilnowac wartosci towaru
  // (zamowienia spoza rozliczenia zbiorczego ida ta trasa tysiacami).
  if (!klient) return null;

  // ⚠️ STRAZ NA WARTOSCI TOWARU. Prog sprawdza sie porownaniem `>=`, a `undefined >= 50000`
  // to po prostu `false` — zgubiona albo nieprzeliczona wartosc NIE wywalilaby niczego,
  // tylko po cichu doklejala 19 zl do kazdego zamowienia, takze do tych, przy ktorych
  // dostawa mala byc darmowa. Kwoty sa w GROSZACH i sa calkowite: ulamek znaczy, ze ktos
  // po drodze policzyl je na zlotowkach.
  if (!Number.isInteger(wartoscTowaruGr) || wartoscTowaruGr < 0) {
    throw new Error(
      `doklejOplate: wartość towaru musi być nieujemną liczbą groszy, dostałem "${wartoscTowaruGr}"`,
    );
  }

  // `bezWysylki` przechodzi PRZEZ ten serwis, a nie ZATRZYMUJE sie w nim — drugi warunek
  // tutaj byłby drugą regułą opłaty, cichszą od tej w domenie i rozjeżdżającą się z nią
  // przy pierwszej zmianie. Serwis przekazuje FAKT („nie ma wysyłki"), decyzję podejmuje
  // wyłącznie domain/oplata-obslugi.js.
  const oplata = oplataDlaZamowienia({ etykietaKlienta, bezWysylki, wartoscTowaruGr, klient });
  if (!oplata) return null;

  // ⚠️ STRAZ NA KWOCIE OPLATY STALA TU DO 2026-08-24 i zostala USUNIETA, a nie zgubiona.
  // Sprawdzala, czy kwota jest calkowita liczba groszy — bo NaN zapisalby sie w kolumnie
  // jako napis "NaN", a ulamek grosza jako "4.005", i jedno i drugie wywrocilo by sie
  // dopiero przy wystawianiu dokumentu. Odkad kwoty przyszly z `.env` na karte klienta,
  // JEDYNYM producentem obiektu `klient` jest `umowaZbiorcza` (domain/klient-zbiorczy.js),
  // ktora odmawia PRZED oddaniem obiektu i robi to precyzyjniej — nazywa brakujace pole
  // po imieniu. Ten warunek byl wiec od tej chwili nieosiagalny, a nieosiagalna straz
  // na sciezce pieniedzy jest gorsza niz jej brak: wyglada jak ochrona i nie chroni.
  // Test „kwota spoza liczb calkowitych RZUCA" celuje dzis w tamta straz.
  const juzJest = db.prepare(
    `SELECT 1 FROM pozycje WHERE zamowienie_id = ? AND zrodlo = 'reczna'`
    + ` AND nazwa IN (${NAZWY_OPLAT.map(() => '?').join(', ')})`,
  ).get(zamowienieId, ...NAZWY_OPLAT);
  if (juzJest) return null;

  const kwota = zl(oplata.kwotaGr);
  // TA SAMA funkcja, co przy dopisywaniu pozycji z karty — jedno miejsce, ktore wie, jak
  // wyglada wiersz o zrodle 'reczna' (i ktore odswieza `zmienione_at` zamowienia).
  dodajPozycjeReczna(db, zamowienieId, {
    nazwa: oplata.nazwa, sku: null, ilosc: 1, cena_brutto: kwota, brutto_linii: kwota,
    // PRZ-105: opłata dostaje stawkę domyślną z chwili doklejenia i ją zachowuje.
    vat: czytajStawkeDomyslna(db),
  });

  return oplata;
}
