import { historiaWOknie, granice } from '../oms/db/historia-sprzedazy.js';
import { kanalHistoryczny, kanalOms, wymagajKlasyfikacji } from './kanaly-raportowe.js';
import { anulowaneEfektywnie } from './status-reczny.js';
import { dzienWarszawa } from './format-daty.js';
import { grosze } from './kwoty.js';
import { kwotaOczekiwanaGrosze } from './suma-pozycji.js';
import { nalozNadpisaniaPozycji } from './pozycje-reczne.js';
import { porcjeZamowienWOkresie } from '../oms/db/okno-zamowien.js';
import { setImmediate } from 'node:timers/promises';

// JEDYNE miejsce, w ktorym powstaje „sprzedaz w okresie". Ekran sprzedazy, rachunek zarzadczy
// i porownanie rok do roku wolaja TE JEDNA funkcje — druga sciezka liczaca to samo rozjechalaby
// sie o grosz przy pierwszej zmianie reguly.

import { nettoZamowieniaGrosze } from './netto-zamowienia.js';
export { nettoZamowieniaGrosze } from './netto-zamowienia.js';
// Listę klientów i filtr dostarcza konfiguracja, nigdy dane firmy w produkcie.
export const KLIENCI_WDT = new Set();
// Obie epoki OMS czytają identyczną migawkę klasyfikacji: zwrot musi obciążyć ten sam kanał.
const KOLUMNY_KLASYFIKACJI = ['sklep', 'indywidualne', 'b2b', 'okres_rozliczeniowy_id'];
const STATUSY_ODRZUCONE = new Set([21, 18]);
export function czyTestowe(email, nazwa, { czyTestowe: filtr = () => false } = {}) {
  return filtr(email, nazwa);
}
function granicaDla(mapa, kanal) {
  const g = mapa.get(kanal);
  // ⚠️ PRZERYWA. Kanal bez granicy nie ma jak sie policzyc ani z historii, ani z OMS-u —
  // a cicha pustka w jednym kanale wyglada dokladnie jak slaby miesiac.
  if (!g) {
    const e = new Error(
      `Raport nie wie, gdzie przebiega granica historii dla kanału ${kanal}.`
      + JAK_ZALOZYC_GRANICE,
    );
    e.dlaOperatora = true;
    throw e;
  }
  return g;
}

export function sprzedazWOkresie(db, { od, do: doDnia }, reguly = {}) {
  return [...wierszeSprzedazy(db, { od, do: doDnia }, reguly)].filter(w => w !== null).sort(poDniu);
}

// Ten sam generator i porządek wyniku. Trasy oddają sterowanie co 500 wierszy,
// także gdy zamówienia są wykluczone — /health nie czeka na całą historię.
export async function sprzedazWOkresieAsync(db, zakres, reguly = {}) {
  const wynik = [];
  for (const w of wierszeSprzedazy(db, zakres, reguly)) {
    if (w) wynik.push(w);
    else await setImmediate();
  }
  return wynik.sort(poDniu);
}

const poDniu = (a, b) => (a.dzien === b.dzien ? 0 : (a.dzien < b.dzien ? -1 : 1));

