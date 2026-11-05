// PRZ-152.G10a — warstwa bazy dla kolejki wydruku PROFORM (tabela `kolejka_druku_proform`, migracja
// rdzen/0009). Lustro `kolejka-druku-faktur.js`: ten sam czuwacz (deploy/drukarka/czuwacz-faktur.ps1),
// ta sama lista `GET /kolejka-druku-faktur`, to samo zajmowanie pozycji przez stanowisko i ta sama reguła
// odroczenia po błędzie. Różnice:
// - id pozycji w odpowiedzi dla czuwacza to napis „p<n>” (domena/druk-proformy.js) — osobna tabela ma
//   własny licznik, więc bez przedrostka pozycja proformy myliłaby się z pozycją faktury o tym samym id;
// - PDF to zapisany plik proformy (services/proforma.js `pdf`), nie dokument pobierany na świeżo;
// - proforma unieważniona po dodaniu do kolejki nie trafia do czuwacza i dostaje stan `porzucone`.
//
// ⚠️ REGULA ODRACZANIA JEST WSPOLNA (`odroczenieMs` z domena/kolejka-druku-stan.js) — powiela sie SQL,
// nigdy regula.
import { bladOperatora } from '../../../domena/bledy.js';
import { odroczenieMs } from '../../../domena/kolejka-druku-stan.js';
import { idPozycjiProformy } from '../../../domena/druk-proformy.js';
import { fakturyDoWziecia, PROG_ZAJECIA_MS } from './kolejka-druku-faktur.js';

const teraz = () => new Date().toISOString();

export const BLAD_UNIEWAZNIONEJ = 'proforma unieważniona przed wydrukiem';

const pobierzWiersz = (db, id) => db.prepare('SELECT * FROM kolejka_druku_proform WHERE id = ?').get(id);

function wymagajWiersza(db, id) {
  const w = pobierzWiersz(db, id);
  if (!w) throw bladOperatora('Nie ma takiej pozycji w kolejce druku proform.');
  return w;
}

/** Każde kliknięcie to NOWY wiersz — powtórny wydruk jest dozwolony, jak przy fakturze. */
export function dodajProformeDoKolejki(db, proformaId) {
  const wynik = db.prepare(
    "INSERT INTO kolejka_druku_proform (proforma_id, status, proby, utworzone_at) VALUES (?, 'oczekuje', 0, ?)",
  ).run(proformaId, teraz());
  return pobierzWiersz(db, Number(wynik.lastInsertRowid));
}

/**
 * Zajęcie i odczyt pozycji dla stanowiska — z `utworzone_at` do łączenia z listą faktur.
 *
 * Najpierw UPDATE zajęcia jednym warunkiem (dwa stanowiska nie zajmą tej samej pozycji), potem SELECT —
 * kolejność i powód jak w `fakturyDoWziecia`.
 *
 * ⚠️ `p.uniewazniona_at IS NULL` w SELECT-cie jest tym warunkiem, który trzyma unieważnioną proformę
 * z dala od drukarki (D4 planu G10). Porzucenie takich pozycji niżej to porządek dla karty (stan
 * „porzucone” z powodem), a nie zabezpieczenie.
 */
function zajmijProformy(db, { stanowisko = 'nieznane', terazIso = teraz(), prog = PROG_ZAJECIA_MS } = {}) {
  const sierota = new Date(new Date(terazIso).getTime() - prog).toISOString();
  db.prepare(`
    UPDATE kolejka_druku_proform SET zajete_przez = ?, zajete_at = ?
    WHERE status = 'oczekuje'
      AND (nastepna_proba_at IS NULL OR nastepna_proba_at <= ?)
      AND (zajete_przez IS NULL OR zajete_at IS NULL OR zajete_at < ?)
  `).run(stanowisko, terazIso, terazIso, sierota);

  const wiersze = db.prepare(`
    SELECT k.id AS id, p.numer AS numer, z.numer AS zamowienie, z.id AS zamowienieId, k.utworzone_at AS utworzoneAt
    FROM kolejka_druku_proform k
    JOIN proformy p ON p.id = k.proforma_id
    JOIN zamowienia z ON z.id = p.zamowienie_id
    WHERE k.status = 'oczekuje' AND k.zajete_przez = ? AND k.zajete_at = ?
      AND p.uniewazniona_at IS NULL
    ORDER BY k.utworzone_at ASC, k.id ASC
  `).all(stanowisko, terazIso);

  db.prepare(`
    UPDATE kolejka_druku_proform SET status = 'porzucone', ostatni_blad = ?, zajete_przez = NULL, zajete_at = NULL
    WHERE status = 'oczekuje'
      AND proforma_id IN (SELECT id FROM proformy WHERE uniewazniona_at IS NOT NULL)
  `).run(BLAD_UNIEWAZNIONEJ);

  return wiersze;
}

