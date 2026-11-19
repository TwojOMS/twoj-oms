import { afterEach, expect, it } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { buildOmsServer } from '../../pomoc/serwer-testowy-oms.ts';
import { utworzKarte } from '../../../src/oms/db/magazyn.js';
import { zalozKonto, ustawUprawnienia } from '../../../src/core/bezpieczenstwo/konta.js';
import { podpisz, NAZWA_CIASTECZKA_OMS } from '../../../src/core/bezpieczenstwo/sesja.js';
import { wczytajSekret } from '../../../src/core/bezpieczenstwo/sekret-sesji.js';
import { dodajDoSlownika } from '../../../src/moduly/magazyn/services/slowniki-kart.js';
import {
  dodajProducenta,
  listaProducentow,
  producentPoId,
  przypiszMarki,
  przypisaniaMarek,
  ustawDomyslnego,
} from '../../../src/oms/db/producenci.js';

const POLCIEN = {
  nazwa: 'Pracownia Półcień',
  adres: 'ul. Przykładowa 1\n00-001 Miasto',
  email: 'kontakt@polcien.invalid',
  www: '',
};
const WARSZTAT = {
  nazwa: 'Warsztat Przykładowy',
  adres: 'ul. Zmyślona 2, 00-002 Miasto',
  email: '',
  www: 'warsztat.example',
};

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
// Powtórzone pola (marka, producent) — jak wysyła je przeglądarka.
const postForm = (url, body) =>
  app.inject({
    method: 'POST',
    url,
    headers: { ...auth, 'content-type': 'application/x-www-form-urlencoded' },
    payload: body,
  });
const ile = () => db.prepare('SELECT COUNT(*) AS n FROM producenci').get().n;
// Kontrolka formularza po id — cały znacznik otwierający, żeby sprawdzić jej atrybuty.
const kontrolka = (body, id) => body.match(new RegExp(`<(?:input|textarea|select)[^>]*\\bid="${id}"[^>]*>`))?.[0] ?? '';

it('lista: producenci z adresem, kontaktem, markami i oznaczeniem domyślnego; formularz z podpowiedziami autouzupełniania', async () => {
  panel();
  const p = dodajProducenta(db, POLCIEN).id;
  const w = dodajProducenta(db, WARSZTAT).id;
  for (const m of ['Półcień', 'Półcień Mini', 'Lampa']) dodajDoSlownika(db, 'marki', m);
  przypiszMarki(db, [
    { marka: 'Półcień', producentId: p },
    { marka: 'Półcień Mini', producentId: p },
  ]);
  ustawDomyslnego(db, w);
  const r = await get('/magazyn/producenci');
  expect(r.statusCode).toBe(200);
  expect(r.body).toContain('Pracownia Półcień');
  expect(r.body).toContain('ul. Przykładowa 1, 00-001 Miasto');
  expect(r.body).toContain('kontakt@polcien.invalid');
  expect(r.body).toContain('https://warsztat.example');
  expect(r.body).toMatch(/Pracownia Półcień[\s\S]*?Półcień, Półcień Mini/);
  expect(r.body).toMatch(/Warsztat Przykładowy[\s\S]*?domyślny/);
  expect(kontrolka(r.body, 'producent-nazwa')).toContain('autocomplete="organization"');
  const adres = r.body.match(/<textarea[^>]*\bid="producent-adres"[^>]*>/)?.[0] ?? '';
  expect(adres).toContain('autocomplete="street-address"');
  expect(kontrolka(r.body, 'producent-email')).toContain('type="email"');
  expect(kontrolka(r.body, 'producent-www')).toContain('type="url"');
  // Sekcja „Marki”: każda marka ze słownika z wyborem producenta.
  expect(r.body).toMatch(/name="marka" value="Lampa"/);
  expect(r.body).toMatch(new RegExp(`<option value="${p}" selected>Pracownia Półcień</option>`));
});

it('dodanie poprawnego producenta: 303 z ?ok=dodano, www dostaje https://', async () => {
  panel();
  const r = await post('/magazyn/producenci/dodaj', WARSZTAT);
  expect(r.statusCode).toBe(303);
  expect(r.headers.location).toBe('/magazyn/producenci?ok=dodano');
  expect(listaProducentow(db)).toMatchObject([
    {
      nazwa: 'Warsztat Przykładowy',
      adres: 'ul. Zmyślona 2, 00-002 Miasto',
      email: null,
      www: 'https://warsztat.example',
    },
  ]);
  expect((await get('/magazyn/producenci?ok=dodano')).body).toContain('Dodano producenta.');
});

