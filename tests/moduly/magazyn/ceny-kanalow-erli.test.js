// Ceny z OMS-u w ERLI: podgląd i zapis obejmują tylko oferty zarządzane. Konto ERLI to prawdziwy klient
// z `fetchImpl` trzymającym produkty w pamięci — żadnej sieci; nieznany adres rzuca.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { modulyDla } from '../../../src/moduly/lista.ts';
import { ENV_DEMO } from '../../../scripts/demo-dane.mjs';
import { utworzKarte } from '../../../src/oms/db/magazyn.js';
import {
  ofertaPoIdZewnetrznym,
  wstawOferte,
  zapiszUstawieniaOfertKonta,
  zmienOferte,
} from '../../../src/oms/db/oferty-kanalow.ts';
import { ustawCeneReczna } from '../../../src/oms/db/ceny-kanalow.js';
import { createErliClient } from '../../../src/oms/erli/client.js';
import { podgladCen } from '../../../src/moduly/magazyn/services/ceny-kanalow-podglad.js';
import { createZapisCenKanalow } from '../../../src/moduly/magazyn/services/ceny-kanalow-zapis.js';

const START = new Date('2026-11-18T10:00:00.000Z');
const AT = START.toISOString();
const NIEZARZADZANA = 'oferta ERLI nieobjęta zarządzaniem — pominięte';
const WSTRZYMANE = 'oferty wstrzymane — pominięte';
const definicja = (klucz) => ({ klucz, typ: 'erli', etykieta: `Pracownia Półcień (${klucz})` });

let db;
beforeEach(() => {
  db = openOmsDb(':memory:', { moduly: modulyDla(ENV_DEMO) });
});
afterEach(() => db.close());

const karta = (cena_gr = 10000) => utworzKarte(db, { nazwa: 'Lampa Półcień', cena_gr });
const zrodloCeny = (id) =>
  db.prepare("SELECT zrodlo, reczne FROM karty_zrodla_pol WHERE karta_id = ? AND pole = 'cena_gr'").get(id);
const dziennik = () =>
  db
    .prepare('SELECT kanal, karta_id, cel, pole, stara, nowa, kto, wynik, blad FROM zmiany_w_kanalach ORDER BY id')
    .all();

// Oferta zarządzana powstaje z OMS-u („Obejmij zarządzaniem”), obserwowana z importu kanału.
function oferta(kartaId, idZewnetrzne, { zarzadzana = true, kanal = 'erli' } = {}) {
  const o = wstawOferte(db, {
    kartaId,
    kanal,
    idZewnetrzne,
    pochodzenie: zarzadzana ? 'oms' : 'przejeta',
    stan: 'aktywna',
  });
  // Flaga ceny z OMS-u na obserwowanej nie wystarcza — ERLI przyjmuje cenę tylko dla zarządzanej.
  if (!zarzadzana) zmienOferte(db, o.id, { cenaZOms: true });
  return o;
}

// Konto ERLI ze stanem: odczyt GET /products/:id, zapis PATCH /products/batch-update; `odrzuc` = id → komunikat.
function kontoErli(produkty, { odrzuc = {} } = {}) {
  const stan = new Map(Object.entries(produkty));
  const zapisy = [];
  const odczyty = [];
  const klient = createErliClient({
    adresApi: 'https://erli.example.invalid/svc/shop-api',
    kluczApi: 'atrapa-klucza-erli',
    czekaj: async () => {},
    fetchImpl: async (url, init) => {
      const u = new URL(url);
      expect(u.origin).toBe('https://erli.example.invalid');
      const sciezka = u.pathname.replace('/svc/shop-api', '');
      const metoda = init?.method ?? 'GET';
      if (metoda === 'PATCH' && sciezka === '/products/batch-update') {
        const lista = JSON.parse(init.body);
        zapisy.push(lista);
        return Response.json(
          lista.map((p) => {
            if (odrzuc[p.externalId]) return { externalId: p.externalId, status: 400, message: odrzuc[p.externalId] };
            stan.set(p.externalId, { ...stan.get(p.externalId), price: p.price });
            return { externalId: p.externalId, status: 202 };
          }),
        );
      }
      const id = /^\/products\/([^/]+)$/.exec(sciezka)?.[1];
      if (metoda === 'GET' && id) {
        const klucz = decodeURIComponent(id);
        odczyty.push(klucz);
        const p = stan.get(klucz);
        if (!p) return Response.json({ message: 'brak' }, { status: 404 });
        return Response.json({ externalId: klucz, status: 'active', stock: 3, name: `Lampa ${klucz}`, ...p });
      }
      throw new Error(`Nieznany adres atrapy ERLI: ${metoda} ${u.pathname}`);
    },
  });
  return { klient, zapisy, odczyty, cena: (id) => stan.get(id).price };
}

