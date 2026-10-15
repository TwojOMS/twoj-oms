import {it,expect} from 'vitest';
import {tmpdir} from 'node:os';
import {zbudujOms} from '../../../src/oms/bootstrap.ts';
import {wczytajUstawienia} from '../../../src/oms/db/ustawienia.js';
import {domyslnaPaczka} from '../../../src/domena/ustawienia-panelu.js';
const env={OMS_SPRZEDAWCA_NIP:'1234563218',OMS_RACHUNEK:'34109010140000000000000000',
  OMS_USER:'operator',OMS_PASS:'test',OMS_PROFORMY_KATALOG:tmpdir(),OMS_ETYKIETY_KATALOG:tmpdir()};
const headers={authorization:'Basic '+Buffer.from('operator:test').toString('base64'),origin:'http://localhost'};
it('rzeczywisty ekran wysyłki czyta paczkę z DB i jego zapis zmienia tę samą domyślną paczkę',async()=>{
  const a=await zbudujOms({env});
  try{
    const r=await a.app.inject({method:'POST',url:'/ustawienia/paczka',headers,
      payload:{waga:'2',dlugosc:'30',szerokosc:'20',wysokosc:'10'}});
    expect(r.statusCode,r.body).toBe(302);
    expect(r.headers.location).toBe('/ustawienia/zamowienia-i-wysylka?zapisano=paczka');
    expect(domyslnaPaczka(wczytajUstawienia(a.db))).toEqual({waga:2,dlugosc:30,szerokosc:20,wysokosc:10});
    const html=await a.app.inject({url:r.headers.location,headers});
    expect(html.statusCode,html.body).toBe(200);
    expect(html.body).toContain('Zapisano domyślną paczkę.');
    expect(html.body).toContain('name="waga" value="2"');
    expect(html.body).toContain('action="/wyloguj"');
    const bledna=await a.app.inject({method:'POST',url:'/ustawienia/paczka',headers,
      payload:{waga:'-1',dlugosc:'30',szerokosc:'20',wysokosc:'10'}});
    expect(bledna.statusCode,bledna.body).toBe(400);
    expect(domyslnaPaczka(wczytajUstawienia(a.db)).waga).toBe(2);
  }finally{await a.app.close();a.db.close();}
});
