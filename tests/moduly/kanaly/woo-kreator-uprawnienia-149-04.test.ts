import {afterEach,expect,it} from 'vitest';
import {createRequire} from 'node:module';
import {zbudujAplikacje,type Aplikacja} from '../../../src/core/aplikacja.ts';
import {openOmsDb} from '../../../src/oms/db/db.ts';
import {modulyPiaskownicy} from '../../../deploy/proba/atrapy/index.mjs';
import {createModulKanaly} from '../../../src/moduly/kanaly/modul.ts';
import {zalozKonto} from '../../../src/core/bezpieczenstwo/konta.js';
import {podpisz} from '../../../src/core/bezpieczenstwo/sesja.js';
import {wczytajSekret} from '../../../src/core/bezpieczenstwo/sekret-sesji.js';
import {MODUL_WOO} from '../../../src/domena/modul-woo.ts';
import {stanKrokow,adresAkcji} from '../../../src/core/web/konfigurator/konfigurator.ts';
import {METODY_WYSYLKI} from '../../../src/domena/wysylka.js';
import {fmtDataCzas,fmtDataCzasKrotko} from '../../../src/domena/format-daty.js';
import {utworzRegule,wlaczRegule} from '../../../src/moduly/automatyzacje/db/reguly.js';
import type {ModulOms} from '../../../src/core/kontrakty.ts';

// PRZ-149.04 (C8): krok 2 kreatora Woo pyta „Jakie uprawnienia ma klucz?”; od wyboru zależy punkt instrukcji,
// wybór leży w ustawienia_json sklepu, krok 5 go pokazuje. Przy „Odczyt” — zdanie o mailu o wysyłce z OMS.

const root=MODUL_WOO.konfigurator.sciezka;
const OPCJA_ODCZYT='Odczyt (OMS tylko pobiera zamówienia)';
const OPCJA_ZAPIS='Zapis/odczyt (OMS też zmienia status, dopisuje numer przesyłki i zapisuje SKU/wymiary)';
const PUNKT_ODCZYT='W polu „Uprawnienia” zostaw „Odczyt”. Kliknij „Wygeneruj klucz API”.';
const PUNKT_ZAPIS='W polu „Uprawnienia” wybierz „Zapis/odczyt”. Kliknij „Wygeneruj klucz API”.';
const WLACZ='<a href="/ustawienia/automatyzacje">Włącz mail »Zamówienie wysłane« z OMS</a>';
const MAIL='mail o wysyłce może wysyłać OMS — automatyzacja z szablonem „Zamówienie wysłane”';
let a:Aplikacja,db:ReturnType<typeof openOmsDb>;
afterEach(async()=>{await a?.app.close();db?.close();a=undefined as any;db=undefined as any;});

async function setup(){
 const env={OMS_USER:'serwis',OMS_PASS:'fixture',OMS_TRYB:'proba',OMS_KANALY:'[]',OMS_SPRZEDAWCA_NIP:'1234563218',OMS_RACHUNEK:'34109010140000000000000000',OMS_PROFORMY_KATALOG:'/tmp/prz149-proformy',OMS_ETYKIETY_KATALOG:'/tmp/prz149-etykiety'};
 const m=createModulKanaly([],false,{fetchImpl:async(u)=>{const url=String(u);if(url.includes('/shipping/zones/'))return Response.json([{instance_id:1,title:'Kurier Półcień',method_id:'flat_rate',enabled:true}]);if(url.includes('/shipping/zones'))return Response.json([{id:1,name:'Polska'}]);if(url.includes('/payment_gateways'))return Response.json([{id:'cod',title:'Za pobraniem',enabled:true}]);return Response.json([]);}});
 const config=createModulKanaly([]).konfiguracja(env);
 db=openOmsDb();a=await zbudujAplikacje({db,moduly:modulyPiaskownicy(env).map(x=>x.nazwa==='kanaly'?{...m,konfiguracja:()=>config}:x) as ModulOms[],env,teraz:()=>new Date('2026-11-03T12:00:00Z'),log:()=>{}});
 zalozKonto(db,{login:'admin',imie:'Administrator',haslo:'fixture',rola:'administrator',admin:true});
 const cookie='sesja_oms_proba='+podpisz('admin',wczytajSekret(db),Date.now());
 const req=(method:'GET'|'POST',path:string,payload?:Record<string,unknown>)=>a.app.inject({method,url:root+path,payload,headers:{accept:'text/html',cookie,...(method==='POST'?{origin:'http://localhost'}:{})}});
 const formularz=async(nazwa='Pracownia Półcień',adres='https://sklep.polcien.example')=>{const p=await req('POST','/szkice',{nazwa,adres});expect(p.statusCode).toBe(200);return p;};
 async function szkic(uprawnienia?:string,nazwa?:string,adres?:string){
  const p=await formularz(nazwa,adres);const formularzId=p.body.match(/name="formularzId" value="([^"]+)"/)?.[1];
  const w=await req('POST','/nowy/klucze',{formularzId,wersja:0,ck:'ck_test_polcien',cs:'cs_test_polcien',...(uprawnienia?{uprawnienia}:{})});expect(w.statusCode).toBe(303);
  return decodeURIComponent(String(w.headers.location).slice(root.length+1));
 }
 const ustawienia=(k:string)=>JSON.parse(String((db.prepare('SELECT ustawienia_json FROM kanaly_sklepy WHERE klucz=?').get(k) as any).ustawienia_json));
 const wersja=(body:string)=>body.match(/name="wersja" value="(\d+)"/)?.[1];
 return {req,formularz,szkic,ustawienia,wersja};
}
const regula=(kanaly:string[],wlacz=true)=>{const id=utworzRegule(db,{nazwa:'Wysłane — Półcień',zdarzenie:'status_zmieniony',zdarzenie_json:{status:'wyslane'},
 warunki:{kanaly,kanalyZnane:kanaly,statusy:['wyslane'],maNumerListu:true,metody:[],pobranie:'dowolne'},akcja:'mail_kupujacy',akcja_json:{szablon:'wyslane'},opoznienie_min:30,limit_na_godzine:20},{login:'admin'} as any);if(wlacz)wlaczRegule(db,id,{login:'admin'} as any);};

