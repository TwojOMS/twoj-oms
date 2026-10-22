// PRZ-108.07, poprawki po niezależnej recenzji (recenzja-07.md, usterki 1–5 i 7–9; 6 — ostrzeżenie na stronie głównej —
// robi C1). Każdy opis zaczyna się od numeru usterki. Scenariusze pochodzą ze skryptów dowodowych recenzenta d1–d6.
import { describe, it, expect, afterEach } from 'vitest';
import net from 'node:net';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { MODULY, modulyDla } from '../../../src/moduly/lista.ts';
import { kolejnoscBudowy } from '../../../src/core/sprawdz-moduly.ts';
import { zbudujOms } from '../../pomoc/zbuduj-oms.ts';
import { createMailer } from '../../../src/core/poczta/smtp.js';
import { createSilnikAutomatyzacji } from '../../../src/moduly/automatyzacje/services/silnik.js';
import {
  utworzRegule, wlaczRegule, wylaczRegule, zmienRegule, wczytajRegule, wyslijZalegle, przelaczeniaReguly,
} from '../../../src/moduly/automatyzacje/db/reguly.js';
import { zakoncz, doWykonania } from '../../../src/moduly/automatyzacje/db/wykonania.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const otwarte = [];
afterEach(() => { for (const db of otwarte.splice(0)) { try { db.close(); } catch { /* zamknięta */ } } });
const T0 = Date.parse('2026-10-21T10:00:00.000Z');
const MIN = 60_000;
const iso = (ms) => new Date(ms).toISOString();
function baza() {
  const db = openOmsDb(':memory:', { moduly: kolejnoscBudowy(MODULY) });
  otwarte.push(db);
  return db;
}
function zegar(start = T0) {
  let ms = start;
  return { teraz: () => new Date(ms), przesun: (o) => { ms += o; }, ustaw: (m) => { ms = m; }, ms: () => ms };
}
let kolejny = 0;
function zamowienie(db, { sklep = 'sklep', wyslane = null } = {}) {
  kolejny += 1;
  return Number(db.prepare(`INSERT INTO zamowienia (sklep, zrodlo_id, numer, kwota_brutto, utworzone_at, wyslane_at)
    VALUES (?,?,?,?,?,?)`).run(sklep, kolejny, `R-${kolejny}`, '10.00', '2026-10-21T08:00:00', wyslane).lastInsertRowid);
}
/** Detektor wg kontraktu: rosnąco po (zdarzenie_at, id), od `od`, ściśle po kursorze złożonym `po`. */
function zdarzenieTestowe() {
  const wywolania = [];
  return {
    klucz: 'test_zdarzenie', etykieta: 'Zdarzenie testowe', grupa: 'zamowienie', wywolania,
    kandydaci(db, { granica, od, po = null, limit }) {
      wywolania.push({ od, po });
      return db.prepare(`SELECT id, id AS zamowienie_id, sklep, wyslane_at AS zdarzenie_at FROM zamowienia
        WHERE id > ? AND wyslane_at IS NOT NULL AND wyslane_at >= ?
          AND (? IS NULL OR wyslane_at > ? OR (wyslane_at = ? AND id > ?))
        ORDER BY wyslane_at, id LIMIT ?`)
        .all(granica.zamowienia, od, po?.at ?? null, po?.at ?? null, po?.at ?? null, po?.id ?? 0, limit);
    },
    symulacja: () => [],
  };
}
function akcjaTestowa(wykonaj) {
  const a = { klucz: 'test_akcja', etykieta: 'Akcja', wymagaPoczty: true, szablon: true, wywolania: [],
    async wykonaj(o) { a.wywolania.push(o.wykonanie.zamowienie_id); return wykonaj ? wykonaj(o) : { adresat: 'x@example.invalid' }; } };
  return a;
}
const REGULA = (o = {}) => ({ nazwa: 'R', zdarzenie: 'test_zdarzenie', zdarzenie_json: {},
  warunki: { kanaly: ['sklep'], kanalyZnane: ['sklep', 'allegro'] }, akcja: 'test_akcja', akcja_json: { szablon: 'wlasny-1' },
  opoznienie_min: 0, limit_na_godzine: 20, ...o });
