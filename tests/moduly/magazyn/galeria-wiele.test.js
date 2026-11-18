import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { buildOmsServer } from '../../pomoc/serwer-testowy-oms.ts';

const tmp = tmpdir();
const auth = {
  authorization: `Basic ${Buffer.from('operator:atrapa').toString('base64')}`,
  origin: 'http://localhost',
};
let db, app, katalog;
function png(n) {
  const b = Buffer.alloc(33);
  Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex').copy(b);
  b.writeUInt32BE(n, 16);
  b.writeUInt32BE(3, 20);
  return b;
}
const plik = (n) => [`obraz-${n}.png`, png(n)];
const lista = () => db.prepare('SELECT * FROM zdjecia_kart WHERE karta_id=1000 ORDER BY kolejnosc, id').all();
function dodaj(ile) {
  for (let i = 0; i < ile; i++)
    db.prepare(
      `INSERT INTO zdjecia_kart
    (karta_id,kolejnosc,zrodlo,adres_zrodlowy,utworzono_at)
    VALUES (1000,?,'api',?,'2026-11-13')`,
    ).run(i, `https://obrazy.example/${i}.png`);
}
function upload(pliki, ai) {
  const czesci = pliki.flatMap(([nazwa, bufor]) => [
    Buffer.from(
      `--paczka\r\nContent-Disposition: form-data; name="zdjecie"; filename="${nazwa}"\r\nContent-Type: image/png\r\n\r\n`,
    ),
    bufor,
    Buffer.from('\r\n'),
  ]);
  if (ai !== undefined)
    czesci.push(Buffer.from(`--paczka\r\nContent-Disposition: form-data; name="ai"\r\n\r\n${ai}\r\n`));
  return app.inject({
    method: 'POST',
    url: '/magazyn/1000/zdjecia/wgraj',
    headers: { ...auth, 'content-type': 'multipart/form-data; boundary=paczka' },
    payload: Buffer.concat([...czesci, Buffer.from('--paczka--\r\n')]),
  });
}
beforeEach(async () => {
  await mkdir(tmp, { recursive: true });
  katalog = await mkdtemp(join(tmp, 'galeria-'));
  db = openOmsDb(':memory:');
  app = buildOmsServer({
    db,
    config: { auth: { user: 'operator', pass: 'atrapa' } },
    magazyn: {},
    env: { OMS_KATALOG_ZDJEC: katalog },
  });
  db.prepare(
    `INSERT INTO karty_produktow (id,nazwa,utworzony_at,zmieniony_at)
    VALUES (1000,'Lampa testowa','2026-11-13','2026-11-13')`,
  ).run();
});
afterEach(async () => {
  await app?.close();
  db?.close();
  await rm(katalog, { recursive: true, force: true });
});

