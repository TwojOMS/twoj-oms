import { przeliczenieRabatu, parsujRabat } from '../../../domena/rabat.js';
import { stawkaKontraktowa, decyzjaRabatu } from '../../../domena/rabat-kontraktowy.js';
import { czyNipUe } from '../../../domena/wdt.js';
import { daneFaktury } from '../../../domena/dane-faktury.js';
import { klientPoNip } from '../../../oms/db/klienci.js';
import { pobierzZamowienie, zapiszPozycjeReczna, zapiszUstaleniaHandlowe } from '../../../oms/db/zamowienia.js';
import { przeliczKwoteRecznego } from '../../../oms/db/zamowienia-reczne.js';
import { sumaPozycjiZWysylkaGrosze } from '../../../domena/suma-pozycji.js';
import { czytajStawkeDomyslna } from '../../faktury/db/stawka-vat.js';

// ZMIANA RABATU NA KARCIE — jedyna droga, którą wolno przeliczyć ceny już zapisanego
// zamówienia (21.08.2026).
//
// ⚠️⚠️ KOLEJNOŚĆ W TEJ FUNKCJI JEST O PIENIĄDZE i nie wolno jej przestawiać:
//   1. POZYCJE — nowe ceny jednostkowe i kwoty linii;
//   2. NAGŁÓWEK — kolumny `b2b` / `termin_platnosci` / `rabat_procent`, czyli zapis tego,
//      z czego te ceny wynikły. Zapisany PRZED pozycjami zostawiłby po awarii w połowie
//      zamówienie z rabatem 30% w nagłówku i cenami sprzed rabatu w tabeli — a to jest stan,
//      w którym nikt już nie odtworzy, co miało być prawdą;
//   3. KWOTA ZAMÓWIENIA — po jednym i drugim, bo liczy się z pozycji. Policzona wcześniej
//      nie objęłaby nowych cen i bariera arytmetyczna zablokowałaby fakturę od pierwszej
//      sekundy.
//
// ⚠️ CAŁOŚĆ W JEDNEJ TRANSAKCJI. Zamówienie z połową pozycji po rabacie i połową sprzed
// niego sumuje się do kwoty, której nikt nigdy nie uzgodnił — a wygląda przy tym poprawnie.

/**
 * @returns `{ rabat, zmienione, pominiete, sumaPrzedGr, sumaPoGr }` — wszystko, czego ekran
 *   potrzebuje, żeby powiedzieć operatorowi, CO się stało. Sam licznik zmian nie wystarcza:
 *   pozycja pominięta (cena wpisana ręcznie) wygląda z zewnątrz jak rabat, który „nie
 *   zadziałał", i operator szukałby usterki tam, gdzie jej nie ma.
 */
export function zmienUstalenia(db, id, { b2b, termin_platnosci: termin, rabat_procent: rabatSurowy }) {
  const przed = pobierzZamowienie(db, id);
  if (!przed) return null;

  const rabat = parsujRabat(rabatSurowy);
  const sumaPrzedGr = sumaPozycjiZWysylkaGrosze(przed);
  const { doZmiany, pominiete } = przeliczenieRabatu(przed.pozycje, {
    rabatPoprzedni: przed.rabat_procent ?? 0,
    rabatNowy: rabat,
    // Zamowienie WDT (nabywca z numerem VAT-UE): ceny panelu zawieraja ÷1,23, wiec
    // rozpoznanie „pozycji panelu" i nowa cena musza isc ta sama transformacja —
    // inaczej zmiana rabatu pominelaby caly wsad z magazynu jako „wyceniony recznie".
    wdt: czyNipUe(daneFaktury(przed).nip),
    // PRZ-105: ÷ stawka domyślna z Ustawień — ta sama, którą pozycja weszła z magazynu.
    stawkaDomyslna: czytajStawkeDomyslna(db),
  });

  db.exec('BEGIN IMMEDIATE');
  try {
    for (const p of doZmiany) {
      // ⚠️ TĄ SAMĄ funkcją, którą zapisuje ręczna edycja pozycji — razem z jej strażą
      // („pozycji ze sklepu nie zapisuje się wprost"). Własny UPDATE ominąłby tę straż
      // i przepisał cenę wiersza, który za dwie minuty i tak nadpisze poller.
      zapiszPozycjeReczna(db, id, p.id, {
        nazwa: p.nazwa, ilosc: p.ilosc, cena_brutto: p.cena_brutto, brutto_linii: p.brutto_linii,
      });
    }
    zapiszUstaleniaHandlowe(db, id, { b2b, termin_platnosci: termin, rabat_procent: rabat });
    // Dotyczy WYŁĄCZNIE zamówień ręcznych i sama o tym wie (`if (z.sklep !== 'reczne') return`).
    // Przy zamówieniu ze sklepu kwota należy do sklepu, a różnicę wobec niej liczy
    // `kwotaOczekiwanaGrosze` — dokładnie tak, jak przy każdej innej dopisanej pozycji.
    przeliczKwoteRecznego(db, id);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }

  return {
    rabat,
    zmienione: doZmiany,
    pominiete,
    sumaPrzedGr,
    sumaPoGr: sumaPozycjiZWysylkaGrosze(pobierzZamowienie(db, id)),
  };
}

/**
 * Stawka umowna dla NIP-u i decyzja, co z nia zrobic — cienka warstwa nad dwoma odczytami.
 *
 * ⚠️ CALA REGULA MIESZKA W `domain/rabat-kontraktowy.js`. Tutaj jest wylacznie wyszukanie
 * klienta w bazie stalych klientow. Druga kopia reguly rozjechalaby sie z pierwsza przy
 * pierwszej zmianie.
 *
 * ⚠️ NIP normalizuje `klientPoNip` (funkcja `normalizujNip`). Wlasne czyszczenie NIP-u tutaj
 * znaczyloby, ze ten sam klient bywa rozpoznany raz tak, raz inaczej.
 *
 * ⚠️ `config` odszedl z sygnatury 2026-08-24 razem z `OMS_KLIENCI_ZBIORCZY` — stawka ma
 * dzis jedno zrodlo i nie ma drugiej liczby do porownania.
 */
export function rabatKontraktowy(db, nip) {
  const stawka = stawkaKontraktowa({ klientBazy: klientPoNip(db, nip) });
  return {
    stawka,
    decyzja: (rabatZamowienia) => decyzjaRabatu({ rabatZamowienia, stawka }),
  };
}
