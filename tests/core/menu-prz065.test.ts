import {nawigacjaUstawien} from '../../src/moduly/ustawienia/nawigacja.js';
import {describe, it, expect} from 'vitest';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {nawigacjaDla} from '../../src/domena/menu-stron.js';
import {menuKontaDla} from '../../src/domena/menu-konta.js';
import {adresZasobu} from '../../src/core/web/wersja-zasobow.js';
const ejs=createRequire(import.meta.url)('ejs');
const file=fileURLToPath(new URL('../../src/core/web/widoki/layout-oms.ejs',import.meta.url));
// PRZ-100: serwer daje `zasob` każdemu widokowi (defaultContext) — render układu wprost dostaje to samo.
const zasob=adresZasobu(fileURLToPath(new URL('../../src/public',import.meta.url)));
const menu=[
  {uprawnienie:'zamowienia',etykieta:'Zamówienia',adres:'/',dzial:'sprzedaz',grupa:'obsluga',kolejnosc:10},
  {uprawnienie:'przesylki',etykieta:'Przesyłki',adres:'/przesylki',dzial:'sprzedaz',grupa:'obsluga',kolejnosc:20},
  {uprawnienie:'faktury',etykieta:'Faktury',adres:'/faktury',dzial:'sprzedaz',grupa:'obsluga',kolejnosc:30},
  {uprawnienie:'wiadomosci',etykieta:'Wiadomości',adres:'/wiadomosci',dzial:'sprzedaz',grupa:'obsluga',kolejnosc:40},
  {uprawnienie:'magazyn',etykieta:'Magazyn',adres:'/magazyn',dzial:'magazyn',kolejnosc:50},
  {uprawnienie:'raporty',etykieta:'Raporty',adres:'/raporty',dzial:'analizy-cele',kolejnosc:60},
  {uprawnienie:'finanse',etykieta:'Finanse',adres:'/finanse',dzial:'analizy-cele',kolejnosc:70},
  {uprawnienie:'ustawienia',etykieta:'Ustawienia',adres:'/ustawienia',dzial:'ustawienia',kolejnosc:99},
];
const konto=(p:string[],admin=false)=>({imie:'Operator <test>',admin,uprawnienia:new Set(p)});
const model=(sciezka='/',k:any=null,m=menu)=>nawigacjaDla({sciezka,konto:k,menu:m,odlozoneEkrany:['finanse']});
async function render(n:any,k:any=null,extra:any={}){return ejs.renderFile(file,{title:'Przesyłki',motyw:'jasny',htmx:false,bezPaska:false,body:'<h1>Przesyłki</h1>',nawigacja:n,menuKonta:menuKontaDla(k,{powrot:'/przesylki?etap=utworzone'}),marka:{logoAlt:'Firma testowa'},modyfikatorStatusu:()=>null,zasob,...extra});}
describe('PRZ065 menu zaakceptowanej makiety',()=>{
  it('na każdej zakładce pokazuje wszystkie dozwolone ekrany z manifestów',()=>{
    const n=model('/przesylki') as any;
    expect(n.boczne.flatMap((g:any)=>g.pozycje).map((p:any)=>p.href)).toEqual(['/','/przesylki','/faktury','/wiadomosci','/magazyn','/raporty']);
    expect(n.boczne.flatMap((g:any)=>g.pozycje).filter((p:any)=>p.aktywna).map((p:any)=>p.href)).toEqual(['/przesylki']);
  });
  it('odmawiane uprawnienia i odłożone moduły nie pojawiają się w nowym menu',async()=>{
    const k=konto(['przesylki']);const n=model('/przesylki',k) as any;
    expect(n.boczne.flatMap((g:any)=>g.pozycje).map((p:any)=>p.href)).toEqual(['/przesylki']);
    const h=await render(n,k);
    for(const url of ['/faktury','/wiadomosci','/magazyn','/raporty','/finanse','/ustawienia','/zamowienia/nowe'])expect(h).not.toContain(`href="${url}"`);
  });
  it('przenosi etykiety, kolejność, adresy i escapowanie manifestu bez statycznej kopii',async()=>{
    const n=model('/raporty',null,menu.map(p=>p.uprawnienie==='raporty'?{...p,etykieta:'Raporty <custom>',adres:'/raporty?tryb=custom',kolejnosc:1}:p));
    const h=await render(n);
    expect(h).toContain('href="/raporty?tryb=custom"');expect(h).toContain('Raporty &lt;custom&gt;');
    expect((n as any).boczne.flatMap((g:any)=>g.pozycje).filter((p:any)=>p.klucz==='raporty')).toHaveLength(1);
  });
  it('renderuje nową ramę i zachowuje powrót motywu oraz menu użytkownika',async()=>{
    const k=konto([],true),h=await render(model('/przesylki',k),k);
    expect(h).toContain('class="oms-sidebar"');expect(h).toContain('aria-label="Główna"');
    expect(h).toContain('/public/oms-design.css');expect(h).toContain('Twój OMS');
    expect(h).toContain('Operator &lt;test&gt;');expect(h).toContain('action="/motyw"');
    expect(h).toContain('value="/przesylki?etap=utworzone"');expect(h).toContain('action="/wyloguj"');
    expect(h).toContain('aria-current="page"');
  });
  // PRZ-085: układ sam liczb nie wymyśla — bez `panelStatusow` i `licznikiStatusow` menu zostaje bez nich.
  // Liczby na Przesyłkach i reszcie dokłada pipeline (tests/moduly/wysylka/liczniki-menu-prz085.test.js).
  it('liczniki zamówień zachowuje przy zamówieniach; układ bez danych z pipeline’u nie zmyśla liczb',async()=>{
    const statuses=[{klucz:'do_zrobienia',etykieta:'Do zrobienia',href:'/',liczba:37,aktywna:true}];
    const h=await render(model('/'),null,{panelStatusow:statuses});
    expect(h).toMatch(/data-status="do_zrobienia">37<\/span>/);expect(h).toContain('href="/zamowienia/nowe"');
    expect(await render(model('/przesylki'))).not.toContain('data-status="do_zrobienia"');
  });
  it('jawne puste menu i widok bez paska nie odtwarzają pozycji',async()=>{
    const n=model('/',null,[]) as any;expect(n.boczne).toEqual([]);
    expect(await render(n)).not.toContain('href="/faktury"');
    expect(await render(model(),null,{bezPaska:true})).not.toContain('class="oms-sidebar"');
  });
});