const usluga = (klucze, klienci) =>
  createZapisCenKanalow({
    db,
    definicje: klucze.map(definicja),
    klienci,
    teraz: () => START,
    sekret: Buffer.from('sekret testowy pracowni półcień'),
    czekaj: vi.fn(async () => {}),
  });
const kluczeDoWyboru = (p) => p.wiersze.filter((w) => w.doWyboru).map((w) => w.klucz);

describe('podgląd cen — ERLI', () => {
  it('oferta zarządzana: cena docelowa z narzutem albo ręczną ceną konta, próg potwierdzenia z konta', async () => {
    zapiszUstawieniaOfertKonta(db, 'erli', { czynne: true, narzutProcent: 10, progPotwierdzeniaProcent: 30 });
    const a = karta(10000);
    const b = karta(10000);
    oferta(a, 'E-1');
    oferta(b, 'E-2');
    ustawCeneReczna(db, { kartaId: b, kanal: 'erli', cenaGr: 12345, kto: 'ola', at: AT });
    const erli = kontoErli({ 'E-1': { price: 10500 }, 'E-2': { price: 6000 } });

    const p = await podgladCen(db, [a, b], { definicje: [definicja('erli')], klienci: { erli: erli.klient } });

    expect(p.wiersze).toEqual([
      expect.objectContaining({
        kartaId: a,
        kanal: 'erli',
        etykietaKanalu: 'Pracownia Półcień (erli)',
        cel: 'oferta:E-1',
        nazwa: 'Lampa E-1',
        staraGr: 10500,
        nowaGr: 11000,
        zrodlo: 'narzut',
        narzutBp: 1000,
        uwagi: [],
        doWyboru: true,
        zaznaczony: true,
      }),
      expect.objectContaining({
        kartaId: b,
        cel: 'oferta:E-2',
        staraGr: 6000,
        nowaGr: 12345,
        zrodlo: 'reczna',
        uwagi: ['duża zmiana > 30%'],
        doWyboru: true,
        zaznaczony: false,
      }),
    ]);
    expect(erli.odczyty.toSorted()).toEqual(['E-1', 'E-2']);
  });

  it('bez ustawionego progu konto ERLI potwierdza zmianę ponad 20%', async () => {
    zapiszUstawieniaOfertKonta(db, 'erli', { czynne: true });
    oferta(karta(10000), 'E-1');
    const erli = kontoErli({ 'E-1': { price: 8000 } });
    const p = await podgladCen(db, [1], { definicje: [definicja('erli')], klienci: { erli: erli.klient } });
    expect(p.wiersze).toEqual([
      expect.objectContaining({ staraGr: 8000, nowaGr: 10000, uwagi: ['duża zmiana > 20%'], zaznaczony: false }),
    ]);
  });

  it('oferta niezarządzana jest widoczna, ale bez wyboru i bez odczytu z ERLI', async () => {
    zapiszUstawieniaOfertKonta(db, 'erli', { czynne: true });
    oferta(karta(10000), 'E-9', { zarzadzana: false });
    const erli = kontoErli({ 'E-9': { price: 9000 } });
    const p = await podgladCen(db, [1], { definicje: [definicja('erli')], klienci: { erli: erli.klient } });
    expect(p.wiersze).toEqual([]);
    expect(p.pominieteWiersze).toEqual([
      expect.objectContaining({ cel: 'oferta:E-9', staraGr: null, uwagi: [NIEZARZADZANA], doWyboru: false }),
    ]);
    expect(p.pominiete).toBe(1);
    expect(erli.odczyty).toEqual([]);
  });

  it('zarchiwizowany produkt i cena zamrożona w ERLI są pomijane', async () => {
    zapiszUstawieniaOfertKonta(db, 'erli', { czynne: true });
    oferta(karta(10000), 'E-1');
    oferta(karta(10000), 'E-2');
    oferta(karta(10000), 'E-3');
    const erli = kontoErli({
      'E-1': { price: 9000, archived: true },
      'E-2': { price: 9000, frozen: ['price'] },
      'E-3': { price: 9000, frozen: ['name'] },
    });
    const p = await podgladCen(db, [1, 2, 3], { definicje: [definicja('erli')], klienci: { erli: erli.klient } });
    expect(p.pominieteWiersze.map((w) => [w.cel, w.doWyboru, w.uwagi])).toEqual([
      ['oferta:E-1', false, ['produkt zarchiwizowany w ERLI — pominięte']],
      ['oferta:E-2', false, ['cena zablokowana w ERLI ręczną zmianą — pominięte']],
    ]);
    expect(p.wiersze.map((w) => [w.cel, w.doWyboru, w.uwagi])).toEqual([['oferta:E-3', true, []]]);
  });
});

