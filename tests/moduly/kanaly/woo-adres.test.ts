import {describe,it,expect} from 'vitest';
import {normalizujAdresSklepu} from '../../../src/moduly/kanaly/adres-sklepu.ts';
describe('adres Woo',()=>{
 it('C6: normalizuje brak schematu, HTTP i końcowy ukośnik w obu trybach',()=>{
  // Wyłącznie dane wejściowe zgłoszenia C6; test nie wykonuje połączeń.
  for(const tryb of ['produkcja','proba'])for(const [wejscie,wynik] of [
   ['www.sklep-polcien.test','https://www.sklep-polcien.test'],['sklep-polcien.test/','https://sklep-polcien.test'],['http://sklep-polcien.test','https://sklep-polcien.test'],
  ])expect(normalizujAdresSklepu(wejscie,tryb)).toBe(wynik);
 });
 it.each(['sklep.pl:8080/sciezka','localhost:8080'])('przyjmuje port bez schematu: %s',adres=>{expect(normalizujAdresSklepu(adres,'produkcja')).toBe('https://'+adres);});
 it.each(['javascript:alert(1)','mailto:a@b'])('odrzuca schemat bez ukośników: %s',adres=>{expect(normalizujAdresSklepu(adres,'produkcja')).toBeNull();});
 it('odrzuca dane logowania',()=>{expect(normalizujAdresSklepu('https://user:pass@sklep-polcien.test','produkcja')).toBeNull();});
 it('normalizuje host i odrzuca zapytania i fragmenty',()=>{expect(normalizujAdresSklepu('https://SKLEP-polcien.test/','produkcja')).toBe('https://sklep-polcien.test');expect(normalizujAdresSklepu('https://sklep-polcien.test/?x=1','produkcja')).toBeNull();});
 it.each(['https://sklep.polcien.example/?','https://sklep.polcien.example/#'])('odrzuca pusty separator w %s',(adres)=>{expect(normalizujAdresSklepu(adres,'produkcja')).toBeNull();});
});
