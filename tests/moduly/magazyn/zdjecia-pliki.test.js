import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmod, mkdir, mkdtemp, open, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { request as httpsRequest } from 'node:https';
import { katalogZdjec, zapiszZdjecie, pobierzZdjecie } from '../../../src/moduly/magazyn/services/zdjecia-pliki.js';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { buildOmsServer } from '../../pomoc/serwer-testowy-oms.ts';
import { zalozKonto, ustawUprawnienia } from '../../../src/core/bezpieczenstwo/konta.js';
import { podpisz, NAZWA_CIASTECZKA_OMS } from '../../../src/core/bezpieczenstwo/sesja.js';
import { wczytajSekret } from '../../../src/core/bezpieczenstwo/sekret-sesji.js';

vi.mock('node:https', () => ({ request: vi.fn(() => { throw new Error('Test zabrania sieci'); }) }));

function png(w = 2, h = 3) {
  const b = Buffer.alloc(33);
  Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex').copy(b);
  b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20);
  return b;
}
function jpeg() {
  return Buffer.from('ffd8ffe000040000ffc00011080003000203011100021100031100ffd9', 'hex');
}
function webp(typ) {
  const b = Buffer.alloc(30);
  b.write('RIFF'); b.writeUInt32LE(22, 4); b.write('WEBP', 8); b.write(typ, 12);
  b.writeUInt32LE(10, 16);
  if (typ === 'VP8X') { b.writeUIntLE(1, 24, 3); b.writeUIntLE(2, 27, 3); }
  if (typ === 'VP8 ') { b[23] = 0x9d; b[24] = 1; b[25] = 0x2a; b.writeUInt16LE(2, 26); b.writeUInt16LE(3, 28); }
  if (typ === 'VP8L') { b[20] = 0x2f; b.writeUInt32LE(1 | (2 << 14), 21); }
  return b;
}
let katalog, app, db;
beforeEach(async () => { katalog = await mkdtemp(join(tmpdir(), 'oms-zdjecia-')); });
afterEach(async () => { await app?.close(); app = null; db?.close(); db = null; await rm(katalog, { recursive: true, force: true }); });
const lookup = vi.fn(async () => [{ address: '93.184.216.34', family: 4 }]);
const adres = 'https://obrazy.example/bez-rozszerzenia';
const odpowiedz = () => new Response(png());

