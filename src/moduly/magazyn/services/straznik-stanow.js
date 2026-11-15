// PRZ-160 E4.15 — strażnik stanów (D57). Co 30 s liczy odcisk zmian, które mogą zmienić cel ilości w kanałach,
// i przy zmianie woła `przyspiesz()` pętli ERLI, Allegro i Woo. Odstęp 60 s od startu poprzedniego przebiegu
// i „następny przebieg zaraz po bieżącym” pilnuje każda pętla w swoim `przyspiesz()`.
import { przelacznikStanow } from '../../../oms/db/stany-magazynowe.js';
import { STATUSY_WOO_BEZ_ROZCHODU } from '../../../domena/stany-magazynowe.js';

export const ODSTEP_STRAZNIKA_MS = 30_000;
/** Znacznik odcisku przy wyłączonych stanach — po włączeniu pierwszy przebieg zawsze widzi zmianę. */
const WYLACZONE = 'wylaczone';

const komunikat = e => (e instanceof Error ? e.message : String(e));

/** Waga tożsamości pozycji (produkt, wariant, oferta, SKU) — tania suma kontrolna bez skrótu w SQL. */
const WAGA_POZYCJI = `(1 + COALESCE(p.produkt_id, 0) % 1000003 + 3 * (CAST(COALESCE(p.wariant_id, '0') AS INTEGER) % 1000003)
  + 7 * (CAST(COALESCE(p.oferta_id, '0') AS INTEGER) % 1000003) + 11 * length(COALESCE(p.sku, '')))`;

/**
 * Jedno zapytanie. Zamówienia od granicy po indeksie `zamowienia_julianday_utworzenia` (to samo wyrażenie).
 * Bez `MAX(zmienione_at)` i bez `MAX(pozycje.id)` — poller przesuwa je przy każdym przebiegu, także bez zmiany (szum).
 * - poprawki pozycji: długość JSON i suma liczbowych liści ważona miejscem w drzewie (2 → 3 szt. przy tej samej długości);
 * - pozycje (sklepowe i ręczne, w tym „dodaj z magazynu”): suma ilości ważona tożsamością pozycji —
 *   ponowny zapis pollera tymi samymi danymi nie zmienia odcisku, zmiana ilości lub produktu zmienia;
 * - status Woo: tylko liczba zamówień w statusach bez rozchodu (inna zmiana statusu nie rusza stanu — bez szumu).
 * Pierwszy przebieg po restarcie (odcisk null) tylko zapamiętuje odcisk — zmiany sprzed restartu łapie zwykły zegar.
 */
export function odciskStanow(db, granica) {
  const w = db.prepare(`SELECT
      (SELECT MAX(id) FROM ruchy_magazynowe) AS ruch,
      (SELECT MAX(id) FROM magazyn_przelaczenia) AS przelaczenie,
      (SELECT MAX(id) FROM stany_zatwierdzenia) AS zatwierdzenie,
      (SELECT MAX(utworzono_at) FROM stany_otwarcia) AS otwarcie,
      (SELECT MAX(id) FROM zamowienia) AS zamowienie,
      SUM(COALESCE(z.anulowane, 0) + COALESCE(z.anulowane_recznie, 0)) AS anulowane,
      SUM(length(z.pozycje_reczne_json)) AS poprawki,
      SUM(CASE WHEN json_valid(z.pozycje_reczne_json) THEN (SELECT total(CAST(j.value AS REAL) * (j.id + 1))
        FROM json_tree(z.pozycje_reczne_json) j WHERE j.atom IS NOT NULL) END) AS poprawkiTresc,
      SUM(z.status_woo IN (SELECT value FROM json_each(?))) AS bezRozchodu,
      (SELECT total(p.ilosc * ${WAGA_POZYCJI})
        FROM zamowienia z2 JOIN pozycje p ON p.zamowienie_id = z2.id
        WHERE julianday(z2.utworzone_at) >= julianday(?)) AS pozycje
    FROM zamowienia z WHERE julianday(z.utworzone_at) >= julianday(?)`)
    .get(JSON.stringify(STATUSY_WOO_BEZ_ROZCHODU), granica, granica);
  return JSON.stringify(w);
}

/**
 * `petle`: { nazwa: { przyspiesz } }. Flaga „brudne” jest na pętlę: trzyma się, dopóki pętla nie przyjmie
 * przyspieszenia (wyjątek w jednej nie zatrzymuje pozostałych; ponowienie w następnym przebiegu strażnika).
 * Przyjęte przyspieszenie gwarantuje przebieg rozpoczęty po zmianie: pętla w trakcie robi następny zaraz po bieżącym.
 */
export function createStraznikStanow({ db, petle, log = () => {} }) {
  let odcisk = null;
  const brudne = new Set();

  function przebieg() {
    let przelacznik;
    try { przelacznik = przelacznikStanow(db); } catch (e) { log(`straznik-stanow: przełącznik: ${komunikat(e)}`); return; }
    // D14: stany wyłączone → bez zapytania o odcisk i bez przyspieszeń.
    if (!przelacznik.wlaczone) { odcisk = WYLACZONE; brudne.clear(); return; }
    let nowy;
    try { nowy = odciskStanow(db, przelacznik.granica); } catch (e) { log(`straznik-stanow: odcisk: ${komunikat(e)}`); return; }
    if (odcisk !== null && nowy !== odcisk) for (const nazwa of Object.keys(petle)) brudne.add(nazwa);
    odcisk = nowy;
    for (const nazwa of [...brudne]) {
      try {
        petle[nazwa].przyspiesz();
        brudne.delete(nazwa);
      } catch (e) { log(`straznik-stanow: ${nazwa}: ${komunikat(e)}`); }
    }
  }

  return { przebieg };
}
