// PRZ-153.E1.3b — wyjątek CSRF dla żądań z kluczem API (plan docs/plany/PRZ-153-api-v1.md, E1.3).
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { czyZadanieKluczem } from '../../../src/core/bezpieczenstwo/csrf.js';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { buildOmsServer } from '../../pomoc/serwer-parytetu.ts';
import { zalozKluczApi } from '../../../src/core/bezpieczenstwo/klucze-api.js';
import { NAZWA_CIASTECZKA_OMS } from '../../../src/core/bezpieczenstwo/sesja.js';
import { MODULY } from '../../../src/moduly/lista.ts';

const KLUCZ = `toms_abcdefgh_${'C'.repeat(43)}`;
const CIASTKO = 'oms_sesja';

describe('czyZadanieKluczem', () => {
  it('/api/v1/x z Bearer i bez ciasteczka sesji → true', () => {
    expect(czyZadanieKluczem({ url: '/api/v1/x', authorization: `Bearer ${KLUCZ}`, cookie: undefined }, CIASTKO)).toBe(true);
    expect(czyZadanieKluczem({ url: '/api/v1', authorization: `Bearer ${KLUCZ}`, cookie: 'motyw=ciemny' }, CIASTKO)).toBe(true);
    expect(czyZadanieKluczem({ url: '/api/v1/x?a=1', authorization: `Bearer ${KLUCZ}`, cookie: '' }, CIASTKO)).toBe(true);
  });
  it('bez Bearer → false', () => {
    expect(czyZadanieKluczem({ url: '/api/v1/x', authorization: undefined, cookie: undefined }, CIASTKO)).toBe(false);
    expect(czyZadanieKluczem({ url: '/api/v1/x', authorization: 'Basic c2Vyd2lzOmhhc2xv', cookie: undefined }, CIASTKO)).toBe(false);
    expect(czyZadanieKluczem({ url: '/api/v1/x', authorization: 'Bearer toms_zly', cookie: undefined }, CIASTKO)).toBe(false);
  });
  it('z ciasteczkiem sesji → false (także z pustą wartością)', () => {
    expect(czyZadanieKluczem({ url: '/api/v1/x', authorization: `Bearer ${KLUCZ}`, cookie: `${CIASTKO}=abc.def` }, CIASTKO)).toBe(false);
    expect(czyZadanieKluczem({ url: '/api/v1/x', authorization: `Bearer ${KLUCZ}`, cookie: `motyw=jasny; ${CIASTKO}=` }, CIASTKO)).toBe(false);
  });
  it('/zamowienia i inne adresy poza /api/v1 z Bearer → false', () => {
    for (const url of ['/zamowienia', '/api/v1x', '/api/zamowienia', '/login']) {
      expect(czyZadanieKluczem({ url, authorization: `Bearer ${KLUCZ}`, cookie: undefined }, CIASTKO), url).toBe(false);
    }
  });
  it('zakodowana ścieżka liczy się jak u strażnika wejścia; złe kodowanie nie zwalnia', () => {
    for (const url of ['/api/v%31/x', '/api%2Fv1/x', '/api/v1%2Fx?a=1']) {
      expect(czyZadanieKluczem({ url, authorization: `Bearer ${KLUCZ}`, cookie: undefined }, CIASTKO), url).toBe(true);
    }
    for (const url of ['/api/v1/%zz', '/api/v%3', '/zamowienia%2Fx', '/api/v1x%2F']) {
      expect(czyZadanieKluczem({ url, authorization: `Bearer ${KLUCZ}`, cookie: undefined }, CIASTKO), url).toBe(false);
    }
  });
  it('bez nazwy ciasteczka nie zwalnia niczego (zawodzimy zamknięciem)', () => {
    expect(czyZadanieKluczem({ url: '/api/v1/x', authorization: `Bearer ${KLUCZ}`, cookie: undefined }, undefined)).toBe(false);
  });
});

describe('CSRF przez HTTP: POST /api/v1/echo z kluczem', () => {
  let db;
  let app;
  let klucz;
  beforeEach(async () => {
    const testowy = {
      nazwa: 'api-echo', wersja: '1.0.0', wymaga: ['api'], migracje: [], menu: [], uprawnienia: [],
      konfiguracja: () => null,
      zbuduj: () => ({ trasy: (a) => { a.register(async (api) => {
        api.post('/echo', async (req) => ({ echo: req.body ?? null }));
      }, { prefix: '/api/v1' }); } }),
    };
    db = openOmsDb(':memory:');
    app = buildOmsServer({ db, config: { auth: { user: 'serwis', pass: 'haslo-env' }, klienciZbiorczy: [] }, moduly: [...MODULY, testowy] });
    await app.ready();
    klucz = zalozKluczApi(db, { nazwa: 'integracja testowa', zakresy: ['druk'], kontoId: null, teraz: new Date().toISOString() }).klucz;
  });
  afterEach(async () => { await app.close(); db.close(); });

  it('klucz bez Origin i Referer → 200', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/v1/echo', headers: { authorization: `Bearer ${klucz}` }, payload: { a: 1 } });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toEqual({ echo: { a: 1 } });
  });
  it('klucz z ciasteczkiem sesji bez Origin → 403 (zwykła ochrona CSRF)', async () => {
    const r = await app.inject({
      method: 'POST', url: '/api/v1/echo',
      headers: { authorization: `Bearer ${klucz}`, cookie: `${NAZWA_CIASTECZKA_OMS}=cokolwiek` }, payload: { a: 1 },
    });
    expect(r.statusCode).toBe(403);
  });
  it('bez klucza i bez Origin → nie 200', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/v1/echo', payload: { a: 1 } });
    expect(r.statusCode).not.toBe(200);
  });
});
