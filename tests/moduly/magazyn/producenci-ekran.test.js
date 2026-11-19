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
  ulica: 'ul. Przykładowa 1',
  kod: '00-001',
  miasto: 'Miasto',
  kraj: 'PL',
  email: 'kontakt@polcien.invalid',
  www: '',
};
const WARSZTAT = {
  nazwa: 'Warsztat Przykładowy',
  ulica: 'ul. Zmyślona 2',
  kod: '00-002',
  miasto: 'Miasto',
  kraj: 'PL',
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
// Producent sprzed adresu w polach: adres jednym tekstem, pola puste (jak po migracji na produkcji).
const stary = (adres = 'ul. Zmyślona 19, 00-950 Przykładowo') =>
  Number(
    db
      .prepare(
        `INSERT INTO producenci (nazwa, adres, email, domyslny, utworzono_at, zmieniono_at)
         VALUES ('Pracownia Półcień', ?, 'kontakt@polcien.invalid', 1, ?, ?)
         RETURNING id`,
      )
      .get(adres, '2026-11-18T10:00:00.000Z', '2026-11-18T10:00:00.000Z').id,
  );
// Wybrana opcja listy krajów (wartość) albo null.
const wybranyKraj = (body) =>
  body
    .match(/<select[^>]*\bid="producent-kraj"[\s\S]*?<\/select>/)?.[0]
    .match(/<option value="(\w+)" selected>/)?.[1] ?? null;
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
  expect(r.body).toContain('ul. Przykładowa 1, 00-001 Miasto, Polska');
  expect(r.body).toContain('kontakt@polcien.invalid');
  expect(r.body).toContain('https://warsztat.example');
  expect(r.body).toMatch(/Pracownia Półcień[\s\S]*?Półcień, Półcień Mini/);
  expect(r.body).toMatch(/Warsztat Przykładowy[\s\S]*?domyślny/);
  // Formularz producenta jest zwinięty, gdy producenci już są — rozwija go „Dodaj producenta” (?dodaj=producent).
  const formularz = (await get('/magazyn/producenci?dodaj=producent')).body;
  expect(kontrolka(formularz, 'producent-nazwa')).toContain('autocomplete="organization"');
  // Adres pocztowy to grupa czterech pól z podpowiedziami autouzupełniania, a nie jedno pole tekstowe.
  expect(formularz).toMatch(/<fieldset class="pole-szerokie">\s*<legend>Adres pocztowy<\/legend>/);
  expect(formularz).not.toMatch(/<textarea[^>]*name="adres"/);
  for (const [id, name, autocomplete] of [
    ['producent-ulica', 'ulica', 'address-line1'],
    ['producent-kod', 'kod', 'postal-code'],
    ['producent-miasto', 'miasto', 'address-level2'],
    ['producent-kraj', 'kraj', 'country'],
  ]) {
    const k = kontrolka(formularz, id);
    expect(k, id).toContain(`name="${name}"`);
    expect(k, id).toContain(`autocomplete="${autocomplete}"`);
    expect(k, id).toContain('required');
    expect(formularz, id).toMatch(new RegExp(`<label for="${id}">`));
  }
  expect(kontrolka(formularz, 'producent-kraj')).toMatch(/^<select/);
  expect(wybranyKraj(formularz)).toBe('PL');
  // Polska na górze, potem UE, a kraje spoza UE w osobnej grupie.
  const kraje = formularz.match(/<select[^>]*\bid="producent-kraj"[\s\S]*?<\/select>/)?.[0] ?? '';
  expect(kraje).toMatch(/^<select[^>]*>\s*<option value="PL" selected>Polska<\/option>\s*<option value="AT">Austria</);
  expect(kraje).toMatch(/<optgroup label="Spoza UE">\s*<option value="CN">Chiny<\/option>/);
  expect(kraje).not.toMatch(/<optgroup label="Spoza UE">[\s\S]*value="DE"/);
  expect(kraje).toContain('<option value="GB">Wielka Brytania</option>');
  expect(kontrolka(formularz, 'producent-email')).toContain('type="email"');
  // Pole www nie jest type="url": przeglądarka blokowała adres bez https://, a serwer go uzupełnia.
  const www = kontrolka(formularz, 'producent-www');
  expect(www).toContain('type="text"');
  expect(www).toContain('inputmode="url"');
  expect(www).not.toContain('type="url"');
  expect(www).toMatch(/aria-describedby="producent-kontakt-podpowiedz producent-www-podpowiedz"/);
  expect(formularz).toContain(
    '<span class="podpowiedz" id="producent-www-podpowiedz">np. pracownia-polcien.pl — https:// dopiszemy sami</span>',
  );
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
      adres: 'ul. Zmyślona 2\n00-002 Miasto\nPolska',
      ulica: 'ul. Zmyślona 2',
      kod_pocztowy: '00-002',
      miasto: 'Miasto',
      kraj: 'PL',
      email: null,
      www: 'https://warsztat.example',
    },
  ]);
  expect((await get('/magazyn/producenci?ok=dodano')).body).toContain('Dodano producenta.');
});

