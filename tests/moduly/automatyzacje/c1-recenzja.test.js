// PRZ-108.08 — poprawki po recenzji 08 (recenzja-08.md, skrypty r08-d1…d4). Numery = usterki recenzji.
//  1. Stare zamówienie Allegro: otwarcie karty dociąga numer jako NOWĄ paczkę → nie wolno wysłać „zostało wysłane”.
//  2. Wysyłka „niepewna” w regule A → reguła B z tym samym szablonem nie wysyła drugiego listu.
//  3. Cofnięcie i ponowne „Wysłane” zamówienia wysłanego przed włączeniem reguły → pominięte (decyzja kierownika pętli).
//  4./5. Indeksy: detektor statusu i ostrzeżenia czytają przez indeks (EXPLAIN QUERY PLAN), nie skanem tabeli.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { MODULY } from '../../../src/moduly/lista.ts';
import { kolejnoscBudowy } from '../../../src/core/sprawdz-moduly.ts';
import { zapiszZamowienie, zapiszFaktyStatusu, pobierzZamowienie } from '../../../src/oms/db/zamowienia.js';
import { faktyDlaStatusu } from '../../../src/domena/status-reczny.js';
import { zapiszStatusy } from '../../../src/oms/db/statusy.js';
import { domyslneStatusy } from '../../../src/domena/statusy-konfiguracja.js';
import { zarejestrujPrzesylkeReczna } from '../../../src/moduly/wysylka/db/przesylki.js';
import { createPrzesylkiAllegro } from '../../../src/moduly/wysylka/services/przesylki-allegro.js';
import { createWiadomosci } from '../../../src/moduly/wiadomosci/services/wiadomosci.js';
import { createSilnikAutomatyzacji } from '../../../src/moduly/automatyzacje/services/silnik.js';
import { ZDARZENIA } from '../../../src/moduly/automatyzacje/zdarzenia/index.js';
import { sqlKandydatow } from '../../../src/moduly/automatyzacje/zdarzenia/status-zmieniony.js';
import { sqlKandydatowPaczki, OKNO_PACZEK_DNI } from '../../../src/moduly/automatyzacje/zdarzenia/paczka-nadana.js';
import { utworzAkcje } from '../../../src/moduly/automatyzacje/akcje/index.js';
import { sprawdzanieWarunkow } from '../../../src/moduly/automatyzacje/services/warunki.js';
import { utworzRegule, wlaczRegule, SQL_OSTRZEZEN } from '../../../src/moduly/automatyzacje/db/reguly.js';
import { ZAMOWIENIE_STARSZE_NIZ_DNI } from '../../../src/domena/warunki-automatyzacji.js';

const MIN = 60_000;
const DZIEN = 24 * 60 * MIN;
const otwarte = [];
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); });
afterEach(() => {
  vi.useRealTimers();
  for (const db of otwarte.splice(0)) { try { db.close(); } catch { /* już zamknięta */ } }
});
const ustaw = (iso) => vi.setSystemTime(Date.parse(iso));
const przesun = (ms) => vi.setSystemTime(Date.now() + ms);
const KANALY = ['sklep', 'allegro_glowne', 'reczne', 'indywidualne'];

function srodowisko({ mailer = null } = {}) {
  const db = openOmsDb(':memory:', { moduly: kolejnoscBudowy(MODULY) });
  otwarte.push(db);
  const listy = [];
  const wiadomosci = createWiadomosci({ db, mailer: mailer ?? { sendMail: async (m) => { listy.push(m); } },
    config: { klienciZbiorczy: [], oprawaPoczty: { podpis: 'Pracownia Przykładowa', footer: 'Stopka' } } });
  const silnik = createSilnikAutomatyzacji({ db, zdarzenia: ZDARZENIA, akcje: utworzAkcje({ wiadomosci: () => wiadomosci }),
    sprawdzWarunki: sprawdzanieWarunkow, pocztaGotowa: () => true });
  return { db, listy, przebiegi: async (n) => { for (let i = 0; i < n; i += 1) { przesun(MIN); await silnik.przebieg(); } } };
}
let nr = 0;
function zamowienie(db, { sklep = 'sklep', utworzone }) {
  nr += 1;
  return zapiszZamowienie(db, sklep, {
    zrodlo_id: 6000 + nr, numer: `R-${nr}`,
    klient: { first_name: 'Anna', last_name: 'Nowak', email: 'kupujacy@example.invalid', phone: '' },
    dostawa: { first_name: 'Anna', last_name: 'Nowak', address_1: 'Lipowa 7', postcode: '00-950', city: 'Warszawa' },
    metoda_wysylki: 'dpd', kwota_pobrania: null, chce_fakture: 0, nip: null, kwota_brutto: '189.00',
    koszt_dostawy_brutto: '19.00', koszt_dostawy_netto: '15.45', status_woo: 'processing', oplacone_at: null, anulowane: 0,
    utworzone_at: utworzone, pozycje: [{ zrodlo_id: 9900 + nr, nazwa: 'Lampa', sku: 'LMP', ilosc: 1, cena_brutto: '189.00',
      cena_netto: '153.66', brutto_linii: '189.00', netto_linii: '153.66', vat: null }],
  });
}
const status = (db, id, s) => zapiszFaktyStatusu(db, id, { ...faktyDlaStatusu(pobierzZamowienie(db, id), s), kto: 'operator' });
let numer = 500;
const paczka = (db, id) => zarejestrujPrzesylkeReczna(db, id, { kurier: 'dpd',
  kolejnosc: Number(db.prepare('SELECT COUNT(*) AS n FROM przesylki WHERE zamowienie_id = ?').get(id).n) + 1,
  numerListu: `0000000${(numer += 1)}U` });