function srodowisko({ wykonaj, sprawdzWarunki, zgoda } = {}) {
  const db = baza();
  const z = zegar();
  const akcja = akcjaTestowa(wykonaj);
  if (zgoda) akcja.zgoda = zgoda;
  const logi = [];
  const s = createSilnikAutomatyzacji({ db, zdarzenia: [zdarzenieTestowe()], akcje: [akcja], pocztaGotowa: () => true,
    teraz: z.teraz, sprawdzWarunki, log: (...t) => logi.push(t.join(' ')) });
  const regula = (o) => utworzRegule(db, REGULA(o), { login: 'adam', teraz: z.teraz });
  const wlacz = (id) => wlaczRegule(db, id, { login: 'adam', teraz: z.teraz });
  return { db, z, akcja, s, logi, regula, wlacz };
}
const wiersz = (db, zid) => db.prepare('SELECT * FROM automatyzacje_wykonania WHERE zamowienie_id = ?').get(zid);
const wpisy = (db, zid) => db.prepare("SELECT akcja, wynik FROM log WHERE zamowienie_id = ? AND akcja LIKE 'automatyzacja.%'").all(zid);

describe('1. ECONNECTION po przyjęciu treści (DATA) nie daje ponowienia', () => {
  it('serwer SMTP odbiera treść i zrywa połączenie przed 250 → niepewne, akcja raz także po 30 min', async () => {
    let tresci = 0;
    const serwer = net.createServer((s) => {
      let wDanych = false, bufor = '';
      s.write('220 test ESMTP\r\n');
      s.on('data', (d) => {
        bufor += d.toString('latin1');
        let i;
        while ((i = bufor.indexOf('\r\n')) >= 0) {
          const linia = bufor.slice(0, i); bufor = bufor.slice(i + 2);
          if (wDanych) { if (linia === '.') { tresci += 1; s.destroy(); return; } continue; }
          const k = linia.slice(0, 4).toUpperCase();
          if (k === 'EHLO' || k === 'HELO') s.write('250-test\r\n250 AUTH PLAIN\r\n');
          else if (k === 'AUTH') s.write('235 ok\r\n');
          else if (k === 'DATA') { wDanych = true; s.write('354 go\r\n'); }
          else if (k === 'QUIT') { s.write('221 bye\r\n'); s.end(); }
          else s.write('250 ok\r\n');
        }
      });
    });
    await new Promise((r) => serwer.listen(0, '127.0.0.1', r));
    try {
      const mailer = createMailer({ smtp: { host: '127.0.0.1', port: serwer.address().port, user: 'u', pass: 'p' },
        mailFrom: 'sklep@example.invalid' });
      let kod = null;
      const e = srodowisko({ wykonaj: async () => {
        try { await mailer.sendMail({ to: 'kupujacy@example.invalid', subject: 'Zamówienie wysłane', text: 'treść' }); }
        catch (err) { kod = err.code; throw err; }
        return { adresat: 'kupujacy@example.invalid' };
      } });
      e.wlacz(e.regula());
      const zid = zamowienie(e.db, { wyslane: iso(T0 + MIN) });
      e.z.przesun(2 * MIN);
      await e.s.przebieg();
      expect(kod).toBe('ECONNECTION');
      expect(tresci).toBe(1);
      expect(wiersz(e.db, zid)).toMatchObject({ stan: 'niepewne', proby: 0, nastepna_proba_at: null });
      for (let i = 0; i < 30; i += 1) { e.z.przesun(MIN); await e.s.przebieg(); }
      expect(e.akcja.wywolania).toEqual([zid]);
      expect(tresci).toBe(1);
    } finally { serwer.close(); }
  });
});

