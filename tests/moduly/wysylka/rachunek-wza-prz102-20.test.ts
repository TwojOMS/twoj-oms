// PRZ-102.20 — IBAN pobrania Allegro WzA z bieżącej konfiguracji rachunku firmy (plik → Ustawienia → Firma → brak),
// czytany przy żądaniu, nie raz przy starcie. Plik wygrywa nad zapisem w panelu. Atrapa fabryki WzA — nic nie wychodzi.
import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zbudujAplikacje } from '../../../src/core/aplikacja.ts';
import { modulRdzen } from '../../../src/moduly/rdzen/modul.ts';
import { createModulWeb } from '../../../src/core/web/modul.ts';
import { createModulKanaly } from '../../../src/moduly/kanaly/modul.ts';
import { modulFaktury } from '../../../src/moduly/faktury/modul.ts';
import { modulZamowienia } from '../../../src/moduly/zamowienia/modul.ts';
import { createModulWysylka } from '../../../src/moduly/wysylka/modul.ts';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import type { FabrykiKurierow } from '../../../src/moduly/wysylka/kurierzy.ts';
import type { ModulOms, Srodowisko } from '../../../src/core/kontrakty.ts';
import { zapiszRachunekFirmy } from '../../../src/oms/db/rachunek-firmy.js';
import { pobranieDoWysylki } from '../../../src/domena/allegro-wysylka.js';

const PANEL = '09109010140000000000000062';
const kanal = { klucz: 'rynek', typ: 'allegro' as const, prefiks: 'RYNEK' };

async function kompozycja(dodatkowe: Srodowisko) {
  const createAllegroWza = vi.fn((_o: Parameters<NonNullable<FabrykiKurierow['createAllegroWza']>>[0]) => ({ nadaj: async () => ({ numerListu: null }) }));
  const katalog = mkdtempSync(join(tmpdir(), 'prz102-20-wza-'));
  const env = { OMS_USER: 'operator', OMS_PASS: 'test', OMS_SPRZEDAWCA_NIP: '1234563218',
    OMS_ETYKIETY_KATALOG: katalog, OMS_PROFORMY_KATALOG: katalog,
    RYNEK_CLIENT_ID: 'test', RYNEK_CLIENT_SECRET: 'test', RYNEK_USER_AGENT: 'Fixture/1.0 (+https://fixture.invalid)', RYNEK_OD: '2026-01-01',
    RYNEK_API: 'https://przyklad.invalid/allegro', RYNEK_AUTH: 'https://przyklad.invalid/oauth', ...dodatkowe };
  const db = openOmsDb();
  try {
    const app = await zbudujAplikacje({ db, env, log: () => {},
      moduly: [modulRdzen, createModulWeb([kanal]), createModulKanaly([kanal]),
        modulFaktury, modulZamowienia, createModulWysylka({ fabryki: { createAllegroWza } })] as unknown as readonly ModulOms[] });
    const konto = createAllegroWza.mock.calls[0]![0].pobranieNadawca!;
    return { ...app, db, konto };
  } catch (e) { db.close(); throw e; }
}
const pobranie = (iban: string | undefined) => pobranieDoWysylki({ pobranieUslugi: true, cashOnDelivery: { amount: '83.99', currency: 'PLN' },
  limit: '6000', ownerName: 'Pracownia', iban, nadpisanieOperatora: null, wymaganeKonto: true });

describe('PRZ-102.20 WzA a rachunek firmy', () => {
  it('bez OMS_RACHUNEK: panel wstaje, WzA bez rachunku odmawia pobrania z kontem; po zapisie w panelu bierze go bez restartu', async () => {
    const a = await kompozycja({});
    try {
      expect(a.konto.rachunek ?? null).toBeNull();
      expect(pobranie(a.konto.rachunek).wolno).toBe(false);
      zapiszRachunekFirmy(a.db, { rachunek: PANEL, bank: '' });
      expect(a.konto.rachunek).toBe(PANEL);
      expect(pobranie(a.konto.rachunek)).toMatchObject({ wolno: true, cashOnDelivery: { iban: `PL${PANEL}` } });
    } finally { await a.app.close(); a.db.close(); }
  });

  it('OMS_RACHUNEK w pliku wygrywa nad zapisem w panelu (IBAN jak przed zmianą)', async () => {
    const a = await kompozycja({ OMS_RACHUNEK: 'PL34 1090 1014 0000 0000 0000 0000' });
    try {
      zapiszRachunekFirmy(a.db, { rachunek: PANEL, bank: '' });
      expect(a.konto.rachunek).toBe('34109010140000000000000000');
      expect(a.konto.rachunek).toBe(a.usluga<{ rachunek: string }>('rdzen', 'sprzedawca').rachunek);
    } finally { await a.app.close(); a.db.close(); }
  });
});
