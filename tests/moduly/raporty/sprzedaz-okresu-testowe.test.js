import { describe, it, expect } from 'vitest';
import { czyTestowe } from '../../pomoc/raporty-parytetu.js';

describe('czyTestowe — adresy własne', () => {
  it('wyklucza zamówienia właściciela', () => {
    expect(czyTestowe('wlasciciel@example.com', 'Marek Zywiecki')).toBe(true);
  });

  // Zgłoszone przez właściciela 13.09.2026 jako jego testy — 3 zamówienia w bazie produkcyjnej
  // (28196, 1297, R/2026/016) liczyły się do raportów.
  it('wyklucza zamówienia Agi', () => {
    expect(czyTestowe('ewa.zywiecki@gmail.com', 'Ewa Zywiecki')).toBe(true);
  });

  it('wyklucza testpsm-klient@example.com dwoma niezależnymi wzorcami', () => {
    expect(czyTestowe('testpsm-klient@example.com', 'Klient')).toBe(true);
    expect(czyTestowe('testpsm-klient@szkicownia.pl', 'Klient')).toBe(true);
    expect(czyTestowe('ktos@example.com', 'Klient')).toBe(true);
  });

  // ⚠️ Bariera na przesadę: prawdziwa klientka o tym samym nazwisku NIE MOŻE wypaść
  // z raportu. Dopasowanie jest po PEŁNYM adresie, nie po nazwisku.
  it('nie wyklucza obcego adresu o podobnym nazwisku', () => {
    expect(czyTestowe('a.zywiecki@firma.pl', 'Anna Zywiecki')).toBe(false);
    expect(czyTestowe('ewa.zywiecki@onet.pl', 'Ewa Zywiecki')).toBe(false);
  });
});
