// MIANOWNIK CAŁEJ ZAKŁADKI STATYSTYKI — jedno miejsce, w którym powstaje odpowiedź na
// pytanie „które zamówienia w ogóle wchodzą na ten ekran". Trzy sekcje (wysyłka,
// terminowość, płatności) dostają TĘ SAMĄ listę; osobne filtrowanie w każdej z nich
// znaczyłoby trzy tabele, których sumy się nie zgadzają.
import { dzienWarszawa } from './format-daty.js';
import { anulowaneEfektywnie } from './status-reczny.js';
import { czyTestowe } from './sprzedaz-okresu.js';
import { zamowieniaPoId, porzadekListy } from '../oms/db/zamowienia.js';
import { idZamowienWOkresie } from '../oms/db/okno-zamowien.js';
import { agregatorUslug, agregatorTerminowosci } from './statystyki-wysylki.js';
import { agregatorMetod } from './statystyki-platnosci.js';
import { setImmediate } from 'node:timers/promises';

const bezpiecznyJson = (s) => { try { return JSON.parse(s ?? '{}') ?? {}; } catch { return {}; } };

/**
 * Uzasadnienie decyzji z 13.09.2026 (przywrócone po recenzji PRZ-094.13).
 * Statystyka musi czytać TE SAME NAKŁADKI co lista zamówień. Surowe kolumny
 * dawały inne liczby dla tej samej paczki:
 * - `oplacone_at` na liście powstaje przy odczycie z tabeli `platnosci`, z progiem
 *   kwoty oczekiwanej od klienta. Migracja `przeniesWplatyDoListy` zeruje surową
 *   kolumnę przy wpłacie ręcznej, a `dodajWplateReczna` nigdy jej nie zapisuje.
 *   Zmierzone wtedy: 16 ze 132 zamówień sierpnia (12% miesiąca) wypadało z obu
 *   procentów jako „bez daty startu zegara”, choć były opłacone. Przy dopłacie
 *   efektywna data pokrycia bywa późniejsza niż sklepowa — surowa schlebia wynikowi.
 * - `metoda_wysylki` i `pobranie` też są efektywne: ręczna korekta z karty leży
 *   w `wysylka_reczna_json`, a rozkłady dostaw i płatności czytają te pola.
 * Próg `kwotaOczekiwanaGrosze` wymaga pozycji Z CENAMI, ręcznych nadpisań pozycji
 * i członu różnicowego dostawy. Liczenie tego tutaj tworzyłoby trzecią definicję
 * opłacenia. Dlatego nakładki nadal wykonuje `zLinii`, dziś przez zamowieniaPoId.
 * Historyczny pomiar 13.09.2026 (SQLite w pamięci): 226 zamówień — 88 ms wobec
 * 1,8 ms surowego odczytu; 2000 — 659 ms wobec 13 ms. Ówczesna lista miała N+1.
 * Te liczby dokumentują powód przyjęcia wspólnego odczytu, nie obecną wydajność:
 * PRZ-094.13 zawęża kandydatów i czyta dzieci porcjami, zachowując te same nakładki.
 *
 * Okno SQL wybiera kandydatów, a dzienWarszawa i wykluczenia ustalają mianownik.
 * Nakładki pozostają w zamowieniaPoId (wspólne z listą i kartą): efektywna data
 * pokrycia wpłat wymaga cen pozycji, nadpisań i różnicy kosztu dostawy. Surowe
 * dane integracji nie uczestniczą w tych wyliczeniach.
 * Kotwicą jest dzień złożenia, tak jak w RAPORTACH. Granica historii sprzedaży
 * nie obowiązuje: historia nie niesie danych o terminie, dostawie i płatności.
 * API listy zachowuje kolejność; ekran używa agregacji porcjami bez pełnej listy.
 */
export function zamowieniaOkresu(db, { od, do: doDnia }, reguly = {}) {
  return [...porcjeZamowienOkresu(db, { od, do: doDnia }, reguly)].flat().sort(porzadekListy);
}

