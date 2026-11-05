import { afterEach, expect, it } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { buildOmsServer } from '../../pomoc/serwer-parytetu.ts';
import { KOMUNIKAT_PODGLADU } from '../../../src/core/bezpieczenstwo/podglad-demo.js';

// PRZ-152.G13c1: odmowy rdzenia (CSRF, podgląd demo) — nawigacja przeglądarki dostaje stronę w barwach OMS
// z paskiem uwagi i drogą powrotu; skrypty (fetch, htmx) i programy — dotychczasowy text/plain znak w znak.
const auth = `Basic ${Buffer.from('operator:x').toString('base64')}`;
const formularz = { authorization: auth, 'content-type': 'application/x-www-form-urlencoded' };
const DOPISEK = '.\n\nJeśli to Twoje własne działanie w panelu, otwórz panel pod jego zwykłym adresem i spróbuj ponownie.';
let db, server;
afterEach(async () => { await server?.close(); db?.close(); server = db = null; });
const zbuduj = (config = {}) => {
  db = openOmsDb(':memory:');
  server = buildOmsServer({ db, config: { auth: { user: 'operator', pass: 'x' }, sklepy: {}, kanaly: {}, definicje: [], ...config }, poller: { stan: () => ({}) } });
  return server;
};
const bezWycieku = (body) => {
  expect(body).not.toMatch(/\/srv\/|[A-Z]:\\|\.ejs|ENOENT|<%/);
};

it('CSRF z formularza przeglądarki: 403, strona HTML, pasek z tym samym tekstem, powrót do panelu', async () => {
  const r = await zbuduj().inject({ method: 'POST', url: '/ostrzezenia/odrzuc', payload: 'klucz=x',
    headers: { ...formularz, origin: 'http://obcy.example.test', accept: 'text/html,application/xhtml+xml,*/*;q=0.8' } });
  expect(r.statusCode).toBe(403);
  expect(r.headers['content-type']).toMatch(/^text\/html/);
  expect(r.body).toMatch(/<html/);
  expect(r.body).toContain(`<p class="pasek-uwaga" role="alert">Odmowa: żądanie z obcego źródła (Origin: http://obcy.example.test)${DOPISEK}</p>`);
  expect(r.body).toContain('<a class="btn" href="/">Przejdź do panelu</a>');
  expect(r.body).toContain('<h1>Nie wykonano polecenia</h1>');
  expect(r.body).toContain('data-motyw="jasny"');
  bezWycieku(r.body);
});

it('CSRF: obcy tekst nagłówka jest ucieczkowany, motyw z ciasteczka', async () => {
  const r = await zbuduj().inject({ method: 'POST', url: '/ostrzezenia/odrzuc', payload: 'klucz=x',
    headers: { ...formularz, origin: '<b>zly</b>', accept: 'text/html', cookie: 'oms_motyw=ciemny' } });
  expect(r.statusCode).toBe(403);
  expect(r.body).toContain(`<p class="pasek-uwaga" role="alert">Odmowa: nagłówek Origin nie jest adresem: &lt;b&gt;zly&lt;/b&gt;${DOPISEK}</p>`);
  expect(r.body).not.toContain('<b>zly</b>');
  expect(r.body).toContain('data-motyw="ciemny"');
});

it('CSRF dla skryptu, htmx i programu: dotychczasowy text/plain bez zmian', async () => {
  const app = zbuduj();
  const tekst = `Odmowa: żądanie z obcego źródła (Origin: http://obcy.example.test)${DOPISEK}`;
  for (const dodatkowe of [{}, { accept: '*/*' }, { accept: 'application/json' }, { accept: 'text/html', 'hx-request': 'true' }]) {
    const r = await app.inject({ method: 'POST', url: '/ostrzezenia/odrzuc', payload: 'klucz=x',
      headers: { ...formularz, origin: 'http://obcy.example.test', ...dodatkowe } });
    expect(r.statusCode).toBe(403);
    expect(r.headers['content-type']).toBe('text/plain; charset=utf-8');
    expect(r.body).toBe(tekst);
  }
});

it('podgląd demo z formularza ustawień: 403, strona HTML, pasek z tym samym tekstem, powrót do ustawień', async () => {
  const r = await zbuduj({ demo: { login: 'operator' } }).inject({ method: 'POST', url: '/ustawienia/firma', payload: 'nazwa=Pracownia+P%C3%B3%C5%82cie%C5%84',
    headers: { ...formularz, origin: 'http://localhost', accept: 'text/html' } });
  expect(r.statusCode).toBe(403);
  expect(r.headers['content-type']).toMatch(/^text\/html/);
  expect(r.body).toMatch(/<html/);
  expect(r.body).toContain(`<p class="pasek-uwaga" role="alert">${KOMUNIKAT_PODGLADU}</p>`);
  expect(r.body).toContain('<a class="btn" href="/ustawienia">Wróć do ustawień</a>');
  expect(r.body).toContain('<h1>Tylko do obejrzenia</h1>');
  bezWycieku(r.body);
});

it('podgląd demo dla skryptu i htmx: dotychczasowy text/plain bez zmian', async () => {
  const app = zbuduj({ demo: { login: 'operator' } });
  for (const dodatkowe of [{}, { accept: 'application/json' }, { accept: 'text/html', 'hx-request': 'true' }]) {
    const r = await app.inject({ method: 'POST', url: '/ustawienia/firma', payload: 'x=1',
      headers: { ...formularz, origin: 'http://localhost', ...dodatkowe } });
    expect(r.statusCode).toBe(403);
    expect(r.headers['content-type']).toBe('text/plain; charset=utf-8');
    expect(r.body).toBe(KOMUNIKAT_PODGLADU);
  }
});
