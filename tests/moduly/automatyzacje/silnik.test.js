// PRZ-108.07 (zmiana B planu automatyzacji, właściciel 21.10): silnik reguł na SZTUCZNYM zdarzeniu `test_zdarzenie`
// (zamówienie z `wyslane_at` po granicy id) i SZTUCZNEJ akcji z licznikiem. Prawdziwe zdarzenia i mail to zmiana C1 —
// w B rejestry są puste, więc ten plik jest jedynym miejscem, w którym silnik cokolwiek wykonuje.
// Numery w opisach = numery testów z planu (sekcja 8, „B. Testy najpierw”).
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { otworzBaze } from '../../../src/core/baza.ts';
import { MODULY, modulyDla } from '../../../src/moduly/lista.ts';
import { zbudujOms } from '../../pomoc/zbuduj-oms.ts';
import { kolejnoscBudowy } from '../../../src/core/sprawdz-moduly.ts';
import { createSilnikAutomatyzacji, symulujRegule } from '../../../src/moduly/automatyzacje/services/silnik.js';
import { zegarAutomatyzacji, ODSTEP_AUTOMATYZACJI_MS } from '../../../src/moduly/automatyzacje/zegary.ts';
import {
  utworzRegule, wlaczRegule, wylaczRegule, zmienRegule, wczytajRegule, wyslijZalegle, pominZalegle,
} from '../../../src/moduly/automatyzacje/db/reguly.js';

const otwarte = [];
afterEach(() => { for (const db of otwarte.splice(0)) { try { db.close(); } catch { /* już zamknięta */ } } });

function baza(sciezka = ':memory:') {
  const db = openOmsDb(sciezka, { moduly: kolejnoscBudowy(MODULY) });
  otwarte.push(db);
  return db;
}
const T0 = Date.parse('2026-10-21T10:00:00.000Z');
const MIN = 60_000;
const iso = (ms) => new Date(ms).toISOString();
function zegar(start = T0) {
  let ms = start;
  return { teraz: () => new Date(ms), ustaw: (m) => { ms = m; }, przesun: (o) => { ms += o; }, ms: () => ms };
}
const zmiany = (db) => db.prepare('SELECT total_changes() AS n').get().n;

let kolejny = 0;
function zamowienie(db, { sklep = 'sklep', wyslane = null, utworzone = '2026-10-21T08:00:00' } = {}) {
  kolejny += 1;
  return Number(db.prepare(`INSERT INTO zamowienia (sklep, zrodlo_id, numer, kwota_brutto, utworzone_at, wyslane_at)
    VALUES (?,?,?,?,?,?)`).run(sklep, kolejny, `T-${kolejny}`, '10.00', utworzone, wyslane).lastInsertRowid);
}
const wyslij = (db, id, ms) => db.prepare('UPDATE zamowienia SET wyslane_at = ? WHERE id = ?').run(iso(ms), id);

/** Sztuczne zdarzenie: zamówienie z `wyslane_at`, id powyżej migawki granicy, od `od` (kursor z zakładką). */
function zdarzenieTestowe() {
  const wywolania = [];
  return {
    klucz: 'test_zdarzenie', etykieta: 'Zdarzenie testowe', grupa: 'zamowienie', opis: 'tylko testy',
    wywolania,
    // Kontrakt (zdarzenia/index.js): rosnąco po (zdarzenie_at, id), od `od`, ściśle po kursorze złożonym `po`.
    kandydaci(db, { granica, od, po = null, limit }) {
      const wiersze = db.prepare(`SELECT id, id AS zamowienie_id, sklep, wyslane_at AS zdarzenie_at FROM zamowienia
        WHERE id > ? AND wyslane_at IS NOT NULL AND wyslane_at >= ?
          AND (? IS NULL OR wyslane_at > ? OR (wyslane_at = ? AND id > ?))
        ORDER BY wyslane_at, id LIMIT ?`)
        .all(granica.zamowienia, od, po?.at ?? null, po?.at ?? null, po?.at ?? null, po?.id ?? 0, limit);
      wywolania.push({ od, wierszy: wiersze.length });
      return wiersze;
    },
    symulacja(db, od) {
      return db.prepare(`SELECT id AS zamowienie_id, sklep, wyslane_at AS zdarzenie_at FROM zamowienia
        WHERE wyslane_at IS NOT NULL AND wyslane_at >= ? ORDER BY wyslane_at, id`).all(od);
    },
  };
}
/** Sztuczna akcja: licznik wywołań; tryb ustawiany w teście (ok, błąd z kodem, wisi bez końca). */
function akcjaTestowa() {
  const a = {
    klucz: 'test_akcja', etykieta: 'Akcja testowa', wymagaPoczty: true, szablon: true,
    wywolania: [], tryb: 'ok',
    async wykonaj({ wykonanie }) {
      a.wywolania.push(wykonanie.zamowienie_id);
      if (a.tryb === 'wisi') return new Promise(() => {});
      if (a.tryb !== 'ok') throw Object.assign(new Error(`poczta: ${a.tryb}`), a.tryb === 'bez-kodu' ? {} : { code: a.tryb });
      return { adresat: `kupujacy-${wykonanie.zamowienie_id}@example.invalid` };
    },
  };
  return a;
}
const REGULA = (o = {}) => ({ nazwa: 'Reguła testowa', zdarzenie: 'test_zdarzenie', zdarzenie_json: {},
  warunki: { kanaly: ['sklep'], kanalyZnane: ['sklep', 'allegro', 'reczne', 'indywidualne'] },
  akcja: 'test_akcja', akcja_json: { szablon: 'wlasny-1' }, opoznienie_min: 0, limit_na_godzine: 20, ...o });

