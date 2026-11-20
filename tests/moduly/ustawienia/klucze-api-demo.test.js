// Gość demo ogląda Klucze API tak jak Konta i Role: widzi listę, ale nie dostaje formularza ani tokenu do zapisu.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { tmpdir } from 'node:os';
import Fastify from 'fastify';
import { zbudujOms } from '../../../src/oms/bootstrap.ts';
import { zalozKonto, ustawUprawnienia } from '../../../src/core/bezpieczenstwo/konta.js';
import { zalozKluczApi } from '../../../src/core/bezpieczenstwo/klucze-api.js';
import { NAZWA_CIASTECZKA_OMS_PROBA, NAZWA_CIASTECZKA_OMS } from '../../../src/core/bezpieczenstwo/sesja.js';
import { KOMUNIKAT_PODGLADU } from '../../../src/core/bezpieczenstwo/podglad-demo.js';
import { registerKluczeApiRoutes } from '../../../src/moduly/ustawienia/trasy/klucze-api.js';
import { ENV_DEMO } from '../../../scripts/demo-dane.mjs';

const LOGIN = 'gosc';
const HASLO = 'pokaz-demo-2026';
const origin = { origin: 'http://localhost' };
const url = '/ustawienia/klucze-api';
const env = {
  ...ENV_DEMO,
  OMS_USER: 'serwis',
  OMS_PASS: 'serwis-haslo',
  OMS_PROFORMY_KATALOG: tmpdir(),
  OMS_ETYKIETY_KATALOG: tmpdir(),
  OMS_DEMO_LOGIN: LOGIN,
  OMS_DEMO_HASLO: HASLO,
};

afterEach(() => vi.unstubAllGlobals());

async function panelZGosciem() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw Error('Sieć zabroniona');
    }),
  );
  const a = await zbudujOms({ env });
  const id = zalozKonto(a.db, { login: LOGIN, imie: 'Gość demo', haslo: HASLO, rola: 'sprzedaz' });
  ustawUprawnienia(a.db, id, ['ustawienia']);
  const r = await a.app.inject({
    method: 'POST',
    url: '/login',
    headers: origin,
    payload: { uzytkownik: LOGIN, haslo: HASLO, powrot: '/' },
  });
  const cookie = []
    .concat(r.headers['set-cookie'])
    .find((c) => [NAZWA_CIASTECZKA_OMS, NAZWA_CIASTECZKA_OMS_PROBA].some((n) => c.startsWith(`${n}=`)))
    .split(';')[0];
  return { a, cookie };
}

describe('Klucze API w demo publicznym', () => {
  it('gość: GET 200 z listą i odnośnikiem do opisu API, bez formularza zakładania i bez przycisków zmian', async () => {
    const { a, cookie } = await panelZGosciem();
    zalozKluczApi(a.db, {
      nazwa: 'Integracja magazynu',
      zakresy: ['zamowienia:odczyt'],
      teraz: '2026-11-19T10:00:00Z',
    });
    const r = await a.app.inject({ url, headers: { cookie, accept: 'text/html' } });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.body).toContain('Integracja magazynu');
    expect(r.body).toContain('https://github.com/TwojOMS/twoj-oms/blob/main/docs/api/README.md');
    expect(r.body).toContain(KOMUNIKAT_PODGLADU);
    expect(r.body).not.toContain('name="jednorazowy"');
    expect(r.body).not.toContain('Utwórz klucz');
    expect(r.body).not.toContain('/odwolaj');
    expect(r.body).not.toContain('/usun');
    await a.app.close();
  });

  it('gość: POST zakładania, odwołania i usunięcia kończy się 403', async () => {
    const { a, cookie } = await panelZGosciem();
    for (const adres of [url, `${url}/1/odwolaj`, `${url}/1/usun`]) {
      const r = await a.app.inject({
        method: 'POST',
        url: adres,
        headers: { ...origin, cookie },
        payload: { nazwa: 'x', zakresy: ['druk'], potwierdzam: 'tak' },
      });
      expect(r.statusCode, adres).toBe(403);
    }
    expect(a.db.prepare('SELECT COUNT(*) AS n FROM klucze_api').get().n).toBe(0);
    await a.app.close();
  });

  it('GET gościa nie tworzy tokenu formularza (model bez tokenu, z oznaczeniem podglądu)', async () => {
    const db = { prepare: () => ({ all: () => [] }) };
    const app = Fastify();
    app.decorateReply('view', function (_plik, model) {
      return this.send(model);
    });
    app.addHook('preHandler', async (req) => {
      req.konto = { podgladDemo: true, login: 'gosc' };
    });
    registerKluczeApiRoutes(app, { db });
    try {
      const r = await app.inject({ url });
      expect(r.statusCode).toBe(200);
      expect(r.json().jednorazowy).toBeNull();
      expect(r.json().podgladDemo).toBe(true);
    } finally {
      await app.close();
    }
  });

  it('konto bez admina i bez podglądu dalej dostaje 403', async () => {
    const a = await zbudujOms({
      env: { ...env, OMS_DEMO_LOGIN: undefined, OMS_DEMO_HASLO: undefined, OMS_TRYB: 'proba' },
    });
    const id = zalozKonto(a.db, { login: 'pracownik', imie: 'Test', haslo: 'haslo-pracownika-1', rola: 'sprzedaz' });
    ustawUprawnienia(a.db, id, ['ustawienia']);
    const r = await a.app.inject({
      method: 'POST',
      url: '/login',
      headers: origin,
      payload: { uzytkownik: 'pracownik', haslo: 'haslo-pracownika-1', powrot: '/' },
    });
    const cookie = []
      .concat(r.headers['set-cookie'])
      .find((c) => [NAZWA_CIASTECZKA_OMS, NAZWA_CIASTECZKA_OMS_PROBA].some((n) => c.startsWith(`${n}=`)))
      .split(';')[0];
    expect((await a.app.inject({ url, headers: { cookie } })).statusCode).toBe(403);
    await a.app.close();
  });
});
