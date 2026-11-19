// Zapytania ręcznych cen kart w kanałach, dziennika zmian wysłanych do kanałów, ochrony ceny karty przed
// importem oraz ceny i statusu publikacji w lustrze kanału. Tu tylko baza — reguła „jaka cena idzie do kanału” jest
// w domenie.
//
// Funkcje nie otwierają własnej transakcji: zapis ręcznej ceny idzie razem z wpisem dziennika i ochroną
// ceny karty, a odmowa jednego ma cofnąć całość u wołającego.
//
// Baza bez migracji tych tabel (stara instalacja, moduł magazynu wyłączony): odczyt daje „brak ręcznych
// cen”, czyli zachowanie sprzed sterowania cenami; zapis odmawia z nazwą brakującej tabeli, bo cichy
// brak zapisu wyglądałby jak sukces.

const maTabele = (db, tabela) =>
  db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(tabela) !== undefined;

function wymagajTabeli(db, tabela) {
  if (!maTabele(db, tabela)) throw new Error(`Brak tabeli ${tabela} — baza bez migracji cen i statusów kanałów`);
}

/** Ręczne ceny jednej karty: Map(konto → cena w groszach). */
export function cenyReczneKarty(db, kartaId) {
  if (!maTabele(db, 'ceny_kanalow_kart')) return new Map();
  const wiersze = db
    .prepare('SELECT kanal, cena_gr FROM ceny_kanalow_kart WHERE karta_id = ? ORDER BY kanal')
    .all(kartaId);
  return new Map(wiersze.map((w) => [w.kanal, w.cena_gr]));
}

/** Ręczne ceny wielu kart: Map(karta → Map(konto → cena)); karta bez ręcznej ceny nie ma klucza. */
export function cenyReczneKart(db, kartyId) {
  const wynik = new Map();
  if (kartyId.length === 0 || !maTabele(db, 'ceny_kanalow_kart')) return wynik;
  // Lista kart jako jeden parametr JSON: setki kart bez limitu parametrów SQLite i bez pętli zapytań.
  const wiersze = db
    .prepare(
      `SELECT karta_id, kanal, cena_gr FROM ceny_kanalow_kart
       WHERE karta_id IN (SELECT value FROM json_each(?)) ORDER BY karta_id, kanal`,
    )
    .all(JSON.stringify(kartyId));
  for (const w of wiersze) {
    if (!wynik.has(w.karta_id)) wynik.set(w.karta_id, new Map());
    wynik.get(w.karta_id).set(w.kanal, w.cena_gr);
  }
  return wynik;
}

/** Ustawia albo zastępuje ręczną cenę karty w jednym koncie. */
export function ustawCeneReczna(db, { kartaId, kanal, cenaGr, kto, at }) {
  // Sprawdzenie przed bazą: CHECK przyjąłby tekst '105' jako liczbę (afinita kolumny), a komunikat
  // „CHECK constraint failed” nic nie mówi osobie, która wpisała cenę.
  if (!Number.isInteger(cenaGr) || cenaGr <= 0) throw new Error('Ręczna cena musi być dodatnią liczbą groszy');
  if (typeof kanal !== 'string' || kanal.trim() === '') throw new Error('Ręczna cena bez konta kanału');
  wymagajTabeli(db, 'ceny_kanalow_kart');
  db.prepare(
    `INSERT INTO ceny_kanalow_kart (karta_id, kanal, cena_gr, kto, zmieniono_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (karta_id, kanal) DO UPDATE SET
       cena_gr = excluded.cena_gr, kto = excluded.kto, zmieniono_at = excluded.zmieniono_at`,
  ).run(kartaId, kanal, cenaGr, kto, at);
}

/** Usuwa ręczną cenę („wróć do narzutu konta”); zwraca liczbę usuniętych wierszy (0 albo 1). */
export function usunCeneReczna(db, { kartaId, kanal }) {
  wymagajTabeli(db, 'ceny_kanalow_kart');
  return Number(
    db.prepare('DELETE FROM ceny_kanalow_kart WHERE karta_id = ? AND kanal = ?').run(kartaId, kanal).changes,
  );
}

const naTekst = (v) => (v === undefined || v === null ? null : String(v));

/** Wpis dziennika zmian w kanałach; zwraca id wpisu (wpis `w_toku` uzupełnia się potem po id). */
export function zapiszZmianeWKanale(
  db,
  { kanal, kartaId = null, cel, pole, stara = null, nowa = null, kto, at, wynik, blad = null },
) {
  wymagajTabeli(db, 'zmiany_w_kanalach');
  const r = db
    .prepare(
      `INSERT INTO zmiany_w_kanalach (kanal, karta_id, cel, pole, stara, nowa, kto, at, wynik, blad)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(kanal, kartaId, cel, pole, naTekst(stara), naTekst(nowa), kto, at, wynik, blad);
  return Number(r.lastInsertRowid);
}

/**
 * Gdy cenę karty prowadzi OMS, import z kanału nie może jej nadpisać: pole `cena_gr` dostaje źródło `oms`
 * z `reczne = 1` (ten znacznik czyta reguła importu). Wartość ceny karty się nie zmienia. Ręcznie
 * wpisanej ceny (już `reczne = 1`) nie przepisuje — jej źródło zostaje prawdziwe. Zwraca, czy coś zmieniła.
 */
export function chronCeneKarty(db, kartaId, at) {
  const r = db
    .prepare(
      `INSERT INTO karty_zrodla_pol (karta_id, pole, zrodlo, reczne, zmieniono_at) VALUES (?, 'cena_gr', 'oms', 1, ?)
       ON CONFLICT (karta_id, pole) DO UPDATE SET zrodlo = 'oms', reczne = 1, zmieniono_at = excluded.zmieniono_at
       WHERE karty_zrodla_pol.reczne != 1`,
    )
    .run(kartaId, at);
  return Number(r.changes) > 0;
}

/** Status publikacji produktu i wszystkich jego wariantów w lustrze jednego konta; zwraca liczbę wierszy. */
export function ustawStatusPublikacji(db, kanal, produktId, status) {
  return Number(
    db
      .prepare('UPDATE produkty_sklepowe SET status_publikacji = ? WHERE kanal = ? AND produkt_id = ?')
      .run(status, kanal, String(produktId)).changes,
  );
}

/** Cena odczytana dla jednej pozycji lustra. Produkt bez wariantów i oferta mają pusty identyfikator wariantu. */
export function ustawCeneWLustrze(db, kanal, produktId, wariantId, cenaGr) {
  db.prepare('UPDATE produkty_sklepowe SET cena_gr = ? WHERE kanal = ? AND produkt_id = ? AND wariant_id = ?').run(
    cenaGr,
    kanal,
    produktId,
    wariantId,
  );
}
