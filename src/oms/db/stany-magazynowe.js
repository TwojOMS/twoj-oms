// Zapytania stanów magazynowych. Reguły — domena/stany-magazynowe.js; tu tylko baza.
import {
  zuzycieZZamowien,
  zuzycieZGrup,
  kartaPozycji,
  planImportuOtwarcia,
  RODZAJE_RUCHU,
  STATUSY_WOO_BEZ_ROZCHODU,
} from '../../domena/stany-magazynowe.js';
import { nalozNadpisaniaPozycji } from '../../domena/pozycje-reczne.js';

const teraz = () => new Date().toISOString();
// Rejestr należy do opcjonalnego modułu magazynu; starsza baza nadal korzysta z samego lustra.
const maRejestrOfert = (db) =>
  Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'oferty_kanalow'").get());
const maTabele = (db, nazwa) =>
  Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(nazwa));
const kluczOferty = (kanal, produktId) => JSON.stringify([kanal, String(produktId)]);

/**
 * Stan przełącznika: `{ wlaczone, granica, historia }`. Brak wpisów = wyłączone (domyślnie).
 * `granica` — chwila OSTATNIEGO włączenia; liczą się zamówienia złożone od niej.
 */
export function przelacznikStanow(db) {
  const historia = db
    .prepare('SELECT id, wlaczone, konto_login, utworzono_at FROM magazyn_przelaczenia ORDER BY id DESC LIMIT 20')
    .all()
    .map((w) => ({ ...w, wlaczone: Number(w.wlaczone) === 1 }));
  const ostatni = historia[0];
  const wlaczone = Boolean(ostatni?.wlaczone);
  return {
    wlaczone,
    granica: wlaczone ? ostatni.utworzono_at : null,
    przelaczenieId: wlaczone ? Number(ostatni.id) : null,
    historia,
  };
}

/** Przełącza stany. Ten sam stan drugi raz nie dopisuje wiersza (nie przesuwa granicy po cichu). */
export function przelaczStany(db, { wlacz, konto = null, at = teraz() }) {
  const { wlaczone } = przelacznikStanow(db);
  if (Boolean(wlacz) === wlaczone) return { zmieniono: false };
  db.prepare(
    'INSERT INTO magazyn_przelaczenia (wlaczone, konto_id, konto_login, utworzono_at) VALUES (?, ?, ?, ?)',
  ).run(wlacz ? 1 : 0, konto?.id ?? null, konto?.login ?? null, at);
  return { zmieniono: true };
}

/** Różne `karta_id` wierszy lustra o danym identyfikatorze (`kanal: null` = dowolny kanał). */
export function kartyLustraZ(db) {
  // Jeden odczyt rejestru, oba tryby ofert. Konto to dokładnie zamowienia.sklep
  // (poller ERLI dostaje polaczenie.klucz), nigdy sam identyfikator produktu między kontami.
  const oferty = new Map(
    (maRejestrOfert(db) ? db.prepare('SELECT kanal, id_zewnetrzne, karta_id FROM oferty_kanalow').all() : []).map(
      (w) => [kluczOferty(w.kanal, w.id_zewnetrzne), Number(w.karta_id)],
    ),
  );
  // Bez `karta_id IS NOT NULL`: wiersz bez karty rozstrzyga o niejednoznaczności (domena, `kartaPozycji`).
  const zKanalem = db.prepare(`SELECT DISTINCT karta_id FROM produkty_sklepowe
    WHERE kanal = ? AND produkt_id = ? AND (? IS NULL OR wariant_id = ?)`);
  const bezKanalu = db.prepare(`SELECT DISTINCT karta_id FROM produkty_sklepowe
    WHERE produkt_id = ? AND (? IS NULL OR wariant_id = ?)`);
  const pamiec = new Map();
  return ({ kanal, produktId, wariantId }) => {
    const klucz = `${kanal}\u0000${produktId}\u0000${wariantId}`;
    if (!pamiec.has(klucz)) {
      const wiersze =
        kanal === null
          ? bezKanalu.all(produktId, wariantId, wariantId)
          : zKanalem.all(kanal, produktId, wariantId, wariantId);
      const kartaOferty = wariantId === null ? oferty.get(kluczOferty(kanal, produktId)) : undefined;
      // Nawet niejednoznaczne lustro lub wiersz bez karty ma pierwszeństwo przed rejestrem.
      pamiec.set(
        klucz,
        wiersze.length
          ? wiersze.map((w) => (w.karta_id === null ? null : Number(w.karta_id)))
          : kartaOferty === undefined
            ? []
            : [kartaOferty],
      );
    }
    return pamiec.get(klucz);
  };
}

