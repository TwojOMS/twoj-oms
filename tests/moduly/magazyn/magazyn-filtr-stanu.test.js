import { afterEach, beforeEach, expect, it } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { utworzKarte } from '../../../src/oms/db/magazyn.js';
import { dodajRuch, przelaczStany } from '../../../src/oms/db/stany-magazynowe.js';
import { buildOmsServer } from '../../pomoc/serwer-testowy-oms.ts';

const konto = { id: 1, login: 'tester' };
const headers = { authorization: `Basic ${Buffer.from('tester:x').toString('base64')}` };
let db, app, ids;

async function ekran(url) {
  const r = await app.inject({ url, headers });
  expect(r.statusCode).toBe(200);
  return r.body;
}

const karty = (html) => [...html.matchAll(/name="zaznaczone" value="(\d+)"/g)].map(([, id]) => Number(id));

beforeEach(() => {
  db = openOmsDb(':memory:');
  app = buildOmsServer({
    db,
    config: { auth: { user: 'tester', pass: 'x' } },
    magazyn: { stan: () => ({ trwa: false, kanaly: [] }) },
  });
  przelaczStany(db, { wlacz: true, konto, at: '2025-01-01T00:00:00Z' });
  ids = {};
  for (const [klucz, nazwa, ruchy, prog, wycofana, kategoria_glowna] of [
    ['piec', 'Abażur pięć', [5], 2, 0, 'Lampy'],
    ['bezRuchow', 'Talerz pusty', [], null, 0, 'Naczynia'],
    ['doZera', 'Lampa wyzerowana', [2, -2], 0, 0, 'Lampy'],
    ['jeden', 'Żyrandol jeden', [1], 1, 0, 'Lampy'],
    ['minus', 'Wazon ujemny', [-2], 2, 0, 'Naczynia'],
    ['wycofaneZero', 'Lampa wycofana', [], 0, 1, 'Lampy'],
    ['wycofanyMinus', 'Filiżanka wycofana', [-1], 2, 1, 'Naczynia'],
  ]) {
    const id = utworzKarte(db, { nazwa, prog_niskiego_stanu: prog, wycofana, kategoria_glowna });
    ids[klucz] = id;
    ruchy.forEach((ilosc, i) =>
      dodajRuch(db, { kartaId: id, rodzaj: 'korekta', ilosc, powod: 'Spis', klucz: `${klucz}-${i}` }),
    );
  }
});

afterEach(async () => {
  await app.close();
  db.close();
});

it('Brak obejmuje zera i stany ujemne aktywnych kart, od najniższego stanu', async () => {
  const html = await ekran('/magazyn?stan=brak');
  expect(karty(html)).toEqual([ids.minus, ids.bezRuchow, ids.doZera]);
  const select = html.match(/<select id="filtr-stan" name="stan">([\s\S]*?)<\/select>/)[1];
  expect(
    [...select.matchAll(/<option value="([^"]*)"[^>]*>([^<]*)<\/option>/g)].map(([, wartosc, tekst]) => [
      wartosc,
      tekst,
    ]),
  ).toEqual([
    ['', 'wszystkie'],
    ['jest', 'Na stanie (więcej niż 0)'],
    ['niski', 'Niski stan'],
    ['brak', 'Brak (0 i mniej)'],
    ['minus', 'Na minusie'],
  ]);
  expect(select).toContain('<option value="brak" selected>');
  expect(karty(await ekran('/magazyn?stan=brak&sort=nazwa'))).toEqual([ids.doZera, ids.bezRuchow, ids.minus]);
});

it('filtr Na minusie pokazuje tyle kart, ile link w pasku, także wycofane', async () => {
  const html = await ekran('/magazyn');
  const link = html.match(/<a\b[^>]*class="stan-minus"[^>]*href="(\/magazyn\?stan=minus)"[^>]*>(\d+) na minusie<\/a>/);
  expect(link).not.toBeNull();
  const pasujace = karty(await ekran(link[1]));
  expect(Number(link[2])).toBe(pasujace.length);
  expect(pasujace).toEqual([ids.minus, ids.wycofanyMinus]);
});

