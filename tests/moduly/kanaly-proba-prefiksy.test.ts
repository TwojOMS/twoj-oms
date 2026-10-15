import {describe,it,expect,vi} from 'vitest';
import type {DatabaseSync} from 'node:sqlite';
import {createModulKanaly} from '../../src/moduly/kanaly/modul.ts';
import {zbudujAplikacje} from '../../src/core/aplikacja.ts';

const definicje=[
 {klucz:'polnoc',typ:'woo',prefiks:'SKLEP_POLNOC'},
 {klucz:'poludnie',typ:'woo',prefiks:'SKLEP_POLUDNIE'},
 {klucz:'wschod',typ:'allegro',prefiks:'RYNEK_WSCHOD'},
 {klucz:'zachod',typ:'allegro',prefiks:'RYNEK_ZACHOD'},
] as const;
// Oczekiwania literalne i niezależne od kluczeKanalu/deklaracji implementacji.
const oczekiwane=['SKLEP_POLNOC_CK','SKLEP_POLNOC_CS','SKLEP_POLUDNIE_CK','SKLEP_POLUDNIE_CS',
 'RYNEK_WSCHOD_CLIENT_ID','RYNEK_WSCHOD_CLIENT_SECRET','RYNEK_ZACHOD_CLIENT_ID','RYNEK_ZACHOD_CLIENT_SECRET'];
describe('próba: dwa neutralne sklepy i dwa konta Allegro',()=>{
 it('manifest przejmuje każdy rzeczywisty skonfigurowany prefiks',()=>{
  expect(createModulKanaly(definicje).kluczeIntegracji).toEqual(oczekiwane);
 });
 it.each(oczekiwane)('%s blokuje skład zanim konfiguracja albo SQL zacznie działać',async klucz=>{
  const kanal=createModulKanaly(definicje);
  const konfiguracja=vi.fn(()=>{throw Error('NIE WOLNO wejść w konfigurację');});
  const budowa=vi.fn(()=>{throw Error('NIE WOLNO budować integracji');});
  const sql=vi.fn(()=>{throw Error('NIE WOLNO wejść w SQL');});
  const db=new Proxy({},{get:()=>sql}) as DatabaseSync;
  const rdzen={nazwa:'rdzen',wersja:'1.0.0',wymaga:[],migracje:[],menu:[],uprawnienia:[],konfiguracja,zbuduj:()=>({})};
  await expect(zbudujAplikacje({moduly:[rdzen,{...kanal,konfiguracja,zbuduj:budowa}],env:{OMS_TRYB:'proba',[klucz]:'fixture-secret'},db}))
   .rejects.toThrow(new RegExp(`OMS_TRYB=proba[\\s\\S]*${klucz}`));
  expect(konfiguracja).not.toHaveBeenCalled();expect(sql).not.toHaveBeenCalled();expect(budowa).not.toHaveBeenCalled();
 });
});
