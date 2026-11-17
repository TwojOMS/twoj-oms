import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { inflateSync } from 'node:zlib';
import { zbudujOms } from '../../src/oms/bootstrap.ts';

// Znak domyślny panelu (bez wgranego logo): PNG 32 i 192 px z paczki (src/public), które panel podaje jako ikonę
// karty i znak w belce. Test sprawdza, że oba pliki są poprawnymi obrazami we właściwym rozmiarze, że coś na nich
// narysowano (nie pusty ani jednolity prostokąt) i że panel serwuje dokładnie te bajty. Wygląd znaku — kształt
// i kolor — jest sprawą projektu: inny znak albo inny kolor nie czerwienią tego testu.
// Test dekoduje prawdziwe PNG, bo wymiary w nagłówku nie mówią, co jest narysowane.

const plik = (nazwa) => readFileSync(new URL(`../../src/public/${nazwa}`, import.meta.url));

/** Minimalny dekoder PNG RGBA 8-bit bez przeplotu (format plików znaku w paczce). */
function dekoduj(bajty) {
  expect([...bajty.subarray(0, 8)], 'podpis PNG').toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  let p = 8; let w; let h; const idat = [];
  while (p < bajty.length) {
    const dlugosc = bajty.readUInt32BE(p); const typ = bajty.toString('latin1', p + 4, p + 8);
    const dane = bajty.subarray(p + 8, p + 8 + dlugosc);
    if (typ === 'IHDR') { w = dane.readUInt32BE(0); h = dane.readUInt32BE(4); expect([...dane.subarray(8, 13)]).toEqual([8, 6, 0, 0, 0]); }
    if (typ === 'IDAT') idat.push(dane);
    p += 12 + dlugosc;
  }
  const surowe = inflateSync(Buffer.concat(idat)); const st = w * 4; const px = Buffer.alloc(h * st);
  for (let y = 0; y < h; y++) {
    const f = surowe[y * (st + 1)]; const r = surowe.subarray(y * (st + 1) + 1, (y + 1) * (st + 1));
    for (let x = 0; x < st; x++) {
      const a = x >= 4 ? px[y * st + x - 4] : 0; const u = y ? px[(y - 1) * st + x] : 0; const c = x >= 4 && y ? px[(y - 1) * st + x - 4] : 0;
      let v = r[x];
      if (f === 1) v += a; else if (f === 2) v += u; else if (f === 3) v += (a + u) >> 1;
      else if (f === 4) { const q = a + u - c; const pa = Math.abs(q - a); const pb = Math.abs(q - u); const pc = Math.abs(q - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? u : c; }
      px[y * st + x] = v & 255;
    }
  }
  const piksele = [];
  for (let i = 0; i < w * h; i++) piksele.push(px.readUInt32BE(i * 4));
  return { w, h, piksele };
}

let oms;
beforeAll(async () => {
  oms = await zbudujOms({ env: { OMS_USER: 'operator', OMS_PASS: 'fixture', OMS_KANALY: '[]',
    OMS_SPRZEDAWCA_NIP: '1234563218', OMS_RACHUNEK: '34109010140000000000000000',
    OMS_PROFORMY_KATALOG: tmpdir(), OMS_ETYKIETY_KATALOG: tmpdir() } });
});
afterAll(async () => { await oms?.app.close(); oms?.db.close(); });

describe.each([192, 32])('favicon-%i.png — znak domyślny', (rozmiar) => {
  const bajty = plik(`favicon-${rozmiar}.png`);
  const { w, h, piksele } = dekoduj(bajty);

  it('jest poprawnym PNG we właściwym rozmiarze', () => {
    expect([w, h]).toEqual([rozmiar, rozmiar]);
  });
  it('coś na nim narysowano: widoczne piksele i więcej niż jeden kolor', () => {
    const widoczne = piksele.filter((p) => (p & 0xff) > 0).length;
    expect(widoczne / piksele.length, 'udział widocznych pikseli').toBeGreaterThan(0.05);
    expect(new Set(piksele).size, 'różne piksele').toBeGreaterThan(1);
  });
  it('panel serwuje dokładnie ten plik jako PNG', async () => {
    const r = await oms.app.inject(`/public/favicon-${rozmiar}.png`);
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toBe('image/png');
    expect(r.rawPayload).toEqual(bajty);
  });
});
