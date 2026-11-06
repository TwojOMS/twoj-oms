// PRZ-153.E5.3b — POST /api/v1/produkty i PATCH /api/v1/produkty/:id (zakres produkty:zapis).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { buildOmsServer } from '../../pomoc/serwer-parytetu.ts';
import { zalozKonto } from '../../../src/core/bezpieczenstwo/konta.js';
import { zalozKluczApi } from '../../../src/core/bezpieczenstwo/klucze-api.js';
import { utworzKarte } from '../../../src/oms/db/magazyn.js';
import { etagKarty, kartaDoApi } from '../../../src/moduly/api/trasy/produkty-odczyt.js';
import { jako } from '../../pomoc/konta-prz068.js';

const STARA_DATA = '2026-01-01T00:00:00.000Z';
const STAN = { trwa: false, zaczety_at: null, skonczony_at: null, postep: null, kanaly: [], blad: null };

let db, app, zapis, odczyt;
beforeEach(async () => {
  db = openOmsDb(':memory:');
  app = buildOmsServer({ db, config: { auth: { user: 'adam', pass: 'x' } }, magazyn: { start: vi.fn(), stan: () => STAN } });
  await app.ready();
  const kontoId = zalozKonto(db, { login: 'tester', imie: 'Tester', haslo: 'h', admin: true, rola: 'administrator' });
  const klucz = (zakresy) => ({ authorization: `Bearer ${zalozKluczApi(db, {
    nazwa: 'integracja testowa', zakresy, kontoId, teraz: new Date().toISOString(),
  }).klucz}` });
  zapis = klucz(['produkty:zapis', 'produkty:odczyt']);
  odczyt = klucz(['produkty:odczyt']);
});
afterEach(async () => { await app.close(); db.close(); });

const wolaj = (method, url, payload, naglowki = {}, klucz = zapis) => app.inject({
  method, url: `/api/v1${url}`, headers: { ...klucz, ...naglowki }, ...(payload === undefined ? {} : { payload }),
});
const zaloz = (payload, naglowki) => wolaj('POST', '/produkty', payload, naglowki);
const zmien = (id, payload, naglowki) => wolaj('PATCH', `/produkty/${id}`, payload, naglowki);
const wiersz = (id) => db.prepare('SELECT * FROM karty_produktow WHERE id = ?').get(id);
const ileKart = () => db.prepare('SELECT COUNT(*) AS n FROM karty_produktow').get().n;
const dziennik = () => db.prepare('SELECT metoda, sciezka, status, klucz_id FROM klucze_api_dziennik ORDER BY id').all();
const karta = (dane = {}) => utworzKarte(db, { nazwa: 'Świecznik Półcień', ...dane }, { at: STARA_DATA });
const etag = (id) => etagKarty(wiersz(id));

