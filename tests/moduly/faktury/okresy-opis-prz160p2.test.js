import {afterEach, expect, it} from 'vitest';
import {openOmsDb} from '../../../src/oms/db/db.ts';
import {zbudujAplikacje} from '../../../src/core/aplikacja.ts';
import {modulyDla} from '../../../src/moduly/lista.ts';
import fs from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';

let a,db,katalog;
afterEach(async()=>{await a?.app.close();db?.close();if(katalog)fs.rmSync(katalog,{recursive:true,force:true});});
const opis='Rozliczenie okresowe jest dla klientów B2B, którzy zamawiają regularnie. Zamiast faktury do każdego zamówienia dostają jedną fakturę za cały miesiąc. Zamówienia klienta z zaznaczonym „Rozliczany zbiorczo” trafiają tu same, a na koniec miesiąca zamykasz okres i wystawiasz jedną fakturę.';
it.each(['proba','produkcja'])('/okresy: opis tylko w próbie (%s)',async tryb=>{
 katalog=fs.mkdtempSync(path.join(tmpdir(),'okresy-opis-prz160p2-'));
 const env={OMS_TRYB:tryb,OMS_KANALY:'[]',OMS_USER:'operator',OMS_PASS:'fixture',OMS_SPRZEDAWCA_NIP:'9990001002',OMS_RACHUNEK:'34109010140000000000000000',OMS_PROFORMY_KATALOG:path.join(katalog,'proformy'),OMS_ETYKIETY_KATALOG:path.join(katalog,'etykiety')};
 db=openOmsDb();a=await zbudujAplikacje({db,env,moduly:modulyDla(env),log:()=>{}});
 const r=await a.app.inject({method:'GET',url:'/okresy',headers:{authorization:'Basic '+Buffer.from('operator:fixture').toString('base64')}});
 expect(r.statusCode).toBe(200);
 if(tryb==='proba'){expect(r.body).toContain(opis);expect(r.body).toMatch(/<p class="pasek-info">Rozliczenie okresowe jest dla klientów B2B,/);}
 else expect(r.body).not.toContain('Rozliczenie okresowe');
});
