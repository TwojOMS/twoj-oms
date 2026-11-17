import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { KANALY, PRODUKTY } from '../../scripts/demo-dane-firma.mjs';
import { ADRES_ZDJEC_DEMO, zdjecieProduktu, katalogWoo, ofertyAllegro, ofertaAllegroPelna } from '../../scripts/demo-dane-katalog.mjs';
import { daneOpisu } from '../../src/moduly/magazyn/opis.js';
import { opisDoSekcji, sekcjeAllegroDoSekcji } from '../../src/domena/opis-sekcje.js';

const katalog = path.resolve('src/public/demo-produkty');
const bezTresci = new Set(['LMP-KIN-001', 'LMP-KIN-002', 'LMP-STO-002-OUT', 'LMP-STO-005-OUT']);
const sha = b => createHash('sha256').update(b).digest('hex');
const plik = adres => {
  expect(adres.startsWith(`${ADRES_ZDJEC_DEMO}/`)).toBe(true);
  return path.join(katalog, adres.slice(ADRES_ZDJEC_DEMO.length + 1));
};
function sprawdzZdjecia(sku, adresy) {
  if (bezTresci.has(sku)) { expect(adresy).toEqual([]); return; }
  expect(adresy.length).toBeGreaterThanOrEqual(2);
  expect(adresy.length).toBeLessThanOrEqual(3);
  expect(adresy[0]).toBe(zdjecieProduktu(sku));
  for (const adres of adresy) {
    const b = fs.readFileSync(plik(adres));
    expect(b.subarray(0, 8).toString('hex') === '89504e470d0a1a0a' || b.subarray(0, 3).toString('hex') === 'ffd8ff').toBe(true);
    if (adres.endsWith('.png')) expect(b.length).toBeLessThan(8 * 1024);
  }
}
function sprawdzCzyszczenie(opis, adresy) {
  // daneOpisu wywołuje prywatne oczyscOpis; zdjęcia należą do galerii karty.
  const db = { prepare: sql => sql.includes('zdjecia_kart')
    ? { all: () => adresy.map(adres_zrodlowy => ({ adres_zrodlowy })) }
    : { get: () => ({ opis_sekcje_json: JSON.stringify(opis) }) } };
  expect(daneOpisu(db, 1).podglad).toEqual(opis.sekcje);
}

// Odczyt pikseli PNG z generatora: RGB 8 bit, jeden IDAT, filtr 0 w każdym wierszu.
function piksele(b) {
  const [szer, wys] = [b.readUInt32BE(16), b.readUInt32BE(20)];
  expect([b[24], b[25]]).toEqual([8, 2]);
  const dane = inflateSync(b.subarray(41, 41 + b.readUInt32BE(33)));
  expect(dane.length).toBe((szer * 3 + 1) * wys);
  const kolor = (x, y) => { const o = y * (szer * 3 + 1) + 1 + x * 3; return [dane[o], dane[o + 1], dane[o + 2]].join(','); };
  return { szer, wys, kolor, filtry: Array.from({ length: wys }, (_, y) => dane[y * (szer * 3 + 1)]) };
}
// Rysunek, nie plama: jednolite tło w rogach, ciemna podstawa pod środkiem i lampa (klosz + noga)
// zajmująca 5–50% obrazka, klosz w jednym kolorze.
function sprawdzRysunek(b) {
  const { szer, wys, kolor, filtry } = piksele(b);
  expect(filtry.every(f => f === 0)).toBe(true);
  const tlo = kolor(0, 0);
  for (const [x, y] of [[szer - 1, 0], [0, wys - 1], [szer - 1, wys - 1]]) expect(kolor(x, y)).toBe(tlo);
  expect(kolor(szer / 2, 203)).toBe('65,60,55');
  let inne = 0;
  for (let y = 0; y < wys; y++) for (let x = 0; x < szer; x++) if (kolor(x, y) !== tlo) inne++;
  expect(inne / (szer * wys)).toBeGreaterThan(0.05);
  expect(inne / (szer * wys)).toBeLessThan(0.5);
  const klosz = new Set();
  for (let y = 20; y < 199; y++) for (let x = 0; x < szer; x++) if (![tlo, '65,60,55'].includes(kolor(x, y))) klosz.add(kolor(x, y));
  expect(klosz.size).toBe(1);
}

