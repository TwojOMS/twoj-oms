import { afterEach, beforeEach, expect, it } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { buildOmsServer } from '../../pomoc/serwer-testowy-oms.ts';
import { utworzKarte, kartyZKanalami, zliczeniaBrakow } from '../../../src/oms/db/magazyn.js';
import { zalozKonto, ustawUprawnienia } from '../../../src/core/bezpieczenstwo/konta.js';
import { podpisz, NAZWA_CIASTECZKA_OMS } from '../../../src/core/bezpieczenstwo/sesja.js';
import { wczytajSekret } from '../../../src/core/bezpieczenstwo/sekret-sesji.js';
import { przelaczStany, stanKarty } from '../../../src/oms/db/stany-magazynowe.js';
import { dzienWarszawa } from '../../../src/domena/format-daty.js';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let db, app, katalog;
const auth = {
  authorization: `Basic ${Buffer.from('operator:atrapa').toString('base64')}`,
  origin: 'http://localhost',
};
const payload = { nazwa: 'Lampa Półcień', sku: 'LMP-07', ean: '5901234123457', cena_zl: '28,90', stawka_vat: '23' };
beforeEach(async () => {
  katalog = await mkdtemp(join(tmpdir(), 'nowa-karta-'));
  db = openOmsDb(':memory:');
  app = buildOmsServer({
    db,
    env: { OMS_KATALOG_ZDJEC: katalog },
    config: { auth: { user: 'operator', pass: 'atrapa' } },
    magazyn: {
      stan: () => ({ trwa: false, zaczety_at: null, skonczony_at: null, postep: null, kanaly: [], blad: null }),
    },
  });
});
afterEach(async () => {
  await app.close();
  db.close();
  await rm(katalog, { recursive: true, force: true });
});
const post = (body = payload, headers = auth) =>
  app.inject({ method: 'POST', url: '/magazyn/nowa-karta', headers, payload: body });
const ile = () => db.prepare('SELECT COUNT(*) AS n FROM karty_produktow').get().n;

const opis = { opis_liczba: '1', s0_liczba: '1', t0_0: 'tekst', h0_0: '<p>Lampa <b>Półcień</b></p>' };
function png(szerokosc) {
  const bufor = Buffer.alloc(33);
  Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex').copy(bufor);
  bufor.writeUInt32BE(szerokosc, 16);
  bufor.writeUInt32BE(3, 20);
  return bufor;
}
function multipart(pola, pliki = []) {
  const czesci = Object.entries(pola).map(([pole, wartosc]) =>
    Buffer.from(`--nowa\r\nContent-Disposition: form-data; name="${pole}"\r\n\r\n${wartosc}\r\n`),
  );
  for (const [nazwa, bufor, typ = 'image/png'] of pliki) {
    czesci.push(
      Buffer.from(
        `--nowa\r\nContent-Disposition: form-data; name="zdjecie"; filename="${nazwa}"\r\nContent-Type: ${typ}\r\n\r\n`,
      ),
      bufor,
      Buffer.from('\r\n'),
    );
  }
  return post(Buffer.concat([...czesci, Buffer.from('--nowa--\r\n')]), {
    ...auth,
    'content-type': 'multipart/form-data; boundary=nowa',
  });
}

it('tworzy kartę z samą nazwą również z formularza multipart i pustym polem pliku', async () => {
  const r = await multipart({ nazwa: payload.nazwa }, [['', Buffer.alloc(0), 'application/octet-stream']]);
  expect(r.statusCode).toBe(303);
  expect(db.prepare('SELECT nazwa, marka, kategoria_glowna, opis_sekcje_json FROM karty_produktow').get()).toEqual({
    nazwa: payload.nazwa,
    marka: null,
    kategoria_glowna: null,
    opis_sekcje_json: null,
  });
});