function regula(db, o = {}) {
  const id = utworzRegule(db, { nazwa: 'Wysłane — sklep', zdarzenie: 'status_zmieniony', zdarzenie_json: { status: 'wyslane' },
    warunki: { kanaly: ['sklep'], kanalyZnane: KANALY, statusy: ['wyslane'], maNumerListu: true, metody: [], pobranie: 'dowolne' },
    akcja: 'mail_kupujacy', akcja_json: { szablon: 'wyslane' }, opoznienie_min: 30, limit_na_godzine: 20, ...o }, { login: 'adam' });
  wlaczRegule(db, id, { login: 'adam' });
  return id;
}
const nadanaAllegro = (db) => regula(db, { nazwa: 'Nadana — Allegro', zdarzenie: 'paczka_nadana', zdarzenie_json: {},
  warunki: { kanaly: ['allegro_glowne'], kanalyZnane: KANALY, statusy: [], maNumerListu: true, metody: [], pobranie: 'dowolne' } });
const wykonania = (db) => db.prepare('SELECT regula_id, zamowienie_id, stan, powod_kod, powod FROM automatyzacje_wykonania ORDER BY id').all();
const klientAllegro = (waybill) => ({ pobierzPrzesylki: async () => [{ waybill, carrierId: 'ALLEGRO' }] });

describe('1. stare zamówienie Allegro — otwarcie karty dociąga numer (r08-d2)', () => {
  it('zamówienie z sierpnia, numer dociągnięty po włączeniu reguły „Paczka nadana” → 0 maili, pominięte z powodem', async () => {
    ustaw('2026-08-05T08:00:00.000Z');
    const e = srodowisko();
    const id = zamowienie(e.db, { sklep: 'allegro_glowne', utworzone: '2026-08-05T07:00:00' });
    ustaw('2026-10-21T10:00:00.000Z');
    nadanaAllegro(e.db);
    await e.przebiegi(1);
    przesun(10 * MIN);
    const karta = createPrzesylkiAllegro({ db: e.db, klienci: { allegro_glowne: klientAllegro('AD000111222PL') } });
    expect((await karta.odswiez(id)).dopisane).toBe(1);
    await e.przebiegi(35);
    expect(e.listy).toEqual([]);
    expect(wykonania(e.db)).toEqual([expect.objectContaining({ stan: 'pominiete', powod_kod: 'przed_granica' })]);
    expect(wykonania(e.db)[0].powod).toContain(`ponad ${ZAMOWIENIE_STARSZE_NIZ_DNI} dni przed włączeniem reguły`);
  });
  it('zamówienie Allegro złożone po włączeniu, numer dociągnięty z karty → mail wychodzi', async () => {
    ustaw('2026-10-21T10:00:00.000Z');
    const e = srodowisko();
    nadanaAllegro(e.db);
    przesun(DZIEN);
    const id = zamowienie(e.db, { sklep: 'allegro_glowne', utworzone: new Date().toISOString() });
    przesun(DZIEN);
    const karta = createPrzesylkiAllegro({ db: e.db, klienci: { allegro_glowne: klientAllegro('AD000333444PL') } });
    expect((await karta.odswiez(id)).dopisane).toBe(1);
    await e.przebiegi(35);
    expect(e.listy).toHaveLength(1);
    expect(e.listy[0].text).toContain('AD000333444PL');
  });
  it('świeże zamówienie, ale z paczką z numerem sprzed włączenia → druga paczka po włączeniu nie wysyła maila', async () => {
    ustaw('2026-10-20T10:00:00.000Z');
    const e = srodowisko();
    const id = zamowienie(e.db, { utworzone: new Date().toISOString() });
    paczka(e.db, id);
    przesun(DZIEN);
    regula(e.db, { nazwa: 'Nadana', zdarzenie: 'paczka_nadana', zdarzenie_json: {},
      warunki: { kanaly: ['sklep'], kanalyZnane: KANALY, statusy: [], maNumerListu: true, metody: [], pobranie: 'dowolne' } });
    przesun(MIN);
    paczka(e.db, id);
    await e.przebiegi(35);
    expect(e.listy).toEqual([]);
    expect(wykonania(e.db)[0]).toMatchObject({ stan: 'pominiete', powod_kod: 'przed_granica' });
    expect(wykonania(e.db)[0].powod).toContain('paczkę z numerem listu sprzed włączenia reguły');
  });
});

