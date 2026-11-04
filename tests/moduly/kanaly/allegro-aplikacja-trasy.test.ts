import {afterEach,expect,it} from 'vitest';
import {zbudujAplikacje,type Aplikacja} from '../../../src/core/aplikacja.ts';
import {openOmsDb} from '../../../src/oms/db/db.ts';
import {modulyPiaskownicy} from '../../../deploy/proba/atrapy/index.mjs';
import {createModulKanaly} from '../../../src/moduly/kanaly/modul.ts';
import {zalozKonto} from '../../../src/core/bezpieczenstwo/konta.js';
import {podpisz} from '../../../src/core/bezpieczenstwo/sesja.js';
import {wczytajSekret} from '../../../src/core/bezpieczenstwo/sekret-sesji.js';
import {UPRAWNIENIA_NOWEGO_POLACZENIA} from '../../../src/oms/allegro/oauth-code.ts';
import {MODUL_ALLEGRO} from '../../../src/domena/modul-allegro.ts';
import {OPISY_UPRAWNIEN,ADRESY_PANELU_DEVELOPERA,krokiInstrukcji} from '../../../src/moduly/kanaly/instrukcja-aplikacji-allegro.ts';
import type {ModulOms} from '../../../src/core/kontrakty.ts';

const root='/ustawienia/integracje/allegro/aplikacja';
const akcja='/ustawienia/integracje/allegro/aplikacja-urzadzenia';
const SEKRET='SEKRET-POLCIEN';
let a:Aplikacja,db:ReturnType<typeof openOmsDb>;
afterEach(async()=>{await a?.app.close();db?.close();});
async function setup(status=200,envExtra:Record<string,string>={},device?:(body:string)=>Response){
 const calls:string[]=[];
 const http=async(u:string,i?:RequestInit)=>{
  calls.push(u);
  if(device&&u.endsWith('/device'))return device(String(i?.body??''));
  if(u.endsWith('/device'))return status===200?Response.json({device_code:'KOD-ODRZUCONY',user_code:'KOD-UZYTKOWNIKA',verification_uri:'https://allegro.pl/skojarz',expires_in:600,interval:5}):Response.json({error:'invalid_client',error_description:SEKRET},{status});
  throw Error('Nieoczekiwane API');
 };
 const env={OMS_USER:'serwis',OMS_PASS:'fixture',OMS_TRYB:'proba',OMS_KANALY:'[]',OMS_SPRZEDAWCA_NIP:'1234563218',OMS_RACHUNEK:'34109010140000000000000000',OMS_PROFORMY_KATALOG:'/tmp/prz132-proformy',OMS_ETYKIETY_KATALOG:'/tmp/prz132-etykiety',...envExtra};
 const m=createModulKanaly([],false,{fetchImpl:(u,i)=>http(String(u),i),autoryzacjaAtrapy:{http,softwareStatementId:'',redirectUri:'http://localhost/ustawienia/integracje/allegro/oauth/powrot',userAgent:'Fixture/1 (+https://example.invalid)'}});
 const kanal={...m,konfiguracja:()=>m.konfiguracja(env)};
 db=openOmsDb();
 a=await zbudujAplikacje({db,moduly:modulyPiaskownicy(env).map(x=>x.nazwa==='kanaly'?kanal:x) as ModulOms[],env,teraz:()=>new Date('2026-11-01T12:00:00Z'),log:()=>{}});
 zalozKonto(db,{login:'admin',imie:'Administrator',haslo:'fixture',rola:'administrator',admin:true});
 zalozKonto(db,{login:'operator',imie:'Operator',haslo:'fixture',rola:'sprzedaz',ekrany:['ustawienia']} as any);
 const cookie=(login:string)=>'sesja_oms_proba='+podpisz(login,wczytajSekret(db),Date.now());
 async function req(method:'GET'|'POST',url:string,payload?:Record<string,unknown>,auth=cookie('admin'),origin:string|undefined='http://localhost'){
  const r=await a.app.inject({method,url,headers:{accept:'text/html',cookie:auth,...(method==='POST'&&origin?{origin}:{})},payload});
  expect(r.body).not.toContain(SEKRET);expect(r.body).not.toContain('KOD-ODRZUCONY');
  return r;
 }
 return {req,cookie,calls};
}
const dane={srodowisko:'produkcja',clientId:'polcien-device-id',clientSecret:SEKRET};

