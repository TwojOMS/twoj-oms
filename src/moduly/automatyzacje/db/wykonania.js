// PRZ-108.07 (zmiana B planu automatyzacji): dziennik wykonań reguł. Para (regula_id, przedmiot) jest UNIQUE w bazie
// (migracje/0001-reguly.ts), więc dwa zegary, restart ani podwójne wykrycie nie dają drugiego wiersza — a wiersz
// `wyslane` / `niepewne` / `blad` nigdy nie wraca do kolejki („najwyżej jeden mail z jednej reguły na zamówienie”).
import { dopiszLog } from '../../../oms/db/zamowienia.js';

/** Transakcja `BEGIN IMMEDIATE`, chyba że wołający już ją trzyma (wtedy praca w jego transakcji). */
export function wTransakcji(db, praca) {
  if (db.isTransaction) return praca();
  db.exec('BEGIN IMMEDIATE');
  try {
    const wynik = praca();
    db.exec('COMMIT');
    return wynik;
  } catch (e) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw e;
  }
}

/**
 * Zaplanowanie wykonania po wykryciu zdarzenia. Nowy wiersz → `nowe`. Istniejący wraca do kolejki WYŁĄCZNIE, gdy jest
 * `pominiete` i przyszło NOWSZE zdarzenie (`zdarzenie_at` większe niż zapisane) → `otwarte`. Każdy inny przypadek
 * (to samo zdarzenie w kolejnym przebiegu, wiersz wysłany / niepewny / błędny / zaplanowany) → `null`, bez zapisu.
 */
export function zaplanuj(db, { regula_id, przedmiot, zamowienie_id, przesylka_id = null, zdarzenie_at, termin_at, szablon = null, teraz }) {
  const bylo = db.prepare('SELECT 1 FROM automatyzacje_wykonania WHERE regula_id = ? AND przedmiot = ?').get(regula_id, przedmiot);
  const r = db.prepare(`INSERT INTO automatyzacje_wykonania
      (regula_id, przedmiot, zamowienie_id, przesylka_id, stan, zdarzenie_at, szablon, wykryte_at, termin_at)
    VALUES (?, ?, ?, ?, 'zaplanowane', ?, ?, ?, ?)
    ON CONFLICT (regula_id, przedmiot) DO UPDATE SET
      stan = 'zaplanowane', zdarzenie_at = excluded.zdarzenie_at, termin_at = excluded.termin_at,
      wykryte_at = excluded.wykryte_at, przesylka_id = excluded.przesylka_id, szablon = excluded.szablon,
      powod = NULL, powod_kod = NULL, adresat = NULL, proby = 0, nastepna_proba_at = NULL, zakonczone_at = NULL
    WHERE automatyzacje_wykonania.stan = 'pominiete' AND excluded.zdarzenie_at > automatyzacje_wykonania.zdarzenie_at`)
    .run(regula_id, przedmiot, zamowienie_id, przesylka_id, zdarzenie_at, szablon, teraz, termin_at);
  if (!r.changes) return null;
  return bylo ? 'otwarte' : 'nowe';
}

/**
 * Należne wykonania: zaplanowane, termin minął, ponowienie (jeśli było) też; najstarsze pierwsze. Recenzja 07, usterka 2:
 * okno nie może się zatkać jedną regułą — w SQL odpadają wiersze reguł wyłączonych, usuniętych i WSTRZYMANYCH, a z każdej
 * reguły wchodzi najwyżej tyle wierszy, ile zostało jej limitu godzinowego (paczka na regułę, `ROW_NUMBER` po regule).
 * Wiersze reguły wyłączonej przechodzą w „pominięte” przy wyłączeniu (db/reguly.js), więc tu nie giną.
 */
export function doWykonania(db, { teraz, godzineWczesniej, limit = 500 }) {
  return db.prepare(`WITH uzyte AS (
      SELECT regula_id, COUNT(*) AS n FROM automatyzacje_wykonania
      WHERE stan = 'w_toku' OR (stan IN ('wyslane', 'niepewne', 'blad') AND zakonczone_at > ?)
      GROUP BY regula_id
    ), kolejka AS (
      SELECT w.*, r.limit_na_godzine - COALESCE(u.n, 0) AS wolne,
        ROW_NUMBER() OVER (PARTITION BY w.regula_id ORDER BY w.termin_at, w.id) AS nr
      FROM automatyzacje_wykonania w
      JOIN automatyzacje_reguly r ON r.id = w.regula_id
      LEFT JOIN uzyte u ON u.regula_id = w.regula_id
      WHERE w.stan = 'zaplanowane' AND w.termin_at <= ? AND (w.nastepna_proba_at IS NULL OR w.nastepna_proba_at <= ?)
        AND r.wlaczona = 1 AND r.usunieta_at IS NULL AND r.wstrzymana_powod IS NULL
    )
    SELECT * FROM kolejka WHERE nr <= wolne ORDER BY termin_at, id LIMIT ?`)
    .all(godzineWczesniej, teraz, teraz, limit).map(({ wolne: _w, nr: _n, ...w }) => w);
}

