// PRZ-108.08 (zmiana C1 planu automatyzacji, właściciel 21.10): prawdziwe zdarzenia „Status zamówienia zmienił się na …”
// i „Paczka nadana”, prawdziwa akcja „Wyślij mail do kupującego” (usługa wiadomości z atrapą poczty), warunki
// w chwili wykonania. Numery w opisach = numery testów z planu (sekcja 8, „C1. Testy najpierw”).
//
// Czas: `vi.useFakeTimers({ toFake: ['Date'] })` — zapis statusu (zapiszFaktyStatusu, oznaczWyslane), paczki i silnik
// liczą czas z tego samego zegara, jak na produkcji. Timery i obietnice zostają prawdziwe.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { MODULY } from '../../../src/moduly/lista.ts';
import { kolejnoscBudowy } from '../../../src/core/sprawdz-moduly.ts';
import {
  zapiszZamowienie, zapiszFaktyStatusu, pobierzZamowienie, oznaczWyslane,
} from '../../../src/oms/db/zamowienia.js';
import { scalZamowienia } from '../../../src/oms/db/scalenia.js';
import { DECYZJE_WYSYLKI } from '../../../src/domena/scalanie.js';
import { faktyDlaStatusu } from '../../../src/domena/status-reczny.js';
import { zapiszStatusy } from '../../../src/oms/db/statusy.js';
import { domyslneStatusy } from '../../../src/domena/statusy-konfiguracja.js';
import { zarejestrujPrzesylkeReczna, domknijPrzesylke } from '../../../src/moduly/wysylka/db/przesylki.js';
import { createWiadomosci } from '../../../src/moduly/wiadomosci/services/wiadomosci.js';
import { createSilnikAutomatyzacji } from '../../../src/moduly/automatyzacje/services/silnik.js';
import { ZDARZENIA } from '../../../src/moduly/automatyzacje/zdarzenia/index.js';
import { zdarzeniePaczkaNadana } from '../../../src/moduly/automatyzacje/zdarzenia/paczka-nadana.js';
import { zdarzenieStatusZmieniony } from '../../../src/moduly/automatyzacje/zdarzenia/status-zmieniony.js';
import { utworzAkcje } from '../../../src/moduly/automatyzacje/akcje/index.js';
import { sprawdzanieWarunkow } from '../../../src/moduly/automatyzacje/services/warunki.js';
import { utworzRegule, wlaczRegule, wyslijZalegle, zmienRegule } from '../../../src/moduly/automatyzacje/db/reguly.js';
import { buildOmsServer } from '../../pomoc/serwer-parytetu.ts';

const MIN = 60_000;
const START = Date.parse('2026-10-21T12:00:00.000Z');
const otwarte = [];
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(START); });
afterEach(() => {
  vi.useRealTimers();
  for (const db of otwarte.splice(0)) { try { db.close(); } catch { /* już zamknięta */ } }
});
const przesun = (ms) => vi.setSystemTime(Date.now() + ms);

const KANALY_ZNANE = ['sklep', 'allegro', 'reczne', 'indywidualne'];
let nr = 0;
function zamowienie(db, { sklep = 'sklep', email = 'kupujacy@example.invalid', metoda = 'dpd' } = {}) {
  nr += 1;
  return zapiszZamowienie(db, sklep, {
    zrodlo_id: 7000 + nr, numer: `L-${nr}`,
    klient: { first_name: 'Anna', last_name: 'Nowak', email: email ?? '', phone: '' },
    dostawa: { first_name: 'Anna', last_name: 'Nowak', address_1: 'Lipowa 7', postcode: '00-950', city: 'Warszawa' },
    metoda_wysylki: metoda, kwota_pobrania: null, chce_fakture: 0, nip: null,
    kwota_brutto: '189.00', koszt_dostawy_brutto: '19.00', koszt_dostawy_netto: '15.45', status_woo: 'processing',
    oplacone_at: null, anulowane: 0, utworzone_at: '2026-10-20T09:00:00', // dzień przed włączeniem reguł w testach (recenzja 08: starsze niż 14 dni = historia)
    pozycje: [{ zrodlo_id: 9000 + nr, nazwa: 'Lampa stołowa Grzybek 30 cm', sku: 'LMP-GRZ-30', ilosc: 1, cena_brutto: '189.00',
      cena_netto: '153.66', brutto_linii: '189.00', netto_linii: '153.66', vat: null }],
  });
}
const ustawStatus = (db, id, status) =>
  zapiszFaktyStatusu(db, id, { ...faktyDlaStatusu(pobierzZamowienie(db, id), status), kto: 'adam' });
let numerListu = 100;
function paczka(db, id, { status = 'nadana', numer } = {}) {
  numerListu += 1;
  const n = numer ?? `00000000${numerListu}U`;
  if (status === 'nadana') return zarejestrujPrzesylkeReczna(db, id, { kurier: 'dpd', kolejnosc: Number(db.prepare('SELECT COUNT(*) AS n FROM przesylki WHERE zamowienie_id = ?').get(id).n) + 1, numerListu: n });
  db.prepare(`INSERT INTO przesylki (zamowienie_id, kurier, status, numer_listu, kolejnosc, utworzona_at) VALUES (?, 'dpd', ?, ?, ?, ?)`)
    .run(id, status, n, 1, new Date().toISOString());
  return db.prepare('SELECT * FROM przesylki WHERE id = last_insert_rowid()').get();
}