const doCzuwacza = (w) => ({ id: idPozycjiProformy(w.id), numer: w.numer, zamowienie: w.zamowienie, zamowienieId: w.zamowienieId });

/** Pozycje proform do wzięcia przez stanowisko, w kształcie kontraktu czuwacza (`id` = „p<n>”). */
export function proformyDoWziecia(db, opcje = {}) {
  return zajmijProformy(db, opcje).map(doCzuwacza);
}

/**
 * Odpowiedź `GET /kolejka-druku-faktur`: pozycje faktur (kształt i typ id BEZ ZMIAN) i proform razem,
 * posortowane po `utworzone_at` (przy remisie faktura przed proformą).
 */
export function pozycjeDrukuDoWziecia(db, { stanowisko = 'nieznane', terazIso = teraz(), prog = PROG_ZAJECIA_MS } = {}) {
  const faktury = fakturyDoWziecia(db, { stanowisko, terazIso, prog });
  const proformy = zajmijProformy(db, { stanowisko, terazIso, prog });
  if (!proformy.length) return faktury;
  const czasy = new Map(db.prepare(
    'SELECT id, utworzone_at FROM kolejka_druku_faktur WHERE id IN (SELECT value FROM json_each(?))',
  ).all(JSON.stringify(faktury.map((f) => f.id))).map((w) => [w.id, w.utworzone_at]));
  const razem = [
    ...faktury.map((poz) => ({ poz, kiedy: czasy.get(poz.id) ?? '' })),
    ...proformy.map((w) => ({ poz: doCzuwacza(w), kiedy: w.utworzoneAt })),
  ];
  return razem.sort((a, b) => (a.kiedy < b.kiedy ? -1 : a.kiedy > b.kiedy ? 1 : 0)).map((x) => x.poz);
}

/**
 * Proforma i zamówienie pozycji — do tras PDF i potwierdzenia. `null`, gdy pozycji nie ma.
 * `uniewaznionaAt` — trasy sprawdzają je jeszcze raz, bo proformę można unieważnić już PO zajęciu
 * pozycji przez czuwacza (drukuje po kolei, do 120 s na pozycję).
 */
export function proformaDlaPozycji(db, id) {
  return db.prepare(`
    SELECT k.proforma_id AS proformaId, p.zamowienie_id AS zamowienieId, p.numer AS numer,
      p.uniewazniona_at AS uniewaznionaAt
    FROM kolejka_druku_proform k JOIN proformy p ON p.id = k.proforma_id
    WHERE k.id = ?
  `).get(id) ?? null;
}

/**
 * Pozycja proformy unieważnionej po zajęciu — ten sam stan i powód co przy liście czuwacza.
 * Tylko pozycja oczekująca: wydrukowana (albo już porzucona) zostaje, jaka była.
 */
export function porzucUniewaznionaPozycje(db, id) {
  db.prepare(
    "UPDATE kolejka_druku_proform SET status = 'porzucone', ostatni_blad = ?, zajete_przez = NULL, zajete_at = NULL"
    + " WHERE id = ? AND status = 'oczekuje'",
  ).run(BLAD_UNIEWAZNIONEJ, id);
}

export const NOTATKA_PO_UNIEWAZNIENIU = 'wydrukowano po unieważnieniu';

