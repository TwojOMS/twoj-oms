import { describe, it, expect, beforeEach, vi } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { zapiszZamowienie, pobierzZamowienie } from '../../../src/oms/db/zamowienia.js';
import { indeksListy } from '../../../src/oms/db/indeks-listy.js';
import { buildOmsServer } from '../../pomoc/serwer-parytetu.ts';
import { createSyncSklep } from '../../../src/moduly/zamowienia/services/sync-sklep.js';
import { createFaktura } from '../../../src/moduly/faktury/services/faktura.js';
import { podzielDoFaktury } from '../../../src/domena/masowe.js';
import { czyWolnoWystawic } from '../../../src/domena/proforma-stan.js';
import { PDFTOTEXT, pdfNaTekst } from './_pdf-tekst.js';
import { dodajWplateReczna } from '../../../src/oms/db/platnosci.js';

// PRZ-101.04 — scalanie zamówień: trasy, baza, lista, faktura grupy, przeniesienie „wysłane”.
const config = { auth: { user: 'adam', pass: 'x' } };
const naglowek = { authorization: 'Basic ' + Buffer.from('adam:x').toString('base64'), origin: 'http://localhost' };
const poller = { stan: () => ({ ostatni_przebieg_at: null, ostatni_blad: null }) };

const zmapowane = (id, nad = {}) => ({
  zrodlo_id: id, numer: `S-${id}`,
  klient: { first_name: 'Anna', last_name: 'Przykładowa', email: 'anna@example.invalid', phone: '600100200' },
  dostawa: { first_name: 'Anna', last_name: 'Przykładowa', address_1: 'Lipowa 3', postcode: '00-950', city: 'Testowo', country: 'PL' },
  metoda_wysylki: 'dpd', kwota_pobrania: null, chce_fakture: 1, nip: '1111111111',
  kwota_brutto: '115.00', koszt_dostawy_brutto: '15.00', status_woo: 'processing', oplacone_at: '2026-10-10T10:00:00Z',
  anulowane: 0, utworzone_at: `2026-10-${String(10 + (id % 10)).padStart(2, '0')}T09:00:00Z`,
  pozycje: [{ nazwa: `Lampa ${id}`, sku: `L-${id}`, ilosc: 2, cena_brutto: '50.00', brutto_linii: '100.00', vat: null }],
  ...nad,
});

let db; let app; let woo; let infakt;
const zbuduj = async (dodatki = {}) => {
  app = buildOmsServer({
    db, config, poller,
    syncSklep: createSyncSklep({ db, klienci: { sklep_a: woo } }),
    faktura: createFaktura({ db, infakt }),
    ...dodatki,
  });
  await app.ready();
};
const post = (url, payload) => app.inject({ method: 'POST', url, headers: naglowek, payload });
const get = (url) => app.inject({ method: 'GET', url, headers: naglowek });
const zam = (id, nad = {}, sklep = 'sklep_a') => zapiszZamowienie(db, sklep, zmapowane(id, nad), {});
const kolumna = (id, k) => db.prepare(`SELECT ${k} FROM zamowienia WHERE id = ?`).get(id)[k];

beforeEach(async () => {
  db = openOmsDb(':memory:');
  woo = { ustawStatus: vi.fn(async (id, status) => ({ id, status })) };
  infakt = {
    znajdzKlientaPoNip: vi.fn().mockResolvedValue(7),
    zalozKlienta: vi.fn(),
    wystaw: vi.fn().mockResolvedValue({ uuid: 'u1', numer: 'FV/1/10/2026', ksefStatus: null }),
    oznaczZaplacona: vi.fn().mockResolvedValue({ referencja: 'r' }),
  };
  await zbuduj();
});

async function scal(a, b, wysylka = 'suma') {
  const r = await post('/zamowienia/scal', { id: [String(a), String(b)], glowne: String(a), wysylka });
  expect(r.statusCode, r.body).toBe(302);
  return r;
}

describe('migracja zamowienia/3 (scalenia; 2 = statusy własne)', () => {
  it('dokłada scalone_do i scalenie_json; świeże zamówienie ma obie puste', () => {
    const kol = db.prepare('PRAGMA table_info(zamowienia)').all().map((c) => c.name);
    expect(kol).toEqual(expect.arrayContaining(['scalone_do', 'scalenie_json']));
    const a = zam(1);
    expect(kolumna(a, 'scalone_do')).toBeNull();
    expect(kolumna(a, 'scalenie_json')).toBeNull();
    expect(db.prepare("SELECT 1 FROM migracje WHERE modul = 'zamowienia' AND numer = 3").get()).toBeTruthy();
  });
});

