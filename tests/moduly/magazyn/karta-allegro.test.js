// Sekcja „Allegro” na karcie: braki bez konta, źródła kategorii i parametrów,
// nazwa z limitem 75 po encjach, kategoria-wyjątek, parametry „na karcie”, wybór produktu przy problemie oferty.
import { afterEach, beforeEach, expect, it } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { buildOmsServer } from '../../pomoc/serwer-testowy-oms.ts';
import { zalozKonto, ustawUprawnienia } from '../../../src/core/bezpieczenstwo/konta.js';
import { podpisz, NAZWA_CIASTECZKA_OMS } from '../../../src/core/bezpieczenstwo/sesja.js';
import { wczytajSekret } from '../../../src/core/bezpieczenstwo/sekret-sesji.js';
import { wstawOferte, ofertaPoId } from '../../../src/oms/db/oferty-kanalow.ts';
import { srodowiskoAllegro } from '../../../src/moduly/magazyn/karta.js';
import { ofertaAllegroKarty } from '../../../src/moduly/magazyn/services/tresc-oferty-allegro.js';

const auth = {
  authorization: `Basic ${Buffer.from('operator:atrapa').toString('base64')}`,
  origin: 'http://localhost',
};
const T0 = '2026-11-14T08:00:00.000Z';
const KARTA = 1000;
let db, app;

const opisKategorii = (parametry, { lisc = true } = {}) =>
  JSON.stringify({ wersja: 2, lisc, tworzenieProduktu: true, parametry });
const PARAMETRY_257 = [
  {
    id: '11323',
    nazwa: 'Stan',
    typ: 'dictionary',
    slownik: [{ id: '11323_1', wartosc: 'Nowy' }],
    wymagany: true,
    opisujeProdukt: false,
  },
  { id: '202717', nazwa: 'Kolor kloszu', typ: 'string', slownik: null, wymagany: true, opisujeProdukt: true },
  {
    id: '4388',
    nazwa: 'Rodzaj gwintu',
    typ: 'dictionary',
    slownik: [
      { id: '4388_1', wartosc: 'E27' },
      { id: '4388_2', wartosc: 'E14' },
    ],
    wymagany: false,
    opisujeProdukt: true,
  },
];

const post = (url, payload, headers = auth) => app.inject({ method: 'POST', url, headers, payload });
const zapis = (payload, headers) => post(`/magazyn/${KARTA}/allegro`, payload, headers);
const wybor = (payload, headers) => post(`/magazyn/${KARTA}/allegro/produkt`, payload, headers);
const kartaAllegro = () => db.prepare('SELECT * FROM karty_allegro WHERE karta_id = ?').get(KARTA);
const zrodla = () =>
  db
    .prepare(
      "SELECT pole, zrodlo, reczne FROM karty_zrodla_pol WHERE karta_id = ? AND pole LIKE 'allegro:%' ORDER BY pole",
    )
    .all(KARTA);
const sekcja = (body) => body.match(/<section[^>]*id="allegro-karty"[\s\S]*?<\/section>/)?.[0] ?? '';

beforeEach(() => {
  db = openOmsDb(':memory:');
  app = buildOmsServer({ db, config: { auth: { user: 'operator', pass: 'atrapa' } }, magazyn: {} });
  for (const id of [KARTA, KARTA + 1]) {
    db.prepare(
      `INSERT INTO karty_produktow (id, nazwa, kategoria_glowna, utworzony_at, zmieniony_at)
      VALUES (?, 'Lampa stołowa Gliwka', 'Lampy stołowe', ?, ?)`,
    ).run(id, T0, T0);
  }
  db.prepare(
    `INSERT INTO allegro_mapa_kategorii (kategoria_karty, srodowisko, kategoria_allegro_id) VALUES ('Lampy stołowe', 'produkcja', '257')`,
  ).run();
  db.prepare(
    `INSERT INTO allegro_reguly_parametrow (srodowisko, kategoria_allegro_id, parametr_id, rodzaj, wartosc_json, pole, zmieniono_at)
    VALUES ('produkcja', '257', '202717', 'na_karcie', NULL, NULL, ?)`,
  ).run(T0);
  const kat = db.prepare(
    `INSERT INTO kanaly_kategorie (polaczenie, kategoria_id, sciezka_json, parametry_json, pobrano_at) VALUES (?, ?, ?, ?, ?)`,
  );
  kat.run(
    'allegro-demo',
    '257',
    JSON.stringify([
      { id: '5', nazwa: 'Oświetlenie' },
      { id: '257', nazwa: 'Lampy stołowe' },
    ]),
    opisKategorii(PARAMETRY_257),
    T0,
  );
  kat.run(
    'allegro-demo',
    '258',
    JSON.stringify([{ id: '258', nazwa: 'Kinkiety' }]),
    opisKategorii([
      {
        id: '17448',
        nazwa: 'Liczba punktów światła',
        typ: 'integer',
        slownik: null,
        wymagany: false,
        opisujeProdukt: true,
      },
    ]),
    T0,
  );
});
afterEach(async () => {
  await app?.close();
  db?.close();
});

