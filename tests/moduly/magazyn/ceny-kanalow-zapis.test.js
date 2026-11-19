// Zatwierdzenie podglądu cen i zapis do kanałów. Kanały to prawdziwi klienci Woo i Allegro z `fetchImpl`
// trzymającym stan sklepu w pamięci — żadnej sieci; nieznany adres rzuca.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ejs from 'ejs';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { modulyDla } from '../../../src/moduly/lista.ts';
import { ENV_DEMO } from '../../../scripts/demo-dane.mjs';
import { powiazProdukt, produktyKarty, utworzKarte, zapiszProduktSklepowy } from '../../../src/oms/db/magazyn.js';
import { wstawOferte, zapiszUstawieniaOfertKonta, zmienOferte } from '../../../src/oms/db/oferty-kanalow.ts';
import { createWooClient } from '../../../src/oms/woo/client.js';
import { createAllegroClient } from '../../../src/oms/allegro/client.js';
import { odswiezMagazyn } from '../../../src/moduly/magazyn/services/magazyn-sync.js';
import { pobierzTrescOfertAllegro } from '../../../src/moduly/magazyn/services/allegro-tresc-kart.js';
import {
  kategoriaAllegroDemo,
  ofertaAllegroPelna,
  ofertyAllegro,
  parametryKategoriiAllegroDemo,
} from '../../../scripts/demo-dane-katalog.mjs';
import { createZapisCenKanalow } from '../../../src/moduly/magazyn/services/ceny-kanalow-zapis.js';
import { ustawCeneWLustrze } from '../../../src/oms/db/ceny-kanalow.js';
import { daneSprzedazyKarty } from '../../../src/moduly/magazyn/karta-sprzedaz-kanalow.js';

const START = new Date('2026-11-18T10:00:00.000Z');
const AT = START.toISOString();
const ZMIANA = 'Ceny na karcie albo narzut zmieniły się — otwórz podgląd ponownie';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const definicja = (klucz, typ = 'woo') => ({ klucz, typ, etykieta: `Pracownia Półcień (${klucz})` });

let db;
let zegar;
const katalogi = [];
beforeEach(() => {
  db = openOmsDb(':memory:', { moduly: modulyDla(ENV_DEMO) });
  zegar = new Date(START);
});
afterEach(() => {
  db.close();
  for (const k of katalogi.splice(0)) rmSync(k, { recursive: true, force: true });
});

const karta = (cena_gr = 10000) => utworzKarte(db, { nazwa: 'Lampa Półcień', cena_gr });
const kartaZBazy = (id) => db.prepare('SELECT cena_gr FROM karty_produktow WHERE id = ?').get(id);
const cenaLustra = (id) => db.prepare('SELECT cena_gr FROM produkty_sklepowe WHERE id = ?').get(id).cena_gr;
const zrodloCeny = (id) =>
  db.prepare("SELECT zrodlo, reczne FROM karty_zrodla_pol WHERE karta_id = ? AND pole = 'cena_gr'").get(id);
const dziennik = () =>
  db
    .prepare('SELECT kanal, karta_id, cel, pole, stara, nowa, kto, at, wynik, blad FROM zmiany_w_kanalach ORDER BY id')
    .all();

function lustro(kartaId, kanal, produkt_id, pola = {}) {
  const id = zapiszProduktSklepowy(db, {
    kanal,
    produkt_id: String(produkt_id),
    nazwa: 'Lampa w lustrze',
    status_publikacji: 'publish',
    odczytane_at: AT,
    ...pola,
  });
  powiazProdukt(db, id, kartaId);
  return id;
}

// Oferta w rejestrze z ceną z OMS-u; domyślnie także powiązana z tą kartą w lustrze, jak po imporcie.
function rejestr(kartaId, idZewnetrzne, kanal = 'aukcje', { wLustrze = true, cena_gr = 9500 } = {}) {
  const oferta = wstawOferte(db, { kartaId, kanal, idZewnetrzne, pochodzenie: 'przejeta', stan: 'aktywna' });
  zmienOferte(db, oferta.id, { cenaZOms: true, odczytCenaGr: 10000 });
  return wLustrze ? lustro(kartaId, kanal, idZewnetrzne, { cena_gr }) : null;
}

const produkt = (id, pola = {}) => ({
  id,
  type: 'simple',
  status: 'publish',
  name: `Lampa ${id}`,
  permalink: `https://polcien.example.invalid/produkt/${id}`,
  regular_price: '95.00',
  sale_price: '',
  ...pola,
});

