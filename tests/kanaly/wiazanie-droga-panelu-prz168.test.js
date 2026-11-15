import { describe, expect, it } from 'vitest';
import { komunikatBrakuDrogiPotwierdzenia } from '../../src/domena/wiazanie-kanalu.js';

describe('odmowa nadpisania tokenów Allegro (PRZ-168)', () => {
  it('pierwsza droga prowadzi do zakładki Moje połączenia i przycisku „Połącz z Allegro”', () => {
    expect(komunikatBrakuDrogiPotwierdzenia())
      .toContain('Ustawienia → Integracje → Moje połączenia → „Połącz z Allegro” przy tym koncie');
  });
});
