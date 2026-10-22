// PRZ-108.08 (zmiana C1 planu automatyzacji, sekcja 2): zdarzenie „Paczka nadana — ma numer listu”.
//
// Fakt: wiersz `przesylki` ze `status = 'nadana'` i numerem listu — ta sama reguła co mail „Zamówienie wysłane”
// (`paczkiDoMaila`: bez 'blad' i 'do_wyjasnienia'). Zapisują go `zakonczPrzesylke` (nadanie z panelu i hurtem),
// `zarejestrujPrzesylkeReczna` (numer wpisany ręcznie, import z Allegro) i `domknijPrzesylke` („do wyjaśnienia” → nadana).
//
// Granica: id paczki większe niż migawka `granica.przesylki` z chwili włączenia (data nie — `utworzona_at` paczki
// „do wyjaśnienia” domkniętej później jest stara). Tabela `przesylki` nie ma znacznika chwili przejścia w 'nadana',
// więc kursor czasu tu nie pomaga; zamiast niego detektor pomija paczki, dla których reguła ma już wykonanie tego
// zamówienia (dowolne poza pominiętym — ono wraca tylko przy NOWSZEJ paczce). Koszt przebiegu rośnie więc z liczbą
// paczek od włączenia, nie z liczbą wykonań: indeks główny `przesylki` + UNIQUE (regula_id, przedmiot).
//
// `zdarzenie_at` = MAX(utworzona_at, od): paczka świeża ma swoją chwilę; paczka domknięta godzinę po utworzeniu
// dostaje chwilę przebiegu, który ją zobaczył (inaczej opóźnienie liczyłoby się od dawna i mail wyszedłby od razu
// albo wcale — 48 h od terminu). Jedno wykonanie na ZAMÓWIENIE (przedmiot `zamowienie:<id>`): druga paczka w oknie
// opóźnienia trafia do tego samego maila, bo `paczkiDoMaila` czyta stan w chwili wysyłki.
//
// Poprawka po recenzji 08 (usterka 4): okno czasu. Detektor czyta tylko paczki utworzone nie dawniej niż OKNO_PACZEK_DNI
// przed `od` (indeks `przesylki_utworzona_at`, migracja automatyzacje/0002) — koszt przebiegu nie rośnie z wiekiem
// reguły (po roku 45 000 paczek: 147 → patrz raport PRZ-108.08). Cena: paczka „do wyjaśnienia” domknięta ponad
// 14 dni po utworzeniu nie wyzwoli maila (brak maila, nigdy mail za dużo).
const znaki = (n) => Array.from({ length: n }, () => '?').join(',');
const ZYWA = "p.status = 'nadana' AND TRIM(COALESCE(p.numer_listu, '')) <> ''";
export const OKNO_PACZEK_DNI = 14;

/** SQL i argumenty kandydatów (eksport dla testu planu zapytania). */
export function sqlKandydatowPaczki({ granica, od, po = null, limit, kanaly = null, regula_id = null }) {
  const filtrKanalu = Array.isArray(kanaly) ? ` AND +z.sklep IN (${znaki(kanaly.length)})` : '';
  const bezWykonania = regula_id === null ? '' : ` AND NOT EXISTS (SELECT 1 FROM automatyzacje_wykonania w
    WHERE w.regula_id = ? AND w.przedmiot = 'zamowienie:' || p.zamowienie_id
      AND (w.stan <> 'pominiete' OR w.zdarzenie_at >= p.utworzona_at))`;
  const odKiedy = od ?? granica?.at ?? '';
  const oknoOd = new Date(Date.parse(odKiedy) - OKNO_PACZEK_DNI * 24 * 3600 * 1000).toISOString();
  // Kontrakt kandydatów: rosnąco po (zdarzenie_at, id), `id` = id paczki; przy `po` — ściśle po (at, id). `od` przy
  // kontynuacji jest tym samym `od` co w obciętym przebiegu (kursor złożony go przechowuje), więc MAX(…) daje te same
  // wartości i porządek się nie przesuwa.
  const chwila = 'MAX(p.utworzona_at, ?)';
  const filtrPo = po ? ` AND (${chwila} > ? OR (${chwila} = ? AND p.id > ?))` : '';
  return { sql: `SELECT p.id, p.zamowienie_id, z.sklep, p.id AS przesylka_id, ${chwila} AS zdarzenie_at
    FROM przesylki p JOIN zamowienia z ON z.id = p.zamowienie_id
    WHERE p.utworzona_at >= ? AND +p.id > ? AND ${ZYWA}${filtrKanalu}${bezWykonania}${filtrPo}
    ORDER BY zdarzenie_at, p.id LIMIT ?`,
  args: [odKiedy, oknoOd, Number(granica?.przesylki ?? 0), ...(Array.isArray(kanaly) ? kanaly : []),
    ...(regula_id === null ? [] : [regula_id]), ...(po ? [odKiedy, po.at, odKiedy, po.at, po.id] : []), limit ?? 1000] };
}

export const zdarzeniePaczkaNadana = Object.freeze({
  klucz: 'paczka_nadana',
  etykieta: 'Paczka nadana — ma numer listu',
  grupa: 'przesylka',
  opis: 'Nadanie z panelu, numer wpisany ręcznie albo pobrany z Allegro. Paczka „do wyjaśnienia” liczy się dopiero po domknięciu.',

  kandydaci(db, opcje) {
    const q = sqlKandydatowPaczki(opcje);
    return db.prepare(q.sql).all(...q.args);
  },

  /** Podgląd „30 dni”: paczki nadane od `od`, jedna (najnowsza) na zamówienie. */
  symulacja(db, od) {
    return db.prepare(`SELECT p.zamowienie_id, z.sklep, MAX(p.id) AS przesylka_id, MAX(p.utworzona_at) AS zdarzenie_at
      FROM przesylki p JOIN zamowienia z ON z.id = p.zamowienie_id
      WHERE p.utworzona_at >= ? AND ${ZYWA} GROUP BY p.zamowienie_id ORDER BY zdarzenie_at DESC`).all(od);
  },
});
