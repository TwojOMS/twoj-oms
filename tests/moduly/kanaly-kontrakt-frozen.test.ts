import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Socket } from 'node:net';
import { konfiguracjaKanalow } from '../../src/moduly/kanaly/konfiguracja.ts';
import { createModulKanaly } from '../../src/moduly/kanaly/modul.ts';
import { modulRdzen } from '../../src/moduly/rdzen/modul.ts';
import { zbudujOms } from '../../src/oms/bootstrap.ts';
import type { ModulOms } from '../../src/core/kontrakty.ts';

const mapa = '{"instancje":{},"poPozycji":[]}';
const woo = [{ klucz: 'sklep', typ: 'woo' as const, prefiks: 'SKLEP_NOCNY' }];
const allegro = [{ klucz: 'rynek', typ: 'allegro' as const, prefiks: 'RYNEK_NOCNY' }];
const pelneWoo = { SKLEP_NOCNY_URL: 'https://sklep.invalid', SKLEP_NOCNY_CK: 'fixture', SKLEP_NOCNY_CS: 'fixture', SKLEP_NOCNY_MAPOWANIE: mapa };
const pelneAllegro = { RYNEK_NOCNY_CLIENT_ID: 'fixture', RYNEK_NOCNY_CLIENT_SECRET: 'fixture' };
const pelnyProdukt = { OMS_TRYB: 'produkcja', OMS_USER: 'fixture', OMS_PASS: 'fixture',
  OMS_SPRZEDAWCA_NIP: '1234563218', OMS_RACHUNEK: '34109010140000000000000000', OMS_PROFORMY_KATALOG: '/synthetic/unused' };
let probySieci: string[];
beforeEach(() => {
  probySieci = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => { probySieci.push('fetch'); throw Error('Sieć poza fixture jest zabroniona'); });
  vi.spyOn(Socket.prototype, 'connect').mockImplementation(() => { probySieci.push('socket'); throw Error('Socket poza fixture jest zabroniony'); });
});
afterEach(() => {
  try { expect(probySieci).toEqual([]); }
  finally { vi.restoreAllMocks(); }
});

