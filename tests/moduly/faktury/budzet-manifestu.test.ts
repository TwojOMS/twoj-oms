import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.doUnmock('../../../src/moduly/faktury/services/czuwacz-ksef.js');
  vi.doUnmock('../../../src/moduly/faktury/services/czuwacz-archiwum-sprzedazy.js');
  vi.resetModules();
});
describe('produkcja: budżet blokuje niebezpieczny harmonogram faktur', () => {
  it.each(['ksef', 'archiwum'])('%s nie może sięgać kolejnego tyknięcia', async rodzaj => {
    vi.resetModules();
    if (rodzaj === 'ksef') vi.doMock('../../../src/moduly/faktury/services/czuwacz-ksef.js', async () => ({
      ...await vi.importActual<object>('../../../src/moduly/faktury/services/czuwacz-ksef.js'), NAJDLUZSZY_PRZEBIEG_MS: 3600000,
    }));
    else vi.doMock('../../../src/moduly/faktury/services/czuwacz-archiwum-sprzedazy.js', async () => ({
      ...await vi.importActual<object>('../../../src/moduly/faktury/services/czuwacz-archiwum-sprzedazy.js'),
      NAJDLUZSZY_PRZEBIEG_ARCHIWUM_SPRZEDAZY_MS: 3600000,
    }));
    const { modulFaktury } = await import('../../../src/moduly/faktury/modul.ts');
    expect(() => modulFaktury.konfiguracja({ OMS_SPRZEDAWCA_NIP: '1234563218',
      OMS_RACHUNEK: '34109010140000000000000000', OMS_PROFORMY_KATALOG: 'fixture' })).toThrow('Budżet czuwacza');
  });
});
