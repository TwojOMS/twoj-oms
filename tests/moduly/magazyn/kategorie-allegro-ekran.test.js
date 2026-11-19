// Ekran mapowania kategorii, reguł parametrów i marek Allegro (D33, D36).
// Klienci Allegro to atrapy na fixture P9 (żadnego połączenia z Allegro); dane zmyślone („Pracownia Półcień”).
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { buildOmsServer } from '../../pomoc/serwer-testowy-oms.ts';
import { definicjeKanalowHistoryczne } from '../../pomoc/przykladowe-definicje-kanalow.js';
import { szyfrTestowy } from '../../pomoc/sejf-testowy.ts';
import { utworzKarte } from '../../../src/oms/db/magazyn.js';
import { zalozKonto, ustawUprawnienia } from '../../../src/core/bezpieczenstwo/konta.js';
import { podpisz, NAZWA_CIASTECZKA_OMS } from '../../../src/core/bezpieczenstwo/sesja.js';
import { wczytajSekret } from '../../../src/core/bezpieczenstwo/sekret-sesji.js';

const P9 = JSON.parse(
  readFileSync(new URL('../../fixtures/allegro/e3-pomiar-p9-kategoria.json', import.meta.url), 'utf8'),
);
const MARKA = '248811';
const WARTOSC = '248811_100001'; // „Pracownia 001” w słowniku kategorii A (257)
const ODCZYT = 'allegro:api:sale:offers:read';
const auth = {
  authorization: `Basic ${Buffer.from('operator:atrapa').toString('base64')}`,
  origin: 'http://localhost',
};
const jwt = (scope) => ['e30', Buffer.from(JSON.stringify({ scope })).toString('base64url'), 'podpis'].join('.');

// Kategoria B (258, liść) ma słownik marek BEZ wartości WARTOSC; 256 nie jest liściem.
const KATEGORIE = {
  ...Object.fromEntries(P9.sciezka.map((k) => [k.id, k])),
  258: {
    id: '258',
    name: 'Lampy wiszące',
    parent: { id: '256' },
    leaf: true,
    options: { productCreationEnabled: true },
  },
};
const parametryB = () => ({
  parameters: P9.parametry.parameters.map((p) =>
    p.id === MARKA ? { ...p, dictionary: p.dictionary.filter((w) => w.id !== WARTOSC) } : p,
  ),
});
const parametry = (id) => (id === '258' ? parametryB() : structuredClone(P9.parametry));

function atrapaKlienta() {
  return {
    pobierzKategorie: vi.fn(async (id) => {
      if (!KATEGORIE[id]) throw Object.assign(new Error('nie ma'), { status: 404 });
      return structuredClone(KATEGORIE[id]);
    }),
    pobierzParametryKategorii: vi.fn(async (id) => parametry(String(id))),
    dopasujKategorie: vi.fn(async (nazwa) =>
      nazwa === 'Lampy stołowe'
        ? [
            { id: '257', name: 'Lampy stołowe', parentCategory: { id: '256', name: 'Oświetlenie' } },
            { id: '256', name: 'Oświetlenie', leaf: false },
          ]
        : [
            { id: '258', name: 'Lampy wiszące', parentCategory: { id: '256', name: 'Oświetlenie' } },
            { id: '257', name: 'Lampy stołowe', parentCategory: { id: '256', name: 'Oświetlenie' } },
          ],
    ),
  };
}

let db, app, klienci, konta;
const post = (url, payload, headers = auth) => app.inject({ method: 'POST', url, payload, headers });
const get = (url, headers = auth) => app.inject({ method: 'GET', url, headers });
const mapa = () =>
  db
    .prepare(
      'SELECT kategoria_karty, srodowisko, kategoria_allegro_id, potwierdzil, potwierdzono_at FROM allegro_mapa_kategorii ORDER BY srodowisko',
    )
    .all();
