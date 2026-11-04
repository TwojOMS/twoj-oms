import {afterEach,expect,it} from 'vitest';
import {openOmsDb} from '../../src/oms/db/db.ts';
import {zbudujAplikacje,type Aplikacja} from '../../src/core/aplikacja.ts';
import {ENV_DEMO} from '../../scripts/demo-dane.mjs';
import {zapiszTokeny} from '../../src/oms/db/tokeny.js';
// Import dynamiczny pozwala obejrzeć RED dla brakującej funkcji bez błędu kolekcji.
let a:Aplikacja|undefined,db:ReturnType<typeof openOmsDb>|undefined;
afterEach(async()=>{await a?.app.close();db?.close();a=undefined;db=undefined;});
const konfiguracja={srodowisko:'sandbox',klucz:'allegro_sandbox_proba',clientName:'Test-Sandbox',clientId:'fikcyjny',clientSecret:'WABIK-TAJNY',userAgent:'Test-Sandbox/1.0 (+https://example.invalid)',od:'2026-11-01'};
const env={...ENV_DEMO,OMS_TRYB:'proba',OMS_USER:'operator',OMS_PASS:'fixture',OMS_PROFORMY_KATALOG:'/tmp/prz128-proformy',OMS_ETYKIETY_KATALOG:'/tmp/prz128-etykiety'};
it('prawdziwa kompozycja miesza Sandbox z atrapami; stary import jest wyłączony, produkcja i reszta sieci odcięte',async()=>{
 const modul=await import('../../deploy/proba/sandbox-uruchomienie.ts').catch(()=>({}));
 expect(modul).toHaveProperty('przygotujUruchomienieSandbox');
 const {przygotujUruchomienieSandbox}=await import('../../deploy/proba/sandbox-uruchomienie.ts');
 const calls:string[]=[];
 const plan=przygotujUruchomienieSandbox(env,konfiguracja,async(u)=>{calls.push(String(u));if(String(u).endsWith('/me'))return Response.json({id:'123',login:'Testowy'});if(String(u).includes('/order/checkout-forms'))return Response.json({checkoutForms:[],totalCount:0});throw Error('Nieoczekiwany zasób testowy');});
 db=openOmsDb();a=await zbudujAplikacje({db,env,moduly:plan.moduly,nadpisania:plan.nadpisania(db),log:()=>{}});
 const repo=a.usluga<any>('kanaly','repozytoriumKanalow');const k=repo.pobierz(konfiguracja.klucz);expect(k).toMatchObject({srodowisko:'sandbox',autoryzacja:'brak'});
 // Istniejąca para po restarcie, bez nowej zgody i bez ruszania importu.
 const wynik=repo.zapiszZmiane(k.klucz,k.wersja,{kontoId:'123',login:'Testowy',autoryzacja:'polaczone',pobieranie:'wylaczone'},{id:1,login:'admin'});expect(wynik.ok).toBe(true);
 zapiszTokeny(db,k.klucz,{accessToken:'fake',refreshToken:'fake',wygasaAt:'2099-01-01',refreshWygasaAt:'2099-01-01'},wynik.dane.generacja);
 const klienci=a.usluga<any>('kanaly','klienciKanalow');expect(klienci.allegro.atrapa).toBe(true);expect(klienci['allegro-outlet'].atrapa).toBe(true);
 expect(await klienci[k.klucz].pobierzMojeKonto()).toEqual({id:'123',login:'Testowy'});
 const before=calls.length;await a.usluga<any>('kanaly','poller').przebieg();expect(calls).toHaveLength(before);
 const config=a.usluga<any>('kanaly','config');expect(config.definicje.map((d:any)=>d.klucz)).toContain(k.klucz);expect(Object.keys(config.sklepy)).not.toHaveLength(0);
 expect(Object.keys(a.usluga<any>('wiadomosci','klienciWiadomosci'))).toContain(k.klucz);
 repo.zapiszZmiane(k.klucz,wynik.dane.wersja,{pobieranie:'wlaczone'},{id:1,login:'admin'});await a.usluga<any>('kanaly','poller').przebieg();
 expect(calls.some(u=>u.includes('/order/checkout-forms?'))).toBe(true);expect(calls.every(u=>u.startsWith('https://api.allegro.pl.allegrosandbox.pl/'))).toBe(true);
 const nadpisania=plan.nadpisania(db);expect(Object.keys(nadpisania).some(k=>k.startsWith('kanaly.'))).toBe(false);
});
it.each([{...env,OMS_TRYB:'produkcja'},{...env,OMS_DEMO_LOGIN:'demo',OMS_DEMO_HASLO:'demo'}])('odmawia uruchomienia rzeczywistego Sandbox w produkcji i publicznym demo',async(e)=>{
 const {przygotujUruchomienieSandbox}=await import('../../deploy/proba/sandbox-uruchomienie.ts');
 expect(()=>przygotujUruchomienieSandbox(e,konfiguracja)).toThrow();
});
it('PRZ-148.07: plik profilu Sandbox to jawny profil — allegrosandbox.pl przechodzi, allegro.pl odmawia straż próby przed transportem',async()=>{
 const {przygotujUruchomienieSandbox}=await import('../../deploy/proba/sandbox-uruchomienie.ts');
 const {vi}=await import('vitest');
 const ostrzezenia:string[]=[];const warn=vi.spyOn(console,'warn').mockImplementation((...t:unknown[])=>{ostrzezenia.push(t.join(' '));});
 try{
  const calls:string[]=[];
  // Env bez OMS_PROBA_ALLEGRO_SANDBOX: o profilu decyduje sam plik /konfiguracja/allegro-sandbox.json.
  const plan=przygotujUruchomienieSandbox(env,konfiguracja,async(u)=>{calls.push(String(u));return Response.json({device_code:'KOD-POLCIEN',user_code:'ABC-123',verification_uri:'https://example.test/skojarz',expires_in:600,interval:5});});
  db=openOmsDb();a=await zbudujAplikacje({db,env,moduly:plan.moduly,nadpisania:plan.nadpisania(db),log:()=>{}});
  const aplikacja=a.usluga<any>('kanaly','aplikacjaAllegro'),para={clientId:'polcien-device-id',clientSecret:'SEKRET-POLCIEN'},aktor={id:1,login:'admin'};
  await aplikacja.sprawdzIZapiszAplikacjeDevice('sandbox',para,aktor);
  expect(calls).toContain('https://allegro.pl.allegrosandbox.pl/auth/oauth/device');
  calls.length=0;
  expect((await aplikacja.sprawdzIZapiszAplikacjeDevice('produkcja',para,aktor)).ok).toBe(false);
  expect(calls).toEqual([]);
  // Odmowa straży zapada przed transportem Sandbox: bez „błędu sieci” dla allegro.pl w logu.
  expect(ostrzezenia.filter(t=>t.includes('https://allegro.pl/'))).toEqual([]);
 }finally{warn.mockRestore();}
});
it('PRZ-150.03: plik profilu bez `klucz` — profil Sandbox i straż zostają, stałego kanału z pliku nie ma',async()=>{
 const {przygotujUruchomienieSandbox}=await import('../../deploy/proba/sandbox-uruchomienie.ts');
 const calls:string[]=[];
 const plan=przygotujUruchomienieSandbox(env,{srodowisko:'sandbox'},async(u)=>{calls.push(String(u));return Response.json({device_code:'KOD-POLCIEN',user_code:'ABC-123',verification_uri:'https://example.test/skojarz',expires_in:600,interval:5});});
 db=openOmsDb();a=await zbudujAplikacje({db,env,moduly:plan.moduly,nadpisania:plan.nadpisania(db),log:()=>{}});
 const config=a.usluga<any>('kanaly','config');
 expect(config.definicje.filter((d:any)=>/^allegro_sandbox_/.test(d.klucz))).toEqual([]);
 expect(Object.keys(config.braki).filter(k=>/^allegro_sandbox_/.test(k))).toEqual([]);
 expect(a.usluga<any>('kanaly','stanyKanalow')().filter((s:any)=>/^allegro_sandbox_/.test(s.klucz??s.kanal??''))).toEqual([]);
 expect(a.usluga<any>('kanaly','repozytoriumKanalow').pobierz('allegro_sandbox_proba')).toBeFalsy();
 const aplikacja=a.usluga<any>('kanaly','aplikacjaAllegro'),para={clientId:'polcien-device-id',clientSecret:'SEKRET-POLCIEN'},aktor={id:1,login:'admin'};
 await aplikacja.sprawdzIZapiszAplikacjeDevice('sandbox',para,aktor);
 expect(calls).toContain('https://allegro.pl.allegrosandbox.pl/auth/oauth/device');
 calls.length=0;
 expect((await aplikacja.sprawdzIZapiszAplikacjeDevice('produkcja',para,aktor)).ok).toBe(false);
 expect(calls).toEqual([]);
 expect(()=>przygotujUruchomienieSandbox(env,{srodowisko:'produkcja'})).toThrow();
 expect(()=>przygotujUruchomienieSandbox({...env,OMS_TRYB:'produkcja'},{srodowisko:'sandbox'})).toThrow();
});
