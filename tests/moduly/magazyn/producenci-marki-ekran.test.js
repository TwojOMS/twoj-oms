// Magazyn → Producenci: jeden ekran producentów i marek. Marki nie mają już własnej strony — stary adres
// przekierowuje, a ich formularze (dodanie, zmiana nazwy, usunięcie, przypisanie producenta) żyją tutaj.
import { afterEach, expect, it } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { buildOmsServer } from '../../pomoc/serwer-testowy-oms.ts';
import { utworzKarte } from '../../../src/oms/db/magazyn.js';
import { dodajDoSlownika } from '../../../src/moduly/magazyn/services/slowniki-kart.js';
import { dodajProducenta, przypiszMarki, przypisaniaMarek } from '../../../src/oms/db/producenci.js';

const PRODUCENT = (nazwa) => ({
  nazwa,
  ulica: 'ul. Przykładowa 1',
  kod: '00-001',
  miasto: 'Miasto',
  kraj: 'PL',
  email: 'kontakt@polcien.invalid',
});

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

function panel() {
  db = openOmsDb(':memory:');
  app = buildOmsServer({ db, config: { auth: { user: 'operator', pass: 'atrapa' } }, magazyn: STAN });
  return app;
}
const get = (url) => app.inject({ url, headers: auth });
const post = (url, payload) => app.inject({ method: 'POST', url, headers: auth, payload });
const postForm = (url, body) =>
  app.inject({
    method: 'POST',
    url,
    headers: { ...auth, 'content-type': 'application/x-www-form-urlencoded' },
    payload: body,
  });
const kolumna = (sql, ...p) =>
  db
    .prepare(sql)
    .all(...p)
    .map((r) => Object.values(r)[0]);
const karta = (sku, pola = {}) => utworzKarte(db, { sku, nazwa: `Karta ${sku}`, ...pola });
// Znacznik otwierający elementu o danym id (cały, żeby sprawdzić atrybuty).
const znacznik = (body, id) => body.match(new RegExp(`<[a-z]+[^>]*\\bid="${id}"[^>]*>`))?.[0] ?? '';
const sekcjaMarek = (body) => body.slice(body.indexOf('id="marki"'));

/**
 * Wysyła formularz przypisań tak, jak przeglądarka: pola należą do niego atrybutem `form`, w kolejności dokumentu;
 * `wybor` podmienia wartość selecta danej marki (inaczej idzie opcja zaznaczona).
 */
function wyslijPrzypisania(body, wybor) {
  const pola = [...body.matchAll(/<input\b([^>]*)>|<select\b([^>]*)>([\s\S]*?)<\/select>/g)].filter((m) =>
    /\bform="marki-przypisania"/.test(m[1] ?? m[2]),
  );
  const pary = [];
  let marka = null;
  for (const [, wejscie, wybierz, opcje] of pola) {
    const atrybuty = wejscie ?? wybierz;
    const nazwa = atrybuty.match(/\bname="([^"]+)"/)?.[1];
    if (wejscie !== undefined) {
      marka = atrybuty.match(/\bvalue="([^"]*)"/)?.[1] ?? '';
      pary.push([nazwa, marka]);
    } else {
      const zaznaczona = opcje.match(/<option value="([^"]*)" selected>/)?.[1] ?? '';
      pary.push([nazwa, wybor[marka] ?? zaznaczona]);
    }
  }
  return postForm('/magazyn/producenci/marki', new URLSearchParams(pary).toString());
}

it('stary adres Marek przekierowuje na stałe do sekcji Marki ekranu Producenci', async () => {
  panel();
  const r = await get('/magazyn/marki');
  expect(r.statusCode).toBe(301);
  expect(r.headers.location).toBe('/magazyn/producenci#marki');
});

