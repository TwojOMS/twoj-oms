// PRZ-093.09 — test PRZYPINAJĄCY produkcję: instalacja z InPostem w pliku (.env: INPOST_TOKEN, INPOST_ORGANIZACJA,
// INPOST_URL, INPOST_PACZKOMAT_NADAWCZY, adres nadawcy DPD_NADAWCA_*) dostaje TEGO SAMEGO klienta InPost co przed
// ekranem „Kurier InPost” w Ustawieniach: jedno wywołanie prawdziwej fabryki createInpostClient z tymi samymi
// argumentami — także wtedy, gdy w bazie leży zapis z ekranu (plik wygrywa). Plik napisany tak, by przechodził
// i na kodzie sprzed PRZ-093.09 (sprawdzone na commicie rodzica), i po zmianie.
// Zero sieci: globalny fetch podmieniony; dane zmyślone.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { createModulWysylka } from '../../../src/moduly/wysylka/modul.ts';
import { createPuls } from '../../../src/core/puls.js';
import { zapiszKonfiguracjeIntegracji } from '../../../src/oms/db/konfiguracja-integracji.js';

const wolania = vi.hoisted(() => [] as Record<string, unknown>[]);
vi.mock('../../../src/oms/kurierzy/inpost.js', async (oryginal) => {
  const m = await oryginal<typeof import('../../../src/oms/kurierzy/inpost.js')>();
  return { ...m, createInpostClient: (o: Parameters<typeof m.createInpostClient>[0]) => {
    wolania.push(o as Record<string, unknown>); return m.createInpostClient(o);
  } };
});

const TOKEN_PLIKU = 'eyJ.TOKEN-Z-PLIKU.zmyslony';
const TOKEN_EKRANU = 'eyJ.TOKEN-Z-EKRANU.zmyslony';
const ENV = {
  INPOST_TOKEN: TOKEN_PLIKU, INPOST_ORGANIZACJA: '4242', INPOST_PACZKOMAT_NADAWCZY: 'abc01m',
  DPD_NADAWCA_NAZWA: 'Pracownia Testowa', DPD_NADAWCA_ULICA: 'Zmyślona 1', DPD_NADAWCA_KOD: '00-950',
  DPD_NADAWCA_MIASTO: 'Warszawa', DPD_NADAWCA_TELEFON: '000000000', DPD_NADAWCA_EMAIL: 'nadawca@example.invalid',
};
const NADAWCA = { nazwa: 'Pracownia Testowa', ulica: 'Zmyślona 1', kod: '00-950', miasto: 'Warszawa', kraj: 'PL',
  phone: '000000000', email: 'nadawca@example.invalid' };

function zbuduj(env: Record<string, string>, { zapisEkranu = false } = {}) {
  const db = openOmsDb();
  if (zapisEkranu) {
    zapiszKonfiguracjeIntegracji(db, 'inpost', { ustawienia: { nazwa: 'InPost', organizacja: '9999', paczkomatNadawczy: 'ZZZ99Z' },
      sekrety: { token: TOKEN_EKRANU } });
  }
  const uslugi: Record<string, unknown> = {
    'kanaly.klienciSklepow': { sklep: {} }, 'kanaly.klienciKanalow': {}, 'rdzen.sprzedawca': { rachunek: '' },
    'kanaly.config': { definicje: [], sklepy: {} }, 'faktury.infakt': null, 'faktury.puls': createPuls({ teraz: () => new Date() }),
  };
  const modul = createModulWysylka();
  const z = modul.zbuduj({ db, konfiguracja: modul.konfiguracja({ ...env, OMS_ETYKIETY_KATALOG: mkdtempSync(join(tmpdir(), 'prz-093-09-')) }),
    teraz: () => new Date(), log: () => {}, usluga: <T>(m: string, n: string) => uslugi[`${m}.${n}`] as T } as any);
  return { db, kurierzy: (z as any).uslugi.kurierzy as Record<string, any> };
}

let siec: ReturnType<typeof vi.fn>;
beforeEach(() => {
  wolania.length = 0;
  siec = vi.fn(async () => new Response(JSON.stringify({ status: 404, error: 'resource_not_found' }), { status: 404 }));
  vi.stubGlobal('fetch', siec);
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('PRZ-093.09 produkcja: InPost z pliku bez zmian', () => {
  for (const zapisEkranu of [false, true]) {
    it(`jedno wywołanie createInpostClient z argumentami z pliku${zapisEkranu ? ' — mimo zapisu z ekranu w bazie' : ''}`, async () => {
      const { db, kurierzy } = zbuduj(ENV, { zapisEkranu });
      expect(wolania).toEqual([{ url: 'https://api-shipx-pl.easypack24.net/v1', token: TOKEN_PLIKU, organizacja: 4242,
        nadawca: NADAWCA, paczkomatNadawczy: 'ABC01M' }]);
      expect(Object.keys(kurierzy.inpost)).toEqual(expect.arrayContaining(['nadaj', 'sprawdzPrzesylke', 'pobierzEtykiete', 'statusPrzesylki']));
      // Klient mapy rozmawia tokenem i adresem z pliku — nie z ekranu.
      await kurierzy.inpost.statusPrzesylki('520000000000000000000001').catch(() => null);
      expect(siec).toHaveBeenCalledTimes(1);
      const [adres, init] = siec.mock.calls[0] as [string, RequestInit];
      expect(adres).toBe('https://api-shipx-pl.easypack24.net/v1/tracking/520000000000000000000001');
      expect(new Headers(init.headers).get('authorization')).toBe(`Bearer ${TOKEN_PLIKU}`);
      expect(JSON.stringify(siec.mock.calls)).not.toContain(TOKEN_EKRANU);
      db.close();
    });
  }

  it('własny INPOST_URL z pliku zostaje (także z końcowym ukośnikiem)', () => {
    const { db } = zbuduj({ ...ENV, INPOST_URL: 'https://shipx.invalid/v1/' });
    expect(wolania).toHaveLength(1);
    expect(wolania[0].url).toBe('https://shipx.invalid/v1/');
    db.close();
  });

  it('bez INPOST_TOKEN w pliku i bez zapisu w bazie: brak kuriera InPost, fabryka nie wołana', () => {
    const { db, kurierzy } = zbuduj({ DPD_NADAWCA_NAZWA: 'Pracownia Testowa' });
    expect(wolania).toEqual([]);
    expect(kurierzy.inpost).toBeUndefined();
    db.close();
  });

  it('sprawdzenie przesyłki po nadaniu gubi drugi argument (zamówienie) — jak dotąd', async () => {
    const { db, kurierzy } = zbuduj(ENV);
    // Przekazany dalej drugi argument udawałby „pierwszą odpowiedź POST” z numerem listu — wtedy pierwsze żądanie
    // poszłoby po etykietę, a nie po przesyłkę.
    await kurierzy.inpost.sprawdzPrzesylke('123', { sklep: 'x', tekst: '{}', dane: { id: 123, tracking_number: '520000000000000000000009' } })
      .catch(() => null);
    expect(siec).toHaveBeenCalled();
    expect(String(siec.mock.calls[0][0])).toBe('https://api-shipx-pl.easypack24.net/v1/shipments/123');
    db.close();
  });
});