it('bez adresu: 400, komunikat przy polu adresu, wpisane wartości zostają, nic się nie zapisuje', async () => {
  panel();
  const r = await post('/magazyn/producenci/dodaj', { ...POLCIEN, adres: '   ' });
  expect(r.statusCode).toBe(400);
  expect(ile()).toBe(0);
  expect(r.body).toContain('Podaj adres pocztowy producenta');
  const adres = r.body.match(/<textarea[^>]*\bid="producent-adres"[^>]*>/)?.[0] ?? '';
  expect(adres).toContain('aria-invalid="true"');
  expect(adres).toMatch(/aria-describedby="[^"]*producent-adres-blad/);
  expect(r.body).toMatch(/id="producent-adres-blad"[^>]*>Podaj adres pocztowy producenta</);
  expect(kontrolka(r.body, 'producent-nazwa')).toContain('value="Pracownia Półcień"');
  expect(kontrolka(r.body, 'producent-nazwa')).not.toContain('aria-invalid="true"');
  expect(kontrolka(r.body, 'producent-email')).toContain('value="kontakt@polcien.invalid"');
});

it('bez e-maila i www: 400 z komunikatem GPSR przy e-mailu', async () => {
  panel();
  const r = await post('/magazyn/producenci/dodaj', { ...POLCIEN, email: '', www: ' ' });
  expect(r.statusCode).toBe(400);
  expect(ile()).toBe(0);
  expect(r.body).toContain('Podaj e-mail albo stronę www producenta — przepisy GPSR wymagają adresu elektronicznego');
  expect(kontrolka(r.body, 'producent-email')).toContain('aria-invalid="true"');
  expect(kontrolka(r.body, 'producent-email')).toMatch(/aria-describedby="[^"]*producent-email-blad/);
  expect(r.body).toMatch(/<span class="uwaga" id="producent-email-blad">Podaj e-mail albo stronę www producenta/);
  expect(r.body).toContain('ul. Przykładowa 1\n00-001 Miasto</textarea>');
});

it('wpisy z „<script>” i „javascript:” wracają jako tekst — bez znacznika i bez odnośnika', async () => {
  panel();
  // E-mail i www przechodzą walidację, choć zawierają znaczniki — zapisują się surowo, widok musi je zabezpieczyć.
  const zly = {
    nazwa: '<script>alert(1)</script> Półcień',
    adres: 'ul. Przykładowa 1 <img src=x onerror=alert(2)>',
    email: '<script>alert(3)</script>@polcien.invalid',
    www: 'https://polcien.example/"><script>alert(4)</script>',
  };
  const dodane = await post('/magazyn/producenci/dodaj', zly);
  expect(dodane.statusCode).toBe(303);
  const p = listaProducentow(db)[0];
  expect(p.www).toBe(zly.www);
  dodajDoSlownika(db, 'marki', 'Lampa Półcień');
  przypiszMarki(db, [{ marka: 'Lampa Półcień', producentId: p.id }]);

  for (const url of ['/magazyn/producenci', `/magazyn/producenci?edytuj=${p.id}`, '/magazyn/marki']) {
    const r = await get(url);
    expect(r.statusCode).toBe(200);
    expect(r.body).not.toMatch(/<script>alert|<img src=x/);
    expect(r.body).not.toMatch(/href="(?!\/|#)[^"]*polcien/);
  }
  const lista = (await get('/magazyn/producenci')).body;
  expect(lista).toContain('&lt;script&gt;alert(1)&lt;/script&gt; Półcień');
  expect(lista).toContain('&lt;script&gt;alert(3)&lt;/script&gt;@polcien.invalid');

  // „javascript:” jako strona www: odmowa, a wpis wraca do pola jako wartość, nie jako odnośnik.
  const r = await post('/magazyn/producenci/dodaj', { ...POLCIEN, www: 'javascript:alert(5)' });
  expect(r.statusCode).toBe(400);
  expect(ile()).toBe(1);
  expect(kontrolka(r.body, 'producent-www')).toContain('value="javascript:alert(5)"');
  expect(r.body).not.toMatch(/href="javascript:/i);
});

