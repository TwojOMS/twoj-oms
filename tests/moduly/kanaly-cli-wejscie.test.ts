import {it,expect} from 'vitest';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,readFileSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

function uruchom(zmiany:Record<string,string|undefined>={}) {
 const katalog=mkdtempSync(join(tmpdir(),'oms-cli-'));const baza=join(katalog,'oms.sqlite');const spy=join(katalog,'api.txt');
 const env={PATH:process.env.PATH,SystemRoot:process.env.SystemRoot,OMS_TRYB:'produkcja',OMS_DB_PATH:baza,
  OMS_TEST_API_SPY:spy,OMS_KANALY:JSON.stringify([{klucz:'polnoc',typ:'woo',prefiks:'NEUTRALNY_SKLEP'}]),
  NEUTRALNY_SKLEP_URL:'https://polnoc.invalid',NEUTRALNY_SKLEP_CK:'fikcyjny-ck',NEUTRALNY_SKLEP_CS:'fikcyjny-cs',
  NEUTRALNY_SKLEP_HISTORIA_KONTO_APILO:'7',...zmiany};
 const wynik=spawnSync(process.execPath,['--import','./tests/pomoc/cli-api-spy.mjs','src/moduly/kanaly/scripts/import-sklep.mjs',
  '--sklep','polnoc','--od','2025-01-01','--do','2025-12-31','--sonda'],{env,encoding:'utf8'});
 return {wynik,baza,spy,katalog};
}
it('rzeczywisty CLI odmawia próby przed SQLite i API dla neutralnego prefiksu',()=>{
 const r=uruchom({OMS_TRYB:'proba'});
 try{
  expect(r.wynik.status).toBe(1);expect(r.wynik.stderr).toContain('OMS_TRYB=proba');
  expect(r.wynik.stderr).toContain('NEUTRALNY_SKLEP_CK');
  expect(existsSync(r.baza)).toBe(false);expect(readFileSync(r.spy,'utf8')).toBe('0');
 }finally{rmSync(r.katalog,{recursive:true,force:true});}
});
it('CLI odmawia literówki trybu przed SQLite i API',()=>{
 const r=uruchom({OMS_TRYB:'produkcyjny'});
 try{
  expect(r.wynik.status).toBe(1);expect(r.wynik.stderr).toContain('OMS_TRYB: dopuszczalne wartości produkcja lub proba');
  expect(existsSync(r.baza)).toBe(false);expect(readFileSync(r.spy,'utf8')).toBe('0');
 }finally{rmSync(r.katalog,{recursive:true,force:true});}
});
it.each(['CK','CS'])('CLI wymaga %s przed SQLite i API',klucz=>{
 const r=uruchom({[`NEUTRALNY_SKLEP_${klucz}`]:undefined});
 try{
  expect(r.wynik.status).toBe(1);expect(r.wynik.stderr).toContain(`Brak wymaganej zmiennej: NEUTRALNY_SKLEP_${klucz}`);
  expect(existsSync(r.baza)).toBe(false);expect(readFileSync(r.spy,'utf8')).toBe('0');
 }finally{rmSync(r.katalog,{recursive:true,force:true});}
});
it('CLI używa prefiksu z OMS_KANALY, a nie SHOP_<klucz>',()=>{
 const r=uruchom();
 try{
  expect(r.wynik.status,r.wynik.stderr).toBe(0);expect(existsSync(r.baza)).toBe(true);
  expect(Number(readFileSync(r.spy,'utf8'))).toBeGreaterThan(0);expect(r.wynik.stdout).toContain('SONDA');
 }finally{rmSync(r.katalog,{recursive:true,force:true});}
});