it('adres www bez schematu: zapis z https://', async () => {
  panel();
  const r = await post('/magazyn/producenci/dodaj', { ...WARSZTAT, www: 'pracownia-polcien.pl' });
  expect(r.statusCode).toBe(303);
  expect(listaProducentow(db)[0].www).toBe('https://pracownia-polcien.pl');
});

it('bez ulicy: 400, komunikat przy polu ulicy, wpisane wartości zostają, nic się nie zapisuje', async () => {
  panel();
  const r = await post('/magazyn/producenci/dodaj', { ...POLCIEN, ulica: '   ' });
  expect(r.statusCode).toBe(400);
  expect(ile()).toBe(0);
  const ulica = kontrolka(r.body, 'producent-ulica');
  expect(ulica).toContain('aria-invalid="true"');
  expect(ulica).toMatch(/aria-describedby="[^"]*producent-ulica-blad/);
  expect(ulica).toContain('autofocus');
  expect(r.body).toMatch(/id="producent-ulica-blad"[^>]*>Podaj ulicę i numer</);
  expect(kontrolka(r.body, 'producent-kod')).toContain('value="00-001"');
  expect(kontrolka(r.body, 'producent-miasto')).toContain('value="Miasto"');
  expect(kontrolka(r.body, 'producent-kod')).not.toContain('aria-invalid');
  expect(kontrolka(r.body, 'producent-nazwa')).toContain('value="Pracownia Półcień"');
  expect(kontrolka(r.body, 'producent-nazwa')).not.toContain('aria-invalid="true"');
  expect(kontrolka(r.body, 'producent-email')).toContain('value="kontakt@polcien.invalid"');
});

it('zły kod pocztowy: 400, komunikat przy kodzie według kraju, wpisane wartości i kraj zostają', async () => {
  panel();
  const pl = await post('/magazyn/producenci/dodaj', { ...POLCIEN, kod: '0095' });
  expect(pl.statusCode).toBe(400);
  expect(ile()).toBe(0);
  const kod = kontrolka(pl.body, 'producent-kod');
  expect(kod).toContain('value="0095"');
  expect(kod).toContain('aria-invalid="true"');
  expect(kod).toContain('autofocus');
  expect(pl.body).toMatch(/id="producent-kod-blad"[^>]*>Kod pocztowy w Polsce ma postać 00-000</);
  expect(kontrolka(pl.body, 'producent-ulica')).toContain('value="ul. Przykładowa 1"');
  expect(kontrolka(pl.body, 'producent-ulica')).not.toContain('autofocus');
  expect(kontrolka(pl.body, 'producent-miasto')).toContain('value="Miasto"');
  expect(wybranyKraj(pl.body)).toBe('PL');

  const de = await post('/magazyn/producenci/dodaj', { ...POLCIEN, kraj: 'DE', kod: '10115!', miasto: 'Berlin' });
  expect(de.statusCode).toBe(400);
  expect(de.body).toContain('Kod pocztowy może mieć tylko litery, cyfry, spację i kreskę');
  expect(kontrolka(de.body, 'producent-kod')).toContain('value="10115!"');
  expect(wybranyKraj(de.body)).toBe('DE');

  const xx = await post('/magazyn/producenci/dodaj', { ...POLCIEN, kraj: 'XX' });
  expect(xx.statusCode).toBe(400);
  expect(ile()).toBe(0);
  expect(kontrolka(xx.body, 'producent-kraj')).toContain('aria-invalid="true"');
  expect(xx.body).toMatch(/id="producent-kraj-blad"[^>]*>Wybierz kraj z listy</);

  const ok = await post('/magazyn/producenci/dodaj', { ...POLCIEN, kraj: 'DE', kod: '10115', miasto: 'Berlin' });
  expect(ok.statusCode).toBe(303);
  expect(listaProducentow(db)[0]).toMatchObject({ kraj: 'DE', adres: 'ul. Przykładowa 1\n10115 Berlin\nNiemcy' });
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
  expect(kontrolka(r.body, 'producent-ulica')).toContain('value="ul. Przykładowa 1"');
});