it('edycja: formularz z danymi producenta, zapis, błąd walidacji zostaje na formularzu edycji, nieznany 404', async () => {
  panel();
  const p = dodajProducenta(db, POLCIEN).id;
  const formularz = await get(`/magazyn/producenci?edytuj=${p}`);
  expect(formularz.statusCode).toBe(200);
  expect(formularz.body).toContain(`action="/magazyn/producenci/${p}/zmien"`);
  expect(kontrolka(formularz.body, 'producent-nazwa')).toContain('value="Pracownia Półcień"');

  const r = await post(`/magazyn/producenci/${p}/zmien`, { ...POLCIEN, nazwa: 'Pracownia Półcień s.c.' });
  expect(r.statusCode).toBe(303);
  expect(r.headers.location).toBe('/magazyn/producenci?ok=zmieniono');
  expect(producentPoId(db, p).nazwa).toBe('Pracownia Półcień s.c.');

  const zly = await post(`/magazyn/producenci/${p}/zmien`, { ...POLCIEN, adres: '' });
  expect(zly.statusCode).toBe(400);
  expect(zly.body).toContain('Podaj adres pocztowy producenta');
  expect(zly.body).toContain(`action="/magazyn/producenci/${p}/zmien"`);
  expect(producentPoId(db, p).adres).toBe('ul. Przykładowa 1\n00-001 Miasto');

  expect((await post('/magazyn/producenci/999/zmien', POLCIEN)).statusCode).toBe(404);
  expect((await get('/magazyn/producenci?edytuj=999')).statusCode).toBe(404);
});

it('marki: przypisanie producenta i jego zdjęcie jednym „Zapisz przypisania”; Marki pokazują producenta', async () => {
  panel();
  const p = dodajProducenta(db, POLCIEN).id;
  for (const m of ['Półcień', 'Lampa']) dodajDoSlownika(db, 'marki', m);
  const r = await postForm(
    '/magazyn/producenci/marki',
    `marka=P%C3%B3%C5%82cie%C5%84&producent=${p}&marka=Lampa&producent=${p}`,
  );
  expect(r.statusCode).toBe(303);
  expect(r.headers.location).toBe('/magazyn/producenci?ok=marki#marki');
  expect(przypisaniaMarek(db)).toEqual(
    new Map([
      ['Lampa', p],
      ['Półcień', p],
    ]),
  );
  const marki = await get('/magazyn/marki');
  expect(marki.body).toContain('<th scope="col">Producent</th>');
  expect(marki.body).toMatch(new RegExp(`href="/magazyn/producenci#producent-${p}">Pracownia Półcień</a>`));

  // Pusty wybór zdejmuje przypisanie; jedna marka w formularzu to pojedyncze pola, nie tablica.
  expect((await post('/magazyn/producenci/marki', { marka: 'Lampa', producent: '' })).statusCode).toBe(303);
  expect(przypisaniaMarek(db)).toEqual(new Map([['Półcień', p]]));
  expect((await get('/magazyn/marki')).body).toMatch(/Lampa[\s\S]*?brak producenta/);

  const nieznany = await post('/magazyn/producenci/marki', { marka: 'Lampa', producent: '999' });
  expect(nieznany.statusCode).toBe(400);
  expect(nieznany.body).toContain('Nie ma takiego producenta.');
  const rozjechane = await postForm(
    '/magazyn/producenci/marki',
    `marka=Lampa&marka=P%C3%B3%C5%82cie%C5%84&producent=${p}`,
  );
  expect(rozjechane.statusCode).toBe(400);
  expect(przypisaniaMarek(db)).toEqual(new Map([['Półcień', p]]));
});

it('domyślny: wybór producenta i zdjęcie oznaczenia', async () => {
  panel();
  const p = dodajProducenta(db, POLCIEN).id;
  const w = dodajProducenta(db, WARSZTAT).id;
  expect((await post('/magazyn/producenci/domyslny', { producent: String(p) })).headers.location).toBe(
    '/magazyn/producenci?ok=domyslny',
  );
  expect(producentPoId(db, p).domyslny).toBe(true);
  await post('/magazyn/producenci/domyslny', { producent: String(w) });
  expect([producentPoId(db, p).domyslny, producentPoId(db, w).domyslny]).toEqual([false, true]);
  const strona = await get('/magazyn/producenci');
  expect(strona.body).toMatch(new RegExp(`<option value="${w}" selected>Warsztat Przykładowy</option>`));
  expect((await post('/magazyn/producenci/domyslny', { producent: '' })).statusCode).toBe(303);
  expect(producentPoId(db, w).domyslny).toBe(false);
  expect((await post('/magazyn/producenci/domyslny', { producent: '999' })).statusCode).toBe(400);
});

