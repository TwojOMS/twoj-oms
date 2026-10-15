import { describe, it, expect, vi } from 'vitest';
import { tmpdir } from 'node:os';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve, dirname, basename } from 'node:path';
import { zbudujOms } from '../../../src/oms/bootstrap.ts';
import { modulRdzen } from '../../../src/moduly/rdzen/modul.ts';
import { modulWeb } from '../../../src/core/web/modul.ts';
import { modulKanaly } from '../../../src/moduly/kanaly/modul.ts';
import { modulFaktury } from '../../../src/moduly/faktury/modul.ts';
import { createModulKoszty, wczytajKoszty, ODSTEP_KOSZTOW_MS } from '../../../src/moduly/koszty/modul.ts';
import { NAJDLUZSZY_PRZEBIEG_KOSZTOW_MS } from '../../../src/moduly/koszty/services/czuwacz-kosztow.js';
import { ODSTEP_OKNA_POBRANIA_MS } from '../../../src/domena/pora-pobrania.js';
import { createSesjaKsef } from '../../../src/oms/ksef/sesja.js';

vi.mock('../../../src/oms/ksef/sesja.js', async () => {
  const rzeczywisty = await vi.importActual<any>('../../../src/oms/ksef/sesja.js');
  return { ...rzeczywisty, createSesjaKsef: vi.fn(rzeczywisty.createSesjaKsef) };
});

const env = { OMS_USER:'operator',OMS_PASS:'fixture',OMS_SPRZEDAWCA_NIP:'1234563218',
  OMS_RACHUNEK:'34109010140000000000000000',OMS_PROFORMY_KATALOG:tmpdir(),KSEF_TOKEN:'fixture-token' };
const headers = { authorization:`Basic ${Buffer.from('operator:fixture').toString('base64')}` };

describe('PRZ-025 realna kompozycja KSeF', () => {
  it('budżet porównuje z dobą, zachowuje godzinny zegar i odmawia sprzecznego NIP', () => {
    expect(NAJDLUZSZY_PRZEBIEG_KOSZTOW_MS).toBeGreaterThan(ODSTEP_KOSZTOW_MS);
    expect(NAJDLUZSZY_PRZEBIEG_KOSZTOW_MS).toBeLessThan(ODSTEP_OKNA_POBRANIA_MS);
    expect(() => wczytajKoszty(env)).not.toThrow();
    expect(wczytajKoszty(env).odstepMs).toBe(3600000);
    expect(wczytajKoszty(env).ksef?.nip).toBe(env.OMS_SPRZEDAWCA_NIP);
    expect(() => wczytajKoszty({...env,KSEF_NIP:'1000001193'})).toThrow('KSEF_NIP');
  });
  it('czuwacz i PDF HTTP korzystają z jednego klienta i jednej trwałej sesji', async () => {
    const katalog = mkdtempSync(join(tmpdir(),'prz025-archiwum-'));
    const metadane = { ksefNumber:'K-FIXTURE',invoiceNumber:'FV/FIXTURE',issueDate:'2026-06-05',
      permanentStorageDate:'2026-06-05T10:00:00Z',seller:{nip:'1111111111',name:'Fixture'},
      netAmount:100,vatAmount:23,grossAmount:123,currency:'PLN',invoiceType:'Vat',hasAttachment:false };
    const klient = { zaloguj:vi.fn().mockResolvedValue({accessToken:'fixture-access',accessDo:'2027-01-01T00:00:00Z',
      refreshToken:'fixture-refresh',refreshDo:'2027-02-01T00:00:00Z'}), odswiez:vi.fn(),
      pobierzMetadane:vi.fn().mockResolvedValue({faktury:[metadane],hasMore:false,isTruncated:false}),
      pobierzXml:vi.fn().mockResolvedValue('<Faktura/>') };
    const fabryka = vi.fn().mockReturnValue(klient);
    const transport = vi.spyOn(globalThis,'fetch').mockRejectedValue(new Error('Sieć zabroniona'));
    vi.mocked(createSesjaKsef).mockClear();
    let z: Awaited<ReturnType<typeof zbudujOms>> | undefined;
    try {
      const chwila = new Date('2026-08-12T12:00:00Z');
      vi.useFakeTimers({toFake:['Date']});
      vi.setSystemTime(chwila);
      z = await zbudujOms({env:{...env,KSEF_ARCHIWUM:katalog},teraz:()=>new Date(chwila.getTime()),
        moduly:[modulRdzen,modulWeb,modulKanaly,modulFaktury,createModulKoszty({createKlient:fabryka as any})] as any});
      expect(fabryka).toHaveBeenCalledTimes(1);
      expect(createSesjaKsef).toHaveBeenCalledTimes(1);
      expect(fabryka).toHaveBeenCalledWith(expect.objectContaining({nip:env.OMS_SPRZEDAWCA_NIP}));
      expect(z.usluga('koszty','ksefKlient')).toBe(klient);
      await z.usluga<any>('koszty','czuwaczKosztow').przebieg({wymuszony:true});
      const w = z.db.prepare("SELECT sciezka_xml,sciezka_pdf FROM koszty WHERE ksef_number='K-FIXTURE'").get();
      expect(w?.sciezka_xml).toEqual(expect.any(String));
      expect(w?.sciezka_pdf).toEqual(expect.any(String));
      expect(readFileSync(join(katalog,String(w?.sciezka_xml)),'utf8')).toBe('<Faktura/>');
      expect(readFileSync(join(katalog,String(w?.sciezka_pdf))).subarray(0,5).toString()).toBe('%PDF-');
      const r = await z.app.inject({method:'GET',url:'/koszty/K-FIXTURE/pdf',headers});
      expect(r.statusCode).toBe(200);
      expect(r.rawPayload.subarray(0,5).toString()).toBe('%PDF-');
      expect(klient.zaloguj).toHaveBeenCalledTimes(1);
      expect(klient.odswiez).not.toHaveBeenCalled();
      expect(klient.pobierzMetadane).toHaveBeenCalledWith(expect.objectContaining({accessToken:'fixture-access'}));
      expect(klient.pobierzXml).toHaveBeenCalledWith({accessToken:'fixture-access',ksefNumber:'K-FIXTURE'});
      expect(z.usluga<()=>any>('koszty','stanKosztow')()).toHaveProperty('ostatnie_udane_at','2026-08-12T12:00:00.000Z');
      expect(transport).not.toHaveBeenCalled();
    } finally {
      try { if (z) { try { await z.app.close(); } finally { z.db.close(); } } }
      finally {
        transport.mockRestore(); vi.useRealTimers();
        const cel = resolve(katalog);
        if (dirname(cel)!==resolve(tmpdir()) || !basename(cel).startsWith('prz025-archiwum-')) throw new Error('Nieprawidłowy katalog fixture');
        rmSync(cel,{recursive:true,force:true});
      }
    }
  });
});
