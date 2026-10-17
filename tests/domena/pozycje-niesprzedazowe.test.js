import { describe, it, expect } from 'vitest';
import { czyPozycjaWysylki, czyPozycjaNieTowar } from '../../src/domena/pozycje-niesprzedazowe.js';

describe('czyPozycjaWysylki', () => {
  it('rozpoznaje transport po nazwie, jaką wysyła wtyczka', () => {
    for (const n of ['wysyłka kurierem DPD', 'Wysylka kurierem', 'Kurier DPD (pobranie)',
      'Dostawa', 'Usługa kurierska', 'Paczka za pobraniem']) {
      expect(czyPozycjaWysylki(n)).toBe(true);
    }
  });

  it('lampa NIE jest transportem', () => {
    expect(czyPozycjaWysylki('lampa wisząca na zamówienie - klosz mleczny, mosiądz')).toBe(false);
  });

  // ⚠️ TA GRANICA JEST CAŁYM POWODEM, dla którego istnieją dwie funkcje, a nie jedna lista.
  // Ekspres nie jest transportem: zamówienie z ekspresem, ale bez wysyłki, ma dalej pokazywać
  // wiersz „Wysyłka" na karcie.
  it('realizacja priorytetowa NIE jest transportem, ale NIE jest też towarem', () => {
    expect(czyPozycjaWysylki('Realizacja priorytetowa')).toBe(false);
    expect(czyPozycjaNieTowar('Realizacja priorytetowa')).toBe(true);
  });

  it('brak nazwy nie wywraca reguły', () => {
    expect(czyPozycjaWysylki(null)).toBe(false);
    expect(czyPozycjaNieTowar(undefined)).toBe(false);
  });
});
