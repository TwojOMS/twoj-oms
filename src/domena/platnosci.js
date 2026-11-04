import { grosze, zl, kwotaOczekiwanaGrosze, kwotaZamowieniaGrosze } from './suma-pozycji.js';
import { bladOperatora } from './bledy.js';
import { czyPobranie, kwotaPobrania, pobranieZeSklepu } from './wysylka.js';
import { normalizujMetode } from './metody-platnosci.js';
import { odczytajKwotePobrania } from './pobranie-nadania.js';
// „Dzis” liczone W CZASIE WARSZAWSKIM, ta sama funkcja, ktora drukuje daty na karcie —
// kontener chodzi z TZ=UTC, wiec gole `new Date()` miedzy polnoca a druga w nocy oddawaloby
// DZIEN POPRZEDNI, a data „dzisiejsza” z formularza wygladalaby na wsteczna.
import { dzienWarszawa } from './format-daty.js';

// ⚠️ CALA arytmetyka wplat idzie przez `grosze()` z domain/suma-pozycji.js — TE SAMA
// funkcje, ktora steruje bariera arytmetyczna faktury i suma pod tabela „Pozycje".
// Druga kopia tej samej arytmetyki (choćby najprostsze `Number(a) + Number(b)`) rozjecha
// sie z bariera przy pierwszej zmianie, a po drodze klamie: 35.65 + 35.65 + 141.60 na
// floatach daje 212.89999999999998, czyli NIEDOPLATE na zamowieniu za 212,90 zl, ktore
// klient oplacil co do grosza. Panel odmawialby wtedy uznania pieniedzy, ktore ma.

const opisWplaty = (p) => `wpłata z ${p?.data ?? p?.utworzona_at ?? '(bez daty)'}`;

/** Suma WSZYSTKICH wplat zamowienia, w groszach. Rzuca na kwocie pustej/nieliczbowej. */
export function sumaWplatGrosze(platnosci) {
  return (platnosci ?? []).reduce((acc, p) => acc + grosze(p.kwota, opisWplaty(p)), 0);
}

/** Przedpłaty poza inkasem kuriera, w groszach. Stare date_paid Woo nie jest przedpłatą — ale tylko
 *  wtedy, gdy pobranie sprzedał SKLEP; pobranie włączone na karcie po opłacie online to dalej przedpłata. */
export function przedplatyPrzedPobraniem(z, wplaty = z?.platnosci) {
  return sumaWplatGrosze((wplaty ?? []).filter((p) =>
    !(czyPobranie(z) && (p.zrodlo === 'pobranie' || (p.zrodlo === 'sklep' && pobranieZeSklepu(z))))
    && normalizujMetode(p.metoda).klucz !== 'pobranie'));
}

/** Maksymalne pobranie po przedpłatach, w groszach (efektywna kwota z zamówienia). */
export function resztaDoPobrania(z, wplaty = z?.platnosci) {
  return Math.max(0, grosze(kwotaPobrania(z), 'kwota pobrania') - przedplatyPrzedPobraniem(z, wplaty));
}

export const brakKwoty = (kwota) => kwota === null || kwota === undefined || String(kwota).trim() === '';

/**
 * PRZ-143.05 (E3-D4): najwyższe pobranie po przedpłatach, w groszach — także bez kwoty pobrania.
 * Podstawa = efektywna kwota pobrania, a gdy jej brak — kwota zamówienia (`kwota_brutto`).
 * `null`, gdy brak obu: wtedy nie ma od czego liczyć i nadanie odmawia. Nigdy nie woła
 * `grosze()` na pustej kwocie (ten wyjątek mówi o „fakturze bez ceny" i wywracał ekran nadania).
 */
