// KANDYDAT PRZ-065. Zastępuje wyłącznie literalną ramę PRZ032 po osobnej zgodzie.
// Historyczne fixtures/menu-prz032-przed.json zostaje nietknięte.
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import Fastify from 'fastify';
import { registerWeb } from '../../src/core/web/pipeline.js';
import { openOmsDb } from '../../src/oms/db/db.ts';
import { MODULY } from '../../src/moduly/lista.ts';
import { nawigacjaDla } from '../../src/domena/menu-stron.js';
import { menuKontaDla } from '../../src/domena/menu-konta.js';
import { zbudujOms } from '../../src/oms/bootstrap.ts';
import { adresZasobu } from '../../src/core/web/wersja-zasobow.js';

// PRZ-100: serwer daje `zasob` każdemu widokowi (defaultContext) — render układu wprost dostaje to samo.
const zasob = adresZasobu(fileURLToPath(new URL('../../src/public', import.meta.url)));

const przed = JSON.parse(readFileSync(new URL('../fixtures/menu-prz065.json', import.meta.url), 'utf8'));
if (przed.cases.length !== 225) throw new Error(`PRZ065: fixture ma ${przed.cases.length} zamiast 225 przypadków`);
type OpcjeRenderu = { filename:string; includer:(original:string, parsed:string)=>{filename:string;template:string} };
const ejs = createRequire(import.meta.url)('ejs') as { renderFile:(path:string,data:Record<string,unknown>)=>Promise<string>; render:(template:string,data:Record<string,unknown>,options:OpcjeRenderu)=>string; };
const szablon = fileURLToPath(new URL('../../src/core/web/widoki/layout-oms.ejs', import.meta.url));
const menu = MODULY.flatMap(m => m.menu).toSorted((a,b) => a.kolejnosc-b.kolejnosc);
const plikiSzablonu = ['layout-oms.ejs','_menu-panelu.ejs','_ikona-panelu.ejs','_menu-uzytkownika.ejs']
  .map(p=>fileURLToPath(new URL(`../../src/core/web/widoki/${p}`,import.meta.url)));
const eolZrodel = plikiSzablonu.map(p=>{
  const rodzaje = [...new Set(readFileSync(p,'utf8').match(/\r\n|\r|\n/g))];
  if(rodzaje.length!==1)throw new Error(`Niejednorodne EOL szablonu: ${p}`);
  return rodzaje[0];
});
if(new Set(eolZrodel).size!==1)throw new Error('Mieszane EOL między szablonami nowego menu — nie zgaduj oracle');
const odtworz = (refs:number[],eol:string=eolZrodel[0]) => refs.map(i=>przed.fragments[i]).join('').replaceAll('\r\n','\n').replaceAll('\n',eol);
const dane = (przypadek:any) => {
  const konto = przypadek.konto ? {...przypadek.konto,uprawnienia:new Set(przypadek.konto.uprawnienia)} : null;
  return {title:'Fixture menu',motyw:'jasny',htmx:false,bezPaska:przypadek.bezPaska??false,body:'<p>Fixture</p>',panelStatusow:przypadek.panelStatusow,
    marka:{logoAlt:'Firma testowa'},nawigacja:nawigacjaDla({sciezka:przypadek.sciezka,konto,menu,odlozoneEkrany:['kampania','cele','finanse']}),
    menuKonta:menuKontaDla(konto,{powrot:przypadek.sciezka}),modyfikatorStatusu:()=>null,zasob};
};
const wytnij = (html: string) => ({
  header: html.match(/<header class="oms-topbar">[\s\S]*?<\/header>/)?.[0] ?? '',
  aside: html.match(/<aside class="oms-sidebar">[\s\S]*?<\/aside>/)?.[0] ?? '',
});

describe('PRZ065 literalny HTML zatwierdzonego menu i manifestów', () => {
  for (const przypadek of przed.cases) it(przypadek.name, async () => {
    expect(wytnij(await ejs.renderFile(szablon,dane(przypadek)))).toEqual({header:odtworz(przypadek.header),aside:odtworz(przypadek.aside)});
  });
});
for(const eol of ['\n','\r\n'])it(`PRZ065 literalny HTML w checkout ${eol==='\n'?'LF':'CRLF'}`,()=>{
  for(const name of ['administrator /faktury','tylko-przesylki /przesylki','statusy-runtime','imie-html /ustawienia/konta/2']) {
    const przypadek = przed.cases.find((p:any)=>p.name===name);
    const eolSzablonu = (p:string)=>readFileSync(p,'utf8').replaceAll('\r\n','\n').replaceAll('\n',eol);
    const html=ejs.render(eolSzablonu(szablon),dane(przypadek),{filename:szablon,includer:(_original,parsed)=>({filename:parsed,template:eolSzablonu(parsed)})});
    expect(wytnij(html)).toEqual({header:odtworz(przypadek.header,eol),aside:odtworz(przypadek.aside,eol)});
  }
});
const env = { OMS_USER:'operator', OMS_PASS:'fixture', OMS_SPRZEDAWCA_NIP:'1234563218', OMS_RACHUNEK:'34109010140000000000000000', OMS_PROFORMY_KATALOG:tmpdir(), OMS_ETYKIETY_KATALOG:tmpdir() };
const headers = { authorization:`Basic ${Buffer.from('operator:fixture').toString('base64')}` };
it('PRZ065 rzeczywisty bootstrap zachowuje etykietę, adres i kolejność z manifestu', async () => {
  const siec = vi.spyOn(globalThis,'fetch').mockRejectedValue(new Error('Sieć zabroniona')); let a: Awaited<ReturnType<typeof zbudujOms>> | undefined;
  const moduly = MODULY.map(m => m.nazwa==='raporty' ? {...m, menu:m.menu.map(p=>p.uprawnienie==='raporty'?{...p,etykieta:'Raporty <z manifestu>',adres:'/raporty?widok=manifest',kolejnosc:25}:p)}:m);
  try { a=await zbudujOms({env,moduly}); const odp=await a.app.inject({method:'GET',url:'/raporty',headers}); expect(odp.statusCode).toBe(200); const f=wytnij(odp.body);
    expect(f.aside).toContain('href="/raporty?widok=manifest"'); expect(f.aside).toContain('Raporty &lt;z manifestu&gt;');
    expect(f.aside.indexOf('href="/statystyki"')).toBeLessThan(f.aside.indexOf('href="/raporty?widok=manifest"')); expect((a.app as any).menuOms).toBe(a.menu); expect(siec).not.toHaveBeenCalled();
  } finally { try { await a?.app.close(); } finally { a?.db.close(); siec.mockRestore(); } }
});
it('PRZ065 jawna pusta lista manifestów nie przywraca statycznych pozycji',()=>{ const n=nawigacjaDla({sciezka:'/',menu:[]} as any); expect({boczne:n.boczne,ustawienia:n.ustawienia,statusy:n.kontekst?.statusy??[]}).toEqual({boczne:[],ustawienia:null,statusy:[]}); });
it('PRZ065 pipeline odmawia konfiguracji HTTP bez manifestu Aplikacja.menu',async()=>{const app=Fastify(),db=openOmsDb();try{expect(()=>registerWeb(app,{db,config:{auth:{user:'operator',pass:'fixture'}}})).toThrow('Brak menuOms');}finally{try{await app.close();}finally{db.close();}}});