describe('4. okno paczek 14 dni (wydajność; znana cena)', () => {
  it('paczka „do wyjaśnienia” domknięta 15 dni po utworzeniu → 0 maili; domknięta po 13 dniach → mail', async () => {
    ustaw('2026-10-21T10:00:00.000Z');
    const e = srodowisko();
    regula(e.db, { nazwa: 'Nadana', zdarzenie: 'paczka_nadana', zdarzenie_json: {},
      warunki: { kanaly: ['sklep'], kanalyZnane: KANALY, statusy: [], maNumerListu: true, metody: [], pobranie: 'dowolne' } });
    przesun(MIN);
    const wstaw = (id) => {
      e.db.prepare(`INSERT INTO przesylki (zamowienie_id, kurier, status, numer_listu, kolejnosc, utworzona_at)
        VALUES (?, 'dpd', 'do_wyjasnienia', ?, 1, ?)`).run(id, `0000000${(numer += 1)}U`, new Date().toISOString());
      return e.db.prepare('SELECT id FROM przesylki WHERE id = last_insert_rowid()').get().id;
    };
    const pozno = zamowienie(e.db, { utworzone: new Date().toISOString() });
    const wczas = zamowienie(e.db, { utworzone: new Date().toISOString() });
    const p1 = wstaw(pozno);
    przesun(2 * DZIEN);
    const p2 = wstaw(wczas);
    for (let d = 0; d < 13; d += 1) { przesun(DZIEN); await e.przebiegi(1); } // zegar chodzi (kursor idzie z czasem)
    e.db.prepare("UPDATE przesylki SET status = 'nadana' WHERE id IN (?, ?)").run(p1, p2); // domknięcie po 15 i po 13 dniach
    await e.przebiegi(35);
    expect(wykonania(e.db).map((w) => w.zamowienie_id), JSON.stringify(wykonania(e.db))).toEqual([wczas]);
    expect(e.listy, JSON.stringify(wykonania(e.db))).toHaveLength(1);
  });
});

describe('2. wysyłka niepewna w regule A → reguła B z tym samym szablonem nie wysyła (r08-d3)', () => {
  it('serwer przyjął treść, połączenie padło (ESOCKET) → do serwera SMTP dotarł 1 list, B pominięta z powodem', async () => {
    const dotarlo = [];
    let pierwszy = true;
    const mailer = { sendMail: async (m) => {
      dotarlo.push(m.subject);
      if (pierwszy) { pierwszy = false; throw Object.assign(new Error('Connection closed unexpectedly'), { code: 'ESOCKET' }); }
    } };
    ustaw('2026-10-21T10:00:00.000Z');
    const e = srodowisko({ mailer });
    regula(e.db, { nazwa: 'A: Wysłane' });
    regula(e.db, { nazwa: 'B: Nadana', zdarzenie: 'paczka_nadana', zdarzenie_json: {}, opoznienie_min: 40,
      warunki: { kanaly: ['sklep'], kanalyZnane: KANALY, statusy: [], maNumerListu: true, metody: [], pobranie: 'dowolne' } });
    przesun(MIN);
    const id = zamowienie(e.db, { utworzone: new Date().toISOString() });
    paczka(e.db, id);
    status(e.db, id, 'wyslane');
    await e.przebiegi(45);
    expect(dotarlo).toHaveLength(1);
    expect(wykonania(e.db).map((w) => [w.regula_id, w.stan, w.powod_kod]))
      .toEqual([[1, 'niepewne', 'niepewne'], [2, 'pominiete', 'niepewne_wczesniej']]);
    expect(wykonania(e.db)[1].powod).toContain('„A: Wysłane”');
  });
});

