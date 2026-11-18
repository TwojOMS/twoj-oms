import { describe, it, expect, beforeEach } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { buildOmsServer } from '../../pomoc/serwer-testowy-oms.ts';
import { klientPoNip } from '../../../src/oms/db/klienci.js';
import { zalozZamowienieReczne } from '../../../src/moduly/zamowienia/services/zamowienie-reczne.js';

// Wpis dziennika ma pokazywać klucz ZAPISANY w bazie,
// a nie ten, który `znormalizujKlienta` wyliczył z nazwy (baza potrafi dołożyć „-2”, „klient-3”).
const config = { auth: { user: 'adam', pass: 'x' }, sprzedawca: { nazwa: 'Pracownia Półcień Anna Wzorcowa' } };
const naglowek = { authorization: `Basic ${Buffer.from('adam:x').toString('base64')}`, origin: 'http://localhost' };
const poller = { stan: () => ({ ostatni_przebieg_at: '2026-08-21T09:00:00', ostatni_blad: null }) };
let db;
let app;

beforeEach(async () => {
  db = openOmsDb(':memory:');
  app = buildOmsServer({ db, config, poller });
  await app.ready();
});

const post = (url, payload) => app.inject({ method: 'POST', url, headers: naglowek, payload });
const wpisy = (akcja) =>
  db
    .prepare('SELECT wynik FROM log WHERE akcja = ? ORDER BY id')
    .all(akcja)
    .map((w) => w.wynik);
const klucze = () => db.prepare('SELECT id, klucz FROM klienci ORDER BY id').all();

describe('dziennik zapisu klienta (ekran Klienci B2B) pokazuje klucz z bazy', () => {
  it('druga firma o tej samej nazwie: w dzienniku klucz z końcówką „-2”', async () => {
    await post('/klienci', { nazwa: 'Pracownia Półcień' });
    await post('/klienci', { nazwa: 'Pracownia Półcień' });
    const [pierwszy, drugi] = klucze();
    expect(drugi.klucz).not.toBe(pierwszy.klucz);
    expect(wpisy('klient.zapis')[1]).toContain(`(${drugi.klucz})`);
  });

  it('nazwa bez liter i cyfr: w dzienniku klucz z bazy, nie pusty nawias', async () => {
    await post('/klienci', { nazwa: '!!!' });
    const [k] = klucze();
    expect(k.klucz).toBeTruthy();
    const wpis = wpisy('klient.zapis')[0];
    expect(wpis).toContain(`(${k.klucz})`);
    expect(wpis).not.toContain('()');
  });

  it('zmiana nazwy przy edycji: w dzienniku stary klucz z bazy', async () => {
    await post('/klienci', { nazwa: 'Pracownia Półcień' });
    const [k] = klucze();
    await post('/klienci', { id: String(k.id), nazwa: 'Zupełnie Inna Nazwa' });
    expect(klucze()[0].klucz).toBe(k.klucz);
    expect(wpisy('klient.zapis')[1]).toContain(`(${k.klucz})`);
  });

  it('„Zapamiętaj klienta” z karty zamówienia: klucz z bazy, także po kolizji nazwy', async () => {
    await post('/klienci', { nazwa: 'Pracownia Półcień' });
    const z = zalozZamowienieReczne({
      db,
      znacznik: '2026-08-21T09:00:00.000Z',
      dane: {
        klient: {
          first_name: 'Anna',
          last_name: 'Półcień',
          company: 'Pracownia Półcień',
          address_1: 'Lampowa 1',
          postcode: '00-950',
          city: 'Warszawa',
          email: 'biuro@polcien.invalid',
        },
        dostawa: {
          first_name: 'Anna',
          last_name: 'Półcień',
          company: 'Pracownia Półcień',
          address_1: 'Lampowa 1',
          postcode: '00-950',
          city: 'Warszawa',
        },
        nip: '5250000009',
        chce_fakture: 1,
        metoda_wysylki: 'dpd',
        koszt_dostawy_brutto: '0.00',
        metoda_platnosci: 'Przelew',
        b2b: 1,
        termin_platnosci: '14',
        rabat_procent: 0,
        pozycje: [],
      },
    });
    expect((await post(`/zamowienia/${z.id}/klient/zapamietaj`)).statusCode).toBe(302);
    const k = klientPoNip(db, '5250000009');
    expect(k.klucz).not.toBe(klucze()[0].klucz);
    expect(wpisy('klient.zapamietaj')[0]).toContain(`(${k.klucz}`);
  });
});