it('usunięcie: producent z markami — 409 z nazwami marek; bez marek — 303', async () => {
  panel();
  const p = dodajProducenta(db, POLCIEN).id;
  const w = dodajProducenta(db, WARSZTAT).id;
  for (const m of ['Półcień', 'Półcień Mini']) dodajDoSlownika(db, 'marki', m);
  przypiszMarki(db, [
    { marka: 'Półcień', producentId: p },
    { marka: 'Półcień Mini', producentId: p },
  ]);
  const odmowa = await post(`/magazyn/producenci/${p}/usun`, {});
  expect(odmowa.statusCode).toBe(409);
  expect(odmowa.body).toContain(
    'Nie można usunąć „Pracownia Półcień” — jest producentem marek: Półcień, Półcień Mini. Najpierw przypisz tym markom innego producenta.',
  );
  expect(ile()).toBe(2);
  const ok = await post(`/magazyn/producenci/${w}/usun`, {});
  expect(ok.statusCode).toBe(303);
  expect(ok.headers.location).toBe('/magazyn/producenci?ok=usunieto');
  expect(producentPoId(db, w)).toBeNull();
  expect((await post('/magazyn/producenci/999/usun', {})).statusCode).toBe(404);
});

it('uprawnienia jak Marki: konto bez Magazynu dostaje 403 na stronie i każdej akcji', async () => {
  panel();
  await app.ready();
  const p = dodajProducenta(db, POLCIEN).id;
  dodajDoSlownika(db, 'marki', 'Półcień');
  zalozKonto(db, { login: 'admin', imie: 'Admin', haslo: 'test', rola: 'admin', admin: true });
  const id = zalozKonto(db, { login: 'czytelnik', imie: 'Czytelnik', haslo: 'test', rola: 'operator' });
  ustawUprawnienia(db, id, []);
  const headers = {
    origin: 'http://localhost',
    cookie: `${NAZWA_CIASTECZKA_OMS}=${podpisz('czytelnik', wczytajSekret(db), Date.now(), 0)}`,
  };
  for (const url of ['/magazyn/marki', '/magazyn/producenci'])
    expect((await app.inject({ url, headers })).statusCode).toBe(403);
  for (const [url, payload] of [
    ['/magazyn/producenci/dodaj', WARSZTAT],
    [`/magazyn/producenci/${p}/zmien`, WARSZTAT],
    [`/magazyn/producenci/${p}/usun`, {}],
    ['/magazyn/producenci/domyslny', { producent: String(p) }],
    ['/magazyn/producenci/marki', { marka: 'Półcień', producent: String(p) }],
  ]) {
    expect((await app.inject({ method: 'POST', url, headers, payload })).statusCode, url).toBe(403);
  }
  expect(listaProducentow(db)).toMatchObject([{ nazwa: 'Pracownia Półcień', domyslny: false, marki: [] }]);
});

it('menu Magazynu: „Producenci” jest czwartą pozycją z aria-current na swojej stronie', async () => {
  panel();
  utworzKarte(db, { sku: 'L-1', nazwa: 'Lampa Półcień' });
  for (const [url, biezacy] of [
    ['/magazyn/producenci', 'Producenci'],
    ['/magazyn/producenci?edytuj=x', 'Producenci'],
    ['/magazyn/marki', 'Marki'],
  ]) {
    const { body } = await get(url);
    const lista = body.slice(body.indexOf('data-podmenu-lista="magazyn"')).split('</ul>')[0];
    const linki = [...lista.matchAll(/<a href="([^"]+)"([^>]*)>([^<]+)<\/a>/g)].map((m) => [m[1], m[3]]);
    expect(linki).toEqual([
      ['/magazyn', 'Produkty'],
      ['/magazyn/kategorie', 'Kategorie'],
      ['/magazyn/marki', 'Marki'],
      ['/magazyn/producenci', 'Producenci'],
    ]);
    const a = lista.match(/<a href="\/magazyn\/producenci"([^>]*)>/);
    expect(a[1].includes('aria-current="page"'), url).toBe(biezacy === 'Producenci');
  }
});