describe('3. cofnięcie i ponowne „Wysłane” (r08-d1; decyzja kierownika: wariant bezpieczniejszy)', () => {
  it('zamówienie wysłane 3 tygodnie przed włączeniem → po cofnięciu i ponownym Wysłane 0 maili, pominięte z powodem', async () => {
    ustaw('2026-10-01T08:00:00.000Z');
    const e = srodowisko();
    const id = zamowienie(e.db, { utworzone: '2026-09-30T08:00:00' });
    paczka(e.db, id);
    status(e.db, id, 'wyslane');
    ustaw('2026-10-21T10:00:00.000Z');
    regula(e.db);
    await e.przebiegi(5);
    status(e.db, id, 'w_realizacji');
    przesun(MIN);
    status(e.db, id, 'wyslane');
    await e.przebiegi(35);
    expect(e.listy).toEqual([]);
    expect(wykonania(e.db)[0]).toMatchObject({ stan: 'pominiete', powod_kod: 'przed_granica' });
    expect(wykonania(e.db)[0].powod).toContain('wysłane przed włączeniem reguły');
  });
  it('zamówienie nowe po włączeniu: Wysłane → mail; reklamacja, cofnięcie i ponowne Wysłane → nadal 1 mail (UNIQUE)', async () => {
    ustaw('2026-10-21T10:00:00.000Z');
    const e = srodowisko();
    regula(e.db);
    przesun(MIN);
    const id = zamowienie(e.db, { utworzone: new Date().toISOString() });
    paczka(e.db, id);
    status(e.db, id, 'wyslane');
    await e.przebiegi(35);
    expect(e.listy).toHaveLength(1);
    przesun(2 * DZIEN);
    status(e.db, id, 'w_realizacji');
    paczka(e.db, id);
    status(e.db, id, 'wyslane');
    await e.przebiegi(35);
    expect(e.listy).toHaveLength(1);
    expect(wykonania(e.db)).toHaveLength(1);
  });
});

describe('4./5. indeksy: detektor statusu i ostrzeżenia bez skanu tabeli', () => {
  const plan = (db, sql, args) => db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args).map((w) => w.detail).join(' | ');
  it.each([
    ['wyslane', 'zamowienia_wyslane_at'],
    ['w_realizacji', 'zamowienia_w_realizacji_at'],
  ])('status → %s czyta przez indeks %s (także z filtrem kanału)', (klucz, indeks) => {
    const db = openOmsDb(':memory:', { moduly: kolejnoscBudowy(MODULY) });
    otwarte.push(db);
    const { sql, args } = sqlKandydatow(db, klucz, '2026-10-21T10:00:00.000Z', { kanaly: ['sklep', 'allegro_glowne'], limit: 1000 });
    expect(plan(db, sql, args)).toMatch(new RegExp(`USING (COVERING )?INDEX ${indeks} `, 'u'));
  });
  it('status własny czyta przez indeks (klucz, ustawione_at)', () => {
    const db = openOmsDb(':memory:', { moduly: kolejnoscBudowy(MODULY) });
    otwarte.push(db);
    zapiszStatusy(db, [...domyslneStatusy(), { klucz: 'w_klosz', etykieta: 'Czeka na klosz', kolor: domyslneStatusy()[0].kolor, jak: 'w_realizacji' }]);
    const { sql, args } = sqlKandydatow(db, 'w_klosz', '2026-10-21T10:00:00.000Z', { kanaly: ['sklep'], limit: 1000 });
    expect(plan(db, sql, args)).toMatch(/USING (COVERING )?INDEX zamowienia_status_wlasny_klucz_ustawione/u);
  });
  it('paczka nadana czyta przez indeks przesylki_utworzona_at (okno 14 dni), nie całą tabelę paczek od włączenia', () => {
    const db = openOmsDb(':memory:', { moduly: kolejnoscBudowy(MODULY) });
    otwarte.push(db);
    const { sql, args } = sqlKandydatowPaczki({ granica: { at: '2025-10-21T10:00:00.000Z', przesylki: 0 }, od: '2026-10-21T09:54:00.000Z',
      kanaly: ['sklep'], regula_id: 1, limit: 1000 });
    expect(plan(db, sql, args)).toMatch(/SEARCH p USING INDEX przesylki_utworzona_at /u);
    expect(OKNO_PACZEK_DNI).toBe(14);
  });
  it('ostrzeżenia na stronie głównej liczą wykonania przez indeks (regula_id, stan, zakonczone_at)', () => {
    const db = openOmsDb(':memory:', { moduly: kolejnoscBudowy(MODULY) });
    otwarte.push(db);
    const p = plan(db, SQL_OSTRZEZEN, Array(4).fill('2026-10-14T00:00:00.000Z'));
    expect(p).toContain('automatyzacje_wykonania_regula_stan');
    expect(p).not.toMatch(/SCAN w\b/u);
  });
});

