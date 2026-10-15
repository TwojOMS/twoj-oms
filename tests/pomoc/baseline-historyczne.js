import {createRequire} from 'node:module';
import {readFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {expect} from 'vitest';
import {openOmsDb} from '../../src/oms/db/db.ts';
const {DatabaseSync}=createRequire(import.meta.url)('node:sqlite');
const baseline=readFileSync(new URL('../../src/moduly/rdzen/migracje/0001-baseline.sql',import.meta.url),'utf8');

/** Zgoda właściciela 2026-09-30: nieoznaczony niepełny schemat odmawia zamiast samonaprawy. */
export function potwierdzOdmoweHistorycznegoSchema(ddl, oczekiwaneNazwy) {
 const katalog=mkdtempSync(join(tmpdir(),'oms-baseline-historyczne-'));const plik=join(katalog,'baza.sqlite');
 try {
  const db=new DatabaseSync(plik);
  try{
   db.exec(baseline);
   db.exec(`INSERT INTO zamowienia(id,sklep,zrodlo_id,numer,kwota_brutto,utworzone_at) VALUES(1,'fixture',1,'TEST-1','123.45','2026-09-01');
    INSERT INTO przesylki(id,zamowienie_id,kurier,status,numer_listu,etykieta_sciezka,etykieta_zpl_sciezka,utworzona_at)
    VALUES(1,1,'dpd','nadana','LIST-M','/etykiety/M.pdf','/etykiety/M.zpl','2026-09-01');`);
   for(const sql of ddl)db.exec(sql);
  }finally{db.close();}
  let blad;
  try{const otwarta=openOmsDb(plik);otwarta.close();}catch(e){blad=e;}
  expect(blad).toBeInstanceOf(Error);
  expect(blad.message).toMatch(/inny schemat niż baseline/);
  // Literalne oczekiwania przypadku; nie wyprowadzamy ich z DDL ani diagnostyki implementacji.
  expect(oczekiwaneNazwy.length).toBeGreaterThan(0);
  for(const nazwa of oczekiwaneNazwy)expect(blad.message).toContain(nazwa);
  const kontrola=new DatabaseSync(plik);
  try{
   expect(kontrola.prepare('SELECT numer,kwota_brutto FROM zamowienia WHERE id=1').get()).toMatchObject({numer:'TEST-1',kwota_brutto:'123.45'});
   expect(kontrola.prepare('SELECT status,numer_listu,etykieta_sciezka,etykieta_zpl_sciezka FROM przesylki WHERE id=1').get())
    .toMatchObject({status:'nadana',numer_listu:'LIST-M',etykieta_sciezka:'/etykiety/M.pdf',etykieta_zpl_sciezka:'/etykiety/M.zpl'});
   expect(kontrola.prepare("SELECT count(*) AS n FROM migracje WHERE modul='rdzen' AND numer=1").get()).toMatchObject({n:0});
  }finally{kontrola.close();}
 }finally{rmSync(katalog,{recursive:true,force:true});}
}
