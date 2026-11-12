import {afterEach,expect,it,vi} from 'vitest';
import {zbudujAplikacje,type Aplikacja} from '../../../src/core/aplikacja.ts';
import {openOmsDb} from '../../../src/oms/db/db.ts';
import {modulyPiaskownicy} from '../../../deploy/proba/atrapy/index.mjs';
import {createModulKanaly} from '../../../src/moduly/kanaly/modul.ts';
import {zalozKonto} from '../../../src/core/bezpieczenstwo/konta.js';
import {podpisz} from '../../../src/core/bezpieczenstwo/sesja.js';
import {wczytajSekret} from '../../../src/core/bezpieczenstwo/sekret-sesji.js';
import {konfiguracjaKanalow} from '../../../src/moduly/kanaly/konfiguracja.ts';
import type {ModulOms} from '../../../src/core/kontrakty.ts';
import {transportErliPiaskownicy} from '../../../deploy/proba/atrapy/erli.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// Katalog roboczy w os.tmpdir(), nie na jednej maszynie (CI kopii publicznej 12.11.2026).
const KATALOG_TESTU=fs.mkdtempSync(path.join(os.tmpdir(),'erli-kreator-trasy-'));
const root='/ustawienia/integracje/erli',produkcja='https://erli.pl/svc/shop-api',sandbox='https://sandbox.erli.dev/svc/shop-api';
const sekret='fixture-polcien-klucz-api';
let a:Aplikacja,db:ReturnType<typeof openOmsDb>;
afterEach(async()=>{vi.restoreAllMocks();await a?.app.close();db?.close();});
async function setup(zPliku=false,zAtrapa=false,admin=true){
 const env={OMS_TRYB:'proba',OMS_KANALY:'[]',OMS_USER:'serwis',OMS_PASS:'fixture',OMS_SPRZEDAWCA_NIP:'1234563218',OMS_RACHUNEK:'34109010140000000000000000',OMS_PROFORMY_KATALOG:path.join(KATALOG_TESTU,'proformy'),OMS_ETYKIETY_KATALOG:path.join(KATALOG_TESTU,'etykiety')};
 const definicje=zPliku?[{klucz:'z-pliku',typ:'erli' as const,prefiks:'POLCIEN',etykieta:'Pracownia Półcień'}]:[];
 const stan={odmowa:false,status:401};const calls:string[]=[];
 const m=createModulKanaly(definicje,false,{fetchImpl:async(u,i)=>{calls.push(String(u));if(zAtrapa)return transportErliPiaskownicy({baza:()=>db,env,log:()=>{}})(u,i);return stan.odmowa?Response.json({message:sekret+' odpowiedz-prywatna'},{status:stan.status}):Response.json({id:1000001,name:'Pracownia Półcień'});}});
 const config=konfiguracjaKanalow(definicje,zPliku?{...env,POLCIEN_KLUCZ_API:sekret,POLCIEN_ADRES_API:produkcja,POLCIEN_OD:'2026-11-01'}:env);
 db=openOmsDb();a=await zbudujAplikacje({db,moduly:modulyPiaskownicy(env).map(x=>x.nazwa==='kanaly'?{...m,konfiguracja:()=>config}:x) as ModulOms[],env,teraz:()=>new Date('2026-11-11T12:00:00Z'),log:()=>{}});
 zalozKonto(db,{login:'admin',imie:'Administrator',haslo:'fixture',rola:'administrator',admin});
 const cookie='sesja_oms_proba='+podpisz('admin',wczytajSekret(db),Date.now());
 const panel=(method:'GET'|'POST',url:string,payload?:Record<string,unknown>)=>a.app.inject({method,url,payload,headers:{accept:'text/html',cookie,origin:'http://localhost'}});
 const req=(method:'GET'|'POST',path:string,payload?:Record<string,unknown>)=>panel(method,root+path,payload);
 const row=()=>db.prepare("SELECT * FROM kanaly_sprzedazy WHERE typ='erli' ORDER BY rowid").get()!;
 async function szkic(adresApi=produkcja,kluczApi=sekret){const r=await req('POST','/nowe/dane',{nazwa:'Pracownia Półcień',adresApi,kluczApi,domyslnyCzasWysylki:'3',wersja:0});expect(r.statusCode).toBe(303);return String(r.headers.location).slice(root.length).split('?')[0];}
 const post=(p:string,op:string,d:Record<string,unknown>={})=>req('POST',p+'/'+op,{wersja:row().wersja,...d});
 return {req,panel,szkic,row,post,stan,calls};
}
async function doDatyStartu(f:Awaited<ReturnType<typeof setup>>,p:string){
 expect((await f.post(p,'sprawdz')).statusCode).toBe(200);
 expect((await f.post(p,'pobierz-metody')).statusCode).toBe(303);
 expect((await f.post(p,'metody')).statusCode).toBe(303);
 expect((await f.post(p,'nadawanie',{punktNadania:'1',waga:'1',dlugosc:'30',szerokosc:'20',wysokosc:'10'})).statusCode).toBe(303);
}
it('zapis nowego klucza sprawdza /me, przekierowuje z kodem ok i zwija dane',async()=>{
 const f=await setup();
 const nowy=await f.req('POST','/nowe/dane',{nazwa:'Pracownia Półcień',adresApi:produkcja,kluczApi:sekret,wersja:0});
 const p='/'+f.row().klucz;
 expect(nowy.statusCode).toBe(303);expect(nowy.headers.location).toBe(root+p+'?polaczenie=ok');
 expect(f.calls).toEqual([produkcja+'/me']);
 const sklep=a.usluga<any>('kanaly','sklepyErli').pobierz(f.row().klucz);
 expect(sklep.ustawienia.sprawdzono).toBe(true);
 const zapis=await f.post(p,'dane',{nazwa:'Pracownia Półcień',adresApi:produkcja,kluczApi:''});
 expect(zapis.statusCode).toBe(303);expect(zapis.headers.location).toBe(root+p+'?polaczenie=ok');
 expect(f.calls).toEqual([produkcja+'/me',produkcja+'/me']);
 const r=await f.req('GET',String(zapis.headers.location).slice(root.length));
 expect(r.body).toContain('class="pas-potwierdzenie" role="status"');
 expect(r.body).toContain('Połączenie z ERLI działa — sklep Pracownia Półcień (id 1000001).');
 const details=[...r.body.matchAll(/<details\b[^>]*>[\s\S]*?<\/details>/g)].map(m=>m[0]).find(d=>d.includes('id="erli-klucz"'));
 expect(details).toContain('<summary>1. Nazwa, środowisko, klucz — Pracownia Półcień, produkcja, klucz zapisany</summary>');
 expect(details).toContain('id="erli-klucz"');expect(details?.match(/<details\b[^>]*>/)?.[0]).not.toContain('open');
 expect(r.body).not.toContain('id="erli-polaczenie"');
});
it('401 po zapisaniu nowego sklepu zachowuje dane i klucz, pokazuje błąd i rozwinięty formularz',async()=>{
 const f=await setup();f.stan.odmowa=true;
 const r=await f.req('POST','/nowe/dane',{nazwa:'Pracownia Półcień',adresApi:produkcja,kluczApi:sekret,wersja:0});
 expect(r.statusCode).toBe(303);expect(r.headers.location).toBe(root+'/'+f.row().klucz+'?polaczenie=blad');
 expect(f.row().nazwa).toBe('Pracownia Półcień');expect(f.calls).toEqual([produkcja+'/me']);
 const zapis=db.prepare("SELECT * FROM konfiguracja_integracji WHERE integracja LIKE 'erli:%'").get()!;
 expect(JSON.parse(String(zapis.sekrety_json))).toEqual({kluczApi:sekret});
 expect(JSON.parse(String(zapis.ustawienia_json)).sprawdzono).toBe(false);
 const ekran=await f.req('GET',String(r.headers.location).slice(root.length));
 expect(ekran.body).toContain('class="pas-blad" role="alert"');
 expect(ekran.body).toContain('Klucz zapisany, ale połączenie z ERLI nie działa. Sprawdź klucz i środowisko.');
 // PRZ-157.12u: rozwinięty jest krok 2 (błąd połączenia); formularz klucza czeka w zwiniętym kroku 1 z odnośnikiem.
 expect(ekran.body).toContain('id="erli-klucz"');expect(ekran.body).toContain('id="erli-polaczenie"');
 expect(ekran.body).toMatch(/<details class="erli-krok" id="erli-krok-dane"[^>]*>[\s\S]*?id="erli-klucz"[\s\S]*?<\/details>/);
 expect(ekran.body).toContain('href="#erli-krok-dane"');
 expect(ekran.body).not.toContain(sekret);expect(ekran.body).not.toContain('odpowiedz-prywatna');
});
it('wyjątek operacji sprawdz po zapisie nie cofa danych i przekierowuje z kodem blad',async()=>{
 const f=await setup(),s=a.usluga<any>('kanaly','sklepyErli'),oryginal=s.operacja.bind(s);
 vi.spyOn(s,'operacja').mockImplementation(async(...args:unknown[])=>{if(args[1]==='sprawdz')throw new Error('fixture');return oryginal(...args);});
 const zapis=await f.req('POST','/nowe/dane',{nazwa:'Pracownia Półcień',adresApi:produkcja,kluczApi:sekret,wersja:0});
 expect(zapis.statusCode).toBe(303);expect(zapis.headers.location).toBe(root+'/'+f.row().klucz+'?polaczenie=blad');
 const r=await f.req('GET',String(zapis.headers.location).slice(root.length));
 expect(f.row().nazwa).toBe('Pracownia Półcień');expect(r.body).toContain('Klucz zapisany, ale połączenie');
 expect(r.body).not.toContain('class="pas-potwierdzenie"');
});
// PRZ-157.12u: kreator pokazuje zrobione kroki zwinięte i tylko bieżący rozwinięty; przyszłe są wyłącznie w pasku.
it('nowy sklep pokazuje zrobione kroki i bieżący, a pasek wymienia wszystkie kroki',async()=>{
 const f=await setup(false,true),p=await f.szkic(sandbox,'atrapa-polcien');
 const sprawdzSekcje=async(widoczne:string[])=>{
  const r=await f.req('GET',p);expect(r.statusCode).toBe(200);
  expect([...r.body.matchAll(/<h2 id="erli-([^"]+)"/g)].map(m=>m[1])).toEqual(widoczne);
  const pasek=r.body.match(/<ol class="stepper"[\s\S]*?<\/ol>/)?.[0];
  for(const tytul of ['Nazwa, środowisko, klucz','Sprawdź połączenie','Metody dostawy','Nadawanie Przesyłek Erli','Start'])expect(pasek).toContain(tytul);
 };
 await sprawdzSekcje(['dane','metody']);
 await f.post(p,'sprawdz');await sprawdzSekcje(['dane','metody']);
 await f.post(p,'pobierz-metody');await sprawdzSekcje(['dane','metody']);
 await f.post(p,'metody');await sprawdzSekcje(['dane','metody','nadawanie']);
 await f.post(p,'nadawanie',{punktNadania:'1',waga:'1',dlugosc:'30',szerokosc:'20',wysokosc:'10'});
 await sprawdzSekcje(['dane','metody','nadawanie','start']);
 expect((await f.req('GET',p)).body).toMatch(/<button[^>]*>Aktywuj<\/button>/);
});
it.each([false,true])('aktywny sklep lub konfiguracja env (%s) pokazuje stan i zwinięte sekcje bez kroków',async zPliku=>{
 const f=await setup(zPliku);let p='/z-pliku';
 if(!zPliku){p=await f.szkic();await f.post(p,'sprawdz');expect((await f.post(p,'aktywuj')).statusCode).toBe(303);expect(f.row().autoryzacja).toBe('polaczone');}
 const r=await f.req('GET',p);expect(r.statusCode).toBe(200);
 expect([...r.body.matchAll(/<h2 id="erli-([^"]+)"/g)].map(m=>m[1])).toEqual(['stan','dane','metody','nadawanie']);
 expect(r.body).not.toContain('class="stepper"');
});
it.each(['GET','POST'] as const)('konto bez admin dostaje 403 na %s konfiguratora bez zapisu w bazie',async method=>{
 const f=await setup(false,false,false);
 const przed=db.prepare("SELECT COUNT(*) AS n FROM kanaly_sprzedazy WHERE typ='erli'").get()!.n;
 const r=await f.req(method,method==='GET'?'/nowe':'/nowe/dane',method==='GET'?undefined:{nazwa:'Pracownia Półcień',adresApi:produkcja,kluczApi:sekret,wersja:0});
 expect(db.prepare("SELECT COUNT(*) AS n FROM kanaly_sprzedazy WHERE typ='erli'").get()!.n).toBe(przed);
 expect(r.statusCode).toBe(403);expect(f.calls).toEqual([]);
});
it.each(['2001-01-01','2025-11-10','2026-11-12','2026-02-30'])('odrzuca datę startu %s bez zmiany zapisów',async od=>{
 const f=await setup(),p=await f.szkic();
 const przed={kanaly:db.prepare('SELECT * FROM kanaly_sprzedazy').all(),audit:db.prepare('SELECT * FROM kanaly_audit').all()};
 const r=await f.post(p,'data-startu',{od});
 expect(r.statusCode).toBe(400);expect(r.body).toContain('Podaj poprawną datę startu');
 expect({kanaly:db.prepare('SELECT * FROM kanaly_sprzedazy').all(),audit:db.prepare('SELECT * FROM kanaly_audit').all()}).toEqual(przed);
});
it.each(['2025-11-11','2026-11-11'])('przyjmuje graniczną datę startu %s i pokazuje zakres w polu daty',async od=>{
 const f=await setup(false,true),p=await f.szkic(sandbox,'atrapa-polcien');await doDatyStartu(f,p);
 const r=await f.req('GET',p),pole=r.body.match(/<input\b[^>]*id="erli-od"[^>]*>/)?.[0];
 expect(r.statusCode).toBe(200);expect(pole).toContain('min="2025-11-11"');expect(pole).toContain('max="2026-11-11"');
 expect((await f.post(p,'data-startu',{od})).statusCode).toBe(303);
 expect(new Intl.DateTimeFormat('sv-SE',{timeZone:'Europe/Warsaw'}).format(new Date(String(f.row().od_utc)))).toBe(od);
});
it('katalog i Moje połączenia pokazują logo ERLI (Adam 11.11: „tak, wstaw logo erli”) i nie pokazują sekretu',async()=>{
 const f=await setup(),p=await f.szkic();await f.post(p,'sprawdz');
 const katalog=await f.panel('GET','/ustawienia/integracje/katalog');
 expect(katalog.statusCode).toBe(200);expect(katalog.body).toContain(root+'/nowe');
 expect(katalog.body).toContain('/integracje/erli.png');
 const lista=await f.panel('GET','/ustawienia/integracje');
 expect(lista.statusCode).toBe(200);expect(lista.body).toContain(root+p);
 expect(lista.body).toContain('Pracownia Półcień');expect(lista.body).toContain('id 1000001');
 expect(lista.body).toContain('/integracje/erli.png');
 expect(lista.body+katalog.body).not.toContain(sekret);
});
it('zapisuje sekret wyłącznie w sekrety_json; HTML i nagłówki nie zawierają klucza',async()=>{
 const f=await setup(),p=await f.szkic(),r=await f.req('GET',p);
 expect(r.statusCode).toBe(200);expect(r.body).toContain('zapisany');expect(r.body+JSON.stringify(r.headers)).not.toContain(sekret);
 expect(r.body).toMatch(/type="password"/);expect(r.body).not.toMatch(/name="kluczApi"[^>]*value=/);
 const zapis=db.prepare("SELECT * FROM konfiguracja_integracji WHERE integracja LIKE 'erli:%'").get()!;
 expect(JSON.parse(String(zapis.sekrety_json))).toEqual({kluczApi:sekret});expect(String(zapis.ustawienia_json)).not.toContain(sekret);
 expect(JSON.stringify(db.prepare('SELECT * FROM kanaly_audit').all())).not.toContain(sekret);
});
it('połączenie: 401 bez odpowiedzi serwera, poprawne /me pokazuje nazwę i id',async()=>{
 const f=await setup(),p=await f.szkic();f.stan.odmowa=true;
 let r=await f.post(p,'sprawdz');expect(r.statusCode).toBe(400);expect(r.body).toContain('Nieprawidłowy klucz API');expect(r.body).not.toContain('odpowiedz-prywatna');expect(r.body).not.toContain(sekret);
 f.stan.odmowa=false;r=await f.post(p,'sprawdz');expect(r.statusCode).toBe(200);expect(r.body).toContain('Sklep ERLI: Pracownia Półcień (id 1000001)');expect(f.calls.every(x=>x===produkcja+'/me')).toBe(true);
});
it.each([produkcja,sandbox])('pierwsza aktywacja %s, data zamrożona, wstrzymanie i odłączenie',async adres=>{
 const f=await setup(false,true),p=await f.szkic(adres,'atrapa-polcien');await doDatyStartu(f,p);
 expect((await f.post(p,'data-startu',{od:'2026-11-01'})).statusCode).toBe(303);
 expect((await f.post(p,'aktywuj')).statusCode).toBe(303);
 const przed=await f.req('GET',p);expect(/name="tylkoOdczyt"[^>]*checked/.test(przed.body)).toBe(adres===produkcja);
 const rejestr=a.usluga<any>('kanaly','rejestrKanalow');expect(rejestr.wolnoZapisywac(String(f.row().klucz))).toBe(adres!==produkcja);
 expect((await f.post(p,'data-startu',{od:'2026-11-02'})).statusCode).toBe(409);
 expect((await f.post(p,'pobieranie',{wlaczone:'nie'})).statusCode).toBe(303);expect(f.row().pobieranie).toBe('wylaczone');
 expect((await f.post(p,'odlacz',{potwierdz:'tak'})).statusCode).toBe(303);expect(f.row().autoryzacja).toBe('odlaczone');
 expect(String(db.prepare("SELECT sekrety_json FROM konfiguracja_integracji WHERE integracja LIKE 'erli:%'").get()?.sekrety_json??'')).not.toContain(sekret);
});
it('kolizja id wstrzymuje oba kanały ERLI',async()=>{
 const f=await setup(),p=await f.szkic();await f.post(p,'sprawdz');await f.post(p,'aktywuj');
 const q=await f.szkic();const k=db.prepare("SELECT * FROM kanaly_sprzedazy WHERE klucz<>?").get(f.row().klucz)!;
 const r=await f.req('POST',q+'/sprawdz',{wersja:k.wersja});expect(r.statusCode).toBe(409);expect(r.body).toContain('Ten sklep ERLI jest już');
 expect(db.prepare("SELECT pobieranie FROM kanaly_sprzedazy WHERE typ='erli'").all().every(x=>x.pobieranie==='wylaczone')).toBe(true);
 expect((await f.post(p,'aktywuj')).statusCode).toBe(409);
 const wersja=db.prepare('SELECT wersja FROM kanaly_sprzedazy WHERE klucz=?').get(q.slice(1))!.wersja;
 expect((await f.req('POST',q+'/odlacz',{wersja,potwierdz:'tak'})).statusCode).toBe(303);
 expect((await f.post(p,'sprawdz')).statusCode).toBe(200);expect((await f.post(p,'aktywuj')).statusCode).toBe(303);
});
it('tryb tylko odczyt blokuje rzeczywisty transport statusów, dopuszcza odczyty pollera i zmienia się bez restartu',async()=>{
 const f=await setup(),p=await f.szkic();await f.post(p,'sprawdz');await f.post(p,'aktywuj');
 const rej=a.usluga<any>('kanaly','rejestrKanalow'),klucz=String(f.row().klucz),klient=rej.klient(klucz);
 await klient.szukajZamowien({});await klient.oznaczPrzeczytane({lastMessageId:'000000000000000000000001'});
 const przed=f.calls.length;await expect(klient.ustawStatusSprzedawcy('PC-ERLI-0001','sent')).rejects.toThrow('tylko odczyt');expect(f.calls).toHaveLength(przed);
 expect((await f.post(p,'odczyt',{decyzjaOdczytu:'1'})).statusCode).toBe(303);expect(rej.wolnoZapisywac(klucz)).toBe(true);
 await rej.klient(klucz).ustawStatusSprzedawcy('PC-ERLI-0001','sent');expect(f.calls).toHaveLength(przed+1);
 await f.post(p,'pobieranie',{wlaczone:'nie'});await expect(rej.przebiegZamowien()).resolves.toBeUndefined();expect(f.calls).toHaveLength(przed+1);
});
it('konfigurator rozmawia z atrapą: produkcja wymaga sandboxa lub klucza atrapy, dobry /me i import bez sieci',async()=>{
 const f=await setup(false,true),p=await f.szkic();
 const odmowa=await f.post(p,'sprawdz');
 expect(odmowa.body).toContain('Piaskownica nie łączy się z prawdziwym ERLI — wybierz środowisko sandbox albo klucz atrapy atrapa-polcien.');
 expect(odmowa.body).not.toContain(sekret);
 expect((await f.post(p,'dane',{nazwa:'Pracownia Półcień',adresApi:produkcja,kluczApi:'atrapa-polcien',domyslnyCzasWysylki:'3'})).statusCode).toBe(303);
 const r=await f.post(p,'sprawdz');expect(r.statusCode).toBe(200);expect(r.body).toContain('id 1000001');
 await f.post(p,'aktywuj');await expect(a.usluga<any>('kanaly','rejestrKanalow').przebiegZamowien()).resolves.toBeUndefined();
 expect(db.prepare('SELECT COUNT(*) AS n FROM zamowienia WHERE sklep=?').get(f.row().klucz)?.n).toBeGreaterThan(0);
});
it('formularz nazywa środowisko ERLI — sandbox bez wzmianki o BOK',async()=>{
 const f=await setup(),r=await f.req('GET','/nowe');
 expect(r.body).toContain('ERLI — sandbox');expect(r.body).not.toContain('BOK');
});
it('dowolna odpowiedź 403 z sieci pozostaje ukryta, także gdy zawiera klucz',async()=>{
 const f=await setup(),p=await f.szkic(sandbox);f.stan.odmowa=true;f.stan.status=403;
 const r=await f.post(p,'sprawdz');
 expect(r.body).toContain('Nie udało się sprawdzić połączenia ERLI.');
 expect(r.body).not.toContain(sekret);expect(r.body).not.toContain('odpowiedz-prywatna');
 expect(r.body).not.toContain('Piaskownica nie łączy się');
});
it('blokada produkcji jest czytelna także podczas pobierania metod dostawy',async()=>{
 const f=await setup(false,true),p=await f.szkic(produkcja,'atrapa-polcien');await f.post(p,'sprawdz');
 db.prepare('UPDATE konfiguracja_integracji SET sekrety_json=? WHERE integracja=?').run(JSON.stringify({kluczApi:sekret}),'erli:'+f.row().klucz);
 const r=await f.post(p,'pobierz-metody');
 expect(r.statusCode).toBe(400);expect(r.body).toContain('Piaskownica nie łączy się z prawdziwym ERLI');
 expect(r.body).not.toContain(sekret);
});
it('env ma pierwszeństwo: zapis odrzucony 409',async()=>{const f=await setup(true);expect((await f.req('GET','/z-pliku')).statusCode).toBe(200);expect((await f.req('POST','/z-pliku/dane',{wersja:0,nazwa:'Zmiana',kluczApi:sekret})).statusCode).toBe(409);});
it('odmawia tożsamości sklepu, gdy /me odbija klucz w id',async()=>{
 const f=await setup(),kluczApi='1000001',p=await f.szkic(produkcja,kluczApi);
 const r=await f.post(p,'sprawdz');
 expect(r.statusCode).toBe(400);expect(r.body).toContain('niepoprawną tożsamość sklepu');
 expect(r.body).not.toContain(kluczApi);
 expect((await f.post(p,'aktywuj')).statusCode).toBe(409);
});
it('formularz pozwala świadomie wyłączyć tylko odczyt, a zmiana klucza automatycznie sprawdza nowe połączenie',async()=>{
 const f=await setup(),p=await f.szkic();await f.post(p,'sprawdz');
 expect((await f.post(p,'aktywuj',{decyzjaOdczytu:'1'})).statusCode).toBe(303);
 const rej=a.usluga<any>('kanaly','rejestrKanalow'),klucz=String(f.row().klucz);
 expect(rej.wolnoZapisywac(klucz)).toBe(true);
 const staryKlient=rej.klient(klucz),przed=f.calls.length;
 expect((await f.post(p,'dane',{nazwa:'Pracownia Półcień',adresApi:produkcja,kluczApi:sekret+'-nowy',domyslnyCzasWysylki:'5'})).statusCode).toBe(303);
 expect(f.row().pobieranie).toBe('wylaczone');expect(rej.wolnoZapisywac(klucz)).toBe(false);
 await expect(staryKlient.szukajZamowien({})).rejects.toThrow();expect(f.calls).toHaveLength(przed+1);
 expect((await f.post(p,'aktywuj')).statusCode).toBe(303);
 expect((await f.req('GET',p)).body).toContain('value="5"');
 expect((await f.post(p,'data-startu',{od:'2026-11-02'})).statusCode).toBe(409);
});
it.each(['https://obcy.example','https://sub.erli.pl/svc/shop-api','http://erli.pl/svc/shop-api','https://erli.pl/svc/shop-api/obce'])('odmawia adresu %s w panelu i env',async adresApi=>{
 const f=await setup();expect((await f.req('POST','/nowe/dane',{nazwa:'Pracownia Półcień',adresApi,kluczApi:sekret,wersja:0})).statusCode).toBe(400);expect(f.calls).toEqual([]);
 expect(()=>konfiguracjaKanalow([{klucz:'polcien',typ:'erli',prefiks:'POLCIEN'}],{POLCIEN_KLUCZ_API:sekret,POLCIEN_ADRES_API:adresApi,POLCIEN_OD:'2026-11-01'})).toThrow();
});
it('szkic pokazuje formularz „Usuń sklep” z potwierdzeniem, sklep z pliku go nie ma',async()=>{
 const f=await setup(),p=await f.szkic();
 const r=await f.req('GET',p);expect(r.statusCode).toBe(200);
 const form=r.body.match(/<form[^>]*action="[^"]*\/usun"[\s\S]*?<\/form>/)?.[0];
 expect(form).toContain('name="potwierdz" value="tak" required');expect(form).toContain('Usuń sklep');
 expect((await f.req('GET','/z-pliku')).body).not.toContain('/usun"');
});
it('kolizja przy zapisie danych pokazuje komunikat kolizji na obu sklepach, nie radę o kluczu',async()=>{
 const f=await setup(),p=await f.szkic();await f.post(p,'aktywuj');
 const r=await f.req('POST','/nowe/dane',{nazwa:'Druga',adresApi:produkcja,kluczApi:sekret,wersja:0});
 expect(r.statusCode).toBe(303);expect(String(r.headers.location)).toMatch(/\?polaczenie=blad$/);
 for(const adres of [String(r.headers.location).slice(root.length),p]){
  const g=(await f.req('GET',adres)).body;
  expect(g).toContain('Ten sklep ERLI jest już zapisany w innym kanale');
  expect(g).not.toContain('Sprawdź klucz i środowisko');expect(g).not.toContain('pas-potwierdzenie');
 }
 expect(db.prepare('SELECT pobieranie FROM kanaly_sprzedazy WHERE klucz=?').get(p.slice(1))!.pobieranie).toBe('wylaczone');
});
