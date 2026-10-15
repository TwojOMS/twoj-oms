import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { modulFaktury, createModulFaktury } from '../../../src/moduly/faktury/modul.ts';

const env = { OMS_PROFORMY_KATALOG: mkdtempSync(join(tmpdir(), 'prz023-')),
  OMS_SPRZEDAWCA_NIP: '1000001193', OMS_RACHUNEK: '61109010140000071219812874' };

describe('manifest faktury', () => {
  it('wymaga jawnej konfiguracji sprzedawcy i katalogu proform', () => {
    expect(() => modulFaktury.konfiguracja({})).toThrow();
    expect(() => modulFaktury.konfiguracja({ ...env, OMS_PROFORMY_KATALOG: '' })).toThrow('OMS_PROFORMY_KATALOG');
    expect(modulFaktury.wymaga).not.toContain('wysylka');
    expect(modulFaktury.konfiguracja({ ...env, DPD_NADAWCA_NAZWA: 'Firma testowa', DPD_NADAWCA_ULICA: 'Testowa 1' }).nadawca)
      .toMatchObject({ nazwa: 'Firma testowa', ulica: 'Testowa 1' });
  });
  it('składa proformę oraz jednego klienta inFaktu i puls bez wykonania API', async () => {
    const db = openOmsDb();
    const transport = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('prawdziwe API zabronione'));
    const uslugi: Record<string, unknown> = { 'kanaly.klienciKanalow': { sklep: {} }, 'kanaly.config': { definicje: [], sklepy: {} } };
    let teraz = new Date('2026-09-30T10:00:00Z');
    try {
      const z = modulFaktury.zbuduj({ db, konfiguracja: modulFaktury.konfiguracja({ ...env, INFAKT_API_KEY: 'testowy-klucz', INFAKT_ARCHIWUM: join(env.OMS_PROFORMY_KATALOG, 'archiwum') }),
        teraz: () => teraz, log: () => {},
        usluga: <T>(m: string, n: string) => {
          const k = `${m}.${n}`; if (!Object.hasOwn(uslugi, k)) throw new Error(k); return uslugi[k] as T;
        },
      });
      expect(z.uslugi?.proforma).toHaveProperty('wystaw');
      expect(z.uslugi?.faktura).toHaveProperty('wystaw');
      expect(z.uslugi?.infakt).toHaveProperty('wystaw');
      expect(z.zegary?.map(x => x.nazwa)).toEqual(['czuwaczKsef', 'czuwaczArchiwumSprzedazy']);
      expect(transport).not.toHaveBeenCalled();
      expect((z.uslugi?.puls as { stan: () => unknown }).stan()).toEqual({});
      await z.zegary?.find(x => x.nazwa === 'czuwaczKsef')?.przebieg();
      expect((z.uslugi?.puls as { stan: () => unknown }).stan()).toEqual({ czuwaczKsef: { okAt: '2026-09-30T10:00:00.000Z' } });
      expect(transport).not.toHaveBeenCalled();
      teraz = new Date('2026-09-30T14:00:00Z');
      expect(z.zdrowie?.().alarmy).toEqual([expect.stringContaining('czuwacz KSeF: ostatni udany przebieg')]);
    } finally { transport.mockRestore(); db.close(); }
  });
});

// PRZ-076: piaskownica (deploy/proba/start.mjs) podaje atrapę inFaktu i VIES fabrykami — bez klucza, bo
// OMS_TRYB=proba odmawia startu z kluczem. ⛔ Ta sama droga na produkcji ma być odmową startu, nie atrapą.
describe('fabryki inFaktu i VIES (atrapy piaskownicy)', () => {
  const usluga = <T>(m: string, n: string) => {
    const uslugi: Record<string, unknown> = { 'kanaly.klienciKanalow': {}, 'kanaly.config': { definicje: [], sklepy: {} } };
    const k = `${m}.${n}`; if (!Object.hasOwn(uslugi, k)) throw new Error(k); return uslugi[k] as T;
  };
  const atrapa = { wystaw: async () => ({ uuid: 'a', numer: '1/10/2026', ksefStatus: null }), listaFaktur: async () => [] };
  const vies = { sprawdz: async () => ({ wynik: 'wazny' }) };

  it('w trybie próby bez klucza: fabryka daje klienta, faktury i widok listy działają na nim', () => {
    const db = openOmsDb();
    const transport = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('prawdziwe API zabronione'));
    try {
      const fabryki = { createInfaktClient: vi.fn(() => atrapa), createVies: vi.fn(() => vies) };
      const modul = createModulFaktury({ fabryki });
      const z = modul.zbuduj({ db, konfiguracja: modul.konfiguracja({ ...env, OMS_TRYB: 'proba' }), teraz: () => new Date(), log: () => {}, usluga });
      expect(z.uslugi?.infakt).toBe(atrapa);
      expect(z.uslugi?.vies).toBe(vies);
      expect(z.uslugi?.faktura).toHaveProperty('wystaw');
      expect(z.uslugi?.fakturyWidok).toHaveProperty('dokumenty');
      expect(fabryki.createInfaktClient).toHaveBeenCalledWith(expect.objectContaining({ db }));
      expect(transport).not.toHaveBeenCalled();
    } finally { transport.mockRestore(); db.close(); }
  });

  it('⛔ fabryka atrapy poza trybem próby: odmowa budowy modułu (produkcja nie dostanie atrapy)', () => {
    const db = openOmsDb();
    try {
      for (const tryb of [undefined, '', 'produkcja']) {
        const modul = createModulFaktury({ fabryki: { createInfaktClient: () => atrapa } });
        const k = modul.konfiguracja({ ...env, OMS_TRYB: tryb, INFAKT_API_KEY: 'prawdziwy-klucz' });
        expect(() => modul.zbuduj({ db, konfiguracja: k, teraz: () => new Date(), log: () => {}, usluga }), String(tryb))
          .toThrow('OMS_TRYB=proba');
      }
      const modul = createModulFaktury({ fabryki: { createVies: () => vies } });
      expect(() => modul.zbuduj({ db, konfiguracja: modul.konfiguracja(env), teraz: () => new Date(), log: () => {}, usluga }))
        .toThrow('OMS_TRYB=proba');
    } finally { db.close(); }
  });

  it('bez fabryk i bez klucza: brak inFaktu jak dotąd (pusty ekran „nie ma podpiętego inFaktu”)', () => {
    const db = openOmsDb();
    try {
      const z = modulFaktury.zbuduj({ db, konfiguracja: modulFaktury.konfiguracja({ ...env, OMS_TRYB: 'proba' }), teraz: () => new Date(), log: () => {}, usluga });
      expect(z.uslugi?.infakt).toBeNull();
      expect(z.uslugi?.vies).toBeNull();
    } finally { db.close(); }
  });
});