/**
 * Zamówienia od granicy z pozycjami EFEKTYWNYMI (po ręcznych poprawkach).
 * `zPoprawkami` — tylko zamówienia z ręcznymi poprawkami pozycji; `ids` — tylko wskazane zamówienia.
 */
export function zamowieniaOdGranicy(db, granica, { zPoprawkami = false, ids = null, doChwili = null } = {}) {
  const warunek =
    (zPoprawkami ? ' AND z.pozycje_reczne_json IS NOT NULL' : '') +
    (doChwili ? ' AND julianday(z.utworzone_at) <= julianday(?)' : '') +
    (ids ? ' AND z.id IN (SELECT value FROM json_each(?))' : '');
  const parametry = [granica, ...(doChwili ? [doChwili] : []), ...(ids ? [JSON.stringify(ids)] : [])];
  const zamowienia = db
    .prepare(
      `SELECT z.id, z.numer, z.sklep, z.anulowane, z.anulowane_recznie, z.status_woo, z.utworzone_at, z.pozycje_reczne_json
    FROM zamowienia z WHERE julianday(z.utworzone_at) >= julianday(?)${warunek} ORDER BY julianday(z.utworzone_at), z.id`,
    )
    .all(...parametry);
  // ⚠️ JEDNO zapytanie o pozycje wszystkich tych zamówień, nie jedno na zamówienie — przy kilkunastu tysiącach zamówień
  // od granicy (miesiąc sprzedaży) zapytanie per zamówienie to blisko sekunda, a liczy się przy każdym otwarciu listy
  // Magazynu i karty zamówienia. Filtr daty po tym samym wyrażeniu, co indeks `zamowienia_julianday_utworzenia`.
  const wszystkie = db
    .prepare(
      `SELECT p.* FROM pozycje p JOIN zamowienia z ON z.id = p.zamowienie_id
    WHERE julianday(z.utworzone_at) >= julianday(?)${warunek} ORDER BY p.zamowienie_id, p.id`,
    )
    .all(...parametry);
  const poZamowieniu = new Map();
  for (const poz of wszystkie) {
    const lista = poZamowieniu.get(poz.zamowienie_id);
    if (lista) lista.push(poz);
    else poZamowieniu.set(poz.zamowienie_id, [poz]);
  }
  // Ręczne poprawki ilości (ta sama ilość, co na fakturze) — nakładane tylko tam, gdzie są.
  return zamowienia.map((z) => {
    const pozycje = poZamowieniu.get(z.id) ?? [];
    return {
      zamowienie: z,
      pozycje: z.pozycje_reczne_json ? nalozNadpisaniaPozycji(pozycje, z.pozycje_reczne_json) : pozycje,
    };
  });
}

/**
 * Stany wszystkich kart: `{ wlaczone, granica, stany: Map karta_id → {ruchy, zuzycie, stan}, bezKarty }`
 * (`bezKarty` — LICZBA pozycji bez karty; ich lista: `pozycjeBezKarty`).
 * Wyłączone stany: pusta mapa i zero — ekrany niczego nie pokazują.
 *
 * ⚠️ DWIE DROGI, JEDNA REGUŁA. Zamówienia bez ręcznych poprawek sumuje baza grupami identyfikatorów, a kartę
 * rozstrzyga `kartaPozycji` raz na grupę (`zuzycieZGrup`); zamówienia z poprawkami ilości idą pozycja po pozycji
 * po nałożeniu poprawek (`zuzycieZZamowien`). Warunek „zdejmuje” (nieanulowane) w SQL jest tym samym warunkiem,
 * co `zamowienieZdejmuje` — test „anulowanie oddaje towar” pilnuje obu dróg.
 */
