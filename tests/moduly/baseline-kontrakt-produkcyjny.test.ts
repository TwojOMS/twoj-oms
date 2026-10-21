import { afterEach, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openOmsDb } from '../../src/oms/db/db.ts';
import { zapiszTokeny, wczytajTokeny } from '../../src/oms/db/tokeny.js';
import { pobierzZamowienie } from '../../src/oms/db/zamowienia.js';
import { pozycjeDokumentu } from '../../src/domena/pozycje-faktury.js';
import { wczytajSprzedawce } from '../../src/core/sprzedawca.ts';

const sql=readFileSync(new URL('../../src/moduly/rdzen/migracje/0001-baseline.sql',import.meta.url),'utf8');
const {DatabaseSync}=createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
const katalogi:string[]=[];
afterEach(()=>{for(const p of katalogi.splice(0))rmSync(p,{recursive:true,force:true});});
function staraBaza(){
  const p=mkdtempSync(join(tmpdir(),'baseline-kontrakt-'));katalogi.push(p);
  const plik=join(p,'fixture.sqlite');const db=new DatabaseSync(plik);db.exec(sql);
  db.exec(`INSERT INTO zamowienia (id,sklep,zrodlo_id,numer,kwota_brutto,koszt_dostawy_brutto,koszt_dostawy_netto,utworzone_at)
    VALUES (1,'fixture',1,'TEST-1','112.30','12.30','10.00','2026-09-01');
    INSERT INTO pozycje (zamowienie_id,nazwa,ilosc,cena_brutto,brutto_linii) VALUES (1,'Test',3,'33.33','100.00');`);
  // Wyłącznie fikcyjne wartości. Nigdy odczyt prawdziwych poświadczeń.
  zapiszTokeny(db,'fixture',{accessToken:'fixture-access',refreshToken:'fixture-refresh',wygasaAt:'2030-01-01',refreshWygasaAt:'2031-01-01'});
  return {db,plik};
}

const scenariusze=[
  ['tokeny','DROP TABLE tokeny_kanalu','tokeny_kanalu'],
  ['dostawa','ALTER TABLE zamowienia DROP COLUMN koszt_dostawy_brutto','koszt_dostawy_brutto'],
  ['suma linii','ALTER TABLE pozycje DROP COLUMN brutto_linii','brutto_linii'],
  ['kolumny faktury: obecność','ALTER TABLE faktury DROP COLUMN ksef_numer','ksef_numer'],
  ['kolumny faktury: zapis','ALTER TABLE faktury DROP COLUMN allegro_invoice_id','allegro_invoice_id'],
  ['kolumny faktury: reopen','ALTER TABLE faktury DROP COLUMN allegro_wyslana_at','allegro_wyslana_at'],
  ['kolumny faktury: odczyt','ALTER TABLE faktury DROP COLUMN ksef_odczyt','ksef_odczyt'],
  ['proformy','DROP TABLE proformy','proformy'],
  ['podjazdy','ALTER TABLE przesylki DROP COLUMN przejeta_at','przejeta_at'],
  ['dane ręczne','ALTER TABLE zamowienia DROP COLUMN dostawa_reczna_json','dostawa_reczna_json'],
] as const;
describe('produkcja: nieoznaczona baza wymaga zgodności baseline',()=>{
  it.each(scenariusze)('%s: odmawia z nazwą różnicy i zachowuje dane',(_opis,ddl,brak)=>{
    const {db,plik}=staraBaza();db.exec(ddl);db.close();
    expect(()=>{const otwarta=openOmsDb(plik);otwarta.close();}).toThrow(new RegExp(`inny schemat niż baseline[\\s\\S]*${brak}`));
    const kontrola=new DatabaseSync(plik);
    try {
      expect(kontrola.prepare('SELECT numer,kwota_brutto FROM zamowienia WHERE id=1').get()).toMatchObject({numer:'TEST-1',kwota_brutto:'112.30'});
      expect(kontrola.prepare("SELECT count(*) AS n FROM migracje WHERE modul='rdzen' AND numer=1").get()).toMatchObject({n:0});
    } finally {kontrola.close();}
  });
});
describe('produkcja: wspierany baseline i poprawne reopen',()=>{
  it('pierwsze oznaczenie i kolejne otwarcie zachowują parę tokenów oraz kwoty dokumentu',()=>{
    const {db,plik}=staraBaza();db.close();
    for(let i=0;i<2;i++){
      const otwarta=openOmsDb(plik);
      try {
        expect(wczytajTokeny(otwarta,'fixture')).toMatchObject({access_token:'fixture-access',refresh_token:'fixture-refresh'});
        const z=pobierzZamowienie(otwarta,1)!;
        expect(z).toMatchObject({kwota_brutto:'112.30',koszt_dostawy_brutto:'12.30'});
        expect(z.pozycje[0]).toMatchObject({brutto_linii:'100.00',cena_brutto:'33.33',ilosc:3});
        expect(pozycjeDokumentu(z, { stawkaDomyslna: '23' }).map((p:{gross_price:number})=>p.gross_price)).toEqual([10000,1230]);
        expect(otwarta.prepare("SELECT count(*) AS n FROM migracje WHERE modul='rdzen' AND numer=1").get()).toMatchObject({n:1});
      } finally {otwarta.close();}
    }
  });
});
describe('produkcja: jawna konfiguracja sprzedawcy',()=>{
  const env={OMS_SPRZEDAWCA_NIP:'1234563218',OMS_RACHUNEK:'34109010140000000000000000',OMS_BANK:'Fixture'};
  it('przyjmuje poprawne jawne wartości',()=>expect(wczytajSprzedawce(env)).toMatchObject({nip:env.OMS_SPRZEDAWCA_NIP,rachunek:env.OMS_RACHUNEK,bank:'Fixture'}));
  it('odmawia błędnego NRB dawnego testu',()=>expect(()=>wczytajSprzedawce({...env,OMS_RACHUNEK:'PL99'})).toThrow('OMS_RACHUNEK'));
  it('odmawia NIP bez poprawnej sumy kontrolnej',()=>expect(()=>wczytajSprzedawce({...env,OMS_SPRZEDAWCA_NIP:'1234563219'})).toThrow('OMS_SPRZEDAWCA_NIP'));
});
