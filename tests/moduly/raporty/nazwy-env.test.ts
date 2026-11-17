import {expect,it} from 'vitest';
import {openOmsDb} from '../../../src/oms/db/db.ts';
import {createModulRaporty} from '../../../src/moduly/raporty/modul.ts';
import {createRepozytoriumKanalow} from '../../../src/moduly/kanaly/repozytorium-kanalow.ts';
import {migracjaKanalowSprzedazy} from '../../../src/moduly/kanaly/migracje/0001-kanaly-sprzedazy.ts';

it('nazwa raportu z env wygrywa z podstawionym kluczem, a jawna nazwa z panelu wygrywa z env',()=>{
 const db=openOmsDb();
 try{
  migracjaKanalowSprzedazy.wykonaj(db);
  const definicje=[{klucz:'allegro_polcien',typ:'allegro' as const,prefiks:'POLCIEN',raport:'POLCIEN'}];
  const repo=createRepozytoriumKanalow({db,definicjeEnv:definicje,konfiguracjaEnv:{}});
  const kanaly={get definicje(){return repo.lista().map(k=>({...definicje[0],etykieta:k.nazwa}));}};
  const modul=createModulRaporty(definicje);
  const konfiguracja=modul.konfiguracja({OMS_RAPORTY_NAZWY_KANALOW:'{"POLCIEN":"Pracownia Półcień"}'});
  modul.zbuduj({db,konfiguracja,usluga:()=>kanaly,teraz:()=>new Date('2026-11-03T12:00:00Z'),log:()=>{}} as any);
  expect(konfiguracja.nazwyKanalow.POLCIEN).toBe('Pracownia Półcień');
  expect(repo.zapiszZmiane('allegro_polcien',0,{nazwa:'Nazwa z panelu'},{id:1,login:'admin'}).ok).toBe(true);
  expect(konfiguracja.nazwyKanalow.POLCIEN).toBe('Nazwa z panelu');
 }finally{db.close();}
});