function srodowisko({ poczta = true, wyslij = () => {} } = {}) {
  const db = openOmsDb(':memory:', { moduly: kolejnoscBudowy(MODULY) });
  otwarte.push(db);
  const listy = [];
  const mailer = { sendMail: async (m) => { listy.push(m); await wyslij(m); } };
  const wiadomosci = createWiadomosci({ db, mailer, config: { klienciZbiorczy: [],
    oprawaPoczty: { podpis: 'Pracownia Przykładowa', footer: 'Stopka przykładowa' } } });
  const akcje = utworzAkcje({ wiadomosci: () => wiadomosci });
  const silnik = createSilnikAutomatyzacji({ db, zdarzenia: ZDARZENIA, akcje, sprawdzWarunki: sprawdzanieWarunkow,
    pocztaGotowa: () => poczta });
  return { db, listy, wiadomosci, silnik, przebieg: () => silnik.przebieg() };
}
const WARUNKI = (o = {}) => ({ kanaly: ['sklep'], kanalyZnane: KANALY_ZNANE, statusy: [], maNumerListu: false, metody: [],
  pobranie: 'dowolne', ...o });
function regula(e, o = {}) {
  const id = utworzRegule(e.db, { nazwa: 'Wysłane — sklep', zdarzenie: 'status_zmieniony', zdarzenie_json: { status: 'wyslane' },
    warunki: WARUNKI({ statusy: ['wyslane'], maNumerListu: true }), akcja: 'mail_kupujacy', akcja_json: { szablon: 'wyslane' },
    opoznienie_min: 0, limit_na_godzine: 20, ...o }, { login: 'adam' });
  wlaczRegule(e.db, id, { login: 'adam' });
  return id;
}
const wykonania = (db) => db.prepare('SELECT * FROM automatyzacje_wykonania ORDER BY id').all();
const log = (db, id) => db.prepare('SELECT akcja, wynik FROM log WHERE zamowienie_id = ? ORDER BY id').all(id);
const rejestr = (db, id) => db.prepare('SELECT temat_id, adresat, kto FROM wiadomosci WHERE zamowienie_id = ? ORDER BY id').all(id);

describe('rejestr modułu', () => {
  it('zdarzenia „Paczka nadana” i „Status zmienił się na” są w rejestrze; akcja „mail do kupującego” też', () => {
    // PRZ-110.02 (D1): dochodzi „Nowe zamówienie” — rejestr ma teraz cztery zdarzenia.
    expect(ZDARZENIA.map((z) => z.klucz)).toEqual(['paczka_nadana', 'paczka_odebrana', 'status_zmieniony', 'zamowienie_nowe']);
    expect(utworzAkcje({ wiadomosci: () => null }).map((a) => a.klucz)).toEqual(['mail_kupujacy']);
  });
});