export function limitPobraniaGrosze(z, wplaty = z?.platnosci) {
  const kwota = kwotaPobrania(z);
  let podstawaGr;
  let podstawa;
  if (!brakKwoty(kwota)) {
    podstawaGr = grosze(kwota, 'kwota pobrania');
    podstawa = 'pobranie';
  } else if (!brakKwoty(z?.kwota_brutto)) {
    podstawaGr = kwotaZamowieniaGrosze(z);
    podstawa = 'zamowienie';
  } else {
    return null;
  }
  return { limit: Math.max(0, podstawaGr - przedplatyPrzedPobraniem(z, wplaty)), podstawa };
}

/** Tekst (b) z planu PRZ-137 E5-D2, bez końcówki „Panel niczego nie nadał.” — dokleja ją wołający. */
export const bladKwotyPobraniaZamowienia = (surowa) =>
  `Kwota pobrania na zamówieniu jest nieczytelna („${surowa}”) — popraw ją w „Szczegółach zamówienia” na karcie.`;

/**
 * PRZ-145.01 (E5-D1): niedopłata przy pobraniu = KWOTA ZAMÓWIENIA minus przedpłaty, w groszach.
 * Wpisana kwota pobrania NIE jest niedopłatą (dziura (e): K 50, wpłata 50, zamówienie 212.90
 * dawało „pobierz najwyżej 0” i sklep tracił 162.90 zł).
 *
 * Podstawa: `kwota_brutto`, gdy czytelna i > 0; inaczej kwota pobrania K (dawna reguła — zero
 * przy pobraniu to wada importu, nie „opłacone”). Wynik: `{ niedoplataGr, przedplatyGr,
 * podstawaGr, podstawa }`, `{ blad }` (zdanie dla operatora, bez końcówki) albo `null`, gdy nie
 * ma od czego liczyć. Nigdy nie rzuca z powodu K ani brutto.
 *
 * ⚠️ K ≤ 0 przy podstawie 'pobranie' daje `null`, nie „niedopłatę 0”: bez kwoty zamówienia nie
 * wiadomo, ile klient jest winien, a zero dałoby paczkę bez pobrania mimo wpłat (odmowa zamiast
 * cichej przedpłaty).
 */
export function niedoplataPobrania(z, wplaty = z?.platnosci) {
  let podstawaGr = null;
  let podstawa = 'zamowienie';
  if (!brakKwoty(z?.kwota_brutto)) {
    try {
      podstawaGr = kwotaZamowieniaGrosze(z);
    } catch {
      return { blad: `Kwota zamówienia jest nieczytelna („${z.kwota_brutto}”) — panel nie policzy niedopłaty. Sprawdź zamówienie w sklepie albo popraw je na karcie.` };
    }
  }
  if (podstawaGr === null || podstawaGr <= 0) {
    const surowaK = kwotaPobrania(z);
    if (brakKwoty(surowaK)) return null;
    const odczyt = odczytajKwotePobrania(surowaK);
    if (odczyt.rodzaj === 'ksztalt') return { blad: bladKwotyPobraniaZamowienia(surowaK) };
    if (odczyt.blad) return null;
    podstawaGr = odczyt.groszeKwoty;
    podstawa = 'pobranie';
  }
  const przedplatyGr = przedplatyPrzedPobraniem(z, wplaty);
  return { niedoplataGr: Math.max(0, podstawaGr - przedplatyGr), przedplatyGr, podstawaGr, podstawa };
}

// Data wplaty, ktora PRZEKROCZYLA prog kwoty zamowienia — czyli chwila, od ktorej
// zamowienie jest oplacone. To jest cala tresc wyliczanego `oplacone_at`: nie „ostatnia
// wplata" i nie „dzis", tylko ta konkretna wplata, ktora domknela kwote. Przy jednej
// wplacie na calosc wychodzi dokladnie to samo, co panel pokazywal dotad.
//
// Wplaty musza przyjsc UPORZADKOWANE po dacie (patrz platnosciZamowienia w db/platnosci.js):
// inaczej „ta, ktora przekroczyla prog" znaczyloby cos innego przy kazdym odczycie.
//
// `null` gdy suma nie pokrywa kwoty — i to jest jedyna droga, ktora daje nieoplacone.
export function dataPokryciaWplat(platnosci, kwotaBrutto) {
  const progGr = grosze(kwotaBrutto, 'kwota zamówienia');
  let sumaGr = 0;
  for (const p of platnosci ?? []) {
    sumaGr += grosze(p.kwota, opisWplaty(p));
    if (sumaGr >= progGr) return p.data ?? p.utworzona_at ?? null;
  }
  return null;
}

