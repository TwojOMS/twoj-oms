import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { otworzBaze, wykonajMigracje } from '../../src/core/baza.ts';
import { rdzen as modulRdzen, zalozKontoZPtaszkami as zalozKonto } from '../pomoc/bezpieczenstwo-prz-007.ts';
import { kontoPoLoginie, zmienHaslo, uprawnieniaKonta } from '../../src/core/bezpieczenstwo/konta.js';
import { zgodneHaslo } from '../../src/domena/hasla.js';

describe('rdzen/3 — wersja hasła', () => {
  it.each([false, true])('zachowuje konta i uprawnienia starej bazy=%s i wykonuje się raz', (stara) => {
    const db = otworzBaze(':memory:');
    try {
      if (stara) db.exec(readFileSync(new URL('../../src/moduly/rdzen/migracje/0001-baseline.sql', import.meta.url), 'utf8'));
      else wykonajMigracje(db, [{ ...modulRdzen, migracje: modulRdzen.migracje.filter((m) => m.numer < 3) }]);
      const id = zalozKonto(db, { login: 'syntetyczne', imie: 'Test', haslo: 'testowe-haslo', rola: 'sprzedaz', ekrany: ['zamowienia'] });
      const przed = db.prepare('SELECT * FROM konta WHERE id = ?').get(id)!;
      const wynik = wykonajMigracje(db, [modulRdzen]);
      expect(wynik.some((m) => m.modul === 'rdzen' && m.numer === 3)).toBe(true);
      expect(db.prepare('SELECT * FROM konta WHERE id = ?').get(id)).toEqual({ ...przed, wersja_hasla: 0 });
      expect(uprawnieniaKonta(db, id)).toEqual(new Set(['zamowienia']));
      expect(wykonajMigracje(db, [modulRdzen])).toEqual([]);
      expect(db.prepare('SELECT * FROM konta WHERE id = ?').get(id)).toEqual({ ...przed, wersja_hasla: 0 });
      expect(() => db.prepare('UPDATE konta SET wersja_hasla = NULL WHERE id = ?').run(id)).toThrow();
      const nowe = zalozKonto(db, { login: 'nowe', imie: 'Nowe', haslo: 'inne-haslo', rola: 'sprzedaz' });
      expect(db.prepare('SELECT wersja_hasla FROM konta WHERE id = ?').get(nowe)).toEqual({ wersja_hasla: 0 });
    } finally { db.close(); }
  });

  it('zmiana hasła zwiększa wersję tego konta i utrzymuje prawdziwy scrypt', () => {
    const db = otworzBaze(':memory:');
    try {
      wykonajMigracje(db, [modulRdzen]);
      const a = zalozKonto(db, { login: 'alfa', imie: 'Alfa', haslo: 'pierwsze', rola: 'sprzedaz' });
      zalozKonto(db, { login: 'beta', imie: 'Beta', haslo: 'drugie', rola: 'sprzedaz' });
      zmienHaslo(db, a, 'nowe');
      zmienHaslo(db, a, 'najnowsze');
      expect(kontoPoLoginie(db, 'alfa')?.wersja_hasla).toBe(2);
      expect(kontoPoLoginie(db, 'beta')?.wersja_hasla).toBe(0);
      const w = db.prepare('SELECT hash_hasla FROM konta WHERE id = ?').get(a)!;
      expect(zgodneHaslo('pierwsze', w.hash_hasla)).toBe(false);
      expect(zgodneHaslo('nowe', w.hash_hasla)).toBe(false);
      expect(zgodneHaslo('najnowsze', w.hash_hasla)).toBe(true);
    } finally { db.close(); }
  });
});