/**
 * Rezerwacja przed akcją: `zaplanowane → w_toku` w `BEGIN IMMEDIATE`. Zmieniony dokładnie jeden wiersz = moja; zero =
 * ktoś (drugi przebieg, druga instancja) był pierwszy. Dopiero po rezerwacji wolno wołać akcję.
 */
export function zarezerwuj(db, id) {
  return wTransakcji(db, () => db.prepare(
    "UPDATE automatyzacje_wykonania SET stan = 'w_toku' WHERE id = ? AND stan = 'zaplanowane'").run(id).changes === 1);
}

const AKCJA_LOGU = { pominiete: 'automatyzacja.pominieta', blad: 'automatyzacja.blad', niepewne: 'automatyzacja.niepewna' };
const PRZEDROSTEK = { pominiete: 'pominięto', blad: 'błąd', niepewne: 'nie wiadomo, czy wyszło' };

/** Wpis w historii zamówienia: każde pominięcie, błąd i niepewność reguły jest widoczne na karcie zamówienia. */
export function wpisDoHistorii(db, { zamowienie_id, stan, nazwa, powod }) {
  if (!AKCJA_LOGU[stan]) return;
  dopiszLog(db, zamowienie_id, { akcja: AKCJA_LOGU[stan], wynik: `Automatyzacja „${nazwa}”: ${PRZEDROSTEK[stan]} — ${powod}` });
}

/**
 * Zakończenie wykonania (z wpisem w historii zamówienia przy pominięciu, błędzie i niepewności). Zmienia wiersz tylko
 * w stanie z `zeStanow` (domyślnie zaplanowane / w_toku) — wiersz pominięty w międzyczasie (np. wyłączenie reguły
 * w trakcie przebiegu) zostaje, jak był, i NIE dostaje drugiego wpisu (recenzja 07, usterka 9). Oddaje: czy zmienił.
 */
export function zakoncz(db, wykonanie, { stan, powod = null, powod_kod = null, adresat = null, proby, teraz, nazwa,
  zeStanow = ['zaplanowane', 'w_toku'] }) {
  return wTransakcji(db, () => {
    const zmienione = db.prepare(`UPDATE automatyzacje_wykonania SET stan = ?, powod = ?, powod_kod = ?, adresat = COALESCE(?, adresat),
      proby = COALESCE(?, proby), nastepna_proba_at = NULL, zakonczone_at = ?
      WHERE id = ? AND stan IN (${zeStanow.map(() => '?').join(',')})`)
      .run(stan, powod, powod_kod, adresat, proby ?? null, teraz, wykonanie.id, ...zeStanow).changes === 1;
    if (zmienione) wpisDoHistorii(db, { zamowienie_id: wykonanie.zamowienie_id, stan, nazwa, powod });
    return zmienione;
  });
}

/** Chwilowy błąd poczty przed przyjęciem listu: z powrotem do kolejki, próba + 1, następna za 15 min. */
export function ponow(db, wykonanie, { nastepna, powod }) {
  db.prepare(`UPDATE automatyzacje_wykonania SET stan = 'zaplanowane', proby = proby + 1, nastepna_proba_at = ?, powod = ?
    WHERE id = ? AND stan = 'w_toku'`).run(nastepna, powod, wykonanie.id);
}

/**
 * Start procesu: rezerwacja `w_toku` sprzed restartu znaczy „akcja mogła wyjść albo nie” → `niepewne`, bez ponowienia
 * (wzór: oznaczPrzerwanyPrzebieg automatu KSeF). Bez wiszących wykonań nic nie zapisuje.
 */
export function oznaczPrzerwane(db, teraz) {
  const wiszace = db.prepare(`SELECT w.id, w.zamowienie_id, r.nazwa FROM automatyzacje_wykonania w
    JOIN automatyzacje_reguly r ON r.id = w.regula_id WHERE w.stan = 'w_toku'`).all();
  if (!wiszace.length) return 0;
  const powod = 'OMS został uruchomiony ponownie w trakcie wysyłki. Nie ponawiamy — sprawdź, czy klient dostał wiadomość.';
  wTransakcji(db, () => {
    for (const w of wiszace) {
      db.prepare(`UPDATE automatyzacje_wykonania SET stan = 'niepewne', powod = ?, powod_kod = 'przerwane', zakonczone_at = ?
        WHERE id = ? AND stan = 'w_toku'`).run(powod, teraz, w.id);
      wpisDoHistorii(db, { zamowienie_id: w.zamowienie_id, stan: 'niepewne', nazwa: w.nazwa, powod });
    }
  });
  return wiszace.length;
}

/**
 * Ile akcji ruszyło w ostatniej godzinie (wysłane, niepewne, błędy i właśnie trwające) — reguły albo całego OMS-u.
 * Ponowienia po chwilowym błędzie poczty i pominięcia się nie liczą.
 */
export function licznikGodziny(db, { od, regula_id = null }) {
  const warunek = regula_id === null ? '' : ' AND regula_id = ?';
  const arg = regula_id === null ? [] : [regula_id];
  return db.prepare(`SELECT COUNT(*) AS n FROM automatyzacje_wykonania
    WHERE (stan = 'w_toku' OR (stan IN ('wyslane', 'niepewne', 'blad') AND zakonczone_at > ?))${warunek}`)
    .get(od, ...arg).n;
}