describe('POST /api/v1/produkty', () => {
  it('odrzuca niepełne wymiary bez tworzenia karty; zapamiętuje 400', async () => {
    for (const wymiary of [
      { szerokosc_mm: 1 }, { wysokosc_mm: 2, glebokosc_mm: 3 }, { glebokosc_mm: 3 },
      { szerokosc_mm: 1, wysokosc_mm: null, glebokosc_mm: 3 },
    ]) {
      const r = await zaloz({ nazwa: 'Niepełna', wymiary });
      expect(r.statusCode).toBe(400);
      expect(r.json()).toEqual({ kod: 'wymiary', powod: expect.stringMatching(/^[A-ZĄĆĘŁŃÓŚŹŻ].*\.$/u) });
      expect(ileKart()).toBe(0);
    }
    const naglowki = { 'idempotency-key': 'niepelny-post' };
    const a = await zaloz({ nazwa: 'Niepełna', wymiary: { szerokosc_mm: 1 } }, naglowki);
    const b = await zaloz({ nazwa: 'Pełna', wymiary: null }, naglowki);
    expect([b.statusCode, b.body]).toEqual([400, a.body]);
    expect(ileKart()).toBe(0);
  });

  it('brak wymiarów i null zapisuje jako trzy null; błędny typ zachowuje walidację pola', async () => {
    for (const dane of [{}, { wymiary: null }]) {
      const r = await zaloz({ nazwa: 'Bez wymiarów', ...dane });
      expect(r.statusCode).toBe(201);
      expect(wiersz(r.json().id)).toMatchObject({ szerokosc_mm: null, wysokosc_mm: null, glebokosc_mm: null });
    }
    const r = await zaloz({ nazwa: 'Błędna', wymiary: { szerokosc_mm: '5' } });
    expect([r.statusCode, r.json().kod, r.json().pole]).toEqual([400, 'walidacja', 'wymiary.szerokosc_mm']);
    expect(ileKart()).toBe(2);
  });

  it('zakłada kartę: 201, Location, ETag, karta jak w GET; polskie znaki i emoji bez zmian, SKU obcięte', async () => {
    const r = await zaloz({
      nazwa: 'Żółta łódź 🛶', opis: 'Zażółć gęślą jaźń 🌙\n', sku: '  Łódź-1 ', kategoria: ' Łodzie ',
      ean: '5901234123457', cena_gr: 4990, stawka_vat: '23', wymiary: { szerokosc_mm: 100, wysokosc_mm: 200 }, waga_g: 50,
    });
    expect(r.statusCode).toBe(201);
    const id = r.json().id;
    const w = wiersz(id);
    expect(w).toMatchObject({ szerokosc_mm: 100, wysokosc_mm: 200, glebokosc_mm: null });
    expect(w).toMatchObject({ nazwa: 'Żółta łódź 🛶', opis: 'Zażółć gęślą jaźń 🌙\n', sku: 'Łódź-1', kategoria_glowna: 'Łodzie', wycofana: 0 });
    expect(r.headers.location).toBe(`/api/v1/produkty/${id}`);
    expect(r.headers.etag).toBe(etagKarty(w));
    expect(r.json()).toEqual(kartaDoApi(db, w));
    expect((await wolaj('GET', `/produkty/${id}`)).json()).toEqual(r.json());
  });

  it('SKU zajęte liczone jak zajeteSku (trim + wielkie litery, także polskie) → 409 z id, karta nie powstaje', async () => {
    const abc = karta({ sku: 'ABC' });
    const zolc = karta({ sku: ' ŻÓŁĆ ' });
    for (const [sku, id] of [[' abc ', abc], ['ABC', abc], ['żółć', zolc]]) {
      const r = await zaloz({ nazwa: 'Kopia', sku });
      expect(r.statusCode).toBe(409);
      expect(r.json()).toEqual({ kod: 'sku_zajete', id, powod: expect.any(String) });
    }
    expect(ileKart()).toBe(2);
  });

  it('odrzuca nieznane pole (400 pole) i brak nazwy (400 walidacja) bez zapisu', async () => {
    const r = await zaloz({ nazwa: 'A', cena: 10 });
    expect(r.statusCode).toBe(400);
    expect(r.json()).toEqual({ kod: 'pole', pole: 'cena', powod: expect.any(String) });
    const bezNazwy = await zaloz({ sku: 'X-1' });
    expect([bezNazwy.statusCode, bezNazwy.json().kod, bezNazwy.json().pole]).toEqual([400, 'walidacja', 'nazwa']);
    expect(ileKart()).toBe(0);
  });

  it('Review Focus 3: dwa POST z tym samym Idempotency-Key → jedna karta, ten sam status i to samo ciało', async () => {
    const klucz = { 'idempotency-key': 'zalozenie-1' };
    const a = await zaloz({ nazwa: 'Lampka 🌙', sku: 'L-1' }, klucz);
    const b = await zaloz({ nazwa: 'Lampka 🌙', sku: 'L-1' }, klucz);
    expect(a.statusCode).toBe(201);
    expect([b.statusCode, b.body]).toEqual([a.statusCode, a.body]);
    expect(ileKart()).toBe(1);
    // Zajęte SKU z kluczem: powtórka dostaje ten sam 409.
    const c = await zaloz({ nazwa: 'Inna', sku: 'l-1' }, { 'idempotency-key': 'zalozenie-2' });
    const d = await zaloz({ nazwa: 'Inna', sku: 'l-1' }, { 'idempotency-key': 'zalozenie-2' });
    expect([c.statusCode, d.statusCode, d.body]).toEqual([409, 409, c.body]);
    expect(ileKart()).toBe(1);
  });

  it('klucz z samym produkty:odczyt → 403 i nic nie zapisane', async () => {
    const r = await wolaj('POST', '/produkty', { nazwa: 'A' }, {}, odczyt);
    expect([r.statusCode, r.json().kod]).toEqual([403, 'brak_zakresu']);
    const id = karta();
    const p = await wolaj('PATCH', `/produkty/${id}`, { nazwa: 'B' }, { 'if-match': etag(id) }, odczyt);
    expect([p.statusCode, p.json().kod]).toEqual([403, 'brak_zakresu']);
    expect(ileKart()).toBe(1);
    expect(wiersz(id).nazwa).toBe('Świecznik Półcień');
  });

  it('dziennik: udany zapis ma wpis z kluczem; po 4xx wpis tylko z 4xx i karta bez zmian', async () => {
    const r = await zaloz({ nazwa: 'Lampka', sku: 'L-1' });
    expect(dziennik()).toEqual([{ metoda: 'POST', sciezka: '/api/v1/produkty', status: 201, klucz_id: expect.any(Number) }]);
    const id = r.json().id;
    await zaloz({ nazwa: 'Druga', sku: 'l-1' });
    await zmien(id, { nazwa: 'Bez If-Match' });
    expect(dziennik().slice(1).map((w) => w.status)).toEqual([409, 428]);
    expect(ileKart()).toBe(1);
    expect(wiersz(id).nazwa).toBe('Lampka');
    await zmien(id, { nazwa: 'Po zmianie' }, { 'if-match': etag(id) });
    expect(dziennik().at(-1)).toEqual({ metoda: 'PATCH', sciezka: `/api/v1/produkty/${id}`, status: 200, klucz_id: expect.any(Number) });
  });

  it('wyjątek po INSERT → 500 bez Location, ROLLBACK (0 kart, bez otwartej transakcji), kolejny POST zakłada kartę', async () => {
    db.exec('ALTER TABLE produkty_sklepowe RENAME TO produkty_sklepowe_x');
    const r = await zaloz({ nazwa: 'Lampka Półcień', sku: 'PC-9' });
    expect(r.statusCode).toBe(500);
    expect(r.headers.location).toBeUndefined();
    expect(ileKart()).toBe(0);
    expect(db.isTransaction).toBe(false);
    db.exec('ALTER TABLE produkty_sklepowe_x RENAME TO produkty_sklepowe');
    expect((await zaloz({ nazwa: 'Lampka Półcień', sku: 'PC-9' })).statusCode).toBe(201);
    expect(ileKart()).toBe(1);
  });
});

