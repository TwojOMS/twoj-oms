import { it, expect } from 'vitest';
import { openOmsDb } from '../../src/oms/db/db.ts';
import { ukryteTypyKonta, zapiszUkryteTypy, rodzajeNiewidoczneDlaFirmy } from '../../src/oms/db/powiadomienia.js';

it('bez id nic nie ukrywa i odmawia zapisu; uszkodzony zapis też pokazuje wszystko', () => {
  const db = openOmsDb(':memory:');
  try {
    expect(ukryteTypyKonta(db, undefined)).toEqual([]);
    expect(() => zapiszUkryteTypy(db, undefined, [])).toThrow();
    expect(rodzajeNiewidoczneDlaFirmy(db)).toEqual([]);
    for (const wartosc of ['{', 'null', '["nieznany"]']) {
      db.prepare('INSERT OR REPLACE INTO ustawienia (klucz, wartosc, zmienione_at) VALUES (?, ?, ?)')
        .run('powiadomienia.ukryte.1', wartosc, '2026-01-01');
      expect(ukryteTypyKonta(db, 1)).toEqual([]);
    }
    zapiszUkryteTypy(db, 1, ['faktura-ksef']);
    expect(ukryteTypyKonta(db, 1)).toEqual(['faktura-ksef']);
    expect(ukryteTypyKonta(db, 2)).toEqual([]);
    expect(() => zapiszUkryteTypy(db, 1, ['nieznany'])).toThrow();
    expect(ukryteTypyKonta(db, 1)).toEqual(['faktura-ksef']);
  } finally { db.close(); }
});