function srodowisko({ db = baza(), poczta = true, sprawdzWarunki } = {}) {
  const z = zegar();
  const zdarzenie = zdarzenieTestowe();
  const akcja = akcjaTestowa();
  const logi = [];
  const silnik = (o = {}) => createSilnikAutomatyzacji({ db, zdarzenia: [zdarzenie], akcje: [akcja],
    pocztaGotowa: () => poczta, teraz: z.teraz, log: (...t) => logi.push(t.join(' ')), sprawdzWarunki, ...o });
  return { db, z, zdarzenie, akcja, logi, silnik, s: silnik(), sprawdzWarunki };
}
const regula = (e, o) => utworzRegule(e.db, REGULA(o), { login: 'adam', teraz: e.z.teraz });
const wlacz = (e, id) => wlaczRegule(e.db, id, { login: 'adam', teraz: e.z.teraz });
const wykonania = (db) => db.prepare('SELECT * FROM automatyzacje_wykonania ORDER BY id').all();
const stany = (db) => wykonania(db).map((w) => w.stan);

describe('1. migracja', () => {
  it('przechodzi przez strażnika addytywności na bazie z wszystkimi modułami; UNIQUE (regula_id, przedmiot)', () => {
    const db = baza();
    expect(db.prepare("SELECT 1 FROM migracje WHERE modul = 'automatyzacje' AND numer = 1").get()).toBeTruthy();
    const unikalne = db.prepare("SELECT name FROM pragma_index_list('automatyzacje_wykonania') WHERE \"unique\" = 1").all();
    const kolumny = unikalne.map((i) => db.prepare(`SELECT name FROM pragma_index_info('${i.name}')`).all().map((k) => k.name).join(','));
    expect(kolumny).toContain('regula_id,przedmiot');
  });
  it('strażnik migracji (scripts/straznik-migracji.mjs) daje 0', () => {
    const r = spawnSync(process.execPath, ['scripts/straznik-migracji.mjs'], { encoding: 'utf8' });
    expect(r.stdout + r.stderr).toBe('');
    expect(r.status).toBe(0);
  });
});

describe('2–3. zero reguł / reguła wyłączona → zero zapisów', () => {
  it('2. brak reguł: przebieg nie zmienia ani jednego wiersza (total_changes) i nie woła akcji', async () => {
    const e = srodowisko();
    zamowienie(e.db, { wyslane: iso(T0 + MIN) });
    const przed = zmiany(e.db);
    const wynik = await e.s.przebieg();
    await e.s.przebieg();
    expect(zmiany(e.db)).toBe(przed);
    expect(wynik).toMatchObject({ wlaczonych: 0 });
    expect(e.akcja.wywolania).toEqual([]);
    expect(e.zdarzenie.wywolania).toEqual([]);
  });
  it('3. reguła wyłączona przy kandydatach: nic, zero zapisów', async () => {
    const e = srodowisko();
    const id = regula(e);
    wlacz(e, id);
    wylaczRegule(e.db, id, { login: 'adam', teraz: e.z.teraz });
    e.z.przesun(MIN);
    zamowienie(e.db, { wyslane: iso(e.z.ms()) });
    const przed = zmiany(e.db);
    e.z.przesun(MIN);
    await e.s.przebieg();
    expect(zmiany(e.db)).toBe(przed);
    expect(e.akcja.wywolania).toEqual([]);
  });
});

