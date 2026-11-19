import { afterEach, expect, it } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { buildOmsServer } from '../../pomoc/serwer-testowy-oms.ts';
import { utworzKarte } from '../../../src/oms/db/magazyn.js';
import { zalozKonto, ustawUprawnienia } from '../../../src/core/bezpieczenstwo/konta.js';
import { podpisz, NAZWA_CIASTECZKA_OMS } from '../../../src/core/bezpieczenstwo/sesja.js';
import { wczytajSekret } from '../../../src/core/bezpieczenstwo/sekret-sesji.js';
import { dodajDoSlownika, usunZeSlownika, zmienNazwe } from '../../../src/moduly/magazyn/services/slowniki-kart.js';
import { dodajProducenta, przypiszMarki, przypisaniaMarek, usunProducenta } from '../../../src/oms/db/producenci.js';

const PRODUCENT = (nazwa) => ({ nazwa, adres: 'ul. Przykładowa 1, 00-001 Miasto', email: 'kontakt@polcien.invalid' });

const auth = {
  authorization: `Basic ${Buffer.from('operator:atrapa').toString('base64')}`,
  origin: 'http://localhost',
};
const STAN = {
  stan: () => ({ trwa: false, zaczety_at: null, skonczony_at: null, postep: null, kanaly: [], blad: null }),
};
let db, app;
afterEach(async () => {
  await app?.close();
  db?.close();
  app = db = null;
});

function panel({ sklepy, definicje } = {}) {
  db = openOmsDb(':memory:');
  const config = { auth: { user: 'operator', pass: 'atrapa' } };
  if (definicje) config.definicje = definicje;
  app = buildOmsServer({ db, config, magazyn: STAN, ...(sklepy ? { sklepy } : {}) });
  return app;
}
const get = (url) => app.inject({ url, headers: auth });
const post = (url, payload) => app.inject({ method: 'POST', url, headers: auth, payload });
const kolumna = (sql, ...p) =>
  db
    .prepare(sql)
    .all(...p)
    .map((r) => Object.values(r)[0]);
const karta = (sku, pola = {}) => utworzKarte(db, { sku, nazwa: `Karta ${sku}`, ...pola });

it('Kategorie: lista płaska z liczbą kart jako odnośnikiem do filtra i wierszem „bez kategorii”', async () => {
  panel();
  karta('A1', { kategoria_glowna: 'Ramki & Passe-partout' });
  karta('A2', { kategoria_glowna: 'Ramki & Passe-partout' });
  karta('A3');
  db.prepare("INSERT INTO kategorie_kart (nazwa, utworzona_at) VALUES ('Szablony', '2026-11-13T10:00:00Z')").run();
  const r = await get('/magazyn/kategorie');
  expect(r.statusCode).toBe(200);
  expect(r.body).toContain('Ramki &amp; Passe-partout');
  expect(r.body).toContain('href="/magazyn?kategoria=Ramki%20%26%20Passe-partout">2<');
  expect(r.body).toContain('Szablony');
  expect(r.body).toMatch(/Bez kategorii[\s\S]*?href="\/magazyn\?brak=kategoria">1</);
  // Usuń widać tylko przy kategorii bez kart.
  expect(r.body).toContain('name="nazwa" value="Szablony"');
});

it('Kategorie: dodanie, odmowa pustej nazwy i brak dubli', async () => {
  panel();
  expect((await post('/magazyn/kategorie/dodaj', { nazwa: '  Lampy  ' })).statusCode).toBe(303);
  expect((await post('/magazyn/kategorie/dodaj', { nazwa: 'Lampy' })).statusCode).toBe(303);
  expect(kolumna('SELECT nazwa FROM kategorie_kart')).toEqual(['Lampy']);
  const pusta = await post('/magazyn/kategorie/dodaj', { nazwa: '   ' });
  expect(pusta.statusCode).toBe(400);
  expect(pusta.body).toContain('Podaj nazwę');
});

