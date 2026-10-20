import { describe, it, expect, vi } from 'vitest';
import { tmpdir } from 'node:os';
import { zbudujOms } from '../../../src/oms/bootstrap.ts';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { ustawGranice } from '../../../src/oms/db/historia-sprzedazy.js';
import { zalozGranice } from '../../../src/moduly/raporty/granice-start.js';

// Komplet kluczy sklepu (reguła „kanał skonfigurowany” z /health, brakujaceKluczeKanalu) — bez OD.
const KLUCZE_LAMPY = { LAMPY_URL: 'https://lampy.example', LAMPY_CK: 'ck_fikcyjny_14', LAMPY_CS: 'cs_fikcyjny_14',
  LAMPY_MAPOWANIE: '{"instancje":{},"poPozycji":[]}' };
const baza = { OMS_USER: 'operator', OMS_PASS: 'fixture-14',
  OMS_SPRZEDAWCA_NIP: '1234563218', OMS_RACHUNEK: '34109010140000000000000000',
  OMS_PROFORMY_KATALOG: tmpdir(), OMS_ETYKIETY_KATALOG: tmpdir(),
  OMS_KANALY: JSON.stringify([{ klucz: 'lampy', typ: 'woo', prefiks: 'LAMPY', raport: 'LAMPY' }]) };
const env = { ...baza, ...KLUCZE_LAMPY, LAMPY_OD: '2026-10-01' };
const headers = { authorization: `Basic ${Buffer.from('operator:fixture-14').toString('base64')}` };
const teraz = () => new Date('2026-10-20T12:00:00Z');
type Db = ReturnType<typeof openOmsDb>;
type Oms = Awaited<ReturnType<typeof zbudujOms>>;
type Log = ReturnType<typeof vi.fn<(...tekst: string[]) => void>>;
const tabela = (db: Db) => db.prepare('SELECT * FROM granice_historii ORDER BY kanal').all();
const granica = (db: Db, kanal: string) =>
  (db.prepare('SELECT do_dnia FROM granice_historii WHERE kanal = ?').get(kanal) as { do_dnia: string } | undefined)?.do_dnia;
const tekstLogu = (log: Log) => log.mock.calls.map(w => w.join(' ')).join('\n');

async function sprawdz(przygotuj: (db: Db) => void, test: (z: Oms, log: Log) => Promise<void>, e: Record<string, string> = env) {
  const db = openOmsDb();
  const log = vi.fn<(...tekst: string[]) => void>();
  const siec = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Sieć zabroniona'));
  let z: Oms | undefined;
  try {
    przygotuj(db);
    z = await zbudujOms({ env: e, db, teraz, log });
    await test(z, log);
    expect(siec).not.toHaveBeenCalled();
  } finally { if (z) await z.app.close(); db.close(); siec.mockRestore(); }
}
/** To, co robi pierwszy przebieg pollera po starcie: zamówienie złożone 10.10. */
function zamowienie(db: Db) {
  db.prepare("INSERT INTO zamowienia (sklep,zrodlo_id,numer,utworzone_at,kwota_brutto) VALUES ('lampy','14','L-14','2026-10-10T12:00:00Z','123.00')").run();
}
const raport = (z: Oms) => z.app.inject({
  method: 'GET', url: '/raporty/eksport.csv?od=2026-10-01&do=2026-10-31', headers });