it('przy zerowym liczniku pasek pokazuje tekst bez odnośnika', async () => {
  for (const [id, ilosc] of [
    [ids.minus, 2],
    [ids.wycofanyMinus, 1],
  ]) {
    dodajRuch(db, { kartaId: id, rodzaj: 'korekta', ilosc, powod: 'Spis', klucz: `zero-${id}` });
  }
  const pasek = (await ekran('/magazyn')).match(/<p class="magazyn-stany">[\s\S]*?<\/p>/)[0];
  expect(pasek).toContain('nic na minusie');
  expect(pasek).not.toContain('stan=minus');
});

it('Na stanie wybiera dodatnie stany, a Niski stan zachowuje kryterium progu', async () => {
  expect(karty(await ekran('/magazyn?stan=jest'))).toEqual([ids.jeden, ids.piec]);
  expect(karty(await ekran('/magazyn?stan=niski'))).toEqual([ids.minus, ids.doZera, ids.jeden]);
});

it('łączy Brak z frazą i kategorią', async () => {
  expect(karty(await ekran('/magazyn?stan=brak&fraza=Talerz'))).toEqual([ids.bezRuchow]);
  expect(karty(await ekran('/magazyn?stan=brak&kategoria=Lampy'))).toEqual([ids.doZera]);
});

it('zachowuje Brak na drugiej stronie, w Pokaż wszystkie i przy powrocie do stron', async () => {
  for (let i = 0; i < 98; i++) utworzKarte(db, { nazwa: `Lampion ${i}` });
  const pierwsza = await ekran('/magazyn?stan=brak');
  expect(karty(pierwsza)).toHaveLength(100);
  const druga = await ekran(pierwsza.match(/href="([^"]+)" aria-label="Strona 2"/)[1].replaceAll('&amp;', '&'));
  expect(karty(druga)).toHaveLength(1);
  expect(druga).toContain('<strong class="sku-pasujace">101</strong>');
  const wszystkie = await ekran(druga.match(/href="([^"]+)">Pokaż wszystkie<\/a>/)[1].replaceAll('&amp;', '&'));
  expect(karty(wszystkie)).toEqual([...karty(pierwsza), ...karty(druga)]);
  const powrot = wszystkie.match(/href="([^"]+)">Po 100 na stronie<\/a>/)[1].replaceAll('&amp;', '&');
  expect(karty(await ekran(powrot))).toEqual(karty(pierwsza));
});

it('podgląd edycji wszystkich pasujących obejmuje karty wskazane przez licznik filtra Brak', async () => {
  const html = await ekran('/magazyn?stan=brak');
  expect(html).toContain('<strong class="sku-pasujace">3</strong>');
  const zawezenie = html.match(/name="zawezenie" value="([^"]*)"/)[1];
  const r = await app.inject({
    method: 'POST',
    url: '/magazyn/hurt',
    headers: { ...headers, origin: 'http://localhost' },
    payload: { zakres: 'pasujace', zawezenie, szerokosc_cm: '70' },
  });
  expect(r.statusCode).toBe(200);
  const podglad = r.body.match(/<section[^>]*id="zmiany-hurtem"[\s\S]*?<\/section>/)[0];
  expect([...podglad.matchAll(/<div class="nazwa-karty">([^<]*)<\/div>/g)].map(([, nazwa]) => nazwa).sort()).toEqual([
    'Lampa wyzerowana',
    'Talerz pusty',
    'Wazon ujemny',
  ]);
});

it('zwraca pustą listę przy nieznanym lub powtórzonym filtrze', async () => {
  expect(karty(await ekran('/magazyn?stan=constructor'))).toEqual([]);
  expect(karty(await ekran('/magazyn?stan=brak&stan=minus'))).toEqual([]);
});

it.each(['jest', 'niski', 'brak', 'minus'])('wyłączone stany dają pustą listę dla filtra %s', async (stan) => {
  przelaczStany(db, { wlacz: false, konto });
  expect(karty(await ekran(`/magazyn?stan=${stan}`))).toEqual([]);
});
