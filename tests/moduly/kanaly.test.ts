import { describe, it, expect } from 'vitest';
import { createModulKanaly } from '../../src/moduly/kanaly/modul.ts';
import { openOmsDb } from '../../src/oms/db/db.ts';

describe('manifest kanałów', () => {
  it('deklaruje dynamiczne klucze zanim rdzeń sprawdzi próbę', () => {
    const m = createModulKanaly([{ klucz: 'rynek', typ: 'allegro', prefiks: 'RYNEK' }]);
    expect(m.kluczeIntegracji).toContain('RYNEK_CLIENT_SECRET');
    expect(m.konfiguracja({})).toEqual({ sklepy: {}, kanaly: {}, odstepMs: 120000,
      definicje: [{ klucz: 'rynek', typ: 'allegro', prefiks: 'RYNEK' }] });
  });
  it('odmawia startu sklepu z kluczem bez mapowania dostaw', () => {
    const m = createModulKanaly([{ klucz: 'sklep', typ: 'woo', prefiks: 'SKLEP' }]);
    expect(() => m.konfiguracja({ SKLEP_CK: 'atrapa', SKLEP_CS: 'atrapa', SKLEP_URL: 'https://shop.invalid' })).toThrow(/MAPOWANIE/);
  });
  it('publikuje SQL i puste rzeczywiste mapy, bez zegara przy braku kanałów', () => {
    const m = createModulKanaly([]); const db = openOmsDb();
    const z = m.zbuduj({ db, konfiguracja: m.konfiguracja({}), teraz: () => new Date(), log: () => {}, usluga: () => { throw new Error('nieznana usługa'); } });
    expect(z.zegary).toEqual([]);
    expect(z.uslugi?.klienciSklepow).toEqual({});
    expect(z.uslugi?.klienciKanalow).toEqual({});
    expect(z.uslugi?.poller).toBeNull();
    db.close();
  });
});