it('PRZ-136.10: krok 0 ma polskie etykiety, główny zapis, wspólny steper i tytuł; sekret nie wraca do HTML',async()=>{
 const f=await setup();
 for(const srodowisko of ['produkcja','sandbox']){
  const p=await f.req('GET',root+'?srodowisko='+srodowisko);
  expect(p.statusCode).toBe(200);
  expect(p.body).toContain('<label for="aplikacja-client-id">Identyfikator aplikacji (Client ID)</label>');
  expect(p.body).toContain('<label for="aplikacja-client-secret">Klucz tajny aplikacji (Client Secret)</label>');
  expect(p.body).toContain('<button class="btn btn--glowny" type="submit">Zapisz i sprawdź</button>');
  expect(p.body).toContain('<title>Allegro: aplikacja OMS</title>');
  const krokiModulu=MODUL_ALLEGRO.konfigurator.kroki;
  expect(krokiModulu.length).toBeGreaterThan(4);
  expect(p.body).toContain('krok 0 z '+(krokiModulu.length-1));
  expect(p.body).toContain('<ol class="stepper" aria-label="Kroki konfiguracji">');
  expect(p.body).toMatch(/<li class="step current" aria-current="step">\s*<span class="step-dot" aria-hidden="true">0<\/span>/);
  expect((p.body.match(/<li class="step\b/g)??[]).length).toBe(krokiModulu.length);
  for(const k of krokiModulu)expect(p.body).toContain(k.numer+'. '+k.tytul);
  expect(p.body).toContain('method="post" action="'+akcja+'"');
  expect(p.body).toContain('type="hidden" name="srodowisko" value="'+srodowisko+'"');
  expect(p.body).toContain('name="clientId"');expect(p.body).toContain('name="clientSecret" type="password"');
  expect((await f.req('POST',akcja,{...dane,srodowisko})).statusCode).toBe(200);
  const zapisany=await f.req('GET',root+'?srodowisko='+srodowisko);
  expect(zapisany.body).toContain('sekret zapisany');
  expect(zapisany.body).not.toContain(SEKRET);
  expect(zapisany.body).not.toMatch(/<input[^>]*name="clientSecret"[^>]*value=/);
 }
});

it('GET bez aplikacji pokazuje instrukcję z typem aplikacji i adresem środowiska',async()=>{
 const f=await setup();
 const p=await f.req('GET',root+'?srodowisko=produkcja');
 expect(p.statusCode).toBe(200);expect(p.headers['referrer-policy']).toBe('strict-origin');
 expect(p.body).toContain('0. Aplikacja Allegro');
 expect(p.body).toContain('Aplikacja będzie działać w środowisku bez dostępu do przeglądarki albo klawiatury');
 expect(p.body).toContain('nie da się później zmienić');
 expect(p.body).toContain(ADRESY_PANELU_DEVELOPERA.produkcja);
 expect(p.body).not.toContain(ADRESY_PANELU_DEVELOPERA.sandbox);
 expect(p.body).toMatch(/<input[^>]*name="clientSecret"[^>]*type="password"|<input[^>]*type="password"[^>]*name="clientSecret"/);
 expect(p.body).toContain('autocomplete="off"');
 const s=await f.req('GET',root+'?srodowisko=sandbox');
 expect(s.body).toContain(ADRESY_PANELU_DEVELOPERA.sandbox);
 expect(ADRESY_PANELU_DEVELOPERA.sandbox).toBe('apps.developer.allegro.pl.allegrosandbox.pl');
 expect(ADRESY_PANELU_DEVELOPERA.produkcja).toBe('apps.developer.allegro.pl');
 expect(f.calls).toEqual([]);
});
it('każde uprawnienie z UPRAWNIENIA_NOWEGO_POLACZENIA jest w HTML i ma opis po polsku',async()=>{
 const f=await setup();const p=await f.req('GET',root+'?srodowisko=sandbox');
 expect(UPRAWNIENIA_NOWEGO_POLACZENIA).toHaveLength(8);
 for(const u of UPRAWNIENIA_NOWEGO_POLACZENIA){
  expect(OPISY_UPRAWNIEN[u],'opis dla '+u).toBeTruthy();
  expect(p.body).toContain(u);expect(p.body).toContain(OPISY_UPRAWNIEN[u]);
 }
});
it('POST z odpowiedzią 401 daje 422 z tekstem o Client ID/Secret i nic nie zapisuje',async()=>{
 const f=await setup(401);
 const r=await f.req('POST',akcja,dane);
 expect(r.statusCode).toBe(422);expect(r.body).toContain('Allegro nie rozpoznało Client ID albo Client Secret');
 expect(db.prepare('SELECT * FROM konfiguracja_integracji').all()).toEqual([]);
});
it('typ aplikacji: 400 daje 422 z tekstem o aplikacji bez przeglądarki',async()=>{
 const f=await setup(400);
 const r=await f.req('POST',akcja,dane);
 expect(r.statusCode).toBe(422);expect(r.body).toContain('bez dostępu do przeglądarki albo klawiatury');
});
it('PRZ-146.04: invalid_scope pokazuje listę brakujących uprawnień z sekcją panelu',async()=>{
 const f=await setup(200,{},body=>{
  const scope=new URLSearchParams(body).get('scope')??'';
  return scope.includes(' ')||scope==='allegro:api:orders:read'?Response.json({error:'invalid_scope'},{status:400}):Response.json({device_code:'KOD-ODRZUCONY',user_code:'X',verification_uri:'https://allegro.pl/skojarz',expires_in:600,interval:5});
 });
 const r=await f.req('POST',akcja,dane);
 expect(r.statusCode).toBe(400);
 const alert=r.body.match(/<div class="pas-blad" role="alert">([\s\S]*?)<\/div>/)?.[1]??'';
 expect(alert).toContain('<code>allegro:api:orders:read</code>');
 expect(alert).toContain('(sekcja „');
 expect(alert.match(/<li>/g)).toHaveLength(1);
 expect(db.prepare('SELECT * FROM konfiguracja_integracji').all()).toEqual([]);
});
it('po udanym zapisie HTML nie zawiera sekretu, także w value=, a pokazuje końcówkę ID',async()=>{
 const f=await setup();
 const r=await f.req('POST',akcja,dane);
 expect(r.statusCode).toBe(200);
 expect(r.body).toContain('Aplikacja zapisana');expect(r.body).toContain('••••e-id');expect(r.body).toContain('sekret zapisany');
 expect(r.body).not.toContain(SEKRET);expect(r.body).not.toContain('polcien-device-id');
 const g=await f.req('GET',root+'?srodowisko=produkcja');
 expect(g.body).not.toContain(SEKRET);expect(g.body).toContain('••••e-id');
 expect(db.prepare('SELECT count(*) AS n FROM konfiguracja_integracji').get()).toEqual({n:1});
});
it('aplikacja z env: bez formularza, a POST daje 409',async()=>{
 const f=await setup(200,{OMS_ALLEGRO_DEVICE_CLIENT_ID:'env-id-polcien',OMS_ALLEGRO_DEVICE_CLIENT_SECRET:'env-sekret-polcien'});
 const g=await f.req('GET',root+'?srodowisko=produkcja');
 expect(g.statusCode).toBe(200);expect(g.body).not.toContain(akcja);expect(g.body).not.toContain('name="clientSecret"');expect(g.body).toContain('Ustawione przez administratora serwera — zmienisz je tylko na serwerze.');
 expect(g.body).not.toContain('env-sekret-polcien');
 const r=await f.req('POST',akcja,dane);
 expect(r.statusCode).toBe(409);expect(r.body).toContain('Ustawione przez administratora serwera');
 expect(f.calls).toEqual([]);
});
it('konto połączone tą aplikacją: zamiast formularza tekst o odłączeniu, POST 409',async()=>{
 const f=await setup();
 expect((await f.req('POST',akcja,dane)).statusCode).toBe(200);
 db.prepare(`INSERT INTO kanaly_sprzedazy (klucz,nazwa,srodowisko,zrodlo,raport,autoryzacja,pobieranie,od_utc,wersja,generacja,generacja_importu,utworzono_at,zmieniono_at,aktor_id,aktor_login,aplikacja) VALUES ('allegro_polcien','Półcień','produkcja','panel','POLCIEN','polaczone','wylaczone','2026-11-01',0,0,0,'2026-11-01','2026-11-01',1,'polcien_test','device')`).run();
 const g=await f.req('GET',root+'?srodowisko=produkcja');
 expect(g.body).toContain('Najpierw odłącz konta Allegro połączone tą aplikacją.');
 expect(g.body).not.toContain(akcja);expect(g.body).not.toContain('name="clientSecret"');
 expect((await f.req('POST',akcja,dane)).statusCode).toBe(409);
});
it('nie-administrator dostaje 403, brak Origin odmowę CSRF; zły parametr środowiska 400',async()=>{
 const f=await setup();
 expect((await f.req('GET',root+'?srodowisko=sandbox',undefined,f.cookie('operator'))).statusCode).toBe(403);
 expect((await f.req('POST',akcja,dane,f.cookie('operator'))).statusCode).toBe(403);
 expect((await f.req('POST',akcja,dane,undefined,'')).statusCode).toBe(403);
 expect((await f.req('POST',akcja,dane,undefined,'https://obca.invalid')).statusCode).toBe(403);
 expect((await f.req('GET',root+'?srodowisko=cos')).statusCode).toBe(400);
 expect(f.calls).toEqual([]);expect(db.prepare('SELECT * FROM konfiguracja_integracji').all()).toEqual([]);
});
it('ekran „Podłącz konto” bez aplikacji Device prowadzi do kroku 0',async()=>{
 const f=await setup();
 const n=await f.req('GET','/ustawienia/integracje/allegro/nowe');
 // U22: jeden „Dalej”; do kroku 0 prowadzi odnośnik, nie drugi przycisk wysyłający formularz.
 expect(n.body).toContain('href="/ustawienia/integracje/allegro/aplikacja?srodowisko=produkcja"');expect(n.body).not.toContain('formaction="/ustawienia/integracje/allegro/aplikacja"');
});

it('PRZ-146.02 B2: krok 0 ma pole „Środowisko” z opcjami w kolejności modułu i zaznaczonym bieżącym',async()=>{
 const f=await setup();
 const opcje=MODUL_ALLEGRO.konfigurator.kroki.find(k=>k.numer===1)!.formularz!.pola.find(p=>p.id==='srodowisko')!.opcje!;
 expect(opcje.map(o=>o.wartosc)).toEqual(['produkcja','sandbox']);
 for(const biezace of ['produkcja','sandbox']){
  const p=await f.req('GET',root+'?srodowisko='+biezace);
  const form=p.body.match(/<form method="get" action="[^"]*aplikacja"[^>]*>[\s\S]*?<\/form>/)?.[0]??'';
  expect(form).toContain('<label for="aplikacja-srodowisko">Środowisko</label>');
  expect(form).toContain('<select id="aplikacja-srodowisko" name="srodowisko"');
  expect(form).toContain('>Zmień</button>');
  const wartosci=[...form.matchAll(/<option value="([^"]*)"([^>]*)>([^<]*)<\/option>/g)];
  expect(wartosci.map(m=>[m[1],m[3]])).toEqual(opcje.map(o=>[o.wartosc,o.etykieta]));
  expect(wartosci.filter(m=>/selected/.test(m[2])).map(m=>m[1])).toEqual([biezace]);
 }
});
it('PRZ-146.02 B3: uprawnienia są punktem przed regulaminem, regulamin na końcu; dopisek o edycji aplikacji',async()=>{
 await setup();
 const k=krokiInstrukcji('sandbox');
 const iU=k.findIndex(x=>x.lista),iR=k.findIndex(x=>/regulamin/.test(x.tekst));
 expect(iU).toBeGreaterThan(-1);expect(iR).toBeGreaterThan(iU);
 expect(k[iU].tekst).toContain('W sekcji Uprawnienia zaznacz wszystkie z listy poniżej');
 expect(k[iU].po).toContain('Zarządzanie aplikacjami');
 expect(k[iR].tekst).toContain('zatwierdź formularz');
 expect(k[iR+1].tekst).toContain('Skopiuj Client ID');
});
