import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const layout = readFileSync('src/public/oms-design.css', 'utf8');

describe('pasy komunikatów integracji', () => {
  it.each([
    ['blad', 'blad-tlo', 'blad-tekst', 'blad-ramka'],
    ['potwierdzenie', 'ok-tlo', 'ok-tekst', 'ok-tekst'],
  ])('nadaje pasowi %s kolory z tokenów', (nazwa, tlo, tekst, ramka) => {
    const regula = layout.match(new RegExp(`\\.pas-${nazwa}\\s*\\{([^}]*)\\}`))?.[1] ?? '';
    expect(regula).toContain(`background: var(--${tlo})`);
    expect(regula).toContain(`color: var(--${tekst})`);
    expect(regula).toContain(`border-color: var(--${ramka})`);
  });
});
