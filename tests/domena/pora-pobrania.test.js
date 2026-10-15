import { describe, it, expect } from 'vitest';
import { czyPoraPobrania } from '../../src/domena/pora-pobrania.js';

describe('pora nocnego pobrania', () => {
  it('godzina 3 w Warszawie to pora pobrania', () => {
    expect(czyPoraPobrania(new Date('2026-08-12T01:30:00Z'))).toBe(true); // 03:30 CEST
  });

  it('poludnie nie jest pora pobrania', () => {
    expect(czyPoraPobrania(new Date('2026-08-12T10:00:00Z'))).toBe(false);
  });

  // ⚠️ Cała treść tego modułu to jedno zdanie o strefie — a strefa Warszawy zmienia
  // przesunięcie dwa razy w roku. Test wyłącznie letni przeszedłby także wtedy, gdyby
  // godzina liczyła się na sztywno „UTC + 2".
  it('⚠️ dziala takze zima, gdy przesuniecie wynosi godzine', () => {
    expect(czyPoraPobrania(new Date('2026-01-15T02:30:00Z'))).toBe(true); // 03:30 CET
    expect(czyPoraPobrania(new Date('2026-01-15T01:30:00Z'))).toBe(false); // 02:30 CET
  });

  // Godzina 3 w Warszawie to CAŁA godzina 03:00–03:59, a nie punkt — zegar czuwacza tyka
  // co godzinę i nie ma obowiązku trafić w równą minutę.
  it('cala godzina 3 jest pora pobrania, nie tylko rowna godzina', () => {
    expect(czyPoraPobrania(new Date('2026-08-12T01:00:00Z'))).toBe(true); // 03:00 CEST
    expect(czyPoraPobrania(new Date('2026-08-12T01:59:59Z'))).toBe(true); // 03:59 CEST
    expect(czyPoraPobrania(new Date('2026-08-12T02:00:00Z'))).toBe(false); // 04:00 CEST
  });

  it('godzina jest parametrem — 4:00 dla archiwum sprzedazy, a 3:00 wtedy nie jest pora', () => {
    expect(czyPoraPobrania(new Date('2026-08-12T02:30:00Z'), 4)).toBe(true);  // 04:30 CEST
    expect(czyPoraPobrania(new Date('2026-08-12T01:30:00Z'), 4)).toBe(false); // 03:30 CEST
  });
});
