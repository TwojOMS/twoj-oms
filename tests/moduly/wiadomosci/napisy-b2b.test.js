import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { MODULY_OPCJONALNE } from '../../../src/domena/moduly-opcjonalne.js';

const czytaj = (sciezka) => readFileSync(new URL(`../../../${sciezka}`, import.meta.url), 'utf8');

describe('„Stali klienci” → „Klienci B2B” (napisy)', () => {
  it('moduł opcjonalny w Ustawieniach nazywa się „Klienci B2B”', () => {
    const modul = MODULY_OPCJONALNE.find((m) => m.klucz === 'klienci');
    expect(modul.nazwa).toBe('Klienci B2B');
    expect(modul.opis).toContain('klientów B2B');
    expect(modul.opis).not.toMatch(/stałych klient/i);
  });

  it('link powrotny w karcie klienta prowadzi do „Klienci B2B”', () => {
    const widok = czytaj('src/moduly/wiadomosci/widoki/klient.ejs');
    expect(widok).toContain('← Klienci B2B');
    expect(widok).not.toContain('Stali klienci');
  });

  it('ustawienia modułów liczą „klientów B2B”', () => {
    const widok = czytaj('src/moduly/ustawienia/widoki/ustawienia-moduly.ejs');
    expect(widok).toContain('klientów B2B z rabatem');
    expect(widok).toContain('klientów B2B z rozliczeniem zbiorczym');
    expect(widok).not.toMatch(/stałych klientów/);
  });

  it('opis GUS i przycisk na zamówieniu mówią „Klienci B2B” / „klienta B2B”', () => {
    const gus = czytaj('src/moduly/zamowienia/widoki/ustawienia-gus.ejs');
    expect(gus).toContain('w Klientach B2B');
    expect(gus).toContain('Klientów B2B zostają');
    expect(gus).not.toMatch(/Stałych klient/);
    const zam = czytaj('src/moduly/zamowienia/widoki/zamowienie.ejs');
    expect(zam).toContain('Uaktualnij dane klienta B2B');
    expect(zam).not.toContain('Uaktualnij dane stałego klienta');
  });

  it('komunikat blokady wyłączenia modułu i wpis w logu mówią „klientów B2B”', () => {
    const baza = czytaj('src/oms/db/moduly-opcjonalne.js');
    expect(baza).toContain('klientów B2B z rozliczeniem zbiorczym');
    const karta = czytaj('src/moduly/zamowienia/karta.js');
    expect(karta).toContain('klienta B2B „${dane.nazwa}');
  });
});
