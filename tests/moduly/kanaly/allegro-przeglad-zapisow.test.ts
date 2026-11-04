import {afterEach,describe,it,expect} from 'vitest';
import {fixtureAllegro,daneAllegro,aktorAllegro} from '../../pomoc/allegro-konfigurator.ts';
import {createRejestrKanalow} from '../../../src/moduly/kanaly/services/rejestr-kanalow.ts';
import {createPrzegladZapisowAllegro} from '../../../src/moduly/kanaly/services/przeglad-zapisow-allegro.ts';
import {zapiszWatek} from '../../../src/oms/db/allegro-watki.js';
const fixtures:ReturnType<typeof fixtureAllegro>[]=[];afterEach(()=>{for(const f of fixtures.splice(0))f.db.close();});
function setup(){
 const f=fixtureAllegro();fixtures.push(f);const szkic=f.szkic();
 const k=daneAllegro(f.repo.zapiszZmiane(szkic.klucz,szkic.wersja,{kontoId:'123',autoryzacja:'polaczone'},aktorAllegro));f.repo.zablokujZapisy(k.klucz,aktorAllegro);
 let http=0;const rejestr=createRejestrKanalow({repozytorium:f.repo,fetchImpl:async()=>{http++;return Response.json({});},fabryki:({http})=>({klient:{pisz:()=>http('https://api.allegro.pl/order/1/invoices',{method:'POST'}),innyZapis:()=>http('https://api.allegro.pl/order/2/fulfillment',{method:'PUT'})},poller:{stan:()=>null,przebieg:async()=>{}}})});
 const usluga=createPrzegladZapisowAllegro({db:f.db,repozytorium:f.repo,rejestr,teraz:f.teraz});
 return {...f,k,rejestr,usluga,ileHttp:()=>http};
}
describe('przegląd zapisów po reconnect',()=>{
 it('dopiero osobna zgoda na aktualną listę odblokowuje; sama zgoda nie wykonuje HTTP ani importu',async()=>{
  const f=setup();expect(f.rejestr.wolnoZapisywac(f.k.klucz)).toBe(false);
  const p=daneAllegro(f.usluga.przygotuj(f.k.klucz,f.k.wersja,aktorAllegro,'A'));
  expect(f.usluga.zatwierdz(p.przegladId,[],aktorAllegro,'B').ok).toBe(false);
  const wynik=daneAllegro(f.usluga.zatwierdz(p.przegladId,[],aktorAllegro,'A'));
  expect(f.rejestr.wolnoZapisywac(f.k.klucz)).toBe(true);expect(f.ileHttp()).toBe(0);expect(wynik.pobieranie).toBe('wylaczone');
  await f.rejestr.klient(f.k.klucz).innyZapis();expect(f.ileHttp()).toBe(1);
  expect(f.usluga.zatwierdz(p.przegladId,[],aktorAllegro,'A').ok).toBe(false);
 });
 it('zmiana wersji, listy, sesji, aktora albo upływ TTL unieważnia przegląd',()=>{
  for(const co of ['wersja','lista','aktor','czas']){
   const f=setup(),p=daneAllegro(f.usluga.przygotuj(f.k.klucz,f.k.wersja,aktorAllegro,'A'));
   if(co==='wersja')daneAllegro(f.repo.zapiszZmiane(f.k.klucz,f.k.wersja,{nazwa:'Inna'},aktorAllegro));
   if(co==='lista')zapiszWatek(f.db,{kanal:f.k.klucz,threadId:'nowy',ostatniaTresc:'TAJNA-TRESC',ostatniaOdKupujacego:1,lastMessageDateTime:'2026-11-01T11:00:00Z'});
   if(co==='czas')f.setCzas('2026-11-01T12:11:00Z');
   expect(f.usluga.zatwierdz(p.przegladId,[],co==='aktor'?{id:2,login:'inny'}:aktorAllegro,'A').ok).toBe(false);expect(f.repo.zapisyZablokowane(f.k.klucz)).toBe(true);
  }
 });
 it('niejednoznaczna operacja pozostaje indywidualnie zablokowana nawet po zgodzie na pozostałe zapisy i restarcie',async()=>{
  const f=setup();f.repo.zapiszNiejednoznaczne(f.k.klucz,[{id:'operacja-1',metoda:'POST',sciezka:'/order/1/invoices'}]);
  const p=daneAllegro(f.usluga.przygotuj(f.k.klucz,f.k.wersja,aktorAllegro,'A'));
  expect(p.niejednoznaczne).toHaveLength(1);
  const zwolniona=setup();zwolniona.repo.zapiszNiejednoznaczne(zwolniona.k.klucz,[{id:'zwolniona',metoda:'POST',sciezka:'/order/1/invoices'}]);
  const przeglad=daneAllegro(zwolniona.usluga.przygotuj(zwolniona.k.klucz,zwolniona.k.wersja,aktorAllegro,'A'));
  daneAllegro(zwolniona.usluga.zatwierdz(przeglad.przegladId,[],aktorAllegro,'A'));
  expect(zwolniona.repo.operacjaZablokowana(zwolniona.k.klucz,'POST','/order/1/invoices')).toBe(false);
  await zwolniona.rejestr.klient(zwolniona.k.klucz).pisz();expect(zwolniona.ileHttp()).toBe(1);
  daneAllegro(f.usluga.zatwierdz(p.przegladId,['operacja-1'],aktorAllegro,'A'));
  expect(f.repo.operacjaZablokowana(f.k.klucz,'POST','/order/1/invoices')).toBe(true);
  await expect(f.rejestr.klient(f.k.klucz).pisz()).rejects.toThrow();await f.rejestr.klient(f.k.klucz).innyZapis();expect(f.ileHttp()).toBe(1);
 });
 it('lista obejmuje lokalne kandydatury, nie ujawnia treści wiadomości i nie wywołuje API',()=>{
  const f=setup();zapiszWatek(f.db,{kanal:f.k.klucz,threadId:'watek-1',ostatniaTresc:'TAJNA-TRESC',ostatniaOdKupujacego:1,lastMessageDateTime:'2026-11-01T11:00:00Z'});
  const p=daneAllegro(f.usluga.przygotuj(f.k.klucz,f.k.wersja,aktorAllegro,'A'));
  expect(p.kandydaci.wiadomosci).toMatchObject([{thread_id:'watek-1'}]);expect(JSON.stringify(p)).not.toContain('TAJNA');expect(f.ileHttp()).toBe(0);
 });
 it('wybór części blokad zwalnia pozostałe, a kolejny przegląd zwalnia też wcześniej pozostawioną',async()=>{
  const f=setup();f.repo.zapiszNiejednoznaczne(f.k.klucz,[{id:'zostaw',metoda:'POST',sciezka:'/order/1/invoices'},{id:'zwolnij',metoda:'POST',sciezka:'/order/2/invoices'}]);
  const p=daneAllegro(f.usluga.przygotuj(f.k.klucz,f.k.wersja,aktorAllegro,'A'));
  expect(f.usluga.zatwierdz(p.przegladId,['obca'],aktorAllegro,'A').ok).toBe(false);
  const k=daneAllegro(f.usluga.zatwierdz(p.przegladId,['zostaw'],aktorAllegro,'A'));
  expect(f.repo.operacjaZablokowana(k.klucz,'POST','/order/1/invoices')).toBe(true);
  expect(f.repo.operacjaZablokowana(k.klucz,'POST','/order/2/invoices')).toBe(false);
  await expect(f.rejestr.klient(k.klucz).pisz()).rejects.toThrow();
  const kolejny=daneAllegro(f.usluga.przygotuj(k.klucz,k.wersja,aktorAllegro,'A'));
  daneAllegro(f.usluga.zatwierdz(kolejny.przegladId,[],aktorAllegro,'A'));
  await f.rejestr.klient(k.klucz).pisz();expect(f.ileHttp()).toBe(1);
  expect(f.db.prepare('SELECT id,stan FROM kanaly_operacje_niejednoznaczne ORDER BY id').all()).toEqual([{id:'zostaw',stan:'zwolniona'},{id:'zwolnij',stan:'zwolniona'}]);
 });
});
