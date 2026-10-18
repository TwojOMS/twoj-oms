// PRZ-093.10 — test PRZYPINAJĄCY produkcję: instalacja z inFaktem w pliku (.env: INFAKT_API_KEY, INFAKT_API_URL,
// INFAKT_ARCHIWUM) dostaje TEGO SAMEGO klienta inFaktu co przed ekranem „inFakt” w Ustawieniach: jedno wywołanie
// prawdziwej fabryki createInfaktClient z tymi samymi argumentami, te same żądania (adres, metoda, nagłówki) przy
// liście, wystawieniu, PDF-ie i korekcie — także wtedy, gdy w bazie leży zapis z ekranu (plik wygrywa w całości).
// Plik napisany tak, by przechodził i na kodzie sprzed PRZ-093.10 (sprawdzone na commicie rodzica 8663c62), i po zmianie.
// Zero sieci: globalny fetch podmieniony; klucze i dane zmyślone.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { createModulFaktury } from '../../../src/moduly/faktury/modul.ts';
import { zapiszKonfiguracjeIntegracji } from '../../../src/oms/db/konfiguracja-integracji.js';

const wolania = vi.hoisted(() => [] as Record<string, unknown>[]);
vi.mock('../../../src/oms/infakt/client.js', async (oryginal) => {
  const m = await oryginal<typeof import('../../../src/oms/infakt/client.js')>();
  return { ...m, createInfaktClient: (o: Parameters<typeof m.createInfaktClient>[0]) => {
    wolania.push({ ...(o as object) } as Record<string, unknown>); return m.createInfaktClient(o);
  } };
});

const KLUCZ_PLIKU = 'zmyslony-klucz-z-pliku-0000000000000001';
const KLUCZ_EKRANU = 'zmyslony-klucz-z-ekranu-000000000000002';
const KATALOG = mkdtempSync(join(tmpdir(), 'prz-093-10-'));
const ARCHIWUM = join(KATALOG, 'archiwum');
const ENV = { OMS_PROFORMY_KATALOG: KATALOG, OMS_SPRZEDAWCA_NIP: '1234563218', OMS_RACHUNEK: '34109010140000000000000000',
  INFAKT_API_KEY: KLUCZ_PLIKU, INFAKT_ARCHIWUM: ARCHIWUM };

function zbuduj(env: Record<string, string>, { zapisEkranu = false } = {}) {
  const db = openOmsDb();
  if (zapisEkranu) zapiszKonfiguracjeIntegracji(db, 'infakt', { ustawienia: {}, sekrety: { apiKey: KLUCZ_EKRANU } });
  const uslugi: Record<string, unknown> = { 'kanaly.klienciKanalow': {}, 'kanaly.config': { definicje: [], sklepy: {} } };
  const modul = createModulFaktury();
  const z = modul.zbuduj({ db, konfiguracja: modul.konfiguracja(env), teraz: () => new Date('2026-10-18T10:00:00Z'), log: () => {},
    usluga: <T>(m: string, n: string) => {
      const k = `${m}.${n}`; if (!Object.hasOwn(uslugi, k)) throw new Error(k); return uslugi[k] as T;
    } } as any);
  return { db, z: z as any };
}

let siec: ReturnType<typeof vi.fn>;
beforeEach(() => {
  wolania.length = 0;
  siec = vi.fn(async (adres: string) => {
    if (String(adres).includes('.pdf')) return new Response(new Uint8Array([37, 80, 68, 70]), { status: 200, headers: { 'content-type': 'application/pdf' } });
    return new Response(JSON.stringify({ metainfo: { count: 0, total_count: 0 }, entities: [], uuid: 'u-1', id: 1, number: '1/10/2026' }),
      { status: 200, headers: { 'content-type': 'application/json' } });
  });
  vi.stubGlobal('fetch', siec);
});
afterEach(() => { vi.unstubAllGlobals(); });

const naglowki = (i: number) => {
  const init = siec.mock.calls[i][1] as RequestInit;
  return Object.fromEntries(new Headers(init.headers).entries());
};

describe('PRZ-093.10 produkcja: inFakt z pliku bez zmian', () => {
  for (const zapisEkranu of [false, true]) {
    it(`jedno wywołanie createInfaktClient z argumentami z pliku${zapisEkranu ? ' — mimo zapisu z ekranu w bazie' : ''}`, async () => {
      const { db, z } = zbuduj(ENV, { zapisEkranu });
      expect(wolania).toEqual([{ apiKey: KLUCZ_PLIKU, baseUrl: undefined, archiwum: ARCHIWUM, fetchImpl: undefined }]);
      expect(Object.keys(wolania[0]).sort()).toEqual(['apiKey', 'archiwum', 'baseUrl', 'fetchImpl']);
      expect(z.uslugi.config.infakt).toEqual({ apiKey: KLUCZ_PLIKU, baseUrl: undefined, archiwum: ARCHIWUM });
      expect(z.zegary.map((x: { nazwa: string }) => x.nazwa)).toEqual(['czuwaczArchiwumSprzedazy']);

      const infakt = z.uslugi.infakt;
      await infakt.listaFaktur({ od: '2026-10-01', do: '2026-10-31' });
      await infakt.wystaw({ client_id: 1, services: [] }).catch(() => null);
      await infakt.pobierzPdf('u-1').catch(() => null);
      await infakt.wystawKorekte({ corrected_invoice_uuid: 'u-1', services: [] }).catch(() => null);
      const json = { accept: 'application/json', 'content-type': 'application/json', 'x-infakt-apikey': KLUCZ_PLIKU };
      expect(siec.mock.calls.map(([adres, init], i) => [(init as RequestInit).method, adres, naglowki(i)])).toEqual([
        ['GET', 'https://api.infakt.pl/api/v3/invoices.json?offset=0&q%5Binvoice_date_gteq%5D=2026-10-01&q%5Binvoice_date_lteq%5D=2026-10-31', json],
        ['POST', 'https://api.infakt.pl/api/v3/invoices.json', json],
        ['GET', 'https://api.infakt.pl/api/v3/invoices/u-1/pdf.json?document_type=original', { 'x-infakt-apikey': KLUCZ_PLIKU }],
        ['POST', 'https://api.infakt.pl/api/v3/async/corrective_invoices.json', json],
      ]);
      expect(JSON.stringify(siec.mock.calls).includes(KLUCZ_EKRANU)).toBe(false);
      db.close();
    });
  }

  it('własny INFAKT_API_URL z pliku zostaje adresem wszystkich żądań', async () => {
    const { db, z } = zbuduj({ ...ENV, INFAKT_API_URL: 'https://infakt.invalid/api' }, { zapisEkranu: true });
    expect(wolania).toEqual([{ apiKey: KLUCZ_PLIKU, baseUrl: 'https://infakt.invalid/api', archiwum: ARCHIWUM, fetchImpl: undefined }]);
    await z.uslugi.infakt.listaFaktur({});
    expect(String(siec.mock.calls[0][0])).toBe('https://infakt.invalid/api/v3/invoices.json?offset=0');
    expect(naglowki(0)['x-infakt-apikey']).toBe(KLUCZ_PLIKU);
    db.close();
  });

  it('bez INFAKT_API_KEY w pliku i bez zapisu w bazie: brak inFaktu, fabryka nie wołana', () => {
    const { INFAKT_API_KEY, ...bez } = ENV;
    const { db, z } = zbuduj(bez);
    expect(wolania).toEqual([]);
    expect(z.uslugi.infakt).toBeNull();
    expect(z.uslugi.faktura).toBeNull();
    expect(z.zegary).toEqual([]);
    db.close();
  });
});
