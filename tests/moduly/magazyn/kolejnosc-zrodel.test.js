import { afterEach, expect, it } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { utworzKarte, zapiszProduktSklepowy, powiazProdukt } from '../../../src/oms/db/magazyn.js';
import { zapiszTrescWoo } from '../../../src/moduly/magazyn/services/woo-tresc-kart.js';
import { pobierzTrescOfertAllegro } from '../../../src/moduly/magazyn/services/allegro-tresc-kart.js';
import {
  skonfigurujZrodla,
  kolejnoscZrodel,
  zapiszKolejnoscZrodel,
} from '../../../src/moduly/magazyn/services/kolejnosc-zrodel.js';
import { zalozKonto, kontoPoLoginie, ustawUprawnienia } from '../../../src/core/bezpieczenstwo/konta.js';
import { jako, get, post } from '../../pomoc/panel-konta-testowe.js';
import { buildOmsServer } from '../../pomoc/serwer-testowy-oms.ts';

const AT = '2026-11-13T12:00:00.000Z';
const config = {
  sklepy: { sklep: {}, drugi: {} },
  kanaly: { konto: {}, drugie: {} },
  definicje: [
    { klucz: 'sklep', etykieta: 'Sklep Lampy' },
    { klucz: 'konto', etykieta: 'Konto Lampy' },
  ],
};
const bazy = [];
const aplikacje = [];
afterEach(async () => {
  for (const app of aplikacje.splice(0)) await app.close();
  for (const db of bazy.splice(0)) db.close();
});
function baza(konfiguracja = config) {
  const db = openOmsDb(':memory:');
  bazy.push(db);
  skonfigurujZrodla(db, () => konfiguracja);
  const id = utworzKarte(db, { nazwa: 'Lampa testowa' });
  const lustra = Object.fromEntries(
    ['sklep', 'konto'].map((kanal) => {
      const pid = zapiszProduktSklepowy(db, {
        kanal,
        produkt_id: '80',
        wariant_id: '',
        nazwa: 'Lampa',
        odczytane_at: AT,
      });
      powiazProdukt(db, pid, id);
      return [kanal, pid];
    }),
  );
  return { db, id, lustra };
}
const cena = (db) => db.prepare('SELECT cena_gr FROM karty_produktow').get().cena_gr;
function woo({ db, lustra }, zdjecia = [], cenaGr = 1000) {
  zapiszTrescWoo(
    db,
    {
      kanal: 'sklep',
      produkt_id: '80',
      tresc_woo: {
        pola: { cena_gr: cenaGr },
        zdjecia,
        kategoria: null,
      },
    },
    lustra.sklep,
    AT,
  );
}
async function allegro({ db }, images = []) {
  db.prepare('UPDATE produkty_sklepowe SET tresc_pobrana_at = NULL').run();
  const wynik = await pobierzTrescOfertAllegro({
    db,
    kanalyAllegro: ['konto'],
    allegro: {
      konto: {
        pobierzOferte: async () => ({
          id: '80',
          name: 'Lampa',
          sellingMode: { price: { amount: '20.00', currency: 'PLN' } },
          images,
        }),
      },
    },
    pobierzZdjecie: async () => Buffer.from('zdjecie testowe'),
    zapiszZdjecie: async () => ({ plik: 'test.jpg', sha256: 'b'.repeat(64), typ: 'image/jpeg', rozmiar: 10 }),
  });
  expect(wynik.bledy).toEqual([]);
}

it('domyślnie sklepy w kolejności konfiguracji, potem konta; brakujące połączenia dopina na końcu', () => {
  const { db } = baza();
  expect(kolejnoscZrodel(db)).toEqual(['woo:sklep', 'woo:drugi', 'allegro:konto', 'allegro:drugie']);
  zapiszKolejnoscZrodel(db, ['allegro:konto']);
  expect(kolejnoscZrodel(db)).toEqual(['allegro:konto', 'woo:sklep', 'woo:drugi', 'allegro:drugie']);
});

it('Allegro → Woo: sklep przejmuje cenę, ponowny odczyt Allegro jej nie zmienia', async () => {
  const p = baza();
  await allegro(p);
  expect(cena(p.db)).toBe(2000);
  woo(p);
  expect(cena(p.db)).toBe(1000);
  await allegro(p);
  expect(cena(p.db)).toBe(1000);
});

it('R1: wyższe Allegro przejmuje identyczną cenę i chroni ją przed późniejszym Woo', async () => {
  const p = baza();
  zapiszKolejnoscZrodel(p.db, ['allegro:konto', 'woo:sklep']);
  woo(p, [], 2000);
  await allegro(p);
  expect(p.db.prepare("SELECT zrodlo FROM karty_zrodla_pol WHERE pole = 'cena_gr'").get().zrodlo).toBe('allegro:konto');
  woo(p, [], 1500);
  expect(cena(p.db)).toBe(2000);
});

