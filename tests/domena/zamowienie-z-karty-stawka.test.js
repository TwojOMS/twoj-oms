import { describe, it, expect } from 'vitest';
import { parsujZamowienieZKarty } from '../../src/domena/zamowienie-z-karty.js';

// PRZ-105: pozycje zamówienia z karty (API panelu zamówień indywidualnych) dostają stawkę domyślną z Ustawień,
// podaną przez trasę — nie wbudowane 23. Panel wysyła brutto, więc kwoty się nie zmieniają, tylko stawka.
describe('parsujZamowienieZKarty — stawka VAT pozycji (PRZ-105)', () => {
  const body = { kartaId: 'K-1', pozycje: [{ nazwa: 'Lampa na wymiar', ilosc: '1', cena_brutto: '105.00' }] };

  it('bez pola vat → stawka domyślna podana przez trasę', () => {
    expect(parsujZamowienieZKarty(body, { stawkaDomyslna: '5' }).pozycje[0].vat).toBe('5');
  });

  it('pozycja z vat spoza listy → odmowa z numerem pozycji', () => {
    const zle = { ...body, pozycje: [{ ...body.pozycje[0], vat: '22' }] };
    expect(() => parsujZamowienieZKarty(zle, { stawkaDomyslna: '23' })).toThrow(/Pozycja 1:.*stawk/i);
  });
});
