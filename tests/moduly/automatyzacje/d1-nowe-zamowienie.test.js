// PRZ-110.02: D1 — nowe zamówienie, prawdziwy zapis, warunki i poczta na atrapie.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { MODULY } from '../../../src/moduly/lista.ts';
import { kolejnoscBudowy } from '../../../src/core/sprawdz-moduly.ts';
import { zapiszZamowienie } from '../../../src/oms/db/zamowienia.js';
import { utworzZamowienieReczne } from '../../../src/oms/db/zamowienia-reczne.js';
import { ZDARZENIA } from '../../../src/moduly/automatyzacje/zdarzenia/index.js';
import { createSilnikAutomatyzacji, symulujRegule } from '../../../src/moduly/automatyzacje/services/silnik.js';
import { sprawdzanieWarunkow } from '../../../src/moduly/automatyzacje/services/warunki.js';
import { utworzAkcje } from '../../../src/moduly/automatyzacje/akcje/index.js';
import { utworzRegule, wlaczRegule, regulaRozpakowana } from '../../../src/moduly/automatyzacje/db/reguly.js';
import { createWiadomosci } from '../../../src/moduly/wiadomosci/services/wiadomosci.js';
import { createPotwierdzenie } from '../../../src/moduly/wiadomosci/services/potwierdzenie.js';
import { nowyPanel, jako, get, post } from '../../pomoc/konta-prz068.js';
import { zalozKonto } from '../../../src/core/bezpieczenstwo/konta.js';

const START = Date.parse('2026-10-23T10:00:00.000Z');
const MIN = 60_000;
const otwarte = [];
let nr = 0;
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(START); });
afterEach(async () => {
  vi.useRealTimers();
  for (const e of otwarte.splice(0)) { await e.app?.close(); e.db.close(); }
});
const przesun = (min) => vi.setSystemTime(Date.now() + min * MIN);
const zdarzenie = () => {
  const z = ZDARZENIA.find((d) => d.klucz === 'zamowienie_nowe');
  expect(z, 'rejestr udostępnia zdarzenie Nowe zamówienie').toBeDefined();
  return z;
};
const wykonania = (e) => e.db.prepare('SELECT * FROM automatyzacje_wykonania ORDER BY id').all();
const WARUNKI = { kanaly: ['sklep', 'allegro', 'reczne'], kanalyZnane: ['sklep', 'allegro', 'reczne'],
  statusy: [], maNumerListu: false, metody: [], pobranie: 'dowolne' };
function srodowisko() {
  const db = openOmsDb(':memory:', { moduly: kolejnoscBudowy(MODULY) });
  const listy = [];
  const mailer = { sendMail: async (m) => { listy.push(m); } };
  const usluga = { ...createWiadomosci({ db, mailer, potwierdzenie: createPotwierdzenie({ db, mailer }),
    config: { klienciZbiorczy: [], oprawaPoczty: { podpis: 'Pracownia Przykładowa', footer: 'Stopka' } } }), gotowe: () => true };
  const e = { db, listy, usluga, akcje: utworzAkcje({ wiadomosci: () => usluga }) };
  e.silnik = createSilnikAutomatyzacji({ db, zdarzenia: ZDARZENIA, akcje: e.akcje,
    sprawdzWarunki: sprawdzanieWarunkow, pocztaGotowa: () => true });
  otwarte.push(e);
  return e;
}
function zamowienie(e, { sklep = 'sklep', email = 'kupujacy@example.invalid', at = new Date().toISOString() } = {}) {
  nr += 1;
  const klient = { first_name: 'Ewa', last_name: 'Przykładowa', email };
  if (sklep === 'reczne') {
    const id = utworzZamowienieReczne(e.db, { klient, utworzone_at: at });
    e.db.prepare(`INSERT INTO pozycje (zamowienie_id, nazwa, ilosc, cena_brutto, cena_netto, brutto_linii, netto_linii)
      VALUES (?, 'Lampa przykładowa', 1, '123.00', '100.00', '123.00', '100.00')`).run(id);
    return id;
  }
  return zapiszZamowienie(e.db, sklep, { zrodlo_id: nr, numer: `D1-${nr}`, klient, dostawa: {},
    metoda_wysylki: 'dpd', kwota_pobrania: null, chce_fakture: 0, nip: null, kwota_brutto: '123.00',
    status_woo: 'processing', oplacone_at: null, anulowane: 0, utworzone_at: at,
    pozycje: [{ zrodlo_id: nr, nazwa: 'Lampa przykładowa', sku: 'LMP-DEMO', ilosc: 1, cena_brutto: '123.00', cena_netto: '100.00',
      brutto_linii: '123.00', netto_linii: '100.00', vat: null }] });
}
function regula(e, o = {}) {
  const id = utworzRegule(e.db, { nazwa: 'Potwierdzenie nowych zamówień', zdarzenie: 'zamowienie_nowe', zdarzenie_json: {},
    warunki: WARUNKI, akcja: 'mail_kupujacy', akcja_json: { szablon: 'potwierdzenie' },
    opoznienie_min: 0, limit_na_godzine: 20, ...o });
  wlaczRegule(e.db, id);
  return id;
}

