import {afterEach,expect,it} from 'vitest';
import {zbudujAplikacje,type Aplikacja} from '../../../src/core/aplikacja.ts';
import {openOmsDb} from '../../../src/oms/db/db.ts';
import {modulyPiaskownicy} from '../../../deploy/proba/atrapy/index.mjs';
import {createModulKanaly} from '../../../src/moduly/kanaly/modul.ts';
import {zalozKonto} from '../../../src/core/bezpieczenstwo/konta.js';
import {podpisz} from '../../../src/core/bezpieczenstwo/sesja.js';
import {wczytajSekret} from '../../../src/core/bezpieczenstwo/sekret-sesji.js';
import {scopesAllegro} from '../../pomoc/allegro-konfigurator.ts';
import {modulKanalu} from '../../../src/domena/moduly-kanalow.ts';
import type {ModulOms} from '../../../src/core/kontrakty.ts';

const root='/ustawienia/integracje/allegro';
let a:Aplikacja,db:ReturnType<typeof openOmsDb>;
afterEach(async()=>{await a?.app.close();db?.close();});
async function setup(device=true){
 let czas=new Date('2026-11-01T12:00:00Z'),konto='1000001',bladTokena='',scope=[...scopesAllegro];const calls:string[]=[];
 const http=async(u:string)=>{
  calls.push(u);
  if(u.endsWith('/device'))return Response.json({device_code:'DEVICE-POLCIEN',user_code:'POLCIEN-123',verification_uri:'https://allegro.pl/skojarz',expires_in:600,interval:5});
  if(u.endsWith('/token'))return bladTokena?Response.json({error:bladTokena,error_description:'SECRET-POLCIEN'},{status:400}):Response.json({access_token:'ACCESS-POLCIEN',refresh_token:'REFRESH-POLCIEN',expires_in:3600,scope:scope.join(' ')});
  if(u.endsWith('/me'))return Response.json({id:konto,login:'polcien_test'});
  if(u.includes('/order/checkout-forms?'))return Response.json({checkoutForms:[],totalCount:0});
  throw Error('Nieoczekiwane API');
 };
 const env={OMS_USER:'serwis',OMS_PASS:'fixture',OMS_TRYB:'proba',OMS_KANALY:'[]',OMS_SPRZEDAWCA_NIP:'1234563218',OMS_RACHUNEK:'34109010140000000000000000',OMS_PROFORMY_KATALOG:'/tmp/prz132-proformy',OMS_ETYKIETY_KATALOG:'/tmp/prz132-etykiety'};
 const m=createModulKanaly([],false,{fetchImpl:u=>http(String(u)),autoryzacjaAtrapy:{http,softwareStatementId:'',redirectUri:'http://localhost'+root+'/oauth/powrot',userAgent:'Fixture/1 (+https://example.invalid)'}});
 const kanal={...m,konfiguracja:()=>m.konfiguracja(env)};
 db=openOmsDb();a=await zbudujAplikacje({db,moduly:modulyPiaskownicy(env).map(x=>x.nazwa==='kanaly'?kanal:x) as ModulOms[],env,teraz:()=>czas,log:()=>{}});
 zalozKonto(db,{login:'admin',imie:'Administrator',haslo:'fixture',rola:'administrator',admin:true});
 zalozKonto(db,{login:'operator',imie:'Operator',haslo:'fixture',rola:'sprzedaz',ekrany:['ustawienia']} as any);
 let flow='';const cookies=Object.fromEntries(['admin','operator'].map(login=>[login,'sesja_oms_proba='+podpisz(login,wczytajSekret(db),Date.now())]));
 async function req(method:'GET'|'POST',url:string,payload?:Record<string,unknown>,login='admin',origin='http://localhost'){
  const r=await a.app.inject({method,url,headers:{accept:'text/html',cookie:cookies[login]+'; '+flow,...(method==='POST'&&origin?{origin}:{})},payload});
  const c=[r.headers['set-cookie']??[]].flat().find(c=>c.startsWith('oms_allegro_flow='));if(c)flow=c.split(';')[0];
  expect(r.body+JSON.stringify(r.headers)).not.toMatch(/SECRET-POLCIEN|DEVICE-POLCIEN|ACCESS-POLCIEN|REFRESH-POLCIEN/);
  return r;
 }
 if(device)expect((await req('POST',root+'/aplikacja-urzadzenia',{srodowisko:'produkcja',clientId:'polcien-id',clientSecret:'SECRET-POLCIEN'})).statusCode).toBe(200);
 const repo=a.usluga<any>('kanaly','repozytoriumKanalow');
 async function draft(){
  const page=await req('GET',root+'/nowe');const formularzId=page.body.match(/name="formularzId" value="([^"]+)"/)![1];
  const r=await req('POST',root+'/szkice',{formularzId,nazwa:'Pracownia Półcień',od:'2026-11-01',srodowisko:'produkcja'});
  expect(r.statusCode).toBe(303);return r.headers.location!.split('/').pop()!;
 }
 const post=(k:string,akcja:string,dane:Record<string,unknown>={})=>req('POST',root+'/'+k+'/'+akcja,{wersja:String(repo.pobierz(k).wersja),...dane});
 async function candidate(k:string){
  const start=await post(k,'autoryzacja');expect(start.statusCode).toBe(200);expect(start.body).toContain('POLCIEN-123');
  const probaId=start.body.match(/name="probaId" value="([^"]+)"/)![1];czas=new Date(czas.getTime()+6000);
  return {probaId,page:await post(k,'zgoda',{probaId})};
 }
 return {req,repo,draft,post,candidate,calls,setKonto:(id:string)=>{konto=id;},setBlad:(b:string)=>{bladTokena=b;},bezProfilu:()=>{scope=scope.filter(s=>s!=='allegro:api:profile:read');}};
}

