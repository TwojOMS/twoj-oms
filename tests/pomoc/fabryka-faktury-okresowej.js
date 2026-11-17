import { createFakturaOkresu as prawdziwaFabryka } from '../../src/moduly/faktury/services/faktura-okresu.js';
export { pozycjeOkresu } from '../../src/moduly/faktury/services/faktura-okresu.js';
// Wyłącznie fixture historycznych asercji WDT. Produkcja nie importuje adaptera.
export const createFakturaOkresu = opcje => prawdziwaFabryka({ nipSprzedawcy: '1234563218', ...opcje });
