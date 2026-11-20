import { afterEach, expect, it } from 'vitest';
import { zalozKonto } from '../../../src/core/bezpieczenstwo/konta.js';
import { get, jako, nowyPanel } from '../../pomoc/panel-konta-testowe.js';
let p;
afterEach(async () => {
  await p.app.close();
  p.db.close();
});
it('dzwonek pakowacza: tylko to, co konto widzi', async () => {
  p = nowyPanel();
  zalozKonto(p.db, { login: 'pakowacz-test', imie: 'Pakowacz', haslo: 'h', rola: 'produkcja', ekrany: ['zamowienia'] });
  const T0 = new Date().toISOString();
  p.db.prepare('INSERT INTO powiadomienia_stan (id, odswiezone_at) VALUES (1, ?)').run(T0);
  const w = p.db.prepare(
    `INSERT INTO powiadomienia (klucz, typ, tekst, href, pilne, pierwszy_raz_at, ostatnio_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  w.run('faktura-ksef:FV-1', 'faktura-ksef', 'TAJNE-FAKTURA', '/faktury', 1, T0, T0);
  w.run('automatyzacja:wstrzymana:1:x', 'automatyzacja', 'TAJNE-AUTO', '/zamowienia/3', 0, T0, T0);
  w.run('niski-stan:1:1', 'niski-stan', 'TAJNE-MAGAZYN', '/magazyn?stan=niski', 0, T0, T0);
  w.run('przesylka:p1:lampa', 'przesylka', 'WIDOCZNA', '/zamowienia/1', 0, T0, T0);
  const r = await get(p.app, '/', jako(p.db, 'pakowacz-test'));
  const h = r.body.match(/<header class="oms-topbar">[\s\S]*?<\/header>/)?.[0] ?? '';
  console.log(
    'STATUS',
    r.statusCode,
    'licznik:',
    h.match(/dzwonek-licznik[^>]*>[^<]*/)?.[0],
    'aria:',
    h.match(/aria-label="Powiadomienia[^"]*"/)?.[0],
  );
  expect(h).toContain('WIDOCZNA');
  expect(h).not.toContain('TAJNE');
  expect(h).toContain('aria-label="Powiadomienia, 1 nieprzeczytane"');
  expect(h).not.toContain('dzwonek-licznik--pilne');
});