it('krok 2 nowego sklepu: wybór z dwiema opcjami, domyślnie Zapis/odczyt, punkt instrukcji w dwóch wariantach',async()=>{
 const f=await setup();const {body}=await f.formularz();
 expect(body).toContain('<label for="konfigurator-klucze-uprawnienia">Jakie uprawnienia ma klucz?</label>');
 expect(body).toMatch(/<select id="konfigurator-klucze-uprawnienia" name="uprawnienia" form="konfigurator-klucze-formularz">/);
 expect(body).toContain('<form id="konfigurator-klucze-formularz" method="post"');
 expect(body).toContain(`<option value="odczyt">${OPCJA_ODCZYT}</option>`);
 expect(body).toContain(`<option value="zapis" selected>${OPCJA_ZAPIS}</option>`);
 expect(body).toContain(`<span data-wybor="odczyt" hidden>${PUNKT_ODCZYT}</span>`);
 expect(body).toContain(`<span data-wybor="zapis">${PUNKT_ZAPIS}</span>`);
 // Zdanie o mailu jest przy wyborze „Odczyt” (ukryte, gdy wybrany Zapis/odczyt); nowy sklep nie ma jeszcze reguły.
 const mail=body.slice(body.indexOf('<p class="ust-pomoc" data-wybor="odczyt"'));expect(mail).toMatch(/^<p class="ust-pomoc" data-wybor="odczyt" hidden>/);
 expect(mail.slice(0,mail.indexOf('</p>'))).toContain(WLACZ);expect(mail.slice(0,mail.indexOf('</p>'))).toContain(MAIL);
});

it('„Odczyt” przy nowym sklepie trafia do ustawienia_json i wraca zaznaczony; brak wyboru = Zapis/odczyt',async()=>{
 const f=await setup();
 const k=await f.szkic('odczyt');expect(f.ustawienia(k).uprawnienia).toBe('odczyt');
 const html=(await f.req('GET','/'+encodeURIComponent(k))).body;
 expect(html).toContain(`<option value="odczyt" selected>${OPCJA_ODCZYT}</option>`);
 expect(html).toContain(`<span data-wybor="odczyt">${PUNKT_ODCZYT}</span>`);expect(html).toContain(`<span data-wybor="zapis" hidden>${PUNKT_ZAPIS}</span>`);
 expect(html).toMatch(/<p class="ust-pomoc" data-wybor="odczyt">[^]*?Włącz mail »Zamówienie wysłane« z OMS/);
 const k2=await f.szkic(undefined,'Pracownia Półcień — hurt','https://hurt.polcien.example');expect(f.ustawienia(k2).uprawnienia).toBeUndefined();
 expect((await f.req('GET','/'+encodeURIComponent(k2))).body).toContain(`<option value="zapis" selected>${OPCJA_ZAPIS}</option>`);
});