describe('1. status zmienił się na …', () => {
  it('Wysłane po granicy → 1 wykonanie, zdarzenie_at = wyslane_at, mail wychodzi', async () => {
    const e = srodowisko();
    regula(e);
    przesun(MIN);
    const id = zamowienie(e.db);
    paczka(e.db, id);
    ustawStatus(e.db, id, 'wyslane');
    przesun(MIN);
    await e.przebieg();
    const [w] = wykonania(e.db);
    expect(wykonania(e.db)).toHaveLength(1);
    expect(w.zdarzenie_at).toBe(pobierzZamowienie(e.db, id).wyslane_at);
    expect(w).toMatchObject({ stan: 'wyslane', przedmiot: `zamowienie:${id}`, adresat: 'kupujacy@example.invalid' });
    expect(e.listy).toHaveLength(1);
  });
  it('ręczna rejestracja paczki (oznaczWyslane) → 1', async () => {
    const e = srodowisko();
    regula(e);
    przesun(MIN);
    const id = zamowienie(e.db);
    paczka(e.db, id);
    oznaczWyslane(e.db, id);
    przesun(MIN);
    await e.przebieg();
    expect(wykonania(e.db).map((w) => w.stan)).toEqual(['wyslane']);
  });
  it('„Wysłane” sprzed granicy (włączenia) → 0 wykonań, 0 maili', async () => {
    const e = srodowisko();
    const id = zamowienie(e.db);
    paczka(e.db, id);
    ustawStatus(e.db, id, 'wyslane');
    przesun(MIN);
    regula(e);
    przesun(MIN);
    await e.przebieg();
    expect(wykonania(e.db)).toEqual([]);
    expect(e.listy).toEqual([]);
  });
  it('zamówienie wysłane przed granicą, potem poller przepisuje `zmienione_at` (bez zmiany statusu) → 0 wykonań', async () => {
    const e = srodowisko();
    const id = zamowienie(e.db);
    paczka(e.db, id);
    ustawStatus(e.db, id, 'wyslane');
    przesun(MIN);
    regula(e);
    przesun(MIN);
    e.db.prepare('UPDATE zamowienia SET zmienione_at = ? WHERE id = ?').run(new Date().toISOString(), id);
    przesun(MIN);
    await e.przebieg();
    expect(wykonania(e.db)).toEqual([]);
  });
  it('„W realizacji” po granicy → 1 (reguła na W realizacji, szablon własny, warunek domyślny = status zdarzenia)', async () => {
    const e = srodowisko();
    e.db.prepare("INSERT INTO ustawienia (klucz, wartosc, zmienione_at) VALUES ('szablony.wiadomosci', ?, '2026-10-21')")
      .run(JSON.stringify({ wbudowane: {}, wlasne: [{ id: 'wlasny-1', nazwa: 'Przyjęte do realizacji', temat: 'Zaczynamy {numer_zamowienia}', tresc: 'Robimy.\n\n{podpis}' }], licznik: 1 }));
    regula(e, { zdarzenie_json: { status: 'w_realizacji' }, warunki: WARUNKI({ statusy: ['w_realizacji'] }), akcja_json: { szablon: 'wlasny-1' } });
    przesun(MIN);
    const id = zamowienie(e.db);
    ustawStatus(e.db, id, 'w_realizacji');
    przesun(MIN);
    await e.przebieg();
    expect(wykonania(e.db).map((w) => w.stan)).toEqual(['wyslane']);
    expect(rejestr(e.db, id)).toEqual([{ temat_id: 'wlasny-1', adresat: 'kupujacy@example.invalid', kto: 'automat: Wysłane — sklep' }]);
  });
  it('status własny ustawiony po granicy → 1; ustawiony ponownie po pominięciu → otwarte ponownie', async () => {
    const e = srodowisko();
    zapiszStatusy(e.db, [...domyslneStatusy(), { klucz: 'w_klosz', etykieta: 'Czeka na klosz', kolor: domyslneStatusy()[0].kolor, jak: 'w_realizacji' }]);
    e.db.prepare("INSERT INTO ustawienia (klucz, wartosc, zmienione_at) VALUES ('szablony.wiadomosci', ?, '2026-10-21')")
      .run(JSON.stringify({ wbudowane: {}, wlasne: [{ id: 'wlasny-1', nazwa: 'Klosz', temat: 'Klosz', tresc: 'Czekamy na klosz.\n\n{podpis}' }], licznik: 1 }));
    regula(e, { zdarzenie_json: { status: 'w_klosz' }, warunki: WARUNKI({ statusy: ['w_klosz'] }), akcja_json: { szablon: 'wlasny-1' }, opoznienie_min: 30 });
    przesun(MIN);
    const id = zamowienie(e.db);
    ustawStatus(e.db, id, 'w_klosz');
    przesun(MIN);
    await e.przebieg();
    expect(wykonania(e.db).map((w) => w.stan)).toEqual(['zaplanowane']);
    ustawStatus(e.db, id, 'nowe'); // cofnięte w oknie opóźnienia
    przesun(31 * MIN);
    await e.przebieg();
    expect(wykonania(e.db)[0]).toMatchObject({ stan: 'pominiete', powod_kod: 'warunek' });
    ustawStatus(e.db, id, 'w_klosz'); // ten sam status własny jeszcze raz — nowsze ustawione_at
    przesun(MIN);
    await e.przebieg();
    expect(wykonania(e.db)[0].stan).toBe('zaplanowane');
    przesun(31 * MIN);
    await e.przebieg();
    expect(wykonania(e.db).map((w) => w.stan)).toEqual(['wyslane']);
    expect(e.listy).toHaveLength(1);
  });
  it('klucz statusu własnego usunięty z Ustawień → wykonania nie powstają; detektor zgłasza „status nie istnieje”', async () => {
    const e = srodowisko();
    regula(e, { zdarzenie_json: { status: 'w_usuniety' }, warunki: WARUNKI() });
    przesun(MIN);
    const id = zamowienie(e.db);
    e.db.prepare("INSERT INTO zamowienia_status_wlasny (zamowienie_id, klucz, ustawione_at, kto) VALUES (?, 'w_usuniety', ?, 'x')")
      .run(id, new Date().toISOString());
    przesun(MIN);
    await e.przebieg();
    expect(wykonania(e.db)).toEqual([]);
    expect(zdarzenieStatusZmieniony.bladParametru(e.db, { status: 'w_usuniety' })).toContain('nie istnieje');
    expect(zdarzenieStatusZmieniony.bladParametru(e.db, { status: 'wyslane' })).toBeNull();
  });
  it('cofnięte przed upływem opóźnienia → pominięte „status jest teraz W realizacji”; ponowne Wysłane → otwarte, wysłane raz', async () => {
    const e = srodowisko();
    regula(e, { opoznienie_min: 30 });
    przesun(MIN);
    const id = zamowienie(e.db);
    paczka(e.db, id);
    ustawStatus(e.db, id, 'wyslane');
    przesun(MIN);
    await e.przebieg();
    ustawStatus(e.db, id, 'w_realizacji');
    przesun(30 * MIN);
    await e.przebieg();
    expect(wykonania(e.db)[0]).toMatchObject({ stan: 'pominiete', powod_kod: 'warunek' });
    expect(wykonania(e.db)[0].powod).toContain('Status jest teraz W realizacji');
    expect(log(e.db, id).filter((l) => l.akcja === 'automatyzacja.pominieta').map((l) => l.wynik).join(' ')).toContain('Status jest teraz W realizacji');
    expect(e.listy).toEqual([]);
    ustawStatus(e.db, id, 'wyslane');
    przesun(MIN);
    await e.przebieg();
    expect(wykonania(e.db)[0].stan).toBe('zaplanowane');
    przesun(31 * MIN);
    await e.przebieg();
    await e.przebieg();
    expect(wykonania(e.db).map((w) => w.stan)).toEqual(['wyslane']);
    expect(e.listy).toHaveLength(1);
    // trzecie „Wysłane” po wysłanym → bez drugiego maila
    ustawStatus(e.db, id, 'w_realizacji');
    ustawStatus(e.db, id, 'wyslane');
    przesun(31 * MIN);
    await e.przebieg();
    expect(e.listy).toHaveLength(1);
  });
  it('zamówienie dołączone do głównego → pominięte „dołączone do zamówienia N”; główne → wysłane', async () => {
    const e = srodowisko();
    regula(e);
    const glowne = zamowienie(e.db);
    const dolaczone = zamowienie(e.db);
    scalZamowienia(e.db, { glowneId: glowne, dolaczoneIds: [dolaczone], wysylka: DECYZJE_WYSYLKI[0], kto: 'adam' });
    przesun(MIN);
    paczka(e.db, glowne);
    ustawStatus(e.db, glowne, 'wyslane');
    expect(pobierzZamowienie(e.db, dolaczone).wyslane_at).toBe(pobierzZamowienie(e.db, glowne).wyslane_at);
    przesun(MIN);
    await e.przebieg();
    const stan = Object.fromEntries(wykonania(e.db).map((w) => [w.zamowienie_id, w]));
    expect(stan[glowne].stan).toBe('wyslane');
    expect(stan[dolaczone]).toMatchObject({ stan: 'pominiete', powod_kod: 'dolaczone' });
    expect(stan[dolaczone].powod).toContain(`dołączone do zamówienia ${glowne}`);
    expect(e.listy).toHaveLength(1);
  });
});

