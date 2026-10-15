import { describe, it, expect } from 'vitest';
import { efektywnyTryb, sprawdzTrybProby } from '../../src/core/tryb.ts';
import { konfiguracjaKanalow } from '../../src/moduly/kanaly/konfiguracja.ts';
import { modulWysylka } from '../../src/moduly/wysylka/modul.ts';
import { wczytajKurierow } from '../../src/moduly/wysylka/kurierzy.ts';
import { wczytajFaktury } from '../../src/moduly/faktury/modul.ts';
import { wczytajKoszty } from '../../src/moduly/koszty/modul.ts';
import { konfiguracjaZamowien } from '../../src/moduly/zamowienia/konfiguracja.ts';
import { zbudujAplikacje } from '../../src/core/aplikacja.ts';
import { modulRdzen } from '../../src/moduly/rdzen/modul.ts';
import type { DatabaseSync } from 'node:sqlite';
import type { ModulOms } from '../../src/core/kontrakty.ts';
import { skonfigurowanyUrl } from '../../src/core/konfiguracja-wartosci.ts';

const seller={OMS_SPRZEDAWCA_NIP:'1000001193',OMS_RACHUNEK:'61109010140000071219812874',OMS_PROFORMY_KATALOG:'/tmp/test-proformy'};
describe('zatwierdzona polityka D02 / D07',()=>{
  it('wyznacza efektywny tryb bez zgadywania literówek',()=>{
    expect(efektywnyTryb({})).toBe('produkcja'); expect(efektywnyTryb({OMS_TRYB:''})).toBe('produkcja');
    for(const v of ['produkcja','proba'] as const)expect(efektywnyTryb({OMS_TRYB:v})).toBe(v);
    for(const v of ['probba',' proba','PROBA',' '])expect(()=>efektywnyTryb({OMS_TRYB:v})).toThrow('OMS_TRYB');
  });
  it('odmawia próby dla odłożonych integracji i whitespace',()=>{
    for(const name of ['ALLEGRO_CLIENT_ID','ALLEGRO_CLIENT_SECRET','WOO_CK','WOO_CS','APILO_CREDENTIALS_PATH',
      'DPD_LOGIN','DPD_PASSWORD','INPOST_TOKEN','INFAKT_API_KEY','KSEF_TOKEN','GUS_KLUCZ','META_TOKEN','GA4_KLUCZ','SMTP_USER','SMTP_PASS'])
      for(const value of ['x',' \t'])expect(()=>sprawdzTrybProby({OMS_TRYB:'proba',[name]:value},[])).toThrow(name);
    expect(()=>sprawdzTrybProby({OMS_TRYB:'proba',CUSTOM_CK:' '},['CUSTOM_CK'])).toThrow('CUSTOM_CK');
    expect(()=>sprawdzTrybProby({OMS_TRYB:'proba',META_TOKEN:''},[])).not.toThrow();
    expect(()=>sprawdzTrybProby({OMS_TRYB:'produkcja',META_TOKEN:'x'},[])).not.toThrow();
  });
  it('odmawia przed dostępem do DB także przy samym rdzeniu',async()=>{
    let dotknietoDb=false;
    await expect(zbudujAplikacje({moduly:[modulRdzen] as unknown as ModulOms[],env:{OMS_TRYB:'proba',META_TOKEN:' '},
      get db(): DatabaseSync {dotknietoDb=true;throw Error('Nie wolno otworzyć DB');}})).rejects.toThrow('META_TOKEN');
    expect(dotknietoDb).toBe(false);
  });
  it('odmawia literówki przed DB',async()=>{
    let dotknietoDb=false;
    await expect(zbudujAplikacje({moduly:[modulRdzen] as unknown as ModulOms[],env:{OMS_TRYB:'probba'},
      get db(): DatabaseSync {dotknietoDb=true;throw Error('Nie wolno otworzyć DB');}})).rejects.toThrow('OMS_TRYB');
    expect(dotknietoDb).toBe(false);
  });
  it('zachowuje dokładne poprawne URL i opcjonalny brak',()=>{
    expect(skonfigurowanyUrl(undefined,'URL')).toBeUndefined();
    expect(skonfigurowanyUrl('','URL')).toBeUndefined();
    for(const v of ['http://localhost:3001/path','https://example.invalid/base/'])expect(skonfigurowanyUrl(v,'URL')).toBe(v);
    for(const v of [' ', 'http:example.invalid'])expect(()=>skonfigurowanyUrl(v,'URL')).toThrow('URL');
  });
  for(const [key,min,read] of [
    ['OMS_POLLER_MS',30000,(env:Record<string,string>)=>konfiguracjaKanalow([],env).odstepMs],
    ['OMS_PRZESYLKI_ODSTEP_MS',60000,(env:Record<string,string>)=>modulWysylka.konfiguracja(env).odstepPrzesylekMs],
    ['OMS_PODJAZDY_ODSTEP_MS',60000,(env:Record<string,string>)=>modulWysylka.konfiguracja(env).odstepPodjazdowMs],
  ] as const) {
    it(key+' chroni dolną granicę',()=>expect(()=>read({[key]:String(min-1)})).toThrow(key));
    it(key+' przyjmuje obie dokładne granice',()=>{expect(read({[key]:String(min)})).toBe(min);expect(read({[key]:'2147483647'})).toBe(2147483647);});
    for(const v of ['2147483648','9007199254740992','30000.5','NaN','Infinity','-1','',' '])
      it(key+' odrzuca '+JSON.stringify(v),()=>expect(()=>read({[key]:v})).toThrow(key));
  }
  for(const [key,configure] of [
    ['DPD_URL',wczytajKurierow],['DPD_INFO_URL',wczytajKurierow],['INPOST_URL',wczytajKurierow],
    ['INFAKT_API_URL',(e:Record<string,string>)=>wczytajFaktury({...seller,...e})],
    ['KSEF_API',wczytajKoszty],['GUS_URL',(e:Record<string,string>)=>konfiguracjaZamowien({...seller,...e})],
  ] as const) for(const url of ['/relative','file:///sekret','ftp://secret.invalid','secret-invalid'])
    it(key+' odrzuca nie-http URL bez wartości w błędzie',()=>{
      let message='';try{configure({[key]:url});}catch(e){message=(e as Error).message;}
      expect(message).toContain(key);expect(message).not.toContain(url);
    });
  for(const [typ,key] of [['woo','URL'],['allegro','API'],['allegro','AUTH']] as const)
    it(typ+'_'+key+' sprawdza URL przed aktywacją poświadczeń',()=>{
      expect(()=>konfiguracjaKanalow([{klucz:'demo',typ,prefiks:'P'}],{['P_'+key]:'file:///sekret'})).toThrow('P_'+key);
    });
});
