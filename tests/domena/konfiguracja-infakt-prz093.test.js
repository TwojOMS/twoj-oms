// PRZ-093.10 — formularz Ustawienia → Integracje → inFakt: sam klucz API (sekret). Adres API nie jest polem
// formularza — zawsze produkcyjny inFakt; inny tylko w pliku razem z INFAKT_API_KEY.
import { describe, it, expect } from 'vitest';
import { sprawdzFormularzInfakt, opcjeKlientaInfakt, ADRES_INFAKT, EKRAN_INFAKTU } from '../../src/domena/konfiguracja-infakt.js';

const KLUCZ = 'zmyslony0klucz0api0infakt0prz093000000b2';

describe('PRZ-093.10 formularz inFaktu', () => {
  it('poprawny klucz: sekret apiKey, bez ustawień jawnych, bez błędów; spacje na brzegach obcięte', () => {
    expect(sprawdzFormularzInfakt({ apiKey: ` ${KLUCZ}\n` })).toEqual({ ustawienia: {}, sekrety: { apiKey: KLUCZ }, bledy: [] });
  });

  it('adres z formularza jest ignorowany — nie ma takiego pola', () => {
    const w = sprawdzFormularzInfakt({ apiKey: KLUCZ, baseUrl: 'https://obcy.invalid/api', url: 'https://obcy.invalid' });
    expect(JSON.stringify(w)).not.toContain('obcy.invalid');
    expect(opcjeKlientaInfakt({ ustawienia: { baseUrl: 'https://obcy.invalid' }, sekrety: { apiKey: KLUCZ } }))
      .toEqual({ apiKey: KLUCZ, baseUrl: ADRES_INFAKT });
    expect(ADRES_INFAKT).toBe('https://api.infakt.pl/api');
    expect(EKRAN_INFAKTU).toBe('/ustawienia/integracje/infakt');
  });

  it('brak klucza: bez zapisu — błąd; z zapisem — błąd „wpisz nowy”, zapisany zostaje', () => {
    expect(sprawdzFormularzInfakt({}).bledy).toEqual(['Podaj klucz API inFaktu.']);
    const z = sprawdzFormularzInfakt({ apiKey: '' }, { sekrety: { apiKey: KLUCZ } });
    expect(z.bledy).toEqual(['Wpisz nowy klucz API — zapisany klucz zostaje bez zmian.']);
    expect(z.sekrety.apiKey).toBe(KLUCZ);
  });

  it('klucz ze spacją w środku, za krótki albo za długi: błąd, a komunikat nie cytuje wpisanej wartości', () => {
    for (const zly of ['abc def ghi jkl mno', 'krotki', 'x'.repeat(201)]) {
      const w = sprawdzFormularzInfakt({ apiKey: zly });
      expect(w.bledy).toHaveLength(1);
      expect(w.bledy[0].includes(zly)).toBe(false);
    }
  });
});
