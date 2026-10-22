// PRZ-108.08 (zmiana C1 planu automatyzacji, sekcja 2a): zdarzenie „Status zamówienia zmienił się na X”.
//
// Status widoczny na liście jest WYLICZANY z faktów (domena/status.js), bez historii zmian — więc zdarzenie czytamy
// ze znacznika czasu faktu, a nie z dziennika `log` (to tekst dla człowieka):
//  • X = Wysłane       → `zamowienia.wyslane_at`  (karta, zmiana masowa, API panelu, ręczna rejestracja paczki,
//                         przeniesienie na dołączone). Cofnięcie do „W realizacji” zeruje datę, ponowne ustawienie daje nową;
//  • X = W realizacji  → `zamowienia.w_realizacji_at` (zostaje po cofnięciu z „Wysłane” — znana luka (a), plan 2a);
//  • X = status własny → `zamowienia_status_wlasny.ustawione_at` (nadpisywane przy każdym ustawieniu).
// Nowe, Anulowane i Zwrot nie mają dziś znacznika chwili zmiany — jako ZDARZENIE niedostępne (zmiana D), jako WARUNEK
// („status jest …”) działają wszystkie, bo warunek czyta `wyliczStatus` w chwili wykonania.
//
// Granica = chwila włączenia reguły (`granica.at`): data faktu sprzed niej nie istnieje dla reguły. `od` (kursor − 5 min)
// nigdy nie jest sprzed granicy (domena/automatyzacje.js, odKursora). Kanał filtrujemy już w SQL — obce kanały nie
// zajmują limitu kandydatów; silnik i tak sprawdza go drugi raz (biała lista).
import { statusyWKolejnosci, maTabeleStatusow } from '../../../oms/db/statusy.js';

const WBUDOWANE = Object.freeze({ wyslane: 'wyslane_at', w_realizacji: 'w_realizacji_at' });
const NIEDOSTEPNE = Object.freeze(['nowe', 'zwrot', 'anulowane']);

const wlasne = (db) => statusyWKolejnosci(db).filter((s) => s.jak);
const znaki = (n) => Array.from({ length: n }, () => '?').join(',');

/** Zapytanie kandydatów dla statusu `klucz` albo `null`, gdy statusu nie ma (usunięty własny, nieznany klucz). */
function zapytanie(db, klucz) {
  if (Object.hasOwn(WBUDOWANE, klucz)) {
    const kolumna = WBUDOWANE[klucz];
    return { sql: `SELECT z.id, z.id AS zamowienie_id, z.sklep, z.${kolumna} AS zdarzenie_at FROM zamowienia z
      WHERE z.${kolumna} IS NOT NULL AND z.${kolumna} >= ?`, porzadek: `z.${kolumna}`, arg: [] };
  }
  if (!maTabeleStatusow(db) || !wlasne(db).some((s) => s.klucz === klucz)) return null;
  return { sql: `SELECT z.id, z.id AS zamowienie_id, z.sklep, s.ustawione_at AS zdarzenie_at FROM zamowienia z
    JOIN zamowienia_status_wlasny s ON s.zamowienie_id = z.id WHERE s.klucz = ? AND s.ustawione_at >= ?`,
  porzadek: 's.ustawione_at', arg: [klucz] };
}

/** SQL i argumenty kandydatów (eksport dla testu planu zapytania) albo `null`, gdy statusu nie ma. */
export function sqlKandydatow(db, klucz, od, { kanaly = null, limit = null, malejaco = false, po = null } = {}) {
  const q = zapytanie(db, klucz);
  if (!q) return null;
  // `+z.sklep`: jednoargumentowy plus wyłącza indeks (sklep, zrodlo_id) dla tego warunku — bez niego planista SQLite
  // wybierał indeks kanału i czytał wszystkie zamówienia sklepu (recenzja 08, usterka 4), zamiast zakresu po dacie
  // (indeksy z migracji automatyzacje/0002). Kanał i tak filtruje się na wąskim zakresie dat.
  const filtrKanalu = Array.isArray(kanaly) ? ` AND +z.sklep IN (${znaki(kanaly.length)})` : '';
  // Kontynuacja po obciętej liście: ŚCIŚLE po (zdarzenie_at, id) ostatniego kandydata (kontrakt w zdarzenia/index.js).
  const filtrPo = po ? ` AND (${q.porzadek} > ? OR (${q.porzadek} = ? AND z.id > ?))` : '';
  const ogranicz = limit === null ? '' : ' LIMIT ?';
  const kierunek = malejaco ? ' DESC' : '';
  return { sql: `${q.sql}${filtrKanalu}${filtrPo} ORDER BY ${q.porzadek}${kierunek}, z.id${kierunek}${ogranicz}`,
    args: [...q.arg, od, ...(Array.isArray(kanaly) ? kanaly : []), ...(po ? [po.at, po.at, po.id] : []),
      ...(limit === null ? [] : [limit])] };
}

function czytaj(db, klucz, od, opcje = {}) {
  const q = sqlKandydatow(db, klucz, od, opcje);
  return q ? db.prepare(q.sql).all(...q.args) : [];
}

export const zdarzenieStatusZmieniony = Object.freeze({
  klucz: 'status_zmieniony',
  etykieta: 'Status zamówienia zmienił się na…',
  grupa: 'zamowienie',
  opis: 'Status ustawiony na karcie, zmianą masową na liście albo przy ręcznej rejestracji paczki.',

  /**
   * Statusy do wyboru jako zdarzenie: Wysłane, W realizacji i własne (z Ustawień, czytane przy każdym żądaniu); Nowe,
   * Zwrot i Anulowane przygaszone („wkrótce”) — bez znacznika chwili zmiany.
   */
  opcjeParametru(db) {
    const etykiety = Object.fromEntries(statusyWKolejnosci(db).map((s) => [s.klucz, s.etykieta]));
    return [
      { klucz: 'w_realizacji', etykieta: etykiety.w_realizacji ?? 'W realizacji', dostepny: true },
      ...wlasne(db).map((s) => ({ klucz: s.klucz, etykieta: s.etykieta, wlasny: true, dostepny: true })),
      { klucz: 'wyslane', etykieta: etykiety.wyslane ?? 'Wysłane', dostepny: true },
      ...NIEDOSTEPNE.map((k) => ({ klucz: k, etykieta: etykiety[k] ?? k, dostepny: false })),
    ];
  },

  /** Jedno zdanie, gdy parametr reguły jest martwy (np. status własny usunięty z Ustawień), inaczej `null`. */
  bladParametru(db, parametr) {
    const klucz = parametr?.status;
    if (!klucz) return 'Reguła nie ma wybranego statusu.';
    return zapytanie(db, klucz) ? null : `Wybrany status („${klucz}”) nie istnieje w Ustawieniach → Statusy zamówień — reguła nic nie zrobi.`;
  },

  /** Kandydaci przebiegu: fakt statusu nie starszy niż `od` (a więc i granica), tylko z zaznaczonych kanałów. */
  kandydaci(db, { granica, od, po = null, parametr, limit, kanaly = null }) {
    const odKiedy = od && granica?.at && od > granica.at ? od : granica?.at ?? od;
    return czytaj(db, parametr?.status, odKiedy, { kanaly, limit, po });
  },

  /** Podgląd „30 dni”: ten sam odczyt bez granicy, najnowsze pierwsze (przykłady i podgląd maila na świeżym zamówieniu);
   *  kanał odsiewa silnik, żeby policzyć „z innych kanałów”. */
  symulacja(db, od, { parametr } = {}) {
    return czytaj(db, parametr?.status, od, { malejaco: true });
  },
});
