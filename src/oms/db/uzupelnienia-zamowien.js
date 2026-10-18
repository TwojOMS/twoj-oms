import { createHash } from 'node:crypto';
import {
  kosztDostawyBrutto, bruttoLinii, kosztDostawyNetto, nettoLinii, cenaJednostkowaNetto,
  punktOdbioruZeSurowych,
} from '../../domena/mapowanie.js';
import { ofertaLinii } from '../../domena/allegro-mapowanie.js';
import { czyIndywidualneZeSurowych } from '../../domena/indywidualne.js';
import { kuponyZeSurowych } from '../../domena/kupony.js';
import { atrybucjaZeSurowych } from '../../domena/atrybucja.js';

// ---------------------------------------------------------------------------------
// PRZ-094.25 — PRZEJSCIE PO ZAMOWIENIU RAZ, NIE PRZY KAZDYM STARCIE.
//
// Uzupelnienia dopisuja do kolumn to, co da sie wyczytac z `surowe_json` (uwagi, paczkomat,
// koszt dostawy, kwoty i identyfikatory pozycji...). Kazde z nich wybiera wiersze z kolumna
// NULL — a NULL zostaje na zawsze, gdy zrodlo tej informacji nie ma (zamowienie bez uwag klienta,
// bez paczkomatu, Woo bez oferty Allegro, Allegro bez `line_items`...). Wiec te wiersze byly
// czytane i parsowane przy KAZDYM starcie procesu, przed `app.listen`. Pomiar PRZ-094.08:
// 100 tys. zamowien = 5,7 s / ~210 MB (surowe_json 13 B) albo 30 s / ~1,2 GB (4 KB), przy
// limicie kontenera 512 MB.
//
// Zamiast znacznika w kazdym zamowieniu (kolumna = migracja bazy, a pusty napis zamiast NULL
// zmieniylby wszystkich czytelnikow tych kolumn) zapamietujemy GRANICE: najwyzsze `zamowienia.id`,
// ktore przeszlo wszystkie uzupelnienia. `id` to AUTOINCREMENT, wiec zamowienie dopisane pozniej
// zawsze ma wyzsze id i trafia w nastepny przebieg. Granica mieszka w `migracje_jednorazowe`
// (nazwa = `uzupelnienia-zamowien:<wersja>:do-id:<N>`, jeden wiersz).
//
// ⚠️ Co to zalozenie wymaga: zamowienie o id <= granicy ma juz wszystko, co z jego `surowe_json`
// da sie uzyskac, a pozniejsze zmiany tych kolumn przychodza z pollera (`zapiszZamowienie`
// zapisuje je z tych samych funkcji mapujacych przy kazdej synchronizacji), nie z uzupelnien.
// Reczne wyzerowanie kolumny w bazie NIE jest juz odtwarzane przy starcie — zeby przeliczyc
// wszystko od nowa: `DELETE FROM migracje_jednorazowe WHERE nazwa LIKE 'uzupelnienia-zamowien:%'`.
//
// ⚠️ DOLOZENIE KROKU: wersja granicy zawiera skrot z nazw krokow ponizej, wiec nowy krok
// (albo zmiana nazwy) sam uniewaznia granice i jeden raz przechodzi cala baze. Zmiana SAMEJ
// logiki istniejacego kroku tego nie robi — wtedy podbij WERSJA_LOGIKI.
// ---------------------------------------------------------------------------------
export const WERSJA_LOGIKI = 1;
const PREFIKS_ZNACZNIKA = 'uzupelnienia-zamowien:';
const PORCJA = 500;
const NAJWYZSZE_ID = Number.MAX_SAFE_INTEGER;

/** Zakres calej tabeli — domyslny dla wywolan pojedynczych krokow (testy, skrypty). */
export const BEZ_GRANIC = Object.freeze({ od: 0, do: NAJWYZSZE_ID });

function wTransakcji(db, praca) {
  if (db.isTransaction) { praca(); return; }
  db.exec('BEGIN IMMEDIATE');
  try {
    praca();
    db.exec('COMMIT');
  } catch (e) {
    // Przerwana porcja zostawia swoje wiersze z NULL-em, czyli „jeszcze nie policzone"; granica
    // nie jest przesuwana, wiec nastepny start sprobuje ponownie.
    db.exec('ROLLBACK');
    throw e;
  }
}

