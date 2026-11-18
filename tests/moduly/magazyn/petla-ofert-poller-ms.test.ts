// Moduł magazynu podaje pętli ofert ERLI odstęp pollera z konfiguracji kanałów,
// ale nigdy krótszy niż 120 s (puls ma pochodzić z przebiegu, który zaczął się po odczycie).
// Atrapy klientów, żadnego połączenia z ERLI.
import { describe, it, expect, vi } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { modulRdzen } from '../../../src/moduly/rdzen/modul.ts';
import { migracjaKanalowSprzedazy } from '../../../src/moduly/kanaly/migracje/0001-kanaly-sprzedazy.ts';
import { migracjaDiagnostykiAllegro } from '../../../src/moduly/kanaly/migracje/0002-diagnostyka-allegro.ts';
import { migracjaTypuKanaluISklepow } from '../../../src/moduly/kanaly/migracje/0003-kanaly-typ-sklepy.ts';
import { migracjaOfertKanalow } from '../../../src/moduly/magazyn/migracje/0001-oferty-kanalow.ts';
import { modulMagazyn } from '../../../src/moduly/magazyn/modul.ts';
import { createPetlaOfert } from '../../../src/moduly/magazyn/services/petla-ofert.js';

vi.mock('../../../src/moduly/magazyn/services/petla-ofert.js', async (orig) => {
  const m = await orig<typeof import('../../../src/moduly/magazyn/services/petla-ofert.js')>();
  return { ...m, createPetlaOfert: vi.fn(m.createPetlaOfert) };
});

function pollerMsDla(config: Record<string, unknown>) {
  vi.mocked(createPetlaOfert).mockClear();
  const db = openOmsDb(':memory:', {
    moduly: [
      modulRdzen,
      { nazwa: 'kanaly', migracje: [migracjaKanalowSprzedazy, migracjaDiagnostykiAllegro, migracjaTypuKanaluISklepow] },
      { nazwa: 'magazyn', migracje: [migracjaOfertKanalow] },
    ],
  } as any);
  const repo = {
    listaTypu: () => [],
    zapisyZablokowane: () => false,
    konfliktKlucza: () => false,
    zwolnijOperacje: () => 0,
  };
  const usluga = (modul: string, nazwa: string) => {
    if (modul === 'kanaly' && nazwa === 'config') return { definicje: [], sklepy: {}, kanaly: {}, ...config };
    if (modul === 'kanaly' && (nazwa === 'klienciKanalow' || nazwa === 'klienciSklepow')) return {};
    if (modul === 'kanaly' && nazwa === 'repozytoriumKanalow') return repo;
    throw new Error(`Usługa „${modul}.${nazwa}” nie istnieje`);
  };
  try {
    modulMagazyn.zbuduj({
      db,
      konfiguracja: modulMagazyn.konfiguracja({ OMS_KATALOG_ZDJEC: '/nieistniejacy/zdjecia-polcien' }),
      teraz: () => new Date('2026-11-14T12:00:00Z'),
      log: vi.fn(),
      usluga,
    } as any);
    expect(createPetlaOfert).toHaveBeenCalledTimes(1);
    return (vi.mocked(createPetlaOfert).mock.calls[0] as any[])[0].pollerMs;
  } finally {
    db.close();
  }
}

describe('odstęp pollera dla pętli ofert ERLI', () => {
  it.each([
    ['dłuższy odstęp z konfiguracji', { odstepMs: 300_000 }, 300_000],
    ['krótszy odstęp (minimum env 30 s) podniesiony do 120 s', { odstepMs: 30_000 }, 120_000],
    ['brak odstępu w konfiguracji', {}, 120_000],
  ])('%s', (_, config, oczekiwany) => {
    expect(pollerMsDla(config)).toBe(oczekiwany);
  });
});
