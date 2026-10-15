import { grosze } from '../../domena/kwoty.js';
import { bladOperatora } from '../../domena/bledy.js';

// Dane, ktorych panel nie zna i poznac nie moze: skladki ZUS, zaplacona zaliczka PIT-5
// i zaplacony VAT-7. API inFaktu odmawia (skladki, KPiR i podatek sa poza planem taryfowym),
// a przelew jest CO MIESIAC INNY, bo skladka zdrowotna liczy sie od dochodu
// (maj 442,83 → czerwiec 894,30, dwukrotnie).
//
// ⚠️⚠️ BRAK WIERSZA = PUSTA SEKCJA I OSTRZEZENIE. Kwot ZUS NIGDY nie zgadujemy — ani ze
// sredniej, ani z poprzedniego miesiaca. Podstawiona kwota wyglada jak fakt, ktorego nikt
// juz nie zakwestionuje.

const teraz = () => new Date().toISOString();

// Klucz od strony wywolujacego (formularz, testy) → kolumna w `dane_miesieczne`.
// ⚠️ ROZBICIE ZUS-u NA SKLADOWE MA ZNACZENIE PODATKOWE: na skali skladki spoleczne
// pomniejszaja dochod, zdrowotna NIE — jedna kwota „razem" nie wystarczylaby do policzenia
// PIT-u w rachunku zarzadczym (Zadania 14–16).
const POLA = [
  ['zusSpoleczne', 'zus_spoleczne'], ['zusZdrowotna', 'zus_zdrowotna'],
  ['zusFunduszPracy', 'zus_fundusz_pracy'], ['zusRazem', 'zus_razem'],
  ['pit5', 'pit5_zaplacony'], ['vat7', 'vat7_zaplacony'],
  ['kpirPrzychod', 'kpir_przychod'], ['kpirKoszty', 'kpir_koszty'],
  ['zwroty', 'zwroty_brutto'], ['uwagi', 'uwagi'],
];

// Kolumna `uwagi` to jedyne pole, ktore NIE jest kwota — reszta trzyma napisy w zlotowkach.
const POLE_TEKSTOWE = 'uwagi';

/**
 * ⚠️ PRZECINEK NA KROPKE — inaczej pierwsza wpisana kwota polozylaby cala sekcje.
 *
 * Wlasciciel przepisuje skladki z PUE ZUS, gdzie separatorem dziesietnym jest PRZECINEK
 * („1874,53"). Taki napis wchodzil do bazy znak w znak, a `grosze()` (domain/kwoty.js) na nim
 * RZUCA — wiec kazde kolejne wejscie na ekran danych i kazdy rachunek zarzadczy odbijalby sie
 * od wpisu, ktory z ekranu wyglada poprawnie. Ta sama normalizacja stoi w `naWierszReczny`
 * przy recznych kosztach i z tego samego powodu.
 *
 * Spacje (takze niedzielace, wklejane z PUE razem z kwota) lecą przy okazji.
 */
function znormalizuj(wartosc, kolumna) {
  if (kolumna === POLE_TEKSTOWE) return wartosc;
  return wartosc.replace(/[\s ]/g, '').replace(',', '.');
}

/**
 * Zapisuje dane recznie wpisane za dany miesiac — nadpisuje caly wiersz (UPSERT), nie tylko
 * pola podane w `pola`. To jest wlasciwy ksztalt dla jedynego wywolujacego (formularz
 * /finanse/dane wysyla komplet pol naraz): pole pominiete albo puste zapisuje sie jako NULL,
 * czyli BRAK — dokladnie tak jak puste pole na formularzu ma dzialac (Zadanie 13).
 *
 * ⚠️ `miesiac` to okres, KTOREGO skladka dotyczy — nie data przelewu.
 */
export function zapiszDaneMiesiaca(db, miesiac, pola) {
  if (!/^\d{4}-\d{2}$/.test(String(miesiac))) {
    throw bladOperatora(`Niepoprawny miesiąc: „${miesiac}” (oczekiwane RRRR-MM).`);
  }
  const kolumny = POLA.map(([, k]) => k);
  const wartosci = POLA.map(
    ([klucz, kolumna]) => (pola[klucz] === undefined || pola[klucz] === ''
      ? null
      : znormalizuj(String(pola[klucz]), kolumna)),
  );
  db.prepare(
    `INSERT INTO dane_miesieczne (miesiac, ${kolumny.join(', ')}, zmienione_at)`
    + ` VALUES (?${',?'.repeat(kolumny.length)}, ?)`
    + ' ON CONFLICT(miesiac) DO UPDATE SET '
    + kolumny.map((k) => `${k} = excluded.${k}`).join(', ')
    + ', zmienione_at = excluded.zmienione_at',
  ).run(miesiac, ...wartosci, teraz());
}

/** Wiersz recznych danych jednego miesiaca, albo `null`, gdy nikt go jeszcze nie wpisal. */
export const daneMiesiaca = (db, miesiac) => db.prepare(
  'SELECT * FROM dane_miesieczne WHERE miesiac = ?',
).get(miesiac) ?? null;

