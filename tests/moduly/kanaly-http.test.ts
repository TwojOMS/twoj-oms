import { describe, it, expect, vi } from 'vitest';
import Fastify from 'fastify';
import { registerWiazanieRoute } from '../../src/moduly/kanaly/trasy.ts';
describe('HTTP wiązania kanału', () => {
  it('zachowuje adres i redirect, przekazuje klucz do usługi', async () => {
    const app=Fastify(); const rozpocznij=vi.fn(async()=>({ok:true}));
    registerWiazanieRoute(app,{wiazanieKanalow:{rozpocznij},widokIntegracji:(_req,reply,d)=>reply.send(d)});
    const r=await app.inject({method:'POST',url:'/ustawienia/kanaly/rynek/wiazanie'});
    expect(rozpocznij).toHaveBeenCalledWith('rynek'); expect(r.statusCode).toBe(302);
    expect(r.headers.location).toBe('/ustawienia/integracje?zapisano=kanal'); await app.close();
  });
  it('odmowa usługi zachowuje 400 i komunikat widoku; brak kanałów daje 503', async () => {
    for(const [usluga,status,blad] of [[{rozpocznij:async()=>({ok:false,powod:'Kanał działa.'})},400,'Kanał działa.'],[null,503,'Panel nie ma podpiętych kanałów Allegro.']] as const){
      const app=Fastify(); registerWiazanieRoute(app,{wiazanieKanalow:usluga,widokIntegracji:(_req,reply,d)=>reply.send(d)});
      const r=await app.inject({method:'POST',url:'/ustawienia/kanaly/rynek/wiazanie'});
      expect(r.statusCode).toBe(status);expect(r.json()).toEqual({blad});await app.close();
    }
  });
});