it('krok 1 używa opisu modułu i domyślnie wybiera produkcję',async()=>{
 const f=await setup();const r=await f.req('GET',root+'/nowe');expect(r.statusCode).toBe(200);
 expect(r.body).toMatch(/value="produkcja" selected/);expect(r.body).toContain('aria-current="step"');
 for(const krok of modulKanalu('allegro').konfigurator.kroki)expect(r.body).toContain(krok.tytul);
});
it('panel z Device pokazuje kod, adres, ostrzeżenie i ręczne sprawdzenie z odstępem',async()=>{
 const f=await setup(),k=await f.draft(),r=await f.post(k,'autoryzacja');expect(r.statusCode).toBe(200);
 expect(r.headers.location).toBeUndefined();expect(r.body).toContain('POLCIEN-123');expect(r.body).toContain('https://allegro.pl/skojarz');
 expect(r.body).toContain('Allegro podłączy konto, na które ta przeglądarka jest teraz zalogowana');
 expect(r.body).toContain('oknie prywatnym');expect(r.body).toContain('Sprawdź, czy zgoda dotarła');
 const probaId=r.body.match(/name="probaId" value="([^"]+)"/)![1];
 const pending=await f.post(k,'zgoda',{probaId});expect(pending.body).toContain('5 s');expect(f.calls.filter(u=>u.endsWith('/token'))).toHaveLength(0);
});
it('bez obu aplikacji kieruje do kroku 0 z komunikatem',async()=>{
 const f=await setup(false),k=await f.draft(),r=await f.post(k,'autoryzacja');expect(r.statusCode).toBe(303);
 expect(r.headers.location).toBe(root+'/aplikacja?srodowisko=produkcja');
 expect((await f.req('GET',r.headers.location!)).body).toContain('Najpierw załóż aplikację Allegro (krok 0).');
});
it('krok 3 pokazuje login i ID, potwierdzenie prowadzi do kroku 4; nowa data działa przy aktywacji',async()=>{
 const f=await setup(),k=await f.draft(),{probaId,page}=await f.candidate(k);
 expect(page.statusCode).toBe(200);expect(page.body).toContain('polcien_test');expect(page.body).toContain('1000001');
 expect(page.body).not.toContain('Jesteś zalogowany w przeglądarce jako');expect(page.body).toContain('Jeśli to konto chcesz podłączyć — kliknij Dalej.');expect(page.body).toContain('To moje konto — dalej');
 const next=await f.post(k,'potwierdz',{probaId});expect(next.statusCode).toBe(303);
 const data=await f.req('GET',next.headers.location!);expect(data.body).toContain('4. Data startu');expect(data.body).toContain('value="2026-11-01"');
 expect((await f.post(k,'data-startu',{od:'2026-10-30'})).statusCode).toBe(303);
 expect((await f.post(k,'aktywuj',{probaId,potwierdz:'tak',pobieraj:'nie'})).statusCode).toBe(303);
 const zakresy=f.calls.filter(u=>u.includes('/order/checkout-forms?'));expect(decodeURIComponent(zakresy.at(-1)!)).toContain('2026-10-29T23:00:00.000Z');
 expect(f.repo.pobierz(k).autoryzacja).toBe('polaczone');expect((await f.req('GET',root+'/'+k)).body).toContain('Podłącz kolejne konto Allegro');
});
it('zmiana nazwy po zgodzie nadal unieważnia kandydata',async()=>{
 const f=await setup(),k=await f.draft(),{probaId}=await f.candidate(k);
 expect((await f.post(k,'nazwa',{nazwa:'Półcień nowe'})).statusCode).toBe(303);
 expect((await f.post(k,'aktywuj',{probaId,potwierdz:'tak',pobieraj:'nie'})).statusCode).toBe(409);
});
it('to nie to konto usuwa kandydata i pozwala rozpocząć zgodę ponownie',async()=>{
 const f=await setup(),k=await f.draft(),{probaId}=await f.candidate(k);
 expect((await f.post(k,'anuluj',{probaId})).statusCode).toBe(303);
 expect((await f.post(k,'aktywuj',{probaId,potwierdz:'tak',pobieraj:'nie'})).statusCode).toBe(409);
 expect((await f.post(k,'autoryzacja')).statusCode).toBe(200);
});
it('dwa konta korzystają z tej samej aplikacji i mają różne ID',async()=>{
 const f=await setup();
 for(const id of ['1000001','1000002']){f.setKonto(id);const k=await f.draft(),{probaId}=await f.candidate(k);expect((await f.post(k,'potwierdz',{probaId})).statusCode).toBe(303);expect((await f.post(k,'aktywuj',{probaId,potwierdz:'tak',pobieraj:'nie'})).statusCode).toBe(303);}
 expect(f.repo.lista().map((k:any)=>[k.autoryzacja,k.kontoId])).toEqual([['polaczone','1000001'],['polaczone','1000002']]);
});
it('brak uprawnień daje instrukcję naprawy i odnośnik do kroku 0',async()=>{
 const f=await setup();f.bezProfilu();const k=await f.draft(),{page}=await f.candidate(k);
 expect(page.body).toContain('zaznacz brakujące uprawnienia i połącz konto jeszcze raz');expect(page.body).toContain(root+'/aplikacja?srodowisko=produkcja');
});
it('odrzucenie zgody daje bezpieczny komunikat i ponowny start',async()=>{
 const f=await setup();f.setBlad('access_denied');const k=await f.draft(),{page}=await f.candidate(k);
 expect(page.body).toContain('Zgoda odrzucona w Allegro. Zacznij od nowa.');
});
it('każda akcja formularza opisu modułu ma POST; operator i brak Origin są odrzucane',async()=>{
 const f=await setup(),k=await f.draft();
 for(const krok of modulKanalu('allegro').konfigurator.kroki){if(!krok.formularz)continue;
  const url=root+'/'+krok.formularz.akcja.replace(':kanal',k);
  expect((await f.req('POST',url,{})).statusCode).not.toBe(404);
  expect((await f.req('POST',url,{},'operator')).statusCode).toBe(403);
  expect((await f.req('POST',url,{},'admin','')).statusCode).toBe(403);
 }
 expect((await f.req('GET',root+'/'+k,undefined,'operator')).statusCode).toBe(403);
});
it('potwierdz i anuluj ze starą albo obcą próbą dają 409 z komunikatem i niczego nie zmieniają',async()=>{
 const f=await setup(),k=await f.draft(),{probaId:stara}=await f.candidate(k);
 expect((await f.post(k,'anuluj',{probaId:stara})).statusCode).toBe(303);
 const {probaId:nowa}=await f.candidate(k);expect(nowa).not.toBe(stara);
 for(const akcja of ['potwierdz','anuluj'])for(const probaId of [stara,'obca-proba-polcien']){
  const r=await f.post(k,akcja,{probaId});expect(r.statusCode,akcja+' '+probaId).toBe(409);
  expect(r.body).toContain('Ta próba połączenia jest nieaktualna');
 }
 const strona=await f.req('GET',root+'/'+k);expect(strona.body).toContain('To moje konto — dalej');expect(strona.body).toContain('polcien_test');
 expect(f.repo.pobierz(k).autoryzacja).not.toBe('polaczone');
 expect((await f.post(k,'potwierdz',{probaId:nowa})).statusCode).toBe(303);
});
it('aktywacja kandydata bez „To moje konto — dalej” jest odrzucana',async()=>{
 const f=await setup(),k=await f.draft(),{probaId}=await f.candidate(k);
 const r=await f.post(k,'aktywuj',{probaId,potwierdz:'tak',pobieraj:'nie'});expect(r.statusCode).toBe(409);
 expect(r.body).toContain('To moje konto — dalej');expect(f.repo.pobierz(k).autoryzacja).not.toBe('polaczone');
 expect((await f.post(k,'potwierdz',{probaId})).statusCode).toBe(303);
 expect((await f.post(k,'aktywuj',{probaId,potwierdz:'tak',pobieraj:'nie'})).statusCode).toBe(303);expect(f.repo.pobierz(k).autoryzacja).toBe('polaczone');
});

