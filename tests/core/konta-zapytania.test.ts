import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { otworzBaze, wykonajMigracje } from '../../src/core/baza.ts';
import { rdzen as modulRdzen, dopiszLogowanieZIp } from '../pomoc/bezpieczenstwo-prz-007.ts';
import * as konta from '../../src/core/bezpieczenstwo/konta.js';
import { zgodneHaslo } from '../../src/domena/hasla.js';

// Pełne stare konta-db.test.js pozostają do PRZ-030, wraz z fabryką bazy serwera.
// Tu sprawdzamy rzeczywiste zapytania przeszczepu na obecnych migracjach rdzenia.
let db: DatabaseSync;
beforeEach(() => { db = otworzBaze(':memory:'); wykonajMigracje(db, [modulRdzen]); });
afterEach(() => db.close());

describe('zapytania kont na bazie rdzenia', () => {
  it('pusta baza pozwala na bootstrap; konto ma scrypt, unikalny login i preset ptaszków', () => {
    expect(konta.listaKont(db)).toEqual([]);
    expect(konta.czyIstniejeCzynnyAdmin(db)).toBe(false);
    expect(konta.kontoPoLoginie(db, 'nie-istnieje')).toBeNull();
    const id = konta.zalozKonto(db, { login: 'alfa', imie: 'Alfa', haslo: 'testowe', rola: 'sprzedaz' });
    const konto = konta.kontoPoLoginie(db, 'alfa')!;
    expect(konto).toMatchObject({ id, login: 'alfa', imie: 'Alfa', czynne: true, admin: false, wersja_hasla: 0 });
    expect(konto.uprawnienia.has('raporty')).toBe(true);
    expect(konto.uprawnienia.has('finanse')).toBe(false);
    const w = db.prepare('SELECT hash_hasla FROM konta WHERE id = ?').get(id)!;
    expect(w.hash_hasla).not.toBe('testowe');
    expect(zgodneHaslo('testowe', w.hash_hasla)).toBe(true);
    expect(() => konta.zalozKonto(db, { login: 'alfa', imie: 'Drugie', haslo: 'inne', rola: 'produkcja' })).toThrow();
  });

  it('admin wymaga czynnego konta; podmiana ptaszków usuwa stare, wyłączenie zachowuje historię', () => {
    const id = konta.zalozKonto(db, { login: 'alfa', imie: 'Alfa', haslo: 'testowe', rola: 'sprzedaz' });
    konta.ustawAdmina(db, id, true);
    expect(konta.czyIstniejeCzynnyAdmin(db)).toBe(true);
    konta.ustawUprawnienia(db, id, ['magazyn']);
    expect(konta.uprawnieniaKonta(db, id)).toEqual(new Set(['magazyn']));
    expect(konta.kontoPoLoginie(db, 'alfa')!.uprawnienia).toEqual(new Set(['magazyn']));
    konta.ustawCzynne(db, id, false);
    expect(konta.czyIstniejeCzynnyAdmin(db)).toBe(false);
    expect(konta.listaKont(db)).toMatchObject([{ id, czynne: false, admin: true }]);
    konta.ustawCzynne(db, id, true);
    konta.ustawAdmina(db, id, false);
    expect(konta.czyIstniejeCzynnyAdmin(db)).toBe(false);
    konta.ustawUprawnienia(db, id, []);
    expect(konta.uprawnieniaKonta(db, id)).toEqual(new Set());
  });

  it('dziennik ogranicza login i zwraca najnowsze wpisy; lista pokazuje wyłącznie udane logowanie', () => {
    konta.zalozKonto(db, { login: 'alfa', imie: 'Alfa', haslo: 'testowe', rola: 'sprzedaz' });
    dopiszLogowanieZIp(db, { login: 'alfa', usluga: 'oms', ip: '127.0.0.1', wynik: 'zle-haslo' });
    expect(konta.listaKont(db)[0].ostatnie_logowanie).toBeNull();
    konta.dopiszLogowanie(db, { login: 'alfa', usluga: 'oms', wynik: 'udane' });
    expect(konta.listaKont(db)[0].ostatnie_logowanie).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    konta.dopiszLogowanie(db, { login: 'x'.repeat(1000), usluga: 'oms', wynik: 'zle-haslo' });
    const dwa = konta.ostatnieLogowania(db, 2);
    expect(dwa).toHaveLength(2);
    expect(dwa.map((w: { login: string }) => w.login)).toEqual(['x'.repeat(64), 'alfa']);
    expect(konta.ostatnieLogowania(db, 10)).toHaveLength(3);
  });
});
