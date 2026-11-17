import { afterEach, beforeEach, expect, it } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { buildOmsServer } from '../../pomoc/serwer-testowy-oms.ts';
import { utworzKarte, kartyZKanalami, zliczeniaBrakow } from '../../../src/oms/db/magazyn.js';
import { zalozKonto, ustawUprawnienia } from '../../../src/core/bezpieczenstwo/konta.js';
import { podpisz, NAZWA_CIASTECZKA_OMS } from '../../../src/core/bezpieczenstwo/sesja.js';
import { wczytajSekret } from '../../../src/core/bezpieczenstwo/sekret-sesji.js';
import { przelaczStany, stanKarty } from '../../../src/oms/db/stany-magazynowe.js';

let db, app;
const auth = { authorization: `Basic ${Buffer.from('operator:atrapa').toString('base64')}`, origin: 'http://localhost' };
const payload = { nazwa: 'Lampa Półcień', sku: 'LMP-07', ean: '5901234123457', cena_zl: '28,90', stawka_vat: '23' };
beforeEach(() => {
  db = openOmsDb(':memory:');
  app = buildOmsServer({ db, config: { auth: { user: 'operator', pass: 'atrapa' } }, magazyn: {
    stan: () => ({ trwa: false, zaczety_at: null, skonczony_at: null, postep: null, kanaly: [], blad: null }),
  } });
});
afterEach(async () => { await app.close(); db.close(); });
const post = (body = payload, headers = auth) => app.inject({ method: 'POST', url: '/magazyn/nowa-karta', headers, payload: body });
const ile = () => db.prepare('SELECT COUNT(*) AS n FROM karty_produktow').get().n;

it('udostępnia formularz i wejście z listy; GET nic nie zapisuje', async () => {
  const lista = await app.inject({ url: '/magazyn', headers: auth });
  expect(lista.body).toContain('href="/magazyn/nowa-karta"');
  const r = await app.inject({ url: '/magazyn/nowa-karta', headers: auth });
  expect(r.statusCode).toBe(200);
  expect(r.body).toContain('action="/magazyn/nowa-karta"');
  expect(r.body).toContain('name="nazwa"');
  expect(r.body).toContain('required');
  expect(ile()).toBe(0);
});
it.each([undefined, '', '   '])('odmawia bez nazwy (%s), zachowując wpisane wartości', async nazwa => {
  const body = { ...payload, nazwa };
  if (nazwa === undefined) delete body.nazwa;
  const r = await post(body);
  expect(r.statusCode).toBe(400);
  expect(r.body).toContain('Karta musi mieć nazwę');
  for (const value of ['LMP-07', '5901234123457', '28,90']) expect(r.body).toContain(`value="${value}"`);
  expect(ile()).toBe(0);
});
it('zapisuje 28,90 jako 2890 gr, ręczne źródła i przekierowuje; nie tworzy ruchu stanu', async () => {
  przelaczStany(db, { wlacz: true });
  const r = await post();
  expect(r.statusCode).toBe(303);
  const karta = db.prepare('SELECT * FROM karty_produktow').get();
  expect(r.headers.location).toBe(`/magazyn/${karta.id}`);
  expect(karta).toMatchObject({ nazwa: payload.nazwa, sku: payload.sku, ean: payload.ean, cena_gr: 2890, stawka_vat: '23' });
  expect(db.prepare('SELECT pole, zrodlo, reczne FROM karty_zrodla_pol ORDER BY pole').all())
    .toEqual(['cena_gr', 'ean', 'nazwa', 'sku', 'stawka_vat'].map(pole => ({ pole, zrodlo: 'reczne', reczne: 1 })));
  expect(db.prepare('SELECT COUNT(*) AS n FROM ruchy_magazynowe').get().n).toBe(0);
  expect(stanKarty(db, karta.id).stan).toBe(0);
});
it('pozwala podać samą nazwę i pozostawia pozostałe pola bez ręcznych źródeł', async () => {
  expect((await post({ nazwa: 'Lampa Półcień' })).statusCode).toBe(303);
  expect(db.prepare('SELECT sku, ean, cena_gr, stawka_vat FROM karty_produktow').get())
    .toEqual({ sku: null, ean: null, cena_gr: null, stawka_vat: null });
  expect(db.prepare('SELECT pole FROM karty_zrodla_pol').all()).toEqual([{ pole: 'nazwa' }]);
});
it.each([{ ean: '123' }, { cena_zl: 'abc' }, { stawka_vat: '99' }, { sku: 'ZAJETE' }])('stosuje walidację karty: %j', async zmiana => {
  utworzKarte(db, { nazwa: 'Lampa inna', sku: 'ZAJETE' });
  const r = await post({ ...payload, ...zmiana });
  expect(r.statusCode).toBe(400);
  expect(ile()).toBe(1);
  expect(r.body).not.toContain('Internal Server Error');
});
it('odrzuca CSRF przed zapisem', async () => {
  expect((await post(payload, { ...auth, origin: 'http://obcy.example' })).statusCode).toBe(403);
  expect((await post(payload, { authorization: auth.authorization })).statusCode).toBe(403);
  expect(ile()).toBe(0);
});
it('na pustej liście oba kafle i filtry są puste', () => {
  expect(zliczeniaBrakow(db)).toMatchObject({ bezZdjecia: 0, bezOpisu: 0 });
  for (const brak of ['zdjecie', 'opis']) expect(kartyZKanalami(db, { filtry: { brak } })).toEqual([]);
});
it('pusta karta zachowuje sześć braków w danych, bez kolumny Stan na liście', async () => {
  utworzKarte(db, { nazwa: 'Lampa bez danych' });
  const r = await app.inject({ url: '/magazyn', headers: auth });
  expect(r.statusCode).toBe(200);
  expect(kartyZKanalami(db)[0].liczba_brakow).toBe(6);
  expect(r.body).toContain('>Lampa bez danych</a>');
  expect(r.body).not.toContain('class="stan-braki"');
});
it('wymaga logowania i uprawnienia magazyn dla obu tras', async () => {
  for (const method of ['GET', 'POST']) {
    const r = await app.inject({ method, url: '/magazyn/nowa-karta', payload: method === 'POST' ? payload : undefined });
    expect([401, 302, 303]).toContain(r.statusCode);
  }
  await app.ready();
  zalozKonto(db, { login: 'admin', imie: 'Admin', haslo: 'test', rola: 'admin', admin: true });
  const id = zalozKonto(db, { login: 'czytelnik', imie: 'Czytelnik', haslo: 'test', rola: 'operator' });
  ustawUprawnienia(db, id, []);
  const headers = { origin: 'http://localhost', cookie: `${NAZWA_CIASTECZKA_OMS}=${podpisz('czytelnik', wczytajSekret(db), Date.now(), 0)}` };
  for (const method of ['GET', 'POST']) expect((await app.inject({ method, url: '/magazyn/nowa-karta', headers,
    payload: method === 'POST' ? payload : undefined })).statusCode).toBe(403);
  expect(ile()).toBe(0);
});

