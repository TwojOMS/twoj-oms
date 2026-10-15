import { describe, it, expect } from 'vitest';
import { zalozKonto, kontoPoLoginie, ustawCzynne, ostatnieLogowania } from '../../../src/core/bezpieczenstwo/konta.js';
import { wydajLink } from '../../../src/moduly/ustawienia/linki-hasla.js';
import { nowyPanel, get, post, ORIGIN } from '../../pomoc/konta-prz068.js';

const NOWE = { nowe: 'nowe-haslo-12345', nowe2: 'nowe-haslo-12345' };
function panel() {
  const p = nowyPanel();
  zalozKonto(p.db, { login: 'adam', imie: 'Adam', haslo: 'h', rola: 'administrator', admin: true });
  const id = zalozKonto(p.db, { login: 'ewa', imie: 'Ewa', haslo: 'stare-haslo-123', rola: 'sprzedaz' });
  const link = () => wydajLink(p.db, { kontoId: id, cel: 'reset', utworzylKontoId: null, teraz: () => new Date() }).token;
  return { ...p, id, link };
}
const NIEWAZNY = 'Link jest nieważny — poproś administratora o nowy';

describe('PRZ-069 /haslo/:token', () => {
  it('bez logowania: formularz, no-store, Referrer-Policy strict-origin (recenzja D8 r1, P1-1), bez menu panelu', async () => {
    const { app, link } = panel();
    const r = await get(app, `/haslo/${link()}`);
    expect(r.statusCode).toBe(200);
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.headers['referrer-policy']).toBe('strict-origin');
    expect(r.body).toContain('name="nowe"');
    expect(r.body).toContain('name="nowe2"');
    // Klasa „menu-uzytkownika” stoi w CSS układu na każdej stronie — o braku menu panelu mówi brak ramy panelu.
    expect(r.body).not.toContain('class="oms-sidebar"');
    expect(r.body).not.toContain('data-menu="uzytkownik"');
  });

  it('ustawia hasło, zużywa link, unieważnia inne, wpis w dzienniku, przekierowanie na logowanie bez zalogowania', async () => {
    const { db, app, link } = panel();
    const starszy = link();
    const token = link();
    const r = await post(app, `/haslo/${token}`, {}, NOWE);
    expect(r.statusCode).toBe(302);
    expect(r.headers.location).toBe('/login?haslo=ustawione');
    expect(r.headers['set-cookie']).toBeUndefined();
    expect(kontoPoLoginie(db, 'ewa').wersja_hasla).toBe(1);
    expect(ostatnieLogowania(db, 5).some((l) => l.login === 'ewa' && l.wynik === 'haslo-z-linku')).toBe(true);
    expect((await get(app, '/login?haslo=ustawione')).body).toContain('Hasło ustawione');
    const login = await app.inject({ method: 'POST', url: '/login', headers: { ...ORIGIN, accept: 'text/html' }, payload: { uzytkownik: 'ewa', haslo: NOWE.nowe } });
    expect(login.statusCode).toBe(302);
    for (const t of [token, starszy]) {
      const ponownie = await get(app, `/haslo/${t}`);
      expect(ponownie.statusCode).toBe(410);
      expect(ponownie.body).toContain(NIEWAZNY);
    }
  });

  it('przeterminowany, podmieniony o znak, za krótki i dla wyłączonego konta — ten sam komunikat', async () => {
    const { db, app, id, link } = panel();
    const przeterminowany = link();
    db.prepare("UPDATE linki_hasla SET wygasa_at = '2000-01-01T00:00:00.000Z'").run();
    const t = link();
    const podmieniony = t.slice(0, -1) + (t.at(-1) === 'A' ? 'B' : 'A');
    for (const zly of [przeterminowany, podmieniony, 'abc']) {
      const r = await get(app, `/haslo/${zly}`);
      expect(r.statusCode, zly).toBe(410);
      expect(r.body).toContain(NIEWAZNY);
    }
    ustawCzynne(db, id, false);
    expect((await post(app, `/haslo/${t}`, {}, NOWE)).statusCode).toBe(410);
    expect(kontoPoLoginie(db, 'ewa').wersja_hasla).toBe(0);
  });

  it('za krótkie albo różne hasła → 400, link dalej ważny', async () => {
    const { db, app, link } = panel();
    const t = link();
    expect((await post(app, `/haslo/${t}`, {}, { nowe: 'krotkie', nowe2: 'krotkie' })).statusCode).toBe(400);
    expect((await post(app, `/haslo/${t}`, {}, { nowe: 'nowe-haslo-12345', nowe2: 'nowe-haslo-12346' })).statusCode).toBe(400);
    expect((await post(app, `/haslo/${t}`, {}, NOWE)).statusCode).toBe(302);
    expect(kontoPoLoginie(db, 'ewa').wersja_hasla).toBe(1);
  });

  it('CSRF po Origin jak cały panel', async () => {
    const { app, link } = panel();
    const r = await app.inject({ method: 'POST', url: `/haslo/${link()}`, headers: { accept: 'text/html', origin: 'http://obcy.example' }, payload: NOWE });
    expect(r.statusCode).toBe(403);
  });

  it('hamulec: cztery nieważne tokeny → 410, piąty → 429, potem nawet ważny → 429', async () => {
    const { app, link } = panel();
    const zly = 'x'.repeat(43);
    for (let i = 1; i <= 4; i++) expect((await get(app, `/haslo/${zly}`)).statusCode, `próba ${i}`).toBe(410);
    expect((await get(app, `/haslo/${zly}`)).statusCode).toBe(429);
    expect((await get(app, `/haslo/${link()}`)).statusCode).toBe(429);
  });
});