describe('D1: Nowe zamówienie', () => {
  it('jest w rejestrze w grupie Zamówienie', () => {
    expect(zdarzenie()).toMatchObject({ grupa: 'zamowienie', etykieta: 'Nowe zamówienie' });
  });
  it('granica ID: zamówienie sprzed włączenia, nawet z późniejszą datą → zero kandydatów i maili', async () => {
    const e = srodowisko();
    zamowienie(e, { at: new Date(START + MIN).toISOString() });
    const id = regula(e);
    przesun(2);
    expect(zdarzenie().kandydaci(e.db, { granica: regulaRozpakowana(e.db, id).granica,
      od: new Date(START).toISOString(), kanaly: WARUNKI.kanaly, limit: 100 })).toEqual([]);
    await e.silnik.przebieg();
    expect(wykonania(e)).toEqual([]);
    expect(e.listy).toEqual([]);
  });
  it.each(['sklep', 'allegro', 'reczne'])('%s: nowe zamówienie → potwierdzenie raz; drugi przebieg nic nie dodaje', async (sklep) => {
    const e = srodowisko();
    zdarzenie();
    regula(e);
    przesun(1);
    const id = zamowienie(e, { sklep });
    await e.silnik.przebieg();
    przesun(1);
    await e.silnik.przebieg();
    expect(wykonania(e).map((w) => [w.zamowienie_id, w.stan, w.szablon])).toEqual([[id, 'wyslane', 'potwierdzenie']]);
    expect(e.listy).toHaveLength(1);
    expect(e.listy[0].text).toContain('Lampa przykładowa');
  });
  it('obcy kanał → nic; dołączone → pominięte przez silnik; brak adresu → pominięte z powodem w dzienniku', async () => {
    const e = srodowisko();
    zdarzenie();
    regula(e, { warunki: { ...WARUNKI, kanaly: ['sklep'] } });
    przesun(1);
    const glowne = zamowienie(e, { sklep: 'allegro' });
    const dolaczone = zamowienie(e);
    e.db.prepare('UPDATE zamowienia SET scalone_do = ? WHERE id = ?').run(glowne, dolaczone);
    const bezAdresu = zamowienie(e, { email: '' });
    await e.silnik.przebieg();
    expect(wykonania(e).map((w) => [w.zamowienie_id, w.stan, w.powod_kod]))
      .toEqual([[dolaczone, 'pominiete', 'dolaczone'], [bezAdresu, 'pominiete', 'brak_adresu']]);
    expect(wykonania(e)[1].powod).toMatch(/adresu e-mail/u);
    expect(e.db.prepare("SELECT wynik FROM log WHERE zamowienie_id = ? AND akcja LIKE 'automatyzacja%'").all(bezAdresu)
      .some((w) => /adresu e-mail/u.test(w.wynik))).toBe(true);
    expect(e.listy).toEqual([]);
  });
  it('spóźniony import ma nowe ID: jest wykrywany po przesunięciu kursora; synchronizacja nie otwiera pominięcia', async () => {
    const e = srodowisko();
    regula(e);
    przesun(60);
    await e.silnik.przebieg(); // kursor już daleko za datą zakupu
    const id = zamowienie(e, { at: new Date(START + MIN).toISOString(), email: '' });
    przesun(1);
    await e.silnik.przebieg();
    expect(wykonania(e).map((w) => [w.zamowienie_id, w.stan, w.powod_kod]))
      .toEqual([[id, 'pominiete', 'brak_adresu']]);
    const pierwszaChwila = wykonania(e)[0].zdarzenie_at;
    e.db.prepare('UPDATE zamowienia SET klient_json = ?, zmienione_at = ? WHERE id = ?')
      .run(JSON.stringify({ email: 'kupujacy@example.invalid' }), new Date().toISOString(), id);
    przesun(10);
    await e.silnik.przebieg();
    expect(wykonania(e)).toHaveLength(1);
    expect(wykonania(e)[0]).toMatchObject({ stan: 'pominiete', zdarzenie_at: pierwszaChwila });
    expect(e.listy).toEqual([]);
  });
  it('reguła działa od miesięcy: import zamówienia sprzed 10 dni → pominięte z powodem w dzienniku i historii', async () => {
    const e = srodowisko();
    regula(e);
    przesun(90 * 24 * 60);
    await e.silnik.przebieg();
    const id = zamowienie(e, { at: new Date(Date.now() - 10 * 24 * 60 * MIN).toISOString() });
    await e.silnik.przebieg();
    const w = wykonania(e)[0];
    expect(w).toMatchObject({ zamowienie_id: id, stan: 'pominiete', powod_kod: 'spozniony_import' });
    expect(w.powod).toMatch(/Zamówienie złożone .*48 godzin.*Potwierdzenie nie idzie automatem/u);
    expect(w.powod).toContain('wyślij je ręcznie z karty');
    expect(e.db.prepare("SELECT wynik FROM log WHERE zamowienie_id = ? AND akcja LIKE 'automatyzacja%'").all(id)
      .some((l) => l.wynik.includes(w.powod))).toBe(true);
    expect(e.listy).toEqual([]);
  });
  it.each([[48 * 3600_000, true], [48 * 3600_000 + 1, false]])(
    'świeżość importu: różnica %s ms względem zdarzenia → zgoda %s; inne zdarzenia bez tego ograniczenia', async (wiek, ok) => {
      const e = srodowisko();
      const idReguly = regula(e);
      przesun(90 * 24 * 60);
      const zdarzenie_at = new Date().toISOString();
      const id = zamowienie(e, { at: new Date(Date.now() - wiek).toISOString() });
      const r = regulaRozpakowana(e.db, idReguly);
      przesun(3 * 24 * 60); // próg dotyczy importu, nie czasu czekania na wykonanie
      const wynik = await sprawdzanieWarunkow({ db: e.db, regula: r, wykonanie: { zamowienie_id: id, zdarzenie_at } });
      expect(wynik.ok).toBe(ok);
      if (!ok) expect(wynik.kod).toBe('spozniony_import');
      expect(await sprawdzanieWarunkow({ db: e.db, regula: { ...r, zdarzenie: 'status_zmieniony' },
        wykonanie: { zamowienie_id: id, zdarzenie_at } })).toEqual({ ok: true });
    },
  );
  it('kanał + opóźnienie: status i przesyłka są sprawdzane dopiero w terminie', async () => {
    const e = srodowisko();
    zdarzenie();
    regula(e, { opoznienie_min: 30, warunki: { ...WARUNKI, kanaly: ['reczne'], statusy: ['nowe'], maNumerListu: true } });
    przesun(1);
    const a = zamowienie(e, { sklep: 'reczne' });
    const b = zamowienie(e, { sklep: 'reczne' });
    const c = zamowienie(e, { sklep: 'reczne' });
    zamowienie(e, { sklep: 'allegro' });
    await e.silnik.przebieg();
    expect(wykonania(e).map((w) => w.stan)).toEqual(['zaplanowane', 'zaplanowane', 'zaplanowane']);
    expect(e.listy).toEqual([]);
    for (const id of [a, b]) e.db.prepare(`INSERT INTO przesylki (zamowienie_id, kurier, status, numer_listu, kolejnosc, utworzona_at)
      VALUES (?, 'dpd', 'nadana', ?, 1, ?)`).run(id, `DEMO-${id}`, new Date().toISOString());
    e.db.prepare('UPDATE zamowienia SET w_realizacji_at = ? WHERE id = ?').run(new Date().toISOString(), b);
    przesun(30);
    await e.silnik.przebieg();
    expect(wykonania(e).map((w) => [w.zamowienie_id, w.stan, w.powod_kod]))
      .toEqual([[a, 'wyslane', null], [b, 'pominiete', 'warunek'], [c, 'pominiete', 'warunek']]);
    expect(e.listy).toHaveLength(1);
  });
  it('kursor od/po, kolejność (czas, id), limit i kanały w SQL; daty ze źródeł mają wspólny format ISO', () => {
    const e = srodowisko();
    const stara = zamowienie(e);
    const granica = { at: new Date(START).toISOString(), zamowienia: stara };
    const a = zamowienie(e, { at: '2026-10-23T10:01:00Z' });
    const b = zamowienie(e, { at: '2026-10-23T12:01:00+02:00' });
    const c = zamowienie(e);
    zamowienie(e, { sklep: 'allegro' });
    const spoznione = zamowienie(e, { at: '2026-10-22T10:00:00Z' });
    const k = (o = {}) => zdarzenie().kandydaci(e.db, { granica, od: granica.at, limit: 100, kanaly: ['sklep'], ...o });
    expect(k().map((w) => w.id)).toEqual([c, spoznione, a, b]);
    expect(k({ limit: 1 }).map((w) => w.id)).toEqual([c]);
    expect(k({ po: { at: '2026-10-23T10:01:00.000Z', id: a } }).map((w) => w.id)).toEqual([b]);
    expect(k({ po: { at: granica.at, id: c } }).map((w) => w.id)).toEqual([spoznione, a, b]);
    expect(k({ od: '2026-10-23T10:01:00.000Z' }).map((w) => w.id)).toEqual([a, b, c, spoznione]);
    expect(k({ kanaly: [] })).toEqual([]);
    expect(k().find((w) => w.id === a)).toEqual({ id: a, zamowienie_id: a, sklep: 'sklep', zdarzenie_at: '2026-10-23T10:01:00.000Z' });
  });
  it('symulacja 30 dni obejmuje historię bez granicy, filtruje kanały i zgody; zero zapisów', async () => {
    const e = srodowisko();
    const dobry = zamowienie(e);
    zamowienie(e, { email: '' });
    zamowienie(e, { sklep: 'allegro' });
    zamowienie(e, { at: '2026-08-01T10:00:00Z' });
    const r = regulaRozpakowana(e.db, regula(e, { warunki: { ...WARUNKI, kanaly: ['sklep'] } }));
    const przed = e.db.prepare('SELECT total_changes() AS n').get().n;
    const wynik = await symulujRegule({ db: e.db, regula: r, zdarzenie: zdarzenie(), akcja: e.akcje[0], sprawdzWarunki: sprawdzanieWarunkow });
    expect(wynik).toMatchObject({ razem: 2, wykonaloby: 1, pominiete: { brak_adresu: 1 }, odrzuconeKanalem: { allegro: 1 } });
    expect(wynik.przyklady.some((w) => w.zamowienie_id === dobry && w.ok)).toBe(true);
    expect(e.db.prepare('SELECT total_changes() AS n').get().n).toBe(przed);
    expect(e.listy).toEqual([]);
  });
  it('okno detektora: dokładnie 14 dni przed od → kandydat; starsze o 1 ms → nic, mimo ID po granicy', () => {
    const e = srodowisko();
    const najstarsze = START - 14 * 24 * 60 * MIN;
    const a = zamowienie(e, { at: new Date(najstarsze).toISOString() });
    zamowienie(e, { at: new Date(najstarsze - 1).toISOString() });
    const wynik = zdarzenie().kandydaci(e.db, { granica: { at: '2026-01-01T00:00:00.000Z', zamowienia: 0 },
      od: new Date(START).toISOString(), kanaly: ['sklep'], limit: 1000 });
    expect(wynik.map((w) => w.id)).toEqual([a]);
  });
  it('plan zapytania używa indeksu daty zamiast zakresu wszystkich ID od włączenia, również z po', async () => {
    const e = srodowisko();
    zdarzenie();
    const { sqlKandydatowZamowienia } = await import('../../../src/moduly/automatyzacje/zdarzenia/nowe-zamowienie.js');
    for (const po of [null, { at: new Date(START).toISOString(), id: 100 }]) {
      const q = sqlKandydatowZamowienia({ granica: { zamowienia: 90, at: new Date(START).toISOString() },
        od: new Date(START).toISOString(), po, kanaly: ['sklep', 'allegro'], limit: 1000, regula_id: 1 });
      const plan = e.db.prepare(`EXPLAIN QUERY PLAN ${q.sql}`).all(...q.args).map((w) => w.detail).join(' | ');
      expect(plan).toMatch(/SEARCH z USING INDEX zamowienia_julianday_utworzenia \(<expr>>\?\)/u);
      expect(plan).not.toMatch(/SCAN z/u);
      expect(plan).toMatch(/SEARCH w USING COVERING INDEX .*\(regula_id=\? AND przedmiot=\?\)/u);
    }
  });
  it('kreator udostępnia zdarzenie, potwierdzenie i wyraźne ostrzeżenie przy kanale Woo; regułę można zapisać', async () => {
    const e = srodowisko();
    const p = nowyPanel({ db: e.db, wiadomosci: e.usluga });
    e.app = p.app;
    zalozKonto(e.db, { login: 'operator', imie: 'Operator', haslo: 'testowe', rola: 'administrator', admin: true });
    const admin = jako(e.db, 'operator');
    const nowa = '/ustawienia/automatyzacje/nowa';
    const lista = await get(e.app, nowa, admin);
    expect(lista.body).toMatch(/name="zdarzenie" value="zamowienie_nowe"/u);
    expect(lista.body).toContain('Zamówienie ze sklepu, Allegro albo dodane ręcznie');
    const formularz = await get(e.app, `${nowa}?zdarzenie=zamowienie_nowe`, admin);
    expect(formularz.statusCode).toBe(200);
    expect(formularz.body).toContain('<option value="potwierdzenie" selected>Potwierdzenie przyjęcia zamówienia</option>');
    expect(formularz.body).toMatch(/<strong>[^<]*WooCommerce[^<]*dwa potwierdzenia[^<]*<\/strong>/u);
    expect(formularz.body).not.toContain('<option value="wyslane"');
    const zapis = await post(e.app, nowa, admin, { nazwa: 'Przyjęcie', zdarzenie: 'zamowienie_nowe', kanaly: ['pro'],
      opoznienie: '30', status_warunek: 'dowolny', ma_numer_listu: '0', pobranie: 'dowolne',
      akcja: 'mail_kupujacy', szablon: 'potwierdzenie', limit: '20' });
    expect(zapis.statusCode).toBe(303);
    expect(e.db.prepare('SELECT zdarzenie, akcja_json FROM automatyzacje_reguly').get())
      .toMatchObject({ zdarzenie: 'zamowienie_nowe', akcja_json: '{"szablon":"potwierdzenie"}' });
  });
});