it('filtry zdjęć i opisów zgadzają się ze zliczeniami; select zachowuje wybór', async () => {
  const pelna = { sku: 'PELNA', szerokosc_mm: 100, wysokosc_mm: 100, paczkomat: 'tak', kategoria_glowna: 'Lampy' };
  const ids = ['Komplet', 'Bez zdjęcia', 'Bez opisu', 'Bez obu'].map((nazwa, i) => utworzKarte(db, { ...pelna, sku: `K-${i}`, nazwa }));
  for (const id of ids.slice(0, 2)) db.prepare('UPDATE karty_produktow SET opis_sekcje_json = ? WHERE id = ?')
    .run(JSON.stringify({ sekcje: [{ elementy: [{ typ: 'tekst', html: '<p>Lampa</p>' }] }] }), id);
  db.prepare('UPDATE karty_produktow SET opis_sekcje_json = ? WHERE id = ?').run('{"sekcje":[]}', ids[2]);
  for (const id of [ids[0], ids[2]]) db.prepare(`INSERT INTO zdjecia_kart
    (karta_id, kolejnosc, zrodlo, adres_zrodlowy, utworzono_at) VALUES (?, 0, 'reczne', 'https://example.org/lampa.png', '2026-11-13')`).run(id);
  const z = zliczeniaBrakow(db);
  expect(z.bezZdjecia).toBe(2);
  expect(z.bezOpisu).toBe(2);
  for (const [brak, klucz, nazwy] of [['zdjecie', 'bezZdjecia', ['Bez obu', 'Bez zdjęcia']], ['opis', 'bezOpisu', ['Bez obu', 'Bez opisu']]]) {
    const lista = kartyZKanalami(db, { filtry: { brak } });
    expect(lista.map(k => k.nazwa)).toEqual(nazwy);
    expect(lista.length).toBe(z[klucz]);
    const ekran = await app.inject({ url: `/magazyn?brak=${brak}`, headers: auth });
    expect(ekran.statusCode).toBe(200);
    expect(ekran.body).not.toContain('class="kafle"');
    expect(ekran.body).toContain(`brak=${brak}`);
    expect(ekran.body).toContain(`<option value="${brak}" selected>`);
    for (const id of ids) expect(ekran.body.includes(`href="/magazyn/${id}?`)).toBe(lista.some(k => k.id === id));
  }
  expect(kartyZKanalami(db, { sort: 'braki', kier: 'desc' }).map(k => k.liczba_brakow)).toEqual([2, 1, 1, 0]);
  expect(kartyZKanalami(db, { filtry: { brak: 'komplet' } }).map(k => k.id)).toEqual([ids[0]]);
});
it('karta z popsutym opis_sekcje_json nie wywraca listy ani kafli i liczy się jako bez opisu', async () => {
  const id = utworzKarte(db, { nazwa: 'Lampa z popsutym opisem' });
  for (const zly of ['', 'nie-json']) {
    db.prepare('UPDATE karty_produktow SET opis_sekcje_json = ? WHERE id = ?').run(zly, id);
    expect(zliczeniaBrakow(db).bezOpisu).toBe(1);
    expect(kartyZKanalami(db, { filtry: { brak: 'opis' } }).map(k => k.id)).toEqual([id]);
    expect((await app.inject({ url: '/magazyn', headers: auth })).statusCode).toBe(200);
  }
});
it('niegotowy magazyn: nowa karta nic nie zapisuje', async () => {
  await app.close();
  app = buildOmsServer({ db, config: { auth: { user: 'operator', pass: 'atrapa' } }, magazyn: { gotowy: () => false, stan: () => ({ trwa: false }) } });
  expect((await post()).statusCode).toBe(302);
  expect(ile()).toBe(0);
});
