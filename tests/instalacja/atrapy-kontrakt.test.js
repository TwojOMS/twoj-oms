// PRZ-076 — kontrakt atrap piaskownicy z prawdziwymi klientami (decyzja właściciela 14.10: atrapa na poziomie metod
// + test kontraktu). Rozjazd atrapy z klientem ma łamać ten test, a nie wychodzić dopiero w piaskownicy:
//   1) atrapy mają KAŻDĄ metodę prawdziwych klientów — nowa metoda w kliencie bez atrapy = czerwony test;
//   2) prawdziwy klient inFaktu karmiony przez fetchImpl surowymi encjami atrapy oddaje to samo co atrapa;
//   3) encje atrapy mają pola, które czytają widok listy i reguły domeny.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createInfaktClient } from '../../src/oms/infakt/client.js';
import { createFakturowniaClient } from '../../src/oms/fakturownia/client.js';
import { createAtrapaFakturowni, createTransportAtrapyFakturowni } from '../../deploy/proba/atrapy/fakturownia.mjs';
import { createWooClient } from '../../src/oms/woo/client.js';
import { createAllegroClient } from '../../src/oms/allegro/client.js';
import { createErliClient } from '../../src/oms/erli/client.js';
import { createAtrapaErli } from '../../deploy/proba/atrapy/erli.mjs';
import { utworzBazeDemo, ENV_DEMO } from '../../scripts/demo-dane.mjs';
import { createAtrapaInfaktu } from '../../deploy/proba/atrapy/infakt.mjs';
import { createDpdClient } from '../../src/oms/kurierzy/dpd.js';
import { createAtrapaDpd, ODMOWY_DPD, zdarzeniaAtrapyDpd, surowaOdpowiedzDpd } from '../../deploy/proba/atrapy/dpd.mjs';
import { createInpostClient } from '../../src/oms/kurierzy/inpost.js';
import {
  createAtrapaInpost, ODMOWY_INPOST, zdarzeniaAtrapyInpost, surowaOdpowiedzInpost,
} from '../../deploy/proba/atrapy/inpost.mjs';
import { openOmsDb } from '../../src/oms/db/db.ts';
import { dowodOdbioru } from '../../src/domena/dowod-odbioru.js';
import { createAtrapaWoo, createAtrapaAllegro, ODMOWY_WOO, ODMOWY_ALLEGRO } from '../../deploy/proba/atrapy/kanaly.mjs';
import { createMailer } from '../../src/core/poczta/smtp.js';
import { createGusClient, METODY_GUS } from '../../src/oms/gus/client.js';
import { createAtrapaGus } from '../../deploy/proba/atrapy/gus.mjs';
import { createKsefClient } from '../../src/oms/ksef/client.js';
import { createAtrapaKsef } from '../../deploy/proba/atrapy/ksef.mjs';
import { odmowaKsefWProbie } from '../../src/moduly/koszty/ksef-ustawien.ts';
import { modulyPiaskownicy } from '../../deploy/proba/atrapy/index.mjs';
import { pocztaZUstawien } from '../../src/moduly/wiadomosci/poczta-ustawien.ts';
import { createAtrapaPoczty, createModulWiadomosciAtrapy } from '../../deploy/proba/atrapy/poczta.mjs';
import { wykonajZlecenieResetu, zlecResetDemo } from '../../src/oms/db/reset-demo.js';

// Napis na stronie PDF (pdfkit bez kompresji: tekst jako <hex> w tablicach TJ), nie metadane dokumentu.
const tekstPdf = (b) => [...b.toString('latin1').matchAll(/\[([^\]]*)\]\s*TJ/g)]
  .map(m => [...m[1].matchAll(/<([0-9a-f]+)>/gi)].map(h => Buffer.from(h[1], 'hex').toString('latin1')).join('')).join('\n');
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');

const DZIS = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Warsaw' });
const metody = (o) => Object.keys(o).filter((k) => typeof o[k] === 'function').sort();
const ciche = () => {};

