import {afterEach, describe, expect, it} from 'vitest';
import {openOmsDb} from '../../../src/oms/db/db.ts';
import {wykonajMigracje} from '../../../src/core/baza.ts';
import type {ModulOms} from '../../../src/core/kontrakty.ts';
import {migracjaKanalowSprzedazy} from '../../../src/moduly/kanaly/migracje/0001-kanaly-sprzedazy.ts';
import {migracjaDiagnostykiAllegro} from '../../../src/moduly/kanaly/migracje/0002-diagnostyka-allegro.ts';
import {migracjaTypuKanaluISklepow} from '../../../src/moduly/kanaly/migracje/0003-kanaly-typ-sklepy.ts';
import {modulKanaly} from '../../../src/moduly/kanaly/modul.ts';

// PRZ-132.02: 0003 dokłada typ kanału, aplikację Allegro i tabelę sklepów — bez ruszania wierszy z 0001.
const bazy:ReturnType<typeof openOmsDb>[]=[];
afterEach(()=>{for(const db of bazy.splice(0))db.close();});
const modul=(migracje:ModulOms['migracje'])=>({nazwa:'kanaly',migracje} as unknown as ModulOms);
function bazaPo0002(){
 const db=openOmsDb();bazy.push(db);
 wykonajMigracje(db,[modul([migracjaKanalowSprzedazy,migracjaDiagnostykiAllegro])]);
 const wstaw=db.prepare(`INSERT INTO kanaly_sprzedazy(klucz,nazwa,srodowisko,zrodlo,konto_id,login,raport,autoryzacja,pobieranie,od_utc,wersja,generacja,generacja_importu,utworzono_at,zmieniono_at,aktor_id,aktor_login)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
 wstaw.run('allegro_polcien','Pracownia Półcień','produkcja','env','1000001','polcien_test','ALLEGRO_POLCIEN','polaczone','wlaczone','2026-01-01T00:00:00Z',3,1,2,'2026-10-01T10:00:00.000Z','2026-10-02T10:00:00.000Z',1,'administrator');
 wstaw.run('allegro_0123456789abcdef0123456789abcdef','Półcień z panelu','sandbox','panel',null,null,'ALLEGRO_0123456789ABCDEF0123456789ABCDEF','brak','wylaczone','2026-10-31T23:00:00.000Z',1,0,0,'2026-11-01T10:00:00.000Z','2026-11-01T10:00:00.000Z',2,'sprzedaz');
 db.prepare('INSERT INTO kanaly_audit(kanal,operacja,wersja,aktor_id,aktor_login,zmieniono_at) VALUES (?,?,?,?,?,?)').run('allegro_polcien','nazwa',3,1,'administrator','2026-10-02T10:00:00.000Z');
 return db;
}
const wiersze=(db:ReturnType<typeof openOmsDb>)=>db.prepare('SELECT * FROM kanaly_sprzedazy ORDER BY klucz').all() as Record<string,unknown>[];
const schemat=(db:ReturnType<typeof openOmsDb>)=>db.prepare("SELECT type,name,sql FROM sqlite_master WHERE name LIKE 'kanaly%' OR tbl_name LIKE 'kanaly%' ORDER BY type,name").all();
describe('migracja kanaly/0003 — typ kanału, aplikacja Allegro i dane sklepów',()=>{
 it('na bazie z wierszami Allegro (env i panel) zachowuje wszystkie pola, daje typ allegro i aplikację NULL',()=>{
  const db=bazaPo0002();const przed=wiersze(db);const audytPrzed=db.prepare('SELECT * FROM kanaly_audit').all();
  expect(wykonajMigracje(db,[modul([migracjaKanalowSprzedazy,migracjaDiagnostykiAllegro,migracjaTypuKanaluISklepow])]))
   .toEqual([{modul:'kanaly',numer:3,nazwa:'typ kanalu, aplikacja Allegro i dane sklepow',tryb:'wykonana'}]);
  const po=wiersze(db);
  expect(po).toEqual(przed.map(r=>({...r,typ:'allegro',aplikacja:null})));
  expect(db.prepare('SELECT * FROM kanaly_audit').all()).toEqual(audytPrzed);
  expect(db.prepare('SELECT count(*) AS n FROM kanaly_sklepy').get()).toEqual({n:0});
  expect(db.prepare('SELECT typ,aplikacja,count(*) AS n FROM kanaly_sprzedazy GROUP BY 1,2').all()).toEqual([{typ:'allegro',aplikacja:null,n:2}]);
 });
 it('drugie uruchomienie nie zmienia niczego (idempotencja)',()=>{
  const db=bazaPo0002();migracjaTypuKanaluISklepow.wykonaj(db);
  db.prepare("INSERT INTO kanaly_sklepy(klucz,adres,ustawienia_json,zmieniono_at) VALUES ('allegro_polcien','https://sklep-polcien.test','{}','2026-11-01T10:00:00.000Z')").run();
  const s=schemat(db),w=wiersze(db),sk=db.prepare('SELECT * FROM kanaly_sklepy').all();
  migracjaTypuKanaluISklepow.wykonaj(db);
  expect(schemat(db)).toEqual(s);expect(wiersze(db)).toEqual(w);expect(db.prepare('SELECT * FROM kanaly_sklepy').all()).toEqual(sk);
 });
 it('tabela sklepów pilnuje adresu, JSON-u ustawień i istniejącego kanału',()=>{
  const db=bazaPo0002();migracjaTypuKanaluISklepow.wykonaj(db);db.exec('PRAGMA foreign_keys=ON');
  const wstaw=db.prepare('INSERT INTO kanaly_sklepy(klucz,adres,ustawienia_json,zmieniono_at) VALUES (?,?,?,?)');
  wstaw.run('allegro_polcien','https://sklep-polcien.test','{"mapowanie":{"instancje":{},"poPozycji":[]}}','2026-11-01T10:00:00.000Z');
  expect(()=>wstaw.run('allegro_0123456789abcdef0123456789abcdef','https://sklep-polcien.test','{}','2026-11-01T10:00:00.000Z')).toThrow(/UNIQUE/);
  expect(()=>wstaw.run('allegro_0123456789abcdef0123456789abcdef','https://inny-polcien.test','nie-json','2026-11-01T10:00:00.000Z')).toThrow(/CHECK/);
  expect(()=>wstaw.run('woo_brak','https://trzeci-polcien.test','{}','2026-11-01T10:00:00.000Z')).toThrow(/FOREIGN KEY/);
 });
 it('moduł kanałów rejestruje 0003 po 0001 i 0002',()=>{
  expect(modulKanaly.migracje.map(m=>m.numer)).toEqual([1,2,3]);expect(modulKanaly.migracje[2]).toBe(migracjaTypuKanaluISklepow);
 });
});
