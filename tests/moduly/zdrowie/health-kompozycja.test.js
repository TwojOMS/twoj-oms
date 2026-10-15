import { describe,it,expect,vi,afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { zbudujOms } from '../../../src/oms/bootstrap.ts';
import { ocenZdrowie } from '../../../src/domena/zdrowie.js';
import { lukiKsef, poTerminie } from '../../../src/oms/db/ostrzezenia.js';
import { zapiszTokeny } from '../../../src/oms/db/tokeny.js';
const env={OMS_SPRZEDAWCA_NIP:'1234563218',OMS_RACHUNEK:'34109010140000000000000000',
  OMS_USER:'operator',OMS_PASS:'test',OMS_PROFORMY_KATALOG:tmpdir(),OMS_ETYKIETY_KATALOG:tmpdir()};
afterEach(()=>vi.unstubAllGlobals());
describe('PRZ-030 health dostępnych usług przez bootstrap',()=>{
  it('czyta prawdziwy poller: krótka awaria nie alarmuje, trwała alarmuje; wyłączone źródło znika',async()=>{
    vi.stubGlobal('fetch',vi.fn(async()=>{throw Error('Sieć zabroniona');}));
    let chwila=new Date('2026-10-01T12:00:00Z');
    const a=await zbudujOms({env:{...env,OMS_KANALY:JSON.stringify([{klucz:'rynek',typ:'allegro',prefiks:'RYNEK'}]),
      RYNEK_CLIENT_ID:'fikcyjny',RYNEK_CLIENT_SECRET:'fikcyjny',RYNEK_USER_AGENT:'Fixture/1.0 (+https://fixture.invalid)',RYNEK_OD:'2026-01-01'},teraz:()=>chwila});
    try {
      zapiszTokeny(a.db,'rynek',{accessToken:'NIE-UJAWNIAJ-ACCESS',refreshToken:'NIE-UJAWNIAJ-REFRESH',
        wygasaAt:'2099-01-01',refreshWygasaAt:'2099-01-01'});
      a.db.prepare('INSERT INTO stan_pollera(sklep,ostatni_przebieg_at,ostatni_blad,ostatni_blad_od_at,ostatni_blad_rodzaj,ostatni_blad_prob) VALUES(?,?,?,?,?,?)')
        .run('rynek',chwila.toISOString(),'fetch failed',chwila.toISOString(),'awaria',1);
      a.db.prepare('INSERT INTO stan_pollera(sklep,ostatni_blad) VALUES(?,?)').run('wylaczony','fetch failed');
      const odpowiedz=await a.app.inject('/health');
      for(const token of ['NIE-UJAWNIAJ-ACCESS','NIE-UJAWNIAJ-REFRESH','access_token','refresh_token'])expect(odpowiedz.body).not.toContain(token);
      const mlody=odpowiedz.json();
      expect(mlody.kanaly[0].pilne).toBe(false);
      a.db.prepare('UPDATE tokeny_kanalu SET ostatni_blad=? WHERE kanal=?').run('invalid_grant','rynek');
      const poAwarii=(await a.app.inject('/health')).json();
      expect(poAwarii.kanaly[0].pilne).toBe(true);
      expect(mlody.poller.zrodla.map(x=>x.zrodlo)).toEqual(['rynek']);
      expect(mlody.alarmy.some(x=>x.includes('poller rynek'))).toBe(false);
      chwila=new Date('2026-10-01T12:11:00Z');
      const trwaly=(await a.app.inject('/health')).json();
      expect(trwaly.alarmy.some(x=>x.includes('poller rynek'))).toBe(true);
      expect(fetch).not.toHaveBeenCalled();
    }finally{await a.app.close();a.db.close();}
  });
  it('prawdziwy czuwacz pisze oba lustra i wspólny puls; błąd nie zalicza sukcesu',async()=>{
    vi.stubGlobal('fetch',vi.fn(async()=>{throw Error('Sieć zabroniona');}));
    let blad=false;let chwila=new Date('2026-10-01T12:00:00Z');
    const log=vi.fn();
    const a=await zbudujOms({env,teraz:()=>chwila,log,nadpisania:{
      'faktury.infakt':{listaFaktur:async()=>{if(blad)throw Error('fixture-awaria');return [{uuid:'luka',number:'TEST/1',invoice_date:'2026-09-01',ksef_number:null,client_tax_code:'1234563218',rodzaj:'vat'}];}},
      'faktury.fakturyWidok':{nieoplacone:async()=>[{uuid:'dlug',number:'TEST/2',payment_date:'2026-09-01',left_to_pay:9900,stanTerminu:'po_terminie'}]},
    }});
    try {
      const zegar=a.zegary.find(x=>x.nazwa==='czuwaczOstrzezen');
      expect(zegar).toBeTruthy();
      await zegar.przebieg();
      expect(lukiKsef(a.db).map(x=>x.uuid)).toEqual(['luka']);
      expect(poTerminie(a.db).map(x=>x.uuid)).toEqual(['dlug']);
      const puls=a.usluga('faktury','puls');
      expect(puls.stan().czuwaczOstrzezen.okAt).toBeTruthy();
      const okAt=puls.stan().czuwaczOstrzezen.okAt;
      const poSukcesie=(await a.app.inject('/health')).json();
      expect(poSukcesie.czuwaczOstrzezen.okAt).toBe(okAt);
      expect(poSukcesie.czuwaczOstrzezen.zdrowy).toBe(true);
      chwila=new Date('2026-10-01T16:00:00Z');
      const stary=(await a.app.inject('/health')).json();
      expect(stary.czuwaczOstrzezen.zdrowy).toBe(false);
      expect(stary.czuwaczOstrzezen.wiekS).toBe(4*3600);
      blad=true;await expect(zegar.przebieg()).resolves.toBeUndefined();
      expect(log).toHaveBeenCalledWith('czuwacz ostrzeżeń:', 'luki KSeF: fixture-awaria');
      expect(puls.stan().czuwaczOstrzezen.okAt).toBe(okAt);
      expect(puls.stan().czuwaczOstrzezen.blad).toContain('fixture-awaria');
      const poBledzie=(await a.app.inject('/health')).json();
      expect(poBledzie.czuwaczOstrzezen.bladSwiezszy).toBe(true);
      expect(poBledzie.czuwaczOstrzezen.blad).toContain('fixture-awaria');
      expect(lukiKsef(a.db).map(x=>x.uuid)).toEqual(['luka']);
      expect(fetch).not.toHaveBeenCalled();
    }finally{await a.app.close();a.db.close();}
  });
  it('GET bez uwierzytelnienia: frozen JSON, no-store, bez sieci i sekretów',async()=>{
    vi.stubGlobal('fetch',vi.fn(async()=>{throw Error('Sieć zabroniona');}));
    const teraz=()=>new Date('2026-10-01T12:00:00Z');
    const a=await zbudujOms({env,teraz});
    try {
      const r=await a.app.inject('/health');
      expect(r.statusCode,r.body).toBe(200);
      expect(r.headers['cache-control']).toBe('no-store');
      expect(r.json()).toEqual(ocenZdrowie({teraz:teraz(),startAt:teraz(),zrodla:[],stanyPollera:[],kanaly:[]}));
      for(const secret of [env.OMS_PASS,'hash_hasla','sekret_sesji','access_token','refresh_token'])expect(r.body).not.toContain(secret);
      expect(fetch).not.toHaveBeenCalled();
    }finally{await a.app.close();a.db.close();}
  });
  it('tylko GET jest otwarty — HEAD/POST/PUT/DELETE nie mają trasy',async()=>{
    const a=await zbudujOms({env});
    try {for(const method of ['HEAD','POST','PUT','DELETE']){
      expect(a.app.hasRoute({method,url:'/health'})).toBe(false);
      const r=await a.app.inject({method,url:'/health',headers:{origin:'http://localhost'}});
      expect(r.statusCode).toBe(404);
    }}finally{await a.app.close();a.db.close();}
  });
});