it('Kategorie: zmiana nazwy przepisuje karty w jednej transakcji i oznacza je jako ręczne', async () => {
  panel();
  const [a, b, c] = [
    karta('A1', { kategoria_glowna: 'Lampy' }),
    karta('A2', { kategoria_glowna: 'Lampy' }),
    karta('A3', { kategoria_glowna: 'Ramki' }),
  ];
  db.prepare("INSERT INTO kategorie_kart (nazwa, utworzona_at) VALUES ('Lampy', 'x')").run();
  const r = await post('/magazyn/kategorie/zmien', { stara: 'Lampy', nowa: 'Lampy stołowe' });
  expect(r.statusCode).toBe(303);
  expect(kolumna('SELECT kategoria_glowna FROM karty_produktow WHERE id IN (?, ?, ?) ORDER BY id', a, b, c)).toEqual([
    'Lampy stołowe',
    'Lampy stołowe',
    'Ramki',
  ]);
  expect(kolumna('SELECT nazwa FROM kategorie_kart ORDER BY nazwa')).toEqual(['Lampy stołowe']);
  expect(
    kolumna(
      "SELECT reczne FROM karty_zrodla_pol WHERE pole = 'kategoria_glowna' AND karta_id IN (?, ?) ORDER BY karta_id",
      a,
      b,
    ),
  ).toEqual([1, 1]);
  // Zmiana na nazwę już istniejącą scala obie kategorie.
  expect((await post('/magazyn/kategorie/zmien', { stara: 'Ramki', nowa: 'Lampy stołowe' })).statusCode).toBe(303);
  expect(kolumna('SELECT DISTINCT kategoria_glowna FROM karty_produktow')).toEqual(['Lampy stołowe']);
  expect((await post('/magazyn/kategorie/zmien', { stara: 'Lampy stołowe', nowa: '  ' })).statusCode).toBe(400);
});

it('Kategorie: usunięcie odmawia przy kartach, a bez kart usuwa', async () => {
  panel();
  karta('A1', { kategoria_glowna: 'Lampy' });
  for (const n of ['Lampy', 'Puste'])
    db.prepare("INSERT INTO kategorie_kart (nazwa, utworzona_at) VALUES (?, 'x')").run(n);
  const odmowa = await post('/magazyn/kategorie/usun', { nazwa: 'Lampy' });
  expect(odmowa.statusCode).toBe(409);
  expect(odmowa.body).toContain('ma 1 kart');
  expect(kolumna('SELECT nazwa FROM kategorie_kart ORDER BY nazwa')).toEqual(['Lampy', 'Puste']);
  expect((await post('/magazyn/kategorie/usun', { nazwa: 'Puste' })).statusCode).toBe(303);
  expect(kolumna('SELECT nazwa FROM kategorie_kart')).toEqual(['Lampy']);
});

it('Marki: lista z odnośnikiem marka=, dodanie, zmiana nazwy przepisuje karty, usunięcie z kartami odmawia', async () => {
  panel();
  const a = karta('A1', { marka: 'Pracownia Półcień' });
  karta('A2');
  let r = await get('/magazyn/marki');
  expect(r.statusCode).toBe(200);
  expect(r.body).toContain('href="/magazyn?marka=Pracownia%20P%C3%B3%C5%82cie%C5%84">1<');
  expect(r.body).toMatch(/Bez marki[\s\S]*?href="\/magazyn\?brak=marka">1</);
  expect(r.body).not.toContain('Pobierz z WooCommerce');
  expect((await post('/magazyn/marki/dodaj', { nazwa: 'Cienie' })).statusCode).toBe(303);
  expect((await post('/magazyn/marki/usun', { nazwa: 'Pracownia Półcień' })).statusCode).toBe(409);
  expect((await post('/magazyn/marki/zmien', { stara: 'Pracownia Półcień', nowa: 'Półcień' })).statusCode).toBe(303);
  expect(kolumna('SELECT marka FROM karty_produktow WHERE id = ?', a)).toEqual(['Półcień']);
  expect(kolumna('SELECT nazwa FROM marki ORDER BY nazwa')).toEqual(['Cienie', 'Półcień']);
  expect((await post('/magazyn/marki/usun', { nazwa: 'Cienie' })).statusCode).toBe(303);
  expect(kolumna('SELECT nazwa FROM marki')).toEqual(['Półcień']);
});

const kategoriaWoo = (id, name, count, parent = 0) => ({ id, name, slug: `k-${id}`, parent, count });
const klientWoo = (lista) => ({
  wywolania: 0,
  async pobierzKategorieProduktow() {
    this.wywolania += 1;
    return lista;
  },
});

