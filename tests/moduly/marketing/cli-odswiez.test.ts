import {it,expect} from 'vitest';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {join,resolve,dirname,basename} from 'node:path';
import {tmpdir} from 'node:os';
it('CLI odswiez kończy neutralną próbę exit0, zamyka HTTP/DB i nie wykonuje sieci',()=>{
 const katalog=mkdtempSync(join(tmpdir(),'prz028k-cli-'));
 try{
 const env={OMS_TRYB:'proba',OMS_USER:'operator',OMS_PASS:'fixture',OMS_SPRZEDAWCA_NIP:'1234563218',OMS_RACHUNEK:'34109010140000000000000000',OMS_DB_PATH:join(katalog,'oms.sqlite'),OMS_ETYKIETY_KATALOG:katalog,OMS_PROFORMY_KATALOG:katalog,OMS_REKLAMY_SEKRETY_DIR:katalog};
 const r=spawnSync(process.execPath,['--import',new URL('../../pomoc/blokada-sieci-entrypoint.mjs',import.meta.url).href,'scripts/oms-reklamy-odswiez.mjs'],{cwd:process.cwd(),env,encoding:'utf8',timeout:20000});
 expect(r.status,r.stderr).toBe(0);expect(r.signal).toBeNull();expect(r.stdout).toContain('Reklamy: 0 połączeń odczytanych, 0 błędów.');expect(r.stderr).not.toContain('ZABRONIONE');
 }finally{if(dirname(resolve(katalog))!==resolve(tmpdir())||!basename(katalog).startsWith('prz028k-cli-'))throw Error('Niewłaściwy tmp');rmSync(katalog,{recursive:true,force:true});}
});