/**
 * Czyta `surowe_json` PORCJAMI po `id` (500 wierszy), wiec pamiec nie zalezy od liczby zamowien.
 * `sql` to SELECT z WHERE (bez ORDER/LIMIT); dokladamy zakres id, porzadek i limit. Kazda porcja
 * zapisuje sie w jednej transakcji — jeden fsync na porcje zamiast na kazdy `run()` (zmierzone przy
 * recenzji: 6 000 zamowien w autocommicie 140 s, w jednej transakcji 6,2 s).
 */
function wPorcjach(db, { sql, id = 'id' }, zakres, naPorcji) {
  const zapytanie = db.prepare(`${sql} AND ${id} > ? AND ${id} <= ? ORDER BY ${id} LIMIT ${PORCJA}`);
  const gora = zakres?.do ?? NAJWYZSZE_ID;
  let kursor = zakres?.od ?? 0;
  for (;;) {
    const wiersze = zapytanie.all(kursor, gora);
    if (wiersze.length === 0) return;
    if (zakres?.licznik) zakres.licznik.wiersze += wiersze.length;
    wTransakcji(db, () => naPorcji(wiersze));
    kursor = wiersze[wiersze.length - 1].id;
    if (wiersze.length < PORCJA) return;
  }
}

// Uszkodzony JSON pojedynczego zamowienia nie ma prawa zablokowac startu panelu.
function surowe(w) {
  try {
    const o = JSON.parse(w.surowe_json);
    return o && typeof o === 'object' ? o : null;
  } catch { return null; }
}

export function uzupelnijZrodloNumeru(db) {
  db.prepare(
    "UPDATE przesylki SET zrodlo_numeru = 'allegro'"
    + " WHERE zrodlo_numeru IS NULL AND kurier = 'allegro' AND nadana_recznie = 1",
  ).run();
}
export function uzupelnijIndywidualne(db, zakres = BEZ_GRANIC) {
  const zapisz = db.prepare('UPDATE zamowienia SET indywidualne = ? WHERE id = ?');
  // ⚠️ ZAPISY W TRANSAKCJI (porcja = jedna), i to nie jest mikrooptymalizacja. To przeliczenie
  // pisze do KAZDEGO zamowienia (zero jest wynikiem tak samo dobrym jak jedynka), a w autocommicie
  // kazdy `run()` to osobna transakcja WAL z wlasnym fsync. Zmierzone przy recenzji na ksztalcie
  // produkcyjnym: 1 000 zamowien — 4,6 s | 3 000 — 31,7 s | 6 000 — 140 s, a ta sama petla
  // w jednej transakcji: 6 000 w 6,2 s. To czas STARTU: panel jest wtedy nieosiagalny.
  wPorcjach(db, {
    sql: 'SELECT id, surowe_json FROM zamowienia WHERE indywidualne IS NULL AND surowe_json IS NOT NULL',
  }, zakres, (wiersze) => {
    for (const w of wiersze) {
      const s = surowe(w);
      if (!s) continue;
      zapisz.run(czyIndywidualneZeSurowych(s) ? 1 : 0, w.id);
    }
  });
  db.prepare(
    'UPDATE zamowienia SET indywidualne = 0 WHERE indywidualne IS NULL AND surowe_json IS NULL AND id > ? AND id <= ?',
  ).run(zakres?.od ?? 0, zakres?.do ?? NAJWYZSZE_ID);
}
export function uzupelnijPunktOdbioru(db, zakres = BEZ_GRANIC) {
  const zapisz = db.prepare('UPDATE zamowienia SET punkt_odbioru = ?, punkt_odbioru_opis = ? WHERE id = ?');
  wPorcjach(db, {
    sql: 'SELECT id, surowe_json FROM zamowienia WHERE punkt_odbioru IS NULL AND surowe_json IS NOT NULL',
  }, zakres, (wiersze) => {
    for (const w of wiersze) {
      const s = surowe(w);
      if (!s) continue;
      const { kod, opis } = punktOdbioruZeSurowych(s);
      if (kod) zapisz.run(kod, opis, w.id);
    }
  });
}
export function uzupelnijAtrybucje(db, zakres = BEZ_GRANIC) {
  const zapisz = db.prepare('UPDATE zamowienia SET atrybucja_json = ? WHERE id = ?');
  wPorcjach(db, {
    sql: `SELECT id, surowe_json FROM zamowienia
     WHERE atrybucja_json IS NULL AND surowe_json LIKE '%_wc_order_attribution_%'`,
  }, zakres, (wiersze) => {
    for (const w of wiersze) {
      const s = surowe(w);
      if (!s) continue;
      const a = atrybucjaZeSurowych(s);
      if (a) zapisz.run(JSON.stringify(a), w.id);
    }
  });
}
export function uzupelnijKupony(db, zakres = BEZ_GRANIC) {
  const zapisz = db.prepare('UPDATE zamowienia SET kupony_json = ? WHERE id = ?');
  wPorcjach(db, {
    sql: `SELECT id, surowe_json FROM zamowienia
     WHERE kupony_json IS NULL AND surowe_json LIKE '%"coupon_lines":[{%'`,
  }, zakres, (wiersze) => {
    for (const w of wiersze) {
      const s = surowe(w);
      if (!s) continue;
      const kupony = kuponyZeSurowych(s);
      if (kupony.length) zapisz.run(JSON.stringify(kupony), w.id);
    }
  });
}