const tokeny = (kanal, scope) =>
  db
    .prepare(
      `INSERT OR REPLACE INTO tokeny_kanalu (kanal, access_token, refresh_token, wygasa_at, refresh_wygasa_at, zaktualizowane_at)
  VALUES (?, ?, ?, '2026-11-14T11:00:00Z', '2027-01-01T00:00:00Z', '2026-11-14T10:00:00Z')`,
    )
    .run(
      kanal,
      szyfrTestowy(db, 'tokeny_kanalu', 'access_token', kanal, jwt(scope)),
      szyfrTestowy(db, 'tokeny_kanalu', 'refresh_token', kanal, 'REFRESH-ATRAPA'),
    );
const ADRES_A = `/magazyn/kategorie/${encodeURIComponent('Lampy stołowe')}/allegro`;
const ADRES_B = `/magazyn/kategorie/${encodeURIComponent('Lampy wiszące')}/allegro`;
const ADRES_MARKI = `/magazyn/marki/${encodeURIComponent('Pracownia Półcień')}/allegro`;

beforeEach(async () => {
  db = openOmsDb(':memory:');
  klienci = { 'allegro-polcien': atrapaKlienta(), 'allegro-polcien-sb': atrapaKlienta() };
  konta = [
    { klucz: 'allegro-polcien', nazwa: 'Półcień', autoryzacja: 'polaczone', srodowisko: 'produkcja' },
    { klucz: 'allegro-polcien-sb', nazwa: 'Półcień test', autoryzacja: 'polaczone', srodowisko: 'sandbox' },
  ];
  app = buildOmsServer({
    db,
    config: { auth: { user: 'operator', pass: 'atrapa' }, definicje: definicjeKanalowHistoryczne },
    magazyn: { stan: () => ({ trwa: false, kanaly: [] }) },
    nadpisania: {
      'kanaly.klienciKanalow': klienci,
      'kanaly.repozytoriumKanalow': {
        listaTypu: (typ) => (typ === 'allegro' ? konta : []),
        zapisyZablokowane: () => false,
        konfliktKlucza: () => false,
      },
    },
  });
  await app.ready();
  tokeny('allegro-polcien', [ODCZYT]);
  tokeny('allegro-polcien-sb', [ODCZYT]);
  for (const nazwa of ['Lampy stołowe', 'Lampy wiszące'])
    db.prepare('INSERT OR IGNORE INTO kategorie_kart (nazwa, utworzona_at) VALUES (?, ?)').run(
      nazwa,
      '2026-11-01T10:00:00Z',
    );
  db.prepare('INSERT OR IGNORE INTO marki (nazwa, utworzona_at) VALUES (?, ?)').run(
    'Pracownia Półcień',
    '2026-11-01T10:00:00Z',
  );
  utworzKarte(db, {
    nazwa: 'Lampka biurkowa Półcień',
    sku: 'LMP-01',
    kategoria_glowna: 'Lampy stołowe',
    marka: 'Pracownia Półcień',
    ean: '5901234123457',
  });
  utworzKarte(db, {
    nazwa: 'Lampka nocna Półcień',
    sku: 'LMP-02',
    kategoria_glowna: 'Lampy stołowe',
    marka: 'Pracownia Półcień',
  });
});
afterEach(async () => {
  await app.close();
  db.close();
});

