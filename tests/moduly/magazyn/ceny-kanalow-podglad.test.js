import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setTimeout as odczekaj } from 'node:timers/promises';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { modulyDla } from '../../../src/moduly/lista.ts';
import { ENV_DEMO } from '../../../scripts/demo-dane.mjs';
import { powiazProdukt, utworzKarte, zapiszProduktSklepowy } from '../../../src/oms/db/magazyn.js';
import { wstawOferte, zapiszUstawieniaOfertKonta, zmienOferte } from '../../../src/oms/db/oferty-kanalow.ts';
import { ustawCeneReczna } from '../../../src/oms/db/ceny-kanalow.js';
import { createWooClient } from '../../../src/oms/woo/client.js';
import { createAllegroClient } from '../../../src/oms/allegro/client.js';
import { podgladCen } from '../../../src/moduly/magazyn/services/ceny-kanalow-podglad.js';

const teraz = () => new Date('2026-05-04T12:00:00Z');
const at = teraz().toISOString();
const definicja = (klucz, typ = 'woo') => ({ klucz, typ, etykieta: `Pracownia Półcień (${klucz})` });
let db;
beforeEach(() => {
  db = openOmsDb(':memory:', { moduly: modulyDla(ENV_DEMO) });
});
afterEach(() => db.close());

function karta(cena_gr = 10000) {
  return utworzKarte(db, { nazwa: 'Lampa Półcień', cena_gr });
}

function lustro(kartaId, kanal, produkt_id, pola = {}) {
  const id = zapiszProduktSklepowy(db, {
    kanal,
    produkt_id,
    nazwa: 'Lampa w lustrze',
    cena_gr: 10000,
    status_publikacji: 'publish',
    odczytane_at: at,
    ...pola,
  });
  powiazProdukt(db, id, kartaId);
}

function rejestr(kartaId, idZewnetrzne, { zarzadzana = false, steruje = true, kanal = 'aukcje' } = {}) {
  const oferta = wstawOferte(db, {
    kartaId,
    kanal,
    idZewnetrzne,
    pochodzenie: zarzadzana ? 'oms' : 'przejeta',
    stan: 'aktywna',
  });
  zmienOferte(db, oferta.id, { cenaZOms: steruje, odczytCenaGr: 10000 });
}

function woo({ produkty = [], warianty = {}, netto = false, tylkoOdczyt = false } = {}) {
  const odczyty = [];
  const paczki = [];
  const klient = createWooClient({
    baseUrl: 'https://polcien.example.invalid',
    ck: 'atrapa',
    cs: 'atrapa',
    uprawnienia: tylkoOdczyt ? 'odczyt' : 'zapis',
    fetchImpl: async (url, init) => {
      const u = new URL(url);
      const sciezka = u.pathname.replace('/wp-json/wc/v3', '');
      odczyty.push(sciezka);
      expect(u.origin).toBe('https://polcien.example.invalid');
      expect(init?.method ?? 'GET').toBe('GET');
      if (sciezka === '/settings/general/woocommerce_calc_taxes') return Response.json({ value: 'yes' });
      if (sciezka === '/settings/tax/woocommerce_prices_include_tax')
        return Response.json({ value: netto ? 'no' : 'yes' });
      const rodzic = /^\/products\/(\d+)\/variations$/.exec(sciezka)?.[1];
      if (sciezka !== '/products' && !rodzic) throw new Error(`Nieznany adres atrapy Woo: ${u.pathname}`);
      const ids = u.searchParams.get('include').split(',').map(Number);
      paczki.push(ids.length);
      expect(u.searchParams.get('per_page')).toBe('100');
      return Response.json((rodzic ? warianty[rodzic] : produkty).filter((p) => ids.includes(p.id)));
    },
  });
  return { klient, odczyty, paczki };
}

const produkt = (id, pola = {}) => ({
  id,
  type: 'simple',
  status: 'publish',
  name: `Lampa ${id}`,
  permalink: `https://polcien.example.invalid/produkt/${id}`,
  regular_price: '95.00',
  ...pola,
});

