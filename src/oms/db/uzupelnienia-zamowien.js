import {
  kosztDostawyBrutto, bruttoLinii, kosztDostawyNetto, nettoLinii, cenaJednostkowaNetto,
  punktOdbioruZeSurowych,
} from '../../domena/mapowanie.js';
import { ofertaLinii } from '../../domena/allegro-mapowanie.js';
import { czyIndywidualneZeSurowych } from '../../domena/indywidualne.js';
import { kuponyZeSurowych } from '../../domena/kupony.js';
import { atrybucjaZeSurowych } from '../../domena/atrybucja.js';
export function uzupelnijZrodloNumeru(db) {
  db.prepare(
    "UPDATE przesylki SET zrodlo_numeru = 'allegro'"
    + " WHERE zrodlo_numeru IS NULL AND kurier = 'allegro' AND nadana_recznie = 1",
  ).run();
}
export function uzupelnijIndywidualne(db) {
  const braki = db.prepare(
    'SELECT id, surowe_json FROM zamowienia WHERE indywidualne IS NULL AND surowe_json IS NOT NULL',
  ).all();
  const zapisz = db.prepare('UPDATE zamowienia SET indywidualne = ? WHERE id = ?');
  // ⚠️ CALA PETLA W JEDNEJ TRANSAKCJI — i to NIE jest mikrooptymalizacja.
  //
  // To przeliczenie rozni sie od trzech starszych obok (paczkomaty, metoda platnosci,
  // zdjecia) jedna rzecza: tamte pisza RZADKO (`if (kod) zapisz.run(...)`), a to pisze
  // do KAZDEGO zamowienia — bo zero jest tu wynikiem tak samo dobrym jak jedynka.
  // W autocommicie kazdy `run()` to osobna transakcja WAL z wlasnym fsync, wiec koszt
  // rosnie kwadratowo. Zmierzone przy recenzji tej galezi, na ksztalcie produkcyjnym:
  //   1 000 zamowien — 4,6 s | 3 000 — 31,7 s | 6 000 — 140 s
  // a ta sama petla w jednej transakcji: 6 000 zamowien w 6,2 s (13x szybciej).
  //
  // To jest czas STARTU: `zbudujOms()` chodzi PRZED `app.listen`, wiec przez caly ten
  // czas panel jest nieosiagalny. Dzis w bazie jest 35 zamowien (0,2 s), ale sklep ma
  // ich blisko 9 000 i poller potrafi masowo dotknac archiwum — wiec „dzis szybko"
  // nie jest zadna gwarancja na pierwszy start po takim przebiegu.
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const w of braki) {
      let surowe = null;
      // Uszkodzony JSON pojedynczego zamowienia nie ma prawa zablokowac startu panelu.
      try { surowe = JSON.parse(w.surowe_json); } catch { continue; }
      if (!surowe || typeof surowe !== 'object') continue;
      zapisz.run(czyIndywidualneZeSurowych(surowe) ? 1 : 0, w.id);
    }
    db.exec('UPDATE zamowienia SET indywidualne = 0 WHERE indywidualne IS NULL AND surowe_json IS NULL');
    db.exec('COMMIT');
  } catch (e) {
    // Przerwane przeliczenie ma zostawic baze w stanie SPRZED niego, a nie w polowie:
    // wiersze bez wartosci zostaja z NULL-em, czyli „jeszcze nie policzone", i nastepny
    // start sprobuje ponownie. Polowicznie zapisany stan wygladalby jak policzony.
    db.exec('ROLLBACK');
    throw e;
  }
}
export function uzupelnijPunktOdbioru(db) {
  const braki = db.prepare(
    'SELECT id, surowe_json FROM zamowienia WHERE punkt_odbioru IS NULL AND surowe_json IS NOT NULL',
  ).all();
  const zapisz = db.prepare('UPDATE zamowienia SET punkt_odbioru = ?, punkt_odbioru_opis = ? WHERE id = ?');
  for (const w of braki) {
    let surowe = null;
    // Uszkodzony JSON pojedynczego zamowienia nie ma prawa zablokowac startu panelu.
    try { surowe = JSON.parse(w.surowe_json); } catch { continue; }
    if (!surowe || typeof surowe !== 'object') continue;
    const { kod, opis } = punktOdbioruZeSurowych(surowe);
    if (kod) zapisz.run(kod, opis, w.id);
  }
}
export function uzupelnijAtrybucje(db) {
  const braki = db.prepare(
    `SELECT id, surowe_json FROM zamowienia
     WHERE atrybucja_json IS NULL AND surowe_json LIKE '%_wc_order_attribution_%'`,
  ).all();
  const zapisz = db.prepare('UPDATE zamowienia SET atrybucja_json = ? WHERE id = ?');
  for (const w of braki) {
    let surowe = null;
    // Uszkodzony JSON pojedynczego zamowienia nie ma prawa zablokowac startu panelu.
    try { surowe = JSON.parse(w.surowe_json); } catch { continue; }
    if (!surowe || typeof surowe !== 'object') continue;
    const a = atrybucjaZeSurowych(surowe);
    if (a) zapisz.run(JSON.stringify(a), w.id);
  }
}
export function uzupelnijKupony(db) {
  const braki = db.prepare(
    `SELECT id, surowe_json FROM zamowienia
     WHERE kupony_json IS NULL AND surowe_json LIKE '%"coupon_lines":[{%'`,
  ).all();
  const zapisz = db.prepare('UPDATE zamowienia SET kupony_json = ? WHERE id = ?');
  for (const w of braki) {
    let surowe = null;
    // Uszkodzony JSON pojedynczego zamowienia nie ma prawa zablokowac startu panelu.
    try { surowe = JSON.parse(w.surowe_json); } catch { continue; }
    if (!surowe || typeof surowe !== 'object') continue;
    const kupony = kuponyZeSurowych(surowe);
    if (kupony.length) zapisz.run(JSON.stringify(kupony), w.id);
  }
}
export function uzupelnijProduktIdPozycji(db) {
  const braki = db.prepare(
    'SELECT DISTINCT z.id, z.surowe_json FROM zamowienia z JOIN pozycje p ON p.zamowienie_id = z.id'
    + " WHERE p.produkt_id IS NULL AND p.zrodlo = 'sklep' AND z.surowe_json IS NOT NULL",
  ).all();
  const wiersze = db.prepare("SELECT id FROM pozycje WHERE zamowienie_id = ? AND zrodlo = 'sklep' ORDER BY id");
  const zapisz = db.prepare('UPDATE pozycje SET produkt_id = ? WHERE id = ?');
  // ⚠️ JEDNA TRANSAKCJA na cala petle — uzasadnienie przy `uzupelnijIndywidualne` wyzej.
  // Tutaj jest go nawet WIECEJ: piszemy nie raz na zamowienie, tylko raz na POZYCJE,
  // czyli okolo trzy razy wiecej zapisow przy tej samej liczbie zamowien.
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const w of braki) {
      let surowe = null;
      // Uszkodzony JSON pojedynczego zamowienia nie ma prawa zablokowac startu panelu.
      try { surowe = JSON.parse(w.surowe_json); } catch { continue; }
      const linie = surowe?.line_items;
      if (!Array.isArray(linie)) continue;
      const nasze = wiersze.all(w.id);
      if (nasze.length !== linie.length) continue;
      nasze.forEach((p, i) => zapisz.run(produktLinii(linie[i]), p.id));
    }
    db.exec('COMMIT');
  } catch (e) {
    // Jak wyzej: przerwane przeliczenie ma zostawic NULL-e, czyli „jeszcze nie policzone".
    db.exec('ROLLBACK');
    throw e;
  }
}
export function uzupelnijOfertaIdPozycji(db) {
  const braki = db.prepare(
    'SELECT DISTINCT z.id, z.surowe_json FROM zamowienia z JOIN pozycje p ON p.zamowienie_id = z.id'
    + " WHERE p.oferta_id IS NULL AND p.zrodlo = 'sklep' AND z.surowe_json IS NOT NULL",
  ).all();
  const wiersze = db.prepare("SELECT id FROM pozycje WHERE zamowienie_id = ? AND zrodlo = 'sklep' ORDER BY id");
  const zapisz = db.prepare('UPDATE pozycje SET oferta_id = ? WHERE id = ?');
  // ⚠️ JEDNA TRANSAKCJA na cala petle — uzasadnienie przy `uzupelnijIndywidualne` wyzej.
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const w of braki) {
      let surowe = null;
      // Uszkodzony JSON pojedynczego zamowienia nie ma prawa zablokowac startu panelu.
      try { surowe = JSON.parse(w.surowe_json); } catch { continue; }
      const linie = surowe?.lineItems;
      if (!Array.isArray(linie)) continue;
      const nasze = wiersze.all(w.id);
      if (nasze.length !== linie.length) continue;
      nasze.forEach((p, i) => zapisz.run(ofertaLinii(linie[i]), p.id));
    }
    db.exec('COMMIT');
  } catch (e) {
    // Jak wyzej: przerwane przeliczenie ma zostawic NULL-e, czyli „jeszcze nie policzone".
    db.exec('ROLLBACK');
    throw e;
  }
}
export function produktLinii(linia) {
  const id = Number(linia?.product_id);
  return Number.isInteger(id) && id > 0 ? id : null;
}
export function uzupelnijMetodePlatnosci(db) {
  const braki = db.prepare(
    'SELECT id, surowe_json FROM zamowienia WHERE metoda_platnosci IS NULL AND surowe_json IS NOT NULL',
  ).all();
  const zapisz = db.prepare('UPDATE zamowienia SET metoda_platnosci = ? WHERE id = ?');
  for (const w of braki) {
    const metoda = metodaPlatnosciZeSurowych(w.surowe_json);
    if (metoda) zapisz.run(metoda, w.id);
  }
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
    const surowe = JSON.parse(surowyJson);
    return surowe?.payment_method_title || null;
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
export function uzupelnijKosztDostawy(db) {
  const braki = db.prepare(
    'SELECT id, surowe_json FROM zamowienia WHERE koszt_dostawy_brutto IS NULL AND surowe_json IS NOT NULL',
  ).all();
  const zapisz = db.prepare('UPDATE zamowienia SET koszt_dostawy_brutto = ? WHERE id = ?');
  for (const w of braki) {
    let surowe = null;
    // Uszkodzony JSON pojedynczego zamowienia nie ma prawa zablokowac startu panelu.
    try { surowe = JSON.parse(w.surowe_json); } catch { continue; }
    if (!surowe || typeof surowe !== 'object') continue;
    zapisz.run(kosztDostawyBrutto(surowe), w.id);
  }
}
export function uzupelnijUwagi(db) {
  const braki = db.prepare(
    'SELECT id, surowe_json FROM zamowienia WHERE uwagi IS NULL AND surowe_json IS NOT NULL',
  ).all();
  const zapisz = db.prepare('UPDATE zamowienia SET uwagi = ? WHERE id = ?');
  for (const w of braki) {
    let surowe = null;
    // Uszkodzony JSON pojedynczego zamowienia nie ma prawa zablokowac startu panelu.
    try { surowe = JSON.parse(w.surowe_json); } catch { continue; }
    if (!surowe || typeof surowe !== 'object') continue;
    if (surowe.customer_note) zapisz.run(surowe.customer_note, w.id);
  }
}
export function uzupelnijKosztDostawyNetto(db) {
  const braki = db.prepare(
    'SELECT id, surowe_json FROM zamowienia WHERE koszt_dostawy_netto IS NULL AND surowe_json IS NOT NULL',
  ).all();
  const zapisz = db.prepare('UPDATE zamowienia SET koszt_dostawy_netto = ? WHERE id = ?');
  for (const w of braki) {
    let surowe = null;
    // Uszkodzony JSON pojedynczego zamowienia nie ma prawa zablokowac startu panelu.
    try { surowe = JSON.parse(w.surowe_json); } catch { continue; }
    if (!surowe || typeof surowe !== 'object') continue;
    zapisz.run(kosztDostawyNetto(surowe), w.id);
  }
}
export function uzupelnijBruttoLinii(db) {
  const braki = db.prepare(
    'SELECT DISTINCT z.id, z.surowe_json FROM zamowienia z JOIN pozycje p ON p.zamowienie_id = z.id'
    + " WHERE p.brutto_linii IS NULL AND p.zrodlo = 'sklep' AND z.surowe_json IS NOT NULL",
  ).all();
  const wiersze = db.prepare("SELECT id FROM pozycje WHERE zamowienie_id = ? AND zrodlo = 'sklep' ORDER BY id");
  const zapisz = db.prepare('UPDATE pozycje SET brutto_linii = ? WHERE id = ?');
  for (const w of braki) {
    let surowe = null;
    // Uszkodzony JSON pojedynczego zamowienia nie ma prawa zablokowac startu panelu.
    try { surowe = JSON.parse(w.surowe_json); } catch { continue; }
    const linie = surowe?.line_items;
    if (!Array.isArray(linie)) continue;
    const nasze = wiersze.all(w.id);
    if (nasze.length !== linie.length) continue;
    nasze.forEach((p, i) => zapisz.run(bruttoLinii(linie[i]), p.id));
  }
}
export function uzupelnijNettoLinii(db) {
  const braki = db.prepare(
    'SELECT DISTINCT z.id, z.surowe_json FROM zamowienia z JOIN pozycje p ON p.zamowienie_id = z.id'
    + " WHERE p.netto_linii IS NULL AND p.zrodlo = 'sklep' AND z.surowe_json IS NOT NULL",
  ).all();
  const wiersze = db.prepare("SELECT id FROM pozycje WHERE zamowienie_id = ? AND zrodlo = 'sklep' ORDER BY id");
  const zapisz = db.prepare('UPDATE pozycje SET netto_linii = ?, cena_netto = ? WHERE id = ?');
  for (const w of braki) {
    let surowe = null;
    // Uszkodzony JSON pojedynczego zamowienia nie ma prawa zablokowac startu panelu.
    try { surowe = JSON.parse(w.surowe_json); } catch { continue; }
    const linie = surowe?.line_items;
    if (!Array.isArray(linie)) continue;
    const nasze = wiersze.all(w.id);
    if (nasze.length !== linie.length) continue;
    nasze.forEach((p, i) => zapisz.run(nettoLinii(linie[i]), cenaJednostkowaNetto(linie[i]), p.id));
  }
}
export function uzupelnijZrodloPozycji(db) {
  const braki = db.prepare(
    'SELECT DISTINCT z.id, z.surowe_json FROM zamowienia z JOIN pozycje p ON p.zamowienie_id = z.id'
    + " WHERE p.zrodlo_id IS NULL AND p.zrodlo = 'sklep' AND z.surowe_json IS NOT NULL",
  ).all();
  const wiersze = db.prepare("SELECT id FROM pozycje WHERE zamowienie_id = ? AND zrodlo = 'sklep' ORDER BY id");
  const zapisz = db.prepare('UPDATE pozycje SET zrodlo_id = ? WHERE id = ?');
  for (const w of braki) {
    let surowe = null;
    // Uszkodzony JSON pojedynczego zamowienia nie ma prawa zablokowac startu panelu.
    try { surowe = JSON.parse(w.surowe_json); } catch { continue; }
    const linie = surowe?.line_items;
    if (!Array.isArray(linie)) continue;
    const nasze = wiersze.all(w.id);
    if (nasze.length !== linie.length) continue;
    // Linia bez `id` (nietypowa odpowiedz sklepu) zostaje z NULL-em, zamiast dostac zgadniety
    // klucz: zapas z numeru porzadkowego jest wtedy uczciwszy niz falszywy identyfikator.
    nasze.forEach((p, i) => {
      const zrodloId = Number(linie[i]?.id);
      if (Number.isInteger(zrodloId) && zrodloId > 0) zapisz.run(zrodloId, p.id);
    });
  }
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
export function uzupelnijDaneZamowien(db){
  rozdzielPobranie(db);
  uzupelnijKosztDostawy(db);
  uzupelnijKosztDostawyNetto(db);
  uzupelnijBruttoLinii(db);
  uzupelnijNettoLinii(db);
  uzupelnijZrodloPozycji(db);
  uzupelnijChecFaktury(db);
  uzupelnijUwagi(db);
  uzupelnijWyslaneAt(db);
  uzupelnijMetodePlatnosci(db);
  uzupelnijProduktIdPozycji(db);
  uzupelnijOfertaIdPozycji(db);
  uzupelnijPunktOdbioru(db);
  uzupelnijIndywidualne(db);
  uzupelnijZrodloNumeru(db);
  uzupelnijKupony(db);
  uzupelnijAtrybucje(db);
  przeniesWplatyDoListy(db);
}
