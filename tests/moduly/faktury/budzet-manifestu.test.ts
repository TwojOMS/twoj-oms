import { afterEach, describe, expect, it, vi } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { programInfakt } from '../../../src/integracje/programy/infakt.ts';

afterEach(() => {
  vi.doUnmock('../../../src/moduly/faktury/services/czuwacz-ksef.js');
  vi.doUnmock('../../../src/moduly/faktury/services/czuwacz-archiwum-sprzedazy.js');
  vi.resetModules();
});
describe('produkcja: budżet blokuje niebezpieczny harmonogram faktur', () => {
  it.each(['ksef', 'archiwum'])('%s nie może sięgać kolejnego tyknięcia', async rodzaj => {
    vi.resetModules();
    if (rodzaj === 'ksef') vi.doMock('../../../src/moduly/faktury/services/czuwacz-ksef.js', async () => ({
      ...await vi.importActual<object>('../../../src/moduly/faktury/services/czuwacz-ksef.js'), najdluzszyPrzebiegMs: () => 3600000,
    }));
    else vi.doMock('../../../src/moduly/faktury/services/czuwacz-archiwum-sprzedazy.js', async () => ({
      ...await vi.importActual<object>('../../../src/moduly/faktury/services/czuwacz-archiwum-sprzedazy.js'),
      najdluzszyPrzebiegArchiwumSprzedazyMs: () => 3600000,
    }));
    const { createModulFaktury } = await import('../../../src/moduly/faktury/modul.ts');
    // Ten sam opis inFaktu co w produkcji, bez klienta sieciowego. Budżet sprawdza składanie modułu.
    const modul = createModulFaktury({ fabryki: { createInfaktClient: () => programInfakt({}) } });
    const konfiguracja = modul.konfiguracja({ OMS_TRYB: 'proba', OMS_SPRZEDAWCA_NIP: '1234563218',
      OMS_RACHUNEK: '34109010140000000000000000', OMS_PROFORMY_KATALOG: 'fixture' });
    const db = openOmsDb();
    try {
      expect(() => modul.zbuduj({ db, konfiguracja, teraz: () => new Date('2026-10-29T10:00:00Z'),
        log: () => {}, usluga: () => ({}) } as any)).toThrow(`Budżet czuwacza ${rodzaj === 'ksef' ? 'KSeF' : 'archiwum sprzedaży'}`);
    } finally { db.close(); }
  });
});
