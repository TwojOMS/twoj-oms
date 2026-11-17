import { afterEach, describe, expect, it } from 'vitest';
import { zbudujOms } from '../../src/oms/bootstrap.ts';
import { modulyDla } from '../../src/moduly/lista.ts';
import type { ModulOms } from '../../src/core/kontrakty.ts';

const env = { OMS_SPRZEDAWCA_NIP: '1234563218', OMS_USER: 'fixture', OMS_PASS: 'fixture', OMS_KANALY: '[]', OMS_TRUST_PROXY: '127.0.0.1',
  OMS_PROFORMY_KATALOG: 'tests/fixture-proformy', OMS_ETYKIETY_KATALOG: 'tests/fixture-etykiety' };
const basic = { authorization: `Basic ${Buffer.from('fixture:fixture').toString('base64')}` };
const probe: ModulOms = {
  nazwa: 'proba-naglowkow', wersja: '1.0.0', wymaga: [], migracje: [], uprawnienia: [], menu: [],
  konfiguracja: () => ({}),
  zbuduj: () => ({ trasy: app => {
    app.get('/public/proba-blad', async () => { throw Error('Fikcyjna awaria'); });
    app.get('/public/proba-polityki', async (_req, reply) => reply
      .header('X-Frame-Options', 'SAMEORIGIN')
      .header('Content-Security-Policy', "frame-ancestors 'self'")
      .header('X-Content-Type-Options', 'nosniff')
      .header('Referrer-Policy', 'no-referrer')
      .header('Strict-Transport-Security', 'max-age=31536000')
      .send('fixture'));
  } }),
};
let a: Awaited<ReturnType<typeof zbudujOms>>;
// Osobny bootstrap w każdym teście: brak wspólnego stanu logowania i limitów.
afterEach(async () => { if (a) { await a.app.close(); a.db.close(); } });
async function zbuduj() { a = await zbudujOms({ env, moduly: [...modulyDla(env), probe], log: () => {} }); }

describe('nagłówki na wszystkich odpowiedziach OMS', () => {
  it.each([
    ['/ustawienia/konta', 200, basic], ['/login', 200, {}],
    ['/public/nie-ma-takiego-pliku', 404, {}], ['/public/oms-design.css', 200, {}],
    ['/public/proba-blad', 500, {}], ['/ustawienia/konta', 401, {}],
  ] as const)('%s (%i)', async (url, status, headers) => {
    await zbuduj();
    const r = await a.app.inject({ url, headers });
    expect(r.statusCode).toBe(status);
    expect(r.headers['x-frame-options']).toBe('DENY');
    expect(r.headers['content-security-policy']).toBe("frame-ancestors 'none'");
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['referrer-policy']).toBe('same-origin');
    expect(r.headers['strict-transport-security']).toBeUndefined();
  });
  it.each(['http', 'https'])('HSTS jak Secure sesji: proxy %s', async protocol => {
    await zbuduj();
    const r = await a.app.inject({ url: '/login', remoteAddress: '127.0.0.1', headers: { 'x-forwarded-proto': protocol } });
    expect(r.headers['strict-transport-security']).toBe(protocol === 'https' ? 'max-age=15552000' : undefined);
  });
  it('zachowuje wszystkie nagłówki ustawione przez trasę', async () => {
    await zbuduj();
    const r = await a.app.inject({ url: '/public/proba-polityki', headers: { 'x-forwarded-proto': 'https' } });
    expect(r.statusCode).toBe(200);
    expect(r.headers).toMatchObject({
      'x-frame-options': 'SAMEORIGIN', 'content-security-policy': "frame-ancestors 'self'",
      'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer',
      'strict-transport-security': 'max-age=31536000',
    });
  });
  it('zachowuje politykę rzeczywistej trasy jednorazowego hasła', async () => {
    await zbuduj();
    const r = await a.app.inject('/haslo/fikcyjny-token');
    expect(r.headers['referrer-policy']).toBe('strict-origin');
  });
});