it('karta z brakami: sekcja pokazuje kategorię z mapy, źródła parametrów, licznik nazwy i listę braków bez konta', async () => {
  const r = await app.inject({ url: `/magazyn/${KARTA}`, headers: auth });
  expect(r.statusCode).toBe(200);
  const s = sekcja(r.body);
  expect(s).toContain('Lampy stołowe (257)');
  expect(s).toContain('z mapy kategorii');
  expect(s).toContain('20 / 75');
  expect(s).toMatch(/Kolor kloszu[\s\S]*?uzupełnij na karcie/);
  expect(s).toContain(
    'wymaga parametru „Kolor kloszu” dla nowego produktu — uzupełnij parametr „Kolor kloszu” na karcie',
  );
  expect(s).toContain('name="parametr:202717"');
  expect(s).not.toContain('Gotowa do wystawienia');
});

it('zapis nazwy 76 znaków → odmowa 400 bez zapisu; 75 znaków przechodzi i oznacza pole jako ręczne', async () => {
  const r = await zapis({ nazwa: 'L'.repeat(76) });
  expect(r.statusCode).toBe(400);
  expect(r.body).toContain('76');
  expect(kartaAllegro()).toBeUndefined();
  expect(zrodla()).toEqual([]);
  const ok = await zapis({ nazwa: 'L'.repeat(75) });
  expect(ok.statusCode).toBe(303);
  expect(ok.headers.location).toBe(`/magazyn/${KARTA}#allegro-karty`);
  expect(kartaAllegro()).toMatchObject({ nazwa: 'L'.repeat(75), kategoria_id: null, produkt_id: null });
  expect(zrodla()).toEqual([{ pole: 'allegro:nazwa', zrodlo: 'reczne', reczne: 1 }]);
});

it('licznik liczy po encjach: 72 znaki z „&” to 76 → odmowa', async () => {
  const nazwa = `Lampa & ${'k'.repeat(64)}`;
  expect(nazwa.length).toBe(72);
  expect((await zapis({ nazwa })).statusCode).toBe(400);
  expect(kartaAllegro()).toBeUndefined();
});

it('parametr spoza kategorii → odmowa 400 bez zapisu', async () => {
  const r = await zapis({ 'parametr:999999': 'cokolwiek' });
  expect(r.statusCode).toBe(400);
  expect(r.body).toContain('999999');
  expect(kartaAllegro()).toBeUndefined();
  // Parametr kategorii 258 nie pasuje do 257 z mapy.
  expect((await zapis({ 'parametr:17448': '2' })).statusCode).toBe(400);
  // Po wyjątku na 258 ten sam parametr przechodzi, a wartość słownikowa spoza słownika — nie.
  expect((await zapis({ kategoria: '258', 'parametr:17448': '2' })).statusCode).toBe(303);
  expect(JSON.parse(kartaAllegro().parametry_json)).toEqual([{ id: '17448', values: ['2'] }]);
  expect((await zapis({ 'parametr:4388': '4388_9' })).statusCode).toBe(400);
});

