// Wyszukiwarka nad listą zamówień znajduje zamówienie po loginie kupującego Allegro.
//
// Droga jak na produkcji: surowe zamówienie Allegro → mapowanie (login do bloku `klient`) → zapis → lista
// z `?szukaj=` (indeks listy, funkcja SQL `lista_szukaj`, reguła `domena/szukanie.js`). Login jest tym samym
// napisem, który lista pokazuje w kolumnie Klient — szukamy po tym, co operator widzi.
import { describe, it, expect, beforeEach } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { zapiszZamowienie } from '../../../src/oms/db/zamowienia.js';
import { buildOmsServer } from '../../pomoc/serwer-testowy-oms.ts';
import { mapujZamowienieAllegro } from '../../../src/domena/allegro-mapowanie.js';
import { metodaZId } from '../../../src/domena/allegro-dostawa.js';
import { polaSzukania, pasujeDoSzukania } from '../../../src/domena/szukanie.js';

const naglowek = { authorization: 'Basic ' + Buffer.from('adam:x').toString('base64'), origin: 'http://localhost' };
const poller = { stan: () => ({ ostatni_przebieg_at: null, ostatni_blad: null }) };
const definicje = [
  { klucz: 'sklep_a', typ: 'woo', prefiks: 'SKLEP_A', etykieta: 'Sklep Woo' },
  { klucz: 'konto_b', typ: 'allegro', prefiks: 'KONTO_B', etykieta: 'Konto Allegro' },
];

const adres = { street: 'Polna 1', city: 'Warszawa', postCode: '00-950', countryCode: 'PL' };
const surowe = (id, buyer) => ({
  id, status: 'READY_FOR_PROCESSING',
  lineItems: [{ boughtAt: '2026-11-16T10:00:00Z', quantity: 1, price: { amount: '10.00' }, offer: { name: 'Lampa' } }],
  summary: { totalToPay: { amount: '10.00', currency: 'PLN' } }, payment: { type: 'ONLINE' }, delivery: { cost: { amount: '0.00' } },
  buyer: { email: `${id}@allegromail.pl`, address: adres, ...buyer },
});

let db, app;
beforeEach(async () => {
  db = openOmsDb(':memory:');
  app = buildOmsServer({ db, config: { auth: { user: 'adam', pass: 'x' }, definicje }, poller });
  await app.ready();
});

const zapiszAllegro = (sur) => {
  const z = mapujZamowienieAllegro(sur, { metodaZId });
  // Imię i nazwisko celowo NIE zawierają loginu — trafienie może dać tylko login.
  return zapiszZamowienie(db, 'konto_b', { ...z, numer: sur.numer }, sur);
};
const numeryZnalezione = async (fraza) => {
  const r = await app.inject({ method: 'GET', url: `/?szukaj=${encodeURIComponent(fraza)}`, headers: naglowek });
  expect(r.statusCode, r.body).toBe(200);
  return ['A-9001', 'A-9002'].filter((n) => r.body.includes(`>${n}</a>`));
};

describe('szukanie po loginie kupującego Allegro', () => {
  beforeEach(() => {
    zapiszAllegro({ ...surowe('chk-9001', { login: 'lampy_jan77', firstName: 'Anna', lastName: 'Nowak' }), numer: 'A-9001' });
    zapiszAllegro({ ...surowe('chk-9002', { login: 'kinkiet_ewa', firstName: 'Ewa', lastName: 'Lis' }), numer: 'A-9002' });
  });

  it('pełny login znajduje zamówienie tego kupującego i tylko jego', async () => {
    expect(await numeryZnalezione('lampy_jan77')).toEqual(['A-9001']);
    expect(await numeryZnalezione('kinkiet_ewa')).toEqual(['A-9002']);
  });

  it('fragment loginu i inna wielkość liter też trafiają (ta sama reguła co reszta pól)', async () => {
    expect(await numeryZnalezione('JAN77')).toEqual(['A-9001']);
    expect(await numeryZnalezione('Lampy_Jan')).toEqual(['A-9001']);
  });

  it('login, którego nie ma, nie zwraca żadnego z tych zamówień', async () => {
    expect(await numeryZnalezione('nieznany_login_xyz')).toEqual([]);
  });
});

describe('reguła domeny', () => {
  it('login z bloku klienta jest polem wyszukiwania', () => {
    const z = { numer: '1', sklep: 'konto_b', klient: { first_name: 'Anna', last_name: 'Nowak', login: 'lampy_jan77' }, pozycje: [], przesylki: [] };
    expect(polaSzukania(z)).toContain('lampy_jan77');
    expect(pasujeDoSzukania(z, 'lampy_jan77')).toBe(true);
    expect(pasujeDoSzukania({ ...z, klient: { first_name: 'Anna', last_name: 'Nowak' } }, 'lampy_jan77')).toBe(false);
  });
});