describe('zapis cen — ERLI', () => {
  it('zatwierdzenie wysyła cenę zarządzanej oferty przez batch-update, z dziennikiem i zapadką', async () => {
    zapiszUstawieniaOfertKonta(db, 'erli', { czynne: true, narzutProcent: 10 });
    const a = karta(10000);
    oferta(a, 'E-1');
    const erli = kontoErli({ 'E-1': { price: 10500 } });
    const u = usluga(['erli'], { erli: erli.klient });

    const p = await u.podglad('ola', [a]);
    const wynik = await u.zatwierdz('ola', p.podpis, kluczeDoWyboru(p));

    expect(erli.zapisy).toEqual([[{ externalId: 'E-1', price: 11000 }]]);
    expect(erli.cena('E-1')).toBe(11000);
    expect(wynik.zapisane).toEqual([expect.objectContaining({ cel: 'oferta:E-1', nowaGr: 11000, wynik: 'ok' })]);
    expect(wynik.bledy).toEqual([]);
    expect(wynik.pominiete).toEqual([]);
    expect(dziennik()).toEqual([
      {
        kanal: 'erli',
        karta_id: a,
        cel: 'oferta:E-1',
        pole: 'cena',
        stara: '10500',
        nowa: '11000',
        kto: 'ola',
        wynik: 'ok',
        blad: null,
      },
    ]);
    expect(zrodloCeny(a)).toEqual({ zrodlo: 'oms', reczne: 1 });
    expect(ofertaPoIdZewnetrznym(db, 'erli', 'E-1').wyslanaCenaGr).toBe(11000);
  });

  it('niezarządzanej oferty nie da się zatwierdzić — nic nie idzie do ERLI', async () => {
    zapiszUstawieniaOfertKonta(db, 'erli', { czynne: true });
    oferta(karta(10000), 'E-9', { zarzadzana: false });
    const erli = kontoErli({ 'E-9': { price: 9000 } });
    const u = usluga(['erli'], { erli: erli.klient });
    const p = await u.podglad('ola', [1]);
    await expect(u.zatwierdz('ola', p.podpis, ['erli|oferta:E-9'])).rejects.toMatchObject({ kod: 'wybor' });
    expect(erli.zapisy).toEqual([]);
    expect(dziennik()).toEqual([]);
  });

  it('błąd jednej oferty w ERLI nie cofa zapisu pozostałych', async () => {
    zapiszUstawieniaOfertKonta(db, 'erli', { czynne: true, narzutProcent: 10 });
    const a = karta(10000);
    const b = karta(10000);
    oferta(a, 'E-1');
    oferta(b, 'E-2');
    const erli = kontoErli(
      { 'E-1': { price: 10500 }, 'E-2': { price: 10500 } },
      { odrzuc: { 'E-2': 'Produkt odrzucony' } },
    );
    const u = usluga(['erli'], { erli: erli.klient });

    const p = await u.podglad('ola', [a, b]);
    const wynik = await u.zatwierdz('ola', p.podpis, kluczeDoWyboru(p));

    expect(erli.cena('E-1')).toBe(11000);
    expect(erli.cena('E-2')).toBe(10500);
    expect(wynik.zapisane.map((w) => w.cel)).toEqual(['oferta:E-1']);
    expect(wynik.bledy).toEqual([expect.objectContaining({ cel: 'oferta:E-2', blad: 'Produkt odrzucony' })]);
    expect(dziennik().map((w) => [w.cel, w.wynik, w.blad])).toEqual([
      ['oferta:E-1', 'ok', null],
      ['oferta:E-2', 'blad', 'Produkt odrzucony'],
    ]);
    expect(zrodloCeny(a)).toEqual({ zrodlo: 'oms', reczne: 1 });
    expect(zrodloCeny(b)?.reczne ?? 0).toBe(0);
    expect(ofertaPoIdZewnetrznym(db, 'erli', 'E-2').wyslanaCenaGr).toBeNull();
  });

  it('wstrzymane oferty konta: podgląd bez wyboru, a wstrzymanie po podglądzie blokuje zapis', async () => {
    zapiszUstawieniaOfertKonta(db, 'erli', { czynne: false });
    oferta(karta(10000), 'E-1');
    const erli = kontoErli({ 'E-1': { price: 9000 } });
    const u = usluga(['erli'], { erli: erli.klient });

    const wstrzymane = await u.podglad('ola', [1]);
    expect(wstrzymane.wiersze).toEqual([]);
    expect(wstrzymane.pominieteWiersze).toEqual([expect.objectContaining({ uwagi: [WSTRZYMANE], doWyboru: false })]);
    expect(erli.odczyty).toEqual([]);

    zapiszUstawieniaOfertKonta(db, 'erli', { czynne: true });
    const p = await u.podglad('ola', [1]);
    zapiszUstawieniaOfertKonta(db, 'erli', { czynne: false });
    const wynik = await u.zatwierdz('ola', p.podpis, kluczeDoWyboru(p));

    expect(wynik.pominiete).toEqual([expect.objectContaining({ cel: 'oferta:E-1', powod: WSTRZYMANE })]);
    expect(erli.zapisy).toEqual([]);
    expect(dziennik()).toEqual([]);
  });
});