it('Pobierz z WooCommerce: dwa sklepy z tą samą nazwą → 1 wpis słownika i 2 źródła; ponowne pobranie bez dubli', async () => {
  const pro = klientWoo([
    kategoriaWoo(7, 'Ramki &amp;amp; Passe-partout', 3),
    kategoriaWoo(8, 'Puste', 0),
    kategoriaWoo(9, 'Lampy', 2, 7),
  ]);
  const sw = klientWoo([kategoriaWoo(41, 'Ramki &amp; Passe-partout', 1)]);
  panel({ sklepy: { pro, swietlik: sw } });
  const strona = await get('/magazyn/kategorie');
  expect(strona.body.match(/Pobierz z WooCommerce/g)).toHaveLength(2);
  expect(strona.body).toContain('name="kanal" value="pro"');
  expect(strona.body).toContain('name="kanal" value="swietlik"');

  let r = await post('/magazyn/kategorie/pobierz-woo', { kanal: 'pro' });
  expect(r.statusCode).toBe(303);
  expect((await get(r.headers.location)).body).toContain('dodano 2, było już 0');
  r = await post('/magazyn/kategorie/pobierz-woo', { kanal: 'swietlik' });
  expect((await get(r.headers.location)).body).toContain('dodano 0, było już 1');
  r = await post('/magazyn/kategorie/pobierz-woo', { kanal: 'pro' });
  expect((await get(r.headers.location)).body).toContain('dodano 0, było już 2');

  expect(kolumna('SELECT nazwa FROM kategorie_kart ORDER BY nazwa')).toEqual(['Lampy', 'Ramki & Passe-partout']);
  expect(
    db
      .prepare('SELECT nazwa, kanal, id_zewnetrzne, rodzic_id FROM kategorie_kart_kanaly ORDER BY kanal, id_zewnetrzne')
      .all(),
  ).toEqual([
    { nazwa: 'Ramki & Passe-partout', kanal: 'pro', id_zewnetrzne: '7', rodzic_id: null },
    { nazwa: 'Lampy', kanal: 'pro', id_zewnetrzne: '9', rodzic_id: '7' },
    { nazwa: 'Ramki & Passe-partout', kanal: 'swietlik', id_zewnetrzne: '41', rodzic_id: null },
  ]);
  const lista = await get('/magazyn/kategorie');
  expect(lista.body).toMatch(/Ramki &amp; Passe-partout[\s\S]{0,200}class="slownik-plakietka[^"]*"[^>]*>W</);
  expect(lista.body).not.toContain('Puste');
});

it('Pobierz z WooCommerce: istniejących nie zmienia, nieznany kanał i błąd sklepu to czytelna odmowa', async () => {
  const pro = klientWoo([kategoriaWoo(7, 'Lampy', 3)]);
  const zepsuty = {
    async pobierzKategorieProduktow() {
      throw new Error('HTTP 500 ck=sekret');
    },
  };
  panel({ sklepy: { pro, swietlik: zepsuty } });
  db.prepare("INSERT INTO kategorie_kart (nazwa, utworzona_at) VALUES ('Lampy', '2026-01-01T00:00:00Z')").run();
  const r = await post('/magazyn/kategorie/pobierz-woo', { kanal: 'pro' });
  expect((await get(r.headers.location)).body).toContain('dodano 0, było już 1');
  expect(kolumna("SELECT utworzona_at FROM kategorie_kart WHERE nazwa = 'Lampy'")).toEqual(['2026-01-01T00:00:00Z']);
  expect((await post('/magazyn/kategorie/pobierz-woo', { kanal: 'allegro_swietlik' })).statusCode).toBe(400);
  const blad = await post('/magazyn/kategorie/pobierz-woo', { kanal: 'swietlik' });
  expect(blad.statusCode).toBe(502);
  expect(blad.body).toContain('Nie udało się pobrać kategorii');
  expect(blad.body).not.toContain('sekret');
});

it('sprzedawca bez WooCommerce: Kategorie działają ręcznie i nie ma przycisku pobierania', async () => {
  panel({
    definicje: [{ klucz: 'allegro_polcien', typ: 'allegro', prefiks: 'ALLEGRO_POLCIEN', etykieta: 'Allegro Półcień' }],
    sklepy: {},
  });
  const r = await get('/magazyn/kategorie');
  expect(r.statusCode).toBe(200);
  expect(r.body).not.toContain('Pobierz z WooCommerce');
  expect((await post('/magazyn/kategorie/dodaj', { nazwa: 'Lampy' })).statusCode).toBe(303);
  expect((await post('/magazyn/kategorie/pobierz-woo', { kanal: 'allegro_polcien' })).statusCode).toBe(400);
});