describe('2. przykład właściciela end-to-end', () => {
  it('status → Wysłane, warunki kanał + Wysłane + numer listu, 30 min: bez paczki pominięte; paczka potem nie wysyła; ponowne Wysłane → mail z numerem', async () => {
    const e = srodowisko();
    regula(e, { opoznienie_min: 30 });
    przesun(MIN);
    const id = zamowienie(e.db);
    ustawStatus(e.db, id, 'wyslane'); // bez paczki
    przesun(MIN);
    await e.przebieg();
    przesun(30 * MIN);
    await e.przebieg();
    expect(wykonania(e.db)[0]).toMatchObject({ stan: 'pominiete', powod_kod: 'warunek' });
    expect(wykonania(e.db)[0].powod).toContain('nie ma paczki z numerem listu');
    // paczka nadana potem: zdarzeniem jest status, więc nic
    const p = paczka(e.db, id);
    przesun(MIN);
    await e.przebieg();
    przesun(31 * MIN);
    await e.przebieg();
    expect(e.listy).toEqual([]);
    // ponowne ustawienie Wysłane po cofnięciu → mail z numerem
    ustawStatus(e.db, id, 'w_realizacji');
    ustawStatus(e.db, id, 'wyslane');
    przesun(MIN);
    await e.przebieg();
    przesun(30 * MIN);
    await e.przebieg();
    expect(wykonania(e.db).map((w) => w.stan)).toEqual(['wyslane']);
    expect(e.listy).toHaveLength(1);
    expect(e.listy[0].to).toBe('kupujacy@example.invalid');
    expect(e.listy[0].text).toContain(p.numer_listu);
    expect(e.listy[0].text).toContain(`https://tracktrace.dpd.com.pl/parcelDetails?p1=${p.numer_listu}`);
  });
});

describe('3. paczka nadana', () => {
  const nadana = (e, o = {}) => regula(e, { nazwa: 'Paczka — sklep', zdarzenie: 'paczka_nadana', zdarzenie_json: {},
    warunki: WARUNKI({ maNumerListu: true }), ...o });
  it('paczka „nadana” z numerem po granicy → 1 wykonanie i mail', async () => {
    const e = srodowisko();
    nadana(e);
    przesun(MIN);
    const id = zamowienie(e.db);
    paczka(e.db, id);
    przesun(MIN);
    await e.przebieg();
    expect(wykonania(e.db).map((w) => [w.zamowienie_id, w.stan])).toEqual([[id, 'wyslane']]);
    expect(e.listy).toHaveLength(1);
  });
  it('„do wyjaśnienia” z numerem → 0; po domknięciu → 1', async () => {
    const e = srodowisko();
    nadana(e);
    przesun(MIN);
    const id = zamowienie(e.db);
    const p = paczka(e.db, id, { status: 'do_wyjasnienia' });
    przesun(MIN);
    await e.przebieg();
    expect(wykonania(e.db)).toEqual([]);
    przesun(60 * MIN); // domknięcie godzinę później — kursor już daleko za `utworzona_at` paczki
    domknijPrzesylke(e.db, p.id);
    przesun(MIN);
    await e.przebieg();
    expect(wykonania(e.db).map((w) => w.stan)).toEqual(['wyslane']);
  });
  it('„blad” → 0; paczka sprzed granicy → 0', async () => {
    const e = srodowisko();
    const stara = zamowienie(e.db);
    paczka(e.db, stara);
    przesun(MIN);
    nadana(e);
    przesun(MIN);
    paczka(e.db, zamowienie(e.db), { status: 'blad' });
    przesun(MIN);
    await e.przebieg();
    expect(wykonania(e.db)).toEqual([]);
  });
  it('dwie paczki jednego zamówienia w oknie 30 min → 1 wykonanie, mail z dwoma numerami', async () => {
    const e = srodowisko();
    nadana(e, { opoznienie_min: 30 });
    przesun(MIN);
    const id = zamowienie(e.db);
    const a = paczka(e.db, id);
    przesun(MIN);
    await e.przebieg();
    const b = paczka(e.db, id);
    przesun(MIN);
    await e.przebieg();
    przesun(30 * MIN);
    await e.przebieg();
    await e.przebieg();
    expect(wykonania(e.db)).toHaveLength(1);
    expect(wykonania(e.db)[0]).toMatchObject({ stan: 'wyslane', przedmiot: `zamowienie:${id}` });
    expect(e.listy).toHaveLength(1);
    expect(e.listy[0].text).toContain(a.numer_listu);
    expect(e.listy[0].text).toContain(b.numer_listu);
  });
  it('paczka dołożona po wysłanym mailu nie daje drugiego maila', async () => {
    const e = srodowisko();
    nadana(e);
    przesun(MIN);
    const id = zamowienie(e.db);
    paczka(e.db, id);
    przesun(MIN);
    await e.przebieg();
    paczka(e.db, id);
    przesun(MIN);
    await e.przebieg();
    expect(e.listy).toHaveLength(1);
  });
});