/**
 * Miesiace danego roku, ktore MAJA juz wiersz — do paska miesiecy na ekranie danych.
 *
 * ⚠️ LICZY SIE ISTNIENIE WIERSZA, NIE KWOTY W NIM. To jest DOKLADNIE to samo kryterium, co
 * `daneOkresu().brakujace` nizej, i musi takie zostac: gdyby pasek wymagal niepustego ZUS-u,
 * pokazywalby jako zalegly miesiac, ktorego rachunek zarzadczy juz nie zglasza — operator
 * chodzilby wtedy poprawiac coś, co z punktu widzenia rachunku jest zrobione.
 */
export const miesiaceZDanymi = (db, rok) => new Set(
  db.prepare('SELECT miesiac FROM dane_miesieczne WHERE miesiac LIKE ?')
    .all(`${rok}-%`).map((w) => w.miesiac),
);

// Kolumna pusta/NULL liczy sie jako 0 W SUMIE OKRESU — ale to jest inna sprawa niz miesiac
// bez wiersza w ogole (ten idzie do `brakujace` i NIE wchodzi do sumy jako zero, patrz nizej).
const gr = (w, kolumna) => (w?.[kolumna] ? grosze(w[kolumna], kolumna) : 0);

/**
 * Dane za liste miesiecy, do rachunku zarzadczego.
 * ⚠️ MIESIAC BEZ WIERSZA TRAFIA DO `brakujace` I JEST WYMIENIONY Z NAZWY, a nie liczony jako
 * zero w `suma`. Policzony jako zero dalby rachunek, w ktorym ZUS po prostu nie istnieje —
 * i wygladalby dokladnie tak samo wiarygodnie jak policzony naprawde.
 */
export function daneOkresu(db, miesiace) {
  const wiersze = [];
  const brakujace = [];
  for (const m of miesiace) {
    const w = daneMiesiaca(db, m);
    if (w) wiersze.push(w); else brakujace.push(m);
  }
  // ⚠️ SUMA IDZIE NA GROSZACH, PRZEZ `grosze()`, NIGDY NA NAPISACH — ta sama zasada, co
  // wszedzie w module (przewodnik OMS, 4.5).
  const suma = {
    zusRazemGrosze: wiersze.reduce((s, w) => s + gr(w, 'zus_razem'), 0),
    zusSpoleczneGrosze: wiersze.reduce((s, w) => s + gr(w, 'zus_spoleczne'), 0),
    pit5Grosze: wiersze.reduce((s, w) => s + gr(w, 'pit5_zaplacony'), 0),
    vat7Grosze: wiersze.reduce((s, w) => s + gr(w, 'vat7_zaplacony'), 0),
    kpirPrzychodGrosze: wiersze.reduce((s, w) => s + gr(w, 'kpir_przychod'), 0),
    kpirKosztyGrosze: wiersze.reduce((s, w) => s + gr(w, 'kpir_koszty'), 0),
    zwrotyGrosze: wiersze.reduce((s, w) => s + gr(w, 'zwroty_brutto'), 0),
  };
  return { miesiace: wiersze, brakujace, suma };
}

/**
 * Roznica miedzy suma skladnikow ZUS a przelewem „razem", w groszach; `null`, gdy nie ma
 * kompletu skladnikow (bez kompletu rozjazdu NIE ZGADUJEMY).
 * ⚠️ TO MA BYC WIDOCZNE, A NIE WYGLADZONE: w styczniu 2026 skladniki daja 1 874,53, a przelew
 * 2 088,92 — rozjazd 214,39 zl jest do dzis niewyjasniony.
 */
export function rozjazdZus(w) {
  if (!w?.zus_spoleczne || !w?.zus_zdrowotna || !w?.zus_fundusz_pracy || !w?.zus_razem) return null;
  const skladniki = gr(w, 'zus_spoleczne') + gr(w, 'zus_zdrowotna') + gr(w, 'zus_fundusz_pracy');
  return gr(w, 'zus_razem') - skladniki;
}

// Jawny import danych startowych; aplikacja nie wywołuje go przy otwarciu bazy.
// Wiersze: [miesiac, społeczne, zdrowotna, fundusz, razem, PIT, VAT, przychód, koszty, zwroty, uwagi].
export function wgrajDaneStartowe(db, { nazwaMigracji, wiersze } = {}) {
  if (typeof nazwaMigracji !== 'string' || !nazwaMigracji.trim() || !Array.isArray(wiersze)) {
    throw new Error('Import danych miesięcznych wymaga jawnej nazwy migracji i wierszy.');
  }
  for (const w of wiersze) {
    if (!Array.isArray(w) || w.length !== 11 || !/^\d{4}-(0[1-9]|1[0-2])$/.test(String(w[0]))) {
      throw new Error('Niepoprawny wiersz importu danych miesięcznych.');
    }
  }
  const juz = db.prepare('SELECT 1 AS x FROM migracje_jednorazowe WHERE nazwa = ?').get(nazwaMigracji);
  if (juz) return;
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const w of wiersze) {
      db.prepare('INSERT OR IGNORE INTO dane_miesieczne (miesiac, zus_spoleczne, zus_zdrowotna,'
        + ' zus_fundusz_pracy, zus_razem, pit5_zaplacony, vat7_zaplacony, kpir_przychod,'
        + ' kpir_koszty, zwroty_brutto, uwagi, zmienione_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(...w, teraz());
    }
    db.prepare('INSERT OR IGNORE INTO migracje_jednorazowe (nazwa, wykonana_at) VALUES (?,?)').run(nazwaMigracji, teraz());
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}