describe('magazyn plików', () => {
  it('wybiera katalog obok bazy i fallback main, bez tworzenia katalogu', () => {
    expect(katalogZdjec({})).toBe('/data-oms/zdjecia');
    expect(katalogZdjec({ OMS_DB_PATH: '' })).toBe('/data-oms/zdjecia');
    expect(katalogZdjec({ OMS_DB_PATH: '/tmp/proba/baza.sqlite', OMS_KATALOG_ZDJEC: '' })).toBe('/tmp/proba/zdjecia');
    expect(katalogZdjec({ OMS_KATALOG_ZDJEC: '/tmp/foto' })).toBe('/tmp/foto');
  });
  it.each([['PNG', png(), 'png', 'image/png'], ['JPEG', jpeg(), 'jpg', 'image/jpeg'], ...['VP8X', 'VP8 ', 'VP8L'].map(t => [t, webp(t), 'webp', 'image/webp'])])('rozpoznaje %s po treści', async (_, b, ext, typ) => {
    const r = await zapiszZdjecie(b, { katalog });
    expect(r).toMatchObject({ typ, rozmiar: b.length, szerokosc: 2, wysokosc: 3 });
    expect(r.plik).toMatch(new RegExp(`^[0-9a-f]{64}\\.${ext}$`));
  });
  it.each([['HTML udający .jpg', Buffer.from('<html>zdjecie.jpg</html>')], ['GIF', Buffer.from('GIF89a')], ['za duży', Buffer.alloc(10 * 1024 * 1024 + 1)], ['zerowy wymiar', png(0)], ['wymiar >10000', png(10001)], ['ucięty PNG', png().subarray(0, 20)], ['ucięty JPEG', jpeg().subarray(0, 15)]])('odmawia: %s', async (_, b) => {
    await expect(zapiszZdjecie(b, { katalog })).rejects.toThrow();
    expect(await readdir(katalog)).toEqual([]);
  });
  it('tworzy katalog przy zapisie, deduplikuje bez ponownego zapisu', async () => {
    const opcje = { katalog: join(katalog, 'nowy') };
    const a = await zapiszZdjecie(png(), opcje);
    const przed = await stat(join(opcje.katalog, a.plik));
    expect(await zapiszZdjecie(png(), opcje)).toEqual(a);
    expect((await stat(join(opcje.katalog, a.plik))).ino).toBe(przed.ino);
    expect(await readdir(opcje.katalog)).toEqual([a.plik]);
  });
  it('naprawia ucięty plik docelowy zapisem pełnej treści', async () => {
    const b = png();
    const plik = createHash('sha256').update(b).digest('hex') + '.png';
    await writeFile(join(katalog, plik), '');
    await zapiszZdjecie(b, { katalog });
    expect((await stat(join(katalog, plik))).size).toBe(b.length);
    expect(await readFile(join(katalog, plik))).toEqual(b);
    expect(await readdir(katalog)).toEqual([plik]);
  });
  it('synchronizuje plik tymczasowy przed udostępnieniem i nadaje prawa 0644', async () => {
    const uchwyt = await open(join(katalog, 'sonda'), 'wx');
    const prototyp = Object.getPrototypeOf(uchwyt);
    await uchwyt.close();
    await rm(join(katalog, 'sonda'));
    const oryginalnySync = prototyp.sync;
    const sync = vi.spyOn(prototyp, 'sync').mockImplementation(async function () {
      expect(await readdir(katalog)).toEqual([expect.stringMatching(/^\.zdjecie-.*\.tmp$/)]);
      return oryginalnySync.call(this);
    });
    try {
      const r = await zapiszZdjecie(png(), { katalog });
      expect(sync).toHaveBeenCalledTimes(1);
      expect((await stat(join(katalog, r.plik))).mode & 0o777).toBe(0o644);
    } finally { sync.mockRestore(); }
  });
});