// PRZ-108.08b — recenzja 08, runda 2, R2-1 (KRYTYCZNA, r09-runda2-scenariusze E i E2): numer dociągnięty z Allegro przy
// otwarciu karty PO TYGODNIACH dawał „Zamówienie wysłane”, choć zamówienie złożono po włączeniu (albo < 14 dni przed nim).
// Świeżość mierzymy względem ZDARZENIA, nie granicy: paczka z numerem z Allegro (`zrodlo_numeru = 'allegro'`) wyzwala
// tylko, gdy zamówienie złożono nie dawniej niż ZAMOWIENIE_STARSZE_NIZ_DNI przed chwilą zdarzenia.
describe('R2-1. numer z Allegro dociągnięty długo po złożeniu zamówienia', () => {
  it('E: zamówienie złożone 4 dni PO włączeniu, karta otwarta po 60 dniach → pominięte z powodem, 0 maili', async () => {
    ustaw('2026-10-21T10:00:00.000Z');
    const e = srodowisko();
    nadanaAllegro(e.db);
    przesun(4 * DZIEN);
    const id = zamowienie(e.db, { sklep: 'allegro_glowne', utworzone: new Date().toISOString().slice(0, 19) });
    await e.przebiegi(1);
    przesun(60 * DZIEN);
    const karta = createPrzesylkiAllegro({ db: e.db, klienci: { allegro_glowne: klientAllegro('AD000999PL') } });
    expect((await karta.odswiez(id)).dopisane).toBe(1);
    await e.przebiegi(35);
    expect(e.listy).toEqual([]);
    expect(wykonania(e.db)).toEqual([expect.objectContaining({ zamowienie_id: id, stan: 'pominiete', powod_kod: 'numer_allegro_pozno' })]);
    expect(wykonania(e.db)[0].powod).toContain('Numer listu dociągnięty z Allegro');
    expect(wykonania(e.db)[0].powod).toContain('przesyłka mogła dawno dojść');
  });
  it('E2: zamówienie złożone 10 dni PRZED włączeniem, karta otwarta po 90 dniach → 0 maili', async () => {
    ustaw('2026-10-11T10:00:00.000Z');
    const e = srodowisko();
    const id = zamowienie(e.db, { sklep: 'allegro_glowne', utworzone: new Date().toISOString().slice(0, 19) });
    ustaw('2026-10-21T10:00:00.000Z');
    nadanaAllegro(e.db);
    przesun(90 * DZIEN);
    await e.przebiegi(1);
    const karta = createPrzesylkiAllegro({ db: e.db, klienci: { allegro_glowne: klientAllegro('AD000777PL') } });
    expect((await karta.odswiez(id)).dopisane).toBe(1);
    await e.przebiegi(35);
    expect(e.listy).toEqual([]);
    expect(wykonania(e.db)[0]).toMatchObject({ stan: 'pominiete', powod_kod: 'numer_allegro_pozno' });
  });
  it('Allegro, numer dociągnięty 13 dni po złożeniu → mail (granica świeżości po stronie maila)', async () => {
    ustaw('2026-10-21T10:00:00.000Z');
    const e = srodowisko();
    nadanaAllegro(e.db);
    przesun(DZIEN);
    const id = zamowienie(e.db, { sklep: 'allegro_glowne', utworzone: new Date().toISOString().slice(0, 19) });
    przesun(13 * DZIEN);
    const karta = createPrzesylkiAllegro({ db: e.db, klienci: { allegro_glowne: klientAllegro('AD000555PL') } });
    expect((await karta.odswiez(id)).dopisane).toBe(1);
    await e.przebiegi(35);
    expect(e.listy).toHaveLength(1);
  });
  it('przypadek właściciela bez zmian: sklep, paczka z panelu 30 dni po złożeniu zamówienia (złożone po włączeniu) → 1 mail', async () => {
    ustaw('2026-10-21T10:00:00.000Z');
    const e = srodowisko();
    regula(e.db);
    przesun(DZIEN);
    const id = zamowienie(e.db, { utworzone: new Date().toISOString().slice(0, 19) });
    przesun(30 * DZIEN);
    await e.przebiegi(1);
    paczka(e.db, id);
    status(e.db, id, 'wyslane');
    await e.przebiegi(35);
    expect(wykonania(e.db).map((w) => w.stan)).toEqual(['wyslane']);
    expect(e.listy).toHaveLength(1);
  });
});
