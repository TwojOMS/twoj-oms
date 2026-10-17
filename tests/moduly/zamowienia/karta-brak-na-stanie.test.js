// PRZ-091: pasek „Brak na stanie” na karcie zamówienia (stany magazynowe włączone, karta produktu < 0).
import { describe, it, expect, beforeEach } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { zapiszZamowienie } from '../../../src/oms/db/zamowienia.js';
import { zapiszProduktSklepowy, utworzKarte, powiazProdukt } from '../../../src/oms/db/magazyn.js';
import { przelaczStany, dodajRuch } from '../../../src/oms/db/stany-magazynowe.js';
import { brakiNaStanieZamowienia } from '../../../src/oms/db/stany-zamowienia.js';
import { buildOmsServer } from '../../pomoc/serwer-parytetu.ts';

const config = { auth: { user: 'adam', pass: 'x' } };
const naglowek = { authorization: 'Basic ' + Buffer.from('adam:x').toString('base64'), origin: 'http://localhost' };
const poller = { stan: () => ({ ostatni_przebieg_at: null, ostatni_blad: null }) };

const WLACZONE_AT = '2026-10-17T08:00:00.000Z';
const PO = '2026-10-17T09:00:00';
const PRZED = '2026-10-16T09:00:00';

let db, app, lampa, kinkiet, numer;
beforeEach(async () => {
  db = openOmsDb(':memory:');
  numer = 0;
  lampa = utworzKarte(db, { nazwa: 'Lampa stołowa Grzybek', sku: 'LMP-GRZ-30' });
  kinkiet = utworzKarte(db, { nazwa: 'Kinkiet Ramię', sku: 'LMP-KIN-01' });
  for (const [produkt, karta] of [['10', lampa], ['20', kinkiet]]) {
    powiazProdukt(db, zapiszProduktSklepowy(db, { kanal: 'pro', produkt_id: produkt, wariant_id: '', nazwa: 'x', odczytane_at: WLACZONE_AT }), karta);
  }
  app = buildOmsServer({ db, config, poller });
  await app.ready();
});

const zamowienie = (pozycje, { at = PO, anulowane = 0 } = {}) => {
  numer += 1;
  return zapiszZamowienie(db, 'pro', {
    zrodlo_id: 5000 + numer, numer: String(5000 + numer), klient: { first_name: 'Anna' }, dostawa: { city: 'Pęki' },
    metoda_wysylki: 'dpd', kwota_pobrania: null, chce_fakture: 0, nip: null, kwota_brutto: '100.00', status_woo: 'processing',
    oplacone_at: null, anulowane, utworzone_at: at,
    pozycje: pozycje.map((p, i) => ({ nazwa: 'poz', sku: null, cena_brutto: '50.00', vat: '23', zdjecie_url: null,
      zrodlo_id: 100 * numer + i, produkt_id: null, oferta_id: null, wariant_id: null, ...p })),
  }, {});
};
const wlacz = () => przelaczStany(db, { wlacz: true, konto: { id: null, login: 'adam' }, at: WLACZONE_AT });
const przyjmij = (karta, ilosc) => dodajRuch(db, { kartaId: karta, rodzaj: 'przyjecie', ilosc, klucz: `przyjecie-${karta}-${ilosc}-xx`, at: WLACZONE_AT });
const karta = (id) => app.inject({ method: 'GET', url: `/zamowienia/${id}`, headers: naglowek });
const pasek = (html) => /<div class="pasek-uwaga" id="brak-na-stanie">[\s\S]*?<\/div>/u.exec(html)?.[0] ?? null;

describe('PRZ-091 karta zamówienia — brak na stanie', () => {
  it('stany wyłączone: karta bez paska, mimo że zamówienie zjadłoby więcej, niż jest', async () => {
    const id = zamowienie([{ produkt_id: '10', ilosc: 5 }]);
    const r = await karta(id);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.body).not.toContain('brak-na-stanie');
    expect(r.body).not.toContain('Brak na stanie');
  });

  it('stany włączone, karta na minusie: pasek z nazwą, stanem −2 i odnośnikiem do karty produktu', async () => {
    wlacz();
    przyjmij(lampa, 3);
    przyjmij(kinkiet, 10);
    const id = zamowienie([{ produkt_id: '10', ilosc: 5 }, { produkt_id: '20', ilosc: 1 }]);
    const r = await karta(id);
    expect(r.statusCode, r.body).toBe(200);
    const p = pasek(r.body);
    expect(p).not.toBeNull();
    expect(p).toContain(`<a href="/magazyn/${lampa}">Lampa stołowa Grzybek</a> (stan −2)`);
    expect(p).not.toContain('Kinkiet'); // kinkiet ma zapas — bez wpisu
    expect(p).toContain('Zamówienie jest przyjęte');
  });

  it('zamówienie, które nie trafia w kartę na minusie, nie dostaje paska (choć inne zamówienie zrobiło minus)', async () => {
    wlacz();
    przyjmij(kinkiet, 10);
    zamowienie([{ produkt_id: '10', ilosc: 1 }]); // lampa: 0 − 1 = −1
    const inne = zamowienie([{ produkt_id: '20', ilosc: 1 }]);
    expect(pasek((await karta(inne)).body)).toBeNull();
  });

  it('anulowane zamówienie — bez paska (i nie zdejmuje towaru)', async () => {
    wlacz();
    zamowienie([{ produkt_id: '10', ilosc: 2 }]); // lampa −2
    const anulowane = zamowienie([{ produkt_id: '10', ilosc: 1 }], { anulowane: 1 });
    expect(pasek((await karta(anulowane)).body)).toBeNull();
    expect(brakiNaStanieZamowienia(db, anulowane)).toEqual([]);
  });

  it('zamówienie sprzed włączenia nie zdejmuje towaru, więc nie dostaje paska', async () => {
    wlacz();
    zamowienie([{ produkt_id: '10', ilosc: 2 }]); // lampa −2 z zamówienia po włączeniu
    const stare = zamowienie([{ produkt_id: '10', ilosc: 1 }], { at: PRZED });
    expect(pasek((await karta(stare)).body)).toBeNull();
  });

  it('brakiNaStanieZamowienia: dwie pozycje tej samej karty sumują się w jeden wpis', () => {
    wlacz();
    przyjmij(lampa, 1);
    const id = zamowienie([{ produkt_id: '10', ilosc: 1 }, { produkt_id: '10', ilosc: 2 }]);
    expect(brakiNaStanieZamowienia(db, id)).toEqual([{ karta_id: lampa, nazwa: 'Lampa stołowa Grzybek', stan: -2, ilosc: 3 }]);
  });
});
