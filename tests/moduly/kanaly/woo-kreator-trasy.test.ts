import {afterEach,expect,it} from 'vitest';
import {zbudujAplikacje,type Aplikacja} from '../../../src/core/aplikacja.ts';
import {openOmsDb} from '../../../src/oms/db/db.ts';
import {modulyPiaskownicy} from '../../../deploy/proba/atrapy/index.mjs';
import {createModulKanaly} from '../../../src/moduly/kanaly/modul.ts';
import {zalozKonto} from '../../../src/core/bezpieczenstwo/konta.js';
import {podpisz} from '../../../src/core/bezpieczenstwo/sesja.js';
import {wczytajSekret} from '../../../src/core/bezpieczenstwo/sekret-sesji.js';
import {MODUL_WOO} from '../../../src/domena/modul-woo.ts';
import type {ModulOms} from '../../../src/core/kontrakty.ts';
const root=MODUL_WOO.konfigurator.sciezka;
let a:Aplikacja,db:ReturnType<typeof openOmsDb>;
afterEach(async()=>{await a?.app.close();db?.close();});
async function setup(zPliku=false,proba=false){
 const env={OMS_USER:'serwis',OMS_PASS:'fixture',OMS_TRYB:'proba',OMS_KANALY:'[]',OMS_SPRZEDAWCA_NIP:'1234563218',OMS_RACHUNEK:'34109010140000000000000000',OMS_PROFORMY_KATALOG:'/tmp/prz132-proformy',OMS_ETYKIETY_KATALOG:'/tmp/prz132-etykiety'};
 const calls:string[]=[];const stan={awaria:false,obcy:false,bezBramek:false,odmowa:false};
 const definicje=zPliku?[{klucz:'z-pliku',typ:'woo' as const,prefiks:'POLCIEN',etykieta:'Pracownia Półcień'}]:[];
 const m=createModulKanaly(definicje,false,{fetchImpl:async(u)=>{const url=String(u);calls.push(url);if(stan.odmowa)return new Response('{}',{status:401});if(stan.obcy&&url.startsWith('https://sklep.polcien.example/'))return new Response(null,{status:302,headers:{Location:'https://obcy.example'+new URL(url).pathname}});if(stan.awaria&&url.includes('/shipping'))return new Response('awaria',{status:500});if(url.includes('/shipping/zones/'))return Response.json([1,2].map(i=>({instance_id:url.includes('/0/')?i+2:i,title:'Metoda Półcień '+i,method_id:'flat_rate',enabled:true})));if(url.includes('/shipping/zones'))return Response.json([{id:1,name:'Polska'}]);if(url.includes('/payment_gateways'))return stan.bezBramek?new Response('{}',{status:403}):Response.json([{id:'cod',title:'Za pobraniem',method_title:'Cash on delivery',enabled:true,settings:{token:{value:'sekret_bramki_polcien'}}},{id:'bacs',title:'Przelew bankowy',enabled:false}]);return Response.json([]);}});
 const config=createModulKanaly([]).konfiguracja(env);
 if(proba)m.konfiguracja(env);
 if(proba)config.sklepy['przykladowy']={atrapa:true,baseUrl:'https://atrapa.example.invalid'} as any;
 if(zPliku)config.sklepy['z-pliku']={baseUrl:'https://sklep.polcien.example',ck:'ck_test_polcien',cs:'cs_test_polcien',od:'2026-11-01T00:00:00Z',mapowanie:{instancje:{'1':{metoda:'dpd'}},poPozycji:[]},historia:null};
 db=openOmsDb();a=await zbudujAplikacje({db,moduly:modulyPiaskownicy(env).map(x=>x.nazwa==='kanaly'?{...m,konfiguracja:()=>config}:x) as ModulOms[],env,teraz:()=>new Date('2026-11-03T12:00:00Z'),log:()=>{}});
 zalozKonto(db,{login:'admin',imie:'Administrator',haslo:'fixture',rola:'administrator',admin:true});
 zalozKonto(db,{login:'operator',imie:'Operator',haslo:'fixture',rola:'sprzedaz',ekrany:['ustawienia']} as any);
 const cookies=Object.fromEntries(['admin','operator'].map(login=>[login,'sesja_oms_proba='+podpisz(login,wczytajSekret(db),Date.now())]));
 // Napis = prawdziwy formularz (application/x-www-form-urlencoded, powtórzone klucze jak z pól wyboru).
 const req=(method:'GET'|'POST',path:string,payload?:Record<string,unknown>|string,login='admin',origin:string|null='http://localhost')=>a.app.inject({method,url:root+path,payload,headers:{accept:'text/html',cookie:cookies[login],...(typeof payload==='string'?{'content-type':'application/x-www-form-urlencoded'}:{}),...(method==='POST'&&origin?{origin}:{})}});
 async function szkic(){
  const p=await req('POST','/szkice',{nazwa:'Pracownia Półcień',adres:'https://sklep.polcien.example'});expect(p.statusCode).toBe(200);
  const formularzId=p.body.match(/name="formularzId" value="([^"]+)"/)?.[1];expect(formularzId).toBeTruthy();
  const w=await req('POST','/nowy/klucze',{formularzId,wersja:0,ck:'ck_test_polcien',cs:'cs_test_polcien'});expect(w.statusCode).toBe(303);expect(JSON.stringify(w.headers)).not.toContain('cs_test_polcien');
  return String(w.headers.location).slice(root.length);
 }
 return {req,szkic,calls,stan,cookies};
}
it('C6: pole adresu przyjmuje domenę, serwer zapisuje HTTPS i informuje o zmianie HTTP',async()=>{
 const f=await setup();const ekran=await f.req('GET','/nowy');
 expect(ekran.body).toMatch(/name="adres"[^>]*type="text"[^>]*inputmode="url"/);
 expect(ekran.body).toContain('placeholder="sklep.pl"');
 for(const adres of ['example.test/','http://example.test/']){
  const p=await f.req('POST','/szkice',{nazwa:'Pracownia Półcień',adres});expect(p.statusCode).toBe(200);
  if(adres.startsWith('http:'))expect(p.body).toContain('Zmieniliśmy http:// na https://.');
  const formularzId=p.body.match(/name="formularzId" value="([^"]+)"/)?.[1];
  const r=await f.req('POST','/nowy/klucze',{formularzId,wersja:0,ck:'ck_test_polcien',cs:'cs_test_polcien'});
  if(adres.startsWith('http:'))expect(r.statusCode).toBe(409);else expect(r.statusCode).toBe(303);
 }
 expect(db.prepare('SELECT adres FROM kanaly_sklepy').all()).toEqual([{adres:'https://example.test'}]);
 expect(f.calls.every(u=>u.startsWith('https://example.test/'))).toBe(true);
});
it('C5: piaskownica odmawia obcego sklepu przed klientem i zapisem kluczy',async()=>{
 const f=await setup(false,true);
 const p=await f.req('POST','/szkice',{nazwa:'Pracownia Półcień',adres:'https://example.test'});
 expect(p.statusCode).toBe(200);
 const formularzId=p.body.match(/name="formularzId" value="([^"]+)"/)?.[1];
 const r=await f.req('POST','/nowy/klucze',{formularzId,wersja:0,ck:'ck_test_polcien',cs:'cs_test_polcien'});
 expect(r.body).toContain('Piaskownica nie łączy się z prawdziwymi sklepami — działa tu tylko sklep przykładowy.');
 expect(r.statusCode).toBe(400);expect(f.calls).toEqual([]);
 expect(db.prepare('SELECT * FROM kanaly_sklepy').all()).toEqual([]);
 expect(db.prepare('SELECT * FROM konfiguracja_integracji WHERE integracja LIKE ?').all('woo_klucze:%')).toEqual([]);
});
it('piaskownica dopuszcza wyłącznie adres atrapy z konfiguracji kanałów',async()=>{
 const f=await setup(false,true);
 for(const [adres,status] of [['https://obcy.example.invalid',400],['https://atrapa.example.invalid',303]] as const){
  const p=await f.req('POST','/szkice',{nazwa:'Sklep przykładowy',adres});
  expect(p.statusCode).toBe(200);
  const formularzId=p.body.match(/name="formularzId" value="([^"]+)"/)?.[1];
  const r=await f.req('POST','/nowy/klucze',{formularzId,wersja:0,ck:'ck_test_polcien',cs:'cs_test_polcien'});
  expect(r.statusCode).toBe(status);
  if(status===400){expect(r.body).toContain('Piaskownica nie łączy się z prawdziwymi sklepami — działa tu tylko sklep przykładowy.');expect(f.calls).toEqual([]);}
 }
 expect(f.calls.length).toBeGreaterThan(0);
 expect(f.calls.every(u=>u.startsWith('https://atrapa.example.invalid/'))).toBe(true);
});
it.each(['sklep-polcien.test/','  http://sklep-polcien.test/  '])('komunikat zmiany HTTP zależy od schematu po usunięciu spacji: %s',async adres=>{
 const f=await setup();
 const r=await f.req('POST','/szkice',{nazwa:'Sklep przykładowy',adres});
 expect(r.statusCode).toBe(200);
 expect(r.body.includes('Zmieniliśmy http:// na https://.')).toBe(adres.trim().startsWith('http:'));
});
it('admin, CSRF i polityka referera obowiązują na wszystkich trasach',async()=>{
 const f=await setup();const paths=['/szkice',...['klucze','sprawdz','mapowanie','data-startu','aktywuj','pobieranie','nazwa','odlacz','usun'].map(p=>'/sklep/'+p)];
 for(const p of ['/nowy','/sklep']){const r=await f.req('GET',p,undefined,'operator');expect(r.statusCode,p).toBe(403);expect(r.headers['referrer-policy']).toBe('strict-origin');}
 for(const p of paths){expect((await f.req('POST',p,{},'operator')).statusCode,p).toBe(403);expect((await f.req('POST',p,{},'admin',null)).statusCode,p).toBe(403);}
 expect((await f.req('GET','/nowy')).statusCode).toBe(200);expect(f.calls).toEqual([]);
});
it('prowadzi od nazwy do kluczy, sprawdzenia, mapowania, daty i aktywacji bez ujawnienia sekretów',async()=>{
 const f=await setup();const path=await f.szkic();let r=await f.req('GET',path);expect(r.statusCode).toBe(200);expect(r.body).toContain('zapisane');expect(r.body).toContain('Połączenie ze sklepem działa.');
 for(const sekret of ['ck_test_polcien','cs_test_polcien'])expect(r.body).not.toContain(sekret);
 const k=()=>db.prepare('SELECT * FROM kanaly_sprzedazy').get()!;
 expect((await f.req('POST',path+'/sprawdz',{wersja:k().wersja})).statusCode).toBe(200);
 expect((await f.req('POST',path+'/mapowanie',{wersja:k().wersja,'instancja_1':'dpd','instancja_4':'',pobranie_decyzja:'1'})).statusCode).toBe(303);
 expect((await f.req('POST',path+'/data-startu',{wersja:k().wersja,od:'2026-11-01'})).statusCode).toBe(303);
 expect((await f.req('POST',path+'/aktywuj',{wersja:k().wersja})).statusCode).toBe(303);
 expect(k()).toMatchObject({autoryzacja:'polaczone',pobieranie:'wlaczone'});
 r=await f.req('GET',path);expect(r.body.match(/name="instancja_\d+"/g)).toHaveLength(4);expect(r.body).toContain('Pozostałe lokalizacje');
 f.stan.awaria=true;r=await f.req('GET',path);
 expect(r.body).not.toMatch(/action="[^"]*\/mapowanie"/);expect(r.body).not.toContain('name="instancja_');expect(r.body).toContain('(1)');
 expect((await f.req('POST',path+'/nazwa',{wersja:0,nazwa:'Inna'})).statusCode).toBe(409);
 expect((await f.req('POST',path+'/odlacz',{wersja:k().wersja})).statusCode).toBe(400);
 expect((await f.req('POST',path+'/odlacz',{wersja:k().wersja,potwierdz:'tak'})).statusCode).toBe(303);
 expect(db.prepare('SELECT * FROM konfiguracja_integracji WHERE integracja LIKE ?').all('woo_klucze:%')).toHaveLength(0);
});
it('pokazuje odmowę kluczy już przy zapisie pierwszego szkicu',async()=>{
 const f=await setup();const woo=a.usluga('kanaly','sklepyWoo') as any;
 woo.sprawdz=async()=>({ok:false,kod:'tymczasowy',komunikat:'Sklep odrzucił klucze.'});
 const p=await f.req('POST','/szkice',{nazwa:'Pracownia Półcień',adres:'https://sklep.polcien.example'});
 const formularzId=p.body.match(/name="formularzId" value="([^"]+)"/)?.[1];
 const r=await f.req('POST','/nowy/klucze',{formularzId,wersja:0,ck:'ck_test_polcien',cs:'cs_test_polcien'});
 expect(r.statusCode).toBe(503);expect(r.body).toContain('Sklep odrzucił klucze.');expect(r.body).not.toContain('cs_test_polcien');
});
// PRZ-134.PT8 (zgłoszenie właściciela 03.11): odrzucone klucze nie zostawiają szkicu w bazie — wcześniej sklep znikał z listy,
// a jego adres blokował ponowne dodanie. Konfigurator zostaje na kroku kluczy z tym samym formularzem.
it('odrzucone klucze nowego sklepu niczego nie zapisują, poprawne w tym samym formularzu tworzą sklep (PRZ-134.PT8)',async()=>{
 const f=await setup();f.stan.odmowa=true;
 const p=await f.req('POST','/szkice',{nazwa:'Pracownia Półcień',adres:'https://sklep.polcien.example'});
 const formularzId=p.body.match(/name="formularzId" value="([^"]+)"/)?.[1];
 let r=await f.req('POST','/nowy/klucze',{formularzId,wersja:0,ck:'ck_zly_polcien',cs:'cs_zly_polcien'});
 expect(r.statusCode).toBe(503);expect(r.body).toContain('Sklep odrzucił klucze.');expect(r.body).not.toContain('cs_zly_polcien');
 expect(r.body).toContain(`name="formularzId" value="${formularzId}"`);expect(r.body).not.toMatch(/action="[^"]*\/mapowanie"/);
 expect(db.prepare('SELECT count(*) n FROM kanaly_sprzedazy').get()).toMatchObject({n:0});
 expect(db.prepare('SELECT count(*) n FROM kanaly_sklepy').get()).toMatchObject({n:0});
 expect(db.prepare('SELECT * FROM konfiguracja_integracji WHERE integracja LIKE ?').all('woo_klucze:%')).toHaveLength(0);
 f.stan.odmowa=false;
 r=await f.req('POST','/nowy/klucze',{formularzId,wersja:0,ck:'ck_test_polcien',cs:'cs_test_polcien'});
 expect(r.statusCode).toBe(303);expect(db.prepare('SELECT count(*) n FROM kanaly_sklepy').get()).toMatchObject({n:1});
});
it('każda akcja opisu Woo ma trasę POST',async()=>{
 const f=await setup();for(const krok of MODUL_WOO.konfigurator.kroki){if('formularz' in krok){const r=await f.req('POST','/'+krok.formularz.akcja.replace(':kanal','brak'),{});expect(r.statusCode).not.toBe(404);}}
});
it('POST na sklep env daje 409 i niczego nie zapisuje',async()=>{
 const f=await setup(true);
 const przed=db.prepare('SELECT * FROM kanaly_sprzedazy').all();
 for(const akcja of ['klucze','sprawdz','mapowanie','data-startu','aktywuj','pobieranie','nazwa','odlacz','usun']){const r=await f.req('POST','/z-pliku/'+akcja,{wersja:0});expect(r.statusCode).toBe(409);expect(r.body).toContain('Formularz niczego nie zapisał.');}
 expect(db.prepare('SELECT * FROM kanaly_sprzedazy').all()).toEqual(przed);
 const r=await f.req('GET','/z-pliku');expect(r.statusCode).toBe(200);expect(r.body).not.toMatch(/<form[^>]+action="\/ustawienia\/integracje\/woocommerce/);expect(r.body).not.toContain('cs_test_polcien');expect(r.body).toContain('https://sklep.polcien.example');expect(f.calls).toEqual([]);
});
it('krok kluczy: puste pola sprawdzają zapisane klucze, wypełnione zapisują nowe; bez kluczy puste pola to błąd',async()=>{
 const f=await setup();const path=await f.szkic();const k=()=>db.prepare('SELECT * FROM kanaly_sprzedazy').get()! as any;
 const przed=k().wersja,wywolania=f.calls.length;
 let r=await f.req('POST',path+'/klucze',{wersja:przed,ck:'',cs:''});
 expect(r.statusCode).toBe(200);expect(r.body).toContain('Połączenie ze sklepem działa.');expect(k().wersja).toBe(przed);expect(f.calls.length).toBeGreaterThan(wywolania);
 r=await f.req('POST',path+'/klucze',{wersja:przed,ck:'ck_nowy_polcien',cs:'cs_nowy_polcien'});
 expect(r.statusCode).toBe(200);expect(k().wersja).toBe(przed+1);expect(r.body).not.toContain('cs_nowy_polcien');
 expect((await f.req('POST',path+'/odlacz',{wersja:k().wersja,potwierdz:'tak'})).statusCode).toBe(303);
 r=await f.req('POST',path+'/klucze',{wersja:k().wersja,ck:'',cs:''});expect(r.statusCode).toBe(400);expect(r.body).toContain('Podaj oba klucze REST.');
});
it('konfigurator: sprawdzenie i metody wysyłki po 302 na obcy origin nie wysyłają tam żądania',async()=>{
 const f=await setup();const path=await f.szkic();const k=()=>db.prepare('SELECT * FROM kanaly_sprzedazy').get()! as any;
 f.stan.obcy=true;const przed=f.calls.length;
 const r=await f.req('POST',path+'/sprawdz',{wersja:k().wersja});expect(r.statusCode).not.toBe(200);
 await f.req('GET',path);
 expect(f.calls.length).toBeGreaterThan(przed);expect(f.calls.filter(u=>!u.startsWith('https://sklep.polcien.example/'))).toEqual([]);
});
it('PRZ-134 krok 3: formularz zapisuje bramki pobrania i pobranie przy metodzie; bez decyzji odmowa',async()=>{
 const f=await setup();const path=await f.szkic();const k=()=>db.prepare('SELECT * FROM kanaly_sprzedazy').get()! as any;
 const mapa=()=>JSON.parse(String((db.prepare('SELECT ustawienia_json FROM kanaly_sklepy').get() as any).ustawienia_json)).mapowanie;
 let r=await f.req('GET',path);
 expect(r.body).toMatch(/aria-current="step">\s*<span class="step-dot" aria-hidden="true">3</s);
 expect(r.body).toMatch(/name="bramki" value="cod" checked/);expect(r.body).toContain('Za pobraniem (cod)');expect(r.body).toContain('Przelew bankowy (bacs) — wyłączona w sklepie');
 expect(r.body).not.toContain('sekret_bramki_polcien');expect(r.body).toContain('name="pobranie_decyzja" value="1"');
 // bez decyzji: odmowa, baza bez zmian
 const przed=mapa(),wersja=k().wersja;
 r=await f.req('POST',path+'/mapowanie','wersja='+wersja+'&instancja_1=dpd&bramki=cod');
 expect(r.statusCode).toBe(400);expect(r.body).toContain('Odśwież ekran i zapisz mapowanie jeszcze raz.');expect(mapa()).toEqual(przed);expect(k().wersja).toBe(wersja);
 // prawdziwy formularz: pole pobrania i jedna bramka
 r=await f.req('POST',path+'/mapowanie','wersja='+wersja+'&instancja_3=dpd&pobranie_3=tak&instancja_1=inpost_paczkomat&bramki=cod&pobranie_decyzja=1');
 expect(r.statusCode).toBe(303);expect(mapa().instancje).toEqual({'3':{metoda:'dpd',pobranie:true},'1':{metoda:'inpost_paczkomat'}});expect(mapa().bramkiPobrania).toEqual(['cod']);
 // dwie bramki z pól wyboru + pole tekstowe, bez powtórzeń
 r=await f.req('POST',path+'/mapowanie','wersja='+k().wersja+'&instancja_1=dpd&bramki=cod&bramki=bacs&bramki_tekst='+encodeURIComponent(' cod , inna_bramka,')+'&pobranie_decyzja=1');
 expect(r.statusCode).toBe(303);expect(mapa().bramkiPobrania).toEqual(['cod','bacs','inna_bramka']);
 r=await f.req('POST',path+'/mapowanie','wersja='+k().wersja+'&instancja_1=dpd&bramki=cod&bramki=bacs&pobranie_decyzja=1');
 expect(r.statusCode).toBe(303);expect(mapa().bramkiPobrania).toHaveLength(2);
 // decyzja „żadnej”: pusta lista, cod już nie zaznaczony, krok 3 zrobiony
 r=await f.req('POST',path+'/mapowanie','wersja='+k().wersja+'&instancja_1=dpd&pobranie_decyzja=1');
 expect(r.statusCode).toBe(303);expect(mapa().bramkiPobrania).toEqual([]);
 r=await f.req('GET',path);expect(r.body).not.toMatch(/value="cod" checked/);expect(r.body).toContain('Zapisano: żadne zamówienie z tego sklepu nie będzie za pobraniem.');
 expect(r.body).not.toMatch(/aria-current="step">\s*<span class="step-dot" aria-hidden="true">3</s);expect(r.body).not.toContain('Uzupełnij pobranie');
});
it('PRZ-134 krok 3: stare mapowanie bez decyzji — krok bieżący 3 i pasek w kroku 3 (kroku 5 szkic jeszcze nie pokazuje, PT9); bez listy bramek pole tekstowe',async()=>{
 const f=await setup();const path=await f.szkic();
 db.prepare('UPDATE kanaly_sklepy SET ustawienia_json=?').run(JSON.stringify({mapowanie:{instancje:{'1':{metoda:'dpd'}},poPozycji:[]}}));
 let r=await f.req('GET',path);
 expect(r.body).toMatch(/aria-current="step">\s*<span class="step-dot" aria-hidden="true">3</s);
 expect(r.body.match(/Uzupełnij pobranie w kroku 3\. Do czasu zapisu żadne zamówienie z tego sklepu nie dostanie pobrania\./g)).toHaveLength(1);
 f.stan.bezBramek=true;r=await f.req('GET',path);
 expect(r.body).toMatch(/name="bramki_tekst"[^>]*value="cod"/);expect(r.body).toContain('Nie udało się odczytać bramek płatności ze sklepu.');expect(r.body).not.toContain('name="bramki" value=');
});
// PRZ-134.PT9 (zgłoszenie właściciela 03.11): szkic pokazuje kroki tylko do bieżącego; szkic bez zamówień da się usunąć.
const forma=(akcja:string)=>new RegExp(`<form[^>]+action="[^"]*/${akcja}"`);
const liczba=(sql:string,...p:unknown[])=>(db.prepare(sql).get(...p as any[]) as {n:number}).n;
it('PT9 (a): szkic z kluczami odrzuconymi albo niesprawdzonymi — tylko formularz kluczy, bez mapowania, daty i aktywacji',async()=>{
 const f=await setup();const path=await f.szkic();const k=()=>db.prepare('SELECT * FROM kanaly_sprzedazy').get()! as any;
 f.stan.odmowa=true;expect((await f.req('POST',path+'/sprawdz',{wersja:k().wersja})).statusCode).toBe(503);
 let r=await f.req('GET',path);expect(r.statusCode).toBe(200);
 expect(r.body).toMatch(forma('klucze'));for(const akcja of ['mapowanie','data-startu','aktywuj'])expect(r.body,akcja).not.toMatch(forma(akcja));
 expect(r.body).not.toContain('<h2>3.');expect(r.body).not.toContain('<h2>4.');expect(r.body).not.toContain('<h2>5.');
 expect(r.body).toMatch(/aria-current="step">\s*<span class="step-dot" aria-hidden="true">2</s);
 // niesprawdzone (bez odmowy): to samo i bez zapytań o metody wysyłki do sklepu
 f.stan.odmowa=false;db.prepare('UPDATE kanaly_sklepy SET sprawdzono_at=NULL').run();const przed=f.calls.length;
 r=await f.req('GET',path);expect(r.body).toMatch(forma('klucze'));for(const akcja of ['mapowanie','data-startu','aktywuj'])expect(r.body,akcja).not.toMatch(forma(akcja));
 expect(f.calls.length).toBe(przed);
 // zarządzanie zawsze widoczne: nazwa, odłączenie, usunięcie
 expect(r.body).toContain('Zarządzanie sklepem');for(const akcja of ['nazwa','odlacz','usun'])expect(r.body,akcja).toMatch(forma(akcja));
 // po sprawdzeniu: krok 2 zwinięty, widać mapowanie, ale nie datę i aktywację
 expect((await f.req('POST',path+'/sprawdz',{wersja:k().wersja})).statusCode).toBe(200);r=await f.req('GET',path);
 expect(r.body).toContain('Klucze REST — połączenie działa');expect(r.body).toMatch(forma('mapowanie'));expect(r.body).not.toMatch(forma('data-startu'));expect(r.body).not.toMatch(forma('aktywuj'));
 // po zapisie mapowania: data startu i „Aktywuj” w kroku 4, krok 5 dalej ukryty
 expect((await f.req('POST',path+'/mapowanie',{wersja:k().wersja,'instancja_1':'dpd',pobranie_decyzja:'1'})).statusCode).toBe(303);r=await f.req('GET',path);
 expect(r.body).toMatch(forma('data-startu'));expect(r.body).toMatch(forma('aktywuj'));expect(r.body).not.toContain('<h2>5.');
 // odłączony szkic: komunikat i krok kluczy, bez mapowania i bez drugiego odłączenia
 expect((await f.req('POST',path+'/odlacz',{wersja:k().wersja,potwierdz:'tak'})).statusCode).toBe(303);r=await f.req('GET',path);
 expect(r.body).toContain('Sklep odłączony — podaj nowe klucze, aby podłączyć go ponownie');expect(r.body).toMatch(forma('klucze'));
 expect(r.body).not.toMatch(forma('mapowanie'));expect(r.body).not.toMatch(forma('odlacz'));expect(r.body).toMatch(forma('usun'));
});
it('PT9 (b): aktywny sklep pokazuje wszystkie sekcje jak dotąd, bez usuwania',async()=>{
 const f=await setup();const path=await f.szkic();const k=()=>db.prepare('SELECT * FROM kanaly_sprzedazy').get()! as any;
 expect((await f.req('POST',path+'/mapowanie',{wersja:k().wersja,'instancja_1':'dpd',pobranie_decyzja:'1'})).statusCode).toBe(303);
 expect((await f.req('POST',path+'/aktywuj',{wersja:k().wersja})).statusCode).toBe(303);
 const r=await f.req('GET',path);for(let i=1;i<=5;i++)expect(r.body).toContain(`<h2>${i}.`);
 for(const akcja of ['klucze','mapowanie','pobieranie','nazwa','odlacz'])expect(r.body,akcja).toMatch(forma(akcja));
 expect(r.body).toContain('Sklep: aktywny');expect(r.body).toContain('Zamówień sprzed tej daty');expect(r.body).not.toMatch(forma('usun'));expect(r.body).not.toMatch(forma('aktywuj'));
 expect(r.body.indexOf('Zarządzanie sklepem')).toBeGreaterThan(r.body.indexOf('<h2>5.'));
});
it('PT9 (c): usunięcie szkicu kasuje sklep, klucze i stan, zostawia audyt; ten sam adres można dodać ponownie',async()=>{
 const f=await setup();const path=await f.szkic();const k=db.prepare('SELECT * FROM kanaly_sprzedazy').get()! as any;
 db.prepare("INSERT INTO stan_pollera(sklep,ostatni_przebieg_at,ostatni_blad) VALUES (?,'2026-11-03','401')").run(k.klucz);
 const r=await f.req('POST',path+'/usun',{wersja:k.wersja,potwierdz:'tak'});
 expect(r.statusCode).toBe(303);expect(r.headers.location).toBe('/ustawienia/integracje?zapisano=usunieto_sklep');
 expect(liczba('SELECT count(*) n FROM kanaly_sprzedazy')).toBe(0);expect(liczba('SELECT count(*) n FROM kanaly_sklepy')).toBe(0);
 expect(liczba("SELECT count(*) n FROM konfiguracja_integracji WHERE integracja LIKE 'woo_klucze:%'")).toBe(0);expect(liczba('SELECT count(*) n FROM stan_pollera WHERE sklep=?',k.klucz)).toBe(0);
 expect(db.prepare('SELECT operacja,wersja,aktor_login FROM kanaly_audit WHERE kanal=? ORDER BY rowid DESC LIMIT 1').get(k.klucz)).toEqual({operacja:'usuniecie_sklepu',wersja:k.wersja+1,aktor_login:'admin'});
 const lista=await a.app.inject({method:'GET',url:'/ustawienia/integracje?zapisano=usunieto_sklep',headers:{accept:'text/html',cookie:f.cookies.admin}});
 expect(lista.statusCode).toBe(200);expect(lista.body).toContain('Usunięto sklep WooCommerce.');expect(lista.body).not.toContain('Pracownia Półcień');
 expect((await f.req('GET',path)).statusCode).toBe(404);
 await f.szkic();expect(liczba('SELECT count(*) n FROM kanaly_sklepy WHERE adres=?','https://sklep.polcien.example')).toBe(1);
});
it('PT9 (d): odmowa usunięcia, gdy sklep ma zamówienie albo jest aktywny',async()=>{
 const f=await setup();const path=await f.szkic();const k=()=>db.prepare('SELECT * FROM kanaly_sprzedazy').get()! as any;const STARA=k().autoryzacja;
 db.prepare("INSERT INTO zamowienia(sklep,zrodlo_id,numer,kwota_brutto,utworzone_at) VALUES (?,1,'PC-1','10.00','2026-11-02')").run(k().klucz);
 let r=await f.req('GET',path);expect(r.body).not.toMatch(forma('usun'));expect(r.body).toMatch(forma('odlacz'));expect(r.body).toContain('Sklep ma już pobrane zamówienia — możesz go tylko odłączyć.');
 db.prepare("UPDATE kanaly_sprzedazy SET autoryzacja='odlaczone' WHERE klucz=?").run(k().klucz);
 r=await f.req('GET',path);expect(r.body).not.toMatch(forma('usun'));expect(r.body).toContain('Sklep jest odłączony. Usunąć go nie można');expect(r.body).not.toContain('możesz go tylko odłączyć');
 db.prepare("UPDATE kanaly_sprzedazy SET autoryzacja=? WHERE klucz=?").run(STARA,k().klucz);
 r=await f.req('POST',path+'/usun',{wersja:k().wersja,potwierdz:'tak'});
 expect(r.statusCode).toBe(409);expect(r.body).toContain('Sklep ma już pobrane zamówienia — możesz go tylko odłączyć.');
 expect(liczba('SELECT count(*) n FROM kanaly_sprzedazy')).toBe(1);expect(liczba("SELECT count(*) n FROM konfiguracja_integracji WHERE integracja LIKE 'woo_klucze:%'")).toBe(1);
 db.prepare('DELETE FROM zamowienia').run();
 expect((await f.req('POST',path+'/mapowanie',{wersja:k().wersja,'instancja_1':'dpd',pobranie_decyzja:'1'})).statusCode).toBe(303);
 expect((await f.req('POST',path+'/aktywuj',{wersja:k().wersja})).statusCode).toBe(303);
 r=await f.req('POST',path+'/usun',{wersja:k().wersja,potwierdz:'tak'});expect(r.statusCode).toBe(409);expect(r.body).toContain('Najpierw odłącz sklep, potem go usuń.');
 expect(liczba('SELECT count(*) n FROM kanaly_sprzedazy')).toBe(1);expect(liczba('SELECT count(*) n FROM kanaly_sklepy')).toBe(1);expect(k().autoryzacja).toBe('polaczone');
});
// Decyzja kierownika PT9: aktywacja bez pobranych danych nie blokuje usunięcia — inaczej adres zostaje zajęty na zawsze.
it('PT9 (f): sklep aktywowany i odłączony, który nic nie pobrał, daje się usunąć razem z granicą historii; adres wolny',async()=>{
 const f=await setup();const path=await f.szkic();const k=()=>db.prepare('SELECT * FROM kanaly_sprzedazy').get()! as any;
 expect((await f.req('POST',path+'/mapowanie',{wersja:k().wersja,'instancja_1':'dpd',pobranie_decyzja:'1'})).statusCode).toBe(303);
 expect((await f.req('POST',path+'/aktywuj',{wersja:k().wersja})).statusCode).toBe(303);expect(k().generacja_importu).toBeGreaterThan(0);
 db.prepare("INSERT INTO stan_pollera(sklep,zsynchronizowane_do) VALUES (?,'2026-11-03T10:00:00Z') ON CONFLICT(sklep) DO UPDATE SET zsynchronizowane_do=excluded.zsynchronizowane_do").run(k().klucz);
 db.prepare("INSERT OR IGNORE INTO granice_historii(kanal,do_dnia,zrodlo,uwaga) VALUES (?,'2026-11-02','oms-bez-historii','test')").run(k().raport);
 expect((await f.req('POST',path+'/odlacz',{wersja:k().wersja,potwierdz:'tak'})).statusCode).toBe(303);
 const raport=k().raport;let r=await f.req('GET',path);expect(r.body).toMatch(forma('usun'));
 r=await f.req('POST',path+'/usun',{wersja:k().wersja,potwierdz:'tak'});expect(r.statusCode).toBe(303);
 expect(liczba('SELECT count(*) n FROM kanaly_sprzedazy')).toBe(0);expect(liczba('SELECT count(*) n FROM granice_historii WHERE kanal=?',raport)).toBe(0);
 await f.szkic();expect(liczba('SELECT count(*) n FROM kanaly_sklepy WHERE adres=?','https://sklep.polcien.example')).toBe(1);
});
it('PT9 (e): bez potwierdzenia albo ze starą wersją niczego nie kasuje',async()=>{
 const f=await setup();const path=await f.szkic();const k=()=>db.prepare('SELECT * FROM kanaly_sprzedazy').get()! as any;const wersja=k().wersja;
 let r=await f.req('POST',path+'/usun',{wersja});expect(r.statusCode).toBe(400);expect(r.body).toContain('Potwierdź usunięcie sklepu.');
 r=await f.req('POST',path+'/usun',{wersja:wersja+5,potwierdz:'tak'});expect(r.statusCode).toBe(409);
 r=await f.req('POST',path+'/usun',{wersja,potwierdz:'tak'},'admin',null);expect(r.statusCode).toBe(403);
 expect(liczba('SELECT count(*) n FROM kanaly_sprzedazy')).toBe(1);expect(liczba('SELECT count(*) n FROM kanaly_sklepy')).toBe(1);
 expect(liczba("SELECT count(*) n FROM konfiguracja_integracji WHERE integracja LIKE 'woo_klucze:%'")).toBe(1);expect(k().wersja).toBe(wersja);
 expect(liczba("SELECT count(*) n FROM kanaly_audit WHERE operacja='usuniecie_sklepu'")).toBe(0);
});