it('zatwierdzenie zapisuje mapę z loginem i datą dla środowiska i nie dotyka drugiego', async () => {
  db.prepare(
    `INSERT INTO allegro_mapa_kategorii (kategoria_karty, srodowisko, kategoria_allegro_id, sciezka_json, potwierdzil, potwierdzono_at)
    VALUES ('Lampy stołowe', 'sandbox', '258', NULL, 'ktos', '2026-11-01T10:00:00Z')`,
  ).run();
  const r = await post(ADRES_A, { srodowisko: 'produkcja', kategoria_id: '257' });
  expect(r.statusCode).toBe(303);
  expect(mapa()).toEqual([
    expect.objectContaining({
      srodowisko: 'produkcja',
      kategoria_allegro_id: '257',
      potwierdzil: 'operator',
      potwierdzono_at: expect.stringMatching(/^20\d\d-/),
    }),
    {
      kategoria_karty: 'Lampy stołowe',
      srodowisko: 'sandbox',
      kategoria_allegro_id: '258',
      potwierdzil: 'ktos',
      potwierdzono_at: '2026-11-01T10:00:00Z',
    },
  ]);
  // „Stan” dostaje od razu regułę „stała: Nowy” — tylko w środowisku zatwierdzenia.
  expect(
    db
      .prepare(
        'SELECT srodowisko, kategoria_allegro_id, parametr_id, rodzaj, wartosc_json FROM allegro_reguly_parametrow',
      )
      .all(),
  ).toEqual([
    {
      srodowisko: 'produkcja',
      kategoria_allegro_id: '257',
      parametr_id: '11323',
      rodzaj: 'stala',
      wartosc_json: '{"valuesIds":["11323_1"]}',
    },
  ]);
  // Opis kategorii przez konto produkcji, nie sandboxu.
  expect(klienci['allegro-polcien-sb'].pobierzKategorie).not.toHaveBeenCalled();
  const ekran = await get(`${ADRES_A}?srodowisko=produkcja`);
  expect(ekran.statusCode).toBe(200);
  for (const tekst of [
    'Dom i Ogród',
    'Lampy stołowe',
    'Marka',
    'Kod producenta',
    'Stan',
    'Nowy',
    '0 z 2 kart ma komplet',
  ])
    expect(ekran.body).toContain(tekst);
});

it('kategoria nie-liść → odmowa bez zapisu', async () => {
  const r = await post(ADRES_A, { srodowisko: 'produkcja', kategoria_id: '256' });
  expect(r.statusCode).toBe(400);
  expect(r.body).toContain('nie jest liściem');
  expect(mapa()).toEqual([]);
});

it('reguła dla parametru spoza kategorii → odmowa; reguła z kategorii zapisuje się', async () => {
  await post(ADRES_A, { srodowisko: 'produkcja', kategoria_id: '257' });
  const zla = await post(`${ADRES_A}/regula`, { srodowisko: 'produkcja', parametr_id: '999999', rodzaj: 'na_karcie' });
  expect(zla.statusCode).toBe(400);
  expect(zla.body).toContain('spoza kategorii');
  const zlePole = await post(`${ADRES_A}/regula`, {
    srodowisko: 'produkcja',
    parametr_id: '224017',
    rodzaj: 'pole',
    pole: 'haslo',
  });
  expect(zlePole.statusCode).toBe(400);
  const zlaStala = await post(`${ADRES_A}/regula`, {
    srodowisko: 'produkcja',
    parametr_id: '11323',
    rodzaj: 'stala',
    wartosc: '11323_9',
  });
  expect(zlaStala.statusCode).toBe(400);
  const ok = await post(`${ADRES_A}/regula`, {
    srodowisko: 'produkcja',
    parametr_id: '224017',
    rodzaj: 'pole',
    pole: 'sku',
  });
  expect(ok.statusCode).toBe(303);
  const marka = await post(`${ADRES_A}/regula`, {
    srodowisko: 'produkcja',
    parametr_id: MARKA,
    rodzaj: 'pole',
    pole: 'marka',
  });
  expect(marka.statusCode).toBe(303);
  // Słownik ponad 200 wartości: stała sprawdzona w pełnym słowniku z Allegro.
  const wycieta = await post(`${ADRES_A}/regula`, {
    srodowisko: 'sandbox',
    parametr_id: MARKA,
    rodzaj: 'stala',
    wartosc: '248811_100250',
  });
  expect(wycieta.statusCode).toBe(400); // sandbox nie ma mapy tej kategorii
  expect(
    db
      .prepare(
        "SELECT parametr_id, rodzaj, pole, potwierdzil FROM allegro_reguly_parametrow WHERE parametr_id <> '11323' ORDER BY parametr_id",
      )
      .all(),
  ).toEqual([
    { parametr_id: '224017', rodzaj: 'pole', pole: 'sku', potwierdzil: 'operator' },
    { parametr_id: MARKA, rodzaj: 'pole', pole: 'marka', potwierdzil: 'operator' },
  ]);
  const ekran = await get(`${ADRES_A}?srodowisko=produkcja`);
  expect(ekran.body).toContain('0 z 2 kart ma komplet');
  expect(ekran.body).toContain('Marka (2)');
});

