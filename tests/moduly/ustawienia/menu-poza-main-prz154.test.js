import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { zalozKonto } from '../../../src/core/bezpieczenstwo/konta.js';
import { nowyPanel, jako, get, post, migawkaDostepu } from '../../pomoc/konta-prz068.js';

describe('PRZ-154.E1.3 menu Ustawień w kolumnie bocznej', () => {
  it('menu poza main: Firma ma boczną kolumnę, aktywną pozycję i zwinięte menu telefonu', async () => {
    const p = nowyPanel();
    zalozKonto(p.db, { login: 'operator', haslo: 'h', rola: 'administrator', admin: true });
    try {
      const r = await get(p.app, '/ustawienia/firma', jako(p.db, 'operator'));
      expect(r.statusCode).toBe(200);
      const main = r.body.match(/<main\b[^>]*>[\s\S]*?<\/main>/u)?.[0];
      expect(main).toBeDefined();
      expect(main).not.toContain('oms-settings-navigation');
      expect(main).not.toContain('nawigacja-kontekstowa');
      const bok = r.body.match(/<aside class="oms-settings-column[^"]*"[^>]*>[\s\S]*?<\/aside>/u)?.[0];
      expect(bok).toContain('oms-settings-navigation');
      expect(bok).toMatch(/<li class="aktywna">\s*<a href="\/ustawienia\/firma" aria-current="page">/u);
      expect(r.body).toContain('<summary><span>Ustawienia: <strong>Firma</strong></span></summary>');
      expect(bok.match(/<a /g)).toHaveLength(10);
      expect(bok.match(/<aside/g)).toHaveLength(1);
      expect(r.body).not.toContain('id="ust-menu-aplikacji"');
      expect(r.body).not.toContain('Menu aplikacji');
      expect(r.body).toContain('class="oms-menu-local"');
      expect(r.body).not.toContain('action="/menu-boczne"');
      expect(r.headers['set-cookie']).toBeUndefined();
    } finally { await p.app.close(); p.db.close(); }
  });

  it('rola bez Ustawień dostaje odmowę bez menu Ustawień', async () => {
    const p = nowyPanel();
    zalozKonto(p.db, { login: 'sprzedawca', haslo: 'h', rola: 'sprzedaz' });
    try {
      const r = await get(p.app, '/ustawienia/firma', jako(p.db, 'sprzedawca'));
      expect(r.statusCode).toBe(403);
      expect(r.body).not.toContain('oms-settings-navigation');
      expect(r.body).not.toContain('oms-settings-mobile');
      expect(r.body).not.toContain('href="/ustawienia/firma"');
      const przed = migawkaDostepu(p.db);
      const id = p.db.prepare('SELECT id FROM konta WHERE login = ?').get('sprzedawca').id;
      const zmiana = await post(p.app, `/ustawienia/konta/${id}/rola`, jako(p.db, 'sprzedawca'), { rola: 'administrator' });
      expect(zmiana.statusCode).toBe(403);
      expect(migawkaDostepu(p.db)).toEqual(przed);
    } finally { await p.app.close(); p.db.close(); }
  });
});

it('zwinięcie zapamiętane: POST i następny GET kilku ekranów oraz ponowne rozwinięcie', async () => {
  const p = nowyPanel();
  zalozKonto(p.db, { login: 'operator', haslo: 'h', rola: 'administrator', admin: true });
  try {
    const auth = jako(p.db, 'operator');
    const r = await post(p.app, '/menu-boczne', auth, { powrot: '/przesylki' });
    expect(r.statusCode).toBe(303);
    expect(r.headers.location).toBe('/przesylki');
    expect(r.headers['set-cookie']).toContain('oms_menu=zwiniete; Path=/; Max-Age=31536000; SameSite=Lax; HttpOnly');
    const headers = { cookie: `${auth.cookie}; oms_menu=zwiniete` };
    for (const url of ['/przesylki', '/klienci', '/']) {
      const ekran = await get(p.app, url, headers);
      expect(ekran.statusCode).toBe(200);
      expect(ekran.body).toContain('oms-shell--zwiniete');
      const bok = ekran.body.match(/<aside class="oms-sidebar">[\s\S]*?<\/aside>/u)[0];
      expect(bok).not.toContain('<span>Twój OMS</span>');
      expect(bok.split('<details class="oms-menu-mobile"')[0]).not.toContain('<h2>');
      expect(bok).toContain('title="Przesyłki"');
      expect(bok).toContain('Rozwiń menu');
    }
    const ustawienia = await get(p.app, '/ustawienia/firma', headers);
    expect(ustawienia.body).not.toContain('oms-shell--zwiniete');
    expect(ustawienia.body).toContain('class="oms-menu-local"');
    expect(ustawienia.body).not.toContain('class="oms-menu-local" open');
    const rozwin = await post(p.app, '/menu-boczne', headers, { powrot: '//obcy.example' });
    expect(rozwin.statusCode).toBe(303);
    expect(rozwin.headers.location).toBe('/');
    expect(rozwin.headers['set-cookie']).toContain('oms_menu=rozwiniete;');
    const pelne = await get(p.app, '/przesylki', { cookie: `${auth.cookie}; oms_menu=rozwiniete` });
    expect(pelne.body).not.toContain('oms-shell--zwiniete');
  } finally { await p.app.close(); p.db.close(); }
});

it('zwijanie jest dostępne także dla roli bez Ustawień', async () => {
  const p = nowyPanel();
  zalozKonto(p.db, { login: 'sprzedawca', haslo: 'h', rola: 'sprzedaz' });
  try {
    expect((await post(p.app, '/menu-boczne', jako(p.db, 'sprzedawca'))).statusCode).toBe(303);
  } finally { await p.app.close(); p.db.close(); }
});

it('Ustawienia: menu telefonu widoczne i zwinięcie z ciasteczka nie przecieka do Ustawień', async () => {
  const p = nowyPanel();
  zalozKonto(p.db, { login: 'operator', haslo: 'h', rola: 'administrator', admin: true });
  try {
    const auth = jako(p.db, 'operator');
    const r = await get(p.app, '/ustawienia/firma', { ...auth, cookie: `${auth.cookie}; oms_menu=zwiniete` });
    expect(r.statusCode).toBe(200);
    const bok = r.body.match(/<aside class="oms-sidebar[^"]*"[^>]*>[\s\S]*?<\/aside>/u)?.[0];
    expect(bok).toContain('<details class="oms-menu-mobile"');
    expect(bok.match(/<div class="oms-menu-desktop">[\s\S]*?<\/nav>/u)?.[0]).toContain('<h2');
    const css = readFileSync(new URL('../../../src/public/oms-ustawienia.css', import.meta.url), 'utf8');
    expect(css).not.toMatch(/\.oms-shell--ustawienia>\.oms-sidebar\{display:none\}/u);
  } finally { await p.app.close(); p.db.close(); }
});
