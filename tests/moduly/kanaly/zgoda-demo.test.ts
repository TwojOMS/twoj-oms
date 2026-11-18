import { afterEach, expect, it } from 'vitest';
import type { ModulOms } from '../../../src/core/kontrakty.ts';
import { zbudujAplikacje, type Aplikacja } from '../../../src/core/aplikacja.ts';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { modulyPiaskownicy } from '../../../deploy/proba/atrapy/index.mjs';
import { ENV_DEMO } from '../../../scripts/demo-dane.mjs';
import { zalozKonto } from '../../../src/core/bezpieczenstwo/konta.js';
import { podpisz } from '../../../src/core/bezpieczenstwo/sesja.js';
import { wczytajSekret } from '../../../src/core/bezpieczenstwo/sekret-sesji.js';
import { maZgodeNaOferty, UPRAWNIENIA_OFERT } from '../../../src/domena/uprawnienia-kanalu.js';
import { wczytajTokeny, zapiszTokeny } from '../../../src/oms/db/tokeny.js';
import { utworzKarte } from '../../../src/oms/db/magazyn.js';

let a: Aplikacja | undefined;
let db: ReturnType<typeof openOmsDb> | undefined;
afterEach(async () => {
  await a?.app.close();
  db?.close();
  a = undefined;
  db = undefined;
});

async function setup() {
  const env = {
    ...ENV_DEMO,
    OMS_USER: 'serwis',
    OMS_PASS: 'fixture',
    OMS_PROFORMY_KATALOG: '/tmp/prz160e3-proformy',
    OMS_ETYKIETY_KATALOG: '/tmp/prz160e3-etykiety',
  };
  db = openOmsDb(':memory:');
  a = await zbudujAplikacje({ db, moduly: modulyPiaskownicy(env) as ModulOms[], env, log: () => {} });
  zalozKonto(db, { login: 'admin', imie: 'Administrator', haslo: 'fixture', rola: 'administrator', admin: true });
  const headers = {
    cookie: 'sesja_oms_proba=' + podpisz('admin', wczytajSekret(db), Date.now()),
    origin: 'http://localhost',
  };
  const get = (url: string) => a!.app.inject({ method: 'GET', url, headers });
  const post = (url: string, payload: Record<string, unknown>) =>
    a!.app.inject({ method: 'POST', url, headers, payload });
  return { get, post, oferty: a.usluga<any>('kanaly', 'ofertyAllegro') };
}

it('demo: Outlet bez zakresów ofert pokazuje zgodę, główne konto ze zgodą jej nie pokazuje', async () => {
  const { get, post, oferty } = await setup();
  const id = utworzKarte(db!, { nazwa: 'Lampa próbna', sku: 'ZGODA-DEMO' });
  for (const [klucz, zgoda] of [
    ['allegro', true],
    ['allegro-outlet', false],
  ] as const) {
    expect(maZgodeNaOferty(wczytajTokeny(db!, klucz)?.access_token)).toBe(zgoda);
    expect(oferty.stan(klucz)).toMatchObject({ zgoda, aplikacja: true, sciezka: 'env' });
    const r = await get('/ustawienia/integracje/allegro/' + klucz);
    expect(r.statusCode).toBe(200);
    expect(r.body.includes('Chcę wystawiać oferty')).toBe(!zgoda);
    expect(r.body.includes('<h2>Wystawianie ofert</h2>')).toBe(!zgoda);
    expect(r.body).toContain(zgoda ? 'Zgoda jest' : 'Brak zgody — konto pobiera zamówienia jak dotąd');
    const podglad = await post('/magazyn/oferty/podglad', { konto: klucz, zaznaczone: [id] });
    expect(podglad.statusCode).toBe(zgoda ? 200 : 400);
  }
});

it('ekran i Magazyn odczytują zmianę zgody z tego samego tokenu, bez restartu', async () => {
  const { get, post, oferty } = await setup();
  const id = utworzKarte(db!, { nazwa: 'Lampa próbna', sku: 'ZGODA-ZMIANA' });
  const scope = ['allegro:api:orders:read', ...UPRAWNIENIA_OFERT];
  zapiszTokeny(db!, 'allegro-outlet', {
    accessToken: 'atrapa.' + Buffer.from(JSON.stringify({ scope })).toString('base64url') + '.atrapa',
    refreshToken: 'ATRAPA',
    wygasaAt: '2099-01-01T00:00:00Z',
    refreshWygasaAt: '2099-02-01T00:00:00Z',
  });
  expect(oferty.stan('allegro-outlet')).toMatchObject({ zgoda: true });
  expect((await get('/ustawienia/integracje/allegro/allegro-outlet')).body).not.toContain('Chcę wystawiać oferty');
  expect((await post('/magazyn/oferty/podglad', { konto: 'allegro-outlet', zaznaczone: [id] })).statusCode).toBe(200);
});
