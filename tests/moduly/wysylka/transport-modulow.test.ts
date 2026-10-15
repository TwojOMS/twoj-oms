import { afterEach, describe, expect, it, vi } from 'vitest';
import { tmpdir } from 'node:os';
import { wczytajKurierow, zbudujKurierow } from '../../../src/moduly/wysylka/kurierzy.ts';
import { modulFaktury } from '../../../src/moduly/faktury/modul.ts';
import { openOmsDb } from '../../../src/oms/db/db.ts';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('rzeczywiste składanie transportu wysylka/faktury', () => {
  it('DPD i inFakt z manifestów otrzymują 60 s i nie ponawiają 503', async () => {
    const limity: number[] = [];
    const czasSygnalu = new WeakMap<AbortSignal, number>();
    vi.spyOn(AbortSignal, 'timeout').mockImplementation(ms => {
      const signal = new AbortController().signal; czasSygnalu.set(signal, ms); return signal;
    });
    const polacz = AbortSignal.any.bind(AbortSignal);
    vi.spyOn(AbortSignal, 'any').mockImplementation(sygnaly => {
      const signal = polacz(sygnaly);
      czasSygnalu.set(signal, Math.min(...sygnaly.map(s => czasSygnalu.get(s) ?? Infinity)));
      return signal;
    });
    const fetch = vi.fn(async (_url: unknown, init: RequestInit) => {
      limity.push(czasSygnalu.get(init.signal as AbortSignal)!);
      return new Response('testowa odmowa', { status: 503 });
    });
    vi.stubGlobal('fetch', fetch);
    const kurierzy = zbudujKurierow(wczytajKurierow({
      DPD_URL: 'https://przyklad.invalid/dpd', DPD_INFO_URL: 'https://przyklad.invalid/info',
      DPD_INFO_CHANNEL: '1', DPD_LOGIN: 'test', DPD_PASSWORD: 'test', DPD_FID: '1',
      DPD_NADAWCA_NAZWA: 'Test', DPD_NADAWCA_ULICA: 'Testowa 1', DPD_NADAWCA_KOD: '00-001',
      DPD_NADAWCA_MIASTO: 'Test',
    }), {});
    await expect(kurierzy.dpd!.nadaj({ zamowienie: { id: 1, sklep: 'sklep-test', zrodlo_id: 11,
      numer: 'TEST', metoda_wysylki: 'dpd', kwota_pobrania: null, pobranie: 0, anulowane: 0,
      punkt_odbioru: null, surowe_json: null, klient: null, dostawa: null, dostawa_reczna_json: null },
      paczka: { waga: 1, dlugosc: 40, szerokosc: 30, wysokosc: 10 },
      adres: { nazwa: 'Test', ulica: 'Testowa 1', kod: '00-001', miasto: 'Test', kraj: 'PL', phone: null, email: null },
    })).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(limity).toEqual([60000]);
    const db = openOmsDb();
    try {
      const env = { OMS_PROFORMY_KATALOG: tmpdir(), OMS_SPRZEDAWCA_NIP: '1234563218',
        OMS_RACHUNEK: '34109010140000000000000000', INFAKT_API_KEY: 'test', INFAKT_API_URL: 'https://przyklad.invalid/infakt' };
      const z = modulFaktury.zbuduj({ db, konfiguracja: modulFaktury.konfiguracja(env),
        teraz: () => new Date(), log: () => {}, usluga: <T>() => ({}) as T });
      const infakt = z.uslugi?.infakt as { pobierzFakture: (id: string) => Promise<unknown> };
      await expect(infakt.pobierzFakture('test')).rejects.toThrow();
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(limity).toEqual([60000, 60000]);
    } finally { db.close(); }
  });
});