describe('ekran scalania i wykonanie', () => {
  it('podgląd: domyślnie najstarsze jako główne, kwoty wysyłki i przycisk „Scal”', async () => {
    const b = zam(2, { koszt_dostawy_brutto: '20.00', kwota_brutto: '120.00' }); const a = zam(1);
    const r = await post('/zamowienia/masowe/scal-podglad', { id: [String(b), String(a)] });
    expect(r.statusCode).toBe(200);
    expect(r.body).toMatch(new RegExp(`value="${a}" id="glowne-${a}" checked`));
    // PRZ-101.11: S-2 jest opłacone — jego wysyłka wchodzi także przy „z głównego” (do 19.10: 15.00 zł).
    expect(r.body).toContain('z zamówienia głównego — <b>35.00 zł</b>');
    expect(r.body).toContain('suma wysyłek — <b>35.00 zł</b>');
    expect(r.body).toContain('Na fakturę wejdzie wysyłka S-1 15.00 zł, S-2 20.00 zł — każda osobną pozycją; faktura 235.00 zł.');
    expect(r.body).toContain('Scal zamówienia');
    // Podgląd niczego nie zapisuje.
    expect(kolumna(b, 'scalone_do')).toBeNull();
  });

  it('PRZ-101.11 podgląd: dołączone nieopłacone — zdanie mówi, że jego wysyłka wypada przy „z głównego”', async () => {
    const a = zam(1); const b = zam(2, { koszt_dostawy_brutto: '20.00', kwota_brutto: '120.00', oplacone_at: null });
    const r = await post('/zamowienia/masowe/scal-podglad', { id: [String(a), String(b)] });
    expect(r.body).toContain('z zamówienia głównego — <b>15.00 zł</b>');
    expect(r.body).toContain('Na fakturę wejdzie wysyłka S-1 15.00 zł; wysyłka nieopłaconego S-2 20.00 zł wypada; faktura 215.00 zł.');
    expect(r.body).toContain('Na fakturę wejdzie wysyłka S-1 15.00 zł, S-2 20.00 zł — każda osobną pozycją; faktura 235.00 zł.');
  });

  it('wykonanie: PRG na kartę głównego, dołączone dostaje scalone_do, główne decyzję', async () => {
    const a = zam(1); const b = zam(2);
    const r = await scal(a, b, 'suma');
    expect(r.headers.location).toBe(`/zamowienia/${a}#scalenie`);
    expect(kolumna(b, 'scalone_do')).toBe(a);
    expect(JSON.parse(kolumna(a, 'scalenie_json'))).toMatchObject({ wysylka: 'suma', dolaczone: [b] });
  });

  it('Allegro w zaznaczeniu: podgląd bez „Scal”, wykonanie 400 i nic nie zapisane', async () => {
    const a = zam(1); const b = zam(2, {}, 'allegro_a');
    const p = await post('/zamowienia/masowe/scal-podglad', { id: [String(a), String(b)] });
    expect(p.body).toContain('jest z Allegro — zamówień z Allegro nie scalamy');
    expect(p.body).not.toContain('Scal zamówienia');
    const r = await post('/zamowienia/scal', { id: [String(a), String(b)], glowne: String(a), wysylka: 'suma' });
    expect(r.statusCode).toBe(400);
    expect(kolumna(b, 'scalone_do')).toBeNull();
    expect(kolumna(a, 'scalenie_json')).toBeNull();
  });

  it('ostrzeżenie (faktura głównego) wymaga „Rozumiem”', async () => {
    const a = zam(1); const b = zam(2);
    db.prepare("INSERT INTO faktury (zamowienie_id, numer, utworzona_at) VALUES (?, 'FV/7/2026', '2026-10-11T00:00:00Z')").run(a);
    const bez = await post('/zamowienia/scal', { id: [String(a), String(b)], glowne: String(a), wysylka: 'glowne' });
    expect(bez.statusCode).toBe(400);
    expect(bez.body).toContain('faktura NIE obejmuje dołączonych pozycji');
    const z = await post('/zamowienia/scal', { id: [String(a), String(b)], glowne: String(a), wysylka: 'glowne', rozumiem: '1' });
    expect(z.statusCode).toBe(302);
  });

  it('główne za pobraniem — odmowa, nic nie zapisane', async () => {
    const a = zam(1, { metoda_wysylki: 'dpd_pobranie', pobranie: 1, kwota_pobrania: '115.00', oplacone_at: null });
    const b = zam(2);
    expect(pobierzZamowienie(db, a).pobranie).toBe(1);
    const r = await post('/zamowienia/scal', { id: [String(a), String(b)], glowne: String(a), wysylka: 'suma' });
    expect(r.statusCode).toBe(400);
    expect(r.body).toContain('zamówień za pobraniem nie scalamy — kwota pobrania obejmowałaby tylko jedno zamówienie');
    expect(kolumna(b, 'scalone_do')).toBeNull();
  });

  it('drugie scalenie tego samego dołączonego — odmowa', async () => {
    const a = zam(1); const b = zam(2); const c = zam(3);
    await scal(a, b);
    const r = await post('/zamowienia/scal', { id: [String(c), String(b)], glowne: String(c), wysylka: 'suma' });
    expect(r.statusCode).toBe(400);
    expect(r.body).toContain('jest już dołączone');
  });
});