export function stanyKart(db, przelacznik = przelacznikStanow(db), doChwili = null, ruchyDo = null) {
  if (!przelacznik.wlaczone) return { ...przelacznik, stany: new Map(), bezKarty: 0 };
  const ruchy = new Map(
    db
      .prepare(
        `SELECT karta_id, SUM(ilosc) AS suma FROM ruchy_magazynowe WHERE julianday(utworzono_at) >= julianday(?)
      AND (? IS NULL OR julianday(utworzono_at) < julianday(?)) GROUP BY karta_id`,
      )
      .all(przelacznik.granica, ruchyDo, ruchyDo)
      .map((w) => [Number(w.karta_id), Number(w.suma)]),
  );
  const lustro = kartyLustraZ(db);
  const grupy = db
    .prepare(
      `SELECT z.sklep, COALESCE(p.zrodlo, 'sklep') AS zrodlo, p.produkt_id, p.wariant_id, p.oferta_id,
      SUM(p.ilosc) AS ilosc, COUNT(*) AS pozycji
    FROM pozycje p JOIN zamowienia z ON z.id = p.zamowienie_id
    WHERE julianday(z.utworzone_at) >= julianday(?) AND z.pozycje_reczne_json IS NULL
      AND (? IS NULL OR julianday(z.utworzone_at) < julianday(?))
      AND COALESCE(z.anulowane, 0) = 0 AND COALESCE(z.anulowane_recznie, 0) = 0
      AND COALESCE(z.status_woo, '') NOT IN (SELECT value FROM json_each(?))
      AND p.ilosc > 0 AND (p.produkt_id IS NOT NULL OR p.oferta_id IS NOT NULL)
    GROUP BY z.sklep, COALESCE(p.zrodlo, 'sklep'), p.produkt_id, p.wariant_id, p.oferta_id`,
    )
    .all(przelacznik.granica, doChwili, doChwili, JSON.stringify(STATUSY_WOO_BEZ_ROZCHODU));
  const zGrup = zuzycieZGrup(grupy, lustro);
  const zPoprawek = zuzycieZZamowien(
    zamowieniaOdGranicy(db, przelacznik.granica, { zPoprawkami: true }).filter(
      ({ zamowienie: z }) => !doChwili || Date.parse(z.utworzone_at) < Date.parse(doChwili),
    ),
    lustro,
  );
  const zuzycie = new Map(zGrup.zuzycie);
  for (const [id, ile] of zPoprawek.zuzycie) zuzycie.set(id, (zuzycie.get(id) ?? 0) + ile);
  const bezKarty = zGrup.bezKarty + zPoprawek.bezKarty.length;
  const stany = new Map();
  for (const id of new Set([...ruchy.keys(), ...zuzycie.keys()])) {
    const r = ruchy.get(id) ?? 0;
    const z = zuzycie.get(id) ?? 0;
    stany.set(id, { ruchy: r, zuzycie: z, stan: r - z });
  }
  return { ...przelacznik, stany, bezKarty };
}

/** Pozycje zamówień od granicy, których nie da się przypiąć do karty — lista dla ekranu „pozycje bez karty”. */
export function pozycjeBezKarty(db) {
  const { wlaczone, granica } = przelacznikStanow(db);
  if (!wlaczone) return [];
  return zuzycieZZamowien(zamowieniaOdGranicy(db, granica), kartyLustraZ(db)).bezKarty;
}

/** Stan jednej karty (0, gdy nie ma ruchów ani zamówień; `null`, gdy stany są wyłączone). */
export function stanKarty(db, kartaId) {
  const s = stanyKart(db);
  if (!s.wlaczone) return null;
  return s.stany.get(Number(kartaId)) ?? { ruchy: 0, zuzycie: 0, stan: 0 };
}

/**
 * Historia karty od granicy: ruchy ręczne i zamówienia, które zdjęły towar (najnowsze pierwsze).
 */
