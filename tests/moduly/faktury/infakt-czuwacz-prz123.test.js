// PRZ-122.TFeb: wydzielone przypadki wspólne; ciała bez zmian.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { createModulFaktury } from '../../../src/moduly/faktury/modul.ts';
import { createCzuwaczKsef } from '../../../src/moduly/faktury/services/czuwacz-ksef.js';
const NIP = '1234563218';
let siec;
const otwarte = [];
beforeEach(() => {
  siec = vi.fn(async () => { throw new Error('Sieć zabroniona w teście rozstrzygania KSeF'); });
  vi.stubGlobal('fetch', siec);
});
afterEach(() => {
  while (otwarte.length) otwarte.pop().close();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});


describe('PRZ-123 C07b — inFakt: czuwacz bez rozstrzygania i bez nowych wołań', () => {
  it('moduł z inFaktem nie podaje czuwaczowi rozstrzygania; przebieg nie wychodzi do sieci ani do KSeF', async () => {
    const db = openOmsDb();
    otwarte.push(db);
    const infakt = {
      wystaw: vi.fn(async () => ({ uuid: 'a', numer: '1/10/2026', ksefStatus: null })),
      listaFaktur: vi.fn(async () => []),
      pobierzFakture: vi.fn(async () => null),
    };
    const argumenty = [];
    const ksefFetch = vi.fn(async () => { throw new Error('KSeF zabroniony przy inFakcie'); });
    const fabryki = {
      createInfaktClient: () => infakt,
      createVies: () => ({ sprawdz: async () => ({ wynik: 'wazny' }) }),
      createCzuwacz: (a) => { argumenty.push(a); return createCzuwaczKsef(a); },
      atrapaKsefWysylki: () => ({ baseUrl: 'https://ksef.atrapa.invalid/v2', fetchImpl: ksefFetch, fabryka: () => { throw new Error('bez tokenu'); } }),
    };
    const modul = createModulFaktury({ fabryki });
    const uslugi = { 'kanaly.klienciKanalow': { sklep: {} }, 'kanaly.config': { definicje: [], sklepy: {} } };
    const env = { OMS_PROFORMY_KATALOG: '/nieuzywany', OMS_TRYB: 'proba', OMS_SPRZEDAWCA_NIP: NIP, OMS_RACHUNEK: '61109010140000071219812874' };
    const z = modul.zbuduj({ db, konfiguracja: modul.konfiguracja(env), teraz: () => new Date(), log: () => {},
      usluga: (m, n) => uslugi[`${m}.${n}`] });
    expect(z.uslugi.programFakturowy.opis.id).not.toBe('twojefaktury');
    expect(argumenty).toHaveLength(1);
    expect(Object.keys(argumenty[0]).sort()).toEqual(['db', 'fakturaAllegro', 'infakt', 'klienciKanalow']);
    await z.uslugi.czuwaczKsef.przebieg();
    expect(siec).not.toHaveBeenCalled();
    expect(ksefFetch).not.toHaveBeenCalled();
    expect(infakt.wystaw).not.toHaveBeenCalled();
  });
});