// Sklep Woo ze stanem: odczyt cen przez `include`, zapis przez `…/batch`; `odrzuc` = id → komunikat sklepu.
function sklepWoo(produkty, { warianty = {}, odrzuc = {}, cenyBatch = {} } = {}) {
  const stan = new Map();
  for (const p of produkty) stan.set(String(p.id), p);
  for (const [rodzic, lista] of Object.entries(warianty))
    for (const w of lista) stan.set(`${rodzic}/${w.id}`, { ...w, parent_id: Number(rodzic) });
  const zapisy = [];
  const klient = createWooClient({
    baseUrl: 'https://polcien.example.invalid',
    ck: 'atrapa',
    cs: 'atrapa',
    uprawnienia: 'zapis',
    fetchImpl: async (url, init) => {
      const u = new URL(url);
      expect(u.origin).toBe('https://polcien.example.invalid');
      const sciezka = u.pathname.replace('/wp-json/wc/v3', '');
      const metoda = init?.method ?? 'GET';
      if (sciezka === '/settings/general/woocommerce_calc_taxes') return Response.json({ value: 'yes' });
      if (sciezka === '/settings/tax/woocommerce_prices_include_tax') return Response.json({ value: 'yes' });
      const batch = /^\/products(?:\/(\d+)\/variations)?\/batch$/.exec(sciezka);
      if (batch && metoda === 'POST') {
        const { update, ...reszta } = JSON.parse(init.body);
        expect(reszta).toEqual({});
        zapisy.push({ sciezka, update });
        return Response.json({
          update: update.map((p) => {
            if (odrzuc[p.id]) return { id: 0, error: { code: 'odrzucone', message: odrzuc[p.id], data: { id: p.id } } };
            const klucz = batch[1] ? `${batch[1]}/${p.id}` : String(p.id);
            const obecny = stan.get(klucz);
            const price = Object.hasOwn(cenyBatch, klucz) ? cenyBatch[klucz] : obecny.sale_price || p.regular_price;
            const zapisany = { ...obecny, regular_price: p.regular_price, price };
            stan.set(klucz, zapisany);
            return zapisany;
          }),
        });
      }
      const rodzic = /^\/products\/(\d+)\/variations$/.exec(sciezka)?.[1];
      if (metoda !== 'GET' || (sciezka !== '/products' && !rodzic))
        throw new Error(`Nieznany adres atrapy Woo: ${metoda} ${u.pathname}`);
      const ids = u.searchParams.get('include').split(',');
      return Response.json(ids.map((id) => stan.get(rodzic ? `${rodzic}/${id}` : id)).filter(Boolean));
    },
  });
  return {
    klient,
    zapisy,
    cena: (klucz) => stan.get(klucz).regular_price,
    zmienCene: (klucz, cena) => stan.set(klucz, { ...stan.get(klucz), regular_price: cena }),
  };
}

// Konto Allegro ze stanem: komendy cen są idempotentne po commandId jak w API; `przetwarza` trzyma zadania
// w toku bez końca, `odrzuc` = id oferty → komunikat zadania FAIL.
function kontoAllegro(ceny, { odrzuc = {}, przetwarza = false } = {}) {
  const stan = new Map(Object.entries(ceny));
  const komendy = new Map();
  const wyslane = [];
  const klient = createAllegroClient({
    ustawienia: { api: 'https://aukcje.example.invalid', userAgent: 'Atrapa/1.0' },
    tokeny: { waznyToken: async () => 'atrapa' },
    fetchImpl: async (url, init) => {
      const u = new URL(url);
      expect(u.origin).toBe('https://aukcje.example.invalid');
      const metoda = init?.method ?? 'GET';
      const oferta = /^\/sale\/product-offers\/([^/]+)$/.exec(u.pathname)?.[1];
      if (oferta && metoda === 'GET') {
        if (!stan.has(oferta)) return Response.json({ errors: [{ message: 'brak oferty' }] }, { status: 404 });
        return Response.json({
          id: oferta,
          name: `Oferta ${oferta}`,
          publication: { status: 'ACTIVE' },
          sellingMode: { price: { amount: stan.get(oferta), currency: 'PLN' } },
        });
      }
      const [, cid, zadania] = /^\/sale\/offer-price-change-commands\/([^/]+)(\/tasks)?$/.exec(u.pathname) ?? [];
      if (cid && !zadania && metoda === 'PUT') {
        const cialo = JSON.parse(init.body);
        const ids = cialo.offerCriteria[0].offers.map((o) => o.id);
        wyslane.push({ cid, cena: cialo.modification.price.amount, oferty: ids });
        const byla = komendy.get(cid);
        if (byla && byla.tresc !== init.body)
          return Response.json(
            { errors: [{ code: 'COMMAND_ALREADY_REGISTERED_WITH_DIFFERENT_CONTENT' }] },
            { status: 409 },
          );
        if (!byla) {
          const tasks = ids.map((id) => {
            if (odrzuc[id]) return { offer: { id }, status: 'FAIL', message: odrzuc[id] };
            if (!przetwarza) stan.set(id, cialo.modification.price.amount);
            return { offer: { id }, status: przetwarza ? 'IN_PROGRESS' : 'SUCCESS', message: null };
          });
          komendy.set(cid, { tresc: init.body, tasks });
        }
        return Response.json({ id: cid }, { status: 201 });
      }
      if (cid && zadania && metoda === 'GET') return Response.json({ tasks: komendy.get(cid)?.tasks ?? [] });
      throw new Error(`Nieznany adres atrapy Allegro: ${metoda} ${u.pathname}`);
    },
  });
  return { klient, wyslane, cena: (id) => stan.get(id), zmienCene: (id, cena) => stan.set(id, cena) };
}