describe('PRZ065 odbiór regresji ramy',()=>{
  it('zachowuje rzeczywistą kolumnę treści oraz wszystkie podsekcje ustawień',async()=>{
    const k=konto(['ustawienia'],true);
    const n=nawigacjaUstawien({url:'/ustawienia/lacznosc',konto:k},{locals:{nawigacja:model('/ustawienia/lacznosc',k)}});
    const h=await render(n,k);
    expect(h).toContain('<main class="kolumna-glowna">');
    expect(h.slice(h.indexOf('<main class="kolumna-glowna">'))).toContain('<h1>Przesyłki</h1>');
    for(const url of ['/ustawienia/zamowienia-i-wysylka','/ustawienia/integracje','/ustawienia/wiadomosci-i-automatyzacje','/ustawienia/lacznosc','/ustawienia/konta'])expect(h).toContain('href="'+url+'"');
    expect(h.match(/<li class="aktywna">\s*<a href="\/ustawienia\/lacznosc">/g)).toHaveLength(2);
  });
  it('statusy runtime zachowują wartości, nowe stany, adresy i escapowanie poza wycinkiem snapshotu menu',async()=>{
    const h=await render(model('/'),null,{panelStatusow:[{klucz:'do_zrobienia',etykieta:'Pilne <test>',href:'/?status=do_zrobienia&kanal=demo',liczba:37,aktywna:true},{klucz:'nowy_stan',etykieta:'Dodatkowy',href:'/?status=nowy_stan',liczba:0}]});
    // PRZ-066: statusy stoją w bocznym menu pod „Zamówienia”, a nie w pasku nad listą.
    // Osobno menu komputerowe i telefonowe — oba siedzą w tej samej kolumnie, więc jedno nie może zasłonić braku drugiego.
    const bok=h.slice(h.indexOf('<aside class="oms-sidebar">'),h.indexOf('</aside>'));
    const komputer=bok.slice(bok.indexOf('<div class="oms-menu-desktop">'),bok.indexOf('<details class="oms-menu-mobile"'));
    const telefon=bok.slice(bok.indexOf('<details class="oms-menu-mobile"'));
    expect(telefon.match(/<ul class="oms-statusy"[\s\S]*?<\/ul>/)?.[0]).toBeDefined();
    const nav=komputer.match(/<ul class="oms-statusy"[\s\S]*?<\/ul>/)?.[0];expect(nav).toBeDefined();
    expect(h).not.toContain('class="oms-order-statuses"');
    expect(nav).toContain('Pilne &lt;test&gt;');expect(nav).not.toContain('Pilne <test>');
    expect(nav).toContain('href="/?status=do_zrobienia&amp;kanal=demo" aria-current="page"');
    expect(nav).toContain('data-status="do_zrobienia">37</span>');expect(nav).toContain('data-status="nowy_stan">0</span>');
    expect(nav).toContain('href="/zamowienia/nowe"');
    const denied=await render(model('/',konto(['przesylki'])),null,{panelStatusow:[{klucz:'do_zrobienia',etykieta:'Tajne',href:'/',liczba:37}]});
    expect(denied).not.toContain('class="oms-statusy"');expect(denied).not.toContain('href="/zamowienia/nowe"');
  });
});
