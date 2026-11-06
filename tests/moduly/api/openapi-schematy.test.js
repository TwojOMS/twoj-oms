import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { buildOmsServer } from '../../pomoc/serwer-parytetu.ts';
import { zalozKonto } from '../../../src/core/bezpieczenstwo/konta.js';
import { zalozKluczApi } from '../../../src/core/bezpieczenstwo/klucze-api.js';
import { ZAKRESY_API } from '../../../src/domena/klucze-api.js';
import { utworzKarte, powiazProdukt, zapiszProduktSklepowy } from '../../../src/oms/db/magazyn.js';
import { zapiszZamowienie } from '../../../src/oms/db/zamowienia.js';
import { przelaczStany } from '../../../src/oms/db/stany-magazynowe.js';
import { createProforma } from '../../../src/moduly/faktury/services/proforma.js';

const opis = JSON.parse(readFileSync(new URL('../../../docs/api/openapi.json', import.meta.url), 'utf8'));
const metody = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'trace']);
const rozwiaz = ref => ref.split('/').slice(1).reduce((v, k) => v[k], opis);
const odpowiedzi = Object.entries(opis.paths).flatMap(([url, sciezka]) =>
  Object.entries(sciezka).filter(([metoda]) => metody.has(metoda)).flatMap(([metoda, operacja]) =>
    Object.entries(operacja.responses).filter(([status]) => /^2\d\d$/.test(status)).flatMap(([status, odpowiedz]) => {
      const tresc = odpowiedz.$ref ? rozwiaz(odpowiedz.$ref) : odpowiedz;
      // PDF proformy nie jest JSON-em i nie podlega walidacji schematu ciała JSON.
      if (!tresc.content?.['application/json']) return [];
      return [{ klucz: `${metoda.toUpperCase()} ${url} ${status}`, schema: tresc.content['application/json'].schema }];
    })));
const ajv = new Ajv2020({ allErrors: true });
addFormats(ajv);
// OpenAPI dopuszcza adnotację example; nie zmienia ona walidacji wartości.
ajv.addKeyword('example');
// Kontener JSON Schema zachowuje lokalne odnośniki OpenAPI bez traktowania paths jako słów kluczowych.
const odwolania = schema => JSON.parse(JSON.stringify(schema).replaceAll('#/components/schemas/', 'urn:oms:odpowiedzi#/$defs/'));
ajv.addSchema({ $id: 'urn:oms:odpowiedzi', $defs: odwolania(opis.components.schemas) });
const walidator = schema => ajv.compile(odwolania(schema));

