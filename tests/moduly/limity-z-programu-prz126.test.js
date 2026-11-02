import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { najdluzszyPrzebiegMs } from '../../src/moduly/faktury/services/czuwacz-ksef.js';
import { najdluzszyPrzebiegArchiwumSprzedazyMs } from '../../src/moduly/faktury/services/czuwacz-archiwum-sprzedazy.js';
import {
  createCzuwaczOstrzezen, limitKrokuLukMs, limitKrokuTerminowMs,
} from '../../src/moduly/zdrowie/services/czuwacz-ostrzezen.js';
import { programTestowy } from '../pomoc/program-testowy.js';

describe('PRZ-126: limity czuwaczy pochodzą z opisu programu', () => {
  it.each([
    'faktury/services/czuwacz-ksef.js',
    'faktury/services/czuwacz-archiwum-sprzedazy.js',
    'zdrowie/services/czuwacz-ostrzezen.js',
  ])('%s nie importuje klienta inFaktu', (plik) => {
    const zrodlo = readFileSync(new URL(`../../src/moduly/${plik}`, import.meta.url), 'utf8');
    expect(zrodlo).not.toMatch(/(?:from\s*|import\s*\(?)\s*['"][^'"]*oms\/infakt\/client\.js['"]/);
  });

  it('liczy wszystkie budżety z innych limitów programu', () => {
    const baza = programTestowy();
    const limity = { zadanieMs: 1234, najdluzszaListaMs: 9876, stronaListy: 10, sufitStron: 13, rownolegleStron: 3 };
    const program = { ...baza, opis: { ...baza.opis, limity } };
    expect(najdluzszyPrzebiegMs(program.opis.limity)).toBe(311700);
    expect(najdluzszyPrzebiegArchiwumSprzedazyMs(program.opis.limity)).toBe(611110);
    expect(limitKrokuLukMs(program.opis.limity)).toBe(9872);
    expect(limitKrokuTerminowMs(program.opis.limity)).toBe(6170);
    expect(createCzuwaczOstrzezen({ program }).najdluzszyPrzebiegMs).toBe(16042);
  });

  it('bez programu nie rezerwuje budżetu inFaktu', () => {
    expect(createCzuwaczOstrzezen({}).najdluzszyPrzebiegMs).toBe(0);
  });
});