it('akcja edytora przed zapisem nie zmienia pustego opisu kolejnego formularza', async () => {
  const edycja = await multipart({ akcja: 'usun:0' });
  expect(edycja.statusCode).toBe(200);
  expect(edycja.body).not.toContain('name="h0_0"');
  expect(ile()).toBe(0);
  const nowy = await app.inject({ url: '/magazyn/nowa-karta', headers: auth });
  expect(nowy.body).toContain('name="h0_0"');
});

it('zapisuje markę, kategorię i oczyszczony opis, a nowe nazwy trafiają do słowników', async () => {
  const r = await multipart({
    nazwa: payload.nazwa,
    marka: 'Inna marka',
    marka_nowa: 'Pracownia Półcień',
    kategoria_glowna_nowa: 'Lampy stołowe',
    ...opis,
    h0_0: '<p onclick="obcy()">Lampa <b>Półcień</b></p>',
  });
  expect(r.statusCode).toBe(303);
  const karta = db.prepare('SELECT marka, kategoria_glowna, opis_sekcje_json FROM karty_produktow').get();
  expect(karta).toMatchObject({ marka: 'Pracownia Półcień', kategoria_glowna: 'Lampy stołowe' });
  expect(JSON.parse(karta.opis_sekcje_json)).toEqual({ sekcje: [{ elementy: [{ typ: 'tekst', html: opis.h0_0 }] }] });
  expect(db.prepare('SELECT nazwa FROM marki').all()).toEqual([{ nazwa: 'Pracownia Półcień' }]);
  expect(db.prepare('SELECT nazwa FROM kategorie_kart').all()).toEqual([{ nazwa: 'Lampy stołowe' }]);
});

it('wycofuje kartę i wpisy słowników po błędzie zapisu ceny zakupu', async () => {
  db.exec(`CREATE TRIGGER odmow_zapisu BEFORE INSERT ON ceny_zakupu_kart
    BEGIN SELECT RAISE(ABORT, 'Test atomowości'); END`);
  const r = await multipart({
    nazwa: payload.nazwa,
    marka_nowa: 'Pracownia Półcień',
    kategoria_glowna_nowa: 'Lampy stołowe',
    cena_zakupu_netto: '12,30',
    ...opis,
  });
  expect(r.statusCode).toBe(500);
  expect(ile()).toBe(0);
  expect(db.prepare('SELECT nazwa FROM marki').all()).toEqual([]);
  expect(db.prepare('SELECT nazwa FROM kategorie_kart').all()).toEqual([]);
});

it('zapisuje zdjęcia w kolejności wyboru i znacznik AI tylko przy drugim', async () => {
  const r = await multipart({ nazwa: payload.nazwa, zdjecie_ai_1: '1' }, [
    ['glowne.png', png(8)],
    ['drugie.png', png(4)],
  ]);
  expect(r.statusCode).toBe(303);
  expect(db.prepare('SELECT kolejnosc, szerokosc, ai FROM zdjecia_kart ORDER BY kolejnosc').all()).toEqual([
    { kolejnosc: 0, szerokosc: 8, ai: 0 },
    { kolejnosc: 1, szerokosc: 4, ai: 1 },
  ]);
});

it.each([
  ['animacja.gif', Buffer.from('GIF89a'), 'image/gif', 'JPEG, PNG lub WebP'],
  ['za-duze.png', Buffer.alloc(10 * 1024 * 1024 + 1), 'image/png', '10 MB'],
])('odmawia przed utworzeniem karty dla %s i zachowuje wpisane pola', async (nazwa, bufor, typ, powod) => {
  const r = await multipart({ ...payload, marka_nowa: 'Pracownia Półcień', ...opis }, [[nazwa, bufor, typ]]);
  expect(ile()).toBe(0);
  expect(r.statusCode).toBe(400);
  for (const tekst of [nazwa, powod, 'wybierz ponownie', 'LMP-07', 'Pracownia Półcień', '&lt;b&gt;Półcień&lt;/b&gt;'])
    expect(r.body).toContain(tekst);
});

