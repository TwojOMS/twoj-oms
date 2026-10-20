// PRZ-102.13 — Ustawienia → Diagnostyka widzi klucz GUS zapisany w panelu (Integracje → GUS), nie tylko GUS_KLUCZ z pliku.
// Prawdziwy bootstrap; pomiar łączności podmieniony, więc nic nie wychodzi do sieci. Klucze zmyślone.
import { it, expect, vi, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { zbudujOms } from '../../../src/oms/bootstrap.ts';
import * as diagnostyka from '../../../src/oms/services/lacznosc.js';
import { zapiszKonfiguracjeIntegracji, usunKonfiguracjeIntegracji } from '../../../src/oms/db/konfiguracja-integracji.js';
import { ADRES_GUS } from '../../../src/domena/konfiguracja-gus.js';

const KLUCZ_PANELU = 'zmyslony0panel0gus0a1';
const KLUCZ_PLIKU = 'zmyslony0plik0gus0b2';
const env: Record<string, string> = { OMS_TRYB: 'produkcja', OMS_DB_PATH: ':memory:', OMS_USER: 'operator', OMS_PASS: 'atrapa',
  OMS_SPRZEDAWCA_NIP: '1234563218', OMS_RACHUNEK: '34109010140000000000000000',
  OMS_PROFORMY_KATALOG: tmpdir(), OMS_ETYKIETY_KATALOG: tmpdir(),
  OMS_KANALY: '[{"klucz":"sklep","typ":"woo","prefiks":"SKLEP"}]',
  SKLEP_URL: 'https://sklep.invalid', SKLEP_CK: 'atrapa', SKLEP_CS: 'atrapa', SKLEP_OD: '2026-01-01',
  SKLEP_MAPOWANIE: '{"instancje":{},"poPozycji":[]}' };

const otwarte: Array<() => Promise<void>> = [];
afterEach(async () => { vi.restoreAllMocks(); while (otwarte.length) await otwarte.pop()!(); });

async function diagnostyka_(dodatkowe: Record<string, string> = {}) {
  const pomiar = vi.spyOn(diagnostyka, 'sprawdzLacznosc').mockResolvedValue([]);
  const a = await zbudujOms({ env: { ...env, ...dodatkowe } as any });
  otwarte.push(async () => { await a.app.close(); a.db.close(); });
  /** Cele, które Diagnostyka dostałaby przy tym wejściu na ekran. */
  const cele = async () => {
    pomiar.mockClear();
    await a.usluga<{ sprawdz: () => Promise<unknown> }>('ustawienia', 'lacznosc').sprawdz();
    expect(pomiar).toHaveBeenCalledTimes(1);
    return (pomiar.mock.calls[0][0]?.cele ?? []) as Array<{ klucz: string; url: string; host: string; nazwa: string }>;
  };
  const gus = async () => (await cele()).filter((c) => c.klucz === 'gus');
  return { a, cele, gus };
}

it('bez klucza (ani w pliku, ani w panelu) Diagnostyka nie ma celu GUS', async () => {
  const { gus } = await diagnostyka_();
  expect(await gus()).toEqual([]);
});

it('klucz zapisany w panelu po starcie dodaje cel GUS przy następnym wejściu — bez restartu, adres domyślny, sekret nie w celach', async () => {
  const { a, gus, cele } = await diagnostyka_();
  expect(await gus()).toEqual([]);
  zapiszKonfiguracjeIntegracji(a.db, 'gus', { ustawienia: {}, sekrety: { klucz: KLUCZ_PANELU } });
  expect(await gus()).toEqual([
    { klucz: 'gus', nazwa: 'GUS (REGON)', url: ADRES_GUS, host: new URL(ADRES_GUS).hostname },
  ]);
  expect(JSON.stringify(await cele())).not.toContain(KLUCZ_PANELU);
  // usunięcie klucza z panelu zabiera cel od następnego wejścia
  usunKonfiguracjeIntegracji(a.db, 'gus');
  expect(await gus()).toEqual([]);
});

it('klucz z panelu + GUS_URL w pliku: cel pod adresem z pliku', async () => {
  const { a, gus } = await diagnostyka_({ GUS_URL: 'https://gus.invalid/ws' });
  zapiszKonfiguracjeIntegracji(a.db, 'gus', { ustawienia: {}, sekrety: { klucz: KLUCZ_PANELU } });
  expect(await gus()).toEqual([{ klucz: 'gus', nazwa: 'GUS (REGON)', url: 'https://gus.invalid/ws', host: 'gus.invalid' }]);
});

it('klucz w pliku działa jak dotąd (także z innym kluczem w panelu); sekret nie w celach', async () => {
  const { a, gus, cele } = await diagnostyka_({ GUS_KLUCZ: KLUCZ_PLIKU, GUS_URL: 'https://gus.invalid/ws' });
  expect(await gus()).toEqual([{ klucz: 'gus', nazwa: 'GUS (REGON)', url: 'https://gus.invalid/ws', host: 'gus.invalid' }]);
  zapiszKonfiguracjeIntegracji(a.db, 'gus', { ustawienia: {}, sekrety: { klucz: KLUCZ_PANELU } });
  expect(await gus()).toHaveLength(1);
  const wszystko = JSON.stringify(await cele());
  expect(wszystko).not.toContain(KLUCZ_PLIKU);
  expect(wszystko).not.toContain(KLUCZ_PANELU);
});
