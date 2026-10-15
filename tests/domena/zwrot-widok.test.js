import { describe, it, expect } from 'vitest';
import { podsumowanieZwrotow } from '../../src/domena/zwrot-widok.js';

describe('podsumowanie zwrotow na karcie', () => {
  it('oddaje null, gdy zwrotow nie ma — karta ma wtedy nie rysowac NICZEGO', () => {
    expect(podsumowanieZwrotow({ zwroty: [] })).toBeNull();
    expect(podsumowanieZwrotow({})).toBeNull();
  });

  it('sumuje pozycje i dostawe po wszystkich zwrotach', () => {
    const z = {
      faktura: null,
      zwroty: [
        { kwota: '99.00', kwota_dostawy: '19.00', pieniadze_oddane_at: '2026-08-15T09:00:00Z' },
        { kwota: '10.90', kwota_dostawy: null, pieniadze_oddane_at: null },
      ],
    };
    expect(podsumowanieZwrotow(z)).toEqual({ sumaZl: '128.90', ile: 2, nierozliczonych: 1 });
  });
});
