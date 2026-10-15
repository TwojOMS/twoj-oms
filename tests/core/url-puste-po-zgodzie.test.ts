import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Socket } from 'node:net';
import dns from 'node:dns/promises';
import { zbudujOms } from '../../src/oms/bootstrap.ts';
import { konfiguracjaKanalow } from '../../src/moduly/kanaly/konfiguracja.ts';
import { wczytajKurierow } from '../../src/moduly/wysylka/kurierzy.ts';
import { wczytajFaktury } from '../../src/moduly/faktury/modul.ts';
import { wczytajKoszty } from '../../src/moduly/koszty/modul.ts';
import { konfiguracjaZamowien } from '../../src/moduly/zamowienia/konfiguracja.ts';
import * as infakt from '../../src/oms/infakt/client.js';
import * as gus from '../../src/oms/gus/client.js';
import * as ksef from '../../src/oms/ksef/client.js';
import * as allegro from '../../src/oms/allegro/client.js';
import * as tokeny from '../../src/oms/allegro/tokeny.js';
import * as fabryki from '../../src/integracje/fabryki.ts';

const seller = { OMS_SPRZEDAWCA_NIP: '1234563218', OMS_RACHUNEK: '34109010140000000000000000', OMS_PROFORMY_KATALOG: '/synthetic/unused' };
const rynek = { R_CLIENT_ID: 'fixture', R_CLIENT_SECRET: 'fixture', R_USER_AGENT: 'Fixture/1.0 (+https://fixture.invalid)', R_OD: '2026-01-01' };
const sender = { DPD_NADAWCA_NAZWA: 'Fixture', DPD_NADAWCA_ULICA: 'Testowa 1', DPD_NADAWCA_KOD: '00-001', DPD_NADAWCA_MIASTO: 'Fixture' };
const defs = [{ klucz: 'rynek', typ: 'allegro' as const, prefiks: 'R' }];
const readers = [
  ['INFAKT_API_URL', (e: Record<string, string | undefined>) => wczytajFaktury({ ...seller, INFAKT_API_KEY: 'fixture', ...e })],
  ['GUS_URL', (e: Record<string, string | undefined>) => konfiguracjaZamowien({ ...seller, GUS_KLUCZ: 'fixture', ...e })],
  ['KSEF_API', (e: Record<string, string | undefined>) => wczytajKoszty({ ...seller, KSEF_TOKEN: 'fixture', ...e })],
  ['DPD_URL', (e: Record<string, string | undefined>) => wczytajKurierow(e)],
  ['DPD_INFO_URL', (e: Record<string, string | undefined>) => wczytajKurierow(e)],
  ['INPOST_URL', (e: Record<string, string | undefined>) => wczytajKurierow({ ...sender, INPOST_TOKEN: 'fixture', INPOST_ORGANIZACJA: '1', ...e })],
  ['R_API', (e: Record<string, string | undefined>) => konfiguracjaKanalow(defs, { ...rynek, ...e })],
  ['R_AUTH', (e: Record<string, string | undefined>) => konfiguracjaKanalow(defs, { ...rynek, ...e })],
] as const;
let wychodzace: string[];
beforeEach(() => {
  wychodzace = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => { wychodzace.push('fetch'); throw Error('Sieć zabroniona'); });
  vi.spyOn(Socket.prototype, 'connect').mockImplementation(() => { wychodzace.push('socket'); throw Error('Sieć zabroniona'); });
  vi.spyOn(dns, 'lookup').mockImplementation(async () => { wychodzace.push('dns'); throw Error('DNS zabroniony'); });
});
afterEach(() => { vi.restoreAllMocks(); expect(wychodzace).toEqual([]); });

