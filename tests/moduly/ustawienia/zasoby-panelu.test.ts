import { it, expect } from 'vitest';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zbudujOms } from '../../../src/oms/bootstrap.ts';
import { uruchomOms } from '../../../src/main.ts';

const envLokalne = () => {
  const dir=mkdtempSync(join(tmpdir(),'prz030-assets-'));
  return {OMS_TRYB:'proba',OMS_USER:'operator',OMS_PASS:'atrapa',OMS_DB_PATH:join(dir,'oms.sqlite'),
    OMS_SPRZEDAWCA_NIP:'1234563218',OMS_RACHUNEK:'34109010140000000000000000',
    OMS_PROFORMY_KATALOG:dir,OMS_ETYKIETY_KATALOG:dir,OMS_KANALY:'[]'};
};
it('wspólny panel udostępnia favicony i wykonywalny komponer',async()=>{
  const wynik=await zbudujOms({env:envLokalne()});
  try {
    const headers={authorization:`Basic ${Buffer.from('operator:atrapa').toString('base64')}`};
    for(const path of ['/public/favicon-32.png','/public/favicon-192.png','/public/komponer.js']) {
      const r=await wynik.app.inject({method:'GET',url:path,headers});
      expect(r.statusCode,path).toBe(200);
      expect(r.rawPayload.length,path).toBeGreaterThan(100);
      expect(r.headers['content-type'],path).toContain(path.endsWith('.png')?'image/png':'javascript');
    }
  }finally{await wynik.app.close();wynik.db.close();}
});
it('główne uruchomienie odmawia próby z kluczem przed utworzeniem DB',async()=>{
  const env={...envLokalne(),INFAKT_API_KEY:'atrapa',OMS_PORT:'0'};
  await expect(uruchomOms(env,'127.0.0.1')).rejects.toThrow(/pr[oó]b/i);
  expect(existsSync(env.OMS_DB_PATH)).toBe(false);
});
