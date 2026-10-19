import { it, expect } from 'vitest';
import { nowyPanel, BASIC, post, get } from '../../pomoc/konta-prz068.js';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { statusyWKolejnosci, etykietyStatusow, koloryStatusow } from '../../../src/oms/db/statusy.js';
import { domyslneStatusy } from '../../../src/domena/statusy-konfiguracja.js';
import { zalozKonto } from '../../../src/core/bezpieczenstwo/konta.js';
import { jako } from '../../pomoc/konta-prz068.js';
import { buildOmsServer } from '../../pomoc/serwer-parytetu.ts';

it('ekran statusów dodaje własny etap, odrzuca duble, zmienia nazwę i kolor, przesuwa oraz przywraca systemowe', async () => {
  const { db, app } = nowyPanel();
  try {
    const poczatek = await get(app, '/ustawienia/statusy', BASIC);
    expect(poczatek.statusCode).toBe(200);
    const dodaj = await post(app, '/ustawienia/statusy', BASIC, { akcja: 'dodaj', etykieta: 'Do pakowania', kolor: 'fioletowy', jak: 'w_realizacji' });
    expect(dodaj.statusCode, dodaj.body).toBe(303);
    const czytaj = () => JSON.parse(db.prepare("SELECT wartosc FROM ustawienia WHERE klucz = 'statusy.konfiguracja'").get().wartosc);
    const wlasny = czytaj().find(s => s.jak);
    expect(wlasny).toMatchObject({ klucz: 'w_do_pakowania', jak: 'w_realizacji' });
    const dubel = await post(app, '/ustawienia/statusy', BASIC, { akcja: 'dodaj', etykieta: 'DO PAKOWANIA', kolor: 'szary', jak: 'nowe' });
    expect(dubel.statusCode).toBe(303);
    expect(czytaj()).toHaveLength(7);
    expect((await get(app, dubel.headers.location, BASIC)).body).toContain('już istnieje');
    await post(app, '/ustawienia/statusy', BASIC, { akcja: 'edytuj', klucz: 'nowe', etykieta: 'Nowe zamówienia', kolor: 'czerwony' });
    expect(czytaj()[0]).toMatchObject({ etykieta: 'Nowe zamówienia', kolor: 'czerwony' });
    for (let i = 0; i < 5; i++) await post(app, '/ustawienia/statusy', BASIC, { akcja: 'gora', klucz: wlasny.klucz });
    expect(czytaj()[1].klucz).toBe(wlasny.klucz);
    expect((await get(app, '/', BASIC)).body).toContain('Nowe zamówienia');
    await post(app, '/ustawienia/statusy', BASIC, { akcja: 'domyslne' });
    expect(czytaj().find(s => s.klucz === 'nowe')).toMatchObject({ etykieta: 'Nowe', kolor: 'niebieski' });
    expect(czytaj().find(s => s.klucz === wlasny.klucz)).toEqual({ ...wlasny, kolejnosc: 1 });
    await post(app, '/ustawienia/statusy', BASIC, { akcja: 'usun', klucz: wlasny.klucz });
    expect(czytaj()).toHaveLength(6);
  } finally { await app.close(); db.close(); }
});

it('pamięć konfiguracji jest osobna dla każdej bazy i wykrywa dwa zapisy z tą samą datą', () => {
  const a = openOmsDb(':memory:'), b = openOmsDb(':memory:');
  try {
    expect(statusyWKolejnosci(a)).toEqual(domyslneStatusy());
    expect(koloryStatusow(a)).toBeUndefined();
    const wpis = a.prepare('INSERT OR REPLACE INTO ustawienia (klucz, wartosc, zmienione_at) VALUES (?, ?, ?)');
    const statusy = domyslneStatusy();
    statusy[0].etykieta = 'Pierwsza nazwa';
    wpis.run('statusy.konfiguracja', JSON.stringify(statusy), '2026-10-18T12:00:00Z');
    expect(etykietyStatusow(a).nowe).toBe('Pierwsza nazwa');
    statusy[0].etykieta = 'Druga nazwa';
    wpis.run('statusy.konfiguracja', JSON.stringify(statusy), '2026-10-18T12:00:00Z');
    expect(etykietyStatusow(a).nowe).toBe('Druga nazwa');
    expect(etykietyStatusow(b).nowe).toBe('Nowe');
  } finally { a.close(); b.close(); }
});

it('konto bez uprawnienia Ustawienia ani obca strona nie mogą zapisać konfiguracji', async () => {
  const { db, app } = nowyPanel();
  try {
    zalozKonto(db, { login: 'operator_testowy', imie: 'Operator', haslo: 'test', rola: 'sprzedaz' });
    const operator = jako(db, 'operator_testowy');
    expect((await get(app, '/ustawienia/statusy', operator)).statusCode).toBe(403);
    expect((await post(app, '/ustawienia/statusy', operator, { akcja: 'domyslne' })).statusCode).toBe(403);
    const obce = await app.inject({ method: 'POST', url: '/ustawienia/statusy', headers: { ...BASIC, origin: 'http://obca.example.invalid' }, payload: { akcja: 'domyslne' } });
    expect(obce.statusCode).toBe(403);
    expect(db.prepare("SELECT wartosc FROM ustawienia WHERE klucz='statusy.konfiguracja'").get()).toBeUndefined();
  } finally { await app.close(); db.close(); }
});

it('gość demo widzi ekran, a POST blokuje wspólny hak podglądu', async () => {
  const db = openOmsDb(':memory:');
  const app = buildOmsServer({ db, config: { auth: { user: 'serwis', pass: 'test' }, demo: { login: 'gosc_testowy' } }, poller: { stan: () => ({}) } });
  try {
    await app.ready();
    // Nadanie prawa wejścia do ustawień nie daje gościowi prawa zapisu.
    zalozKonto(db, { login: 'gosc_testowy', imie: 'Gość', haslo: 'test', rola: 'administrator', admin: true });
    const gosc = jako(db, 'gosc_testowy');
    expect((await get(app, '/ustawienia/statusy', gosc)).statusCode).toBe(200);
    const r = await post(app, '/ustawienia/statusy', gosc, { akcja: 'domyslne' });
    expect(r.statusCode).toBe(403);
    expect(r.body).toContain('zmiany są wyłączone');
    expect(db.prepare("SELECT wartosc FROM ustawienia WHERE klucz='statusy.konfiguracja'").get()).toBeUndefined();
  } finally { await app.close(); db.close(); }
});
