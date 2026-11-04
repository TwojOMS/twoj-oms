import {afterEach, expect, it, vi} from 'vitest';
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import Fastify from 'fastify';
import {fixtureAllegro, daneAllegro, aktorAllegro, callbackAllegro} from '../../pomoc/allegro-konfigurator.ts';
import {createRejestrKanalow} from '../../../src/moduly/kanaly/services/rejestr-kanalow.ts';
import {createZarzadzanieAllegro} from '../../../src/moduly/kanaly/services/zarzadzanie-allegro.ts';
import {migracjaDiagnostykiAllegro} from '../../../src/moduly/kanaly/migracje/0002-diagnostyka-allegro.ts';
import {createSklepyWoo} from '../../../src/moduly/kanaly/services/sklepy-woo.ts';
import {createWooClient} from '../../../src/oms/woo/client.js';
import {registerTrasyWoo} from '../../../src/moduly/kanaly/trasy-woo.ts';
import {MODUL_WOO} from '../../../src/domena/modul-woo.ts';
import {fmtDataCzas, fmtDataCzasKrotko} from '../../../src/domena/format-daty.js';

const ejs = createRequire(import.meta.url)('ejs') as {
  render: (template: string, data: object, options: {filename: string}) => string;
};
const root = MODUL_WOO.konfigurator.sciezka;
const fixtures: ReturnType<typeof fixtureAllegro>[] = [];
const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  for (const f of fixtures.splice(0)) f.db.close();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
function baza() {
  const f = fixtureAllegro();
  fixtures.push(f);
  return f;
}
function usluga(klient: Parameters<typeof createSklepyWoo>[0]['klient']) {
  const f = baza();
  return createSklepyWoo({db: f.db, repozytorium: f.repo, klient, envSklepy: [], tryb: 'proba', przykladowySklep: () => true});
}
const daneNowego = {adres: 'https://sklep.example.test', ck: 'ck_atrapa', cs: 'cs_atrapa'};
function komunikat(w: Awaited<ReturnType<ReturnType<typeof createSklepyWoo>['sprawdzNowe']>>) {
  expect(w.ok).toBe(false);
  if (w.ok) throw new Error('Oczekiwano błędu sprawdzenia');
  return w.komunikat;
}
function serwer(woo: ReturnType<typeof createSklepyWoo>, sklep = false, env = false) {
  const f = baza();
  const app = Fastify();
  apps.push(app);
  app.addHook('preHandler', async req => {
    (req as typeof req & {konto: object}).konto = {id: 1, login: 'admin', admin: true};
  });
  app.decorateReply('view', function(path: string, data?: object) {
    const filename = 'src/moduly/kanaly/widoki/' + path;
    return this.type('text/html').send(ejs.render(readFileSync(filename, 'utf8'),
      {...data, fmtDataCzas, fmtDataCzasKrotko}, {filename}));
  });
  const mapowanie = {instancje: {'1': {metoda: 'dpd'}}, bramkiPobrania: []};
  const k = sklep ? daneAllegro(f.repo.utworzSzkicSklepu({nazwa: 'Sklep Przykładowy',
    adres: daneNowego.adres, odUtc: '2026-11-01T23:00:00Z', aktor: aktorAllegro})) : null;
  if (k) f.db.prepare('UPDATE kanaly_sklepy SET sprawdzono_at=?, ustawienia_json=? WHERE klucz=?')
    .run('2026-11-03T12:00:00Z', JSON.stringify({mapowanie}), k.klucz);
  registerTrasyWoo(app, {db: f.db, repozytorium: f.repo, sklepyWoo: woo,
    envSklepy: env ? [{klucz: 'woo_env', nazwa: 'Sklep Przykładowy', adres: daneNowego.adres,
      od: '2026-11-01T23:00:00Z', mapowanie}] : [], teraz: () => new Date(), tryb: 'proba'});
  return {app, klucz: env ? 'woo_env' : k?.klucz};
}
function wooDoWidoku() {
  const woo = usluga(() => ({sprawdzPolaczenie: async () => ({ok: true}),
    pobierzMetodyWysylki: async () => [], pobierzBramkiPlatnosci: async () => []}));
  vi.spyOn(woo, 'metodyWysylki').mockResolvedValue({ok: true, dane: {
    metody: [{strefa: 'Polska', instanceId: 1, tytul: 'Kurier', metodaWoo: 'flat_rate'}],
    mapowanie: {instancje: {'1': {metoda: 'dpd'}}, bramkiPobrania: []}, bramki: [], bladBramek: null,
  }});
  return woo;
}

