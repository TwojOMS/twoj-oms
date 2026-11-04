import {afterEach,describe,it,expect} from 'vitest';
import {createHash} from 'node:crypto';
import {fixtureAllegro,daneAllegro,aktorAllegro,callbackAllegro,scopesAllegro} from '../../pomoc/allegro-konfigurator.ts';
const bazy:ReturnType<typeof fixtureAllegro>[]=[];afterEach(()=>{for(const f of bazy.splice(0))f.db.close();});
const fixture=()=>{const f=fixtureAllegro();bazy.push(f);return f;};
async function start(f:ReturnType<typeof fixture>){const k=f.szkic();const p=daneAllegro(await f.auth.rozpocznijAutoryzacje(k.klucz,aktorAllegro,'sesja-A'));return {k,p,url:new URL(p.adres)};}
describe('OAuth Code z kandydatem',()=>{
 it('brak zakresu odczytu profilu zatrzymuje zgodę przed próbą /me',async()=>{
  const f=fixture(),{url}=await start(f);f.setScopes(scopesAllegro.filter(s=>s!=='allegro:api:profile:read'));
  const w=await f.auth.obsluzPowrot({state:url.searchParams.get('state')!,code:'kod',redirectUri:callbackAllegro},'sesja-A');
  expect(w).toMatchObject({ok:false,kod:'ponow_autoryzacje'});expect(f.calls.some(c=>c.url.endsWith('/me'))).toBe(false);
 });
 it('PKCE S256, osiem zakresów i /me; callback nie zapisuje aktywnych tokenów ani importu',async()=>{
  const f=fixture();const {k,p,url}=await start(f);expect(url.origin+url.pathname).toBe('https://allegro.pl/auth/oauth/authorize');expect(url.searchParams.get('code_challenge_method')).toBe('S256');expect(url.searchParams.get('redirect_uri')).toBe(callbackAllegro);expect(url.searchParams.get('scope')?.split(' ')).toEqual(scopesAllegro);
  const state=url.searchParams.get('state')!;expect(state.length).toBeGreaterThanOrEqual(40);
  const result=daneAllegro(await f.auth.obsluzPowrot({state,code:'KOD-OAUTH-WABIK',redirectUri:callbackAllegro},'sesja-A'));expect(result).toMatchObject({probaId:p.probaId,kontoId:'123',login:'konto-123'});
  const tokenRequest=f.calls.find(c=>c.url.endsWith('/token'))!;const body=new URLSearchParams(String(tokenRequest.init.body));const verifier=body.get('code_verifier')!;expect(createHash('sha256').update(verifier).digest('base64url')).toBe(url.searchParams.get('code_challenge'));expect(body.get('redirect_uri')).toBe(callbackAllegro);
  expect(f.calls.map(c=>c.url)).toContain('https://api.allegro.pl/me');expect(JSON.stringify(result)).not.toMatch(/ACCESS-WABIK|REFRESH-WABIK|SEKRET|nigdy-na-ekran|KOD-OAUTH/);
  expect(f.db.prepare('SELECT * FROM tokeny_kanalu').all()).toEqual([]);expect(f.repo.pobierz(k.klucz)?.pobieranie).toBe('wylaczone');expect(f.db.prepare('SELECT * FROM zamowienia').all()).toEqual([]);
 });
 it.each(['obcy-state','zla-sesja','zly-callback','wygasly'])('odrzuca %s przed HTTP',async mode=>{
  const f=fixture();const {url}=await start(f);if(mode==='wygasly')f.setCzas('2026-11-01T12:10:01Z');
  const result=await f.auth.obsluzPowrot({state:mode==='obcy-state'?'obcy':url.searchParams.get('state')!,code:'kod',redirectUri:mode==='zly-callback'?'https://obcy.invalid':callbackAllegro},mode==='zla-sesja'?'B':'sesja-A');expect(result.ok).toBe(false);expect(f.calls).toEqual([]);
 });
 it('state jest jednorazowy i dwa callbacki nie wymieniają kodu drugi raz',async()=>{
  const f=fixture();const {url}=await start(f);const d={state:url.searchParams.get('state')!,code:'kod',redirectUri:callbackAllegro};const [a,b]=await Promise.all([f.auth.obsluzPowrot(d,'sesja-A'),f.auth.obsluzPowrot(d,'sesja-A')]);expect([a.ok,b.ok].sort()).toEqual([false,true]);expect(f.calls.filter(c=>c.url.endsWith('/token'))).toHaveLength(1);
 });
 it.each(scopesAllegro)('brak zakresu %s zatrzymuje kandydata',async scope=>{const f=fixture();const {url,p}=await start(f);f.setScopes(scopesAllegro.filter(s=>s!==scope));expect((await f.auth.obsluzPowrot({state:url.searchParams.get('state')!,code:'kod',redirectUri:callbackAllegro},'sesja-A')).ok).toBe(false);expect(f.auth.pobierzKandydata(p.probaId,'sesja-A')).toBeNull();});
 it.each([401,403,500])('/me HTTP %s nie aktywuje konta',async status=>{const f=fixture();const {url,p}=await start(f);f.setMeStatus(status);expect((await f.auth.obsluzPowrot({state:url.searchParams.get('state')!,code:'kod',redirectUri:callbackAllegro},'sesja-A')).ok).toBe(false);expect(f.auth.pobierzKandydata(p.probaId,'sesja-A')).toBeNull();});
 it('odłączenie po rozpoczęciu blokuje callback, a odmowa zgody nie wykonuje HTTP',async()=>{const f=fixture();const {k,url}=await start(f);const before=f.repo.pobierz(k.klucz)!;daneAllegro(f.repo.zapiszZmiane(k.klucz,before.wersja,{autoryzacja:'odlaczone'},aktorAllegro));expect((await f.auth.obsluzPowrot({state:url.searchParams.get('state')!,code:'kod',redirectUri:callbackAllegro},'sesja-A')).ok).toBe(false);expect(f.calls).toEqual([]);});
});