// Ile jeszcze brakuje, w groszach (ujemne = nadplata).
//
// ⚠️ Miara to KWOTA OCZEKIWANA OD KLIENTA (kwota ze sklepu + pozycje dopisane recznie),
// a NIE `kwota_brutto`. Liczenie od kwoty sklepowej znaczyloby, ze zamowienie z dopisana
// pozycja wyglada na rozliczone w chwili, gdy klient zaplacil samo to, co zamowil w sklepie —
// czyli panel przestalby pokazywac doplate, dla ktorej ta pozycja w ogole powstala.
export function brakujacaKwotaGrosze(zamowienie) {
  return kwotaOczekiwanaGrosze(zamowienie) - sumaWplatGrosze(zamowienie?.platnosci);
}

// Saldo do pokazania na karcie: suma wplat wobec kwoty zamowienia. NIEDOPLATA I NADPLATA
// SA OBIE JAWNE — zadnego z tych stanow nie wolno chowac. Nadplata jest rownie wazna jak
// niedoplata: to pieniadze klienta, ktore trzeba mu oddac albo rozliczyc, a panel jest
// jedynym miejscem, gdzie ktokolwiek to zobaczy.
//
// Nigdy nie rzuca: uszkodzona/pusta kwota nie ma prawa wywalic karty (ta sama zasada, co
// przy podsumowaniuPozycji), ale MA sie pokazac jako blad — nie jako ciche „wszystko gra".
/**
 * Czy pieniądze przychodzą DOPIERO PRZY DORĘCZENIU (kurier inkasuje).
 *
 * ⚠️ Przy pobraniu brak wpłaty jest stanem NORMALNYM, nie niedopłatą — i to jest DOKŁADNIE
 * ta sama reguła, którą od początku ma `ikonaPlatnosci` na liście („pobranie wygrywa nad
 * opłacone/nieopłacone"). Do 2026-07-31 pilnowało jej także ostrzeżenie na karcie, ale
 * przebudowa karty przeniosła ostrzeżenia do paska „Do załatwienia" i strażnik po drodze
 * wypadł: każde zamówienie za pobraniem zaczęło krzyczeć „NIEDOPŁATA".
 *
 * Stąd reguła stoi TERAZ w jednym miejscu, wołanym przez pasek i przez widok — żeby lista
 * i karta nie mogły znów powiedzieć czegoś innego o tym samym zamówieniu.
 *
 * Pytamy o POBRANIE (wartość EFEKTYWNA, po ręcznych korektach — `czyPobranie` czyta
 * nadpisanie, a w jego braku kolumnę), a nie o `kwota_pobrania`: to decyzja o pobraniu
 * rządzi, kwota jest jej skutkiem. Od 2026-08-01 nie pytamy też o NAZWĘ metody — pobranie
 * jest cechą płatności i ta sama dostawa („DPD") występuje w obu wariantach.
 */
export function platnoscPrzyOdbiorze(zamowienie) {
  return czyPobranie(zamowienie);
}