describe('2. wstrzymana albo „najedzona” reguła nie zagładza innych', () => {
  it('reguła A wstrzymana z 600 zaplanowanymi; wykonanie reguły B wychodzi od razu (d1)', async () => {
    const e = srodowisko();
    const A = e.regula({ nazwa: 'A', warunki: { kanaly: ['sklep'], kanalyZnane: ['sklep', 'allegro'] } });
    const B = e.regula({ nazwa: 'B', warunki: { kanaly: ['allegro'], kanalyZnane: ['sklep', 'allegro'] } });
    e.wlacz(A); e.wlacz(B);
    for (let i = 0; i < 600; i += 1) zamowienie(e.db, { wyslane: iso(T0 + MIN) });
    const zb = zamowienie(e.db, { sklep: 'allegro', wyslane: iso(T0 + 2 * MIN) });
    e.z.przesun(3 * MIN);
    await e.s.przebieg();
    expect(wczytajRegule(e.db, A).wstrzymana_powod).toBeTruthy();
    expect(e.akcja.wywolania).toEqual([zb]);
  });
  it('po „Wyślij zaległe” 600 wierszy A przy limicie 20/h nie trzyma okna — B wychodzi w tym samym przebiegu', async () => {
    const e = srodowisko();
    const A = e.regula({ nazwa: 'A' });
    const B = e.regula({ nazwa: 'B', warunki: { kanaly: ['allegro'], kanalyZnane: ['sklep', 'allegro'] } });
    e.wlacz(A); e.wlacz(B);
    for (let i = 0; i < 600; i += 1) zamowienie(e.db, { wyslane: iso(T0 + MIN) });
    e.z.przesun(2 * MIN);
    await e.s.przebieg();
    wyslijZalegle(e.db, A, { teraz: e.z.teraz });
    e.z.przesun(MIN);
    await e.s.przebieg(); // A wysyła swoje 20
    const zb = zamowienie(e.db, { sklep: 'allegro', wyslane: iso(e.z.ms()) });
    e.z.przesun(MIN);
    await e.s.przebieg();
    expect(e.akcja.wywolania).toContain(zb);
    expect(e.akcja.wywolania).toHaveLength(21);
  });
});

describe('2. doWykonania (SQL)', () => {
  it('nie oddaje wierszy reguł wstrzymanych, wyłączonych ani usuniętych; z każdej reguły najwyżej wolny limit godzinowy', () => {
    const e = srodowisko();
    const wstawRegule = (o, stan) => {
      const id = e.regula({ limit_na_godzine: 3, ...o });
      e.db.prepare('UPDATE automatyzacje_reguly SET wlaczona = ?, wstrzymana_powod = ?, usunieta_at = ? WHERE id = ?')
        .run(stan.wlaczona ?? 1, stan.wstrzymana ?? null, stan.usunieta ?? null, id);
      for (let i = 0; i < 5; i += 1) {
        const zid = zamowienie(e.db);
        e.db.prepare(`INSERT INTO automatyzacje_wykonania (regula_id, przedmiot, zamowienie_id, stan, zdarzenie_at, wykryte_at, termin_at)
          VALUES (?, ?, ?, 'zaplanowane', ?, ?, ?)`).run(id, `zamowienie:${zid}`, zid, iso(T0), iso(T0), iso(T0));
      }
      return id;
    };
    const zdrowa = wstawRegule({ nazwa: 'zdrowa' }, {});
    wstawRegule({ nazwa: 'wstrzymana' }, { wstrzymana: 'bezpiecznik' });
    wstawRegule({ nazwa: 'wyłączona' }, { wlaczona: 0 });
    wstawRegule({ nazwa: 'usunięta' }, { usunieta: iso(T0) });
    const wiersze = doWykonania(e.db, { teraz: iso(T0 + MIN), godzineWczesniej: iso(T0 - 59 * MIN) });
    expect(wiersze.map((w) => w.regula_id)).toEqual([zdrowa, zdrowa, zdrowa]);
    expect(Object.keys(wiersze[0])).not.toContain('nr');
  });
});

describe('3. kursor złożony (zdarzenie_at, id)', () => {
  it('1100 zdarzeń w tej samej sekundzie → wszystkie wykryte w kolejnych przebiegach, późniejsze zdarzenie też (d5)', async () => {
    const e = srodowisko();
    const id = e.regula({ limit_na_godzine: 200 });
    e.wlacz(id);
    const masowe = [];
    for (let i = 0; i < 1100; i += 1) masowe.push(zamowienie(e.db, { wyslane: iso(T0 + MIN) }));
    e.z.przesun(2 * MIN);
    await e.s.przebieg();
    expect(e.db.prepare('SELECT COUNT(*) AS n FROM automatyzacje_wykonania').get().n).toBe(1000);
    const nowe = [];
    for (let i = 0; i < 5; i += 1) {
      wyslijZalegle(e.db, id, { teraz: e.z.teraz }); // admin akceptuje zaległe po każdym wstrzymaniu
      e.z.przesun(MIN);
      if (i === 1) nowe.push(zamowienie(e.db, { wyslane: iso(e.z.ms()) }));
      await e.s.przebieg();
    }
    const wykryte = new Set(e.db.prepare('SELECT zamowienie_id FROM automatyzacje_wykonania').all().map((w) => w.zamowienie_id));
    expect(masowe.filter((m) => !wykryte.has(m))).toEqual([]);
    expect(wykryte.has(nowe[0])).toBe(true);
    expect(wykryte.size).toBe(1101);
  });
});