describe('lista, liczniki, wyszukiwanie, karta', () => {
  it('dołączone znika z listy i z licznika „wszystkie”; fraza z jego numerem prowadzi do głównego', async () => {
    const a = zam(1); const b = zam(2); zam(3);
    const indeks = indeksListy(db);
    await indeks.odswiez();
    expect(indeks.liczniki(Date.now()).wszystkie).toBe(3);
    await scal(a, b);
    await indeks.odswiez();
    expect(indeks.liczniki(Date.now()).wszystkie).toBe(2);
    expect(indeks.liczniki(Date.now()).statusy.nowe).toBe(2);
    const lista = await get('/?wszystkie=1');
    expect(lista.body).toContain(`href="/zamowienia/${a}`);
    expect(lista.body).toContain('S-3');
    expect(lista.body).not.toContain(`href="/zamowienia/${b}`);
    expect(lista.body).not.toContain('S-2');
    const szukaj = indeks.strona({ zakladka: null, filtry: null, szukaj: 'S-2', offset: 0, limit: 50, teraz: Date.now() });
    expect(szukaj.ids).toEqual([a]);
  });

  it('karta dołączonego przekierowuje do głównego; karta głównego pokazuje pozycje grupy i sumę', async () => {
    const a = zam(1); const b = zam(2, { koszt_dostawy_brutto: '20.00', kwota_brutto: '120.00' });
    await scal(a, b, 'suma');
    const kd = await get(`/zamowienia/${b}`);
    expect(kd.statusCode).toBe(302);
    expect(kd.headers.location).toBe(`/zamowienia/${a}`);
    const kg = await get(`/zamowienia/${a}`);
    expect(kg.statusCode).toBe(200);
    // Sekcja scalenia krótka: numery dołączonych i decyzja wysyłki, bez drugiej tabeli pozycji.
    const sekcja = kg.body.slice(kg.body.indexOf('id="scalenie"'), kg.body.indexOf('id="pozycje"'));
    expect(sekcja).toContain('S-2');
    expect(sekcja).toContain('suma wysyłek');
    expect(sekcja).not.toContain('Lampa 2');
    // Panel „Pozycje” (tryb odczytu) — pozycje CAŁEJ grupy z numerem zamówienia i suma grupy.
    const pozycje = kg.body.slice(kg.body.indexOf('id="pozycje"'), kg.body.indexOf('id="przesylka"'));
    expect(pozycje).toContain('Lampa 1');
    expect(pozycje).toContain('Lampa 2');
    expect(pozycje).toContain('z zamówienia S-2');
    expect(pozycje).toContain('35.00');
    expect(pozycje).toContain('235.00');
    // PRZ-101.11 (właściciel 19.10: „obie wpłaty powinny pojawić się na liście wpłat”): lista wpłat
    // pokazuje wpłaty CAŁEJ grupy, przy dołączonej dopisek „zam. S-2”; saldo liczone z grupy.
    // Do 19.10 saldo było tylko głównego („Wpłacono 115.00 zł z 115.00 zł”) + osobne zdanie z sumą.
    const platnosci = kg.body.slice(kg.body.indexOf('id="platnosci"'), kg.body.indexOf('class="wplata-szybka"'));
    expect(platnosci).toContain('Wpłacono 235.00 zł z 235.00 zł');
    const wiersze = [...platnosci.matchAll(/<tr>[^]*?<\/tr>/g)].map((m) => m[0]).filter((w) => w.includes('<td'));
    expect(wiersze).toHaveLength(2);
    expect(wiersze[0]).toContain('115.00 zł');
    expect(wiersze[0]).not.toContain('zam. S-');
    expect(wiersze[1]).toContain('120.00 zł');
    expect(wiersze[1]).toContain('zam. S-2');
  });

  it('PRZ-101.11: wpłata dopisana na karcie głównego trafia do głównego; saldo grupy ją widzi', async () => {
    const a = zam(1); const b = zam(2, { koszt_dostawy_brutto: '20.00', kwota_brutto: '120.00', oplacone_at: null });
    await scal(a, b, 'suma');
    const przed = (await get(`/zamowienia/${a}`)).body;
    expect(przed.slice(przed.indexOf('id="platnosci"'))).toContain('Wpłacono 115.00 zł z 235.00 zł');
    const r = await post(`/zamowienia/${a}/platnosci`, { kwota: '120.00', metoda: 'przelew' });
    expect(r.statusCode, r.body).toBe(302);
    const wplaty = db.prepare("SELECT zamowienie_id, kwota FROM platnosci WHERE zrodlo = 'reczna'").all();
    expect(wplaty).toEqual([{ zamowienie_id: a, kwota: '120.00' }]);
    const po = (await get(`/zamowienia/${a}`)).body;
    expect(po.slice(po.indexOf('id="platnosci"'))).toContain('Wpłacono 235.00 zł z 235.00 zł');
  });

  it('PRZ-101.11: ręczna wpłata dołączonego — „Usuń” na karcie głównego kasuje ją z dołączonego', async () => {
    const a = zam(1); const b = zam(2, { oplacone_at: null });
    dodajWplateReczna(db, b, { kwota: '115.00', data: '2026-10-11T00:00:00', metoda: 'przelew', uwaga: null });
    await scal(a, b, 'suma');
    const karta = (await get(`/zamowienia/${a}`)).body;
    const idW = db.prepare('SELECT id FROM platnosci WHERE zamowienie_id = ?').get(b).id;
    expect(karta).toContain(`action="/zamowienia/${b}/platnosci/${idW}/usun"`);
    const r = await post(`/zamowienia/${b}/platnosci/${idW}/usun`, { powrot: `/zamowienia/${a}` });
    expect(r.statusCode, r.body).toBe(302);
    expect(db.prepare('SELECT COUNT(*) AS n FROM platnosci WHERE zamowienie_id = ?').get(b).n).toBe(0);
  });

  it('tryb „Edytuj” pozycji na karcie głównego dostaje tylko jego pozycje (zapis idzie do jego wiersza)', async () => {
    const a = zam(1); const b = zam(2);
    await scal(a, b);
    const r = await get(`/zamowienia/${a}?edytuj=pozycje`);
    const pozycje = r.body.slice(r.body.indexOf('id="pozycje"'), r.body.indexOf('id="przesylka"'));
    expect(pozycje).toContain('Lampa 1');
    expect(pozycje).not.toContain('Lampa 2');
  });

  // PRZ-101.11 (właściciel 19.10: „zmień tekst DECYZJA CZŁOWIEKA, brzmi bardzo AI”) — wpis czyta się jak zdanie.
  it('wpisy w historii: scalenie i rozdzielenie zdaniem „Ręcznie (kto): …”, u dołączonego bez podwójnego dwukropka', async () => {
    const a = zam(1); const b = zam(2);
    await scal(a, b, 'suma');
    expect((await post(`/zamowienia/${a}/rozdziel`, {})).statusCode).toBe(302);
    const wpisy = (id) => db.prepare("SELECT wynik FROM log WHERE zamowienie_id = ? AND akcja = 'scalenie' ORDER BY id").all(id).map((w) => w.wynik);
    expect(wpisy(a)).toEqual([
      'Ręcznie (adam): scalono zamówienia S-1 + S-2, wysyłka: suma wysyłek.',
      'Ręcznie (adam): rozdzielono scalenie, zamówienie S-2 znów osobno.',
    ]);
    expect(wpisy(b)).toEqual([
      'Ręcznie (adam): scalono zamówienia S-1 + S-2, wysyłka: suma wysyłek. Zamówienie główne: S-1.',
      'Ręcznie (adam): rozdzielono scalenie, zamówienie S-2 znów osobno. Zamówienie główne: S-1.',
    ]);
    const strona = (await get(`/zamowienia/${a}?historia=1`)).body;
    const karta = strona.slice(strona.indexOf('id="historia"'));
    expect(karta).toContain('Ręcznie (adam): rozdzielono scalenie, zamówienie S-2 znów osobno.');
    expect(karta).not.toContain('DECYZJA');
  });

  it('rozdziel: dołączone wraca na listę; z fakturą — odmowa', async () => {
    const a = zam(1); const b = zam(2);
    await scal(a, b);
    const r = await post(`/zamowienia/${a}/rozdziel`, {});
    expect(r.statusCode).toBe(302);
    expect(kolumna(b, 'scalone_do')).toBeNull();
    expect(kolumna(a, 'scalenie_json')).toBeNull();
    const indeks = indeksListy(db); await indeks.odswiez();
    expect(indeks.liczniki(Date.now()).wszystkie).toBe(2);
    await scal(a, b);
    db.prepare("INSERT INTO faktury (zamowienie_id, numer, utworzona_at) VALUES (?, 'FV/8/2026', '2026-10-11T00:00:00Z')").run(a);
    const odm = await post(`/zamowienia/${a}/rozdziel`, {});
    expect(odm.statusCode).toBe(400);
    expect(kolumna(b, 'scalone_do')).toBe(a);
  });
});

