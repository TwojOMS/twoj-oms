import { describe, it, expect, beforeEach, vi } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { buildOmsServer } from '../../pomoc/serwer-testowy-oms.ts';

// Przycisk „Pobierz treść i zdjęcia ofert" na ekranie magazynu: osobny przebieg w tle,
// postęp „N z M", zdanie D3 pod przyciskiem (bez przełącznika i bez blokady), błędy ofert widoczne.

const config = { auth: { user: 'adam', pass: 'x' } };
const auth = {
  authorization: `Basic ${Buffer.from('adam:x').toString('base64')}`,
  origin: 'http://localhost',
};
const ZDANIE_D3 = 'Allegro zabrania używania treści pobranych z ofert w innych serwisach sprzedażowych — decyzja należy do Ciebie';

const STAN_MAGAZYNU = { trwa: false, zaczety_at: null, skonczony_at: null, postep: null, kanaly: [], blad: null };
const STAN_TRESCI = { trwa: false, zaczety_at: null, skonczony_at: null, postep: null, razem: 0, pobrane: 0, bledy: [], blad: null };

const atrapaMagazynu = () => ({ start: vi.fn(() => ({ wystartowal: true })), stan: () => STAN_MAGAZYNU });
const atrapaTresci = (stan = {}, gotowy = true) => ({
  start: vi.fn(() => ({ wystartowal: true })), stan: () => ({ ...STAN_TRESCI, ...stan }), gotowy: () => gotowy,
});

let db;
beforeEach(() => { db = openOmsDb(':memory:'); });

const serwer = (trescAllegro) => buildOmsServer({ db, config, magazyn: atrapaMagazynu(),
  nadpisania: trescAllegro === undefined ? {} : { 'magazyn.trescAllegro': trescAllegro } });
const strona = async (trescAllegro) => {
  const r = await serwer(trescAllegro).inject({ method: 'GET', url: '/magazyn', headers: auth });
  expect(r.statusCode).toBe(200);
  return r.body;
};
// Przycisk „Pobierz treść i zdjęcia ofert" i zdanie D3 zeszły z listy na ekran importu
// (`/magazyn/import`). Na liście zostaje pasek `.pasek-odczytu` — tylko przy trwaniu albo błędzie.
const formularzTresci = (html) => html.match(/<form method="post" action="\/magazyn\/tresc-allegro">[\s\S]*?<\/form>/)?.[0] ?? '';
const pasek = (html) => /<div class="pasek-odczytu"[\s\S]*?<\/div>/.exec(html)?.[0] ?? '';

describe('ekran magazynu — treść i zdjęcia ofert Allegro', () => {
  it('spokój: na liście nie ma przycisku, zdania D3 ani paska — są na ekranie importu', async () => {
    const html = await strona(atrapaTresci());
    expect(formularzTresci(html)).toBe('');
    expect(html).not.toContain('Pobierz treść i zdjęcia ofert');
    expect(html).not.toContain(ZDANIE_D3);
    expect(pasek(html)).toBe('');
  });

  it('w trakcie: postęp „N z M" na pasku z odnośnikiem do importu', async () => {
    const html = await strona(atrapaTresci({ trwa: true, zaczety_at: '2026-11-13T08:00:00.000Z', postep: { zrobione: 2, zTego: 5 } }));
    const p = pasek(html);
    expect(p).toContain('Treść ofert:');
    expect(p).toContain('2 z 5');
    expect(p).toMatch(/<a href="\/magazyn\/import">Importuj →<\/a>/);
  });

  it('po przebiegu: odmowa Allegro, liczba pobranych i liczba ofert z błędem na pasku', async () => {
    const p = pasek(await strona(atrapaTresci({
      skonczony_at: '2026-11-13T08:10:00.000Z', razem: 3, pobrane: 1,
      blad: 'Allegro odmówiło dostępu do konta allegro_polcien2 (HTTP 403).',
      bledy: [{ kanal: 'allegro_polcien2', oferta_id: '7700000001', blad: 'Oferta w EUR — pominięta.' },
        { kanal: 'allegro_polcien2', oferta_id: '7700000002', zdjecie: 'https://a.example/z.webp', blad: 'Zdjęcie pominięte: zły format' }],
    })));
    expect(p).toContain('błędy pobierania');
    expect(p).toContain('Allegro odmówiło dostępu do konta allegro_polcien2 (HTTP 403).');
    expect(p).toContain('pobrane 1 z 3');
    expect(p).toContain('ofert z błędem: 2');
    expect(p).toContain('7700000001');
    expect(p).toContain('Oferta w EUR — pominięta.');
    expect(p).toContain('Zdjęcie pominięte: zły format');
  });

  it('bez połączonego konta Allegro przycisku nie ma', async () => {
    expect(formularzTresci(await strona(atrapaTresci({}, false)))).toBe('');
  });
});

describe('POST /magazyn/tresc-allegro', () => {
  it('startuje przebieg i od razu wraca na listę', async () => {
    const tresc = atrapaTresci();
    const r = await serwer(tresc).inject({ method: 'POST', url: '/magazyn/tresc-allegro', headers: auth, payload: {} });
    expect(tresc.start.mock.calls).toHaveLength(1);
    expect(r.statusCode).toBe(303);
    expect(r.headers.location).toBe('/magazyn');
  });

  it('bez nagłówka Origin ochrona CSRF odmawia', async () => {
    const tresc = atrapaTresci();
    const r = await serwer(tresc).inject({ method: 'POST', url: '/magazyn/tresc-allegro',
      headers: { authorization: auth.authorization }, payload: {} });
    expect(r.statusCode).toBeGreaterThanOrEqual(400);
    expect(tresc.start.mock.calls).toHaveLength(0);
  });

  it('bez połączonego konta Allegro odmawia czytelnie i niczego nie startuje', async () => {
    const tresc = atrapaTresci({}, false);
    const r = await serwer(tresc).inject({ method: 'POST', url: '/magazyn/tresc-allegro', headers: auth, payload: {} });
    expect(r.statusCode).toBe(503);
    expect(r.body).toContain('Żadne konto Allegro nie jest połączone');
    expect(tresc.start.mock.calls).toHaveLength(0);
  });
});
