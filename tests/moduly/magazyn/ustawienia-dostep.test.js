// Magazyn → Ustawienia: kto wchodzi, jak wygląda podmenu i co robią dawne adresy z Ustawień.
import { describe, it, expect } from 'vitest';
import { zalozKonto, kontoPoLoginie, ustawUprawnienia } from '../../../src/core/bezpieczenstwo/konta.js';
import { przelacznikStanow } from '../../../src/oms/db/stany-magazynowe.js';
import { nowyPanel, jako, get, post } from '../../pomoc/panel-konta-testowe.js';

function panel() {
  const p = nowyPanel();
  zalozKonto(p.db, { login: 'adam', imie: 'Adam', haslo: 'h', rola: 'administrator', admin: true });
  zalozKonto(p.db, { login: 'ewa', imie: 'Ewa', haslo: 'h', rola: 'sprzedaz' });
  ustawUprawnienia(p.db, kontoPoLoginie(p.db, 'ewa').id, ['zamowienia', 'magazyn']);
  zalozKonto(p.db, { login: 'ola', imie: 'Ola', haslo: 'h', rola: 'sprzedaz' });
  ustawUprawnienia(p.db, kontoPoLoginie(p.db, 'ola').id, ['magazyn', 'ustawienia']);
  return { ...p, admin: jako(p.db, 'adam'), ewa: jako(p.db, 'ewa'), ola: jako(p.db, 'ola') };
}

/** Pozycje podmenu Magazynu (pierwsza lista — wersja na szeroki ekran). */
const podmenu = (html) =>
  /<ul class="oms-podmenu-lista"[^>]*data-podmenu-lista="magazyn"[\s\S]*?<\/ul>/u.exec(html)?.[0] ?? '';
const pozycja = (html, napis) => new RegExp(`<a href="([^"]+)"([^>]*)>${napis}</a>`, 'u').exec(podmenu(html));

describe('Magazyn → Ustawienia: dostęp', () => {
  it.each(['/magazyn/ustawienia', '/magazyn/ustawienia/parametry', '/magazyn/ustawienia/parametry/nowy'])(
    'konto z magazynem bez uprawnienia „Ustawienia” dostaje odmowę pod %s',
    async (adres) => {
      const { app, ewa } = panel();
      expect((await get(app, adres, ewa)).statusCode).toBe(403);
    },
  );

  it('konto z uprawnieniem „Ustawienia” wchodzi, a stany przełącza tylko administrator', async () => {
    const { db, app, ola, admin } = panel();
    expect((await get(app, '/magazyn/ustawienia', ola)).statusCode).toBe(200);
    expect((await get(app, '/magazyn/ustawienia/parametry', ola)).statusCode).toBe(200);
    expect((await post(app, '/magazyn/ustawienia/stany', ola, { wlacz: '1' })).statusCode).toBe(403);
    expect(przelacznikStanow(db).wlaczone).toBe(false);
    expect((await post(app, '/magazyn/ustawienia/stany', admin, { wlacz: '1' })).statusCode).toBe(303);
  });

  it('podmenu Magazynu ma „Ustawienia” tylko dla konta z uprawnieniem', async () => {
    const { app, admin, ewa } = panel();
    expect(pozycja((await get(app, '/magazyn', admin)).body, 'Ustawienia')?.[1]).toBe('/magazyn/ustawienia');
    const bez = await get(app, '/magazyn', ewa);
    expect(bez.statusCode).toBe(200);
    expect(podmenu(bez.body)).toContain('>Produkty<');
    expect(pozycja(bez.body, 'Ustawienia')).toBeNull();
  });

  it('na ekranie ustawień magazynu dział Magazyn jest aktywny, a „Ustawienia” w górnym pasku i Produkty nie', async () => {
    const { app, admin } = panel();
    const glowny = await get(app, '/magazyn/ustawienia', admin);
    expect(pozycja(glowny.body, 'Ustawienia')?.[2]).toContain('aria-current="page"');
    expect(pozycja(glowny.body, 'Produkty')?.[2]).not.toContain('aria-current');
    const podstrona = await get(app, '/magazyn/ustawienia/parametry', admin);
    expect(pozycja(podstrona.body, 'Ustawienia')?.[2]).toContain('aria-current="true"');
    expect(pozycja(podstrona.body, 'Produkty')?.[2]).not.toContain('aria-current');
    for (const r of [glowny, podstrona]) {
      expect(r.body).toMatch(/<a href="\/magazyn" aria-current="page">/u);
      expect(r.body).not.toMatch(/<a href="\/ustawienia"[^>]*aria-current/u);
    }
  });

  it.each(['/magazyn/%75stawienia', '/magazyn/%75stawienia/parametry', '/magazyn/ustawienia%2Fparametry'])(
    'zakodowany adres %s nie omija odmowy dla konta bez uprawnienia „Ustawienia”',
    async (adres) => {
      const { db, app, ewa } = panel();
      expect((await get(app, adres, ewa)).statusCode).toBe(403);
      const r = await post(app, '/magazyn/%75stawienia/parametry', ewa, { nazwa: 'Kolor', typ: 'tekst' });
      expect(r.statusCode).toBe(403);
      expect(db.prepare('SELECT COUNT(*) AS n FROM parametry_kart').get().n).toBe(0);
    },
  );

  it.each(['/zamowienia/1%3F/dane/faktura', '/zamowienia/1%3Fx/faktura'])(
    'zdekodowany znak zapytania w %s nie przenosi na łagodniejszy ekran zamówień',
    async (adres) => {
      const { app, ewa } = panel();
      expect((await get(app, '/zamowienia/1/dane/faktura', ewa)).statusCode).toBe(403);
      expect((await get(app, adres, ewa)).statusCode).toBe(403);
    },
  );
});

describe('Magazyn → Ustawienia: dawne adresy', () => {
  it.each([
    ['/ustawienia/magazyn', '/magazyn/ustawienia'],
    ['/ustawienia/magazyn/parametry', '/magazyn/ustawienia/parametry'],
    ['/ustawienia/magazyn/parametry/3?x=1', '/magazyn/ustawienia/parametry/3?x=1'],
    ['/ustawienia/magazyn?zapisano=wlaczono', '/magazyn/ustawienia?zapisano=wlaczono'],
    ['/ustawienia/%6Dagazyn/parametry', '/magazyn/ustawienia/parametry'],
  ])('GET %s przekierowuje na %s kodem 301', async (stary, nowy) => {
    const { app, admin } = panel();
    const r = await get(app, stary, admin);
    expect(r.statusCode).toBe(301);
    expect(r.headers.location).toBe(nowy);
  });

  it('POST pod dawnym adresem kończy się 404 i niczego nie zmienia', async () => {
    const { db, app, admin } = panel();
    const r = await post(app, '/ustawienia/magazyn/stany', admin, { wlacz: '1' });
    expect(r.statusCode).toBe(404);
    expect(przelacznikStanow(db).wlaczone).toBe(false);
    expect((await post(app, '/ustawienia/magazyn/zrodla', admin, {})).statusCode).toBe(404);
  });
});
