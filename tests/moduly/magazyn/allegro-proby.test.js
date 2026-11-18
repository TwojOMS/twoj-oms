// Ponowne próby zdjęć z trwałym wpisem błędu przy ofercie (`tresc_blad`) i jedna oferta na kartę
// i konto Allegro. Dane: lampy Pracowni Półcień z atrapy; klient Allegro i pobieranie zdjęć wstrzyknięte — żadnej sieci.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { utworzKarte, zapiszProduktSklepowy, powiazProdukt } from '../../../src/oms/db/magazyn.js';
import { pobierzTrescOfertAllegro } from '../../../src/moduly/magazyn/services/allegro-tresc-kart.js';
import { pobierzZdjecie } from '../../../src/moduly/magazyn/services/zdjecia-pliki.js';
import {
  ofertyAllegro,
  ofertaAllegroPelna,
  kategoriaAllegroDemo,
  parametryKategoriiAllegroDemo,
} from '../../../scripts/demo-dane-katalog.mjs';

const KANAL = 'allegro';
const DRUGIE = 'allegro_drugie';
const AT = '2026-11-13T08:00:00.000Z';
const PO = '2026-11-13T09:00:00.000Z';
const WZOR = ofertaAllegroPelna(KANAL, ofertyAllegro(KANAL)[0].id);

const bazy = [];
const katalogi = [];
afterEach(() => {
  for (const db of bazy.splice(0)) db.close();
  for (const k of katalogi.splice(0)) rmSync(k, { recursive: true, force: true });
});

function png(szerokosc) {
  const b = Buffer.alloc(33);
  Buffer.from('89504e470d0a1a0a', 'hex').copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'ascii');
  b.writeUInt32BE(szerokosc, 16);
  b.writeUInt32BE(10, 20);
  return b;
}
const numerZdjecia = (adres) => 1 + [...adres].reduce((s, c) => (s * 31 + c.charCodeAt(0)) % 997, 7);
const blad = (status, wiadomosc = `HTTP ${status}`) => Object.assign(new Error(wiadomosc), { status });
const adresyZdjec = (n, przedrostek = 'lampa') =>
  Array.from(
    { length: n },
    (_, i) => `https://polcien.example.invalid/${przedrostek}-${i + 1}.jpg?token=tajne-${i + 1}`,
  );

const nowaBaza = () => {
  const db = openOmsDb(':memory:');
  bazy.push(db);
  return db;
};
function oferta(db, { kanal = KANAL, id, karta, status = 'ACTIVE' }) {
  const pid = zapiszProduktSklepowy(db, {
    kanal,
    produkt_id: id,
    wariant_id: '',
    nazwa: `Oferta ${id}`,
    status_publikacji: status,
    odczytane_at: AT,
  });
  powiazProdukt(db, pid, karta);
  return pid;
}
const karta = (db, n = 1) => utworzKarte(db, { nazwa: `Karta lampy ${n}` }, { at: AT });

// Jedna karta z jedną ofertą; treść oferty z atrapy, zdjęcia podane w teście.
function jednaOferta(images) {
  const db = nowaBaza();
  const k = karta(db);
  const pid = oferta(db, { id: '501', karta: k });
  return { db, k, pid, klient: klient({ images }) };
}

function klient({ images = adresyZdjec(1), oferty = {} } = {}) {
  return {
    pobierzOferte: vi.fn(async (id) => (oferty[id] ? oferty[id]() : { ...WZOR, id: String(id), images })),
    pobierzKategorie: vi.fn(async (id) => kategoriaAllegroDemo(id)),
    pobierzParametryKategorii: vi.fn(async (id) => parametryKategoriiAllegroDemo(id)),
  };
}

function przebieg(db, klienci, { at = AT, pobierz, czekaj, ofertaWskazana } = {}) {
  const katalog = mkdtempSync(join(tmpdir(), 'oms-06b-'));
  katalogi.push(katalog);
  const allegro = typeof klienci.pobierzOferte === 'function' ? { [KANAL]: klienci } : klienci;
  return pobierzTrescOfertAllegro({
    db,
    allegro,
    kanalyAllegro: Object.keys(allegro),
    katalog,
    teraz: () => new Date(at),
    pobierzZdjecie: pobierz ?? vi.fn(async (adres) => png(numerZdjecia(adres))),
    czekaj: czekaj ?? vi.fn(async () => {}),
    ofertaWskazana,
  });
}