describe('4. kanały', () => {
  it('reguła tylko na kanał sklepu: zamówienie Allegro z paczką → 0 wykonań, 0 wpisów w historii; zamówienie sklepu → 1', async () => {
    const e = srodowisko();
    regula(e, { nazwa: 'Paczka — sklep', zdarzenie: 'paczka_nadana', zdarzenie_json: {}, warunki: WARUNKI() });
    przesun(MIN);
    const allegro = zamowienie(e.db, { sklep: 'allegro' });
    const sklep = zamowienie(e.db);
    const przed = log(e.db, allegro).length;
    paczka(e.db, allegro);
    paczka(e.db, sklep);
    przesun(MIN);
    await e.przebieg();
    expect(wykonania(e.db).map((w) => w.zamowienie_id)).toEqual([sklep]);
    expect(log(e.db, allegro).filter((l) => l.akcja.startsWith('automatyzacja') || l.akcja.startsWith('wiadomosc'))).toEqual([]);
    expect(log(e.db, allegro)).toHaveLength(przed); // zapis paczki funkcją bazy nie loguje; automat też nie
  });
  it('detektory same odsiewają obce kanały (filtr w SQL, nie tylko w silniku)', () => {
    const e = srodowisko();
    const allegro = zamowienie(e.db, { sklep: 'allegro' });
    paczka(e.db, allegro);
    ustawStatus(e.db, allegro, 'wyslane');
    const granica = { at: new Date(START - MIN).toISOString(), zamowienia: 0, przesylki: 0 };
    const opcje = { granica, od: granica.at, limit: 100, kanaly: ['sklep'], regula_id: 1 };
    expect(zdarzeniePaczkaNadana.kandydaci(e.db, opcje)).toEqual([]);
    expect(zdarzenieStatusZmieniony.kandydaci(e.db, { ...opcje, parametr: { status: 'wyslane' } })).toEqual([]);
    expect(zdarzeniePaczkaNadana.kandydaci(e.db, { ...opcje, kanaly: ['allegro'] })).toHaveLength(1);
    expect(zdarzenieStatusZmieniony.kandydaci(e.db, { ...opcje, kanaly: ['allegro'], parametr: { status: 'wyslane' } })).toHaveLength(1);
  });
});

describe('kursor złożony (recenzja 07, usterka 3): 1100 zdarzeń w tej samej sekundzie → wszystkie wykryte', () => {
  // Zamówienia wstawione wprost (szybko): bez e-maila i bez warunków — wykonanie i tak się pominie; liczy się wykrycie.
  function masowo(e, n, { paczki = false, wyslane = false } = {}) {
    const chwila = new Date().toISOString();
    const wstaw = e.db.prepare(`INSERT INTO zamowienia (sklep, zrodlo_id, numer, kwota_brutto, utworzone_at, wyslane_at)
      VALUES ('sklep', ?, ?, '10.00', '2026-10-01T09:00:00', ?)`);
    const paczka1 = e.db.prepare(`INSERT INTO przesylki (zamowienie_id, kurier, status, numer_listu, kolejnosc, utworzona_at)
      VALUES (?, 'dpd', 'nadana', ?, 1, ?)`);
    const ids = [];
    e.db.exec('BEGIN');
    for (let i = 0; i < n; i += 1) {
      nr += 1;
      const id = Number(wstaw.run(90000 + nr, `M-${nr}`, wyslane ? chwila : null).lastInsertRowid);
      if (paczki) paczka1.run(id, `M${nr}`, chwila);
      ids.push(id);
    }
    e.db.exec('COMMIT');
    return ids;
  }
  /** Admin akceptuje zaległe po każdym wstrzymaniu (bezpiecznik >50); w drugim przebiegu dochodzi jedno nowe zdarzenie. */
  async function dokoncz(e, id, zrob) {
    let nowe = null;
    for (let i = 0; i < 5; i += 1) {
      wyslijZalegle(e.db, id, {});
      przesun(MIN);
      if (i === 1) nowe = zrob();
      await e.przebieg();
    }
    return nowe;
  }
  it.each([
    ['status zmienił się na Wysłane', { zdarzenie: 'status_zmieniony', zdarzenie_json: { status: 'wyslane' } }, { wyslane: true }],
    ['paczka nadana', { zdarzenie: 'paczka_nadana', zdarzenie_json: {} }, { paczki: true }],
  ])('%s', async (_n, regulaZdarzenia, rodzaj) => {
    const e = srodowisko({ poczta: false });
    const id = regula(e, { ...regulaZdarzenia, warunki: WARUNKI(), limit_na_godzine: 200 });
    przesun(MIN);
    const masowe = masowo(e, 1100, rodzaj);
    przesun(MIN);
    await e.przebieg();
    expect(wykonania(e.db)).toHaveLength(1000);
    const nowe = await dokoncz(e, id, () => masowo(e, 1, rodzaj)[0]);
    const wykryte = new Set(wykonania(e.db).map((w) => w.zamowienie_id));
    expect(masowe.filter((m) => !wykryte.has(m))).toEqual([]);
    expect(wykryte.has(nowe)).toBe(true);
    expect(wykryte.size).toBe(1101);
  });
});

