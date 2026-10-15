// PRZ-068/069, recenzja D8 r1 (P3-8): scrypt NIE liczy się wewnątrz BEGIN IMMEDIATE — inaczej blokada zapisu
// całej bazy trwa tyle co haszowanie (dziesiątki ms na każde konto/hasło z linku). Atrapa `zahaszuj` zapisuje,
// czy w chwili wywołania baza była w transakcji; prawdziwe haszowanie liczy się dalej (oryginał).
import { describe, it, expect, vi, beforeEach } from 'vitest';

const stan = vi.hoisted(() => ({ db: null, wTransakcji: [] }));
vi.mock('../../../src/domena/hasla.js', async (oryginal) => {
  const m = await oryginal();
  return { ...m, zahaszuj: (h) => { stan.wTransakcji.push(Boolean(stan.db?.isTransaction)); return m.zahaszuj(h); } };
});

const { zalozKonto, kontoPoLoginie } = await import('../../../src/core/bezpieczenstwo/konta.js');
const { zgodneHaslo } = await import('../../../src/domena/hasla.js');
const { wydajLink } = await import('../../../src/moduly/ustawienia/linki-hasla.js');
const { nowyPanel, jako, post } = await import('../../pomoc/konta-prz068.js');

function panel() {
  const p = nowyPanel();
  stan.db = p.db;
  zalozKonto(p.db, { login: 'adam', imie: 'Adam', haslo: 'h', rola: 'administrator', admin: true });
  return { ...p, admin: jako(p.db, 'adam') };
}

describe('P3-8: haszowanie hasła przed transakcją', () => {
  beforeEach(() => { stan.wTransakcji = []; });

  it('/ustawienia/konta/nowe z hasłem: scrypt poza BEGIN IMMEDIATE, konto i rola zapisane razem', async () => {
    const { db, app, admin } = panel();
    stan.wTransakcji = [];
    const r = await post(app, '/ustawienia/konta/nowe', admin, { login: 'pako', imie: 'Pako', haslo: 'haslo-pako-123', rola: 'produkcja' });
    expect(r.statusCode).toBe(302);
    expect(stan.wTransakcji.length).toBeGreaterThan(0);
    expect(stan.wTransakcji.every((w) => w === false)).toBe(true);
    const konto = kontoPoLoginie(db, 'pako');
    expect(zgodneHaslo('haslo-pako-123', db.prepare('SELECT hash_hasla FROM konta WHERE id = ?').get(konto.id).hash_hasla)).toBe(true);
    expect(db.prepare('SELECT rola FROM konta WHERE id = ?').get(konto.id).rola).toBe('produkcja');
  });

  it('/haslo/:token: scrypt poza transakcją użycia linku, hasło ustawione', async () => {
    const { db, app } = panel();
    const id = zalozKonto(db, { login: 'ewa', imie: 'Ewa', haslo: 'stare-haslo-123', rola: 'sprzedaz' });
    const { token } = wydajLink(db, { kontoId: id, cel: 'reset', teraz: () => new Date() });
    stan.wTransakcji = [];
    const r = await post(app, `/haslo/${token}`, {}, { nowe: 'nowe-haslo-12345', nowe2: 'nowe-haslo-12345' });
    expect(r.statusCode).toBe(302);
    expect(stan.wTransakcji.length).toBeGreaterThan(0);
    expect(stan.wTransakcji.every((w) => w === false)).toBe(true);
    expect(zgodneHaslo('nowe-haslo-12345', db.prepare('SELECT hash_hasla FROM konta WHERE id = ?').get(id).hash_hasla)).toBe(true);
  });
});