describe('wydruki głównego obejmują pozycje całej grupy', () => {
  const lampa2 = /Lampa\s+2/;
  // Specyfikacja wymaga sprzedawcy (config.nadawca) — dane fikcyjne. PRZ-108.10: i NIP-u (config.proforma.nip) —
  // bez NIP-u specyfikacja odmawia zamiast wyjść bez NIP-u sprzedawcy.
  beforeEach(async () => {
    await zbuduj({ config: { ...config, proforma: { nip: '1234563218' },
      nadawca: { nazwa: 'Pracownia Testowa', ulica: 'ul. Próbna 1', kod: '00-001', miasto: 'Testowo', kraj: 'PL' } } });
  });
  it.skipIf(!PDFTOTEXT)('specyfikacja, lista produktów i zestawienie — pojedynczo i zbiorczo z listy', async () => {
    const a = zam(1); const b = zam(2);
    await scal(a, b);
    for (const url of [`/zamowienia/${a}/specyfikacja.pdf`, `/zamowienia/${a}/lista-produktow.pdf`, `/zamowienia/${a}/zestawienie.pdf`]) {
      const r = await get(url);
      expect(r.statusCode, url).toBe(200);
      const tekst = pdfNaTekst(r.rawPayload);
      expect(tekst, url).toMatch(/Lampa\s+1/);
      expect(tekst, url).toMatch(lampa2);
    }
    for (const url of ['/zamowienia/specyfikacje.pdf', '/zamowienia/lista-produktow.pdf', '/zamowienia/zestawienie.pdf']) {
      const r = await post(url, { id: [String(a)] });
      expect(r.statusCode, url).toBe(200);
      expect(pdfNaTekst(r.rawPayload), url).toMatch(lampa2);
    }
  });

  it.skipIf(!PDFTOTEXT)('zamówienie bez scalenia drukuje się jak dotąd (bez pozycji innych zamówień)', async () => {
    const a = zam(1); zam(2);
    const tekst = pdfNaTekst((await get(`/zamowienia/${a}/specyfikacja.pdf`)).rawPayload);
    expect(tekst).not.toMatch(lampa2);
  });

  it('ekran nadania głównego pokazuje pozycje grupy (co jedzie w paczce)', async () => {
    await zbuduj({ nadanie: { nadaj: vi.fn() } });
    const a = zam(1); const b = zam(2);
    await scal(a, b);
    const r = await get(`/zamowienia/${a}/nadaj`);
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('Lampa 2');
  });
});

describe('poller po scaleniu', () => {
  it('synchronizacja dołączonego zachowuje scalone_do, a pozycje głównego zostają nietknięte', async () => {
    const a = zam(1); const b = zam(2);
    await scal(a, b);
    const pozycjeGlownego = db.prepare('SELECT nazwa, brutto_linii FROM pozycje WHERE zamowienie_id = ?').all(a);
    zapiszZamowienie(db, 'sklep_a', zmapowane(2, { uwagi: 'zmiana w sklepie' }), {});
    zapiszZamowienie(db, 'sklep_a', zmapowane(1, { uwagi: 'zmiana w sklepie' }), {});
    expect(kolumna(b, 'scalone_do')).toBe(a);
    expect(JSON.parse(kolumna(a, 'scalenie_json')).dolaczone).toEqual([b]);
    expect(db.prepare('SELECT nazwa, brutto_linii FROM pozycje WHERE zamowienie_id = ?').all(a)).toEqual(pozycjeGlownego);
    expect(db.prepare('SELECT COUNT(*) AS n FROM pozycje WHERE zamowienie_id = ?').get(b).n).toBe(1);
  });
});

