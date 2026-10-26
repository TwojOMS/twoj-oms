import { it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';
import { Socket } from 'node:net';
import { zbudujOms } from '../../../src/oms/bootstrap.ts';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { modulRdzen } from '../../../src/moduly/rdzen/modul.ts';
import { modulWeb } from '../../../src/core/web/modul.ts';
import { createModulKanaly } from '../../../src/moduly/kanaly/modul.ts';
import { modulUstawienia } from '../../../src/moduly/ustawienia/modul.ts';
import { modulMarketing } from '../../../src/moduly/marketing/modul.ts';
import * as diagnostyka from '../../../src/oms/services/lacznosc.js';
import type { ModulOms } from '../../../src/core/kontrakty.ts';

const bazoweEnv={OMS_TRYB:'produkcja',OMS_USER:'operator',OMS_PASS:'atrapa',OMS_SPRZEDAWCA_NIP:'1234563218',
  OMS_RACHUNEK:'34109010140000000000000000',OMS_PROFORMY_KATALOG:tmpdir(),OMS_ETYKIETY_KATALOG:tmpdir()};
const envWoo={...bazoweEnv,OMS_KANALY:'[{"klucz":"sklep","typ":"woo","prefiks":"SKLEP"}]',
  SKLEP_URL:'https://sklep.invalid',SKLEP_CK:'atrapa',SKLEP_CS:'atrapa',SKLEP_OD:'2026-01-01',SKLEP_MAPOWANIE:'{"instancje":{},"poPozycji":[]}'};
function blokada(){
  const proby:string[]=[];
  const f=vi.spyOn(globalThis,'fetch').mockImplementation(async()=>{proby.push('fetch');throw Error('Sieć zabroniona');});
  const s=vi.spyOn(Socket.prototype,'connect').mockImplementation(()=>{proby.push('socket');throw Error('Sieć zabroniona');});
  return()=>{try{expect(proby).toEqual([]);}finally{f.mockRestore();s.mockRestore();}};
}
it('pełny produkt przekazuje prawdziwe zdrowie do ostrzeżeń GET strony głównej',async()=>{
  const zakoncz=blokada();const a=await zbudujOms({env:envWoo,teraz:()=>new Date('2026-10-02T10:00:00Z')});
  try{
    a.db.prepare('INSERT INTO stan_pollera(sklep,ostatni_przebieg_at,ostatni_blad,ostatni_blad_od_at,ostatni_blad_rodzaj,ostatni_blad_prob) VALUES(?,?,?,?,?,?)')
      .run('sklep','2026-10-01T10:00:00Z','fixture-awaria','2026-10-01T10:00:00Z','awaria',1);
    expect((await a.app.inject('/health')).json().poller.zrodla[0].zdrowy).toBe(false);
    const r=await a.app.inject({url:'/',headers:{authorization:'Basic '+Buffer.from('operator:atrapa').toString('base64')}});
    expect(r.statusCode,r.body).toBe(200);
    expect(r.body).toContain('Poller sklep nie działa: fixture-awaria');
    expect(r.body).toContain('/ustawienia/lacznosc');
  }finally{await a.app.close();a.db.close();zakoncz();}
});
it('startup normalizuje plikową starą bazę Woo, zachowuje resztę pól i ponawia pominięte',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'prz030-backfill-'));const path=join(dir,'stara.sqlite');
  const zakoncz=blokada();const db=openOmsDb(path);
  const insert=db.prepare('INSERT INTO zamowienia(sklep,zrodlo_id,numer,kwota_brutto,utworzone_at,oplacone_at,surowe_json,uwagi) VALUES(?,?,?,?,?,?,?,?)');
  for(const [id,sklep,surowe,data] of [
    [1,'sklep',{date_created_gmt:'2026-08-01T07:00:00',date_paid_gmt:'2026-08-01T07:05:00'},'2026-08-01T09:00:00'],
    [2,'sklep',{},'2026-08-01T09:00:00'],
    [3,'reczne',{},'2026-08-01'],
    [4,'inny_sklep',{date_created_gmt:'2026-08-01T07:00:00'},'2026-08-01T09:00:00'],
    [5,'sklep',{},'2026-08-01T07:00:00Z'],
  ] as const)insert.run(sklep,id,`F-${id}`,'123.45',data,id===1?'2026-08-01T09:05:00':null,JSON.stringify(surowe),'NIE ZMIENIAĆ');
  db.close();
  // Istniejące uzupełnienia danych są niezależne od brakującego backfillu UTC.
  // Stabilizujemy je przed migawką, aby sprawdzać wyłącznie zmianę dat i niezmienność reszty.
  const stara=openOmsDb(path);
  const przed=stara.prepare('SELECT * FROM zamowienia ORDER BY id').all() as any[];
  expect(przed[0].utworzone_at).toBe('2026-08-01T09:00:00');stara.close();
  const log=vi.fn();let a:Awaited<ReturnType<typeof zbudujOms>>|undefined;
  try{
    a=await zbudujOms({env:{...envWoo,OMS_DB_PATH:path},log});
    const po=a.db.prepare('SELECT * FROM zamowienia ORDER BY id').all() as any[];
    // PRZ-101.04: start modułu zamówień wykonuje migrację zamowienia/3 (scalenia), która dokłada dwie
    // puste kolumny — migawka „przed” to sam rdzeń. Kolumny sprawdzone osobno, reszta pól bez zmian.
    expect(po.every((w)=>w.scalone_do===null&&w.scalenie_json===null)).toBe(true);
    const bezScalen=po.map(({scalone_do:_d,scalenie_json:_j,...w})=>w);
    expect(bezScalen[0]).toEqual({...przed[0],utworzone_at:'2026-08-01T07:00:00Z',oplacone_at:'2026-08-01T07:05:00Z'});
    expect(bezScalen.slice(1)).toEqual(przed.slice(1));
    expect(log).toHaveBeenCalledWith('daty zamowien: znormalizowano 1 wierszy do UTC-Z, 1 POMINIETYCH bez GMT w surowym JSON-ie (obejrzec recznie).');
    await a.app.close();a.db.close();a=undefined;log.mockClear();
    a=await zbudujOms({env:{...envWoo,OMS_DB_PATH:path},log});
    expect(a.db.prepare('SELECT * FROM zamowienia ORDER BY id').all()).toEqual(po);
    expect(log).toHaveBeenCalledWith('daty zamowien: znormalizowano 0 wierszy do UTC-Z, 1 POMINIETYCH bez GMT w surowym JSON-ie (obejrzec recznie).');
  }finally{if(a){await a.app.close();a.db.close();}zakoncz();
    if(dirname(resolve(dir))!==resolve(tmpdir())||!basename(dir).startsWith('prz030-backfill-'))throw Error('Nieprawidłowy katalog własnej fixture');
    rmSync(dir,{recursive:true,force:true});}
});
it.each([
  ['bez integracji',{...bazoweEnv,OMS_KANALY:'[]'},false,false],
  ['tylko Woo',envWoo,false,false],
  ['aktywne Allegro',{...bazoweEnv,OMS_KANALY:'[{"klucz":"rynek","typ":"allegro","prefiks":"RYNEK"}]',
    RYNEK_CLIENT_ID:'atrapa',RYNEK_CLIENT_SECRET:'atrapa',RYNEK_USER_AGENT:'Fixture/1.0 (+https://przyklad.invalid)',RYNEK_OD:'2026-01-01'},true,true],
  ['aktywny DPD',{...envWoo,DPD_URL:'https://dpd.invalid/ws',DPD_LOGIN:'atrapa',DPD_PASSWORD:'atrapa',DPD_FID:'1',
    DPD_INFO_URL:'https://dpd-info.invalid/ws',DPD_INFO_CHANNEL:'atrapa',DPD_NADAWCA_NAZWA:'Fixture',DPD_NADAWCA_ULICA:'Testowa 1',
    DPD_NADAWCA_KOD:'00-001',DPD_NADAWCA_MIASTO:'Test'},false,true],
] as const)('rzeczywisty bootstrap zachowuje null i aktywne usługi śledzenia: %s',async(_nazwa,env,allegro,kurier)=>{
  const zakoncz=blokada();const a=await zbudujOms({env});
  try{
    const paczki=a.usluga<any>('wysylka','przesylkiAllegro');
    const czuwacz=a.usluga<any>('wysylka','czuwaczPrzesylek');
    if(allegro)expect(paczki.odswiez).toBeTypeOf('function');else expect(paczki).toBeNull();
    if(kurier)expect(czuwacz.przebieg).toBeTypeOf('function');else expect(czuwacz).toBeNull();
    expect(a.zegary.some(z=>z.nazwa==='czuwaczPrzesylek')).toBe(kurier);
    // PRZ-117: ponawianie statusów stoi, gdy jest dokąd odsyłać (sklep albo kanał), i tylko wtedy.
    expect(a.zegary.some(z=>z.nazwa==='ponawianieStatusow')).toBe(_nazwa!=='bez integracji');
  }finally{await a.app.close();a.db.close();zakoncz();}
});
it('diagnostyka minimalnej rzeczywistej kompozycji pomija brakujące konfiguracje usług',async()=>{
  const zakoncz=blokada();const pomiar=vi.spyOn(diagnostyka,'sprawdzLacznosc').mockResolvedValue([]);
  const a=await zbudujOms({env:bazoweEnv,moduly:[modulRdzen,modulWeb,createModulKanaly([]),modulMarketing,modulUstawienia] as readonly ModulOms[]});
  try{
    await expect(a.usluga<{sprawdz:()=>Promise<unknown>}>('ustawienia','lacznosc').sprawdz()).resolves.toEqual([]);
    expect(pomiar).toHaveBeenCalledWith({cele:[]});
  }finally{await a.app.close();a.db.close();pomiar.mockRestore();zakoncz();}
});