function allegro(oferty, opoznienie = 0) {
  const odczyty = [];
  let wToku = 0;
  let maksimum = 0;
  const klient = createAllegroClient({
    ustawienia: { api: 'https://aukcje.example.invalid', userAgent: 'Atrapa/1.0' },
    tokeny: { waznyToken: async () => 'atrapa' },
    fetchImpl: async (url, init) => {
      const u = new URL(url);
      expect(u.origin).toBe('https://aukcje.example.invalid');
      expect(init?.method ?? 'GET').toBe('GET');
      const id = /^\/sale\/product-offers\/(\d+)$/.exec(u.pathname)?.[1];
      odczyty.push(id);
      if (!oferty[id]) throw new Error(`Nieznany adres atrapy Allegro: ${u.pathname}`);
      wToku += 1;
      maksimum = Math.max(wToku, maksimum);
      try {
        if (opoznienie) await odczekaj(opoznienie);
        return Response.json({ id, name: `Oferta ${id}`, ...oferty[id] });
      } finally {
        wToku -= 1;
      }
    },
  });
  return { klient, odczyty, maksimum: () => maksimum };
}

const oferta = (status = 'ACTIVE', amount = '95.00') => ({
  publication: { status },
  sellingMode: { price: { amount, currency: 'PLN' } },
});