it('po odrzuceniu uszkodzonego zdjęcia zachowuje kartę i poprawne zdjęcie, pokazuje powód na karcie', async () => {
  const r = await multipart({ nazwa: payload.nazwa }, [
    ['uszkodzone.png', Buffer.from('89504e470d0a1a0a', 'hex')],
    ['poprawne.png', png(4)],
  ]);
  expect(r.statusCode).toBe(303);
  expect(ile()).toBe(1);
  expect(db.prepare('SELECT kolejnosc, szerokosc FROM zdjecia_kart').all()).toEqual([{ kolejnosc: 0, szerokosc: 4 }]);
  const ekran = await app.inject({ url: r.headers.location, headers: auth });
  expect(ekran.statusCode).toBe(200);
  expect(ekran.body).toContain('Utworzono kartę; nie wgrałem 1 zdjęcia: uszkodzone.png — Niedozwolony lub uszkodzony');
});

it('udostępnia formularz i wejście z listy; GET nic nie zapisuje', async () => {
  const lista = await app.inject({ url: '/magazyn', headers: auth });
  expect(lista.body).toContain('href="/magazyn/nowa-karta"');
  const r = await app.inject({ url: '/magazyn/nowa-karta', headers: auth });
  expect(r.statusCode).toBe(200);
  expect(r.body).toContain('action="/magazyn/nowa-karta"');
  expect(r.body).toContain('name="nazwa"');
  expect(r.body).toContain('required');
  expect(ile()).toBe(0);
});
it.each([undefined, '', '   '])('odmawia bez nazwy (%s), zachowując wpisane wartości', async (nazwa) => {
  const body = { ...payload, nazwa };
  if (nazwa === undefined) delete body.nazwa;
  const r = await post(body);
  expect(r.statusCode).toBe(400);
  expect(r.body).toContain('Karta musi mieć nazwę');
  for (const value of ['LMP-07', '5901234123457', '28,90']) expect(r.body).toContain(`value="${value}"`);
  expect(ile()).toBe(0);
});
it('zapisuje 28,90 jako 2890 gr, ręczne źródła i przekierowuje; nie tworzy ruchu stanu', async () => {
  przelaczStany(db, { wlacz: true });
  const r = await post();
  expect(r.statusCode).toBe(303);
  const karta = db.prepare('SELECT * FROM karty_produktow').get();
  expect(r.headers.location).toBe(`/magazyn/${karta.id}`);
  expect(karta).toMatchObject({
    nazwa: payload.nazwa,
    sku: payload.sku,
    ean: payload.ean,
    cena_gr: 2890,
    stawka_vat: '23',
  });
  expect(db.prepare('SELECT pole, zrodlo, reczne FROM karty_zrodla_pol ORDER BY pole').all()).toEqual(
    ['cena_gr', 'ean', 'nazwa', 'sku', 'stawka_vat'].map((pole) => ({ pole, zrodlo: 'reczne', reczne: 1 })),
  );
  expect(db.prepare('SELECT COUNT(*) AS n FROM ruchy_magazynowe').get().n).toBe(0);
  expect(stanKarty(db, karta.id).stan).toBe(0);
});
it('pozwala podać samą nazwę i pozostawia pozostałe pola bez ręcznych źródeł', async () => {
  expect((await post({ nazwa: 'Lampa Półcień' })).statusCode).toBe(303);
  expect(db.prepare('SELECT sku, ean, cena_gr, stawka_vat FROM karty_produktow').get()).toEqual({
    sku: null,
    ean: null,
    cena_gr: null,
    stawka_vat: null,
  });
  expect(db.prepare('SELECT pole FROM karty_zrodla_pol').all()).toEqual([{ pole: 'nazwa' }]);
});
it.each([{ ean: '123' }, { cena_zl: 'abc' }, { stawka_vat: '99' }, { sku: 'ZAJETE' }])(
  'stosuje walidację karty: %j',
  async (zmiana) => {
    utworzKarte(db, { nazwa: 'Lampa inna', sku: 'ZAJETE' });
    const r = await post({ ...payload, ...zmiana });
    expect(r.statusCode).toBe(400);
    expect(ile()).toBe(1);
    expect(r.body).not.toContain('Internal Server Error');
  },
);
it('odrzuca CSRF przed zapisem', async () => {
  expect((await post(payload, { ...auth, origin: 'http://obcy.example' })).statusCode).toBe(403);
  expect((await post(payload, { authorization: auth.authorization })).statusCode).toBe(403);
  expect(ile()).toBe(0);
});
it('na pustej liście oba kafle i filtry są puste', () => {
  expect(zliczeniaBrakow(db)).toMatchObject({ bezZdjecia: 0, bezOpisu: 0 });
  for (const brak of ['zdjecie', 'opis']) expect(kartyZKanalami(db, { filtry: { brak } })).toEqual([]);
});
it('pusta karta zachowuje sześć braków w danych, bez kolumny Stan na liście', async () => {
  utworzKarte(db, { nazwa: 'Lampa bez danych' });
  const r = await app.inject({ url: '/magazyn', headers: auth });
  expect(r.statusCode).toBe(200);
  expect(kartyZKanalami(db)[0].liczba_brakow).toBe(6);
  expect(r.body).toContain('>Lampa bez danych</a>');
  expect(r.body).not.toContain('class="stan-braki"');
});
it('wymaga logowania i uprawnienia magazyn dla obu tras', async () => {
  for (const method of ['GET', 'POST']) {
    const r = await app.inject({
      method,
      url: '/magazyn/nowa-karta',
      payload: method === 'POST' ? payload : undefined,
    });
    expect([401, 302, 303]).toContain(r.statusCode);
  }
  await app.ready();
  zalozKonto(db, { login: 'admin', imie: 'Admin', haslo: 'test', rola: 'admin', admin: true });
  const id = zalozKonto(db, { login: 'czytelnik', imie: 'Czytelnik', haslo: 'test', rola: 'operator' });
  ustawUprawnienia(db, id, []);
  const headers = {
    origin: 'http://localhost',
    cookie: `${NAZWA_CIASTECZKA_OMS}=${podpisz('czytelnik', wczytajSekret(db), Date.now(), 0)}`,
  };
  for (const method of ['GET', 'POST'])
    expect(
      (
        await app.inject({
          method,
          url: '/magazyn/nowa-karta',
          headers,
          payload: method === 'POST' ? payload : undefined,
        })
      ).statusCode,
    ).toBe(403);
  expect(ile()).toBe(0);
});