function usluga(definicje, klienci, opcje = {}) {
  const czekaj = vi.fn(async () => {});
  const zapis = createZapisCenKanalow({
    db,
    definicje,
    klienci,
    teraz: () => zegar,
    sekret: Buffer.from('sekret testowy pracowni półcień'),
    czekaj,
    ...opcje,
  });
  return { zapis, czekaj };
}

const klucze = (podglad) => podglad.wiersze.filter((w) => w.doWyboru).map((w) => w.klucz);
const krotko = (lista) => lista.map(({ kartaId, cel, wynik }) => ({ kartaId, cel, wynik }));

describe('T-D2 — zatwierdzenie podglądu i zapis cen w kanałach', () => {
  it('odrzuca zmieniony, nieznany, stary i cudzy podpis oraz wybór spoza podglądu — bez zapisu w kanale', async () => {
    const k = karta();
    lustro(k, 'sklep', 1);
    zapiszUstawieniaOfertKonta(db, 'sklep', { narzutProcent: 10, progPotwierdzeniaProcent: 50 });
    const sklep = sklepWoo([produkt(1)]);
    const { zapis } = usluga([definicja('sklep')], { sklep: sklep.klient });

    const p = await zapis.podglad('anna', [k]);
    expect(p.wiersze).toMatchObject([{ klucz: 'sklep|produkt:1', staraGr: 9500, nowaGr: 11000 }]);
    expect(p.podpis).toMatch(/^[0-9a-f]{32}\.\d+\.[0-9a-f]{64}$/);
    const [id, czas, mac] = p.podpis.split('.');
    const zmieniony = `${id}.${czas}.${mac.slice(0, -1)}${mac.endsWith('0') ? '1' : '0'}`;
    const odmowy = [
      ['anna', zmieniony, klucze(p), 'podpis'],
      ['anna', `${id}.${Number(czas) + 1}.${mac}`, klucze(p), 'podpis'],
      ['anna', `${'0'.repeat(32)}.${czas}.${mac}`, klucze(p), 'podpis'],
      ['anna', 'byle co', klucze(p), 'podpis'],
      ['bartek', p.podpis, klucze(p), 'podpis'],
      ['anna', p.podpis, ['sklep|produkt:2'], 'wybor'],
      ['anna', p.podpis, [], 'wybor'],
    ];
    for (const [login, podpis, wybor, kod] of odmowy)
      await expect(zapis.zatwierdz(login, podpis, wybor)).rejects.toMatchObject({ kod });

    zegar = new Date(START.getTime() + 31 * 60_000);
    await expect(zapis.zatwierdz('anna', p.podpis, klucze(p))).rejects.toMatchObject({
      kod: 'wygasl',
      message: 'Podgląd wygasł — otwórz go ponownie',
    });
    expect(sklep.zapisy).toEqual([]);
    expect(dziennik()).toEqual([]);

    zegar = new Date(START.getTime() + 29 * 60_000);
    const wynik = await zapis.zatwierdz('anna', p.podpis, klucze(p));
    expect(krotko(wynik.zapisane)).toEqual([{ kartaId: k, cel: 'produkt:1', wynik: 'ok' }]);
    expect(sklep.cena('1')).toBe('110.00');
  });

  it('cena karty albo narzut zmienione po podglądzie odrzucają całość, zanim cokolwiek wyjdzie', async () => {
    const [a, b] = [karta(), karta()];
    lustro(a, 'sklep', 1);
    lustro(b, 'sklep', 2);
    rejestr(a, '501');
    zapiszUstawieniaOfertKonta(db, 'sklep', { narzutProcent: 10, progPotwierdzeniaProcent: 50 });
    zapiszUstawieniaOfertKonta(db, 'aukcje', { czynne: true, narzutProcent: 10 });
    const sklep = sklepWoo([produkt(1), produkt(2)]);
    const aukcje = kontoAllegro({ 501: '95.00' });
    const { zapis } = usluga([definicja('sklep'), definicja('aukcje', 'allegro')], {
      sklep: sklep.klient,
      aukcje: aukcje.klient,
    });
    const p = await zapis.podglad('anna', [a, b]);
    expect(klucze(p)).toEqual(['sklep|produkt:1', 'sklep|produkt:2', 'aukcje|oferta:501']);

    db.prepare('UPDATE karty_produktow SET cena_gr = 10100 WHERE id = ?').run(b);
    await expect(zapis.zatwierdz('anna', p.podpis, klucze(p))).rejects.toMatchObject({
      kod: 'zmiana',
      message: ZMIANA,
    });
    db.prepare('UPDATE karty_produktow SET cena_gr = 10000 WHERE id = ?').run(b);
    zapiszUstawieniaOfertKonta(db, 'aukcje', { czynne: true, narzutProcent: 12 });
    await expect(zapis.zatwierdz('anna', p.podpis, ['aukcje|oferta:501'])).rejects.toThrow(ZMIANA);
    expect(sklep.zapisy).toEqual([]);
    expect(aukcje.wyslane).toEqual([]);
    expect(dziennik()).toEqual([]);

    zapiszUstawieniaOfertKonta(db, 'aukcje', { czynne: true, narzutProcent: 10 });
    const wynik = await zapis.zatwierdz('anna', p.podpis, klucze(p));
    expect(wynik.zapisane).toHaveLength(3);
  });

  it('Woo: pomija wiersz zmieniony w sklepie, zapisuje po rodzicu tylko cenę regularną, błąd jednego nie cofa reszty', async () => {
    const [prosty, zmieniony, wariant, odrzucony] = [karta(), karta(), karta(), karta()];
    lustro(prosty, 'sklep', 1);
    lustro(zmieniony, 'sklep', 2);
    const lustroWariantu = lustro(wariant, 'sklep', 3, { wariant_id: '31', cena_gr: 9500 });
    const lustroOdrzuconego = lustro(odrzucony, 'sklep', 3, { wariant_id: '32', cena_gr: 9500 });
    const lustroInnego = lustro(karta(), 'sklep', 3, { wariant_id: '33', cena_gr: 8700 });
    zapiszUstawieniaOfertKonta(db, 'sklep', { narzutProcent: 10, progPotwierdzeniaProcent: 50 });
    const sklep = sklepWoo(
      [produkt(1, { sale_price: '79.00' }), produkt(2), produkt(3, { type: 'variable', regular_price: '' })],
      { warianty: { 3: [produkt(31), produkt(32)] }, odrzuc: { 32: 'Cena poza zakresem sklepu' } },
    );
    const { zapis } = usluga([definicja('sklep')], { sklep: sklep.klient });
    const p = await zapis.podglad('anna', [prosty, zmieniony, wariant, odrzucony]);
    expect(klucze(p)).toHaveLength(4);
    sklep.zmienCene('2', '97.00');

    const wynik = await zapis.zatwierdz('anna', p.podpis, klucze(p));
    expect(krotko(wynik.zapisane)).toEqual([
      { kartaId: prosty, cel: 'produkt:1', wynik: 'ok' },
      { kartaId: wariant, cel: 'wariant:3/31', wynik: 'ok' },
    ]);
    expect(wynik.pominiete).toMatchObject([
      { kartaId: zmieniony, cel: 'produkt:2', powod: 'cena w kanale zmieniła się od podglądu' },
    ]);
    expect(wynik.bledy).toMatchObject([
      { kartaId: odrzucony, cel: 'wariant:3/32', wynik: 'blad', blad: 'Cena poza zakresem sklepu' },
    ]);
    expect(sklep.zapisy).toEqual([
      { sciezka: '/products/batch', update: [{ id: '1', regular_price: '110.00' }] },
      {
        sciezka: '/products/3/variations/batch',
        update: [
          { id: '31', regular_price: '110.00' },
          { id: '32', regular_price: '110.00' },
        ],
      },
    ]);
    expect(sklep.cena('1')).toBe('110.00');
    expect(sklep.cena('2')).toBe('97.00');
    expect(cenaLustra(lustroWariantu)).toBe(11000);
    expect(cenaLustra(lustroOdrzuconego)).toBe(9500);
    expect(cenaLustra(lustroInnego)).toBe(8700);
    const wpis = { kanal: 'sklep', pole: 'cena', stara: '9500', nowa: '11000', kto: 'anna', at: AT };
    expect(dziennik()).toEqual([
      { ...wpis, karta_id: prosty, cel: 'produkt:1', wynik: 'ok', blad: null },
      { ...wpis, karta_id: wariant, cel: 'wariant:3/31', wynik: 'ok', blad: null },
      { ...wpis, karta_id: odrzucony, cel: 'wariant:3/32', wynik: 'blad', blad: 'Cena poza zakresem sklepu' },
    ]);
    expect(zrodloCeny(prosty)).toEqual({ zrodlo: 'oms', reczne: 1 });
    expect(zrodloCeny(wariant)).toEqual({ zrodlo: 'oms', reczne: 1 });
    expect(zrodloCeny(odrzucony)).toBeUndefined();
    expect(zrodloCeny(zmieniony)).toBeUndefined();
  });

  it('Woo: po zapisie ceny regularnej okienko pokazuje odczytaną cenę promocyjną z odpowiedzi', async () => {
    const k = karta();
    const produktId = lustro(k, 'sklep', 1, { cena_gr: 9500 });
    const definicje = [definicja('sklep')];
    // Promocja startuje po ostatnim odczycie, tuż przed obsługą zapisu przez sklep.
    const sklep = sklepWoo([produkt(1)], { cenyBatch: { 1: '79.50' } });
    const { zapis } = usluga(definicje, { sklep: sklep.klient }, { blokujPromocjeWoo: true });
    const p = await zapis.podglad('anna', [k]);

    const wynik = await zapis.zatwierdz('anna', p.podpis, klucze(p));

    expect(wynik.zapisane).toMatchObject([{ wynik: 'ok' }]);
    expect(sklep.cena('1')).toBe('100.00');
    const sprzedazKanalow = daneSprzedazyKarty(db, k, produktyKarty(db, k), [], definicje, () => null);
    const html = await ejs.renderFile('src/moduly/magazyn/widoki/_karta-sprzedaz-kanalow.ejs', {
      sprzedazKanalow,
      karta: { id: k },
      mozeEdytowacOferty: true,
    });
    expect(html.match(/Odczytana: [^<]+/u)?.[0]).toBe('Odczytana: 79,50 zł');
    expect(cenaLustra(produktId)).toBe(7950);
  });

  it.each([
    ['brak price', undefined],
    ['pusta price', ''],
    ['niepoprawna price', '99 zł'],
  ])('Woo: %s w udanej odpowiedzi zachowuje poprzednią cenę lustra i zapisuje historię', async (_, price) => {
    const k = karta();
    const produktId = lustro(k, 'sklep', 1, { cena_gr: 9500 });
    const sklep = sklepWoo([produkt(1)], { cenyBatch: { 1: price } });
    const { zapis } = usluga([definicja('sklep')], { sklep: sklep.klient });
    const p = await zapis.podglad('anna', [k]);

    const wynik = await zapis.zatwierdz('anna', p.podpis, klucze(p));

    expect(wynik.zapisane).toMatchObject([{ wynik: 'ok' }]);
    expect(cenaLustra(produktId)).toBe(9500);
    expect(dziennik()).toMatchObject([{ cel: 'produkt:1', wynik: 'ok', nowa: '10000' }]);
  });

  it('Allegro: jedna komenda na cenę docelową, wynik zadań po ofercie, błąd jednej oferty nie cofa reszty', async () => {
    const [a, b, c] = [karta(), karta(), karta(20000)];
    const lustroA = rejestr(a, '501');
    const lustroB = rejestr(b, '502');
    const lustroC = rejestr(c, '503', 'aukcje', { cena_gr: 20000 });
    zapiszUstawieniaOfertKonta(db, 'aukcje', { czynne: true, narzutProcent: 10 });
    const aukcje = kontoAllegro(
      { 501: '95.00', 502: '95.00', 503: '200.00' },
      { odrzuc: { 502: 'Cena poza dozwolonym zakresem' } },
    );
    const { zapis, czekaj } = usluga([definicja('aukcje', 'allegro')], { aukcje: aukcje.klient });
    const p = await zapis.podglad('anna', [a, b, c]);
    const wynik = await zapis.zatwierdz('anna', p.podpis, klucze(p));

    expect(aukcje.wyslane).toMatchObject([
      { cena: '110.00', oferty: ['501', '502'] },
      { cena: '220.00', oferty: ['503'] },
    ]);
    expect(aukcje.wyslane.map((k) => k.cid)).toEqual([expect.stringMatching(UUID), expect.stringMatching(UUID)]);
    expect(aukcje.wyslane[0].cid).not.toBe(aukcje.wyslane[1].cid);
    expect(krotko(wynik.zapisane)).toEqual([
      { kartaId: a, cel: 'oferta:501', wynik: 'ok' },
      { kartaId: c, cel: 'oferta:503', wynik: 'ok' },
    ]);
    expect(wynik.bledy).toMatchObject([{ kartaId: b, cel: 'oferta:502', blad: 'Cena poza dozwolonym zakresem' }]);
    expect(wynik.pominiete).toEqual([]);
    expect([cenaLustra(lustroA), cenaLustra(lustroB), cenaLustra(lustroC)]).toEqual([11000, 9500, 22000]);
    expect(czekaj).toHaveBeenCalledWith(1000);
    expect(dziennik().map((w) => [w.cel, w.stara, w.nowa, w.wynik, w.blad])).toEqual([
      ['oferta:501', '9500', '11000', 'ok', null],
      ['oferta:502', '9500', '11000', 'blad', 'Cena poza dozwolonym zakresem'],
      ['oferta:503', '20000', '22000', 'ok', null],
    ]);
    expect(zrodloCeny(a)).toEqual({ zrodlo: 'oms', reczne: 1 });
    expect(zrodloCeny(b)).toBeUndefined();
  });

  it('Allegro: niezakończona po 15 s komenda to „w toku”; powtórka wysyła ten sam commandId', async () => {
    const k = karta();
    const ofertaWLustrze = rejestr(k, '501');
    zapiszUstawieniaOfertKonta(db, 'aukcje', { czynne: true, narzutProcent: 10 });
    const aukcje = kontoAllegro({ 501: '95.00' }, { przetwarza: true });
    const { zapis, czekaj } = usluga([definicja('aukcje', 'allegro')], { aukcje: aukcje.klient });
    const p = await zapis.podglad('anna', [k]);

    const wynik = await zapis.zatwierdz('anna', p.podpis, klucze(p));
    expect(wynik.zapisane).toMatchObject([
      { cel: 'oferta:501', wynik: 'w_toku', uwaga: 'Allegro jeszcze przetwarza — sprawdź za chwilę' },
    ]);
    expect(czekaj).toHaveBeenCalledTimes(15);
    expect(czekaj.mock.calls.every(([ms]) => ms === 1000)).toBe(true);
    expect(dziennik()).toMatchObject([{ cel: 'oferta:501', wynik: 'w_toku', blad: null }]);
    expect(cenaLustra(ofertaWLustrze)).toBe(9500);
    expect(zrodloCeny(k)).toEqual({ zrodlo: 'oms', reczne: 1 });

    const powtorka = await zapis.zatwierdz('anna', p.podpis, klucze(p));
    expect(powtorka.bledy).toEqual([]);
    expect(aukcje.wyslane).toHaveLength(2);
    expect(aukcje.wyslane[1]).toEqual(aukcje.wyslane[0]);

    const nowy = await zapis.podglad('anna', [k]);
    await zapis.zatwierdz('anna', nowy.podpis, klucze(nowy));
    expect(aukcje.wyslane[2].cid).not.toBe(aukcje.wyslane[0].cid);
  });

  it('Allegro: inny wybór ofert z tego samego podglądu to nowa komenda, nie odrzucona powtórka', async () => {
    const [a, b] = [karta(), karta()];
    rejestr(a, '501');
    rejestr(b, '502');
    zapiszUstawieniaOfertKonta(db, 'aukcje', { czynne: true, narzutProcent: 10 });
    const aukcje = kontoAllegro({ 501: '95.00', 502: '95.00' });
    const { zapis } = usluga([definicja('aukcje', 'allegro')], { aukcje: aukcje.klient });
    const p = await zapis.podglad('anna', [a, b]);

    await zapis.zatwierdz('anna', p.podpis, ['aukcje|oferta:501']);
    const drugi = await zapis.zatwierdz('anna', p.podpis, ['aukcje|oferta:502']);

    expect(drugi.bledy).toEqual([]);
    expect(krotko(drugi.zapisane)).toEqual([{ kartaId: b, cel: 'oferta:502', wynik: 'ok' }]);
    expect(aukcje.wyslane.map((k) => k.oferty)).toEqual([['501'], ['502']]);
    expect(aukcje.wyslane[1].cid).not.toBe(aukcje.wyslane[0].cid);
    expect(aukcje.cena('502')).toBe('110.00');
  });

  it('Allegro: ten sam wybór ofert w innej kolejności to ten sam commandId', async () => {
    const [a, b] = [karta(), karta()];
    rejestr(a, '501');
    rejestr(b, '502');
    zapiszUstawieniaOfertKonta(db, 'aukcje', { czynne: true, narzutProcent: 10 });
    const aukcje = kontoAllegro({ 501: '95.00', 502: '95.00' }, { przetwarza: true });
    const { zapis } = usluga([definicja('aukcje', 'allegro')], { aukcje: aukcje.klient });
    const p = await zapis.podglad('anna', [a, b]);

    await zapis.zatwierdz('anna', p.podpis, ['aukcje|oferta:501', 'aukcje|oferta:502']);
    await zapis.zatwierdz('anna', p.podpis, ['aukcje|oferta:502', 'aukcje|oferta:501']);

    expect(aukcje.wyslane).toHaveLength(2);
    expect(aukcje.wyslane[1]).toEqual(aukcje.wyslane[0]);
  });

  it('Allegro: oferta bez powiązania z tą kartą w lustrze jest pominięta, choć rejestr ma cenę z OMS-u', async () => {
    const [a, b, c] = [karta(), karta(), karta()];
    rejestr(a, '501');
    const odpinana = rejestr(b, '502');
    rejestr(c, '503', 'aukcje', { wLustrze: false });
    zapiszUstawieniaOfertKonta(db, 'aukcje', { czynne: true, narzutProcent: 10 });
    const aukcje = kontoAllegro({ 501: '95.00', 502: '95.00', 503: '95.00' });
    const { zapis } = usluga([definicja('aukcje', 'allegro')], { aukcje: aukcje.klient });
    const p = await zapis.podglad('anna', [a, b, c]);
    expect(klucze(p)).toEqual(['aukcje|oferta:501', 'aukcje|oferta:502', 'aukcje|oferta:503']);
    // Odpięcie zeruje tylko wysyłkę ilości; flaga ceny z OMS-u i karta w rejestrze zostają.
    powiazProdukt(db, odpinana, null);

    const wynik = await zapis.zatwierdz('anna', p.podpis, klucze(p));
    expect(krotko(wynik.zapisane)).toEqual([{ kartaId: a, cel: 'oferta:501', wynik: 'ok' }]);
    const powod = 'oferta nie jest powiązana z tą kartą — pominięta';
    expect(wynik.pominiete).toMatchObject([
      { kartaId: b, cel: 'oferta:502', powod },
      { kartaId: c, cel: 'oferta:503', powod },
    ]);
    expect(aukcje.wyslane).toMatchObject([{ cena: '110.00', oferty: ['501'] }]);
    expect(dziennik().map((w) => w.cel)).toEqual(['oferta:501']);
    expect(zrodloCeny(b)).toBeUndefined();
    expect(zrodloCeny(c)).toBeUndefined();
  });

  it('pamięta najwyżej 50 podglądów — najstarszy przestaje działać', async () => {
    const k = karta();
    const { zapis } = usluga([definicja('sklep')], { sklep: sklepWoo([]).klient });
    const pierwszy = await zapis.podglad('anna', [k]);
    for (let i = 0; i < 50; i += 1) await zapis.podglad('anna', [k]);
    await expect(zapis.zatwierdz('anna', pierwszy.podpis, ['sklep|produkt:1'])).rejects.toMatchObject({
      kod: 'podpis',
    });
  });
});