function* wierszeSprzedazy(db, { od, do: doDnia }, reguly) {
  wymagajKlasyfikacji(reguly.klasyfikacja);
  const mapa = granice(db);
  sprawdzGraniceBezHistorii(db, reguly.klasyfikacja);
  let przeczytane = 0;

  for (const w of historiaWOknie(db, od, doDnia)) {
    if (++przeczytane % 500 === 0) yield null;
    if (STATUSY_ODRZUCONE.has(w.status)) continue;
    if (czyTestowe(w.klient_email, w.klient_nazwa, reguly)) continue;
    const kanal = kanalHistoryczny(w, reguly.klasyfikacja);
    // Historia liczy sie DO granicy wlacznie.
    if (w.dzien > granicaDla(mapa, kanal)) continue;
    const bruttoGrosze = grosze(w.brutto, `historia ${w.apilo_id}`);
    yield {
      zrodlo: 'historia', id: w.apilo_id, numer: w.numer ?? w.apilo_id, dzien: w.dzien, kanal, bruttoGrosze,
      // ⚠️ `zrodlo` wyzej mowi „ktora EPOKA" (historia kontra OMS), a `zrodloDanych` — „ktory
      // SYSTEM ZRODLOWY" ('apilo' albo 'woo:<sklep>'). To dwie rozne rzeczy i musza byc dwoma
      // polami: od 27.08.2026 epoka historyczna ma DWA zrodla, a reguly, ktore pytaja o tagi
      // albo o dane klienta, dotycza wylacznie tego z Apilo.
      zrodloDanych: w.zrodlo,
      nettoGrosze: nettoZamowieniaGrosze(bruttoGrosze, w.klient_email, reguly.klienciWdt),
      faktura: Boolean(w.faktura), oplacone: w.payment_status === 2,
      email: w.klient_email ?? null, tagi: JSON.parse(w.tagi_json ?? '[]'),
      pozycje: w.pozycje.map((p) => ({
        nazwa: p.nazwa, ilosc: p.ilosc, typ: p.typ,
        bruttoGrosze: grosze(p.brutto_linii, `pozycja ${w.apilo_id}`),
      })),
    };
  }

  // Okno SQL ma zapas na strefy. Dokładną granicę wciąż liczy dzienWarszawa,
  // bo daty sklepowe bez strefy i znaczniki UTC mają różne znaczenie.
  // ⚠️⚠️ KAZDA KOLUMNA, KTOREJ POTRZEBUJE `kanalOms`, MUSI BYC NA TEJ LISCIE — a lista jest
  // wypisana z reki. Kolumna dolozona do tabeli i do reguly kanalu, ale POMINIETA tutaj,
  // przychodzi jako `undefined` i regula cicho wpada do galezi zapasowej: zamowienie
  // oznaczone jako B2B liczyloby sie jako RECZNE, bez ani jednego bledu, wygladajac na
  // „raport nie widzi nowych zamowien". Test tej reguly idzie wiec przez `sprzedazWOkresie`,
  // a nie przez samo `kanalOms` (21.08.2026).
  const kolumny = KOLUMNY_KLASYFIKACJI.join(', ') + ', id, numer, kwota_brutto, utworzone_at,'
    + ' anulowane, anulowane_recznie, chce_fakture, chce_fakture_reczne, klient_json,'
    + ' klient_reczny_json, oplacone_at, oplacone_recznie,'
    // ⚠️ KOLUMNA LICZY PIENIĄDZE, nie zdobi zapytania: poprawka ceny pozycji ze sklepu nie
    // mieszka w wierszu pozycji, tylko tutaj (domain/pozycje-reczne.js). Bez niej raport
    // policzyłby przecenioną linię po cenie sklepowej — cicho, bo różnica wyszłaby zerowa.
    // ⚠️ WYSYŁKA MA W `kwotaOczekiwanaGrosze` WŁASNY CZŁON RÓŻNICOWY — bez ceny sklepowej
    // z tej kolumny „dwie paczki zamiast jednej" liczyłoby się jako 0 × 2 i dopłata za
    // wysyłkę wypadałaby z raportu.
    + ' koszt_dostawy_brutto, pozycje_reczne_json';

  for (const porcja of porcjeZamowienWOkresie(db, kolumny, od, doDnia)) {
    for (const w of porcja) {
      if (anulowaneEfektywnie(w)) continue;
      const dzien = dzienWarszawa(w.utworzone_at);
      if (!dzien || dzien < od || dzien > doDnia) continue;
      const kanal = kanalOms(w, reguly.klasyfikacja);
      // OMS liczy sie DOPIERO PO granicy.
      if (dzien <= granicaDla(mapa, kanal)) continue;
      const klient = { ...bezpiecznyJson(w.klient_json), ...bezpiecznyJson(w.klient_reczny_json) };
      // ⚠️ KOMPLET WOO `billing`, NIE `imie/nazwisko/firma` — tak wyglada klient_json trzema
      // niezaleznymi drogami: sklep (domain/mapowanie.js: `klient: surowe.billing`), Allegro
      // (domain/allegro-mapowanie.js: adresPanelu mapuje imie/nazwisko/firma NA first_name/
      // last_name/company PRZY ZAPISIE) i reczne zamowienie (domain/nowe-zamowienie.js:
      // rozbijNazwe + company). Klucze imie/nazwisko/firma nie istnieja w tym obiekcie NIGDY —
      // regula nazwowa czytajaca je bylaby martwa na kazdym kanale OMS-u (recenzja Zadania 4).
      if (czyTestowe(klient.email, `${klient.first_name ?? ''} ${klient.last_name ?? ''} ${klient.company ?? ''}`, reguly)) continue;
      // ⚠️⚠️ TA SAMA MIARA, CO NA FAKTURZE — i to jest cała treść tej linii (23.08.2026).
      // Do tego dnia stało tu `grosze(w.kwota_brutto)`, czyli kwota ZE SKLEPU. Ta kolumna
      // z założenia NIE ROŚNIE od naszych dopisków (`kwotaZamowieniaGrosze` i komentarz przy
      // niej: podniesiona pociągnęłaby za sobą wpłatę sklepową i niedopłata zniknęłaby
      // z ekranu), więc pozycja dopisana ręcznie podnosiła fakturę, a raport zostawiała
      // w miejscu. Zmierzone na produkcji: zamówienie 28171 miało na fakturze 654,00 zł,
      // a w raporcie 429,00 zł — cała różnica to jedna pozycja dopisana ręcznie.
      //
      // ⚠️ SKALA JEST DZIŚ JEDNOSTKOWA, MECHANIZM NIE: na 23.08.2026 poprawka rusza DOKŁADNIE
      // JEDNO zamówienie (+225,00 zł). Dwa pozostałe rozjazdy „nagłówek < suma pozycji"
      // znalezione w bazie to zamówienia WŁASNE, które i tak nie
      // wchodzą do raportu (`czyTestowe`). Ale dokładka wraca przy każdej następnej dopłacie
      // do zamówienia sklepowego, więc liczy się reguła, nie dzisiejsze 225 zł.
      const pozycje = nalozNadpisaniaPozycji(pozycjeSurowe(db, w.id), w.pozycje_reczne_json);
      const bruttoGrosze = kwotaOczekiwanaGrosze({ ...w, pozycje });
      yield {
        zrodlo: 'oms', id: w.id, numer: w.numer, dzien, kanal, bruttoGrosze,
        nettoGrosze: nettoZamowieniaGrosze(bruttoGrosze, klient.email, reguly.klienciWdt),
        faktura: Boolean(w.chce_fakture_reczne ?? w.chce_fakture),
        oplacone: Boolean(w.oplacone_at || w.oplacone_recznie),
        email: klient.email ?? null, tagi: [],
        pozycje: doRankingu(pozycje, w.id),
      };
    }
    yield null;
  }
}

