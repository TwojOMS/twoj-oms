import { describe, it, expect } from 'vitest';
import { zalozKonto, kontoPoLoginie } from '../../../src/core/bezpieczenstwo/konta.js';
import { dodajRole, przypiszRole } from '../../../src/moduly/ustawienia/role.js';
import { NAZWA_CIASTECZKA_OMS } from '../../../src/core/bezpieczenstwo/sesja.js';
import { nowyPanel, jako, get, post, BASIC } from '../../pomoc/konta-prz068.js';

const HASLO = 'obecne-haslo-123';
function panel() {
  const p = nowyPanel();
  zalozKonto(p.db, { login: 'adam', imie: 'Adam', haslo: 'h', rola: 'administrator', admin: true });
  const pusta = dodajRole(p.db, { nazwa: 'Bez ekranów', teraz: () => new Date() });
  const id = zalozKonto(p.db, { login: 'ewa', imie: 'Ewa', haslo: HASLO, rola: pusta });
  przypiszRole(p.db, id, pusta);
  return { ...p, id, ewa: jako(p.db, 'ewa') };
}
const ciastko = (r) => [].concat(r.headers['set-cookie'] ?? []).filter((c) => c.startsWith(`${NAZWA_CIASTECZKA_OMS}=`)).at(-1)?.split(';')[0];

describe('PRZ-069 Moje konto', () => {
  it('każde konto z tabeli (także bez ani jednego ptaszka) widzi swoją stronę i link w menu', async () => {
    const { app, ewa } = panel();
    const r = await get(app, '/konto', ewa);
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('<h1>Moje konto</h1>');
    expect(r.body).toContain('name="imie"');
    expect(r.body).toContain('Bez ekranów');
    expect(r.body).toContain('name="obecne"');
    expect(r.body).toContain('<a href="/konto">Moje konto</a>');
    expect(r.body).not.toContain('wyloguj-wszystkie');
  });

  it('imię: przycięte 1–60 znaków', async () => {
    const { db, app, ewa } = panel();
    const ok = await post(app, '/konto/imie', ewa, { imie: '  Barbara K  ' });
    expect(ok.statusCode).toBe(302);
    expect(ok.headers.location).toBe('/konto?zapisano=imie');
    expect(kontoPoLoginie(db, 'ewa').imie).toBe('Barbara K');
    for (const imie of ['', '   ', 'x'.repeat(61)]) expect((await post(app, '/konto/imie', ewa, { imie })).statusCode, imie).toBe(400);
  });

  it('zmiana hasła: wymaga obecnego, ≥ 12 znaków, dwa razy to samo, inne niż obecne', async () => {
    const { db, app, ewa } = panel();
    const przypadki = [
      { obecne: 'zle-haslo-xyz', nowe: 'nowe-haslo-123', nowe2: 'nowe-haslo-123' },
      { obecne: HASLO, nowe: 'krotkie', nowe2: 'krotkie' },
      { obecne: HASLO, nowe: 'nowe-haslo-123', nowe2: 'nowe-haslo-124' },
      { obecne: HASLO, nowe: HASLO, nowe2: HASLO },
    ];
    for (const p of przypadki) expect((await post(app, '/konto/haslo', ewa, p)).statusCode).toBe(400);
    expect(kontoPoLoginie(db, 'ewa').wersja_hasla).toBe(0);
  });

  it('po zmianie własnego hasła bieżąca sesja dostaje nowe ciasteczko, a stare ciasteczko wylatuje', async () => {
    const { db, app, ewa } = panel();
    const r = await post(app, '/konto/haslo', ewa, { obecne: HASLO, nowe: 'nowe-haslo-123', nowe2: 'nowe-haslo-123' });
    expect(r.statusCode).toBe(302);
    expect(kontoPoLoginie(db, 'ewa').wersja_hasla).toBe(1);
    const nowe = ciastko(r);
    expect(nowe).toBeTruthy();
    expect((await get(app, '/konto', { cookie: nowe })).statusCode).toBe(200);
    const stare = await get(app, '/konto', ewa);
    expect(stare.statusCode).toBe(302);
    expect(stare.headers.location).toMatch(/^\/login/);
  });

  it('hamulec prób obecnego hasła: piąta zła próba i każda następna (także poprawna) → 429', async () => {
    const { app, ewa } = panel();
    const zle = { obecne: 'zle-haslo-xyz', nowe: 'nowe-haslo-123', nowe2: 'nowe-haslo-123' };
    for (let i = 1; i <= 4; i++) expect((await post(app, '/konto/haslo', ewa, zle)).statusCode, `próba ${i}`).toBe(400);
    expect((await post(app, '/konto/haslo', ewa, zle)).statusCode).toBe(429);
    expect((await post(app, '/konto/haslo', ewa, { obecne: HASLO, nowe: 'nowe-haslo-123', nowe2: 'nowe-haslo-123' })).statusCode).toBe(429);
  });

  it('konto serwisowe .env: informacja zamiast strony, bez linku w menu, bez zapisu', async () => {
    const { app } = nowyPanel();
    const r = await get(app, '/konto', BASIC);
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('Konto serwisowe nie ma własnej strony');
    expect(r.body).not.toContain('<a href="/konto">Moje konto</a>');
    expect((await post(app, '/konto/haslo', BASIC, { obecne: 'x', nowe: 'nowe-haslo-123', nowe2: 'nowe-haslo-123' })).statusCode).toBe(403);
  });
});
