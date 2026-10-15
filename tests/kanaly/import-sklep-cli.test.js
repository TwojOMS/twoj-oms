import { describe, it, expect } from 'vitest';
import { parsujArgumenty } from '../../src/moduly/kanaly/scripts/import-sklep.mjs';

const argv = (...a) => ['node', 'import-sklep.mjs', ...a];

describe('argumenty importu historii sklepu', () => {
  it('czyta komplet', () => {
    expect(parsujArgumenty(argv('--sklep', 'szkicownia', '--od', '2014-01-01', '--do', '2024-10-06')))
      .toEqual({ sklep: 'szkicownia', od: '2014-01-01', doDnia: '2024-10-06', sonda: false });
  });

  it('⚠️ BRAK --do JEST BLEDEM, nie domyslnym „do dzis" — sufit ma byc wpisany swiadomie', () => {
    expect(() => parsujArgumenty(argv('--sklep', 'szkicownia', '--od', '2014-01-01')))
      .toThrow(/--do/);
  });

  it('odmawia daty w zlym formacie', () => {
    expect(() => parsujArgumenty(argv('--sklep', 'szkicownia', '--od', '2014-1-1', '--do', '2024-10-06')))
      .toThrow(/RRRR-MM-DD/);
  });

  it('--sonda wlacza tryb pomiaru', () => {
    expect(parsujArgumenty(argv('--sklep', 'szkicownia', '--od', '2014-01-01', '--do', '2024-10-06', '--sonda')).sonda)
      .toBe(true);
  });
});
