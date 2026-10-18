// STATYSTYKI WYSYŁKI — czyste agregacje nad listą z domain/statystyki-okresu.js.
// Ten moduł nie dotyka bazy i nie zna zegara.
import { uslugaDostawy } from './wysylka.js';
import {
  terminZamowienia, dniRoboczeDoWysylki,
} from './termin-wysylki.js';
import { dzienWarszawa } from './format-daty.js';

/** Udział w procentach z jednym miejscem po przecinku. Mianownik 0 → `null`, nie `0`. */
export const udzialProcent = (ile, zCzego) => (zCzego
  ? Math.round((ile / zCzego) * 1000) / 10
  : null);

/**
 * Rozkład zamówień po USŁUDZE DOSTAWY, którą wybrał klient.
 *
 * ⚠️⚠️ ETYKIETA POCHODZI Z `uslugaDostawy` (domain/wysylka.js) — TEJ SAMEJ reguły, którą
 * rysuje kolumna „Dostawa" na liście zamówień, karta, mail i specyfikacja do paczki.
 * Do 13.09.2026 stało tu `etykietaWysylki(z.metoda_wysylki, false, z.metoda_wysylki_nazwa)`
 * na SUROWYCH kolumnach i recenzja nazwała to wprost: zamówienie przychodzące jako
 * `inpost_paczkomat` i poprawione przez operatora na karcie na `dpd` pokazywało się na liście
 * jako „Kurier DPD", a w tym rozkładzie liczyło się jako „InPost Paczkomat". Metoda i pobranie
 * są wartościami EFEKTYWNYMI (ręczna korekta leży w `wysylka_reczna_json`), a ręczna zmiana
 * metody albo pobrania UNIEWAŻNIA nazwę usługi od Allegro — bo tamta nazwa opisuje wybór
 * kupującego, nie to, czym paczka naprawdę jedzie.
 *
 * ⚠️ POBRANIE DALEJ NIE ROZDZIELA USŁUGI na dwa wiersze — `uslugaDostawy` woła
 * `etykietaWysylki` z `czyPobranie = false` i to jest osobna, świadoma decyzja z 1.08.2026
 * (pobranie jest cechą PŁATNOŚCI i liczy się w sekcji płatności). Ma własny test.
 *
 * ⚠️ LICZYMY PER ZAMÓWIENIE, NIE PER PACZKA. Na produkcji 7 zamówień ma dwie paczki, więc
 * liczenie per paczka dałoby sumę 165 przy 158 wysłanych zamówieniach — liczbę, której nie
 * da się zestawić z RAPORTAMI ani z licznikiem na liście.
 */
export function rozkladUslug(zamowienia) {
  const a = agregatorUslug();
  for (const z of zamowienia) a.dodaj(z);
  return a.wynik();
}

export function agregatorUslug() {
  let suma = 0;
  const kubelki = new Map();
  const dodaj = (z) => {
    suma += 1;
    const etykieta = uslugaDostawy(z);
    kubelki.set(etykieta, (kubelki.get(etykieta) ?? 0) + 1);
  };
  const wynik = () => {
    const pozycje = [...kubelki.entries()]
      .map(([etykieta, ile]) => ({ etykieta, ile, udzial: udzialProcent(ile, suma) }))
      // Drugie kryterium jest obowiązkowe: bez niego kolejność dwóch usług o tej samej
      // liczbie skacze między odświeżeniami i ekran wygląda, jakby dane się zmieniały.
      .sort((a, b) => (b.ile - a.ile) || a.etykieta.localeCompare(b.etykieta, 'pl'));
    return { pozycje, suma };
  };
  return { dodaj, wynik };
}

// Kolejność jest treścią: rozkład czyta się od najlepszego wyniku do najgorszego, a pozycje
// PUSTE ZOSTAJĄ na ekranie. Tabela, z której znika „tego samego dnia", bo w tym miesiącu nic
// nie wyszło tego samego dnia, wygląda jak inna tabela — a to ta sama, z zerem.
const KUBELKI_CZASU = ['tego samego dnia', '1 dzień rob.', '2 dni rob.', '3+ dni rob.'];