/**
 * Wspolny szkielet krokow „pozycje zamowienia": zamowienia z pozycja sklepowa bez wartosci w kolumnie
 * `kolumna`, linie z `surowe_json` (pole `pole`) przypisane do wierszy `pozycje` po kolejnosci.
 */
function uzupelnijPozycje(db, zakres, { kolumna, pole = 'line_items', zapisz }) {
  const wiersze = db.prepare("SELECT id FROM pozycje WHERE zamowienie_id = ? AND zrodlo = 'sklep' ORDER BY id");
  wPorcjach(db, {
    // EXISTS zamiast DISTINCT + JOIN: ten sam zbior zamowien, ale bez deduplikowania calego surowe_json.
    sql: 'SELECT z.id, z.surowe_json FROM zamowienia z WHERE z.surowe_json IS NOT NULL AND EXISTS ('
      + `SELECT 1 FROM pozycje p WHERE p.zamowienie_id = z.id AND p.${kolumna} IS NULL AND p.zrodlo = 'sklep')`,
    id: 'z.id',
  }, zakres, (porcja) => {
    for (const w of porcja) {
      let s = null;
      try { s = JSON.parse(w.surowe_json); } catch { continue; }
      const linie = s?.[pole];
      if (!Array.isArray(linie)) continue;
      const nasze = wiersze.all(w.id);
      if (nasze.length !== linie.length) continue;
      nasze.forEach((p, i) => zapisz(linie[i], p.id));
    }
  });
}
export function uzupelnijProduktIdPozycji(db, zakres = BEZ_GRANIC) {
  const zapisz = db.prepare('UPDATE pozycje SET produkt_id = ? WHERE id = ?');
  uzupelnijPozycje(db, zakres, { kolumna: 'produkt_id', zapisz: (linia, id) => zapisz.run(produktLinii(linia), id) });
}
export function uzupelnijOfertaIdPozycji(db, zakres = BEZ_GRANIC) {
  const zapisz = db.prepare('UPDATE pozycje SET oferta_id = ? WHERE id = ?');
  uzupelnijPozycje(db, zakres, {
    kolumna: 'oferta_id', pole: 'lineItems', zapisz: (linia, id) => zapisz.run(ofertaLinii(linia), id),
  });
}
export function produktLinii(linia) {
  const id = Number(linia?.product_id);
  return Number.isInteger(id) && id > 0 ? id : null;
}
export function uzupelnijMetodePlatnosci(db, zakres = BEZ_GRANIC) {
  const zapisz = db.prepare('UPDATE zamowienia SET metoda_platnosci = ? WHERE id = ?');
  wPorcjach(db, {
    sql: 'SELECT id, surowe_json FROM zamowienia WHERE metoda_platnosci IS NULL AND surowe_json IS NOT NULL',
  }, zakres, (wiersze) => {
    for (const w of wiersze) {
      const metoda = metodaPlatnosciZeSurowych(w.surowe_json);
      if (metoda) zapisz.run(metoda, w.id);
    }
  });
}
export const PROG_BACKFILLU_WYSLANE = '2026-07-31';
export function uzupelnijWyslaneAt(db) {
  // Ten sam warunek w obu podzapytaniach — inaczej MIN() liczyloby sie z innego zbioru niz
  // ten, ktory decyduje o zapisie, i zamowienie z paczka stara ORAZ nowa dostaloby date
  // z paczki, ktorej backfill juz nie obejmuje.
  const objete = "p.zamowienie_id = zamowienia.id AND p.status = 'nadana'"
    + ' AND p.utworzona_at < @prog'
    // `IS NOT` zamiast `<>`: `<>` na NULL-u daje NULL (czyli falsz), wiec odrzucaloby KAZDA
    // paczke sprzed dolozenia kolumny `zrodlo_numeru` — czyli caly zbior, ktoremu backfill sluzy.
    + " AND p.zrodlo_numeru IS NOT 'allegro'";
  db.prepare(
    'UPDATE zamowienia SET wyslane_at = ('
    + `  SELECT MIN(p.utworzona_at) FROM przesylki p WHERE ${objete}`
    + ') WHERE wyslane_at IS NULL AND EXISTS ('
    + `  SELECT 1 FROM przesylki p WHERE ${objete}`
    + ')',
  ).run({ prog: PROG_BACKFILLU_WYSLANE });
}
export function przeniesWplatyDoListy(db) {
  const braki = db.prepare(
    'SELECT id, kwota_brutto, oplacone_at, oplacone_recznie, surowe_json FROM zamowienia'
    + " WHERE oplacone_at IS NOT NULL AND TRIM(oplacone_at) <> ''"
    + ' AND NOT EXISTS (SELECT 1 FROM platnosci p WHERE p.zamowienie_id = zamowienia.id)',
  ).all();
  const wstaw = db.prepare(
    'INSERT INTO platnosci (zamowienie_id, kwota, data, metoda, uwaga, zrodlo, utworzona_at)'
    + ' VALUES (?,?,?,?,?,?,?)',
  );
  const zdejmijZnacznik = db.prepare(
    'UPDATE zamowienia SET oplacone_at = NULL, oplacone_recznie = 0 WHERE id = ?',
  );
  const teraz = new Date().toISOString();
  for (const w of braki) {
    const reczna = w.oplacone_recznie === 1;
    wstaw.run(
      w.id,
      String(w.kwota_brutto),
      w.oplacone_at,
      reczna ? null : metodaPlatnosciZeSurowych(w.surowe_json),
      reczna ? 'przeniesione z ręcznego potwierdzenia wpłaty' : null,
      reczna ? 'reczna' : 'sklep',
      teraz,
    );
    if (reczna) zdejmijZnacznik.run(w.id);
  }
}
export function metodaPlatnosciZeSurowych(surowyJson) {
  if (!surowyJson) return null;
  try {
    const s = JSON.parse(surowyJson);
    return s?.payment_method_title || null;
  } catch {
    return null;
  }
}
export function uzupelnijChecFaktury(db) {
  db.exec(
    "UPDATE zamowienia SET chce_fakture = 1"
    + " WHERE chce_fakture = 0 AND nip IS NOT NULL AND TRIM(nip) <> ''",
  );
}
export function uzupelnijKosztDostawy(db, zakres = BEZ_GRANIC) {
  const zapisz = db.prepare('UPDATE zamowienia SET koszt_dostawy_brutto = ? WHERE id = ?');
  wPorcjach(db, {
    sql: 'SELECT id, surowe_json FROM zamowienia WHERE koszt_dostawy_brutto IS NULL AND surowe_json IS NOT NULL',
  }, zakres, (wiersze) => {
    for (const w of wiersze) {
      const s = surowe(w);
      if (!s) continue;
      zapisz.run(kosztDostawyBrutto(s), w.id);
    }
  });
}
export function uzupelnijUwagi(db, zakres = BEZ_GRANIC) {
  const zapisz = db.prepare('UPDATE zamowienia SET uwagi = ? WHERE id = ?');
  wPorcjach(db, {
    sql: 'SELECT id, surowe_json FROM zamowienia WHERE uwagi IS NULL AND surowe_json IS NOT NULL',
  }, zakres, (wiersze) => {
    for (const w of wiersze) {
      const s = surowe(w);
      if (!s) continue;
      if (s.customer_note) zapisz.run(s.customer_note, w.id);
    }
  });
}
export function uzupelnijKosztDostawyNetto(db, zakres = BEZ_GRANIC) {
  const zapisz = db.prepare('UPDATE zamowienia SET koszt_dostawy_netto = ? WHERE id = ?');
  wPorcjach(db, {
    sql: 'SELECT id, surowe_json FROM zamowienia WHERE koszt_dostawy_netto IS NULL AND surowe_json IS NOT NULL',
  }, zakres, (wiersze) => {
    for (const w of wiersze) {
      const s = surowe(w);
      if (!s) continue;
      zapisz.run(kosztDostawyNetto(s), w.id);
    }
  });
}
export function uzupelnijBruttoLinii(db, zakres = BEZ_GRANIC) {
  const zapisz = db.prepare('UPDATE pozycje SET brutto_linii = ? WHERE id = ?');
  uzupelnijPozycje(db, zakres, { kolumna: 'brutto_linii', zapisz: (linia, id) => zapisz.run(bruttoLinii(linia), id) });
}
export function uzupelnijNettoLinii(db, zakres = BEZ_GRANIC) {
  const zapisz = db.prepare('UPDATE pozycje SET netto_linii = ?, cena_netto = ? WHERE id = ?');
  uzupelnijPozycje(db, zakres, {
    kolumna: 'netto_linii',
    zapisz: (linia, id) => zapisz.run(nettoLinii(linia), cenaJednostkowaNetto(linia), id),
  });
}
export function uzupelnijZrodloPozycji(db, zakres = BEZ_GRANIC) {
  const zapisz = db.prepare('UPDATE pozycje SET zrodlo_id = ? WHERE id = ?');
  // Linia bez `id` (nietypowa odpowiedz sklepu) zostaje z NULL-em, zamiast dostac zgadniety
  // klucz: zapas z numeru porzadkowego jest wtedy uczciwszy niz falszywy identyfikator.
  uzupelnijPozycje(db, zakres, {
    kolumna: 'zrodlo_id',
    zapisz: (linia, id) => {
      const zrodloId = Number(linia?.id);
      if (Number.isInteger(zrodloId) && zrodloId > 0) zapisz.run(zrodloId, id);
    },
  });
}
/** Frozen neutralna naprawa pieniędzy: stara metoda nie może zgubić pobrania COD. */
export function rozdzielPobranie(db) {
  db.prepare(
    "UPDATE zamowienia SET metoda_wysylki = 'dpd', pobranie = 1 WHERE metoda_wysylki = 'dpd_pobranie'",
  ).run();
  const zNadpisaniem = db.prepare(
    "SELECT id, wysylka_reczna_json FROM zamowienia WHERE wysylka_reczna_json LIKE '%dpd_pobranie%'",
  ).all();
  const zapisz = db.prepare('UPDATE zamowienia SET wysylka_reczna_json = ? WHERE id = ?');
  for (const w of zNadpisaniem) {
    let o = null;
    // Wadliwy JSON nie może zatrzymać startupu ani zmienić pozostałych danych zamówienia.
    try { o = JSON.parse(w.wysylka_reczna_json); } catch { continue; }
    if (!o || typeof o !== 'object' || o.metoda !== 'dpd_pobranie') continue;
    zapisz.run(JSON.stringify({ ...o, metoda: 'dpd', pobranie: 1 }), w.id);
  }
}

