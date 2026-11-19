// Słowniki kart: kategorie główne i marki (tabele z migracji 0016).
// Słownik to lista nazw do wyboru na karcie; karta trzyma nazwę tekstem (`kategoria_glowna`, `marka`).
// Zmiana nazwy przepisuje karty w JEDNEJ transakcji i oznacza pole jako ręczne (import go potem nie nadpisze).
import { zapiszKarte } from '../../../oms/db/magazyn.js';
import { dekodujEncje } from '../../../domena/slowniki-kart.js';
import { czystaNazwa } from '../../../domena/marka-karty.js';

export { czystaNazwa };

export const SLOWNIKI = Object.freeze({
  kategorie: Object.freeze({ tabela: 'kategorie_kart', kolumna: 'kategoria_glowna' }),
  marki: Object.freeze({ tabela: 'marki', kolumna: 'marka' }),
});

const teraz = () => new Date().toISOString();

/** Transakcja `BEGIN IMMEDIATE` (node:sqlite nie ma `db.transaction`), chyba że wołający już ją trzyma. */
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
const slownik = (typ) => {
  const s = SLOWNIKI[typ];
  if (!s) throw new Error(`nieznany słownik „${typ}”`);
  return s;
};

const liczbaKart = (db, { kolumna }, nazwa) =>
  db.prepare(`SELECT COUNT(*) AS ile FROM karty_produktow WHERE ${kolumna} = ?`).get(nazwa).ile;

/** Nazwy ze słownika (do wyboru na karcie), alfabetycznie. */
export function nazwySlownika(db, typ) {
  const { tabela } = slownik(typ);
  return db
    .prepare(`SELECT nazwa FROM ${tabela} ORDER BY nazwa COLLATE NOCASE, nazwa`)
    .all()
    .map((r) => r.nazwa);
}

/**
 * Lista do strony słownika: wpisy słownika i nazwy spotykane na kartach (choćby spoza słownika),
 * z liczbą kart; przy kategoriach także, z których połączeń sklepu przyszła nazwa.
 */
export function listaSlownika(db, typ) {
  const { tabela, kolumna } = slownik(typ);
  const wiersze = db
    .prepare(
      `
    SELECT n.nazwa, COUNT(k.id) AS karty, MAX(s.nazwa IS NOT NULL) AS w_slowniku
    FROM (SELECT nazwa FROM ${tabela}
          UNION SELECT ${kolumna} FROM karty_produktow WHERE ${kolumna} IS NOT NULL AND trim(${kolumna}) <> '') n
    LEFT JOIN karty_produktow k ON k.${kolumna} = n.nazwa
    LEFT JOIN ${tabela} s ON s.nazwa = n.nazwa
    GROUP BY n.nazwa ORDER BY n.nazwa COLLATE NOCASE, n.nazwa`,
    )
    .all();
  const zrodla = new Map();
  if (typ === 'kategorie') {
    for (const r of db.prepare('SELECT DISTINCT nazwa, kanal FROM kategorie_kart_kanaly ORDER BY kanal').all()) {
      zrodla.set(r.nazwa, [...(zrodla.get(r.nazwa) ?? []), r.kanal]);
    }
  }
  const bez = db
    .prepare(`SELECT COUNT(*) AS ile FROM karty_produktow WHERE ${kolumna} IS NULL OR trim(${kolumna}) = ''`)
    .get().ile;
  return {
    pozycje: wiersze.map((w) => ({
      nazwa: w.nazwa,
      karty: w.karty,
      wSlowniku: w.w_slowniku === 1,
      kanaly: zrodla.get(w.nazwa) ?? [],
    })),
    bez,
  };
}

/** Dopisuje nazwę do słownika; istniejąca zostaje bez zmian. */
export function dodajDoSlownika(db, typ, nazwa, { at = teraz() } = {}) {
  const { tabela } = slownik(typ);
  const n = czystaNazwa(nazwa);
  if (!n) return false;
  return db.prepare(`INSERT OR IGNORE INTO ${tabela} (nazwa, utworzona_at) VALUES (?, ?)`).run(n, at).changes === 1;
}

/**
 * Zmiana nazwy: wszystkie karty ze starą nazwą dostają nową (ręcznie — zapiszKarte oznacza źródło),
 * stary wpis znika, nowy powstaje (albo już był — wtedy dwie nazwy się scalają). Jedna transakcja.
 */
// Mapowania idą za nazwą: Allegro (tabele z migracji magazynu 0002 — w bazie bez modułu ich nie ma)
// i producent marki (rdzeń). Przy scaleniu z istniejącą nazwą zostaje mapowanie nazwy docelowej
// (UPDATE OR IGNORE + usunięcie resztek).
const MAPOWANIA_MAREK = Object.freeze({
  kategorie: [['allegro_mapa_kategorii', 'kategoria_karty']],
  marki: [
    ['allegro_marki', 'marka'],
    ['allegro_marki_gpsr', 'marka'],
    ['marki_producenci', 'marka'],
  ],
});

