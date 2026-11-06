import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { buildOmsServer } from '../../pomoc/serwer-parytetu.ts';
import { zalozKonto } from '../../../src/core/bezpieczenstwo/konta.js';
import { zalozKluczApi } from '../../../src/core/bezpieczenstwo/klucze-api.js';
import { utworzKarte, powiazProdukt, zapiszProduktSklepowy } from '../../../src/oms/db/magazyn.js';
import { zapiszZamowienie } from '../../../src/oms/db/zamowienia.js';
import { przelaczStany, stanyKart } from '../../../src/oms/db/stany-magazynowe.js';

const OD = '2026-01-01T00:00:00.000Z';
let db, app, pelny, drugi, obcy, odczyt, zapis, karta, licznik;
beforeEach(async () => {
  db = openOmsDb(':memory:');
  app = buildOmsServer({ db, config: { auth: { user: 'operator', pass: 'x' } },
    magazyn: { start: vi.fn(), stan: () => ({ trwa: false, kanaly: [] }) } });
  await app.ready();
  const kontoId = zalozKonto(db, { login: 'tester', imie: 'Tester', haslo: 'h', admin: true, rola: 'administrator' });
  const klucz = (zakresy) => ({ authorization: `Bearer ${zalozKluczApi(db, {
    nazwa: 'Pracownia Półcień', zakresy, kontoId, teraz: new Date().toISOString(),
  }).klucz}` });
  pelny = klucz(['stany:odczyt', 'stany:zapis']);
  drugi = klucz(['stany:odczyt', 'stany:zapis']);
  obcy = klucz(['produkty:odczyt']);
  odczyt = klucz(['stany:odczyt']);
  zapis = klucz(['stany:zapis']);
  karta = utworzKarte(db, { nazwa: 'Lampa Półcień', sku: 'ŻÓŁĆ-1' });
  licznik = 0;
  przelaczStany(db, { wlacz: true, at: OD });
});
afterEach(async () => { await app.close(); db.close(); });
const get = (query = '', headers = pelny) => app.inject({ method: 'GET', url: `/api/v1/stany${query}`, headers });
const post = (payload = { karta_id: karta, rodzaj: 'przyjecie', ilosc: 5 }, headers = pelny, key = `ruch-${++licznik}`) =>
  app.inject({ method: 'POST', url: '/api/v1/stany/ruchy', payload,
    headers: { ...headers, ...(key === null ? {} : { 'idempotency-key': key }) } });
const ruchy = () => db.prepare('SELECT * FROM ruchy_magazynowe ORDER BY id').all();

