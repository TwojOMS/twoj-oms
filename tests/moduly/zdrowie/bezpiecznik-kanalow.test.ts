import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zbudujOms } from '../../../src/oms/bootstrap.ts';

const chwila = new Date('2026-10-02T12:00:00Z');
const env = { OMS_SPRZEDAWCA_NIP: '1234563218', OMS_RACHUNEK: '34109010140000000000000000',
  OMS_USER: 'operator', OMS_PASS: 'HASLO-NIE-UJAWNIAJ', OMS_PROFORMY_KATALOG: tmpdir(), OMS_ETYKIETY_KATALOG: tmpdir() };
const woo = { klucz: 'polnoc', typ: 'woo', prefiks: 'POLNOC' };
const allegro = { klucz: 'rynek', typ: 'allegro', prefiks: 'RYNEK' };
const pelneWoo = { POLNOC_CK: 'CK-NIE-UJAWNIAJ', POLNOC_CS: 'CS-NIE-UJAWNIAJ',
  POLNOC_URL: 'https://polnoc.invalid', POLNOC_MAPOWANIE: '{"instancje":{},"poPozycji":[]}', POLNOC_OD: '2026-01-01' };
const pelneAllegro = { RYNEK_CLIENT_ID: 'ID-NIE-UJAWNIAJ', RYNEK_CLIENT_SECRET: 'SECRET-NIE-UJAWNIAJ',
  RYNEK_USER_AGENT: 'Fixture/1.0 (+https://fixture.invalid)', RYNEK_OD: '2026-01-01', RYNEK_API: 'https://rynek.invalid' };
const klucze = ['ok','alarmy','uwagi','poller','czuwaczKsef','czuwaczPrzesylek','czuwaczOstrzezen','czuwaczKosztow','kanaly','proces'];
afterEach(() => vi.unstubAllGlobals());

async function sprawdz(nad: Record<string, string | undefined>, sklep?: string, data = chwila.toISOString()) {
  const fetch = vi.fn(async () => { throw Error('Nie wolno wykonywać HTTP integracji'); });
  vi.stubGlobal('fetch', fetch);
  const katalog = mkdtempSync(join(tmpdir(), 'oms030-kanaly-'));
  const sciezka = join(katalog, 'test.sqlite');
  // Rzeczywisty plik SQLite jest otwierany, zamykany i ponownie przekazywany bootstrapowi.
  const pierwsza = await zbudujOms({ env: { ...env, OMS_DB_PATH: sciezka }, teraz: () => chwila });
  if (sklep) pierwsza.db.prepare("INSERT INTO zamowienia(sklep,zrodlo_id,numer,kwota_brutto,utworzone_at) VALUES(?,?,?,'0',?)").run(sklep, 1, 'TEST', data);
  await pierwsza.app.close(); pierwsza.db.close();
  let a: Awaited<ReturnType<typeof zbudujOms>> | undefined;
  try {
    a = await zbudujOms({ env: { ...env, OMS_DB_PATH: sciezka, ...nad }, teraz: () => chwila });
    const odpowiedz = await a.app.inject('/health');
    expect(odpowiedz.statusCode).toBe(200);
    expect(odpowiedz.headers['cache-control']).toBe('no-store');
    const wynik = odpowiedz.json();
    expect(Object.keys(wynik)).toEqual(klucze);
    for (const sekret of ['HASLO-NIE-UJAWNIAJ','CK-NIE-UJAWNIAJ','CS-NIE-UJAWNIAJ','ID-NIE-UJAWNIAJ','SECRET-NIE-UJAWNIAJ']) expect(odpowiedz.body).not.toContain(sekret);
    expect(fetch).not.toHaveBeenCalled();
    return { wynik, config: a.usluga<any>('kanaly', 'config'), zegary: a.zegary.map(z => z.nazwa) };
  } finally {
    await a?.app.close(); a?.db.close();
    rmSync(katalog, { recursive: true, force: true });
  }
}

