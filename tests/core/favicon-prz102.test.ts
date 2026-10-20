import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { get as httpGet } from 'node:http';
import { zbudujOms } from '../../src/oms/bootstrap.ts';
import { zalozKonto } from '../../src/core/bezpieczenstwo/konta.js';
import { jako } from '../pomoc/konta-prz068.js';
import { czyTrasaOtwarta } from '../../src/core/bezpieczenstwo/logowanie-wspolne.js';
import { przelaczModul } from '../../src/oms/db/moduly-opcjonalne.js';

const env = { OMS_USER: 'operator', OMS_PASS: 'fixture', OMS_KANALY: '[]',
  OMS_SPRZEDAWCA_NIP: '1234563218', OMS_RACHUNEK: '34109010140000000000000000',
  OMS_PROFORMY_KATALOG: tmpdir(), OMS_ETYKIETY_KATALOG: tmpdir() };
const katalogi: string[] = [];
let oms: Awaited<ReturnType<typeof zbudujOms>> | undefined;
afterEach(async () => {
  await oms?.app.close(); oms?.db.close(); oms = undefined;
  for (const k of katalogi.splice(0)) rmSync(k, { recursive: true, force: true });
});
async function panel(extra = {}) {
  oms = await zbudujOms({ env: { ...env, ...extra } });
  return oms;
}
function ikona(html: string) {
  const link = html.match(/<link\b[^>]*rel="icon"[^>]*>/)?.[0];
  expect(link, 'układ ma ikonę PNG').toContain('type="image/png"');
  return link!.match(/href="([^"]+)"/)![1];
}

it('favicon bez logowania: 301 do wersjonowanej ikony 32 px, cel zwraca PNG z paczki', async () => {
  const { app } = await panel();
  const r = await app.inject('/favicon.ico');
  expect(r.statusCode).toBe(301);
  expect(r.headers.location).toMatch(/^\/public\/favicon-32\.png\?v=[a-f0-9]{10}$/);
  const png = await app.inject(r.headers.location!);
  expect(png.statusCode).toBe(200);
  expect(png.headers['content-type']).toBe('image/png');
  expect(png.rawPayload).toEqual(readFileSync(new URL('../../src/public/favicon-32.png', import.meta.url)));
});

it.each(['/favicon.ico.bak', '/favicon.icox', '/public/../favicon.ico'])('sąsiedni adres %s pozostaje chroniony', async (url) => {
  const { app } = await panel();
  expect(czyTrasaOtwarta(url)).toBe(false);
  // inject (WHATWG URL) usuwa „..” przed wysłaniem; surowa ścieżka HTTP musi dojść do strażnika.
  await app.listen({ host: '127.0.0.1', port: 0 });
  const port = (app.server.address() as { port: number }).port;
  const status = await new Promise<number>((resolve, reject) => {
    httpGet({ host: '127.0.0.1', port, path: url }, (r) => {
      r.resume(); resolve(r.statusCode!);
    }).on('error', reject);
  });
  expect(status).toBe(401);
});

it('lista otwiera dokładny adres ikony, także z query, bez zmiany tras chronionych', () => {
  expect(czyTrasaOtwarta('/favicon.ico')).toBe(true);
  expect(czyTrasaOtwarta('/favicon.ico?v=1')).toBe(true);
  expect(czyTrasaOtwarta('/zamowienia')).toBe(false);
});

it('panel, login, odmowa i moduł wyłączony linkują tę samą wersjonowaną ikonę', async () => {
  const { app, db } = await panel();
  zalozKonto(db, { login: 'sprzedawca', imie: 'Operator', haslo: 'fixture', rola: 'sprzedaz', admin: false });
  const odmowa = await app.inject({ url: '/ustawienia/uzytkownicy', headers: { ...jako(db, 'sprzedawca'), accept: 'text/html' } });
  expect(odmowa.statusCode).toBe(403);
  const url = ikona(odmowa.body);
  for (const adres of ['/login', '/']) {
    const r = await app.inject({ url: adres, headers: { authorization: `Basic ${Buffer.from('operator:fixture').toString('base64')}` } });
    expect(r.statusCode).toBe(200);
    expect(ikona(r.body)).toBe(url);
  }
  przelaczModul(db, { modul: 'okresy', wlacz: false });
  const modul = await app.inject({ url: '/okresy', headers: { ...jako(db, 'sprzedawca'), accept: 'text/html' } });
  expect(modul.statusCode).toBe(404);
  expect(ikona(modul.body)).toBe(url);
});

it('logo instalacji jest też ikoną karty; zmiana logo zmienia wersję adresu', async () => {
  const k = mkdtempSync(join(tmpdir(), 'oms-favicon-')); katalogi.push(k);
  const plik = join(k, 'logo.png');
  const logo = readFileSync(new URL('../../src/public/favicon-192.png', import.meta.url));
  writeFileSync(plik, logo);
  let { app } = await panel({ OMS_LOGO_PLIK: plik });
  const url = ikona((await app.inject('/login')).body);
  expect((await app.inject('/favicon.ico')).headers.location).toBe(url);
  for (const adres of [url, '/public/favicon-192.png']) expect((await app.inject(adres)).rawPayload).toEqual(logo);
  await oms!.app.close(); oms!.db.close(); oms = undefined;
  const inneLogo = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYPj/HwADAgH/zW3mEwAAAABJRU5ErkJggg==', 'base64');
  writeFileSync(plik, inneLogo);
  ({ app } = await panel({ OMS_LOGO_PLIK: plik }));
  const nowyUrl = ikona((await app.inject('/login')).body);
  expect(nowyUrl).not.toBe(url);
  expect((await app.inject(nowyUrl)).rawPayload).toEqual(inneLogo);
});