export function historiaKarty(db, kartaId) {
  const { wlaczone, granica } = przelacznikStanow(db);
  if (!wlaczone) return [];
  const id = Number(kartaId);
  const ruchy = db
    .prepare(
      `SELECT rodzaj, ilosc, powod, konto_login, utworzono_at FROM ruchy_magazynowe
    WHERE karta_id = ? AND julianday(utworzono_at) >= julianday(?)`,
    )
    .all(id, granica)
    .map((r) => ({ typ: 'ruch', ...r, ilosc: Number(r.ilosc) }));
  const lustro = kartyLustraZ(db);
  // Tylko zamówienia z pozycją, której identyfikator występuje w lustrze lub rejestrze tej karty (o tym, czy faktycznie
  // zdejmują z tej karty, rozstrzyga niżej ta sama reguła) — zamiast przeglądać wszystkie od granicy.
  const rejestr = maRejestrOfert(db);
  const ids = db
    .prepare(
      `SELECT DISTINCT p.zamowienie_id AS id FROM pozycje p JOIN zamowienia z ON z.id = p.zamowienie_id
    WHERE julianday(z.utworzone_at) >= julianday(?) AND (
      p.oferta_id IN (SELECT produkt_id FROM produkty_sklepowe WHERE karta_id = ?)
      OR CAST(p.produkt_id AS TEXT) IN (SELECT produkt_id FROM produkty_sklepowe WHERE karta_id = ?)
      ${
        rejestr
          ? `OR EXISTS (SELECT 1 FROM oferty_kanalow o
        WHERE o.karta_id = ? AND o.kanal = z.sklep
          AND o.id_zewnetrzne = p.oferta_id)`
          : ''
      })`,
    )
    .all(granica, id, id, ...(rejestr ? [id] : []))
    .map((w) => Number(w.id));
  const zamowienia = [];
  for (const { zamowienie, pozycje } of zamowieniaOdGranicy(db, granica, { ids })) {
    const ilosc = zuzycieZZamowien([{ zamowienie, pozycje }], lustro).zuzycie.get(id) ?? 0;
    if (ilosc)
      zamowienia.push({
        typ: 'zamowienie',
        zamowienie_id: zamowienie.id,
        numer: zamowienie.numer,
        sklep: zamowienie.sklep,
        ilosc: -ilosc,
        utworzono_at: zamowienie.utworzone_at,
      });
  }
  // Przepięcie oferty z tej karty albo na nią — wpis opisowy (ilość 0, bo zamówienia już liczą się na nowej karcie;
  // historia dalej sumuje się do stanu), z liczbą sztuk, które przeszły z ofertą wstecz.
  const przepiecia = maTabele(db, 'stany_przepiecia')
    ? db
        .prepare(
          `SELECT kanal, produkt_id, wariant_id, z_karty, na_karte,
      ilosc_wstecz, konto_login, utworzono_at, (SELECT nazwa FROM karty_produktow WHERE id = z_karty) AS z_nazwa,
      (SELECT nazwa FROM karty_produktow WHERE id = na_karte) AS na_nazwa FROM stany_przepiecia
    WHERE (z_karty = ? OR na_karte = ?) AND julianday(utworzono_at) >= julianday(?)`,
        )
        .all(id, id, granica)
        .map(({ z_nazwa, na_nazwa, ...w }) => ({
          typ: 'przepiecie',
          ...w,
          ilosc: 0,
          ilosc_wstecz: Number(w.ilosc_wstecz),
          powod: opisPrzepiecia({ ...w, z_nazwa, na_nazwa }, id),
        }))
    : [];
  return [...ruchy, ...zamowienia, ...przepiecia].sort((a, b) =>
    String(b.utworzono_at).localeCompare(String(a.utworzono_at)),
  );
}

function opisPrzepiecia(w, id) {
  const oferta = `${w.kanal} ${w.produkt_id}${w.wariant_id ? `/${w.wariant_id}` : ''}`;
  const karta = (k, nazwa) => (k === null ? 'brak karty' : `#${k}${nazwa ? ` ${nazwa}` : ''}`);
  const kierunek =
    Number(w.z_karty) === id
      ? `z tej karty na: ${karta(w.na_karte, w.na_nazwa)}`
      : `na tę kartę z: ${karta(w.z_karty, w.z_nazwa)}`;
  return `Oferta ${oferta} przepięta ${kierunek}; ${Number(w.ilosc_wstecz)} szt. z zamówień od włączenia stanów przeszło z ofertą.`;
}

/**
 * Rozchód z zamówień od granicy, w których występuje ten produkt kanału (`oferta_id` albo `produkt_id`),
 * rozłożony na karty według BIEŻĄCEGO lustra i rejestru — ta sama reguła, co `stanyKart` (`zuzycieZZamowien`).
 * Różnica przed i po zmianie powiązania = ilość, którą przepięcie przenosi wstecz. Wyłączone stany → pusta mapa.
 */
export function zuzycieProduktuOdGranicy(db, produktId, przelacznik = przelacznikStanow(db)) {
  if (!przelacznik.wlaczone) return new Map();
  const ids = db
    .prepare(
      `SELECT DISTINCT p.zamowienie_id AS id FROM pozycje p JOIN zamowienia z ON z.id = p.zamowienie_id
    WHERE julianday(z.utworzone_at) >= julianday(?) AND (p.oferta_id = ? OR CAST(p.produkt_id AS TEXT) = ?)`,
    )
    .all(przelacznik.granica, String(produktId), String(produktId))
    .map((w) => Number(w.id));
  if (!ids.length) return new Map();
  return zuzycieZZamowien(zamowieniaOdGranicy(db, przelacznik.granica, { ids }), kartyLustraZ(db)).zuzycie;
}

/**
 * Ruch ręczny. Ten sam `klucz` drugi raz (podwójne kliknięcie, ponowione żądanie) — `{ dopisano: false }`, bez wyjątku.
 */
