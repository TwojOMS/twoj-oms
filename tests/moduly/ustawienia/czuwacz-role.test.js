import { describe, it, expect } from 'vitest';
import { zalozKonto } from '../../../src/core/bezpieczenstwo/konta.js';
import { dodajRole, przypiszRole } from '../../../src/moduly/ustawienia/role.js';
import { nowyPanel, BASIC, ORIGIN } from '../../pomoc/konta-prz068.js';

describe('PRZ-068 czuwacz druku poza tabelą ról', () => {
  it('rola bez ani jednego ptaszka nie odcina czuwacza (Basic Auth z .env) od kolejek druku', async () => {
    const { db, app } = nowyPanel();
    zalozKonto(db, { login: 'adam', imie: 'Adam', haslo: 'h', rola: 'administrator', admin: true });
    const pusta = dodajRole(db, { nazwa: 'Bez dostępu', teraz: () => new Date() });
    przypiszRole(db, zalozKonto(db, { login: 'nikt', imie: 'Nikt', haslo: 'h', rola: pusta }), pusta);
    for (const url of ['/kolejka-druku', '/kolejka-druku-faktur']) {
      const r = await app.inject({ method: 'GET', url, headers: { ...BASIC, accept: 'application/json' } });
      expect([401, 403], url).not.toContain(r.statusCode);
    }
    for (const url of ['/kolejka-druku/999999/wydrukowano', '/kolejka-druku-faktur/999999/wydrukowano']) {
      const r = await app.inject({ method: 'POST', url, headers: { ...BASIC, ...ORIGIN, accept: 'application/json' } });
      expect([401, 403], url).not.toContain(r.statusCode);
    }
    const ekran = await app.inject({ method: 'GET', url: '/przesylki', headers: { ...BASIC, accept: 'application/json' } });
    expect(ekran.statusCode).toBe(403);
  });
});