describe('zamrożony kontrakt kanałów: USER_AGENT i OD', () => {
  it('waliduje i przycina USER_AGENT Allegro pod dynamicznym prefiksem, bez wartości w odmowie', () => {
    const poprawne = konfiguracjaKanalow(allegro, { ...pelneAllegro,
      RYNEK_NOCNY_USER_AGENT: '  Fixture/1.0 (+https://fixture.invalid/docs)  ', RYNEK_NOCNY_OD: '2026-02-28' });
    expect(poprawne.kanaly.rynek.userAgent).toBe('Fixture/1.0 (+https://fixture.invalid/docs)');
    for (const surowe of ['bez-wersji', 'Fixture/1.0 (https://fixture.invalid)', ' SEKRET_UA ']) {
      let blad: Error | undefined;
      try { konfiguracjaKanalow(allegro, { ...pelneAllegro, RYNEK_NOCNY_USER_AGENT: surowe, RYNEK_NOCNY_OD: '2026-02-28' }); }
      catch (e) { blad = e as Error; }
      expect(blad?.message).toContain('RYNEK_NOCNY_USER_AGENT');
      expect(blad?.message).not.toContain(surowe.trim());
    }
  });

  it('normalizuje tylko istniejący kalendarzowy RRRR-MM-DD, Woo zostawia pustą podłogę jako null, Allegro wymaga jej', () => {
    expect(konfiguracjaKanalow(woo, { ...pelneWoo, SKLEP_NOCNY_OD: ' 2024-02-29 ' }).sklepy.sklep.od).toBe('2024-02-29T00:00:00');
    expect(konfiguracjaKanalow(woo, pelneWoo).sklepy.sklep.od).toBeNull();
    expect(konfiguracjaKanalow(woo, { ...pelneWoo, SKLEP_NOCNY_OD: '' }).sklepy.sklep.od).toBeNull();
    expect(() => konfiguracjaKanalow(allegro, { ...pelneAllegro, RYNEK_NOCNY_USER_AGENT: 'Fixture/1.0 (+https://fixture.invalid)' }))
      .toThrow('RYNEK_NOCNY_OD');
    for (const surowe of ['2025-02-29', '2026-02-30', '2026-2-03', '2026-02-03T00:00:00', '2026-02-03Z']) {
      expect(() => konfiguracjaKanalow(woo, { ...pelneWoo, SKLEP_NOCNY_OD: surowe })).toThrow('SKLEP_NOCNY_OD');
    }
  });

  it('realny zbudujOms odmawia złego USER_AGENT i daty przed dotknięciem DB', async () => {
    const moduly = [modulRdzen, createModulKanaly(allegro)] as ModulOms[];
    for (const nad of [
      { ...pelneAllegro, RYNEK_NOCNY_USER_AGENT: 'błędne', RYNEK_NOCNY_OD: '2026-02-28' },
      { ...pelneAllegro, RYNEK_NOCNY_USER_AGENT: 'Fixture/1.0 (+https://fixture.invalid)', RYNEK_NOCNY_OD: '2026-02-30' },
    ]) {
      let dotknietoDb = 0;
      await expect(zbudujOms({ moduly, env: { ...pelnyProdukt, ...nad }, get db(): never { dotknietoDb += 1; throw Error('Dotknięto DB'); } }))
        .rejects.toThrow(/RYNEK_NOCNY_(USER_AGENT|OD)/);
      expect(dotknietoDb).toBe(0);
    }
  });

  it('pełna kompozycja D01 odmawia obecnych błędnych UA/OD mimo brakującego poświadczenia, przed DB', async () => {
    for (const nad of [
      { ...pelneAllegro, RYNEK_NOCNY_CLIENT_SECRET: undefined, RYNEK_NOCNY_USER_AGENT: 'błędne', RYNEK_NOCNY_OD: '2026-02-28' },
      { ...pelneAllegro, RYNEK_NOCNY_CLIENT_SECRET: undefined, RYNEK_NOCNY_USER_AGENT: 'Fixture/1.0 (+https://fixture.invalid)', RYNEK_NOCNY_OD: '2026-02-30' },
    ]) {
      let dotknietoDb = 0;
      await expect(zbudujOms({ env: { ...pelnyProdukt, OMS_KANALY: JSON.stringify(allegro), ...nad }, get db(): never {
        dotknietoDb += 1; throw Error('Dotknięto DB');
      } })).rejects.toThrow(/RYNEK_NOCNY_(USER_AGENT|OD)/);
      expect(dotknietoDb).toBe(0);
    }
  });

  it('realna fabryka i poller Woo przekazują znormalizowaną datę do modified_after bez sieci', async () => {
    const fetch = vi.fn(async (wejscie: string | URL) => {
      const url = new URL(String(wejscie));
      expect(url.hostname).toBe('sklep.invalid');
      return new Response('[]', { headers: { 'X-WP-TotalPages': '1' } });
    });
    const moduly = [modulRdzen, createModulKanaly(woo, false, { fetchImpl: fetch as typeof globalThis.fetch })] as ModulOms[];
    const a = await zbudujOms({ moduly, env: { ...pelnyProdukt, ...pelneWoo, SKLEP_NOCNY_OD: ' 2024-02-29 ' } });
    try {
      await a.usluga<any>('kanaly', 'poller').przebieg();
      expect(fetch).toHaveBeenCalledOnce();
      const url = new URL(String(fetch.mock.calls[0][0]));
      expect(url.searchParams.get('modified_after')).toBe('2024-02-29T00:00:00');
      expect(url.searchParams.get('dates_are_gmt')).toBe('true');
    } finally { await a.app.close(); a.db.close(); }
  });

  it('realna fabryka i poller Woo zachowują historyczny brak podłogi: null i brak modified_after', async () => {
    const fetch = vi.fn(async (_wejscie: string | URL) => new Response('[]', { headers: { 'X-WP-TotalPages': '1' } }));
    const moduly = [modulRdzen, createModulKanaly(woo, false, { fetchImpl: fetch as typeof globalThis.fetch })] as ModulOms[];
    const a = await zbudujOms({ moduly, env: { ...pelnyProdukt, ...pelneWoo } });
    try {
      expect(a.usluga<any>('kanaly', 'config').sklepy.sklep.od).toBeNull();
      await a.usluga<any>('kanaly', 'poller').przebieg();
      const url = new URL(String(fetch.mock.calls[0][0]));
      expect(url.searchParams.has('modified_after')).toBe(false);
      expect(url.searchParams.has('dates_are_gmt')).toBe(false);
    } finally { await a.app.close(); a.db.close(); }
  });
});