describe('jedna faktura grupy', () => {
  it('faktura głównego obejmuje pozycje grupy i wysyłkę „suma”', async () => {
    const a = zam(1); const b = zam(2, { koszt_dostawy_brutto: '20.00', kwota_brutto: '120.00' });
    await scal(a, b, 'suma');
    const r = await post(`/zamowienia/${a}/faktura`, {});
    expect(r.statusCode, r.body).toBe(302);
    const services = infakt.wystaw.mock.calls[0][0].services;
    // PRZ-101.11: wysyłka każdego zamówienia osobną pozycją (do 19.10 — jedna linia „Dostawa” 35 zł).
    expect(services.map((s) => [s.name, s.gross_price])).toEqual([
      ['Lampa 1', 10000], ['Lampa 2', 10000], ['Dostawa', 1500], ['Dostawa — zamówienie S-2', 2000],
    ]);
  });

  // PRZ-101.11 (właściciel 19.10): kupujący zapłacił za dwie wysyłki — druga wchodzi osobną pozycją, faktura = wpłaty.
  // Do 19.10 ten test żądał faktury 215 zł przy wpłatach 235 zł.
  it('„z zamówienia głównego”, oba opłacone (115 + 120 zł): faktura 235 zł z dwiema pozycjami wysyłki', async () => {
    const a = zam(1); const b = zam(2, { koszt_dostawy_brutto: '20.00', kwota_brutto: '120.00' });
    await scal(a, b, 'glowne');
    const r = await post(`/zamowienia/${a}/faktura`, {});
    expect(r.statusCode, r.body).toBe(302);
    const services = infakt.wystaw.mock.calls[0][0].services;
    expect(services.reduce((s, x) => s + x.gross_price, 0)).toBe(23500);
    expect(services.filter((s) => s.name.startsWith('Dostawa')).map((s) => [s.name, s.gross_price]))
      .toEqual([['Dostawa', 1500], ['Dostawa — zamówienie S-2', 2000]]);
    const wplaty = db.prepare('SELECT zamowienie_id, kwota FROM platnosci ORDER BY zamowienie_id').all();
    expect(wplaty.map((w) => Number(w.kwota))).toEqual([115, 120]);
  });

  it('„z zamówienia głównego”, dołączone nieopłacone: na fakturze bez jego wysyłki', async () => {
    const a = zam(1); const b = zam(2, { koszt_dostawy_brutto: '20.00', kwota_brutto: '120.00', oplacone_at: null });
    await scal(a, b, 'glowne');
    const r = await post(`/zamowienia/${a}/faktura`, {});
    expect(r.statusCode, r.body).toBe(302);
    const services = infakt.wystaw.mock.calls[0][0].services;
    expect(services.reduce((s, x) => s + x.gross_price, 0)).toBe(21500);
    expect(services.map((s) => s.name)).not.toContain('Dostawa — zamówienie S-2');
  });

  it('faktura dołączonego — odmowa „faktura w zamówieniu głównym”, inFakt nietknięty', async () => {
    const a = zam(1); const b = zam(2);
    await scal(a, b);
    const r = await post(`/zamowienia/${b}/faktura`, {});
    expect(r.statusCode).toBe(400);
    expect(r.body).toContain('faktura w zamówieniu głównym');
    expect(r.body).toContain('S-1');
    expect(infakt.wystaw).not.toHaveBeenCalled();
  });

  it('hurt i proforma odmawiają dołączonemu tą samą regułą', async () => {
    const a = zam(1); const b = zam(2);
    await scal(a, b);
    const { pominiete } = podzielDoFaktury([pobierzZamowienie(db, b)]);
    expect(pominiete[0].powod).toContain('faktura w zamówieniu głównym');
    expect(czyWolnoWystawic(pobierzZamowienie(db, b))).toMatchObject({ wolno: false });
  });
});