describe('5. pominięcia z wpisem w historii zamówienia', () => {
  const bezStatusu = (e) => regula(e, { nazwa: 'Paczka', zdarzenie: 'paczka_nadana', zdarzenie_json: {}, warunki: WARUNKI({ maNumerListu: true }) });
  it('bez e-maila → pominięte „brak_adresu” z wpisem automatyzacja.pominieta', async () => {
    const e = srodowisko();
    bezStatusu(e);
    przesun(MIN);
    const id = zamowienie(e.db, { email: '' });
    paczka(e.db, id);
    przesun(MIN);
    await e.przebieg();
    expect(wykonania(e.db)[0]).toMatchObject({ stan: 'pominiete', powod_kod: 'brak_adresu' });
    expect(log(e.db, id).find((l) => l.akcja === 'automatyzacja.pominieta').wynik).toContain('nie ma adresu e-mail');
    expect(log(e.db, id).some((l) => l.akcja === 'wiadomosc.nieudane-zlozenie')).toBe(false);
    expect(e.listy).toEqual([]);
  });
  it('anulowane → pominięte „anulowane”', async () => {
    const e = srodowisko();
    bezStatusu(e);
    przesun(MIN);
    const id = zamowienie(e.db);
    paczka(e.db, id);
    ustawStatus(e.db, id, 'anulowane');
    przesun(MIN);
    await e.przebieg();
    expect(wykonania(e.db)[0]).toMatchObject({ stan: 'pominiete', powod_kod: 'anulowane' });
    expect(log(e.db, id).some((l) => l.akcja === 'wiadomosc.nieudane-zlozenie')).toBe(false);
  });
  it('brak poczty → pominięte „brak_poczty”', async () => {
    const e = srodowisko({ poczta: false });
    bezStatusu(e);
    przesun(MIN);
    const id = zamowienie(e.db);
    paczka(e.db, id);
    przesun(MIN);
    await e.przebieg();
    expect(wykonania(e.db)[0]).toMatchObject({ stan: 'pominiete', powod_kod: 'brak_poczty' });
    expect(log(e.db, id).some((l) => l.akcja === 'wiadomosc.nieudane-zlozenie')).toBe(false);
  });
  it('usunięty szablon własny → pominięte „szablon_usuniety”, bez maila', async () => {
    const e = srodowisko();
    regula(e, { nazwa: 'Paczka', zdarzenie: 'paczka_nadana', zdarzenie_json: {}, warunki: WARUNKI(), akcja_json: { szablon: 'wlasny-7' } });
    przesun(MIN);
    const id = zamowienie(e.db);
    paczka(e.db, id);
    przesun(MIN);
    await e.przebieg();
    expect(wykonania(e.db)[0]).toMatchObject({ stan: 'pominiete', powod_kod: 'szablon_usuniety' });
    expect(e.listy).toEqual([]);
  });
});

describe('6. wysłane — ślad w rejestrze, dzienniku i poczcie', () => {
  it('rejestr: temat „wyslane”, kto „automat: <nazwa>”; historia: „Automatycznie (reguła „…”)”; 1 list z numerem i linkiem', async () => {
    const e = srodowisko();
    regula(e);
    przesun(MIN);
    const id = zamowienie(e.db);
    const p = paczka(e.db, id);
    ustawStatus(e.db, id, 'wyslane');
    przesun(MIN);
    await e.przebieg();
    expect(rejestr(e.db, id)).toEqual([{ temat_id: 'wyslane', adresat: 'kupujacy@example.invalid', kto: 'automat: Wysłane — sklep' }]);
    const wpis = log(e.db, id).find((l) => l.akcja === 'wiadomosc.wyslana');
    expect(wpis.wynik).toBe('Automatycznie (reguła „Wysłane — sklep”): „Zamówienie wysłane" wysłane na kupujacy@example.invalid bez załącznika.');
    expect(e.listy).toHaveLength(1);
    expect(e.listy[0].text).toContain(p.numer_listu);
    expect(e.listy[0].text).toContain(`https://tracktrace.dpd.com.pl/parcelDetails?p1=${p.numer_listu}`);
  });
});

