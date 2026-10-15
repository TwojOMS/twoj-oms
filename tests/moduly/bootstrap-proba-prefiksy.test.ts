import {afterEach,describe,it,expect} from 'vitest';
import {mkdtempSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {zbudujOms} from '../../src/oms/bootstrap.ts';
const katalogi:string[]=[];
afterEach(()=>{for(const p of katalogi.splice(0))rmSync(p,{recursive:true,force:true});});
const definicje=[{klucz:'a',typ:'woo',prefiks:'SKLEP_A'},{klucz:'b',typ:'woo',prefiks:'SKLEP_B'},
 {klucz:'c',typ:'allegro',prefiks:'RYNEK_C'},{klucz:'d',typ:'allegro',prefiks:'RYNEK_D'}];
const klucze=['SKLEP_A_CK','SKLEP_A_CS','SKLEP_B_CK','SKLEP_B_CS',
 'RYNEK_C_CLIENT_ID','RYNEK_C_CLIENT_SECRET','RYNEK_D_CLIENT_ID','RYNEK_D_CLIENT_SECRET'];
describe('bootstrap produkcyjny: próba przed otwarciem SQLite',()=>{
 it.each(klucze)('%s odmawia nawet bez poprawnej konfiguracji, nie tworzy pliku bazy',async klucz=>{
  const katalog=mkdtempSync(join(tmpdir(),'oms-proba-prefix-'));katalogi.push(katalog);const plik=join(katalog,'nie-powstaje.sqlite');
  await expect(zbudujOms({env:{OMS_TRYB:'proba',OMS_KANALY:JSON.stringify(definicje),OMS_DB_PATH:plik,[klucz]:'fixture'}}))
   .rejects.toThrow(new RegExp(`OMS_TRYB=proba[\\s\\S]*${klucz}`));
  expect(existsSync(plik)).toBe(false);
 });
});