function bezpiecznyJson(s) {
  try { return JSON.parse(s ?? '{}') ?? {}; } catch { return {}; }
}

/**
 * ZWROTY W OKRESIE — osobna tablica, NIE wiersze sprzedazy.
 *
 * ⚠️⚠️ DLACZEGO OSOBNO: `agreguj` liczy `zamowien = wiersze.length`, sumuje sztuki z `pozycje`
 * i buduje `kanaly[].zamowien`. Wiersz zwrotu wrzucony do tamtej tablicy zepsulby CZTERY
 * liczniki naraz — w tym srednia wartosc zamowienia — i zrobilby to po cichu. Regula okresu,
 * kanalu i odsiewu testowych zostaje TUTAJ, w jednym pliku; konsument przyjmuje zwroty JAWNIE.
 *
 * ⚠️ Zwrot obciaza MIESIAC ZWROTU, nie miesiac sprzedazy (art. 14 ust. 1m PIT, art. 29a ust. 13
 * VAT) — dlatego oknem rzadzi `zwroty.data`, a nie data zamowienia.
 *
 * ⚠️ `zwroty.data` to CZYSTY DZIEN (YYYY-MM-DD), zapisywany wprost przez `dodajZwrot`
 * (db/zwroty.js) i zwalidowany regexem w `parsujZwrot` (domain/zwrot.js) — bez strefy i bez
 * czasu, w przeciwienstwie do `utworzone_at` z dwoma formatami. Dlatego okno porownujemy
 * WPROST w SQL-u, bez `dzienWarszawa`.
 *
 * ⚠️ Filtry sa TE SAME co przy sprzedazy i liczone po ZAMOWIENIU: anulowane i testowe nie
 * weszly do przychodu, wiec ich zwrot nie ma czego pomniejszac.
 *
 * `bruttoGrosze` jest DODATNIE — znak naklada agregacja. Ujemna wartosc w bazie i w tej
 * funkcji naraz to dwa miejsca na jeden minus i pierwszy blad znaku, ktorego nikt nie zauwazy.
 */