describe('7. ten sam mail już poszedł', () => {
  it('ręczne „Zamówienie wysłane” przed terminem → automat pomija z powodem i nie wysyła', async () => {
    const e = srodowisko();
    regula(e, { opoznienie_min: 30 });
    przesun(MIN);
    const id = zamowienie(e.db);
    paczka(e.db, id);
    ustawStatus(e.db, id, 'wyslane');
    przesun(MIN);
    await e.przebieg();
    await e.wiadomosci.wyslij(id, 'wyslane', { ktoKlikal: 'adam' });
    expect(e.listy).toHaveLength(1);
    przesun(30 * MIN);
    await e.przebieg();
    expect(wykonania(e.db)[0]).toMatchObject({ stan: 'pominiete', powod_kod: 'juz_wyslany' });
    expect(wykonania(e.db)[0].powod).toMatch(/„Zamówienie wysłane” poszło już do tego zamówienia ręcznie \(adam\) \d{2}\.\d{2} o \d{2}:\d{2}\./u);
    expect(e.listy).toHaveLength(1);
  });
  it('mail tej samej treści z innej reguły → pominięte „inną regułą”', async () => {
    const e = srodowisko();
    regula(e);
    regula(e, { nazwa: 'Paczka', zdarzenie: 'paczka_nadana', zdarzenie_json: {}, warunki: WARUNKI({ maNumerListu: true }), opoznienie_min: 30 });
    przesun(MIN);
    const id = zamowienie(e.db);
    paczka(e.db, id);
    ustawStatus(e.db, id, 'wyslane');
    przesun(MIN);
    await e.przebieg();
    przesun(31 * MIN);
    await e.przebieg();
    const [pierwsza, druga] = wykonania(e.db);
    expect(pierwsza.stan).toBe('wyslane');
    expect(druga).toMatchObject({ stan: 'pominiete', powod_kod: 'juz_wyslany' });
    expect(druga.powod).toContain('regułą „Wysłane — sklep”');
    expect(e.listy).toHaveLength(1);
  });
});

describe('PRZ-110.06: zmiana szablonu zaplanowanego wykonania', () => {
  it.each([
    ['niepewne', 'niepewne_wczesniej'],
    ['wyslane', 'juz_wyslany'],
  ])('%s: bieżący szablon w wykonaniu i brak drugiego maila z innej reguły', async (stan, powod_kod) => {
    const podczasWysylki = [];
    const e = srodowisko({ wyslij: () => {
      podczasWysylki.push(e.db.prepare("SELECT stan, szablon FROM automatyzacje_wykonania WHERE stan = 'w_toku'").get());
      if (stan === 'niepewne') throw new Error('Brak potwierdzenia po przyjęciu treści');
    } });
    e.db.prepare("INSERT INTO ustawienia (klucz, wartosc, zmienione_at) VALUES ('szablony.wiadomosci', ?, '2026-10-21')")
      .run(JSON.stringify({ wbudowane: {}, wlasne: [
        { id: 'wlasny-1', nazwa: 'Pierwszy', temat: 'Pierwszy szablon', tresc: 'Pierwsza treść.\n\n{podpis}' },
        { id: 'wlasny-2', nazwa: 'Drugi', temat: 'Drugi szablon', tresc: 'Druga treść.\n\n{podpis}' },
      ], licznik: 2 }));
    const ustawienia = { nazwa: 'Pierwsza reguła', zdarzenie: 'status_zmieniony', zdarzenie_json: { status: 'w_realizacji' },
      warunki: WARUNKI(), akcja: 'mail_kupujacy', akcja_json: { szablon: 'wlasny-1' },
      opoznienie_min: 30, limit_na_godzine: 20 };
    const pierwsza = regula(e, ustawienia);
    regula(e, { ...ustawienia, nazwa: 'Druga reguła', akcja_json: { szablon: 'wlasny-2' }, opoznienie_min: 45 });
    przesun(MIN);
    const id = zamowienie(e.db);
    ustawStatus(e.db, id, 'w_realizacji');
    przesun(MIN);
    await e.przebieg();
    expect(wykonania(e.db)[0]).toMatchObject({ stan: 'zaplanowane', szablon: 'wlasny-1' });
    zmienRegule(e.db, pierwsza, { ...ustawienia, akcja_json: { szablon: 'wlasny-2' } });
    przesun(30 * MIN);
    await e.przebieg();
    przesun(15 * MIN);
    await e.przebieg();
    expect.soft(wykonania(e.db)[0]).toMatchObject({ stan, szablon: 'wlasny-2' });
    expect.soft(wykonania(e.db)[1]).toMatchObject({ stan: 'pominiete', powod_kod });
    expect.soft(podczasWysylki).toEqual([{ stan: 'w_toku', szablon: 'wlasny-2' }]);
    expect.soft(e.listy).toHaveLength(1);
    expect(e.listy[0].subject).toBe('Drugi szablon');
    expect(e.listy[0].text).toContain('Druga treść.');
  });
});