// Kolejnosc jak dotad. `zakres: true` = krok czyta `surowe_json` i podlega granicy „sprawdzone raz";
// pozostale (czysty SQL na stanie, ktory zmienia sie takze recznie: paczki, wplaty, NIP) chodza
// jak dotad za kazdym razem.
const KROKI = [
  { nazwa: 'rozdzielPobranie', fn: rozdzielPobranie },
  { nazwa: 'uzupelnijKosztDostawy', fn: uzupelnijKosztDostawy, zakres: true },
  { nazwa: 'uzupelnijKosztDostawyNetto', fn: uzupelnijKosztDostawyNetto, zakres: true },
  { nazwa: 'uzupelnijBruttoLinii', fn: uzupelnijBruttoLinii, zakres: true },
  { nazwa: 'uzupelnijNettoLinii', fn: uzupelnijNettoLinii, zakres: true },
  { nazwa: 'uzupelnijZrodloPozycji', fn: uzupelnijZrodloPozycji, zakres: true },
  { nazwa: 'uzupelnijChecFaktury', fn: uzupelnijChecFaktury },
  { nazwa: 'uzupelnijUwagi', fn: uzupelnijUwagi, zakres: true },
  { nazwa: 'uzupelnijWyslaneAt', fn: uzupelnijWyslaneAt },
  { nazwa: 'uzupelnijMetodePlatnosci', fn: uzupelnijMetodePlatnosci, zakres: true },
  { nazwa: 'uzupelnijProduktIdPozycji', fn: uzupelnijProduktIdPozycji, zakres: true },
  { nazwa: 'uzupelnijOfertaIdPozycji', fn: uzupelnijOfertaIdPozycji, zakres: true },
  { nazwa: 'uzupelnijPunktOdbioru', fn: uzupelnijPunktOdbioru, zakres: true },
  { nazwa: 'uzupelnijIndywidualne', fn: uzupelnijIndywidualne, zakres: true },
  { nazwa: 'uzupelnijZrodloNumeru', fn: uzupelnijZrodloNumeru },
  { nazwa: 'uzupelnijKupony', fn: uzupelnijKupony, zakres: true },
  { nazwa: 'uzupelnijAtrybucje', fn: uzupelnijAtrybucje, zakres: true },
  { nazwa: 'przeniesWplatyDoListy', fn: przeniesWplatyDoListy },
];