describe('4. granica (migawka MAX(id), nie data ze sklepu)', () => {
  it('kandydat sprzed włączenia → 0; nowe zamówienie z cofniętą datą sklepu po włączeniu → 1', async () => {
    const e = srodowisko();
    const stare = zamowienie(e.db);
    // Zaimportowane przed włączeniem, ale kupione wcześniej (data sklepu wstecz): najwyższe id, nie najnowsza data.
    const stareZImportu = zamowienie(e.db, { utworzone: '2026-10-15T09:00:00' });
    const id = regula(e);
    wlacz(e, id);
    e.z.przesun(MIN);
    wyslij(e.db, stare, e.z.ms()); // zdarzenia na zamówieniach sprzed włączenia — poza granicą id
    wyslij(e.db, stareZImportu, e.z.ms());
    const nowe = zamowienie(e.db, { utworzone: '2026-10-18T09:00:00', wyslane: iso(e.z.ms()) }); // Woo date_created wstecz
    e.z.przesun(MIN);
    await e.s.przebieg();
    expect(wykonania(e.db).map((w) => w.zamowienie_id)).toEqual([nowe]);
    expect(e.akcja.wywolania).toEqual([nowe]);
  });
  it('wyłączenie i ponowne włączenie przesuwa granicę: zdarzenia z przerwy nie wchodzą', async () => {
    const e = srodowisko();
    const id = regula(e);
    wlacz(e, id);
    wylaczRegule(e.db, id, { login: 'adam', teraz: e.z.teraz });
    e.z.przesun(MIN);
    zamowienie(e.db, { wyslane: iso(e.z.ms()) }); // w przerwie
    e.z.przesun(MIN);
    wlacz(e, id);
    e.z.przesun(MIN);
    await e.s.przebieg();
    expect(wykonania(e.db)).toEqual([]);
    const po = zamowienie(e.db, { wyslane: iso(e.z.ms()) });
    e.z.przesun(MIN);
    await e.s.przebieg();
    expect(e.akcja.wywolania).toEqual([po]);
  });
});

describe('5. deduplikacja', () => {
  it('dwa przebiegi z rzędu → 1 wykonanie, akcja raz', async () => {
    const e = srodowisko();
    wlacz(e, regula(e));
    zamowienie(e.db, { wyslane: iso(T0 + MIN) });
    e.z.przesun(2 * MIN);
    await e.s.przebieg();
    e.z.przesun(MIN);
    await e.s.przebieg();
    expect(stany(e.db)).toEqual(['wyslane']);
    expect(e.akcja.wywolania).toHaveLength(1);
  });
  it('dwa równoległe przebiegi dwóch instancji (warunki sprawdzane asynchronicznie) → akcja raz', async () => {
    const e = srodowisko({ sprawdzWarunki: async () => { await new Promise((r) => setImmediate(r)); return { ok: true }; } });
    wlacz(e, regula(e));
    zamowienie(e.db, { wyslane: iso(T0 + MIN) });
    e.z.przesun(2 * MIN);
    const drugi = e.silnik();
    await Promise.all([e.s.przebieg(), drugi.przebieg()]);
    expect(e.akcja.wywolania).toHaveLength(1);
    expect(stany(e.db)).toEqual(['wyslane']);
  });
  it('„restart” — nowa instancja silnika na tej samej bazie (plik) → dalej 1', async () => {
    const plik = join(mkdtempSync(join(tmpdir(), 'prz108-07-')), 'oms.sqlite');
    const e = srodowisko({ db: baza(plik) });
    wlacz(e, regula(e));
    zamowienie(e.db, { wyslane: iso(T0 + MIN) });
    e.z.przesun(2 * MIN);
    await e.s.przebieg();
    const db2 = otworzBaze(plik);
    otwarte.push(db2);
    const po = e.silnik({ db: db2 });
    po.poStarcie();
    e.z.przesun(MIN);
    await po.przebieg();
    expect(e.akcja.wywolania).toHaveLength(1);
    expect(stany(db2)).toEqual(['wyslane']);
  });
});

describe('6. rezerwacja i restart', () => {
  it('akcja „wisi” (proces pada w trakcie) → po starcie w_toku → niepewne, kolejne przebiegi nie wysyłają', async () => {
    const e = srodowisko();
    wlacz(e, regula(e));
    const zid = zamowienie(e.db, { wyslane: iso(T0 + MIN) });
    e.z.przesun(2 * MIN);
    e.akcja.tryb = 'wisi';
    void e.s.przebieg();
    await new Promise((r) => setImmediate(r));
    expect(stany(e.db)).toEqual(['w_toku']);
    e.akcja.tryb = 'ok';
    const po = e.silnik();
    po.poStarcie();
    expect(stany(e.db)).toEqual(['niepewne']);
    const wpis = e.db.prepare("SELECT akcja, wynik FROM log WHERE zamowienie_id = ? AND akcja LIKE 'automatyzacja.%'").get(zid);
    expect(wpis.akcja).toBe('automatyzacja.niepewna');
    for (let i = 0; i < 3; i += 1) { e.z.przesun(MIN); await po.przebieg(); }
    expect(e.akcja.wywolania).toHaveLength(1);
    expect(stany(e.db)).toEqual(['niepewne']);
  });
  // Recenzja 07, runda 2 (R2-1): jednorazowy wyjątek w pierwszym `poStarcie` (np. zablokowana baza) nie może
  // zostawić `w_toku` do następnego restartu — kolejny przebieg próbuje jeszcze raz.
  it('wyjątek w poStarcie przy pierwszym przebiegu → następny przebieg ponawia, w_toku → niepewne', async () => {
    const e = srodowisko();
    wlacz(e, regula(e));
    zamowienie(e.db, { wyslane: iso(T0 + MIN) });
    e.z.przesun(2 * MIN);
    e.akcja.tryb = 'wisi';
    void e.s.przebieg();
    await new Promise((r) => setImmediate(r));
    expect(stany(e.db)).toEqual(['w_toku']);
    let raz = true;
    const zablokowana = new Proxy(e.db, { get(t, p) {
      if (p === 'prepare') return (sql) => {
        if (raz && sql.includes("w.stan = 'w_toku'")) { raz = false; throw new Error('database is locked'); }
        return t.prepare(sql);
      };
      const v = t[p];
      return typeof v === 'function' ? v.bind(t) : v;
    } });
    const po = e.silnik({ db: zablokowana });
    await expect(po.przebieg()).rejects.toThrow('database is locked');
    e.z.przesun(MIN);
    await po.przebieg();
    expect(stany(e.db)).toEqual(['niepewne']);
  });
  it('poStarcie bez wiszących wykonań nic nie zapisuje', () => {
    const e = srodowisko();
    const przed = zmiany(e.db);
    e.s.poStarcie();
    expect(zmiany(e.db)).toBe(przed);
  });
});