it('marka z wartością obecną w kategorii A i nieobecną w B → kategorie_sprawdzone_json = [A]; B wypisana z nazwy', async () => {
  expect((await post(ADRES_A, { srodowisko: 'produkcja', kategoria_id: '257' })).statusCode).toBe(303);
  expect((await post(ADRES_B, { srodowisko: 'produkcja', kategoria_id: '258' })).statusCode).toBe(303);
  const r = await post(ADRES_MARKI, { srodowisko: 'produkcja', parametr_id: MARKA, wartosc_id: WARTOSC });
  expect(r.statusCode).toBe(303);
  const wiersz = db.prepare('SELECT * FROM allegro_marki').get();
  expect(wiersz).toEqual(
    expect.objectContaining({
      marka: 'Pracownia Półcień',
      srodowisko: 'produkcja',
      parametr_id: MARKA,
      wartosc_id: WARTOSC,
      wartosc_tekst: 'Pracownia 001',
      potwierdzil: 'operator',
    }),
  );
  expect(JSON.parse(wiersz.kategorie_sprawdzone_json)).toEqual(['257']);
  const ekran = await get(`${ADRES_MARKI}?srodowisko=produkcja`);
  expect(ekran.statusCode).toBe(200);
  expect(ekran.body).toContain('Lampy wiszące');
  expect(ekran.body).toContain('nie ma tej wartości');
  // Wartość spoza słownika każdej kategorii → odmowa.
  const zla = await post(ADRES_MARKI, { srodowisko: 'produkcja', parametr_id: MARKA, wartosc_id: '248811_999999' });
  expect(zla.statusCode).toBe(400);
  // Ponowne zatwierdzenie kategorii sprawdza zmapowaną markę w jej słowniku (D36).
  db.prepare("UPDATE allegro_marki SET kategorie_sprawdzone_json = '[]'").run();
  await post(ADRES_A, { srodowisko: 'produkcja', kategoria_id: '257' });
  expect(JSON.parse(db.prepare('SELECT kategorie_sprawdzone_json AS k FROM allegro_marki').get().k)).toEqual(['257']);
});

it('podpowiedzi: tylko liście, bez powtórzeń, z nazw kart; marka podpowiada dokładne trafienie', async () => {
  const r = await get(`${ADRES_A}?srodowisko=produkcja`);
  expect(r.statusCode).toBe(200);
  expect(r.body).toContain('Lampy wiszące');
  expect(r.body).toContain('value="257"');
  expect(r.body).not.toContain('value="256"');
  expect(klienci['allegro-polcien'].dopasujKategorie).toHaveBeenCalledWith('Lampy stołowe');
  expect(klienci['allegro-polcien'].dopasujKategorie).toHaveBeenCalledWith('Lampka biurkowa Półcień');
  // Wybór środowiska, gdy konta są w obu.
  expect(r.body).toContain('srodowisko=sandbox');
  await post(ADRES_A, { srodowisko: 'produkcja', kategoria_id: '257' });
  const m = await get(`${ADRES_MARKI}?srodowisko=produkcja&szukaj=${encodeURIComponent('Pracownia 001')}`);
  expect(m.statusCode).toBe(200);
  expect(m.body).toContain(WARTOSC);
});

