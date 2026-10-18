// PRZ-093.10 — piaskownica i demo (OMS_TRYB=proba) a inFakt z Ustawień: klucz wpisany na :3005 albo na demo nie może
// wyjść do inFaktu. Bez atrapy — odmowa „Piaskownica” zamiast prawdziwego klienta; z atrapą (deploy/proba/atrapy/
// infakt.mjs, złożoną przez modulyPiaskownicy) — zawsze atrapa, także gdy w bazie leży zapis z ekranu.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { createModulFaktury } from '../../../src/moduly/faktury/modul.ts';
import { zapiszKonfiguracjeIntegracji } from '../../../src/oms/db/konfiguracja-integracji.js';
import { modulyPiaskownicy } from '../../../deploy/proba/atrapy/index.mjs';
import { ENV_DEMO } from '../../../scripts/demo-dane.mjs';

const ENV = { OMS_PROFORMY_KATALOG: mkdtempSync(join(tmpdir(), 'prz-093-10-proba-')), OMS_SPRZEDAWCA_NIP: '1234563218',
  OMS_RACHUNEK: '34109010140000000000000000', OMS_TRYB: 'proba' };
const usluga = <T>(m: string, n: string) => {
  const uslugi: Record<string, unknown> = { 'kanaly.klienciKanalow': {}, 'kanaly.config': { definicje: [], sklepy: {} } };
  const k = `${m}.${n}`; if (!Object.hasOwn(uslugi, k)) throw new Error(k); return uslugi[k] as T;
};

function zbuduj(modul: ReturnType<typeof createModulFaktury>, env: Record<string, string>, klucz = 'zmyslony0klucz0proby0infakt0000000000f6') {
  const db = openOmsDb();
  zapiszKonfiguracjeIntegracji(db, 'infakt', { ustawienia: {}, sekrety: { apiKey: klucz } });
  const z = modul.zbuduj({ db, konfiguracja: modul.konfiguracja(env), teraz: () => new Date(), log: () => {}, usluga } as any) as any;
  return { db, uslugi: z.uslugi };
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('PRZ-093.10 piaskownica a inFakt z Ustawień', () => {
  it('bez atrapy: każda metoda i sprawdzenie odmawiają „Piaskownica”, ani jednego żądania sieciowego', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const { db, uslugi } = zbuduj(createModulFaktury(), ENV);
    expect(uslugi.infakt).not.toBeNull();
    for (const metoda of ['listaFaktur', 'wystaw', 'pobierzPdf', 'wyslijDokumentDoKsef', 'sprawdzPolaczenie']) {
      await expect(uslugi.infakt[metoda]({}), metoda).rejects.toThrow('Piaskownica');
    }
    await expect(uslugi.konfiguracjaInfaktu.sprawdzPolaczenie()).rejects.toThrow('Piaskownica');
    // VIES powstaje razem z inFaktem — w próbie bez atrapy też nie może wyjść z panelu.
    await expect(uslugi.vies.sprawdz('DE123456789')).rejects.toThrow('Piaskownica');
    expect(fetch).not.toHaveBeenCalled();
    db.close();
  });

  it('moduły piaskownicy: zapis z ekranu nie podmienia atrapy — usługi i sprawdzenie idą do atrapy', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const env = { ...ENV_DEMO, OMS_TRYB: 'proba', OMS_PROFORMY_KATALOG: ENV.OMS_PROFORMY_KATALOG };
    const faktury = modulyPiaskownicy(env).find((m: { nazwa: string }) => m.nazwa === 'faktury') as ReturnType<typeof createModulFaktury>;
    const { db, uslugi } = zbuduj(faktury, env);
    expect(uslugi.infakt.atrapa).toBe(true);
    await expect(uslugi.konfiguracjaInfaktu.sprawdzPolaczenie()).resolves.toEqual({ ok: true });
    expect(uslugi.konfiguracjaInfaktu.wymagaRestartu()).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
    db.close();
    // Klucz z „zle” udaje odrzucony klucz — żeby na demo dało się obejrzeć komunikat błędu.
    const zly = zbuduj(faktury, env, 'zmyslony0zle0klucz0proby0infakt000000g7');
    await expect(zly.uslugi.konfiguracjaInfaktu.sprawdzPolaczenie()).rejects.toThrow('nie przyjął klucza API');
    zly.db.close();
    expect(fetch).not.toHaveBeenCalled();
  });
});