describe('treść kart demo', () => {
  it('Woo: pełny opis i galerie; jawne wyjątki dla kafli braków', () => {
    for (const kanal of KANALY.filter(k => k.typ === 'woo')) {
      for (const p of katalogWoo(kanal.klucz).produkty) {
        const sku = p.sku || 'LMP-' + ({ Rozmiar: 'WIS-001', Szkło: 'ABA-003', Rodzaj: 'AKC-001' }[p.attributes[0].name]);
        const adresy = p.images.map(z => z.src);
        sprawdzZdjecia(sku, adresy);
        if (bezTresci.has(sku)) expect([p.description, p.short_description]).toEqual(['', '']);
        else {
          expect(p.description).toContain('<h2>');
          expect(p.description.length).toBeGreaterThan(p.short_description.length);
          const opis = opisDoSekcji(p.description);
          expect(opis.sekcje.flatMap(s => s.elementy).map(e => e.html).join('')).toBe(p.description);
          sprawdzCzyszczenie(opis, adresy);
        }
      }
    }
  });

  it('Allegro: 2–3 sekcje, 1–2 elementy, tylko TEXT/IMAGE z galerii; czyszczenie zachowuje treść', () => {
    for (const kanal of KANALY.filter(k => k.typ === 'allegro')) {
      for (const o of ofertyAllegro(kanal.klucz)) {
        const p = ofertaAllegroPelna(kanal.klucz, o.id);
        sprawdzZdjecia(o.external.id, p.images);
        if (bezTresci.has(o.external.id)) { expect(p.description.sections).toEqual([]); continue; }
        expect(p.description.sections.length).toBeGreaterThanOrEqual(2);
        expect(p.description.sections.length).toBeLessThanOrEqual(3);
        for (const s of p.description.sections) {
          expect(s.items.length).toBeGreaterThanOrEqual(1);
          expect(s.items.length).toBeLessThanOrEqual(2);
          for (const e of s.items) {
            expect(['TEXT', 'IMAGE']).toContain(e.type);
            if (e.type === 'IMAGE') expect(p.images).toContain(e.url);
          }
        }
        const opis = sekcjeAllegroDoSekcji(p.description);
        expect(opis.sekcje.flatMap(s => s.elementy).filter(e => e.typ === 'tekst').map(e => e.html))
          .toEqual(p.description.sections.flatMap(s => s.items).filter(e => e.type === 'TEXT').map(e => e.content));
        sprawdzCzyszczenie(opis, p.images);
      }
    }
  });

  it('generator deterministyczny: różne karty mają różne rysunki, a ponowny zapis te same bajty', () => {
    const cel = fs.mkdtempSync(path.join(os.tmpdir(), 'rysunki-'));
    try {
      const wynik = spawnSync(process.execPath, ['scripts/demo-zdjecia-rysunki.mjs', cel], { encoding: 'utf8' });
      expect(wynik.status, wynik.stderr).toBe(0);
      const skroty = [];
      const pliki = [];
      for (const p of PRODUKTY) {
        for (const nr of [1, 2]) {
          const nazwa = `rys-${p.sku.toLowerCase()}-${nr}.png`;
          const b = fs.readFileSync(path.join(cel, nazwa));
          expect(b.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
          expect([b.readUInt32BE(16), b.readUInt32BE(20)]).toEqual([240, 240]);
          expect(b.length).toBeLessThan(8 * 1024);
          sprawdzRysunek(b);
          pliki.push({ nazwa, b });
          if (nr === 1) skroty.push(sha(b));
        }
      }
      expect(new Set(skroty).size).toBe(PRODUKTY.length);
      for (const { nazwa, b } of pliki) expect(b).toEqual(fs.readFileSync(path.join(katalog, nazwa)));
    } finally { fs.rmSync(cel, { recursive: true, force: true }); }
  });
});