const lustro = (db, pid) => db.prepare('SELECT * FROM produkty_sklepowe WHERE id = ?').get(pid);
const galeria = (db, k) =>
  db
    .prepare('SELECT adres_zrodlowy FROM zdjecia_kart WHERE karta_id = ? ORDER BY kolejnosc')
    .all(k)
    .map((z) => z.adres_zrodlowy);
const wywolania = (k) => k.pobierzOferte.mock.calls.map((c) => c[0]);

describe('ponowne próby zdjęcia', () => {
  it('2× 503, potem OK: zdjęcie zapisane, odstępy 2 s i 10 s, bez wpisu błędu', async () => {
    const adresy = adresyZdjec(2);
    const { db, k, pid, klient: kl } = jednaOferta(adresy);
    let proby = 0;
    const pobierz = vi.fn(async (adres) => {
      if (adres === adresy[0] && ++proby <= 2) throw blad(503);
      return png(numerZdjecia(adres));
    });
    const odstepy = [];
    const wynik = await przebieg(db, kl, {
      pobierz,
      czekaj: async (ms) => {
        odstepy.push(ms);
      },
    });
    expect(wynik).toMatchObject({ razem: 1, pobrane: 1, bledy: [], blad: null });
    expect(pobierz.mock.calls.filter((c) => c[0] === adresy[0])).toHaveLength(3);
    expect(odstepy).toEqual([2000, 10000]);
    expect(galeria(db, k)).toEqual(adresy);
    expect(lustro(db, pid)).toMatchObject({ tresc_pobrana_at: AT, tresc_blad: null, tresc_blad_at: null });
  });

  it('3× 503: zdjęcie pominięte, oferta zapisana, trwały wpis błędu bez adresu i tokenu', async () => {
    const adresy = adresyZdjec(3);
    const { db, k, pid, klient: kl } = jednaOferta(adresy);
    const pobierz = vi.fn(async (adres) => {
      if (adres === adresy[1]) throw blad(503, `HTTP 503 przy ${adres}`);
      return png(numerZdjecia(adres));
    });
    const odstepy = [];
    const wynik = await przebieg(db, kl, {
      pobierz,
      czekaj: async (ms) => {
        odstepy.push(ms);
      },
    });
    expect(pobierz.mock.calls.filter((c) => c[0] === adresy[1])).toHaveLength(3);
    expect(odstepy).toEqual([2000, 10000]);
    expect(wynik).toMatchObject({ pobrane: 1, blad: null });
    expect(wynik.bledy).toEqual([expect.objectContaining({ oferta_id: '501', zdjecie: adresy[1] })]);
    expect(galeria(db, k)).toEqual([adresy[0], adresy[2]]);
    const w = lustro(db, pid);
    expect(w).toMatchObject({ tresc_pobrana_at: AT, tresc_blad_at: AT });
    expect(w.tresc_blad).toMatch(/1 z 3/);
    expect(w.tresc_blad).toMatch(/503/);
    expect(w.tresc_blad).not.toMatch(/tajne|https?:|example\.invalid/);

    // Pobrana oferta nie wraca do kolejki mimo błędu.
    const drugi = klient({ images: adresy });
    expect(await przebieg(db, drugi, { at: PO })).toMatchObject({ razem: 0 });
    expect(drugi.pobierzOferte).not.toHaveBeenCalled();
  });

  it('404, zły typ pliku i błąd adresu: jedna próba, od razu wpis błędu', async () => {
    const adresy = adresyZdjec(3);
    const { db, pid, klient: kl } = jednaOferta(adresy);
    const pobierz = vi.fn(async (adres) => {
      if (adres === adresy[0]) throw blad(404);
      if (adres === adresy[1]) return Buffer.from('to nie jest obraz');
      throw new Error('Niedozwolony adres sieciowy zdjęcia.');
    });
    const czekaj = vi.fn(async () => {});
    await przebieg(db, kl, { pobierz, czekaj });
    expect(pobierz.mock.calls.map((c) => c[0])).toEqual(expect.arrayContaining(adresy));
    expect(pobierz).toHaveBeenCalledTimes(3);
    expect(czekaj).not.toHaveBeenCalled();
    expect(lustro(db, pid)).toMatchObject({ tresc_pobrana_at: AT, tresc_blad_at: AT });
    expect(lustro(db, pid).tresc_blad).toMatch(/3 z 3.*404/);
  });

  it('410 i 400 bez ponawiania; 429, zerwane połączenie i przekroczony czas ponawiane', async () => {
    const przypadki = [
      [blad(410), 1],
      [blad(400), 1],
      [blad(429), 3],
      [blad(500), 3],
      [Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }), 3],
      [Object.assign(new TypeError('fetch failed'), { cause: { code: 'ETIMEDOUT' } }), 3],
      [Object.assign(new Error('Przekroczono czas pobierania zdjęcia.'), { chwilowy: true }), 3],
    ];
    for (const [e, ile] of przypadki) {
      const { db, klient: kl } = jednaOferta(adresyZdjec(1));
      const pobierz = vi.fn(async () => {
        throw e;
      });
      await przebieg(db, kl, { pobierz });
      expect([e.status ?? e.code ?? e.cause?.code ?? e.message, pobierz.mock.calls.length]).toEqual([
        e.status ?? e.code ?? e.cause?.code ?? e.message,
        ile,
      ]);
    }
  });

  it('pobieranie z sieci oznacza błędy: status HTTP przy 503 i 404, przekroczony czas chwilowy, za duży plik nie', async () => {
    const lookup = async () => [{ address: '8.8.8.8', family: 4 }];
    const adres = 'https://polcien.example.invalid/lampa.jpg';
    await expect(
      pobierzZdjecie(adres, { lookup, fetch: async () => new Response('x', { status: 503 }) }),
    ).rejects.toMatchObject({ status: 503 });
    await expect(
      pobierzZdjecie(adres, { lookup, fetch: async () => new Response('x', { status: 404 }) }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      pobierzZdjecie(adres, { lookup, limitCzasuMs: 20, fetch: () => new Promise(() => {}) }),
    ).rejects.toMatchObject({ chwilowy: true });
    const zaDuzy = await pobierzZdjecie(adres, {
      lookup,
      limitBajtow: 10,
      fetch: async () => new Response(png(5), { status: 200, headers: { 'content-length': '33' } }),
    }).catch((e) => e);
    expect(zaDuzy).toBeInstanceOf(Error);
    expect(zaDuzy.status).toBeUndefined();
    expect(zaDuzy.chwilowy).toBeUndefined();
  });

  it('ponowny udany przebieg (oferta zmieniona) czyści wpis błędu', async () => {
    const adresy = adresyZdjec(2);
    const { db, pid, klient: kl } = jednaOferta(adresy);
    await przebieg(db, kl, {
      pobierz: vi.fn(async (adres) => {
        if (adres === adresy[0]) throw blad(502);
        return png(numerZdjecia(adres));
      }),
    });
    expect(lustro(db, pid).tresc_blad).toMatch(/502/);
    // Odczyt listy zeruje `tresc_pobrana_at`, gdy oferta się zmieniła.
    db.prepare('UPDATE produkty_sklepowe SET tresc_pobrana_at = NULL WHERE id = ?').run(pid);
    const wynik = await przebieg(db, klient({ images: adresy }), { at: PO });
    expect(wynik).toMatchObject({ pobrane: 1, bledy: [] });
    expect(lustro(db, pid)).toMatchObject({ tresc_pobrana_at: PO, tresc_blad: null, tresc_blad_at: null });
  });
});