it('wpisy z „<script>” i „javascript:” wracają jako tekst — bez znacznika i bez odnośnika', async () => {
  panel();
  // E-mail i www przechodzą walidację, choć zawierają znaczniki — zapisują się surowo, widok musi je zabezpieczyć.
  const zly = {
    nazwa: '<script>alert(1)</script> Półcień',
    ulica: 'ul. Przykładowa 1 <img src=x onerror=alert(2)>',
    kod: '00-001',
    miasto: '<script>alert(6)</script>',
    kraj: 'PL',
    email: '<script>alert(3)</script>@polcien.invalid',
    www: 'https://polcien.example/"><script>alert(4)</script>',
  };
  const dodane = await post('/magazyn/producenci/dodaj', zly);
  expect(dodane.statusCode).toBe(303);
  const p = listaProducentow(db)[0];
  expect(p.www).toBe(zly.www);
  dodajDoSlownika(db, 'marki', 'Lampa Półcień');
  przypiszMarki(db, [{ marka: 'Lampa Półcień', producentId: p.id }]);

  for (const url of ['/magazyn/producenci', `/magazyn/producenci?edytuj=${p.id}`, '/magazyn/producenci?dodaj=marka']) {
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
  expect(kontrolka(formularz.body, 'producent-ulica')).toContain('value="ul. Przykładowa 1"');
  expect(kontrolka(formularz.body, 'producent-kod')).toContain('value="00-001"');
  expect(kontrolka(formularz.body, 'producent-miasto')).toContain('value="Miasto"');
  expect(wybranyKraj(formularz.body)).toBe('PL');
  expect(formularz.body).not.toContain('Dotychczasowy adres');

  const r = await post(`/magazyn/producenci/${p}/zmien`, { ...POLCIEN, nazwa: 'Pracownia Półcień s.c.' });
  expect(r.statusCode).toBe(303);
  expect(r.headers.location).toBe('/magazyn/producenci?ok=zmieniono');
  expect(producentPoId(db, p).nazwa).toBe('Pracownia Półcień s.c.');

  const zly = await post(`/magazyn/producenci/${p}/zmien`, { ...POLCIEN, ulica: '' });
  expect(zly.statusCode).toBe(400);
  expect(zly.body).toContain('Podaj ulicę i numer');
  expect(zly.body).toContain(`action="/magazyn/producenci/${p}/zmien"`);
  expect(producentPoId(db, p).adres).toBe('ul. Przykładowa 1\n00-001 Miasto\nPolska');

  expect((await post('/magazyn/producenci/999/zmien', POLCIEN)).statusCode).toBe(404);
  expect((await get('/magazyn/producenci?edytuj=999')).statusCode).toBe(404);
});

it('dotychczasowy adres starego producenta z „<script>” wraca w podpowiedzi jako tekst', async () => {
  panel();
  const p = stary('<script>alert(7)</script> ul. Zmyślona 19');
  const formularz = (await get(`/magazyn/producenci?edytuj=${p}`)).body;
  expect(formularz).not.toContain('<script>alert(7)</script>');
  expect(formularz).toContain('Dotychczasowy adres: &lt;script&gt;alert(7)&lt;/script&gt; ul. Zmyślona 19');
});

it('stary producent z adresem w jednym polu: lista pokazuje adres, formularz zmiany ma puste pola i dotychczasowy adres', async () => {
  panel();
  const p = stary();
  expect((await get('/magazyn/producenci')).body).toContain('ul. Zmyślona 19, 00-950 Przykładowo');

  const formularz = (await get(`/magazyn/producenci?edytuj=${p}`)).body;
  expect(formularz).toContain(
    '<p class="podpowiedz">Dotychczasowy adres: ul. Zmyślona 19, 00-950 Przykładowo — przepisz go do pól poniżej.</p>',
  );
  expect(kontrolka(formularz, 'producent-nazwa')).toContain('value="Pracownia Półcień"');
  for (const id of ['producent-ulica', 'producent-kod', 'producent-miasto']) {
    expect(kontrolka(formularz, id), id).toContain('value=""');
  }
  expect(wybranyKraj(formularz)).toBe('PL');

  // Błąd przy przepisywaniu nie gubi podpowiedzi — człowiek dalej widzi, co ma przepisać.
  const zly = await post(`/magazyn/producenci/${p}/zmien`, { ...POLCIEN, ulica: 'ul. Zmyślona 19', kod: '' });
  expect(zly.statusCode).toBe(400);
  expect(zly.body).toContain('Dotychczasowy adres: ul. Zmyślona 19, 00-950 Przykładowo');
  expect(producentPoId(db, p).ulica).toBeNull();

  const r = await post(`/magazyn/producenci/${p}/zmien`, {
    ...POLCIEN,
    ulica: 'ul. Zmyślona 19',
    kod: '00950',
    miasto: 'Przykładowo',
  });
  expect(r.statusCode).toBe(303);
  expect(producentPoId(db, p)).toMatchObject({
    adres: 'ul. Zmyślona 19\n00-950 Przykładowo\nPolska',
    ulica: 'ul. Zmyślona 19',
    kod_pocztowy: '00-950',
    domyslny: true,
  });
  expect((await get(`/magazyn/producenci?edytuj=${p}`)).body).not.toContain('Dotychczasowy adres');
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
  const marki = (await get('/magazyn/producenci')).body;
  const sekcja = marki.slice(marki.indexOf('id="marki"'));
  expect(sekcja).toContain('<th scope="col">Producent</th>');
  expect(sekcja.match(new RegExp(`<option value="${p}" selected>Pracownia Półcień</option>`, 'g'))).toHaveLength(2);

  // Pusty wybór zdejmuje przypisanie; jedna marka w formularzu to pojedyncze pola, nie tablica.
  expect((await post('/magazyn/producenci/marki', { marka: 'Lampa', producent: '' })).statusCode).toBe(303);
  expect(przypisaniaMarek(db)).toEqual(new Map([['Półcień', p]]));
  const lampa = (await get('/magazyn/producenci')).body.match(/>Lampa<\/th>[\s\S]*?<\/select>/)?.[0] ?? '';
  expect(lampa).toContain('<option value="">— brak —</option>');
  expect(lampa).not.toContain(' selected');

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

it('menu Magazynu: „Producenci” jest trzecią pozycją (bez osobnych Marek) z aria-current na swojej stronie', async () => {
  panel();
  utworzKarte(db, { sku: 'L-1', nazwa: 'Lampa Półcień' });
  for (const [url, biezacy] of [
    ['/magazyn/producenci', 'Producenci'],
    ['/magazyn/producenci?edytuj=x', 'Producenci'],
    ['/magazyn/kategorie', 'Kategorie'],
  ]) {
    const { body } = await get(url);
    const lista = body.slice(body.indexOf('data-podmenu-lista="magazyn"')).split('</ul>')[0];
    const linki = [...lista.matchAll(/<a href="([^"]+)"([^>]*)>([^<]+)<\/a>/g)].map((m) => [m[1], m[3]]);
    expect(linki).toEqual([
      ['/magazyn', 'Produkty'],
      ['/magazyn/kategorie', 'Kategorie'],
      ['/magazyn/producenci', 'Producenci'],
      ['/magazyn/cenniki', 'Cenniki'],
      ['/magazyn/ustawienia', 'Ustawienia'],
    ]);
    const a = lista.match(/<a href="\/magazyn\/producenci"([^>]*)>/);
    expect(a[1].includes('aria-current="page"'), url).toBe(biezacy === 'Producenci');
  }
});
