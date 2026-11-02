import { it, expect } from 'vitest';
import { zalozKonto, kontoPoLoginie } from '../../../src/core/bezpieczenstwo/konta.js';
import { nowyPanel, jako, get, post } from '../../pomoc/konta-prz068.js';
import { ukryteTypyKonta } from '../../../src/oms/db/powiadomienia.js';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { buildOmsServer } from '../../pomoc/serwer-parytetu.ts';

it('własne Powiadomienia są dostępne Sprzedaży i nie przyjmują obcego ID konta', async () => {
  const { app, db } = nowyPanel();
  zalozKonto(db, {login:'szef',haslo:'h',rola:'administrator',admin:true});
  zalozKonto(db, {login:'sprzedawca',haslo:'h',rola:'sprzedaz'});
  const sprzedaz=jako(db,'sprzedawca');
  try {
    expect((await get(app,'/konto/powiadomienia',sprzedaz)).statusCode).toBe(200);
    expect((await get(app,'/ustawienia/powiadomienia',sprzedaz)).statusCode).toBe(200); // osobisty wyjątek dotychczasowego strażnika pozostaje
    const obce=kontoPoLoginie(db,'szef').id;
    const przed=ukryteTypyKonta(db,obce);
    expect((await post(app,'/konto/powiadomienia',sprzedaz,{kontoId:obce})).statusCode).toBe(303);
    expect(ukryteTypyKonta(db,obce)).toEqual(przed);
    expect(ukryteTypyKonta(db,kontoPoLoginie(db,'sprzedawca').id).length).toBeGreaterThan(0);
  } finally {await app.close();db.close();}
});
it('walidacja kosztów dostawy zostawia właściwą zakładkę i wpisane wartości', async () => {
  const { app, db } = nowyPanel();
  zalozKonto(db,{login:'szef',haslo:'h',rola:'administrator',admin:true});
  try {
    const r=await post(app,'/ustawienia/dostawa',jako(db,'szef'),{'koszt.INPOST':'-12'});
    expect(r.statusCode).toBe(400);
    expect(r.body).toContain('href="/ustawienia/wysylka/dostawa" aria-current="page"');
    expect(r.body).not.toContain('id="ust-szablon-nowy"');
  } finally {await app.close();db.close();}
});
it('gość demo nie zapisze osobistych Powiadomień przez nowy adres', async () => {
  const db=openOmsDb(':memory:');
  const app=buildOmsServer({db,config:{auth:{user:'serwis',pass:'fixture'},demo:{login:'demo',haslo:'demo',reset:'co godzinę'}}});
  zalozKonto(db,{login:'demo',haslo:'demo',rola:'sprzedaz'});
  const id=kontoPoLoginie(db,'demo').id;
  const przed=ukryteTypyKonta(db,id);
  try {
    expect((await get(app,'/konto/powiadomienia',jako(db,'demo'))).statusCode).toBe(200);
    expect((await post(app,'/konto/powiadomienia',jako(db,'demo'),{})).statusCode).toBe(403);
    expect(ukryteTypyKonta(db,id)).toEqual(przed);
  } finally {await app.close();db.close();}
});