it('R2: wyższe Allegro zastępuje galerię Woo wyłącznie własnymi wierszami, także przy wspólnym SHA', async () => {
  const p = baza();
  zapiszKolejnoscZrodel(p.db, ['allegro:konto', 'woo:sklep']);
  woo(p, ['https://example.invalid/woo.jpg']);
  p.db
    .prepare(
      `INSERT INTO zdjecia_kart (karta_id, kolejnosc, zrodlo, plik, sha256, typ, rozmiar, utworzono_at)
    VALUES (?, 1, 'woo:sklep', 'stary.jpg', ?, 'image/jpeg', 10, ?)`,
    )
    .run(p.id, 'b'.repeat(64), AT);
  await allegro(p, [{ url: 'https://example.invalid/allegro.jpg' }]);
  expect(p.db.prepare('SELECT zrodlo, plik, adres_zrodlowy FROM zdjecia_kart').all()).toEqual([
    { zrodlo: 'allegro:konto', plik: 'test.jpg', adres_zrodlowy: 'https://example.invalid/allegro.jpg' },
  ]);
  expect(p.db.prepare("SELECT zrodlo FROM karty_zrodla_pol WHERE pole = 'zdjecia'").get().zrodlo).toBe('allegro:konto');
});

it('Allegro przejmuje źródło także przy identycznych SHA własnej galerii', async () => {
  const p = baza();
  zapiszKolejnoscZrodel(p.db, ['allegro:konto', 'woo:sklep']);
  await allegro(p, [{ url: 'https://example.invalid/pierwsze.jpg' }]);
  p.db.prepare("UPDATE karty_zrodla_pol SET zrodlo = 'woo:sklep' WHERE pole = 'zdjecia'").run();
  await allegro(p, [{ url: 'https://example.invalid/drugie.jpg' }]);
  expect(p.db.prepare("SELECT zrodlo FROM karty_zrodla_pol WHERE pole = 'zdjecia'").get().zrodlo).toBe('allegro:konto');
  expect(p.db.prepare('SELECT adres_zrodlowy FROM zdjecia_kart').all()).toEqual([
    { adres_zrodlowy: 'https://example.invalid/drugie.jpg' },
  ]);
});

it('R3: po odłączeniu właściciela Woo przejmuje cenę, a zapisana kolejność pomija odłączone konto', async () => {
  const konfiguracja = { ...config, kanaly: { ...config.kanaly } };
  const p = baza(konfiguracja);
  zapiszKolejnoscZrodel(p.db, ['allegro:konto', 'woo:sklep']);
  await allegro(p);
  delete konfiguracja.kanaly.konto;
  expect(kolejnoscZrodel(p.db)).toEqual(['woo:sklep', 'woo:drugi', 'allegro:drugie']);
  woo(p);
  expect(cena(p.db)).toBe(1000);
  expect(p.db.prepare("SELECT zrodlo FROM karty_zrodla_pol WHERE pole = 'cena_gr'").get().zrodlo).toBe('woo:sklep');
});

it('odwrotna zapisana kolejność: Allegro zostaje i może przejąć cenę sklepu', async () => {
  const p = baza();
  zapiszKolejnoscZrodel(p.db, ['allegro:konto', 'woo:sklep']);
  woo(p);
  await allegro(p);
  expect(cena(p.db)).toBe(2000);
  woo(p);
  expect(cena(p.db)).toBe(2000);
});

it('wyższe Woo przejmuje źródło także przy identycznej cenie, chroniąc ją przed następną zmianą Allegro', async () => {
  const p = baza();
  await allegro(p);
  p.db.prepare('UPDATE karty_produktow SET cena_gr = 1000').run();
  woo(p);
  expect(p.db.prepare("SELECT zrodlo FROM karty_zrodla_pol WHERE pole = 'cena_gr'").get().zrodlo).toBe('woo:sklep');
  await allegro(p);
  expect(cena(p.db)).toBe(1000);
});

it.each(['reczne', 'bez zrodla'])('%s: importy nie zmieniają ceny przy obu kolejnościach', async (tryb) => {
  const p = baza();
  p.db.prepare('UPDATE karty_produktow SET cena_gr = 333').run();
  if (tryb === 'reczne') p.db.prepare(`INSERT INTO karty_zrodla_pol VALUES (?, 'cena_gr', 'api', 1, ?)`).run(p.id, AT);
  for (const lista of [
    ['woo:sklep', 'allegro:konto'],
    ['allegro:konto', 'woo:sklep'],
  ]) {
    zapiszKolejnoscZrodel(p.db, lista);
    woo(p);
    await allegro(p);
    expect(cena(p.db)).toBe(333);
  }
});

