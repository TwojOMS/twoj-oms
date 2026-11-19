// Zapytania słownika producentów (GPSR) i przypisań producentów do marek. Reguły pól — domena/producenci.js.
//
// Każda odmowa wraca jako komunikat, zanim baza rzuci CHECK, UNIQUE albo FOREIGN KEY: ekran ma pokazać
// człowiekowi, co poprawić, a nie wyjątek SQL. Ograniczenia bazy zostają drugą zaporą.
import { walidujProducenta } from '../../domena/producenci.js';

const teraz = () => new Date().toISOString();
const NIE_MA = 'Nie ma takiego producenta.';

/** Transakcja `BEGIN IMMEDIATE` (node:sqlite nie ma `db.transaction`), chyba że wołający już ją trzyma. */
function wTransakcji(db, praca) {
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

// Adres w polach obok złożonego `adres`. Starzy producenci mają w polach NULL — ekran pokazuje wtedy `adres`.
const KOLUMNY = 'id, nazwa, adres, ulica, kod_pocztowy, miasto, kraj, email, www, domyslny, utworzono_at, zmieniono_at';

const wiersz = (w) => (w ? { ...w, domyslny: w.domyslny === 1 } : null);

const markiProducenta = (db, id) =>
  db
    .prepare('SELECT marka FROM marki_producenci WHERE producent_id = ? ORDER BY marka COLLATE NOCASE, marka')
    .all(id)
    .map((r) => r.marka);

/** Producent po id albo `null`. */
export function producentPoId(db, id) {
  return wiersz(db.prepare(`SELECT ${KOLUMNY} FROM producenci WHERE id = ?`).get(Number(id)));
}

/** Wszyscy producenci alfabetycznie, każdy z listą przypisanych marek i liczbą kart tych marek. */
export function listaProducentow(db) {
  const karty = new Map(
    db
      .prepare(
        `SELECT mp.producent_id AS id, COUNT(k.id) AS ile
         FROM marki_producenci mp JOIN karty_produktow k ON k.marka = mp.marka
         GROUP BY mp.producent_id`,
      )
      .all()
      .map((r) => [r.id, r.ile]),
  );
  return db
    .prepare(
      `SELECT ${KOLUMNY} FROM producenci
       ORDER BY nazwa COLLATE NOCASE, nazwa, id`,
    )
    .all()
    .map((w) => ({ ...wiersz(w), marki: markiProducenta(db, w.id), karty: karty.get(w.id) ?? 0 }));
}

/** Dodaje producenta po walidacji: `{ ok: true, id }` albo `{ ok: false, bledy, wartosci }`. */
export function dodajProducenta(db, dane, { at = teraz() } = {}) {
  const w = walidujProducenta(dane);
  if (!w.ok) return { ok: false, bledy: w.bledy, wartosci: w.wartosci };
  const { nazwa, adres, ulica, kod, miasto, kraj, email, www } = w.wartosci;
  const r = db
    .prepare(
      `INSERT INTO producenci (nazwa, adres, ulica, kod_pocztowy, miasto, kraj, email, www, utworzono_at, zmieniono_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    )
    .get(nazwa, adres, ulica, kod, miasto, kraj, email, www, at, at);
  return { ok: true, id: Number(r.id) };
}

/** Zmienia dane producenta po walidacji: `{ ok: true }`, `{ ok: false, bledy, wartosci }` albo `{ blad }`. */
export function zmienProducenta(db, id, dane, { at = teraz() } = {}) {
  const w = walidujProducenta(dane);
  if (!w.ok) return { ok: false, bledy: w.bledy, wartosci: w.wartosci };
  const { nazwa, adres, ulica, kod, miasto, kraj, email, www } = w.wartosci;
  const zmiana = db
    .prepare(
      `UPDATE producenci SET nazwa = ?, adres = ?, ulica = ?, kod_pocztowy = ?, miasto = ?, kraj = ?, email = ?,
       www = ?, zmieniono_at = ? WHERE id = ?`,
    )
    .run(nazwa, adres, ulica, kod, miasto, kraj, email, www, at, Number(id));
  return zmiana.changes === 1 ? { ok: true } : { blad: NIE_MA };
}

/**
 * Usuwa producenta bez marek i niebędącego domyślnym: `{ ok: true }`; inaczej `{ blad, marki? }` z komunikatem,
 * co najpierw zrobić.
 */
export function usunProducenta(db, id) {
  return wTransakcji(db, () => {
    const p = producentPoId(db, id);
    if (!p) return { blad: NIE_MA };
    const marki = markiProducenta(db, p.id);
    if (marki.length) {
      const jedna = marki.length === 1;
      return {
        blad:
          `Nie można usunąć „${p.nazwa}” — jest producentem ${jedna ? 'marki' : 'marek'}: ${marki.join(', ')}. ` +
          `Najpierw przypisz ${jedna ? 'tej marce' : 'tym markom'} innego producenta.`,
        marki,
      };
    }
    if (p.domyslny) {
      return {
        blad: `Nie można usunąć „${p.nazwa}” — to producent domyślny. Najpierw wskaż innego albo zdejmij oznaczenie.`,
      };
    }
    db.prepare('DELETE FROM producenci WHERE id = ?').run(p.id);
    return { ok: true };
  });
}

/** Ustawia producenta domyślnego (`null` zdejmuje oznaczenie) w jednej transakcji: zdejmij stare, ustaw nowe. */
export function ustawDomyslnego(db, id, { at = teraz() } = {}) {
  return wTransakcji(db, () => {
    if (id != null && id !== '' && !producentPoId(db, id)) return { blad: NIE_MA };
    db.prepare('UPDATE producenci SET domyslny = 0, zmieniono_at = ? WHERE domyslny = 1').run(at);
    if (id != null && id !== '') {
      db.prepare('UPDATE producenci SET domyslny = 1, zmieniono_at = ? WHERE id = ?').run(at, Number(id));
    }
    return { ok: true };
  });
}

/**
 * Przypisuje producentów markom `[{ marka, producentId }]` w jednej transakcji; pusty `producentId` zdejmuje
 * przypisanie. Marka spoza słownika marek albo nieznany producent — `{ blad }` i nic się nie zapisuje.
 */
export function przypiszMarki(db, zmiany, { at = teraz() } = {}) {
  const wSlowniku = db.prepare('SELECT 1 FROM marki WHERE nazwa = ?');
  const zdejmij = db.prepare('DELETE FROM marki_producenci WHERE marka = ?');
  const ustaw = db.prepare(
    `INSERT INTO marki_producenci (marka, producent_id, zmieniono_at) VALUES (?, ?, ?)
     ON CONFLICT (marka) DO UPDATE SET producent_id = excluded.producent_id, zmieniono_at = excluded.zmieniono_at
     WHERE producent_id <> excluded.producent_id`,
  );
  const lista = Array.isArray(zmiany) ? zmiany : [];
  const pusty = (id) => id == null || id === '';
  // Najpierw cała kontrola, potem zapis — odmowa nie zostawia połowy zmian także w transakcji wołającego.
  return wTransakcji(db, () => {
    for (const { marka, producentId } of lista) {
      if (typeof marka !== 'string' || !wSlowniku.get(marka)) {
        return { blad: `Marki „${String(marka ?? '')}” nie ma w słowniku marek.` };
      }
      if (!pusty(producentId) && !producentPoId(db, producentId)) {
        return { blad: `${NIE_MA} Odśwież stronę i wybierz producenta z listy.` };
      }
    }
    for (const { marka, producentId } of lista) {
      if (pusty(producentId)) zdejmij.run(marka);
      else ustaw.run(marka, Number(producentId), at);
    }
    return { ok: true };
  });
}

/** Przypisania marek: `Map` marka → id producenta. */
export function przypisaniaMarek(db) {
  return new Map(
    db
      .prepare('SELECT marka, producent_id FROM marki_producenci ORDER BY marka')
      .all()
      .map((r) => [r.marka, r.producent_id]),
  );
}