describe('status, nadanie i przeniesienie „wysłane”', () => {
  it('wysłanie głównego z karty: dołączone też wysłane i odesłane do sklepu', async () => {
    const a = zam(1); const b = zam(2);
    await scal(a, b);
    const r = await post(`/zamowienia/${a}/status`, { status: 'wyslane' });
    expect(r.statusCode).toBe(302);
    expect(kolumna(a, 'wyslane_at')).toBeTruthy();
    expect(kolumna(b, 'wyslane_at')).toBe(kolumna(a, 'wyslane_at'));
    expect(woo.ustawStatus.mock.calls.map((c) => c[0]).sort()).toEqual([1, 2]);
    // Cofnięcie — analogicznie.
    await post(`/zamowienia/${a}/status`, { status: 'w_realizacji' });
    expect(kolumna(a, 'wyslane_at')).toBeNull();
    expect(kolumna(b, 'wyslane_at')).toBeNull();
  });

  it('zmiana masowa głównego przenosi „wysłane”; dołączone w zaznaczeniu jest pomijane', async () => {
    const a = zam(1); const b = zam(2);
    await scal(a, b);
    const tylkoDolaczone = await post('/zamowienia/masowe/status', { id: [String(b)], status: 'wyslane' });
    expect(tylkoDolaczone.statusCode).toBe(200);
    expect(tylkoDolaczone.body).toContain('status zmieniasz w zamówieniu głównym');
    expect(kolumna(b, 'wyslane_at')).toBeNull();
    await post('/zamowienia/masowe/status', { id: [String(a)], status: 'wyslane' });
    expect(kolumna(b, 'wyslane_at')).toBeTruthy();
    expect(woo.ustawStatus).toHaveBeenCalledWith(2, 'completed');
  });

  it('przesyłka ręczna na głównym przenosi „wysłane”; na dołączonym — 400', async () => {
    const a = zam(1); const b = zam(2);
    await scal(a, b);
    const odm = await post(`/zamowienia/${b}/przesylki/reczna`, { numer_listu: '1234567890123' });
    expect(odm.statusCode).toBe(400);
    const r = await post(`/zamowienia/${a}/przesylki/reczna`, { numer_listu: '1234567890123' });
    expect(r.statusCode, r.body).toBe(302);
    expect(kolumna(b, 'wyslane_at')).toBe(kolumna(a, 'wyslane_at'));
    expect(woo.ustawStatus).toHaveBeenCalledWith(2, 'completed');
  });

  it('nieudane odesłanie dołączonego ląduje na głównym (widoczne), ponowienie je zdejmuje', async () => {
    const a = zam(1); const b = zam(2);
    await scal(a, b);
    woo.ustawStatus.mockImplementation(async (id) => { if (id === 2) throw new Error('sklep nie odpowiada'); });
    await post(`/zamowienia/${a}/status`, { status: 'wyslane' });
    expect(kolumna(a, 'sync_woo_blad')).toMatch(/^dołączone S-2: .*sklep nie odpowiada/);
    woo.ustawStatus.mockImplementation(async () => null);
    await post(`/zamowienia/${a}/sync-sklep`, {});
    expect(kolumna(a, 'sync_woo_blad')).toBeNull();
  });

  it('ręczna zmiana statusu dołączonego i anulowanie głównego z grupą — 400', async () => {
    const a = zam(1); const b = zam(2);
    await scal(a, b);
    const r = await post(`/zamowienia/${b}/status`, { status: 'w_realizacji' });
    expect(r.statusCode).toBe(400);
    const an = await post(`/zamowienia/${a}/status`, { status: 'anulowane' });
    expect(an.statusCode).toBe(400);
    expect(an.body).toContain('najpierw je rozdziel');
  });

  it('nadanie dołączonego — 4xx, kurier nietknięty', async () => {
    const nadaj = vi.fn();
    await zbuduj({ nadanie: { nadaj } });
    const a = zam(1); const b = zam(2);
    await scal(a, b);
    const r = await post(`/zamowienia/${b}/nadaj`, { waga: '1', dlugosc: '10', szerokosc: '10', wysokosc: '10' });
    expect(r.statusCode).toBeGreaterThanOrEqual(400);
    expect(r.statusCode).toBeLessThan(500);
    expect(r.body).toContain('paczkę nadajesz z zamówienia głównego');
    expect(nadaj).not.toHaveBeenCalled();
  });
});

// ——— Poprawki po recenzji (PRZ-101.04, 19.10) ————————————————————————————————————————————
describe('W2: pobranie na zamówieniu scalonym — odmowa', () => {
  it('karta: pobranie na głównym grupy — 400, nadpisanie niezapisane; to samo na dołączonym', async () => {
    const a = zam(1); const b = zam(2);
    await scal(a, b);
    for (const id of [a, b]) {
      const r = await post(`/zamowienia/${id}/wysylka/metoda`, { metoda: 'dpd', pobranie: '1', kwota_pobrania: '235.00' });
      expect(r.statusCode, r.body).toBe(400);
      expect(r.body).toContain('za pobraniem');
      expect(kolumna(id, 'wysylka_reczna_json')).toBeNull();
    }
    // Zmiana metody BEZ pobrania dalej działa (zwykła korekta dostawy).
    const ok = await post(`/zamowienia/${a}/wysylka/metoda`, { metoda: 'dpd' });
    expect(ok.statusCode, ok.body).toBe(302);
  });

  it('„Przywróć metodę ze sklepu”, gdy sklep ma pobranie — 400 na głównym grupy', async () => {
    const a = zam(1, { metoda_wysylki: 'dpd_pobranie', pobranie: 1, kwota_pobrania: '115.00', oplacone_at: null });
    db.prepare('UPDATE zamowienia SET wysylka_reczna_json = ? WHERE id = ?').run(JSON.stringify({ metoda: 'dpd', pobranie: 0 }), a);
    const b = zam(2);
    await scal(a, b);
    const r = await post(`/zamowienia/${a}/wysylka/przywroc`, {});
    expect(r.statusCode, r.body).toBe(400);
    expect(kolumna(a, 'wysylka_reczna_json')).not.toBeNull();
  });

  it('obrona w głębi: główne z pobraniem wpisanym poza panelem — ekran nadania odmawia', async () => {
    await zbuduj({ nadanie: { nadaj: vi.fn() } });
    const a = zam(1); const b = zam(2);
    await scal(a, b);
    db.prepare('UPDATE zamowienia SET wysylka_reczna_json = ? WHERE id = ?')
      .run(JSON.stringify({ metoda: 'dpd', pobranie: 1, kwota_pobrania: '115.00' }), a);
    const r = await get(`/zamowienia/${a}/nadaj`);
    expect(r.statusCode).toBe(400);
    expect(r.body).toContain('za pobraniem');
  });
});