describe('PATCH /api/v1/produkty/:id', () => {
  it('karta z trzema wymiarami + PATCH jednego → OK; null pojedynczego odrzucony, null całości czyści', async () => {
    const id = karta({ szerokosc_mm: 1, wysokosc_mm: 2, glebokosc_mm: 3 });
    const r = await zmien(id, { wymiary: { szerokosc_mm: 5 } }, { 'if-match': etag(id) });
    expect(r.statusCode).toBe(200);
    expect(wiersz(id)).toMatchObject({ szerokosc_mm: 5, wysokosc_mm: 2, glebokosc_mm: 3 });
    const przed = wiersz(id);
    const naglowki = { 'if-match': etag(id), 'idempotency-key': 'niepelne-wymiary' };
    const b = await zmien(id, { wymiary: { wysokosc_mm: null }, nazwa: 'Nie zapisuj' }, naglowki);
    expect(b.statusCode).toBe(400);
    expect(b.json()).toEqual({ kod: 'wymiary', powod: expect.stringMatching(/^[A-ZĄĆĘŁŃÓŚŹŻ].*\.$/u) });
    expect(wiersz(id)).toEqual(przed);
    const czysc = await zmien(id, { wymiary: null }, { 'if-match': etag(id) });
    expect(czysc.statusCode).toBe(200);
    expect(wiersz(id)).toMatchObject({ szerokosc_mm: null, wysokosc_mm: null, glebokosc_mm: null });
    const po = wiersz(id);
    const powtorka = await zmien(id, { wymiary: { wysokosc_mm: null }, nazwa: 'Nie zapisuj' }, naglowki);
    expect([powtorka.statusCode, powtorka.body]).toEqual([400, b.body]);
    expect(wiersz(id)).toEqual(po);
  });

  it('karta bez wymiarów odrzuca jeden wymiar bez zapisu, przyjmuje komplet', async () => {
    const id = karta();
    const przed = wiersz(id);
    const r = await zmien(id, { wymiary: { szerokosc_mm: 5 }, nazwa: 'Nie zapisuj' }, { 'if-match': etag(id) });
    expect([r.statusCode, r.json().kod]).toEqual([400, 'wymiary']);
    expect(wiersz(id)).toEqual(przed);
    const komplet = { szerokosc_mm: 0, wysokosc_mm: 2, glebokosc_mm: 3 };
    expect((await zmien(id, { wymiary: komplet }, { 'if-match': etag(id) })).statusCode).toBe(200);
    expect(wiersz(id)).toMatchObject(komplet);
  });

  it('produkt płaski: dwa wymiary przy zakładaniu i zmiana szerokości bez głębokości przechodzą', async () => {
    const r = await zaloz({ nazwa: 'Plakat Półcień', wymiary: { szerokosc_mm: 700, wysokosc_mm: 1000 } });
    expect(r.statusCode).toBe(201);
    expect(wiersz(r.json().id)).toMatchObject({ szerokosc_mm: 700, wysokosc_mm: 1000, glebokosc_mm: null });
    const id = karta({ szerokosc_mm: 700, wysokosc_mm: 1000 });
    const p = await zmien(id, { wymiary: { szerokosc_mm: 710 } }, { 'if-match': etag(id) });
    expect(p.statusCode).toBe(200);
    expect(wiersz(id)).toMatchObject({ szerokosc_mm: 710, wysokosc_mm: 1000, glebokosc_mm: null });
    const g = await zmien(id, { wymiary: { glebokosc_mm: 5 } }, { 'if-match': etag(id) });
    expect(g.statusCode).toBe(200);
    const sama = await zmien(id, { wymiary: { szerokosc_mm: null, wysokosc_mm: null } }, { 'if-match': etag(id) });
    expect([sama.statusCode, sama.json().kod]).toEqual([400, 'wymiary']);
  });

  it('stara karta z połowicznym wymiarem: zmiana innych pól przechodzi, zmiana wymiarów wymaga kompletu', async () => {
    const id = karta({ szerokosc_mm: 7 });
    const r = await zmien(id, { nazwa: 'Nowa nazwa' }, { 'if-match': etag(id) });
    expect(r.statusCode).toBe(200);
    expect(wiersz(id)).toMatchObject({ nazwa: 'Nowa nazwa', szerokosc_mm: 7, wysokosc_mm: null });
    const w = await zmien(id, { wymiary: { glebokosc_mm: 2 } }, { 'if-match': etag(id) });
    expect([w.statusCode, w.json().kod]).toEqual([400, 'wymiary']);
  });

  it('bez If-Match → 428 if_match, karta bez zmian', async () => {
    const id = karta();
    const r = await zmien(id, { nazwa: 'Nowa' });
    expect([r.statusCode, r.json().kod]).toEqual([428, 'if_match']);
    expect(wiersz(id)).toMatchObject({ nazwa: 'Świecznik Półcień', zmieniony_at: STARA_DATA });
  });

  it('z aktualnym If-Match (także z białymi znakami) zmienia kartę i daje nowy ETag', async () => {
    const id = karta({ sku: 'S-1' });
    const r = await zmien(id, { nazwa: 'Świecznik 🕯️', cena_gr: 1234 }, { 'if-match': ` ${etag(id)} ` });
    expect(r.statusCode).toBe(200);
    expect(wiersz(id)).toMatchObject({ nazwa: 'Świecznik 🕯️', cena_gr: 1234, sku: 'S-1' });
    expect(wiersz(id).zmieniony_at).not.toBe(STARA_DATA);
    expect(r.headers.etag).toBe(etag(id));
    expect(r.json()).toEqual(kartaDoApi(db, wiersz(id)));
  });

  it('z nieaktualnym If-Match → 409 zmieniona z aktualną kartą', async () => {
    const id = karta();
    const r = await zmien(id, { nazwa: 'Nowa' }, { 'if-match': '"2025-01-01T00:00:00.000Z"' });
    expect(r.statusCode).toBe(409);
    expect(r.json()).toEqual({ kod: 'zmieniona', powod: expect.any(String), karta: kartaDoApi(db, wiersz(id)) });
    expect(wiersz(id).nazwa).toBe('Świecznik Półcień');
  });

  it('ETag sprzed zmiany człowieka na ekranie MAGAZYNU → 409, zmiana człowieka zostaje', async () => {
    const id = karta();
    const pobrany = await wolaj('GET', `/produkty/${id}`);
    const ekran = await app.inject({ method: 'POST', url: `/magazyn/${id}`, headers: { ...jako(db, 'tester'), origin: 'http://localhost' }, payload: { nazwa: 'Zmienione na ekranie' } });
    expect(ekran.statusCode).toBe(303);
    const r = await zmien(id, { nazwa: 'Z integracji' }, { 'if-match': pobrany.headers.etag });
    expect(r.statusCode).toBe(409);
    expect(r.json().kod).toBe('zmieniona');
    expect(r.json().karta.nazwa).toBe('Zmienione na ekranie');
    expect(wiersz(id).nazwa).toBe('Zmienione na ekranie');
  });

  it('wycofana true i false', async () => {
    const id = karta();
    expect((await zmien(id, { wycofana: true }, { 'if-match': etag(id) })).json().wycofana).toBe(true);
    expect(wiersz(id).wycofana).toBe(1);
    expect((await zmien(id, { wycofana: false }, { 'if-match': etag(id) })).json().wycofana).toBe(false);
    expect(wiersz(id).wycofana).toBe(0);
  });

  it('SKU innej karty (inna wielkość liter) → 409 sku_zajete; własne SKU inną wielkością przechodzi; null czyści', async () => {
    const abc = karta({ sku: 'ABC' });
    const id = karta({ sku: 'XYZ' });
    const r = await zmien(id, { sku: ' abc ' }, { 'if-match': etag(id) });
    expect([r.statusCode, r.json().kod, r.json().id]).toEqual([409, 'sku_zajete', abc]);
    expect(wiersz(id).sku).toBe('XYZ');
    expect((await zmien(id, { sku: 'xyz' }, { 'if-match': etag(id) })).statusCode).toBe(200);
    expect(wiersz(id).sku).toBe('xyz');
    const czysc = await zmien(id, { sku: null }, { 'if-match': etag(id) });
    expect([czysc.statusCode, czysc.json().sku, wiersz(id).sku]).toEqual([200, null, null]);
  });

  it('nieznane pole → 400 pole; pusty PATCH → 200 bez zapisu (zmieniony_at i ETag bez zmian)', async () => {
    const id = karta();
    const r = await zmien(id, { kolor: 'zielony' }, { 'if-match': etag(id) });
    expect(r.json()).toEqual({ kod: 'pole', pole: 'kolor', powod: expect.any(String) });
    const pusty = await zmien(id, {}, { 'if-match': etag(id) });
    expect(pusty.statusCode).toBe(200);
    expect(wiersz(id).zmieniony_at).toBe(STARA_DATA);
    expect(pusty.headers.etag).toBe(`"${STARA_DATA}"`);
  });

  it('nieistniejąca albo zła karta → 404 brak', async () => {
    for (const id of ['999', 'abc', '0', '1e3']) {
      const r = await zmien(id, { nazwa: 'X' }, { 'if-match': '"x"' });
      expect([r.statusCode, r.json().kod]).toEqual([404, 'brak']);
    }
  });

  it('Idempotency-Key: powtórka oddaje to samo mimo nowego ETag; ten sam klucz na innej karcie → 422', async () => {
    const id = karta();
    const inna = karta({ nazwa: 'Inna' });
    const naglowki = { 'if-match': etag(id), 'idempotency-key': 'zmiana-1' };
    const a = await zmien(id, { nazwa: 'Raz' }, naglowki);
    const b = await zmien(id, { nazwa: 'Raz' }, naglowki);
    expect(a.statusCode).toBe(200);
    expect([b.statusCode, b.body]).toEqual([a.statusCode, a.body]);
    const c = await zmien(inna, { nazwa: 'Raz' }, { 'if-match': etag(inna), 'idempotency-key': 'zmiana-1' });
    expect([c.statusCode, c.json().kod]).toEqual([422, 'idempotencja']);
    expect(wiersz(inna).nazwa).toBe('Inna');
  });
});