const kubelekCzasu = (dniRobocze, tenSamDzien) => {
  if (tenSamDzien) return KUBELKI_CZASU[0];
  if (dniRobocze <= 1) return KUBELKI_CZASU[1];
  if (dniRobocze === 2) return KUBELKI_CZASU[2];
  return KUBELKI_CZASU[3];
};

/**
 * Terminowość wysyłki: dwa procenty, rozkład czasów i TRZY WYŁĄCZENIA.
 *
 * ⚠️⚠️ WYŁĄCZENIA SĄ CZĘŚCIĄ WYNIKU, NIE ŚMIECIEM DO WYRZUCENIA. Procent bez widocznego
 * mianownika jest nieweryfikowalny, a każde z tych trzech ma na produkcji niezerową liczbę
 * (13.09.2026: 6 niewysłanych, 15 wysłanych przed wpłatą). Wliczone do licznika kłamałyby
 * w najlepszą stronę: `Number(null)` daje 0, czyli „tego samego dnia" — najlepszy możliwy
 * wynik dla zamówienia, które w ogóle nie umie odpowiedzieć na to pytanie.
 *
 * ⚠️ ANULOWANE NIE MAJĄ TU WIERSZA. Wypadają wcześniej, w `zamowieniaOkresu` — na poziomie
 * mianownika całego ekranu. Drugi wiersz odejmowałby tę samą liczbę dwa razy.
 *
 * `mianownik + niewyslane + przedWplata + bezStartu === zamowienia.length` — niezmiennik
 * przypięty testem. Każde zamówienie wpada dokładnie w jedno miejsce.
 */
export function terminowosc(zamowienia) {
  const a = agregatorTerminowosci();
  for (const z of zamowienia) a.dodaj(z);
  return a.wynik();
}

export function agregatorTerminowosci() {
  const wylaczenia = { niewyslane: 0, przedWplata: 0, bezStartu: 0 };
  const liczniki = new Map(KUBELKI_CZASU.map((k) => [k, 0]));
  let mianownik = 0;
  let wTerminie = 0;
  let tegoDnia = 0;

  const dodaj = (z) => {
    if (!z.wyslane_at) { wylaczenia.niewyslane += 1; return; }
    // ⚠️ KOLEJNOŚĆ TYCH DWÓCH WARUNKÓW JEST TREŚCIĄ. Brak startu (nieopłacona przedpłata)
    // sprawdzamy PRZED wysłaniem przed wpłatą — inaczej zamówienie bez `oplacone_at`
    // wpadłoby do „wysłane przed wpłatą", czyli do kubełka opisującego CO INNEGO.
    const termin = terminZamowienia(z);
    if (!termin) { wylaczenia.bezStartu += 1; return; }
    const dni = dniRoboczeDoWysylki(z, termin);
    if (dni === null) { wylaczenia.przedWplata += 1; return; }

    mianownik += 1;
    if (dni <= termin.limit) wTerminie += 1;
    const tenSam = termin.dzienStartu === dzienWarszawa(z.wyslane_at);
    if (tenSam) tegoDnia += 1;
    const kubelek = kubelekCzasu(dni, tenSam);
    liczniki.set(kubelek, liczniki.get(kubelek) + 1);
  };

  const wynik = () => ({
    mianownik,
    wTerminie,
    tegoSamegoDnia: tegoDnia,
    procentWTerminie: udzialProcent(wTerminie, mianownik),
    procentTegoSamegoDnia: udzialProcent(tegoDnia, mianownik),
    rozklad: KUBELKI_CZASU.map((etykieta) => ({
      etykieta,
      ile: liczniki.get(etykieta),
      udzial: udzialProcent(liczniki.get(etykieta), mianownik),
    })),
    wylaczenia,
  });
  return { dodaj, wynik };
}
