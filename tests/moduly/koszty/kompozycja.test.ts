import { describe, it, expect, vi } from 'vitest';
import { tmpdir } from 'node:os';
import { zbudujOms } from '../../../src/oms/bootstrap.ts';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { wczytajSekret } from '../../../src/core/bezpieczenstwo/sekret-sesji.js';
import { modulRdzen } from '../../../src/moduly/rdzen/modul.ts';
import { modulWeb } from '../../../src/core/web/modul.ts';
import { modulKanaly } from '../../../src/moduly/kanaly/modul.ts';
import { modulFaktury } from '../../../src/moduly/faktury/modul.ts';
import { modulKoszty } from '../../../src/moduly/koszty/modul.ts';

const env = { OMS_USER: 'operator', OMS_PASS: 'fixture',
  OMS_SPRZEDAWCA_NIP: '1234563218', OMS_RACHUNEK: '34109010140000000000000000',
  OMS_PROFORMY_KATALOG: tmpdir(), OMS_ETYKIETY_KATALOG: tmpdir() };
const headers = { authorization: `Basic ${Buffer.from('operator:fixture').toString('base64')}` };

describe('PRZ-025 rzeczywista kompozycja bootstrapu', () => {
  it('baza przygotowana przez fabrykę i initializer sekretu Web pozwala czytać koszty po zablokowaniu zapisów', async () => {
    const db = openOmsDb();
    wczytajSekret(db);
    const zapis = vi.fn(() => { throw new Error('SQLITE_FULL: database or disk is full'); });
    const bazaBezZapisow = {
      prepare(sql: string) {
        const st = db.prepare(sql);
        return { get: (...a: any[]) => st.get(...a), all: (...a: any[]) => st.all(...a), run: zapis };
      },
      exec: (sql: string) => db.exec(sql),
      get isTransaction() { return db.isTransaction; },
    };
    let z: Awaited<ReturnType<typeof zbudujOms>> | undefined;
    try {
      expect(db.prepare('SELECT count(*) n FROM slownik_kategorii_kosztow').get()?.n).toBe(11);
      const budowa = zbudujOms({env,db:bazaBezZapisow as any,
        moduly:[modulRdzen,modulWeb,modulKanaly,modulFaktury,modulKoszty] as any});
      // Rejection po powtórnym INSERT ma być błędem asercji, a nie nieobsłużonym wyjątkiem.
      await expect(budowa).resolves.toHaveProperty('app');
      z = await budowa;
      const lista = await z.app.inject({method:'GET',url:'/koszty',headers});
      expect(lista.statusCode).toBe(200);
      expect(lista.body).toContain('Koszty');
      expect(db.prepare('SELECT count(*) n FROM slownik_kategorii_kosztow').get()?.n).toBe(11);
      expect(zapis).not.toHaveBeenCalled();
    } finally {
      try { if (z) await z.app.close(); } finally { db.close(); }
    }
  });

  it('czyta lustro kosztów bez integracji i udostępnia wszystkie trasy operatora', async () => {
    const transport = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Sieć zabroniona'));
    const z = await zbudujOms({ env });
    try {
      const lista = await z.app.inject({ method: 'GET', url: '/koszty', headers });
      expect(lista.statusCode).toBe(200);
      expect(lista.body).toContain('Koszty');
      for (const [method, url] of [
        ['GET', '/koszty/reczne/:klucz'], ['GET', '/koszty/:ksefNumber/pdf'],
        ['POST', '/koszty/kategoria'], ['POST', '/koszty/odswiez'],
        ['POST', '/koszty/reczne'], ['POST', '/koszty/firmy'],
        ['POST', '/koszty/reczne/:klucz'], ['POST', '/koszty/reczne/:klucz/usun'],
      ] as const) expect(z.app.hasRoute({ method, url })).toBe(true);
      expect(z.usluga('koszty', 'czuwaczKosztow')).toBeNull();
      expect(z.zegary.map(x => x.nazwa)).not.toContain('czuwaczKosztow');
      expect(transport).not.toHaveBeenCalled();
    } finally { await z.app.close(); z.db.close(); transport.mockRestore(); }
  });

  it('paczka faktur używa rzeczywistej usługi kosztów i współdzielonego inFaktu po budowie', async () => {
    const infakt = { listaFaktur: vi.fn().mockResolvedValue([]), listaKorekt: vi.fn().mockResolvedValue([]) };
    const transport = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Sieć zabroniona'));
    const z = await zbudujOms({ env: { ...env, INFAKT_API_KEY: 'fixture-key' },
      nadpisania: { 'faktury.infakt': infakt } });
    try {
      const paczka = z.usluga<any>('faktury', 'paczkaDlaBiura');
      const kosztowa = z.usluga<any>('koszty', 'paczkaDlaBiura');
      expect(kosztowa).toHaveProperty('zbuduj');
      expect(kosztowa).toHaveProperty('zbudujZestawieniePrzychodow');
      const wynik = await paczka.zbudujZestawieniePrzychodow('2026-08');
      expect(wynik.dokumentow).toBe(0);
      expect(wynik.bajty.subarray(0, 5).toString()).toBe('%PDF-');
      expect(infakt.listaFaktur).toHaveBeenCalledWith({ od: '2026-08-01', do: '2026-08-31', pole: 'sale_date' });
      expect(infakt.listaKorekt).toHaveBeenCalledWith({ od: '2026-08-01', do: '2026-08-31', pole: 'invoice_date' });
      expect(transport).not.toHaveBeenCalled();
    } finally { await z.app.close(); z.db.close(); transport.mockRestore(); }
  });
});
