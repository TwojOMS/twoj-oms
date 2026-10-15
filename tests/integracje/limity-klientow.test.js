import { describe, it, expect, vi, afterAll } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, writeFileSync, unlinkSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWooClient } from '../../src/oms/woo/client.js';
import { createMetaClient } from '../../src/oms/meta/client.js';
import { createGa4Client } from '../../src/oms/ga4/client.js';
import { createApiloClient } from '../../src/oms/apilo/client.js';
import { createTokeny } from '../../src/oms/allegro/tokeny.js';

const katalog = mkdtempSync(join(tmpdir(), 'prz012-'));
const sciezkaKlucza = join(katalog, 'test.json');
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
writeFileSync(sciezkaKlucza, JSON.stringify({ client_email: 'test@przyklad.invalid', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) }));
afterAll(() => { unlinkSync(sciezkaKlucza); rmdirSync(katalog); });

const przypadki = [
  ['Woo', (o) => () => createWooClient({ baseUrl: 'https://przyklad.invalid', ck: 'x', cs: 'y', ...o }).pobierzZamowienia()],
  ['Meta', (o) => () => createMetaClient({ token: 'x', konta: ['act_1'], baseUrl: 'https://przyklad.invalid', ...o }).dzienneStatystyki({ od: '2026-01-01', do: '2026-01-02' })],
  ['GA4', (o) => () => createGa4Client({ sciezkaKlucza, authUrl: 'https://przyklad.invalid/token', baseUrl: 'https://przyklad.invalid', ...o }).dzienneStatystyki({ wlasciwosc: '1', od: '2026-01-01', do: '2026-01-02' })],
  ['Apilo', (o) => () => createApiloClient({ host: 'https://przyklad.invalid', credentialsPath: 'nieczytany', readFile: () => JSON.stringify({ accessToken: 'x', accessTokenExpireAt: '2099-01-01' }), ...o }).request('GET', '/rest/order/')],
  ['Allegro tokeny', (o) => () => createTokeny({ db: {}, kanal: 'test', ustawienia: { auth: 'https://przyklad.invalid', clientId: 'x', clientSecret: 'y', userAgent: 'Test/1 (+https://przyklad.invalid)' }, ...o }).rozpocznijPowiazanie()],
];

describe.each(przypadki)('%s — wspólny transport', (nazwa, buduj) => {
  it('ma limit 30 sekund i przerywa wiszące żądanie', async () => {
    const kontroler = new AbortController();
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(kontroler.signal);
    const f = vi.fn((url, init) => new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new Error('test przerwania')), { once: true });
    }));
    vi.stubGlobal('fetch', f);
    try {
      const wynik = buduj({})().then(wartosc => ({wartosc}), blad => ({blad}));
      await vi.waitFor(() => expect(f).toHaveBeenCalledTimes(1));
      expect(timeout).toHaveBeenCalledWith(30_000);
      expect(f.mock.calls[0][1].signal).toBe(kontroler.signal);
      kontroler.abort();
      expect((await wynik).blad?.message).toMatch(/limit czasu/);
      expect(f).toHaveBeenCalledTimes(1);
    } finally { timeout.mockRestore(); vi.unstubAllGlobals(); }
  });
  it('przyjmuje http i nie sięga po globalny fetch', async () => {
    const f = vi.fn(() => { throw new Error('Niedozwolona prawdziwa sieć'); });
    const http = vi.fn(async () => { throw new Error('podstawione http'); });
    vi.stubGlobal('fetch', f);
    try {
      await expect(buduj({ http })()).rejects.toThrow(/podstawione http/);
      expect(http).toHaveBeenCalledTimes(1);
      expect(f).not.toHaveBeenCalled();
    } finally { vi.unstubAllGlobals(); }
  });
});