export function saldoWplat(zamowienie) {
  try {
    const sumaGr = sumaWplatGrosze(zamowienie?.platnosci);
    // Kwota OCZEKIWANA (ze sklepu + dopisane recznie), nie sama sklepowa — patrz
    // brakujacaKwotaGrosze wyzej. Inaczej doplata za dodatkowy szablon nigdy nie pokazalaby
    // sie jako niedoplata.
    const kwotaGr = kwotaOczekiwanaGrosze(zamowienie);
    const roznicaGr = sumaGr - kwotaGr;
    return {
      sumaZl: zl(sumaGr),
      kwotaZl: zl(kwotaGr),
      roznicaZl: zl(Math.abs(roznicaGr)),
      // Trzy stany, nie dwa: „pokryte" musi znaczyc DOKLADNIE zero roznicy, zeby nadplata
      // nie schowala sie w tym samym worku co rowna zaplata.
      stan: roznicaGr === 0 ? 'pokryte' : (roznicaGr < 0 ? 'niedoplata' : 'nadplata'),
      blad: null,
    };
  } catch (e) {
    return {
      sumaZl: null, kwotaZl: zamowienie?.kwota_brutto ?? null, roznicaZl: null,
      stan: 'blad', blad: e.message,
    };
  }
}

// Wplata z formularza „Dodaj platnosc". KWOTA JEST WYMAGANA — data, metoda i uwaga nie.
// Odmowa musi byc otagowana dla operatora (bladOperatora), inaczej trasa zamieni ja
// w „blad techniczny panelu" i czlowiek nie dowie sie, co poprawic.
//
// Pusta data bierze biezacy czas, bo wyliczony `oplacone_at` MUSI z czegos powstac:
// wplata bez daty domykajaca kwote dawalaby zamowienie oplacone „nigdy".
export function parsujWplate(body, teraz = new Date().toISOString()) {
  // Przecinek dziesietny to to, co czlowiek w Polsce naprawde wpisuje — i co juz dzis
  // przyjmuje pole wagi na ekranie nadania. Odrzucanie go tutaj byloby niespojnoscia
  // w obrebie jednego panelu, a przy `type="number"` przegladarka potrafi oddac PUSTA
  // wartosc zamiast wpisanej, wiec operator zobaczylby „podaj kwote" po tym, jak ja podal.
  const surowa = String(body?.kwota ?? '').trim().replace(',', '.');
  if (!surowa) throw bladOperatora('Podaj kwotę wpłaty — bez niej nie ma czego dopisać.');
  if (!Number.isFinite(Number(surowa))) {
    throw bladOperatora(`Kwota wpłaty nie jest liczbą: "${body?.kwota}".`);
  }
  const kwotaGr = grosze(surowa, 'wpłata');
  // Zero i kwoty ujemne odrzucamy WPROST: wplata na 0 zl nie jest zdarzeniem, a ujemna
  // po cichu zmniejszalaby saldo i mogla zdjac z zamowienia status „oplacone".
  if (kwotaGr <= 0) throw bladOperatora('Kwota wpłaty musi być większa od zera.');
  const data = parsujDateWplaty(body?.data, teraz);
  // ⚠️ METODA JEST WYMAGANA (audyt 22.08.2026). Jako pole opcjonalne zebrala na produkcji
  // 11 wplat bez metody na 3194,56 zl — druga pozycje po sumie — i kazde uzgodnienie
  // z wyciagiem bankowym zaczynalo sie od zgadywania. Odmowa stoi TUTAJ, w domenie, bo
  // widok nie jest bariera (ta sama lekcja, co przy dacie z 07.08); formularze podaja pole
  // wyboru (METODY_WPLATY_RECZNEJ z domain/metody-platnosci.js). Sprawdzana PO dacie:
  // zepsuta data ma dalej mowic o dacie, a nie o metodzie.
  const metoda = String(body?.metoda ?? '').trim();
  if (!metoda) throw bladOperatora('Wybierz metodę wpłaty — bez niej wpłaty nie da się uzgodnić z wyciągiem.');
  return {
    kwota: zl(kwotaGr),
    data,
    metoda,
    uwaga: String(body?.uwaga ?? '').trim() || null,
  };
}