it.each([
  ['2026-11-03T22:30:00Z', '2026-11-03', '2025-11-03'],
  ['2026-11-03T23:30:00Z', '2026-11-04', '2025-11-04'],
  ['2026-07-03T22:30:00Z', '2026-07-04', '2025-07-04'],
  ['2026-07-03T23:30:00Z', '2026-07-04', '2025-07-04'],
])('U23/B4: data w kreatorze ma warszawskie min/max przy %s', async (czas, max, min) => {
  vi.useFakeTimers({toFake: ['Date']});
  vi.setSystemTime(new Date(czas));
  const {app, klucz} = serwer(wooDoWidoku(), true);
  const r = await app.inject({url: root + '/' + klucz});
  expect(r.statusCode, r.body).toBe(200);
  const input = r.body.match(/<input\b[^>]*type="date"[^>]*>/)?.[0];
  expect(input).toBeDefined();
  expect(input).toContain(`min="${min}"`);
  expect(input).toContain(`max="${max}"`);
});

it('U27/B5: odmowa 401 i ECONNRESET dają różne komunikaty Allegro', async () => {
  const f = baza();
  migracjaDiagnostykiAllegro.wykonaj(f.db);
  let blad = Object.assign(new Error('HTTP 401'), {status: 401});
  const rejestr = createRejestrKanalow({repozytorium: f.repo, fabryki: () => ({
    klient: {pobierzMojeKonto: async () => {throw blad;}, sprawdzZakresZamowien: async () => 0},
    poller: {stan: () => null, przebieg: async () => {}},
  })});
  const z = createZarzadzanieAllegro({db: f.db, repozytorium: f.repo, autoryzacja: f.auth, rejestr, teraz: f.teraz});
  const szkic = f.szkic();
  const p = daneAllegro(await f.auth.rozpocznijAutoryzacje(szkic.klucz, aktorAllegro, 'A'));
  const konto = daneAllegro(await f.auth.obsluzPowrot({state: new URL(p.adres).searchParams.get('state')!,
    code: 'kod', redirectUri: callbackAllegro}, 'A'));
  const k = daneAllegro(await z.aktywuj(szkic.klucz, p.probaId, konto.wersja, true, aktorAllegro, 'A'));
  const odmowa = await z.sprawdzPolaczenie(k.klucz, k.wersja);
  blad = Object.assign(new Error('read ECONNRESET'), {status: 0, code: 'ECONNRESET'});
  const siec = await z.sprawdzPolaczenie(k.klucz, k.wersja);
  expect(odmowa).toMatchObject({ok: false, komunikat: expect.stringContaining('odmówiło')});
  expect(siec).toMatchObject({ok: false, komunikat: expect.stringContaining('nie odpowiada')});
  if (odmowa.ok || siec.ok) throw new Error('Oczekiwano dwóch błędów');
  expect(odmowa.komunikat).not.toBe(siec.komunikat);
});

it('U32/U33/B6: błąd kluczy ma pas-blad, a instrukcja kluczy jest listą w karcie', async () => {
  const {app} = serwer(usluga(d => createWooClient({...d,
    fetchImpl: async () => Response.json({}, {status: 401})})));
  const szkic = await app.inject({method: 'POST', url: root + '/szkice',
    payload: {nazwa: 'Sklep Przykładowy', adres: daneNowego.adres}});
  expect(szkic.statusCode).toBe(200);
  const id = szkic.body.match(/name="formularzId" value="([^"]+)"/)?.[1];
  expect(id).toBeTruthy();
  const r = await app.inject({method: 'POST', url: root + '/nowy/klucze',
    payload: {formularzId: id, wersja: 0, ck: daneNowego.ck, cs: daneNowego.cs}});
  expect(r.statusCode).toBe(503);
  expect(r.body).toMatch(/<div class="pas-blad" role="alert"><p>Sklep odrzucił klucze\./);
  const karta = r.body.match(/<section class="ust-sekcja">[\s\S]*?<\/section>/)?.[0];
  expect(karta).toContain('Klucze');
  expect(karta).toMatch(/<ol>\s*<li><p>[\s\S]*WooCommerce[\s\S]*<\/p><\/li><\/ol>/);
  const css = readFileSync('src/public/oms-design.css', 'utf8');
  expect(css).toMatch(/\.pas-blad\s*\{[^}]*background:\s*var\(--blad-tlo\)[^}]*color:\s*var\(--blad-tekst\)[^}]*border-color:\s*var\(--blad-ramka\)/);
  expect(css).toMatch(/\.pas-potwierdzenie\s*\{[^}]*background:\s*var\(--ok-tlo\)[^}]*color:\s*var\(--ok-tekst\)/);
});

it('U39: sklep z panelu i konfiguracji pokazuje polski opis identyfikatora', async () => {
  for (const env of [false, true]) {
    const {app, klucz} = serwer(wooDoWidoku(), true, env);
    const r = await app.inject({url: root + '/' + klucz});
    expect(r.statusCode, r.body).toBe(200);
    expect(r.body).toContain('Identyfikator instalacji');
    expect(r.body).not.toContain('instance_id');
    expect(r.body).not.toContain('(oms.env)');
  }
});