// PRZ-146.03 (B5–B7, B9): kreator pokazuje tylko bieżący krok; sekcje konta wracają po połączeniu.
const sekcjeKonta=(html:string)=>({odlacz:/action="[^"]*\/odlacz"/.test(html),nazwa:/action="[^"]*\/nazwa"/.test(html),polaczenie:html.includes('<h2>Połączenie</h2>'),przerwij:/action="[^"]*\/przerwij"/.test(html)});
it('B5/B6: kroki 2, 3 i 4 szkicu nie mają sekcji Połączenie, Nazwa i Odłączenie — mają „Przerwij podłączanie”; połączone konto je ma',async()=>{
 const f=await setup(),k=await f.draft();
 const krok2=await f.req('GET',root+'/'+k);expect(krok2.body).toContain('aria-current="step"');expect(krok2.body).toContain('2. Zgoda w Allegro');
 const device=await f.post(k,'autoryzacja');
 const {probaId,page:krok3}=await f.candidate(k);expect(krok3.body).toContain('To moje konto — dalej');
 expect((await f.post(k,'potwierdz',{probaId})).statusCode).toBe(303);
 const krok4=await f.req('GET',root+'/'+k);expect(krok4.body).toContain('4. Data startu');
 for(const [nazwa,r] of [['krok 2',krok2],['krok 2 z kodem',device],['krok 3',krok3],['krok 4',krok4]] as const){
  expect(sekcjeKonta(r.body),nazwa).toEqual({odlacz:false,nazwa:false,polaczenie:false,przerwij:true});
  expect(r.body,nazwa).toContain('Przerwij podłączanie');
 }
 expect((await f.post(k,'aktywuj',{probaId,potwierdz:'tak',pobieraj:'nie'})).statusCode).toBe(303);
 const konto=await f.req('GET',root+'/'+k);
 expect(sekcjeKonta(konto.body)).toEqual({odlacz:true,nazwa:true,polaczenie:true,przerwij:false});
});
it('B5c/d/e: kod w osobnym elemencie z ukrytym przyciskiem Kopiuj, wyjaśnienie w 3 krokach, adres środowiska Sandbox',async()=>{
 const f=await setup();
 const r=await f.post(await f.draft(),'autoryzacja');
 expect(r.body).toMatch(/<code[^>]*>POLCIEN-123<\/code>/);
 expect(r.body).toMatch(/<button[^>]*data-kopiuj="POLCIEN-123"[^>]*hidden|<button[^>]*hidden[^>]*data-kopiuj="POLCIEN-123"/);
 expect(r.body).toContain('1. Kliknij »Otwórz stronę zgody Allegro« — otworzy się w nowej karcie.');
 expect(r.body).toContain('Kliknij po zatwierdzeniu w Allegro. Jeśli zgoda jeszcze nie dotarła, poczekaj kilka sekund i kliknij ponownie.');
 expect(r.body).toContain('zalogowana na allegro.pl. Jeśli');
 const sandbox=f.repo.utworzSzkic({nazwa:'Półcień test',odUtc:'2026-10-31T23:00:00.000Z',srodowisko:'sandbox'},{id:1,login:'admin'}).dane as {klucz:string};
 const s=await f.req('GET',root+'/'+sandbox.klucz);
 expect(s.body).toContain('allegro.pl.allegrosandbox.pl');expect(s.body).not.toContain('zalogowana na allegro.pl. Jeśli');
});
it('B5b: „← Wróć do kroku 1” tylko na szkicu z autoryzacja=brak; zapis z kroku 1 zastępuje szkic',async()=>{
 const f=await setup(),k=await f.draft();
 const krok2=await f.req('GET',root+'/'+k);
 expect(krok2.body).toContain('href="'+root+'/'+k+'/krok-1"');expect(krok2.body).toContain('← Wróć do kroku 1');
 const krok1=await f.req('GET',root+'/'+k+'/krok-1');expect(krok1.statusCode).toBe(200);
 expect(krok1.body).toContain('value="Pracownia Półcień"');expect(krok1.body).toMatch(/value="produkcja" selected/);
 const formularzId=krok1.body.match(/name="formularzId" value="([^"]+)"/)![1];
 const akcja=krok1.body.match(/action="([^"]*\/szkice[^"]*)"/)![1].replaceAll('&amp;','&');
 const nowy=await f.req('POST',akcja,{formularzId,nazwa:'Pracownia Półcień test',od:'2026-11-01',srodowisko:'sandbox'});
 expect(nowy.statusCode).toBe(303);const k2=nowy.headers.location!.split('/').pop()!;
 expect(k2).not.toBe(k);expect(f.repo.pobierz(k)).toBeNull();
 expect(f.repo.pobierz(k2)).toMatchObject({nazwa:'Pracownia Półcień test',srodowisko:'sandbox',autoryzacja:'brak'});
 // Po starcie zgody (autoryzacja ≠ brak) powrotu już nie ma.
 const k3=await f.draft();const z=await f.post(k3,'autoryzacja');
 expect(f.repo.pobierz(k3).autoryzacja).not.toBe('brak');expect(z.body).not.toContain('Wróć do kroku 1');expect(z.body).not.toContain('/krok-1"');
 expect((await f.req('GET',root+'/'+k3+'/krok-1')).statusCode).toBe(303);expect(f.repo.pobierz(k3)).not.toBeNull();
});
it('Przerwij podłączanie usuwa szkic; odmawia przy połączonym koncie i przy zamówieniach w bazie',async()=>{
 const f=await setup(),k=await f.draft();await f.candidate(k);
 const r=await f.post(k,'przerwij',{potwierdz:'tak'});expect(r.statusCode).toBe(303);expect(r.headers.location).toBe('/ustawienia/integracje');
 expect(f.repo.pobierz(k)).toBeNull();
 const z=await f.draft();db.prepare("INSERT INTO zamowienia(sklep,zrodlo_id,numer,kwota_brutto,utworzone_at) VALUES (?,1,'PC-1','10.00','2026-11-02')").run(z);
 const odmowa=await f.post(z,'przerwij',{potwierdz:'tak'});expect(odmowa.statusCode).toBe(409);expect(f.repo.pobierz(z)).not.toBeNull();
 const p=await f.draft(),{probaId}=await f.candidate(p);
 expect((await f.post(p,'potwierdz',{probaId})).statusCode).toBe(303);expect((await f.post(p,'aktywuj',{probaId,potwierdz:'tak',pobieraj:'nie'})).statusCode).toBe(303);
 const polaczone=await f.post(p,'przerwij',{potwierdz:'tak'});expect(polaczone.statusCode).toBe(409);expect(f.repo.pobierz(p).autoryzacja).toBe('polaczone');
 // konto kiedyś połączone, odłączone i w trakcie ponownej zgody: kontoId zostaje, więc przerwanie odmawia
 expect((await f.post(p,'odlacz',{potwierdz:'tak'})).statusCode).toBe(303);await f.post(p,'autoryzacja');
 expect(f.repo.pobierz(p).autoryzacja).toBe('oczekuje_potwierdzenia');expect(f.repo.pobierz(p).kontoId).toBeTruthy();
 const ponowna=await f.post(p,'przerwij',{potwierdz:'tak'});expect(ponowna.statusCode).toBe(409);expect(f.repo.pobierz(p)).not.toBeNull();
});
it('B7: krok 4 bez pola wyboru, z ukrytym potwierdz=tak i zdaniem o koncie; POST /aktywuj bez potwierdz nadal odmawia',async()=>{
 const f=await setup(),k=await f.draft(),{probaId}=await f.candidate(k);
 expect((await f.post(k,'potwierdz',{probaId})).statusCode).toBe(303);
 const krok4=(await f.req('GET',root+'/'+k)).body;
 const form=krok4.match(/<form method="post" action="[^"]*\/aktywuj">[\s\S]*?<\/form>/)![0];
 expect(form).not.toContain('type="checkbox"');expect(form).toMatch(/<input type="hidden" name="potwierdz" value="tak">/);
 expect(form).toContain('Podłączasz konto Allegro <strong>polcien_test</strong> (ID 1000001), środowisko sprzedażowe.');
 expect(form).toContain('Pozostaw wyłączone — konto zostanie podłączone, pobieranie włączysz później na ekranie konta.');
 expect(form).toMatch(/<button class="btn btn--glowny" type="submit">Podłącz konto<\/button>/);
 const bez=await f.post(k,'aktywuj',{probaId,pobieraj:'nie'});expect(bez.statusCode).toBe(400);expect(f.repo.pobierz(k).autoryzacja).not.toBe('polaczone');
 expect((await f.post(k,'aktywuj',{probaId,potwierdz:'tak',pobieraj:'nie'})).statusCode).toBe(303);
});
it('B9: odłączenie konta ma klasę przycisku niebezpiecznego z Ustawień, nie btn--cichy',async()=>{
 const f=await setup(),k=await f.draft(),{probaId}=await f.candidate(k);
 await f.post(k,'potwierdz',{probaId});await f.post(k,'aktywuj',{probaId,potwierdz:'tak',pobieraj:'nie'});
 const html=(await f.req('GET',root+'/'+k)).body;
 const form=html.match(/<form method="post" action="[^"]*\/odlacz">[\s\S]*?<\/form>/)![0];
 expect(form).toMatch(/<button class="ust-przycisk grozny"[^>]*>Odłącz konto<\/button>/);expect(form).not.toContain('btn--cichy');
 expect(form).toMatch(/name="potwierdz" value="tak" required/);
});