describe('4. wyjątek przy jednym wykonaniu nie zatrzymuje pozostałych', () => {
  it('zgoda rzuca dla jednego zamówienia → to pominięte (blad_wewnetrzny) z wpisem i logiem, reszta wychodzi (d6)', async () => {
    let zly = null;
    const e = srodowisko({ zgoda: async ({ wykonanie }) => {
      if (wykonanie.zamowienie_id === zly) throw new Error('nieoczekiwane dane zamówienia');
      return { ok: true };
    } });
    e.wlacz(e.regula());
    zly = zamowienie(e.db, { wyslane: iso(T0 + MIN) });
    const dobre = [zamowienie(e.db, { wyslane: iso(T0 + 2 * MIN) }), zamowienie(e.db, { wyslane: iso(T0 + 3 * MIN) })];
    e.z.przesun(4 * MIN);
    await expect(e.s.przebieg()).resolves.toBeTruthy();
    expect(e.akcja.wywolania).toEqual(dobre);
    expect(wiersz(e.db, zly)).toMatchObject({ stan: 'pominiete', powod_kod: 'blad_wewnetrzny' });
    expect(wpisy(e.db, zly)).toHaveLength(1);
    expect(wpisy(e.db, zly)[0].wynik).toContain('nieoczekiwane dane zamówienia');
    expect(e.logi.join('\n')).toContain('nieoczekiwane dane zamówienia');
  });
});

describe('5. odznaczony kanał w regule włączonej', () => {
  it('edycja zawężająca kanały od razu pomija zaplanowane z odznaczonego kanału (d2)', async () => {
    const e = srodowisko();
    const id = e.regula({ opoznienie_min: 120, warunki: { kanaly: ['sklep', 'allegro'], kanalyZnane: ['sklep', 'allegro'] } });
    e.wlacz(id);
    const za = zamowienie(e.db, { sklep: 'allegro', wyslane: iso(T0 + MIN) });
    const zs = zamowienie(e.db, { sklep: 'sklep', wyslane: iso(T0 + MIN) });
    e.z.przesun(2 * MIN);
    await e.s.przebieg();
    zmienRegule(e.db, id, REGULA({ opoznienie_min: 120, warunki: { kanaly: ['sklep'], kanalyZnane: ['sklep', 'allegro'] } }),
      { login: 'ewa', teraz: e.z.teraz });
    expect(wiersz(e.db, za)).toMatchObject({ stan: 'pominiete', powod_kod: 'kanal_odznaczony' });
    expect(wpisy(e.db, za)).toHaveLength(1);
    expect(wiersz(e.db, zs).stan).toBe('zaplanowane');
    e.z.przesun(125 * MIN);
    await e.s.przebieg();
    expect(e.akcja.wywolania).toEqual([zs]);
  });
  it('wysyłacz sprawdza kanał przed rezerwacją (zaplanowane z kanału, którego reguła już nie ma)', async () => {
    const e = srodowisko();
    const id = e.regula({ opoznienie_min: 30, warunki: { kanaly: ['sklep', 'allegro'], kanalyZnane: ['sklep', 'allegro'] } });
    e.wlacz(id);
    const za = zamowienie(e.db, { sklep: 'allegro', wyslane: iso(T0 + MIN) });
    e.z.przesun(2 * MIN);
    await e.s.przebieg();
    e.db.prepare('UPDATE automatyzacje_reguly SET warunki_json = ? WHERE id = ?')
      .run(JSON.stringify({ kanaly: ['sklep'], kanalyZnane: ['sklep', 'allegro'] }), id);
    e.z.przesun(30 * MIN);
    await e.s.przebieg();
    expect(wiersz(e.db, za)).toMatchObject({ stan: 'pominiete', powod_kod: 'kanal_odznaczony' });
    expect(e.akcja.wywolania).toEqual([]);
  });
});

