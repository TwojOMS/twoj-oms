import {it,expect} from 'vitest';
import {openOmsDb} from '../../../src/oms/db/db.ts';
import {zapiszPolaczenie,zapiszStan,stanPolaczenia} from '../../../src/oms/db/reklamy.js';
import {createMagazynSekretow} from '../../../src/moduly/marketing/uslugi/reklamy-sekrety.js';
import {tmpdir} from 'node:os';
it('błąd kolejnej próby zachowuje datę ostatniego sukcesu',()=>{
 const db=openOmsDb(':memory:');try{
 const p=zapiszPolaczenie(db,{typ:'ga4',kontoId:'property-test'});
 zapiszStan(db,{polaczenieId:p.id,ostatniaProbaAt:'2026-09-01T00:00:00Z',ostatniSukcesAt:'2026-09-01T00:00:00Z'});
 zapiszStan(db,{polaczenieId:p.id,ostatniaProbaAt:'2026-09-02T00:00:00Z',kodBledu:'NIEDOSTEPNE'});
 expect(stanPolaczenia(db,p.id)).toMatchObject({ostatniaProbaAt:'2026-09-02T00:00:00Z',ostatniSukcesAt:'2026-09-01T00:00:00Z',kodBledu:'NIEDOSTEPNE'});
 }finally{db.close();}
});
it('referencja odrzuca nie-UUID przed dostępem do pliku',()=>{
 const m=createMagazynSekretow({katalog:tmpdir()});
 for(const ref of ['ga4:zwykly-identyfikator','meta:12345678-1234-1234-1234-12345678901z'])expect(()=>m.sciezka(ref)).toThrow('Nieprawidłowa referencja');
});
