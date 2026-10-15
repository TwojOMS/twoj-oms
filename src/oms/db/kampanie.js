// Warstwa zapytan zakladki /kampania (2026-08-25, kampania WRZESIEN30).
//
// Tu mieszka WYLACZNIE odczyt konfiguracji kampanii i wybor zamowien z kuponami —
// cala arytmetyka (kafle, dni, agregaty) siedzi w domain/kampania.js, a status i kwoty
// zamowienia przychodza z pobierzZamowienie (zLinii), zeby zadna regula statusu nie
// miala tu drugiej kopii.

import { pobierzZamowienie } from './zamowienia.js';

// ——— LUSTRO DANYCH ZE ZRODEL ZEWNETRZNYCH (Etapy 1-2) ————————————————————————————
//
// ⚠️ `ON CONFLICT DO UPDATE`, nie `INSERT OR IGNORE`: statystyki dnia dojrzewaja jeszcze
// przez dobe po jego zakonczeniu (Meta domyka wydatki, GA4 dolicza sesje), wiec przebieg
// MA nadpisywac to, co juz jest. To odwrotnosc reguly przy kosztach z KSeF, gdzie wiersz
// jest niezmienny i `REPLACE` skasowalby nasza czesc wiersza.

export function zapiszMetaDzien(db, kod, w) {
  db.prepare(
    `INSERT INTO kampania_meta_dni (kod, dzien, wydatek, wyswietlenia, zasieg, klikniecia, klikniecia_linku, pobrane_at)
     VALUES (?,?,?,?,?,?,?,?)
     ON CONFLICT(kod, dzien) DO UPDATE SET
       wydatek = excluded.wydatek, wyswietlenia = excluded.wyswietlenia, zasieg = excluded.zasieg,
       klikniecia = excluded.klikniecia, klikniecia_linku = excluded.klikniecia_linku,
       pobrane_at = excluded.pobrane_at`,
  ).run(
    kod, w.dzien, w.wydatek, w.wyswietlenia ?? 0, w.zasieg ?? 0,
    w.klikniecia ?? 0, w.kliknieciaLinku ?? 0, new Date().toISOString(),
  );
}

export function zapiszGa4Dzien(db, kod, w) {
  db.prepare(
    `INSERT INTO kampania_ga4_dni (kod, dzien, sesje, uzytkownicy, sesje_meta, odslony_promo, pobrane_at)
     VALUES (?,?,?,?,?,?,?)
     ON CONFLICT(kod, dzien) DO UPDATE SET
       sesje = excluded.sesje, uzytkownicy = excluded.uzytkownicy, sesje_meta = excluded.sesje_meta,
       odslony_promo = excluded.odslony_promo, pobrane_at = excluded.pobrane_at`,
  ).run(kod, w.dzien, w.sesje ?? 0, w.uzytkownicy ?? 0, w.sesjeMeta ?? 0, w.odslonyPromo ?? 0, new Date().toISOString());
}

export const metaDni = (db, kod) =>
  db.prepare('SELECT * FROM kampania_meta_dni WHERE kod = ? ORDER BY dzien').all(kod);

export const ga4Dni = (db, kod) =>
  db.prepare('SELECT * FROM kampania_ga4_dni WHERE kod = ? ORDER BY dzien').all(kod);

/**
 * Stan zrodla — czytany przez ekran, zeby odroznic „reklama nic nie wydala" od „od trzech
 * dni nie udalo sie zapytac". Oba wygladaja w tabeli jak zera i znacza cos innego.
 */
export function zapiszStanZrodla(db, zrodlo, { blad = null } = {}) {
  const teraz = new Date().toISOString();
  db.prepare(
    `INSERT INTO kampania_zrodla (zrodlo, ostatnia_proba_at, ostatni_sukces_at, ostatni_blad)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(zrodlo) DO UPDATE SET
       ostatnia_proba_at = excluded.ostatnia_proba_at,
       -- ⚠️ COALESCE, nie nadpisanie: nieudana proba NIE MA PRAWA skasowac znacznika
       -- ostatniego udanego pobrania — to po nim ekran mowi, jak stare sa liczby.
       ostatni_sukces_at = COALESCE(excluded.ostatni_sukces_at, kampania_zrodla.ostatni_sukces_at),
       ostatni_blad = excluded.ostatni_blad`,
  ).run(zrodlo, teraz, blad ? null : teraz, blad);
}

export const stanyZrodel = (db) => {
  const wiersze = db.prepare('SELECT * FROM kampania_zrodla').all();
  return Object.fromEntries(wiersze.map((w) => [w.zrodlo, w]));
};

// Najnowsza na gorze — ekran pokazuje pierwsza z listy, ktorej okno obejmuje „dzis",
// a gdy zadne nie obejmuje, pierwsza z listy (ostatnia zakonczona). Wybor robi domena.
export function listaKampanii(db) {
  return db.prepare('SELECT * FROM kampanie ORDER BY od_dnia DESC, id DESC').all();
}

// Wszystkie zamowienia z JAKIMKOLWIEK kuponem, przez zLinii (pobierzZamowienie):
// status, anulowanie i kwoty licza sie dokladnie ta sama droga, co na karcie i liscie.
// Filtrowanie po KONKRETNYM kodzie robi domena na sparsowanej liscie kuponow — LIKE po
// kodzie w SQL mylilby sie na kodach bedacych przedrostkiem innych.
//
// N+1 jest tu SWIADOME: zbior to zamowienia z kuponami (dzis: 6), a pobierzZamowienie
// jest jedynym miejscem znajacym komplet regul odczytu. Gdyby zbior kiedys urosl do
// setek, właściwa droga to poszerzenie warstwy zLinii o odczyt partiami, nie druga
// kopia regul tutaj.
export function zamowieniaZKuponami(db) {
  const idy = db.prepare(
    'SELECT id FROM zamowienia WHERE kupony_json IS NOT NULL ORDER BY utworzone_at DESC',
  ).all();
  return idy.map(({ id }) => pobierzZamowienie(db, id));
}

// Zamowienia, ktorych atrybucja niesie JAKAKOLWIEK kampanie utm (sekcja „zamowienia
// z reklam"). LIKE filtruje tu wylacznie OBECNOSC niepustej kampanii — `atrybucja_json`
// to nasza wlasna serializacja (JSON.stringify w db/zamowienia.js), wiec klucz ma zawsze
// postac `"kampania":"..."` bez spacji; dokladne dopasowanie KODU robi domena na
// sparsowanym JSON (prefiksy wrzesien30/wrzesien305 — ta sama zasada, co przy kuponach).
// N+1 swiadome, jak wyzej: zbior to zamowienia z kampania w utm (dzis: zero).
export function zamowieniaZAtrybucjaKampanii(db) {
  const idy = db.prepare(
    `SELECT id FROM zamowienia WHERE atrybucja_json LIKE '%"kampania":"%' ORDER BY utworzone_at DESC`,
  ).all();
  return idy.map(({ id }) => pobierzZamowienie(db, id));
}