it('brak zakresu odczytu, brak konta w środowisku albo odmowa Allegro → komunikat, nie 500', async () => {
  tokeny('allegro-polcien-sb', ['allegro:api:orders:read']);
  const r = await get(`${ADRES_A}?srodowisko=sandbox`);
  expect(r.statusCode).toBe(200);
  expect(r.body).toContain('Połącz konto Allegro w środowisku sandbox');
  expect((await post(ADRES_A, { srodowisko: 'sandbox', kategoria_id: '257' })).statusCode).toBe(400);
  konta = [konta[0]];
  const bez = await get(`${ADRES_A}?srodowisko=sandbox`);
  expect(bez.statusCode).toBe(200);
  expect(bez.body).toContain('Połącz konto Allegro w środowisku sandbox');
  klienci['allegro-polcien'].dopasujKategorie.mockRejectedValue(
    Object.assign(new Error('Forbidden token=SEKRET'), { status: 403 }),
  );
  const odmowa = await get(`${ADRES_A}?srodowisko=produkcja`);
  expect(odmowa.statusCode).toBe(200);
  expect(odmowa.body).toContain('Nie udało się pobrać podpowiedzi');
  expect(odmowa.body).not.toContain('SEKRET');
  const marka = await get(`${ADRES_MARKI}?srodowisko=sandbox`);
  expect(marka.statusCode).toBe(200);
  expect(marka.body).toContain('Połącz konto Allegro w środowisku sandbox');
});

it('lista Kategorie i tabela marek na ekranie Producenci mają kolumnę Allegro', async () => {
  await post(ADRES_A, { srodowisko: 'produkcja', kategoria_id: '257' });
  const k = await get('/magazyn/kategorie');
  expect(k.body).toContain('Allegro');
  expect(k.body).toContain('Dom i Ogród › Oświetlenie › Lampy stołowe');
  expect(k.body).toContain('nieprzypisana');
  expect(k.body).toContain(ADRES_B);
  const m = await get('/magazyn/producenci');
  expect(m.body).toContain('nieprzypisana');
  expect(m.body).toContain(ADRES_MARKI);
});

it('menu Magazynu: na ekranie Allegro kategorii i marki bieżące są Kategorie albo Producenci, nie Produkty', async () => {
  for (const [url, biezacy] of [
    [ADRES_A, 'Kategorie'],
    [ADRES_MARKI, 'Producenci'],
  ]) {
    const { body } = await get(url);
    // Marki mieszkają w sekcji ekranu Producenci, więc tam prowadzi powrót z ekranu Allegro marki.
    if (url === ADRES_MARKI) expect(body).toContain('<a href="/magazyn/producenci#marki">← Producenci</a>');
    const lista = body.slice(body.indexOf('data-podmenu-lista="magazyn"')).split('</ul>')[0];
    for (const [href, etykieta] of [
      ['/magazyn', 'Produkty'],
      ['/magazyn/kategorie', 'Kategorie'],
      ['/magazyn/producenci', 'Producenci'],
    ]) {
      const a = lista.match(new RegExp(`<a href="${href}"([^>]*)>${etykieta}</a>`));
      expect(a, `${url} ${etykieta}`).not.toBeNull();
      expect(a[1].includes('aria-current="true"'), `${url} ${etykieta}`).toBe(etykieta === biezacy);
      expect(a[1]).not.toContain('aria-current="page"');
    }
  }
});

it('zmiana nazwy kategorii i marki przenosi mapowania Allegro', async () => {
  await post(ADRES_A, { srodowisko: 'produkcja', kategoria_id: '257' });
  await post(ADRES_MARKI, { srodowisko: 'produkcja', parametr_id: MARKA, wartosc_id: WARTOSC });
  db.prepare(
    `INSERT INTO allegro_marki_gpsr (marka, konto, zrodlo, producent_id, osoba_odpowiedzialna_id, zmieniono_at)
    VALUES ('Pracownia Półcień', 'allegro-polcien', 'wybrany', 'P-1', NULL, '2026-11-14T10:00:00Z')`,
  ).run();
  expect((await post('/magazyn/kategorie/zmien', { stara: 'Lampy stołowe', nowa: 'Lampki stołowe' })).statusCode).toBe(
    303,
  );
  expect((await post('/magazyn/marki/zmien', { stara: 'Pracownia Półcień', nowa: 'Półcień Studio' })).statusCode).toBe(
    303,
  );
  expect(mapa().map((w) => w.kategoria_karty)).toEqual(['Lampki stołowe']);
  expect(db.prepare('SELECT marka FROM allegro_marki').all()).toEqual([{ marka: 'Półcień Studio' }]);
  expect(db.prepare('SELECT marka FROM allegro_marki_gpsr').all()).toEqual([{ marka: 'Półcień Studio' }]);
});