it('kategoria-wyjątek i parametr „na karcie” zapisują się do karty_allegro; pusta wartość zdejmuje nadpisanie', async () => {
  expect(
    (await zapis({ nazwa: '', kategoria: '', 'parametr:202717': 'mleczny', 'parametr:4388': '4388_1' })).statusCode,
  ).toBe(303);
  expect(kartaAllegro()).toMatchObject({ nazwa: null, kategoria_id: null });
  expect(JSON.parse(kartaAllegro().parametry_json)).toEqual([
    { id: '202717', values: ['mleczny'] },
    { id: '4388', valuesIds: ['4388_1'] },
  ]);
  expect(zrodla()).toEqual([{ pole: 'allegro:parametry', zrodlo: 'reczne', reczne: 1 }]);
  const r = await app.inject({ url: `/magazyn/${KARTA}`, headers: auth });
  const s = sekcja(r.body);
  expect(s).toMatch(/Kolor kloszu[\s\S]*?nadpisane na karcie/);
  expect(s).not.toContain('Uzupełnij parametr „Kolor kloszu”');
  expect((await zapis({ 'parametr:202717': '', 'parametr:4388': '4388_1' })).statusCode).toBe(303);
  expect(JSON.parse(kartaAllegro().parametry_json)).toEqual([{ id: '4388', valuesIds: ['4388_1'] }]);
  expect((await zapis({ kategoria: 'abc 1' })).statusCode).toBe(400);
});

