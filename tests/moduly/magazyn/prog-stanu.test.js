// Zapis progu niskiego stanu z karty: osobna trasa POST /magazyn/:id/prog-stanu.
// Puste pole kasuje próg, liczba całkowita ≥ 0 go ustawia, reszta to 400 bez zapisu. Dane zmyślone.
import { beforeEach, afterEach, describe, it, expect } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { buildOmsServer } from '../../pomoc/serwer-testowy-oms.ts';
import { utworzKarte, zapiszKarte } from '../../../src/oms/db/magazyn.js';
import { zalozKonto } from '../../../src/core/bezpieczenstwo/konta.js';

const auth = { authorization: `Basic ${Buffer.from('operator:x').toString('base64')}`, origin: 'http://localhost' };
let db, app;

beforeEach(() => {
  db = openOmsDb(':memory:');
  app = buildOmsServer({
    db,
    config: { auth: { user: 'operator', pass: 'x' } },
    magazyn: { stan: () => ({ trwa: false }) },
  });
});
afterEach(async () => {
  await app.close();
  db.close();
});

const zapisz = (id, payload) =>
  app.inject({ method: 'POST', url: `/magazyn/${id}/prog-stanu`, headers: auth, payload });
const wiersz = (id) =>
  db.prepare('SELECT prog_niskiego_stanu AS prog, zmieniony_at FROM karty_produktow WHERE id = ?').get(id);

describe('POST /magazyn/:id/prog-stanu — zapis', () => {
  it('„2” zapisuje próg 2 i wraca do sekcji stanu karty', async () => {
    const id = utworzKarte(db, { nazwa: 'Lampa Półcień' });
    const r = await zapisz(id, { prog_niskiego_stanu: '2' });
    expect(r.statusCode).toBe(303);
    expect(r.headers.location).toBe(`/magazyn/${id}?zapisano=prog-stanu#stan-karty`);
    expect(wiersz(id).prog).toBe(2);
  });

  it('„0” to próg zero, nie brak progu', async () => {
    const id = utworzKarte(db, { nazwa: 'Lampa Półcień' });
    await zapisz(id, { prog_niskiego_stanu: '0' });
    expect(wiersz(id).prog).toBe(0);
  });

  it('puste pole kasuje ustawiony próg', async () => {
    const id = utworzKarte(db, { nazwa: 'Lampa Półcień' });
    zapiszKarte(db, id, { prog_niskiego_stanu: 3 });
    const r = await zapisz(id, { prog_niskiego_stanu: '' });
    expect(r.statusCode).toBe(303);
    expect(wiersz(id).prog).toBe(null);
  });

  it('ten sam próg drugi raz nie zmienia daty zmiany karty', async () => {
    const id = utworzKarte(db, { nazwa: 'Lampa Półcień' }, { at: '2026-11-01T10:00:00.000Z' });
    zapiszKarte(db, id, { prog_niskiego_stanu: 2 }, { at: '2026-11-02T10:00:00.000Z' });
    await zapisz(id, { prog_niskiego_stanu: '2' });
    expect(wiersz(id)).toEqual({ prog: 2, zmieniony_at: '2026-11-02T10:00:00.000Z' });
  });
});

describe('POST /magazyn/:id/prog-stanu — odmowy bez zapisu', () => {
  it('bez Origin i Referer odmawia zapisu progu', async () => {
    const id = utworzKarte(db, { nazwa: 'Lampa Półcień' });
    zapiszKarte(db, id, { prog_niskiego_stanu: 4 });
    const r = await app.inject({
      method: 'POST',
      url: `/magazyn/${id}/prog-stanu`,
      headers: { authorization: auth.authorization },
      payload: { prog_niskiego_stanu: '2' },
    });
    expect(r.statusCode).toBe(403);
    expect(wiersz(id).prog).toBe(4);
  });

  it('konto bez uprawnienia magazyn nie zapisuje progu', async () => {
    const id = utworzKarte(db, { nazwa: 'Lampa Półcień' });
    zapiszKarte(db, id, { prog_niskiego_stanu: 4 });
    zalozKonto(db, { login: 'pakowacz', imie: 'Jan', haslo: 'x', rola: 'produkcja', admin: false });
    const login = await app.inject({
      method: 'POST',
      url: '/login',
      headers: { origin: auth.origin },
      payload: { uzytkownik: 'pakowacz', haslo: 'x' },
    });
    expect(login.statusCode).toBe(302);
    const cookie = []
      .concat(login.headers['set-cookie'] ?? [])
      .map((c) => c.split(';')[0])
      .join('; ');
    const r = await app.inject({
      method: 'POST',
      url: `/magazyn/${id}/prog-stanu`,
      headers: { origin: auth.origin, cookie },
      payload: { prog_niskiego_stanu: '2' },
    });
    expect(r.statusCode).toBe(403);
    expect(wiersz(id).prog).toBe(4);
  });

  it.each(['-1', 'abc', '1,5'])('„%s” → 400, próg bez zmian', async (tekst) => {
    const id = utworzKarte(db, { nazwa: 'Lampa Półcień' });
    zapiszKarte(db, id, { prog_niskiego_stanu: 4 });
    const r = await zapisz(id, { prog_niskiego_stanu: tekst });
    expect(r.statusCode).toBe(400);
    expect(r.body).toContain('liczba całkowita');
    expect(wiersz(id).prog).toBe(4);
  });

  it('brak pola w formularzu → 400, próg nie znika', async () => {
    const id = utworzKarte(db, { nazwa: 'Lampa Półcień' });
    zapiszKarte(db, id, { prog_niskiego_stanu: 4 });
    const r = await zapisz(id, {});
    expect(r.statusCode).toBe(400);
    expect(wiersz(id).prog).toBe(4);
  });

  it('nieznana karta → 404', async () => {
    const r = await zapisz(999999, { prog_niskiego_stanu: '2' });
    expect(r.statusCode).toBe(404);
  });

  it('bez logowania nic nie zapisuje', async () => {
    const id = utworzKarte(db, { nazwa: 'Lampa Półcień' });
    const r = await app.inject({
      method: 'POST',
      url: `/magazyn/${id}/prog-stanu`,
      headers: { origin: 'http://localhost' },
      payload: { prog_niskiego_stanu: '2' },
    });
    expect(r.statusCode).toBe(401);
    expect(wiersz(id).prog).toBe(null);
  });
});