describe('T-D3 — zapadka: cena wysłana z narzutem nie wraca na kartę przy imporcie', () => {
  it('Woo: karta 100 zł z importu, sklep 110,00 po zapisie, następny odczyt sklepu zostawia 100 zł', async () => {
    const k = utworzKarte(db, { nazwa: 'Lampa Półcień' });
    lustro(k, 'polcien', 80);
    const odczytSklepu = (regular_price) =>
      odswiezMagazyn({
        db,
        sklepy: {
          polcien: {
            pobierzWszystkieProdukty: async () => [produkt(80, { regular_price })],
            pobierzWarianty: async () => [],
            ustawienieSklepu: async (id) => (id === 'woocommerce_calc_taxes' ? 'no' : 'yes'),
          },
        },
        kanalySklepow: ['polcien'],
        kanalyAllegro: [],
        teraz: () => AT,
        log: () => {},
      });
    await odczytSklepu('100.00');
    expect(kartaZBazy(k).cena_gr).toBe(10000);
    expect(zrodloCeny(k)).toEqual({ zrodlo: 'woo:polcien', reczne: 0 });

    zapiszUstawieniaOfertKonta(db, 'polcien', { narzutProcent: 10, progPotwierdzeniaProcent: 50 });
    const sklep = sklepWoo([produkt(80, { regular_price: '100.00' })]);
    const { zapis } = usluga([definicja('polcien')], { polcien: sklep.klient });
    const p = await zapis.podglad('anna', [k]);
    expect(p.wiersze).toMatchObject([{ cel: 'produkt:80', staraGr: 10000, nowaGr: 11000 }]);
    const wynik = await zapis.zatwierdz('anna', p.podpis, klucze(p));
    expect(krotko(wynik.zapisane)).toEqual([{ kartaId: k, cel: 'produkt:80', wynik: 'ok' }]);
    expect(sklep.cena('80')).toBe('110.00');

    await odczytSklepu(sklep.cena('80'));
    expect(kartaZBazy(k).cena_gr).toBe(10000);
    expect(zrodloCeny(k)).toEqual({ zrodlo: 'oms', reczne: 1 });
  });

  it('Allegro: karta 100 zł z treści oferty, oferta 110,00 po komendzie, ponowne pobranie treści zostawia 100 zł', async () => {
    const O = String(ofertyAllegro('allegro')[0].id);
    const k = utworzKarte(db, { nazwa: 'Lampa Półcień' });
    lustro(k, 'allegro', O, { status_publikacji: null });
    const katalog = mkdtempSync(join(tmpdir(), 'oms-ceny-zapis-'));
    katalogi.push(katalog);
    const trescOferty = async (amount) => {
      db.prepare('UPDATE produkty_sklepowe SET tresc_pobrana_at = NULL').run();
      const przebieg = await pobierzTrescOfertAllegro({
        db,
        allegro: {
          allegro: {
            pobierzOferte: async (id) => ({
              ...ofertaAllegroPelna('allegro', id),
              images: [],
              sellingMode: { price: { amount, currency: 'PLN' } },
            }),
            pobierzKategorie: async (id) => kategoriaAllegroDemo(id),
            pobierzParametryKategorii: async (id) => parametryKategoriiAllegroDemo(id),
          },
        },
        kanalyAllegro: ['allegro'],
        katalog,
        teraz: () => START,
        pobierzZdjecie: async () => {
          throw new Error('bez zdjęć w tym teście');
        },
      });
      expect(przebieg).toMatchObject({ pobrane: 1, bledy: [] });
    };
    await trescOferty('100.00');
    expect(kartaZBazy(k).cena_gr).toBe(10000);
    expect(zrodloCeny(k)).toEqual({ zrodlo: 'allegro:allegro', reczne: 0 });

    rejestr(k, O, 'allegro', { wLustrze: false });
    zapiszUstawieniaOfertKonta(db, 'allegro', { czynne: true, narzutProcent: 10 });
    const konto = kontoAllegro({ [O]: '100.00' });
    const { zapis } = usluga([definicja('allegro', 'allegro')], { allegro: konto.klient });
    const p = await zapis.podglad('anna', [k]);
    expect(p.wiersze).toMatchObject([{ cel: `oferta:${O}`, staraGr: 10000, nowaGr: 11000 }]);
    const wynik = await zapis.zatwierdz('anna', p.podpis, klucze(p));
    expect(krotko(wynik.zapisane)).toEqual([{ kartaId: k, cel: `oferta:${O}`, wynik: 'ok' }]);
    expect(konto.cena(O)).toBe('110.00');

    await trescOferty(konto.cena(O));
    expect(kartaZBazy(k).cena_gr).toBe(10000);
    expect(zrodloCeny(k)).toEqual({ zrodlo: 'oms', reczne: 1 });
  });
});

describe('lustro kanału po udanym zapisie ceny', () => {
  it('nowa cena trafia tylko do sklepu, który ją przyjął — drugi sklep z tym samym id produktu zostaje bez zmian', () => {
    const k = karta();
    const tenSklep = lustro(k, 'sklep', 7, { cena_gr: 9500 });
    const drugiSklep = lustro(k, 'sklep-drugi', 7, { cena_gr: 8800 });
    ustawCeneWLustrze(db, 'sklep', '7', '', 11000);
    expect(cenaLustra(tenSklep)).toBe(11000);
    expect(cenaLustra(drugiSklep)).toBe(8800);
  });
});
