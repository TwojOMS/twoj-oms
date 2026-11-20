import { afterEach, expect, it } from 'vitest';
import { zalozKonto } from '../../../src/core/bezpieczenstwo/konta.js';
import { get, jako, nowyPanel } from '../../pomoc/panel-konta-testowe.js';

let panel;
afterEach(async () => {
  if (!panel) return;
  await panel.app.close();
  panel.db.close();
  panel = null;
});

function przygotuj({ liczba = 0, przeczytane = false, pilne = false, wiek = 0, blad = null } = {}) {
  panel = nowyPanel();
  const { app, db } = panel;
  const login = 'pracownia-polcien';
  const kontoId = zalozKonto(db, {
    login,
    imie: 'Pracownia Półcień',
    haslo: 'test',
    rola: 'administrator',
    admin: true,
  });
  const teraz = Date.now();
  const data = new Date(teraz - wiek).toISOString();
  db.prepare('INSERT INTO powiadomienia_stan (id, odswiezone_at, blad, blad_at) VALUES (1, ?, ?, ?)').run(
    data,
    blad,
    blad ? data : null,
  );
  const dodaj = db.prepare(
    `INSERT INTO powiadomienia (klucz, typ, tekst, href, pilne, pierwszy_raz_at, ostatnio_at)
     VALUES (?, 'przesylka', 'Przesyłka lampy wymaga uwagi', '/zamowienia/1', ?, ?, ?)`,
  );
  const oznacz = db.prepare('INSERT INTO powiadomienia_przeczytane (klucz, konto_id, przeczytane_at) VALUES (?, ?, ?)');
  for (let i = 0; i < liczba; i++) {
    const klucz = `przesylka:lampa:${i}`;
    dodaj.run(klucz, Number(pilne && i === 0), data, new Date(teraz - i * 1000).toISOString());
    if (przeczytane) oznacz.run(klucz, kontoId, data);
  }
  const sesja = jako(db, login);
  return {
    app,
    sesja,
    async naglowek() {
      const r = await get(app, '/', sesja);
      expect(r.statusCode).toBe(200);
      return r.body.match(/<header class="oms-topbar">[\s\S]*?<\/header>/)?.[0] ?? '';
    },
  };
}

it.each([
  [10, '9+'],
  [9, '9'],
  [3, '3'],
])('licznik przy %i ma tekst %s i pełną liczbę w etykiecie', async (liczba, etykieta) => {
  const html = await przygotuj({ liczba }).naglowek();
  expect(html).toContain(`aria-label="Powiadomienia, ${liczba} nieprzeczytane"`);
  expect(html).toContain(`class="dzwonek-licznik" aria-hidden="true">${etykieta}</span>`);
  expect(html.indexOf('data-menu="powiadomienia"')).toBeLessThan(
    html.indexOf('class="oms-theme-button oms-settings-button"'),
  );
});

it('pokazuje do pięciu aktualnych spraw w kolejności odczytu i akcje POST', async () => {
  const html = await przygotuj({ liczba: 7, pilne: true }).naglowek();
  expect(html).toContain('dzwonek-licznik--pilne');
  expect(html.match(/dzwonek-wiersz--pilne/g)).toHaveLength(1);
  expect(html).toContain('method="post" action="/powiadomienia/przeczytane"');
  expect(html).toContain('name="wszystkie" value="1"');
  expect(html).toContain('name="powrot" value="/"');
  expect(Array.from(html.matchAll(/method="post" action="(\/powiadomienia\/[^"]+\/otworz)"/g), (m) => m[1])).toEqual(
    Array.from({ length: 5 }, (_, i) => `/powiadomienia/przesylka%3Alampa%3A${i}/otworz`),
  );
  expect(html).toContain('href="/powiadomienia">Zobacz wszystkie powiadomienia</a>');
});

it('pokazuje pilną kropkę także po przeczytaniu sprawy', async () => {
  const html = await przygotuj({ liczba: 1, przeczytane: true, pilne: true }).naglowek();
  expect(html).toContain('aria-label="Powiadomienia, pilne"');
  expect(html).toContain('dzwonek-licznik--pilne dzwonek-licznik--kropka');
  expect(html).not.toContain('action="/powiadomienia/przeczytane"');
});

it('pokazuje pusty panel bez licznika i ostrzeżenia przy świeżej migawce', async () => {
  const html = await przygotuj().naglowek();
  expect(html).toContain('aria-label="Powiadomienia"');
  expect(html).toContain('Brak powiadomień');
  expect(html).not.toContain('dzwonek-licznik');
  expect(html).not.toContain('Powiadomienia mogą być nieaktualne');
});

it.each([{ blad: 'Błąd próbny' }, { wiek: 301_000 }])('ostrzega przy błędzie lub starej migawce (%j)', async (stan) => {
  const html = await przygotuj(stan).naglowek();
  expect(html).toContain('title="Powiadomienia mogą być nieaktualne"');
  expect(html).toContain('>Powiadomienia mogą być nieaktualne</p>');
});

it('pomija dzwonek na logowaniu i stronie odmowy z własnym układem', async () => {
  const { app, sesja } = przygotuj({ liczba: 3 });
  const login = await get(app, '/login');
  expect(login.statusCode).toBe(200);
  expect(login.body).not.toContain('data-menu="powiadomienia"');
  const odmowa = await app.inject({
    method: 'POST',
    url: '/motyw',
    headers: { ...sesja, accept: 'text/html', origin: 'http://obcy.invalid' },
  });
  expect(odmowa.statusCode).toBe(403);
  expect(odmowa.body).not.toContain('data-menu="powiadomienia"');
});