it.each(readers)('%s dosłownie pusty daje dokładny wynik absent', (key, read) => {
  expect(read({ [key]: '' })).toEqual(read({}));
});
it.each(readers)('%s niepuste białe znaki nadal odmawiają nazwanym błędem', (key, read) => {
  for (const value of [' ', ' https://fixture.invalid', 'https://fixture.invalid\t']) expect(() => read({ [key]: value })).toThrow(key);
});
it('puste URL bez aktywnej integracji zachowują wyłączenie KSeF, DPD i GUS', () => {
  expect(wczytajKoszty({ ...seller, KSEF_API: '' }).ksef).toBeNull();
  expect(wczytajKurierow({ DPD_URL: '', DPD_INFO_URL: '', INPOST_URL: '' }).dpd).toBeNull();
  expect(konfiguracjaZamowien({ ...seller, GUS_URL: '' }).gus).toBeNull();
});
it('DPD_INFO_URL bez defaultu jest nadal wymagane przy aktywnym DPD', () => {
  expect(() => wczytajKurierow({ ...sender, DPD_URL: 'https://fixture.invalid', DPD_LOGIN: 'fixture', DPD_PASSWORD: 'fixture', DPD_FID: '1', DPD_INFO_CHANNEL: 'fixture', DPD_INFO_URL: '' })).toThrow('DPD_INFO_URL');
});
it.each(['', '/', '///'])('Allegro API i AUTH z końcówką %j dają pojedynczy separator w rzeczywistych klientach', async koncowka => {
  const ustawienia = konfiguracjaKanalow(defs, { ...rynek,
    R_API: `https://allegro-fixture.invalid${koncowka}`,
    R_AUTH: `https://allegro-fixture.invalid/auth/oauth${koncowka}` }).kanaly.rynek;
  const urls: string[] = [];
  const http = async (url: unknown) => { urls.push(String(url)); throw Error('Lokalna odmowa fixture'); };
  const klient = allegro.createAllegroClient({ ustawienia, http, fetchImpl: undefined, tokeny: { waznyToken: async () => 'fixture' } });
  const oauth = tokeny.createTokeny({ ustawienia, http, fetchImpl: undefined, kanal: 'rynek', db: {
    prepare() { throw Error('Odczyt DB poza zakresem testu'); },
  } });
  await expect(klient.pobierzOferte('fixture')).rejects.toThrow('Lokalna odmowa fixture');
  await expect(oauth.rozpocznijPowiazanie()).rejects.toThrow('Lokalna odmowa fixture');
  expect(urls).toEqual([
    'https://allegro-fixture.invalid/sale/product-offers/fixture',
    'https://allegro-fixture.invalid/auth/oauth/device',
  ]);
});
it('Woo pusty URL w pełnym produkcie pozostaje brakiem, a strict wymaga go', async () => {
  const woo = [{ klucz: 'sklep', typ: 'woo' as const, prefiks: 'W' }];
  const e = { W_URL: '', W_CK: 'fixture', W_CS: 'fixture', W_MAPOWANIE: '{"instancje":[],"poPozycji":[]}', W_OD: '2026-01-01' };
  const full = konfiguracjaKanalow(woo, e, true);
  expect(full.sklepy).toEqual({}); expect(full.braki!.sklep).toEqual(['W_URL']);
  expect(() => konfiguracjaKanalow(woo, e)).toThrow('Brak wymaganej zmiennej: W_URL');
  const a = await zbudujOms({ env: { ...seller, OMS_TRYB: 'produkcja', OMS_USER: 'fixture', OMS_PASS: 'fixture', OMS_KANALY: JSON.stringify(woo), ...e } });
  try {
    expect((await a.app.inject('/login')).statusCode).toBe(200); expect(a.usluga<any>('kanaly', 'config').braki.sklep).toEqual(['W_URL']);
    a.db.prepare("INSERT INTO zamowienia(sklep,zrodlo_id,numer,kwota_brutto,utworzone_at) VALUES('sklep',1,'FIXTURE','0',?)").run(new Date().toISOString());
    const zdrowie = (await a.app.inject('/health')).json();
    expect(zdrowie.ok).toBe(false); expect(JSON.stringify(zdrowie.alarmy)).toContain('W_URL');
  }
  finally { await a.app.close(); a.db.close(); }
});

it.each([' ', '\t'])('Woo full konfigurator odmawia niepustego whitespace %j', value => {
  const woo = [{ klucz: 'sklep', typ: 'woo' as const, prefiks: 'W' }];
  expect(() => konfiguracjaKanalow(woo, { W_URL: value, W_CK: 'fixture', W_CS: 'fixture', W_OD: '2026-01-01', W_MAPOWANIE: '{"instancje":[],"poPozycji":[]}' }, true)).toThrow('W_URL');
});
it.each([' ', '\t'])('Woo full bootstrap odmawia niepustego whitespace %j przed odczytem bazy', async value => {
  const woo = [{ klucz: 'sklep', typ: 'woo' as const, prefiks: 'W' }];
  const env = { ...seller, OMS_TRYB: 'produkcja', OMS_USER: 'fixture', OMS_PASS: 'fixture', OMS_KANALY: JSON.stringify(woo), W_URL: value, W_CK: 'fixture', W_CS: 'fixture', W_OD: '2026-01-01', W_MAPOWANIE: '{"instancje":[],"poPozycji":[]}' };
  let odczytyDb = 0;
  await expect(zbudujOms({ env, get db(): never { odczytyDb++; throw Error('Dotknięto DB'); } })).rejects.toThrow('W_URL');
  expect(odczytyDb).toBe(0);
});