/**
 * Potwierdzenie czuwacza zapisuje prawdę: kartka wyszła. PDF oddajemy tylko ważnej proformie, więc
 * unieważniona w tej chwili = unieważniona w trakcie druku (nowa proforma unieważnia poprzednią) —
 * wtedy notatka w `ostatni_blad`.
 */
export function oznaczProformeWydrukowana(db, id) {
  wymagajWiersza(db, id);
  db.prepare(`
    UPDATE kolejka_druku_proform SET status = 'wydrukowano', wydrukowane_at = ?,
      ostatni_blad = CASE WHEN (SELECT uniewazniona_at FROM proformy WHERE id = proforma_id) IS NOT NULL
        THEN ? ELSE ostatni_blad END
    WHERE id = ?
  `).run(teraz(), NOTATKA_PO_UNIEWAZNIENIU, id);
}

/**
 * Błąd nie zdejmuje pozycji; odsuwa kolejną próbę i od razu zwalnia zajęcie — jak przy fakturze.
 * Tylko pozycja oczekująca: czuwacz po 409 z PDF (unieważniona) woła /blad z tekstem wyjątku i nie może
 * nadpisać powodu porzucenia. Brak wiersza → błąd operatora (404) jak dotąd.
 */
export function oznaczBladDrukuProformy(db, id, powod) {
  const w = wymagajWiersza(db, id);
  const proby = w.proby + 1;
  const nastepna = new Date(Date.now() + odroczenieMs(proby)).toISOString();
  db.prepare(
    'UPDATE kolejka_druku_proform SET proby = ?, ostatni_blad = ?, nastepna_proba_at = ?,'
    + " zajete_przez = NULL, zajete_at = NULL WHERE id = ? AND status = 'oczekuje'",
  ).run(proby, powod, nastepna, id);
}

/** Decyzja człowieka — jedyne wyjście z „proforma ciągle się nie drukuje”. */
export function porzucProforme(db, id) {
  wymagajWiersza(db, id);
  db.prepare("UPDATE kolejka_druku_proform SET status = 'porzucone' WHERE id = ?").run(id);
}

/** Stan na karcie: liczy się tylko najnowszy wiersz. */
export function ostatniaPozycjaDlaProformy(db, proformaId) {
  return db.prepare('SELECT * FROM kolejka_druku_proform WHERE proforma_id = ? ORDER BY id DESC LIMIT 1')
    .get(proformaId) ?? null;
}

/** Najnowsza pozycja każdej z podanych proform — `Map<proformaId, wiersz>`; proformy bez pozycji pominięte. */
export function ostatniePozycjeDlaProform(db, proformaIds) {
  const mapa = new Map();
  if (!proformaIds?.length) return mapa;
  const wiersze = db.prepare(`
    SELECT * FROM kolejka_druku_proform WHERE id IN (
      SELECT MAX(id) FROM kolejka_druku_proform
      WHERE proforma_id IN (SELECT value FROM json_each(?)) GROUP BY proforma_id)
  `).all(JSON.stringify(proformaIds.map(Number)));
  for (const w of wiersze) mapa.set(w.proforma_id, w);
  return mapa;
}

export function createZapytania(db) {
  return {
    dodajProformeDoKolejki: (...args) => dodajProformeDoKolejki(db, ...args),
    proformyDoWziecia: (...args) => proformyDoWziecia(db, ...args),
    pozycjeDrukuDoWziecia: (...args) => pozycjeDrukuDoWziecia(db, ...args),
    proformaDlaPozycji: (...args) => proformaDlaPozycji(db, ...args),
    porzucUniewaznionaPozycje: (...args) => porzucUniewaznionaPozycje(db, ...args),
    oznaczProformeWydrukowana: (...args) => oznaczProformeWydrukowana(db, ...args),
    oznaczBladDrukuProformy: (...args) => oznaczBladDrukuProformy(db, ...args),
    porzucProforme: (...args) => porzucProforme(db, ...args),
    ostatniaPozycjaDlaProformy: (...args) => ostatniaPozycjaDlaProformy(db, ...args),
    ostatniePozycjeDlaProform: (...args) => ostatniePozycjeDlaProform(db, ...args),
  };
}
