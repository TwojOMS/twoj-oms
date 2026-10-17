// Zapytania stanów magazynowych (PRZ-091). Reguły — domena/stany-magazynowe.js; tu tylko baza.
import { zuzycieZZamowien, zuzycieZGrup, planImportuOtwarcia, RODZAJE_RUCHU, STATUSY_WOO_BEZ_ROZCHODU } from '../../domena/stany-magazynowe.js';
import { nalozNadpisaniaPozycji } from '../../domena/pozycje-reczne.js';

const teraz = () => new Date().toISOString();

/**
 * Stan przełącznika: `{ wlaczone, granica, historia }`. Brak wpisów = wyłączone (domyślnie).
 * `granica` — chwila OSTATNIEGO włączenia; liczą się zamówienia złożone od niej.
 */
export function przelacznikStanow(db) {
  const historia = db.prepare(
    'SELECT wlaczone, konto_login, utworzono_at FROM magazyn_przelaczenia ORDER BY id DESC LIMIT 20',
  ).all().map((w) => ({ ...w, wlaczone: Number(w.wlaczone) === 1 }));
  const ostatni = historia[0];
  const wlaczone = Boolean(ostatni?.wlaczone);
  return { wlaczone, granica: wlaczone ? ostatni.utworzono_at : null, historia };
}

/** Przełącza stany. Ten sam stan drugi raz nie dopisuje wiersza (nie przesuwa granicy po cichu). */
export function przelaczStany(db, { wlacz, konto = null, at = teraz() }) {
  const { wlaczone } = przelacznikStanow(db);
  if (Boolean(wlacz) === wlaczone) return { zmieniono: false };
  db.prepare('INSERT INTO magazyn_przelaczenia (wlaczone, konto_id, konto_login, utworzono_at) VALUES (?, ?, ?, ?)')
    .run(wlacz ? 1 : 0, konto?.id ?? null, konto?.login ?? null, at);
  return { zmieniono: true };
}

/** Różne `karta_id` wierszy lustra o danym identyfikatorze (`kanal: null` = dowolny kanał). */
export function kartyLustraZ(db) {
  // Bez `karta_id IS NOT NULL`: wiersz bez karty rozstrzyga o niejednoznaczności (domena, `kartaPozycji`).
  const zKanalem = db.prepare(`SELECT DISTINCT karta_id FROM produkty_sklepowe
    WHERE kanal = ? AND produkt_id = ? AND (? IS NULL OR wariant_id = ?)`);
  const bezKanalu = db.prepare(`SELECT DISTINCT karta_id FROM produkty_sklepowe
    WHERE produkt_id = ? AND (? IS NULL OR wariant_id = ?)`);
  const pamiec = new Map();
  return ({ kanal, produktId, wariantId }) => {
    const klucz = `${kanal}\u0000${produktId}\u0000${wariantId}`;
    if (!pamiec.has(klucz)) {
      const wiersze = kanal === null
        ? bezKanalu.all(produktId, wariantId, wariantId)
        : zKanalem.all(kanal, produktId, wariantId, wariantId);
      pamiec.set(klucz, wiersze.map((w) => (w.karta_id === null ? null : Number(w.karta_id))));
    }
    return pamiec.get(klucz);
  };
}

/**
 * Zamówienia od granicy z pozycjami EFEKTYWNYMI (po ręcznych poprawkach).
 * `zPoprawkami` — tylko zamówienia z ręcznymi poprawkami pozycji; `ids` — tylko wskazane zamówienia.
 */
