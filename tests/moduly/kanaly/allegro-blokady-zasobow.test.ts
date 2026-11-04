import {afterEach,it,expect} from 'vitest';
import {fixtureAllegro,daneAllegro,aktorAllegro} from '../../pomoc/allegro-konfigurator.ts';
import {createRejestrKanalow} from '../../../src/moduly/kanaly/services/rejestr-kanalow.ts';
import {bladPrzejsciowy} from '../../../src/moduly/zamowienia/services/sync-sklep.js';
const fixtures:ReturnType<typeof fixtureAllegro>[]=[];
afterEach(()=>{for(const f of fixtures.splice(0))f.db.close();});
function setup(fetchImpl:typeof fetch){
 const f=fixtureAllegro();fixtures.push(f);const s=f.szkic();
 const k=daneAllegro(f.repo.zapiszZmiane(s.klucz,s.wersja,{autoryzacja:'polaczone',kontoId:'123'},aktorAllegro));
 const rejestr=createRejestrKanalow({repozytorium:f.repo,fetchImpl,limitCzasuMs:10,fabryki:({http})=>({klient:{
  wyslij:(sciezka:string,method='POST',body:any={})=>http('https://api.allegro.pl'+sciezka,{method,body:JSON.stringify(body)}),
 },poller:{stan:()=>null,przebieg:async()=>{}}})});
 return {...f,k,klient:rejestr.klient(k.klucz)};
}
it.each(['shipments','pickups'])('timeout %s blokuje tylko ten commandId, również gdy zmieni się input',async zasob=>{
 let calls=0;const f=setup(async(_u,i)=>{calls++;if(calls===1)return new Promise((_r,reject)=>i!.signal!.addEventListener('abort',()=>reject(i!.signal!.reason),{once:true}));return Response.json({});});
 const path=`/shipment-management/${zasob}/create-commands`;
 await expect(f.klient.wyslij(path,'POST',{commandId:'pierwszy',input:{}})).rejects.toThrow();
 await f.klient.wyslij(path,'POST',{commandId:'drugi',input:{}});
 await expect(f.klient.wyslij(path,'POST',{commandId:'pierwszy',input:{zmiana:true}})).rejects.toThrow(/niejednoznaczny/);
 expect(calls).toBe(2);expect(f.repo.niejednoznaczne(f.k.klucz)).toHaveLength(1);
});
it.each([
 ['PUT','/order/checkout-forms/1/fulfillment'],
 ['PUT','/order/checkout-forms/1/invoices/2/file'],
 ['POST','/shipment-management/pickup-proposals'],
 ['POST','/shipment-management/label'],
])('%s %s po awarii można ponowić bez przeglądu',async(method,path)=>{
 let calls=0;const f=setup(async()=>{if(++calls===1)throw Error('awaria');return Response.json({});});
 await expect(f.klient.wyslij(path,method)).rejects.toThrow();await f.klient.wyslij(path,method);
 expect(calls).toBe(2);expect(f.repo.niejednoznaczne(f.k.klucz)).toEqual([]);
});
it('5xx zachowuje status, Retry-After i opis rozpoznawany przez ponawianie statusów',async()=>{
 const f=setup(async()=>Response.json({},{status:503,headers:{'Retry-After':'30'}}));
 for(const [method,path] of [['POST','/order/checkout-forms/1/invoices'],['PUT','/order/checkout-forms/1/fulfillment']]){
  const e=await f.klient.wyslij(path,method).catch((e:Error)=>e);
  expect(e).toBeInstanceOf(Error);expect(e).toMatchObject({status:503,retryAfterS:30});expect(bladPrzejsciowy(e.message)).toBe(true);
 }
});
it('faktury są blokowane po zamówieniu, deklaracje załączników po nazwie i rozmiarze',async()=>{
 let calls=0;const f=setup(async()=>{if(++calls===1||calls===3)throw Error('awaria');return Response.json({});});
 await expect(f.klient.wyslij('/order/checkout-forms/1/invoices','POST',{numer:'1'})).rejects.toThrow();
 await f.klient.wyslij('/order/checkout-forms/2/invoices');
 await expect(f.klient.wyslij('/order/checkout-forms/1/invoices','POST',{numer:'2'})).rejects.toThrow(/niejednoznaczny/);
 const path='/messaging/message-attachments';
 await expect(f.klient.wyslij(path,'POST',{filename:'przyklad.pdf',size:10})).rejects.toThrow();
 await f.klient.wyslij(path,'POST',{filename:'inny.pdf',size:10});
 await f.klient.wyslij(path,'POST',{filename:'przyklad.pdf',size:11});
 await expect(f.klient.wyslij(path,'POST',{size:10,filename:'przyklad.pdf'})).rejects.toThrow(/niejednoznaczny/);
 expect(calls).toBe(5);expect(JSON.stringify(f.repo.niejednoznaczne(f.k.klucz))).not.toContain('przyklad.pdf');
});
it('niepotwierdzona wiadomość nie blokuje kolejnej wiadomości w tym samym wątku',async()=>{
 let calls=0;const f=setup(async()=>{if(++calls===1)throw Error('awaria');return Response.json({});});
 const path='/messaging/threads/watek/messages';
 await expect(f.klient.wyslij(path,'POST',{text:'Pierwsza wiadomość'})).rejects.toThrow();
 await f.klient.wyslij(path,'POST',{text:'Druga wiadomość'});
 await expect(f.klient.wyslij(path,'POST',{text:'Pierwsza wiadomość'})).rejects.toThrow(/niejednoznaczny/);
 expect(calls).toBe(2);expect(JSON.stringify(f.repo.niejednoznaczne(f.k.klucz))).not.toContain('Pierwsza');
});
it('rejestr wymusza redirect:error dla Allegro przy GET i PUT',async()=>{
 const tryby:unknown[]=[];
 const f=setup(async(_u,i)=>{tryby.push(i?.redirect);return Response.json({});});
 await f.klient.wyslij('/order/checkout-forms/1','GET');
 await f.klient.wyslij('/order/checkout-forms/1/fulfillment','PUT');
 expect(tryby).toEqual(['error','error']);
});
