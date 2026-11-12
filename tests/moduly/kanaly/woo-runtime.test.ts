import {afterEach,expect,it,vi} from 'vitest';
import {openOmsDb} from '../../../src/oms/db/db.ts';
import {migracjaKanalowSprzedazy} from '../../../src/moduly/kanaly/migracje/0001-kanaly-sprzedazy.ts';
import {migracjaTypuKanaluISklepow} from '../../../src/moduly/kanaly/migracje/0003-kanaly-typ-sklepy.ts';
import {zbudujUslugiKanalow} from '../../../src/moduly/kanaly/services/kompozycja-kanalow.ts';
import {createSklepyWoo} from '../../../src/moduly/kanaly/services/sklepy-woo.ts';
import {createRejestrKanalow} from '../../../src/moduly/kanaly/services/rejestr-kanalow.ts';
import {konfiguracjaKanalow} from '../../../src/moduly/kanaly/konfiguracja.ts';
const bazy:ReturnType<typeof openOmsDb>[]=[];
afterEach(()=>{for(const db of bazy.splice(0))db.close();});
const a={id:1,login:'polcien_test'};
function ok(w:any){expect(w.ok).toBe(true);return w.dane;}
const zam=(id:number)=>({id,number:String(id),status:'processing',total:'10.00',payment_method:'bacs',date_created_gmt:'2026-11-01T10:00:00',date_modified_gmt:'2026-11-01T11:00:00',billing:{},shipping:{},shipping_lines:[{method_id:'flat_rate',instance_id:1}],line_items:[],meta_data:[]});
function setup(env=false){
 const db=openOmsDb();bazy.push(db);migracjaKanalowSprzedazy.wykonaj(db);migracjaTypuKanaluISklepow.wykonaj(db);
 const log=vi.fn(),fetchImpl=vi.fn(async()=>Response.json([zam(1),zam(2),zam(3)],{headers:{'X-WP-TotalPages':'1'}}));
 const definicje=env?[{klucz:'woo_polcien',typ:'woo' as const,prefiks:'POLCIEN'}]:[];
 const config=konfiguracjaKanalow(definicje,env?{POLCIEN_URL:'https://sklep.polcien.example',POLCIEN_CK:'ck_polcien',POLCIEN_CS:'cs_polcien',POLCIEN_MAPOWANIE:'{"instancje":{},"poPozycji":[]}'}:{});
 const teraz=()=>new Date('2026-11-02T12:00:00Z');
 const poAktywacji=vi.fn();
 const u=zbudujUslugiKanalow({db,konfiguracja:config,log,teraz,usluga:()=>poAktywacji} as any,definicje,{fetchImpl});
 const s=createSklepyWoo({db,repozytorium:u.repozytoriumKanalow,envSklepy:[],teraz,tryb:'produkcja',poAktywacji:u.poAktywacji,klient:()=>({sprawdzPolaczenie:async()=>({ok:true}),pobierzMetodyWysylki:async()=>[],pobierzBramkiPlatnosci:async()=>[]})});
 const wersja=(k:string)=>u.repozytoriumKanalow.listaTypu('woo').find(s=>s.klucz===k)!.wersja;
 const aktywuj=async()=>{const k=ok(s.utworzSzkic({nazwa:'Pracownia Półcień',adres:'https://sklep.polcien.example',ck:'ck_polcien',cs:'cs_polcien',od:'2026-11-01'},a)).klucz;ok(s.zapiszMapowanie(k,{instancje:{},bramkiPobrania:[]},wersja(k),a));ok(await s.sprawdz(k));ok(s.aktywuj(k,wersja(k),a));return k;};
 return {db,u,s,wersja,aktywuj,fetchImpl,log,poAktywacji};
}
it('aktywacja bez restartu udostępnia mapy, definicje, stan i trzy zamówienia; pauza i odłączenie działają',async()=>{
 const {db,u,s,wersja,aktywuj,fetchImpl}=setup();expect(Object.keys(u.config.sklepy)).toEqual([]);
 const k=await aktywuj();expect(Object.keys(u.config.sklepy)).toEqual([k]);expect(u.klienciSklepow[k].pobierzZamowienia).toBeTypeOf('function');
 expect(u.config.definicje.find(d=>d.klucz===k)?.typ).toBe('woo');expect(Object.keys(u.klienciKanalow)).toEqual([]);
 await u.poller.przebieg();expect(db.prepare('SELECT sklep FROM zamowienia').all()).toEqual([{sklep:k},{sklep:k},{sklep:k}]);
 expect(u.poller.stany().map((s:any)=>s.sklep)).toContain(k);
 ok(s.ustawPobieranie(k,false,wersja(k),a));const n=fetchImpl.mock.calls.length;await u.poller.przebieg();expect(fetchImpl).toHaveBeenCalledTimes(n);
 ok(s.odlacz(k,wersja(k),a));expect(k in u.config.sklepy).toBe(false);expect(u.klienciSklepow[k]).toBeUndefined();expect(u.poller.stany()).toEqual([]);
});
it('publiczna lista rejestru nie zawiera aktywnego sklepu Woo z panelu',async()=>{
 const {u,aktywuj}=setup();const k=await aktywuj();
 expect(Object.keys(u.config.sklepy)).toContain(k);
 expect(u.rejestrKanalow.lista().map(k=>k.klucz)).not.toContain(k);
});
it('sklep z panelu pobiera zamówienia po 301 na nowy adres na tym samym hoście',async()=>{
 const {db,u,aktywuj,fetchImpl}=setup();const k=await aktywuj();
 const zapytania:{url:URL;init:RequestInit}[]=[];
 const przekierowanie=new Response('treść przekierowania',{status:301,headers:{Location:'/przeniesiony/wp-json/wc/v3/orders'}});
 const json=vi.spyOn(przekierowanie,'json'),text=vi.spyOn(przekierowanie,'text');
 fetchImpl.mockImplementation(async(...args:unknown[])=>{
  const url=new URL(String(args[0])),init=args[1] as RequestInit;zapytania.push({url,init});
  if(url.pathname==='/wp-json/wc/v3/orders'){
   if(init.redirect==='error')throw new TypeError('Przekierowanie odrzucone');
   return przekierowanie;
  }
  expect(url.pathname).toBe('/przeniesiony/wp-json/wc/v3/orders');
  return Response.json([zam(1),zam(2),zam(3)],{headers:{'X-WP-TotalPages':'1'}});
 });
 await expect(u.poller.przebieg()).resolves.toBeUndefined();
 expect(db.prepare('SELECT sklep FROM zamowienia').all()).toEqual([{sklep:k},{sklep:k},{sklep:k}]);
 expect(zapytania).toHaveLength(2);
 for(const {url,init} of zapytania){
  expect(url.origin).toBe('https://sklep.polcien.example');expect(init.redirect).toBe('manual');
  expect(new Headers(init.headers).get('Authorization')).toBe('Basic '+Buffer.from('ck_polcien:cs_polcien').toString('base64'));
 }
 expect(json).not.toHaveBeenCalled();expect(text).not.toHaveBeenCalled();
});
it('generacja mapowania tworzy nowego klienta i adapter z nową metodą',async()=>{
 const {db,u,s,wersja,aktywuj}=setup();const k=await aktywuj(),klient=u.klienciSklepow[k];
 await u.poller.przebieg();expect(db.prepare('SELECT metoda_wysylki FROM zamowienia LIMIT 1').get()).toEqual({metoda_wysylki:'nieznana'});
 ok(s.zapiszMapowanie(k,{instancje:{'1':{metoda:'dpd'}},bramkiPobrania:[]},wersja(k),a));expect(u.klienciSklepow[k]).not.toBe(klient);
 await u.poller.przebieg();expect(db.prepare('SELECT DISTINCT metoda_wysylki FROM zamowienia').all()).toEqual([{metoda_wysylki:'dpd'}]);
});
it('sklep env nadal pobiera i zachowuje importy',async()=>{
 const {db,u}=setup(true);expect(Object.keys(u.klienciSklepow)).toEqual(['woo_polcien']);expect(u.importySklepow).toEqual({});
 await u.poller.przebieg();expect(db.prepare('SELECT count(*) AS n FROM zamowienia WHERE sklep=?').get('woo_polcien')).toEqual({n:3});
});
it.each(['siec','odpowiedz','bledne200'])('sekrety nie trafiają do błędów, logów ani stanów: %s',async(awaria)=>{
 const {u,aktywuj,fetchImpl,log}=setup();await aktywuj();
 fetchImpl.mockImplementation(async()=>{if(awaria==='siec')throw Error('ck_polcien cs_polcien token_polcien');return Response.json({message:'ck_polcien cs_polcien token_polcien'},{status:awaria==='bledne200'?200:401});});
 let blad='';try{await u.poller.przebieg();}catch(e){blad=String(e);}
 expect(blad).not.toBe('');expect(JSON.stringify([blad,u.poller.stany(),log.mock.calls])).not.toMatch(/ck_polcien|cs_polcien|token_polcien/);
});
it('przekazuje po aktywacji pełne połączenie Woo do raportów',async()=>{
 const {aktywuj,poAktywacji}=setup();const klucz=await aktywuj();expect(poAktywacji).toHaveBeenCalledWith(expect.objectContaining({klucz,typ:'woo',zrodlo:'panel',odUtc:'2026-10-31T23:00:00.000Z'}));
});
it('odmawia startu dla brakującej fabryki i fabryki bez modułu',()=>{
 const {u}=setup();const f=()=>({klient:{},poller:{przebieg:async()=>{},stan:()=>null}});
 expect(()=>createRejestrKanalow({repozytorium:u.repozytoriumKanalow,fabryki:{allegro:f} as any})).toThrow(/woo/);
 expect(()=>createRejestrKanalow({repozytorium:u.repozytoriumKanalow,fabryki:{allegro:f,woo:f,erli:()=>{throw Error('nieużywane');},obcy:f} as any})).toThrow(/obcy/);
});
it('Woo nie zakłada blokady niejednoznacznych zapisów Allegro',async()=>{
 const {u,aktywuj}=setup();const k=await aktywuj();let calls=0;
 const f=({http}:any)=>({klient:{pisz:()=>http('https://sklep.polcien.example/wp-json/wc/v3/orders/1',{method:'POST'})},poller:{przebieg:async()=>{},stan:()=>null}});
 const r=createRejestrKanalow({repozytorium:u.repozytoriumKanalow,fabryki:{woo:f,allegro:f,erli:()=>{throw Error('nieużywane');}},fetchImpl:async()=>{calls++;throw Error('awaria');}});
 await expect(r.klient(k).pisz()).rejects.toThrow();await expect(r.klient(k).pisz()).rejects.toThrow();
 expect(calls).toBe(2);expect(u.repozytoriumKanalow.niejednoznaczne(k)).toEqual([]);
});
it('pauza w trakcie HTTP nie zapisuje zamówień ani stanu zamkniętego przebiegu',async()=>{
 const {db,u,s,wersja,aktywuj,fetchImpl}=setup();const k=await aktywuj();
 let wejscie!:()=>void,zwolnij!:()=>void;
 const wszedl=new Promise<void>(r=>{wejscie=r;}),bramka=new Promise<void>(r=>{zwolnij=r;});
 fetchImpl.mockImplementation(async()=>{wejscie();await bramka;return Response.json([zam(1)]);});
 const p=u.poller.przebieg();await wszedl;ok(s.ustawPobieranie(k,false,wersja(k),a));zwolnij();
 await expect(p).resolves.toBeUndefined();expect(db.prepare('SELECT * FROM zamowienia').all()).toEqual([]);expect(db.prepare('SELECT * FROM stan_pollera').all()).toEqual([]);
});
// PRZ-132.09c: sklep z panelu nie przyjmuje odpowiedzi ani nie wysyła zapisu po przekierowaniu na inny origin.
function przekierowanieNa(fetchImpl:any,cel:string,status=302){
 const zapytania:{url:URL;init:RequestInit}[]=[];
 fetchImpl.mockImplementation(async(...args:unknown[])=>{
  const url=new URL(String(args[0])),init=(args[1]??{}) as RequestInit;zapytania.push({url,init});
  if(url.origin==='https://sklep.polcien.example'&&url.pathname.startsWith('/wp-json/'))return new Response(null,{status,headers:{Location:cel+url.pathname+url.search}});
  return Response.json([zam(1),zam(2),zam(3)],{headers:{'X-WP-TotalPages':'1'}});
 });
 return zapytania;
}
it.each([['obcy host','https://obcy.example','https://obcy.example'],['https→http','http://sklep.polcien.example','http://sklep.polcien.example'],['inny port','https://sklep.polcien.example:8443','https://sklep.polcien.example:8443']])('panel: 302 na inny origin (%s) daje błąd i 0 zamówień',async(_n,cel,origin)=>{
 const {db,u,aktywuj,fetchImpl}=setup();const k=await aktywuj();
 const zapytania=przekierowanieNa(fetchImpl,cel);
 try{await u.poller.przebieg();}catch{}
 expect(db.prepare('SELECT count(*) AS n FROM zamowienia').get()).toEqual({n:0});
 expect(zapytania.filter(z=>z.url.origin!=='https://sklep.polcien.example')).toEqual([]);
 const stan=db.prepare('SELECT ostatni_blad FROM stan_pollera WHERE sklep=?').get(k) as {ostatni_blad:string};
 expect(stan.ostatni_blad).toBe(`Sklep WooCommerce przekierował na inny adres (${origin}). Popraw adres sklepu w Ustawieniach.`);
});
it.each([[307,'ustawStatus',['5','completed']],[308,'dodajNotatke',['5','Paczka nadana']]])('panel: zapis %i na obcy host jest blokowany przed wysłaniem',async(status,metoda,args)=>{
 const {u,aktywuj,fetchImpl}=setup();const k=await aktywuj();
 const zapytania=przekierowanieNa(fetchImpl,'https://obcy.example',status as number);
 await expect((u.klienciSklepow[k] as any)[metoda as string](...(args as string[]))).rejects.toThrow(/przekierował na inny adres \(https:\/\/obcy\.example\)/);
 expect(zapytania).toHaveLength(1);expect(zapytania[0].url.origin).toBe('https://sklep.polcien.example');
});
it('sklep env po 302 na obcy host zachowuje się jak dotąd: idzie dalej bez Authorization',async()=>{
 const {db,u,fetchImpl}=setup(true);
 const zapytania=przekierowanieNa(fetchImpl,'https://obcy.example');
 await u.poller.przebieg();
 expect(db.prepare('SELECT count(*) AS n FROM zamowienia WHERE sklep=?').get('woo_polcien')).toEqual({n:3});
 const obce=zapytania.filter(z=>z.url.origin==='https://obcy.example');
 expect(obce).toHaveLength(1);expect(new Headers(obce[0].init.headers).get('Authorization')).toBeNull();
});
it('panel: miniatury (Store API) po 302 na obcy origin dają błąd bez żądania na obcy host',async()=>{
 const {u,aktywuj,fetchImpl}=setup();const k=await aktywuj();
 const zapytania=przekierowanieNa(fetchImpl,'https://obcy.example');
 await expect((u.klienciSklepow[k] as any).pobierzMiniatury()).rejects.toThrow(/przekierował na inny adres \(https:\/\/obcy\.example\)/);
 expect(zapytania).toHaveLength(1);expect(zapytania[0].url.pathname).toBe('/wp-json/wc/store/v1/products');expect(zapytania[0].init.redirect).toBe('manual');
});
