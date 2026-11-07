import { it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

it('wejście do zwrotu ma czerwony przycisk w zwykłym rozmiarze wpłaty', () => {
  const widok = readFileSync('src/moduly/zamowienia/widoki/zamowienie.ejs', 'utf8');
  expect(widok).toContain('<a class="btn btn--groza" href="<%= adresPodwidoku(\'zwrot\') %>">Zarejestruj zwrot</a>');
  expect(widok).toContain('<summary class="btn">+ Dodaj wpłatę</summary>');
});
