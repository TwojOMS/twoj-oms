import { describe,it,expect,vi,afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { zbudujOms } from '../../../src/oms/bootstrap.ts';
const env={OMS_SPRZEDAWCA_NIP:'1234563218',OMS_RACHUNEK:'34109010140000000000000000',
  OMS_USER:'operator',OMS_PASS:'test',OMS_PROFORMY_KATALOG:tmpdir(),OMS_ETYKIETY_KATALOG:tmpdir()};
const headers={authorization:'Basic '+Buffer.from('operator:test').toString('base64'),origin:'http://localhost'};
afterEach(()=>vi.unstubAllGlobals());
describe('PRZ-030 renderer i istniejąca trasa PRZ-020',()=>{
  it('sukces rzeczywistego device flow na fixture: jeden POST, redirect i HTML kanału',async()=>{
    const api=vi.fn(async input=>{
      const url=new URL(String(input));
      expect(url.hostname).toBe('rynek.invalid');
      if(url.pathname==='/oauth/device')return new Response(JSON.stringify({device_code:'device-secret',
        user_code:'TEST-CODE',verification_uri:'https://rynek.invalid/aktywuj',expires_in:600,interval:1}));
      if(url.pathname==='/oauth/token')return new Response(JSON.stringify({access_token:'fixture-access',refresh_token:'fixture-refresh',expires_in:3600}));
      throw Error('Nieoczekiwany fixture URL: '+url.pathname);
    });
    vi.stubGlobal('fetch',api);
    const a=await zbudujOms({env:{...env,OMS_KANALY:JSON.stringify([{klucz:'rynek',typ:'allegro',prefiks:'RYNEK'}]),
      RYNEK_CLIENT_ID:'fikcyjny',RYNEK_CLIENT_SECRET:'fikcyjny',RYNEK_USER_AGENT:'Fixture/1.0 (+https://fixture.invalid)',RYNEK_OD:'2026-01-01',
      RYNEK_AUTH:'https://rynek.invalid/oauth',RYNEK_API:'https://rynek.invalid'}});
    try {
      const r=await a.app.inject({method:'POST',url:'/ustawienia/kanaly/rynek/wiazanie',headers,payload:{}});
      expect(r.statusCode,r.body).toBe(302);
      expect(r.headers.location).toBe('/ustawienia/integracje?zapisano=kanal');
      const html=await a.app.inject({url:r.headers.location,headers});
      expect(html.statusCode,html.body).toBe(200);
      expect(html.body).toContain('Rozpoczęto wiązanie kanału Allegro.');
      expect(html.body).toContain('rynek');
      expect(html.body).not.toContain('device-secret');
      expect(api.mock.calls.filter(([u])=>String(u).endsWith('/device'))).toHaveLength(1);
      expect(a.app.trasyOms.filter(t=>t.metoda==='POST'&&t.url==='/ustawienia/kanaly/:kanal/wiazanie')).toHaveLength(1);
    }finally{await a.app.close();a.db.close();}
  });
  it.each([false,true])('rzeczywisty HTML odmowy, skonfigurowane Allegro=%s',async(wlaczone)=>{
    vi.stubGlobal('fetch',vi.fn(async()=>{throw Error('Sieć zabroniona');}));
    const a=await zbudujOms({env:{...env,...(wlaczone?{OMS_KANALY:JSON.stringify([{klucz:'rynek',typ:'allegro',prefiks:'RYNEK'}]),
      RYNEK_CLIENT_ID:'fikcyjny',RYNEK_CLIENT_SECRET:'fikcyjny',RYNEK_USER_AGENT:'Fixture/1.0 (+https://fixture.invalid)',RYNEK_OD:'2026-01-01'}:{})}});
    try {
      const r=await a.app.inject({method:'POST',url:'/ustawienia/kanaly/nieznany/wiazanie',headers,payload:{}});
      expect(r.statusCode,r.body).toBe(wlaczone?400:503);
      expect(r.headers['content-type']).toContain('text/html');
      expect(r.body).toContain(wlaczone?'Panel nie zna kanału':'Panel nie ma podpiętych kanałów Allegro.');
      expect(r.body).toContain('Integracje');
      expect(r.body).not.toContain('ustawienia.widokIntegracji');
      expect(fetch).not.toHaveBeenCalled();
    }finally{await a.app.close();a.db.close();}
  });
});
