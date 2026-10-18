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

  it('PRZ-094.12: układ jak ekrany kurierów — kafel na liście, plakietki stanu, blok instrukcji bez stylu inline', async () => {
    const db = openOmsDb(':memory:');
    zapiszPolaczenie(db, { typ: 'meta', kontoId: 'act_1', kanal: 'sklep_a', sekretRef: `meta:${randomUUID()}` });
    const app = buildOmsServer({ db, config: CONFIG });
    const lista = await app.inject({ method: 'GET', url: '/ustawienia/integracje', headers: BASIC });
    expect(lista.body).toMatch(/<div class="ust-sekcja">\s*<h2>Reklamy<\/h2>\s*<p><a href="\/ustawienia\/integracje\/reklamy">/);
    expect(lista.body.indexOf('<h2>Kurierzy</h2>')).toBeLessThan(lista.body.indexOf('<h2>Reklamy</h2>'));
    expect(lista.body.indexOf('<h2>Reklamy</h2>')).toBeLessThan(lista.body.indexOf('<h2>Kanały Allegro</h2>'));
    const r = await app.inject({ method: 'GET', url: '/ustawienia/integracje/reklamy', headers: BASIC });
    expect(r.body).toContain('<a href="/ustawienia/integracje">← Integracje</a>');
    expect((r.body.match(/<section class="ust-sekcja" id="reklamy-(?:ga4|google_ads|meta)"/g) ?? [])).toHaveLength(3);
    expect((r.body.match(/<p class="ust-stan"><strong>Niepodłączone<\/strong>/g) ?? [])).toHaveLength(2);
    // Meta jest zapisana, ale bez udanego odczytu — plakietka „Weryfikacja", nie „Niepodłączone".
    expect(r.body).toMatch(/ust-stan ust-stan-weryfikacja"><strong>Weryfikacja<\/strong>/);
    expect((r.body.match(/<aside class="ust-instrukcja"/g) ?? [])).toHaveLength(2);
    expect(r.body).toContain('class="ust-prompt"');
    expect(r.body).not.toContain('style="width:100%"');
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

  describe('PRZ-094.14: „Test odczytu” wraca na ekran reklam z komunikatem', () => {
    const NAGLOWKI = { ...BASIC, origin: 'http://localhost' };
    const serwerZTestem = (raportReklam) => {
      const db = openOmsDb(':memory:');
      const polaczenie = zapiszPolaczenie(db, { typ: 'meta', kontoId: 'act_123', kanal: 'sklep_a',
        sekretRef: `meta:${randomUUID()}` });
      const app = buildOmsServer({ db, config: CONFIG, reklamy: {
        magazyn: { odczytaj: async () => 'tajny-token' },
        klienci: { meta: () => ({ raportReklam }) },
      } });
      return { app, db, polaczenie };
    };
    const kliknijTest = async (app, polaczenie) => {
      const post = await app.inject({ method: 'POST', url: '/ustawienia/integracje/reklamy/test',
        headers: NAGLOWKI, payload: { polaczenieId: polaczenie.id } });
      expect(post.statusCode).toBe(303);
      const ekran = await app.inject({ method: 'GET', url: post.headers.location, headers: BASIC });
      expect(ekran.statusCode).toBe(200);
      return { post, ekran };
    };

    it('sukces: przekierowanie na ekran reklam i zielony pasek z źródłem i kontem, bez JSON-a', async () => {
      const { app, polaczenie } = serwerZTestem(async () => ({ waluta: 'PLN', strefa: 'Europe/Warsaw' }));
      const { post, ekran } = await kliknijTest(app, polaczenie);
      expect(post.headers.location).toMatch(/^\/ustawienia\/integracje\/reklamy\?/);
      expect(ekran.headers['content-type']).toContain('text/html');
      expect(ekran.body).toMatch(/<div class="pas-potwierdzenie"[^>]*><p>Odczyt działa — Meta, konto act_123\.<\/p><\/div>/);
      expect(ekran.body).not.toContain('"stan"');
      expect(ekran.body).not.toContain('tajny-token');
      await app.close();
    });

    it('porażka: żółty pasek z czytelnym zaleceniem po polsku, bez wyjątku klienta, sekretu ani JSON-a', async () => {
      const { app, polaczenie } = serwerZTestem(async () => {
        throw new Error('HTTP 500 {"error":"token tajny-token odrzucony"} at fetch (node:internal)');
      });
      const { ekran } = await kliknijTest(app, polaczenie);
      expect(ekran.body).toMatch(/<div class="pas-uprzedzenie"[^>]*><p>Test odczytu nie powiódł się — Meta, konto act_123\. Sprawdź połączenie ze źródłem i ponów test\.<\/p><\/div>/);
      expect(ekran.body).not.toContain('pas-potwierdzenie');
      for (const nie of ['tajny-token', 'HTTP 500', 'node:internal', '"stan"', 'BLAD_ODCZYTU"}']) expect(ekran.body).not.toContain(nie);
      await app.close();
    });

    it('adres z samym parametrem nie wyświetla cudzego tekstu ani komunikatu dla nieistniejącego połączenia', async () => {
      const { app, polaczenie } = serwerZTestem(async () => ({ waluta: 'PLN' }));
      const podrobiony = await app.inject({ method: 'GET', headers: BASIC,
        url: `/ustawienia/integracje/reklamy?test=blad&kod=%3Cscript%3Ealert(1)%3C%2Fscript%3E&polaczenie=${polaczenie.id}` });
      expect(podrobiony.body).not.toContain('<script>alert');
      expect(podrobiony.body).not.toContain('Test odczytu nie powiódł się');
      const cudze = await app.inject({ method: 'GET', headers: BASIC,
        url: '/ustawienia/integracje/reklamy?test=dziala&polaczenie=9999' });
      expect(cudze.body).not.toContain('Odczyt działa');
      await app.close();
    });
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
    // PRZ-094.14: wynik wraca na ekran reklam (PRG), nie jako surowy JSON.
    expect(r.statusCode).toBe(303);
    expect(r.headers.location).toBe(`/ustawienia/integracje/reklamy?test=dziala&polaczenie=${polaczenie.id}`);
    expect(r.headers['content-type'] ?? '').not.toContain('json');
    expect(r.body).not.toContain('tajny-token');
    expect(stanPolaczenia(db, polaczenie.id).ostatniSukcesAt).toBeTruthy();
    expect(polaczenia(db)[0]).toMatchObject({ waluta: 'PLN', strefa: 'Europe/Warsaw' });
    await app.close();
  });
});