describe('PRZ-102.14 granice przy starcie OMS', () => {
  it('C: komplet kluczy i OD — granica dzień przed OD, po zamówieniu raport liczy 123,00 i log podaje kanał oraz datę', async () => {
    await sprawdz(() => {}, async (z, log) => {
      expect(granica(z.db, 'LAMPY')).toBe('2026-09-30');
      zamowienie(z.db);
      const odp = await raport(z);
      expect(odp.statusCode).toBe(200);
      expect(odp.body).toContain('123,00');
      expect(log.mock.calls.filter(w => w.join(' ').includes('LAMPY=2026-09-30'))).toHaveLength(1);
    });
  });

  it('A: sklep z kompletem kluczy, ale bez LAMPY_OD — bez granicy, log „do założenia ręcznie”, raport odmawia zamiast pustego CSV', async () => {
    await sprawdz(() => {}, async (z, log) => {
      expect(granica(z.db, 'LAMPY')).toBeUndefined();
      // Kanały wbudowane powstają w panelu po starcie (dziś > wczoraj) — dostają „wczoraj” jak dotąd.
      for (const k of ['B2B', 'DROPSHIPPING', 'RECZNE']) expect(granica(z.db, k)).toBe('2026-10-19');
      expect(tekstLogu(log)).toMatch(/kanał LAMPY: granica do założenia ręcznie \(`--granice`\) po pierwszym pobraniu zamówień — brak LAMPY_OD/);
      zamowienie(z.db);
      const odp = await raport(z);
      expect(odp.statusCode).toBe(400);
      expect(odp.body).not.toContain('123,00');
      expect(odp.body).toContain('nie wie, gdzie przebiega granica historii dla kanału LAMPY');
    }, { ...baza, ...KLUCZE_LAMPY });
  });

  it('B: wpis bez kluczy i bez OD — bez granicy; dopisane samo OD nie wystarcza; komplet kluczy przy kolejnym starcie zakłada granicę przed OD', async () => {
    const kanaly = JSON.stringify([{ klucz: 'lampy', typ: 'woo', prefiks: 'LAMPY', raport: 'LAMPY' },
      { klucz: 'allegro_aukcje', typ: 'allegro', prefiks: 'AUKCJE', raport: 'AUKCJE' }]);
    const bezKluczy = { ...baza, OMS_KANALY: kanaly };
    await sprawdz(() => {}, async (z, log) => {
      expect(granica(z.db, 'LAMPY')).toBeUndefined();
      expect(granica(z.db, 'AUKCJE')).toBeUndefined();
      expect(tekstLogu(log)).toMatch(/kanał LAMPY: granica do założenia ręcznie .* brak LAMPY_OD, niepełna konfiguracja \(brak LAMPY_URL, LAMPY_CK, LAMPY_CS, LAMPY_MAPOWANIE\)/);
      expect(tekstLogu(log)).toMatch(/kanał AUKCJE: granica do założenia ręcznie .* brak AUKCJE_OD, niepełna konfiguracja/);
      zamowienie(z.db);
      log.mockClear();
      const drugi = await zbudujOms({ env: { ...bezKluczy, LAMPY_OD: '2026-10-01' }, db: z.db, teraz, log });
      try {
        expect(granica(z.db, 'LAMPY')).toBeUndefined();
        expect(tekstLogu(log)).toMatch(/kanał LAMPY: granica do założenia ręcznie .* niepełna konfiguracja \(brak LAMPY_URL/);
        expect(tekstLogu(log)).not.toMatch(/brak LAMPY_OD/);
      } finally { await drugi.app.close(); }
      const trzeci = await zbudujOms({ env: { ...bezKluczy, ...KLUCZE_LAMPY, LAMPY_OD: '2026-10-01' }, db: z.db, teraz, log });
      try {
        expect(granica(z.db, 'LAMPY')).toBe('2026-09-30');
        expect(granica(z.db, 'AUKCJE')).toBeUndefined();
        const odp = await raport(trzeci);
        expect(odp.statusCode).toBe(200);
        expect(odp.body).toContain('123,00');
      } finally { await trzeci.app.close(); }
    }, bezKluczy);
  });

  it('INDYWIDUALNE dziedziczy OD sklepów: granica przed najwcześniejszym OD; sklep bez OD wstrzymuje ją do ręcznego', async () => {
    await sprawdz(() => {}, async z => {
      expect(granica(z.db, 'INDYWIDUALNE')).toBe('2026-09-30');
    }, { ...env, OMS_KANAL_INDYWIDUALNY: '1' });
    await sprawdz(() => {}, async (z, log) => {
      expect(granica(z.db, 'INDYWIDUALNE')).toBeUndefined();
      expect(tekstLogu(log)).toMatch(/kanał INDYWIDUALNE: granica do założenia ręcznie .* brak LAMPY_OD/);
    }, { ...baza, ...KLUCZE_LAMPY, OMS_KANAL_INDYWIDUALNY: '1' });
  });

  it('głośna odmowa: granica oms-bez-historii późniejsza niż zamówienie kanału — raport odmawia z kanałem i datami', async () => {
    await sprawdz(db => {
      ustawGranice(db, 'LAMPY', '2026-10-19', 'oms-bez-historii');
      zamowienie(db);
    }, async z => {
      const odp = await raport(z);
      expect(odp.statusCode).toBe(400);
      expect(odp.body).not.toContain('123,00');
      expect(odp.body).toContain('zamówienia kanału LAMPY sprzed granicy 2026-10-19');
      expect(odp.body).toContain('2026-10-10');
      expect(odp.body).toContain('--granice');
    });
    // Styk doby: 21:30 UTC 19.10 to 23:30 w Warszawie (dzień granicy — odmowa), 22:30 UTC to już 20.10 (liczy się).
    for (const [chwila, odmowa] of [['2026-10-19T21:30:00Z', true], ['2026-10-19T22:30:00Z', false]] as const) {
      await sprawdz(db => {
        ustawGranice(db, 'LAMPY', '2026-10-19', 'oms-bez-historii');
        db.prepare("INSERT INTO zamowienia (sklep,zrodlo_id,numer,utworzone_at,kwota_brutto) VALUES ('lampy','15','L-15',?,'45.00')").run(chwila);
      }, async z => {
        const odp = await raport(z);
        expect(odp.statusCode, chwila).toBe(odmowa ? 400 : 200);
        if (odmowa) expect(odp.body).toContain('zamówienia kanału LAMPY sprzed granicy 2026-10-19 (najwcześniejsze z dnia 2026-10-19)');
        else expect(odp.body).toContain('45,00');
      });
    }
    // Granica z pomiaru (kanał z historią) nie jest „bez historii” — strażnik jej nie dotyczy.
    await sprawdz(db => {
      ustawGranice(db, 'LAMPY', '2026-10-09', 'pomiar');
      zamowienie(db);
    }, async z => {
      const odp = await raport(z);
      expect(odp.statusCode).toBe(200);
      expect(odp.body).toContain('123,00');
    });
  });

  it('ręczne --granice po pierwszym pobraniu: kanał bez OD dostaje dzień przed najwcześniejszym zamówieniem', () => {
    const db = openOmsDb();
    try {
      zamowienie(db);
      const { zalozone } = zalozGranice(db, { ...baza, ...KLUCZE_LAMPY }, teraz());
      expect(zalozone).toContain('LAMPY=2026-10-09');
      expect(granica(db, 'LAMPY')).toBe('2026-10-09');
    } finally { db.close(); }
  });

  it('istniejące granice: zero zmian i zero zapisów także po drugim starcie', async () => {
    let przed: unknown;
    await sprawdz(db => {
      for (const k of ['B2B', 'DROPSHIPPING', 'RECZNE', 'LAMPY']) ustawGranice(db, k, '2026-08-31', 'pomiar');
      db.exec("UPDATE granice_historii SET uwaga='zachowaj'");
      przed = tabela(db);
      db.exec('CREATE TEMP TABLE zapisy_granic (operacja TEXT)');
      for (const operacja of ['INSERT', 'UPDATE', 'DELETE']) db.exec(`CREATE TEMP TRIGGER sledz_${operacja}
        AFTER ${operacja} ON granice_historii BEGIN INSERT INTO zapisy_granic VALUES ('${operacja}'); END;`);
    }, async (z, log) => {
      expect(tabela(z.db)).toEqual(przed);
      expect(z.db.prepare('SELECT COUNT(*) AS n FROM zapisy_granic').get()).toEqual({ n: 0 });
      expect(log.mock.calls.flat().join(' ')).not.toMatch(/granic/i);
      const drugi = await zbudujOms({ env, db: z.db, teraz, log });
      try {
        expect(tabela(z.db)).toEqual(przed);
        expect(z.db.prepare('SELECT COUNT(*) AS n FROM zapisy_granic').get()).toEqual({ n: 0 });
        expect(log.mock.calls.flat().join(' ')).not.toMatch(/granic/i);
      }
      finally { await drugi.app.close(); }
    });
  });

  it('błąd zapisu: panel startuje, raport odmawia i log wyjaśnia przyczynę', async () => {
    await sprawdz(db => {
      zamowienie(db);
      db.exec("CREATE TRIGGER odmowa_granicy BEFORE INSERT ON granice_historii WHEN NEW.kanal='LAMPY' BEGIN SELECT RAISE(ABORT, 'testowa odmowa zapisu'); END;");
    }, async (z, log) => {
      expect(z.app.hasRoute({ method: 'GET', url: '/' })).toBe(true);
      expect(tabela(z.db).some(w => w.kanal === 'LAMPY')).toBe(false);
      const odp = await raport(z);
      expect(odp.statusCode).toBe(400);
      expect(odp.body).toContain('restart panelu');
      expect(log.mock.calls.flat().join(' ')).toContain('testowa odmowa zapisu');
      expect(log.mock.calls.flat().join(' ')).toContain('LAMPY');
    });
  });
});