let db, app, headers, karta, zamowienie, zamowienieZFaktura, katalog;
const OD = '2026-01-01T00:00:00.000Z';
beforeAll(async () => {
  db = openOmsDb(':memory:');
  katalog = mkdtempSync(join(tmpdir(), 'openapi-schematy-'));
  const proforma = createProforma({ db, config: {
    nadawca: { nazwa: 'Pracownia Półcień', ulica: 'Przykładowa 1', kod: '00-001', miasto: 'Testowo', kraj: 'PL' },
    proforma: { katalog, nip: '1234563218', rachunek: '34109010140000000000000000', bank: 'Bank testowy' },
  }, teraz: () => new Date('2026-11-06T10:00:00.000Z'), budujPdf: () => Buffer.from('%PDF-1.3 atrapa lokalna') });
  app = buildOmsServer({ db, proforma, syncSklep: { odeslijStatus: vi.fn(async () => {}) },
    config: { auth: { user: 'operator', pass: 'fixture' } },
    magazyn: { start: vi.fn(), stan: () => ({ trwa: false, kanaly: [] }) } });
  await app.ready();
  const kontoId = zalozKonto(db, { login: 'tester-api', imie: 'Tester', haslo: 'h', admin: true, rola: 'administrator' });
  headers = { authorization: `Bearer ${zalozKluczApi(db, {
    nazwa: 'Pracownia Półcień', zakresy: [...ZAKRESY_API], kontoId, teraz: new Date().toISOString(),
  }).klucz}` };
  karta = utworzKarte(db, { nazwa: 'Lampa Półcień', sku: 'PC-1', cena_gr: 12345,
    opis: 'Opis lampy', ean: '5901234123457', stawka_vat: '23', kategoria_glowna: 'Lampy',
    szerokosc_mm: 100, wysokosc_mm: 200, glebokosc_mm: 30, waga_g: 50 });
  powiazProdukt(db, zapiszProduktSklepowy(db, { kanal: 'sklep-testowy', produkt_id: '10', wariant_id: '',
    nazwa: 'Lampa Półcień', cena_gr: 12345, zdjecia: ['https://example.test/lampa.jpg'], odczytane_at: OD }), karta);
  zamowienie = zapiszZamowienie(db, 'sklep-testowy', {
    zrodlo_id: '701', numer: '701', kwota_brutto: '123.45', kwota_pobrania: null,
    utworzone_at: '2026-11-01T10:00:00.000Z', metoda_wysylki: 'dpd',
    klient: { first_name: 'Ala', last_name: 'Testowa', email: 'ala@example.test' },
    dostawa: { first_name: 'Ala', last_name: 'Testowa', address_1: 'Przykładowa 7', postcode: '00-001', city: 'Testowo' },
    chce_fakture: 0, nip: null, status_woo: 'processing', oplacone_at: null, anulowane: 0,
    pozycje: [{ zrodlo_id: 1, produkt_id: 10, ilosc: 1, nazwa: 'Lampa Półcień', sku: 'PC-1',
      oferta_id: null, wariant_id: null, zdjecie_url: null, cena_brutto: '123.45', vat: '23' }],
  }, {});
  db.prepare('UPDATE zamowienia SET karta_id = ? WHERE id = ?').run('karta-odczyt', zamowienie);
  // Drugie zamówienie z fakturą: schemat DaneFakturyDostawy musi dostać prawdziwy obiekt, nie tylko null.
  zamowienieZFaktura = zapiszZamowienie(db, 'sklep-testowy', {
    zrodlo_id: '702', numer: '702', kwota_brutto: '123.45', kwota_pobrania: null,
    utworzone_at: '2026-11-01T11:00:00.000Z', metoda_wysylki: 'dpd',
    klient: { first_name: 'Ala', last_name: 'Testowa', company: 'Pracownia Półcień', email: 'ala@example.test',
      address_1: 'Przykładowa 7', postcode: '00-001', city: 'Testowo' },
    dostawa: { first_name: 'Ala', last_name: 'Testowa', address_1: 'Przykładowa 7', postcode: '00-001', city: 'Testowo' },
    chce_fakture: 1, nip: '1234563218', status_woo: 'processing', oplacone_at: null, anulowane: 0,
    pozycje: [{ zrodlo_id: 2, produkt_id: 10, ilosc: 1, nazwa: 'Lampa Półcień', sku: 'PC-1',
      oferta_id: null, wariant_id: null, zdjecie_url: null, cena_brutto: '123.45', vat: '23' }],
  }, {});
  przelaczStany(db, { wlacz: true, at: OD });
});
afterAll(async () => { await app?.close(); db?.close(); if (katalog) rmSync(katalog, { recursive: true, force: true }); });

