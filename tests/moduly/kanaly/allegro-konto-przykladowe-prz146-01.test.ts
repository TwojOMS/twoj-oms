// PRZ-146.01: konta przykładowe piaskownicy (atrapy z konfiguracji kanałów, bez wpisu w repozytorium kont)
// mają ekran w układzie panelu zamiast gołego „Nie znaleziono połączenia Allegro.”; nieznany klucz — 404 też w układzie.
import {afterEach,expect,it} from 'vitest';
import {openOmsDb} from '../../../src/oms/db/db.ts';
import {zbudujAplikacje,type Aplikacja} from '../../../src/core/aplikacja.ts';
import {ENV_DEMO} from '../../../scripts/demo-dane.mjs';
import {zalozKonto} from '../../../src/core/bezpieczenstwo/konta.js';
import {podpisz} from '../../../src/core/bezpieczenstwo/sesja.js';
import {wczytajSekret} from '../../../src/core/bezpieczenstwo/sekret-sesji.js';
import {przygotujUruchomienieSandbox} from '../../../deploy/proba/sandbox-uruchomienie.ts';

const root='/ustawienia/integracje/allegro';
const ZDANIE='Konto przykładowe piaskownicy (zamówienia demo). Nie da się go odłączyć ani usunąć.';
let a:Aplikacja|undefined,db:ReturnType<typeof openOmsDb>|undefined;
afterEach(async()=>{await a?.app.close();db?.close();a=undefined;db=undefined;});
const konfiguracja={srodowisko:'sandbox',klucz:'allegro_sandbox_polcien',clientName:'Polcien-Sandbox',clientId:'fikcyjny',clientSecret:'WABIK-FIKCYJNY',userAgent:'Polcien-Sandbox/1.0 (+https://example.invalid)',od:'2026-11-01'};
const env={...ENV_DEMO,OMS_TRYB:'proba',OMS_USER:'operator',OMS_PASS:'fixture',OMS_PROFORMY_KATALOG:'/tmp/prz14601-proformy',OMS_ETYKIETY_KATALOG:'/tmp/prz14601-etykiety'};

/** Kompozycja jak w piaskownicy: atrapy kont Allegro tylko w konfiguracji kanałów, nie w repozytorium. */
async function setup(){
 const plan=przygotujUruchomienieSandbox(env,konfiguracja,async()=>{throw Error('Bez sieci w teście');});
 db=openOmsDb();a=await zbudujAplikacje({db,env,moduly:plan.moduly,nadpisania:plan.nadpisania(db),log:()=>{}});
 zalozKonto(db,{login:'admin',imie:'Administrator',haslo:'fixture',rola:'administrator',admin:true});
 const cookie='sesja_oms_proba='+podpisz('admin',wczytajSekret(db),Date.now());
 const get=(url:string)=>a!.app.inject({method:'GET',url,headers:{accept:'text/html',cookie}});
 return {get,repo:a.usluga<any>('kanaly','repozytoriumKanalow'),config:a.usluga<any>('kanaly','config')};
}

it('oba konta przykładowe z konfiguracji: 200 w układzie panelu, zdanie, powrót do listy, bez formularzy',async()=>{
 const f=await setup();
 const przykladowe=Object.keys(f.config.kanaly).filter(k=>f.config.kanaly[k]?.atrapa);
 expect(przykladowe).toEqual(expect.arrayContaining(['allegro','allegro-outlet']));
 for(const k of ['allegro','allegro-outlet']){
  expect(f.repo.pobierz(k)).toBeFalsy();
  const r=await f.get(root+'/'+k);
  expect(r.statusCode,k).toBe(200);
  expect(r.body).toContain(ZDANIE);
  expect(r.body).toContain('<a href="/ustawienia/integracje">← Moje połączenia</a>');
  expect(r.body).toContain('class="oms-brand"');
  const tresc=r.body.slice(r.body.indexOf('<div class="allegro-konfiguracja">'));
  expect(tresc.slice(0,tresc.indexOf('</div>'))).not.toMatch(/<form|odlacz|Odłącz|name="nazwa"/);
  expect(r.body).not.toContain('Nie znaleziono połączenia Allegro.');
 }
});

it('nieznany klucz: 404 w układzie panelu z odnośnikiem do listy, nie goły tekst',async()=>{
 const f=await setup();
 const r=await f.get(root+'/nie-ma-takiego');
 expect(r.statusCode).toBe(404);
 expect(r.body).toContain('Nie znaleziono połączenia Allegro.');
 expect(r.body).toContain('class="oms-brand"');
 expect(r.body).toMatch(/<title>[^<]*Nie znaleziono/);
 expect(r.body).toContain('<a href="/ustawienia/integracje">← Moje połączenia</a>');
 expect(r.body).not.toContain(ZDANIE);
});
