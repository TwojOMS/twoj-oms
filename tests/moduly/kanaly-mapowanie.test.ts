import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Socket } from 'node:net';
import { zbudujOms } from '../../src/oms/bootstrap.ts';
import { konfiguracjaKanalow } from '../../src/moduly/kanaly/konfiguracja.ts';

const env = { OMS_TRYB: 'produkcja', OMS_DB_PATH: ':memory:', OMS_USER: 'operator', OMS_PASS: 'fixture',
  OMS_SPRZEDAWCA_NIP: '1234563218', OMS_RACHUNEK: '34109010140000000000000000',
  OMS_PROFORMY_KATALOG: '/synthetic/unused', OMS_KANALY: '[{"klucz":"sklep","typ":"woo","prefiks":"SKLEP"}]',
  SKLEP_URL: 'https://sklep.invalid', SKLEP_OD: '2026-01-01' };
let proby: string[];
beforeEach(() => {
  proby = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => { proby.push('fetch'); throw Error('Sieć zabroniona'); });
  vi.spyOn(Socket.prototype, 'connect').mockImplementation(() => { proby.push('socket'); throw Error('Sieć zabroniona'); });
});
afterEach(() => { vi.restoreAllMocks(); expect(proby).toEqual([]); });

it('rzeczywisty bootstrap odmawia obecnego uszkodzonego JSON mimo braku CK/CS', async () => {
  let blad: unknown;
  let a: Awaited<ReturnType<typeof zbudujOms>> | undefined;
  try { a = await zbudujOms({ env: { ...env, SKLEP_MAPOWANIE: 'SYNTHETIC_SECRET_JSON{' } }); }
  catch (e) { blad = e; }
  finally { if (a) { await a.app.close(); a.db.close(); } }
  expect(blad).toBeInstanceOf(Error);
  expect((blad as Error).message).toContain('SKLEP_MAPOWANIE: niepoprawny JSON');
  expect((blad as Error).message).not.toContain('SYNTHETIC');
});
it('rzeczywisty bootstrap odmawia obecnego wadliwego kształtu mimo braku CK/CS', async () => {
  let blad: unknown;
  let a: Awaited<ReturnType<typeof zbudujOms>> | undefined;
  try { a = await zbudujOms({ env: { ...env, SKLEP_MAPOWANIE: 'null' } }); }
  catch (e) { blad = e; }
  finally { if (a) { await a.app.close(); a.db.close(); } }
  expect(blad).toBeInstanceOf(Error);
  expect((blad as Error).message).toContain('SKLEP_MAPOWANIE: oczekiwano instancje i poPozycji');
});
it.each([undefined, '', '   ', '{"instancje":[],"poPozycji":[]}'])('brak/puste lub poprawne częściowe mapowanie %s zostawia dostępny panel', async SKLEP_MAPOWANIE => {
  const a = await zbudujOms({ env: { ...env, SKLEP_MAPOWANIE } });
  try {
    expect(a.usluga<any>('kanaly', 'config').sklepy).toEqual({});
    expect((await a.app.inject({ method: 'GET', url: '/login' })).statusCode).toBe(200);
  } finally { await a.app.close(); a.db.close(); }
});
it('ścisły konfigurator bez CK/CS nadal pomija klienta bez parsowania mapowania', () => {
  expect(konfiguracjaKanalow([{ klucz: 'sklep', typ: 'woo', prefiks: 'SKLEP' }], { ...env, SKLEP_MAPOWANIE: 'SYNTHETIC{' }).sklepy).toEqual({});
});