describe('8. ręczna ścieżka maila bez zmian (znak w znak)', () => {
  it('wyslij bez trybu: rejestr kto = klikający, wpis „Ręcznie (…)” jak przed C1', async () => {
    const e = srodowisko();
    const id = zamowienie(e.db);
    paczka(e.db, id);
    await e.wiadomosci.wyslij(id, 'wyslane', { ktoKlikal: 'adam' });
    expect(rejestr(e.db, id)).toEqual([{ temat_id: 'wyslane', adresat: 'kupujacy@example.invalid', kto: 'adam' }]);
    expect(log(e.db, id).find((l) => l.akcja === 'wiadomosc.wyslana').wynik)
      .toBe('Ręcznie (adam): „Zamówienie wysłane" wysłane na kupujacy@example.invalid bez załącznika.');
  });
});

describe('PRZ-110.03: anulowanie przed wykonaniem automatu', () => {
  const zdarzenia = ['status_zmieniony', 'paczka_nadana', 'paczka_odebrana'];
  function przygotuj(zdarzenie, szablon = 'wlasny-1') {
    const e = srodowisko();
    e.db.prepare("INSERT INTO ustawienia (klucz, wartosc, zmienione_at) VALUES ('szablony.wiadomosci', ?, '2026-10-21')")
      .run(JSON.stringify({ wbudowane: {}, wlasne: [{ id: 'wlasny-1', nazwa: 'Informacja o zamówieniu',
        temat: 'Informacja {numer_zamowienia}', tresc: 'Wiadomość o zamówieniu.\n\n{podpis}' }], licznik: 1 }));
    regula(e, { nazwa: 'Informacja', zdarzenie, zdarzenie_json: zdarzenie === 'status_zmieniony' ? { status: 'w_realizacji' } : {},
      warunki: WARUNKI(), akcja_json: { szablon }, opoznienie_min: 30 });
    przesun(MIN);
    const id = zamowienie(e.db);
    const p = paczka(e.db, id);
    if (zdarzenie === 'paczka_odebrana') {
      e.db.prepare('UPDATE przesylki SET odebrana_at = ? WHERE id = ?').run(new Date().toISOString(), p.id);
    }
    ustawStatus(e.db, id, 'w_realizacji');
    return { ...e, id };
  }

  it.each(zdarzenia.flatMap((zdarzenie) => ['wlasny-1', 'wyslane'].map((szablon) => [zdarzenie, szablon])))
  ('%s, %s: anulowane po zdarzeniu → pominięte z kodem i zdaniem w historii, bez maila', async (zdarzenie, szablon) => {
    const e = przygotuj(zdarzenie, szablon);
    await e.przebieg();
    expect(wykonania(e.db)[0].stan).toBe('zaplanowane');
    przesun(MIN);
    ustawStatus(e.db, e.id, 'anulowane');
    przesun(30 * MIN);
    await e.przebieg();
    expect(wykonania(e.db)[0]).toMatchObject({ stan: 'pominiete', powod_kod: 'anulowane',
      powod: 'Zamówienie jest anulowane — wiadomości do klienta nie wysyłamy.' });
    expect(log(e.db, e.id).find((l) => l.akcja === 'automatyzacja.pominieta').wynik)
      .toContain('Zamówienie jest anulowane — wiadomości do klienta nie wysyłamy.');
    expect(log(e.db, e.id).some((l) => l.akcja.startsWith('wiadomosc.'))).toBe(false);
    expect(rejestr(e.db, e.id)).toEqual([]);
    expect(e.listy).toEqual([]);
  });

  it.each(zdarzenia)('%s: własny + nieanulowane → wysłane', async (zdarzenie) => {
    const e = przygotuj(zdarzenie);
    await e.przebieg();
    przesun(31 * MIN);
    await e.przebieg();
    expect(wykonania(e.db)[0].stan).toBe('wyslane');
    expect(rejestr(e.db, e.id)).toEqual([{ temat_id: 'wlasny-1', adresat: 'kupujacy@example.invalid', kto: 'automat: Informacja' }]);
    expect(e.listy).toHaveLength(1);
  });

  it('karta: podgląd i ręczna wysyłka własnego do anulowanego nadal działają', async () => {
    const e = przygotuj('status_zmieniony');
    ustawStatus(e.db, e.id, 'anulowane');
    const app = buildOmsServer({ db: e.db, config: { auth: { user: 'operator', pass: 'x' } }, wiadomosci: e.wiadomosci,
      poller: { stan: () => ({ ostatni_przebieg_at: null, ostatni_blad: null }) } });
    const headers = { authorization: `Basic ${Buffer.from('operator:x').toString('base64')}`, origin: 'http://localhost' };
    try {
      const karta = await app.inject({ method: 'GET', url: `/zamowienia/${e.id}?wiadomosc=wlasny-1`, headers });
      expect(karta.statusCode).toBe(200);
      expect(karta.body).toContain(`action="/zamowienia/${e.id}/wiadomosc/wlasny-1"`);
      expect(e.listy).toEqual([]);
      const wyslane = await app.inject({ method: 'POST', url: `/zamowienia/${e.id}/wiadomosc/wlasny-1`, headers });
      expect(wyslane.statusCode).toBe(302);
      expect(rejestr(e.db, e.id)).toEqual([{ temat_id: 'wlasny-1', adresat: 'kupujacy@example.invalid', kto: 'operator' }]);
      expect(e.listy).toHaveLength(1);
    } finally { await app.close(); }
  });
});
