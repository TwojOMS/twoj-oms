import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Socket } from 'node:net';
import { zbudujOms } from '../../../src/oms/bootstrap.ts';
import { wczytajRaporty } from '../../../src/moduly/raporty/konfiguracja.ts';

const marker = 'RAPORTY_JSON_MARKER_NIE_WYPISUJ';
const env = {
  OMS_TRYB: 'produkcja', OMS_DB_PATH: ':memory:', OMS_USER: 'operator', OMS_PASS: 'fixture',
  OMS_SPRZEDAWCA_NIP: '1234563218', OMS_RACHUNEK: '34109010140000000000000000',
  OMS_PROFORMY_KATALOG: '/synthetic/unused', OMS_KANALY: '[]', OMS_ETYKIETY_KATALOG: '/synthetic/labels',
};
let proby: string[];
beforeEach(() => {
  proby = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => { proby.push('fetch'); throw Error('Sieć zabroniona'); });
  vi.spyOn(Socket.prototype, 'connect').mockImplementation(() => { proby.push('socket'); throw Error('Sieć zabroniona'); });
});
afterEach(() => { vi.restoreAllMocks(); expect(proby).toEqual([]); });
function komunikat(f: () => unknown): string {
  try { f(); } catch (e) { return (e as Error).message; }
  throw Error('Oczekiwano odmowy konfiguracji');
}

it('wadliwe nazwy kanałów oddają wyłącznie nazwany błąd bez wartości wejściowej', () => {
  const blad = komunikat(() => wczytajRaporty({ OMS_RAPORTY_NAZWY_KANALOW: `${marker}{` }));
  expect(blad).toBe('OMS_RAPORTY_NAZWY_KANALOW: niepoprawny JSON');
  expect(blad).not.toContain(marker);
});

it('rzeczywisty startup agreguje nazwany błąd i nie ujawnia markera', async () => {
  let blad: unknown;
  let aplikacja: Awaited<ReturnType<typeof zbudujOms>> | undefined;
  try { aplikacja = await zbudujOms({ env: { ...env, OMS_RAPORTY_NAZWY_KANALOW: `${marker}{` } }); }
  catch (e) { blad = e; }
  finally { if (aplikacja) { await aplikacja.app.close(); aplikacja.db.close(); } }
  expect(blad).toBeInstanceOf(Error);
  expect((blad as Error).message).toContain('[raporty] OMS_RAPORTY_NAZWY_KANALOW: niepoprawny JSON');
  expect((blad as Error).message).not.toContain(marker);
  expect((blad as Error).message).not.toMatch(/SyntaxError/i);
});