it('filtry zdjęć i opisów zgadzają się ze zliczeniami; select zachowuje wybór', async () => {
  const pelna = { sku: 'PELNA', szerokosc_mm: 100, wysokosc_mm: 100, paczkomat: 'tak', kategoria_glowna: 'Lampy' };
  const ids = ['Komplet', 'Bez zdjęcia', 'Bez opisu', 'Bez obu'].map((nazwa, i) =>
    utworzKarte(db, { ...pelna, sku: `K-${i}`, nazwa }),
  );
  for (const id of ids.slice(0, 2))
    db.prepare('UPDATE karty_produktow SET opis_sekcje_json = ? WHERE id = ?').run(
      JSON.stringify({ sekcje: [{ elementy: [{ typ: 'tekst', html: '<p>Lampa</p>' }] }] }),
      id,
    );
  db.prepare('UPDATE karty_produktow SET opis_sekcje_json = ? WHERE id = ?').run('{"sekcje":[]}', ids[2]);
  for (const id of [ids[0], ids[2]])
    db.prepare(
      `INSERT INTO zdjecia_kart
    (karta_id, kolejnosc, zrodlo, adres_zrodlowy, utworzono_at) VALUES (?, 0, 'reczne', 'https://example.org/lampa.png', '2026-11-13')`,
    ).run(id);
  const z = zliczeniaBrakow(db);
  expect(z.bezZdjecia).toBe(2);
  expect(z.bezOpisu).toBe(2);
  for (const [brak, klucz, nazwy] of [
    ['zdjecie', 'bezZdjecia', ['Bez obu', 'Bez zdjęcia']],
    ['opis', 'bezOpisu', ['Bez obu', 'Bez opisu']],
  ]) {
    const lista = kartyZKanalami(db, { filtry: { brak } });
    expect(lista.map((k) => k.nazwa)).toEqual(nazwy);
    expect(lista.length).toBe(z[klucz]);
    const ekran = await app.inject({ url: `/magazyn?brak=${brak}`, headers: auth });
    expect(ekran.statusCode).toBe(200);
    expect(ekran.body).not.toContain('class="kafle"');
    expect(ekran.body).toContain(`brak=${brak}`);
    expect(ekran.body).toContain(`<option value="${brak}" selected>`);
    for (const id of ids) expect(ekran.body.includes(`href="/magazyn/${id}?`)).toBe(lista.some((k) => k.id === id));
  }
  expect(kartyZKanalami(db, { sort: 'braki', kier: 'desc' }).map((k) => k.liczba_brakow)).toEqual([2, 1, 1, 0]);
  expect(kartyZKanalami(db, { filtry: { brak: 'komplet' } }).map((k) => k.id)).toEqual([ids[0]]);
});
it('karta z popsutym opis_sekcje_json nie wywraca listy ani kafli i liczy się jako bez opisu', async () => {
  const id = utworzKarte(db, { nazwa: 'Lampa z popsutym opisem' });
  for (const zly of ['', 'nie-json']) {
    db.prepare('UPDATE karty_produktow SET opis_sekcje_json = ? WHERE id = ?').run(zly, id);
    expect(zliczeniaBrakow(db).bezOpisu).toBe(1);
    expect(kartyZKanalami(db, { filtry: { brak: 'opis' } }).map((k) => k.id)).toEqual([id]);
    expect((await app.inject({ url: '/magazyn', headers: auth })).statusCode).toBe(200);
  }
});
it('niegotowy magazyn: nowa karta nic nie zapisuje', async () => {
  await app.close();
  app = buildOmsServer({
    db,
    config: { auth: { user: 'operator', pass: 'atrapa' } },
    magazyn: { gotowy: () => false, stan: () => ({ trwa: false }) },
  });
  expect((await post()).statusCode).toBe(302);
  expect(ile()).toBe(0);
});