it('pełny bootstrap przekazuje pusty URL do rzeczywistych fabryk jako default albo wyłączenie', async () => {
  const urls: string[] = [];
  const http = async (url: unknown) => { urls.push(String(url)); throw Error('Zablokowany lokalny transport fixture'); };
  const realInfakt = infakt.createInfaktClient, realGus = gus.createGusClient, realKsef = ksef.createKsefClient;
  const realAllegro = allegro.createAllegroClient, realTokeny = tokeny.createTokeny, realInpost = fabryki.createInpostClient;
  const i = vi.spyOn(infakt, 'createInfaktClient').mockImplementation((o: any) => realInfakt({ ...o, http }));
  const g = vi.spyOn(gus, 'createGusClient').mockImplementation((o: any) => realGus(o, { http }));
  const k = vi.spyOn(ksef, 'createKsefClient').mockImplementation((o: any) => realKsef({ ...o, http }));
  vi.spyOn(allegro, 'createAllegroClient').mockImplementation((o: any) => realAllegro({ ...o, http, tokeny: { ...o.tokeny, waznyToken: async () => 'fixture' } }));
  const t = vi.spyOn(tokeny, 'createTokeny').mockImplementation((o: any) => realTokeny({ ...o, http }));
  const ip = vi.spyOn(fabryki, 'createInpostClient').mockImplementation((o: any) => realInpost({ ...o, http }));
  const dpd = vi.spyOn(fabryki, 'createDpdClient');
  const a = await zbudujOms({ env: { ...seller, ...sender, ...rynek, OMS_TRYB: 'produkcja', OMS_USER: 'fixture', OMS_PASS: 'fixture', OMS_KANALY: JSON.stringify(defs),
    INFAKT_API_KEY: 'fixture', INFAKT_API_URL: '', GUS_KLUCZ: 'fixture', GUS_URL: '', KSEF_TOKEN: 'fixture', KSEF_API: '',
    DPD_URL: '', DPD_INFO_URL: '', INPOST_TOKEN: 'fixture', INPOST_ORGANIZACJA: '1', INPOST_URL: '', R_API: '', R_AUTH: '' } });
  try {
    const pierwszy = (spy: { mock: { calls: unknown[][] } }): any => spy.mock.calls[0][0];
    expect(pierwszy(i).baseUrl).toBeUndefined(); expect(pierwszy(k).baseUrl).toBeUndefined();
    expect(pierwszy(g).url).toBe('https://wyszukiwarkaregon.stat.gov.pl/wsBIR/UslugaBIRzewnPubl.svc');
    expect(pierwszy(ip).url).toBe('https://api-shipx-pl.easypack24.net/v1'); expect(dpd).not.toHaveBeenCalled();
    expect(pierwszy(t).ustawienia.api).toBe('https://api.allegro.pl'); expect(pierwszy(t).ustawienia.auth).toBe('https://allegro.pl/auth/oauth');
    const probe = async (f: () => Promise<unknown>) => { try { await f(); } catch {} };
    await probe(() => a.usluga<any>('faktury', 'infakt').pobierzFakture('fixture'));
    await probe(() => a.usluga<any>('zamowienia', 'gus').zaloguj());
    await probe(() => k.mock.results[0].value.zaloguj());
    await probe(() => a.usluga<any>('kanaly', 'klienciKanalow').rynek.pobierzOferte('fixture'));
    await probe(() => a.usluga<any>('kanaly', 'tokenyKanalow').rynek.rozpocznijPowiazanie());
    await probe(() => a.usluga<any>('wysylka', 'kurierzy').inpost.sprawdzPrzesylke('1'));
    for (const prefix of ['https://api.infakt.pl/api/', 'https://wyszukiwarkaregon.stat.gov.pl/', 'https://api.ksef.mf.gov.pl/v2/', 'https://api.allegro.pl/', 'https://allegro.pl/auth/oauth/', 'https://api-shipx-pl.easypack24.net/v1/']) expect(urls.some(u => u.startsWith(prefix)), prefix).toBe(true);
  } finally { await a.app.close(); a.db.close(); }
});