describe('7. poczta', () => {
  it('EAUTH (przed MAIL FROM) → zaplanowane, proby=1, ponowienie za 15 min; po 3 próbach błąd z wpisem', async () => {
    const e = srodowisko();
    wlacz(e, regula(e));
    const zid = zamowienie(e.db, { wyslane: iso(T0 + MIN) });
    e.z.przesun(2 * MIN);
    e.akcja.tryb = 'EAUTH';
    await e.s.przebieg();
    let w = wykonania(e.db)[0];
    expect(w).toMatchObject({ stan: 'zaplanowane', proby: 1, nastepna_proba_at: iso(e.z.ms() + 15 * MIN) });
    e.z.przesun(10 * MIN);
    await e.s.przebieg();
    expect(e.akcja.wywolania).toHaveLength(1); // przed ponowieniem nic
    e.z.przesun(6 * MIN);
    await e.s.przebieg();
    expect(wykonania(e.db)[0]).toMatchObject({ stan: 'zaplanowane', proby: 2 });
    e.z.przesun(16 * MIN);
    await e.s.przebieg();
    w = wykonania(e.db)[0];
    expect(w).toMatchObject({ stan: 'blad', proby: 3 });
    expect(e.akcja.wywolania).toHaveLength(3);
    e.z.przesun(16 * MIN);
    await e.s.przebieg();
    expect(e.akcja.wywolania).toHaveLength(3);
    expect(e.db.prepare("SELECT akcja FROM log WHERE zamowienie_id = ? AND akcja = 'automatyzacja.blad'").get(zid)).toBeTruthy();
  });
  it.each(['ECONNECTION', 'ESOCKET', 'bez-kodu'])('%s → niepewne, bez ponowienia', async (tryb) => {
    const e = srodowisko();
    wlacz(e, regula(e));
    zamowienie(e.db, { wyslane: iso(T0 + MIN) });
    e.z.przesun(2 * MIN);
    e.akcja.tryb = tryb;
    await e.s.przebieg();
    expect(wykonania(e.db)[0]).toMatchObject({ stan: 'niepewne', proby: 0 });
    e.z.przesun(30 * MIN);
    await e.s.przebieg();
    expect(e.akcja.wywolania).toHaveLength(1);
  });
  it('brak poczty → pominięte „brak poczty wychodzącej” z wpisem w dzienniku zamówienia, akcja 0 razy', async () => {
    const e = srodowisko({ poczta: false });
    wlacz(e, regula(e));
    const zid = zamowienie(e.db, { wyslane: iso(T0 + MIN) });
    e.z.przesun(2 * MIN);
    await e.s.przebieg();
    expect(wykonania(e.db)[0]).toMatchObject({ stan: 'pominiete', powod_kod: 'brak_poczty' });
    const wpis = e.db.prepare("SELECT wynik FROM log WHERE zamowienie_id = ? AND akcja = 'automatyzacja.pominieta'").get(zid);
    expect(wpis.wynik).toContain('brak poczty wychodzącej');
    expect(wpis.wynik).toContain('Reguła testowa');
    expect(e.akcja.wywolania).toEqual([]);
  });
});

describe('8. limity', () => {
  it('25 kandydatów przy limicie 20/h → 20 wysłane, 5 zaplanowane; godzinę później reszta', async () => {
    const e = srodowisko();
    wlacz(e, regula(e, { limit_na_godzine: 20 }));
    for (let i = 0; i < 25; i += 1) zamowienie(e.db, { wyslane: iso(T0 + MIN) });
    e.z.przesun(2 * MIN);
    await e.s.przebieg();
    expect(stany(e.db).filter((s) => s === 'wyslane')).toHaveLength(20);
    expect(stany(e.db).filter((s) => s === 'zaplanowane')).toHaveLength(5);
    e.z.przesun(30 * MIN);
    await e.s.przebieg();
    expect(e.akcja.wywolania).toHaveLength(20);
    e.z.przesun(30 * MIN + 1000);
    await e.s.przebieg();
    expect(stany(e.db).filter((s) => s === 'wyslane')).toHaveLength(25);
  });
  it('limit OMS-u 100/h obejmuje wszystkie reguły razem', async () => {
    const e = srodowisko();
    for (let r = 0; r < 3; r += 1) wlacz(e, regula(e, { nazwa: `R${r}`, limit_na_godzine: 200 }));
    for (let i = 0; i < 40; i += 1) zamowienie(e.db, { wyslane: iso(T0 + MIN) });
    e.z.przesun(2 * MIN);
    await e.s.przebieg();
    expect(e.akcja.wywolania).toHaveLength(100);
    expect(stany(e.db).filter((s) => s === 'zaplanowane')).toHaveLength(20);
  });
});

