import {describe,it,expect} from 'vitest';
import {parsujFiltry,kanalyDoFiltra,bezpiecznyPowrotNaListe,filtrujFiltrami} from '../../src/domena/filtry-listy.js';
import {adresKanalu} from '../../src/domena/kanaly.js';
import {kanalOms,kanalHistoryczny} from '../../src/domena/kanaly-raportowe.js';
import {definicjeKanalow,konfiguracjaKanalow} from '../../src/moduly/kanaly/konfiguracja.ts';
import {wczytajRaporty} from '../../src/moduly/raporty/konfiguracja.ts';

const a=[{klucz:'allegro_zetaklient',typ:'allegro',prefiks:'K',etykieta:'Zetaklient <demo>',raport:'SKLEP_A'}, {klucz:'pusty',typ:'woo',prefiks:'P',etykieta:'Pusty sklep',raport:'SKLEP_P'}];
const b=[{klucz:'market_inny',typ:'allegro',prefiks:'M',etykieta:'Inny market',raport:'SKLEP_B'}];
const env=(d,h={konta:[]})=>({OMS_KANALY:JSON.stringify(d),OMS_HISTORIA_KLASYFIKACJA:JSON.stringify(h)});
describe('PRZ053 jawne kanały',()=>{
 it.each([{d:a},{d:b}])('przyjmuje skonfigurowany klucz i filtruje właściwe rekordy', ({d})=>{
  const f=parsujFiltry({kanal:d[0].klucz},d);
  expect(f.kanal).toBe(d[0].klucz);
  expect(filtrujFiltrami([{id:1,sklep:d[0].klucz},{id:2,sklep:'obcy'}],f).map(z=>z.id)).toEqual([1]);
  expect(kanalyDoFiltra(d)).toContainEqual({klucz:d[0].klucz,etykieta:d[0].etykieta});
  expect(adresKanalu(d[0].klucz,d)).toBe(d[0].etykieta);
 });
 it('pokazuje kanał bez zamówień i izoluje A/B/A',()=>{
  expect(kanalyDoFiltra(a).map(x=>x.klucz)).toEqual(['allegro_zetaklient','pusty','reczne','indywidualne']);
  expect(kanalyDoFiltra(b).map(x=>x.klucz)).toEqual(['market_inny','reczne','indywidualne']);
  expect(kanalyDoFiltra(a)[0].etykieta).toBe('Zetaklient <demo>');
  expect(JSON.stringify(kanalyDoFiltra([]))).not.toMatch(/szkicownia|amarka/i);
 });
 it('zachowuje bezpieczny powrót i odrzuca obcy kanał',()=>{
  expect(bezpiecznyPowrotNaListe('/?wszystkie=1&kanal=allegro_zetaklient',a)).toBe('/?wszystkie=1&kanal=allegro_zetaklient');
  expect(bezpiecznyPowrotNaListe('//example.invalid/?kanal=pusty',a)).toBe('/');
  expect(bezpiecznyPowrotNaListe('/?kanal=pusty&kanal=pusty',a)).toBe('/');
  expect(parsujFiltry({kanal:'allegro_szkicownia'},a).kanal).toBeNull();
 });
 it('wymaga jawnego katalogu, także dla pustego query',()=>{
  expect(()=>parsujFiltry({})).toThrow(TypeError);
  expect(()=>kanalyDoFiltra()).toThrow(TypeError);
  expect(()=>adresKanalu('pro')).toThrow(TypeError);
  expect(()=>bezpiecznyPowrotNaListe('/')).toThrow(TypeError);
 });
 it('definicje są źródłem listy również gdy połączenie jest niekompletne',()=>{
  const d=definicjeKanalow(env(a));
  expect(konfiguracjaKanalow(d,env(a),true).definicje).toEqual(a);
 });
 it('odmawia kluczy zastrzeżonych i niepoprawnych etykiet',()=>{
  for(const patch of [{klucz:'reczne'},{klucz:'indywidualne'},{etykieta:''},{etykieta:12},{raport:''}])
   expect(()=>definicjeKanalow(env([{...a[0],...patch}]))).toThrow();
 });
 it.each([{d:a},{d:b}])('raport klasyfikuje z konfiguracji bez zgadywania nazwy',({d})=>{
  const reguly=wczytajRaporty(env(d)).regulySprzedazy;
  expect(kanalOms({sklep:d[0].klucz},reguly.klasyfikacja)).toBe(d[0].raport);
  expect(()=>kanalOms({sklep:'obcy'},reguly.klasyfikacja)).toThrow(/nieznany sklep/);
 });
 it('historia zachowuje jawne wygaszone konto i pierwszeństwa',()=>{
  const h={konta:[{konto:91,raport:'ARCHIWUM'},{konto:21,raport:'RECZNE'},{konto:12,raport:'B2B'}],tagDrop:6,tagGdd:9,tagB2b:3,kontaB2b:[12],prefiksyIndywidualne:['28040|']};
  const c=wczytajRaporty(env(a,h)).regulySprzedazy.klasyfikacja;
  expect(kanalHistoryczny({platform_account_id:91},c)).toBe('ARCHIWUM');
  expect(kanalHistoryczny({platform_account_id:12,tagi:[6,9,3]},c)).toBe('DROPSHIPPING');
  expect(kanalHistoryczny({platform_account_id:21,tagi:[9,3]},c)).toBe('GDD');
  expect(kanalHistoryczny({platform_account_id:21},c)).toBe('RECZNE');
  expect(kanalHistoryczny({platform_account_id:21,pozycje:[{original_code:'28040|1'}]},c)).toBe('INDYWIDUALNE');
  expect(kanalOms({sklep:'reczne',b2b:1,okres_rozliczeniowy_id:2},c)).toBe('DROPSHIPPING');
  expect(kanalOms({sklep:'reczne',b2b:1},c)).toBe('B2B');
  expect(()=>kanalHistoryczny({platform_account_id:3},c)).toThrow(/nieznane konto/);
 });
 it('niepełne mapowanie nie przywraca firmy',()=>{
  const c=wczytajRaporty(env([{klucz:'nowy',typ:'woo',prefiks:'N'}])).regulySprzedazy.klasyfikacja;
  expect(()=>kanalOms({sklep:'nowy'},c)).toThrow(/nieznany sklep/);
  expect(()=>kanalOms({sklep:'szkicownia'},c)).toThrow(/nieznany sklep/);
  expect(()=>kanalOms({sklep:'reczne'})).toThrow(TypeError);
 });
});