it('pod nagłówkiem dwa przyciski: „Dodaj producenta” i „Dodaj markę”; formularze zwinięte bez ?dodaj', async () => {
  panel();
  dodajProducenta(db, PRODUCENT('Pracownia Półcień'));
  const r = await get('/magazyn/producenci');
  expect(r.statusCode).toBe(200);
  expect(r.body).toContain('Producenci (GPSR) i marki kart produktów.');
  expect(r.body).toContain(
    '<a href="/magazyn/producenci?dodaj=producent#producent-formularz" class="btn btn--glowny">Dodaj producenta</a>',
  );
  expect(r.body).toContain('<a href="/magazyn/producenci?dodaj=marka#marka-formularz" class="btn">Dodaj markę</a>');
  expect(r.body).not.toContain('id="producent-formularz"');
  expect(r.body).not.toContain('id="marka-formularz"');
  // Kolejność sekcji: Producenci, Producent domyślny, Marki.
  expect(r.body.indexOf('id="producent-domyslny"')).toBeGreaterThan(r.body.indexOf('id="producent-poz-'));
  expect(r.body.indexOf('id="marki"')).toBeGreaterThan(r.body.indexOf('id="producent-domyslny"'));

  const producent = await get('/magazyn/producenci?dodaj=producent');
  expect(producent.body).toContain('id="producent-formularz"');
  expect(producent.body).toContain('action="/magazyn/producenci/dodaj"');
  expect(producent.body).toMatch(/<a href="\/magazyn\/producenci" class="btn">Anuluj<\/a>/);
  expect(producent.body).not.toContain('id="marka-formularz"');

  const marka = await get('/magazyn/producenci?dodaj=marka');
  expect(marka.body).not.toContain('id="producent-formularz"');
  expect(marka.body).toContain('id="marka-formularz"');
  expect(marka.body).toContain('action="/magazyn/marki/dodaj"');
  const pole = znacznik(marka.body, 'marka-nazwa');
  expect(pole).toContain('name="nazwa"');
  expect(pole).toContain('required');
  expect(pole).toContain('maxlength="200"');
  expect(marka.body).toMatch(/<select id="marka-producent" name="producent">\s*<option value="">— brak —<\/option>/);
  expect(marka.body).toMatch(/<a href="\/magazyn\/producenci#marki" class="btn">Anuluj<\/a>/);
  // Formularz marki stoi nad tabelą Marek.
  expect(marka.body.indexOf('id="marka-formularz"')).toBeLessThan(marka.body.indexOf('id="marki-tabela"'));
});

it('bez producentów formularz producenta jest rozwinięty, a kolumna Producent pokazuje „—”', async () => {
  panel();
  dodajDoSlownika(db, 'marki', 'Półcień');
  const r = await get('/magazyn/producenci');
  expect(r.body).toContain('id="producent-formularz"');
  const marki = sekcjaMarek(r.body);
  expect(marki).toContain('Dodaj producenta, żeby przypisać go markom.');
  expect(marki).not.toContain('form="marki-przypisania"');
  expect(marki).toMatch(/Półcień<\/th>[\s\S]*?<td>—<\/td>/);
});

it('„Dodaj markę” z producentem zapisuje słownik i przypisanie; bez producenta tylko słownik', async () => {
  panel();
  const p = dodajProducenta(db, PRODUCENT('Pracownia Półcień')).id;
  const z = await post('/magazyn/marki/dodaj', { nazwa: 'Półcień', producent: String(p) });
  expect(z.statusCode).toBe(303);
  expect(z.headers.location).toBe('/magazyn/producenci?ok=marka-dodana#marki');
  expect(kolumna('SELECT nazwa FROM marki')).toEqual(['Półcień']);
  expect(przypisaniaMarek(db)).toEqual(new Map([['Półcień', p]]));
  expect(sekcjaMarek((await get('/magazyn/producenci?ok=marka-dodana')).body)).toContain('Dodano markę.');

  const bez = await post('/magazyn/marki/dodaj', { nazwa: 'Lampa', producent: '' });
  expect(bez.statusCode).toBe(303);
  expect(kolumna('SELECT nazwa FROM marki ORDER BY nazwa')).toEqual(['Lampa', 'Półcień']);
  expect(przypisaniaMarek(db).has('Lampa')).toBe(false);
});

it('„Dodaj markę”: pusta nazwa — 400 z błędem przy polu; nieznany producent — 400 i nic się nie zapisuje', async () => {
  panel();
  const p = dodajProducenta(db, PRODUCENT('Pracownia Półcień')).id;
  const r = await post('/magazyn/marki/dodaj', { nazwa: '   ', producent: String(p) });
  expect(r.statusCode).toBe(400);
  expect(r.body).toContain('id="marka-formularz"');
  const pole = znacznik(r.body, 'marka-nazwa');
  expect(pole).toContain('aria-invalid="true"');
  expect(pole).toContain('aria-describedby="marka-nazwa-blad"');
  expect(r.body).toMatch(/<span class="uwaga" id="marka-nazwa-blad">Podaj nazwę marki\.<\/span>/);
  // Wybrany producent zostaje wybrany.
  expect(r.body).toMatch(new RegExp(`id="marka-producent"[\\s\\S]*?<option value="${p}" selected>`));

  const nieznany = await post('/magazyn/marki/dodaj', { nazwa: 'Lampa', producent: '999' });
  expect(nieznany.statusCode).toBe(400);
  expect(nieznany.body).toContain('id="marka-formularz"');
  expect(znacznik(nieznany.body, 'marka-nazwa')).toContain('value="Lampa"');
  expect(kolumna('SELECT COUNT(*) FROM marki')).toEqual([0]);
  expect(przypisaniaMarek(db).size).toBe(0);
});