it('U41: przyciski mapowania i nazwy są w akapitach karty z odstępem CSS', async () => {
  const {app, klucz} = serwer(wooDoWidoku(), true);
  const r = await app.inject({url: root + '/' + klucz});
  expect(r.statusCode, r.body).toBe(200);
  const karty = r.body.match(/<section class="ust-sekcja">[\s\S]*?<\/section>/g) ?? [];
  for (const napis of ['Zapisz mapowanie', 'Zmień nazwę']) {
    const karta = karty.find(html => html.includes('>' + napis + '</button>'));
    expect(karta).toBeDefined();
    expect(karta).toContain(`<p><button class="ust-przycisk" type="submit">${napis}</button></p>`);
  }
  const layout = readFileSync('src/core/web/widoki/layout-oms.ejs', 'utf8');
  expect(layout).toMatch(/\.ust-sekcja p\s*\{[^}]*margin:\s*0 0 \.8rem\s*;/);
});

it('U42/B9: sześć powodów ma różne komunikaty, nieznany powód daje ogólny', async () => {
  let powod = '';
  const woo = usluga(() => ({sprawdzPolaczenie: async () => ({ok: false, powod}),
    pobierzMetodyWysylki: async () => [], pobierzBramkiPlatnosci: async () => []}));
  const oczekiwane = {siec: 'Sklep nie odpowiada.', adres: 'Nie udało się odnaleźć sklepu.',
    brak_api: 'Pod tym adresem nie znaleziono API WooCommerce.', klucze: 'Sklep odrzucił klucze.',
    certyfikat: 'Sklep ma nieważny lub niezaufany certyfikat HTTPS. Sprawdź certyfikat sklepu (np. czy nie wygasł) i spróbuj ponownie.',
    przekierowanie: 'Adres przekierowuje na inną stronę. Wpisz adres, pod którym sklep działa naprawdę (np. z www albo https).'};
  const komunikaty: string[] = [];
  for (const [p, tekst] of Object.entries(oczekiwane)) {
    powod = p;
    const t = komunikat(await woo.sprawdzNowe(daneNowego));
    expect(t).toContain(tekst);
    komunikaty.push(t);
  }
  expect(new Set(komunikaty).size).toBe(6);
  powod = 'nieznany';
  const ogolny = komunikat(await woo.sprawdzNowe(daneNowego));
  expect(ogolny).toBe('Nie udało się połączyć ze sklepem.');
  expect(komunikaty).not.toContain(ogolny);
});

it.each([
  [401, 'klucze', 'Sklep odrzucił klucze.'],
  [404, 'brak_api', 'Pod tym adresem nie znaleziono API WooCommerce.'],
  ['ECONNRESET', 'siec', 'Sklep nie odpowiada.'],
  ['ENOTFOUND', 'adres', 'Nie udało się odnaleźć sklepu.'],
  ['CERT_HAS_EXPIRED', 'certyfikat', 'Sklep ma nieważny lub niezaufany certyfikat HTTPS.'],
  ['UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'certyfikat', 'Sklep ma nieważny lub niezaufany certyfikat HTTPS.'],
  [302, 'przekierowanie', 'Adres przekierowuje na inną stronę.'],
])('U42/B9: klient Woo %s → %s → komunikat na ekranie', async (status, powod, tekst) => {
  const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => {
    if (typeof status === 'string') throw Object.assign(new Error('read ECONNRESET'), {code: status});
    if (status === 302) return new Response(null, {status, headers: {location: 'https://inny.example.test'}});
    return Response.json({}, {status});
  });
  const klient = createWooClient({...daneNowego, baseUrl: daneNowego.adres, fetchImpl, tylkoTenSamOrigin: true});
  expect(await klient.sprawdzPolaczenie()).toMatchObject({ok: false, powod});
  const {app} = serwer(usluga(d => createWooClient({...d, fetchImpl, tylkoTenSamOrigin: true})));
  const szkic = await app.inject({method: 'POST', url: root + '/szkice',
    payload: {nazwa: 'Sklep Przykładowy', adres: daneNowego.adres}});
  expect(szkic.statusCode).toBe(200);
  const id = szkic.body.match(/name="formularzId" value="([^"]+)"/)?.[1];
  expect(id).toBeTruthy();
  const r = await app.inject({method: 'POST', url: root + '/nowy/klucze',
    payload: {formularzId: id, wersja: 0, ck: daneNowego.ck, cs: daneNowego.cs}});
  expect(r.statusCode).toBe(503);
  expect(r.body).toContain(`<div class="pas-blad" role="alert"><p>${tekst}`);
  expect(fetchImpl).toHaveBeenCalledTimes(2);
  expect(fetchImpl.mock.calls[1]?.[0]).toBe(daneNowego.adres + '/wp-json/wc/v3/orders?per_page=1');
});