it('zapisuje trzy pliki w kolejności przesłania i oznacza ręczne źródło', async () => {
  const pliki = [plik(3), plik(1), plik(2)];
  expect((await upload(pliki)).statusCode).toBe(303);
  expect(lista().map((z) => [z.kolejnosc, z.szerokosc, z.ai])).toEqual([
    [0, 3, 0],
    [1, 1, 0],
    [2, 2, 0],
  ]);
  for (const [i, z] of lista().entries()) expect(await readFile(join(katalog, z.plik))).toEqual(pliki[i][1]);
  expect(db.prepare("SELECT reczne FROM karty_zrodla_pol WHERE karta_id=1000 AND pole='zdjecia'").get()?.reczne).toBe(
    1,
  );
});
it('dwa dobre i GIF: odmawia z nazwą, bez wierszy, plików i historii', async () => {
  const r = await upload([plik(1), plik(2), ['animacja.gif', Buffer.from('GIF89a')]]);
  expect(r.statusCode).toBe(400);
  expect(r.body).toContain('animacja.gif');
  expect(lista()).toEqual([]);
  expect(await readdir(katalog)).toEqual([]);
  expect(db.prepare('SELECT * FROM karty_zrodla_pol').all()).toEqual([]);
});
it.each([10 * 1024 * 1024 + 1, 11 * 1024 * 1024])('odrzuca całość dla pliku o rozmiarze %i', async (rozmiar) => {
  const r = await upload([plik(1), ['za-duzy.png', Buffer.alloc(rozmiar)]]);
  expect(r.statusCode).toBe(400);
  expect(r.body).toContain('za-duzy.png');
  expect(r.body).toContain('10 MB');
  expect(lista()).toEqual([]);
  expect(await readdir(katalog)).toEqual([]);
});
it('19 zdjęć i dwa nowe: zostawia 19 oraz pusty katalog', async () => {
  dodaj(19);
  const r = await upload([plik(1), plik(2)]);
  expect(r.statusCode).toBe(400);
  expect(r.body).toContain('obraz-2.png');
  expect(r.body).toContain('20 zdjęć');
  expect(lista()).toHaveLength(19);
  expect(await readdir(katalog)).toEqual([]);
});
it('ponownie sprawdza limit w transakcji po równoległym dodaniu zdjęć', async () => {
  await app.ready();
  const exec = db.exec.bind(db);
  let dodano = false;
  db.exec = (sql) => {
    if (sql === 'BEGIN IMMEDIATE' && !dodano) {
      dodano = true;
      dodaj(19);
    }
    return exec(sql);
  };
  const r = await upload([plik(1), plik(2)]);
  expect(dodano).toBe(true);
  expect(r.statusCode).toBe(400);
  expect(r.body).toContain('obraz-2.png');
  expect(lista()).toHaveLength(19);
  expect(await readdir(katalog)).toEqual([]);
});
it('duplikaty w paczce i na karcie pomija po cichu, również na pełnej karcie', async () => {
  expect((await upload([plik(1), plik(1), plik(2)])).statusCode).toBe(303);
  expect(lista().map((z) => z.szerokosc)).toEqual([1, 2]);
  dodaj(18);
  expect((await upload([plik(1), plik(2)])).statusCode).toBe(303);
  expect(lista()).toHaveLength(20);
  expect(await readdir(katalog)).toHaveLength(2);
});
it('jeden plik zachowuje przekierowanie i ręczny znacznik 0', async () => {
  const r = await upload([plik(1)]);
  expect(r.statusCode).toBe(303);
  expect(r.headers.location).toBe('/magazyn/1000#zdjecia-karty');
  expect(lista()).toHaveLength(1);
  expect(lista()[0]).toMatchObject({ ai: 0, ai_reczne: 1 });
});
it('ai=1 po plikach dotyczy obu zdjęć', async () => {
  expect((await upload([plik(1), plik(2)], '1')).statusCode).toBe(303);
  expect(lista().map((z) => [z.ai, z.ai_reczne])).toEqual([
    [1, 1],
    [1, 1],
  ]);
});
it('błąd bazy wycofuje całą paczkę i usuwa tylko jej nowe pliki', async () => {
  expect((await upload([plik(3)])).statusCode).toBe(303);
  const przed = lista(),
    plikiPrzed = await readdir(katalog);
  db.exec(`CREATE TRIGGER awaria_zdjecia BEFORE INSERT ON zdjecia_kart
    WHEN NEW.szerokosc=2 BEGIN SELECT RAISE(ABORT, 'test awarii zapisu'); END`);
  expect((await upload([plik(3), plik(1), plik(2)])).statusCode).toBe(500);
  expect(lista()).toEqual(przed);
  expect(await readdir(katalog)).toEqual(plikiPrzed);
  expect(await readFile(join(katalog, przed[0].plik))).toEqual(png(3));
});
it('złe ai po plikach odrzuca całą paczkę i sprząta katalog roboczy', async () => {
  expect((await upload([plik(1), plik(2)], '2')).statusCode).toBe(400);
  expect(lista()).toEqual([]);
  expect(await readdir(katalog)).toEqual([]);
});
it('przyjmuje pełne 20 plików z ai, odmawia 21. z jego nazwą', async () => {
  const pliki = Array.from({ length: 20 }, (_, i) => plik(i + 1));
  const r = await upload([...pliki, plik(21)], '1');
  expect(r.statusCode).toBe(400);
  expect(r.body).toContain('obraz-21.png');
  expect(lista()).toEqual([]);
  expect(await readdir(katalog)).toEqual([]);
  expect((await upload(pliki, '1')).statusCode).toBe(303);
  expect(lista()).toHaveLength(20);
});
