import { describe, it, expect } from 'vitest';
import { zastrzezenia } from '../pomoc/raporty-parytetu.js';

describe('zastrzezenia do okresu sprzed ery Apilo', () => {
  it('okres w calosci po granicy nie ma zastrzezen', () => {
    expect(zastrzezenia({ od: '2025-01-01', sufitApilo: '2024-10-07' })).toEqual([]);
  });

  it('okres siegajacy przed granice mowi, ze to WYLACZNIE sklep', () => {
    const z = zastrzezenia({ od: '2016-01-01', sufitApilo: '2024-10-07' });
    expect(z.join(' ')).toMatch(/wyłącznie sprzedaż sklepu szkicownia\.pl/i);
    expect(z.join(' ')).toMatch(/Allegro/);
  });

  it('mowi tez, ze nie ma danych klienta ani podzialu faktura/paragon', () => {
    const z = zastrzezenia({ od: '2016-01-01', sufitApilo: '2024-10-07' });
    expect(z.join(' ')).toMatch(/nowych ani powracających/i);
    expect(z.join(' ')).toMatch(/faktura \/ paragon/i);
    expect(z.join(' ')).toMatch(/bez danych klienta/i);
  });

  it('BEZ GRANICY NIE UDAJE, ZE WIE — mowi wprost, ze nie wie', () => {
    expect(zastrzezenia({ od: '2016-01-01', sufitApilo: null }).join(' '))
      .toMatch(/nie wiadomo, gdzie przebiega granica/i);
  });

  it('dzien granicy jest juz era Apilo — bez zastrzezen', () => {
    expect(zastrzezenia({ od: '2024-10-07', sufitApilo: '2024-10-07' })).toEqual([]);
  });
});
