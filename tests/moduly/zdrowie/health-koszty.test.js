import {describe,it,expect,vi,afterEach} from 'vitest';
import {tmpdir} from 'node:os';
import {zbudujOms} from '../../../src/oms/bootstrap.ts';

const env={OMS_SPRZEDAWCA_NIP:'1234563218',OMS_RACHUNEK:'34109010140000000000000000',
  OMS_USER:'operator',OMS_PASS:'test',OMS_PROFORMY_KATALOG:tmpdir(),OMS_ETYKIETY_KATALOG:tmpdir()};
const teraz=()=>new Date('2026-10-01T12:00:00Z');
const aktualny='2026-10-01T12:00:00.000Z';
const przeterminowany='2026-09-29T12:00:00.000Z';
function zapiszStan(db,ostatnieUdaneAt){
  db.prepare(`INSERT INTO stan_kosztow(id,ostatnie_udane_at,ostatni_blad,ostatni_blad_at)
    VALUES(1,?,NULL,NULL) ON CONFLICT(id) DO UPDATE SET ostatnie_udane_at=excluded.ostatnie_udane_at,
    ostatni_blad=NULL,ostatni_blad_at=NULL`).run(ostatnieUdaneAt);
}
afterEach(()=>vi.unstubAllGlobals());
describe('PRZ-025/030 — rzeczywiste koszty w HTTP health',()=>{
  it('manifest włącza koszty, a health odczytuje zmieniający się stan tej samej DB bez sieci',async()=>{
    vi.stubGlobal('fetch',vi.fn(async()=>{throw Error('Sieć zabroniona w odbiorze health');}));
    const a=await zbudujOms({env:{...env,KSEF_TOKEN:'FIXTURE-NIE-UJAWNIAJ-KSEF',KSEF_API:'https://ksef.invalid'},teraz});
    try{
      expect(a.usluga('koszty','ksefKlient')).toBeTruthy();
      expect(a.usluga('koszty','kosztyWlaczone')).toBe(true);
      // Konstrukcja klienta i zegara nie jest ich uruchomieniem.
      zapiszStan(a.db,aktualny);
      expect(a.usluga('koszty','stanKosztow')().ostatnie_udane_at).toBe(aktualny);
      const r=await a.app.inject('/health');
      expect(r.statusCode,r.body).toBe(200);
      expect(r.json().czuwaczKosztow).toMatchObject({wlaczony:true,zdrowy:true,ostatnieUdaneAt:aktualny,wiekS:0});
      expect(r.body).not.toContain('FIXTURE-NIE-UJAWNIAJ-KSEF');
      zapiszStan(a.db,przeterminowany);
      expect(a.usluga('koszty','stanKosztow')().ostatnie_udane_at).toBe(przeterminowany);
      const stary=(await a.app.inject('/health')).json();
      expect(stary.czuwaczKosztow).toMatchObject({wlaczony:true,zdrowy:false,ostatnieUdaneAt:przeterminowany,wiekS:48*3600});
      expect(stary.ok).toBe(false);
      expect(stary.alarmy.some(x=>x.includes('czuwacz kosztów: ostatnie udane pobranie'))).toBe(true);
      expect(fetch).not.toHaveBeenCalled();
    }finally{await a.app.close();a.db.close();}
  });
  it('bez tokenu prawdziwy manifest wyłącza koszty, nawet gdy DB zawiera przeterminowany stan',async()=>{
    vi.stubGlobal('fetch',vi.fn(async()=>{throw Error('Sieć zabroniona w odbiorze health');}));
    const a=await zbudujOms({env,teraz});
    try{
      expect(a.usluga('koszty','ksefKlient')).toBeNull();
      expect(a.usluga('koszty','kosztyWlaczone')).toBe(false);
      zapiszStan(a.db,przeterminowany);
      const r=await a.app.inject('/health');
      expect(r.statusCode,r.body).toBe(200);
      expect(r.json().czuwaczKosztow).toMatchObject({wlaczony:false,zdrowy:true,ostatnieUdaneAt:null,wiekS:null});
      expect(r.json().alarmy.some(x=>x.includes('czuwacz kosztów'))).toBe(false);
      expect(fetch).not.toHaveBeenCalled();
    }finally{await a.app.close();a.db.close();}
  });
});
