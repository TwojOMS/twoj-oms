// PRZ-108.07 (zmiana B planu automatyzacji): reguły automatyzacji i historia włączeń. Zapis reguły tworzy ją
// WYŁĄCZONĄ; włączenie ustawia granicę (chwila + migawka MAX(id)) i dopisuje historię w JEDNEJ transakcji. Wyłączenie
// działa od razu: zaplanowane wykonania tej reguły przechodzą w „pominięte: reguła wyłączona” w tej samej transakcji.
// Usunięcie jest miękkie (`usunieta_at`) — dziennik zostaje.
import { nowaGranica, zmianaPrzesuwaGranice } from '../../../domena/automatyzacje.js';
import { wTransakcji, wpisDoHistorii } from './wykonania.js';

const iso = (teraz) => teraz().toISOString();
const json = (w) => JSON.stringify(w ?? {});
function parsuj(tekst, domyslna = {}) {
  try { return JSON.parse(tekst ?? 'null') ?? domyslna; } catch { return domyslna; }
}

/** Migawka granicy: największe id tabel, z których rosną zdarzenia (zamówienia, przesyłki, faktury, proformy). */
export function migawkaGranicy(db) {
  const max = (tabela) => db.prepare(`SELECT COALESCE(MAX(id), 0) AS n FROM ${tabela}`).get().n;
  return { zamowienia: max('zamowienia'), przesylki: max('przesylki'), faktury: max('faktury'), proformy: max('proformy') };
}

/** Wiersz reguły z rozpakowanymi polami JSON (`warunki`, `zdarzenie_param`, `akcja_param`, `granica`). */
export function rozpakuj(w) {
  if (!w) return null;
  return { ...w, warunki: parsuj(w.warunki_json), zdarzenie_param: parsuj(w.zdarzenie_json),
    akcja_param: parsuj(w.akcja_json), granica: { at: w.granica_at, ...parsuj(w.granica_json) } };
}

export function wczytajRegule(db, id) {
  return db.prepare('SELECT * FROM automatyzacje_reguly WHERE id = ?').get(id) ?? null;
}
export const regulaRozpakowana = (db, id) => rozpakuj(wczytajRegule(db, id));

export function listaRegul(db) {
  return db.prepare('SELECT * FROM automatyzacje_reguly WHERE usunieta_at IS NULL ORDER BY id').all().map(rozpakuj);
}

/** Zależności szablonu dla modułu wiadomości: również wyłączone reguły, bez miękko usuniętych. */
export function regulyUzywajaceSzablonu(db, id) {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'automatyzacje_reguly'").get()) return [];
  return listaRegul(db).filter(r => r.akcja_param.szablon === id)
    .map(({ id, nazwa, wlaczona }) => ({ id, nazwa, wlaczona }));
}

/** Jedno SELECT — jedyne zapytanie przebiegu zegara, gdy żadna reguła nie jest włączona. */
export function czySaWlaczone(db) {
  return Boolean(db.prepare('SELECT 1 FROM automatyzacje_reguly WHERE wlaczona = 1 AND usunieta_at IS NULL LIMIT 1').get());
}

export function wlaczoneReguly(db) {
  return db.prepare('SELECT * FROM automatyzacje_reguly WHERE wlaczona = 1 AND usunieta_at IS NULL ORDER BY id').all().map(rozpakuj);
}

function dopiszPrzelaczenie(db, id, wlaczona, login, at) {
  db.prepare('INSERT INTO automatyzacje_przelaczenia (regula_id, wlaczona, konto_login, at) VALUES (?, ?, ?, ?)')
    .run(id, wlaczona ? 1 : 0, login ?? null, at);
}

export const POWOD_KANAL_ODZNACZONY = 'Kanał tego zamówienia został odznaczony w regule, zanim nadszedł termin.';

