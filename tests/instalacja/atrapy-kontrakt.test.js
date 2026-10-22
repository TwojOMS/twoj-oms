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
