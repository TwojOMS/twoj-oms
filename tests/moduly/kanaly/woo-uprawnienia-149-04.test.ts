import {afterEach,expect,it,vi} from 'vitest';
import {openOmsDb} from '../../../src/oms/db/db.ts';
import {migracjaKanalowSprzedazy} from '../../../src/moduly/kanaly/migracje/0001-kanaly-sprzedazy.ts';
import {migracjaTypuKanaluISklepow} from '../../../src/moduly/kanaly/migracje/0003-kanaly-typ-sklepy.ts';
import {zbudujUslugiKanalow} from '../../../src/moduly/kanaly/services/kompozycja-kanalow.ts';
import {createSklepyWoo} from '../../../src/moduly/kanaly/services/sklepy-woo.ts';
import {konfiguracjaKanalow} from '../../../src/moduly/kanaly/konfiguracja.ts';
import {TYLKO_ODCZYT,KLUCZ_TYLKO_ODCZYT} from '../../../src/domena/woo-uprawnienia.js';

// PRZ-149.04 (C8): wybór „Jakie uprawnienia ma klucz?” leży w kanaly_sklepy.ustawienia_json (bez migracji)
// i dociera do klienta sklepu z panelu — przy „Odczyt” zapis nie wychodzi do sklepu.

const bazy:ReturnType<typeof openOmsDb>[]=[];
afterEach(()=>{for(const db of bazy.splice(0))db.close();});
const a={id:1,login:'polcien_test'};
function ok(w:any){expect(w.ok).toBe(true);return w.dane;}
function setup(odpowiedz:(url:URL,init:RequestInit)=>Response=()=>Response.json([],{headers:{'X-WP-TotalPages':'1'}})){
 const db=openOmsDb();bazy.push(db);migracjaKanalowSprzedazy.wykonaj(db);migracjaTypuKanaluISklepow.wykonaj(db);
 const fetchImpl=vi.fn(async(u:any,init:any={})=>odpowiedz(new URL(String(u)),init));
 const config=konfiguracjaKanalow([],{});
 const teraz=()=>new Date('2026-11-02T12:00:00Z');
 const u=zbudujUslugiKanalow({db,konfiguracja:config,log:vi.fn(),teraz,usluga:()=>vi.fn()} as any,[],{fetchImpl});
 const s=createSklepyWoo({db,repozytorium:u.repozytoriumKanalow,envSklepy:[],teraz,tryb:'produkcja',poAktywacji:u.poAktywacji,klient:()=>({sprawdzPolaczenie:async()=>({ok:true}),pobierzMetodyWysylki:async()=>[],pobierzBramkiPlatnosci:async()=>[]})} as any);
 const wersja=(k:string)=>u.repozytoriumKanalow.listaTypu('woo').find(s=>s.klucz===k)!.wersja;
 const ustawienia=(k:string)=>JSON.parse((db.prepare('SELECT ustawienia_json FROM kanaly_sklepy WHERE klucz=?').get(k) as any).ustawienia_json);
 const aktywuj=async(uprawnienia?:string)=>{const k=ok(s.utworzSzkic({nazwa:'Pracownia Półcień',adres:'https://sklep.polcien.example',ck:'ck_polcien',cs:'cs_polcien',od:'2026-11-01',...(uprawnienia?{uprawnienia}:{})} as any,a)).klucz;ok(s.zapiszMapowanie(k,{instancje:{},bramkiPobrania:[]},wersja(k),a));ok(await s.sprawdz(k));ok(s.aktywuj(k,wersja(k),a));return k;};
 const zapisy=()=>fetchImpl.mock.calls.filter(([,i]:any)=>i?.method&&i.method!=='GET');
 return {db,u,s,wersja,ustawienia,aktywuj,fetchImpl,zapisy};
}

it('nowy sklep z wyborem „Odczyt” zapisuje uprawnienia w ustawienia_json; klient nie wysyła zapisów',async()=>{
 const {u,ustawienia,aktywuj,zapisy}=setup();const k=await aktywuj('odczyt');
 expect(ustawienia(k).uprawnienia).toBe('odczyt');
 expect(u.config.sklepy[k].uprawnienia).toBe('odczyt');
 const klient=u.klienciSklepow[k] as any;expect(klient.tylkoOdczyt).toBe(true);
 await expect(klient.ustawStatus('5','completed')).rejects.toThrow(TYLKO_ODCZYT);
 await expect(klient.dodajNotatke('5','Nadano')).rejects.toThrow(TYLKO_ODCZYT);
 await expect(klient.zapiszProdukt('products/9',{sku:'A-1'})).rejects.toThrow(TYLKO_ODCZYT);
 expect(zapisy()).toEqual([]);
});

it('sklep bez zapisanego wyboru pracuje jako Zapis/odczyt',async()=>{
 const {u,ustawienia,aktywuj}=setup();const k=await aktywuj();
 expect(ustawienia(k).uprawnienia).toBeUndefined();
 expect(u.config.sklepy[k].uprawnienia).toBe('zapis');
 expect((u.klienciSklepow[k] as any).tylkoOdczyt).toBe(false);
});

it('zmiana uprawnień zachowuje mapowanie i przebudowuje klienta',async()=>{
 const {u,s,wersja,ustawienia,aktywuj}=setup();const k=await aktywuj('odczyt');const przed=ustawienia(k).mapowanie;
 ok(s.ustawUprawnienia(k,'zapis',wersja(k),a));
 expect(ustawienia(k)).toEqual({mapowanie:przed,uprawnienia:'zapis'});
 expect((u.klienciSklepow[k] as any).tylkoOdczyt).toBe(false);
 expect(s.ustawUprawnienia(k,'wszystko',wersja(k),a).ok).toBe(false);
 expect(s.ustawUprawnienia(k,'odczyt',wersja(k)-1,a).ok).toBe(false);
});

it.each([
 ['403 woocommerce_rest_cannot_edit',403,{code:'woocommerce_rest_cannot_edit',message:'Sorry, you are not allowed to edit this resource.'}],
 ['401 bez prawa zapisu',401,{code:'woocommerce_rest_authentication_error',message:'The API key provided does not have write permissions.'}],
])('Zapis/odczyt z kluczem tylko do odczytu (%s) — komunikat kreatora po jednej próbie',async(_n,status,body)=>{
 const {u,aktywuj,zapisy}=setup((url,init)=>init.method&&init.method!=='GET'?Response.json(body,{status}):Response.json([],{headers:{'X-WP-TotalPages':'1'}}));
 const k=await aktywuj('zapis');
 await expect((u.klienciSklepow[k] as any).ustawStatus('5','completed')).rejects.toThrow(KLUCZ_TYLKO_ODCZYT);
 expect(zapisy()).toHaveLength(1);
});

it('inny błąd zapisu nadal ukrywa treść odpowiedzi sklepu',async()=>{
 const {u,aktywuj}=setup((url,init)=>init.method&&init.method!=='GET'?Response.json({code:'rest_forbidden',message:'treść ze sklepu'},{status:403}):Response.json([],{headers:{'X-WP-TotalPages':'1'}}));
 const k=await aktywuj();
 await expect((u.klienciSklepow[k] as any).ustawStatus('5','completed')).rejects.toThrow('Nie udało się wykonać operacji sklepu WooCommerce.');
});