it('odrzuca obcy CSRF i konto bez uprawnienia magazyn', async () => {
  const obcy = { ...auth, origin: 'https://obcy.example' };
  expect((await post(ADRES_A, { srodowisko: 'produkcja', kategoria_id: '257' }, obcy)).statusCode).toBe(403);
  expect(
    (await post(`${ADRES_A}/regula`, { srodowisko: 'produkcja', parametr_id: '224017', rodzaj: 'na_karcie' }, obcy))
      .statusCode,
  ).toBe(403);
  expect(
    (await post(ADRES_MARKI, { srodowisko: 'produkcja', parametr_id: MARKA, wartosc_id: WARTOSC }, obcy)).statusCode,
  ).toBe(403);
  zalozKonto(db, { login: 'admin', imie: 'Admin', haslo: 'test', rola: 'admin', admin: true });
  const user = zalozKonto(db, { login: 'fakturzystka', imie: 'Fakturzystka', haslo: 'test', rola: 'operator' });
  ustawUprawnienia(db, user, ['faktury']);
  const headers = {
    origin: 'http://localhost',
    cookie: `${NAZWA_CIASTECZKA_OMS}=${podpisz('fakturzystka', wczytajSekret(db), Date.now(), 0)}`,
  };
  expect((await get(ADRES_A, headers)).statusCode).toBe(403);
  expect((await post(ADRES_A, { srodowisko: 'produkcja', kategoria_id: '257' }, headers)).statusCode).toBe(403);
  expect(
    (await post(ADRES_MARKI, { srodowisko: 'produkcja', parametr_id: MARKA, wartosc_id: WARTOSC }, headers)).statusCode,
  ).toBe(403);
  expect(mapa()).toEqual([]);
  expect(db.prepare('SELECT COUNT(*) AS n FROM allegro_marki').get().n).toBe(0);
});

it('po zapisie marki, kategorii i reguły ekran pokazuje „Zapisano” z wiersza bazy, nie z zapytania', async () => {
  const adres = (r) => r.headers.location;
  const kat = await post(ADRES_A, { srodowisko: 'produkcja', kategoria_id: '257' });
  expect(adres(kat)).toContain('srodowisko=produkcja&ok=kategoria');
  const ekranKat = await get(adres(kat));
  expect(ekranKat.body).toMatch(
    /role="status">Zapisano\. Kategoria „Lampy stołowe” w Allegro \(produkcja\) to .*\(nr 257\)/,
  );
  expect((await get(`${ADRES_A}?srodowisko=produkcja`)).body).not.toContain('Zapisano.');

  const reg = await post(`${ADRES_A}/regula`, {
    srodowisko: 'produkcja',
    parametr_id: '224017',
    rodzaj: 'pole',
    pole: 'sku',
  });
  expect(adres(reg)).toMatch(/ok=regula#parametr-224017$/);
  expect((await get(adres(reg).replace(/#.*/, ''))).body).toContain('role="status">Zapisano regułę parametru.</p>');

  const mar = await post(ADRES_MARKI, { srodowisko: 'produkcja', parametr_id: MARKA, wartosc_id: WARTOSC });
  expect(adres(mar)).toContain('ok=marka');
  const ekranMarki = await get(adres(mar));
  expect(ekranMarki.body).toContain(
    'role="status">Zapisano. Marka „Pracownia Półcień” w Allegro (produkcja) to „Pracownia 001” (nr 248811_100001).</p>',
  );

  // Nieznany klucz i klucz bez zapisu w środowisku nie dają komunikatu; nic z zapytania nie trafia na ekran.
  expect((await get(`${ADRES_MARKI}?srodowisko=produkcja&ok=%3Cb%3Ecokolwiek`)).body).not.toContain('Zapisano.');
  expect((await get(`${ADRES_MARKI}?srodowisko=sandbox&ok=marka`)).body).not.toContain('Zapisano.');
  expect((await get(`${ADRES_B}?srodowisko=produkcja&ok=kategoria`)).body).not.toContain('Zapisano.');
});
