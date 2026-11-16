import { warunkiDostawy } from '../../../domena/klient-zbiorczy.js';
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
 * O TYM, CZY oplata sie nalezy, rozstrzyga WYLACZNIE domena/oplata-obslugi.js — tutaj nie
 * ma ani jednego progu i ani jednej kwoty.
 */
export function doklejOplate({
  db, zamowienieId, nip, etykietaKlienta, bezWysylki, wartoscTowaruGr, zw = false,
}) {
  // `zw` (program wbudowany) — domyślna „zw” firmy zwolnionej trafia też na opłatę; bez flagi jak dotąd.
  const opcjeZw = { zw };
  const klient = warunkiDostawy(klientPoNip(db, nip));
  // Warunki każdego stałego klienta, niezależnie od rozliczenia miesięcznego.
  if (!klient) return null;

  // Wartość towaru musi być jawnie policzona w całkowitych groszach.
  if (!Number.isInteger(wartoscTowaruGr) || wartoscTowaruGr < 0) {
    throw new Error(
      `doklejOplate: wartość towaru musi być nieujemną liczbą groszy, dostałem "${wartoscTowaruGr}"`,
    );
  }

  // `bezWysylki` przechodzi PRZEZ ten serwis, a nie ZATRZYMUJE sie w nim — drugi warunek
  // tutaj byłby drugą regułą opłaty, cichszą od tej w domenie i rozjeżdżającą się z nią
  // przy pierwszej zmianie. Serwis przekazuje FAKT („nie ma wysyłki"), decyzję podejmuje
  // wyłącznie domena/oplata-obslugi.js.
  const oplata = oplataDlaZamowienia({ etykietaKlienta, bezWysylki, wartoscTowaruGr, klient });
  if (!oplata) return null;

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
    // Opłata dostaje stawkę domyślną z chwili doklejenia i ją zachowuje.
    vat: czytajStawkeDomyslna(db, opcjeZw),
  }, opcjeZw);

  return oplata;
}
