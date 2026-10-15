import {it,expect,vi} from 'vitest';
import {zbudujOms} from '../../pomoc/zbuduj-oms.ts';
import {MODULY} from '../../../src/moduly/lista.ts';
import {tmpdir} from 'node:os';
const env={OMS_USER:'operator',OMS_PASS:'fixture',OMS_SPRZEDAWCA_NIP:'1234563218',OMS_RACHUNEK:'34109010140000000000000000',OMS_PROFORMY_KATALOG:tmpdir(),OMS_ETYKIETY_KATALOG:tmpdir(),OMS_REKLAMY_SEKRETY_DIR:tmpdir()};
const h={authorization:'Basic '+Buffer.from('operator:fixture').toString('base64'),origin:'http://localhost'};
it('K rzeczywiste HTTP rejestruje warianty reklam i integracje, pusty start bez kampanii firmy',async()=>{
 const network=vi.spyOn(globalThis,'fetch').mockRejectedValue(Error('Sieć zabroniona'));
 const a=await zbudujOms({moduly:MODULY,env});
 try{
 for(const widok of ['', 'podsumowanie','google','meta','kampanie']){
  const r=await a.app.inject({method:'GET',url:'/kampania'+(widok?'?widok='+widok:''),headers:h});
  expect(r.statusCode).toBe(200);expect(r.body).toContain('Reklamy');
 }
 const r=await a.app.inject({method:'GET',url:'/ustawienia/integracje/reklamy',headers:h});
 expect(r.statusCode).toBe(200);expect(r.body).toContain('Integracje reklam');expect(r.body).toContain('Google przez GA4');
 const wspolny=await a.app.inject({method:'GET',url:'/ustawienia/integracje',headers:h});expect(wspolny.body).toContain('Google przez GA4');
 for(const url of ['/kampania/odswiez','/kampania/odswiez-reklamy','/ustawienia/integracje/reklamy/zapisz','/ustawienia/integracje/reklamy/test'])expect(a.app.hasRoute({method:'POST',url})).toBe(true);
 expect(a.db.prepare('SELECT COUNT(*) AS n FROM kampanie').get()?.n).toBe(0);
 expect(MODULY.find(m=>m.nazwa==='marketing')?.menu.map(m=>m.adres)).toEqual(['/kampania','/cele']);
 expect(network).not.toHaveBeenCalled();
 }finally{await a.app.close();a.db.close();network.mockRestore();}
});
