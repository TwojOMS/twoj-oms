// Zapytania parametrów własnych kart: definicje (`parametry_kart`) i wartości kart (`karty_parametry`).
// Reguły pól i wartości są w domenie (`domena/parametry-kart.js`) — tu tylko baza i spójność między tabelami.
//
// Każda odmowa wraca jako komunikat, zanim baza rzuci CHECK albo UNIQUE: ekran ma pokazać człowiekowi, co
// poprawić. Kody odmów (`kod`) pozwalają trasom wybrać status HTTP bez porównywania tekstu.
//
// API (Ustawienia, karta produktu, lista Magazynu i edycja hurtem budują na nim):
// - `listaParametrow(db)` → definicje w kolejności `[{ id, nazwa, typ, jednostka, wartosci: string[]|null,
//   wymagany: boolean, kolejnosc, karty, utworzono_at, zmieniono_at }]`; `karty` = liczba kart z wartością.
// - `parametrPoId(db, id)` → ten sam kształt albo `null`.
// - `dodajParametr(db, dane, { at })` → `{ ok, id }` | `{ blad, kod: 'NIEPOPRAWNE' }`; nowy staje na końcu.
// - `zmienParametr(db, id, dane, { at, kto })` → `{ ok, przepisane }` | `{ blad, kod }`, kody: `NIE_MA`,
//   `NIEPOPRAWNE`, `TYP_Z_WARTOSCIAMI` (+ `karty`), `WARTOSC_UZYWANA` (+ `karty`, `wartosc`). Zmiana nazwy
//   wartości listy (`wartosc_z` → `wartosc_na`) przepisuje karty w tej samej transakcji; `przepisane` = ile.
// - `przesunParametr(db, id, 'gora'|'dol')` → `{ ok }` | `{ blad, kod }`; na brzegu nic się nie dzieje.
// - `usunParametr(db, id)` → `{ ok, karty }` | `{ blad, kod: 'NIE_MA' }`; wartości kart znikają przez CASCADE.
// - `wartosciKarty(db, kartaId)` → `Map<parametrId, wartosc>`.
// - `wartosciKart(db, kartaIds)` → `Map<kartaId, Map<parametrId, wartosc>>`, każda poprawna karta z wejścia
//   ma wpis (pusta mapa = brak wartości).
// - `ustawWartoscKarty(db, kartaId, parametrId, surowa, { at, kto })` → `{ ok, wartosc, zmieniono }` |
//   `{ blad, kod }`; wartość przechodzi przez `normalizujWartosc`, puste pole kasuje wiersz.
// - `wyczyscWartoscKarty(db, kartaId, parametrId)` → `{ ok, zmieniono }` | `{ blad, kod: 'NIE_MA' }`.
// Funkcje zapisu wołane w transakcji wołającego (hurt) nie otwierają własnej.
import { normalizujWartosc, walidujDefinicje } from '../../domena/parametry-kart.js';

const teraz = () => new Date().toISOString();
const NIE_MA_PARAMETRU = { blad: 'Nie ma takiego parametru.', kod: 'NIE_MA' };
const NIE_MA_KARTY = { blad: 'Nie ma takiej karty.', kod: 'NIE_MA' };

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