export function zwrotyWOkresie(db, { od, do: doDnia }, reguly = {}) {
  wymagajKlasyfikacji(reguly.klasyfikacja);
  const wiersze = db.prepare(
    'SELECT w.id, w.zamowienie_id, w.data, w.kwota, w.kwota_dostawy,'
    + ' ' + KOLUMNY_KLASYFIKACJI.map(k => `z.${k}`).join(', ') + ', z.anulowane, z.anulowane_recznie, z.klient_json, z.klient_reczny_json'
    + ' FROM zwroty w JOIN zamowienia z ON z.id = w.zamowienie_id'
    + ' WHERE w.data >= ? AND w.data <= ? ORDER BY w.data, w.id',
  ).all(od, doDnia);

  const wynik = [];
  for (const w of wiersze) {
    if (anulowaneEfektywnie(w)) continue;
    const klient = { ...bezpiecznyJson(w.klient_json), ...bezpiecznyJson(w.klient_reczny_json) };
    if (czyTestowe(klient.email, `${klient.first_name ?? ''} ${klient.last_name ?? ''} ${klient.company ?? ''}`, reguly)) continue;
    const bruttoGrosze = grosze(w.kwota, `zwrot ${w.id}`)
      + (w.kwota_dostawy ? grosze(w.kwota_dostawy, `zwrot dostawy ${w.id}`) : 0);
    wynik.push({
      id: w.id, zamowienieId: w.zamowienie_id, dzien: w.data, kanal: kanalOms(w, reguly.klasyfikacja),
      bruttoGrosze, nettoGrosze: nettoZamowieniaGrosze(bruttoGrosze, klient.email, reguly.klienciWdt),
    });
  }
  return wynik;
}

// ⚠️ KOMPLET KOLUMN, KTÓRYCH POTRZEBUJE NAKŁADKA — `id` i `zrodlo` budują klucz nadpisania
// (`kluczPozycji` w domain/pozycje-reczne.js), a bez `cena_brutto` przeceniona linia nie ma
// z czego przeliczyć kwoty. Trzy kolumny, które wystarczały do samego rankingu, dawałyby tu
// nakładkę bezczynną: klucz nie trafiałby w nic i różnica wobec sklepu wyszłaby zerowa.
function pozycjeSurowe(db, zamowienieId) {
  return db.prepare(
    'SELECT id, zrodlo_id, nazwa, ilosc, cena_brutto, brutto_linii, zrodlo FROM pozycje WHERE zamowienie_id = ?',
  ).all(zamowienieId);
}

// Kształt dla rankingu produktów i licznika sztuk — ten sam, co przed 23.08. Liczy się
// z pozycji EFEKTYWNYCH, więc linia przeceniona na karcie wchodzi do rankingu po cenie,
// którą karta pokazuje.
function doRankingu(pozycje, zamowienieId) {
  return pozycje.map((p) => ({
    nazwa: p.nazwa, ilosc: p.ilosc, typ: 1,
    bruttoGrosze: grosze(p.brutto_linii ?? '0.00', `pozycja ${zamowienieId}`),
  }));
}

