import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import { registerWeb } from '../../src/core/web/pipeline.js';
import { openOmsDb } from '../../src/oms/db/db.ts';
describe('wspólny pipeline HTTP',()=>{
 it('wymaga uwierzytelnienia i parsuje formbody w tej samej aplikacji',async()=>{
  const db=openOmsDb();const app=Fastify();
  app.decorate('menuOms', []);
  registerWeb(app,{db,config:{auth:{user:'operator',pass:'atrapa'}}});
  app.post('/sonda',async(req)=>req.body);
  app.get('/sonda',async()=>({ok:true}));
  expect((await app.inject({method:'POST',url:'/sonda',headers:{authorization:'Basic '+Buffer.from('operator:atrapa').toString('base64'),'content-type':'application/x-www-form-urlencoded',origin:'http://localhost:80'},payload:'tekst=Za%C5%BC%C3%B3%C5%82%C4%87'})).json()).toEqual({tekst:'Zażółć'});
  expect((await app.inject({url:'/sonda',headers:{accept:'text/html'}})).statusCode).toBe(302);
  expect((await app.inject('/sonda')).statusCode).toBe(401);
  expect((await app.inject({url:'/sonda',headers:{authorization:'Basic '+Buffer.from('operator:atrapa').toString('base64')}})).json()).toEqual({ok:true});
  await app.close();db.close();
 });
});
