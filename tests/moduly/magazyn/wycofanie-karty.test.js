import { afterEach, beforeEach, expect, it } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { kartaPoId, utworzKarte, zapiszKarte } from '../../../src/oms/db/magazyn.js';
import { buildOmsServer } from '../../pomoc/serwer-testowy-oms.ts';
import { zalozKonto, ustawUprawnienia } from '../../../src/core/bezpieczenstwo/konta.js';
import { podpisz, NAZWA_CIASTECZKA_OMS } from '../../../src/core/bezpieczenstwo/sesja.js';
import { wczytajSekret } from '../../../src/core/bezpieczenstwo/sekret-sesji.js';

let db, app, id, admin, operator, bezPraw;
const post = (akcja, headers = admin, payload = { potwierdz: 'tak' }) =>
  app.inject({ method: 'POST', url: `/magazyn/${id}/${akcja}`, headers, payload });
const get = (headers = admin, query = '') => app.inject({ url: `/magazyn/${id}${query}`, headers });
const stan = () => kartaPoId(db, id).wycofana;

beforeEach(async () => {
  db = openOmsDb(':memory:');
  app = buildOmsServer({ db, config: { auth: { user: 'operator', pass: 'atrapa' } }, magazyn: {} });
  await app.ready();
  const konto = (login, czyAdmin, prawa) => {
    const kontoId = zalozKonto(db, { login, imie: login, haslo: 'atrapa-testowa', rola: 'operator', admin: czyAdmin });
    ustawUprawnienia(db, kontoId, prawa);
    return {
      origin: 'http://localhost',
      cookie: `${NAZWA_CIASTECZKA_OMS}=${podpisz(login, wczytajSekret(db), Date.now(), 0)}`,
    };
  };
  admin = konto('administrator-testowy', true, []);
  operator = konto('operator-testowy', false, ['magazyn']);
  bezPraw = konto('czytelnik-testowy', false, []);
  id = utworzKarte(db, { nazwa: 'Lampa testowa' });
});
afterEach(async () => {
  await app?.close();
  db?.close();
});

it('admin widzi wejście do potwierdzenia; GET potwierdzenia nie wycofuje karty', async () => {
  const r = await get();
  expect(r.statusCode).toBe(200);
  const naglowek = r.body.match(/<header[^>]*id="naglowek-karty"[\s\S]*?<\/header>/)?.[0];
  expect(naglowek).toMatch(/<details[^>]*>\s*<summary[^>]*>Więcej/);
  expect(naglowek).toContain('Wycofaj ze sprzedaży…');
  expect(naglowek).toContain(`href="/magazyn/${id}?wycofaj=tak#potwierdz-wycofanie-karty"`);
  expect(r.body).not.toContain('id="sprzedaz-karty"');
  expect(r.body).not.toContain(`action="/magazyn/${id}/wycofaj"`);
  const potwierdzenie = await get(admin, '?wycofaj=tak');
  expect(potwierdzenie.statusCode).toBe(200);
  const pasek = potwierdzenie.body.match(
    /<header[^>]*id="naglowek-karty"[\s\S]*?<\/header>\s*(<section[^>]*id="potwierdz-wycofanie-karty"[\s\S]*?<\/section>)/,
  )?.[1];
  expect(pasek).toContain('Ta karta nie ma ofert wystawionych z OMS. Wycofanie zablokuje wystawianie nowych.');
  expect(pasek).toContain(
    'Oferty istniejące w kanałach, które OMS tylko obserwuje, i produkty w sklepie zostają bez zmian.',
  );
  expect(pasek).toContain(`action="/magazyn/${id}/wycofaj"`);
  expect(pasek).toContain('name="potwierdz" value="tak"');
  expect(pasek).toContain(`href="/magazyn/${id}#naglowek-karty">Anuluj`);
  expect(stan()).toBe(0);
});

it('admin wycofuje i przywraca kartę; widok mówi o skutkach obu operacji', async () => {
  const wycofanie = await post('wycofaj');
  expect(wycofanie.statusCode).toBe(303);
  expect(wycofanie.headers.location).toBe(`/magazyn/${id}#naglowek-karty`);
  expect(stan()).toBe(1);
  const widok = await get();
  expect(widok.statusCode).toBe(200);
  const naglowek = widok.body.match(/<header[^>]*id="naglowek-karty"[\s\S]*?<\/header>/)?.[0];
  expect(naglowek).toContain('plakietka plakietka--wycofana">wycofana ze sprzedaży');
  expect(naglowek).toContain('Przywróć do sprzedaży');
  expect(naglowek).toContain('Oferty w kanałach nie wrócą automatycznie');
  expect(widok.body).not.toContain('Wycofaj ze sprzedaży');
  const przywrocenie = await post('przywroc');
  expect(przywrocenie.statusCode).toBe(303);
  expect(przywrocenie.headers.location).toBe(`/magazyn/${id}#naglowek-karty`);
  expect(stan()).toBe(0);
});

it('operator z prawem magazynu i konto bez praw nie mogą wycofywać ani przywracać', async () => {
  for (const headers of [operator, bezPraw]) {
    expect((await post('wycofaj', headers)).statusCode).toBe(403);
    expect(stan()).toBe(0);
    zapiszKarte(db, id, { wycofana: 1 });
    expect((await post('przywroc', headers)).statusCode).toBe(403);
    expect(stan()).toBe(1);
    zapiszKarte(db, id, { wycofana: 0 });
  }
});

it('operator nie widzi akcji nawet po otwarciu adresu potwierdzenia; widzi status wycofanej karty', async () => {
  for (const wycofana of [0, 1]) {
    zapiszKarte(db, id, { wycofana });
    for (const query of ['', '?wycofaj=tak']) {
      const r = await get(operator, query);
      expect(r.statusCode).toBe(200);
      expect(r.body).not.toContain('>Więcej <');
      expect(r.body).not.toContain('Wycofaj ze sprzedaży');
      expect(r.body).not.toContain('Przywróć do sprzedaży');
      expect(r.body).not.toContain(`/magazyn/${id}/wycofaj`);
      expect(r.body).not.toContain(`/magazyn/${id}/przywroc`);
      if (wycofana) expect(r.body).toContain('plakietka plakietka--wycofana">wycofana ze sprzedaży');
    }
  }
});

it('bez CSRF i z obcym Origin obie operacje dają 403 bez zmiany danych', async () => {
  for (const headers of [{ cookie: admin.cookie }, { ...admin, origin: 'https://obcy.example' }]) {
    expect((await post('wycofaj', headers)).statusCode).toBe(403);
    expect(stan()).toBe(0);
    zapiszKarte(db, id, { wycofana: 1 });
    expect((await post('przywroc', headers)).statusCode).toBe(403);
    expect(stan()).toBe(1);
    zapiszKarte(db, id, { wycofana: 0 });
  }
});

it('wycofanie wymaga jawnego potwierdzenia w formularzu', async () => {
  expect((await post('wycofaj', admin, {})).statusCode).toBe(400);
  expect(stan()).toBe(0);
});

it('operacje admina na nieistniejącej karcie zwracają 404', async () => {
  id = 999999;
  expect((await post('wycofaj')).statusCode).toBe(404);
  expect((await post('przywroc')).statusCode).toBe(404);
});