export function dodajRuch(db, { kartaId, rodzaj, ilosc, powod = null, klucz, konto = null, at = teraz() }) {
  if (!RODZAJE_RUCHU.includes(rodzaj)) throw new Error(`dodajRuch: nieznany rodzaj „${rodzaj}”`);
  if (!przelacznikStanow(db).wlaczone)
    throw new Error(
      'Stany magazynowe są wyłączone — włącz je w Ustawieniach → Zamówienia i magazyn → Stany magazynowe.',
    );
  if (!db.prepare('SELECT 1 FROM karty_produktow WHERE id = ?').get(kartaId))
    throw new Error(`Nie ma karty produktu ${kartaId}.`);
  const r = db
    .prepare(
      `INSERT INTO ruchy_magazynowe (karta_id, ilosc, rodzaj, powod, konto_id, konto_login, utworzono_at, klucz)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (klucz) DO NOTHING`,
    )
    .run(kartaId, ilosc, rodzaj, powod, konto?.id ?? null, konto?.login ?? null, at, klucz);
  return { dopisano: Number(r.changes) === 1 };
}

/** Podgląd importu stanu otwarcia (bez zapisu). */
export function podgladImportuOtwarcia(db, tekst) {
  const { wlaczone, granica } = przelacznikStanow(db);
  if (!wlaczone)
    throw new Error(
      'Stany magazynowe są wyłączone — włącz je w Ustawieniach → Zamówienia i magazyn → Stany magazynowe.',
    );
  const poSku = db.prepare(
    "SELECT id, nazwa FROM karty_produktow WHERE UPPER(TRIM(sku)) = UPPER(TRIM(?)) AND TRIM(COALESCE(sku, '')) <> ''",
  );
  const maOtwarcie = new Set(
    db
      .prepare(
        `SELECT DISTINCT karta_id FROM ruchy_magazynowe
    WHERE rodzaj = 'otwarcie' AND julianday(utworzono_at) >= julianday(?)`,
      )
      .all(granica)
      .map((w) => Number(w.karta_id)),
  );
  const zTabela = maTabele(db, 'stany_otwarcia');
  if (zTabela) {
    for (const w of db.prepare('SELECT karta_id FROM stany_otwarcia WHERE granica = ?').all(granica))
      maOtwarcie.add(Number(w.karta_id));
  }
  // Bez tabeli stany_otwarcia zera nie da się zapisać — odrzucona jest tylko ta linia, nie cały plik.
  return planImportuOtwarcia(tekst, (sku) => poSku.get(sku) ?? null, maOtwarcie, { zeroDozwolone: zTabela });
}

/**
 * Zapis importu w JEDNEJ transakcji. Klucz ruchu = otwarcie + karta + granica, więc ponowny import tego samego
 * pliku (albo drugie kliknięcie „Zapisz”) nie podwaja zapasu — liczy się od nowa i wraca jako `pominiete`.
 */
export function zapiszImportOtwarcia(db, tekst, { konto = null, at = teraz() } = {}) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const plan = podgladImportuOtwarcia(db, tekst);
    let zapisane = 0;
    for (const w of plan.doZapisu) {
      const { dopisano } = zapiszOtwarcieWTransakcji(db, {
        kartaId: w.karta_id,
        ilosc: w.ilosc,
        zrodlo: 'import',
        konto,
        at,
      });
      if (dopisano) zapisane += 1;
    }
    db.exec('COMMIT');
    return { zapisane, odrzucone: plan.odrzucone };
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

