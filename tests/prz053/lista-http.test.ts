import {it,expect} from 'vitest';
import {tmpdir} from 'node:os';
import {zbudujOms} from '../../src/oms/bootstrap.ts';
import {zalozKonto} from '../../src/core/bezpieczenstwo/konta.js';

it('PRZ053: logowanie, rzeczywista lista i powroty dwóch izolowanych konfiguracji',async()=>{
 for(const key of ['allegro_przykladowa','rynek_drugi']){
  const defs=[{klucz:key,typ:'allegro',prefiks:'K',etykieta:'Kanał <syntetyczny>',raport:'MARKET'}, {klucz:'pusty',typ:'woo',prefiks:'P',etykieta:'Bez zamówień',raport:'PUSTY'}];
  const a=await zbudujOms({env:{OMS_SPRZEDAWCA_NIP:'1234563218',OMS_RACHUNEK:'34109010140000000000000000',OMS_USER:'bootstrap',OMS_PASS:'syntetyczne',OMS_PROFORMY_KATALOG:tmpdir(),OMS_ETYKIETY_KATALOG:tmpdir(),OMS_KANALY:JSON.stringify(defs)}});
  try{
   zalozKonto(a.db,{login:'tester',imie:'Test',haslo:'syntetyczne-haslo-053',rola:'admin',admin:true});
   const insert=a.db.prepare('INSERT INTO zamowienia(sklep,zrodlo_id,numer,utworzone_at,kwota_brutto,metoda_wysylki) VALUES(?,?,?,?,?,?)');
   const id=Number(insert.run(key,'1','WLASCIWY-053','2026-10-09T10:00:00','10.00','dpd').lastInsertRowid);
   insert.run('obcy','2','WYKLUCZONY-053','2026-10-09T10:00:00','20.00','dpd');
   const login=await a.app.inject({method:'POST',url:'/login',headers:{origin:'http://localhost','content-type':'application/x-www-form-urlencoded'},payload:'uzytkownik=tester&haslo=syntetyczne-haslo-053&powrot=%2F'});
   expect(login.statusCode).toBe(302);
   const cookie=String(login.headers['set-cookie']).match(/sesja_oms=[^;]+/)![0];
   const headers={cookie};
   const back='/?wszystkie=1&kanal='+key;
   const r=await a.app.inject({url:back,headers});
   expect(r.statusCode,r.body.slice(0,500)).toBe(200);
   expect(r.body).toContain('WLASCIWY-053');expect(r.body).not.toContain('WYKLUCZONY-053');
   expect(r.body).toContain('Kanał &lt;syntetyczny&gt;');expect(r.body).not.toContain('Kanał <syntetyczny>');
   expect(r.body).toContain('Bez zamówień');
   expect(r.body).not.toMatch(/Allegro szkicownia_pl|Allegro AmarkaPL|pro\.szkicownia\.pl/);
   expect(r.body).toContain('powrot='+encodeURIComponent(back));
   const detail=await a.app.inject({url:'/zamowienia/'+id+'?powrot='+encodeURIComponent(back),headers});
   expect(detail.statusCode,detail.body.slice(0,400)).toBe(200);
   expect(detail.body).toContain(key);
   expect(detail.body).toContain('/zamowienia/'+id+'?powrot='+encodeURIComponent(back)); // kanoniczny powrót menu motywu
   const empty=await a.app.inject({url:'/?wszystkie=1&kanal=pusty',headers});
   expect(empty.statusCode).toBe(200);expect(empty.body).not.toContain('WLASCIWY-053');expect(empty.body).not.toContain('WYKLUCZONY-053');
   const mass=await a.app.inject({method:'POST',url:'/zamowienia/masowe/status',headers:{...headers,origin:'http://localhost','content-type':'application/x-www-form-urlencoded'},payload:new URLSearchParams({powrot:back}).toString()});
   expect(mass.statusCode).toBeLessThan(500);
   expect(mass.body+String(mass.headers.location)).toContain(key);
  }finally{await a.app.close();a.db.close();}
 }
});
