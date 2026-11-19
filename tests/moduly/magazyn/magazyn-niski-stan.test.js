import { afterEach, beforeEach, expect, it } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { utworzKarte } from '../../../src/oms/db/magazyn.js';
import { dodajRuch, przelaczStany } from '../../../src/oms/db/stany-magazynowe.js';
import { buildOmsServer } from '../../pomoc/serwer-testowy-oms.ts';

const konto = { id: 1, login: 'tester' };
const headers = { authorization: `Basic ${Buffer.from('tester:x').toString('base64')}` };
let db, app, ids;

async function ekran(url = '/magazyn') {
  const r = await app.inject({ url, headers });
  expect(r.statusCode).toBe(200);
  return r.body;
}

function komorki(html) {
  return html.match(/<td class="liczba kol-na-stanie[^"]*">[\s\S]*?<\/td>/g) ?? [];
}

beforeEach(() => {
  db = openOmsDb(':memory:');
  app = buildOmsServer({
    db,
    config: { auth: { user: 'tester', pass: 'x' } },
    magazyn: { stan: () => ({ trwa: false, kanaly: [] }) },
  });
  przelaczStany(db, { wlacz: true, konto, at: '2025-01-01T00:00:00Z' });
  ids = {};
  for (const [nazwa, stan, prog, wycofana] of [
    ['Alfa na progu', 2, 2, 0],
    ['Beta powyżej progu', 4, 2, 0],
    ['Eta bez progu', 0, null, 0],
    ['Iota wycofana', 0, 2, 1],
    ['Kappa zero na progu', 0, 0, 0],
    ['Zeta na minusie', -3, 2, 0],
  ]) {
    const id = utworzKarte(db, { nazwa, prog_niskiego_stanu: prog, wycofana });
    ids[nazwa] = id;
    if (stan) dodajRuch(db, { kartaId: id, rodzaj: 'korekta', ilosc: stan, powod: 'Spis', klucz: nazwa });
  }
});

afterEach(async () => {
  await app.close();
  db.close();
});

it('rozróżnia trzy wyglądy stanu i liczy niski stan bez kart na minusie', async () => {
  const html = await ekran();
  const [niska, powyzej, bezProgu, wycofana, zerowa, minus] = komorki(html);
  expect(niska).toContain('stan-niski');
  expect(niska).toContain('title="niski stan — próg 2 szt."');
  expect(niska).toContain('aria-hidden="true">⚠');
  expect(niska).toContain('class="poza-okiem">niski stan — próg 2 szt.');
  expect(powyzej).toBe('<td class="liczba kol-na-stanie">4</td>');
  expect(bezProgu).toBe('<td class="liczba kol-na-stanie">0</td>');
  expect(wycofana).toBe('<td class="liczba kol-na-stanie">0</td>');
  expect(zerowa).toContain('stan-niski');
  expect(minus).toBe('<td class="liczba kol-na-stanie stan-minus">-3</td>');
  expect(html).toContain('1 na minusie');
  expect(html).toContain('href="/magazyn?stan=niski">2 z niskim stanem</a>');
});

it('filtruje również −3 przy progu 2 i domyślnie sortuje od najniższego stanu', async () => {
  const html = await ekran('/magazyn?stan=niski');
  const stany = komorki(html);
  expect(stany[0]).toBe('<td class="liczba kol-na-stanie stan-minus">-3</td>');
  expect(stany).toHaveLength(3);
  expect(stany[1]).toContain('próg 0 szt.');
  expect(stany[2]).toContain('próg 2 szt.');
  expect(html).toContain('<option value="niski" selected>Niski stan</option>');
  expect(html).toContain('name="stan" value="niski"');
  expect(komorki(await ekran('/magazyn?stan=niski&sort=nazwa'))[0]).toContain('próg 2 szt.');
  expect(komorki(await ekran('/magazyn?stan=niski&fraza=Kappa'))).toHaveLength(1);
});

it('zwraca pustą listę przy nieznanej wartości filtra stanu', async () => {
  const html = await ekran('/magazyn?stan=constructor');
  expect(komorki(html)).toHaveLength(0);
  expect(komorki(await ekran('/magazyn?stan=niski&stan=niski'))).toHaveLength(0);
});

it('pokazuje próg i plakietkę na karcie oraz pozwala wyczyścić próg', async () => {
  const id = ids['Alfa na progu'];
  const url = `/magazyn/${id}`;
  const html = await ekran(url);
  expect(html).toContain('niski stan (2 ≤ 2)');
  expect(html).toContain(`action="${url}/prog-stanu"`);
  expect(html).toMatch(/name="prog_niskiego_stanu"[^>]*value="2"/);
  const kartaNaMinusie = await ekran(`/magazyn/${ids['Zeta na minusie']}`);
  expect(kartaNaMinusie).toContain('class="stan-minus">-3 szt.');
  expect(kartaNaMinusie).toContain('niski stan (-3 ≤ 2)');

  const r = await app.inject({
    method: 'POST',
    url: `${url}/prog-stanu`,
    headers: { ...headers, origin: 'http://localhost', 'content-type': 'application/x-www-form-urlencoded' },
    payload: 'prog_niskiego_stanu=',
  });
  expect(r.statusCode).toBe(303);
  expect(r.headers.location).toBe(`${url}?zapisano=prog-stanu#stan-karty`);
  expect(await ekran(url)).not.toContain('niski stan (');
});

it('ukrywa formularz progu przy wyłączonych stanach i zwraca pusty filtr', async () => {
  przelaczStany(db, { wlacz: false, konto });
  expect(await ekran(`/magazyn/${ids['Alfa na progu']}`)).not.toContain('/prog-stanu');
  expect(await ekran('/magazyn?stan=niski')).not.toContain('>Alfa na progu</a>');
});
