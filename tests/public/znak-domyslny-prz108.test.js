import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { inflateSync } from 'node:zlib';

// PRZ-108.03b: znak domyślny panelu (bez wgranego logo) to SYGNET produktu „Twój OMS” ze strony twojoms.pl —
// sam sygnet w kolorze marki #1F6B45 na PRZEZROCZYSTYM tle (bez jasnego kwadratu), a nie szara ikonka listy.
// Test dekoduje prawdziwe PNG z paczki (src/public), bo wymiary w nagłówku nie mówią, co jest narysowane.

const plik = (nazwa) => readFileSync(new URL(`../../src/public/${nazwa}`, import.meta.url));
const sha = (bajty) => createHash('sha256').update(bajty).digest('hex');
// Odciski dawnej ikonki listy (PRZ-102): znak domyślny NIE może do niej wrócić.
const STARE = {
  192: '8b1930d0553795711de587f72c7dcaaede4ffcc2481bdbe0760302544fdbb273',
  32: '1a6f162b6131c931cf7618cb513900d55e02e9664cdebf18449817f03e41ca10',
};
const ZIELEN_MARKI = [0x1f, 0x6b, 0x45];

/** Minimalny dekoder PNG RGBA 8-bit bez przeplotu (tyle, ile potrzeba do odczytu pikseli). */
function dekoduj(bajty) {
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
  const piksel = (x, y) => [...px.subarray((y * w + x) * 4, (y * w + x) * 4 + 4)];
  return { w, h, piksel };
}

describe.each([192, 32])('favicon-%i.png — znak domyślny', (rozmiar) => {
  const bajty = plik(`favicon-${rozmiar}.png`);
  const { w, h, piksel } = dekoduj(bajty);

  it('ma właściwy rozmiar i nie jest dawną ikonką listy', () => {
    expect([w, h]).toEqual([rozmiar, rozmiar]);
    expect(sha(bajty)).not.toBe(STARE[rozmiar]);
  });
  it('tło jest przezroczyste (cztery narożniki), a nie jasny kwadrat', () => {
    for (const [x, y] of [[0, 0], [w - 1, 0], [0, h - 1], [w - 1, h - 1]]) expect(piksel(x, y)[3], `narożnik ${x},${y}`).toBe(0);
  });
  it('lewa belka sygnetu jest w kolorze marki, pełna', () => {
    // sygnet: pionowa belka x 4–12 (z 48), środek wysokości; otwór w środku jest przezroczysty
    const x = Math.round(rozmiar * 8 / 48); const y = Math.round(rozmiar / 2);
    expect(piksel(x, y)).toEqual([...ZIELEN_MARKI, 255]);
    expect(piksel(Math.round(rozmiar / 2), Math.round(rozmiar / 2))[3], 'otwór sygnetu').toBe(0);
  });
});
