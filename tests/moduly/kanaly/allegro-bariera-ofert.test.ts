// Bariera zapisu Allegro dla ofert, prognozy opłat i odczytu operacji.
// Każde sprawdzenie porównuje wynik (status albo tekst błędu), żeby mutacja dawała czytelny AssertionError.
import {afterEach,describe,it,expect} from 'vitest';
import {fixtureAllegro,daneAllegro,aktorAllegro} from '../../pomoc/allegro-konfigurator.ts';
import {createRejestrKanalow,zasobZapisu} from '../../../src/moduly/kanaly/services/rejestr-kanalow.ts';
const fixtures:ReturnType<typeof fixtureAllegro>[]=[];
afterEach(()=>{for(const f of fixtures.splice(0))f.db.close();});
const API='https://api.allegro.pl',UPLOAD='https://upload.allegro.pl';
type Wywolanie={url:string;metoda:string;redirect:unknown;body:unknown};
/** Atrapa sieci zachowuje się jak fetch: przekierowanie przy redirect:'error' to TypeError, przy 'manual' — odpowiedź. */
function setup(odpowiedz:(w:Wywolanie,nr:number)=>Response|'zawies'){
 const f=fixtureAllegro();fixtures.push(f);const s=f.szkic();
 const k=daneAllegro(f.repo.zapiszZmiane(s.klucz,s.wersja,{autoryzacja:'polaczone',kontoId:'123'},aktorAllegro));
 const wywolania:Wywolanie[]=[];
 const fetchImpl=(async(u:string|URL|Request,i?:RequestInit)=>{
  const w={url:String(u),metoda:(i?.method??'GET').toUpperCase(),redirect:i?.redirect,body:i?.body};wywolania.push(w);
  const r=odpowiedz(w,wywolania.length);
  if(r==='zawies')return new Promise<Response>((_r,reject)=>i!.signal!.addEventListener('abort',()=>reject(i!.signal!.reason),{once:true}));
  if(r.status>=300&&r.status<400&&i?.redirect!=='manual')throw new TypeError('fetch failed: redirect');
  return r;
 }) as typeof fetch;
 const rejestr=createRejestrKanalow({repozytorium:f.repo,fetchImpl,limitCzasuMs:10,fabryki:({http})=>({klient:{
  wyslij:(adres:string,init:RequestInit={})=>http(adres,init),
 },poller:{stan:()=>null,przebieg:async()=>{}}})});
 const klient=rejestr.klient(k.klucz);
 const wynik=(adres:string,init:RequestInit={})=>klient.wyslij(adres,init).then((r:Response)=>'HTTP '+r.status,(e:Error)=>'błąd: '+e.message);
 return {...f,k,wywolania,wynik};
}
const oferta=(externalId:string,nazwa='Lampa biurkowa Półcień')=>({method:'POST',body:JSON.stringify({name:nazwa,external:{id:externalId}})});

