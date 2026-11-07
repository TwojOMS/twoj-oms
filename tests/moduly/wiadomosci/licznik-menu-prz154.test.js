import { afterEach, beforeEach, expect, it } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { zapiszWatek, zamknijWatek } from '../../../src/oms/db/allegro-watki.js';
import { buildOmsServer } from '../../pomoc/serwer-parytetu.ts';

const headers = { authorization: `Basic ${Buffer.from('operator:x').toString('base64')}` };
let db; let app;
beforeEach(() => {
  db = openOmsDb(':memory:');
  app = buildOmsServer({ db, config: { auth: { user: 'operator', pass: 'x' }, klienciZbiorczy: [] } });
});
afterEach(async () => { await app.close(); db.close(); });
const zapisz = (nadpisz = {}) => zapiszWatek(db, {
  kanal: 'allegro_test', threadId: 't1', ostatniaOdKupujacego: 1,
  lastMessageDateTime: new Date().toISOString(), ...nadpisz,
});
const bok = html => html.split('<div class="oms-menu-desktop">')[1]?.split('<details class="oms-menu-mobile"')[0] ?? '';
const licznik = html => bok(html).match(/class="licznik oms-wiadomosci-licznik"[^>]*>(\d+)<\/span>/)?.[1];
const wejdz = (cookie = '') => app.inject({ url: '/przesylki', headers: { ...headers, cookie } });

it('liczy czekający wątek jednym COUNT i usuwa plakietkę po odpowiedzi sprzedawcy', async () => {
  zapisz();
  const sql = []; const prepare = db.prepare.bind(db);
  db.prepare = tekst => { sql.push(tekst); return prepare(tekst); };
  const r = await wejdz();
  expect(r.statusCode).toBe(200);
  expect(licznik(r.body)).toBe('1');
  const odczyty = sql.filter(s => /FROM allegro_watki/i.test(s));
  expect(odczyty).toHaveLength(1);
  expect(odczyty[0]).toMatch(/SELECT COUNT\(\*\)/i);
  zapisz({ ostatniaOdKupujacego: 0 });
  expect(licznik((await wejdz()).body)).toBeUndefined();
});
it('stosuje regułę ekranu: stary wątek czeka, ręcznie zamknięty nie, nowe pytanie znów czeka', async () => {
  const data = '2020-01-01T12:00:00Z';
  zapisz({ lastMessageDateTime: data });
  expect(licznik((await wejdz()).body)).toBe('1');
  zamknijWatek(db, 'allegro_test', 't1', data);
  expect(licznik((await wejdz()).body)).toBeUndefined();
  zapisz();
  expect(licznik((await wejdz()).body)).toBe('1');
});
it('menu zwinięte zachowuje plakietkę i liczbę w title', async () => {
  zapisz();
  const r = await wejdz('oms_menu=zwiniete');
  expect(r.body).toContain('oms-shell--zwiniete');
  expect(bok(r.body)).toContain('title="Wiadomości (1)"');
  expect(licznik(r.body)).toBe('1');
});