it('wyższe Woo zastępuje wiersze galerii niższego źródła, zachowując plik na dysku', () => {
  const p = baza();
  p.db.prepare(`INSERT INTO karty_zrodla_pol VALUES (?, 'zdjecia', 'allegro:konto', 0, ?)`).run(p.id, AT);
  p.db
    .prepare(
      `INSERT INTO zdjecia_kart (karta_id, kolejnosc, zrodlo, plik, sha256, typ, rozmiar, utworzono_at)
    VALUES (?, 0, 'allegro:konto', 'pozostaje.jpg', ?, 'image/jpeg', 10, ?)`,
    )
    .run(p.id, 'a'.repeat(64), AT);
  p.db
    .prepare(
      `INSERT INTO zdjecia_kart (karta_id, kolejnosc, zrodlo, adres_zrodlowy, utworzono_at)
    VALUES (?, 1, 'allegro:drugie', 'https://example.invalid/stare.jpg', ?)`,
    )
    .run(p.id, AT);
  woo(p, ['https://example.invalid/nowe.jpg']);
  expect(p.db.prepare('SELECT zrodlo, plik, adres_zrodlowy FROM zdjecia_kart').all()).toEqual([
    { zrodlo: 'woo:sklep', plik: null, adres_zrodlowy: 'https://example.invalid/nowe.jpg' },
  ]);
});

function panel() {
  const db = openOmsDb(':memory:');
  const p = { db, app: buildOmsServer({ db, config: { ...config, auth: { user: 'serwis', pass: 'atrapa' } } }) };
  bazy.push(p.db);
  aplikacje.push(p.app);
  zalozKonto(p.db, { login: 'admin', imie: 'Admin', haslo: 'h', rola: 'administrator', admin: true });
  zalozKonto(p.db, { login: 'osoba', imie: 'Osoba', haslo: 'h', rola: 'sprzedaz' });
  ustawUprawnienia(p.db, kontoPoLoginie(p.db, 'osoba').id, ['magazyn']);
  return { ...p, admin: jako(p.db, 'admin'), osoba: jako(p.db, 'osoba') };
}
const URL = '/magazyn/ustawienia/zrodla';
it('ustawienia pokazują nazwy połączeń i zapisują kolejność formularzem', async () => {
  const p = panel();
  const r = await get(p.app, '/magazyn/ustawienia', p.admin);
  expect(r.statusCode, r.body).toBe(200);
  expect(r.body).toContain('Kolejność źródeł treści karty');
  expect(r.body).toContain('Sklep Lampy');
  expect(r.body).toContain('Konto Lampy');
  expect(r.body).toContain('Przy pustym polu karty wygrywa źródło wyżej. Pola poprawione ręcznie nie są nadpisywane.');
  const zapis = await post(p.app, URL, p.admin, { kolejnosc: ['allegro:konto', 'woo:sklep'] });
  expect(zapis.statusCode, zapis.body).toBe(303);
  expect(kolejnoscZrodel(p.db).slice(0, 2)).toEqual(['allegro:konto', 'woo:sklep']);
  const przesuniecie = await post(p.app, URL, p.admin, {
    kolejnosc: kolejnoscZrodel(p.db),
    przesun: 'wyzej:woo:sklep',
  });
  expect(przesuniecie.statusCode, przesuniecie.body).toBe(303);
  expect(kolejnoscZrodel(p.db).slice(0, 2)).toEqual(['woo:sklep', 'allegro:konto']);
  const formularz = new URLSearchParams();
  for (const klucz of kolejnoscZrodel(p.db)) formularz.append('kolejnosc', klucz);
  formularz.set('przesun', 'nizej:woo:sklep');
  const nizej = await p.app.inject({
    method: 'POST',
    url: URL,
    headers: { ...p.admin, origin: 'http://localhost', 'content-type': 'application/x-www-form-urlencoded' },
    payload: formularz.toString(),
  });
  expect(nizej.statusCode, nizej.body).toBe(303);
  expect(kolejnoscZrodel(p.db).slice(0, 2)).toEqual(['allegro:konto', 'woo:sklep']);
});

it('zapis odrzuca brak CSRF, rolę bez ustawień, nieznane i powtórzone klucze', async () => {
  const p = panel();
  await p.app.ready();
  const przed = kolejnoscZrodel(p.db);
  expect(
    (await p.app.inject({ method: 'POST', url: URL, headers: p.admin, payload: { kolejnosc: ['allegro:konto'] } }))
      .statusCode,
  ).toBe(403);
  expect((await post(p.app, URL, p.osoba, { kolejnosc: ['allegro:konto'] })).statusCode).toBe(403);
  for (const lista of [['woo:obcy'], ['woo:sklep', 'woo:sklep']]) {
    expect((await post(p.app, URL, p.admin, { kolejnosc: lista })).statusCode).toBe(400);
  }
  expect(kolejnoscZrodel(p.db)).toEqual(przed);
});
