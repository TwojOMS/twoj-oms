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
import { createWooClient } from '../../src/oms/woo/client.js';
import { createAllegroClient } from '../../src/oms/allegro/client.js';
import { utworzBazeDemo, ENV_DEMO } from '../../scripts/demo-dane.mjs';
import { createAtrapaInfaktu } from '../../deploy/proba/atrapy/infakt.mjs';
import { createAtrapaWoo, createAtrapaAllegro, ODMOWY_WOO, ODMOWY_ALLEGRO } from '../../deploy/proba/atrapy/kanaly.mjs';
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');

const DZIS = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Warsaw' });
const metody = (o) => Object.keys(o).filter((k) => typeof o[k] === 'function').sort();
const ciche = () => {};

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
  it('atrapa inFaktu ma każdą metodę createInfaktClient', () => {
    const prawdziwy = metody(createInfaktClient({ apiKey: 'x', fetchImpl: async () => { throw new Error('sieć'); } }));
    expect(prawdziwy.length).toBeGreaterThanOrEqual(13);
    expect(prawdziwy.filter((m) => !metody(infakt).includes(m))).toEqual([]);
  });

  it('atrapa Woo ma każdą metodę createWooClient; odmowy to podzbiór metod klienta', () => {
    const prawdziwy = metody(createWooClient({ baseUrl: 'https://x.invalid', ck: 'a', cs: 'b', fetchImpl: async () => { throw new Error('sieć'); } }));
    const atrapa = metody(createAtrapaWoo({ db, kanal: 'polcien', env: ENV_DEMO, log: ciche }));
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