function* porcjeZamowienOkresu(db, { od, do: doDnia }, reguly) {
  for (const ids of idZamowienWOkresie(db, od, doDnia)) {
    const wybrane = [];
    // Te same nakładki co na liście: pozycje, wpłaty i dostawa. Żadna z nich
    // nie czyta surowe_json — to pole jest potrzebne akcjom integracji, nie agregatom.
    for (const w of zamowieniaPoId(db, ids, { bezSurowych: true })) {
      if (anulowaneEfektywnie(w)) continue;
      const dzien = dzienWarszawa(w.utworzone_at);
      if (!dzien || dzien < od || dzien > doDnia) continue;
      // ⚠️ POPRAWKA RĘCZNA WYGRYWA — tak samo jak przy każdym innym odczycie klienta.
      // Adres zmieniony na karcie leży w `klient_reczny_json`, nie w `klient_json`.
      const klient = { ...bezpiecznyJson(w.klient_json), ...bezpiecznyJson(w.klient_reczny_json) };
      const nazwa = `${klient.first_name ?? ''} ${klient.last_name ?? ''} ${klient.company ?? ''}`;
      if (czyTestowe(klient.email, nazwa, reguly)) continue;
      wybrane.push({ ...w, dzien });
    }
    yield wybrane;
  }
}

/** Ekran nie zatrzymuje listy historii: po każdej porcji zostają tylko liczniki. */
export async function statystykiWOkresie(db, zakres, reguly = {}) {
  const uslugi = agregatorUslug();
  const termin = agregatorTerminowosci();
  const platnosci = agregatorMetod();
  for (const porcja of porcjeZamowienOkresu(db, zakres, reguly)) {
    for (const z of porcja) {
      uslugi.dodaj(z);
      termin.dodaj(z);
      platnosci.dodaj(z);
    }
    await setImmediate();
  }
  return { uslugi: uslugi.wynik(), termin: termin.wynik(), platnosci: platnosci.wynik() };
}

/**
 * Dzień (Warszawa) najstarszego zamówienia w tabeli `zamowienia` albo `null` przy pustej bazie.
 *
 * PRZ-093.07: domyślny początek danych zakładki, gdy instalacja nie ustawiła
 * `OMS_STATYSTYKI_PIERWSZY_DZIEN` (env wygrywa — trasa pyta tę funkcję tylko bez niego).
 * To prawdziwa odpowiedź na pytanie paska, bo `zamowieniaOkresu` czyta WYŁĄCZNIE wiersze
 * `zamowienia`: przed pierwszym z nich statystyki nie mają czego liczyć.
 * Ta sama kotwica co w `zamowieniaOkresu` — `dzienWarszawa(utworzone_at)`.
 * MIN po indeksie wybiera początek okna, nie porównuje napisów różnych stref.
 * Na liczby nie wpływa: decyduje tylko o pasku zastrzeżenia.
 */
export function pierwszyDzienZamowien(db) {
  const { minimum } = db.prepare('SELECT MIN(julianday(utworzone_at)) AS minimum FROM zamowienia').get();
  let pierwszy = null;
  // Lokalna data i UTC mogą mieć odwrotną kolejność chwil i dni warszawskich.
  // MIN znajduje początek po indeksie, a dokładny dzień wybiera wspólna definicja.
  const kandydaci = db.prepare('SELECT utworzone_at FROM zamowienia'
    + ' WHERE (julianday(utworzone_at) >= ? AND julianday(utworzone_at) <= ?)'
    + ' OR julianday(utworzone_at) IS NULL').all(minimum, minimum === null ? null : minimum + 2);
  for (const { utworzone_at: utworzone } of kandydaci) {
    const dzien = dzienWarszawa(utworzone);
    if (dzien && (pierwszy === null || dzien < pierwszy)) pierwszy = dzien;
  }
  return pierwszy;
}
