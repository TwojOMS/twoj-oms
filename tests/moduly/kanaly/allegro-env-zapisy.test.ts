import {it,expect} from 'vitest';
import {openOmsDb} from '../../../src/oms/db/db.ts';
import {migracjaKanalowSprzedazy} from '../../../src/moduly/kanaly/migracje/0001-kanaly-sprzedazy.ts';
import {migracjaDiagnostykiAllegro} from '../../../src/moduly/kanaly/migracje/0002-diagnostyka-allegro.ts';
import {zbudujUslugiKanalow} from '../../../src/moduly/kanaly/services/kompozycja-kanalow.ts';
import {konfiguracjaKanalow,type DefinicjaKanalu} from '../../../src/moduly/kanaly/konfiguracja.ts';
import {zapiszTokeny} from '../../../src/oms/db/tokeny.js';
it.each(['bez zmian','po przeglądzie','po przywróceniu'])('dwa kanały env %s: osiem zapisów złożonych klientów zachowuje konto',async tryb=>{
 const db=openOmsDb();
 try{
  migracjaKanalowSprzedazy.wykonaj(db);migracjaDiagnostykiAllegro.wykonaj(db);
  const definicje:DefinicjaKanalu[]=[{klucz:'allegro_polcien',typ:'allegro',prefiks:'POLCIEN'},{klucz:'allegro_zorza',typ:'allegro',prefiks:'ZORZA'}];
  const env:Record<string,string>={};
  for(const d of definicje){
   Object.assign(env,{[d.prefiks+'_CLIENT_ID']:'fixture',[d.prefiks+'_CLIENT_SECRET']:'fixture',[d.prefiks+'_USER_AGENT']:'OMS/1 (+https://example.invalid)',[d.prefiks+'_OD']:'2026-10-01'});
   zapiszTokeny(db,d.klucz,{accessToken:'fixture-'+d.klucz,refreshToken:'fixture-refresh-'+d.klucz,wygasaAt:'2099-01-01',refreshWygasaAt:'2099-02-01'});
  }
  const calls:{path:string;token:string|null;commandId?:string}[]=[];
  const fetchImpl:typeof fetch=async(u,i)=>{
   const path=new URL(String(u)).pathname;calls.push({path,token:new Headers(i?.headers).get('Authorization'),...(path.endsWith('/create-commands')?{commandId:JSON.parse(String(i?.body)).commandId}:{})});
   return Response.json({id:'fixture',commandId:'fixture'});
  };
  const uslugi=zbudujUslugiKanalow({db,konfiguracja:konfiguracjaKanalow(definicje,env),teraz:()=>new Date('2026-11-01T12:00:00Z'),log:()=>{}} as any,definicje,{fetchImpl});
  const aktor={id:1,login:'admin'},tokeny=db.prepare('SELECT * FROM tokeny_kanalu ORDER BY kanal').all();
  for(const d of definicje){
   if(tryb==='po przeglądzie'){
    uslugi.repozytoriumKanalow.zapiszNiejednoznaczne(d.klucz,[{id:d.klucz,metoda:'PUT',sciezka:'/fixture'}]);
    const p=uslugi.przegladZapisowAllegro.przygotuj(d.klucz,0,aktor,'sesja');if(!p.ok)throw Error('przegląd');
    expect(uslugi.przegladZapisowAllegro.zatwierdz(p.dane.przegladId,[],aktor,'sesja').ok).toBe(true);
    expect(uslugi.repozytoriumKanalow.operacjaZablokowana(d.klucz,'PUT','/fixture')).toBe(false);
    expect(db.prepare('SELECT * FROM kanaly_sprzedazy').all()).toEqual([]);
   }
   if(tryb==='po przywróceniu'){
    const stary=uslugi.klienciKanalow[d.klucz];
    expect((await uslugi.zarzadzanieAllegro.odlacz(d.klucz,0,aktor)).ok).toBe(true);
    await expect(stary.ustawStatusRealizacji('stare','SENT')).rejects.toThrow();
    const k=uslugi.repozytoriumKanalow.pobierz(d.klucz)!;
    expect(uslugi.repozytoriumKanalow.przywrocZKonfiguracji(d.klucz,k.wersja,aktor).ok).toBe(true);
    await expect(stary.ustawStatusRealizacji('stare','SENT')).rejects.toThrow();
   }
  }
  expect(calls).toEqual([]);expect(db.prepare('SELECT * FROM tokeny_kanalu ORDER BY kanal').all()).toEqual(tokeny);
  await Promise.all(definicje.map(async(d,index)=>{
   const c=uslugi.klienciKanalow[d.klucz];const id='zamowienie-'+index;
   await c.ustawStatusRealizacji(id,'SENT');
   await c.utworzPrzesylke({commandId:'command-'+index,input:{deliveryMethodId:'fixture'}});
   await c.wyslijWiadomosc('watek-'+index,'Przykładowa wiadomość');
   await c.wyslijPlikFaktury(id,'faktura-'+index,Buffer.from('%PDF-fixture'));
  }));
  expect(calls).toHaveLength(8);
  for(const [index,d] of definicje.entries()){
   const konto=calls.filter(c=>c.token==='Bearer fixture-'+d.klucz);expect(konto).toHaveLength(4);
   expect(konto.find(c=>c.commandId)?.commandId).toBe('command-'+index);
   expect(konto.map(c=>c.path)).toEqual(expect.arrayContaining([
    `/order/checkout-forms/zamowienie-${index}/fulfillment`,
    '/shipment-management/shipments/create-commands',
    `/messaging/threads/watek-${index}/messages`,
    `/order/checkout-forms/zamowienie-${index}/invoices/faktura-${index}/file`,
   ]));
  }
  if(tryb!=='po przywróceniu')expect(db.prepare('SELECT * FROM kanaly_sprzedazy').all()).toEqual([]);
 }finally{db.close();}
});
