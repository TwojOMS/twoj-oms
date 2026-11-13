import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { createModulFaktury } from '../../../src/moduly/faktury/modul.ts';
import { zapiszKonfiguracjeIntegracji } from '../../../src/oms/db/konfiguracja-integracji.js';
const KATALOG = mkdtempSync(join(tmpdir(), 'prz119-06-proba-'));
const ENV = { OMS_PROFORMY_KATALOG: KATALOG, OMS_SPRZEDAWCA_NIP: '1234563218', OMS_RACHUNEK: '34109010140000000000000000' };
const TOKEN = 'zmyslony-token-polcien-0001';
const DOMENA = 'pracownia-polcien';
function zbuduj(modul: any, env: any, { wybor, infakt }: any = {}) {
  const db = openOmsDb();
  if (wybor) zapiszKonfiguracjeIntegracji(db, 'program_fakturowy', { ustawienia: { program: wybor }, sekrety: {} });
  zapiszKonfiguracjeIntegracji(db, 'fakturownia', { ustawienia: { domena: DOMENA }, sekrety: { token: TOKEN } });
  if (infakt) zapiszKonfiguracjeIntegracji(db, 'infakt', { ustawienia: {}, sekrety: { apiKey: infakt } });
  const obce: any = { 'kanaly.klienciKanalow': { lampy: {} }, 'kanaly.config': { definicje: [], sklepy: {} } };
  const usluga = (m: string, n: string) => { const k = `${m}.${n}`; if (!Object.hasOwn(obce, k)) throw new Error(k); return obce[k]; };
  return { db, z: modul.zbuduj({ db, konfiguracja: modul.konfiguracja(env), teraz: () => new Date('2026-11-12T10:00:00Z'), log: () => {}, usluga }) };
}
let siec: any;
beforeEach(() => { siec = vi.fn(async () => new Response('[]', { status: 200 })); vi.stubGlobal('fetch', siec); });
afterEach(() => vi.unstubAllGlobals());
describe('PRZ-119.06: sprawdzenie połączenia w próbie bez atrapy', () => {
  for (const [opis, env, opc] of [
    ['próba, program inFakt (klucz)', { ...ENV, OMS_TRYB: 'proba' }, { infakt: 'klucz-infakt-zmyslony-1' }],
    ['próba, program fakturownia', { ...ENV, OMS_TRYB: 'proba', OMS_PROGRAM_FAKTUROWY: 'fakturownia' }, {}],
    ['próba, nic nie wybrano', { ...ENV, OMS_TRYB: 'proba' }, {}],
  ] as const) {
    it(`${opis}: sprawdzenie ekranu bez atrapy nie idzie do sieci`, async () => {
      const { db, z } = zbuduj(createModulFaktury(), env, opc);
      try {
        const e = await z.uslugi.konfiguracjaFakturowni.sprawdzPolaczenie().catch((x: any) => x);
        expect(e).toBeInstanceOf(Error);
        expect(String(e.message)).not.toContain(TOKEN);
        expect(siec).not.toHaveBeenCalled();
      } finally { db.close(); }
    });
  }
  it('produkcja, program inFakt: sprawdzenie ekranu robi jeden GET', async () => {
    const { db, z } = zbuduj(createModulFaktury(), ENV, { infakt: 'klucz-infakt-zmyslony-1' });
    try {
      await z.uslugi.konfiguracjaFakturowni.sprawdzPolaczenie();
      expect(siec).toHaveBeenCalledTimes(1);
      expect(siec.mock.calls[0][1].method).toBe('GET');
      expect(z.uslugi.konfiguracjaFakturowni.wymagaRestartu()).toBe(true);
    } finally { db.close(); }
  });
});
