import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { buildOmsServer } from '../../pomoc/serwer-testowy-oms.ts';

// Formularz wgrywania zdjęć karty = strefa przeciągania wokół pola `multiple`.
const auth = {
  authorization: `Basic ${Buffer.from('operator:atrapa').toString('base64')}`,
  origin: 'http://localhost',
};
let db, app, katalog;
const dodaj = (kolejnosc) =>
  db
    .prepare(
      `INSERT INTO zdjecia_kart (karta_id, kolejnosc, zrodlo, adres_zrodlowy, utworzono_at)
  VALUES (1000, ?, 'reczne', ?, '2026-11-13')`,
    )
    .run(kolejnosc, `https://obrazy.example/${kolejnosc}.png`);
const formularz = async () => {
  const r = await app.inject({ url: '/magazyn/1000', headers: auth });
  expect(r.statusCode).toBe(200);
  return { html: r.body, form: r.body.match(/<form[^>]*zdjecia\/wgraj[\s\S]*?<\/form>/)?.[0] ?? '' };
};

beforeEach(async () => {
  katalog = await mkdtemp(join(tmpdir(), 'galeria-strefa-'));
  db = openOmsDb(':memory:');
  app = buildOmsServer({
    db,
    config: { auth: { user: 'operator', pass: 'atrapa' } },
    magazyn: {},
    env: { OMS_KATALOG_ZDJEC: katalog },
  });
  db.prepare(
    `INSERT INTO karty_produktow (id,nazwa,utworzony_at,zmieniony_at) VALUES (1000, 'Lampa testowa', '2026-11-13', '2026-11-13')`,
  ).run();
});
afterEach(async () => {
  await app?.close();
  db?.close();
  await rm(katalog, { recursive: true, force: true });
});

it('strefa wokół pola multiple, napis z wolnym miejscem, przycisk główny, skrypt z wersją', async () => {
  for (const k of [0, 1, 2]) dodaj(k);
  const { html, form } = await formularz();
  expect(form).toMatch(/<div class="strefa-pliku"[^>]*data-strefa-pliku[^>]*data-maks-plikow="17"/);
  expect(form).toMatch(/<input type="file"[^>]*name="zdjecie"[^>]*multiple/);
  expect(form).toMatch(/accept="image\/jpeg,image\/png,image\/webp"/);
  expect(form).toContain('Przeciągnij zdjęcia tutaj albo wybierz z dysku');
  expect(form).toContain('JPEG, PNG lub WebP, do 10 MB każde. Zostało miejsca na 17 z 20.');
  expect(form).toMatch(
    /<button class="btn btn--glowny" type="submit"[^>]*data-strefa-przycisk[^>]*>Wgraj zdjęcia<\/button>/,
  );
  expect(form).toMatch(/aria-live="polite"/);
  // przełącznik AI bez zmian
  expect(form).toContain('<input type="checkbox" id="zdjecie-karty-ai" name="ai" value="1"');
  expect(form).toContain('Zdjęcie wygenerowane lub istotnie zmienione przez AI');
  const src = html.match(/<script type="module" src="(\/public\/strefa-pliku\.js\?v=[a-f0-9]{10})"><\/script>/)?.[1];
  expect(src).toBeTruthy();
  expect((await app.inject(src)).statusCode).toBe(200);
});

it('karta z 20 zdjęciami: strefa nieaktywna z komunikatem, pole i przycisk wyłączone', async () => {
  for (let k = 0; k < 20; k++) dodaj(k);
  const { form } = await formularz();
  expect(form).toContain('data-maks-plikow="0"');
  expect(form).toContain('Zostało miejsca na 0 z 20.');
  expect(form).toMatch(/Karta ma już 20 zdjęć/);
  expect(form).toMatch(/<input type="file"[^>]*disabled/);
  expect(form).toMatch(/<button class="btn btn--glowny" type="submit"[^>]*disabled/);
});
