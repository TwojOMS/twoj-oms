import { describe, it, expect, beforeEach } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { zapiszZamowienie } from '../../../src/oms/db/zamowienia.js';
import { buildOmsServer } from '../../pomoc/serwer-parytetu.ts';

// PRZ-085: liczby przy statusach w bocznym menu znikały po wejściu w inną zakładkę niż lista
// i karta zamówienia (Przesyłki, Faktury…) — liczył je tylko `panelStatusow` tych dwóch ekranów.
// Teraz pipeline dokłada je na każdej stronie z menu zamówień, z TEGO SAMEGO indeksu co lista.

const AUTH = { authorization: `Basic ${Buffer.from('adam:x').toString('base64')}` };
const CONFIG = { auth: { user: 'adam', pass: 'x' }, klienciZbiorczy: [] };

const zmapowane = (nr, status = 'processing') => ({
  zrodlo_id: nr, numer: `Z-${nr}`, klient: { first_name: 'Jan', last_name: 'Testowy', email: 'j@k.pl' }, dostawa: {},
  metoda_wysylki: 'dpd', kwota_pobrania: null, chce_fakture: 0, nip: null,
  kwota_brutto: '50.00', status_woo: status, oplacone_at: null, anulowane: 0,
  utworzone_at: new Date().toISOString(), pozycje: [],
});

// Liczniki z menu KOMPUTEROWEGO: klucz statusu → tekst licznika.
const liczniki = (html) => {
  const bok = html.slice(html.indexOf('<div class="oms-menu-desktop">'), html.indexOf('<details class="oms-menu-mobile"'));
  return Object.fromEntries([...bok.matchAll(/<span class="licznik" data-status="([a-z_]+)">([^<]*)<\/span>/g)].map((m) => [m[1], m[2]]));
};

let db; let app;
beforeEach(() => {
  db = openOmsDb(':memory:');
  for (const n of [1, 2, 3]) zapiszZamowienie(db, 'pro', zmapowane(n), {});
  zapiszZamowienie(db, 'pro', zmapowane(4, 'cancelled'), {});
  app = buildOmsServer({ db, config: CONFIG });
});

describe('liczniki statusów w menu poza listą zamówień', () => {
  it('lista zamówień ma liczniki (punkt odniesienia)', async () => {
    const r = await app.inject({ method: 'GET', url: '/?wszystkie=1', headers: AUTH });
    const l = liczniki(r.body);
    expect(l.wszystkie).toBe('4');
    expect(Object.keys(l).length).toBeGreaterThan(3);
  });

  for (const url of ['/przesylki', '/faktury', '/zamowienia/nowe']) {
    it(`${url} pokazuje te same liczby co lista`, async () => {
      const wzor = liczniki((await app.inject({ method: 'GET', url: '/?wszystkie=1', headers: AUTH })).body);
      const r = await app.inject({ method: 'GET', url, headers: AUTH });
      expect(r.statusCode).toBe(200);
      const l = liczniki(r.body);
      // Lista dopisuje „po terminie" jako osobny licznik, więc porównujemy klucze strony bez listy.
      expect(l.wszystkie).toBe(wzor.wszystkie);
      expect(l.do_zrobienia).toBe(wzor.do_zrobienia);
      for (const k of Object.keys(wzor)) expect(l[k], `licznik ${k}`).toBe(wzor[k]);
    });
  }

  it('licznik jest też w menu telefonowym', async () => {
    const r = await app.inject({ method: 'GET', url: '/przesylki', headers: AUTH });
    const tel = r.body.slice(r.body.indexOf('<details class="oms-menu-mobile"'));
    expect(tel).toMatch(/<span class="licznik">4<\/span>/);
  });

  it('strona bez statusów w menu (Ustawienia) nie liczy indeksu wcale', async () => {
    const zapytania = [];
    const prepare = db.prepare.bind(db);
    db.prepare = (sql) => { zapytania.push(String(sql)); return prepare(sql); };
    const r = await app.inject({ method: 'GET', url: '/ustawienia/lacznosc', headers: AUTH });
    expect(r.statusCode).toBe(200);
    expect(zapytania.filter((s) => s.includes('lista_stan'))).toEqual([]);
    expect(liczniki(r.body)).toEqual({});
  });

  it('awaria indeksu nie wywraca strony — menu bez liczb', async () => {
    db.exec('DROP TABLE lista_stan');
    const r = await app.inject({ method: 'GET', url: '/przesylki', headers: AUTH });
    expect(r.statusCode).toBe(200);
    expect(liczniki(r.body)).toEqual({});
  });
});