/** Wersja granicy: numer logiki + skrot z nazw krokow podlegajacych granicy. */
export function wersjaUzupelnien() {
  const skrot = createHash('sha1')
    .update(KROKI.filter((k) => k.zakres).map((k) => k.nazwa).join(','))
    .digest('hex').slice(0, 8);
  return `v${WERSJA_LOGIKI}-${skrot}`;
}

function odczytajGranice(db, wersja) {
  const prefiks = `${PREFIKS_ZNACZNIKA}${wersja}:do-id:`;
  const w = db.prepare('SELECT nazwa FROM migracje_jednorazowe WHERE substr(nazwa, 1, ?) = ?')
    .get(prefiks.length, prefiks);
  if (!w) return null;
  const n = Number(w.nazwa.slice(prefiks.length));
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}

function zapiszGranice(db, wersja, doId, teraz) {
  wTransakcji(db, () => {
    db.prepare('DELETE FROM migracje_jednorazowe WHERE substr(nazwa, 1, ?) = ?')
      .run(PREFIKS_ZNACZNIKA.length, PREFIKS_ZNACZNIKA);
    db.prepare('INSERT INTO migracje_jednorazowe (nazwa, wykonana_at) VALUES (?, ?)')
      .run(`${PREFIKS_ZNACZNIKA}${wersja}:do-id:${doId}`, teraz.toISOString());
  });
}

