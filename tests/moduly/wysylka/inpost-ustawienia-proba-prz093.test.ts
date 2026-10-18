// PRZ-093.09 — piaskownica (OMS_TRYB=proba) a InPost z Ustawień: bez atrapy żadnego prawdziwego klienta InPost
// z danych wpisanych na :3005 (token nie może wyjść do InPostu); z atrapą (deploy/proba/atrapy/inpost.mjs)
// sprawdzenie przechodzi, a nadanie odmawia czytelnie. Wzór: dpd-ustawienia-proba-prz092.test.ts.
import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { createModulWysylka } from '../../../src/moduly/wysylka/modul.ts';
import { createPuls } from '../../../src/core/puls.js';
import { zapiszKonfiguracjeIntegracji } from '../../../src/oms/db/konfiguracja-integracji.js';
import { modulyPiaskownicy } from '../../../deploy/proba/atrapy/index.mjs';
import { ENV_DEMO } from '../../../scripts/demo-dane.mjs';

const NADAWCA = { DPD_NADAWCA_NAZWA: 'N', DPD_NADAWCA_ULICA: 'U 1', DPD_NADAWCA_KOD: '00-001', DPD_NADAWCA_MIASTO: 'M',
  DPD_NADAWCA_TELEFON: '000000000', DPD_NADAWCA_EMAIL: 'n@example.invalid' };

function zbuduj(modul: ReturnType<typeof createModulWysylka>, env: Record<string, string>, token = 'eyJ.zmyslony') {
  const db = openOmsDb();
  zapiszKonfiguracjeIntegracji(db, 'inpost', { ustawienia: { nazwa: 'InPost', organizacja: '4242', paczkomatNadawczy: '' },
    sekrety: { token } });
  const uslugi: Record<string, unknown> = {
    'kanaly.klienciSklepow': { sklep: {} }, 'kanaly.klienciKanalow': {}, 'rdzen.sprzedawca': { rachunek: '' },
    'kanaly.config': { definicje: [], sklepy: {} }, 'faktury.infakt': null, 'faktury.puls': createPuls({ teraz: () => new Date() }),
  };
  const z = modul.zbuduj({ db, konfiguracja: modul.konfiguracja({ ...NADAWCA, ...env, OMS_ETYKIETY_KATALOG: mkdtempSync(join(tmpdir(), 'prz-093-09-')) }),
    teraz: () => new Date(), log: () => {}, usluga: <T>(m: string, n: string) => uslugi[`${m}.${n}`] as T } as any);
  return { db, kurierzy: (z as any).uslugi.kurierzy as Record<string, any> };
}

describe('PRZ-093.09 piaskownica a InPost z Ustawień', () => {
  it('bez atrapy: odmowa „Piaskownica” na każdej metodzie, ani jednego żądania sieciowego', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    try {
      const { db, kurierzy } = zbuduj(createModulWysylka(), { OMS_TRYB: 'proba' });
      await expect(kurierzy.inpost.sprawdzPolaczenie()).rejects.toThrow('Piaskownica');
      await expect(kurierzy.inpost.nadaj({})).rejects.toMatchObject({ status: 400 });
      await expect(kurierzy.inpost.sprawdzPrzesylke('1')).rejects.toThrow('Piaskownica');
      await expect(kurierzy.inpost.statusPrzesylki('1')).rejects.toThrow('Piaskownica');
      expect(fetch).not.toHaveBeenCalled();
      db.close();
    } finally { vi.unstubAllGlobals(); }
  });

  it('moduły piaskownicy składają wysyłkę z atrapą InPost (sprawdzenie przechodzi, nadanie odmawia czytelnie)', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    try {
      const env = { ...ENV_DEMO, OMS_TRYB: 'proba' };
      const wysylka = modulyPiaskownicy(env).find((m: { nazwa: string }) => m.nazwa === 'wysylka') as ReturnType<typeof createModulWysylka>;
      const { db, kurierzy } = zbuduj(wysylka, env);
      await expect(kurierzy.inpost.sprawdzPolaczenie()).resolves.toEqual({ ok: true });
      const e = await kurierzy.inpost.nadaj({}).catch((x: unknown) => x);
      expect(e).toMatchObject({ status: 400, dlaOperatora: true });
      expect((e as Error).message).toContain('Piaskownica: atrapa InPost nie nadaje');
      expect(fetch).not.toHaveBeenCalled();
      db.close();
      const zly = zbuduj(wysylka, env, 'eyJ.zle.zmyslony');
      await expect(zly.kurierzy.inpost.sprawdzPolaczenie()).rejects.toThrow('odrzucił');
      zly.db.close();
    } finally { vi.unstubAllGlobals(); }
  });
});