describe('T-D1 — usługa podglądu cen kanałów', () => {
  it('porównuje świeże ceny regularne i pokazuje powody pominięcia oraz odznaczenia', async () => {
    const ids = Array.from({ length: 9 }, () => karta());
    const [promocja, wygasla, bezZmiany, duza, szkic, zarzadzana, bezSterowania, tylkoLustro, osierocona] = ids;
    lustro(promocja, 'sklep', 1);
    lustro(wygasla, 'sklep', 2, { wariant_id: 12 });
    lustro(wygasla, 'sklep', 2);
    lustro(bezZmiany, 'sklep', 3);
    lustro(duza, 'sklep', 4);
    lustro(szkic, 'sklep', 5, { status_publikacji: 'draft' });
    lustro(promocja, 'netto', 1);
    lustro(promocja, 'odczyt', 1);
    lustro(tylkoLustro, 'aukcje', '506');
    rejestr(promocja, '501');
    rejestr(zarzadzana, '502', { zarzadzana: true });
    rejestr(bezSterowania, '503', { steruje: false });
    ustawCeneReczna(db, { kartaId: promocja, kanal: 'sklep', cenaGr: 10501, kto: 'operator', at });
    zapiszUstawieniaOfertKonta(db, 'sklep', { narzutProcent: 10, progPotwierdzeniaProcent: 50 });
    zapiszUstawieniaOfertKonta(db, 'aukcje', { czynne: true });

    const sklep = woo({
      produkty: [
        produkt(1, { price: '39.00', sale_price: '39.00', date_on_sale_from_gmt: '2026-05-04T12:00:00' }),
        produkt(2, { type: 'variable', regular_price: '' }),
        produkt(3, { regular_price: '110.00' }),
        produkt(4, { regular_price: '60.00' }),
      ],
      warianty: { 2: [produkt(12, { sale_price: '39.00', date_on_sale_to_gmt: '2026-05-04T12:00:00' })] },
    });
    const netto = woo({ produkty: [produkt(1)], netto: true });
    const odczyt = woo({ produkty: [produkt(1)], tylkoOdczyt: true });
    const aukcje = allegro({ 501: oferta('ENDED', '80.00'), 502: oferta() });
    const przed = db.prepare('SELECT total_changes() AS n').get().n;
    const wynik = await podgladCen(db, ids, {
      definicje: [definicja('sklep'), definicja('netto'), definicja('odczyt'), definicja('aukcje', 'allegro')],
      klienci: { sklep: sklep.klient, netto: netto.klient, odczyt: odczyt.klient, aukcje: aukcje.klient },
      teraz,
    });
    const wiersz = (kanal, id) => wynik.wiersze.find((w) => w.kanal === kanal && w.kartaId === id);
    const pominiety = (kanal, id) => wynik.pominieteWiersze.find((w) => w.kanal === kanal && w.kartaId === id);
    expect(wiersz('sklep', promocja)).toMatchObject({
      cel: 'produkt:1',
      nazwa: 'Lampa 1',
      adres: 'https://polcien.example.invalid/produkt/1',
      staraGr: 9500,
      nowaGr: 10501,
      roznicaBp: 1054,
      zrodlo: 'reczna',
      zaznaczony: true,
      uwagi: ['trwa promocja 39,00 zł'],
    });
    expect(wiersz('sklep', wygasla)).toMatchObject({
      cel: 'wariant:2/12',
      staraGr: 9500,
      nowaGr: 11000,
      narzutBp: 1000,
      zrodlo: 'narzut',
      uwagi: [],
    });
    expect(wiersz('sklep', duza)).toMatchObject({
      doWyboru: true,
      zaznaczony: false,
      uwagi: ['duża zmiana > 50%'],
    });
    expect(wiersz('aukcje', promocja)).toMatchObject({
      cel: 'oferta:501',
      adres: 'https://allegro.pl/oferta/501',
      staraGr: 8000,
      roznicaBp: 2500,
      doWyboru: true,
      zaznaczony: false,
      uwagi: ['oferta zakończona', 'duża zmiana > 20%'],
    });
    for (const [kanal, id, uwaga] of [
      ['netto', promocja, 'sklep liczy ceny netto — pominięte'],
      ['odczyt', promocja, 'klucz tylko do odczytu — pominięte'],
      ['aukcje', zarzadzana, 'zmieni się samo przy przebiegu pętli'],
      ['aukcje', bezSterowania, 'cena prowadzona w Allegro — włącz Steruj ceną'],
      ['aukcje', tylkoLustro, 'cena prowadzona w Allegro — włącz Steruj ceną'],
    ]) {
      expect(wiersz(kanal, id)).toBeUndefined();
      expect(pominiety(kanal, id)).toMatchObject({ doWyboru: false, zaznaczony: false, uwagi: [uwaga], powod: uwaga });
    }
    expect(wiersz('sklep', bezZmiany)).toBeUndefined();
    expect(wynik.bezZmianWiersze).toEqual([
      {
        kartaId: bezZmiany,
        kanal: 'sklep',
        etykietaKanalu: 'Pracownia Półcień (sklep)',
        cel: 'produkt:3',
        nazwa: 'Lampa 3',
        adres: 'https://polcien.example.invalid/produkt/3',
        staraGr: 11000,
      },
    ]);
    expect(wiersz('sklep', szkic)).toBeUndefined();
    expect(wynik.wiersze.some((w) => w.kartaId === osierocona)).toBe(false);
    for (const id of [szkic, osierocona])
      expect(wynik.pominieteWiersze.find((w) => w.kartaId === id)).toMatchObject({
        nazwa: 'Lampa Półcień',
        adres: `/magazyn/${id}#sprzedaz-kanalow`,
        powod: 'karta bez oferty w kanałach z wysyłką cen',
        doWyboru: false,
      });
    expect(wynik).toMatchObject({ bezZmian: 1, pominiete: 7 });
    expect(wynik.wiersze).toHaveLength(4);
    expect(wynik.pominieteWiersze).toHaveLength(7);
    expect(netto.odczyty).toHaveLength(2);
    expect(odczyt.odczyty).toEqual([]);
    expect(aukcje.odczyty).toEqual(['501', '502']);
    expect(db.prepare('SELECT total_changes() AS n').get().n).toBe(przed);
  });

  it('czyta 200 kart w dwóch paczkach produktów i najwyżej czterech żądaniach na sklep', async () => {
    const produkty = Array.from({ length: 200 }, (_, i) => produkt(i + 1, { regular_price: '75.00' }));
    const a = woo({ produkty });
    const b = woo({ produkty });
    const ids = produkty.map(({ id }) => {
      const kartaId = karta();
      lustro(kartaId, 'a', id);
      lustro(kartaId, 'b', id);
      return kartaId;
    });
    const opcje = {
      definicje: [definicja('a'), definicja('b')],
      klienci: { a: a.klient, b: b.klient },
      teraz,
    };
    await expect(podgladCen(db, [...ids, karta()], opcje)).rejects.toThrow('zaznacz najwyżej 200 kart');
    expect(a.odczyty).toEqual([]);
    const wynik = await podgladCen(db, ids, opcje);
    expect(wynik.wiersze).toHaveLength(400);
    expect(wynik.wiersze.every((w) => w.zaznaczony)).toBe(true);
    for (const kanal of [a, b]) {
      expect(kanal.odczyty.length).toBeLessThanOrEqual(4);
      expect(kanal.paczki).toEqual([100, 100]);
    }
  });

  it('pomija brak ceny karty i szkic rodzica oraz pokazuje trwającą promocję do zera', async () => {
    const bezCeny = karta(null);
    const szkicRodzica = karta();
    const gratis = karta();
    const brakOdczytu = karta();
    lustro(bezCeny, 'sklep', 1);
    lustro(szkicRodzica, 'sklep', 2, { wariant_id: 22 });
    lustro(gratis, 'sklep', 3);
    lustro(brakOdczytu, 'sklep', 4);
    const sklep = woo({
      produkty: [
        produkt(1),
        produkt(2, { type: 'variable', status: 'draft' }),
        produkt(3, { sale_price: '0.00', date_on_sale_to: '2026-05-04T13:00:00Z' }),
      ],
    });
    const wynik = await podgladCen(db, [bezCeny, szkicRodzica, gratis, brakOdczytu], {
      definicje: [definicja('sklep')],
      klienci: { sklep: sklep.klient },
      teraz,
    });
    expect(wynik.bezZmian).toBe(0);
    expect(wynik.pominiete).toBe(3);
    expect(wynik.wiersze).toMatchObject([
      { kartaId: gratis, staraGr: 9500, doWyboru: true, uwagi: ['trwa promocja 0,00 zł'] },
    ]);
    expect(wynik.pominieteWiersze).toMatchObject([
      { kartaId: bezCeny, nowaGr: null, doWyboru: false, uwagi: ['karta bez ceny'] },
      {
        kartaId: brakOdczytu,
        staraGr: null,
        doWyboru: false,
        uwagi: ['nie udało się odczytać ceny w kanale — pominięte'],
      },
      { kartaId: szkicRodzica, powod: 'karta bez oferty w kanałach z wysyłką cen' },
    ]);
    expect(sklep.odczyty).not.toContain('/products/2/variations');
  });

  it('nazywa wiersz wariantu Woo pełną nazwą produktu, a nie samym opisem atrybutów', async () => {
    const wariantowa = karta();
    lustro(wariantowa, 'sklep', 7, { wariant_id: 71, nazwa: 'Szablon Lampa' });
    const sklep = woo({
      produkty: [produkt(7, { type: 'variable', name: 'Szablon Lampa', regular_price: '' })],
      warianty: { 7: [produkt(71, { name: '70 x 100 cm' })] },
    });
    const wynik = await podgladCen(db, [wariantowa], {
      definicje: [definicja('sklep')],
      klienci: { sklep: sklep.klient },
      teraz,
    });
    expect(wynik.wiersze).toMatchObject([
      { kartaId: wariantowa, cel: 'wariant:7/71', nazwa: 'Szablon Lampa — 70 x 100 cm', staraGr: 9500 },
    ]);
  });

  it('pomija kartę bez ceny po błędzie odczytu ceny z kanału', async () => {
    const bezCeny = karta(null);
    lustro(bezCeny, 'aukcje', '501');
    rejestr(bezCeny, '501');
    zapiszUstawieniaOfertKonta(db, 'aukcje', { czynne: true });
    const aukcje = allegro({});

    const wynik = await podgladCen(db, [bezCeny], {
      definicje: [definicja('aukcje', 'allegro')],
      klienci: { aukcje: aukcje.klient },
      teraz,
    });

    expect(aukcje.odczyty).toEqual(['501']);
    expect(wynik).toMatchObject({
      bezZmian: 0,
      pominiete: 1,
      wiersze: [],
      pominieteWiersze: [{ kartaId: bezCeny, staraGr: null, nowaGr: null, doWyboru: false, uwagi: ['karta bez ceny'] }],
    });
  });

  it('porównuje koniec promocji Woo podany w GMT z bieżącą chwilą w UTC', async () => {
    const trwa = karta();
    const wygasla = karta();
    lustro(trwa, 'sklep', 1);
    lustro(wygasla, 'sklep', 2);
    const sklep = woo({
      produkty: [
        produkt(1, { sale_price: '39.00', date_on_sale_to_gmt: '2026-01-15T13:00:00' }),
        produkt(2, { sale_price: '39.00', date_on_sale_to_gmt: '2026-01-15T11:00:00' }),
      ],
    });

    const wynik = await podgladCen(db, [trwa, wygasla], {
      definicje: [definicja('sklep')],
      klienci: { sklep: sklep.klient },
      // Zimą w Warszawie 13:00 lokalnie to dokładnie 12:00 UTC, kiedy uwaga już znika.
      teraz: new Date('2026-01-15T12:00:00Z'),
    });

    expect(wynik.wiersze).toMatchObject([
      { kartaId: trwa, uwagi: ['trwa promocja 39,00 zł'] },
      { kartaId: wygasla, uwagi: [] },
    ]);
  });

  it('pokazuje pominięte produkty i warianty Woo z aktualnym statusem innym niż publikacja', async () => {
    const prywatny = karta();
    const oczekujacyRodzic = karta();
    const oczekujacyWariant = karta();
    lustro(prywatny, 'sklep', 1);
    lustro(oczekujacyRodzic, 'sklep', 2, { wariant_id: 22 });
    lustro(oczekujacyWariant, 'sklep', 3, { wariant_id: 33 });
    const sklep = woo({
      produkty: [
        produkt(1, { status: 'private' }),
        produkt(2, { type: 'variable', status: 'pending' }),
        produkt(3, { type: 'variable' }),
      ],
      warianty: { 3: [produkt(33, { status: 'pending' })] },
    });

    const wynik = await podgladCen(db, [prywatny, oczekujacyRodzic, oczekujacyWariant], {
      definicje: [definicja('sklep')],
      klienci: { sklep: sklep.klient },
      teraz,
    });

    expect(wynik).toMatchObject({ pominiete: 3, bezZmian: 0, wiersze: [] });
    expect(wynik.pominieteWiersze).toMatchObject(
      [
        { kartaId: prywatny, cel: 'produkt:1', status: 'private' },
        { kartaId: oczekujacyRodzic, cel: 'wariant:2/22', status: 'pending' },
        { kartaId: oczekujacyWariant, cel: 'wariant:3/33', status: 'pending' },
      ].map(({ status, ...wiersz }) => ({
        ...wiersz,
        doWyboru: false,
        zaznaczony: false,
        uwagi: [`status w sklepie: ${status} — pominięte`],
      })),
    );
    expect(sklep.odczyty).not.toContain('/products/2/variations');
  });

  it('ogranicza Allegro do czterech odczytów naraz i respektuje wstrzymanie konta', async () => {
    const ids = Array.from({ length: 200 }, (_, i) => {
      const id = karta();
      rejestr(id, String(600 + i));
      return id;
    });
    rejestr(ids[0], '800', { kanal: 'wstrzymane' });
    zapiszUstawieniaOfertKonta(db, 'aukcje', { czynne: true, progPotwierdzeniaProcent: 10 });
    const aukcje = allegro(Object.fromEntries(ids.map((_, i) => [600 + i, oferta('ACTIVE', '85.00')])), 200);
    const wstrzymane = allegro({});
    const start = performance.now();
    const wynik = await podgladCen(db, ids, {
      definicje: [definicja('aukcje', 'allegro'), definicja('wstrzymane', 'allegro')],
      klienci: { aukcje: aukcje.klient, wstrzymane: wstrzymane.klient },
      teraz,
    });
    console.info(
      `Podgląd Allegro: ${ids.length} odczytów z opóźnieniem 200 ms, ${Math.round(performance.now() - start)} ms`,
    );
    expect(aukcje.maksimum()).toBe(4);
    expect(aukcje.odczyty).toHaveLength(ids.length);
    expect(wstrzymane.odczyty).toEqual([]);
    expect(wynik.wiersze.filter((w) => w.doWyboru)).toHaveLength(ids.length);
    expect(wynik.wiersze.every((w) => !w.zaznaczony)).toBe(true);
    expect(wynik).toMatchObject({ bezZmian: 0, pominiete: 1 });
  }, 30_000);
});
