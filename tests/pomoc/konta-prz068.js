// Wspólne atrapy testów PRZ-068/069: prawdziwy buildOmsServer, ciasteczko konta, migawka dostępu.
import { openOmsDb } from '../../src/oms/db/db.ts';
import { buildOmsServer } from './serwer-parytetu.ts';
import { podpisz, NAZWA_CIASTECZKA_OMS } from '../../src/core/bezpieczenstwo/sesja.js';
import { wczytajSekret } from '../../src/core/bezpieczenstwo/sekret-sesji.js';

export const CONFIG = { auth: { user: 'serwis', pass: 'tajne-haslo' } };
export const POLLER = { stan: () => ({ ostatni_przebieg_at: null, ostatni_blad: null }) };
export const HTML = { accept: 'text/html' };
export const ORIGIN = { origin: 'http://localhost' };
export const BASIC = { authorization: `Basic ${Buffer.from('serwis:tajne-haslo').toString('base64')}` };

export function nowyPanel(o = {}) {
  const db = o.db ?? openOmsDb(':memory:');
  const app = buildOmsServer({ poller: POLLER, ...o, db, config: { auth: { ...CONFIG.auth } } });
  return { db, app };
}
export const jako = (db, login, wersja = 0) => ({ cookie: `${NAZWA_CIASTECZKA_OMS}=${podpisz(login, wczytajSekret(db), Date.now(), wersja)}` });
export const get = (app, url, naglowki = {}) => app.inject({ method: 'GET', url, headers: { ...HTML, ...naglowki } });
export const post = (app, url, naglowki, payload = {}) => app.inject({ method: 'POST', url, headers: { ...HTML, ...ORIGIN, ...naglowki }, payload });
/** login → { admin, ekrany (posortowane) } — jedyna miara „czyjegoś dostępu” w przejściu. */
export function migawkaDostepu(db) {
  return Object.fromEntries(db.prepare('SELECT id, login, admin FROM konta ORDER BY login').all().map((k) => [k.login, {
    admin: k.admin === 1,
    ekrany: db.prepare('SELECT ekran FROM uprawnienia WHERE konto_id = ? ORDER BY ekran').all(k.id).map((w) => w.ekran),
  }]));
}
