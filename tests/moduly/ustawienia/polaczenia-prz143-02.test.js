import { it, expect, vi, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { zbudujOms } from '../../../src/oms/bootstrap.ts';
import { createWidokIntegracji } from '../../../src/moduly/ustawienia/integracje.js';

const { renderFile } = createRequire(import.meta.url)('ejs');
const kanal = 'allegro_polcien';
const adres = `/ustawienia/integracje/allegro/${kanal}`;
const headers = { authorization: `Basic ${Buffer.from('operator:test').toString('base64')}`, accept: 'text/html' };
const env = { OMS_USER: 'operator', OMS_PASS: 'test', OMS_PROFORMY_KATALOG: tmpdir(), OMS_ETYKIETY_KATALOG: tmpdir(),
  OMS_KANALY: JSON.stringify([{ klucz: kanal, typ: 'allegro', prefiks: 'POLCIEN', etykieta: 'Pracownia Półcień' }]),
  POLCIEN_CLIENT_ID: 'fikcyjny', POLCIEN_CLIENT_SECRET: 'fikcyjny', POLCIEN_USER_AGENT: 'Fixture/1.0 (+https://fixture.invalid)', POLCIEN_OD: '2026-01-01' };
afterEach(() => vi.unstubAllGlobals());
async function panel(fn) {
  vi.stubGlobal('fetch', vi.fn(() => { throw Error('Sieć zabroniona'); }));
  const a = await zbudujOms({ env });
  try { await fn(a); } finally { await a.app.close(); a.db.close(); }
}
const kartaAllegro = html => html.match(/<article[^>]*data-usluga="allegro"[\s\S]*?<\/article>/)?.[0] ?? '';

it('N5: każde konto Allegro, także przykładowe, ma Zarządzaj; katalog jednego konta otwiera jego ekran, kilku — grupę', async () => {
  await panel(async ({ app, db }) => {
    for (const ile of [1, 2]) {
      for (const proba of [false, true]) {
        let dane;
        const klucze = [kanal, 'allegro_cien'].slice(0, ile);
        const widok = createWidokIntegracji({ db, proba, kanaly: () => ({ kanaly: Object.fromEntries(klucze.map(k => [k, {}])) }) });
        for (const katalog of [false, true]) {
          widok({ url: '/ustawienia/integracje' + (katalog ? '/katalog' : ''), query: {} }, { view: (_n, d) => { dane = d; } });
          const html = await renderFile('src/moduly/ustawienia/widoki/ustawienia-polaczenia.ejs', { ...dane, fmtKiedy: () => '' });
          if (katalog) expect(kartaAllegro(html)).toContain(`href="${ile === 1 ? adres : '/ustawienia/integracje#grupa-sprzedaz'}">Zarządzaj</a>`);
          else for (const k of klucze) expect(html).toMatch(new RegExp(`href="/ustawienia/integracje/allegro/${k}">Zarządzaj</a>`));
        }
      }
    }
    const r = await app.inject({ url: adres, headers });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('Pracownia Półcień');
  });
});

it('N8: każdy ekran połączenia ma jeden główny nagłówek, a Integracje są wspólnym małym linkiem powrotu', async () => {
  await panel(async ({ app }) => {
    for (const trasa of ['', '/katalog', '/dpd', '/inpost', '/ksef', '/infakt', '/gus', '/poczta', '/reklamy', '/allegro/nowe', `/allegro/${kanal}`, '/woocommerce/nowy']) {
      const r = await app.inject({ url: '/ustawienia/integracje' + trasa, headers });
      expect(r.statusCode, trasa).toBe(200);
      const html = r.body.replace(/<style\b[^>]*>[\s\S]*?<\/style>|<!--[\s\S]*?-->/g, '');
      expect(html.match(/<h1(?:\s|>)/g) ?? [], trasa).toHaveLength(1);
      expect(r.body, trasa).not.toMatch(/role="heading" aria-level="1"/);
      expect(r.body, trasa).toContain('<a href="/ustawienia/integracje">Integracje</a>');
    }
  });
  const css = readFileSync('src/public/oms-ustawienia.css', 'utf8');
  expect(css).toMatch(/\.oms-settings-content \.ust-instrukcja\s*\{[^}]*max-width:\s*none/);
});

it('N11: lista używa czytelnych inicjałów KSeF, GUS i Meta zamiast pomniejszonych logotypów', async () => {
  for (const [usluga, inicjal] of [['ksef', 'K'], ['gus', 'G'], ['meta', 'M']]) {
    const html = await renderFile('src/moduly/ustawienia/widoki/ustawienia-polaczenia-wiersz.ejs', {
      p: { usluga, nazwa: usluga, stan: 'niesprawdzone' }, idWiersza: usluga, kanaly: [],
      wszystkieUslugi: [{ id: usluga, nazwa: usluga, logo: `/integracje/${usluga}.svg` }], fmtKiedy: () => '',
    });
    const logo = html.match(/<span class="pol-logo"[\s\S]*?<\/span>/)?.[0];
    expect(logo).toContain(`class="pol-inicjal" aria-hidden="true">${inicjal}</span>`);
    expect(logo).not.toContain('<img');
  }
});
