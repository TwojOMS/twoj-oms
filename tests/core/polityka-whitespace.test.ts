import {describe,it,expect} from 'vitest';
import {konfiguracjaKanalow} from '../../src/moduly/kanaly/konfiguracja.ts';
import {modulWysylka} from '../../src/moduly/wysylka/modul.ts';
import {wczytajKurierow} from '../../src/moduly/wysylka/kurierzy.ts';
import {wczytajFaktury} from '../../src/moduly/faktury/modul.ts';
import {wczytajKoszty} from '../../src/moduly/koszty/modul.ts';
import {konfiguracjaZamowien} from '../../src/moduly/zamowienia/konfiguracja.ts';

const seller={OMS_SPRZEDAWCA_NIP:'1234563218',OMS_RACHUNEK:'34109010140000000000000000',OMS_PROFORMY_KATALOG:'syntetyczny-katalog'};
const url='https://fixture.invalid/base/';
const dpd={DPD_URL:url,DPD_INFO_URL:url,DPD_LOGIN:'fixture',DPD_PASSWORD:'fixture',DPD_FID:'1',DPD_INFO_CHANNEL:'fixture',
 DPD_NADAWCA_NAZWA:'Fixture',DPD_NADAWCA_ULICA:'Fixture 1',DPD_NADAWCA_KOD:'00-001',DPD_NADAWCA_MIASTO:'Fixture'};
const urls=[
 ['DPD_URL',(e:Record<string,string>)=>wczytajKurierow({...dpd,...e})],['DPD_INFO_URL',(e:Record<string,string>)=>wczytajKurierow({...dpd,...e})],
 ['INPOST_URL',(e:Record<string,string>)=>wczytajKurierow({...dpd,...e})],
 ['INFAKT_API_URL',(e:Record<string,string>)=>wczytajFaktury({...seller,...e})],
 ['KSEF_API',(e:Record<string,string>)=>wczytajKoszty({...seller,KSEF_TOKEN:'fixture',KSEF_NIP:'1234563218',...e})],
 ['GUS_URL',(e:Record<string,string>)=>konfiguracjaZamowien({...seller,...e})],
 ...([['woo','URL'],['allegro','API'],['allegro','AUTH']] as const).map(([typ,sufiks])=>
  ['P_'+sufiks,(e:Record<string,string>)=>konfiguracjaKanalow([{klucz:'demo',typ,prefiks:'P'}],e)] as const),
] as const;
const timers=[
 ['OMS_POLLER_MS',30000,120000,(e:Record<string,string>)=>konfiguracjaKanalow([],e).odstepMs],
 ['OMS_PRZESYLKI_ODSTEP_MS',60000,3600000,(e:Record<string,string>)=>modulWysylka.konfiguracja(e).odstepPrzesylekMs],
 ['OMS_PODJAZDY_ODSTEP_MS',60000,600000,(e:Record<string,string>)=>modulWysylka.konfiguracja(e).odstepPodjazdowMs],
] as const;

describe('D07 W2 — rzeczywiste konfiguratory odrzucają otaczające białe znaki',()=>{
 for(const [key,configure] of urls){
  for(const whitespace of [' ','\t','\n'])for(const side of ['poczatek','koniec'] as const)
   it(`${key} URL whitespace ${side} ${JSON.stringify(whitespace)}`,()=>{
    const raw=side==='koniec'?url+whitespace:whitespace+url;
    expect(()=>configure({[key]:raw})).toThrow(`${key}: wymagany absolutny URL http/https`);
    try{configure({[key]:raw});}catch(e){expect((e as Error).message).not.toContain(url);}
   });
  it(`${key} poprawny URL bez otaczających znaków pozostaje przyjęty`,()=>expect(()=>configure({[key]:url})).not.toThrow());
 }
 for(const [key,min,domyslny,read] of timers){
  for(const whitespace of [' ','\t','\n'])for(const side of ['poczatek','koniec','oba'] as const)
   it(`${key} timer whitespace ${side} ${JSON.stringify(whitespace)}`,()=>{
    const raw=(side!=='koniec'?whitespace:'')+'60001'+(side!=='poczatek'?whitespace:'');
    expect(()=>read({[key]:raw})).toThrow(`${key}: wymagany całkowity odstęp od ${min} do 2147483647 ms`);
    try{read({[key]:raw});}catch(e){expect((e as Error).message).not.toContain(raw);}
   });
  it(`${key} zachowuje default, min, max i reprezentacje Number`,()=>{
   expect(read({})).toBe(domyslny);
   expect(read({[key]:String(min)})).toBe(min);
   expect(read({[key]:'2147483647'})).toBe(2147483647);
   expect(read({[key]:'6e4'})).toBe(60000);
   expect(read({[key]:'0xea60'})).toBe(60000);
   for(const raw of [String(min-1),'2147483648','9007199254740992','60000.5','Infinity','NaN'])expect(()=>read({[key]:raw})).toThrow(key);
  });
 }
});
