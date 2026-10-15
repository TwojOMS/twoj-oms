import { describe, it, expect } from 'vitest';
import { zlotowki } from '../../src/domena/kwoty.js';

describe('zlotowki', () => {
  it('zamienia kropkę dziesiętną na przecinek i dokleja "zł"', () => {
    expect(zlotowki('990.00')).toBe('990,00 zł');
    expect(zlotowki('590.00')).toBe('590,00 zł');
  });

  // ⚠️⚠️ STRAŻNIK PUSTKI (recenzja 22.08.2026): prywatna kopia tej funkcji w
  // domain/blok-platnosci.js (usunięta tym przeglądem, przy przeprowadzce tutaj) tej straży
  // NIE MIAŁA — pustą/nieznaną kwotę zamieniała na " zł" zamiast na „—", inaczej niż kopia
  // w domain/potwierdzenie-zamowienia.js. `zlotowki` jest teraz JEDNYM miejscem formatowania
  // kwoty dla maili i komunikatów operatora, więc ten strażnik pilnuje obu stron na raz.
  it('pustą albo nieznaną kwotę oddaje jako „—", nie " zł"', () => {
    expect(zlotowki('')).toBe('—');
    expect(zlotowki(null)).toBe('—');
    expect(zlotowki(undefined)).toBe('—');
    expect(zlotowki('   ')).toBe('—');
  });
});
