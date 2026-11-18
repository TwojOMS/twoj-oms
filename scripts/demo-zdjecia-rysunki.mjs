// Własne sylwetki lamp, bez zależności i materiałów z internetu.
// Uruchomienie: node scripts/demo-zdjecia-rysunki.mjs [katalog-wynikowy]
import { deflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { PRODUKTY } from './demo-dane-firma.mjs';

function crc32(b) {
  let crc = 0xffffffff;
  for (const n of b) {
    crc ^= n;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function fragment(typ, dane) {
  const b = Buffer.alloc(dane.length + 12);
  b.writeUInt32BE(dane.length);
  b.write(typ, 4, 4, 'ascii');
  dane.copy(b, 8);
  b.writeUInt32BE(crc32(b.subarray(4, -4)), b.length - 4);
  return b;
}

export function rysunekLampy(sku, nr) {
  const cechy = createHash('sha256').update(sku).digest();
  const szer = 240,
    wys = 240;
  const tlo = [220 + (cechy[0] % 30), 220 + (cechy[1] % 30), 220 + (cechy[2] % 30)];
  const klosz = [60 + (cechy[3] % 140), 60 + (cechy[4] % 140), 60 + (cechy[5] % 140)];
  const promien = 40 + (cechy[6] % 32);
  const gora = 32 + (cechy[7] % 25) + nr * 5;
  const dol = gora + 42 + (cechy[8] % 28);
  const ksztalt = cechy[9] % 3;
  const srodek = nr === 1 ? 112 : 128;
  const piksele = Buffer.alloc((szer * 3 + 1) * wys);
  for (let y = 0; y < wys; y++) {
    for (let x = 0; x < szer; x++) {
      const dx = Math.abs(x - srodek);
      const wKloszu =
        ksztalt === 0
          ? y >= gora && y <= dol && dx <= promien * (0.5 + (0.5 * (y - gora)) / (dol - gora))
          : ksztalt === 1
            ? ((x - srodek) / promien) ** 2 + ((y - (gora + dol) / 2) / ((dol - gora) / 2)) ** 2 <= 1
            : y >= gora && y <= dol && dx <= promien;
      const podstawa = y >= 199 && y <= 207 && dx <= 34 + (cechy[10] % 15);
      const noga = y >= dol && y < 199 && dx <= 4;
      const kolor = wKloszu ? klosz : podstawa || noga ? [65, 60, 55] : tlo;
      const offset = y * (szer * 3 + 1) + 1 + x * 3;
      for (let k = 0; k < 3; k++) piksele[offset + k] = kolor[k];
    }
  }
  const naglowek = Buffer.alloc(13);
  naglowek.writeUInt32BE(szer, 0);
  naglowek.writeUInt32BE(wys, 4);
  naglowek[8] = 8; // 8 bitów na składową
  naglowek[9] = 2; // RGB
  return Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'),
    fragment('IHDR', naglowek),
    fragment('IDAT', deflateSync(piksele, { level: 9 })),
    fragment('IEND', Buffer.alloc(0)),
  ]);
}

export function generujRysunki(katalog) {
  mkdirSync(katalog, { recursive: true });
  for (const p of PRODUKTY)
    for (const nr of [1, 2]) {
      writeFileSync(path.join(katalog, `rys-${p.sku.toLowerCase()}-${nr}.png`), rysunekLampy(p.sku, nr));
    }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  generujRysunki(process.argv[2] ?? fileURLToPath(new URL('../src/public/demo-produkty/', import.meta.url)));
}
