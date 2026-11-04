import {it,expect} from 'vitest';
const W=process.cwd();
it('składanie zamówień nie buduje klientów: start przy połączonym koncie Allegro bez aplikacji (recenzja K05)',async()=>{
  const {openOmsDb}=await import(W+'/src/oms/db/db.ts');
  const {migracjaKanalowSprzedazy}=await import(W+'/src/moduly/kanaly/migracje/0001-kanaly-sprzedazy.ts');
  const {migracjaTypuKanaluISklepow}=await import(W+'/src/moduly/kanaly/migracje/0003-kanaly-typ-sklepy.ts');
  const {zbudujUslugiKanalow}=await import(W+'/src/moduly/kanaly/services/kompozycja-kanalow.ts');
  const {konfiguracjaKanalow}=await import(W+'/src/moduly/kanaly/konfiguracja.ts');
  const {createModulZamowienia}=await import(W+'/src/moduly/zamowienia/modul.ts');
  const db=openOmsDb();migracjaKanalowSprzedazy.wykonaj(db);migracjaTypuKanaluISklepow.wykonaj(db);
  const u=zbudujUslugiKanalow({db,konfiguracja:konfiguracjaKanalow([],{}),log:()=>{}} as any,[],{fetchImpl:async()=>{throw Error('bez sieci');}});
  const a={id:1,login:'admin'} as any;
  const w1=u.repozytoriumKanalow.utworzSzkic({nazwa:'Półcień',odUtc:'2026-10-31T23:00:00Z',srodowisko:'produkcja'},a);if(!w1.ok)throw Error(w1.komunikat);
  const w2=u.repozytoriumKanalow.zapiszZmiane(w1.dane.klucz,w1.dane.wersja,{aplikacja:'device',autoryzacja:'polaczone'},a);if(!w2.ok)throw Error(w2.komunikat);
  const m=createModulZamowienia({} as any);
  const ctx:any={db,konfiguracja:{kanalIndywidualny:null},log:()=>{},usluga:(mod:string,n:string)=>{if(mod==='kanaly'&&n in u)return (u as any)[n];throw new Error(`usluga ${mod}.${n} nie istnieje (atrapa)`);}};
  let blad='';try{m.zbuduj(ctx);}catch(e){blad=(e as Error).message;}
  expect(blad).toBe('');
  db.close();
});
