import { describe, it, expect, beforeEach } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { utworzZamowienieReczne } from '../../../src/oms/db/zamowienia-reczne.js';

let db;
beforeEach(() => { db = openOmsDb(':memory:'); });

describe('zamowienie reczne z karty indywidualnej', () => {
  it('drugie zamowienie z tym samym karta_id odbija sie od indeksu', () => {
    utworzZamowienieReczne(db, { karta_id: 'karta-1', indywidualne: 1 });
    expect(() => utworzZamowienieReczne(db, { karta_id: 'karta-1', indywidualne: 1 }))
      .toThrow(/UNIQUE|constraint/i);
  });

  it('zamowienia BEZ karty nie przeszkadzaja sobie nawzajem (indeks czesciowy)', () => {
    expect(() => {
      utworzZamowienieReczne(db, {});
      utworzZamowienieReczne(db, {});
    }).not.toThrow();
  });

  // ⚠️ TO JEST TEST MINY ZE SPECU (sekcja 7). `uzupelnijIndywidualne` (db/db.js) wykonuje
  // przy KAZDYM otwarciu bazy dokladnie ten UPDATE — a zamowienie reczne `surowe_json`
  // nie ma. Znacznik wpisany w INSERCIE ma go przezyc; znacznik dopisany „za chwile"
  // zostalby wyzerowany przy najblizszym restarcie kontenera.
  it('znacznik indywidualne przezywa przeliczenie ze startu panelu', () => {
    const id = utworzZamowienieReczne(db, { karta_id: 'karta-2', indywidualne: 1 });
    db.exec('UPDATE zamowienia SET indywidualne = 0 WHERE indywidualne IS NULL AND surowe_json IS NULL');
    const w = db.prepare('SELECT indywidualne, karta_id FROM zamowienia WHERE id = ?').get(id);
    expect(w.indywidualne).toBe(1);
    expect(w.karta_id).toBe('karta-2');
  });

  it('zwykle zamowienie telefoniczne NIE jest indywidualne', () => {
    const id = utworzZamowienieReczne(db, {});
    expect(db.prepare('SELECT indywidualne FROM zamowienia WHERE id = ?').get(id).indywidualne).toBe(0);
  });
});
