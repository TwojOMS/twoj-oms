import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const layout = readFileSync('src/public/oms-uklad.css', 'utf8');
const wartosc = (nazwa) => layout.match(new RegExp(`--${nazwa}:\\s*(#[0-9a-f]{6})`, 'i'))?.[1];
const luminancja = (kolor) => {
  const skladowe = kolor.slice(1).match(/../g).map((x) => {
    const s = parseInt(x, 16) / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * skladowe[0] + 0.7152 * skladowe[1] + 0.0722 * skladowe[2];
};
const kontrast = (a, b) => {
  const [jasny, ciemny] = [luminancja(a), luminancja(b)].sort((x, y) => y - x);
  return (jasny + 0.05) / (ciemny + 0.05);
};

describe('plakietka DPD', () => {
  it('ma biały tekst i kontrast co najmniej 4,5 w obu motywach', () => {
    expect(layout).toMatch(/\.plakietka--dpd\s*\{[^}]*--plakietka-tlo:\s*var\(--marka-dpd-tlo\);[^}]*--plakietka-tekst:\s*var\(--marka-bialy\)/);
    expect(wartosc('marka-bialy')).toBe('#FFFFFF');
    expect(kontrast(wartosc('marka-dpd-tlo'), wartosc('marka-bialy'))).toBeGreaterThanOrEqual(4.5);
    const ciemnyMotyw = layout.match(/html\[data-motyw="ciemny"\]\s*\{([^}]*)\}/)?.[1];
    expect(ciemnyMotyw).toBeDefined();
    expect(ciemnyMotyw).not.toMatch(/--marka-(?:dpd-tlo|bialy)\s*:/);
  });

  it('przywraca kolor marki napisowi wewnątrz każdej plakietki w szczegółach zamówienia (także DPD)', () => {
    const widok = readFileSync('src/moduly/zamowienia/widoki/zamowienie.ejs', 'utf8');
    expect(/class="plakietka plakietka--<%= przewoznikKarty\.klucz %>"[^\n]*\n\s*<span title=/.test(widok)).toBe(true);
    expect(/\.metadane\s+\.plakietka\s+span:first-child\s*\{\s*color:\s*var\(--plakietka-tekst,\s*inherit\)\s*;/.test(layout)).toBe(true);
  });
});