describe('9. bezpiecznik: więcej niż 50 naraz', () => {
  it('51 kandydatów → reguła wstrzymana z powodem, akcja 0 razy; „Wyślij zaległe” zdejmuje wstrzymanie', async () => {
    const e = srodowisko();
    const id = regula(e, { limit_na_godzine: 200 });
    wlacz(e, id);
    for (let i = 0; i < 51; i += 1) zamowienie(e.db, { wyslane: iso(T0 + MIN) });
    e.z.przesun(2 * MIN);
    await e.s.przebieg();
    expect(wczytajRegule(e.db, id).wstrzymana_powod).toContain('51');
    expect(e.akcja.wywolania).toEqual([]);
    expect(stany(e.db).filter((s) => s === 'zaplanowane')).toHaveLength(51);
    e.z.przesun(MIN);
    await e.s.przebieg();
    expect(e.akcja.wywolania).toEqual([]);
    wyslijZalegle(e.db, id, { login: 'adam', teraz: e.z.teraz });
    e.z.przesun(MIN);
    await e.s.przebieg();
    expect(e.akcja.wywolania).toHaveLength(51);
  });
  it('50 kandydatów → bez wstrzymania; „Pomiń zaległe” przy wstrzymaniu pomija wszystkie zaplanowane', async () => {
    const e = srodowisko();
    const id = regula(e, { limit_na_godzine: 200 });
    wlacz(e, id);
    for (let i = 0; i < 50; i += 1) zamowienie(e.db, { wyslane: iso(T0 + MIN) });
    e.z.przesun(2 * MIN);
    await e.s.przebieg();
    expect(wczytajRegule(e.db, id).wstrzymana_powod).toBeNull();
    expect(e.akcja.wywolania).toHaveLength(50);
    for (let i = 0; i < 60; i += 1) zamowienie(e.db, { wyslane: iso(e.z.ms()) });
    e.z.przesun(MIN);
    await e.s.przebieg();
    expect(wczytajRegule(e.db, id).wstrzymana_powod).toBeTruthy();
    pominZalegle(e.db, id, { login: 'adam', teraz: e.z.teraz });
    expect(wczytajRegule(e.db, id).wstrzymana_powod).toBeNull();
    expect(stany(e.db).filter((s) => s === 'pominiete')).toHaveLength(60);
    e.z.przesun(MIN);
    await e.s.przebieg();
    expect(e.akcja.wywolania).toHaveLength(50);
  });
});

describe('10–11. przeterminowanie i opóźnienie', () => {
  it('10. termin starszy niż 48 h (OMS stał dwa dni) → pominięte „przeterminowane”, akcja 0 razy', async () => {
    const e = srodowisko();
    wlacz(e, regula(e));
    zamowienie(e.db, { wyslane: iso(T0 + MIN) });
    e.z.ustaw(T0 + 49 * 60 * MIN);
    await e.s.przebieg();
    expect(wykonania(e.db)[0]).toMatchObject({ stan: 'pominiete', powod_kod: 'przeterminowane' });
    expect(e.akcja.wywolania).toEqual([]);
  });
  it('11. opóźnienie 30 min: nic przed terminem, wysyłka po nim', async () => {
    const e = srodowisko();
    wlacz(e, regula(e, { opoznienie_min: 30 }));
    zamowienie(e.db, { wyslane: iso(T0 + MIN) });
    e.z.przesun(10 * MIN);
    await e.s.przebieg();
    expect(wykonania(e.db)[0]).toMatchObject({ stan: 'zaplanowane', termin_at: iso(T0 + 31 * MIN) });
    e.z.ustaw(T0 + 31 * MIN - 1000);
    await e.s.przebieg();
    expect(e.akcja.wywolania).toEqual([]);
    e.z.ustaw(T0 + 31 * MIN);
    await e.s.przebieg();
    expect(e.akcja.wywolania).toHaveLength(1);
  });
  it('18. opóźnienie 7 dni (10 080 min) → wysyłka po 7 dniach, NIE „przeterminowane” (48 h od terminu)', async () => {
    const e = srodowisko();
    wlacz(e, regula(e, { opoznienie_min: 10080 }));
    zamowienie(e.db, { wyslane: iso(T0 + MIN) });
    e.z.przesun(2 * MIN);
    await e.s.przebieg();
    e.z.ustaw(T0 + MIN + 10080 * MIN - 1000);
    await e.s.przebieg();
    expect(e.akcja.wywolania).toEqual([]);
    e.z.ustaw(T0 + 2 * MIN + 10080 * MIN);
    await e.s.przebieg();
    expect(stany(e.db)).toEqual(['wyslane']);
    expect(e.akcja.wywolania).toHaveLength(1);
  });
});

