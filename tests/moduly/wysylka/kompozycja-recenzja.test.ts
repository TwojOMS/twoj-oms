import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zbudujAplikacje } from '../../../src/core/aplikacja.ts';
import { modulRdzen } from '../../../src/moduly/rdzen/modul.ts';
import { createModulWeb } from '../../../src/core/web/modul.ts';
import { createModulKanaly } from '../../../src/moduly/kanaly/modul.ts';
import { modulFaktury } from '../../../src/moduly/faktury/modul.ts';
import { modulZamowienia } from '../../../src/moduly/zamowienia/modul.ts';
import { createModulWysylka, modulWysylka } from '../../../src/moduly/wysylka/modul.ts';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import type { FabrykiKurierow } from '../../../src/moduly/wysylka/kurierzy.ts';
import type { ModulOms, Srodowisko } from '../../../src/core/kontrakty.ts';
import { zalozKonto, ustawUprawnienia } from '../../../src/core/bezpieczenstwo/konta.js';
import { wczytajSekret } from '../../../src/core/bezpieczenstwo/sekret-sesji.js';
import { podpisz, NAZWA_CIASTECZKA_OMS } from '../../../src/core/bezpieczenstwo/sesja.js';
import { zapiszAdresFirmy } from '../../../src/oms/db/adres-firmy.js';
import { zapiszKonfiguracjeIntegracji } from '../../../src/oms/db/konfiguracja-integracji.js';
import { pobranieDoWysylki } from '../../../src/domena/allegro-wysylka.js';

const naglowek = { authorization: `Basic ${Buffer.from('operator:test').toString('base64')}` };
const dpd = { DPD_URL: 'https://przyklad.invalid/dpd', DPD_INFO_URL: 'https://przyklad.invalid/info',
  DPD_INFO_CHANNEL: '1', DPD_LOGIN: 'test', DPD_PASSWORD: 'test', DPD_FID: '1',
  DPD_NADAWCA_NAZWA: 'Nadawca testowy', DPD_NADAWCA_ULICA: 'Testowa 15', DPD_NADAWCA_KOD: '00-001',
  DPD_NADAWCA_MIASTO: 'Testowo', DPD_NADAWCA_EMAIL: 'nadawca@przyklad.invalid', DPD_NADAWCA_TELEFON: '500100200' };
const kanal = { klucz: 'rynek', typ: 'allegro' as const, prefiks: 'RYNEK' };
const sklep = { klucz: 'sklep', typ: 'woo' as const, prefiks: 'SKLEP' };

async function kompozycja(zWoo: boolean, dodatkowe: Srodowisko = {}, fabryki: FabrykiKurierow = {}) {
  const definicje = zWoo ? [kanal, sklep] : [kanal];
  const katalog = mkdtempSync(join(tmpdir(), 'prz022-recenzja-'));
  const env = { OMS_USER: 'operator', OMS_PASS: 'test', OMS_SPRZEDAWCA_NIP: '1234563218',
    OMS_RACHUNEK: 'PL34 1090 1014 0000 0000 0000 0000', OMS_ETYKIETY_KATALOG: katalog,
    OMS_PROFORMY_KATALOG: katalog, ...dpd,
    RYNEK_CLIENT_ID: 'test', RYNEK_CLIENT_SECRET: 'test', RYNEK_USER_AGENT: 'Fixture/1.0 (+https://fixture.invalid)', RYNEK_OD: '2026-01-01',
    RYNEK_API: 'https://przyklad.invalid/allegro', RYNEK_AUTH: 'https://przyklad.invalid/oauth',
    SKLEP_CK: 'test', SKLEP_CS: 'test', SKLEP_URL: 'https://przyklad.invalid/woo', SKLEP_OD: '2026-01-01',
    SKLEP_MAPOWANIE: JSON.stringify({ instancje: { 1: { metoda: 'dpd' } }, poPozycji: [] }),
    ...dodatkowe };
  const db = openOmsDb();
  try {
    const app = await zbudujAplikacje({ db, env, log: () => {},
      moduly: [modulRdzen, createModulWeb(definicje), createModulKanaly(definicje),
        modulFaktury, modulZamowienia, createModulWysylka({ fabryki })] as unknown as readonly ModulOms[] });
    return { ...app, db, katalog };
  } catch (e) { db.close(); throw e; }
}

