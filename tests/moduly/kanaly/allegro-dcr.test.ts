import {afterEach,describe,it,expect} from 'vitest';
import {openOmsDb} from '../../../src/oms/db/db.ts';
import {createAplikacjaAllegro} from '../../../src/moduly/kanaly/services/aplikacja-allegro.ts';
import {zarejestrujInstalacje} from '../../../src/oms/allegro/dcr.ts';
const bazy:ReturnType<typeof openOmsDb>[]=[];afterEach(()=>{for(const db of bazy.splice(0))db.close();});
const redirectUri='http://192.168.0.33:3005/ustawienia/integracje/allegro/oauth/powrot';
const input={kod:'KOD-DCR-WABIK',softwareStatementId:'ssi-atrapa',clientName:'TwojOMS test-123',redirectUri,srodowisko:'produkcja' as const};
const response=(body:any={})=>Response.json({client_id:'id-atrapa',client_secret:'SEKRET-DCR-WABIK',client_name:input.clientName,redirect_uris:[redirectUri],software_statement_id:'ssi-atrapa',grant_types:['authorization_code','refresh_token'],...body},{status:201});
function setup(http:Parameters<typeof createAplikacjaAllegro>[0]['http'],ssi='ssi-atrapa'){const db=openOmsDb();bazy.push(db);return {db,app:createAplikacjaAllegro({db,softwareStatementId:ssi,redirectUri,http})};}
describe('DCR aplikacji instalacji',()=>{
 it('wysyła przypięty kontrakt do właściwego hosta, bez ręcznych kluczy',async()=>{
  const calls:any[]=[];const w=await zarejestrujInstalacje(input,async(url,init)=>{calls.push({url,method:init?.method,body:JSON.parse(String(init?.body))});return response();});
  expect(w.ok).toBe(true);expect(calls).toEqual([{url:'https://api.allegro.pl/register',method:'POST',body:{code:'KOD-DCR-WABIK',client_name:'TwojOMS test-123',redirect_uris:[redirectUri],software_statement_id:'ssi-atrapa'}}]);
 });
 it('zapisuje aplikację atomowo; kolejne konta i restart używają tej samej aplikacji',async()=>{
  let calls=0;const http=async(_u:string,i?:RequestInit)=>{calls++;const d=JSON.parse(String(i?.body));return response({client_name:d.client_name});};
  const {db,app}=setup(http);expect(await app.zarejestruj('kod-1','produkcja')).toEqual({ok:true,dane:{gotowa:true}});
  expect(await app.zarejestruj('kod-2','produkcja')).toEqual({ok:true,dane:{gotowa:true}});expect(calls).toBe(1);
  const a=app.aplikacjaDlaInstalacji('produkcja');expect(a).toMatchObject({clientId:'id-atrapa',clientSecret:'SEKRET-DCR-WABIK',redirectUri});expect(a?.clientName).toMatch(/^TwojOMS [a-f0-9]{32}$/);
  const restart=createAplikacjaAllegro({db,softwareStatementId:'ssi-atrapa',redirectUri,http});expect(restart.aplikacjaDlaInstalacji('produkcja')).toEqual(a);expect(await restart.zarejestruj('kod-3','produkcja')).toEqual({ok:true,dane:{gotowa:true}});expect(calls).toBe(1);
 });
 it('dwa kliknięcia i dwie instancje usługi rejestrują aplikację raz',async()=>{
  let calls=0;let resolve!:(r:Response)=>void;let body:any;const gate=new Promise<Response>(r=>{resolve=r;});
  const http=async(_u:string,i?:RequestInit)=>{calls++;body=JSON.parse(String(i?.body));return gate;};const {db,app}=setup(http);const other=createAplikacjaAllegro({db,softwareStatementId:'ssi-atrapa',redirectUri,http});
  const p=app.zarejestruj('kod','produkcja'),q=other.zarejestruj('kod','produkcja');await Promise.resolve();resolve(response({client_name:body?.client_name}));expect((await p).ok).toBe(true);expect((await q).ok).toBe(true);expect(calls).toBe(1);
 });
 it('brak SSI nie wykonuje HTTP',async()=>{let calls=0;const {app}=setup(async()=>{calls++;return response();},'');expect(await app.zarejestruj('kod','produkcja')).toMatchObject({ok:false,kod:'brak_dostepu'});expect(calls).toBe(0);});
 it.each([403,422,429,500])('błąd HTTP %s nie odbija kodu ani sekretów',async status=>{const w=await zarejestrujInstalacje(input,async()=>Response.json({error_description:'KOD-DCR-WABIK SEKRET-DCR-WABIK'},{status}));expect(w.ok).toBe(false);expect(JSON.stringify(w)).not.toMatch(/KOD-DCR-WABIK|SEKRET-DCR-WABIK/);});
 it('niejednoznacznego timeoutu nie ponawia, także po restarcie',async()=>{
  let calls=0;const http=async()=>{calls++;throw Error('KOD-DCR-WABIK');};const {db,app}=setup(http);const w=await app.zarejestruj('KOD-DCR-WABIK','produkcja');expect(w).toMatchObject({ok:false,kod:'niejednoznaczny'});
  const restart=createAplikacjaAllegro({db,softwareStatementId:'ssi-atrapa',redirectUri,http});expect(await restart.zarejestruj('drugi','produkcja')).toMatchObject({ok:false,kod:'niejednoznaczny'});expect(calls).toBe(1);expect(JSON.stringify(w)).not.toContain('KOD-DCR-WABIK');
 });
 it('nie akceptuje odpowiedzi z innym callbackiem ani bez refresh grant',async()=>{
  for(const body of [{redirect_uris:['https://obcy.invalid/callback']},{grant_types:['authorization_code']}])expect(await zarejestrujInstalacje(input,async()=>response(body))).toMatchObject({ok:false,kod:'niejednoznaczny'});
 });
});