function zamowieniaOdGranicy(db, granica, { zPoprawkami = false, ids = null } = {}) {
  const warunek = (zPoprawkami ? ' AND z.pozycje_reczne_json IS NOT NULL' : '')
    + (ids ? ' AND z.id IN (SELECT value FROM json_each(?))' : '');
  const parametry = [granica, ...(ids ? [JSON.stringify(ids)] : [])];
  const zamowienia = db.prepare(`SELECT z.id, z.numer, z.sklep, z.anulowane, z.anulowane_recznie, z.status_woo, z.utworzone_at, z.pozycje_reczne_json
    FROM zamowienia z WHERE julianday(z.utworzone_at) >= julianday(?)${warunek} ORDER BY julianday(z.utworzone_at), z.id`).all(...parametry);
  // ⚠️ JEDNO zapytanie o pozycje wszystkich tych zamówień, nie jedno na zamówienie — pomiar PRZ-091: 15 000 zamówień
  // od granicy (500 dziennie × 30 dni) to 760 ms przy zapytaniu per zamówienie, a liczy się przy każdym otwarciu listy
  // Magazynu i karty zamówienia. Filtr daty po tym samym wyrażeniu, co indeks `zamowienia_julianday_utworzenia`.
  const wszystkie = db.prepare(`SELECT p.* FROM pozycje p JOIN zamowienia z ON z.id = p.zamowienie_id
    WHERE julianday(z.utworzone_at) >= julianday(?)${warunek} ORDER BY p.zamowienie_id, p.id`).all(...parametry);
  const poZamowieniu = new Map();
  for (const poz of wszystkie) {
    const lista = poZamowieniu.get(poz.zamowienie_id);
    if (lista) lista.push(poz); else poZamowieniu.set(poz.zamowienie_id, [poz]);
  }
  // Ręczne poprawki ilości (ta sama ilość, co na fakturze) — nakładane tylko tam, gdzie są.
  return zamowienia.map((z) => {
    const pozycje = poZamowieniu.get(z.id) ?? [];
    return { zamowienie: z, pozycje: z.pozycje_reczne_json ? nalozNadpisaniaPozycji(pozycje, z.pozycje_reczne_json) : pozycje };
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
export function stanyKart(db) {
  const przelacznik = przelacznikStanow(db);
  if (!przelacznik.wlaczone) return { ...przelacznik, stany: new Map(), bezKarty: 0 };
  const ruchy = new Map(db.prepare(
    'SELECT karta_id, SUM(ilosc) AS suma FROM ruchy_magazynowe WHERE julianday(utworzono_at) >= julianday(?) GROUP BY karta_id',
  ).all(przelacznik.granica).map((w) => [Number(w.karta_id), Number(w.suma)]));
  const lustro = kartyLustraZ(db);
  const grupy = db.prepare(`SELECT z.sklep, COALESCE(p.zrodlo, 'sklep') AS zrodlo, p.produkt_id, p.wariant_id, p.oferta_id,
      SUM(p.ilosc) AS ilosc, COUNT(*) AS pozycji
    FROM pozycje p JOIN zamowienia z ON z.id = p.zamowienie_id
    WHERE julianday(z.utworzone_at) >= julianday(?) AND z.pozycje_reczne_json IS NULL
      AND COALESCE(z.anulowane, 0) = 0 AND COALESCE(z.anulowane_recznie, 0) = 0
      AND COALESCE(z.status_woo, '') NOT IN (SELECT value FROM json_each(?))
      AND p.ilosc > 0 AND (p.produkt_id IS NOT NULL OR p.oferta_id IS NOT NULL)
    GROUP BY z.sklep, COALESCE(p.zrodlo, 'sklep'), p.produkt_id, p.wariant_id, p.oferta_id`)
    .all(przelacznik.granica, JSON.stringify(STATUSY_WOO_BEZ_ROZCHODU));
  const zGrup = zuzycieZGrup(grupy, lustro);
  const zPoprawek = zuzycieZZamowien(zamowieniaOdGranicy(db, przelacznik.granica, { zPoprawkami: true }), lustro);
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
  const ruchy = db.prepare(`SELECT rodzaj, ilosc, powod, konto_login, utworzono_at FROM ruchy_magazynowe
    WHERE karta_id = ? AND julianday(utworzono_at) >= julianday(?)`).all(id, granica)
    .map((r) => ({ typ: 'ruch', ...r, ilosc: Number(r.ilosc) }));
  const lustro = kartyLustraZ(db);
  // Tylko zamówienia z pozycją, której identyfikator występuje w lustrze tej karty (o tym, czy faktycznie
  // zdejmują z tej karty, rozstrzyga niżej ta sama reguła) — zamiast przeglądać wszystkie od granicy.
  const ids = db.prepare(`SELECT DISTINCT p.zamowienie_id AS id FROM pozycje p JOIN zamowienia z ON z.id = p.zamowienie_id
    WHERE julianday(z.utworzone_at) >= julianday(?) AND (
      p.oferta_id IN (SELECT produkt_id FROM produkty_sklepowe WHERE karta_id = ?)
      OR CAST(p.produkt_id AS TEXT) IN (SELECT produkt_id FROM produkty_sklepowe WHERE karta_id = ?))`)
    .all(granica, id, id).map((w) => Number(w.id));
  const zamowienia = [];
  for (const { zamowienie, pozycje } of zamowieniaOdGranicy(db, granica, { ids })) {
    const ilosc = zuzycieZZamowien([{ zamowienie, pozycje }], lustro).zuzycie.get(id) ?? 0;
    if (ilosc) zamowienia.push({ typ: 'zamowienie', zamowienie_id: zamowienie.id, numer: zamowienie.numer,
      sklep: zamowienie.sklep, ilosc: -ilosc, utworzono_at: zamowienie.utworzone_at });
  }
  return [...ruchy, ...zamowienia].sort((a, b) => String(b.utworzono_at).localeCompare(String(a.utworzono_at)));
}

/**
 * Ruch ręczny. Ten sam `klucz` drugi raz (podwójne kliknięcie, ponowione żądanie) — `{ dopisano: false }`, bez wyjątku.
 */
export function dodajRuch(db, { kartaId, rodzaj, ilosc, powod = null, klucz, konto = null, at = teraz() }) {
  if (!RODZAJE_RUCHU.includes(rodzaj)) throw new Error(`dodajRuch: nieznany rodzaj „${rodzaj}”`);
  if (!przelacznikStanow(db).wlaczone) throw new Error('Stany magazynowe są wyłączone — włącz je w Ustawieniach → Magazyn.');
  if (!db.prepare('SELECT 1 FROM karty_produktow WHERE id = ?').get(kartaId)) throw new Error(`Nie ma karty produktu ${kartaId}.`);
  const r = db.prepare(`INSERT INTO ruchy_magazynowe (karta_id, ilosc, rodzaj, powod, konto_id, konto_login, utworzono_at, klucz)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (klucz) DO NOTHING`)
    .run(kartaId, ilosc, rodzaj, powod, konto?.id ?? null, konto?.login ?? null, at, klucz);
  return { dopisano: Number(r.changes) === 1 };
}

/** Podgląd importu stanu otwarcia (bez zapisu). */
export function podgladImportuOtwarcia(db, tekst) {
  const { wlaczone, granica } = przelacznikStanow(db);
  if (!wlaczone) throw new Error('Stany magazynowe są wyłączone — włącz je w Ustawieniach → Magazyn.');
  const poSku = db.prepare("SELECT id, nazwa FROM karty_produktow WHERE UPPER(TRIM(sku)) = UPPER(TRIM(?)) AND TRIM(COALESCE(sku, '')) <> ''");
  const maOtwarcie = new Set(db.prepare(`SELECT DISTINCT karta_id FROM ruchy_magazynowe
    WHERE rodzaj = 'otwarcie' AND julianday(utworzono_at) >= julianday(?)`).all(granica).map((w) => Number(w.karta_id)));
  return planImportuOtwarcia(tekst, (sku) => poSku.get(sku) ?? null, maOtwarcie);
}

/**
 * Zapis importu w JEDNEJ transakcji. Klucz ruchu = otwarcie + karta + granica, więc ponowny import tego samego
 * pliku (albo drugie kliknięcie „Zapisz”) nie podwaja zapasu — liczy się od nowa i wraca jako `pominiete`.
 */
export function zapiszImportOtwarcia(db, tekst, { konto = null, at = teraz() } = {}) {
  const { granica } = przelacznikStanow(db);
  const plan = podgladImportuOtwarcia(db, tekst);
  db.exec('BEGIN IMMEDIATE');
  try {
    let zapisane = 0;
    for (const w of plan.doZapisu) {
      const { dopisano } = dodajRuch(db, { kartaId: w.karta_id, rodzaj: 'otwarcie', ilosc: w.ilosc, powod: 'import stanu otwarcia',
        klucz: `otwarcie:${w.karta_id}:${granica}`, konto, at });
      if (dopisano) zapisane += 1;
    }
    db.exec('COMMIT');
    return { zapisane, odrzucone: plan.odrzucone };
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}
