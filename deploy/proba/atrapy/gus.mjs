// PRZ-083 — atrapa GUS (REGON BIR1.1) dla piaskownicy i demo publicznego. Bez GUS_KLUCZ przyciski „Pobierz z GUS”
// znikały z karty, nowego zamówienia i Stałych klientów, a gość demo nie wiedział, że taka funkcja jest.
// Decyzja właściciela 15.10: przycisk stoi, kliknięcie mówi wprost, że w demo nie działa (nie zmyślone dane firmy —
// demo nie ma sieci, a odpowiedź „jak z GUS-u” udawałaby integrację, której tu nie ma).
import { wymagajTrybuProby } from './tryb.mjs';

export const KOMUNIKAT_GUS_DEMO = 'Pobieranie danych z GUS nie działa w wersji demonstracyjnej. '
  + 'W Twoim OMS-ie ten przycisk wpisuje nazwę i adres firmy z rejestru REGON — tutaj wpisz je ręcznie.';

export function createAtrapaGus({ env = process.env } = {}) {
  wymagajTrybuProby(env, 'atrapa GUS');
  return {
    async firmaPoNip() {
      throw Object.assign(new Error(KOMUNIKAT_GUS_DEMO), { dlaOperatora: true, wylaczoneWDemo: true });
    },
    atrapa: true,
  };
}