// PRZ-148.06: drobne uwagi z recenzji PRZ-146.
it('PRZ-148.06 (2): stary link kroku 1 nie zastępuje szkicu zmienionego w międzyczasie (wersja w adresie)',async()=>{
 const f=await setup(),k=await f.draft();
 const krok1=await f.req('GET',root+'/'+k+'/krok-1');
 const formularzId=krok1.body.match(/name="formularzId" value="([^"]+)"/)![1];
 const akcja=krok1.body.match(/action="([^"]*\/szkice[^"]*)"/)![1].replaceAll('&amp;','&');
 expect(akcja).toContain('zastap='+k);expect(akcja).toMatch(/[?&]wersja=1(&|$)/);
 expect((await f.post(k,'nazwa',{nazwa:'Półcień nowsza nazwa'})).statusCode).toBe(303);expect(f.repo.pobierz(k).wersja).toBeGreaterThan(1);
 const nowy=await f.req('POST',akcja,{formularzId,nazwa:'Pracownia Półcień test',od:'2026-11-01',srodowisko:'produkcja'});
 expect(nowy.statusCode).toBe(303);
 expect(f.repo.pobierz(k)).toMatchObject({nazwa:'Półcień nowsza nazwa'});
});
it.each([['2026-10-15T22:00:00.000Z','2026-10-16'],['2025-06-01T00:00:00.000Z','2026-11-01'],['2026-12-24T23:00:00.000Z','2026-11-01'],['zepsute','2026-11-01']])('PRZ-148.06 (6): krok 1 pokazuje datę szkicu %s tylko z okna 12 miesięcy → %s',async(odUtc,widac)=>{
 const f=await setup(),k=await f.draft();
 db.prepare('UPDATE kanaly_sprzedazy SET od_utc=? WHERE klucz=?').run(odUtc,k);
 const krok1=await f.req('GET',root+'/'+k+'/krok-1');expect(krok1.statusCode).toBe(200);
 expect(krok1.body).toMatch(new RegExp('type="date" value="'+widac+'"'));
});
it('PRZ-148.06 (8): domyślne środowisko w kroku 0 i 1 to to, w którym jest aplikacja',async()=>{
 const f=await setup(false);
 expect((await f.req('GET',root+'/nowe')).body).toMatch(/value="produkcja" selected/);
 expect((await f.req('GET',root+'/aplikacja')).body).toMatch(/value="produkcja" selected/);
 expect((await f.req('POST',root+'/aplikacja-urzadzenia',{srodowisko:'sandbox',clientId:'polcien-id',clientSecret:'SECRET-POLCIEN'})).statusCode).toBe(200);
 const nowe=(await f.req('GET',root+'/nowe')).body;expect(nowe).toMatch(/value="sandbox" selected/);expect(nowe).not.toMatch(/value="produkcja" selected/);
 const app=await f.req('GET',root+'/aplikacja');expect(app.statusCode).toBe(200);expect(app.body).toMatch(/value="sandbox" selected/);
 expect((await f.req('GET',root+'/aplikacja?srodowisko=cos')).statusCode).toBe(400);
});
it('PRZ-148.06 (3): ostrzeżenie o braku aplikacji stoi w formularzu kroku 1 nad przyciskiem „Dalej”',async()=>{
 const f=await setup();
 const html=(await f.req('GET',root+'/nowe')).body;
 const form=html.match(/<form method="post" action="[^"]*\/szkice[^"]*">[\s\S]*?<\/form>/)![0];
 const uwaga=form.indexOf('data-bez-aplikacji="sandbox"'),przycisk=form.indexOf('<button class="btn btn--glowny"');
 expect(uwaga).toBeGreaterThan(-1);expect(uwaga).toBeLessThan(przycisk);
 expect(form).toMatch(/<p class="ust-uwaga" data-bez-aplikacji="sandbox" hidden role="status">/);});