/** Id z formularza albo adresu; cokolwiek innego niż dodatnia liczba całkowita to `null`. */
function idLiczba(id) {
  const n = Number(id);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

// „na 1 karcie”, „na 2 kartach”, „na 5 kartach” — miejscownik liczby mnogiej jest jeden.
const naKartach = (n) => (n === 1 ? 'na 1 karcie' : `na ${n} kartach`);

const POLA = `p.id, p.nazwa, p.typ, p.jednostka, p.wartosci_json, p.wymagany, p.kolejnosc, p.utworzono_at,
  p.zmieniono_at, (SELECT COUNT(*) FROM karty_parametry kp WHERE kp.parametr_id = p.id) AS karty`;

function definicja(w) {
  if (!w) return null;
  const { wartosci_json, ...reszta } = w;
  return {
    ...reszta,
    wartosci: wartosci_json === null ? null : JSON.parse(wartosci_json),
    wymagany: w.wymagany === 1,
    karty: Number(w.karty),
  };
}

/** Definicje w kolejności Ustawień, z wartościami listy i liczbą kart, które mają wartość. */
export function listaParametrow(db) {
  return db.prepare(`SELECT ${POLA} FROM parametry_kart p ORDER BY p.kolejnosc, p.id`).all().map(definicja);
}

/** Definicja po id albo `null`. */
export function parametrPoId(db, id) {
  const n = idLiczba(id);
  if (n === null) return null;
  return definicja(db.prepare(`SELECT ${POLA} FROM parametry_kart p WHERE p.id = ?`).get(n));
}

const nazwyPozostalych = (db, bezId = 0) =>
  db
    .prepare('SELECT nazwa FROM parametry_kart WHERE id != ?')
    .all(bezId)
    .map((w) => w.nazwa);

/** Nowa definicja na końcu kolejności. Zmiana nazwy wartości nie ma tu sensu (nikt jeszcze nie ma wartości). */
export function dodajParametr(db, dane, { at = teraz() } = {}) {
  return wTransakcji(db, () => {
    const v = walidujDefinicje(dane, { istniejaceNazwy: nazwyPozostalych(db), nowy: true });
    if (v.blad) return { blad: v.blad, kod: 'NIEPOPRAWNE' };
    const d = v.wartosc;
    const wiersz = db
      .prepare(
        `INSERT INTO parametry_kart (nazwa, typ, jednostka, wartosci_json, wymagany, kolejnosc, utworzono_at, zmieniono_at)
         VALUES (?, ?, ?, ?, ?, (SELECT COALESCE(MAX(kolejnosc), 0) + 1 FROM parametry_kart), ?, ?) RETURNING id`,
      )
      .get(d.nazwa, d.typ, d.jednostka, d.wartosci ? JSON.stringify(d.wartosci) : null, d.wymagany ? 1 : 0, at, at);
    return { ok: true, id: Number(wiersz.id) };
  });
}

/**
 * Zmiana definicji. Odmawia tego, co osierociłoby wartości kart: zmiany typu, gdy karty mają wartości,
 * i usunięcia z listy wartości, której karty używają. Zmiana nazwy wartości przepisuje karty razem z definicją —
 * nieudany zapis cofa jedno i drugie.
 */
export function zmienParametr(db, id, dane, { at = teraz(), kto = null } = {}) {
  return wTransakcji(db, () => {
    const stary = parametrPoId(db, id);
    if (!stary) return NIE_MA_PARAMETRU;
    const v = walidujDefinicje(dane, { istniejaceNazwy: nazwyPozostalych(db, stary.id) });
    if (v.blad) return { blad: v.blad, kod: 'NIEPOPRAWNE' };
    const d = v.wartosc;

    if (d.typ !== stary.typ && stary.karty > 0) {
      return {
        blad: `Parametr ma wartości ${naKartach(stary.karty)} — typu nie da się zmienić.`,
        kod: 'TYP_Z_WARTOSCIAMI',
        karty: stary.karty,
      };
    }

    const zmiana = d.zmianaWartosci;
    if (zmiana && !(stary.wartosci ?? []).includes(zmiana.z)) {
      return { blad: `Wartości „${zmiana.z}” nie ma na liście parametru „${stary.nazwa}”.`, kod: 'NIEPOPRAWNE' };
    }

    if (d.typ === 'lista') {
      const uzywane = db
        .prepare(
          `SELECT wartosc, COUNT(*) AS ile FROM karty_parametry WHERE parametr_id = ?
           GROUP BY wartosc ORDER BY ile DESC, wartosc`,
        )
        .all(stary.id);
      for (const { wartosc, ile } of uzywane) {
        if (wartosc === zmiana?.z || d.wartosci.includes(wartosc)) continue;
        const karty = Number(ile);
        return {
          blad: `Wartość „${wartosc}” jest ${naKartach(karty)} — zmień je najpierw.`,
          kod: 'WARTOSC_UZYWANA',
          karty,
          wartosc,
        };
      }
    }

    db.prepare(
      `UPDATE parametry_kart SET nazwa = ?, typ = ?, jednostka = ?, wartosci_json = ?, wymagany = ?, zmieniono_at = ?
       WHERE id = ?`,
    ).run(
      d.nazwa,
      d.typ,
      d.jednostka,
      d.wartosci ? JSON.stringify(d.wartosci) : null,
      d.wymagany ? 1 : 0,
      at,
      stary.id,
    );

    let przepisane = 0;
    if (zmiana) {
      przepisane = Number(
        db
          .prepare(
            `UPDATE karty_parametry SET wartosc = ?, zmieniono_at = ?, kto = ? WHERE parametr_id = ? AND wartosc = ?`,
          )
          .run(zmiana.na, at, kto, stary.id, zmiana.z).changes,
      );
    }
    return { ok: true, przepisane };
  });
}

/** Zamienia parametr z sąsiadem i numeruje kolejność od 1 (dziury po usuniętych znikają przy okazji). */
export function przesunParametr(db, id, kierunek) {
  if (kierunek !== 'gora' && kierunek !== 'dol') return { blad: 'Nieznany kierunek przesunięcia.', kod: 'NIEPOPRAWNE' };
  return wTransakcji(db, () => {
    const ids = db
      .prepare('SELECT id FROM parametry_kart ORDER BY kolejnosc, id')
      .all()
      .map((w) => Number(w.id));
    const i = ids.indexOf(idLiczba(id));
    if (i < 0) return NIE_MA_PARAMETRU;
    const j = kierunek === 'gora' ? i - 1 : i + 1;
    if (j < 0 || j >= ids.length) return { ok: true };
    [ids[i], ids[j]] = [ids[j], ids[i]];
    const ustaw = db.prepare('UPDATE parametry_kart SET kolejnosc = ? WHERE id = ?');
    ids.forEach((pid, k) => ustaw.run(k + 1, pid));
    return { ok: true };
  });
}

/** Usuwa definicję; wartości kart zabiera ON DELETE CASCADE (baza włącza klucze obce przy otwarciu). */
export function usunParametr(db, id) {
  return wTransakcji(db, () => {
    const p = parametrPoId(db, id);
    if (!p) return NIE_MA_PARAMETRU;
    db.prepare('DELETE FROM parametry_kart WHERE id = ?').run(p.id);
    return { ok: true, karty: p.karty };
  });
}

/** Wartości jednej karty: `Map<parametrId, wartosc>` w kolejności parametrów. */
export function wartosciKarty(db, kartaId) {
  return wartosciKart(db, [kartaId]).get(idLiczba(kartaId)) ?? new Map();
}

/**
 * Wartości wielu kart jednym zapytaniem (lista Magazynu, hurt). Id idą jako jedna tablica JSON, więc liczba kart
 * nie zderza się z limitem parametrów zapytania SQLite.
 */
export function wartosciKart(db, kartaIds) {
  const wynik = new Map();
  for (const id of kartaIds ?? []) {
    const n = idLiczba(id);
    if (n !== null && !wynik.has(n)) wynik.set(n, new Map());
  }
  if (!wynik.size) return wynik;
  const wiersze = db
    .prepare(
      `SELECT kp.karta_id, kp.parametr_id, kp.wartosc
       FROM karty_parametry kp JOIN parametry_kart p ON p.id = kp.parametr_id
       WHERE kp.karta_id IN (SELECT value FROM json_each(?))
       ORDER BY p.kolejnosc, p.id`,
    )
    .all(JSON.stringify([...wynik.keys()]));
  for (const w of wiersze) wynik.get(Number(w.karta_id)).set(Number(w.parametr_id), w.wartosc);
  return wynik;
}

const kartaIstnieje = (db, id) => id !== null && !!db.prepare('SELECT 1 FROM karty_produktow WHERE id = ?').get(id);

/**
 * Ustawia wartość parametru na karcie po walidacji domeny. Puste pole kasuje wiersz. Ta sama wartość nie rusza
 * `zmieniono_at` ani `kto` — hurt zapisujący wiele kart nie podbija czasu tym, którym nic nie zmienił.
 */
export function ustawWartoscKarty(db, kartaId, parametrId, surowa, { at = teraz(), kto = null } = {}) {
  const parametr = parametrPoId(db, parametrId);
  if (!parametr) return NIE_MA_PARAMETRU;
  const karta = idLiczba(kartaId);
  if (!kartaIstnieje(db, karta)) return NIE_MA_KARTY;
  const v = normalizujWartosc(parametr, surowa);
  if (v.blad) return { blad: v.blad, kod: 'NIEPOPRAWNE' };
  if (v.wartosc === null) {
    const { changes } = db
      .prepare('DELETE FROM karty_parametry WHERE karta_id = ? AND parametr_id = ?')
      .run(karta, parametr.id);
    return { ok: true, wartosc: null, zmieniono: Number(changes) > 0 };
  }
  const { changes } = db
    .prepare(
      `INSERT INTO karty_parametry (karta_id, parametr_id, wartosc, zmieniono_at, kto) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (karta_id, parametr_id) DO UPDATE
         SET wartosc = excluded.wartosc, zmieniono_at = excluded.zmieniono_at, kto = excluded.kto
         WHERE karty_parametry.wartosc IS NOT excluded.wartosc`,
    )
    .run(karta, parametr.id, v.wartosc, at, kto);
  return { ok: true, wartosc: v.wartosc, zmieniono: Number(changes) > 0 };
}

/** Kasuje wartość parametru z karty; brak wartości to nie błąd. */
export function wyczyscWartoscKarty(db, kartaId, parametrId) {
  const parametr = parametrPoId(db, parametrId);
  if (!parametr) return NIE_MA_PARAMETRU;
  const { changes } = db
    .prepare('DELETE FROM karty_parametry WHERE karta_id = ? AND parametr_id = ?')
    .run(idLiczba(kartaId), parametr.id);
  return { ok: true, zmieniono: Number(changes) > 0 };
}