it('Marki na ekranie Producenci: odnośnik marka=, „Bez marki”, zmiana nazwy przepisuje karty, usunięcie z kartami odmawia', async () => {
  panel();
  const a = karta('A1', { marka: 'Pracownia Półcień' });
  karta('A2');
  const r = await get('/magazyn/producenci');
  expect(r.statusCode).toBe(200);
  const marki = sekcjaMarek(r.body);
  expect(marki).toContain('href="/magazyn?marka=Pracownia%20P%C3%B3%C5%82cie%C5%84">1<');
  expect(marki).toContain('tylko na kartach');
  expect(marki).toMatch(/Bez marki[\s\S]*?href="\/magazyn\?brak=marka">1</);
  expect(marki).toContain('action="/magazyn/marki/zmien"');
  expect(marki).not.toContain('Pobierz z WooCommerce');

  expect((await post('/magazyn/marki/dodaj', { nazwa: 'Cienie' })).statusCode).toBe(303);
  const odmowa = await post('/magazyn/marki/usun', { nazwa: 'Pracownia Półcień' });
  expect(odmowa.statusCode).toBe(409);
  // Błąd stoi w sekcji Marki połączonego ekranu.
  expect(sekcjaMarek(odmowa.body)).toContain('Nie można usunąć „Pracownia Półcień” — ma 1 kartę.');
  expect(odmowa.body).toContain('id="producent-formularz"');

  const zmiana = await post('/magazyn/marki/zmien', { stara: 'Pracownia Półcień', nowa: 'Półcień' });
  expect(zmiana.statusCode).toBe(303);
  expect(zmiana.headers.location).toBe('/magazyn/producenci?ok=marka-zmieniona#marki');
  expect(kolumna('SELECT marka FROM karty_produktow WHERE id = ?', a)).toEqual(['Półcień']);
  expect(kolumna('SELECT nazwa FROM marki ORDER BY nazwa')).toEqual(['Cienie', 'Półcień']);

  const pusta = await post('/magazyn/marki/zmien', { stara: 'Półcień', nowa: ' ' });
  expect(pusta.statusCode).toBe(400);
  expect(sekcjaMarek(pusta.body)).toContain('role="alert"');

  const usun = await post('/magazyn/marki/usun', { nazwa: 'Cienie' });
  expect(usun.statusCode).toBe(303);
  expect(usun.headers.location).toBe('/magazyn/producenci?ok=marka-usunieta#marki');
  expect(kolumna('SELECT nazwa FROM marki')).toEqual(['Półcień']);
});

it('selecty producentów należą do formularza „marki-przypisania”, a zapis przypisań działa jak dawniej', async () => {
  panel();
  const p = dodajProducenta(db, PRODUCENT('Pracownia Półcień')).id;
  const w = dodajProducenta(db, PRODUCENT('Warsztat Przykładowy')).id;
  for (const m of ['Półcień', 'Lampa']) dodajDoSlownika(db, 'marki', m);
  przypiszMarki(db, [{ marka: 'Lampa', producentId: w }]);
  const { body } = await get('/magazyn/producenci');
  // Jeden formularz pod tabelą; formularze w wierszach (zmiana nazwy) nie są w nim zagnieżdżone.
  expect(body).toMatch(/<form id="marki-przypisania" method="post" action="\/magazyn\/producenci\/marki"/);
  expect(body.indexOf('<form id="marki-przypisania"')).toBeGreaterThan(body.indexOf('id="marki-tabela"'));
  const selecty = [...sekcjaMarek(body).matchAll(/<select\b[^>]*\bname="producent"[^>]*>/g)].map((m) => m[0]);
  expect(selecty).toHaveLength(2);
  for (const s of selecty) expect(s).toContain('form="marki-przypisania"');

  const r = await wyslijPrzypisania(body, { Półcień: String(p), Lampa: '' });
  expect(r.statusCode).toBe(303);
  expect(r.headers.location).toBe('/magazyn/producenci?ok=marki#marki');
  expect(przypisaniaMarek(db)).toEqual(new Map([['Półcień', p]]));
});

it('kolumna Allegro na ekranie Producenci prowadzi do mapowania marki', async () => {
  panel();
  dodajDoSlownika(db, 'marki', 'Półcień');
  dodajDoSlownika(db, 'marki', 'Lampa');
  db.prepare(
    `INSERT INTO allegro_marki (marka, srodowisko, parametr_id, wartosc_id, wartosc_tekst, zmieniono_at)
     VALUES ('Półcień', 'produkcja', '248811', '248811_1', 'Półcień Allegro', '2026-11-14T10:00:00Z')`,
  ).run();
  const marki = sekcjaMarek((await get('/magazyn/producenci')).body);
  expect(marki).toContain('<th scope="col">Allegro</th>');
  expect(marki).toContain('Półcień Allegro');
  expect(marki).toContain('nieprzypisana');
  expect(marki).toContain(`href="/magazyn/marki/${encodeURIComponent('Lampa')}/allegro"`);
  expect(marki).toMatch(/Bez marki<\/th>\s*<td class="liczba">0<\/td>/);
});
