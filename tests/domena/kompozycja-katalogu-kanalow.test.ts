import {it,expect} from 'vitest';
import {modulyDla,MODULY} from '../../src/moduly/lista.ts';
const a=[{klucz:'market_a',typ:'allegro',prefiks:'A',raport:'MARKET_A'}];
const b=[{klucz:'market_b',typ:'allegro',prefiks:'B',raport:'MARKET_B'}];
it('kompozycja utrwala jeden katalog także po zmianie wejściowego env',()=>{
 const env={OMS_USER:'test',OMS_PASS:'fixture',OMS_KANALY:JSON.stringify(a)};
 const m=modulyDla(env);
 env.OMS_KANALY=JSON.stringify(b);
 const config=(n:string)=>m.find(x=>x.nazwa===n)!.konfiguracja(env) as any;
 expect(config('kanaly').definicje.map((x:any)=>x.klucz)).toEqual(['market_a']);
 expect(config('web').definicje.map((x:any)=>x.klucz)).toEqual(['market_a']);
 expect([...config('raporty').regulySprzedazy.klasyfikacja.sklepy.keys()]).toEqual(['market_a']);
});
it('statyczny zestaw modułów ma spójny pusty katalog we wszystkich konsumentach',()=>{
 const env={OMS_USER:'test',OMS_PASS:'fixture',OMS_KANALY:JSON.stringify(a)};
 const config=(n:string)=>MODULY.find(x=>x.nazwa===n)!.konfiguracja(env) as any;
 expect(config('kanaly').definicje).toEqual([]);
 expect(config('web').definicje).toEqual([]);
 expect([...config('raporty').regulySprzedazy.klasyfikacja.sklepy]).toEqual([]);
});