describe('błąd całej oferty', () => {
  it('oferta w EUR i 404 oferty: wpis błędu, tresc_pobrana_at puste; 403 bez wpisu', async () => {
    const db = nowaBaza();
    const karty = [karta(db, 1), karta(db, 2), karta(db, 3)];
    const pids = ['501', '502', '503'].map((id, i) => oferta(db, { id, karta: karty[i] }));
    const kl = klient({
      oferty: {
        501: () => ({
          ...WZOR,
          id: '501',
          sellingMode: { ...WZOR.sellingMode, price: { amount: '20.00', currency: 'EUR' } },
        }),
        502: () => {
          throw blad(404, 'Allegro: HTTP 404 przy /sale/product-offers/502');
        },
        503: () => {
          throw blad(403, 'Allegro: HTTP 403 przy /sale/product-offers/503');
        },
      },
    });
    const wynik = await przebieg(db, kl);
    expect(wynik.blad).toMatch(/odmówiło dostępu/);
    expect(lustro(db, pids[0])).toMatchObject({ tresc_pobrana_at: null, tresc_blad_at: AT });
    expect(lustro(db, pids[0]).tresc_blad).toMatch(/EUR/);
    expect(lustro(db, pids[1])).toMatchObject({ tresc_pobrana_at: null, tresc_blad_at: AT });
    expect(lustro(db, pids[1]).tresc_blad).toMatch(/404/);
    expect(lustro(db, pids[2])).toMatchObject({ tresc_pobrana_at: null, tresc_blad: null, tresc_blad_at: null });

    // Następny przebieg próbuje znów; udany czyści wpis.
    const drugi = klient();
    await przebieg(db, { [KANAL]: drugi }, { at: PO });
    expect(wywolania(drugi)).toEqual(['501', '502', '503']);
    expect(lustro(db, pids[0])).toMatchObject({ tresc_pobrana_at: PO, tresc_blad: null, tresc_blad_at: null });
  });
});

