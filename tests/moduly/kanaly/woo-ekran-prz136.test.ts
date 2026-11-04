import {expect,it} from 'vitest';
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import Fastify from 'fastify';
import {MODUL_WOO} from '../../../src/domena/modul-woo.ts';
import {stanKrokow,adresAkcji} from '../../../src/core/web/konfigurator/konfigurator.ts';
import {fmtDataCzas,fmtDataCzasKrotko} from '../../../src/domena/format-daty.js';
import {registerTrasyWoo} from '../../../src/moduly/kanaly/trasy-woo.ts';

const ejs=createRequire(import.meta.url)('ejs');
const konfigurator=MODUL_WOO.konfigurator;
const render=(zmiany:Record<string,unknown>={},inne:Record<string,unknown>={})=>ejs.renderFile('src/moduly/kanaly/widoki/woo-sklep.ejs',{
 k:{klucz:'woo_polcien',nazwa:'Sklep Półcień',zrodlo:'panel',wersja:1,generacjaImportu:1,autoryzacja:'polaczone',pobieranie:'wlaczone',...zmiany},
 adres:konfigurator.sciezka+'/woo_polcien',adresSklepu:'https://example.test',konfigurator,adresAkcji,fmtDataCzas,fmtDataCzasKrotko,
 kroki:stanKrokow(konfigurator,{biezacy:'stan',zrobione:['nazwa','klucze','mapowanie','start']}),
 wartosci:{od:'2026-11-03',ck:true,cs:true},formularzId:'',blad:null,komunikat:null,
 stan:{ostatni_przebieg_at:'2026-11-03T21:22:00Z',zsynchronizowane_do:null,ostatni_blad:null},
 metody:[],mapowanie:{instancje:{},bramkiPobrania:[]},metodyOms:[],etykiety:{},...inne,
});

it('B8: ostatni przebieg pokazuje czas polski, bez surowego ISO',async()=>{
 const html=await render();
 expect(html).toContain('22:22');expect(html).not.toContain('2026-11-03T21:22');
});
it('B7: sklep administratora bez adresu ma wyjaśnienie i nazwę bez myślnika',async()=>{
 const html=await render({zrodlo:'env'},{adresSklepu:''});
 expect(html).toContain('Połączenie i adres sklepu ustawił administrator serwera — zmiany zgłoś jemu.');
 expect(html).not.toContain('Sklep Półcień —<');
 expect(html.match(/administrator/g)).toHaveLength(1);
 expect(html).not.toContain('oms.env');
});
it('aktywny sklep nie pokazuje stepera; nieaktywny nadal go ma',async()=>{
 expect(await render()).not.toContain('aria-label="Kroki konfiguracji"');
 expect(await render({autoryzacja:'brak'})).toContain('aria-label="Kroki konfiguracji"');
});
it('zamówienia uzupełnione do: kursor Woo bez strefy (UTC) pokazany w czasie polskim, jak ostatni przebieg',async()=>{
 const html=await render({},{stan:{ostatni_przebieg_at:'2026-11-03T21:22:00Z',zsynchronizowane_do:'2026-11-03T21:22:00',ostatni_blad:null}});
 expect(html).toMatch(/Zamówienia uzupełnione do: 2026-11-03 22:22\./);
 expect(html).not.toContain('Ostatni sukces');
});
it('brak zamówień i metod wyjaśnia zdaniami zamiast pustej tabeli',async()=>{
 const html=await render();
 expect(html).toContain('Jeszcze nie pobrano zamówień');expect(html).not.toContain('Ostatni sukces');
 expect(html).toContain('Brak metod wysyłki do przypisania.');expect(html).not.toContain('<table');
 expect(html).toContain('← Moje połączenia');
});
it('metody mają polską etykietę identyfikatora i kontener przewijania',async()=>{
 const html=await render({}, {metody:[{strefa:'Polska',instanceId:1,tytul:'Kurier',metodaWoo:'flat_rate'}]});
 expect(html).toContain('Identyfikator instalacji');expect(html).not.toContain('instance_id');
 expect(html).toMatch(/<div class="przewijak-tabeli">\s*<table>/);
});
it('dodawanie Woo aktywuje zakładkę Dodaj integrację także w kroku kluczy',async()=>{
 const app=Fastify();
 app.addHook('preHandler',async req=>{(req as any).konto={id:1,login:'admin',admin:true};});
 app.decorateReply('view',function(path:string,data?:object){
  const renderWidok=(filename:string)=>ejs.render(readFileSync(filename,'utf8'),data,{filename});
  const tabs=renderWidok('src/core/web/widoki/_zakladki-ustawien.ejs');
  return this.type('text/html').send(tabs+renderWidok('src/moduly/kanaly/widoki/'+path));
 });
 registerTrasyWoo(app,{db:{} as any,repozytorium:{} as any,sklepyWoo:{} as any,envSklepy:[],teraz:()=>new Date('2026-11-03T12:00:00Z'),tryb:'produkcja'});
 try{
  const responses=[await app.inject({url:konfigurator.sciezka+'/nowy'}),await app.inject({method:'POST',url:konfigurator.sciezka+'/szkice',payload:{nazwa:'Sklep Półcień',adres:'https://example.test'}})];
  for(const res of responses){expect(res.statusCode).toBe(200);expect(res.body).toMatch(/href="\/ustawienia\/integracje\/katalog" aria-current="page">Dodaj integrację/);expect(res.body).toContain('← Moje połączenia');}
 }finally{await app.close();}
});
it('bez błędu nie pisze „Błąd: Brak”; z błędem jedno zdanie',async()=>{
 const html=await render();
 expect(html).not.toContain('Błąd:');expect(html).not.toContain('nie udało');
 expect(html).toMatch(/Ostatni przebieg: 2026-11-03 22:22\./);
 const zBledem=await render({},{stan:{ostatni_przebieg_at:'2026-11-03T21:22:00Z',zsynchronizowane_do:null,ostatni_blad:'ECONNREFUSED'}});
 expect(zBledem).toContain('Ostatnie pobieranie się nie udało — sprawdź połączenie ze sklepem.');expect(zBledem).not.toContain('ECONNREFUSED');
});