describe('7. „Włącz” na regule już włączonej nic nie zmienia', () => {
  it('włączona i wstrzymana: wstrzymanie, granica i historia bez zmian', () => {
    const e = srodowisko();
    const id = e.regula();
    e.wlacz(id);
    e.db.prepare("UPDATE automatyzacje_reguly SET wstrzymana_powod = 'bezpiecznik' WHERE id = ?").run(id);
    const przed = wczytajRegule(e.db, id);
    const historia = przelaczeniaReguly(e.db, id).length;
    e.z.przesun(10 * MIN);
    expect(e.wlacz(id)).toBe(false);
    expect(wczytajRegule(e.db, id)).toEqual(przed);
    expect(przelaczeniaReguly(e.db, id)).toHaveLength(historia);
  });
});

describe('8. „w_toku” → „niepewne” przy pierwszym przebiegu zegara, nie przy budowie aplikacji', () => {
  it('zbudowanie aplikacji (np. skrypt na tej samej bazie) nie rusza trwającej wysyłki; pierwszy przebieg zegara tak', async () => {
    const katalog = mkdtempSync(join(tmpdir(), 'prz108-07-r8-'));
    const env = { OMS_TRYB: 'proba', OMS_USER: 'operator', OMS_PASS: 'atrapa', OMS_SPRZEDAWCA_NIP: '1234563218',
      OMS_RACHUNEK: '34109010140000000000000000', OMS_KANALY: '[]', OMS_ETYKIETY_KATALOG: katalog, OMS_PROFORMY_KATALOG: katalog };
    const moduly = modulyDla(env);
    const db = openOmsDb(':memory:', { moduly: kolejnoscBudowy(moduly) });
    const id = utworzRegule(db, REGULA(), { teraz: () => new Date(T0) });
    const zid = zamowienie(db);
    db.prepare(`INSERT INTO automatyzacje_wykonania (regula_id, przedmiot, zamowienie_id, stan, zdarzenie_at, wykryte_at, termin_at)
      VALUES (?, ?, ?, 'w_toku', ?, ?, ?)`).run(id, `zamowienie:${zid}`, zid, iso(T0), iso(T0), iso(T0));
    const a = await zbudujOms({ moduly, env, db, log: () => {} });
    try {
      expect(wiersz(db, zid).stan).toBe('w_toku');
      await a.zegary.find((x) => x.nazwa === 'automatyzacje').przebieg();
      expect(wiersz(db, zid).stan).toBe('niepewne');
    } finally { await a.app.close(); db.close(); }
  });
});

describe('9. zakoncz tylko z zaplanowane / w_toku; wpis w historii tylko przy zmianie', () => {
  it('wyłączenie reguły w trakcie przebiegu nie daje drugiego wpisu „pominięto” w historii zamówienia', async () => {
    let e;
    let wylaczono = false;
    e = srodowisko({ sprawdzWarunki: async ({ regula }) => {
      if (!wylaczono) { wylaczono = true; wylaczRegule(e.db, regula.id, { login: 'adam', teraz: e.z.teraz }); }
      return { ok: true };
    } });
    e.wlacz(e.regula());
    const z1 = zamowienie(e.db, { wyslane: iso(T0 + MIN) });
    const z2 = zamowienie(e.db, { wyslane: iso(T0 + MIN) });
    e.z.przesun(2 * MIN);
    await e.s.przebieg();
    expect(e.akcja.wywolania).toEqual([]);
    expect(wpisy(e.db, z1)).toHaveLength(1);
    expect(wpisy(e.db, z2)).toHaveLength(1);
  });
  it('zakoncz na wierszu już pominiętym: bez zmiany, bez wpisu, oddaje false', () => {
    const e = srodowisko();
    const id = e.regula();
    const zid = zamowienie(e.db);
    e.db.prepare(`INSERT INTO automatyzacje_wykonania (regula_id, przedmiot, zamowienie_id, stan, powod, zdarzenie_at, wykryte_at, termin_at, zakonczone_at)
      VALUES (?, ?, ?, 'pominiete', 'pierwszy', ?, ?, ?, ?)`).run(id, `zamowienie:${zid}`, zid, iso(T0), iso(T0), iso(T0), iso(T0));
    const w = wiersz(e.db, zid);
    expect(zakoncz(e.db, w, { stan: 'pominiete', powod: 'drugi', teraz: iso(T0 + MIN), nazwa: 'R' })).toBe(false);
    expect(wiersz(e.db, zid)).toEqual(w);
    expect(wpisy(e.db, zid)).toEqual([]);
  });
});