describe('jedna oferta na kartę i konto', () => {
  it('dwie oferty jednego konta na karcie: treść tylko z oferty o niższym id w lustrze', async () => {
    const db = nowaBaza();
    const k = karta(db);
    // Lustro nadaje id w kolejności zapisu: 602 dostaje niższe id niż 601.
    const nizsza = oferta(db, { id: '602', karta: k });
    const wyzsza = oferta(db, { id: '601', karta: k });
    expect(nizsza).toBeLessThan(wyzsza);
    const kl = klient();
    const wynik = await przebieg(db, kl);
    expect(wywolania(kl)).toEqual(['602']);
    expect(wynik).toMatchObject({ razem: 1, pobrane: 1 });
    expect(db.prepare('SELECT oferta_id FROM karty_dane_kanalu WHERE karta_id = ?').get(k).oferta_id).toBe('602');
    expect(lustro(db, wyzsza).tresc_pobrana_at).toBeNull();
    // Kolejny przebieg nie sięga po drugą ofertę tej pary.
    const drugi = klient();
    expect(await przebieg(db, drugi, { at: PO })).toMatchObject({ razem: 0 });
    expect(drugi.pobierzOferte).not.toHaveBeenCalled();
  });

  it('nieaktywna oferta o niższym id (zniknęła albo ENDED): treść daje aktywna', async () => {
    const db = nowaBaza();
    const k1 = karta(db, 1);
    const k2 = karta(db, 2);
    const zniknieta = oferta(db, { id: '701', karta: k1 });
    oferta(db, { id: '702', karta: k1 });
    db.prepare('UPDATE produkty_sklepowe SET zniknal_at = ? WHERE id = ?').run(AT, zniknieta);
    oferta(db, { id: '801', karta: k2, status: 'ENDED' });
    oferta(db, { id: '802', karta: k2 });
    const kl = klient();
    await przebieg(db, kl);
    expect(wywolania(kl)).toEqual(['702', '802']);
  });

  it('jedyna oferta karty zakończona (ENDED): nadal daje treść', async () => {
    const db = nowaBaza();
    oferta(db, { id: '901', karta: karta(db), status: 'ENDED' });
    const kl = klient();
    await przebieg(db, kl);
    expect(wywolania(kl)).toEqual(['901']);
  });

  it('dwa różne konta na jednej karcie: obie oferty pobrane', async () => {
    const db = nowaBaza();
    const k = karta(db);
    oferta(db, { id: '501', karta: k });
    oferta(db, { kanal: DRUGIE, id: '502', karta: k });
    const a = klient();
    const b = klient();
    const wynik = await przebieg(db, { [KANAL]: a, [DRUGIE]: b });
    expect(wywolania(a)).toEqual(['501']);
    expect(wywolania(b)).toEqual(['502']);
    expect(wynik).toMatchObject({ razem: 2, pobrane: 2 });
  });

  it('wskazana ręcznie oferta (ofertaWskazana): pobrana ona, także gdy ma wyższe id i treść już pobrano', async () => {
    const db = nowaBaza();
    const k = karta(db);
    oferta(db, { id: '501', karta: k });
    const druga = oferta(db, { id: '502', karta: k });
    await przebieg(db, klient());
    db.prepare('UPDATE produkty_sklepowe SET tresc_pobrana_at = ? WHERE id = ?').run(AT, druga);
    const kl = klient();
    const wynik = await przebieg(db, kl, { at: PO, ofertaWskazana: druga });
    expect(wywolania(kl)).toEqual(['502']);
    expect(wynik).toMatchObject({ razem: 1, pobrane: 1 });
    expect(lustro(db, druga).tresc_pobrana_at).toBe(PO);
    expect(db.prepare('SELECT oferta_id FROM karty_dane_kanalu WHERE karta_id = ?').get(k).oferta_id).toBe('502');
  });
});
