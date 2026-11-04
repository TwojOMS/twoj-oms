import {describe,it,expect} from 'vitest';
import {transportAllegroSandbox,sprawdzCallbackSandbox} from '../../deploy/proba/allegro-sandbox.ts';
describe('rzeczywisty transport Allegro Sandbox',()=>{
 it.each(['https://api.allegro.pl/me','https://allegro.pl/auth/oauth/token','http://api.allegro.pl.allegrosandbox.pl/me','https://api.allegro.pl.allegrosandbox.pl:444/me','https://api.allegro.pl.allegrosandbox.pl.obcy.invalid/me','http://192.168.0.31:3001','https://api.allegro.pl.allegrosandbox.pl@obcy.invalid/me'])('odrzuca cel %s przed siecią',async adres=>{
  let calls=0;const http=transportAllegroSandbox({tryb:'proba',fetchImpl:async()=>{calls++;return Response.json({});}});
  await expect(http(adres)).rejects.toThrow();expect(calls).toBe(0);
 });
 it('przepuszcza JSON i binaria tylko do dwóch dokładnych hostów; nie podąża za redirect i zachowuje AbortSignal',async()=>{
  const calls:{url:string;init:RequestInit}[]=[];const ac=new AbortController();
  const http=transportAllegroSandbox({tryb:'proba',fetchImpl:async(u,i)=>{calls.push({url:String(u),init:i!});return new Response(new Uint8Array([1,2,3]));}});
  await http('https://allegro.pl.allegrosandbox.pl/auth/oauth/token',{method:'POST',signal:ac.signal});
  const r=await http('https://api.allegro.pl.allegrosandbox.pl/order/1/invoices/1/file');expect([...new Uint8Array(await r.arrayBuffer())]).toEqual([1,2,3]);
  expect(calls.map(c=>c.init.redirect)).toEqual(['error','error']);ac.abort();expect(calls[0].init.signal?.aborted).toBe(true);
 });
 it('poza lokalnym trybem próby odmawia utworzenia transportu',()=>{expect(()=>transportAllegroSandbox({tryb:'produkcja'})).toThrow();expect(()=>transportAllegroSandbox({tryb:'demo'})).toThrow();});
 it.each(['http://192.168.0.33:3005/powrot','http://[::1]:3005/powrot','https://konto:haslo@oms.test/powrot','http://oms.test/powrot#fragment','file:///powrot'])('nie przyjmuje callbacku %s',url=>{expect(()=>sprawdzCallbackSandbox(url)).toThrow();});
 it('callback z nazwą hosta zachowuje dokładny URL',()=>{expect(sprawdzCallbackSandbox('http://oms-proba.test:3005/ustawienia/integracje/allegro/oauth/powrot')).toBe('http://oms-proba.test:3005/ustawienia/integracje/allegro/oauth/powrot');});
});