it('uprawnienia jak edycja karty: konto bez Magazynu dostaje 403 na stronach i akcjach słowników', async () => {
  panel();
  await app.ready();
  zalozKonto(db, { login: 'admin', imie: 'Admin', haslo: 'test', rola: 'admin', admin: true });
  const id = zalozKonto(db, { login: 'czytelnik', imie: 'Czytelnik', haslo: 'test', rola: 'operator' });
  ustawUprawnienia(db, id, []);
  const headers = {
    origin: 'http://localhost',
    cookie: `${NAZWA_CIASTECZKA_OMS}=${podpisz('czytelnik', wczytajSekret(db), Date.now(), 0)}`,
  };
  for (const url of ['/magazyn/kategorie', '/magazyn/marki'])
    expect((await app.inject({ url, headers })).statusCode).toBe(403);
  for (const url of ['/magazyn/kategorie/dodaj', '/magazyn/marki/dodaj']) {
    expect((await app.inject({ method: 'POST', url, headers, payload: { nazwa: 'X' } })).statusCode).toBe(403);
  }
  expect(kolumna('SELECT COUNT(*) FROM kategorie_kart UNION ALL SELECT COUNT(*) FROM marki')).toEqual([0, 0]);
});

it('menu Magazynu: Kategorie i Marki są odnośnikami z aria-current na swojej stronie', async () => {
  panel();
  for (const [url, biezacy] of [
    ['/magazyn/kategorie', 'Kategorie'],
    ['/magazyn/marki', 'Marki'],
  ]) {
    const { body } = await get(url);
    const lista = body.slice(body.indexOf('data-podmenu-lista="magazyn"')).split('</ul>')[0];
    for (const [href, etykieta] of [
      ['/magazyn', 'Produkty'],
      ['/magazyn/kategorie', 'Kategorie'],
      ['/magazyn/marki', 'Marki'],
    ]) {
      const a = lista.match(new RegExp(`<a href="${href}"([^>]*)>${etykieta}</a>`));
      expect(a, `${url} ${etykieta}`).not.toBeNull();
      expect(a[1].includes('aria-current="page"')).toBe(etykieta === biezacy);
    }
    expect(lista).not.toContain('wkrótce');
  }
});

it('Marki: zmiana nazwy zachowuje producenta, przy scaleniu zostaje producent marki docelowej', async () => {
  db = openOmsDb(':memory:');
  const p = dodajProducenta(db, PRODUCENT('Pracownia Półcień')).id;
  const w = dodajProducenta(db, PRODUCENT('Warsztat Przykładowy')).id;
  for (const m of ['Półcień', 'Półcień Mini', 'Lampa']) dodajDoSlownika(db, 'marki', m);
  przypiszMarki(db, [
    { marka: 'Półcień', producentId: p },
    { marka: 'Półcień Mini', producentId: p },
    { marka: 'Lampa', producentId: w },
  ]);
  expect(zmienNazwe(db, 'marki', 'Półcień', 'Półcień Studio')).toEqual({ karty: 0 });
  expect(przypisaniaMarek(db).get('Półcień Studio')).toBe(p);
  expect(przypisaniaMarek(db).has('Półcień')).toBe(false);

  zmienNazwe(db, 'marki', 'Półcień Mini', 'Lampa');
  expect(przypisaniaMarek(db)).toEqual(
    new Map([
      ['Lampa', w],
      ['Półcień Studio', p],
    ]),
  );
});

it('Marki: usunięcie marki ze słownika zdejmuje jej producenta', async () => {
  db = openOmsDb(':memory:');
  const p = dodajProducenta(db, PRODUCENT('Pracownia Półcień')).id;
  dodajDoSlownika(db, 'marki', 'Półcień');
  przypiszMarki(db, [{ marka: 'Półcień', producentId: p }]);
  expect(usunZeSlownika(db, 'marki', 'Półcień')).toEqual({ karty: 0 });
  expect(przypisaniaMarek(db).size).toBe(0);
  expect(usunProducenta(db, p)).toEqual({ ok: true });
});
