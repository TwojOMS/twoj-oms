import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { buildOmsServer } from '../../pomoc/serwer-testowy-oms.ts';
import { utworzKarte } from '../../../src/oms/db/magazyn.js';
import { wstawOferte, zmienOferte } from '../../../src/oms/db/oferty-kanalow.ts';
import { zalozKonto, ustawUprawnienia } from '../../../src/core/bezpieczenstwo/konta.js';
import { podpisz, NAZWA_CIASTECZKA_OMS } from '../../../src/core/bezpieczenstwo/sesja.js';
import { wczytajSekret } from '../../../src/core/bezpieczenstwo/sekret-sesji.js';

let db, app, prepare;
const karta = n => utworzKarte(db, { nazwa: `Lampa Półcień ${n}`, sku: `POL-${n}`, marka: 'Pracownia Półcień' });
const zapytaniaLicznika = () => prepare.mock.calls.filter(([sql]) => /SELECT COUNT\(\*\) AS n FROM oferty_kanalow o/.test(sql));
const get = (login = 'admin') => app.inject({ method: 'GET', url: '/magazyn', headers: {
  cookie: `${NAZWA_CIASTECZKA_OMS}=${podpisz(login, wczytajSekret(db), Date.now(), 0)}`,
} });
function dwieOfertyDoDecyzji() {
  const id = karta(1);
  wstawOferte(db, { kartaId: id, kanal: 'allegro_polcien', idZewnetrzne: 'pol-problem', stan: 'problem' });
  const cena = wstawOferte(db, { kartaId: id, kanal: 'erli-polcien', idZewnetrzne: 'pol-cena', stan: 'aktywna' });
  zmienOferte(db, cena.id, { cenaDoPotwierdzeniaGr: 12900 });
  wstawOferte(db, { kartaId: karta(2), kanal: 'allegro_polcien', idZewnetrzne: 'pol-zwykla', stan: 'aktywna' });
}

beforeEach(async () => {
  db = openOmsDb(':memory:');
  zalozKonto(db, { login: 'admin', imie: 'Administrator', haslo: 'test', rola: 'admin', admin: true });
  const user = zalozKonto(db, { login: 'czytelnik', imie: 'Czytelnik', haslo: 'test', rola: 'operator' });
  ustawUprawnienia(db, user, ['magazyn']);
  app = buildOmsServer({ db, config: { auth: { user: 'operator', pass: 'atrapa' }, definicje: [] },
    magazyn: { stan: () => ({ trwa: false, kanaly: [] }) } });
  await app.ready();
  prepare = vi.spyOn(db, 'prepare');
});
afterEach(async () => { vi.restoreAllMocks(); await app.close(); db.close(); });

it('admin widzi link Problemy ofert (2), liczony po ofertach, także wymagających potwierdzenia ceny', async () => {
  dwieOfertyDoDecyzji();
  const r = await get();
  expect(r.statusCode).toBe(200);
  expect(r.body).toMatch(/<a\b[^>]*href="\/magazyn\/problemy-ofert"[^>]*>Problemy ofert \(2\)<\/a>/);
  expect(zapytaniaLicznika()).toHaveLength(1);
});

it('konto z prawem magazynu bez admina nie widzi linku i nie odczytuje licznika', async () => {
  dwieOfertyDoDecyzji();
  const r = await get('czytelnik');
  expect(r.statusCode).toBe(200);
  expect(r.body).not.toContain('/magazyn/problemy-ofert');
  expect(zapytaniaLicznika()).toHaveLength(0);
});

it('admin przy N=0 nie widzi linku', async () => {
  wstawOferte(db, { kartaId: karta(1), kanal: 'allegro_polcien', idZewnetrzne: 'pol-aktywna', stan: 'aktywna' });
  const r = await get();
  expect(r.statusCode).toBe(200);
  expect(r.body).not.toContain('/magazyn/problemy-ofert');
  expect(zapytaniaLicznika()).toHaveLength(1);
});

it.each([3, 30])('licznik wykonuje jedno zapytanie na żądanie przy %i kartach', async liczbaKart => {
  for (let n = 1; n <= liczbaKart; n++) karta(n);
  for (let zadanie = 0; zadanie < 2; zadanie++) {
    prepare.mockClear();
    expect((await get()).statusCode).toBe(200);
    expect(zapytaniaLicznika()).toHaveLength(1);
  }
});
