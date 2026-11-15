import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { utworzSerwerZdjec, TYPY } from '../../src/zdjecia-publiczne/serwer.js';

const sha = 'a1'.repeat(32), sha2 = 'b2'.repeat(32), sha3 = 'c3'.repeat(32);
let serwer, katalog, korzen, port;
function pobierz(path, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port, path, method, agent: false }, res => {
      const czesci = [];
      res.on('data', c => czesci.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(czesci).toString() }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
}
beforeAll(async () => {
  korzen = fs.mkdtempSync(join(os.tmpdir(), 'oms-zdjecia-'));
  katalog = join(korzen, 'zdjecia');
  fs.mkdirSync(join(katalog, 'podkatalog'), { recursive: true });
  for (const ext of ['jpg', 'png', 'webp']) fs.writeFileSync(join(katalog, `${sha}.${ext}`), `zdjecie-${ext}`);
  fs.writeFileSync(join(katalog, 'oms.sqlite'), 'fikcyjna baza');
  fs.writeFileSync(join(katalog, 'notatka.txt'), 'fikcyjna notatka');
  fs.writeFileSync(join(katalog, 'podkatalog', `${sha3}.jpg`), 'ukryte');
  fs.mkdirSync(join(katalog, `${'d4'.repeat(32)}.jpg`));
  fs.writeFileSync(join(korzen, 'poza.jpg'), 'poza katalogiem');
  fs.symlinkSync('../poza.jpg', join(katalog, `${sha2}.jpg`));
  serwer = utworzSerwerZdjec({ katalog });
  await new Promise(resolve => serwer.listen(0, '127.0.0.1', resolve));
  port = serwer.address().port;
});
afterAll(async () => {
  if (serwer) await new Promise(resolve => serwer.close(resolve));
  if (korzen) fs.rmSync(korzen, { recursive: true, force: true });
});

describe('publiczne zdjęcia — zamknięta lista plików', () => {
  it.each(['jpg', 'png', 'webp'])('GET %s strumieniuje zdjęcie i podaje bezpieczne nagłówki', async ext => {
    const res = await pobierz(`/z/${sha}.${ext}`);
    expect(res.status).toBe(200);
    expect(res.body).toBe(`zdjecie-${ext}`);
    expect(res.headers['content-type']).toBe(TYPY[ext]);
    expect(res.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers.server).toBeUndefined();
  });
  it('HEAD podaje nagłówki bez ciała', async () => {
    const res = await pobierz(`/z/${sha}.jpg`, 'HEAD');
    expect(res.status).toBe(200);
    expect(res.body).toBe('');
    expect(res.headers['content-type']).toBe('image/jpeg');
    expect(res.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });
  it('ignoruje zapytanie bez zmiany ścieżki', async () => {
    expect(await pobierz(`/z/${sha}.jpg?x=/../oms.sqlite`)).toMatchObject({ status: 200, body: 'zdjecie-jpg' });
  });
  it.each([
    '/', '/z/', '/z', '/z/../oms.sqlite', '/z/%2e%2e%2foms.sqlite',
    `/z/${sha}.jpg/../x`, `/z/${sha.toUpperCase()}.jpg`, `/z/${sha}.svg`,
    `/z/podkatalog/${sha3}.jpg`, `/z/${sha3}.jpg`, '/z/oms.sqlite', '/z/notatka.txt',
    `/z/${sha2}.jpg`, `/z/${'d4'.repeat(32)}.jpg`, `/inne/z/${sha}.jpg`,
    `/z/${sha}.jpg/dalej`, `/z/${sha.slice(1)}.jpg`, `/z/${sha}0.jpg`,
    `/z/${sha}.JPG`, `/z/${sha}.jpg%00`, `/z/${sha}.jpg%2f..`,
  ])('odmawia 404: %s', async path => {
    const res = await pobierz(path);
    expect(res.status).toBe(404);
    expect(res.body).toBe('');
    expect(res.headers.server).toBeUndefined();
  });
  it.each(['POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'])('odmawia metody %s', async method => {
    expect([404, 405]).toContain((await pobierz(`/z/${sha}.jpg`, method)).status);
  });
  it('odrzuca złą ścieżkę przed dostępem do dysku', async () => {
    const odczyt = vi.spyOn(fs, 'lstat');
    try {
      expect((await pobierz('/z/../oms.sqlite')).status).toBe(404);
      expect(odczyt).not.toHaveBeenCalled();
    } finally { odczyt.mockRestore(); }
  });
  it('ma identyczne rozszerzenia i MIME jak magazyn plików', () => {
    const kod = fs.readFileSync(new URL('../../src/moduly/magazyn/services/zdjecia-pliki.js', import.meta.url), 'utf8');
    const wpisy = [...kod.match(/const TYPY = \{([^}]+)\}/)[1].matchAll(/(\w+): '([^']+)'/g)];
    expect(TYPY).toEqual(Object.fromEntries(wpisy.map(([, ext, mime]) => [ext, mime])));
  });
  it('nie oddaje pliku podmienionego na symlink pomiędzy lstat a otwarciem', async () => {
    const plik = join(katalog, `${sha}.jpg`);
    const oryginalneLstat = fs.lstat;
    const odczyt = vi.spyOn(fs, 'lstat').mockImplementation((cel, callback) => {
      oryginalneLstat(cel, (blad, dane) => {
        if (!blad && cel === plik) {
          fs.unlinkSync(plik);
          fs.symlinkSync('../poza.jpg', plik);
        }
        callback(blad, dane);
      });
    });
    try {
      expect(await pobierz(`/z/${sha}.jpg`)).toMatchObject({ status: 404, body: '' });
    } finally {
      odczyt.mockRestore();
      fs.unlinkSync(plik);
      fs.writeFileSync(plik, 'zdjecie-jpg');
    }
  });
  it('nie zmienia zawartości katalogu zdjęć', () => {
    expect(fs.readdirSync(katalog).sort()).toEqual([
      `${sha}.jpg`, `${sha}.png`, `${sha}.webp`, `${sha2}.jpg`, `${'d4'.repeat(32)}.jpg`,
      'oms.sqlite', 'notatka.txt', 'podkatalog',
    ].sort());
  });
  it('używa strumienia, bez pełnego odczytu i zapisów na dysk', async () => {
    const strumien = vi.spyOn(fs, 'createReadStream');
    const operacje = ['readFile', 'readFileSync', 'writeFile', 'writeFileSync', 'appendFile', 'appendFileSync', 'mkdir', 'unlink', 'rename']
      .map(metoda => vi.spyOn(fs, metoda));
    try {
      expect((await pobierz(`/z/${sha}.jpg`)).body).toBe('zdjecie-jpg');
      expect(strumien).toHaveBeenCalledWith(join(katalog, `${sha}.jpg`));
      for (const operacja of operacje) expect(operacja).not.toHaveBeenCalled();
    } finally {
      strumien.mockRestore();
      for (const operacja of operacje) operacja.mockRestore();
    }
  });
});