describe('stany API v1', () => {
  it('obie trasy wymagają klucza (401) i własnego zakresu (403)', async () => {
    for (const headers of [{}, { authorization: 'Bearer zly' }]) {
      expect((await get('', headers)).statusCode).toBe(401);
      expect((await post(undefined, headers)).statusCode).toBe(401);
    }
    for (const headers of [obcy, zapis]) expect((await get('', headers)).statusCode).toBe(403);
    for (const headers of [obcy, odczyt]) expect((await post(undefined, headers)).statusCode).toBe(403);
    expect(ruchy()).toHaveLength(0);
  });

  it('wyłączony przełącznik daje 409 na obu trasach przed zapisem ruchu', async () => {
    przelaczStany(db, { wlacz: false });
    for (const r of [await get(), await post()]) {
      expect(r.statusCode).toBe(409);
      expect(r.json()).toEqual({ kod: 'stany_wylaczone', powod: expect.any(String) });
    }
    expect(ruchy()).toHaveLength(0);
  });

  it('GET: zero bez ruchów, ISO UTC, filtr SKU jak produkty i stronicowanie po id z dziurami', async () => {
    const dziura = utworzKarte(db, { nazwa: 'Usunięta' });
    db.prepare('DELETE FROM karty_produktow WHERE id = ?').run(dziura);
    const ostatnia = utworzKarte(db, { nazwa: 'Kinkiet', sku: 'B' });
    expect((await get('?ile=1')).json()).toEqual({
      pozycje: [{ karta_id: karta, sku: 'ŻÓŁĆ-1', stan: 0, od: OD }], nastepny: karta,
    });
    expect((await get(`?po=${karta}&ile=1`)).json()).toEqual({
      pozycje: [{ karta_id: ostatnia, sku: 'B', stan: 0, od: OD }], nastepny: ostatnia,
    });
    expect((await get(`?po=${ostatnia}`)).json()).toEqual({ pozycje: [], nastepny: null });
    expect((await get(`?sku=${encodeURIComponent(' żółć-1 ')}`)).json().pozycje.map(p => p.karta_id)).toEqual([karta]);
    expect((await get('?sku=nieznany')).json()).toEqual({ pozycje: [], nastepny: null });
    for (const q of ['?sku=A&sku=B', '?ile=0', '?ile=201', '?ile=1.5']) expect((await get(q)).statusCode).toBe(400);
  });

  it('stan GET i POST zgodny ze stanyKart także po zamówieniu; przyjęcie 5 i korekta -2 dają +3', async () => {
    powiazProdukt(db, zapiszProduktSklepowy(db, { kanal: 'sklep', produkt_id: '10', wariant_id: '', nazwa: 'Lampa', odczytane_at: OD }), karta);
    zapiszZamowienie(db, 'sklep', { zrodlo_id: '1', numer: 'TEST-1', klient: { first_name: 'Ala', email: 'ala@example.test' },
      dostawa: { city: 'Testowo' }, metoda_wysylki: 'dpd', kwota_pobrania: null, chce_fakture: 0, nip: null,
      kwota_brutto: '100.00', status_woo: null, oplacone_at: null, anulowane: 0, utworzone_at: '2026-02-01T00:00:00.000Z',
      pozycje: [{ zrodlo_id: 1000, produkt_id: 10, ilosc: 2, nazwa: 'Lampa', sku: null,
        oferta_id: null, wariant_id: null, zdjecie_url: null, cena_brutto: '50.00', vat: '23' }] }, {});
    const start = stanyKart(db).stany.get(karta).stan;
    expect(start).toBe(-2);
    expect((await get()).json().pozycje[0].stan).toBe(start);
    const a = await post({ sku: ' żółć-1 ', rodzaj: 'przyjecie', ilosc: 5 });
    expect(a.statusCode).toBe(201);
    expect(a.json()).toEqual({ karta_id: karta, sku: 'ŻÓŁĆ-1', rodzaj: 'przyjecie', ilosc: 5, powod: null, stan: start + 5 });
    const b = await post({ karta_id: karta, rodzaj: 'korekta', ilosc: -2, powod: '  Ubytek  ' });
    expect(b.statusCode).toBe(201);
    expect(b.json()).toEqual({ karta_id: karta, sku: 'ŻÓŁĆ-1', rodzaj: 'korekta', ilosc: -2, powod: 'Ubytek', stan: start + 3 });
    expect(b.json().stan).toBe(stanyKart(db).stany.get(karta).stan);
    expect((await get()).json().pozycje[0].stan).toBe(start + 3);
    expect(ruchy()[0]).toMatchObject({ konto_id: null, konto_login: 'api:Pracownia Półcień' });
  });

  it('powtórka Idempotency-Key zwraca identyczną odpowiedź i jeden ruch; po usunięciu pamięci odpowiedzi zajęty klucz ruchu daje 409', async () => {
    const a = await post(undefined, pelny, 'wspolny');
    await post(undefined, pelny, 'inny');
    const b = await post(undefined, pelny, 'wspolny');
    expect(a.statusCode).toBe(201);
    expect([b.statusCode, b.body]).toEqual([a.statusCode, a.body]);
    expect(ruchy()).toHaveLength(2);
    db.exec('DELETE FROM api_idempotencja');
    const c = await post({ karta_id: karta, rodzaj: 'korekta', ilosc: -3, powod: 'Inny ruch' }, pelny, 'wspolny');
    expect([c.statusCode, c.json().kod]).toEqual([409, 'idempotencja']);
    expect(ruchy()).toHaveLength(2);
    expect(db.prepare('SELECT COUNT(*) AS n FROM api_idempotencja').get().n).toBe(0);
    const d = await post({ karta_id: karta, rodzaj: 'korekta', ilosc: -3, powod: 'Inny ruch' }, pelny, 'wspolny');
    expect([d.statusCode, d.json().kod]).toEqual([409, 'idempotencja']);
    expect(ruchy()).toHaveLength(2);
    expect(db.prepare('SELECT COUNT(*) AS n FROM api_idempotencja').get().n).toBe(0);
  });

  it('404 dla nieznanego SKU pozwala ponowić ten sam klucz i ciało po założeniu karty', async () => {
    const payload = { sku: 'NOWA-LAMPA', rodzaj: 'przyjecie', ilosc: 3 };
    const a = await post(payload, pelny, 'nowa-karta');
    expect([a.statusCode, a.json().kod]).toEqual([404, 'brak']);
    expect(ruchy()).toHaveLength(0);
    const id = utworzKarte(db, { nazwa: 'Nowa lampa', sku: payload.sku });
    const b = await post(payload, pelny, 'nowa-karta');
    expect(b.statusCode).toBe(201);
    expect(b.json()).toMatchObject({ karta_id: id, sku: payload.sku, stan: 3 });
    expect(ruchy()).toHaveLength(1);
    expect((await post(payload, pelny, 'nowa-karta')).body).toBe(b.body);
    expect(ruchy()).toHaveLength(1);
  });

  it('dwa klucze API z tym samym Idempotency-Key zapisują dwa ruchy', async () => {
    expect((await post(undefined, pelny, 'wspolny')).json().stan).toBe(5);
    expect((await post(undefined, drugi, 'wspolny')).json().stan).toBe(10);
    expect(ruchy()).toHaveLength(2);
    const ids = db.prepare('SELECT id FROM klucze_api ORDER BY id LIMIT 2').all().map(w => w.id);
    expect(ruchy().map(w => w.klucz)).toEqual(ids.map(id => `api:${id}:wspolny`));
  });

  it('wymaga Idempotency-Key (428) i odrzuca pusty oraz za długi nagłówek (400)', async () => {
    expect((await post(undefined, pelny, null)).statusCode).toBe(428);
    for (const key of ['', 'x'.repeat(201)]) expect((await post(undefined, pelny, key)).statusCode).toBe(400);
    expect(ruchy()).toHaveLength(0);
  });

  it('odrzuca błędne ciało, rodzaj, ilość, powód i identyfikację (400), bez ruchów', async () => {
    const bazowy = { karta_id: karta, rodzaj: 'przyjecie', ilosc: 1 };
    const zle = [null, [], {}, { ...bazowy, obce: true }, { ...bazowy, rodzaj: 'otwarcie' }, { ...bazowy, rodzaj: 'wydanie' },
      ...[0, -1, 1.5, '5'].map(ilosc => ({ ...bazowy, ilosc })),
      { ...bazowy, sku: 'ŻÓŁĆ-1' }, { rodzaj: 'przyjecie', ilosc: 1 },
      ...[null, 0, -1, 1.5, '1'].map(karta_id => ({ ...bazowy, karta_id })),
      { sku: 12, rodzaj: 'przyjecie', ilosc: 1 },
      { ...bazowy, rodzaj: 'korekta', ilosc: 0, powod: 'Ubytek' },
      ...[undefined, null, '', '  ', 42, 'x'.repeat(501)].map(powod => ({ ...bazowy, rodzaj: 'korekta', ilosc: -1, powod }))];
    for (const payload of zle) expect((await post(payload)).statusCode, JSON.stringify(payload)).toBe(400);
    expect(ruchy()).toHaveLength(0);
  });

  it('nieznana karta lub SKU daje 404 brak', async () => {
    for (const ident of [{ karta_id: 99999 }, { sku: 'NIE-MA' }]) {
      const r = await post({ ...ident, rodzaj: 'przyjecie', ilosc: 1 });
      expect([r.statusCode, r.json().kod]).toEqual([404, 'brak']);
    }
    expect(ruchy()).toHaveLength(0);
  });
});