describe('PRZ-119.04 — kontrakt Fakturowni bez sieci', () => {
  const opcje = { env: { OMS_TRYB: 'proba' }, token: 'demo', log: ciche, teraz: () => new Date('2026-11-12T12:00:00Z') };
  const bazy = [];
  const nowaBaza = () => { const db = new DatabaseSync(':memory:'); bazy.push(db); return db; };
  afterAll(() => bazy.forEach(db => db.close()));
  const fixture = (plik) => JSON.parse(fs.readFileSync(new URL(`../fixtures/fakturownia/${plik}`, import.meta.url), 'utf8')).wymiany;
  const pomiar = fixture('F04-faktura-minimalna.json').find(w => w.zadanie.metoda === 'POST');
  const invoice = pomiar.zadanie.cialo.invoice;
  it('dzieli stan i numerację między połączeniami tej samej bazy, chroni oid', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'baza-'));
    const plik = path.join(dir, 'atrapa.sqlite');
    const db1 = new DatabaseSync(plik), db2 = new DatabaseSync(plik);
    try {
      const a = createAtrapaFakturowni({ ...opcje, db: db1 });
      const f = await a.wystaw({ ...invoice, oid: 'demo-wspolne', oid_unique: 'yes' });
      const b = createAtrapaFakturowni({ ...opcje, db: db2 });
      expect(await b.pobierzFakture(f.id)).toEqual(f);
      const drugi = await b.wystaw(invoice);
      expect(drugi.id).toBe(f.id + 1);
      expect(drugi.number).toBe('2/11/2026');
      await expect(b.wystaw({ ...invoice, oid: 'demo-wspolne', oid_unique: 'yes' })).rejects.toMatchObject({ status: 422 });
      expect((await b.listaFaktur()).map(d => d.id)).toEqual([drugi.id, f.id]);
      const { odpowiedzFakturowni: wyslany } = await a.wyslijDokumentDoKsef(f.id);
      expect(wyslany).toMatchObject({ gov_status: 'ok', gov_id: `ATRAPA-20261112-${f.id}` });
      expect(await b.pobierzFakture(f.id)).toMatchObject({ gov_status: 'ok', gov_id: wyslany.gov_id });
    } finally { db1.close(); db2.close(); fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('liczy netto i VAT pozycji oraz numeruje korekty niezależnie od faktur', async () => {
    const db = nowaBaza();
    const a = createAtrapaFakturowni({ ...opcje, db });
    const f = await a.wystaw({ ...invoice, positions: [{ name: 'Towar demo', quantity: 2, total_price_gross: 246, tax: 23 }] });
    expect(f.positions[0]).toMatchObject({ total_price_net: '200.0', total_price_tax: '46.0', price_net: '100.0', price_tax: '23.0' });
    const pomiar = fixture('F15-korekta.json').find(w => w.zadanie.cialo?.invoice?.kind === 'correction' && w.odpowiedz.status === 201);
    const dane = { ...pomiar.zadanie.cialo.invoice, from_invoice_id: f.id, number: undefined };
    const k1 = await a.wystawKorekte(dane);
    const b = createAtrapaFakturowni({ ...opcje, db });
    const k2 = await b.wystawKorekte(dane);
    expect([k1.number, k2.number]).toEqual(['K1', 'K2']);
    expect(k1.positions[0].price_gross).toBe(pomiar.odpowiedz.cialo.positions[0].price_gross);
    expect((await b.wystaw(invoice)).number).toBe('2/11/2026');
  });

  it('dla token null odpowiada 401 bez wyjątku', async () => {
    const transport = createTransportAtrapyFakturowni({ ...opcje, db: nowaBaza(), token: null });
    expect((await transport('https://demo.fakturownia.pl/invoices.json')).status).toBe(401);
  });

  it('reset próby usuwa dokumenty, klientów i numerację Fakturowni', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reset-'));
    const baza = path.join(dir, 'oms.sqlite');
    try {
      const db = openOmsDb(baza);
      await createAtrapaFakturowni({ ...opcje, db }).wystaw(invoice);
      zlecResetDemo(db, { login: 'operator-demo' }); db.close();
      fs.writeFileSync(`${baza}.reset-proba`, '');
      expect(await wykonajZlecenieResetu({ baza, utworzBaze: () => openOmsDb(baza).close() })).toBeTruthy();
      const nowe = openOmsDb(baza);
      try {
        const a = createAtrapaFakturowni({ ...opcje, db: nowe });
        expect(await a.listaFaktur()).toEqual([]);
        expect(await a.znajdzKlientowPoNip(invoice.buyer_tax_no)).toEqual([]);
        expect(await a.wystaw(invoice)).toMatchObject({ id: 1, number: '1/11/2026' });
      } finally { nowe.close(); }
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
  const serwerFakturowniZ = () => {
    const transport = createTransportAtrapyFakturowni({ ...opcje, db: nowaBaza() });
    const wywolania = [];
    return { wywolania, fetchImpl: async (url, init) => {
      wywolania.push(new URL(url));
      return transport(url, init);
    } };
  };

  it('ma każdą metodę klienta i odmawia poza próbą', () => {
    const a = createAtrapaFakturowni({ ...opcje, db: nowaBaza() });
    const klient = createFakturowniaClient({ token: 'demo', domena: 'demo', fetchImpl: async () => { throw Error('sieć'); } });
    expect(metody(klient).filter(m => !metody(a).includes(m))).toEqual([]);
    expect(() => createAtrapaFakturowni({ env: {} })).toThrow('OMS_TRYB=proba');
    expect(() => createTransportAtrapyFakturowni({ env: {} })).toThrow('OMS_TRYB=proba');
  });

  it('prawdziwy klient na encjach atrapy oddaje te same dokumenty, płatność i KSeF', async () => {
    const a = createAtrapaFakturowni({ ...opcje, db: nowaBaza() });
    const serwer = serwerFakturowniZ();
    const klient = createFakturowniaClient({ token: 'demo', domena: 'demo', fetchImpl: serwer.fetchImpl });
    const logi = [];
    const zLogiem = createAtrapaFakturowni({ ...opcje, db: nowaBaza(), log: t => logi.push(t) });
    await zLogiem.wystaw(invoice);
    expect(logi.join('\n')).toMatch(/atrapa Fakturowni:.*nic nie poszło/);
    expect(await a.sprawdzPolaczenie()).toEqual(await klient.sprawdzPolaczenie());
    const dokument = await a.wystaw(invoice);
    expect(await klient.wystaw(invoice)).toEqual(dokument);
    expect(dokument).toMatchObject({ id: expect.any(Number), number: expect.any(String), gov_status: null,
      price_gross: pomiar.odpowiedz.cialo.price_gross, paid: pomiar.odpowiedz.cialo.paid });
    expect(await a.pobierzFakture(dokument.id)).toEqual(await klient.pobierzFakture(dokument.id));
    const zaplata = await a.oznaczZaplacona(dokument.id);
    expect(await klient.oznaczZaplacona(dokument.id)).toEqual(zaplata);
    const odpowiedzZaplaty = fixture('F09-zaplata.json').find(w => w.zadanie.url.includes('change_status')).odpowiedz.cialo;
    expect(zaplata).toEqual({ ...odpowiedzZaplaty, id: dokument.id });
    expect(await klient.pobierzFakture(dokument.id)).toMatchObject({ status: 'paid', paid: dokument.price_gross,
      paid_date: '2026-11-12', gov_status: null });
    // PRZ-119.05: data zapłaty z zamówienia (PUT paid_date po change_status) — atrapa ją zapisuje.
    const zData = await a.oznaczZaplacona(dokument.id, { paidDate: '2026-11-10' });
    expect(zData).toMatchObject({ id: dokument.id, paid_date: '2026-11-10' });
    expect(await klient.oznaczZaplacona(dokument.id, { paidDate: '2026-11-10' })).toEqual(zData);
    expect(await a.pobierzFakture(dokument.id)).toMatchObject({ status: 'paid', paid_date: '2026-11-10' });
    const pomiarKorekty = fixture('F15-korekta.json').find(w => w.zadanie.cialo?.invoice?.kind === 'correction' && w.odpowiedz.status === 201);
    const korekta = { ...pomiarKorekty.zadanie.cialo.invoice, from_invoice_id: dokument.id, number: 'K1' };
    expect(await a.wystawKorekte(korekta)).toEqual(await klient.wystawKorekte(korekta));
    expect((await a.listaFaktur()).find(d => d.number === 'K1').kind).toBe('correction');
    expect(await a.iluMaNumer(dokument.number)).toBe(await klient.iluMaNumer(dokument.number));
    expect(await klient.iluMaNumer(dokument.number)).toBe(1);
    expect(await klient.iluMaNumer('nie-ma')).toBe(0);
    expect(await a.znajdzKlientowPoNip(invoice.buyer_tax_no)).toEqual(await klient.znajdzKlientowPoNip(invoice.buyer_tax_no));
    expect(await klient.znajdzKlientowPoNip('nie-ma')).toEqual([]);
    expect((await klient.znajdzKlientowPoNip(invoice.buyer_tax_no))[0]).toMatchObject({ tax_no: invoice.buyer_tax_no, name: invoice.buyer_name });
    expect(await a.wyslijDokumentDoKsef(dokument.id)).toEqual(await klient.wyslijDokumentDoKsef(dokument.id));
    expect((await klient.pobierzFakture(dokument.id)).gov_status).toBe('ok');
    for (const c of [a, klient]) {
      const pdf = await c.pobierzPdf(dokument.id);
      expect(Buffer.isBuffer(pdf)).toBe(true);
      expect(pdf.toString('latin1')).toMatch(/^%PDF-[\s\S]*%%EOF\s*$/);
      await expect(c.pobierzFakture('99999')).rejects.toMatchObject({ status: 404 });
    }
  });

  it('odtwarza HTTP 201, duplikat 422 z F11, 401 z F02 i puste strony z F07', async () => {
    const serwer = serwerFakturowniZ();
    const klient = createFakturowniaClient({ token: 'demo', domena: 'demo', fetchImpl: serwer.fetchImpl });
    const naglowki = { Authorization: 'Bearer demo' };
    const res = await serwer.fetchImpl('https://demo.fakturownia.pl/invoices.json', {
      method: 'POST', headers: naglowki, body: JSON.stringify({ invoice: { ...invoice, oid: 'zam-demo', oid_unique: 'yes' } }),
    });
    expect(res.status).toBe(pomiar.odpowiedz.status);
    const duplikat = fixture('F11-podwojne-wystawienie.json').find(w => w.odpowiedz.status === 422).odpowiedz.cialo;
    await expect(klient.wystaw({ ...invoice, oid: 'zam-demo', oid_unique: 'yes' })).rejects.toMatchObject({ status: 422, tresc: duplikat });
    await klient.wystaw({ ...invoice, oid: 'zam-demo' });
    for (let i = 2; i < 100; i++) await klient.wystaw({ ...invoice, number: `DEMO/${i}` });
    serwer.wywolania.length = 0;
    expect(await klient.listaFaktur()).toHaveLength(100);
    expect(serwer.wywolania.map(u => u.searchParams.get('page'))).toEqual(['1', '2']);
    const pusta = await serwer.fetchImpl('https://demo.fakturownia.pl/invoices.json?page=3&per_page=100', { headers: naglowki });
    expect(await pusta.json()).toEqual([]);
    await klient.wystaw(invoice);
    expect(await klient.listaFaktur()).toHaveLength(101);
    expect(await klient.listaFaktur({ number: 'nie-ma' })).toEqual([]);
    for (const token of ['zle', '']) {
      const odmowa = await serwer.fetchImpl('https://demo.fakturownia.pl/invoices.json', { headers: { Authorization: `Bearer ${token}` } });
      expect(odmowa.status).toBe(401);
    }
    await expect(createFakturowniaClient({ token: 'zle', domena: 'demo', fetchImpl: serwer.fetchImpl }).sprawdzPolaczenie()).rejects.toMatchObject({ status: 401 });
  });
});

describe('PRZ-152.G1 — nadanie WzA atrapy', () => {
  it('reset demo usuwa stan przesyłek atrapy', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wza-reset-'));
    const baza = path.join(dir, 'oms.sqlite');
    try {
      const stare = openOmsDb(baza);
      const a = createAtrapaAllegro({ db: stare, kanal: 'allegro', env: ENV_DEMO, log: ciche });
      await a.utworzPrzesylke({ commandId: 'przed-resetem', input: { deliveryMethodId: 'demo' } });
      zlecResetDemo(stare, { login: 'operator-demo' });
      stare.close();
      expect(await wykonajZlecenieResetu({ baza, utworzBaze: () => { openOmsDb(baza).close(); } })).toBeTruthy();
      const nowe = openOmsDb(baza);
      try {
        const po = createAtrapaAllegro({ db: nowe, kanal: 'allegro', env: ENV_DEMO, log: ciche });
        expect(nowe.prepare('SELECT count(*) AS n FROM atrapa_allegro_przesylki').get().n).toBe(0);
        await expect(po.stanTworzeniaPrzesylki('przed-resetem')).rejects.toThrow();
      } finally { nowe.close(); }
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
  it('zachowuje commandId i przesyłkę po odtworzeniu klienta, oddaje PDF i ZPL', async () => {
    const baza = openOmsDb(':memory:');
    try {
      const opcje = { db: baza, kanal: 'allegro', env: ENV_DEMO, log: ciche };
      const a = createAtrapaAllegro(opcje);
      const input = { deliveryMethodId: '03f26351-f683-4db2-8895-f2c599280e3c', labelFormat: 'PDF', packages: [{ weight: { value: 1, unit: 'KILOGRAMS' } }] };
      const pierwszy = await a.utworzPrzesylke({ commandId: 'demo-command', input });
      const drugi = await createAtrapaAllegro(opcje).utworzPrzesylke({ commandId: 'demo-command', input });
      expect(drugi).toEqual(pierwszy);
      expect(pierwszy).toEqual({ commandId: 'demo-command', status: 'SUCCESS', errors: null, shipmentId: expect.any(String) });
      expect(await a.stanTworzeniaPrzesylki('demo-command')).toEqual(pierwszy);
      const p = await a.pobierzPrzesylkeWza(pierwszy.shipmentId);
      expect(p).toMatchObject({ id: pierwszy.shipmentId, labelFormat: 'PDF', packages: [{ waybill: expect.stringContaining('ATRAPA') }] });
      expect(baza.prepare('SELECT count(*) AS n FROM atrapa_allegro_przesylki').get().n).toBe(1);
      const pdf = await a.pobierzEtykieteWza([p.id]);
      expect(Buffer.isBuffer(pdf)).toBe(true);
      expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
      expect(tekstPdf(pdf).split('\n')).toContain('ATRAPA');
      const zpl = (await a.pobierzEtykieteWza([p.id], 'ZPL')).toString();
      expect(zpl).toContain('^XA'); expect(zpl).toContain('ATRAPA'); expect(zpl).toContain('^XZ');
      await expect(a.utworzPrzesylke({ input })).rejects.toThrow('commandId');
      await expect(a.utworzPrzesylke({ commandId: 'brak-uslugi' })).rejects.toThrow('deliveryMethodId');
      await expect(a.pobierzEtykieteWza([])).rejects.toThrow();
      await expect(a.pobierzPrzesylkeWza('nieznana')).rejects.toThrow();
      await expect(createAtrapaAllegro({ ...opcje, kanal: 'inne-konto' }).stanTworzeniaPrzesylki('demo-command')).rejects.toThrow();
      expect(() => createAtrapaAllegro({ ...opcje, env: {} })).toThrow('OMS_TRYB=proba');
    } finally { baza.close(); }
  });
});

let katalog, db, infakt;
beforeAll(async () => {
  katalog = fs.mkdtempSync(path.join(os.tmpdir(), 'oms-atrapy-kontrakt-'));
  const env = { ...ENV_DEMO, OMS_PROFORMY_KATALOG: katalog, OMS_ETYKIETY_KATALOG: katalog };
  await utworzBazeDemo({ baza: path.join(katalog, 'oms.sqlite'), dzis: DZIS, env });
  db = new DatabaseSync(path.join(katalog, 'oms.sqlite'));
  infakt = createAtrapaInfaktu({ db, env: ENV_DEMO, log: ciche });
}, 60000);
afterAll(() => { db?.close(); fs.rmSync(katalog, { recursive: true, force: true }); });

describe('komplet metod', () => {
  it('atrapa ERLI ma każdą metodę createErliClient', () => {
    const baza = new DatabaseSync(':memory:');
    try {
      const atrapa = createAtrapaErli({ db: baza, kanal: 'polcien', env: { OMS_TRYB: 'proba' } });
      expect(metody(createErliClient()).filter(m => !metody(atrapa).includes(m))).toEqual([]);
    } finally { baza.close(); }
  });
  it('status korekty atrapy wskazuje zapisany dokument także po odtworzeniu klienta', async () => {
    const [faktura] = await infakt.listaFaktur();
    const zlecenie = await infakt.wystawKorekte({ corrected_invoice_uuid: faktura.uuid, services: [], notes: 'Zwrot towaru' });
    const status = await infakt.statusKorekty(zlecenie.referencja);
    expect(zlecenie.referencja).toMatch(/^atrapa-/);
    expect(status).toEqual({ stan: 'wystawiona', uuid: expect.any(String), bledy: [] });
    expect((await infakt.listaKorekt()).some((k) => k.uuid === status.uuid)).toBe(true);
    const odtworzony = createAtrapaInfaktu({ db, env: ENV_DEMO, log: ciche });
    expect(await odtworzony.statusKorekty(zlecenie.referencja)).toEqual(status);
    expect(await odtworzony.statusKorekty('atrapa-nieznana')).toEqual({ stan: 'nieznany', uuid: null, bledy: [] });
    expect(await odtworzony.statusKorekty('')).toEqual({ stan: 'nieznany', uuid: null, bledy: [] });
  });
  it('atrapa inFaktu ma każdą metodę createInfaktClient', () => {
    const prawdziwy = metody(createInfaktClient({ apiKey: 'x', fetchImpl: async () => { throw new Error('sieć'); } }));
    expect(prawdziwy.length).toBeGreaterThanOrEqual(13);
    expect(prawdziwy.filter((m) => !metody(infakt).includes(m))).toEqual([]);
  });

  it('atrapa Woo ma każdą metodę createWooClient; odmowy to podzbiór metod klienta', async () => {
    const prawdziwy = metody(createWooClient({ baseUrl: 'https://x.invalid', ck: 'a', cs: 'b', fetchImpl: async () => { throw new Error('sieć'); } }));
    const klientAtrapy = createAtrapaWoo({ db, kanal: 'polcien', env: ENV_DEMO, log: ciche });
    const atrapa = metody(klientAtrapy);
    expect(prawdziwy).toEqual(expect.arrayContaining(['sprawdzPolaczenie', 'pobierzMetodyWysylki', 'pobierzBramkiPlatnosci']));
    expect(atrapa).toContain('pobierzBramkiPlatnosci');
    expect(await klientAtrapy.pobierzBramkiPlatnosci()).toEqual([
      { id: 'cod', tytul: 'Płatność przy odbiorze', nazwaWoo: 'Pobranie', wlaczona: true },
      { id: 'bacs', tytul: 'Przelew bankowy', nazwaWoo: 'Przelew', wlaczona: true },
    ]);
    expect(prawdziwy.length).toBeGreaterThanOrEqual(10);
    expect(prawdziwy.filter((m) => !atrapa.includes(m))).toEqual([]);
    expect(ODMOWY_WOO.filter((m) => !prawdziwy.includes(m))).toEqual([]);
  });

  it('atrapa Allegro ma każdą metodę createAllegroClient; odmowy to podzbiór metod klienta', () => {
    const prawdziwy = metody(createAllegroClient({ ustawienia: { api: 'https://x.invalid', userAgent: 'a/1 (+https://x.invalid)' },
      tokeny: { waznyToken: async () => 't' }, fetchImpl: async () => { throw new Error('sieć'); } }));
    const atrapa = metody(createAtrapaAllegro({ db, kanal: 'allegro', env: ENV_DEMO, log: ciche }));
    expect(prawdziwy.length).toBeGreaterThanOrEqual(26);
    expect(prawdziwy.filter((m) => !atrapa.includes(m))).toEqual([]);
    expect(ODMOWY_ALLEGRO.filter((m) => !prawdziwy.includes(m))).toEqual([]);
  });

  // PRZ-092: kurier DPD z Ustawień w piaskownicy.
  it('atrapa DPD ma każdą metodę createDpdClient; nadanie odmawia 400, sprawdzenie nie wychodzi do sieci', async () => {
    const opcje = { url: 'https://x.invalid', login: 'l', haslo: 'h', fid: '1', infoUrl: '', channel: '',
      nadawca: { nazwa: 'N', ulica: 'U 1', kod: '00-001', miasto: 'M' }, fetchImpl: async () => { throw new Error('sieć'); } };
    const prawdziwy = metody(createDpdClient(opcje));
    const atrapa = createAtrapaDpd({ env: ENV_DEMO })(opcje);
    expect(prawdziwy).toEqual(expect.arrayContaining(['nadaj', 'statusPrzesylki', 'sprawdzPolaczenie']));
    expect(prawdziwy.filter((m) => !metody(atrapa).includes(m))).toEqual([]);
    expect(ODMOWY_DPD.filter((m) => !prawdziwy.includes(m))).toEqual([]);
    for (const m of ODMOWY_DPD) {
      const e = await atrapa[m]().catch((x) => x);
      expect(e?.status, m).toBe(400);
      expect(e?.message, m).toContain('Piaskownica');
    }
    await expect(atrapa.sprawdzPolaczenie()).resolves.toEqual({ ok: true });
    await expect(createAtrapaDpd({ env: ENV_DEMO })({ ...opcje, haslo: 'zle' }).sprawdzPolaczenie()).rejects.toThrow('odrzuciło');
    expect(() => createAtrapaDpd({ env: {} })).toThrow('OMS_TRYB=proba');
  });

  // PRZ-093.09: kurier InPost z Ustawień w piaskownicy.
  it('atrapa InPost ma każdą metodę createInpostClient; nadanie odmawia 400, sprawdzenie nie wychodzi do sieci', async () => {
    const opcje = { url: 'https://x.invalid', token: 't', organizacja: 1,
      nadawca: { nazwa: 'N', ulica: 'U 1', kod: '00-001', miasto: 'M' }, fetchImpl: async () => { throw new Error('sieć'); } };
    const prawdziwy = metody(createInpostClient(opcje));
    const atrapa = createAtrapaInpost({ env: ENV_DEMO })(opcje);
    expect(prawdziwy).toEqual(expect.arrayContaining(['nadaj', 'sprawdzPrzesylke', 'pobierzEtykiete', 'statusPrzesylki', 'sprawdzPolaczenie']));
    expect(prawdziwy.filter((m) => !metody(atrapa).includes(m))).toEqual([]);
    expect(ODMOWY_INPOST.filter((m) => !prawdziwy.includes(m))).toEqual([]);
    expect(ODMOWY_INPOST).toContain('nadaj');
    for (const m of ODMOWY_INPOST) {
      const e = await atrapa[m]().catch((x) => x);
      expect(e?.status, m).toBe(400);
      expect(e?.message, m).toContain('Piaskownica');
    }
    await expect(atrapa.sprawdzPolaczenie()).resolves.toEqual({ ok: true });
    await expect(createAtrapaInpost({ env: ENV_DEMO })({ ...opcje, token: 'zle' }).sprawdzPolaczenie()).rejects.toThrow('odrzucił');
    expect(() => createAtrapaInpost({ env: {} })).toThrow('OMS_TRYB=proba');
  });

  // PRZ-102.11: klucz GUS z Ustawień w piaskownicy — „Sprawdź połączenie” na atrapie, pobranie firmy odmawia jak w demo.
  it('atrapa GUS ma każdą metodę createGusClient i pośrednika z Ustawień; sprawdzenie nie wychodzi do sieci', async () => {
    const prawdziwy = metody(createGusClient({ klucz: 'k', url: 'https://x.invalid' }, { fetchImpl: async () => { throw new Error('sieć'); } }))
      .filter((m) => !m.startsWith('_')); // `_sesja` to podgląd stanu dla testów klienta, nie metoda usługi
    const atrapa = createAtrapaGus({ env: ENV_DEMO, klucz: 'k' });
    expect(prawdziwy).toEqual(expect.arrayContaining(['firmaPoNip', 'zaloguj', 'sprawdzPolaczenie']));
    expect([...prawdziwy, ...METODY_GUS].filter((m) => !metody(atrapa).includes(m))).toEqual([]);
    await expect(atrapa.sprawdzPolaczenie()).resolves.toEqual({ ok: true });
    await expect(createAtrapaGus({ env: ENV_DEMO, klucz: 'zle' }).sprawdzPolaczenie()).rejects.toThrow('odrzuciła');
    await expect(atrapa.firmaPoNip('1234563218')).rejects.toThrow('wersji demonstracyjnej');
    expect(() => createAtrapaGus({ env: {} })).toThrow('OMS_TRYB=proba');
  });

  // PRZ-102.22: token KSeF (faktury kosztowe) z Ustawień w piaskownicy — logowanie i lista faktur bez sieci, PDF odmawia.
  it('atrapa KSeF i odmowa piaskownicy mają każdą metodę createKsefClient; logowanie i lista nie wychodzą do sieci', async () => {
    const prawdziwy = metody(createKsefClient({ token: 't', nip: '1234563218', fetchImpl: async () => { throw new Error('sieć'); } }));
    const atrapa = createAtrapaKsef({ env: ENV_DEMO, token: 'zmyslony' });
    expect(prawdziwy).toEqual(['odswiez', 'pobierzMetadane', 'pobierzXml', 'zaloguj']);
    expect(prawdziwy.filter((m) => !metody(atrapa).includes(m))).toEqual([]);
    expect(metody(odmowaKsefWProbie())).toEqual(prawdziwy);
    await expect(atrapa.zaloguj()).resolves.toHaveProperty('accessToken');
    await expect(atrapa.pobierzMetadane({ accessToken: 'a', from: '2026-10-19T00:00:00Z', to: '2026-10-20T00:00:00Z' })).resolves.toMatchObject({ faktury: [], hasMore: false });
    await expect(atrapa.pobierzXml({ accessToken: 'a', ksefNumber: 'K-1' })).rejects.toMatchObject({ status: 400 });
    await expect(createAtrapaKsef({ env: ENV_DEMO, token: 'zle' }).zaloguj()).rejects.toThrow('odrzuciła');
    for (const m of prawdziwy) await expect(odmowaKsefWProbie()[m](), m).rejects.toMatchObject({ status: 400 });
    expect(() => createAtrapaKsef({ env: {} })).toThrow('OMS_TRYB=proba');
    // Skład piaskownicy wpina atrapę w moduł kosztów; poza trybem próby moduł z atrapą odmawia konfiguracji.
    const koszty = modulyPiaskownicy(ENV_DEMO).find((m) => m.nazwa === 'koszty');
    expect(() => koszty.konfiguracja(ENV_DEMO)).not.toThrow();
    expect(() => koszty.konfiguracja({ ...ENV_DEMO, OMS_TRYB: 'produkcja' })).toThrow('atrapaKsef');
  });

  // PRZ-094.04: poczta z Ustawień w piaskownicy — atrapa poczty zastępuje i mailer z pliku, i pośrednika z ekranu.
  it('atrapa poczty ma każdą metodę createMailer i pośrednika poczty z Ustawień; wysyłka nie wychodzi do sieci', async () => {
    const poczta = { smtp: { host: 'smtp.example.invalid', port: 465, user: 'u@example.invalid', pass: 'p' }, mailFrom: 'u@example.invalid' };
    const prawdziwy = metody(createMailer({ ...poczta, transportFactory: () => ({ sendMail: async () => { throw new Error('sieć'); } }) }));
    const zUstawien = metody(pocztaZUstawien({ wczytaj: () => null, fabryka: () => { throw new Error('sieć'); } }))
      .filter((m) => m !== 'gotowy'); // `gotowy` mówi tylko, czy zapis z ekranu jest kompletny — atrapa jest zawsze gotowa
    const logi = [];
    const atrapa = createAtrapaPoczty({ env: ENV_DEMO, log: (t) => logi.push(t) });
    expect(prawdziwy).toContain('sendMail');
    expect([...prawdziwy, ...zUstawien].filter((m) => !metody(atrapa).includes(m))).toEqual([]);
    await expect(atrapa.sendMail({ to: 'a@example.invalid', subject: 'Wiadomość próbna z panelu' })).resolves.toHaveProperty('messageId');
    expect(logi.join('\n')).toContain('nic nie poszło');
    expect(createModulWiadomosciAtrapy(ENV_DEMO).konfiguracja({}).atrapaPoczty).toBe(true);
    expect(() => createAtrapaPoczty({ env: {} })).toThrow('OMS_TRYB=proba');
  });

  it('metoda z listy odmów odmawia czytelnie, kodem 4xx (usługi zwalniają wtedy rezerwację)', async () => {
    const allegro = createAtrapaAllegro({ db, kanal: 'allegro', env: ENV_DEMO, log: ciche });
    for (const m of ODMOWY_ALLEGRO) {
      const e = await allegro[m]().catch((x) => x);
      expect(e?.status, m).toBe(400);
      expect(e?.message, m).toContain('Piaskownica');
    }
  });
});

// Serwer inFaktu „z encji atrapy”: stronicowanie po 10 jak w prawdziwym API (inFakt ignoruje `limit`).
function serwerZ(encje) {
  const wolania = [];
  const fetchImpl = async (url, opcje = {}) => {
    wolania.push({ url, metoda: opcje.method ?? 'GET' });
    const u = new URL(url);
    const offset = Number(u.searchParams.get('offset') ?? 0);
    const odp = typeof encje === 'function' ? encje(u, opcje) : { metainfo: { count: Math.min(10, encje.length - offset), total_count: encje.length }, entities: encje.slice(offset, offset + 10) };
    return { ok: true, status: 200, json: async () => odp, arrayBuffer: async () => odp };
  };
  return { fetchImpl, wolania };
}
const bezRodzaju = ({ rodzaj, ...e }) => e;

describe('kształty inFaktu: prawdziwy klient na encjach atrapy oddaje to samo', () => {
  it('listaFaktur, listaKorekt, listaNieoplaconych — te same wiersze i ten sam `rodzaj`', async () => {
    for (const [metoda, zakres] of [['listaFaktur', { od: `${DZIS.slice(0, 7)}-01`, do: DZIS }], ['listaKorekt', {}], ['listaNieoplaconych', undefined]]) {
      const zAtrapy = await infakt[metoda](zakres);
      expect(zAtrapy.length, metoda).toBeGreaterThan(0);
      const { fetchImpl } = serwerZ(zAtrapy.map(bezRodzaju));
      const zKlienta = await createInfaktClient({ apiKey: 'x', fetchImpl })[metoda](zakres);
      expect(zKlienta, metoda).toEqual(zAtrapy);
    }
  });

  it('pobierzFakture — mapowanie pól jak w kliencie (numer, ksefNumer, status, left_to_pay, services)', async () => {
    for (const { uuid } of (await infakt.listaFaktur({})).slice(0, 5)) {
      const { fetchImpl } = serwerZ(() => infakt.surowaEncja(uuid));
      expect(await createInfaktClient({ apiKey: 'x', fetchImpl }).pobierzFakture(uuid)).toEqual(await infakt.pobierzFakture(uuid));
    }
  });

  it('wystaw — wynik jak z klienta dla tej samej encji; korekta i oznaczenie zapłaty — te same klucze', async () => {
    const klient = await infakt.zalozKlienta({ company_name: 'Kontrahent kontraktu (demo)', nip: '9990000019' });
    const w = await infakt.wystaw({ client_id: klient, services: [{ name: 'Lampa (demo)', quantity: 1, gross_price: 12300, tax_symbol: '23' }] });
    const { fetchImpl } = serwerZ(() => infakt.surowaEncja(w.uuid));
    const prawdziwy = createInfaktClient({ apiKey: 'x', fetchImpl });
    expect(await prawdziwy.wystaw({ client_id: klient, services: [] })).toEqual(w);
    expect(Object.keys(await infakt.wystawKorekte({ corrected_invoice_uuid: w.uuid, services: [] })).sort())
      .toEqual(Object.keys(await prawdziwy.wystawKorekte({})).sort());
    expect(Object.keys(await infakt.oznaczZaplacona(w.uuid)).sort()).toEqual(Object.keys(await prawdziwy.oznaczZaplacona(w.uuid)).sort());
    expect(Object.keys(await infakt.wyslijDokumentDoKsef(w.uuid)).sort()).toEqual(Object.keys(await prawdziwy.wyslijDokumentDoKsef(w.uuid)).sort());
    // Pułapka z 10.08.2026 odtworzona wiernie: zapłata zmienia status, `left_to_pay` zostaje.
    const po = await infakt.pobierzFakture(w.uuid);
    expect([po.status, po.left_to_pay]).toEqual(['paid', 12300]);
  });

  it('PDF faktury i korekty: bajty zaczynają się od %PDF (klient odrzuca wszystko inne); obcy uuid = 404', async () => {
    const [f] = await infakt.listaFaktur({});
    const [k] = await infakt.listaKorekt({});
    for (const pdf of [await infakt.pobierzPdf(f.uuid), await infakt.pobierzPdfKorekty(k.uuid)]) {
      expect(Buffer.isBuffer(pdf)).toBe(true);
      expect(pdf.subarray(0, 4).toString()).toBe('%PDF');
    }
    await expect(infakt.pobierzPdf(k.uuid)).rejects.toMatchObject({ status: 404 });
    await expect(infakt.pobierzPdfKorekty(f.uuid)).rejects.toMatchObject({ status: 404 });
  });

  it('encje mają pola czytane przez widok Faktur i domenę (lista-faktur, termin, KSeF)', async () => {
    const POLA = ['uuid', 'number', 'invoice_date', 'sale_date', 'payment_date', 'status', 'left_to_pay', 'gross_price',
      'payment_method', 'ksef_number', 'client_company_name', 'client_first_name', 'client_last_name', 'client_tax_code'];
    for (const d of [...await infakt.listaFaktur({}), ...await infakt.listaKorekt({})]) {
      expect(POLA.filter((p) => !Object.hasOwn(d, p)), d.number).toEqual([]);
      expect(Number.isInteger(d.gross_price), d.number).toBe(true);
      // Kolumna „Nabywca” (faktury.ejs): firma albo imię i nazwisko — pusta była błędem atrapy (14.10).
      expect(d.client_company_name || [d.client_first_name, d.client_last_name].filter(Boolean).join(' '), d.number).toBeTruthy();
    }
  });
});

// PRZ-108.09 (zmiana C2 planu automatyzacji): atrapy DPD i InPost oddają realistyczny przebieg paczki — zarejestrowana →
// odebrana przez kuriera (10 min po nadaniu) → w drodze → doręczona — liczony od `utworzona_at` paczki w bazie piaskownicy.
// Bez tego „Kurier odebrał paczkę” byłoby w piaskownicy martwe (statusPrzesylki() → null). Kształt odpowiedzi atrapy =
// to, co prawdziwy klient wyczytuje z surowej odpowiedzi kuriera zbudowanej przez atrapę (SOAP DPD, JSON ShipX).
describe('przebieg przesyłki w atrapach DPD i InPost (PRZ-108.09)', () => {
  const MIN = 60_000;
  const T0 = Date.parse('2026-10-21T10:00:00.000Z');
  const opcjeDpd = { url: 'https://x.invalid', login: 'l', haslo: 'h', fid: '1', infoUrl: 'https://x.invalid/info', channel: 'k',
    nadawca: { nazwa: 'N', ulica: 'U 1', kod: '00-001', miasto: 'M' } };
  const opcjeInpost = { url: 'https://x.invalid', token: 't', organizacja: 1, nadawca: { nazwa: 'N', ulica: 'U 1', kod: '00-001', miasto: 'M' } };
  let baza;
  const otworz = () => {
    baza = openOmsDb(':memory:');
    const zam = baza.prepare("INSERT INTO zamowienia (sklep, zrodlo_id, numer, kwota_brutto, utworzone_at) VALUES ('sklep', ?, ?, '1.00', '2026-10-21')");
    const pacz = baza.prepare('INSERT INTO przesylki (zamowienie_id, kurier, status, numer_listu, kolejnosc, utworzona_at) VALUES (?, ?, ?, ?, 1, ?)');
    for (const [i, [kurier, status, numer]] of [['dpd', 'nadana', '0000000000001U'], ['inpost', 'nadana', '000000000000000000000001'],
      ['dpd', 'do_wyjasnienia', '0000000000002U'], ['dpd', 'blad', '0000000000003U']].entries()) {
      const id = Number(zam.run(i + 1, String(i + 1)).lastInsertRowid);
      pacz.run(id, kurier, status, numer, new Date(T0).toISOString());
    }
  };
  const dpd = (terazMs) => createAtrapaDpd({ env: ENV_DEMO, baza: () => baza, teraz: () => new Date(terazMs) })(opcjeDpd);
  const inpost = (terazMs) => createAtrapaInpost({ env: ENV_DEMO, baza: () => baza, teraz: () => new Date(terazMs) })(opcjeInpost);
  afterAll(() => baza?.close());

  it('DPD: zarejestrowana do 10 min, potem „odebrana przez Kuriera” (dowód z białej listy), na końcu doręczona; czasy rosną', async () => {
    otworz();
    const przed = await dpd(T0 + 9 * MIN).statusPrzesylki('0000000000001U');
    expect(przed.opis).toBe('Zarejestrowano dane przesyłki, przesyłka jeszcze nie nadana');
    expect(dowodOdbioru({ status_kuriera: przed.opis }, { historia: przed.historia })).toBeNull();
    const po = await dpd(T0 + 10 * MIN).statusPrzesylki('0000000000001U');
    expect(po.opis).toBe('Przesyłka odebrana przez Kuriera');
    expect(dowodOdbioru({ status_kuriera: po.opis }, { historia: po.historia })).toBe('dpd:ODEBRANA_PRZEZ_KURIERA');
    const koniec = await dpd(T0 + 3 * 24 * 60 * MIN).statusPrzesylki('0000000000001U');
    expect(koniec.opis).toBe('Przesyłka doręczona');
    const czasy = koniec.historia.map((z) => z.at);
    expect([...czasy].sort()).toEqual(czasy);
    expect(koniec.historia.length).toBeGreaterThanOrEqual(4);
  });

  it('InPost: „Przesyłka zarejestrowana” do 10 min, potem „Przyjęta w oddziale nadawczym”, na końcu „Odebrana przez klienta”', async () => {
    otworz();
    expect((await inpost(T0 + 9 * MIN).statusPrzesylki('000000000000000000000001')).opis).toBe('Przesyłka zarejestrowana');
    const po = await inpost(T0 + 10 * MIN).statusPrzesylki('000000000000000000000001');
    expect(dowodOdbioru({ status_kuriera: po.opis })).toBe('inpost:adopted_at_source_branch');
    expect((await inpost(T0 + 3 * 24 * 60 * MIN).statusPrzesylki('000000000000000000000001')).opis).toBe('Odebrana przez klienta');
  });

  it('bez nadania nie ma odbioru: nieznany numer, paczka „do wyjaśnienia” albo z błędem, numer innego kuriera, brak bazy → null', async () => {
    otworz();
    const pozniej = T0 + 3 * 24 * 60 * MIN;
    for (const numer of ['9999999999999U', '0000000000002U', '0000000000003U', '000000000000000000000001']) {
      expect(await dpd(pozniej).statusPrzesylki(numer), numer).toBeNull();
    }
    expect(await inpost(pozniej).statusPrzesylki('0000000000001U')).toBeNull();
    expect(await createAtrapaDpd({ env: ENV_DEMO })(opcjeDpd).statusPrzesylki('0000000000001U')).toBeNull();
    expect(await createAtrapaInpost({ env: ENV_DEMO })(opcjeInpost).statusPrzesylki('000000000000000000000001')).toBeNull();
  });

  it('prawdziwy klient DPD na surowej odpowiedzi SOAP atrapy oddaje to samo co atrapa (w każdym etapie)', async () => {
    otworz();
    for (const minut of [0, 10, 300, 1230, 4000]) {
      const teraz = T0 + minut * MIN;
      const xml = surowaOdpowiedzDpd(zdarzeniaAtrapyDpd(new Date(T0).toISOString(), teraz));
      const prawdziwy = createDpdClient({ ...opcjeDpd, fetchImpl: async () => new Response(xml, { status: 200 }) });
      expect(await prawdziwy.statusPrzesylki('0000000000001U'), `${minut} min`).toEqual(await dpd(teraz).statusPrzesylki('0000000000001U'));
    }
  });

  it('prawdziwy klient InPost na surowej odpowiedzi ShipX atrapy oddaje to samo co atrapa (w każdym etapie)', async () => {
    otworz();
    for (const minut of [0, 10, 300, 1230, 4000]) {
      const teraz = T0 + minut * MIN;
      const json = JSON.stringify(surowaOdpowiedzInpost('000000000000000000000001', zdarzeniaAtrapyInpost(new Date(T0).toISOString(), teraz)));
      const prawdziwy = createInpostClient({ ...opcjeInpost, fetchImpl: async () => new Response(json, { status: 200, headers: { 'content-type': 'application/json' } }) });
      expect(await prawdziwy.statusPrzesylki('000000000000000000000001'), `${minut} min`)
        .toEqual(await inpost(teraz).statusPrzesylki('000000000000000000000001'));
    }
  });
});
