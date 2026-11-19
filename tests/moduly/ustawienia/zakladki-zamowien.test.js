import { describe, it, expect } from 'vitest';
import { modelNawigacjiUstawien } from '../../../src/domena/podmenu-ustawien.js';

describe('dział „Zamówienia” w Ustawieniach', () => {
  it('ma jedną zakładkę „Statusy zamówień”; ustawienia magazynu są w Magazynie', () => {
    const m = modelNawigacjiUstawien('/ustawienia/statusy', { admin: true });
    expect(m.zakladki.map((z) => z.etykieta)).toEqual(['Statusy zamówień']);
    expect(m.dzialy.map((d) => d.etykieta)).toContain('Zamówienia');
    expect(m.dzialy.map((d) => d.etykieta)).not.toContain('Zamówienia i magazyn');
  });
});