const cenaKarty = () => db.prepare('SELECT cena_gr, stawka_vat FROM karty_produktow').get();
const wpisyZakupu = () =>
  db.prepare('SELECT karta_id, cena_netto_gr, obowiazuje_od, kto, zrodlo FROM ceny_zakupu_kart').all();

it('netto 10,00 + 23% zapisuje 1230 gr brutto', async () => {
  expect(
    (await post({ nazwa: 'Lampa Półcień', cena_netto_zl: '10,00', cena_zl: '', stawka_vat: '23' })).statusCode,
  ).toBe(303);
  expect(cenaKarty()).toEqual({ cena_gr: 1230, stawka_vat: '23' });
});
it('brutto 12,30 + 23% zapisuje 1230 gr i wygrywa z netto', async () => {
  expect(
    (await post({ nazwa: 'Lampa Półcień', cena_netto_zl: '99,00', cena_zl: '12,30', stawka_vat: '23' })).statusCode,
  ).toBe(303);
  expect(cenaKarty()).toEqual({ cena_gr: 1230, stawka_vat: '23' });
});
it.each([
  ['10,005', 1231], // netto 1001 gr (połówka w górę przy czytaniu kwoty) × 1,23
  ['0,50', 62], // 50 gr × 1,23 = 61,5 gr → w górę
])('netto %s zaokrągla połówkę grosza w górę: %i gr brutto', async (netto, gr) => {
  expect((await post({ nazwa: 'Lampa Półcień', cena_netto_zl: netto, stawka_vat: '23' })).statusCode).toBe(303);
  expect(cenaKarty().cena_gr).toBe(gr);
});
it('netto bez stawki VAT → 400 z podpowiedzią i wypełnionymi polami, nic nie zapisuje', async () => {
  const r = await post({ nazwa: 'Lampa Półcień', sku: 'LMP-07', cena_netto_zl: '10,00', cena_zakupu_netto: '6,50' });
  expect(r.statusCode).toBe(400);
  expect(r.body).toContain('Wybierz stawkę VAT albo wpisz cenę brutto.');
  for (const value of ['Lampa Półcień', 'LMP-07', '10,00', '6,50']) expect(r.body).toContain(`value="${value}"`);
  expect(ile()).toBe(0);
  expect(wpisyZakupu()).toEqual([]);
});
it('cena zakupu netto → wpis historii od dziś ze źródłem karta, w tej samej operacji', async () => {
  const r = await post({ nazwa: 'Lampa Półcień', cena_zakupu_netto: '6,50' });
  expect(r.statusCode).toBe(303);
  const karta = db.prepare('SELECT id FROM karty_produktow').get();
  expect(wpisyZakupu()).toEqual([
    {
      karta_id: karta.id,
      cena_netto_gr: 650,
      obowiazuje_od: dzienWarszawa(new Date().toISOString()),
      kto: 'operator',
      zrodlo: 'karta',
    },
  ]);
});
it('sama nazwa nie tworzy wpisu ceny zakupu', async () => {
  expect((await post({ nazwa: 'Lampa Półcień' })).statusCode).toBe(303);
  expect(wpisyZakupu()).toEqual([]);
});
it('zła cena zakupu → 400 bez karty i bez wpisu', async () => {
  const r = await post({ nazwa: 'Lampa Półcień', cena_zakupu_netto: 'tanio' });
  expect(r.statusCode).toBe(400);
  expect(r.body).toContain('value="tanio"');
  expect(ile()).toBe(0);
  expect(wpisyZakupu()).toEqual([]);
});
it('błąd zapisu ceny zakupu cofa też utworzoną kartę', async () => {
  db.exec(`CREATE TRIGGER psuj_zakup BEFORE INSERT ON ceny_zakupu_kart BEGIN SELECT RAISE(ABORT, 'atrapa'); END`);
  const r = await post({ nazwa: 'Lampa Półcień', cena_zakupu_netto: '6,50' });
  expect(r.statusCode).toBe(500);
  expect(ile()).toBe(0);
});
it('formularz ma pola cen i liczy w przeglądarce tym samym modułem co serwer', async () => {
  const r = await app.inject({ url: '/magazyn/nowa-karta', headers: auth });
  for (const nazwa of ['cena_zakupu_netto', 'cena_netto_zl', 'stawka_vat', 'cena_zl'])
    expect(r.body).toContain(`name="${nazwa}"`);
  expect(r.body).toContain('data-ceny="/public/domena/cena-sprzedazy.js"');
  expect(r.body).toMatch(/<script type="module" src="\/public\/nowa-karta-ceny\.js\?v=/);
  for (const plik of ['cena-sprzedazy.js', 'vat.js', 'kwota.js']) {
    const modul = await app.inject({ url: `/public/domena/${plik}` });
    expect(modul.statusCode).toBe(200);
    expect(modul.headers['content-type']).toMatch(/^text\/javascript/);
    expect(modul.body).toBe(readFileSync(new URL(`../../../src/domena/${plik}`, import.meta.url), 'utf8'));
  }
  expect((await app.inject({ url: '/public/domena/format-daty.js' })).statusCode).toBe(404);
  expect((await app.inject({ url: '/public/domena/..%2Fkonfiguracja.js' })).statusCode).toBe(404);
});