describe('12. edycja reguły włączonej', () => {
  it('zmiana kanałów przesuwa granicę na chwilę zapisu; zmiana nazwy nie', () => {
    const e = srodowisko();
    const id = regula(e);
    wlacz(e, id);
    const przed = wczytajRegule(e.db, id);
    e.z.przesun(5 * MIN);
    zamowienie(e.db);
    zmienRegule(e.db, id, REGULA({ nazwa: 'Inna nazwa' }), { login: 'ewa', teraz: e.z.teraz });
    expect(wczytajRegule(e.db, id)).toMatchObject({ granica_at: przed.granica_at, granica_json: przed.granica_json, nazwa: 'Inna nazwa' });
    e.z.przesun(5 * MIN);
    zmienRegule(e.db, id, REGULA({ warunki: { kanaly: ['sklep', 'allegro'], kanalyZnane: ['sklep', 'allegro'] } }), { login: 'ewa', teraz: e.z.teraz });
    const po = wczytajRegule(e.db, id);
    expect(po.granica_at).toBe(iso(e.z.ms()));
    expect(JSON.parse(po.granica_json).zamowienia).toBeGreaterThan(JSON.parse(przed.granica_json).zamowienia);
    expect(po.zmienil_login).toBe('ewa');
  });
  it('edycja reguły wyłączonej nie ustawia granicy (ustawi ją włączenie)', () => {
    const e = srodowisko();
    const id = regula(e);
    zmienRegule(e.db, id, REGULA({ zdarzenie_json: { status: 'x' } }), { login: 'ewa', teraz: e.z.teraz });
    expect(wczytajRegule(e.db, id).granica_at).toBeNull();
  });
  it('wyłączenie od razu pomija zaplanowane tej reguły („reguła wyłączona”), z wpisem', async () => {
    const e = srodowisko();
    const id = regula(e, { opoznienie_min: 30 });
    wlacz(e, id);
    zamowienie(e.db, { wyslane: iso(T0 + MIN) });
    e.z.przesun(2 * MIN);
    await e.s.przebieg();
    wylaczRegule(e.db, id, { login: 'adam', teraz: e.z.teraz });
    expect(wykonania(e.db)[0]).toMatchObject({ stan: 'pominiete', powod_kod: 'regula_wylaczona' });
    e.z.przesun(60 * MIN);
    await e.s.przebieg();
    expect(e.akcja.wywolania).toEqual([]);
  });
});

describe('14. nowy kanał domyślnie odznaczony', () => {
  it('reguła zapisana przy {sklep, allegro}; zamówienie z kanału dodanego później → brak wykonania', async () => {
    const e = srodowisko();
    wlacz(e, regula(e, { warunki: { kanaly: ['sklep', 'allegro'], kanalyZnane: ['sklep', 'allegro', 'reczne', 'indywidualne'] } }));
    zamowienie(e.db, { sklep: 'nowy-sklep', wyslane: iso(T0 + MIN) });
    zamowienie(e.db, { sklep: 'reczne', wyslane: iso(T0 + MIN) });
    const dobre = zamowienie(e.db, { sklep: 'allegro', wyslane: iso(T0 + MIN) });
    e.z.przesun(2 * MIN);
    await e.s.przebieg();
    expect(wykonania(e.db).map((w) => w.zamowienie_id)).toEqual([dobre]);
  });
});

describe('15. podgląd „30 dni”', () => {
  it('zero zapisów, liczby zgodne ze sztucznymi danymi', async () => {
    const e = srodowisko({ sprawdzWarunki: async ({ wykonanie }) => (wykonanie.zamowienie_id % 2
      ? { ok: true } : { ok: false, kod: 'warunek', powod: 'status jest teraz W realizacji' }) });
    for (let i = 0; i < 6; i += 1) zamowienie(e.db, { wyslane: iso(T0 - 2 * 24 * 60 * MIN) });
    for (let i = 0; i < 3; i += 1) zamowienie(e.db, { sklep: 'allegro', wyslane: iso(T0 - 24 * 60 * MIN) });
    zamowienie(e.db, { wyslane: iso(T0 - 40 * 24 * 60 * MIN) }); // starsze niż 30 dni
    const przed = zmiany(e.db);
    const w = await symulujRegule({ db: e.db, regula: { ...REGULA(), id: null }, zdarzenie: e.zdarzenie, akcja: e.akcja,
      sprawdzWarunki: e.sprawdzWarunki, pocztaGotowa: () => true, teraz: e.z.teraz });
    expect(zmiany(e.db)).toBe(przed);
    expect(w).toMatchObject({ od: iso(T0 - 30 * 24 * 60 * MIN), razem: 6, wykonaloby: 3, pominieteRazem: 3,
      pominiete: { warunek: 3 }, odrzuconeKanalem: { allegro: 3 } });
    expect(w.przyklady.length).toBeLessThanOrEqual(5);
    expect(e.akcja.wywolania).toEqual([]);
  });
});