describe('D01: bezpiecznik rzeczywistej bazy i bootstrapu', () => {
  it.each([undefined, '[]'])('brak definicji kanału w OMS_KANALY=%s nie daje zdrowego wyniku', async OMS_KANALY => {
    const { wynik } = await sprawdz({ OMS_KANALY }, 'polnoc');
    expect(wynik.ok).toBe(false);
    expect(wynik.alarmy).toContain('kanał polnoc: brak kompletnej konfiguracji (OMS_KANALY)');
  });
  it.each(['POLNOC_CK','POLNOC_CS','POLNOC_URL','POLNOC_MAPOWANIE'])('częściowy Woo: brak %s alarmuje i nie tworzy klienta', async nazwa => {
    const { wynik, config, zegary } = await sprawdz({ OMS_KANALY: JSON.stringify([woo]), ...pelneWoo, [nazwa]: undefined }, 'polnoc');
    expect(wynik.ok).toBe(false);
    expect(wynik.alarmy).toContain(`kanał polnoc: brak kompletnej konfiguracji (${nazwa})`);
    expect(config.sklepy).toEqual({}); expect(zegary).not.toContain('poller');
  });
  it.each(['RYNEK_CLIENT_ID','RYNEK_CLIENT_SECRET','RYNEK_USER_AGENT','RYNEK_OD'])('częściowe Allegro: brak %s alarmuje i nie tworzy klienta', async nazwa => {
    const { wynik, config, zegary } = await sprawdz({ OMS_KANALY: JSON.stringify([allegro]), ...pelneAllegro, [nazwa]: undefined }, 'rynek');
    expect(wynik.ok).toBe(false);
    expect(wynik.alarmy).toContain(`kanał rynek: brak kompletnej konfiguracji (${nazwa})`);
    expect(config.kanaly).toEqual({}); expect(zegary).not.toContain('poller');
  });
  it('zdefiniowany Woo bez żadnych kluczy podaje wszystkie brakujące nazwy', async () => {
    const { wynik } = await sprawdz({ OMS_KANALY: JSON.stringify([woo]) }, 'polnoc');
    expect(wynik.ok).toBe(false);
    expect(wynik.alarmy).toContain('kanał polnoc: brak kompletnej konfiguracji (POLNOC_URL, POLNOC_CK, POLNOC_CS, POLNOC_MAPOWANIE)');
  });
  it('komplet Woo nie alarmuje o konfiguracji', async () => {
    const { wynik, config, zegary } = await sprawdz({ OMS_KANALY: JSON.stringify([woo]), ...pelneWoo }, 'polnoc');
    expect(wynik.ok).toBe(true); expect(wynik.alarmy).toEqual([]);
    expect(config.sklepy.polnoc).toBeTruthy(); expect(zegary).toContain('poller');
  });
  it('jawnie pusty wymagany URL Woo pozostaje brakiem D01 i alarmuje', async () => {
    const { wynik, config } = await sprawdz({ OMS_KANALY: JSON.stringify([woo]), ...pelneWoo, POLNOC_URL: '' }, 'polnoc');
    expect(wynik.ok).toBe(false);
    expect(wynik.alarmy).toContain('kanał polnoc: brak kompletnej konfiguracji (POLNOC_URL)');
    expect(config.sklepy).toEqual({});
  });
  it('niepusty wadliwy URL jest odrzucany także przy brakującym innym kluczu kanału', async () => {
    await expect(zbudujOms({ env: { ...env, OMS_KANALY: JSON.stringify([woo]), ...pelneWoo,
      POLNOC_CK: undefined, POLNOC_URL: 'file:///SEKRET_ADRESU' } })).rejects.toThrow('POLNOC_URL');
  });
  it('komplet Allegro nie alarmuje o konfiguracji, stan tokenu zachowuje własną ocenę', async () => {
    const { wynik, config } = await sprawdz({ OMS_KANALY: JSON.stringify([allegro]), ...pelneAllegro }, 'rynek');
    expect(wynik.alarmy.every((x: string) => !x.includes('brak kompletnej konfiguracji'))).toBe(true);
    expect(config.kanaly.rynek).toBeTruthy();
  });
  it.each(['2026-09-02T11:59:59.999Z','2026-10-02T12:00:00.001Z'])('zamówienie poza oknem: %s', async data => {
    const { wynik } = await sprawdz({}, 'polnoc', data);
    expect(wynik.ok).toBe(true); expect(wynik.alarmy).toEqual([]);
  });
  it('zamówienie dokładnie sprzed 30 dni należy do okna', async () => {
    const { wynik } = await sprawdz({}, 'polnoc', '2026-09-02T12:00:00Z');
    expect(wynik.ok).toBe(false);
  });
  it('kanał dodany po uruchomieniu do DB zostaje wykryty przy odczycie zdrowia', async () => {
    const a = await zbudujOms({ env, teraz: () => chwila });
    try {
      expect((await a.app.inject('/health')).json().ok).toBe(true);
      a.db.prepare("INSERT INTO zamowienia(sklep,zrodlo_id,numer,kwota_brutto,utworzone_at) VALUES(?,?,?,'0',?)").run('nowy', 1, 'TEST', chwila.toISOString());
      expect((await a.app.inject('/health')).json().alarmy).toContain('kanał nowy: brak kompletnej konfiguracji (OMS_KANALY)');
    } finally { await a.app.close(); a.db.close(); }
  });
  it('pusta baza pozostaje zdrowa bez integracji', async () => {
    const { wynik } = await sprawdz({}); expect(wynik.ok).toBe(true);
  });
  it('źródło ręczne nie wymaga kluczy integracji', async () => {
    const { wynik } = await sprawdz({}, 'reczne'); expect(wynik.ok).toBe(true);
  });
  it('próba bez integracji na kopii zamówień pozostaje możliwa', async () => {
    const { wynik } = await sprawdz({ OMS_TRYB: 'proba' }, 'polnoc'); expect(wynik.ok).toBe(true);
  });
});
