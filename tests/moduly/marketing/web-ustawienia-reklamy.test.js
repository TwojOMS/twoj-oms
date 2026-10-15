import { describe, expect, it } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { buildOmsServer } from '../../pomoc/serwer-parytetu.ts';
import { zalozKonto, ustawUprawnienia } from '../../../src/core/bezpieczenstwo/konta.js';
import { podpisz, NAZWA_CIASTECZKA_OMS } from '../../../src/core/bezpieczenstwo/sesja.js';
import { odczytajSekret } from '../../../src/core/bezpieczenstwo/sekret-sesji.js';
import Fastify from 'fastify';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerUstawieniaRoutes } from '../../../src/moduly/marketing/trasy/integracje.js';
import { createMagazynSekretow } from '../../../src/moduly/marketing/uslugi/reklamy-sekrety.js';
import { polaczenia, zapiszPolaczenie, stanPolaczenia } from '../../../src/oms/db/reklamy.js';

const CONFIG = { auth: { user: 'serwis', pass: 'haslo-env' }, klienciZbiorczy: [] };
const BASIC = { authorization: `Basic ${Buffer.from('serwis:haslo-env').toString('base64')}` };

describe('Ustawienia → Integracje → Reklamy', () => {
  it('pokazuje trzy niezależne źródła, puste stany i neutralne prompty', async () => {
    const app = buildOmsServer({ db: openOmsDb(':memory:'), config: CONFIG });
    const r = await app.inject({ method: 'GET', url: '/ustawienia/integracje/reklamy', headers: BASIC });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('Google przez GA4');
    expect(r.body).toContain('Google Ads API');
    expect(r.body).toContain('Meta');
    expect((r.body.match(/Niepodłączone/g) ?? [])).toHaveLength(3);
    expect((r.body.match(/Skopiuj prompt dla agenta/g) ?? [])).toHaveLength(3);
    expect(r.body).not.toContain('name="tresc"');
    expect(r.body).not.toContain('name="token"');
    await app.close();
  });

  it('odmawia zapisu bez admina i odrzuca POST bez źródła CSRF', async () => {
    const db = openOmsDb(':memory:');
    const app = buildOmsServer({ db, config: CONFIG });
    const id = zalozKonto(db, { login: 'ewa', imie: 'Barbara', haslo: 'h', rola: 'sprzedaz', admin: false });
    ustawUprawnienia(db, id, ['ustawienia']);
    const jakoAga = { cookie: `${NAZWA_CIASTECZKA_OMS}=${podpisz('ewa', odczytajSekret(db))}` };
    const bezAdmina = await app.inject({ method: 'POST', url: '/ustawienia/integracje/reklamy/zapisz',
      headers: { ...jakoAga, origin: 'http://localhost' }, payload: { typ: 'meta', token: 'SEKRET' } });
    expect(bezAdmina.statusCode).toBe(403);
    const bezCsrf = await app.inject({ method: 'POST', url: '/ustawienia/integracje/reklamy/zapisz',
      headers: BASIC, payload: { typ: 'meta', token: 'SEKRET' } });
    expect(bezCsrf.statusCode).toBe(403);
    const http = await app.inject({ method: 'POST', url: '/ustawienia/integracje/reklamy/zapisz',
      headers: { ...BASIC, origin: 'http://localhost', 'x-forwarded-proto': 'https' }, payload: { typ: 'meta', token: 'SEKRET' } });
    expect(http.statusCode).toBe(403);
    expect(http.body).not.toContain('SEKRET');
    await app.close();
  });

  it('ponowny zapis tego samego konta wymienia sekret bez utraty ID i historii połączenia', async () => {
    const katalog = await mkdtemp(join(tmpdir(), 'oms-reklamy-route-'));
    const db = openOmsDb(':memory:');
    const magazyn = createMagazynSekretow({ katalog });
    const app = Fastify();
    app.addHook('onRequest', async (req) => { req.konto = { admin: true }; });
    registerUstawieniaRoutes(app, { db, reklamy: { magazyn, zaufaneHttps: () => true } });
    try {
      const dane = { typ: 'meta', kontoId: 'act_123', kanal: 'sklep_a' };
      const pierwszy = await app.inject({ method: 'POST', url: '/ustawienia/integracje/reklamy/zapisz',
        payload: { ...dane, tresc: 'pierwszy-token' } });
      expect(pierwszy.statusCode).toBe(302);
      const przed = polaczenia(db);
      expect(przed).toHaveLength(1);
      const drugi = await app.inject({ method: 'POST', url: '/ustawienia/integracje/reklamy/zapisz',
        payload: { ...dane, tresc: 'nowy-token' } });
      expect(drugi.statusCode).toBe(302);
      const po = polaczenia(db);
      expect(po).toHaveLength(1);
      expect(po[0].id).toBe(przed[0].id);
      expect(po[0].sekretRef).toBe(przed[0].sekretRef);
      expect(await magazyn.odczytaj(po[0].sekretRef)).toBe('nowy-token');
      expect(JSON.stringify(po)).not.toContain('nowy-token');
    } finally {
      await app.close();
      await rm(katalog, { recursive: true, force: true });
    }
  });

  it('ręczny test zapisuje ostatni sukces bez surowej odpowiedzi API', async () => {
    const db = openOmsDb(':memory:');
    const polaczenie = zapiszPolaczenie(db, { typ: 'meta', kontoId: 'act_123', kanal: 'sklep_a',
      sekretRef: `meta:${randomUUID()}` });
    const app = Fastify();
    app.addHook('onRequest', async (req) => { req.konto = { admin: true }; });
    registerUstawieniaRoutes(app, { db, reklamy: {
      magazyn: { odczytaj: async () => 'tajny-token' },
      klienci: { meta: () => ({ raportReklam: async () => ({ waluta: 'PLN', strefa: 'Europe/Warsaw' }) }) },
    } });
    const r = await app.inject({ method: 'POST', url: '/ustawienia/integracje/reklamy/test',
      payload: { polaczenieId: polaczenie.id } });
    expect(r.statusCode).toBe(200);
    expect(r.json().stan).toBe('dziala');
    expect(r.body).not.toContain('tajny-token');
    expect(stanPolaczenia(db, polaczenie.id).ostatniSukcesAt).toBeTruthy();
    expect(polaczenia(db)[0]).toMatchObject({ waluta: 'PLN', strefa: 'Europe/Warsaw' });
    await app.close();
  });
});
