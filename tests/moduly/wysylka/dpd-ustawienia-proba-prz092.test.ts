// PRZ-092 — piaskownica (OMS_TRYB=proba) bez atrapy DPD nie zbuduje prawdziwego klienta DPD z danych wpisanych
// w Ustawieniach: dane z :3005 nie mogą wyjść do DPD. Piaskownica składa moduł wysyłki z atrapą (deploy/proba/atrapy).
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

const NADAWCA = { DPD_NADAWCA_NAZWA: 'N', DPD_NADAWCA_ULICA: 'U 1', DPD_NADAWCA_KOD: '00-001', DPD_NADAWCA_MIASTO: 'M' };

function zbuduj(modul: ReturnType<typeof createModulWysylka>, env: Record<string, string>) {
  const db = openOmsDb();
  zapiszKonfiguracjeIntegracji(db, 'dpd', { ustawienia: { nazwa: 'DPD', login: 'l', fid: '1', typEtykiety: 'LBL_PRINTER' },
    sekrety: { haslo: 'h', kanal: '' } });
  const uslugi: Record<string, unknown> = {
    'kanaly.klienciSklepow': { sklep: {} }, 'kanaly.klienciKanalow': {}, 'rdzen.sprzedawca': { rachunek: '' },
    'kanaly.config': { definicje: [], sklepy: {} }, 'faktury.infakt': null, 'faktury.puls': createPuls({ teraz: () => new Date() }),
  };
  const z = modul.zbuduj({ db, konfiguracja: modul.konfiguracja({ ...NADAWCA, ...env, OMS_ETYKIETY_KATALOG: mkdtempSync(join(tmpdir(), 'prz-092-')) }),
    teraz: () => new Date(), log: () => {}, usluga: <T>(m: string, n: string) => uslugi[`${m}.${n}`] as T });
  return { db, kurierzy: z.uslugi?.kurierzy as Record<string, any> };
}

// Recenzja PRZ-092 (P2): czuwacz przesyłek powstaje przy starcie tylko z kurierem. DPD dodane potem z Ustawień
// nie może po 3 h dać alarmu „ani jednego udanego przebiegu” ani zgasić uwagi „Nadawanie nie jest skonfigurowane”.
it('zdrowie po dodaniu DPD bez restartu: bez fałszywego alarmu czuwacza, uwaga o nadawaniu zostaje', () => {
  const db = openOmsDb();
  let teraz = new Date('2026-10-17T10:00:00Z');
  const puls = createPuls({ teraz: () => teraz });
  const uslugi: Record<string, unknown> = {
    'kanaly.klienciSklepow': { sklep: {} }, 'kanaly.klienciKanalow': {}, 'rdzen.sprzedawca': { rachunek: '' },
    'kanaly.config': { definicje: [], sklepy: {} }, 'faktury.infakt': null, 'faktury.puls': puls,
  };
  const modul = createModulWysylka({ fabryki: { createDpd: () => ({ nadaj: vi.fn(), statusPrzesylki: vi.fn() }) as any } });
  const z = modul.zbuduj({ db, konfiguracja: modul.konfiguracja({ ...NADAWCA, OMS_ETYKIETY_KATALOG: mkdtempSync(join(tmpdir(), 'prz-092-')) }),
    teraz: () => teraz, log: () => {}, usluga: <T>(m: string, n: string) => uslugi[`${m}.${n}`] as T });
  expect(z.zdrowie?.().uwagi).toContain('Nadawanie nie jest skonfigurowane.');
  zapiszKonfiguracjeIntegracji(db, 'dpd', { ustawienia: { nazwa: 'DPD', login: 'l', fid: '1', typEtykiety: 'LBL_PRINTER' },
    sekrety: { haslo: 'h', kanal: '' } });
  (z.uslugi as any).kurierDpd.odswiez(); // to samo woła zapis formularza (trasy/ustawienia-dpd.js)
  expect((z.uslugi?.kurierzy as any).dpd).toBeDefined();
  teraz = new Date('2026-10-17T14:30:00Z');
  const ocena = z.zdrowie!();
  expect(ocena.alarmy).toEqual([]);
  expect(ocena.uwagi).toContain('Nadawanie nie jest skonfigurowane.');
  db.close();
});

describe('PRZ-092 piaskownica a DPD z Ustawień', () => {
  it('bez atrapy: odmowa „Piaskownica”, ani jednego żądania sieciowego', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    try {
      const { db, kurierzy } = zbuduj(createModulWysylka(), { OMS_TRYB: 'proba' });
      await expect(kurierzy.dpd.sprawdzPolaczenie()).rejects.toThrow('Piaskownica');
      await expect(kurierzy.dpd.nadaj({})).rejects.toMatchObject({ status: 400 });
      expect(fetch).not.toHaveBeenCalled();
      db.close();
    } finally { vi.unstubAllGlobals(); }
  });

  it('moduły piaskownicy składają wysyłkę z atrapą DPD (sprawdzenie przechodzi, nadanie odmawia)', async () => {
    const env = { ...ENV_DEMO, OMS_TRYB: 'proba' };
    const wysylka = modulyPiaskownicy(env).find((m: { nazwa: string }) => m.nazwa === 'wysylka') as ReturnType<typeof createModulWysylka>;
    const { db, kurierzy } = zbuduj(wysylka, env);
    await expect(kurierzy.dpd.sprawdzPolaczenie()).resolves.toEqual({ ok: true });
    await expect(kurierzy.dpd.nadaj({})).rejects.toThrow('atrapa DPD nie nadaje');
    db.close();
  });
});