describe('pobieranie bez sieci', () => {
  it('transport produkcyjny przypina IP, zachowuje host TLS i nie ponawia DNS', async () => {
    const dns = vi.fn(lookup);
    httpsRequest.mockImplementationOnce((url, opcje, odpowiedz) => {
      expect(url).toBe(adres);
      expect(opcje.agent).toBe(false);
      const wynik = vi.fn();
      opcje.lookup('obrazy.example', { all: true }, wynik);
      expect(wynik).toHaveBeenCalledWith(null, [{ address: '93.184.216.34', family: 4 }], 4);
      opcje.lookup('obrazy.example', {}, wynik);
      expect(wynik).toHaveBeenLastCalledWith(null, '93.184.216.34', 4);
      const req = new EventEmitter();
      req.end = () => {
        const res = Readable.from([png()]);
        res.statusCode = 200; res.headers = {};
        odpowiedz(res);
      };
      return req;
    });
    expect(await pobierzZdjecie(adres, { lookup: dns })).toEqual(png());
    expect(dns).toHaveBeenCalledTimes(1);
  });
  it.each(['http://public.example/x', 'https://127.0.0.1/', 'https://10.0.0.5/', 'https://[::1]/', 'https://169.254.169.254/', 'https://100.64.0.1/', 'https://[fc00::1]/', 'https://[fe80::1]/', 'https://[::ffff:8.8.8.8]/', 'https://user:pass@public.example/'])('odmawia %s przed fetch', async url => {
    const fetch = vi.fn(odpowiedz);
    await expect(pobierzZdjecie(url, { fetch, lookup })).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each(['192.168.1.10', '127.0.0.1', '::1', 'fd12::1', '::ffff:192.168.1.10'])('sprawdza DNS %s', async address => {
    const fetch = vi.fn(odpowiedz);
    await expect(pobierzZdjecie(adres, { fetch, lookup: async () => [{ address }] })).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
  it('odmawia również mieszanego DNS publicznego/prywatnego', async () => {
    await expect(pobierzZdjecie(adres, { fetch: odpowiedz, lookup: async () => [{ address: '8.8.8.8' }, { address: '10.0.0.1' }] })).rejects.toThrow();
  });
  it('pobiera bajty, ręczne przekierowania, bez auth i cookies', async () => {
    const fetch = vi.fn(odpowiedz);
    expect(await pobierzZdjecie(adres, { fetch, lookup })).toEqual(png());
    expect(fetch.mock.calls[0][1]).toMatchObject({ redirect: 'manual', credentials: 'omit' });
    expect(fetch.mock.calls[0][1].headers).toBeUndefined();
  });
  it('sprawdza prywatny cel przekierowania i anuluje odpowiedź', async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 302, headers: { location: 'https://10.0.0.1/x' } }));
    await expect(pobierzZdjecie(adres, { fetch, lookup })).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('sprawdza DNS nowego hosta przekierowania', async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 301, headers: { location: 'https://wewnetrzny.example/x' } }));
    await expect(pobierzZdjecie(adres, { fetch, lookup: async h => [{ address: h === 'wewnetrzny.example' ? '10.0.0.1' : '8.8.8.8' }] })).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('pozwala na trzy przekierowania względne', async () => {
    let n = 0;
    const fetch = vi.fn(async () => n++ < 3 ? new Response(null, { status: 302, headers: { location: `/foto${n}` } }) : odpowiedz());
    expect(await pobierzZdjecie(adres, { fetch, lookup })).toEqual(png());
    expect(fetch).toHaveBeenCalledTimes(4);
  });
  it('odmawia czwartego przekierowania', async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 307, headers: { location: '/dalej' } }));
    await expect(pobierzZdjecie(adres, { fetch, lookup })).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(4);
  });
  it('przerywa strumień po limicie bez content-length', async () => {
    const cancel = vi.fn();
    const fetch = async () => new Response(new ReadableStream({ pull(c) { c.enqueue(new Uint8Array(8)); }, cancel }));
    await expect(pobierzZdjecie(adres, { fetch, lookup, limitBajtow: 10 })).rejects.toThrow();
    expect(cancel).toHaveBeenCalled();
  });
  it.each(['DNS', 'fetch', 'strumień'])('limit czasu obejmuje %s', async etap => {
    const nigdy = () => new Promise(() => {});
    await expect(pobierzZdjecie(adres, {
      limitCzasuMs: 20, lookup: etap === 'DNS' ? nigdy : lookup,
      fetch: etap === 'fetch' ? nigdy : async () => new Response(new ReadableStream({ pull: nigdy })),
    })).rejects.toThrow();
  });
  it('odmawia odpowiedzi HTTP z błędem', async () => {
    await expect(pobierzZdjecie(adres, { lookup, fetch: async () => new Response('blad', { status: 404 }) })).rejects.toThrow();
  });
});

