// PRZ-135.04b — kontrakt składania kurierów: rejestr (opis) ⇔ adapter z FABRYKI_KURIEROW ⇔ odmowa w piaskownicy.
// Rejestr nie widzi adapterów (D2), więc zgodność umiejętności z metodami adaptera pilnuje ten test (D5.3, R3).
import { describe, expect, it, vi } from 'vitest';

const strazStartu = vi.hoisted(() => ({ wywolania: 0 }));
vi.mock('../../../src/domena/moduly-kurierow.ts', async (oryg) => {
  const m = await oryg<typeof import('../../../src/domena/moduly-kurierow.ts')>();
  return { ...m, sprawdzOpisyKurierow: (...a: Parameters<typeof m.sprawdzOpisyKurierow>) => {
    strazStartu.wywolania++; return m.sprawdzOpisyKurierow(...a);
  } };
});

import { FABRYKI_KURIEROW } from '../../../src/integracje/fabryki.ts';
import { MODULY_KURIEROW, type KluczKurieraNadania } from '../../../src/domena/moduly-kurierow.ts';
import { odmowaWProbie } from '../../../src/moduly/wysylka/modul.ts';
import { wczytajKurierow, zbudujKurierow } from '../../../src/moduly/wysylka/kurierzy.ts';
import { zplPrzyNadaniu } from '../../../src/moduly/wysylka/services/nadanie.js';

const nadawca = { nazwa: 'Pracownia Półcień', ulica: 'Cienista 1', kod: '00-001', miasto: 'Warszawa', kraj: 'PL',
  phone: '500600700', email: 'nadania@polcien.example' };
const bezSieci = async () => { throw new Error('test: bez sieci'); };

// Typowane kluczem rejestru: nowy kurier z metodami bez opcji tutaj = błąd tsc, nie cicho pominięty kontrakt.
const OPCJE: { [K in KluczKurieraNadania]: Parameters<typeof FABRYKI_KURIEROW[K]>[0] } = {
  dpd: { url: 'https://dpd.invalid/ws', login: 'polcien', haslo: 'tajne', fid: '1001', nadawca,
    infoUrl: 'https://dpd.invalid/info', channel: 'kanal', fetchImpl: bezSieci },
  inpost: { url: 'https://inpost.invalid/v1', token: 'token', organizacja: 1, nadawca, fetchImpl: bezSieci },
  allegro_wza: { allegroDla: () => { throw new Error('test: bez Allegro'); }, metodaZywa: () => null,
    pobranieNadawca: { nazwa: 'Pracownia Półcień' } },
  erli_przesylki: { erliDla: () => { throw new Error('test: bez ERLI'); }, punktNadaniaDla: () => null },
};

const kurierzyNadania = Object.entries(MODULY_KURIEROW)
  .filter(([, opis]) => opis.metody.length > 0)
  .map(([k]) => k as KluczKurieraNadania);
const adapter = (k: KluczKurieraNadania): Record<string, unknown> =>
  (FABRYKI_KURIEROW[k] as (o: unknown) => Record<string, unknown>)(OPCJE[k]);
const metody = (o: Record<string, unknown>) => Object.keys(o).filter(m => typeof o[m] === 'function').sort();

describe('FABRYKI_KURIEROW', () => {
  it('ma fabrykę dokładnie dla każdego kuriera z metodami, w kolejności rejestru', () => {
    expect(Object.keys(FABRYKI_KURIEROW)).toEqual(kurierzyNadania);
    expect(kurierzyNadania).toEqual(['dpd', 'inpost', 'allegro_wza', 'erli_przesylki']);
  });

  describe.each(kurierzyNadania)('%s: umiejętności zgodne z metodami adaptera (Komplet)', (k) => {
    const opis = MODULY_KURIEROW[k];
    it('nadanieAsynchroniczne ⇔ sprawdzPrzesylke', () => {
      expect(typeof adapter(k).sprawdzPrzesylke === 'function').toBe(opis.umiejetnosci.nadanieAsynchroniczne);
    });
    it('sledzenie „wlasne” ⇔ statusPrzesylki; inne ⇔ jawne bezSledzenia', () => {
      const a = adapter(k);
      const wlasne = opis.umiejetnosci.sledzenie === 'wlasne';
      expect(typeof a.statusPrzesylki === 'function').toBe(wlasne);
      expect(a.bezSledzenia === true).toBe(!wlasne);
    });
    it('umowa „wlasna” ⇔ sprawdzPolaczenie (konfigurator sprawdza połączenie)', () => {
      expect(typeof adapter(k).sprawdzPolaczenie === 'function').toBe(opis.umowa === 'wlasna');
    });
  });
});

describe('odmowaWProbie(opis)', () => {
  const zAtrapa = kurierzyNadania.filter(k => MODULY_KURIEROW[k].umowa === 'wlasna');
  it('dotyczy kurierów z własną umową: DPD i InPost', () => {
    expect(zAtrapa).toEqual(['dpd', 'inpost']);
  });
  describe.each(zAtrapa)('%s', (k) => {
    const opis = MODULY_KURIEROW[k];
    it('ma dokładnie te nazwy metod co adapter (R3: bez sprawdzPrzesylke u DPD)', () => {
      expect(metody(odmowaWProbie(opis)({}) as Record<string, unknown>)).toEqual(metody(adapter(k)));
    });
    it('każda metoda odrzuca tekstem z opisu i statusem 400', async () => {
      const o = odmowaWProbie(opis)({}) as Record<string, () => Promise<unknown>>;
      for (const m of Object.keys(o)) {
        await expect(o[m]!()).rejects.toMatchObject({ message: opis.piaskownica.komunikat, status: 400 });
      }
    });
  });
});

describe('zplPrzyNadaniu(kurier) — czy brak ZPL po nadaniu idzie do logu', () => {
  it('z opisu: WzA świadomie bez ZPL, DPD i InPost z ZPL', () => {
    expect(zplPrzyNadaniu('allegro_wza')).toBe(false);
    expect(zplPrzyNadaniu('dpd')).toBe(true);
    expect(zplPrzyNadaniu('inpost')).toBe(true);
  });
  it('pusty albo historyczny kurier: bez rzucania, jak dotąd (log „BRAK”)', () => {
    for (const k of [undefined, null, '', 'kurier_z_2025', 'toString']) expect(zplPrzyNadaniu(k)).toBe(true);
  });
});

describe('składanie modułu wysyłki', () => {
  it('wczytajKurierow sprawdza opisy kurierów (strażnik startu)', () => {
    const przed = strazStartu.wywolania;
    wczytajKurierow({});
    expect(strazStartu.wywolania).toBe(przed + 1);
  });
  it('zbudujKurierow składa mapę w kolejności rejestru', () => {
    const atrapa = () => ({ nadaj: async () => ({ numerListu: null }) });
    const config = { ...wczytajKurierow({}), dpd: {} as never, inpost: {} as never };
    const mapa = zbudujKurierow(config, {}, { createDpd: atrapa, createInpost: atrapa, createAllegroWza: atrapa,
      createAllegroSledzenie: () => ({ statusPrzesylki: async () => null }) });
    expect(Object.keys(mapa)).toEqual(['dpd', 'inpost', 'allegro_wza', 'erli_przesylki', 'allegro']);
  });
});
