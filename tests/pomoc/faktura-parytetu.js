import { createFaktura as prawdziwaFabryka } from '../../src/moduly/faktury/services/faktura.js';
// Wyłącznie fixture historycznych asercji WDT. Produkcja nie importuje adaptera.
export const createFaktura = opcje => prawdziwaFabryka({ nipSprzedawcy: '1234563218', ...opcje });