describe('podgląd przez rzeczywisty panel (inject, bez sieci)', () => {
  const headers = { authorization: `Basic ${Buffer.from('operator:atrapa').toString('base64')}` };
  beforeEach(() => {
    db = openOmsDb(':memory:');
    app = buildOmsServer({ db, config: { auth: { user: 'operator', pass: 'atrapa' } }, env: { OMS_KATALOG_ZDJEC: katalog } });
  });
  it('wymaga zalogowania jak magazyn', async () => {
    const r = await zapiszZdjecie(png(), { katalog });
    const odmowa = await app.inject({ url: '/magazyn' });
    const zdjecie = await app.inject({ url: `/magazyn/zdjecia/${r.plik}` });
    expect([401, 302, 303]).toContain(odmowa.statusCode);
    expect(zdjecie.statusCode).toBe(odmowa.statusCode);
  });
  it('wymaga również uprawnienia magazyn', async () => {
    const r = await zapiszZdjecie(png(), { katalog });
    await app.ready();
    zalozKonto(db, { login: 'admin', imie: 'Admin', haslo: 'test', rola: 'admin', admin: true });
    const id = zalozKonto(db, { login: 'czytelnik', imie: 'Czytelnik', haslo: 'test', rola: 'operator' });
    ustawUprawnienia(db, id, []);
    const naglowki = { cookie: `${NAZWA_CIASTECZKA_OMS}=${podpisz('czytelnik', wczytajSekret(db), Date.now(), 0)}` };
    const get = () => app.inject({ url: `/magazyn/zdjecia/${r.plik}`, headers: naglowki });
    expect((await get()).statusCode).toBe(403);
    ustawUprawnienia(db, id, ['magazyn']);
    expect((await get()).statusCode).toBe(200);
  });
  it.each(['../', '%2e%2e%2f', 'A'.repeat(64) + '.png', 'a'.repeat(64) + '.gif', 'a'.repeat(64) + '.PNG'])('404 dla %s', async plik => {
    // Kodujemy parametr, żeby parser URL klienta testowego nie skrócił ../
    // do /magazyn/ przed wysłaniem żądania do testowanej trasy.
    expect((await app.inject({ url: `/magazyn/zdjecia/${encodeURIComponent(plik)}`, headers })).statusCode).toBe(404);
  });
  it.each([['PNG', png(), 'image/png'], ['JPEG', jpeg(), 'image/jpeg'], ['WebP', webp('VP8X'), 'image/webp']])('oddaje bajty i nagłówki %s', async (_, b, typ) => {
    const r = await zapiszZdjecie(b, { katalog });
    const res = await app.inject({ url: `/magazyn/zdjecia/${r.plik}`, headers });
    expect(res.statusCode).toBe(200);
    expect(res.rawPayload).toEqual(b);
    expect(res.headers['content-type']).toBe(typ);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['cache-control']).toBe('private, max-age=31536000, immutable');
  });
  it('404 dla ..%2F i istniejącego zdjęcia poza katalogiem', async () => {
    const r = await zapiszZdjecie(png(), { katalog });
    const podkatalog = join(katalog, 'podglad');
    await mkdir(podkatalog);
    await app.close();
    app = buildOmsServer({ db, config: { auth: { user: 'operator', pass: 'atrapa' } }, env: { OMS_KATALOG_ZDJEC: podkatalog } });
    const res = await app.inject({ url: `/magazyn/zdjecia/..%2F${r.plik}`, headers });
    expect(res.statusCode).toBe(404);
  });
  it('ukrywa szczegóły EACCES w odpowiedzi 500 dla pliku z prawami 000', async () => {
    if (process.getuid?.() === 0) return; // root może odczytać plik mimo praw 000.
    const r = await zapiszZdjecie(png(), { katalog });
    const plik = join(katalog, r.plik);
    await chmod(plik, 0o000);
    try {
      const res = await app.inject({ url: `/magazyn/zdjecia/${r.plik}`, headers });
      expect(res.statusCode).toBe(500);
      expect(res.body).not.toContain(katalog);
      expect(res.body).not.toContain('EACCES');
      expect(res.body).toBe('');
    } finally { await chmod(plik, 0o644); }
  });
  it('404 dla brakującego pliku i dowiązania', async () => {
    const plik = 'a'.repeat(64) + '.png';
    expect((await app.inject({ url: `/magazyn/zdjecia/${plik}`, headers })).statusCode).toBe(404);
    await symlink('/nieistniejacy-plik', join(katalog, plik));
    expect((await app.inject({ url: `/magazyn/zdjecia/${plik}`, headers })).statusCode).toBe(404);
  });
});
