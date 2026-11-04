import { describe, expect, it } from 'vitest';
import { sprawdzZmianeMetody } from '../../src/domena/wysylka.js';

describe('PRZ-145.02 — kwota pobrania na karcie', () => {
  it.each(['1e2', '0.005', '12.345'])('odrzuca zapis %s', (kwota) => {
    const wynik = sprawdzZmianeMetody('dpd', true, kwota);
    expect(wynik.blad).toBeTruthy();
    expect(wynik.nadpisanie).toBeNull();
  });
  it.each([['12,50', '12.50'], ['150.00', '150.00']])('zapisuje %s jako %s', (kwota, oczekiwana) => {
    expect(sprawdzZmianeMetody('dpd', true, kwota)).toEqual({
      nadpisanie: { metoda: 'dpd', pobranie: 1, kwota_pobrania: oczekiwana }, blad: null,
    });
  });
  it.each(['0', '-10.00'])('zachowuje komunikat o kwocie większej od zera dla %s', (kwota) => {
    expect(sprawdzZmianeMetody('dpd', true, kwota).blad).toContain('większa od zera');
  });
});