/**
 * Uzupelnia dane zamowien. Zamowienia o id nizszym lub rownym zapisanej granicy pomija (sprawdzone
 * przy poprzednim starcie); po udanym przebiegu przesuwa granice na najwyzsze id. Zwraca statystyki
 * przebiegu; `log(linia)` dostaje jedna linie z liczba zamowien do sprawdzenia i czasem.
 * @param {*} db
 * @param {{ teraz?: () => Date, log?: ((linia: string) => void) | null }} [opcje]
 */
export function uzupelnijDaneZamowien(db, { teraz = () => new Date(), log = null } = {}) {
  const start = performance.now();
  const wersja = wersjaUzupelnien();
  const koniec = Number(db.prepare('SELECT MAX(id) AS m FROM zamowienia').get()?.m ?? 0);
  const seq = Number(db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'zamowienia'").get()?.seq ?? 0);
  const zapisana = odczytajGranice(db, wersja);
  // Granica wyzsza niz kiedykolwiek nadane id = znacznik z innej bazy (podmieniona kopia): nie ufamy.
  const wazna = zapisana !== null && zapisana <= seq;
  const od = wazna ? zapisana : 0;
  const licznik = { wiersze: 0 };
  const zakres = { od, do: koniec, licznik };
  const doSprawdzenia = koniec > od
    ? Number(db.prepare('SELECT COUNT(*) AS c FROM zamowienia WHERE id > ? AND id <= ?').get(od, koniec).c)
    : 0;
  for (const krok of KROKI) {
    if (krok.zakres) krok.fn(db, zakres);
    else krok.fn(db);
  }
  const nowaGranica = wazna ? Math.max(od, koniec) : koniec;
  if (!wazna || nowaGranica !== zapisana) zapiszGranice(db, wersja, nowaGranica, teraz());
  const ms = Math.round(performance.now() - start);
  if (log) {
    log(`uzupełnienia danych zamówień: ${doSprawdzenia} do sprawdzenia, ${ms} ms`
      + (licznik.wiersze ? ` (odczytano surowe_json: ${licznik.wiersze} wierszy)` : ''));
  }
  return { doSprawdzenia, odczytane: licznik.wiersze, od, do: koniec, ms };
}
