import {it,expect} from 'vitest';
import {zbudujOms} from '../../pomoc/zbuduj-oms.ts';
import {tmpdir} from 'node:os';
import {zalozKonto,ustawUprawnienia,uprawnieniaKonta} from '../../../src/core/bezpieczenstwo/konta.js';
import {zalozCel,dopiszZdarzenie,zdarzeniaCelu} from '../../../src/oms/db/cele.js';
import {openOmsDb} from '../../../src/oms/db/db.ts';
import {vi} from 'vitest';
import {MODULY} from '../../../src/moduly/lista.ts';
const env={OMS_USER:'operator',OMS_PASS:'fixture',OMS_SPRZEDAWCA_NIP:'1234563218',OMS_RACHUNEK:'34109010140000000000000000',OMS_PROFORMY_KATALOG:tmpdir(),OMS_ETYKIETY_KATALOG:tmpdir()};
it('PRZ028C rzeczywista kompozycja rejestruje osiem tras Celów i nie uruchamia zegarów marketingu',async()=>{
 const a=await zbudujOms({moduly:MODULY,env});
 try{
 const h={authorization:'Basic '+Buffer.from('operator:fixture').toString('base64'),origin:'http://localhost'};
 for(const [method,url] of [['GET','/cele'],['GET','/cele/nowy'],['GET','/cele/:id'],['POST','/cele'],['POST','/cele/:id'],['POST','/cele/:id/zdarzenie'],['POST','/cele/:id/cofnij'],['POST','/cele/:id/czynny']])expect(a.app.hasRoute({method:method as any,url})).toBe(true);
 for(const url of ['/cele','/cele/nowy']){
 const r=await a.app.inject({method:'GET',url,headers:h});expect(r.statusCode).toBe(200);expect(r.body).toContain('Cele');}
 expect(MODULY.find(m=>m.nazwa==='marketing')?.menu.map(m=>m.adres)).toEqual(['/kampania','/cele']);
 expect(a.app.hasRoute({method:'GET',url:'/kampania'})).toBe(true);
 expect(a.zegary.map(z=>z.nazwa).filter(n=>/marketing|kampani|reklam|meta|ga4|cele/i.test(n))).toEqual(['czuwaczReklam']);
 const finance=await a.app.inject({method:'GET',url:'/finanse',headers:h});expect(finance.statusCode).toBe(400);expect(finance.body).toContain('podłogi danych kosztów');
 }finally{await a.app.close();a.db.close();}
});

it('PRZ028C rzeczywisty HTTP chroni Cele ptaszkiem i zachowuje świadomie odebrane prawo',async()=>{
 const db=openOmsDb();const zabrane=zalozKonto(db,{login:'zabrane',imie:'Z',haslo:'fixture',rola:'sprzedaz'}),przyznane=zalozKonto(db,{login:'przyznane',imie:'P',haslo:'fixture',rola:'sprzedaz'});
 ustawUprawnienia(db,zabrane,[]);ustawUprawnienia(db,przyznane,['cele']);
 const a=await zbudujOms({moduly:MODULY,env,db});
 try{expect(uprawnieniaKonta(db,zabrane).has('cele')).toBe(false);expect(uprawnieniaKonta(db,przyznane).has('cele')).toBe(true);
 for(const [login,status]of [['zabrane',403],['przyznane',200]]as const){
  const l=await a.app.inject({method:'POST',url:'/login',headers:{origin:'http://localhost'},payload:{uzytkownik:login,haslo:'fixture'}});expect(l.statusCode).toBe(302);
  const cookie=String(l.headers['set-cookie']).split(';')[0];
  for(const url of ['/cele','/cele/nowy']){const r=await a.app.inject({method:'GET',url,headers:{cookie}});expect(r.statusCode).toBe(status);}
  const zapis=await a.app.inject({method:'POST',url:'/cele',headers:{cookie,origin:'http://localhost'},payload:{nazwa:'Zadanie syntetyczne',rytm:'tydzien',miernik:'reczny'}});expect(zapis.statusCode).toBe(status===403?403:302);
 }
 const nowe=zalozKonto(db,{login:'nowe',imie:'N',haslo:'fixture',rola:'sprzedaz'});expect(uprawnieniaKonta(db,nowe).has('cele')).toBe(true);
 expect(db.prepare('SELECT COUNT(*) AS n FROM kampanie').get()?.n).toBe(0);
 }finally{await a.app.close();db.close();}
});
it('PRZ028C próba nie tworzy zegarów marketingu ani nie wykonuje transportu',async()=>{
 const network=vi.spyOn(globalThis,'fetch').mockRejectedValue(new Error('Sieć zabroniona'));
 const a=await zbudujOms({moduly:MODULY,env:{...env,OMS_TRYB:'proba'}});
 try{expect(a.zegary.map(z=>z.nazwa).filter(n=>/marketing|kampani|reklam|meta|ga4|cele/i.test(n))).toEqual([]);
 const r=await a.app.inject({method:'GET',url:'/cele',headers:{authorization:'Basic '+Buffer.from('operator:fixture').toString('base64')}});expect(r.statusCode).toBe(200);expect(network).not.toHaveBeenCalled();
 }finally{await a.app.close();a.db.close();network.mockRestore();}
});

it('PRZ028C POST cofnij w pustym tygodniu zachowuje poprzednią historię',async()=>{
 vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date('2031-06-04T10:00:00Z'));
 const db=openOmsDb();const id=zalozCel(db,{nazwa:'Historia',kontoId:null,rytm:'tydzien',celIle:3,miernik:'reczny',odDnia:null,doDnia:null});
 dopiszZdarzenie(db,{celId:id,dzien:'2031-06-01',ile:2});
 const a=await zbudujOms({moduly:MODULY,env,db});
 try{const r=await a.app.inject({method:'POST',url:'/cele/'+id+'/cofnij',headers:{authorization:'Basic '+Buffer.from('operator:fixture').toString('base64'),origin:'http://localhost'},payload:{}});
 expect(r.statusCode).toBe(302);expect(zdarzeniaCelu(db,id).map((z:any)=>({dzien:z.dzien,ile:z.ile}))).toEqual([{dzien:'2031-06-01',ile:2}]);
 }finally{await a.app.close();db.close();vi.useRealTimers();}
});
it('PRZ028C rzeczywista osoba zapisuje swoje id w zdarzeniu przez POST',async()=>{
 const db=openOmsDb();const user=zalozKonto(db,{login:'aktor',imie:'Aktor',haslo:'fixture',rola:'sprzedaz'});
 const id=zalozCel(db,{nazwa:'Id osoby',kontoId:null,rytm:'tydzien',celIle:3,miernik:'reczny',odDnia:null,doDnia:null});
 const a=await zbudujOms({moduly:MODULY,env,db});
 try{const l=await a.app.inject({method:'POST',url:'/login',headers:{origin:'http://localhost'},payload:{uzytkownik:'aktor',haslo:'fixture'}});expect(l.statusCode).toBe(302);
 const cookie=String(l.headers['set-cookie']).split(';')[0];
 const r=await a.app.inject({method:'POST',url:'/cele/'+id+'/zdarzenie',headers:{cookie,origin:'http://localhost'},payload:{ile:'2'}});expect(r.statusCode).toBe(302);
 expect(zdarzeniaCelu(db,id).map((z:any)=>({konto_id:z.konto_id,imie:z.imie_konta,ile:z.ile}))).toEqual([{konto_id:user,imie:'Aktor',ile:2}]);
 }finally{await a.app.close();db.close();}
});