describe('W3: dołączone anulowane w sklepie po scaleniu', () => {
  const anulujWSklepie = (id) => zapiszZamowienie(db, 'sklep_a', zmapowane(id, { anulowane: 1, status_woo: 'cancelled' }), {});

  it('główne (wysłane) wraca do „Do zrobienia” z powodem na liście', async () => {
    const a = zam(1); const b = zam(2);
    await scal(a, b);
    await post(`/zamowienia/${a}/status`, { status: 'wyslane' });
    const indeks = indeksListy(db);
    await indeks.odswiez();
    const robocze = () => indeks.strona({ zakladka: { rodzaj: 'robocze' }, filtry: null, szukaj: '', offset: 0, limit: 50, teraz: Date.now() }).ids;
    expect(robocze()).not.toContain(a);
    anulujWSklepie(2);
    await indeks.odswiez();
    expect(robocze()).toContain(a);
    expect(indeks.liczniki(Date.now()).wszystkie).toBe(1);
    const lista = await get('/?wszystkie=1');
    expect(lista.body).toContain('dołączone zamówienie S-2 anulowane w sklepie — rozdziel albo skoryguj');
  });

  it('karta głównego oznacza anulowane dołączone; nadanie głównego odmawia', async () => {
    await zbuduj({ nadanie: { nadaj: vi.fn() } });
    const a = zam(1); const b = zam(2);
    await scal(a, b);
    anulujWSklepie(2);
    const kg = await get(`/zamowienia/${a}`);
    const sekcja = kg.body.slice(kg.body.indexOf('id="scalenie"'), kg.body.indexOf('id="pozycje"'));
    expect(sekcja).toContain('anulowane w sklepie');
    const n = await get(`/zamowienia/${a}/nadaj`);
    expect(n.statusCode).toBe(400);
    expect(n.body).toContain('dołączone zamówienie S-2 anulowane w sklepie');
    expect(kolumna(b, 'scalone_do')).toBe(a);
  });

  it('„Wysłane” głównego nie przechodzi na anulowane dołączone (ani do sklepu)', async () => {
    const a = zam(1); const b = zam(2); const c = zam(3);
    const r = await post('/zamowienia/scal', { id: [String(a), String(b), String(c)], glowne: String(a), wysylka: 'suma' });
    expect(r.statusCode, r.body).toBe(302);
    anulujWSklepie(2);
    await post(`/zamowienia/${a}/status`, { status: 'wyslane' });
    expect(kolumna(a, 'wyslane_at')).toBeTruthy();
    expect(kolumna(c, 'wyslane_at')).toBe(kolumna(a, 'wyslane_at'));
    expect(kolumna(b, 'wyslane_at')).toBeNull();
    expect(woo.ustawStatus.mock.calls.map((x) => x[0]).sort()).toEqual([1, 3]);
  });
});

describe('W4: sync_woo_blad i scalanie', () => {
  it('„Rozdziel” zdejmuje z głównego ślad nieodesłanego statusu dołączonych', async () => {
    const a = zam(1); const b = zam(2);
    await scal(a, b);
    db.prepare('UPDATE zamowienia SET sync_woo_blad = ? WHERE id = ?').run('dołączone S-2: sklep nie odpowiada', a);
    const r = await post(`/zamowienia/${a}/rozdziel`, {});
    expect(r.statusCode, r.body).toBe(302);
    expect(kolumna(a, 'sync_woo_blad')).toBeNull();
  });

  it('„Rozdziel” zostawia WŁASNY błąd odesłania głównego', async () => {
    const a = zam(1); const b = zam(2);
    await scal(a, b);
    db.prepare('UPDATE zamowienia SET sync_woo_blad = ? WHERE id = ?').run('sklep odrzucił status', a);
    await post(`/zamowienia/${a}/rozdziel`, {});
    expect(kolumna(a, 'sync_woo_blad')).toBe('sklep odrzucił status');
  });

  it('scalenie zamówienia z nieodesłanym statusem — odmowa z powodem', async () => {
    const a = zam(1); const b = zam(2);
    db.prepare('UPDATE zamowienia SET sync_woo_blad = ? WHERE id = ?').run('sklep nie odpowiada', b);
    const r = await post('/zamowienia/scal', { id: [String(a), String(b)], glowne: String(a), wysylka: 'suma' });
    expect(r.statusCode).toBe(400);
    expect(r.body).toContain('S-2 ma status nieodesłany do sklepu');
    expect(kolumna(b, 'scalone_do')).toBeNull();
  });
});

// Scalenie gałęzi pętli (PRZ-101.02 statusy własne): przypisanie statusu własnego DOŁĄCZONEGO kasujemy
// przy scaleniu — dołączone nie ma wiersza na liście, jego stan niesie główne; ręczna zmiana (także na
// status własny) dalej odmawia. Główne zachowuje swój status własny.
describe('statusy własne a scalanie', () => {
  it('scalenie kasuje status własny dołączonego, zostawia głównego; dołączone odmawia statusu własnego', async () => {
    const dodaj = await post('/ustawienia/statusy', { akcja: 'dodaj', etykieta: 'Do pakowania', kolor: 'fioletowy', jak: 'w_realizacji' });
    expect(dodaj.statusCode, dodaj.body).toBeLessThan(400);
    const a = zam(1); const b = zam(2);
    for (const id of [a, b]) expect((await post(`/zamowienia/${id}/status`, { status: 'w_do_pakowania' })).statusCode).toBe(302);
    await scal(a, b);
    const wiersze = () => db.prepare('SELECT zamowienie_id FROM zamowienia_status_wlasny ORDER BY zamowienie_id').all().map((w) => w.zamowienie_id);
    expect(wiersze()).toEqual([a]);
    const odm = await post(`/zamowienia/${b}/status`, { status: 'w_do_pakowania' });
    expect(odm.statusCode).toBe(400);
    expect(odm.body).toContain('status zmieniasz w zamówieniu głównym');
    expect(wiersze()).toEqual([a]);
  });
});