/** Otwarcie i ewentualny ruch należą do tej samej transakcji wywołującego. */
function zapiszOtwarcieWTransakcji(db, { kartaId, ilosc, zrodlo, konto = null, at = teraz() }) {
  if (!Number.isSafeInteger(ilosc) || ilosc < 0) throw new Error('Ilość otwarcia musi być liczbą całkowitą ≥ 0.');
  if (!String(zrodlo ?? '').trim()) throw new Error('Otwarcie wymaga źródła.');
  const { wlaczone, granica } = przelacznikStanow(db);
  if (!wlaczone) throw new Error('Stany magazynowe są wyłączone.');
  if (!db.prepare('SELECT 1 FROM karty_produktow WHERE id = ?').get(kartaId)) throw new Error('Nie ma karty produktu.');
  if (!maTabele(db, 'stany_otwarcia')) {
    // Starsza instalacja: dodatni import nadal działa; zera nie wolno po cichu zgubić.
    if (ilosc === 0) throw new Error('Brak tabeli stany_otwarcia — wymagane uaktualnienie bazy.');
    return dodajRuch(db, {
      kartaId,
      rodzaj: 'otwarcie',
      ilosc,
      powod: `otwarcie z ${zrodlo}`,
      klucz: `otwarcie:${kartaId}:${granica}`,
      konto,
      at,
    });
  }
  if (db.prepare('SELECT 1 FROM stany_otwarcia WHERE karta_id = ? AND granica = ?').get(kartaId, granica))
    return { dopisano: false };
  // Ruch otwarcia ze starszego importu bez wiersza stany_otwarcia — jak w podglądzie importu: odmowa.
  if (
    db
      .prepare(
        `SELECT 1 FROM ruchy_magazynowe WHERE karta_id = ? AND rodzaj = 'otwarcie'
    AND julianday(utworzono_at) >= julianday(?)`,
      )
      .get(kartaId, granica)
  ) {
    throw new Error('Karta ma już stan otwarcia — zmień go korektą na karcie.');
  }
  db.prepare(
    `INSERT INTO stany_otwarcia (karta_id, granica, ilosc, zrodlo, konto_login, utworzono_at)
    VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(kartaId, granica, ilosc, zrodlo, konto?.login ?? null, at);
  if (ilosc !== 0) {
    const { dopisano } = dodajRuch(db, {
      kartaId,
      rodzaj: 'otwarcie',
      ilosc,
      powod: `otwarcie z ${zrodlo}`,
      klucz: `otwarcie:${kartaId}:${granica}`,
      konto,
      at,
    });
    if (!dopisano) throw new Error('Ruch otwarcia nie został zapisany (klucz zajęty) — otwarcie cofnięte.');
  }
  return { dopisano: true };
}

/** Także zero zapisuje znany stan. */
export function zapiszOtwarcie(db, dane) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const wynik = zapiszOtwarcieWTransakcji(db, dane);
    db.exec('COMMIT');
    return wynik;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

/**
 * Wiele otwarć w JEDNEJ transakcji: błąd w którejkolwiek karcie cofa wszystkie.
 * Zwraca `{ zapisano, pominieto }` (pominięte = karta ma już otwarcie).
 */
export function zapiszOtwarciaHurtem(db, zapisy) {
  db.exec('BEGIN IMMEDIATE');
  try {
    let zapisano = 0;
    let pominieto = 0;
    for (const zapis of zapisy) {
      if (zapiszOtwarcieWTransakcji(db, zapis).dopisano) zapisano++;
      else pominieto++;
    }
    db.exec('COMMIT');
    return { zapisano, pominieto };
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

function uzupelnijMigawke(db, stany, ruchyDo = null) {
  const otwarcia = new Map();
  const znane = new Set();
  if (stany.wlaczone) {
    for (const w of db
      .prepare(
        `SELECT DISTINCT karta_id FROM ruchy_magazynowe
      WHERE julianday(utworzono_at) >= julianday(?)
      AND (? IS NULL OR julianday(utworzono_at) < julianday(?))`,
      )
      .all(stany.granica, ruchyDo, ruchyDo))
      znane.add(Number(w.karta_id));
    if (maTabele(db, 'stany_otwarcia')) {
      for (const w of db
        .prepare('SELECT karta_id, ilosc, zrodlo FROM stany_otwarcia WHERE granica = ?')
        .all(stany.granica)) {
        const id = Number(w.karta_id);
        znane.add(id);
        otwarcia.set(id, { ilosc: Number(w.ilosc), zrodlo: w.zrodlo });
        if (!stany.stany.has(id)) stany.stany.set(id, { ruchy: 0, zuzycie: 0, stan: 0 });
      }
    }
  }
  let zatwierdzenie = null;
  if (stany.wlaczone && maTabele(db, 'stany_zatwierdzenia')) {
    const w = db
      .prepare(
        `SELECT id, przelaczenie_id, skrot FROM stany_zatwierdzenia
      WHERE przelaczenie_id = ? ORDER BY id DESC LIMIT 1`,
      )
      .get(stany.przelaczenieId);
    if (w) zatwierdzenie = { id: Number(w.id), przelaczenieId: Number(w.przelaczenie_id), skrot: w.skrot };
  }
  return { ...stany, znane, otwarcia, zatwierdzenie, policzonoAt: teraz() };
}

/** Jedno wyliczenie na przebieg; brak ruchu i otwarcia oznacza stan nieznany. */
export function migawkaStanow(db) {
  return uzupelnijMigawke(db, stanyKart(db));
}

/** Poprzednia granica: ruchy do wyłączenia, sprzedaż do ponownego włączenia (albo do teraz). */
export function stanKontynuacji(db) {
  const historia = db.prepare('SELECT id, wlaczone, utworzono_at FROM magazyn_przelaczenia ORDER BY id DESC').all();
  const indeks = historia.findIndex((w) => !Number(w.wlaczone));
  if (indeks < 0) return null;
  const wylaczenie = historia[indeks];
  const wlaczenie = historia.slice(indeks + 1).find((w) => Number(w.wlaczone));
  if (!wlaczenie) return null;
  const doChwili = indeks > 0 ? historia[indeks - 1].utworzono_at : teraz();
  const przelacznik = { wlaczone: true, granica: wlaczenie.utworzono_at, przelaczenieId: Number(wlaczenie.id) };
  return uzupelnijMigawke(db, stanyKart(db, przelacznik, doChwili, wylaczenie.utworzono_at), wylaczenie.utworzono_at);
}

/**
 * Map po id przekazanego wiersza (bez id: po obiekcie wiersza). `od` jest jawne, nie wymaga kolumn z migracji magazyn/0004.
 * Jeden odczyt grupuje pozycje zamówień od najstarszego okna; ruchy, powiązania i pollery są w tym samym SELECT.
 */
export function wyjasnieniaOfert(db, wiersze) {
  if (!wiersze.length) return new Map();
  // Wiersz bez prawidłowego `od` (oferta jeszcze bez pierwszej wysyłki) nie wyznacza okna — dostaje zera niżej.
  const czasy = wiersze.map((w) => Date.parse(w.od)).filter(Number.isFinite);
  const od = czasy.length ? new Date(Math.min(...czasy)).toISOString() : teraz();
  let dane;
  try {
    dane = db
      .prepare(
        `WITH grupy AS (
      SELECT z.id, z.sklep, z.utworzone_at, z.zmienione_at, z.anulowane, z.anulowane_recznie,
        z.status_woo, z.pozycje_reczne_json,
        json_group_array(json_object('id', p.id, 'zrodlo', p.zrodlo, 'zrodlo_id', p.zrodlo_id,
          'oferta_id', p.oferta_id, 'produkt_id', p.produkt_id, 'wariant_id', p.wariant_id,
          'ilosc', p.ilosc, 'cena_brutto', p.cena_brutto, 'nazwa', p.nazwa)) AS pozycje
      FROM zamowienia z JOIN pozycje p ON p.zamowienie_id = z.id
      WHERE julianday(z.utworzone_at) > julianday(?) OR julianday(z.zmienione_at) > julianday(?)
      GROUP BY z.id
    ) SELECT
      (SELECT json_group_array(json_object('id', id, 'sklep', sklep, 'utworzone_at', utworzone_at,
        'zmienione_at', zmienione_at, 'anulowane', anulowane, 'anulowane_recznie', anulowane_recznie,
        'status_woo', status_woo, 'poprawki', pozycje_reczne_json, 'pozycje', json(pozycje))) FROM grupy) AS zamowienia,
      (SELECT json_group_array(json_object('karta_id', karta_id, 'ilosc', ilosc, 'at', utworzono_at, 'klucz', klucz))
        FROM ruchy_magazynowe WHERE julianday(utworzono_at) > julianday(?)) AS ruchy,
      (SELECT json_group_array(json_object('kanal', kanal, 'produkt_id', produkt_id, 'wariant_id', wariant_id, 'karta_id', karta_id))
        FROM produkty_sklepowe) AS lustro,
      (SELECT json_group_array(json_object('kanal', kanal, 'produkt_id', id_zewnetrzne, 'karta_id', karta_id))
        FROM oferty_kanalow) AS oferty,
      (SELECT json_group_array(json_object('sklep', sklep, 'ostatniPrzebiegAt', ostatni_przebieg_at,
        'ostatniBlad', ostatni_blad, 'ostatniBladRodzaj', ostatni_blad_rodzaj)) FROM stan_pollera) AS pollery`,
      )
      .get(od, od, od);
  } catch (e) {
    if (/no such table: (?:main\.)?oferty_kanalow\b/.test(String(e.message))) return new Map();
    throw e;
  }
  const lustro = JSON.parse(dane.lustro);
  const oferty = new Map(JSON.parse(dane.oferty).map((w) => [kluczOferty(w.kanal, w.produkt_id), w.karta_id]));
  const pamiec = new Map();
  const karty = ({ kanal, produktId, wariantId }) => {
    const klucz = JSON.stringify([kanal, produktId, wariantId]);
    if (!pamiec.has(klucz)) {
      const pasujace = lustro.filter(
        (w) =>
          (kanal === null || w.kanal === kanal) &&
          String(w.produkt_id) === produktId &&
          (wariantId === null || String(w.wariant_id) === wariantId),
      );
      const karta = wariantId === null ? oferty.get(kluczOferty(kanal, produktId)) : undefined;
      pamiec.set(klucz, pasujace.length ? pasujace.map((w) => w.karta_id) : karta === undefined ? [] : [karta]);
    }
    return pamiec.get(klucz);
  };
  const zamowienia = JSON.parse(dane.zamowienia).map((z) => ({
    ...z,
    pozycje: (z.poprawki ? nalozNadpisaniaPozycji(z.pozycje, z.poprawki) : z.pozycje).map((p) => ({
      ...p,
      kartaId: kartaPozycji(p, z.sklep, karty)?.kartaId,
    })),
  }));
  const ruchy = JSON.parse(dane.ruchy);
  const pollery = new Map(JSON.parse(dane.pollery).map(({ sklep, ...p }) => [sklep, p]));
  // Indeksy: pozycje po (kanał, identyfikator) i po karcie, ruchy po karcie — wiersz nie przegląda wszystkich zamówień.
  const poId = new Map();
  const poKarcie = new Map();
  const dopisz = (mapa, klucz, wpis) => {
    const lista = mapa.get(klucz);
    if (lista) lista.push(wpis);
    else mapa.set(klucz, [wpis]);
  };
  for (const z of zamowienia) {
    const utworzone = Date.parse(z.utworzone_at);
    const zmienioneAt = Date.parse(z.zmienione_at);
    const anulowane = Boolean(Number(z.anulowane) || Number(z.anulowane_recznie));
    const wooBez = STATUSY_WOO_BEZ_ROZCHODU.includes(z.status_woo) || z.status_woo === 'pending';
    for (const p of z.pozycje) {
      const wpis = { ile: Math.abs(Number(p.ilosc)), utworzone, zmienioneAt, anulowane, wooBez };
      if (p.kartaId !== undefined) dopisz(poKarcie, p.kartaId, wpis);
      if (p.oferta_id != null) dopisz(poId, JSON.stringify(['o', z.sklep, String(p.oferta_id)]), wpis);
      else {
        dopisz(poId, JSON.stringify(['p', z.sklep, String(p.produkt_id), String(p.wariant_id ?? '')]), wpis);
        dopisz(poId, JSON.stringify(['s', z.sklep, `${p.produkt_id}${p.wariant_id ? `/${p.wariant_id}` : ''}`]), wpis);
      }
    }
  }
  const ruchyKarty = new Map();
  for (const r of ruchy)
    dopisz(ruchyKarty, Number(r.karta_id), {
      ile: Math.abs(Number(r.ilosc)),
      at: Date.parse(r.at),
      klucz: String(r.klucz ?? ''),
    });
  const wynik = new Map();
  for (const w of wiersze) {
    let sprzedaneOd = 0,
      anulowaneOd = 0,
      wyjasnioneKarty = 0;
    const odAt = Date.parse(w.od);
    const kartaId = Number(w.kartaId ?? w.karta_id);
    if (Number.isFinite(odAt)) {
      for (const p of poKarcie.get(kartaId) ?? []) if (p.zmienioneAt > odAt) wyjasnioneKarty += p.ile;
      const identyfikator = String(w.idZewnetrzne ?? w.id_zewnetrzne ?? w.ofertaId);
      const pasujace = [
        ...(poId.get(JSON.stringify(['o', w.kanal, identyfikator])) ?? []),
        ...(poId.get(
          JSON.stringify(
            w.produktId != null
              ? ['p', w.kanal, String(w.produktId), String(w.wariantId ?? '')]
              : ['s', w.kanal, identyfikator],
          ),
        ) ?? []),
      ];
      for (const p of pasujace) {
        const zmienione = p.zmienioneAt > odAt;
        const sprzedaz = (w.regula === 'zmienione' ? p.zmienioneAt : p.utworzone) > odAt;
        if (sprzedaz && (w.regula !== 'zmienione' || (!p.anulowane && !p.wooBez))) sprzedaneOd += p.ile;
        if (zmienione && (p.anulowane || (w.regula === 'zmienione' && p.wooBez))) anulowaneOd += p.ile;
      }
      // Własna korekta „Przyjmij stan kanału” tej oferty (`rozjazd:<id>:…`) już siedzi w jej S — nie jest wyjaśnieniem.
      const wlasna = w.id != null ? `rozjazd:${w.id}:` : null;
      for (const r of ruchyKarty.get(kartaId) ?? [])
        if (r.at > odAt && !(wlasna && r.klucz.startsWith(wlasna))) wyjasnioneKarty += r.ile;
    }
    wynik.set(w.id ?? w, { sprzedaneOd, anulowaneOd, wyjasnioneKarty, poller: pollery.get(w.kanal) ?? null });
  }
  return wynik;
}
