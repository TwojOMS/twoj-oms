import { describe, it, expect } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import {
  stanWeryfikacji, zapiszStanWeryfikacji, kanalyZOtwartymBezpiecznikiem,
} from '../../../src/oms/db/stan-weryfikacji.js';

const baza = () => openOmsDb(':memory:');

describe('stan bezpiecznika weryfikacji — zapis i odczyt', () => {
  it('nieznany kanał nie ma stanu i NIE rzuca', () => {
    expect(stanWeryfikacji(baza(), 'allegro_szkicownia')).toBeUndefined();
  });

  it('zapisuje i oddaje stan kanału', () => {
    const db = baza();
    zapiszStanWeryfikacji(db, 'allegro_szkicownia', {
      kolejnePuste: 3, bezpiecznikOd: '2026-08-28T12:00:00Z', ostatniaProbaAt: '2026-08-28T12:00:00Z',
    });
    const s = stanWeryfikacji(db, 'allegro_szkicownia');
    expect(s.kolejne_puste).toBe(3);
    expect(s.bezpiecznik_od).toBe('2026-08-28T12:00:00Z');
    expect(s.ostatnia_proba_at).toBe('2026-08-28T12:00:00Z');
  });

  it('drugi zapis AKTUALIZUJE ten sam wiersz, nie dokłada drugiego', () => {
    const db = baza();
    zapiszStanWeryfikacji(db, 'allegro_szkicownia', { kolejnePuste: 1, bezpiecznikOd: null, ostatniaProbaAt: 'a' });
    zapiszStanWeryfikacji(db, 'allegro_szkicownia', { kolejnePuste: 2, bezpiecznikOd: null, ostatniaProbaAt: 'b' });
    expect(stanWeryfikacji(db, 'allegro_szkicownia').kolejne_puste).toBe(2);
    expect(db.prepare('SELECT COUNT(*) AS n FROM stan_weryfikacji_allegro').get().n).toBe(1);
  });

  it('kanały są od siebie NIEZALEŻNE — jeden zepsuty nie zamyka drugiego', () => {
    const db = baza();
    zapiszStanWeryfikacji(db, 'allegro_szkicownia', { kolejnePuste: 3, bezpiecznikOd: 'x', ostatniaProbaAt: 'x' });
    expect(stanWeryfikacji(db, 'allegro_amarka')).toBeUndefined();
  });

  it('zamknięcie bezpiecznika zapisuje NULL, a nie napis "null"', () => {
    const db = baza();
    zapiszStanWeryfikacji(db, 'allegro_szkicownia', { kolejnePuste: 3, bezpiecznikOd: 'x', ostatniaProbaAt: 'x' });
    zapiszStanWeryfikacji(db, 'allegro_szkicownia', { kolejnePuste: 0, bezpiecznikOd: null, ostatniaProbaAt: 'y' });
    expect(stanWeryfikacji(db, 'allegro_szkicownia').bezpiecznik_od).toBe(null);
  });

  it('lista otwartych bezpieczników pomija kanały zamknięte', () => {
    const db = baza();
    zapiszStanWeryfikacji(db, 'allegro_szkicownia', { kolejnePuste: 3, bezpiecznikOd: '2026-08-20T10:00:00Z', ostatniaProbaAt: 'x' });
    zapiszStanWeryfikacji(db, 'allegro_amarka', { kolejnePuste: 0, bezpiecznikOd: null, ostatniaProbaAt: 'y' });
    const otwarte = kanalyZOtwartymBezpiecznikiem(db);
    expect(otwarte).toHaveLength(1);
    expect(otwarte[0].kanal).toBe('allegro_szkicownia');
    expect(otwarte[0].bezpiecznik_od).toBe('2026-08-20T10:00:00Z');
  });

  it('pusta baza oddaje pustą listę otwartych, nie null', () => {
    expect(kanalyZOtwartymBezpiecznikiem(baza())).toEqual([]);
  });
});
