import {afterEach,describe,it,expect} from 'vitest';
import {openOmsDb} from '../../../src/oms/db/db.ts';
import {migracjaKanalowSprzedazy} from '../../../src/moduly/kanaly/migracje/0001-kanaly-sprzedazy.ts';
import {createRepozytoriumKanalow} from '../../../src/moduly/kanaly/repozytorium-kanalow.ts';
import {createRejestrKanalow,type FabrykaKanalu} from '../../../src/moduly/kanaly/services/rejestr-kanalow.ts';
import type {PolaczenieAllegro,Wynik} from '../../../src/moduly/kanaly/kontrakty-allegro.ts';
import {createTokeny} from '../../../src/oms/allegro/tokeny.js';
import {zapiszTokeny,wczytajTokeny} from '../../../src/oms/db/tokeny.js';
import {createPoller} from '../../../src/moduly/kanaly/services/poller.js';
import {migracjaTypuKanaluISklepow} from '../../../src/moduly/kanaly/migracje/0003-kanaly-typ-sklepy.ts';
import {zbudujUslugiKanalow} from '../../../src/moduly/kanaly/services/kompozycja-kanalow.ts';
import {konfiguracjaKanalow} from '../../../src/moduly/kanaly/konfiguracja.ts';
import {zapiszKonfiguracjeIntegracji} from '../../../src/oms/db/konfiguracja-integracji.js';
const a={id:1,login:'admin'};
const bazy:ReturnType<typeof openOmsDb>[]=[];afterEach(()=>{for(const db of bazy.splice(0))db.close();});
function dane(w:Wynik<PolaczenieAllegro>){if(!w.ok)throw Error(w.komunikat);return w.dane;}
function odrocz<T>(){let resolve!:(t:T)=>void;const promise=new Promise<T>(r=>{resolve=r;});return {promise,resolve};}
function setup(fabryki:FabrykaKanalu,fetchImpl?:typeof fetch,limitCzasuMs=1000,limitZatrzymaniaMs=20){
 const db=openOmsDb();bazy.push(db);migracjaKanalowSprzedazy.wykonaj(db);let tick=0;const repo=createRepozytoriumKanalow({db,definicjeEnv:[],konfiguracjaEnv:{},teraz:()=>new Date(Date.UTC(2026,10,1,12,0,0,tick++))});
 const registry=createRejestrKanalow({repozytorium:repo,fabryki,db,fetchImpl,limitCzasuMs,limitZatrzymaniaMs});
 const nowe=()=>{const k=dane(repo.utworzSzkic({nazwa:'Konto',odUtc:'2026-10-31T23:00:00Z',srodowisko:'produkcja'},a));return dane(repo.zapiszZmiane(k.klucz,k.wersja,{autoryzacja:'polaczone',kontoId:String(repo.lista().length),pobieranie:'wlaczone'},a));};
 const zmien=(k:PolaczenieAllegro,z:Partial<PolaczenieAllegro>)=>dane(repo.zapiszZmiane(k.klucz,repo.pobierz(k.klucz)!.wersja,z,a));
 return {db,repo,registry,nowe,zmien};
}
describe('kanały zmieniane w procesie',()=>{
 it('mapa fabryk wybiera Allegro i zachowuje blokadę niejednoznacznego zapisu',async()=>{
  const s=setup(()=>({klient:{},poller:{przebieg:async()=>{},stan:()=>null}}));const k=s.nowe();let calls=0;
  const allegro:FabrykaKanalu=({polaczenie,http})=>({klient:{typ:()=>polaczenie.typ,pisz:()=>http('https://api.allegro.pl/order/1/invoices',{method:'POST'})},poller:{przebieg:async()=>{},stan:()=>null}});
  const r=createRejestrKanalow({repozytorium:s.repo,fabryki:{allegro,woo:()=>{throw Error('Nie wolno użyć Woo dla Allegro');}},fetchImpl:async()=>{calls++;throw Error('awaria');}});
  expect(await r.klient(k.klucz).typ()).toBe('allegro');
  await expect(r.klient(k.klucz).pisz()).rejects.toThrow();expect(s.repo.niejednoznaczne(k.klucz)).toHaveLength(1);
  await expect(r.klient(k.klucz).pisz()).rejects.toThrow(/niejednoznaczny/);expect(calls).toBe(1);
 });
 it('obie aplikacje: refresh device używa Device, dcr i NULL używają DCR',async()=>{
  const db=openOmsDb();bazy.push(db);migracjaKanalowSprzedazy.wykonaj(db);migracjaTypuKanaluISklepow.wykonaj(db);
  zapiszKonfiguracjeIntegracji(db,'allegro_aplikacja:produkcja',{ustawienia:{status:'gotowa'},sekrety:{clientId:'polcien-dcr-id',clientSecret:'SEKRET-DCR'}});
  const calls:string[]=[];
  const u=zbudujUslugiKanalow({db,konfiguracja:konfiguracjaKanalow([],{OMS_ALLEGRO_DEVICE_CLIENT_ID:'polcien-device-id',OMS_ALLEGRO_DEVICE_CLIENT_SECRET:'SEKRET-POLCIEN'}),log:()=>{}} as any,[],{fetchImpl:async(_url,i)=>{calls.push(new Headers(i?.headers).get('Authorization')!);return Response.json({access_token:'nowy',refresh_token:'nowy-refresh',expires_in:3600});}});
  for(const aplikacja of ['device','dcr',null] as const){
   const k=dane(u.repozytoriumKanalow.utworzSzkic({nazwa:'Półcień',odUtc:'2026-10-31T23:00:00Z',srodowisko:'produkcja'},a));
   dane(u.repozytoriumKanalow.zapiszZmiane(k.klucz,k.wersja,{aplikacja,autoryzacja:'polaczone'},a));
   zapiszTokeny(db,k.klucz,{accessToken:'stary',refreshToken:'refresh',wygasaAt:'2020-01-01',refreshWygasaAt:'2099-01-01'});
   expect(await u.tokenyKanalow[k.klucz].waznyToken()).toBe('nowy');
   expect(calls.at(-1)).toBe('Basic '+Buffer.from(aplikacja==='device'?'polcien-device-id:SEKRET-POLCIEN':'polcien-dcr-id:SEKRET-DCR').toString('base64'));
  }
 });
 it.each(['device','dcr',null] as const)('brak właściwej aplikacji %s nie przełącza refresh na drugą',aplikacja=>{
  const db=openOmsDb();bazy.push(db);migracjaKanalowSprzedazy.wykonaj(db);migracjaTypuKanaluISklepow.wykonaj(db);
  if(aplikacja==='device')zapiszKonfiguracjeIntegracji(db,'allegro_aplikacja:produkcja',{ustawienia:{status:'gotowa'},sekrety:{clientId:'dcr',clientSecret:'SEKRET-DCR'}});
  const u=zbudujUslugiKanalow({db,konfiguracja:konfiguracjaKanalow([],aplikacja==='device'?{}:{OMS_ALLEGRO_DEVICE_CLIENT_ID:'polcien-device-id',OMS_ALLEGRO_DEVICE_CLIENT_SECRET:'SEKRET-POLCIEN'}),log:()=>{}} as any,[],{fetchImpl:async()=>{throw Error('HTTP nie może się rozpocząć');}});
  const k=dane(u.repozytoriumKanalow.utworzSzkic({nazwa:'Półcień',odUtc:'2026-10-31T23:00:00Z',srodowisko:'produkcja'},a));
  dane(u.repozytoriumKanalow.zapiszZmiane(k.klucz,k.wersja,{aplikacja,autoryzacja:'polaczone'},a));
  expect(()=>u.config.kanaly[k.klucz]).toThrow('Aplikacja Allegro tego konta nie jest skonfigurowana.');
 });
 it('niekompletne env ze starą parą nie buduje klienta, stanu ani importu',async()=>{
  const db=openOmsDb();bazy.push(db);migracjaKanalowSprzedazy.wykonaj(db);
  const repo=createRepozytoriumKanalow({db,definicjeEnv:[{klucz:'allegro_test',typ:'allegro',prefiks:'TEST'}],konfiguracjaEnv:{}});
  zapiszTokeny(db,'allegro_test',{accessToken:'fixture',refreshToken:'fixture',wygasaAt:'2027-01-01',refreshWygasaAt:'2027-02-01'});
  let calls=0;const r=createRejestrKanalow({repozytorium:repo,skonfigurowany:()=>false,fabryki:()=>{calls++;throw Error('Fabryka nie może powstać');}});
  expect(r.stany()).toEqual([]);await r.przebiegZamowien();expect(r.wolnoZapisywac('allegro_test')).toBe(false);expect(()=>r.klient('allegro_test')).toThrow(/odłączony/);expect(calls).toBe(0);
 });
 it('definicja env bez aktywnej pary nie uruchamia fabryki ani importu',async()=>{
  const db=openOmsDb();bazy.push(db);migracjaKanalowSprzedazy.wykonaj(db);
  const repo=createRepozytoriumKanalow({db,definicjeEnv:[{klucz:'allegro_test',typ:'allegro',prefiks:'TEST'}],konfiguracjaEnv:{}});let calls=0;
  const r=createRejestrKanalow({repozytorium:repo,fabryki:()=>{calls++;throw Error('Nie wolno budować bez dostępu');}});
  await r.przebiegZamowien();expect(calls).toBe(0);expect(r.definicje()).toHaveLength(1);expect(()=>r.klient('allegro_test')).toThrow();
 });
 it.each(['sieć','5xx'])('niejednoznaczny POST (%s) blokuje ponowienie tej operacji także po restarcie',async awaria=>{
  let requests=0;const factory:FabrykaKanalu=({http})=>({klient:{pisz:()=>http('https://api.allegro.pl/order/1/invoices',{method:'POST',headers:{Authorization:'Bearer WABIK'},body:'TAJNA-TRESC'}),czytaj:()=>http('https://api.allegro.pl/me')},poller:{stan:()=>null,przebieg:async()=>{}}});
  const s=setup(factory,async()=>{requests++;if(awaria==='sieć')throw Error('TAJNA-TRESC');return Response.json({blad:'TAJNA-TRESC'},{status:503});});const k=s.nowe();
  await expect(s.registry.klient(k.klucz).pisz()).rejects.toThrow();
  expect(s.repo.niejednoznaczne(k.klucz)).toHaveLength(1);expect(JSON.stringify(s.repo.niejednoznaczne(k.klucz))).not.toMatch(/WABIK|TAJNA/);
  const restart=createRejestrKanalow({repozytorium:s.repo,fabryki:factory,fetchImpl:async()=>{requests++;return Response.json({});}});
  await expect(restart.klient(k.klucz).pisz()).rejects.toThrow();expect(requests).toBe(1);
  await restart.klient(k.klucz).czytaj();expect(requests).toBe(2);
 });
 it('ponowne połączenie nie uruchamia zapisów; blokada przeżywa nowy rejestr',async()=>{
  let requests=0;const factory:FabrykaKanalu=({http})=>({klient:{pisz:()=>http('https://api.allegro.pl/order/checkout-forms/1/fulfillment',{method:'PUT'}),czytaj:()=>http('https://api.allegro.pl/me')},poller:{stan:()=>null,przebieg:async()=>{}}});
  const s=setup(factory,async()=>{requests++;return Response.json({});});const k=s.nowe();await s.registry.klient(k.klucz).pisz();expect(requests).toBe(1);
  s.zmien(k,{autoryzacja:'odlaczone'});s.repo.zablokujZapisy(k.klucz,a);s.zmien(k,{autoryzacja:'polaczone',pobieranie:'wylaczone'});
  const restart=createRejestrKanalow({repozytorium:s.repo,fabryki:factory,fetchImpl:async()=>{requests++;return Response.json({});}});
  await restart.klient(k.klucz).czytaj();await expect(restart.klient(k.klucz).pisz()).rejects.toThrow();expect(requests).toBe(2);
 });
 it('prawdziwy poller nie zapisuje drugiej strony ani kursora po pauzie',async()=>{
  const entered=odrocz<void>(),gate=odrocz<{zamowienia:any[];stron:number}>();let s:ReturnType<typeof setup>;
  s=setup(({polaczenie,sprawdzZapis})=>({klient:{},poller:createPoller({db:s.db,sklep:polaczenie.klucz,od:polaczenie.odUtc,kontrola:sprawdzZapis,kanal:{
   pobierzStrone:async({strona}:any)=>{if(strona===2){entered.resolve();return gate.promise;}return {zamowienia:[{id:'1',updatedAt:'2026-11-01T01:00:00Z'}],stron:2};},
   zlozoneZ:()=> '2026-11-01T00:00:00Z',kursorZ:(r:any)=>r.updatedAt,
   mapuj:(r:any)=>({zrodlo_id:r.id,numer:r.id,klient:{},dostawa:{},metoda_wysylki:'nieznana',pobranie:false,kwota_pobrania:null,chce_fakture:0,nip:null,kwota_brutto:'0.00',status_woo:'processing',oplacone_at:null,anulowane:0,pozycje:[]}),
  }})}));
  const k=s.nowe();const pending=s.registry.przebiegZamowien();await entered.promise;s.zmien(k,{pobieranie:'wylaczone'});const stop=s.registry.zatrzymaj(k.klucz,'zamowienia');
  gate.resolve({zamowienia:[{id:'2',updatedAt:'2026-11-01T02:00:00Z'}],stron:2});await pending;await stop;
  expect(s.db.prepare('SELECT zrodlo_id FROM zamowienia WHERE sklep=?').all(k.klucz)).toEqual([{zrodlo_id:1}]);
  expect(s.db.prepare('SELECT zsynchronizowane_do FROM stan_pollera WHERE sklep=?').get(k.klucz)).toBeUndefined();
 });
 it.each([false,true])('prawdziwy refresh: odłączenie=%s nie odtwarza pary, pauza pozwala odświeżyć',async(odlacz)=>{
  const entered=odrocz<void>(),gate=odrocz<Response>();
  const s=setup(()=>({klient:{},poller:{stan:()=>null,przebieg:async()=>{}}}));const k=s.nowe();
  zapiszTokeny(s.db,k.klucz,{accessToken:'stary',refreshToken:'stary-refresh',wygasaAt:'2020-01-01',refreshWygasaAt:'2027-01-01'});
  const tokeny=createTokeny({db:s.db,kanal:k.klucz,ustawienia:{auth:'https://allegro.pl/auth/oauth',clientId:'atrapa',clientSecret:'atrapa',userAgent:'OMS/1 (+https://example.invalid)'},fetchImpl:async()=>{entered.resolve();return gate.promise;}});
  const result=tokeny.waznyToken().catch(()=> 'odrzucono');await entered.promise;
  if(odlacz){s.zmien(k,{autoryzacja:'odlaczone'});s.db.prepare('DELETE FROM tokeny_kanalu WHERE kanal=?').run(k.klucz);}else{s.zmien(k,{pobieranie:'wylaczone'});}
  gate.resolve(Response.json({access_token:'nowy',refresh_token:'nowy-refresh',expires_in:3600}));
  if(odlacz){expect(await result).toBe('odrzucono');expect(wczytajTokeny(s.db,k.klucz)).toBeNull();}else{expect(await result).toBe('nowy');expect(wczytajTokeny(s.db,k.klucz)?.refresh_token).toBe('nowy-refresh');}
 });
 it('startuje z zerem kont, pierwszy i kolejny kanał pracują bez restartu, jeden przebieg naraz',async()=>{
  const gate=odrocz<void>();const started=odrocz<void>();const calls:string[]=[];
  const {registry,nowe}=setup(({polaczenie})=>({klient:{},poller:{stan:()=>null,przebieg:async()=>{calls.push(polaczenie.klucz);started.resolve();await gate.promise;}}}));
  await registry.przebiegZamowien();const k=nowe();expect(registry.definicje()).toHaveLength(1);const pending=registry.przebiegZamowien();await started.promise;
  const drugi=registry.przebiegZamowien();await Promise.resolve();const wywolaniaRownolegle=[...calls];gate.resolve();await Promise.all([pending,drugi]);expect(wywolaniaRownolegle).toEqual([k.klucz]);
  const b=nowe();await registry.przebiegZamowien();expect(calls).toEqual([k.klucz,k.klucz,b.klucz]);expect(registry.definicje()).toHaveLength(2);
 });
 it('uchwyt sprzed odłączenia nie odzyskuje dostępu po ponownym połączeniu tego samego konta',async()=>{
  let requests=0;
  const s=setup(({http})=>({klient:{czytaj:()=>http('https://api.allegro.pl/me')},poller:{stan:()=>null,przebieg:async()=>{}}}),async()=>{requests++;return Response.json({});});
  const k=s.nowe(),stary=s.registry.klient(k.klucz);
  const odlaczony=s.zmien(k,{autoryzacja:'odlaczone'});s.zmien(odlaczony,{autoryzacja:'polaczone',pobieranie:'wylaczone'});
  await expect(stary.czytaj()).rejects.toThrow();expect(requests).toBe(0);
  await s.registry.klient(k.klucz).czytaj();expect(requests).toBe(1);
 });
 it('pauza anuluje import A i nie blokuje obsługi starego zamówienia ani konta B',async()=>{
  const entered=odrocz<void>();const pages=odrocz<Response>();const written:string[]=[];let signal:AbortSignal|undefined;
  const {registry,nowe,zmien}=setup(({polaczenie,http,sprawdzZapis})=>({klient:{stare:async()=>{const r=await http('https://api.allegro.pl/order/old');return r.status;}},poller:{stan:()=>null,przebieg:async()=>{await http('https://api.allegro.pl/order/page');sprawdzZapis();written.push(polaczenie.klucz);}}}),async(url,init)=>{if(String(url).endsWith('/page')&&!signal){signal=init?.signal??undefined;entered.resolve();return pages.promise;}return new Response('{}');});
  const k=nowe();const b=nowe();const pending=registry.przebiegZamowien();await entered.promise;zmien(k,{pobieranie:'wylaczone'});
  const stop=registry.zatrzymaj(k.klucz,'zamowienia');expect(signal?.aborted).toBe(true);pages.resolve(new Response('{}'));await stop;await pending;
  expect(written).toEqual([b.klucz]);expect(await registry.klient(k.klucz).stare()).toBe(200);
 });
 it('odłączenie unieważnia stary uchwyt, spóźnioną odpowiedź i kolejne HTTP; restart respektuje stan',async()=>{
  const gate=odrocz<Response>(),entered=odrocz<void>();let requests=0,writes=0;
  const factory:FabrykaKanalu=({http,sprawdzZapis})=>({klient:{wykonaj:async()=>{await http('https://api.allegro.pl/me');sprawdzZapis();writes++;return 'OK';}},poller:{stan:()=>null,przebieg:async()=>{}}});
  const s=setup(factory,async()=>{requests++;entered.resolve();return gate.promise;});const k=s.nowe();const client=s.registry.klient(k.klucz);
  const result=client.wykonaj().catch(()=> 'odrzucono');await entered.promise;s.zmien(k,{autoryzacja:'odlaczone'});const stop=s.registry.zatrzymaj(k.klucz,'calosc');gate.resolve(new Response('{}'));expect(await result).toBe('odrzucono');expect(await stop).toBe('gotowe');expect(writes).toBe(0);
  await expect(client.wykonaj()).rejects.toThrow();expect(requests).toBe(1);
  const restart=createRejestrKanalow({repozytorium:s.repo,fabryki:factory,fetchImpl:async()=>{requests++;return new Response('{}');}});expect(()=>restart.klient(k.klucz)).toThrow();expect(requests).toBe(1);
 });
 it('zachowuje limit transportu po dołączeniu sygnału kanału',async()=>{
  const s=setup(({http})=>({klient:{czytaj:()=>http('https://api.allegro.pl/me')},poller:{stan:()=>null,przebieg:async()=>{}}}),async(_u,i)=>new Promise((_r,reject)=>i!.signal!.addEventListener('abort',()=>reject(i!.signal!.reason),{once:true})),15);
  const k=s.nowe();await expect(s.registry.klient(k.klucz).czytaj()).rejects.toThrow();
 });
 it('po limicie oczekiwania zgłasza zatrzymywanie i nie udaje zakończenia operacji',async()=>{
  const started=odrocz<void>(),gate=odrocz<Response>();const s=setup(({http})=>({klient:{czytaj:()=>http('https://api.allegro.pl/me')},poller:{stan:()=>null,przebieg:async()=>{}}}),async()=>{started.resolve();return gate.promise;},1000,5);
  const k=s.nowe();const result=s.registry.klient(k.klucz).czytaj().catch(()=>null);await started.promise;s.zmien(k,{autoryzacja:'odlaczone'});
  expect(await s.registry.zatrzymaj(k.klucz,'calosc')).toBe('zatrzymywanie');gate.resolve(new Response('{}'));await result;
 });
});