/** Nowa reguła — zawsze wyłączona (`wlaczona` z domyślnej 0 tabeli), bez granicy. Oddaje id. */
export function utworzRegule(db, r, { login = null, teraz = () => new Date() } = {}) {
  const at = iso(teraz);
  return wTransakcji(db, () => {
    const id = Number(db.prepare(`INSERT INTO automatyzacje_reguly (nazwa, zdarzenie, zdarzenie_json, warunki_json, akcja,
        akcja_json, opoznienie_min, limit_na_godzine, utworzona_at, zmieniona_at, zmienil_login)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(r.nazwa, r.zdarzenie, json(r.zdarzenie_json), json(r.warunki), r.akcja, json(r.akcja_json),
        r.opoznienie_min, r.limit_na_godzine, at, at, login).lastInsertRowid);
    dopiszPrzelaczenie(db, id, false, login, at);
    return id;
  });
}

/**
 * Edycja. Przy regule WŁĄCZONEJ zmiana zdarzenia albo warunków przesuwa granicę na chwilę zapisu (i zeruje kursor) —
 * rozszerzone warunki nie zgarną historii. Nazwa, szablon, limit i opóźnienie granicy nie ruszają.
 */
export function zmienRegule(db, id, r, { login = null, teraz = () => new Date() } = {}) {
  const at = iso(teraz);
  return wTransakcji(db, () => {
    const stara = regulaRozpakowana(db, id);
    if (!stara || stara.usunieta_at) return false;
    const przesun = stara.wlaczona === 1
      && zmianaPrzesuwaGranice({ ...stara, zdarzenie_json: stara.zdarzenie_param }, r);
    db.prepare(`UPDATE automatyzacje_reguly SET nazwa = ?, zdarzenie = ?, zdarzenie_json = ?, warunki_json = ?, akcja = ?,
        akcja_json = ?, opoznienie_min = ?, limit_na_godzine = ?, zmieniona_at = ?, zmienil_login = ? WHERE id = ?`)
      .run(r.nazwa, r.zdarzenie, json(r.zdarzenie_json), json(r.warunki), r.akcja, json(r.akcja_json),
        r.opoznienie_min, r.limit_na_godzine, at, login, id);
    // Kolejka wysyła bieżący szablon reguły — także ślad niepewnej wysyłki musi wskazywać ten sam szablon.
    db.prepare("UPDATE automatyzacje_wykonania SET szablon = ? WHERE regula_id = ? AND stan = 'zaplanowane'")
      .run(r.akcja_json?.szablon ?? null, id);
    if (przesun) {
      const g = nowaGranica(teraz(), migawkaGranicy(db));
      db.prepare('UPDATE automatyzacje_reguly SET granica_at = ?, granica_json = ?, kursor_json = NULL WHERE id = ?')
        .run(g.granica_at, json(g.granica_json), id);
    }
    // Recenzja 07, usterka 5: zaplanowane z kanałów, których reguła już nie obejmuje, nie wyjdą (wysyłacz sprawdza też
    // kanał przed rezerwacją — to tu daje od razu widoczny stan w dzienniku).
    const kanaly = new Set(r.warunki?.kanaly ?? []);
    const odznaczone = db.prepare(`SELECT w.id, w.zamowienie_id, z.sklep FROM automatyzacje_wykonania w
      LEFT JOIN zamowienia z ON z.id = w.zamowienie_id WHERE w.regula_id = ? AND w.stan = 'zaplanowane'`).all(id)
      .filter((w) => !kanaly.has(w.sklep));
    for (const w of odznaczone) {
      if (db.prepare(`UPDATE automatyzacje_wykonania SET stan = 'pominiete', powod = ?, powod_kod = 'kanal_odznaczony',
        zakonczone_at = ? WHERE id = ? AND stan = 'zaplanowane'`).run(POWOD_KANAL_ODZNACZONY, at, w.id).changes === 1) {
        wpisDoHistorii(db, { zamowienie_id: w.zamowienie_id, stan: 'pominiete', nazwa: r.nazwa, powod: POWOD_KANAL_ODZNACZONY });
      }
    }
    return true;
  });
}

/** Włączenie: granica (chwila + migawka MAX(id)), zerowy kursor, zdjęte wstrzymanie i wpis w historii — razem. */
export function wlaczRegule(db, id, { login = null, teraz = () => new Date() } = {}) {
  return wTransakcji(db, () => {
    const g = nowaGranica(teraz(), migawkaGranicy(db));
    // Tylko reguła WYŁĄCZONA (recenzja 07, usterka 7): „Włącz” ze starej karty na regule włączonej i wstrzymanej nie może
    // zdjąć wstrzymania ani przesunąć granicy bez decyzji o zaległych. 0 zmienionych wierszy = nic się nie dzieje.
    const zmienione = db.prepare(`UPDATE automatyzacje_reguly SET wlaczona = 1, granica_at = ?, granica_json = ?, kursor_json = NULL,
      wstrzymana_powod = NULL, zmieniona_at = ?, zmienil_login = ? WHERE id = ? AND wlaczona = 0 AND usunieta_at IS NULL`)
      .run(g.granica_at, json(g.granica_json), g.granica_at, login, id).changes === 1;
    if (zmienione) dopiszPrzelaczenie(db, id, true, login, g.granica_at);
    return zmienione;
  });
}

/** Zaplanowane wykonania reguły → pominięte z powodem (z wpisem w historii każdego zamówienia). */
function pominZaplanowane(db, r, { powod, powod_kod, at }) {
  const zaplanowane = db.prepare("SELECT id, zamowienie_id FROM automatyzacje_wykonania WHERE regula_id = ? AND stan = 'zaplanowane'").all(r.id);
  for (const w of zaplanowane) {
    db.prepare(`UPDATE automatyzacje_wykonania SET stan = 'pominiete', powod = ?, powod_kod = ?, zakonczone_at = ?
      WHERE id = ? AND stan = 'zaplanowane'`).run(powod, powod_kod, at, w.id);
    wpisDoHistorii(db, { zamowienie_id: w.zamowienie_id, stan: 'pominiete', nazwa: r.nazwa, powod });
  }
  return zaplanowane.length;
}

export const POWOD_WYLACZONA = 'Reguła została wyłączona, zanim nadszedł termin.';

/** Wyłączenie działa od razu: zaplanowane tej reguły nie wyjdą. Ponowne włączenie liczy od nowa (nowa granica). */
export function wylaczRegule(db, id, { login = null, teraz = () => new Date(), usun = false } = {}) {
  const at = iso(teraz);
  return wTransakcji(db, () => {
    const r = wczytajRegule(db, id);
    if (!r || r.usunieta_at) return false;
    db.prepare(`UPDATE automatyzacje_reguly SET wlaczona = 0, zmieniona_at = ?, zmienil_login = ?${usun ? ', usunieta_at = ?' : ''}
      WHERE id = ?`).run(...(usun ? [at, login, at, id] : [at, login, id]));
    if (r.wlaczona === 1) dopiszPrzelaczenie(db, id, false, login, at);
    pominZaplanowane(db, r, { powod: usun ? 'Reguła została usunięta.' : POWOD_WYLACZONA, powod_kod: 'regula_wylaczona', at });
    return true;
  });
}

export const usunRegule = (db, id, o = {}) => wylaczRegule(db, id, { ...o, usun: true });

/** Bezpiecznik: reguła wstrzymana — nic nie wykrywa i nic nie wysyła, dopóki admin nie zdecyduje o zaległych. */
export function wstrzymajRegule(db, id, powod) {
  db.prepare('UPDATE automatyzacje_reguly SET wstrzymana_powod = ? WHERE id = ?').run(powod, id);
}

/** „Wyślij zaległe”: zdjęcie wstrzymania — zaplanowane idą z limitami godzinowymi (i 48 h od terminu). */
export function wyslijZalegle(db, id, { login = null, teraz = () => new Date() } = {}) {
  return db.prepare(`UPDATE automatyzacje_reguly SET wstrzymana_powod = NULL, zmieniona_at = ?, zmienil_login = ?
    WHERE id = ? AND usunieta_at IS NULL`).run(iso(teraz), login, id).changes === 1;
}

/** „Pomiń zaległe”: wszystkie zaplanowane → pominięte, wstrzymanie zdjęte. */
export function pominZalegle(db, id, { login = null, teraz = () => new Date() } = {}) {
  const at = iso(teraz);
  return wTransakcji(db, () => {
    const r = wczytajRegule(db, id);
    if (!r || r.usunieta_at) return false;
    pominZaplanowane(db, r, { powod: `Zaległe pominięte ręcznie (${login ?? 'administrator'}).`, powod_kod: 'pominiete_recznie', at });
    db.prepare('UPDATE automatyzacje_reguly SET wstrzymana_powod = NULL, zmieniona_at = ?, zmienil_login = ? WHERE id = ?')
      .run(at, login, id);
    return true;
  });
}

/** Kursor reguły: `{ at }` albo `{ at, od, po: { at, id } }` (domena/automatyzacje.js, nowyKursor). */
export function zapiszKursor(db, id, kursor) {
  db.prepare('UPDATE automatyzacje_reguly SET kursor_json = ? WHERE id = ?').run(JSON.stringify(kursor), id);
}

export function przelaczeniaReguly(db, id) {
  return db.prepare('SELECT * FROM automatyzacje_przelaczenia WHERE regula_id = ? ORDER BY at DESC, id DESC').all(id);
}

export const STANY_FILTRA = Object.freeze({
  wyslane: ['wyslane'], pominiete: ['pominiete'], zaplanowane: ['zaplanowane', 'w_toku'], bledy: ['blad', 'niepewne'],
});

/** Dziennik reguły: ostatnie 200 wykonań, opcjonalnie tylko jednego rodzaju (filtr ekranu). */
export function wykonaniaReguly(db, id, { stan = null, limit = 200 } = {}) {
  const stany = STANY_FILTRA[stan] ?? null;
  const warunek = stany ? ` AND w.stan IN (${stany.map(() => '?').join(',')})` : '';
  return db.prepare(`SELECT w.*, z.numer AS numer_zamowienia FROM automatyzacje_wykonania w
    LEFT JOIN zamowienia z ON z.id = w.zamowienie_id
    WHERE w.regula_id = ?${warunek} ORDER BY COALESCE(w.zakonczone_at, w.wykryte_at) DESC, w.id DESC LIMIT ?`)
    .all(id, ...(stany ?? []), limit);
}

/** Ile wykonań reguły czeka w kolejce — przycisk „Wyślij zaległe (N)”. */
export function zaleglychReguly(db, id) {
  return db.prepare("SELECT COUNT(*) AS n FROM automatyzacje_wykonania WHERE regula_id = ? AND stan = 'zaplanowane'").get(id).n;
}

/** Liczby do kolumny „Ostatnie 7 dni” listy reguł (i zaległe zaplanowane). */
export function liczbyRegul(db, od) {
  const wynik = new Map();
  for (const w of db.prepare(`SELECT regula_id, stan, COUNT(*) AS n FROM automatyzacje_wykonania
    WHERE stan = 'zaplanowane' OR zakonczone_at >= ? GROUP BY regula_id, stan`).all(od)) {
    const r = wynik.get(w.regula_id) ?? {};
    r[w.stan] = w.n;
    wynik.set(w.regula_id, r);
  }
  return wynik;
}

/** Zapytanie ostrzeżeń (eksport dla testu planu zapytania): 4 × `od`. */
export const SQL_OSTRZEZEN = `SELECT r.id, r.nazwa, CASE WHEN r.wlaczona = 1 THEN r.wstrzymana_powod END AS wstrzymana_powod, r.zmieniona_at,
      (SELECT COUNT(*) FROM automatyzacje_wykonania w WHERE w.regula_id = r.id AND w.stan = 'zaplanowane') AS zalegle,
      (SELECT COUNT(*) FROM automatyzacje_wykonania w WHERE w.regula_id = r.id AND w.stan = 'niepewne' AND w.zakonczone_at >= ?) AS niepewne,
      (SELECT COUNT(*) FROM automatyzacje_wykonania w WHERE w.regula_id = r.id AND w.stan = 'blad' AND w.zakonczone_at >= ?) AS blad,
      (SELECT MAX(w.id) FROM automatyzacje_wykonania w WHERE w.regula_id = r.id AND w.stan IN ('niepewne', 'blad') AND w.zakonczone_at >= ?) AS ostatni_id
    FROM automatyzacje_reguly r WHERE r.usunieta_at IS NULL
      AND ((r.wlaczona = 1 AND r.wstrzymana_powod IS NOT NULL) OR EXISTS (SELECT 1 FROM automatyzacje_wykonania w
        WHERE w.regula_id = r.id AND w.stan IN ('niepewne', 'blad') AND w.zakonczone_at >= ?))
    ORDER BY r.id`;

/**
 * PRZ-108.08: reguły z kłopotem do tabelki ostrzeżeń na stronie głównej (tylko admin): włączone i wstrzymane albo
 * z wykonaniami `niepewne` / `blad` zakończonymi od `od`. Baza bez modułu automatyzacji (wąski skład) → pusta lista.
 */
export function regulyDoOstrzezen(db, od) {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'automatyzacje_reguly'").get()) return [];
  return db.prepare(SQL_OSTRZEZEN).all(od, od, od, od);
}