afterEach(() => vi.unstubAllGlobals());
describe('poprawki recenzji — rzeczywiste manifesty i HTTP', () => {
  it('WzA czyta właściciela konta z Firmy przy żądaniu, bez kuriera z pliku', async () => {
    const createAllegroWza = vi.fn((_o: Parameters<NonNullable<FabrykiKurierow['createAllegroWza']>>[0]) => ({ nadaj: async () => ({ numerListu: null }) }));
    const bezDpd = Object.fromEntries(Object.keys(dpd).map(k => [k, '']));
    const a = await kompozycja(true, bezDpd, { createAllegroWza });
    try {
      zapiszKonfiguracjeIntegracji(a.db, 'dpd', { ustawienia: { nazwa: 'DPD test', login: 'fixture', fid: '1', typEtykiety: 'A4' },
        sekrety: { haslo: 'fixture', kanal: '' } });
      a.usluga<any>('wysylka', 'kurierDpd').odswiez();
      const konto = createAllegroWza.mock.calls[0]![0].pobranieNadawca!;
      for (const nazwa of ['Pracownia Przykładowa', 'Pracownia Po Zmianie']) {
        zapiszAdresFirmy(a.db, { nazwa, ulica: 'Testowa 1', kod: '00-001', miasto: 'Testowo', kraj: 'PL', telefon: '', email: '' });
        expect(konto.nazwa).toBe(nazwa);
        expect(konto.rachunek).toBe('34109010140000000000000000');
        expect(pobranieDoWysylki({ pobranieUslugi: true, cashOnDelivery: { amount: '83.99', currency: 'PLN' },
          limit: '6000', ownerName: konto.nazwa, iban: konto.rachunek, nadpisanieOperatora: null, wymaganeKonto: true })).toEqual({ wolno: true,
          cashOnDelivery: { amount: '83.99', currency: 'PLN', ownerName: nazwa, iban: 'PL34109010140000000000000000' } });
      }
    } finally { await a.app.close(); a.db.close(); }
  });
  it('rzeczywiste trasy zachowują sesję, uprawnienia, degradację Basic Auth i CSRF kolejki', async () => {
    const fetch = vi.fn(async () => { throw new Error('test nie zezwala na API'); });
    vi.stubGlobal('fetch', fetch);
    const a = await kompozycja(true);
    try {
      for (const url of ['/kolejka-druku', '/przesylki', '/zamowienia/999/nadaj']) {
        expect((await a.app.inject({ url })).statusCode).toBe(401);
      }
      zalozKonto(a.db, { login: 'admin', imie: 'Test', haslo: 'test', rola: 'admin', admin: true });
      const id = zalozKonto(a.db, { login: 'operator-test', imie: 'Test', haslo: 'test', rola: 'operator' });
      ustawUprawnienia(a.db, id, []);
      const cookie = `${NAZWA_CIASTECZKA_OMS}=${podpisz('operator-test', wczytajSekret(a.db))}`;
      expect((await a.app.inject({ url: '/kolejka-druku', headers: naglowek })).statusCode).toBe(200);
      expect((await a.app.inject({ url: '/przesylki', headers: naglowek })).statusCode).toBe(403);
      expect((await a.app.inject({ url: '/przesylki', headers: { cookie } })).statusCode).toBe(403);
      ustawUprawnienia(a.db, id, ['przesylki', 'zamowienia']);
      expect((await a.app.inject({ url: '/przesylki', headers: { cookie } })).statusCode).toBe(200);
      expect((await a.app.inject({ url: '/zamowienia/999/nadaj', headers: { cookie } })).statusCode).toBe(404);
      expect((await a.app.inject({ method: 'POST', url: '/kolejka-druku/999/wydrukowano', headers: naglowek })).statusCode).toBe(403);
      expect((await a.app.inject({ method: 'POST', url: '/kolejka-druku/999/wydrukowano', headers: { ...naglowek, origin: 'http://localhost' } })).statusCode).toBe(404);
      expect((await a.app.inject({ method: 'POST', url: '/zamowienia/999/nadaj', headers: { cookie, origin: 'https://obcy.invalid' } })).statusCode).toBe(403);
      a.db.prepare('UPDATE konta SET czynne=0 WHERE id=?').run(id);
      expect((await a.app.inject({ url: '/kolejka-druku', headers: { cookie } })).statusCode).toBe(401);
      expect(fetch).not.toHaveBeenCalled();
    } finally { await a.app.close(); a.db.close(); }
  });
  it('podjazd pokazuje zwalidowany adres DPD i kraj PL bez nowych OMS_PODJAZD_*', async () => {
    const fetch = vi.fn(async () => { throw new Error('test nie zezwala na API'); });
    vi.stubGlobal('fetch', fetch);
    const a = await kompozycja(false);
    try {
      a.db.exec("INSERT INTO zamowienia(id,sklep,zrodlo_id,numer,metoda_wysylki,kwota_brutto,utworzone_at) VALUES(1,'rynek',1,'TEST','allegro_dpd','10.00','2026-09-30'); INSERT INTO przesylki(id,zamowienie_id,kurier,numer_listu,status,utworzona_at) VALUES(1,1,'allegro_wza','LIST-TEST','utworzona','2026-09-30')");
      const r = await a.app.inject({ url: '/przesylki/podjazdy?ids=1', headers: naglowek });
      expect(r.statusCode).toBe(200);
      for (const [pole, wartosc] of Object.entries({ name: 'Nadawca testowy', street: 'Testowa 15',
        postalCode: '00-001', city: 'Testowo', countryCode: 'PL', email: 'nadawca@przyklad.invalid', phone: '500100200' })) {
        expect(r.body).toContain(`name="${pole}" value="${wartosc}"`);
      }
      expect(fetch).not.toHaveBeenCalled();
    } finally { await a.app.close(); a.db.close(); }
  });

  it.each([false, true])('czynne nadanie wymaga Woo: sklep=%s', async zWoo => {
    const fetch = vi.fn(async () => { throw new Error('test nie zezwala na API'); });
    vi.stubGlobal('fetch', fetch);
    const a = await kompozycja(zWoo);
    try {
      const nadanie = a.usluga('wysylka', 'nadanie');
      if (zWoo) expect(nadanie).toHaveProperty('nadaj');
      else expect(nadanie).toBeNull();
      expect(fetch).not.toHaveBeenCalled();
    } finally { await a.app.close(); a.db.close(); }
  });

  it('WzA dostaje znormalizowany rachunek tej samej usługi rdzenia', async () => {
    const createAllegroWza = vi.fn((_o: Parameters<NonNullable<FabrykiKurierow['createAllegroWza']>>[0]) => ({ nadaj: async () => ({ numerListu: null }) }));
    const a = await kompozycja(true, {}, { createAllegroWza });
    try {
      expect(createAllegroWza).toHaveBeenCalledOnce();
      const o = createAllegroWza.mock.calls[0]?.[0] as Parameters<NonNullable<FabrykiKurierow['createAllegroWza']>>[0];
      expect(o.pobranieNadawca?.rachunek).toBe('34109010140000000000000000');
      expect(o.pobranieNadawca?.rachunek).toBe(a.usluga<{ rachunek: string }>('rdzen', 'sprzedawca').rachunek);
    } finally { await a.app.close(); a.db.close(); }
  });

  it('zachowuje dawną nazwę i pierwszeństwo katalogu etykiet oraz historyczną ścieżkę domyślną', () => {
    expect(modulWysylka.konfiguracja({ OMS_ETYKIETY_DIR: '/data-oms/dawne', OMS_ETYKIETY_KATALOG: '/data-oms/inne' }).katalogEtykiet).toBe('/data-oms/dawne');
    expect(modulWysylka.konfiguracja({ OMS_ETYKIETY_DIR: '/data-oms/dawne' }).katalogEtykiet).toBe('/data-oms/dawne');
    expect(modulWysylka.konfiguracja({}).katalogEtykiet).toBe('/var/lib/panel/etykiety');
  });
});
