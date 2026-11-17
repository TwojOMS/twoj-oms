import { daneSpecyfikacji as produkcyjneDane } from '../../src/domena/specyfikacja.js';
// Jawna konfiguracja historycznej fikstury; regułę wykonuje produkcyjna domena.
const klienciWdt=new Set(['peter.novak@alfatrend.sk','info@alfatrend.sk']);
export const daneSpecyfikacji=(z,opcje)=>produkcyjneDane(z,{klienciWdt,...opcje});
