import { access } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { MODULY_KURIEROW } from '../../src/domena/moduly-kurierow.ts';
import { createModulWysylka } from '../../src/moduly/wysylka/modul.ts';
import { openOmsDb } from '../../src/oms/db/db.ts';
import { zapiszKonfiguracjeIntegracji } from '../../src/oms/db/konfiguracja-integracji.js';
import { createPuls } from '../../src/core/puls.js';
import { fabrykiKurierowPiaskownicy } from '../../deploy/proba/atrapy/index.mjs';

describe('atrapy kurierów z rejestru', () => {
  it('każdy kurier z własną umową ma eksportowaną atrapę w fabrykach piaskownicy', async () => {
    const fabryki = fabrykiKurierowPiaskownicy({ env: { OMS_TRYB: 'proba' } });
    const kurierzy = Object.values(MODULY_KURIEROW).filter((opis) => opis.umowa === 'wlasna' && opis.metody.length);
    expect(kurierzy.length).toBeGreaterThan(0);
    for (const opis of kurierzy) {
      expect(opis.piaskownica.atrapa).toBeTruthy();
      const sciezka = resolve(opis.piaskownica.atrapa);
      await access(sciezka);
      const modul = await import(pathToFileURL(sciezka).href);
      expect(modul.createAtrapa).toEqual(expect.any(Function));
      const klucz = `create${opis.klucz[0].toUpperCase()}${opis.klucz.slice(1)}`;
      expect(fabryki[klucz]).toEqual(expect.any(Function));
      expect(fabryki[klucz]({}).atrapa).toBe(true);
      expect(Object.keys(fabryki[klucz]({})).sort()).toEqual(Object.keys(modul.createAtrapa({ env: { OMS_TRYB: 'proba' } })({})).sort());
    }
  });

  it('brak atrapy daje odmowę z komunikatem opisu', async () => {
    const db = openOmsDb();
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    try {
      zapiszKonfiguracjeIntegracji(db, 'dpd', { ustawienia: { nazwa: 'DPD', login: 'test', fid: '1', typEtykiety: 'A4' },
        sekrety: { haslo: 'test', kanal: '' } });
      zapiszKonfiguracjeIntegracji(db, 'inpost', { ustawienia: { nazwa: 'InPost', organizacja: '1', paczkomatNadawczy: '' },
        sekrety: { token: 'test' } });
      const modul = createModulWysylka();
      const uslugi = { 'kanaly.klienciSklepow': {}, 'kanaly.klienciKanalow': {}, 'rdzen.sprzedawca': { rachunek: '' },
        'kanaly.config': { definicje: [], sklepy: {} }, 'faktury.infakt': null, 'faktury.puls': createPuls({ teraz: () => new Date() }) };
      const wynik = modul.zbuduj({ db, konfiguracja: modul.konfiguracja({ OMS_TRYB: 'proba',
        DPD_NADAWCA_NAZWA: 'Test', DPD_NADAWCA_ULICA: 'Testowa 1', DPD_NADAWCA_KOD: '00-001', DPD_NADAWCA_MIASTO: 'Testowo' }),
        teraz: () => new Date(), log: () => {}, usluga: (m, n) => uslugi[`${m}.${n}`] });
      for (const klucz of ['dpd', 'inpost']) {
        await expect(wynik.uslugi.kurierzy[klucz].sprawdzPolaczenie()).rejects.toMatchObject({
          message: MODULY_KURIEROW[klucz].piaskownica.komunikat, status: 400,
        });
      }
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      db.close();
      vi.unstubAllGlobals();
    }
  });
});