describe('wystawienie oferty i wgranie zdjęcia',()=>{
 it('timeout jednego wystawienia nie blokuje oferty z innym external.id; ten sam external.id czeka na przegląd',async()=>{
  const f=setup((_w,nr)=>nr===1?'zawies':Response.json({id:'oferta'}));
  expect(await f.wynik(API+'/sale/product-offers',oferta('karta-1'))).toMatch(/^błąd: /);
  expect(await f.wynik(API+'/sale/product-offers',oferta('karta-2'))).toBe('HTTP 200');
  expect(await f.wynik(API+'/sale/product-offers',oferta('karta-1','Lampa wisząca Półcień'))).toMatch(/niejednoznaczny/);
  expect(f.wywolania).toHaveLength(2);
  const wiersze=f.repo.niejednoznaczne(f.k.klucz);
  expect(wiersze.map(w=>[w.metoda,w.sciezka])).toEqual([['POST',zasobZapisu('/sale/product-offers',oferta('karta-1'))]]);
  expect(wiersze[0].sciezka).toMatch(/^\/sale\/product-offers#[0-9a-f]{64}$/);
  expect(JSON.stringify(wiersze)).not.toContain('karta-1');
 });
 it('wystawienie bez external.id jest odrzucane przed siecią',async()=>{
  const f=setup(()=>Response.json({}));
  expect(await f.wynik(API+'/sale/product-offers',{method:'POST',body:JSON.stringify({name:'Lampa'})})).toMatch(/Brak identyfikatora/);
  expect(f.wywolania).toHaveLength(0);
 });
 it('zwolnijOperacje odblokowuje ten jeden zasób, nie rusza innych ani decyzji operatora',async()=>{
  const f=setup((_w,nr)=>nr<=2?'zawies':Response.json({id:'oferta'}));
  expect(await f.wynik(API+'/sale/product-offers',oferta('karta-1'))).toMatch(/^błąd: /);
  expect(await f.wynik(API+'/sale/product-offers',oferta('karta-2'))).toMatch(/^błąd: /);
  const zasob1=zasobZapisu('/sale/product-offers',oferta('karta-1')),zasob2=zasobZapisu('/sale/product-offers',oferta('karta-2'));
  expect(f.repo.zwolnijOperacje(f.k.klucz,'POST',zasob1)).toBe(1);
  expect(await f.wynik(API+'/sale/product-offers',oferta('karta-1'))).toBe('HTTP 200');
  expect(await f.wynik(API+'/sale/product-offers',oferta('karta-2'))).toMatch(/niejednoznaczny/);
  expect(f.repo.niejednoznaczne(f.k.klucz).map(w=>w.sciezka)).toEqual([zasob2]);
  // Blokada zostawiona przez operatora w przeglądzie zostaje — zwalnia ją tylko człowiek.
  f.db.prepare("UPDATE kanaly_operacje_niejednoznaczne SET stan='zablokowana' WHERE sciezka=?").run(zasob2);
  expect(f.repo.zwolnijOperacje(f.k.klucz,'POST',zasob2)).toBe(0);
  expect(await f.wynik(API+'/sale/product-offers',oferta('karta-2'))).toMatch(/niejednoznaczny/);
  expect(f.repo.zwolnijOperacje('allegro_inny','POST',zasob2)).toBe(0);
 });
 it('wgranie zdjęcia: zasób to skrót bajtów — inne zdjęcie przechodzi, te same bajty czekają',async()=>{
  const f=setup((_w,nr)=>nr===1?'zawies':Response.json({location:'https://a.allegroimg.example/zdjecie'}));
  const zdjecie=(b:number[])=>({method:'POST',headers:{'Content-Type':'image/jpeg'},body:new Uint8Array(b)});
  expect(await f.wynik(UPLOAD+'/sale/images',zdjecie([1,2,3]))).toMatch(/^błąd: /);
  expect(await f.wynik(UPLOAD+'/sale/images',zdjecie([4,5,6]))).toBe('HTTP 200');
  expect(await f.wynik(UPLOAD+'/sale/images',zdjecie([1,2,3]))).toMatch(/niejednoznaczny/);
  expect(f.wywolania.map(w=>w.url)).toEqual([UPLOAD+'/sale/images',UPLOAD+'/sale/images']);
  expect(f.repo.niejednoznaczne(f.k.klucz).map(w=>w.sciezka)).toEqual([zasobZapisu('/sale/images',zdjecie([1,2,3]))]);
  expect(zasobZapisu('/sale/images',{body:new Uint8Array([1,2,3]).buffer})).toBe(zasobZapisu('/sale/images',zdjecie([1,2,3])));
 });
});

describe('prognoza opłat nie jest zapisem',()=>{
 const prognoza={method:'POST',body:JSON.stringify({offer:{category:{id:'257150'}}})};
 it('timeout prognozy nie tworzy wiersza przeglądu, kolejna prognoza przechodzi — także przy wstrzymanych zapisach',async()=>{
  const f=setup((_w,nr)=>nr===1?'zawies':Response.json({commissions:[]}));
  expect(await f.wynik(API+'/pricing/offer-fee-preview',prognoza)).toMatch(/^błąd: /);
  expect(f.repo.niejednoznaczne(f.k.klucz)).toEqual([]);
  expect(await f.wynik(API+'/pricing/offer-fee-preview',prognoza)).toBe('HTTP 200');
  f.repo.zablokujZapisy(f.k.klucz,aktorAllegro);
  expect(await f.wynik(API+'/pricing/offer-fee-preview',prognoza)).toBe('HTTP 200');
  expect(f.wywolania).toHaveLength(3);
 });
});

describe('przekierowanie 303 przy odczycie operacji',()=>{
 const zPrzekierowaniem=()=>new Response(null,{status:303,headers:{Location:API+'/sale/product-offers/7700001'}});
 it('GET operacji oferty z 303 oddaje odpowiedź z nagłówkiem Location',async()=>{
  const f=setup(()=>zPrzekierowaniem());
  const adres=API+'/sale/product-offers/7700001/operations/op-1';
  expect(await f.wynik(adres)).toBe('HTTP 303');
  expect(f.wywolania.map(w=>w.redirect)).toEqual(['manual']);
 });
 it.each([
  ['GET','/sale/product-offers/7700001'],
  ['GET','/order/checkout-forms/1'],
  ['GET','/sale/product-offers/7700001/operations/op-1/inne'],
 ])('%s %s z przekierowaniem nadal odmawia',async(metoda,sciezka)=>{
  const f=setup(()=>zPrzekierowaniem());
  expect(await f.wynik(API+sciezka,{method:metoda})).toMatch(/^błąd: /);
  expect(f.wywolania.map(w=>w.redirect)).toEqual(['error']);
 });
});

describe('regresja: nadania i faktury jak przed zmianą',()=>{
 it('create-commands nadal rozróżnia zasób po commandId',async()=>{
  const f=setup((_w,nr)=>nr===1?'zawies':Response.json({}));
  const komenda=(id:string)=>({method:'POST',body:JSON.stringify({commandId:id,input:{}})});
  expect(await f.wynik(API+'/shipment-management/shipments/create-commands',komenda('nadanie-1'))).toMatch(/^błąd: /);
  expect(await f.wynik(API+'/shipment-management/shipments/create-commands',komenda('nadanie-2'))).toBe('HTTP 200');
  expect(await f.wynik(API+'/shipment-management/shipments/create-commands',komenda('nadanie-1'))).toMatch(/niejednoznaczny/);
  expect(f.repo.niejednoznaczne(f.k.klucz).map(w=>w.sciezka)).toEqual([zasobZapisu('/shipment-management/shipments/create-commands',komenda('nadanie-1'))]);
  expect(zasobZapisu('/shipment-management/shipments/create-commands',komenda('nadanie-1'))).toMatch(/^\/shipment-management\/shipments\/create-commands#[0-9a-f]{64}$/);
 });
 it('POST faktury z timeoutem trafia do przeglądu i blokuje kolejną fakturę tego zamówienia',async()=>{
  const f=setup((_w,nr)=>nr===1?'zawies':Response.json({id:'faktura'}));
  const faktura={method:'POST',body:JSON.stringify({file:{name:'FV-1.pdf'},invoiceNumber:'FV/1/2026'})};
  expect(await f.wynik(API+'/order/checkout-forms/zam-1/invoices',faktura)).toMatch(/^błąd: /);
  expect(f.repo.niejednoznaczne(f.k.klucz).map(w=>[w.metoda,w.sciezka,w.stan])).toEqual([['POST','/order/checkout-forms/zam-1/invoices','do_sprawdzenia']]);
  expect(await f.wynik(API+'/order/checkout-forms/zam-1/invoices',faktura)).toMatch(/niejednoznaczny/);
  expect(f.wywolania).toHaveLength(1);
 });
 it('wstrzymane zapisy konta nadal zatrzymują fakturę, nadanie i wystawienie przed siecią',async()=>{
  const f=setup(()=>Response.json({}));
  f.repo.zablokujZapisy(f.k.klucz,aktorAllegro);
  expect(await f.wynik(API+'/order/checkout-forms/zam-1/invoices',{method:'POST',body:'{}'})).toMatch(/wstrzymane/);
  expect(await f.wynik(API+'/shipment-management/shipments/create-commands',{method:'POST',body:JSON.stringify({commandId:'nadanie-1'})})).toMatch(/wstrzymane/);
  expect(await f.wynik(API+'/sale/product-offers',oferta('karta-1'))).toMatch(/wstrzymane/);
  expect(await f.wynik(UPLOAD+'/sale/images',{method:'POST',body:new Uint8Array([1])})).toMatch(/wstrzymane/);
  expect(f.wywolania).toHaveLength(0);
 });
});