/** Jawna, jednorazowa operacja administracyjna dla kanału bez historii. */
export function inicjalizujGraniceBezHistorii(db, kanal, doDnia, klasyfikacja) {
  wymagajKlasyfikacji(klasyfikacja);
  if (!klasyfikacja.raporty.has(kanal)) throw new Error('Nieznany kanał raportowy');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(doDnia) || new Date(doDnia + 'T00:00:00Z').toISOString().slice(0,10) !== doDnia) throw new Error('Niepoprawny dzień granicy');
  if ([...klasyfikacja.konta.values()].includes(kanal)) throw new Error('Kanał ma skonfigurowaną historię; wymaga pomiaru granicy');
  db.exec('BEGIN IMMEDIATE');
  try {
    if (granice(db).has(kanal)) throw new Error('Granica już istnieje; inicjalizacja odmawia nadpisania');
    if (db.prepare('SELECT COUNT(*) AS ile FROM sprzedaz_historyczna').get().ile > 0) throw new Error('Baza zawiera historię; granica wymaga pomiaru');
    const wiersze = db.prepare('SELECT ' + KOLUMNY_KLASYFIKACJI.join(', ') + ', utworzone_at FROM zamowienia').all();
    for (const w of wiersze) {
      if (kanalOms(w, klasyfikacja) !== kanal) continue;
      const dzien=dzienWarszawa(w.utworzone_at);
      if (!dzien || dzien <= doDnia) throw new Error('Granica musi poprzedzać pierwszy dzień sprzedaży OMS');
    }
    db.prepare('INSERT INTO granice_historii (kanal,do_dnia,zrodlo,uwaga) VALUES (?,?,?,?)').run(kanal,doDnia,'oms-bez-historii','Jawna jednorazowa inicjalizacja');
    db.exec('COMMIT');
  } catch(e) {db.exec('ROLLBACK');throw e;}
}

// Inicjalizacja bez historii nie może później po cichu wyciąć zaimportowanych danych.
// Kontrola obejmuje całą historię przed oknem/statusami oraz przed odrzuceniem za granicą.
function sprawdzGraniceBezHistorii(db, klasyfikacja) {
  const kanaly = new Set(db.prepare("SELECT kanal FROM granice_historii WHERE zrodlo = 'oms-bez-historii'").all().map(w => w.kanal));
  if (!kanaly.size) return;
  for (const w of historiaWOknie(db, '0000-01-01', '9999-12-31')) {
    const kanal = kanalHistoryczny(w, klasyfikacja);
    if (kanaly.has(kanal)) {
      const e = new Error(`Kanał ${kanal} ma granicę oms-bez-historii, ale zawiera zaimportowaną historię. Wymagany pomiar i jawne uzgodnienie granicy.`);
      e.dlaOperatora = true;
      throw e;
    }
  }
}

// PRZ-093.07: ciąg dalszy odmowy z `granicaDla` — nowa instalacja dostaje polecenie, które
// zakłada granicę (docs/instalacja-docker.md, sekcja 9), a nie samo „uzupełnij”. Składnia
// polecenia jest dosłownie z instrukcji; skrypt pomija kanały z zaimportowaną historią.
const JAK_ZALOZYC_GRANICE = ' Granicę kanału bez zaimportowanej historii zakłada polecenie na serwerze OMS:'
  + ' sudo sh /opt/oms/aktualizuj.sh compose exec -T oms node scripts/produkcja-pierwszy-start.mjs --granice'
  + ' (instrukcja instalacji, sekcja 9 „Integracje po kolei”; dzień granicy liczy samo: dzień przed datą z linii PREFIKS_OD kanału albo wczoraj).'
  + ' Kanał z zaimportowaną historią (OMS_HISTORIA_KLASYFIKACJA) to polecenie pomija — jego granicę trzeba ustalić pomiarem.'
  + ' Sprawdź też, czy po zmianie raportu nie pozostała osierocona granica starego identyfikatora.';
