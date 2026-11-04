// PRZ-135.01 — ZŁOTE TESTY modułu wysyłki (stan z fb84a210): odmowy piaskownicy bez atrap i klucze integracji.
import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const przechwycone = vi.hoisted(() => ({ dpd: null as null | ((o: any) => any), inpost: null as null | ((o: any) => any) }));
vi.mock('../../../src/moduly/wysylka/kurierzy.ts', async (oryg) => {
  const m = await oryg<typeof import('../../../src/moduly/wysylka/kurierzy.ts')>();
  return {
    ...m,
    kurierDpdZUstawien: (a: any) => { przechwycone.dpd = a.fabryka; return m.kurierDpdZUstawien(a); },
    kurierInpostZUstawien: (a: any) => { przechwycone.inpost = a.fabryka; return m.kurierInpostZUstawien(a); },
  };
});

import { openOmsDb } from '../../../src/oms/db/db.ts';
import { createModulWysylka } from '../../../src/moduly/wysylka/modul.ts';
import { createPuls } from '../../../src/core/puls.js';

function zbudujWProbie() {
  const db = openOmsDb();
  const uslugi: Record<string, unknown> = {
    'kanaly.klienciSklepow': { sklep: {} }, 'kanaly.klienciKanalow': {}, 'rdzen.sprzedawca': { rachunek: '' },
    'kanaly.config': { definicje: [], sklepy: {} }, 'faktury.infakt': null, 'faktury.puls': createPuls({ teraz: () => new Date() }),
  };
  const modul = createModulWysylka();
  modul.zbuduj({ db, konfiguracja: modul.konfiguracja({ OMS_TRYB: 'proba', OMS_ETYKIETY_KATALOG: mkdtempSync(join(tmpdir(), 'prz-135-')) }),
    teraz: () => new Date(), log: () => {}, usluga: <T>(m: string, n: string) => uslugi[`${m}.${n}`] as T });
  db.close();
}

describe('piaskownica bez fabryk — odmowy DPD i InPost', () => {
  it('DPD: dokładnie 3 metody, każda odrzuca dosłownym tekstem ze statusem 400', async () => {
    zbudujWProbie();
    const odmowa: any = przechwycone.dpd!({});
    expect(Object.keys(odmowa).sort()).toEqual(['nadaj', 'sprawdzPolaczenie', 'statusPrzesylki']);
    for (const m of Object.keys(odmowa)) {
      await expect(odmowa[m]()).rejects.toMatchObject({
        message: 'Piaskownica: prawdziwe DPD jest tu wyłączone — nic nie poszło do DPD.', status: 400 });
    }
  });

  it('InPost: dokładnie 5 metod, każda odrzuca dosłownym tekstem ze statusem 400', async () => {
    zbudujWProbie();
    const odmowa: any = przechwycone.inpost!({});
    expect(Object.keys(odmowa).sort()).toEqual(['nadaj', 'pobierzEtykiete', 'sprawdzPolaczenie', 'sprawdzPrzesylke', 'statusPrzesylki']);
    for (const m of Object.keys(odmowa)) {
      await expect(odmowa[m]()).rejects.toMatchObject({
        message: 'Piaskownica: prawdziwy InPost jest tu wyłączony — nic nie poszło do InPostu.', status: 400 });
    }
  });
});

describe('kluczeIntegracji modułu wysyłki', () => {
  it('lista dosłownie', () => {
    expect(createModulWysylka().kluczeIntegracji).toEqual(['DPD_LOGIN', 'DPD_PASSWORD', 'INPOST_TOKEN', 'ALLEGRO_CLIENT_ID', 'ALLEGRO_CLIENT_SECRET', 'INFAKT_API_KEY']);
  });
});
