import { describe, it, expect } from 'vitest';
import { czyTestowe } from '../../pomoc/raporty-parytetu.js';

describe('czyTestowe — adresy własne', () => {
  it('wyklucza zamówienia właściciela', () => {
    expect(czyTestowe('anna.wzorcowa@example.test', 'Anna Wzorcowa')).toBe(true);
  });

  // Zgłoszone przez właściciela 13.09.2026 jako jego testy — 3 zamówienia w bazie produkcyjnej
  // (28196, 1297, R/2026/016) liczyły się do raportów.
  it('wyklucza zamówienia Agi', () => {
    expect(czyTestowe('jan.wzorcowy@example.test', 'Jan Wzorcowy')).toBe(true);
  });

  it('wyklucza testpsm-klient@example.com dwoma niezależnymi wzorcami', () => {
    expect(czyTestowe('testpsm-klient@example.com', 'Klient')).toBe(true);
    expect(czyTestowe('testpsm-klient@swietlik.example.test', 'Klient')).toBe(true);
    expect(czyTestowe('ktos@example.com', 'Klient')).toBe(true);
  });

  // ⚠️ Bariera na przesadę: prawdziwa klientka o tym samym nazwisku NIE MOŻE wypaść
  // z raportu. Dopasowanie jest po PEŁNYM adresie, nie po nazwisku.
  it('nie wyklucza obcego adresu o podobnym nazwisku', () => {
    expect(czyTestowe('a.wzorcowa@firma.example.test', 'Anna Wzorcowa')).toBe(false);
    expect(czyTestowe('jan.wzorcowy@onet.example.test', 'Jan Wzorcowy')).toBe(false);
  });
});