// ——— N1 (ponowna recenzja): „Odłącz anulowane” — wyjście dla głównego z anulowanym dołączonym ———
describe('N1: Odłącz anulowane', () => {
  const anuluj = (id) => zapiszZamowienie(db, 'sklep_a', zmapowane(id, { anulowane: 1, status_woo: 'cancelled' }), {});
  const scal3 = async (a, b, c) => {
    const r = await post('/zamowienia/scal', { id: [String(a), String(b), String(c)], glowne: String(a), wysylka: 'suma' });
    expect(r.statusCode, r.body).toBe(302);
  };
  const sekcja = (body) => body.slice(body.indexOf('id="scalenie"'), body.indexOf('id="pozycje"'));
  const robocze = (indeks) => indeks.strona({ zakladka: { rodzaj: 'robocze' }, filtry: null, szukaj: '', offset: 0, limit: 50, teraz: Date.now() }).ids;

  it('(A) grupa wysłana: Rozdziel odmawia, Odłącz anulowane wyprowadza główne z „Do zrobienia”, anulowane wraca na listę', async () => {
    const a = zam(1); const b = zam(2); const c = zam(3);
    await scal3(a, b, c);
    await post(`/zamowienia/${a}/status`, { status: 'wyslane' });
    anuluj(2);
    const indeks = indeksListy(db); await indeks.odswiez();
    expect(robocze(indeks)).toContain(a);
    expect((await post(`/zamowienia/${a}/rozdziel`, {})).statusCode).toBe(400);
    const karta = sekcja((await get(`/zamowienia/${a}`)).body);
    expect(karta).toContain('Odłącz anulowane');
    expect(karta).not.toContain('są wstrzymane');
    const r = await post(`/zamowienia/${a}/odlacz-anulowane`, {});
    expect(r.statusCode, r.body).toBe(302);
    expect(kolumna(b, 'scalone_do')).toBeNull();
    expect(kolumna(c, 'scalone_do')).toBe(a);
    expect(JSON.parse(kolumna(a, 'scalenie_json')).dolaczone).toEqual([c]);
    await indeks.odswiez();
    expect(robocze(indeks)).not.toContain(a);
    expect(robocze(indeks)).not.toContain(b);
    expect(indeks.liczniki(Date.now()).wszystkie).toBe(2);
    expect(indeks.liczniki(Date.now()).statusy.anulowane).toBe(1);
    expect(sekcja((await get(`/zamowienia/${a}`)).body)).not.toContain('Odłącz anulowane');
    expect(db.prepare("SELECT wynik FROM log WHERE zamowienie_id = ? AND akcja = 'scalenie' ORDER BY id DESC").get(b).wynik).toMatch(/odłączone od S-1/);
  });

  it('(B) faktura grupy wystawiona, paczki brak: nadanie odmawia; po odłączeniu nadanie działa, ostrzeżenie o korekcie i wpis w logu', async () => {
    await zbuduj({ nadanie: { nadaj: vi.fn() } });
    const a = zam(1); const b = zam(2); const c = zam(3);
    await scal3(a, b, c);
    db.prepare("INSERT INTO faktury (zamowienie_id, numer, utworzona_at) VALUES (?, 'FV/9/10/2026', '2026-10-12T00:00:00Z')").run(a);
    anuluj(2);
    expect((await get(`/zamowienia/${a}/nadaj`)).statusCode).toBe(400);
    expect((await post(`/zamowienia/${a}/rozdziel`, {})).statusCode).toBe(400);
    const r = await post(`/zamowienia/${a}/odlacz-anulowane`, {});
    expect(r.statusCode, r.body).toBe(200);
    const ostrzezenie = 'faktura grupy obejmuje pozycje anulowanego zamówienia S-2 — wystaw korektę';
    expect(r.body).toContain(ostrzezenie);
    expect(db.prepare("SELECT wynik FROM log WHERE zamowienie_id = ? AND wynik LIKE '%wystaw korektę%'").get(a).wynik).toContain(ostrzezenie);
    expect(kolumna(b, 'scalone_do')).toBeNull();
    const n = await get(`/zamowienia/${a}/nadaj`);
    expect(n.statusCode, n.body).toBe(200);
    expect(n.body).toContain('Lampa 3');
    expect(n.body).not.toContain('Lampa 2');
  });

  it('faktura jeszcze niewystawiona: po odłączeniu faktura grupy bez pozycji anulowanego (wysyłka „suma” bez jego wysyłki)', async () => {
    const a = zam(1); const b = zam(2); const c = zam(3);
    await scal3(a, b, c);
    anuluj(2);
    expect(sekcja((await get(`/zamowienia/${a}`)).body)).toContain('są wstrzymane');
    expect((await post(`/zamowienia/${a}/faktura`, {})).statusCode).toBe(400);
    expect((await post(`/zamowienia/${a}/odlacz-anulowane`, {})).statusCode).toBe(302);
    const f = await post(`/zamowienia/${a}/faktura`, {});
    expect(f.statusCode, f.body).toBe(302);
    const services = infakt.wystaw.mock.calls[0][0].services;
    // PRZ-101.11: wysyłki osobnymi pozycjami (do 19.10 — jedna linia „Dostawa” 30 zł).
    expect(services.map((s) => [s.name, s.gross_price])).toEqual([
      ['Lampa 1', 10000], ['Lampa 3', 10000], ['Dostawa', 1500], ['Dostawa — zamówienie S-3', 1500],
    ]);
  });

  it('bez anulowanego dołączonego — przycisku nie ma, POST odmawia i nic nie zmienia', async () => {
    const a = zam(1); const b = zam(2);
    await scal(a, b);
    expect(sekcja((await get(`/zamowienia/${a}`)).body)).not.toContain('Odłącz anulowane');
    const r = await post(`/zamowienia/${a}/odlacz-anulowane`, {});
    expect(r.statusCode).toBe(400);
    expect(kolumna(b, 'scalone_do')).toBe(a);
  });
});