it('istniejący sklep: zmiana wyboru w kroku 2 (z kluczami i bez) zapisuje się; zła wartość niczego nie zmienia',async()=>{
 const f=await setup();const k=await f.szkic();const adres='/'+encodeURIComponent(k);
 let v=f.wersja((await f.req('GET',adres)).body);
 let r=await f.req('POST',adres+'/klucze',{wersja:v,ck:'',cs:'',uprawnienia:'odczyt'});
 expect(r.statusCode).toBe(200);expect(r.body).toContain('Połączenie ze sklepem działa.');expect(f.ustawienia(k).uprawnienia).toBe('odczyt');
 // Nowe klucze i zmiana wyboru w jednym formularzu — obie zmiany przechodzą (bez konfliktu wersji).
 v=f.wersja(r.body);r=await f.req('POST',adres+'/klucze',{wersja:v,ck:'ck_nowy_polcien',cs:'cs_nowy_polcien',uprawnienia:'zapis'});
 expect(r.statusCode).toBe(200);expect(r.body).not.toContain('Formularz jest nieaktualny');expect(f.ustawienia(k).uprawnienia).toBe('zapis');
 v=f.wersja(r.body);r=await f.req('POST',adres+'/klucze',{wersja:v,ck:'',cs:'',uprawnienia:'wszystko'});
 expect(r.statusCode).toBe(400);expect(r.body).toContain('Wybierz uprawnienia klucza.');expect(f.ustawienia(k).uprawnienia).toBe('zapis');
});

it('zdanie „Włącz mail…” znika, gdy dla tego sklepu jest włączona automatyzacja z szablonem „Zamówienie wysłane”',async()=>{
 const f=await setup();const k=await f.szkic('odczyt');const strona=async()=>(await f.req('GET','/'+encodeURIComponent(k))).body;
 regula(['inny_sklep']);regula([k],false);
 let html=await strona();expect(html).toContain(WLACZ);
 regula([k]);html=await strona();
 expect(html).not.toContain('Włącz mail');expect(html).toContain(MAIL);expect(html).toContain('Dla tego sklepu jest włączona.');
 // Nic nie włącza się samo: liczba włączonych reguł bez zmian po wejściu na ekran.
 expect((db.prepare('SELECT COUNT(*) AS n FROM automatyzacje_reguly WHERE wlaczona=1').get() as any).n).toBe(2);
});

// Krok 5 (stan aktywnego sklepu) — sam widok.
const ejs=createRequire(import.meta.url)('ejs') as {renderFile:(path:string,data:Record<string,unknown>)=>Promise<string>};
const krok5=async(uprawnienia:string,mailWyslane:boolean|null,env=false)=>{const h=await ejs.renderFile('src/moduly/kanaly/widoki/woo-sklep.ejs',{
 k:{klucz:'woo_polcien',nazwa:'Pracownia Półcień',zrodlo:env?'env':'panel',wersja:2,odUtc:'2026-11-01T23:00:00Z',generacjaImportu:1,autoryzacja:'polaczone',pobieranie:'wlaczone'},
 root,adres:root+'/woo_polcien',adresSklepu:'https://sklep.polcien.example',fmtDataCzas,fmtDataCzasKrotko,konfigurator:MODUL_WOO.konfigurator,
 kroki:stanKrokow(MODUL_WOO.konfigurator,{biezacy:'stan',zrobione:['nazwa','klucze','mapowanie','start']}),adresAkcji,
 wartosci:{od:'2026-11-02',ck:true,cs:true,uprawnienia},formularzId:'',blad:null,komunikat:null,stan:null,metody:[],mapowanie:{instancje:{}},metodyOms:METODY_WYSYLKI,etykiety:{},mailWyslane,
});return h.slice(h.indexOf('<h2>5.'),h.indexOf('</section>',h.indexOf('<h2>5.')));};
it('krok 5 pokazuje tryb klucza; przy „Odczyt” zdanie o mailu z OMS',async()=>{
 let s=await krok5('odczyt',false);expect(s).toContain('Uprawnienia klucza: Odczyt.');expect(s).toContain(MAIL);expect(s).toContain(WLACZ);expect(s).not.toContain('data-wybor');
 s=await krok5('odczyt',true);expect(s).toContain(MAIL);expect(s).not.toContain('Włącz mail');
 s=await krok5('zapis',false);expect(s).toContain('Uprawnienia klucza: Zapis/odczyt.');expect(s).not.toContain(MAIL);
 // Bez modułu automatyzacji (null) nie ma do czego odsyłać.
 s=await krok5('odczyt',null);expect(s).toContain('Uprawnienia klucza: Odczyt.');expect(s).not.toContain(MAIL);
 s=await krok5('zapis',null,true);expect(s).toContain('Uprawnienia klucza: Zapis/odczyt.');
});
