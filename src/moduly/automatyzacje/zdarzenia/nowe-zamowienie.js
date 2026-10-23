// PRZ-110.02 (D1): „Nowe zamówienie”. Fakt powstaje w `zapiszZamowienie` (poller Woo i Allegro)
// albo `utworzZamowienieReczne`. Granica to ID z migawki włączenia, nigdy data ze sklepu.
// Czas zdarzenia = MAX(utworzone_at, od), jak w „Paczka nadana”: spóźniony import ma nowe ID,
// ale starą datę zakupu. Dostaje początek okna wykrycia (kursor − 5 min), aby nie zginąć za kursorem.
// `zmienione_at` jest nadpisywane przy synchronizacji, więc nie mierzy przyjęcia zamówienia do OMS-u.
// Jedno zdarzenie na zamówienie: każde istniejące wykonanie (także pominięte) wyłącza je z detektora.
// SQLite normalizuje datę do ISO z milisekundami i Z (Woo ma też daty bez milisekund).
// Okno czasu używa istniejącego indeksu `zamowienia_julianday_utworzenia` (zamowienia/0001).
// Plus przy ID i kanale wyłącza wybór zakresu wszystkich ID od włączenia albo całego kanału.
// Dołączone pomija wspólny silnik (także w symulacji), ze śladem w dzienniku.
const CHWILA = "strftime('%Y-%m-%dT%H:%M:%fZ', z.utworzone_at)";
const znaki = (n) => Array.from({ length: n }, () => '?').join(',');
// PRZ-110.02 (odbiór): koszt przebiegu ma zależeć od ostatnich dni, nie wieku reguły. Importy
// starsze niż okno nie są wykrywane; w oknie próg 48 h pomija je z powodem w chwili wykonania.
export const OKNO_ZAMOWIEN_DNI = 14;

/** SQL i argumenty kandydatów (eksport dla testu planu zapytania). */
export function sqlKandydatowZamowienia({ granica, od, po = null, limit, kanaly = null, regula_id = null }) {
  const odKiedy = od ?? granica?.at ?? '';
  const oknoOd = new Date(Date.parse(odKiedy) - OKNO_ZAMOWIEN_DNI * 24 * 3600_000).toISOString();
  const chwila = `MAX(${CHWILA}, ?)`;
  const filtrKanalu = Array.isArray(kanaly) ? ` AND +z.sklep IN (${znaki(kanaly.length)})` : '';
  const bezWykonania = regula_id === null ? '' : ` AND NOT EXISTS (SELECT 1 FROM automatyzacje_wykonania w
    WHERE w.regula_id = ? AND w.przedmiot = 'zamowienie:' || z.id)`;
  const filtrPo = po ? ` AND (${chwila} > ? OR (${chwila} = ? AND z.id > ?))` : '';
  return { sql: `SELECT z.id, z.id AS zamowienie_id, z.sklep, ${chwila} AS zdarzenie_at
    FROM zamowienia z WHERE julianday(z.utworzone_at) >= julianday(?) AND +z.id > ?
      AND ${CHWILA} IS NOT NULL${filtrKanalu}${bezWykonania}${filtrPo}
    ORDER BY zdarzenie_at, z.id LIMIT ?`,
  args: [odKiedy, oknoOd, Number(granica?.zamowienia ?? 0), ...(Array.isArray(kanaly) ? kanaly : []),
    ...(regula_id === null ? [] : [regula_id]), ...(po ? [odKiedy, po.at, odKiedy, po.at, po.id] : []), limit ?? 1000] };
}

export const zdarzenieNoweZamowienie = Object.freeze({
  klucz: 'zamowienie_nowe',
  etykieta: 'Nowe zamówienie',
  grupa: 'zamowienie',
  opis: 'Zamówienie ze sklepu, Allegro albo dodane ręcznie. Zamówienia obecne w OMS-ie przed włączeniem reguły się nie liczą.',

  kandydaci(db, opcje) {
    const q = sqlKandydatowZamowienia(opcje);
    return db.prepare(q.sql).all(...q.args);
  },

  /** Podgląd „30 dni”: data złożenia, bez granicy, najnowsze najpierw. Zero zapisów. */
  symulacja(db, od) {
    return db.prepare(`SELECT z.id, z.id AS zamowienie_id, z.sklep, ${CHWILA} AS zdarzenie_at
      FROM zamowienia z WHERE ${CHWILA} >= ? ORDER BY zdarzenie_at DESC, z.id DESC`).all(od);
  },
});
