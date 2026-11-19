import Fastify from 'fastify';
import { afterEach, expect, it } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { modulyDla } from '../../../src/moduly/lista.ts';
import { ENV_DEMO } from '../../../scripts/demo-dane.mjs';
import { utworzKarte, zapiszProduktSklepowy, powiazProdukt } from '../../../src/oms/db/magazyn.js';
import { zapiszCeneZakupu } from '../../../src/oms/db/ceny-zakupu.js';
import { ofertaAllegroKarty } from '../../../src/moduly/magazyn/services/tresc-oferty-allegro.js';
import { trescOferty } from '../../../src/moduly/magazyn/services/tresc-oferty.js';
import { zapiszTrescWoo } from '../../../src/moduly/magazyn/services/woo-tresc-kart.js';
import { pluginApiV1 } from '../../../src/moduly/api/plugin.js';

const AT = '2026-11-18T12:00:00.000Z';
let db, app;
afterEach(async () => {
  await app?.close();
  db?.close();
});

function bezCeny(wynik) {
  const json = JSON.stringify(wynik);
  expect(json).toBeDefined();
  for (const fragment of ['98765', '987,65', '987.65', 'cena_zakupu', 'cenaZakupu']) {
    expect(json).not.toContain(fragment);
  }
}

it('cena zakupu karty nie trafia do treści kanałów ani do API produktów', async () => {
  db = openOmsDb(':memory:', { moduly: modulyDla(ENV_DEMO) });
  const id = utworzKarte(db, { nazwa: 'Lampa Półcień', sku: 'LAMPA-1', cena_gr: 12000, stawka_vat: '23' }, { at: AT });
  zapiszCeneZakupu(db, id, { gr: 98765, od: '2026-01-01' }, { kto: null, zrodlo: 'karta', at: AT });
  db.prepare(
    "INSERT INTO zdjecia_kart (karta_id, kolejnosc, zrodlo, adres_zrodlowy, utworzono_at) VALUES (?, 0, 'woo', 'https://example.invalid/lampa.png', ?)",
  ).run(id, AT);

  const allegro = ofertaAllegroKarty(db, id, { klucz: 'allegro', srodowisko: 'produkcja' }, { teraz: AT });
  expect(allegro.karta.id).toBe(id);
  bezCeny(allegro);
  const erli = trescOferty(db, id, {
    narzutBp: 0,
    stalaIlosc: 9,
    czasWysylkiDni: 2,
    cennikDostaw: 'Lampy',
    stawkaVat: '23',
  });
  expect(erli.cialo).not.toBeNull();
  bezCeny(erli);

  const lustro = zapiszProduktSklepowy(db, {
    kanal: 'sklep',
    produkt_id: '1',
    wariant_id: '',
    nazwa: 'Lampa',
    odczytane_at: AT,
  });
  powiazProdukt(db, lustro, id);
  zapiszTrescWoo(
    db,
    { kanal: 'sklep', produkt_id: '1', tresc_woo: { pola: { cena_gr: 12000 }, zdjecia: [], kategoria: null } },
    lustro,
    AT,
  );
  bezCeny(db.prepare('SELECT * FROM karty_produktow WHERE id = ?').get(id));

  app = Fastify();
  await app.register(
    async (api) => {
      api.addHook('onRequest', async (req) => {
        req.kluczApi = { id: 1, zakresy: new Set(['produkty:odczyt']) };
      });
      await api.register(pluginApiV1, { ctx: { db, teraz: () => new Date(AT) } });
    },
    { prefix: '/api/v1' },
  );
  for (const url of ['/api/v1/produkty', `/api/v1/produkty/${id}`]) {
    const r = await app.inject({ url });
    expect(r.statusCode).toBe(200);
    const wynik = r.json();
    expect(url.endsWith('/produkty') ? wynik.pozycje[0].id : wynik.id).toBe(id);
    bezCeny(wynik);
  }
});