describe('16. warunek w chwili wykonania, nie wykrycia', () => {
  it('spełniony przy zdarzeniu, niespełniony po opóźnieniu → pominięte (warunek), akcja 0 razy', async () => {
    let ok = true;
    const e = srodowisko({ sprawdzWarunki: async () => (ok ? { ok: true } : { ok: false, kod: 'warunek', powod: 'status jest teraz W realizacji' }) });
    wlacz(e, regula(e, { opoznienie_min: 30 }));
    const zid = zamowienie(e.db, { wyslane: iso(T0 + MIN) });
    e.z.przesun(2 * MIN);
    await e.s.przebieg();
    ok = false;
    e.z.ustaw(T0 + 32 * MIN);
    await e.s.przebieg();
    expect(wykonania(e.db)[0]).toMatchObject({ stan: 'pominiete', powod_kod: 'warunek' });
    expect(wykonania(e.db)[0].powod).toContain('status jest teraz W realizacji');
    expect(e.db.prepare("SELECT wynik FROM log WHERE zamowienie_id = ? AND akcja = 'automatyzacja.pominieta'").get(zid).wynik)
      .toContain('status jest teraz W realizacji');
    expect(e.akcja.wywolania).toEqual([]);
  });
  it('niespełniony przy zdarzeniu, spełniony po opóźnieniu → wysłane', async () => {
    let ok = false;
    const e = srodowisko({ sprawdzWarunki: async () => (ok ? { ok: true } : { ok: false, kod: 'warunek', powod: 'nie' }) });
    wlacz(e, regula(e, { opoznienie_min: 30 }));
    zamowienie(e.db, { wyslane: iso(T0 + MIN) });
    e.z.przesun(2 * MIN);
    await e.s.przebieg();
    ok = true;
    e.z.ustaw(T0 + 32 * MIN);
    await e.s.przebieg();
    expect(stany(e.db)).toEqual(['wyslane']);
  });
  it('domyślnie (B, bez sprawdzacza z C1) warunek inny niż kanał jest NIESPEŁNIONY — nigdy mail „na ślepo”', async () => {
    const e = srodowisko();
    wlacz(e, regula(e, { warunki: { kanaly: ['sklep'], kanalyZnane: ['sklep'], statusy: ['wyslane'] } }));
    zamowienie(e.db, { wyslane: iso(T0 + MIN) });
    e.z.przesun(2 * MIN);
    await e.s.przebieg();
    expect(wykonania(e.db)[0]).toMatchObject({ stan: 'pominiete', powod_kod: 'warunek' });
    expect(e.akcja.wywolania).toEqual([]);
  });
  it('zamówienie dołączone do innego → pominięte „dołączone do zamówienia N”', async () => {
    const e = srodowisko();
    wlacz(e, regula(e));
    const glowne = zamowienie(e.db);
    const dol = zamowienie(e.db, { wyslane: iso(T0 + MIN) });
    e.db.prepare('UPDATE zamowienia SET scalone_do = ? WHERE id = ?').run(glowne, dol);
    e.z.przesun(2 * MIN);
    await e.s.przebieg();
    expect(wykonania(e.db)[0]).toMatchObject({ stan: 'pominiete', powod_kod: 'dolaczone' });
    expect(wykonania(e.db)[0].powod).toContain(`dołączone do zamówienia ${glowne}`);
  });
});