it('formularz z ekranu: puste parametry starej kategorii + nowy wyjątek kategorii → zapis przechodzi', async () => {
  const s = sekcja((await app.inject({ url: `/magazyn/${KARTA}`, headers: auth })).body);
  const nazwy = [...new Set([...s.matchAll(/name="([^"]+)"/g)].map((m) => m[1]))].filter(
    (n) => n !== 'ofertaId' && n !== 'produktId',
  );
  expect(nazwy).toEqual(expect.arrayContaining(['nazwa', 'kategoria', 'parametr:202717']));
  const payload = Object.fromEntries(nazwy.filter((n) => n !== '_csrf').map((n) => [n, '']));
  payload.kategoria = '258';
  const r = await zapis(payload);
  expect(r.statusCode).toBe(303);
  expect(kartaAllegro()).toMatchObject({ kategoria_id: '258' });
});

it('zmiana wyjątku kategorii zdejmuje nadpisania parametrów spoza nowej kategorii', async () => {
  expect((await zapis({ 'parametr:202717': 'mleczny' })).statusCode).toBe(303);
  expect(JSON.parse(kartaAllegro().parametry_json)).toEqual([{ id: '202717', values: ['mleczny'] }]);
  expect((await zapis({ kategoria: '258' })).statusCode).toBe(303);
  expect(kartaAllegro()).toMatchObject({ kategoria_id: '258' });
  expect(JSON.parse(kartaAllegro().parametry_json)).toEqual([]);
});

it('środowisko Allegro: konto produkcyjne ma pierwszeństwo, inaczej pierwsze konto', () => {
  expect(
    srodowiskoAllegro(() => [
      { klucz: 'a', srodowisko: 'sandbox' },
      { klucz: 'b', srodowisko: 'produkcja' },
    ]),
  ).toBe('produkcja');
  expect(srodowiskoAllegro(() => [{ klucz: 'a', srodowisko: 'sandbox' }])).toBe('sandbox');
  expect(srodowiskoAllegro(() => [])).toBe('produkcja');
});

it('wybór produktu zapisuje produkt_id i przestawia ofertę na do_wyslania', async () => {
  const o = wstawOferte(db, { kartaId: KARTA, kanal: 'allegro-demo', idZewnetrzne: 'ext:a1', stan: 'problem' });
  db.prepare('UPDATE oferty_kanalow SET problemy_json = ?, blad = ? WHERE id = ?').run(
    JSON.stringify([
      {
        kod: 'wiele-produktow',
        produkty: [
          { id: 'prod-1', nazwa: 'Lampa Gliwka biała', ean: '5900000000017' },
          { id: 'prod-2', nazwa: 'Lampa Gliwka czarna', ean: null },
        ],
      },
    ]),
    'Kilka produktów w Katalogu',
    o.id,
  );
  const g = sekcja((await app.inject({ url: `/magazyn/${KARTA}`, headers: auth })).body);
  expect(g).toContain('Lampa Gliwka czarna');
  expect((await wybor({ ofertaId: String(o.id), produktId: 'prod-obcy' })).statusCode).toBe(400);
  expect(ofertaPoId(db, o.id)?.stan).toBe('problem');
  const r = await wybor({ ofertaId: String(o.id), produktId: 'prod-2' });
  expect(r.statusCode).toBe(303);
  expect(kartaAllegro()).toMatchObject({ produkt_id: 'prod-2' });
  expect(ofertaPoId(db, o.id)).toMatchObject({ stan: 'do_wyslania', problemy: [], blad: null });
  expect(zrodla()).toEqual([{ pole: 'allegro:produkt', zrodlo: 'reczne', reczne: 1 }]);
  // Druga próba: oferta nie jest już w stanie „problem”.
  expect((await wybor({ ofertaId: String(o.id), produktId: 'prod-1' })).statusCode).toBe(409);
});

it('parameter-mismatch: produkt wskazany przez Allegro; oferta innej karty → 404', async () => {
  const o = wstawOferte(db, { kartaId: KARTA, kanal: 'allegro-demo', idZewnetrzne: 'ext:a2', stan: 'problem' });
  db.prepare('UPDATE oferty_kanalow SET problemy_json = ? WHERE id = ?').run(
    JSON.stringify([{ kod: 'parameter-mismatch', produktId: 'prod-9', parametr: 'Kolor kloszu' }]),
    o.id,
  );
  const obca = wstawOferte(db, { kartaId: KARTA + 1, kanal: 'allegro-demo', idZewnetrzne: 'ext:b1', stan: 'problem' });
  db.prepare('UPDATE oferty_kanalow SET problemy_json = ? WHERE id = ?').run(
    JSON.stringify([{ kod: 'parameter-mismatch', produktId: 'prod-9', parametr: 'Kolor' }]),
    obca.id,
  );
  expect((await wybor({ ofertaId: String(obca.id), produktId: 'prod-9' })).statusCode).toBe(404);
  expect(ofertaPoId(db, obca.id)?.stan).toBe('problem');
  expect((await wybor({ ofertaId: String(o.id), produktId: 'prod-9' })).statusCode).toBe(303);
  expect(kartaAllegro()).toMatchObject({ produkt_id: 'prod-9' });
  expect(ofertaPoId(db, o.id)?.stan).toBe('do_wyslania');
});

it('odmawia bez CSRF i bez uprawnienia magazyn (zapis i wybór produktu)', async () => {
  const o = wstawOferte(db, { kartaId: KARTA, kanal: 'allegro-demo', idZewnetrzne: 'ext:a3', stan: 'problem' });
  db.prepare('UPDATE oferty_kanalow SET problemy_json = ? WHERE id = ?').run(
    JSON.stringify([{ kod: 'parameter-mismatch', produktId: 'prod-9', parametr: 'Kolor' }]),
    o.id,
  );
  const bezCsrf = { authorization: auth.authorization };
  expect((await zapis({ nazwa: 'Lampa' }, bezCsrf)).statusCode).toBe(403);
  expect((await wybor({ ofertaId: String(o.id), produktId: 'prod-9' }, bezCsrf)).statusCode).toBe(403);
  await app.ready();
  zalozKonto(db, { login: 'admin', imie: 'Admin', haslo: 'test', rola: 'admin', admin: true });
  const konto = zalozKonto(db, { login: 'czytelnik', imie: 'Czytelnik', haslo: 'test', rola: 'operator' });
  ustawUprawnienia(db, konto, []);
  const bezRoli = {
    origin: auth.origin,
    cookie: `${NAZWA_CIASTECZKA_OMS}=${podpisz('czytelnik', wczytajSekret(db), Date.now(), 0)}`,
  };
  expect((await zapis({ nazwa: 'Lampa' }, bezRoli)).statusCode).toBe(403);
  expect((await wybor({ ofertaId: String(o.id), produktId: 'prod-9' }, bezRoli)).statusCode).toBe(403);
  expect(kartaAllegro()).toBeUndefined();
  expect(ofertaPoId(db, o.id)?.stan).toBe('problem');
});

// Kategoria „Lampy nocne” (259): wartości parametrów z reguł, importu i nadpisań oraz edycja każdej z nich.
const KARTA_N = KARTA + 2;
const PARAMETRY_259 = [
  {
    id: '11323',
    nazwa: 'Stan',
    typ: 'dictionary',
    slownik: [
      { id: '11323_1', wartosc: 'Nowy' },
      { id: '11323_2', wartosc: 'Używany' },
    ],
    wymagany: true,
    opisujeProdukt: false,
  },
  {
    id: '224017',
    nazwa: 'Kod producenta',
    typ: 'string',
    slownik: null,
    wymagany: false,
    wymaganyDlaProduktu: true,
    opisujeProdukt: true,
  },
  {
    id: '248811',
    nazwa: 'Marka',
    typ: 'dictionary',
    slownik: [{ id: '248811_9001', wartosc: 'Pracownia Półcień' }],
    wymagany: false,
    wymaganyDlaProduktu: true,
    opisujeProdukt: true,
  },
  { id: '5100', nazwa: 'Kolor', typ: 'string', slownik: null, wymagany: false, opisujeProdukt: true },
];
const zapisN = (payload) => post(`/magazyn/${KARTA_N}/allegro`, payload);
const sekcjaN = async () => sekcja((await app.inject({ url: `/magazyn/${KARTA_N}`, headers: auth })).body);
/** Komórki „Wartość” i „Skąd” wiersza tabeli parametrów. */
const wiersz = (s, nazwa) => {
  const m = s.match(new RegExp(`<tr><th scope="row">${nazwa}(?: \\*)?</th><td>([^<]*)</td><td[^>]*>([^<]*)</td></tr>`));
  return m ? { wartosc: m[1], skad: m[2] } : null;
};

function lampaNocna({ ean = null, markaBezSlownika = false } = {}) {
  db.prepare(
    `INSERT INTO karty_produktow (id, nazwa, sku, ean, marka, kategoria_glowna, utworzony_at, zmieniony_at)
    VALUES (?, 'Lampka nocna Sowa', 'LMP-NOC-001', ?, 'Pracownia Półcień', 'Lampy nocne', ?, ?)`,
  ).run(KARTA_N, ean, T0, T0);
  db.prepare(
    `INSERT INTO allegro_mapa_kategorii (kategoria_karty, srodowisko, kategoria_allegro_id) VALUES ('Lampy nocne', 'produkcja', '259')`,
  ).run();
  const regula = db.prepare(
    `INSERT INTO allegro_reguly_parametrow (srodowisko, kategoria_allegro_id, parametr_id, rodzaj, wartosc_json, pole, zmieniono_at)
    VALUES ('produkcja', '259', ?, ?, ?, ?, ?)`,
  );
  regula.run('11323', 'stala', '{"valuesIds":["11323_1"]}', null, T0);
  regula.run('224017', 'pole', null, 'sku', T0);
  regula.run('248811', 'pole', null, 'marka', T0);
  regula.run('5100', 'stala', '{"values":["mleczny"]}', null, T0);
  db.prepare(
    `INSERT INTO allegro_marki (marka, srodowisko, parametr_id, wartosc_id, kategorie_sprawdzone_json, zmieniono_at)
    VALUES ('Pracownia Półcień', 'produkcja', '248811', '248811_9001', '["259"]', ?)`,
  ).run(T0);
  db.prepare(
    `INSERT INTO kanaly_kategorie (polaczenie, kategoria_id, sciezka_json, parametry_json, pobrano_at) VALUES (?, ?, ?, ?, ?)`,
  ).run(
    'allegro-demo',
    '259',
    JSON.stringify([{ id: '259', nazwa: 'Lampy nocne' }]),
    opisKategorii(
      markaBezSlownika ? PARAMETRY_259.map((p) => (p.id === '248811' ? { ...p, slownik: null } : p)) : PARAMETRY_259,
    ),
    T0,
  );
}

it('parametry kategorii pokazują wartość, którą dostanie oferta: reguła stała, pole karty i marka ze słownika — także przy brakach', async () => {
  lampaNocna();
  const s = await sekcjaN();
  // Karta bez zdjęcia ma braki, a wartości i tak są widoczne.
  expect(s).toContain('Dodaj co najmniej jedno zdjęcie');
  expect(wiersz(s, 'Stan')).toEqual({ wartosc: 'Nowy', skad: 'reguła kategorii: stała wartość' });
  expect(wiersz(s, 'Kod producenta')).toEqual({ wartosc: 'LMP-NOC-001', skad: 'reguła kategorii: pole karty „sku”' });
  expect(wiersz(s, 'Marka')).toEqual({ wartosc: 'Pracownia Półcień', skad: 'reguła kategorii: pole karty „marka”' });
  expect(wiersz(s, 'Kolor')).toEqual({ wartosc: 'mleczny', skad: 'reguła kategorii: stała wartość' });
});

it('marka bez słownika w opisie kategorii (setki wartości) → nazwa z mapy marek, nie samo id', async () => {
  lampaNocna({ markaBezSlownika: true });
  let s = await sekcjaN();
  expect(wiersz(s, 'Marka')).toEqual({ wartosc: 'Pracownia Półcień', skad: 'reguła kategorii: pole karty „marka”' });
  expect(s).not.toContain('<select name="parametr:248811"');
  db.prepare(`UPDATE allegro_marki SET wartosc_tekst = 'Półcień' WHERE marka = 'Pracownia Półcień'`).run();
  s = await sekcjaN();
  expect(wiersz(s, 'Marka')?.wartosc).toBe('Półcień');
});

it('nadpisanie na karcie wygrywa z regułą; import oferty w tej samej kategorii daje wartość z importu', async () => {
  lampaNocna();
  db.prepare(
    `INSERT INTO karty_dane_kanalu (karta_id, typ_kanalu, polaczenie, oferta_id, produkt_id, kategoria_id, parametry_json, pobrano_at)
    VALUES (?, 'allegro', 'allegro-demo', 'ext:n1', NULL, '259', ?, ?)`,
  ).run(
    KARTA_N,
    JSON.stringify({
      produkt: [{ id: '5100', nazwa: 'Kolor', wartosci: ['bursztynowy'], wartosciId: null, zakres: null }],
      oferta: [],
    }),
    T0,
  );
  expect((await zapisN({ 'parametr:224017': 'SOWA-30' })).statusCode).toBe(303);
  const s = await sekcjaN();
  expect(wiersz(s, 'Kod producenta')).toEqual({ wartosc: 'SOWA-30', skad: 'nadpisane na karcie' });
  expect(wiersz(s, 'Kolor')).toEqual({ wartosc: 'bursztynowy', skad: 'z importu oferty Allegro' });
});

it('karta z EAN (droga „ean”): parametry produktu z Katalogu Allegro, bez pola w formularzu', async () => {
  lampaNocna({ ean: '5900000000017' });
  const s = await sekcjaN();
  expect(wiersz(s, 'Kolor')).toEqual({
    wartosc: 'z produktu w Katalogu Allegro',
    skad: 'reguła kategorii: stała wartość',
  });
  expect(wiersz(s, 'Kod producenta')?.wartosc).toBe('z produktu w Katalogu Allegro');
  expect(s).not.toContain('name="parametr:5100"');
  expect(s).not.toContain('name="parametr:224017"');
  expect(s).toContain('name="parametr:11323"');
});

it('każdą wartość z tabeli da się nadpisać: pole przy regule stałej i regule „pole karty” z wartością wyliczoną', async () => {
  lampaNocna();
  const s = await sekcjaN();
  expect(s).toMatch(
    /<label>Stan \*\s*<select name="parametr:11323" aria-describedby="allegro-skad-11323">\s*<option value="">— bez nadpisania \(teraz: Nowy\) —<\/option>/,
  );
  expect(s).toMatch(/<td id="allegro-skad-11323">reguła kategorii: stała wartość<\/td>/);
  const kod = s.match(/<input[^>]*name="parametr:224017"[^>]*>/)?.[0] ?? '';
  expect(kod).toContain('placeholder="LMP-NOC-001"');
  expect(kod).toContain('value=""');
  expect(kod).toContain('aria-describedby="allegro-skad-224017"');
  expect(s).toContain('Wartość wpisana tutaj wygrywa z regułą kategorii i z importem.');
});

it('zapis „Używany” w Stanie → tabela i oferta z kontem mają „Używany”; pusty wybór wraca do „Nowy” z reguły', async () => {
  lampaNocna();
  expect((await zapisN({ 'parametr:11323': '11323_2' })).statusCode).toBe(303);
  let s = await sekcjaN();
  expect(wiersz(s, 'Stan')).toEqual({ wartosc: 'Używany', skad: 'nadpisane na karcie' });
  expect(s).toMatch(/<option value="11323_2" selected>Używany<\/option>/);
  const konto = { klucz: 'allegro-demo', nazwa: 'Demo', srodowisko: 'produkcja' };
  const zKontem = ofertaAllegroKarty(db, KARTA_N, konto);
  expect(zKontem.parametryWyliczone.get('11323')).toEqual({
    wartosc: { id: '11323', valuesIds: ['11323_2'] },
    zKatalogu: false,
  });
  expect((await zapisN({ 'parametr:11323': '' })).statusCode).toBe(303);
  s = await sekcjaN();
  expect(wiersz(s, 'Stan')).toEqual({ wartosc: 'Nowy', skad: 'reguła kategorii: stała wartość' });
  expect(ofertaAllegroKarty(db, KARTA_N, konto).parametryWyliczone.get('11323')?.wartosc).toEqual({
    id: '11323',
    valuesIds: ['11323_1'],
  });
});