function przeniesMapowania(db, typ, stara, nowa) {
  for (const [tabela, kolumna] of MAPOWANIA_MAREK[typ] ?? []) {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(tabela)) continue;
    db.prepare(`UPDATE OR IGNORE ${tabela} SET ${kolumna} = ? WHERE ${kolumna} = ?`).run(nowa, stara);
    db.prepare(`DELETE FROM ${tabela} WHERE ${kolumna} = ?`).run(stara);
  }
}

export function zmienNazwe(db, typ, stara, nowa, { at = teraz() } = {}) {
  const s = slownik(typ);
  const z = czystaNazwa(stara);
  const n = czystaNazwa(nowa);
  if (!z || !n) return { blad: 'Podaj nazwę.' };
  if (z === n) return { karty: 0 };
  return wTransakcji(db, () => {
    const karty = db
      .prepare(`SELECT id FROM karty_produktow WHERE ${s.kolumna} = ?`)
      .all(z)
      .map((r) => r.id);
    for (const id of karty) zapiszKarte(db, id, { [s.kolumna]: n }, { at });
    db.prepare(`DELETE FROM ${s.tabela} WHERE nazwa = ?`).run(z);
    db.prepare(`INSERT OR IGNORE INTO ${s.tabela} (nazwa, utworzona_at) VALUES (?, ?)`).run(n, at);
    if (typ === 'kategorie') db.prepare('UPDATE kategorie_kart_kanaly SET nazwa = ? WHERE nazwa = ?').run(n, z);
    przeniesMapowania(db, typ, z, n);
    return { karty: karty.length };
  });
}

/** Usuwa wpis słownika tylko wtedy, gdy żadna karta go nie używa. */
export function usunZeSlownika(db, typ, nazwa) {
  const s = slownik(typ);
  const n = czystaNazwa(nazwa);
  if (!n) return { blad: 'Podaj nazwę.' };
  return wTransakcji(db, () => {
    const karty = liczbaKart(db, s, n);
    if (karty > 0) return { karty };
    db.prepare(`DELETE FROM ${s.tabela} WHERE nazwa = ?`).run(n);
    if (typ === 'kategorie') db.prepare('DELETE FROM kategorie_kart_kanaly WHERE nazwa = ?').run(n);
    if (typ === 'marki') db.prepare('DELETE FROM marki_producenci WHERE marka = ?').run(n);
    return { karty: 0 };
  });
}

/** Po zapisie karty: wartości kategorii i marki trafiają do słowników (nowe nazwy z „dodaj nową”). */
export function dopiszDoSlownikow(db, zmiany, { at = teraz() } = {}) {
  for (const [typ, { kolumna }] of Object.entries(SLOWNIKI)) {
    if (typeof zmiany?.[kolumna] === 'string') dodajDoSlownika(db, typ, zmiany[kolumna], { at });
  }
}

/**
 * Kategorie jednego połączenia WooCommerce → słownik. Tylko kategorie z produktami (count > 0), po nazwie
 * zdekodowanej z encji; istniejących wpisów nie zmienia, niczego nie usuwa. Źródło (połączenie, id, rodzic)
 * trafia do kategorie_kart_kanaly. Zwraca {dodano, bylo}: ile nazw nowych, ile już było w słowniku.
 */
export function scalKategorieWoo(db, kanal, lista, { at = teraz() } = {}) {
  const wstaw = db.prepare('INSERT OR IGNORE INTO kategorie_kart (nazwa, utworzona_at) VALUES (?, ?)');
  const zrodlo =
    db.prepare(`INSERT INTO kategorie_kart_kanaly (nazwa, kanal, id_zewnetrzne, rodzic_id) VALUES (?, ?, ?, ?)
    ON CONFLICT (kanal, id_zewnetrzne) DO UPDATE SET nazwa = excluded.nazwa, rodzic_id = excluded.rodzic_id`);
  return wTransakcji(db, () => {
    const widziane = new Set();
    let dodano = 0;
    let bylo = 0;
    for (const k of Array.isArray(lista) ? lista : []) {
      if (!(Number(k?.count) > 0) || k?.id == null) continue;
      const nazwa = czystaNazwa(dekodujEncje(String(k.name ?? '')));
      if (!nazwa) continue;
      const rodzic = Number(k.parent) > 0 ? String(k.parent) : null;
      zrodlo.run(nazwa, kanal, String(k.id), rodzic);
      if (widziane.has(nazwa)) continue;
      widziane.add(nazwa);
      if (wstaw.run(nazwa, at).changes === 1) dodano += 1;
      else bylo += 1;
    }
    return { dodano, bylo };
  });
}