describe('17. ponowne otwarcie tylko pominiętych i tylko nowszym zdarzeniem', () => {
  async function pominiete() {
    let ok = false;
    const e = srodowisko({ sprawdzWarunki: async () => (ok ? { ok: true } : { ok: false, kod: 'warunek', powod: 'nie' }) });
    wlacz(e, regula(e));
    const zid = zamowienie(e.db, { wyslane: iso(T0 + MIN) });
    e.z.przesun(2 * MIN);
    await e.s.przebieg();
    return { e, zid, wlacz: () => { ok = true; } };
  }
  it('pominięte + to samo zdarzenie (ten sam zdarzenie_at) w kolejnym przebiegu → bez zmian', async () => {
    const { e, wlacz: spelnij } = await pominiete();
    const przed = wykonania(e.db)[0];
    spelnij();
    e.z.przesun(MIN);
    await e.s.przebieg();
    expect(wykonania(e.db)[0]).toEqual(przed);
    expect(e.akcja.wywolania).toEqual([]);
  });
  it('pominięte + nowsze zdarzenie → zaplanowane z nowym terminem, potem wysłane', async () => {
    const { e, zid, wlacz: spelnij } = await pominiete();
    spelnij();
    e.z.przesun(MIN);
    wyslij(e.db, zid, e.z.ms());
    const nowe = e.z.ms();
    e.z.przesun(MIN);
    await e.s.przebieg();
    expect(wykonania(e.db)[0]).toMatchObject({ stan: 'wyslane', zdarzenie_at: iso(nowe), termin_at: iso(nowe), powod: null });
    expect(e.akcja.wywolania).toEqual([zid]);
  });
  it.each(['wyslane', 'niepewne'])('%s + nowsze zdarzenie → bez zmian (najwyżej jeden mail)', async (stan) => {
    const e = srodowisko();
    wlacz(e, regula(e));
    const zid = zamowienie(e.db, { wyslane: iso(T0 + MIN) });
    e.z.przesun(2 * MIN);
    if (stan === 'niepewne') e.akcja.tryb = 'ESOCKET';
    await e.s.przebieg();
    e.akcja.tryb = 'ok';
    expect(stany(e.db)).toEqual([stan]);
    e.z.przesun(MIN);
    wyslij(e.db, zid, e.z.ms());
    e.z.przesun(MIN);
    await e.s.przebieg();
    e.z.przesun(MIN);
    await e.s.przebieg();
    expect(stany(e.db)).toEqual([stan]);
    expect(e.akcja.wywolania).toHaveLength(1);
  });
});

describe('19. kursor z zakładką 5 min', () => {
  it('drugi przebieg czyta od kursor − 5 min; zdarzenie zapisane „w tej samej sekundzie” co kursor nie ginie', async () => {
    const e = srodowisko();
    wlacz(e, regula(e));
    e.z.przesun(10 * MIN);
    await e.s.przebieg();
    const kursor = e.z.ms();
    expect(e.zdarzenie.wywolania[0].od).toBe(iso(T0));
    // Transakcja zaczęta przed przebiegiem: zdarzenie ze znacznikiem 2 s przed kursorem, widoczne dopiero po nim.
    const spoznione = zamowienie(e.db, { wyslane: iso(kursor - 2000) });
    zamowienie(e.db, { wyslane: iso(kursor - 6 * MIN) }); // starsze niż zakładka — drugi przebieg go nie czyta
    e.z.przesun(MIN);
    await e.s.przebieg();
    expect(e.zdarzenie.wywolania[1].od).toBe(iso(kursor - 5 * MIN));
    expect(e.zdarzenie.wywolania[1].wierszy).toBe(1);
    expect(e.akcja.wywolania).toEqual([spoznione]);
  });
});

describe('zegar w złożonej aplikacji (tryb próby — piaskownica i demo)', () => {
  it('rzeczywisty zegar „automatyzacje” przy zerze reguł: przebieg bez błędu i bez jednego zapisu', async () => {
    const katalog = mkdtempSync(join(tmpdir(), 'prz108-07-app-'));
    const env = { OMS_TRYB: 'proba', OMS_USER: 'operator', OMS_PASS: 'atrapa', OMS_SPRZEDAWCA_NIP: '1234563218',
      OMS_RACHUNEK: '34109010140000000000000000', OMS_KANALY: '[]', OMS_ETYKIETY_KATALOG: katalog, OMS_PROFORMY_KATALOG: katalog };
    const logi = [];
    const a = await zbudujOms({ moduly: modulyDla(env), env, log: (...t) => logi.push(t.join(' ')) });
    try {
      const z = a.zegary.find((x) => x.nazwa === 'automatyzacje');
      expect(z).toMatchObject({ odstepMs: 60_000 });
      const przed = zmiany(a.db);
      await z.przebieg();
      await z.przebieg();
      expect(zmiany(a.db)).toBe(przed);
      expect(logi.filter((l) => l.includes('automatyzac'))).toEqual(['automatyzacje: zegar ruszył — włączonych reguł: 0, zapisów: 0']);
    } finally { await a.app.close(); a.db.close(); }
  });
});

describe('zegar automatyzacji', () => {
  it('co 60 s; wyjątek przebiegu ląduje w logu, zegar nie pada; pierwszy przebieg zostawia jedną linię', async () => {
    expect(ODSTEP_AUTOMATYZACJI_MS).toBe(60_000);
    const logi = [];
    let n = 0;
    const z = zegarAutomatyzacji({ silnik: { przebieg: async () => { n += 1; if (n === 2) throw new Error('baza zablokowana'); return { wlaczonych: 0, zapisow: 0 }; } },
      log: (...t) => logi.push(t.join(' ')) });
    expect(z).toMatchObject({ nazwa: 'automatyzacje', odstepMs: 60_000 });
    await z.przebieg();
    await expect(z.przebieg()).resolves.toBeUndefined();
    await z.przebieg();
    expect(logi).toHaveLength(2);
    expect(logi[0]).toContain('włączonych reguł: 0');
    expect(logi[1]).toContain('baza zablokowana');
  });
});