describe('Schematy rzeczywistych odpowiedzi API v1', () => {
  it('wszystkie obiekty odpowiedzi mają pełne required i additionalProperties: false', () => {
    const odwiedzone = new Set();
    function sprawdz(schema) {
      expect(schema).toBeDefined();
      if (schema.$ref) {
        if (odwiedzone.has(schema.$ref)) return;
        odwiedzone.add(schema.$ref);
        return sprawdz(rozwiaz(schema.$ref));
      }
      if (schema.type === 'object') {
        expect(schema.additionalProperties, JSON.stringify(schema)).toBe(false);
        expect([...(schema.required ?? [])].sort()).toEqual(Object.keys(schema.properties).sort());
        Object.values(schema.properties).forEach(sprawdz);
      }
      if (schema.items) sprawdz(schema.items);
      for (const slowo of ['allOf', 'anyOf', 'oneOf']) schema[slowo]?.forEach(sprawdz);
    }
    odpowiedzi.forEach(({ schema }) => sprawdz(schema));
  });

  it('wywołuje każdą opisaną odpowiedź 2xx JSON i waliduje jej ciało', async () => {
    const pokryte = new Set();
    async function wolaj(metoda, sciezka, status, { url = sciezka, payload, naglowki } = {}) {
      const klucz = `${metoda} /api/v1${sciezka} ${status}`;
      const opisOdpowiedzi = odpowiedzi.find(o => o.klucz === klucz);
      expect(opisOdpowiedzi, klucz).toBeDefined();
      const r = await app.inject({ method: metoda, url: `/api/v1${url}`, headers: { ...headers, ...naglowki }, payload });
      expect(r.statusCode, `${klucz}: ${r.body}`).toBe(status);
      expect(r.headers['content-type']).toMatch(/^application\/json/);
      const waliduj = walidator(opisOdpowiedzi.schema);
      expect(waliduj(r.json()), `${klucz}: ${JSON.stringify(waliduj.errors)}`).toBe(true);
      pokryte.add(klucz);
      return r;
    }
    await wolaj('GET', '/ja', 200);
    await wolaj('GET', '/produkty', 200, { url: '/produkty?ile=1' });
    const produkt = await wolaj('GET', '/produkty/{id}', 200, { url: `/produkty/${karta}` });
    await wolaj('POST', '/produkty', 201, { payload: { nazwa: 'Nowa lampa', sku: 'PC-2' } });
    await wolaj('PATCH', '/produkty/{id}', 200, { url: `/produkty/${karta}`, payload: { opis: 'Opis testowy' },
      naglowki: { 'if-match': produkt.headers.etag } });
    await wolaj('GET', '/zamowienia', 200, { url: '/zamowienia?ile=1' });
    await wolaj('GET', '/zamowienia/{id}', 200, { url: `/zamowienia/${zamowienie}` });
    await wolaj('GET', '/zamowienia/z-karty/{kartaId}', 200, { url: '/zamowienia/z-karty/karta-odczyt' });
    await wolaj('GET', '/zamowienia/po-numerze/{numer}', 200, { url: '/zamowienia/po-numerze/701?sklep=sklep-testowy' });
    await wolaj('GET', '/zamowienia/{id}/dostawa', 200, { url: `/zamowienia/${zamowienie}/dostawa` });
    for (const r of [await wolaj('GET', '/zamowienia/{id}', 200, { url: `/zamowienia/${zamowienieZFaktura}` }),
      await wolaj('GET', '/zamowienia/{id}/dostawa', 200, { url: `/zamowienia/${zamowienieZFaktura}/dostawa` })]) {
      expect(JSON.stringify(r.json())).toContain('"nip":"1234563218"');
    }
    await wolaj('GET', '/zamowienia/{id}/stan-wysylki', 200, { url: `/zamowienia/${zamowienie}/stan-wysylki` });
    await wolaj('GET', '/sprzedaz', 200, { url: '/sprzedaz?od=2026-11-01&do=2026-11-03' });
    const nowe = await wolaj('POST', '/zamowienia/z-karty', 201, { payload: {
      kartaId: 'karta-zapis', klient: { first_name: 'Ala', email: 'ala@example.test' },
      dostawa: { first_name: 'Ala', address_1: 'Przykładowa 7', postcode: '00-001', city: 'Testowo' },
      chceFakture: false, kosztDostawyBrutto: '19.00',
      pozycje: [{ nazwa: 'Lampa', sku: 'PC-1', ilosc: 2, cena_brutto: '61.50' }],
    } });
    const id = nowe.json().id;
    await wolaj('POST', '/zamowienia/{id}/w-realizacji', 200, { url: `/zamowienia/${id}/w-realizacji`, payload: {} });
    await wolaj('POST', '/zamowienia/{id}/proforma', 201, { url: `/zamowienia/${id}/proforma`, payload: {} });
    await wolaj('GET', '/stany', 200, { url: '/stany?ile=1' });
    await wolaj('POST', '/stany/ruchy', 201, { payload: { karta_id: karta, rodzaj: 'przyjecie', ilosc: 5 },
      naglowki: { 'idempotency-key': 'schemat-ruchu' } });
    expect([...pokryte].sort(), 'Każda odpowiedź 2xx JSON wymaga rzeczywistego przykładu').toEqual(odpowiedzi.map(o => o.klucz).sort());
  });
});
