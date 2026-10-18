import { afterEach, expect, it, vi } from 'vitest';
import { tmpdir } from 'node:os';
import { zbudujOms } from '../../../src/oms/bootstrap.ts';
import * as diagnostyka from '../../../src/oms/services/lacznosc.js';
import { zapiszKonfiguracjeIntegracji, usunKonfiguracjeIntegracji } from '../../../src/oms/db/konfiguracja-integracji.js';
import { opcjeKlientaDpd } from '../../../src/domena/konfiguracja-dpd.js';
import { opcjeKlientaInpost } from '../../../src/domena/konfiguracja-inpost.js';
import { opcjeKlientaInfakt } from '../../../src/domena/konfiguracja-infakt.js';

const env = { OMS_TRYB: 'produkcja', OMS_DB_PATH: ':memory:', OMS_USER: 'operator', OMS_PASS: 'atrapa',
  OMS_SPRZEDAWCA_NIP: '1234563218', OMS_RACHUNEK: '34109010140000000000000000',
  OMS_PROFORMY_KATALOG: tmpdir(), OMS_ETYKIETY_KATALOG: tmpdir() };
const zapis = { ustawienia: { login: 'operator-demo', fid: '1', organizacja: '1', typEtykiety: 'LBL_PRINTER' },
  sekrety: { haslo: 'sekret-testowy-dpd', kanal: 'sekret-testowy-kanal', token: 'sekret-testowy-inpost', apiKey: 'sekret-testowy-infakt' } };
afterEach(() => vi.restoreAllMocks());

it.each([
  ['dpd', 'DPD', opcjeKlientaDpd(zapis, null).url],
  ['infakt', 'inFakt', opcjeKlientaInfakt(zapis).baseUrl],
  ['inpost', 'InPost', opcjeKlientaInpost(zapis, null).url],
])('Łączność czyta %s z panelu przy każdym otwarciu, bez sekretów', async (klucz, nazwa, url) => {
  const pomiar = vi.spyOn(diagnostyka, 'sprawdzLacznosc').mockImplementation(async ({ cele }: any) =>
    cele.map((cel: any) => ({ ...cel, ok: true, status: 200, komunikat: '' })));
  const log = vi.fn();
  const a = await zbudujOms({ env, log });
  const headers = { authorization: 'Basic ' + Buffer.from('operator:atrapa').toString('base64') };
  try {
    await a.app.inject({ url: '/ustawienia/lacznosc', headers });
    expect(pomiar.mock.calls.at(-1)?.[0]?.cele).toEqual([]);
    zapiszKonfiguracjeIntegracji(a.db, klucz, zapis);
    const r = await a.app.inject({ url: '/ustawienia/lacznosc', headers });
    expect(r.statusCode).toBe(200);
    expect(pomiar.mock.calls.at(-1)?.[0]?.cele).toEqual([{ klucz, nazwa, url, host: new URL(url).hostname }]);
    expect(r.body).toContain(`<strong>${nazwa}</strong>`);
    for (const sekret of Object.values(zapis.sekrety)) {
      expect(r.body).not.toContain(sekret);
      expect(JSON.stringify(pomiar.mock.calls)).not.toContain(sekret);
      expect(JSON.stringify(log.mock.calls)).not.toContain(sekret);
    }
    usunKonfiguracjeIntegracji(a.db, klucz);
    await a.app.inject({ url: '/ustawienia/lacznosc', headers });
    expect(pomiar.mock.calls.at(-1)?.[0]?.cele).toEqual([]);
  } finally { await a.app.close(); a.db.close(); }
});

it('plik wygrywa z panelem: jeden cel dla każdej integracji, dotychczasowa kolejność', async () => {
  const pomiar = vi.spyOn(diagnostyka, 'sprawdzLacznosc').mockResolvedValue([]);
  const a = await zbudujOms({ env: { ...env, INFAKT_API_KEY: 'atrapa', INFAKT_API_URL: 'https://infakt.invalid/api',
    DPD_URL: 'https://dpd.invalid/ws', DPD_LOGIN: 'atrapa', DPD_PASSWORD: 'atrapa', DPD_FID: '1',
    DPD_INFO_URL: 'https://dpd-info.invalid/ws', DPD_INFO_CHANNEL: 'atrapa',
    DPD_NADAWCA_NAZWA: 'Pracownia Przykładowa', DPD_NADAWCA_ULICA: 'Testowa 1', DPD_NADAWCA_KOD: '00-001', DPD_NADAWCA_MIASTO: 'Test',
    INPOST_TOKEN: 'atrapa', INPOST_ORGANIZACJA: '1', INPOST_URL: 'https://inpost.invalid/v1' } });
  try {
    for (const klucz of ['dpd', 'inpost', 'infakt']) zapiszKonfiguracjeIntegracji(a.db, klucz, zapis);
    await a.usluga<{ sprawdz: () => Promise<unknown> }>('ustawienia', 'lacznosc').sprawdz();
    expect(pomiar.mock.calls[0][0]?.cele).toEqual([
      { klucz: 'infakt', nazwa: 'inFakt', url: 'https://infakt.invalid/api', host: 'infakt.invalid' },
      { klucz: 'dpd', nazwa: 'DPD', url: 'https://dpd.invalid/ws', host: 'dpd.invalid' },
      { klucz: 'inpost', nazwa: 'InPost', url: 'https://inpost.invalid/v1', host: 'inpost.invalid' },
    ]);
  } finally { await a.app.close(); a.db.close(); }
});