// Data wplaty z formularza — `RRRR-MM-DD` z pola `type="date"`.
//
// ⚠️⚠️ POWSTALO Z TEGO, ZE POLE DATY ISTNIALO, ALE NIC GO NIE WALIDOWALO (07.08.2026).
// Do tego dnia szedl tu goly `String(body.data).trim()`: co czlowiek wpisal, ladowalo
// w bazie ZNAK W ZNAK. A z tej daty wylicza sie `oplacone_at`, czyli odpowiedz na pytanie
// „kiedy klient zaplacil". „5 sierpnia" albo „05.08.2026" zapisywalo sie bez mrugniecia
// i nie dawalo sie potem sformatowac (`fmtDataCzas` oddaje wtedy PUSTY STRING), wiec data
// po prostu ZNIKALA z karty — cicho, bez ani jednego bledu.
const KSZTALT_DATY = /^\d{4}-\d{2}-\d{2}$/;

function parsujDateWplaty(surowa, teraz) {
  const dzien = String(surowa ?? '').trim();
  // Pusta data bierze biezacy czas — dawne zachowanie i jedyne poprawne: wplata bez daty
  // domykajaca kwote dawalaby zamowienie oplacone „nigdy".
  if (!dzien) return teraz;

  if (!KSZTALT_DATY.test(dzien)) {
    throw bladOperatora(
      `Nie umiem odczytać daty wpłaty: „${dzien}" — podaj ją w formacie RRRR-MM-DD (np. 2026-08-01). `
      + 'Panel niczego nie dopisał.',
    );
  }
  // „2026-02-31" przechodzi wzorzec, a Date cicho przesuwa je na 3 marca — czyli wplata
  // wyladowalaby w INNYM DNIU, niz czlowiek wskazal. Ta sama pulapka, co przy podlodze
  // pollera (`parsujDateOd` w config.js), i domykana tak samo: porownaniem po przeliczeniu.
  const d = new Date(`${dzien}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== dzien) {
    throw bladOperatora(`Data wpłaty „${dzien}" nie jest istniejącą datą. Panel niczego nie dopisał.`);
  }

  const dzisiaj = dzienWarszawa(teraz);
  // Data z przyszlosci to prawie zawsze literowka w roku, a wplata „z przyszlosci" psuje
  // `oplacone_at` w sposob, ktorego nikt nie zauwazy.
  if (dzien > dzisiaj) {
    throw bladOperatora(
      `Data wpłaty „${dzien}" jest z przyszłości (dziś ${dzisiaj}). Panel niczego nie dopisał.`,
    );
  }
  // ⚠️ DZIS DOSTAJE PELNY ZNACZNIK CZASU, DZIEN WSTECZNY — POLNOC. Zamowienie zlozone dzis
  // o 10:33 z wplata „dzis 00:00" twierdziloby, ze pieniadze przyszly PRZED zamowieniem.
  // Przy dacie wstecznej godziny przeoczonego przelewu NIE ZNAMY, wiec jej nie zmyslamy.
  return dzien === dzisiaj ? teraz : `${dzien}T00:00:00`;
}

/**
 * Kwota, ktora formularz „Dodaj wplate" ma podstawic — czyli to, czego BRAKUJE.
 *
 * ⚠️ BRAKUJACA RESZTA, NIE KWOTA ZAMOWIENIA (prosba wlasciciela: „domyslnie […] cala kwota,
 * bo tak jest najczesciej"). Przy pierwszej wplacie to jedno i to samo — ale przy DOPLACIE
 * po wplacie czesciowej podstawienie pelnej kwoty znaczyloby nadplate wpisana jednym
 * klknieciem, czyli pieniadze do oddania klientowi.
 *
 * Pusty napis, gdy nie ma czego doplacac (pokryte albo nadplata) — pole zostaje puste,
 * zeby nie zapraszac do nadplaty. Liczone `saldoWplat`, czyli TA SAMA funkcja, ktora
 * drukuje pasek salda nad formularzem: druga implementacja rozjechalaby sie z nim
 * i formularz podstawialby inna liczbe, niz mowi zdanie tuz obok.
 */
export function domyslnaKwotaWplaty(zamowienie) {
  const saldo = saldoWplat(zamowienie);
  return saldo.stan === 'niedoplata' ? saldo.roznicaZl : '';
}