it('PRZ-148.06 (5): przycisk „Podłącz konto” w karcie kroku 4',async()=>{
 const f=await setup(),k=await f.draft(),{probaId}=await f.candidate(k);
 expect((await f.post(k,'potwierdz',{probaId})).statusCode).toBe(303);
 const html=(await f.req('GET',root+'/'+k)).body;
 expect(html).toMatch(/<section class="ust-sekcja">\s*<h2>4\. Data startu<\/h2>(?:(?!<\/section>)[\s\S])*action="[^"]*\/aktywuj"(?:(?!<\/section>)[\s\S])*Podłącz konto<\/button>\s*<\/form>\s*<\/section>/);
});
it('PRZ-149.03 (C2): krok 1 z aplikacją ma zdanie o kolejnych kontach raz, krok 0 go nie ma',async()=>{
 const zdanie='Aplikację zakładasz raz na środowisko — kolejne konta podłączasz od kroku 1. W kroku 2 zaloguj się na to konto, które chcesz podłączyć (najlepiej w oknie prywatnym).';
 const z=await setup();
 expect(((await z.req('GET',root+'/nowe')).body.split(zdanie).length-1)).toBe(1);
 const b=await setup(false);
 const krok0=(await b.req('GET',root+'/nowe')).body;
 expect(krok0).toContain('Najpierw załóż aplikację Allegro (krok 0).');
 expect(krok0).not.toContain('kolejne konta podłączasz');
});
